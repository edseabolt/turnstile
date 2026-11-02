/**
 * @fileoverview Telemetry boundary: JSONL journal and human-readable trace
 * persistence. A `Journaler` instance is created per plugin setup from the
 * resolved config and injected into the state, gate, and wiring layers,
 * so no module-level paths exist and tests can redirect all writes. Journaling is
 * fail-open by contract: no write ever breaks execution.
 */

import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"

import {
  appendLine,
  createJournalSinks,
  formatTraceLine,
  now,
  sessionJournalPath,
} from "./journal-sinks.ts"
import type { JournalSinks } from "./journal-sinks.ts"

export {
  REPLAY_SESSION_RE,
  appendLine,
  now,
  rotateIfLarge,
  sessionJournalPath,
} from "./journal-sinks.ts"

/**
 * Resolves the default metrics directory from an environment. Relative
 * `XDG_DATA_HOME` or `HOME` values are ignored: the XDG spec demands the
 * former be absolute, and this plugin's contract is that the resulting
 * path is never relative.
 * @param env Environment to consult; defaults to `process.env`.
 * @returns The absolute default metrics directory.
 */
export function defaultMetricsDir(env: Record<string, string | undefined> = process.env): string {
  const abs = (v: string | undefined): string | undefined =>
    v !== undefined && path.isAbsolute(v) ? v : undefined
  const home = abs(env.HOME) ?? os.homedir()
  const base = abs(env.XDG_DATA_HOME) ?? path.join(home, ".local/share")
  return path.join(base, "opencode", "metrics")
}

/** Default metrics directory, used only before config resolves (e.g. to
 * journal a malformed config file). */
export const DEFAULT_METRICS_DIR: string = defaultMetricsDir()

/** Default JSONL journal path inside {@link DEFAULT_METRICS_DIR}. */
export const DEFAULT_JOURNAL_PATH: string = path.join(DEFAULT_METRICS_DIR, "turnstile.jsonl")

/** One parsed journal entry (a JSON object line). */
export type JournalEntry = Record<string, unknown>

/**
 * Reads the current journal file and returns its parsed object entries,
 * oldest-first. Fail-open: any read or parse problem yields the entries
 * parsed so far (an unreadable or missing file yields []); a malformed
 * non-object line is skipped and the rest of the file still parses.
 * Rotation generations are NOT walked — only the current file is read — so
 * a count that straddles a rotation undercounts visibly in the summary
 * line, which is acceptable for a display-only surface (the reader feeds
 * the session-end summary; see `src/summary.ts`).
 * @param journalPath Absolute path of the current JSONL journal file.
 * @returns The parsed entries, oldest-first.
 */
export function readJournalEntries(journalPath: string): JournalEntry[] {
  let text: string
  try {
    text = fs.readFileSync(journalPath, "utf8")
  } catch {
    // missing or unreadable journal: nothing to count
    return []
  }
  const entries: JournalEntry[] = []
  for (const line of text.split("\n")) {
    if (line.trim() === "") continue
    try {
      const parsed: unknown = JSON.parse(line)
      // Plain objects only: arrays and JSON scalars are not entry shapes.
      if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
        entries.push(parsed as JournalEntry)
      }
    } catch {
      // malformed line: skip, keep the rest
    }
  }
  return entries
}

/** Telemetry writer injected into the state, gate, and wiring layers. */
export interface Journaler {
  /** Absolute path of the shared (legacy fallback) JSONL journal file. */
  journalPath: string
  /** Absolute path of the per-session journal directory. */
  sessionsDir: string
  /** Absolute path of the human-readable trace file. */
  tracePath: string
  /**
   * Resolves the journal file that owns a parent session's entries.
   * @param parentID The parent session ID (already sanitized by the caller
   *     when used as a file name).
   * @returns The absolute path `<sessionsDir>/<parentID>.jsonl`.
   */
  journalPathFor(parentID: string): string
  /**
   * Appends one structured entry to the JSONL journal, timestamped.
   * @param entry The journal entry; a `ts` field is prepended.
   */
  journal(entry: Record<string, unknown>): void
  /**
   * Appends one line to the trace file in the AGENTS.md trace contract
   * format (`YYYY-MM-DD HH:MM | agent | event | detail`). No-op when the
   * config disables the trace.
   * @param agent The acting agent label (e.g. `orchestrator`, `reviewer`).
   * @param event The event kind (e.g. `dispatch`, `gate`, `verdict`).
   * @param detail Free-form event detail, truncated to 200 characters.
   * @param sessionID Optional session ID; when provided it is appended as a
   *     trailing ` | <id>` segment after `detail`. Omitting it leaves the
   *     four documented segments (`ts | agent | event | detail`) byte-identical.
   */
  traceEvent(agent: string, event: string, detail: string, sessionID?: string): void
}

