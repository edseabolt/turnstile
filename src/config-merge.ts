/**
 * @fileoverview Config-merge boundary: per-section patch merging for
 * `mergeConfig` and the `agents`/`toolPolicy`/`gitGates` default sub-objects.
 * Split out of `src/config.ts` so the merge arms are one concern per helper;
 * every warning string is byte-identical to the historical arms.
 */

import { BARE_OUTPUT_UNSET, isValidScalar } from "./config-validate.ts"
import type {
  TurnstileAgents,
  TurnstileConfig,
  TurnstileGitGates,
  TurnstileDecisionLedger,
  TurnstileToolPolicy,
} from "./types.ts"

/**
 * Canonical default name of the reviewer agent whose task-result verdicts
 * credit the landing gate. `defaultConfig()` stores it for `agents.reviewer`,
 * and the ledger's verdict replay credits only verdict rows attributed to the
 * configured reviewer name (passed through from `config.agents.reviewer`), so
 * a plan-reviewer verdict, a legacy unattributed row, or a hostile/degraded
 * agent never restores `hasReviewApprove` on restart. Defined here (next to
 * the default agents block that stores it) so the merge boundary has no
 * circular import with `config.ts`, which re-exports it.
 */
export const CANONICAL_REVIEWER_AGENT = "reviewer"

/**
 * Default conventional-commits regex SOURCE string for `gitGates.commitFormat`
 * (compiled by callers with `new RegExp("^" + source + "$", "s")`). It accepts
 * a single type from the conventional set `{feat,fix,docs,style,refactor,perf,
 * test,build,ci,chore,revert}`, an optional `(scope)`, a required `!` or `:`
 * separator (only one is needed — no `BREAKING CHANGE` trailer), a subject of
 * up to 72 characters on the first line, and one optional following body line.
 * Note the source carries no leading `^`/trailing `$`: the caller wraps them.
 * Defined here (next to the default gitGates block that stores it) so the
 * merge boundary has no circular import with `config.ts`, which re-exports it.
 */
export const DEFAULT_COMMIT_FORMAT =
  "(?:feat|fix|docs|style|refactor|perf|test|build|ci|chore|revert)(?:\\([^)]*\\))?(?:[!]:?|:) [^\\r\\n]{1,72}(?:(?:\\r?\\n){1,2}[^\\r\\n]*)?"

/**
 * Builds the default `agents` sub-object: the five pipeline stage names plus
 * the unset `bareOutput` sentinel (derivation resolves it after merge).
 * @returns The default agents block.
 */
export function defaultAgents(): TurnstileAgents {
  return {
    planner: "planner",
    reviewer: CANONICAL_REVIEWER_AGENT,
    planReviewer: "plan-reviewer",
    executor: "executor",
    testRunner: "test-runner",
    debugger: "debugger",
    bareOutput: BARE_OUTPUT_UNSET,
  }
}

/**
 * Builds the default `toolPolicy` sub-object.
 * @returns The default tool-policy block.
 */
export function defaultToolPolicy(): TurnstileToolPolicy {
  return {
    // `bashDeny` is the tool for pattern-based shell denies the host
    // permission system cannot express; a configured list replaces this
    // default wholesale (the merge semantics are unchanged). Empty by
    // default: runtime consent for an operation belongs to the host
    // permission system's `ask` rules — a denylist cannot observe "the
    // user explicitly asked", so a hardcoded list would hard-block the
    // legitimate, user-requested case.
    bashDeny: [],
    // No default path blocks: write/edit are covered (a decision is made and,
    // on block, journaled) without breaking ordinary editing.
    pathDeny: [],
    observeSessionMove: true,
    // File-writing bash goes through the hands-on ladder: only confident
    // writer shapes gate (`cat > f`, `tee f`, `sed -i`, `cp`/`mv`/...);
    // output capture (`npm test > log`, `> /dev/null`) never gates, so the
    // writer-head set is the zero-false-positive surface. The session-wide
    // escape hatch is the TURNSTILE OFF: suspend marker.
    bashWriteGate: true,
  }
}

/**
 * Builds the default `gitGates` sub-object.
 * @returns The default git-gates block.
 */
