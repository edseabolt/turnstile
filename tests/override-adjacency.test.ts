/**
 * @fileoverview The in-memory child-write adjacency tracker in
 * `src/override-adjacency.ts`: window hit/miss, expiry, per-parent cap
 * eviction, empty-path skip, and the non-consuming (window-persistent)
 * match contract.
 */

import { test } from "node:test"
import assert from "node:assert/strict"

import {
  MAX_TRACKED_CHILD_WRITES,
  OVERRIDE_WINDOW_MS,
  createOverrideAdjacency,
} from "../src/override-adjacency.ts"

test("findOverride: hits a child write to the same path within the window", () => {
  const adj = createOverrideAdjacency()
  adj.recordChildWrite("p1", "c1", "/r/a.ts", 1000)
  assert.equal(adj.findOverride("p1", "/r/a.ts", 1000 + OVERRIDE_WINDOW_MS), "c1")
})

test("findOverride: misses a different path", () => {
  const adj = createOverrideAdjacency()
  adj.recordChildWrite("p1", "c1", "/r/a.ts", 1000)
  assert.equal(adj.findOverride("p1", "/r/b.ts", 1001), "")
})

test("findOverride: misses an expired window", () => {
  const adj = createOverrideAdjacency()
  adj.recordChildWrite("p1", "c1", "/r/a.ts", 1000)
  assert.equal(adj.findOverride("p1", "/r/a.ts", 1000 + OVERRIDE_WINDOW_MS + 1), "")
})

test("findOverride: returns the newest matching child", () => {
  const adj = createOverrideAdjacency()
  adj.recordChildWrite("p1", "c1", "/r/a.ts", 1000)
  adj.recordChildWrite("p1", "c2", "/r/a.ts", 2000)
  assert.equal(adj.findOverride("p1", "/r/a.ts", 2001), "c2")
})

test("findOverride: does not consume the record (window-persistent)", () => {
  const adj = createOverrideAdjacency()
  adj.recordChildWrite("p1", "c1", "/r/a.ts", 1000)
  assert.equal(adj.findOverride("p1", "/r/a.ts", 1001), "c1")
  assert.equal(adj.findOverride("p1", "/r/a.ts", 1002), "c1")
})

test("findOverride: is keyed per parent", () => {
  const adj = createOverrideAdjacency()
  adj.recordChildWrite("p1", "c1", "/r/a.ts", 1000)
  assert.equal(adj.findOverride("p2", "/r/a.ts", 1001), "")
})

test("recordChildWrite: skips an empty path", () => {
  const adj = createOverrideAdjacency()
  adj.recordChildWrite("p1", "c1", "", 1000)
  assert.equal(adj.findOverride("p1", "", 1001), "")
})

test("recordChildWrite: prunes entries older than the window", () => {
  const adj = createOverrideAdjacency()
  adj.recordChildWrite("p1", "c1", "/r/old.ts", 0)
  // A fresh record far in the future prunes the expired one; the cap is
  // never reached, so the prune is observable only via the match below.
  adj.recordChildWrite("p1", "c2", "/r/new.ts", OVERRIDE_WINDOW_MS * 10)
  assert.equal(adj.findOverride("p1", "/r/old.ts", OVERRIDE_WINDOW_MS * 10 + 1), "")
  assert.equal(adj.findOverride("p1", "/r/new.ts", OVERRIDE_WINDOW_MS * 10 + 1), "c2")
})

test("recordChildWrite: caps each parent's array, evicting the oldest", () => {
  const adj = createOverrideAdjacency()
  const t0 = 1000
  for (let i = 0; i < MAX_TRACKED_CHILD_WRITES; i++) {
    adj.recordChildWrite("p1", `c${i}`, `/r/f${i}.ts`, t0 + i)
  }
  adj.recordChildWrite("p1", "clast", "/r/last.ts", t0 + MAX_TRACKED_CHILD_WRITES)
  // The oldest record was evicted; the newest survives.
  assert.equal(adj.findOverride("p1", "/r/f0.ts", t0 + MAX_TRACKED_CHILD_WRITES + 1), "")
  assert.equal(adj.findOverride("p1", "/r/last.ts", t0 + MAX_TRACKED_CHILD_WRITES + 1), "clast")
})
