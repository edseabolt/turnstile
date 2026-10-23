/**
 * Shared bounded-collection eviction.
 *
 * turnstile keeps several small in-memory maps and sets at a bounded size.
 * Every one of them evicts in first-set order: the entry inserted earliest
 * (the one `map.keys()` or the set iterator yields first) is removed until
 * the collection is within its cap. Note that re-setting an existing key
 * keeps its original position — `Map` and `Set` order by first insertion.
 *
 * Fail-open contract: callers pass already-resolved caps; this module never
 * throws. A cap of zero or less empties the collection.
 *
 * @module bounded
 */

/**
 * Evicts entries from the oldest-inserted end of a map or set until it is
 * within `cap`, so the collection never grows past the bound. `Map` and
 * `Set` iterate in first-insertion order, so the first key is the oldest
 * entry (re-setting an existing key keeps its original position). A cap
 * of zero or less empties the collection.
 * @template K The key type.
 * @template V The value type of a `Map`; unused for a `Set`.
 * @param map The map or set to trim.
 * @param cap The maximum number of entries to retain.
 */
export function evictTo<K, V>(map: Map<K, V> | Set<K>, cap: number): void {
  if (cap <= 0) {
    map.clear()
    return
  }
  if (map.size <= cap) return
  while (map.size > cap) {
    // The loop condition guarantees a first key exists.
    const oldest = map.keys().next().value as K
    map.delete(oldest)
  }
}
