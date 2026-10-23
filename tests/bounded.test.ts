/**
 * @fileoverview Bounded-eviction unit tests: `evictTo` trims a map or set to
 * a cap by evicting the oldest-inserted key first (insertion-order FIFO —
 * Map and Set iterate in insertion order, so a re-set entry moves to the
 * newest end and survives). Also covers the cap<=0 clear, the at/below-cap
 * no-op, and a cap+1 single-evict. Pure: operates on the caller's
 * collection, no host, no journal.
 */

import { test } from "node:test"
import assert from "node:assert/strict"

import { evictTo } from "../src/bounded.ts"

/** A map whose values are numbers and whose stamp order differs from insertion order. */
function numericMap(): Map<string, number> {
  const m = new Map<string, number>()
  m.set("a", 100)
  m.set("b", 300)
  m.set("c", 200)
  return m
}

/** Eviction follows first-set order even when values are numbers. */
test("evictTo trims a numeric map from the oldest-inserted key", () => {
  const m = numericMap()
  evictTo(m, 1)
  assert.deepEqual([...m.keys()], ["c"])
  assert.equal(m.get("c"), 200)
})

/** Evicting to cap+1 removes exactly the single oldest-inserted entry. */
test("evictTo removes exactly one entry when over cap by one", () => {
  const m = new Map<string, number>([
    ["a", 1],
    ["b", 2],
  ])
  evictTo(m, 1)
  assert.deepEqual([...m.keys()], ["b"])
})

/** Re-setting an existing key keeps its first-insertion position. */
test("evictTo order ignores value re-assignment of an existing key", () => {
  const m = new Map<string, number>([
    ["a", 1],
    ["b", 2],
  ])
  m.set("a", 9)
  evictTo(m, 1)
  assert.deepEqual([...m.keys()], ["b"])
  assert.equal(m.get("b"), 2)
})

/** An insertion-ordered map with non-number values evicts the oldest key first. */
test("evictTo trims an insertion-ordered map from the oldest key", () => {
  const m = new Map<string, true>([
    ["a", true],
    ["b", true],
    ["c", true],
  ])
  evictTo(m, 2)
  assert.deepEqual([...m.keys()], ["b", "c"])
})

/** A set is evicted from the oldest-inserted key. */
test("evictTo trims a set from the oldest-inserted key", () => {
  const s = new Set(["a", "b", "c"])
  evictTo(s, 2)
  assert.deepEqual([...s], ["b", "c"])
})

/** A map already at or under the cap is left untouched. */
test("evictTo is a no-op when the collection is at or under the cap", () => {
  const m = new Map<string, number>([["a", 1]])
  evictTo(m, 5)
  assert.deepEqual([...m.keys()], ["a"])
  const s = new Set(["a", "b"])
  evictTo(s, 2)
  assert.deepEqual([...s], ["a", "b"])
})

/** A cap of zero or less empties the collection. */
test("evictTo clears the collection when the cap is zero or less", () => {
  const m = new Map<string, number>([
    ["a", 1],
    ["b", 2],
  ])
  evictTo(m, 0)
  assert.equal(m.size, 0)
  const s = new Set(["a", "b"])
  evictTo(s, -1)
  assert.equal(s.size, 0)
})
