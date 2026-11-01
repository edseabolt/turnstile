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

/**
 * Host session-ID alphabet, length-capped: the only shapes that may name a
 * per-session journal file (and the only shapes replay accepts as bucket
 * keys). Anything else is hostile bytes, not a session. Canonical export:
 * both the journal sink routing and the ledger replay validate against this
 * one rule.
 */
export const REPLAY_SESSION_RE = /^[A-Za-z0-9._-]{1,64}$/

/** Rotation bound (rotation-race fix): the append hot path never stats or
 * renames the file — `journal()` only appends and advances a per-file
 * counter. The rotate-then-rename sequence runs once per `rotateEveryEntries`
 * appends (cadence set by the `journalRotateEveryEntries` config key) and only
 * under a created `<file>.lock` directory (an
 * atomic mutex: `mkdir` fails with EEXIST while another session holds it), so
 * two concurrent sessions never both rename the shared file. Disk usage stays
 * bounded at (N + 1) × maxBytes plus at most `rotateEveryEntries × ~2 KB` of
 * overshoot between the size check and the rename. A crashed process between
 * the create and the remove of `<file>.lock` leaves a stale lock: the next
 * tick steals it once its mtime passes the staleness bound, journaling a
 * `rotation-lock-stale:` error entry, so rotation resumes; a fresh
 * (contended) lock is still skipped silently, and the append hot path keeps
 * journaling through either. */

/** A created `<file>.lock` older than this cannot be held by a live
 *  rotation (the hold spans one stat + at most maxGenerations renames):
 *  it marks a crashed process. Steal it. */
const ROTATION_LOCK_STALE_MS = 60_000

/**
 * Returns the current time as an ISO-8601 timestamp.
 * @returns The current UTC timestamp, e.g. `2026-10-08T12:00:00.000Z`.
 */
export function now(): string {
  return new Date().toISOString()
}

/**
 * Steals a lock directory whose mtime proves its creator crashed
 * mid-rotation. A stat or rmdir failure throws to the caller's catch, so a
 * lock in an unexpected state (a file, a non-empty directory, a vanished
 * path) is never forced open — it just skips the tick.
 * @param lock Path of the contended `<file>.lock` directory.
 * @returns True when the stale lock was removed (a steal happened).
 */
function stealStaleLock(lock: string): boolean {
  if (Date.now() - fs.statSync(lock).mtimeMs < ROTATION_LOCK_STALE_MS) return false
  fs.rmdirSync(lock)
  return true
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
 * Resolves the per-session journal file for a parent session ID.
 * @param metricsDir The metrics directory.
 * @param parentID The parent session ID.
 * @returns The absolute path `<metricsDir>/sessions/<parentID>.jsonl`.
 */
export function sessionJournalPath(metricsDir: string, parentID: string): string {
  return path.join(metricsDir, "sessions", `${parentID}.jsonl`)
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
  const journalPath = path.join(options.metricsDir, "turnstile.jsonl")
  const sessionsDir = path.join(options.metricsDir, "sessions")
  const tracePath = path.join(options.metricsDir, "gate-events.log")
  // Counters per file, never shared: the journal, each session sink, and the
  // trace file each rotate on their own schedule (a trace-off journal still
  // counts its own ticks). Keyed by resolved file path; bounded by the live
  // session count plus the two fixed sinks.
  const journalTicks = new Map<string, { n: number }>()
  const traceTick = { n: 0 }
  /**
   * Resolves the sink file that owns one journal entry: the parent session's
   * file when per-session segmentation is on, the entry carries a string
   * `sessionID`, the resolver yields a parent, and that parent passes the
   * session-ID shape rule; the shared file otherwise.
   * @param entry The journal entry about to be appended.
   * @returns The absolute path of the owning journal file.
   */
  function sinkFor(entry: Record<string, unknown>): string {
    const sessionID = entry.sessionID
    if (!options.perSession || typeof sessionID !== "string") return journalPath
    const parent = options.sinkFor?.(sessionID) ?? ""
    if (parent === "" || !REPLAY_SESSION_RE.test(parent)) return journalPath
    return sessionJournalPath(options.metricsDir, parent)
  }
  /**
   * Acquires the `<file>.lock` mutex for the tick. A stale lock (mtime past
   * the staleness bound — its creator crashed) is stolen and journaled as a
   * `rotation-lock-stale:` error entry before the mkdir is retried once; a
   * fresh contention returns false without journaling. Non-EEXIST mkdir
   * errors and steal-path throws propagate to the caller's catch. The error
   * row always lands on the shared journal file, even when the contended
   * file is a session sink (one fixed audit location for rotation errors).
   * @param file Path of the file whose lock is acquired.
   * @returns True when the lock is held by the caller on return.
   */
  function tryLock(file: string): boolean {
    const lock = `${file}.lock`
    try {
      fs.mkdirSync(lock)
      return true
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e
      if (!stealStaleLock(lock)) return false
      appendLine(
        journalPath,
        JSON.stringify({ ts: now(), type: "error", error: `rotation-lock-stale: ${file}` }),
      )
      fs.mkdirSync(lock) // raced again: the throw lands in tickRotate's catch
      return true
    }
  }

  /**
   * Rotates `file` once per `rotateEveryEntries` writes, under a created
   * `<file>.lock` directory that is an atomic mutex (mkdir fails with EEXIST
   * while another session holds it) so concurrent sessions never both rename
   * the shared file. A stale lock — its mtime past the staleness bound,
   * proving its creator crashed — is stolen by `tryLock`, journaled as a
   * `rotation-lock-stale:` error entry, and the mkdir retried; a fresh
   * contention is a silent return. Fail-open: the single outer catch
   * swallows every steal-path throw and the finally's failed rmdir, so a
   * throw inside the finally (a failed rmdir) or the rotate cannot propagate
   * out of `journal()` into the hook. The per-write hot path never calls
   * this past the counter gate.
   * @param file Path of the file to rotate.
   * @param counter A per-file `{ n }` counter; callers pass one bound here.
   */
  function tickRotate(file: string, counter: { n: number }): void {
    if (++counter.n < options.rotateEveryEntries) return
    counter.n = 0
    try {
      if (!tryLock(file)) return
      try {
        rotateIfLarge(file, options.maxBytes, options.maxGenerations)
      } finally {
        fs.rmdirSync(`${file}.lock`)
      }
    } catch {
      // steal-path throw, non-EEXIST mkdir error, or failed rmdir: skip the tick
    }
  }
  return {
    journalPath,
    sessionsDir,
    tracePath,
    journalPathFor(parentID: string): string {
      return sessionJournalPath(options.metricsDir, parentID)
    },
    journal(entry: Record<string, unknown>): void {
      const file = sinkFor(entry)
      appendLine(file, JSON.stringify({ ts: now(), ...entry }))
      let tick = journalTicks.get(file)
      if (!tick) {
        tick = { n: 0 }
        journalTicks.set(file, tick)
      }
      tickRotate(file, tick)
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
