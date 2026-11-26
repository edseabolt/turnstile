/**
 * @fileoverview Evidence-hits boundary: the hits-map operations behind
 * `createEvidenceTracker` in `src/evidence.ts` — record, correlate, snapshot,
 * and clear over the raw session → bucket map, plus the test-overlap
 * capture surfaces (`touched`, `testFiles`, `touchedFiles`). Pure in-memory
 * bookkeeping; the pattern compile and journaling stay in the tracker
 * factory. Redaction contract: path tokens only — command text and stdout
 * are never stored.
 */

import { evictTo } from "./bounded.ts"
import { extractTestFiles } from "./overlap.ts"

/** Cap on the per-bucket test-file and touched-path sets (newest-wins). */
export const MAX_PATHS_PER_BUCKET = 32

/**
 * One session's evidence bucket: the latest exit-0 hit timestamp (`0` for a
 * touched-only bucket that never ran a matching command), the latest
 * write/edit touch timestamp (tracked separately so a post-window touch
 * cannot re-qualify a pre-window hit), whether any hit was ever recorded,
 * and the bounded test-file / touched-path sets.
 */
export interface EvidenceBucket {
  /** `Date.now()` of the latest exit-0 hit (0 when none). */
  last: number
  /** `Date.now()` of the latest write/edit touch (0 when none). */
  lastTouch: number
  /** True once any exit-0 test-command hit was recorded. */
  hadHit: boolean
  /** Bounded, deduped executed test-file tokens (newest-wins). */
  testFiles: string[]
  /** Bounded, deduped touched change-set paths (newest-wins). */
  touched: string[]
}

