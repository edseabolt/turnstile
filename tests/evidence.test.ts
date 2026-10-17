/**
 * @fileoverview Evidence-tracker unit tests: observe/has/clear semantics,
 * exit-code and pattern gating, child→parent attribution with lazy re-key,
 * the windowed has (task-window lower bound) and snapshot (pure-read
 * diagnostic view), LRU eviction beyond maxSessions, and the invalid-pattern
 * fallback. Pure against an injected parent resolver (no host, no journal).
 */

import { test } from "node:test"
import assert from "node:assert/strict"

import { DEFAULT_EVIDENCE_PATTERN } from "../src/config.ts"
import { createEvidenceTracker } from "../src/evidence.ts"
import { defaultConfig } from "../src/config.ts"

/** A pass-through parent resolver: every raw session resolves to itself. */
const identityParent = (raw: string): string => raw

/** A resolver mapping the recorded children to a shared parent p1. */
function parentOfP1(): (raw: string) => string {
  const edges = new Map<string, string>([
    ["c1", "p1"],
    ["c2", "p1"],
  ])
  return (raw: string): string => edges.get(raw) ?? raw
}

/** A fresh default config (XDG untouched; nothing writes to the real env). */
function cfg(overrides: Record<string, unknown> = {}): ReturnType<typeof defaultConfig> {
  return defaultConfig(overrides as Record<string, string | undefined>) as ReturnType<
    typeof defaultConfig
  >
}

/** observe records only exit-0 commands matching the evidence pattern. */
test("evidence.observe records exit-0 test commands and ignores others", () => {
  const t = createEvidenceTracker(cfg(), identityParent)
  assert.equal(t.observe("c1", "npm test", 0), true)
  assert.equal(t.observe("c1", "node --test", 0), true)
  assert.equal(t.observe("c1", "echo hi", 0), false)
  assert.equal(t.observe("c1", "npm test", 1), false)
  assert.equal(t.observe("c1", "npm test", undefined), false)
  assert.equal(t.observe("", "npm test", 0), false)
})

/** has(sid) is true once a matching exit-0 hit is observed under sid. */
test("evidence.has reflects a direct hit", () => {
  const t = createEvidenceTracker(cfg(), identityParent)
  assert.equal(t.has("c1"), false)
  t.observe("c1", "pnpm test", 0)
  assert.equal(t.has("c1"), true)
})

/** a non-zero exit and a non-matching command never count, alone or combined. */
test("evidence never counts a non-zero exit or a non-matching command", () => {
  const t = createEvidenceTracker(cfg(), identityParent)
  t.observe("c1", "ls -la", 1)
  assert.equal(t.has("c1"), false)
  t.observe("c1", "git status", 0)
  assert.equal(t.has("c1"), false)
})

/** clear drops the parent bucket and every child whose edge resolves to it. */
test("evidence.clear drops the parent bucket and its children", () => {
  const t = createEvidenceTracker(cfg(), parentOfP1())
  t.observe("c1", "pytest", 0)
  t.observe("c2", "pytest", 0)
  assert.equal(t.has("p1"), true)
  t.clear("p1")
  assert.equal(t.has("p1"), false)
})

/** (lazy re-key) a child's hit resolves to the parent once its edge exists:
 *  observe under the child, has(parent) promotes the bucket to the parent. */
test("evidence.has attributes a child hit to the parent and re-keys it", () => {
  const edges = new Map<string, string>([["c1", "p1"]])
  const parentOf = (raw: string): string => edges.get(raw) ?? raw
  const t = createEvidenceTracker(cfg(), parentOf)
  t.observe("c1", "go test", 0)
  assert.equal(t.has("p1"), true)
  // Re-keyed: a direct has(p1) still finds the bucket now under p1.
  assert.equal(t.has("p1"), true)
})

/** LRU eviction beyond maxSessions evicts the oldest bucket only. */
test("evidence evicts the least-recently-used bucket beyond maxSessions", () => {
  const t = createEvidenceTracker({ ...cfg(), maxSessions: 2 }, identityParent)
  t.observe("a", "npm test", 0) // oldest
  t.observe("b", "npm test", 0)
  t.observe("c", "npm test", 0) // evicts a
  assert.equal(t.has("a"), false)
  assert.equal(t.has("b"), true)
  assert.equal(t.has("c"), true)
})

/** The per-session ring trims to the last MAX_HITS_PER_SESSION hits. */
test("evidence trims the per-session hit ring to the cap", () => {
  const t = createEvidenceTracker(cfg(), identityParent)
  for (let i = 0; i < 12; i++) assert.equal(t.observe("c1", "npm test", 0), true)
  assert.equal(t.has("c1"), true)
})

/** A zero maxSessions cap evicts every hit immediately. */
test("a zero maxSessions cap evicts every recorded hit", () => {
  const t = createEvidenceTracker({ ...cfg(), maxSessions: 0 }, identityParent)
  t.observe("a", "npm test", 0)
  assert.equal(t.has("a"), false)
})

/** clear("") and clear of an unknown parent are safe no-ops. */
test("evidence.clear no-ops on an empty id and tolerates children of others", () => {
  const t = createEvidenceTracker(cfg(), parentOfP1())
  t.clear("")
  t.observe("c1", "pytest", 0)
  t.clear("other-parent")
  assert.equal(t.has("p1"), true)
})

/** a bad evidencePattern journals the fallback once and still matches npm test
 *  via the default fallback pattern. */
