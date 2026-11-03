/**
 * @fileoverview Config-validation boundary: scalar patch-value validation and
 * the post-merge resolved-config invariants. Split out of `src/config.ts` so
 * the merge boundary stays about layering, not about per-key type rules.
 * Pure decision logic; warning strings are byte-identical to the historical
 * ones produced inside `config.ts`.
 */

import * as path from "node:path"

import { CANONICAL_GATE_MARKER, CANONICAL_VERDICT_MARKER, GATE_RE, VERDICT_RE } from "./markers.ts"
import type { TurnstileConfig } from "./types.ts"

/**
 * Identity sentinel for "bareOutput not configured": `defaultConfig()` stores
 * this exact reference for `agents.bareOutput`, and derivation fires only when
 * the resolved list is still this reference. `mergeConfig` always stores a
 * fresh array for an explicitly configured list, so a non-empty explicit list
 * — including a reordered copy of the default names — is distinguishable from
 * the unset default regardless of its contents. An explicit empty list is not:
 * JSON cannot express this reference, so the shipped example carries an empty
 * one, and derivation treats an empty list as unset to keep that copy from
 * denying every marker. Defined here (not in `config.ts`) so the validation
 * boundary can key off the sentinel by reference identity without a circular
 * import; `config.ts` re-exports it.
 */
export const BARE_OUTPUT_UNSET: string[] = []

/** Config keys whose only valid value is a boolean. */
const BOOLEAN_KEYS: readonly (keyof TurnstileConfig)[] = [
  "trace",
  "journalPerSession",
  "continuationCarry",
  "allowSuspend",
  "intentNudge",
  "alwaysEnforce",
  "planImpactStrict",
]

/** Config keys whose valid value is a non-empty string. */
const NON_EMPTY_STRING_KEYS: readonly (keyof TurnstileConfig)[] = [
  "waiverMarker",
  "approvalMarker",
  "suspendMarker",
  "resumeMarker",
  "taskDoneMarker",
  "plansDir",
]

/** Config keys accepting a fixed literal set, with the accepted literals.
 *  Definitive: a non-matching value is rejected outright. */
const LITERAL_KEYS: Partial<Record<keyof TurnstileConfig, readonly string[]>> = {
  sessionSummary: ["on", "quiet", "off"],
  escalation: ["ask", "block"],
}

/** Config keys whose literal check is non-final: a non-matching value falls
 *  through to the numeric default arm, mirroring the historical if-chain
 *  (a numeric value for one of these keys validated and assigned). */
const FALL_THROUGH_LITERAL_KEYS: Partial<Record<keyof TurnstileConfig, readonly string[]>> = {
  gateEvidence: ["enforce", "flag", "off"],
  reviewEnsemble: ["enforce", "advise"],
}

/**
 * Decides a boolean-family key. Definitive: a boolean key never falls through
 * to the numeric default, so `trace: 1` is rejected even though 1 is a
 * positive integer.
 * @param key Config key being set.
 * @param value Candidate value.
 * @returns True when the key is a boolean key and the value is a boolean.
 */
function isValidBooleanKey(key: keyof TurnstileConfig, value: unknown): boolean {
  return BOOLEAN_KEYS.includes(key) && typeof value === "boolean"
}

/**
 * Decides a string-family key: `metricsDir` must be a non-empty absolute
 * path, the marker/literal-path keys a non-empty string, and the marker
 * regex-source keys any string (an empty source is legal — it matches
 * nothing, which the breadth probe in `validateResolved` reports).
 * @param key Config key being set.
 * @param value Candidate value.
 * @returns True when the value is valid for the key; false when the key is a
 *     string-family key and the value is invalid; undefined when the key is
 *     not in the string family at all (the caller falls through).
 */
function stringKeyResult(key: keyof TurnstileConfig, value: unknown): boolean | undefined {
  if (key === "metricsDir") {
    return typeof value === "string" && value.trim().length > 0 && path.isAbsolute(value)
  }
  if (NON_EMPTY_STRING_KEYS.includes(key)) {
    return typeof value === "string" && value.trim().length > 0
  }
  if (key === "gateMarker" || key === "verdictMarker") return typeof value === "string"
  return undefined
}

