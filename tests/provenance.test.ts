/**
 * @fileoverview The pure provenance entry builders in `src/provenance.ts`:
 * shape tests, the redact-then-truncate ordering and cap boundary, and the
 * JSON-round-trip stability constraint (canonical serializability for the
 * deferred tamper-evidence design).
 */

import { test } from "node:test"
import assert from "node:assert/strict"

import {
  PROVENANCE_TEXT_CAP,
  provDeniedEntry,
  provStatedEntry,
  provWaiverEntry,
} from "../src/provenance.ts"

// ── prov:stated ──────────────────────────────────────────────────────────────

test("provStatedEntry: shapes a plain prompt with truncated false", () => {
  const entry = provStatedEntry({ sessionID: "ses_1", text: "continue" })
  assert.deepEqual(entry, {
    type: "prov:stated",
    sessionID: "ses_1",
    text: "continue",
    truncated: false,
  })
})

test("provStatedEntry: redacts secrets before capping", () => {
  const secret = "sk-abc123DEF456ghi789JKLmno"
  const filler = "x".repeat(PROVENANCE_TEXT_CAP)
  const entry = provStatedEntry({ sessionID: "ses_1", text: `${filler} ${secret}` })
  assert.equal(entry.truncated, true)
  assert.equal(entry.text.length, PROVENANCE_TEXT_CAP)
  assert.ok(!entry.text.includes("sk-"), "a secret straddling the cap must be masked first")
})

test("provStatedEntry: text exactly at the cap is not truncated", () => {
  const entry = provStatedEntry({ sessionID: "ses_1", text: "a".repeat(PROVENANCE_TEXT_CAP) })
  assert.equal(entry.truncated, false)
  assert.equal(entry.text.length, PROVENANCE_TEXT_CAP)
})

test("provStatedEntry: text one over the cap is truncated to the cap", () => {
  const entry = provStatedEntry({ sessionID: "ses_1", text: "a".repeat(PROVENANCE_TEXT_CAP + 1) })
  assert.equal(entry.truncated, true)
  assert.equal(entry.text.length, PROVENANCE_TEXT_CAP)
})

// ── prov:denied ──────────────────────────────────────────────────────────────

test("provDeniedEntry: shapes each ask kind", () => {
  for (const kind of ["plan", "landing", "hands-on"] as const) {
    assert.deepEqual(provDeniedEntry({ sessionID: "ses_2", kind }), {
      type: "prov:denied",
      sessionID: "ses_2",
      kind,
    })
  }
})

// ── prov:waiver (unwired shape) ──────────────────────────────────────────────

test("provWaiverEntry: shapes the covered stages", () => {
  assert.deepEqual(provWaiverEntry({ sessionID: "ses_3", stages: ["plan", "landing"] }), {
    type: "prov:waiver",
    sessionID: "ses_3",
    stages: ["plan", "landing"],
  })
})

// ── canonical serializability ────────────────────────────────────────────────

test("every builder round-trips JSON byte-identically with construction-order keys", () => {
  const entries = [
    provStatedEntry({ sessionID: "ses_1", text: "continue" }),
    provDeniedEntry({ sessionID: "ses_2", kind: "plan" }),
    provWaiverEntry({ sessionID: "ses_3", stages: ["plan"] }),
  ]
  for (const entry of entries) {
    const serialized = JSON.stringify(entry)
    const parsed = JSON.parse(serialized) as Record<string, unknown>
    assert.equal(JSON.stringify(parsed), serialized, "round-trip must be byte-identical")
    assert.ok(!serialized.includes("undefined"), "no undefined fields may serialize")
    assert.equal(Object.keys(parsed)[0], "type", "key order must match construction order")
  }
})
