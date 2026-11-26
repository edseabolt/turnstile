/**
 * @fileoverview Canonical secret-pattern boundary: the built-in credential
 * pattern list (the single source both journal redaction and the write-time
 * guard consume), the compiler that appends configured extra sources to it,
 * and the advisory high-entropy heuristic. No fs, no host access, no
 * throwing — a non-compiling extra source is dropped with a journaled error
 * so a config typo weakens detection visibly, never silently. Built-ins are
 * never replaceable: redaction at capture time cannot be taken back, so the
 * configured list only ever extends the built-ins.
 */

import type { Journaler } from "./journal.ts"

/** One built-in secret pattern: its regex source and compile flags. */
export interface SecretPatternSource {
  /** The regex source string. */
  source: string
  /** The flags the pattern compiles with (built-ins keep their historical flags). */
  flags: string
}

/**
 * The ordered built-in secret-pattern sources — the canonical source of what
 * the ledger capture layer masks and what the write-time guard flags. Order
 * matters: broader spans (headers, blocks) precede narrower token shapes so
 * overlapping matches converge onto the widest span. Frozen: consumers must
 * not mutate it.
 */
export const BUILTIN_SECRET_PATTERN_SOURCES: readonly SecretPatternSource[] = Object.freeze([
  // PEM private-key blocks: header to matching footer, body included. The
  // lazy body quantifier keeps the match linear in the input length.
  {
    source: "-----BEGIN [A-Z ]*PRIVATE KEY-----[\\s\\S]*?-----END [A-Z ]*PRIVATE KEY-----",
    flags: "g",
  },
  // Bearer tokens in authorization headers, matched before the narrower
  // token patterns so a bearer header wrapping an `sk-` key redacts as one
  // span.
  { source: "\\bbearer\\s+[\\w.\\-+=/]{8,}", flags: "gi" },
  // Authorization headers of any scheme: an `authorization` header name, a
  // separator, and the credential value that follows it.
  { source: "\\bauthorization\\b[\"']?\\s*[:=]\\s*[\"']?[\\w.\\-+=/]{8,}", flags: "gi" },
  // OpenAI-style API keys: `sk-` followed by at least 20 key characters, so
  // near-misses like a bare `sk-` prefix or a short fragment in prose
  // ("sk-1.5 models") never match.
  { source: "\\bsk-[A-Za-z0-9_-]{20,}\\b", flags: "g" },
  // AWS access key IDs: the literal `AKIA` prefix followed by 16 or more
  // uppercase alphanumeric characters (the AWS key-ID shape). `{16,}` with
  // the trailing word boundary backtracks correctly; a fixed `{16}` would
  // drop the whole match when the run continues.
  { source: "\\bAKIA[0-9A-Z]{16,}\\b", flags: "g" },
  // GitHub classic personal access tokens: the `ghp_` prefix shape.
  { source: "\\bghp_[A-Za-z0-9]{20,}\\b", flags: "g" },
  // GitHub fine-grained personal access tokens: the `github_pat_` shape.
  { source: "\\bgithub_pat_[A-Za-z0-9_]{20,}\\b", flags: "g" },
  // Generic API-key assignments: `api_key` / `api-key` / `apikey` followed by
  // `=` or `:` and a credential-looking value.
  { source: "\\bapi[_-]?key\\b[\"']?\\s*[:=]\\s*[\"']?[\\w.\\-+=/]{8,}", flags: "gi" },
  // Generic token assignments: a bare `token` name followed by `=` or `:`
  // and a credential-looking value.
  { source: "\\btoken\\b[\"']?\\s*[:=]\\s*[\"']?[\\w.\\-+=/]{8,}", flags: "gi" },
])

/**
 * Compiles the resolved secret-pattern list: the built-ins in their canonical
 * order, then the configured extra sources (each compiled with `"g"`). A
 * non-compiling extra is dropped with a journaled `{type:"error"}` naming its
 * index, mirroring the denylist compiler's wording, so a config typo is never
 * silent. Never throws.
 * @param journaler The telemetry writer for drop entries; null compiles
 *     silently (callers without a journaler yet, tests).
 * @param extraSources The configured extra regex sources, appended in order.
 * @returns The compiled pattern list (fresh instances, so `lastIndex` state
 *     is never shared across compilations).
 */
export function compileSecretPatterns(
  journaler: Journaler | null,
  extraSources: readonly string[],
): RegExp[] {
  const patterns = BUILTIN_SECRET_PATTERN_SOURCES.map((s) => new RegExp(s.source, s.flags))
  extraSources.forEach((source, index) => {
    try {
      patterns.push(new RegExp(source, "g"))
    } catch {
      journaler?.journal({
        type: "error",
        error: `secret patterns: dropped invalid secrets.patterns[${index}] regex "${source}"; it detects nothing`,
      })
    }
  })
  return patterns
}

/** Candidate run shape for the entropy heuristic: 20+ credential-charset chars. */
const ENTROPY_RUN_RE = /[A-Za-z0-9_\-+/=]{20,}/g

/** Minimum Shannon entropy (bits/char) for a run to flag. */
const ENTROPY_THRESHOLD = 4.0

/** Cap on flagged literals per call, bounding journal volume. */
const ENTROPY_FLAG_CAP = 5

/**
 * Shannon entropy of a string in bits/char: `-Σ p log2 p` over the character
 * frequency distribution.
 * @param s The string to measure.
 * @returns The entropy in bits per character.
 */
function shannonEntropy(s: string): number {
  const counts = new Map<string, number>()
  for (const ch of s) counts.set(ch, (counts.get(ch) ?? 0) + 1)
  let entropy = 0
  for (const count of counts.values()) {
    const p = count / s.length
    entropy -= p * Math.log2(p)
  }
  return entropy
}

/**
 * True when a candidate run plausibly carries secret material: at least one
 * letter and one digit (prose runs and pure punctuation-joined paths never
 * qualify).
 * @param run The candidate run.
 * @returns True when the run has both a letter and a digit.
 */
function hasLetterAndDigit(run: string): boolean {
  return /[A-Za-z]/.test(run) && /[0-9]/.test(run)
}

/**
 * Extracts high-entropy literal candidates from text: runs of 20+ characters
 * from the credential charset that carry at least one letter and one digit
 * and whose Shannon entropy exceeds 4.0 bits/char. Advisory-only: callers
 * journal a flag row and never block on it. Capped at 5 flags per call.
 * @param text The text to scan.
 * @returns The flagged runs (at most 5, in first-seen order).
 */
export function findHighEntropyLiterals(text: string): string[] {
  const flags: string[] = []
  for (const match of text.matchAll(ENTROPY_RUN_RE)) {
    if (flags.length >= ENTROPY_FLAG_CAP) break
    const run = match[0]
    if (hasLetterAndDigit(run) && shannonEntropy(run) > ENTROPY_THRESHOLD) flags.push(run)
  }
  return flags
}