/** The hits-map operations `createEvidenceTracker` composes over. */
export interface EvidenceHits {
  /**
   * Records a plausible exit-0 test execution under `raw`, returning whether a
   * hit was recorded. Non-zero exits and non-matching commands are ignored;
   * the command text is never stored. On a hit, the command line and the
   * stdout window are scanned for test-file tokens (scanned and discarded —
   * only the resulting tokens are retained).
   * @param raw The session ID that ran the command.
   * @param command The command string (matched, never retained).
   * @param exit The command exit code.
   * @param stdout Optional stdout window scanned for test-file tokens.
   * @returns True when a hit was recorded.
   */
  observe(raw: string, command: unknown, exit: unknown, stdout?: string): boolean
  /**
   * Records a touched change-set path under `raw` (no exit/pattern gate;
   * deduped, capped). Creates the bucket when absent.
   * @param raw The session ID that wrote/edited the path.
   * @param path The write/edit target path.
   */
  touched(raw: string, path: string): void
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
   * The executed test-file tokens correlated for `sid` (direct bucket, or
   * child promotion on the same rules `has` uses), windowed like `has`.
   * @param sid The parent (or raw) session ID to read.
   * @param since Optional inclusive lower bound (the task window).
   * @returns A copy of the correlated test-file set (empty when none).
   */
  testFiles(sid: string, since?: number): string[]
  /**
   * The touched change-set paths correlated for `sid` (same rules as
   * `testFiles`, windowed on the latest touch timestamp rather than the
   * latest hit timestamp).
   * @param sid The parent (or raw) session ID to read.
   * @param since Optional inclusive lower bound (the task window).
   * @returns A copy of the correlated touched set (empty when none).
   */
  touchedFiles(sid: string, since?: number): string[]
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
function promote(map: Map<string, EvidenceBucket>, key: string): void {
  const v = map.get(key)
  if (v !== undefined) {
    map.delete(key)
    map.set(key, v)
  }
}

/**
 * Which bucket timestamp a windowed read bounds on: `last` (the latest
 * exit-0 hit) for the hit-side reads, `lastTouch` (the latest write/edit)
 * for the touched-side read.
 */
type WindowField = "last" | "lastTouch"

/**
 * Whether a bucket satisfies the window bound: the bound compares against
 * the bucket's timestamp for the read's window field (hit timestamp for
 * `has`/`testFiles`, touch timestamp for `touchedFiles`).
 * @param bucket The bucket to check.
 * @param since The inclusive lower bound, or undefined for no bound.
 * @param field The bucket timestamp the read bounds on.
 * @returns True when the bucket qualifies.
 */
function windowQualifies(
  bucket: EvidenceBucket,
  since: number | undefined,
  field: WindowField,
): boolean {
  if (since === undefined) return true
  return bucket[field] >= since
}

/**
 * Merges a path into one of a bucket's bounded sets: deduped, newest-wins
 * (a re-seen path moves to the end), trimmed to `MAX_PATHS_PER_BUCKET`.
 * @param set The set to mutate.
 * @param path The path to record.
 */
function recordPath(set: string[], path: string): void {
  const at = set.indexOf(path)
  if (at >= 0) set.splice(at, 1)
  set.push(path)
  if (set.length > MAX_PATHS_PER_BUCKET) set.splice(0, set.length - MAX_PATHS_PER_BUCKET)
}

/**
 * Records one exit-0 hit under `raw` when the command matches the pattern,
 * scanning the command line and stdout window for test-file tokens, and
 * trimming the map to the session cap.
 * @param hits The hits map to mutate.
 * @param maxSessions The LRU session cap.
 * @param pattern The compiled evidence pattern.
 * @param testPatterns The compiled test-file regexes.
 * @param raw The session ID that ran the command.
 * @param command The command string (matched, never retained).
 * @param exit The command exit code.
 * @param stdout Optional stdout window (scanned and discarded).
 * @returns True when a hit was recorded.
 */
function recordHit(
  hits: Map<string, EvidenceBucket>,
  maxSessions: number,
  pattern: RegExp,
  testPatterns: readonly RegExp[],
  raw: string,
  command: unknown,
  exit: unknown,
  stdout: string | undefined,
): boolean {
  if (!raw) return false
  if (exit !== 0) return false
  const commandText = String(command ?? "")
  if (!pattern.test(commandText)) return false
  const bucket = hits.get(raw) ?? {
    last: 0,
    lastTouch: 0,
    hadHit: false,
    testFiles: [],
    touched: [],
  }
  bucket.last = Date.now()
  bucket.hadHit = true
  for (const file of extractTestFiles(commandText, stdout ?? "", testPatterns)) {
    recordPath(bucket.testFiles, file)
  }
  hits.set(raw, bucket)
  evictTo(hits, maxSessions)
  return true
}

/**
 * Records a touched change-set path under `raw` (no exit/pattern gate),
 * creating the bucket when absent and trimming the map to the session cap.
 * Only the bucket's touch timestamp advances (the hit timestamp is left
 * alone, so a post-window touch cannot re-qualify a pre-window hit for the
 * windowed `has`/`testFiles` reads).
 * @param hits The hits map to mutate.
 * @param maxSessions The LRU session cap.
 * @param raw The session ID that wrote/edited the path.
 * @param path The write/edit target path.
 */
function recordTouched(
  hits: Map<string, EvidenceBucket>,
  maxSessions: number,
  raw: string,
  path: string,
): void {
  if (!raw || !path) return
  const bucket = hits.get(raw) ?? {
    last: 0,
    lastTouch: 0,
    hadHit: false,
    testFiles: [],
    touched: [],
  }
  bucket.lastTouch = Date.now()
  recordPath(bucket.touched, path)
  hits.set(raw, bucket)
  evictTo(hits, maxSessions)
}

/**
 * Correlates a bucket for `sid`: a direct in-window bucket, or an in-window
 * child bucket re-keyed to `sid` (lazy promotion, so an async parent edge
 * established after the record still resolves). A stale direct bucket falls
 * through to the child scan; a filtered-out child stays keyed under the
 * child (no re-key on a miss, preserving laziness for a later call).
 * @param hits The hits map to read and re-key.
 * @param parentOf Resolves a raw session ID to its parent.
 * @param sid The parent (or raw) session ID to check.
 * @param since Optional inclusive lower bound (the task window).
 * @param field The bucket timestamp the read bounds on.
 * @returns The correlated bucket, or undefined when none qualifies.
 */
function correlateBucket(
  hits: Map<string, EvidenceBucket>,
  parentOf: (raw: string) => string,
  sid: string,
  since: number | undefined,
  field: WindowField,
): EvidenceBucket | undefined {
  if (!sid) return undefined
  // Touch unconditionally: present keys reorder to MRU, absent keys no-op.
  promote(hits, sid)
  const direct = hits.get(sid)
  if (direct && windowQualifies(direct, since, field)) return direct
  for (const [child, bucket] of hits) {
    if (parentOf(child) === sid && windowQualifies(bucket, since, field)) {
      hits.delete(child)
      hits.set(sid, bucket)
      promote(hits, sid)
      return bucket
    }
  }
  return undefined
}

/**
 * Builds the hits-map operations over one shared map, bound to the session
 * cap, the compiled pattern, the configured test-file pattern list, and the
 * parent resolver.
 * @param maxSessions The LRU session cap (`config.maxSessions`).
 * @param pattern The compiled evidence pattern.
 * @param testPatterns The compiled test-file regexes.
 * @param parentOf Resolves a raw session ID to its parent (the ledger's
 *     `parentOf`).
 * @returns The observe/touched/has/testFiles/touchedFiles/snapshot/clear
 *     operations.
 */
export function createEvidenceHits(
  maxSessions: number,
  pattern: RegExp,
  testPatterns: readonly RegExp[],
  parentOf: (raw: string) => string,
): EvidenceHits {
  // Raw session ID → evidence bucket; insertion-order LRU, capped at
  // `config.maxSessions` (mirroring state.ts bookkeeping).
  const hits = new Map<string, EvidenceBucket>()
  return {
    observe: (raw, command, exit, stdout) =>
      recordHit(hits, maxSessions, pattern, testPatterns, raw, command, exit, stdout),
    touched: (raw, path) => recordTouched(hits, maxSessions, raw, path),
    has: (sid, since) => {
      const bucket = correlateBucket(hits, parentOf, sid, since, "last")
      return bucket !== undefined && bucket.hadHit
    },
    testFiles: (sid, since) => {
      const bucket = correlateBucket(hits, parentOf, sid, since, "last")
      return bucket ? [...bucket.testFiles] : []
    },
    touchedFiles: (sid, since) => {
      const bucket = correlateBucket(hits, parentOf, sid, since, "lastTouch")
      return bucket ? [...bucket.touched] : []
    },
    snapshot(): Array<{ session: string; last: number }> {
      const view: Array<{ session: string; last: number }> = []
      for (const [session, bucket] of hits) {
        view.push({ session, last: bucket.last })
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