export function defaultGitGates(): TurnstileGitGates {
  return {
    commitMessages: true,
    commitFormat: DEFAULT_COMMIT_FORMAT,
    landingGate: true,
    // Default on: the probe releases only pushes git proves land nothing
    // (ref-equal upstream, no force flags), so it never bypasses review of
    // real work. Set false for the strict opt-out. Tests that assert a
    // push blocks pass this key explicitly (false) so they stay
    // deterministic against the live repo's git state.
    emptyDiffExempt: true,
    // Blind-retry escalation for the commit lint: after this many failed
    // attempts for the same session within the window, the block message
    // appends a full canonical example (see src/tool-policy-guards.ts).
    commitRetryThreshold: 3,
    commitRetryWindowMs: 60_000,
  }
}

/**
 * Assigns a validated scalar into the config without erasing the key→type
 * correlation the validator just established.
 * @param config The config to mutate.
 * @param key The validated config key.
 * @param value The validated value.
 */
function assignScalar(config: TurnstileConfig, key: keyof TurnstileConfig, value: unknown): void {
  if (key === "trace") config.trace = value as boolean
  else if (key === "journalPerSession") config.journalPerSession = value as boolean
  else if (key === "sessionSummary") config.sessionSummary = value as "on" | "quiet" | "off"
  else if (key === "metricsDir") config.metricsDir = value as string
  else if (key === "waiverMarker") config.waiverMarker = value as string
  else if (key === "approvalMarker") config.approvalMarker = value as string
  else if (key === "plansDir") config.plansDir = value as string
  else if (key === "gateMarker") config.gateMarker = value as string
  else if (key === "verdictMarker") config.verdictMarker = value as string
  else if (key === "gateEvidence") config.gateEvidence = value as TurnstileConfig["gateEvidence"]
  else if (key === "reviewEnsemble")
    config.reviewEnsemble = value as TurnstileConfig["reviewEnsemble"]
  else if (key === "evidencePattern") config.evidencePattern = value as string
  else if (key === "continuationCarry") config.continuationCarry = value as boolean
  else if (key === "suspendMarker") config.suspendMarker = value as string
  else if (key === "resumeMarker") config.resumeMarker = value as string
  else if (key === "taskDoneMarker") config.taskDoneMarker = value as string
  else if (key === "allowSuspend") config.allowSuspend = value as boolean
  else if (key === "intentNudge") config.intentNudge = value as boolean
  else if (key === "alwaysEnforce") config.alwaysEnforce = value as boolean
  else if (key === "planImpactStrict") config.planImpactStrict = value as boolean
  else if (key === "planUserReview") config.planUserReview = value as boolean
  else if (key === "planReviewAcceptMarker") config.planReviewAcceptMarker = value as string
  else if (key === "planReviewRejectMarker") config.planReviewRejectMarker = value as string
  else if (key === "observeSessions") config.observeSessions = value as number
  else if (key === "agentMarkerRetry") config.agentMarkerRetry = value as number
  else config[key as keyof TurnstileConfig] = value as never
}

/** Scalar keys whose invalid-value warning names the accepted literals. */
const SCALAR_WARNINGS: Record<string, string> = {
  gateEvidence: `config: gateEvidence must be "enforce", "flag", or "off"; keeping default`,
  reviewEnsemble: `config: reviewEnsemble must be "enforce" or "advise"; keeping default`,
  sessionSummary: `config: sessionSummary must be "on", "quiet", or "off"; keeping default`,
  escalation: `config: escalation must be "block" or "ask"; keeping default`,
}

/**
 * Validates and assigns one top-level scalar patch key. The four
 * literal-wording keys (`gateEvidence`, `reviewEnsemble`, `sessionSummary`,
 * `escalation`) share the validate/assign helpers and diverge only in warning
 * wording, carried by `SCALAR_WARNINGS`; every other key uses the generic
 * invalid-value warning.
 * @param config The config to mutate.
 * @param key The scalar config key being merged.
 * @param value The candidate value.
 * @param warnings The warning list to append to.
 */
export function mergeScalarKey(
  config: TurnstileConfig,
  key: string,
  value: unknown,
  warnings: string[],
): void {
  if (isValidScalar(key as keyof TurnstileConfig, value)) {
    assignScalar(config, key as keyof TurnstileConfig, value)
  } else {
    warnings.push(SCALAR_WARNINGS[key] ?? `config: invalid value for "${key}"; keeping default`)
  }
}

/**
 * Consumes the editor-convention `$schema` key silently when it is a string
 * (it lives in the config file the schema validates and is not a
 * TurnstileConfig key); a non-string is not a usable URI/path, so it warns.
 * @param value The `$schema` patch value.
 * @param warnings The warning list to append to.
 */
function mergeSchemaKey(value: unknown, warnings: string[]): void {
  if (typeof value !== "string") {
    warnings.push('config: "$schema" must be a string URI or path; ignored')
  }
}

