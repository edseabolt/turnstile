/**
 * @fileoverview Journal-sinks boundary: the per-file sink resolution, rotation
 * locking, and trace-line formatting behind `createJournaler` in
 * `src/journal.ts`. Extracted so the journaler factory stays a thin
 * composition; every write remains fail-open by contract.
 */

import * as fs from "node:fs"
import * as path from "node:path"

import { appendLine, now, rotateIfLarge, sessionJournalPath, REPLAY_SESSION_RE } from "./journal.ts"

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
  /** Acquires the `<file>.lock` mutex for a rotation tick. */
  tryLock(file: string): boolean
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
 * Acquires the `<file>.lock` mutex for the tick. A stale lock (mtime past
 * the staleness bound — its creator crashed) is stolen and journaled as a
 * `rotation-lock-stale:` error entry before the mkdir is retried once; a
 * fresh contention returns false without journaling. Non-EEXIST mkdir
 * errors and steal-path throws propagate to the caller's catch. The error
 * row always lands on the shared journal file, even when the contended
 * file is a session sink (one fixed audit location for rotation errors).
 * @param file Path of the file whose lock is acquired.
 * @param journalPath The shared journal file path (the error row's sink).
 * @returns True when the lock is held by the caller on return.
 */
function tryLock(file: string, journalPath: string): boolean {
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
 * @param options The journaler options (rotation bounds).
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
    if (!tryLock(file, journalPath)) return
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
    tryLock: (file) => tryLock(file, journalPath),
    tickRotate: (file, counter) => tickRotate(options, journalPath, file, counter),
  }
}

export { formatTraceLine }