/**
 * Decides a literal-set key. `sessionSummary` and `escalation` are definitive
 * (a non-matching value is rejected); `gateEvidence` and `reviewEnsemble` are
 * non-final — a non-matching value falls through to the numeric default arm,
 * mirroring the historical if-chain (a numeric value for one of these keys
 * validated and assigned).
 * @param key Config key being set.
 * @param value Candidate value.
 * @returns True when the value is one of the key's accepted literals; false
 *     when the key is a definitive literal key with a non-matching value;
 *     undefined when the caller must continue (a fall-through literal key
 *     with a non-matching value, or a key outside the literal family).
 */
function isValidLiteralKey(key: keyof TurnstileConfig, value: unknown): boolean | undefined {
  if (LITERAL_KEYS[key]) return LITERAL_KEYS[key]!.includes(value as string)
  if (FALL_THROUGH_LITERAL_KEYS[key]) {
    return FALL_THROUGH_LITERAL_KEYS[key]!.includes(value as string) || undefined
  }
  return undefined
}

/**
 * Decides a numeric-family key. `observeSessions` and `agentMarkerRetry`
 * accept integers >= 0 so 0 can be set explicitly to end an observe period /
 * disable the marker retry; every other numeric key keeps the
 * positive-integer rule (Number.isInteger subsumes the finite check, so
 * NaN/Infinity are rejected as non-integers).
 * @param key Config key being set.
 * @param value Candidate value.
 * @returns True when the value is an integer in the key's allowed range.
 */
function isValidNumberKey(key: keyof TurnstileConfig, value: unknown): boolean {
  if (key === "observeSessions" || key === "agentMarkerRetry") {
    return typeof value === "number" && Number.isInteger(value) && value >= 0
  }
  return typeof value === "number" && Number.isInteger(value) && value > 0
}

/**
 * Validates a patch value for a scalar key.
 * @param key Config key being set.
 * @param value Candidate value.
 * @returns true when the value has the right type for the key.
 */
export function isValidScalar(key: keyof TurnstileConfig, value: unknown): boolean {
  // Boolean keys are terminal: a boolean key never falls through to the
  // string/literal/numeric arms, so `trace: 1` is rejected even though 1 is
  // a positive integer.
  if (BOOLEAN_KEYS.includes(key)) return isValidBooleanKey(key, value)
  const stringResult = stringKeyResult(key, value)
  if (stringResult !== undefined) return stringResult
  const literalResult = isValidLiteralKey(key, value)
  if (literalResult !== undefined) return literalResult
  if (key === "evidencePattern" && typeof value === "string") {
    // A non-compiling pattern is rejected so `new RegExp` never throws later.
    try {
      new RegExp(value, "i")
      return true
    } catch {
      return false
    }
  }
  return isValidNumberKey(key, value)
}

/**
 * Warns when a user-configured marker regex differs from the shipped default
 * on the match-oracle probes — i.e. it accepts text the canonical syntax
 * rejects. This is a match-oracle, not a full subsumption proof: it is sound
 * (never warns for a source that matches no more than the default on the
 * probes) but incomplete (broadening that the probes do not exercise is not
 * caught). The signal is probe-divergence, not a subsumption proof, so a
 * narrower un-anchored source can also trip it when it matches a probe the
 * default does not. A missing `^` start anchor is caught by a probe that leads
 * the canonical marker with junk; a `.*` end broadening is caught by a probe
 * that trails it. A source that matches neither probe (a disjoint custom
 * syntax) stays silent, so an intentional re-skinning never trips a false
 * positive.
 * @param label The config key name to surface in the warning.
 * @param source The user-provided regex source string.
 * @param defaultRe The compiled canonical regex to compare against.
 * @param canonical A canonical example the default regex must match.
 * @returns One warning string when the source matches a probe the default
 *     rejects, otherwise undefined.
 */
function warnIfBroaderMarker(
  label: string,
  source: string,
  defaultRe: RegExp,
  canonical: string,
): string | undefined {
  if (source === defaultRe.source) return undefined
  let compiled: RegExp
  try {
    compiled = new RegExp(source, "gm")
  } catch {
    // A source that cannot compile already fell back to the default at setup
    // time (journaled there); there is nothing left to warn about here.
    return undefined
  }
  for (const probe of [`noise ${canonical}`, `${canonical} trailing noise`]) {
    const defaultMatches: string[] = probe.match(defaultRe) ?? []
    const userMatches: string[] = probe.match(compiled) ?? []
    // `String.match` (never `.test`): the `g` flag's `lastIndex` would make a
    // stateful `.test` unreliable. A user match the default does not produce
    // for the same probe is the divergence signal.
    if (userMatches.some((m) => !defaultMatches.includes(m))) {
      return `config: ${label} differs from the default marker regex: it matches "${probe}" which the default does not match`
    }
  }
  return undefined
}