/**
 * Merges the `agents` patch section one level deep. `bareOutput` must be an
 * array of non-empty strings (copied, so a mutated injected options object
 * never retro-mutates the live config); other keys must be non-empty strings
 * naming known agents.
 * @param config The config to mutate.
 * @param value The `agents` patch value.
 * @param warnings The warning list to append to.
 */
export function mergeAgentsPatch(
  config: TurnstileConfig,
  value: unknown,
  warnings: string[],
): void {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    warnings.push(`config: agents must be an object; keeping defaults`)
    return
  }
  for (const [agentKey, agentValue] of Object.entries(value as Record<string, unknown>)) {
    if (agentKey === "bareOutput") {
      mergeBareOutput(config.agents, agentValue, warnings)
      continue
    }
    if (!(agentKey in config.agents)) {
      warnings.push(`config: unknown agents key "${agentKey}" ignored`)
      continue
    }
    if (typeof agentValue === "string" && agentValue.trim().length > 0) {
      const name = agentKey as "reviewer" | "planReviewer" | "executor" | "testRunner" | "debugger"
      config.agents[name] = agentValue
    } else {
      warnings.push(`config: agents.${agentKey} must be a non-empty string; keeping default`)
    }
  }
}

/**
 * Validates and copies a `bareOutput` patch value into the agents block.
 * @param agents The agents block to mutate.
 * @param value The candidate `bareOutput` value.
 * @param warnings The warning list to append to.
 */
function mergeBareOutput(agents: TurnstileAgents, value: unknown, warnings: string[]): void {
  if (Array.isArray(value) && value.every((v) => typeof v === "string" && v.trim().length > 0)) {
    // Copy: a mutated injected options object must not retro-mutate the live
    // config.
    agents.bareOutput = [...(value as string[])]
  } else {
    warnings.push(
      `config: agents.bareOutput must be an array of non-empty strings; keeping default`,
    )
  }
}

/**
 * Validates one denylist element: a non-empty string that compiles as a
 * case-insensitive regex. Bad elements are dropped individually with one
 * warning each so a single typo never discards the whole user list, nor
 * silently widens the policy.
 * @param sources The validated sources accumulated so far.
 * @param tpKey The denylist key (for warning wording).
 * @param index The element index (for warning wording).
 * @param src The candidate element.
 * @param warnings The warning list to append to.
 */
function mergeDenyElement(
  sources: string[],
  tpKey: string,
  index: number,
  src: unknown,
  warnings: string[],
): void {
  if (typeof src !== "string" || src.trim().length === 0) {
    warnings.push(
      `config: toolPolicy.${tpKey}[${index}] is not a non-empty string; dropping element`,
    )
    return
  }
  try {
    new RegExp(src, "i")
    sources.push(src)
  } catch {
    warnings.push(`config: toolPolicy.${tpKey}[${index}] is not a valid regex; dropping element`)
  }
}

/**
 * Merges a `bashDeny`/`pathDeny` patch value. Only the value itself being
 * non-array falls back to the default (fail-safe); otherwise every element is
 * validated individually and the validated list replaces the default
 * wholesale.
 * @param merged The tool-policy block being built.
 * @param tpKey The denylist key (`bashDeny` or `pathDeny`).
 * @param tpValue The candidate list value.
 * @param warnings The warning list to append to.
 */
function mergeDenyList(
  merged: TurnstileToolPolicy,
  tpKey: "bashDeny" | "pathDeny",
  tpValue: unknown,
  warnings: string[],
): void {
  if (!Array.isArray(tpValue)) {
    warnings.push(
      `config: toolPolicy.${tpKey} must be an array of non-empty strings; keeping default`,
    )
    return
  }
  const sources: string[] = []
  tpValue.forEach((src, i) => mergeDenyElement(sources, tpKey, i, src, warnings))
  merged[tpKey] = sources
}

/**
 * Merges one `toolPolicy` sub-key into the block being built.
 * @param merged The tool-policy block being built.
 * @param tpKey The sub-key name.
 * @param tpValue The candidate sub-key value.
 * @param warnings The warning list to append to.
 */
