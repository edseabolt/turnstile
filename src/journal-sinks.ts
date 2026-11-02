/**
 * @fileoverview Journal-persistence boundary: the append/rotate primitives
 * (`appendLine`, `rotateIfLarge`, `now`), the session-ID shape rule, the
 * per-file sink resolution, rotation locking, and trace-line formatting
 * behind `createJournaler` in `src/journal.ts`. Extracted so the journaler
 * factory stays a thin composition over one persistence boundary; every
 * write remains fail-open by contract.
 */

import * as fs from "node:fs"
import * as path from "node:path"

/**
 * Host session-ID alphabet, length-capped: the only shapes that may name a
 * per-session journal file (and the only shapes replay accepts as bucket
 * keys). Anything else is hostile bytes, not a session. Canonical export:
 * both the journal sink routing and the ledger replay validate against this
 * one rule.
 */
export const REPLAY_SESSION_RE = /^[A-Za-z0-9._-]{1,64}$/

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

/**
 * Resolves the per-session journal file for a parent session ID.
 * @param metricsDir The metrics directory.
 * @param parentID The parent session ID.
 * @returns The absolute path `<metricsDir>/sessions/<parentID>.jsonl`.
 */
export function sessionJournalPath(metricsDir: string, parentID: string): string {
  return path.join(metricsDir, "sessions", `${parentID}.jsonl`)
}

/** A created `<file>.lock` older than this cannot be held by a live
 *  rotation (the hold spans one stat + at most maxGenerations renames):
 *  it marks a crashed process. Steal it. */
const ROTATION_LOCK_STALE_MS = 60_000

/** Options accepted by `createJournaler`, threaded into the sink helpers. */
export interface JournalSinksOptions {
  /** Directory that receives both telemetry files. */
  metricsDir: string
  /** Whether trace lines are written (journal always is). */
  trace: boolean
  /** Rotation threshold per journal file. */
  maxBytes: number
  /** Rotated generations kept per journal file. */
  maxGenerations: number
  /** Hot path is append-only; the size check and rotation run once per this
   *  many appends. Entries between the check and the rename are the bounded
   *  overshoot. */
  rotateEveryEntries: number
  /** When true, entries carrying a resolvable parent sessionID route to
   *  `sessions/<parentID>.jsonl`; everything else stays on the shared
   *  `turnstile.jsonl`. */
  perSession?: boolean
  /** Resolves the parent sessionID whose file owns an entry, or `""` for the
   *  shared sink. Bound late by the wiring (the ledger is built after the
   *  journaler). */
  sinkFor?: (sessionID: string) => string
}

/** The sink capability `createJournaler` composes over. */
export interface JournalSinks {
  /** Absolute path of the shared (legacy fallback) JSONL journal file. */
  journalPath: string
  /** Absolute path of the per-session journal directory. */
  sessionsDir: string
  /** Absolute path of the human-readable trace file. */
  tracePath: string
  /** Resolves the sink file that owns one journal entry. */
  sinkFor(entry: Record<string, unknown>): string
  /** Rotates `file` once per `rotateEveryEntries` writes. */
  tickRotate(file: string, counter: { n: number }): void
}

/**
 * Resolves the sink file that owns one journal entry: the parent session's
 * file when per-session segmentation is on, the entry carries a string
 * `sessionID`, the resolver yields a parent, and that parent passes the
 * session-ID shape rule; the shared file otherwise.
 * @param options The journaler options (segmentation + resolver).
 * @param journalPath The shared journal file path (the fallback sink).
 * @param entry The journal entry about to be appended.
 * @returns The absolute path of the owning journal file.
 */
