/**
 * @fileoverview Evidence-tracker unit tests: observe/has/clear semantics,
 * exit-code and pattern gating, child→parent attribution with lazy re-key,
 * LRU eviction beyond maxSessions, and the invalid-pattern fallback. Pure
 * against an injected parent resolver (no host, no journal).
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

/** (AC-4) a non-zero exit and a non-matching command never count, alone or combined. */
test("evidence never counts a non-zero exit or a non-matching command", () => {
  const t = createEvidenceTracker(cfg(), identityParent)
  t.observe("c1", "ls -la", 1)
  assert.equal(t.has("c1"), false)
  t.observe("c1", "git status", 0)
  assert.equal(t.has("c1"), false)
})

/** (AC-4) clear drops the parent bucket and every child whose edge resolves to it. */
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

/** (AC-7) LRU eviction beyond maxSessions evicts the oldest bucket only. */
test("evidence evicts the least-recently-used bucket beyond maxSessions", () => {
  const t = createEvidenceTracker({ ...cfg(), maxSessions: 2 }, identityParent)
  t.observe("a", "npm test", 0) // oldest
  t.observe("b", "npm test", 0)
  t.observe("c", "npm test", 0) // evicts a
  assert.equal(t.has("a"), false)
  assert.equal(t.has("b"), true)
  assert.equal(t.has("c"), true)
})

/** (AC-8) a bad evidencePattern fires onFallback once and still matches npm test
 *  via the default fallback pattern. */
test("evidence falls back to the default pattern on a bad evidencePattern", () => {
  const causes: unknown[] = []
  const t = createEvidenceTracker({ ...cfg(), evidencePattern: "(" }, identityParent, (cause) =>
    causes.push(cause),
  )
  assert.equal(causes.length, 1)
  assert.equal(t.has("c1"), false)
  t.observe("c1", "npm test", 0)
  assert.equal(t.has("c1"), true)
})

/** (AC-8) the default pattern matches the repo-relevant JS and non-JS runners. */
test("default evidence pattern matches npm test and pytest", () => {
  const t = createEvidenceTracker(cfg(), identityParent)
  assert.equal(t.observe("c1", "npm test", 0), true)
  assert.equal(t.observe("c2", "python -m pytest", 0), true)
  assert.equal(
    DEFAULT_EVIDENCE_PATTERN,
    "\\b(npm\\s+(run\\s+)?test|pnpm\\s+test|yarn\\s+test|bun\\s+test|deno\\s+test|node\\s+--test|npx\\s+node\\s+--test|pytest|make\\s+test(\\s|$)|go\\s+test|cargo\\s+test)\\b",
  )
})