/**
 * Appends one timestamped journal entry to its owning sink and runs the
 * rotation tick for that file, managing the per-file tick counter (created
 * on first write; keyed by resolved file path).
 * @param sinks The sink capability (sink resolution + rotation).
 * @param journalTicks The per-file tick counters, mutated in place.
 * @param entry The journal entry; a `ts` field is prepended.
 */
function writeJournalEntry(
  sinks: JournalSinks,
  journalTicks: Map<string, { n: number }>,
  entry: Record<string, unknown>,
): void {
  const file = sinks.sinkFor(entry)
  appendLine(file, JSON.stringify({ ts: now(), ...entry }))
  let tick = journalTicks.get(file)
  if (!tick) {
    tick = { n: 0 }
    journalTicks.set(file, tick)
  }
  sinks.tickRotate(file, tick)
}

/**
 * Creates a telemetry writer bound to the given metrics directory.
 * @param options.metricsDir Directory that receives both telemetry files.
 * @param options.trace Whether trace lines are written (journal always is).
 * @param options.maxBytes Rotation threshold per journal file.
 * @param options.maxGenerations Rotated generations kept per journal file.
 * @param options.rotateEveryEntries Hot path is append-only; the size check
 *     and rotation run once per this many appends (documented in the
 *     rotation-bound comment above). Entries between the check and the
 *     rename are the bounded overshoot.
 * @param options.perSession When true, entries carrying a resolvable parent
 *     sessionID route to `sessions/<parentID>.jsonl`; everything else stays
 *     on the shared `turnstile.jsonl`. Default false (single-file layout).
 * @param options.sinkFor Resolves the parent sessionID whose file owns an
 *     entry, or `""` for the shared sink. Consulted only when `perSession`
 *     is on and the entry carries a string `sessionID`. Bound late by the
 *     wiring (the ledger is built after the journaler).
 * @returns A Journaler writing `turnstile.jsonl` (and, when `perSession` is
 *     on, `sessions/<parentID>.jsonl`) plus `gate-events.log` under
 *     `options.metricsDir`.
 */
export function createJournaler(options: {
  metricsDir: string
  trace: boolean
  maxBytes: number
  maxGenerations: number
  rotateEveryEntries: number
  perSession?: boolean
  sinkFor?: (sessionID: string) => string
}): Journaler {
  const sinks = createJournalSinks(options)
  // Counters per file, never shared: the journal, each session sink, and the
  // trace file each rotate on their own schedule (a trace-off journal still
  // counts its own ticks). Keyed by resolved file path; bounded by the live
  // session count plus the two fixed sinks.
  const journalTicks = new Map<string, { n: number }>()
  const traceTick = { n: 0 }
  return {
    journalPath: sinks.journalPath,
    sessionsDir: sinks.sessionsDir,
    tracePath: sinks.tracePath,
    journalPathFor(parentID: string): string {
      return sessionJournalPath(options.metricsDir, parentID)
    },
    journal(entry: Record<string, unknown>): void {
      writeJournalEntry(sinks, journalTicks, entry)
    },
    traceEvent(agent: string, event: string, detail: string, sessionID?: string): void {
      if (!options.trace) return
      appendLine(sinks.tracePath, formatTraceLine(agent, event, detail, sessionID))
      // The trace file shares the journal's rotation bound (AGENTS.md
      // retention contract: bounded at (N + 1) × maxBytes per file).
      sinks.tickRotate(sinks.tracePath, traceTick)
    },
  }
}
