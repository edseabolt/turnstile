/**
 * @fileoverview Evidence-hits boundary: the hits-map operations behind
 * `createEvidenceTracker` in `src/evidence.ts` — record, correlate, snapshot,
 * and clear over the raw session → hit-timestamp ring map. Pure in-memory
 * bookkeeping; the pattern compile and journaling stay in the tracker factory.
 */

import { evictTo } from "./bounded.ts"

/** Per-session hit cap: a ring buffer of exit-0 hit timestamps. */
export const MAX_HITS_PER_SESSION = 8

/** The hits-map operations `createEvidenceTracker` composes over. */
export interface EvidenceHits {
  /**
   * Records a plausible exit-0 test execution under `raw`, returning whether a
   * hit was recorded. Non-zero exits and non-matching commands are ignored;
   * the command text is never stored.
   * @param raw The session ID that ran the command.
   * @param command The command string (matched, never retained).
   * @param exit The command exit code.
   * @returns True when a hit was recorded.
   */
  observe(raw: string, command: unknown, exit: unknown): boolean
  /**
   * True when `sid` or any child whose child→parent edge resolves to `sid`
   * has a recorded hit (see the tracker's `has` contract for the re-keying
   * and window semantics).
   * @param sid The parent (or raw) session ID to check.
   * @param since Optional inclusive lower bound (the task window).
   * @returns True when correlated evidence exists.
   */
  has(sid: string, since?: number): boolean
  /**
   * Diagnostic view: a copy of every tracked session ID with its latest hit
   * timestamp, in insertion order. Pure read: no LRU promotion, no cap, no
   * mutation.
   * @returns One `{ session, last }` per tracked session.
   */
  snapshot(): Array<{ session: string; last: number }>
  /**
   * Drops `sid`'s bucket and every child's bucket whose edge resolves to `sid`.
   * @param sid The parent (or raw) session ID to clear.
   */
  clear(sid: string): void
}

/**
 * Promotes a key to most-recently-used in an insertion-ordered map.
 * @param map The map to reorder.
 * @param key The key to touch (no-op when absent).
 */
function promote(map: Map<string, number[]>, key: string): void {
  const v = map.get(key)
  if (v !== undefined) {
    map.delete(key)
    map.set(key, v)
  }
}

/**
 * Whether a bucket's latest hit satisfies the window bound.
 * @param bucket The bucket's hit timestamps (always non-empty).
 * @param since The inclusive lower bound, or undefined for no bound.
 * @returns True when the bucket qualifies.
 */
function windowQualifies(bucket: number[], since: number | undefined): boolean {
  if (since === undefined) return true
  return bucket[bucket.length - 1]! >= since
}

/**
 * Records one exit-0 hit under `raw` when the command matches the pattern,
 * trimming the ring to the per-session cap and the map to the session cap.
 * @param hits The hits map to mutate.
 * @param maxSessions The LRU session cap.
 * @param pattern The compiled evidence pattern.
 * @param raw The session ID that ran the command.
 * @param command The command string (matched, never retained).
 * @param exit The command exit code.
 * @returns True when a hit was recorded.
 */
function recordHit(
  hits: Map<string, number[]>,
  maxSessions: number,
  pattern: RegExp,
  raw: string,
  command: unknown,
  exit: unknown,
): boolean {
  if (!raw) return false
  if (exit !== 0) return false
  if (!pattern.test(String(command ?? ""))) return false
  const bucket = [...(hits.get(raw) ?? []), Date.now()]
  if (bucket.length > MAX_HITS_PER_SESSION) bucket.length = MAX_HITS_PER_SESSION
  hits.set(raw, bucket)
  evictTo(hits, maxSessions)
  return true
}

/**
 * Correlates evidence for `sid`: a direct in-window hit, or an in-window
 * child hit re-keyed to `sid` (lazy promotion, so an async parent edge
 * established after `observe` still resolves). A stale direct bucket falls
 * through to the child scan; a filtered-out child stays keyed under the
 * child (no re-key on a miss, preserving laziness for a later call).
 * @param hits The hits map to read and re-key.
 * @param parentOf Resolves a raw session ID to its parent.
 * @param sid The parent (or raw) session ID to check.
 * @param since Optional inclusive lower bound (the task window).
 * @returns True when correlated evidence exists.
 */
function correlate(
  hits: Map<string, number[]>,
  parentOf: (raw: string) => string,
  sid: string,
  since: number | undefined,
): boolean {
  if (!sid) return false
  // Touch unconditionally: present keys reorder to MRU, absent keys no-op.
  promote(hits, sid)
  // A stale direct bucket falls through to the child scan: an in-window
  // child hit still qualifies when the direct one predates the window.
  // Without `since` this is byte-identical to the legacy direct-hit return.
  if (hits.has(sid) && windowQualifies(hits.get(sid)!, since)) return true
  for (const [child, bucket] of hits) {
    if (parentOf(child) === sid && windowQualifies(bucket, since)) {
      hits.delete(child)
      hits.set(sid, bucket)
      promote(hits, sid)
      return true
    }
  }
  return false
}

/**
 * Builds the hits-map operations over one shared map, bound to the session
 * cap, the compiled pattern, and the parent resolver.
 * @param maxSessions The LRU session cap (`config.maxSessions`).
 * @param pattern The compiled evidence pattern.
 * @param parentOf Resolves a raw session ID to its parent (the ledger's
 *     `parentOf`).
 * @returns The observe/has/snapshot/clear operations.
 */
export function createEvidenceHits(
  maxSessions: number,
  pattern: RegExp,
  parentOf: (raw: string) => string,
): EvidenceHits {
  // Raw session ID → ring of exit-0 hit timestamps; insertion-order LRU,
  // capped at `config.maxSessions` (mirroring state.ts bookkeeping).
  const hits = new Map<string, number[]>()
  return {
    observe: (raw, command, exit) => recordHit(hits, maxSessions, pattern, raw, command, exit),
    has: (sid, since) => correlate(hits, parentOf, sid, since),
    snapshot(): Array<{ session: string; last: number }> {
      const view: Array<{ session: string; last: number }> = []
      for (const [session, bucket] of hits) {
        view.push({ session, last: bucket[bucket.length - 1]! })
      }
      return view
    },
    clear(sid: string): void {
      if (!sid) return
      hits.delete(sid)
      for (const [child] of hits) {
        if (parentOf(child) === sid) hits.delete(child)
      }
    },
  }
}
