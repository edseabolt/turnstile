/**
 * @fileoverview Cross-process file-lock boundary: an atomic mkdir mutex at
 * `<file>.lock` with bounded retry and mtime-based stale steal. Extracted
 * from the rotation path in `src/journal-sinks.ts` so the chained append,
 * the approval sidecar, and rotation share exactly one lock protocol (DRY);
 * the semantics are the rotation path's proven ones. Fail-open by contract:
 * lock-state failures return a degradation result instead of throwing — the
 * caller decides how to proceed.
 */

import * as fs from "node:fs"

/** Options for the cross-process file lock. */
export interface FileLockOptions {
  /** Max milliseconds to retry acquiring before degrading (default 1000;
   *  `0` makes a single attempt). */
  timeoutMs?: number
  /** A lock whose mtime is older than this is stale and stolen once
   *  (default 10_000; rotation passes 60_000). */
  staleMs?: number
  /** Called with the lock held, before `fn` runs. Production callers omit
   *  it; tests inject it to force deterministic critical-section
   *  interleaving. */
  onAcquired?: () => void
  /** Called after a stale lock was successfully stolen, before the retry
   *  mkdir. Rotation journals its `rotation-lock-stale:` row here so the
   *  row lands before the rotation rename (inside the rotated generation). */
  onStaleSteal?: () => void
}

/** The lock outcome: whether `fn` ran under the lock and whether a stale
 *  lock had to be stolen to acquire it. */
export interface FileLockResult {
  /** True when the lock was held and `fn` ran inside it. */
  held: boolean
  /** True when a stale lock was stolen on the way to acquiring. */
  stoleStale: boolean
}

/** Default retry bound: milliseconds-wide critical sections never wait
 *  longer than this before degrading. */
const DEFAULT_TIMEOUT_MS = 1_000

/** Default staleness bound: a lock older than this marks a crashed holder
 *  (the guarded critical sections are far shorter). */
const DEFAULT_STALE_MS = 10_000

/** Sleep between acquisition retries. */
const RETRY_BACKOFF_MS = 25

/** The outcome of one acquisition attempt. */
type Attempt = "acquired" | "stale-stolen" | "busy"

/**
 * Blocks synchronously for `ms` milliseconds. The lock protocol is
 * synchronous (callers append with `fs.appendFileSync`), so the retry wait
 * parks the thread via `Atomics.wait` instead of a timer.
 * @param ms The milliseconds to wait.
 */
function sleep(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

/**
 * Resolves the lock directory path guarding a file.
 * @param file The guarded file path.
 * @returns The `<file>.lock` directory path.
 */
function lockPath(file: string): string {
  return `${file}.lock`
}

/**
 * Makes one acquisition attempt: mkdir the mutex; on `EEXIST` steal a stale
 * lock (mtime past `staleMs`) once — rmdir, notify, one mkdir retry — and
 * report a fresh contention as busy. Unexpected lock-state errors (a
 * non-EEXIST mkdir failure, an unstealable stale lock, a vanished lock, a
 * lost re-acquire race) throw to the caller's fail-open catch, mirroring
 * the rotation path's outer catch: a lock in an unexpected state is never
 * forced open.
 * @param file The guarded file path.
 * @param staleMs The staleness bound for stealing.
 * @param onStaleSteal Optional steal notification (see {@link FileLockOptions}).
 * @returns The attempt outcome.
 */
function attemptAcquire(file: string, staleMs: number, onStaleSteal?: () => void): Attempt {
  try {
    fs.mkdirSync(lockPath(file))
    return "acquired"
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e
  }
  if (Date.now() - fs.statSync(lockPath(file)).mtimeMs < staleMs) return "busy"
  fs.rmdirSync(lockPath(file))
  onStaleSteal?.()
  fs.mkdirSync(lockPath(file)) // raced again: the throw fails the acquire
  return "stale-stolen"
}

/**
 * Runs `fn` under the held lock and releases it. Release failure is
 * swallowed (the rotation path's finally contract): a lock that cannot be
 * removed is left for the stale steal, never turned into a caller error.
 * An exception from `fn` propagates after release — the caller owns its
 * body's error handling, and swallowing it here would make the caller
 * re-run work that already (partially) happened.
 * @param file The guarded file path.
 * @param opts The lock options (the `onAcquired` seam).
 * @param fn The critical-section body.
 * @param outcome The acquisition outcome (distinguishes a stale steal).
 * @returns The lock result (always `held: true`).
 */
function runLocked(
  file: string,
  opts: FileLockOptions,
  fn: () => void,
  outcome: Attempt,
): FileLockResult {
  try {
    opts.onAcquired?.()
    fn()
  } finally {
    try {
      fs.rmdirSync(lockPath(file))
    } catch {
      // a failed release cannot break the caller
    }
  }
  return { held: true, stoleStale: outcome === "stale-stolen" }
}

/**
 * Runs `fn` while holding an atomic mkdir mutex at `<file>.lock`. Fails
 * open: after the retry bound (or on any unexpected lock-state error) it
 * returns `{ held: false }` instead of throwing, and `fn` never ran — the
 * caller degrades to its unlocked path. A stale lock (mtime past
 * `staleMs`) is stolen once, mirroring the rotation protocol's single
 * retry. An exception from `fn` propagates after release (see
 * {@link runLocked}).
 * @param file The guarded file path.
 * @param opts The lock options (bounds, seams).
 * @param fn The critical-section body.
 * @returns Whether the lock was held and whether a stale lock was stolen.
 */
export function withFileLock(file: string, opts: FileLockOptions, fn: () => void): FileLockResult {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const staleMs = opts.staleMs ?? DEFAULT_STALE_MS
  const deadline = Date.now() + timeoutMs
  for (;;) {
    let outcome: Attempt
    try {
      outcome = attemptAcquire(file, staleMs, opts.onStaleSteal)
    } catch {
      // unexpected lock state: fail open, fn never ran
      return { held: false, stoleStale: false }
    }
    if (outcome !== "busy") return runLocked(file, opts, fn, outcome)
    if (Date.now() >= deadline) return { held: false, stoleStale: false }
    sleep(RETRY_BACKOFF_MS)
  }
}
