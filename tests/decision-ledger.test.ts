/**
 * @fileoverview The pure decision-ledger entry builders in `src/decision-ledger.ts`:
 * shape tests, the redact-then-truncate ordering and cap boundary, and the
 * JSON-round-trip stability constraint (canonical serializability for the
 * deferred tamper-evidence design).
 */

import { test } from "node:test"
import assert from "node:assert/strict"

import {
  LEDGER_PATH_CAP,
  LEDGER_TEXT_CAP,
  provDeniedEntry,
  provOverrideEntry,
  provStatedEntry,
  provWaiverEntry,
} from "../src/decision-ledger.ts"

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
  // The raw secret straddles the cap boundary (raw positions CAP-20..CAP+5)
  // while trailing filler pushes the redacted text just over the cap, so the
  // sentinel lands fully inside the prefix. If redaction ever ran after
  // truncation, the raw `sk-` prefix would survive inside the cap and this
  // test would fail; with cap-length filler before the secret the assertion
  // was vacuous because the secret sat entirely past the slice point.
  const secret = "sk-abc123DEF456ghi789JKLmno"
  const entry = provStatedEntry({
    sessionID: "ses_1",
    text: `${"x".repeat(LEDGER_TEXT_CAP - 21)} ${secret} ${"x".repeat(30)}`,
  })
  assert.equal(entry.truncated, true)
  assert.equal(entry.text.length, LEDGER_TEXT_CAP)
  assert.ok(
    entry.text.includes("[REDACTED]"),
    "the sentinel sits fully inside the prefix, proving redaction ran first",
  )
  assert.ok(!entry.text.includes("sk-"), "no raw secret may survive truncation")
})

test("provStatedEntry: text exactly at the cap is not truncated", () => {
  const entry = provStatedEntry({ sessionID: "ses_1", text: "a".repeat(LEDGER_TEXT_CAP) })
  assert.equal(entry.truncated, false)
  assert.equal(entry.text.length, LEDGER_TEXT_CAP)
})

test("provStatedEntry: text one over the cap is truncated to the cap", () => {
  const entry = provStatedEntry({ sessionID: "ses_1", text: "a".repeat(LEDGER_TEXT_CAP + 1) })
  assert.equal(entry.truncated, true)
  assert.equal(entry.text.length, LEDGER_TEXT_CAP)
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

// ── prov:override ────────────────────────────────────────────────────────────

test("provOverrideEntry: shapes the override row with keys in construction order", () => {
  assert.deepEqual(provOverrideEntry({ sessionID: "p1", tool: "edit", path: "/r/a.ts", child: "c1" }), {
    type: "prov:override",
    sessionID: "p1",
    tool: "edit",
    path: "/r/a.ts",
    child: "c1",
  })
})

test("provOverrideEntry: redacts secrets in the path", () => {
  const entry = provOverrideEntry({
    sessionID: "p1",
    tool: "write",
    path: "/r/sk-abc123DEF456ghi789JKLmno/a.ts",
    child: "c1",
  })
  assert.ok(entry.path.includes("[REDACTED]"), "the secret must be masked")
  assert.ok(!entry.path.includes("sk-"), "no raw secret may survive")
})

test("provOverrideEntry: caps the path at LEDGER_PATH_CAP", () => {
  const entry = provOverrideEntry({
    sessionID: "p1",
    tool: "edit",
    path: `/r/${"a".repeat(LEDGER_PATH_CAP)}/b.ts`,
    child: "c1",
  })
  assert.equal(entry.path.length, LEDGER_PATH_CAP)
})

// ── canonical serializability ────────────────────────────────────────────────

test("every builder round-trips JSON byte-identically with construction-order keys", () => {
  const entries = [
    provStatedEntry({ sessionID: "ses_1", text: "continue" }),
    provDeniedEntry({ sessionID: "ses_2", kind: "plan" }),
    provWaiverEntry({ sessionID: "ses_3", stages: ["plan"] }),
    provOverrideEntry({ sessionID: "p1", tool: "edit", path: "/r/a.ts", child: "c1" }),
  ]
  for (const entry of entries) {
    const serialized = JSON.stringify(entry)
    const parsed = JSON.parse(serialized) as Record<string, unknown>
    assert.equal(JSON.stringify(parsed), serialized, "round-trip must be byte-identical")
    assert.ok(!serialized.includes("undefined"), "no undefined fields may serialize")
    assert.equal(Object.keys(parsed)[0], "type", "key order must match construction order")
  }
})
