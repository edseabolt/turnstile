/**
 * @fileoverview The pure secret-redaction module `src/provenance-redact.ts`:
 * table-driven pattern coverage (a positive and a near-miss negative per
 * pattern), overlapping-pattern convergence, and a bounded-time
 * pathological-input guard for the repeat-application loop.
 */

import { test } from "node:test"
import assert from "node:assert/strict"

import { REDACTION_SENTINEL, SECRET_PATTERNS, redactSecrets } from "../src/provenance-redact.ts"

// ── pattern table: positive + near-miss negative per pattern ─────────────────

test("redactSecrets: each pattern matches its secret shape and not its near-miss", () => {
  const cases: Array<{ name: string; positive: string; negative: string }> = [
    {
      name: "OpenAI-style API key",
      positive: "use sk-abc123DEF456ghi789JKLmno before deploy",
      negative: "prefer the sk- short model prefix in prose",
    },
    {
      name: "AWS access key",
      positive: "deploy AKIAIOSFODNN7EXAMPLE now",
      negative: "the AKIA prefix alone is not a key",
    },
    {
      name: "bearer token",
      positive: "curl -H 'Authorization: Bearer abcdef123456' url",
      negative: "the bearer scheme name alone carries no credential",
    },
    {
      name: "authorization header",
      positive: 'authorization: "dXNlcjpwYXNzMTIz"',
      negative: "an authorization header with no value is not a secret",
    },
    {
      name: "GitHub classic PAT",
      positive: "token ghp_0123456789abcdefghij for the push",
      negative: "ghp_ alone is not a token",
    },
    {
      name: "GitHub fine-grained PAT",
      positive: "use github_pat_0123456789_abcdefghij today",
      negative: "github_pat_ alone is not a token",
    },
    {
      name: "api key assignment",
      positive: "api_key=supersecretvalue1 in env",
      negative: "api_key with no value assigns nothing",
    },
    {
      name: "token assignment",
      positive: "token: anothersecret12 in config",
      negative: "the word token by itself is prose",
    },
    {
      name: "private key block",
      positive: "-----BEGIN RSA PRIVATE KEY-----\nMIIEow\n-----END RSA PRIVATE KEY-----",
      negative: "a public key block is not a private key",
    },
  ]
  for (const { name, positive, negative } of cases) {
    assert.ok(
      redactSecrets(positive).includes(REDACTION_SENTINEL),
      `${name}: positive case must redact`,
    )
    assert.equal(
      redactSecrets(negative),
      negative,
      `${name}: near-miss negative case must be untouched`,
    )
  }
})

test("redactSecrets: an sk- key shorter than 20 characters does not match", () => {
  const text = "key sk-abc123def456 stays"
  assert.equal(redactSecrets(text), text)
})

test("redactSecrets: an AKIA id shorter than 16 trailing characters does not match", () => {
  const text = "id AKIA123456 stays"
  assert.equal(redactSecrets(text), text)
})

// ── overlap convergence ──────────────────────────────────────────────────────

test("redactSecrets: a bearer header wrapping an sk- key converges to one sentinel", () => {
  const text = "Authorization: Bearer sk-abc123DEF456ghi789JKLmno"
  const out = redactSecrets(text)
  assert.equal(out, `Authorization: ${REDACTION_SENTINEL}`)
  assert.ok(!out.includes("sk-"))
})

test("redactSecrets: repeated application is idempotent on already-redacted text", () => {
  const once = redactSecrets("token sk-abc123DEF456ghi789JKLmno here")
  assert.equal(redactSecrets(once), once)
})

// ── bounded time ─────────────────────────────────────────────────────────────

test("redactSecrets: a backtracking-shaped 2000-char input completes quickly", () => {
  const pathological = `token=${"a".repeat(1996)}!`
  const start = Date.now()
  const out = redactSecrets(pathological)
  const elapsed = Date.now() - start
  assert.ok(elapsed < 1000, `redaction took ${elapsed}ms, must stay bounded`)
  assert.equal(out, `${REDACTION_SENTINEL}!`)
})

// ── pattern-list invariants ──────────────────────────────────────────────────

test("SECRET_PATTERNS is a frozen non-empty ordered list of global regexes", () => {
  assert.ok(SECRET_PATTERNS.length >= 6)
  assert.ok(Object.isFrozen(SECRET_PATTERNS))
  for (const pattern of SECRET_PATTERNS) {
    assert.equal(pattern.global, true)
  }
})
