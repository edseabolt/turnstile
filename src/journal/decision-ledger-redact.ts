/**
 * @fileoverview Pure secret-redaction for the decision ledger:
 * an ordered pattern list plus `redactSecrets`, which replaces every
 * match with the fixed `[REDACTED]` sentinel. No fs, no host access, no
 * throwing — pure string in, string out — so capture-time
 * wiring can call it unguarded and still fail open. The built-in pattern
 * list is the default; a caller holding a resolved config threads its
 * compiled list (built-ins plus configured extras, from
 * `src/secret-patterns.ts`) in as a parameter, so configured extras extend
 * redaction without this module reading config.
 */

import { compileSecretPatterns } from "./secret-patterns.ts"

/** The fixed replacement sentinel written over every redacted span. */
export const REDACTION_SENTINEL = "[REDACTED]"

/**
 * The ordered built-in redaction pattern list — the compiled built-in
 * sources from `src/secret-patterns.ts` (the canonical home of the pattern
 * definitions). Order matters: broader spans (headers, blocks) precede
 * narrower token shapes so overlapping matches converge onto the widest
 * span. Frozen: consumers must not mutate it.
 */
export const SECRET_PATTERNS: readonly RegExp[] = Object.freeze(compileSecretPatterns(null, []))

/**
 * Apply every pattern to `text` once, returning the single-pass result.
 * Global regexes with `lastIndex` state are reset before use so repeated
 * calls on the same pattern are safe.
 *
 * @param text - The text to redact in one pass.
 * @param patterns - The compiled patterns to apply.
 * @returns The text with every pattern match replaced by the sentinel.
 */
function applyAllPatterns(text: string, patterns: readonly RegExp[]): string {
  let result = text
  for (const pattern of patterns) {
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
 * @param patterns - The compiled patterns to apply; defaults to the
 *     built-in list (callers with a resolved config pass the compiled
 *     built-ins-plus-extras list from `src/secret-patterns.ts`).
 * @returns The redacted text, or the input unchanged when nothing matches.
 */
export function redactSecrets(text: string, patterns: readonly RegExp[] = SECRET_PATTERNS): string {
  let current = text
  for (;;) {
    const next = applyAllPatterns(current, patterns)
    if (next === current) return current
    current = next
  }
}
