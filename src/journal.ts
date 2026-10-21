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

/** Rotation bound (rotation-race fix): the append hot path never stats or
 * renames the file — `journal()` only appends and advances a per-file
 * counter. The rotate-then-rename sequence runs once per `rotateEveryEntries`
 * appends (cadence set by the `journalRotateEveryEntries` config key) and only
 * under a created `<file>.lock` directory (an
 * atomic mutex: `mkdir` fails with EEXIST while another session holds it), so
 * two concurrent sessions never both rename the shared file. Disk usage stays
 * bounded at (N + 1) × maxBytes plus at most `rotateEveryEntries × ~2 KB` of
 * overshoot between the size check and the rename. A crashed process between
 * the create and the remove of `<file>.lock` leaves a stale lock, so that
 * file's rotation is skipped until the directory is removed, and the append
 * hot path keeps journaling through it. */

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
      // no generation at the limit yet; nothing to prune
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
 * caller is responsible for rotating when a size bound applies (the journaler's
 * `journal()`/`traceEvent()` call `tickRotate` on an entry-count tick, under a
 * lock-guarded rename). Silent on any failure: journaling must never break
 * execution.
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
   * @param sessionID Optional session ID; when provided it is appended as a
   *     trailing ` | <id>` segment after `detail`. Omitting it leaves the
   *     four documented segments (`ts | agent | event | detail`) byte-identical.
   */
  traceEvent(agent: string, event: string, detail: string, sessionID?: string): void
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
 * @returns A Journaler writing `turnstile.jsonl` and `gate-events.jsonl`
 *     under `options.metricsDir`.
 */
export function createJournaler(options: {
  metricsDir: string
  trace: boolean
  maxBytes: number
  maxGenerations: number
  rotateEveryEntries: number
}): Journaler {
  const journalPath = path.join(options.metricsDir, "turnstile.jsonl")
  const tracePath = path.join(options.metricsDir, "gate-events.jsonl")
  // Counter per file, never shared: the journal and the trace file each rotate
  // on their own schedule (a trace-off journal still counts its own ticks).
  const journalTick = { n: 0 }
  const traceTick = { n: 0 }
  /**
   * Rotates `file` once per `rotateEveryEntries` writes, under a created
   * `<file>.lock` directory that is an atomic mutex (mkdir fails with EEXIST
   * while another session holds it) so concurrent sessions never both rename
   * the shared file. Fail-open: a contended lock or any rotation error is
   * swallowed by the single outer catch, so a throw inside the finally (a
   * failed rmdir) or the rotate cannot propagate out of `journal()` into the
   * hook. The per-write hot path never calls this past the counter gate.
   * @param file Path of the file to rotate.
   * @param counter A per-file `{ n }` counter; callers pass one bound here.
   */
  function tickRotate(file: string, counter: { n: number }): void {
    if (++counter.n < options.rotateEveryEntries) return
    counter.n = 0
    try {
      const lock = `${file}.lock`
      fs.mkdirSync(lock)
      try {
        rotateIfLarge(file, options.maxBytes, options.maxGenerations)
      } finally {
        fs.rmdirSync(lock)
      }
    } catch {
      // Contended lock or any rotation failure: skip the tick. Journaling must
      // never break execution, so every error here is swallowed (fail-open).
    }
  }
  return {
    journalPath,
    tracePath,
    journal(entry: Record<string, unknown>): void {
      appendLine(journalPath, JSON.stringify({ ts: now(), ...entry }))
      tickRotate(journalPath, journalTick)
    },
    traceEvent(agent: string, event: string, detail: string, sessionID?: string): void {
      if (!options.trace) return
      const d = new Date()
      const pad = (n: number): string => String(n).padStart(2, "0")
      // The session segment is optional and appended last; the first four
      // segments (ts | agent | event | detail) stay byte-identical for every
      // existing `split("|")` consumer when it is omitted.
      const tail = sessionID ? ` | ${sessionID}` : ""
      appendLine(
        tracePath,
        `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())} | ${agent} | ${event} | ${String(detail).slice(0, 200)}${tail}`,
      )
      // The trace file shares the journal's rotation bound (AGENTS.md
      // retention contract: bounded at (N + 1) × maxBytes per file).
      tickRotate(tracePath, traceTick)
    },
  }
}