function mergeToolPolicyKey(
  merged: TurnstileToolPolicy,
  tpKey: string,
  tpValue: unknown,
  warnings: string[],
): void {
  if (tpKey === "mode") {
    // Legacy key from the removed tool-policy meta-mode: dropped, never
    // honored, and surfaced so a user config cannot silently lose the knob it
    // still names.
    warnings.push(
      'config: unknown key "toolPolicy.mode" removed — the bash/path denylist is now always enforced; use TURNSTILE OFF: to suspend',
    )
  } else if (tpKey === "observeSessionMove" || tpKey === "bashWriteGate") {
    if (typeof tpValue === "boolean") {
      merged[tpKey] = tpValue
    } else {
      warnings.push(`config: toolPolicy.${tpKey} must be a boolean; keeping default`)
    }
  } else if (tpKey === "bashDeny" || tpKey === "pathDeny") {
    mergeDenyList(merged, tpKey, tpValue, warnings)
  } else {
    warnings.push(`config: unknown toolPolicy key "${tpKey}" ignored`)
  }
}

/**
 * Merges the `toolPolicy` patch section one level deep like `agents`. A
 * non-object keeps all defaults; each known sub-key is validated, and invalid
 * denylist elements are dropped individually (compiled with "i") with one
 * warning each so a config typo weakens the policy visibly in the journal,
 * never silently.
 * @param config The config to mutate.
 * @param value The `toolPolicy` patch value.
 * @param warnings The warning list to append to.
 */
export function mergeToolPolicyPatch(
  config: TurnstileConfig,
  value: unknown,
  warnings: string[],
): void {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    warnings.push("config: toolPolicy must be an object; keeping defaults")
    return
  }
  const merged: TurnstileToolPolicy = { ...config.toolPolicy }
  for (const [tpKey, tpValue] of Object.entries(value as Record<string, unknown>)) {
    mergeToolPolicyKey(merged, tpKey, tpValue, warnings)
  }
  config.toolPolicy = merged
}

/**
 * Merges the burst-escalation knobs: `commitRetryThreshold` is a positive
 * integer, `commitRetryWindowMs` a non-negative one (0 means only
 * same-millisecond retries accumulate; larger windows expire via the
 * elapsed-time check).
 * @param merged The git-gates block being built.
 * @param gk The sub-key name.
 * @param gv The candidate sub-key value.
 * @param warnings The warning list to append to.
 */
function mergeGitGateRetryKnob(
  merged: TurnstileGitGates,
  gk: string,
  gv: unknown,
  warnings: string[],
): void {
  const positive = gk === "commitRetryThreshold"
  if (typeof gv === "number" && Number.isInteger(gv) && (positive ? gv > 0 : gv >= 0)) {
    if (positive) merged.commitRetryThreshold = gv
    else merged.commitRetryWindowMs = gv
  } else {
    warnings.push(
      positive
        ? "config: gitGates.commitRetryThreshold must be a positive number; keeping default"
        : "config: gitGates.commitRetryWindowMs must be a non-negative number; keeping default",
    )
  }
}

/**
 * Merges one scalar `gitGates` sub-key: the burst-escalation knobs
 * (`commitRetryThreshold` positive integer, `commitRetryWindowMs`
 * non-negative integer) and `commitFormat` (a regex SOURCE compiled with the
 * same `^…$` + `"s"` wrap the caller uses, so `new RegExp` never throws).
 * @param merged The git-gates block being built.
 * @param gk The sub-key name.
 * @param gv The candidate sub-key value.
 * @param warnings The warning list to append to.
 */
function mergeGitGateScalar(
  merged: TurnstileGitGates,
  gk: string,
  gv: unknown,
  warnings: string[],
): void {
  if (gk === "commitRetryThreshold" || gk === "commitRetryWindowMs") {
    mergeGitGateRetryKnob(merged, gk, gv, warnings)
    return
  }
  if (gk !== "commitFormat") {
    warnings.push(`config: unknown gitGates key "${gk}" ignored`)
    return
  }
  if (typeof gv !== "string") {
    warnings.push("config: gitGates.commitFormat must be a string; keeping default")
  } else {
    try {
      new RegExp("^" + gv + "$", "s")
      merged.commitFormat = gv
    } catch {
      warnings.push("config: gitGates.commitFormat is not a valid regex; keeping default")
    }
  }
}

/**
 * Merges one `gitGates` sub-key into the block being built.
 * @param merged The git-gates block being built.
 * @param gk The sub-key name.
 * @param gv The candidate sub-key value.
 * @param warnings The warning list to append to.
 */
