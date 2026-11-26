/**
 * @fileoverview Config-validation boundary: scalar patch-value validation and
 * the post-merge resolved-config invariants. Split out of `src/config.ts` so
 * the merge boundary stays about layering, not about per-key type rules.
 * Pure decision logic; warning strings are byte-identical to the historical
 * ones produced inside `config.ts`.
 */

import * as path from "node:path"

import { CANONICAL_GATE_MARKER, CANONICAL_VERDICT_MARKER, GATE_RE, VERDICT_RE } from "./markers.ts"
import { DEFAULT_EPOCH_ENTRIES, type TurnstileConfig } from "./types.ts"

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
  "planUserReview",
  "requirementsPhase",
  "requireTestOverlap",
]

/** Config keys whose valid value is a non-empty string. */
const NON_EMPTY_STRING_KEYS: readonly (keyof TurnstileConfig)[] = [
  "waiverMarker",
  "approvalMarker",
  "suspendMarker",
  "resumeMarker",
  "taskDoneMarker",
  "planReviewAcceptMarker",
  "planReviewRejectMarker",
  "questionCancelMarker",
  "plansDir",
]

/** Config keys accepting a fixed literal set, with the accepted literals.
 *  Definitive: a non-matching value is rejected outright. */
const LITERAL_KEYS: Partial<Record<keyof TurnstileConfig, readonly string[]>> = {
  sessionSummary: ["on", "quiet", "off"],
  tokenUsage: ["off", "summary", "per-message"],
  escalation: ["ask", "block"],
  questionTimeoutAction: ["hold", "resume"],
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
  if (
    key === "observeSessions" ||
    key === "agentMarkerRetry" ||
    key === "journalArchiveGenerations" ||
    key === "questionTimeoutMinutes"
  ) {
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
 * positive. A second probe category checks capture-less-ness: a source whose
 * match on a probe carrying the primary keyword only in trailing prose would
 * classify as the primary via the substring fallback in `classifyMarkerResult`
 * is warned to add a capture group.
 * @param label The config key name to surface in the warning.
 * @param source The user-provided regex source string.
 * @param defaultRe The compiled canonical regex to compare against.
 * @param canonical A canonical example the default regex must match.
 * @param primary The keyword mapping to the primary result.
 * @param other The keyword mapping to the other result.
 * @returns One warning string when the source matches a probe the default
 *     rejects or would misclassify via the substring fallback, otherwise
 *     undefined.
 */
function warnIfBroaderMarker(
  label: string,
  source: string,
  defaultRe: RegExp,
  canonical: string,
  primary: string,
  other: string,
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
  return warnIfCapturelessMarker(label, compiled, canonical, primary, other)
}

/**
 * Warns when a custom marker source is capture-less in a way that makes the
 * substring fallback in `classifyMarkerResult` load-bearing: on a probe where
 * the primary keyword appears only in trailing prose (after the other
 * keyword's canonical position), a match with no capture group classifies as
 * the primary purely because its matched span contains the keyword. The
 * compiled source is assumed valid and different from the default (the caller
 * guards both). Diagnostic-only: runtime classification is unchanged.
 * @param label The config key name to surface in the warning.
 * @param compiled The user's compiled marker regex (`gm` flags).
 * @param canonical A canonical example the default regex matches.
 * @param primary The keyword mapping to the primary result.
 * @param other The keyword mapping to the other result.
 * @returns One warning string when a capture-less match would misclassify,
 *     otherwise undefined.
 */
function warnIfCapturelessMarker(
  label: string,
  compiled: RegExp,
  canonical: string,
  primary: string,
  other: string,
): string | undefined {
  const probe = `${canonical.replace(primary, other)} -- see ${primary} criteria`
  const userMatches: string[] = probe.match(compiled) ?? []
  for (const match of userMatches) {
    // Recompute group 1 the way `classifyMarkerResult` does (matchAll on a
    // cloned global regex), so the probe mirrors the runtime fallback.
    const group = Array.from(match.matchAll(compiled), (m) => m[1]).at(0)
    if (group === undefined && match.includes(primary)) {
      return `config: ${label} has no capture group for the result keyword: a match whose text merely contains "${primary}" (e.g. "${probe}") classifies as ${primary} via the substring fallback; add a capture group around the result keyword`
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
    "PASS",
    "FAIL",
  )
  if (gateWarning) warnings.push(gateWarning)
  const verdictWarning = warnIfBroaderMarker(
    "verdictMarker",
    config.verdictMarker,
    VERDICT_RE,
    CANONICAL_VERDICT_MARKER,
    "APPROVE",
    "BLOCK",
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
 * Warns when `tamperEvidence.epochEntries` is out of bounds and resets it to
 * the default: a non-positive or non-integer value would never (or
 * unpredictably) close an epoch, and a pathological value would balloon the
 * in-memory epoch hash list. The reset keeps the warning truthful — the
 * value the journaler then runs with is the default, not the out-of-bounds
 * one.
 * @param config The resolved config to check (mutated on correction).
 * @returns The epoch-entries warning, or undefined when in bounds.
 */
function epochEntriesWarning(config: TurnstileConfig): string | undefined {
  const n = config.tamperEvidence.epochEntries
  if (Number.isInteger(n) && n > 0 && n <= 100_000) return undefined
  config.tamperEvidence.epochEntries = DEFAULT_EPOCH_ENTRIES
  return `config: tamperEvidence.epochEntries must be a positive integer <= 100000 (got ${String(n)}); keeping default`
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
  const epoch = epochEntriesWarning(config)
  if (epoch) warnings.push(epoch)
  return warnings
}