/**
 * Probes both configured marker regex sources against the canonical examples.
 * @param config The resolved config to probe.
 * @returns One warning per diverging marker source, gate first.
 */
function markerWarnings(config: TurnstileConfig): string[] {
  const warnings: string[] = []
  const gateWarning = warnIfBroaderMarker(
    "gateMarker",
    config.gateMarker,
    GATE_RE,
    CANONICAL_GATE_MARKER,
  )
  if (gateWarning) warnings.push(gateWarning)
  const verdictWarning = warnIfBroaderMarker(
    "verdictMarker",
    config.verdictMarker,
    VERDICT_RE,
    CANONICAL_VERDICT_MARKER,
  )
  if (verdictWarning) warnings.push(verdictWarning)
  return warnings
}

/**
 * Clamps `readWarn` below `readBlock` when a hand-built config inverts the
 * budget, mutating `config` in place.
 * @param config The resolved config to correct in place.
 * @returns The clamp warning, or undefined when the budget is ordered.
 */
function readBudgetWarning(config: TurnstileConfig): string | undefined {
  if (config.readWarn < config.readBlock) return undefined
  const warn = config.readWarn
  const block = config.readBlock
  config.readWarn = Math.max(block - 1, 0)
  return `config: readWarn (${warn}) >= readBlock (${block}); clamping readWarn to ${config.readWarn}`
}

/**
 * Checks the path-shaped invariants: an explicit empty `bareOutput` about to
 * be re-derived, a relative `metricsDir`, and an absolute `plansDir`.
 * @param config The resolved config to check.
 * @returns One warning per violated path invariant, in field order.
 */
function pathWarnings(config: TurnstileConfig): string[] {
  const warnings: string[] = []
  if (config.agents.bareOutput !== BARE_OUTPUT_UNSET && config.agents.bareOutput.length === 0) {
    warnings.push(
      `config: agents.bareOutput is an explicit empty list; deriving from the configured agent names (an empty list would deny every child-session marker)`,
    )
  }
  if (!path.isAbsolute(config.metricsDir)) {
    warnings.push(
      `config: metricsDir "${config.metricsDir}" is relative; journaling resolves against the process cwd`,
    )
  }
  if (path.isAbsolute(config.plansDir)) {
    warnings.push(
      `config: plansDir "${config.plansDir}" is absolute; enforced as-is (the project directory is ignored)`,
    )
  }
  return warnings
}

/**
 * Warns when the `enforce` ensemble is mechanically unsatisfiable: with
 * maxReviewerRounds < 2 the second required reviewer dispatch is capped away.
 * Warns (does not clamp — clamping upward would violate the user's cap
 * intent); the human escalation path is the escape.
 * @param config The resolved config to check.
 * @returns The ensemble warning, or undefined when satisfiable.
 */
function ensembleWarning(config: TurnstileConfig): string | undefined {
  if (config.reviewEnsemble !== "enforce" || config.maxReviewerRounds >= 2) return undefined
  return `config: reviewEnsemble enforce needs maxReviewerRounds >= 2 (got ${config.maxReviewerRounds}); a second reviewer dispatch will be capped, escalate to the user`
}

/**
 * Defends the fully-resolved config against inter-key and path invariants that
 * no single layer validator catches, so hand-constructed configs cannot slip a
 * bad value past the merge-time checks. Mutates `config` in place (clamping
 * `readWarn` below `readBlock`, warning on a relative `metricsDir`, naming an
 * explicit empty `bareOutput` about to be re-derived) and returns one warning
 * string per correction.
 *
 * Called once at the end of `loadConfig` after every layer has merged, so the
 * defaults (8 < 15, absolute dir) never trip it and the golden digest stays
 * stable. Exported for tests: every merge layer forces an absolute
 * `metricsDir`, so the relative-dir warning is reachable only directly.
 * @param config The resolved config to validate.
 * @returns One warning string per corrected/resolved invariant.
 */
export function validateResolved(config: TurnstileConfig): string[] {
  const warnings = markerWarnings(config)
  const budget = readBudgetWarning(config)
  if (budget) warnings.push(budget)
  warnings.push(...pathWarnings(config))
  const ensemble = ensembleWarning(config)
  if (ensemble) warnings.push(ensemble)
  return warnings
}