function mergeGitGateKey(
  merged: TurnstileGitGates,
  gk: string,
  gv: unknown,
  warnings: string[],
): void {
  if (gk === "mode") {
    // Legacy key from the removed gitGates meta-mode: dropped, never honored,
    // and surfaced; the booleans are the only switches now.
    warnings.push(
      'config: unknown key "gitGates.mode" removed — commit lint and the landing gate are always enforced when their boolean keys are true; use TURNSTILE OFF: to suspend',
    )
  } else if (gk === "commitMessages" || gk === "landingGate" || gk === "emptyDiffExempt") {
    if (typeof gv === "boolean") {
      if (gk === "commitMessages") merged.commitMessages = gv
      else if (gk === "landingGate") merged.landingGate = gv
      else merged.emptyDiffExempt = gv
    } else {
      warnings.push(`config: gitGates.${gk} must be a boolean; keeping default`)
    }
  } else {
    mergeGitGateScalar(merged, gk, gv, warnings)
  }
}

/**
 * Merges the `gitGates` patch section one level deep like `toolPolicy` and
 * `agents`. A non-object keeps all defaults; each known sub-key is validated
 * individually with a journaled warning so a config typo weakens the gate
 * visibly, never silently.
 * @param config The config to mutate.
 * @param value The `gitGates` patch value.
 * @param warnings The warning list to append to.
 */
export function mergeGitGatesPatch(
  config: TurnstileConfig,
  value: unknown,
  warnings: string[],
): void {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    warnings.push("config: gitGates must be an object; keeping defaults")
    return
  }
  const merged: TurnstileGitGates = { ...config.gitGates }
  for (const [gk, gv] of Object.entries(value as Record<string, unknown>)) {
    mergeGitGateKey(merged, gk, gv, warnings)
  }
  config.gitGates = merged
}

/**
 * Merges one `decisionLedger` sub-key into the block being built. The only key is
 * the `enabled` boolean; unknown sub-keys warn like the other sections.
 * @param merged The decisionLedger block being built.
 * @param pk The sub-key name.
 * @param pv The candidate sub-key value.
 * @param warnings The warning list to append to.
 */
function mergeDecisionLedgerKey(
  merged: TurnstileDecisionLedger,
  pk: string,
  pv: unknown,
  warnings: string[],
): void {
  if (pk !== "enabled") {
    warnings.push(`config: unknown decisionLedger key "${pk}" ignored`)
    return
  }
  if (typeof pv === "boolean") {
    merged.enabled = pv
  } else {
    warnings.push("config: decisionLedger.enabled must be a boolean; keeping default")
  }
}

/**
 * Merges the `decisionLedger` patch section one level deep like `toolPolicy` and
 * `gitGates`. A non-object keeps all defaults; each known sub-key is
 * validated individually with a journaled warning so a config typo is
 * visible, never silent.
 * @param config The config to mutate.
 * @param value The `decisionLedger` patch value.
 * @param warnings The warning list to append to.
 */
export function mergeDecisionLedgerPatch(
  config: TurnstileConfig,
  value: unknown,
  warnings: string[],
): void {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    warnings.push("config: decisionLedger must be an object; keeping defaults")
    return
  }
  const merged: TurnstileDecisionLedger = { ...config.decisionLedger }
  for (const [pk, pv] of Object.entries(value as Record<string, unknown>)) {
    mergeDecisionLedgerKey(merged, pk, pv, warnings)
  }
  config.decisionLedger = merged
}

/**
 * Merges one top-level patch key into the config: section dispatch for the
 * three sub-objects, the `$schema`/`handsOnGate` conventions, the unknown-key
 * warning, and scalar validation for everything else.
 * @param config The config to mutate.
 * @param key The top-level patch key.
 * @param value The candidate value.
 * @param warnings The warning list to append to.
 */
export function mergeConfigKey(
  config: TurnstileConfig,
  key: string,
  value: unknown,
  warnings: string[],
): void {
  if (key === "agents") return mergeAgentsPatch(config, value, warnings)
  if (key === "toolPolicy") return mergeToolPolicyPatch(config, value, warnings)
  if (key === "gitGates") return mergeGitGatesPatch(config, value, warnings)
  if (key === "decisionLedger") return mergeDecisionLedgerPatch(config, value, warnings)
  if (key === "$schema") return mergeSchemaKey(value, warnings)
  if (key === "handsOnGate") {
    // Legacy key from the removed hands-on meta-mode: dropped, never honored,
    // and surfaced so a user config cannot silently lose the knob it still
    // names; the gate is always enforced now.
    warnings.push(
      'config: unknown key "handsOnGate" removed — the parent hands-on gate is now always enforced; use TURNSTILE OFF: to suspend',
    )
    return
  }
  if (!(key in config)) {
    warnings.push(`config: unknown key "${key}" ignored`)
    return
  }
  mergeScalarKey(config, key, value, warnings)
}
