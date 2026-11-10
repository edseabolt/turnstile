/**
 * @fileoverview In-memory child-write adjacency for `prov:override` capture:
 * records pipeline-child write/edit target paths per parent and matches a
 * later parent write/edit to the same path within a bounded time window.
 * No I/O, no journal re-reading, never touches child session content —
 * only the in-process record of journaled child-write telemetry.
 */

/**
 * How long after a pipeline-child write a parent edit to the same path
 * still counts as an override. A config key would be premature; revisit
 * if read-time filtering proves insufficient.
 */
export const OVERRIDE_WINDOW_MS = 15 * 60 * 1000

/** Cap on tracked child writes per parent (bounded memory, drop oldest). */
export const MAX_TRACKED_CHILD_WRITES = 64

/** One recorded pipeline-child write target. */
interface ChildWriteRecord {
  /** The child session that performed the write. */
  child: string
  /** The raw target path as the host reported it. */
  path: string
  /** The record time (ms epoch). */
  at: number
}

/**
 * The adjacency tracker surface: record child writes, find a matching
 * child for a parent edit. `findOverride` never consumes the record —
 * every completed parent edit inside the window journals its own row.
 */
export type OverrideAdjacency = {
  /**
   * Records a pipeline-child write target for the parent (skips empty
   * paths), prunes expired entries, and caps the parent's array.
   * @param parent The parent session ID.
   * @param child The child session ID.
   * @param path The raw target path.
   * @param now The record time (ms epoch).
   */
  recordChildWrite(parent: string, child: string, path: string, now: number): void
  /**
   * Finds the newest non-expired child write to the exact same path.
   * @param parent The parent session ID.
   * @param path The parent edit's target path.
   * @param now The match time (ms epoch).
   * @returns The child session ID, or "" when nothing matches.
   */
  findOverride(parent: string, path: string, now: number): string
}

/**
 * Creates the adjacency tracker. Records are keyed per parent and bounded:
 * entries older than {@link OVERRIDE_WINDOW_MS} are pruned on access and
 * each parent holds at most {@link MAX_TRACKED_CHILD_WRITES} records.
 * @returns The tracker.
 */
export function createOverrideAdjacency(): OverrideAdjacency {
  const writes = new Map<string, ChildWriteRecord[]>()
  return {
    recordChildWrite(parent, child, path, now) {
      if (path === "") return
      const arr = (writes.get(parent) ?? []).filter((r) => now - r.at <= OVERRIDE_WINDOW_MS)
      arr.push({ child, path, at: now })
      while (arr.length > MAX_TRACKED_CHILD_WRITES) arr.shift()
      writes.set(parent, arr)
    },
    findOverride(parent, path, now) {
      const arr = writes.get(parent) ?? []
      for (let i = arr.length - 1; i >= 0; i--) {
        const r = arr[i]!
        if (now - r.at <= OVERRIDE_WINDOW_MS && r.path === path) return r.child
      }
      return ""
    },
  }
}
