/**
 * @fileoverview Pure secret-redaction for the decision-provenance ledger:
 * a fixed, ordered pattern list plus `redactSecrets`, which replaces every
 * match with the fixed `[REDACTED]` sentinel. No fs, no host access, no
 * configuration, no throwing — pure string in, string out — so capture-time
 * wiring can call it unguarded and still fail open. The pattern list is
 * deliberately fixed (not user-configurable in v1): redaction at capture is
 * the one editorial decision that cannot be taken back at read time, so the
 * capture layer refuses to become a secrets leak. This module is the single
 * place to extend the pattern list.
 */

/** The fixed replacement sentinel written over every redacted span. */
export const REDACTION_SENTINEL = "[REDACTED]"

/**
 * OpenAI-style API keys: `sk-` followed by at least 20 key characters, so
 * near-misses like a bare `sk-` prefix or a short fragment in prose
 * ("sk-1.5 models") never match.
 */
const OPENAI_KEY_RE = /\bsk-[A-Za-z0-9_-]{20,}\b/g

/**
 * AWS access key IDs: the literal `AKIA` prefix followed by exactly 16
 * uppercase alphanumeric characters (the fixed AWS key-ID shape), so a
 * truncated or prose `AKIA` mention does not match.
 */
const AWS_ACCESS_KEY_RE = /\bAKIA[0-9A-Z]{16}\b/g

/**
 * Bearer tokens in authorization headers: a `Bearer` scheme keyword followed
 * by its credential run, matched before the narrower token patterns so a
 * bearer header wrapping an `sk-` key redacts as one span.
 */
const BEARER_TOKEN_RE = /\bbearer\s+[\w.\-+=/]{8,}/gi

/**
 * Authorization headers of any scheme: an `authorization` header name, a
 * separator, and the credential value that follows it (basic, digest,
 * custom schemes alike).
 */
const AUTHORIZATION_HEADER_RE = /\bauthorization\b["']?\s*[:=]\s*["']?[\w.\-+=/]{8,}/gi

/** GitHub classic personal access tokens: the `ghp_` prefix shape. */
const GITHUB_PAT_RE = /\bghp_[A-Za-z0-9]{20,}\b/g

/** GitHub fine-grained personal access tokens: the `github_pat_` prefix shape. */
const GITHUB_FINE_PAT_RE = /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g

/**
 * Generic API-key assignments: `api_key` / `api-key` / `apikey` followed by
 * `=` or `:` and a credential-looking value, in code, env lines, or config.
 */
const API_KEY_ASSIGNMENT_RE = /\bapi[_-]?key\b["']?\s*[:=]\s*["']?[\w.\-+=/]{8,}/gi

/**
 * Generic token assignments: a bare `token` name followed by `=` or `:` and
 * a credential-looking value (the same assignment shape as API keys).
 */
const TOKEN_ASSIGNMENT_RE = /\btoken\b["']?\s*[:=]\s*["']?[\w.\-+=/]{8,}/gi

/**
 * PEM private-key blocks: from the `-----BEGIN … PRIVATE KEY-----` header to
 * the matching `-----END … PRIVATE KEY-----` footer, body included. The lazy
 * body quantifier keeps the match linear in the input length.
 */
const PRIVATE_KEY_BLOCK_RE =
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g

/**
 * The ordered redaction pattern list — the canonical source of what the
 * provenance capture layer masks. Order matters: broader spans (headers,
 * blocks) precede narrower token shapes so overlapping matches converge onto
 * the widest span. Frozen: consumers must not mutate it.
 */
export const SECRET_PATTERNS: readonly RegExp[] = Object.freeze([
  PRIVATE_KEY_BLOCK_RE,
  BEARER_TOKEN_RE,
  AUTHORIZATION_HEADER_RE,
  OPENAI_KEY_RE,
  AWS_ACCESS_KEY_RE,
  GITHUB_PAT_RE,
  GITHUB_FINE_PAT_RE,
  API_KEY_ASSIGNMENT_RE,
  TOKEN_ASSIGNMENT_RE,
])

/**
 * Apply every pattern to `text` once, returning the single-pass result.
 * Global regexes with `lastIndex` state are reset before use so repeated
 * calls on the same pattern are safe.
 *
 * @param text - The text to redact in one pass.
 * @returns The text with every pattern match replaced by the sentinel.
 */
function applyAllPatterns(text: string): string {
  let result = text
  for (const pattern of SECRET_PATTERNS) {
    pattern.lastIndex = 0
    result = result.replace(pattern, REDACTION_SENTINEL)
  }
  return result
}

/**
 * Redact every known secret pattern in `text`, replacing each match with
 * `[REDACTED]`. Passes repeat until the text stabilizes, so overlapping
 * patterns converge (e.g. a bearer header whose value is itself an `sk-`
 * key masks as one span). The sentinel matches no pattern, so each pass
 * strictly shrinks the matchable content and the loop terminates. All
 * patterns are linear-time (no nested quantifiers), keeping pathological
 * inputs bounded.
 *
 * @param text - The text to redact.
 * @returns The redacted text, or the input unchanged when nothing matches.
 */
export function redactSecrets(text: string): string {
  let current = text
  for (;;) {
    const next = applyAllPatterns(current)
    if (next === current) return current
    current = next
  }
}
