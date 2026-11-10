/**
 * @fileoverview Decision-ledger shape pins: one test per `prov:*` builder
 * asserting the exact key set, the absence of a builder-side `ts` (the
 * journaler prepends it), `truncated` coherence with the text cap actually
 * applied, and stable JSON key order pinned against a serialization
 * literal — plus a redaction corpus over `SECRET_PATTERNS` asserting each
 * pattern matches its synthetic secret shape and the masked output uses the
 * `[REDACTED]` sentinel. Synthetic secrets only.
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
import {
  REDACTION_SENTINEL,
  SECRET_PATTERNS,
  redactSecrets,
} from "../src/decision-ledger-redact.ts"

test("provStatedEntry pins its exact key set, no ts, and stable JSON order", () => {
  const e = provStatedEntry({ sessionID: "s1", text: "hello" })
  assert.deepEqual(Object.keys(e), ["type", "sessionID", "text", "truncated"])
  assert.equal("ts" in e, false)
  assert.equal(
    JSON.stringify(e),
    '{"type":"prov:stated","sessionID":"s1","text":"hello","truncated":false}',
  )
})

test("provDeniedEntry pins its exact key set, no ts, and stable JSON order", () => {
  const e = provDeniedEntry({ sessionID: "s1", kind: "plan" })
  assert.deepEqual(Object.keys(e), ["type", "sessionID", "kind"])
  assert.equal("ts" in e, false)
  assert.equal(JSON.stringify(e), '{"type":"prov:denied","sessionID":"s1","kind":"plan"}')
})

test("provWaiverEntry pins its exact key set, no ts, and stable JSON order", () => {
  const e = provWaiverEntry({ sessionID: "s1", stages: ["plan", "reviewer"] })
  assert.deepEqual(Object.keys(e), ["type", "sessionID", "stages"])
  assert.equal("ts" in e, false)
  assert.equal(
    JSON.stringify(e),
    '{"type":"prov:waiver","sessionID":"s1","stages":["plan","reviewer"]}',
  )
})

test("provOverrideEntry pins its exact key set, no ts, and stable JSON order", () => {
  const e = provOverrideEntry({
    sessionID: "s1",
    tool: "write",
    path: "/tmp/a.md",
    child: "c1",
  })
  assert.deepEqual(Object.keys(e), ["type", "sessionID", "tool", "path", "child"])
  assert.equal("ts" in e, false)
  assert.equal(
    JSON.stringify(e),
    '{"type":"prov:override","sessionID":"s1","tool":"write","path":"/tmp/a.md","child":"c1"}',
  )
})

test("provStatedEntry keeps truncated coherent with the text cap", () => {
  const under = provStatedEntry({ sessionID: "s1", text: "x".repeat(LEDGER_TEXT_CAP) })
  assert.equal(under.truncated, false)
  assert.equal(under.text.length, LEDGER_TEXT_CAP)
  const over = provStatedEntry({ sessionID: "s1", text: "x".repeat(LEDGER_TEXT_CAP + 5) })
  assert.equal(over.truncated, true)
  assert.equal(over.text.length, LEDGER_TEXT_CAP)
})

test("provOverrideEntry caps the path at LEDGER_PATH_CAP with no truncated flag", () => {
  const e = provOverrideEntry({
    sessionID: "s1",
    tool: "edit",
    path: "/".repeat(LEDGER_PATH_CAP + 10),
    child: "c1",
  })
  assert.equal(e.path.length, LEDGER_PATH_CAP)
  assert.equal("truncated" in e, false)
})

test("provStatedEntry redacts before truncating so a straddling secret never leaks", () => {
  const filler = "y".repeat(LEDGER_TEXT_CAP - 5)
  const e = provStatedEntry({
    sessionID: "s1",
    text: `${filler} sk-${"A".repeat(30)} tail`,
  })
  assert.equal(e.text.includes("sk-"), false)
  assert.equal(e.text.includes("A".repeat(30)), false)
  assert.equal(e.truncated, true)
})

test("every secret pattern matches its synthetic shape and redacts to the sentinel", () => {
  const corpus: Array<[RegExp, string]> = [
    [
      /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
      "-----BEGIN RSA PRIVATE KEY-----\nabc\n-----END RSA PRIVATE KEY-----",
    ],
    [/\bbearer\s+[\w.\-+=/]{8,}/i, "bearer Abcdef123456"],
    [/\bauthorization\b/i, "authorization: dXNlcjpwYXNzd29yZA"],
    [/\bsk-[A-Za-z0-9_-]{20,}\b/, "sk-Abcdefghij0123456789"],
    [/\bAKIA[0-9A-Z]{16,}\b/, "AKIAIOSFODNN7EXAMPLE"],
    [/\bghp_[A-Za-z0-9]{20,}\b/, "ghp_Abcdef0123456789ABCDE"],
    [/\bgithub_pat_[A-Za-z0-9_]{20,}\b/, "github_pat_Abcdef0123456789ABCDE"],
    [/\bapi[_-]?key\b/i, "api_key: Abcdef123456"],
    [/\btoken\b["']?\s*[:=]/i, "token = Abcdef123456"],
  ]
  assert.equal(corpus.length, SECRET_PATTERNS.length)
  for (const [pattern, secret] of corpus) {
    pattern.lastIndex = 0
    assert.equal(pattern.test(secret), true, `pattern ${pattern} matches its shape`)
    assert.equal(redactSecrets(secret), REDACTION_SENTINEL)
  }
})

test("redactSecrets masks a bearer header wrapping an sk- key as one span", () => {
  assert.equal(redactSecrets("bearer sk-Abcdefghij0123456789"), REDACTION_SENTINEL)
})