function sinkFor(
  options: JournalSinksOptions,
  journalPath: string,
  entry: Record<string, unknown>,
): string {
  const sessionID = entry.sessionID
  if (!options.perSession || typeof sessionID !== "string") return journalPath
  const parent = options.sinkFor?.(sessionID) ?? ""
  if (parent === "" || !REPLAY_SESSION_RE.test(parent)) return journalPath
  return sessionJournalPath(options.metricsDir, parent)
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
 * Rotates `file` once per `rotateEveryEntries` writes, under a created
 * `<file>.lock` directory that is an atomic mutex (mkdir fails with EEXIST
 * while another session holds it) so concurrent sessions never both rename
 * the shared file. A stale lock — its mtime past the staleness bound,
 * proving its creator crashed — is stolen (journaled as a
 * `rotation-lock-stale:` error entry) and the mkdir retried once; a fresh
 * contention is a silent return. Non-EEXIST mkdir errors and steal-path
 * throws land in the single outer catch. The error row always lands on the
 * shared journal file, even when the contended file is a session sink (one
 * fixed audit location for rotation errors). Fail-open: the outer catch
 * swallows every steal-path throw and the finally's failed rmdir, so a
 * throw inside the finally (a failed rmdir) or the rotate cannot propagate
 * out of `journal()` into the hook. The per-write hot path never calls
 * this past the counter gate.
 * @param options The journaler options (rotation bounds).
 * @param journalPath The shared journal file path (the error row's sink).
 * @param file Path of the file to rotate.
 * @param counter A per-file `{ n }` counter; callers pass one bound here.
 */
function tickRotate(
  options: JournalSinksOptions,
  journalPath: string,
  file: string,
  counter: { n: number },
): void {
  if (++counter.n < options.rotateEveryEntries) return
  counter.n = 0
  try {
    const lock = `${file}.lock`
    try {
      fs.mkdirSync(lock)
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e
      if (!stealStaleLock(lock)) return
      appendLine(
        journalPath,
        JSON.stringify({ ts: now(), type: "error", error: `rotation-lock-stale: ${file}` }),
      )
      fs.mkdirSync(lock) // raced again: the throw lands in the outer catch
    }
    try {
      rotateIfLarge(file, options.maxBytes, options.maxGenerations)
    } finally {
      fs.rmdirSync(`${file}.lock`)
    }
  } catch {
    // steal-path throw, non-EEXIST mkdir error, or failed rmdir: skip the tick
  }
}

/**
 * Formats one trace line in the AGENTS.md trace contract format
 * (`YYYY-MM-DD HH:MM | agent | event | detail`).
 * @param agent The acting agent label (e.g. `orchestrator`, `reviewer`).
 * @param event The event kind (e.g. `dispatch`, `gate`, `verdict`).
 * @param detail Free-form event detail, truncated to 200 characters.
 * @param sessionID Optional session ID; when provided it is appended as a
 *     trailing ` | <id>` segment after `detail`. Omitting it leaves the
 *     four documented segments (`ts | agent | event | detail`) byte-identical.
 * @returns The formatted trace line (no trailing newline).
 */
function formatTraceLine(agent: string, event: string, detail: string, sessionID?: string): string {
  const d = new Date()
  const pad = (n: number): string => String(n).padStart(2, "0")
  // The session segment is optional and appended last; the first four
  // segments (ts | agent | event | detail) stay byte-identical for every
  // existing `split("|")` consumer when it is omitted.
  const tail = sessionID ? ` | ${sessionID}` : ""
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())} | ${agent} | ${event} | ${String(detail).slice(0, 200)}${tail}`
}

/**
 * Builds the journal sink capability: the three fixed paths plus the sink
 * resolution, rotation locking, and tick cadence the journaler's write
 * methods delegate to.
 * @param options The journaler options (paths, rotation bounds, segmentation).
 * @returns The sink capability bound to the given options.
 */
export function createJournalSinks(options: JournalSinksOptions): JournalSinks {
  const journalPath = path.join(options.metricsDir, "turnstile.jsonl")
  const sessionsDir = path.join(options.metricsDir, "sessions")
  const tracePath = path.join(options.metricsDir, "gate-events.log")
  return {
    journalPath,
    sessionsDir,
    tracePath,
    sinkFor: (entry) => sinkFor(options, journalPath, entry),
    tickRotate: (file, counter) => tickRotate(options, journalPath, file, counter),
  }
}

export { formatTraceLine }