test("evidence falls back to the default pattern on a bad evidencePattern", () => {
  const entries: Array<Record<string, unknown>> = []
  const t = createEvidenceTracker({ ...cfg(), evidencePattern: "(" }, identityParent, {
    journal: (entry: Record<string, unknown>): void => {
      entries.push(entry)
    },
  })
  assert.equal(entries.length, 1)
  const first = entries[0] as Record<string, unknown>
  assert.equal(first.type, "error")
  assert.match(String(first.error), /evidencePattern/)
  assert.equal(t.has("c1"), false)
  t.observe("c1", "npm test", 0)
  assert.equal(t.has("c1"), true)
})

/** The windowed has excludes a bucket whose latest hit predates the window
 *  and includes a same-millisecond-boundary hit (inclusive join). */
test("evidence.has with a task window bounds by the latest hit (inclusive)", () => {
  const t = createEvidenceTracker(cfg(), identityParent)
  t.observe("c1", "npm test", 0)
  const last = t.snapshot()[0]!.last
  assert.equal(t.has("c1", last), true, "same-millisecond boundary is inclusive")
  assert.equal(t.has("c1", last + 1), false, "a predating hit is outside the window")
  // The un-windowed check is unaffected by the windowed miss.
  assert.equal(t.has("c1"), true)
})

/** A windowed miss does not re-key: the child bucket stays under the child,
 *  and a later qualifying call still re-keys it (laziness preserved). */
test("evidence.has with a task window keeps a filtered-out child keyed under the child", () => {
  const edges = new Map<string, string>([["c1", "p1"]])
  const parentOf = (raw: string): string => edges.get(raw) ?? raw
  const t = createEvidenceTracker(cfg(), parentOf)
  t.observe("c1", "npm test", 0)
  const last = t.snapshot()[0]!.last
  assert.equal(t.has("p1", last + 1), false, "out-of-window: no attribution")
  assert.deepEqual(
    t.snapshot().map((e) => e.session),
    ["c1"],
    "no re-key on a miss",
  )
  assert.equal(t.has("p1", last), true, "a later in-window call re-keys")
  assert.deepEqual(
    t.snapshot().map((e) => e.session),
    ["p1"],
  )
})

/** A stale direct bucket does not hide an in-window child hit: the windowed
 *  check falls through to the child scan, and a window beyond every hit
 *  still reports false. */
test("evidence.has with a task window falls through a stale direct bucket to an in-window child", async () => {
  const edges = new Map<string, string>([["c1", "p1"]])
  const parentOf = (raw: string): string => edges.get(raw) ?? raw
  const t = createEvidenceTracker(cfg(), parentOf)
  t.observe("p1", "npm test", 0)
  const staleLast = t.snapshot().find((e) => e.session === "p1")!.last
  // A distinct-millisecond gap so the child's hit is strictly later.
  await new Promise((resolve) => setTimeout(resolve, 10))
  t.observe("c1", "npm test", 0)
  assert.equal(t.has("p1", staleLast + 1), true, "the in-window child qualifies")
  const childLast = t.snapshot().find((e) => e.session === "p1")!.last
  assert.equal(t.has("p1", childLast + 1), false, "a window beyond every hit is false")
})

/** snapshot returns copies (mutations never reach the tracker) and includes
 *  every tracked session with its latest timestamp. */
test("evidence.snapshot copies every tracked session with its latest timestamp", () => {
  const t = createEvidenceTracker(cfg(), identityParent)
  t.observe("a", "npm test", 0)
  t.observe("b", "pytest", 0)
  const view = t.snapshot()
  assert.deepEqual([...view].map((e) => e.session).sort(), ["a", "b"])
  for (const e of view) assert.equal(typeof e.last, "number")
  view.push({ session: "ghost", last: 0 })
  view[0]!.last = 0
  assert.equal(t.snapshot().length, 2, "mutating the view never touches the tracker")
  assert.equal(t.has("ghost"), false)
})

/** snapshot is a pure read: the eviction order after a snapshot matches a
 *  control tracker that never called one (no LRU promotion). */
test("evidence.snapshot is a pure read that leaves the eviction order unchanged", () => {
  const t = createEvidenceTracker({ ...cfg(), maxSessions: 2 }, identityParent)
  const control = createEvidenceTracker({ ...cfg(), maxSessions: 2 }, identityParent)
  t.observe("a", "npm test", 0)
  control.observe("a", "npm test", 0)
  t.observe("b", "npm test", 0)
  control.observe("b", "npm test", 0)
  t.snapshot()
  t.observe("c", "npm test", 0)
  control.observe("c", "npm test", 0)
  assert.equal(t.has("a"), false, "the oldest bucket evicted as in the control")
  assert.equal(t.has("b"), true)
  assert.equal(t.has("c"), true)
  assert.equal(control.has("a"), false)
  assert.equal(control.has("b"), true)
})

/** the default pattern matches the repo-relevant JS and non-JS runners. */
test("default evidence pattern matches npm test and pytest", () => {
  const t = createEvidenceTracker(cfg(), identityParent)
  assert.equal(t.observe("c1", "npm test", 0), true)
  assert.equal(t.observe("c2", "python -m pytest", 0), true)
  assert.equal(
    DEFAULT_EVIDENCE_PATTERN,
    "\\b(npm\\s+(run\\s+)?test|pnpm\\s+test|yarn\\s+test|bun\\s+test|deno\\s+test|node\\s+--test|npx\\s+node\\s+--test|pytest|make\\s+test(\\s|$)|go\\s+test|cargo\\s+test)\\b",
  )
})
