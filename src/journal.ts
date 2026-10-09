/**
 * @fileoverview Telemetry boundary: JSONL journal and human-readable trace
 * persistence. A `Journaler` instance is created per plugin setup from the
 * resolved config and injected into the state, gate, and wiring layers —
 * no module-level paths, so tests can redirect all writes. Journaling is
 * fail-open by contract: no write ever breaks execution.
 */

import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"

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

/** Rotation bound comment: a journal file rotates when it exceeds the
 * configured byte size; generations `.1`…`.N` shift up, the oldest is
 * pruned. Disk usage is bounded at (N + 1) × maxBytes per journal. The
 * stat cost per append is negligible; the shift is a handful of renames
 * that happens once per maxBytes of journal growth. */

/**
 * Returns the current time as an ISO-8601 timestamp.
 * @returns The current UTC timestamp, e.g. `2026-10-08T12:00:00.000Z`.
 */
export function now(): string {
  return new Date().toISOString()
}

/**
 * Rotates a journal file when it grows past the size limit, keeping at
 * most `maxGenerations` numbered generations. Silent on any failure.
 * @param file Path of the journal file to check and rotate.
 * @param maxBytes Rotation threshold in bytes.
 * @param maxGenerations Number of numbered generations to keep.
 */
export function rotateIfLarge(file: string, maxBytes: number, maxGenerations: number): void {
  try {
    const stat = fs.statSync(file)
    if (stat.size <= maxBytes) return
    // prune the oldest generation first so the shift below has a free slot
    const oldest = `${file}.${maxGenerations}`
    try {
      fs.unlinkSync(oldest)
    } catch {
      // no generation at the limit yet — nothing to prune
    }
    for (let gen = maxGenerations - 1; gen >= 1; gen--) {
      try {
        fs.renameSync(`${file}.${gen}`, `${file}.${gen + 1}`)
      } catch {
        // missing generation: skip; lower generations still shift correctly
      }
    }
    fs.renameSync(file, `${file}.1`)
  } catch {
    // missing file or stat failure: nothing to rotate
  }
}

/**
 * Appends one line to a file, creating the parent directory first. The
 * caller is responsible for rotating when a size bound applies (the
 * JSONL journal and trace both call `rotateIfLarge` before appending).
 * Silent on any failure — journaling must never break execution.
 * @param file Path of the file to append to.
 * @param text The line to append (a trailing newline is added).
 */
export function appendLine(file: string, text: string): void {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.appendFileSync(file, text + "\n")
  } catch {
    // journaling must never break execution
  }
}

/** Telemetry writer injected into the state, gate, and wiring layers. */
export interface Journaler {
  /** Absolute path of the JSONL journal file. */
  journalPath: string
  /** Absolute path of the human-readable trace file. */
  tracePath: string
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
   */
  traceEvent(agent: string, event: string, detail: string): void
}

/**
 * Creates a telemetry writer bound to the given metrics directory.
 * @param options.metricsDir Directory that receives both telemetry files.
 * @param options.trace Whether trace lines are written (journal always is).
 * @param options.maxBytes Rotation threshold per journal file.
 * @param options.maxGenerations Rotated generations kept per journal file.
 * @returns A Journaler writing `turnstile.jsonl` and `gate-events.jsonl`
 *     under `options.metricsDir`.
 */
export function createJournaler(options: {
  metricsDir: string
  trace: boolean
  maxBytes: number
  maxGenerations: number
}): Journaler {
  const journalPath = path.join(options.metricsDir, "turnstile.jsonl")
  const tracePath = path.join(options.metricsDir, "gate-events.jsonl")
  return {
    journalPath,
    tracePath,
    journal(entry: Record<string, unknown>): void {
      rotateIfLarge(journalPath, options.maxBytes, options.maxGenerations)
      appendLine(journalPath, JSON.stringify({ ts: now(), ...entry }))
    },
    traceEvent(agent: string, event: string, detail: string): void {
      if (!options.trace) return
      // The trace file shares the journal's rotation bound (AGENTS.md
      // retention contract: bounded at (N + 1) × maxBytes per file).
      rotateIfLarge(tracePath, options.maxBytes, options.maxGenerations)
      const d = new Date()
      const pad = (n: number): string => String(n).padStart(2, "0")
      appendLine(
        tracePath,
        `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())} | ${agent} | ${event} | ${String(detail).slice(0, 200)}`,
      )
    },
  }
}
