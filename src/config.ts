/**
 * @fileoverview Config boundary: layered configuration for the plugin.
 * Precedence: code defaults ⊕ JSON config file ⊕ environment variables ⊕
 * injected overrides (tests). Config is read once at setup; restart
 * sessions to apply. Invalid keys are ignored and journaled to the
 * env-resolved metrics directory (the journaler does not exist until
 * config resolves): config errors never crash the host, per the fail-open
 * contract.
 */

import { createHash } from "node:crypto"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"

import { appendLine, defaultMetricsDir } from "./journal.ts"
import {
  CANONICAL_GATE_MARKER,
  CANONICAL_VERDICT_MARKER,
  GATE_RE,
  VERDICT_RE,
  formatDiagnosticBlock,
} from "./markers.ts"
import type {
  GateEvidenceMode,
  ReviewEnsembleMode,
  TurnstileAgents,
  TurnstileConfig,
  TurnstileGitGates,
  TurnstileToolPolicy,
} from "./types.ts"

/** Default config file location. */
export const CONFIG_PATH: string = path.join(os.homedir(), ".config", "opencode", "turnstile.json")

/** Environment variable names honored by the env layer. */
export const ENV_KEYS = {
  trace: "TURNSTILE_TRACE",
  metricsDir: "TURNSTILE_METRICS_DIR",
  config: "TURNSTILE_CONFIG",
} as const

/**
 * Default case-insensitive evidence pattern: plausible test commands across
 * the common JS and non-JS toolchains, plus the full-CI-chain convention
 * (`npm run ci` and its colon legs, e.g. `ci:host` / `ci:installed`) for repos
 * whose tests run behind a combined CI script. Node CLI flags may interpolate
 * between `node` and `--test` (e.g. `node --experimental-strip-types --test`);
 * script-path arguments deliberately do not qualify (`node server.js --test`
 * is not evidence). Compiled with `"i"`; a host can override `evidencePattern`
 * for toolchains the default does not cover.
 */
export const DEFAULT_EVIDENCE_PATTERN =
  "\\b(npm\\s+(run\\s+)?test|npm\\s+run\\s+ci|pnpm\\s+test|yarn\\s+test|bun\\s+test|deno\\s+test|node\\s+(?:--[\\w=-]+\\s+)*--test|pytest|make\\s+test(\\s|$)|go\\s+test|cargo\\s+test)\\b"

/**
 * Default conventional-commits regex SOURCE string for `gitGates.commitFormat`
 * (compiled by callers with `new RegExp("^" + source + "$", "s")`). It accepts
 * a single type from the conventional set `{feat,fix,docs,style,refactor,perf,
 * test,build,ci,chore,revert}`, an optional `(scope)`, a required `!` or `:`
 * separator (only one is needed — no `BREAKING CHANGE` trailer), a subject of
 * up to 72 characters on the first line, and one optional following body line.
 * Note the source carries no leading `^`/trailing `$`: the caller wraps them.
 */
export const DEFAULT_COMMIT_FORMAT =
  "(?:feat|fix|docs|style|refactor|perf|test|build|ci|chore|revert)(?:\\([^)]*\\))?(?:[!]:?|:) [^\\r\\n]{1,72}(?:(?:\\r?\\n){1,2}[^\\r\\n]*)?"

/**
 * Identity sentinel for "bareOutput not configured": `defaultConfig()` stores
 * this exact reference for `agents.bareOutput`, and derivation fires only when
 * the resolved list is still this reference. `mergeConfig` always stores a
 * fresh array for an explicitly configured list, so a non-empty explicit list
 * — including a reordered copy of the default names — is distinguishable from
 * the unset default regardless of its contents. An explicit empty list is not:
 * JSON cannot express this reference, so the shipped example carries an empty
 * one, and derivation treats an empty list as unset to keep that copy from
 * denying every marker.
 */
export const BARE_OUTPUT_UNSET: string[] = []

/**
 * Builds the code defaults for every config key.
 * @param env Environment consulted for XDG_DATA_HOME only.
 * @returns The default TurnstileConfig matching the historical hardcoded
 *     constants; `agents.bareOutput` stores the unset sentinel, which
 *     `loadConfig`'s derivation step resolves to the derived agent list.
 */
export function defaultConfig(
  env: Record<string, string | undefined> = process.env,
): TurnstileConfig {
  return {
    metricsDir: defaultMetricsDir(env),
    journalMaxBytes: 5 * 1024 * 1024,
    journalMaxGenerations: 5,
    journalRotateEveryEntries: 512,
    replayTailLines: 2000,
    maxReviewerRounds: 2,
    // Per-leg loop caps: a healthy task is ≤1 planner + ≤3
    // plan-reviewer + N executor chunks + ≤4 test-runner + ≤2 reviewer; 16
    // total leaves chunk headroom while staying an order of magnitude below an
    // unbounded loop. Waived dispatches are exempt.
    maxPlannerRounds: 3,
    maxPlanReviewerRounds: 3,
    maxTestRunnerRounds: 4,
    maxTotalDispatches: 16,
    maxSessions: 64,
    readWarn: 8,
    readBlock: 15,
    observeSessions: 0,
    waiverMarker: "USER WAIVER:",
    approvalMarker: "PLAN APPROVED:",
    plansDir: path.join(".opencode", "plans"),
    trace: true,
    // Session-end summary: "quiet" prints one recap line at session.idle for
    // sessions that did something (silent for zero-activity sessions); "on"
    // also prints an all-gates-green line for zero-activity sessions; "off"
    // restores pre-summary behavior exactly.
    sessionSummary: "quiet",
    // Escalation ladder: "block" (default) re-throws the block on a retried
    // landing/hands-on attempt and never raises a permission ask, so an
    // auto-accepting host cannot silently collapse the ask tier into an
    // allow; release is waiver/approval-marker or earned reviewer verdict
    // only. "ask" restores the interactive permission-ask ladder verbatim.
    escalation: "block",
    // Continuation carry is on by default: a reviewer-approved landing prompt
    // re-arms earned credit when the worktree/branch is unchanged; set
    // `continuationCarry: false` to restore a clean cycle every prompt.
    continuationCarry: true,
    // Session-level gate suspend/resume: while suspended, decisions compute and
    // journal but never throw `BLOCKED`; the resume marker starts from fresh
    // state with no rehydrated credit. `allowSuspend: false` refuses both.
    suspendMarker: "TURNSTILE OFF:",
    resumeMarker: "TURNSTILE ON:",
    // Explicit task-retire marker: a user prompt carrying the literal journals
    // {type:"task-complete", plan} and stamps taskComplete, so the NEXT
    // admitted prompt starts a fresh task scope. Admission-only (child
    // results and dispatch prompts never retire a task).
    taskDoneMarker: "TASK DONE:",
    allowSuspend: true,
    // Advisory intent nudge is on by default: an admitted prompt classified
    // as implementation intent with no plan approval journals `{type:"intent"}`
    // and prepends one advisory pipeline-entry nudge to the next tool
    // delivery. `intentNudge: false` disables detection entirely (no journal
    // row, no nudge).
    intentNudge: true,
    agents: {
      planner: "planner",
      reviewer: "reviewer",
      planReviewer: "plan-reviewer",
      executor: "executor",
      testRunner: "test-runner",
      debugger: "debugger",
      bareOutput: BARE_OUTPUT_UNSET,
    },
    gateMarker: GATE_RE.source,
    verdictMarker: VERDICT_RE.source,
    gateEvidence: "enforce",
    reviewEnsemble: "enforce",
    evidencePattern: DEFAULT_EVIDENCE_PATTERN,
    toolPolicy: {
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
    },
    // Git-and-commit gates are per-feature switches with no meta-mode: while
    // `commitMessages` is true commit subjects are linted, and while
    // `landingGate` is true pushes wait for a reviewer verdict. `commitFormat`
    // is a conventional-commits regex SOURCE (no anchors): callers wrap it with
    // `^…$` + the `"s"` flag (see src/tool-policy.ts).
    gitGates: {
      commitMessages: true,
      commitFormat: DEFAULT_COMMIT_FORMAT,
      landingGate: true,
      // Default on: the probe releases only pushes git proves land nothing
      // (ref-equal upstream, no force flags), so it never bypasses review of
      // real work. Set false for the strict opt-out. Tests that assert a
      // push blocks pass this key explicitly (false) so they stay
      // deterministic against the live repo's git state.
      emptyDiffExempt: true,
    },
  }
}

/**
 * Validates a patch value for a scalar key.
 * @param key Config key being set.
 * @param value Candidate value.
 * @returns true when the value has the right type for the key: numeric keys
 *     accept positive integers only (Number.isInteger subsumes the finite
 *     check, so NaN/Infinity are rejected as non-integers); the one exception
 *     is `observeSessions`, which accepts integers >= 0 so 0 can be set
 *     explicitly to end an observe period.
 */
function isValidScalar(key: keyof TurnstileConfig, value: unknown): boolean {
  if (
    key === "trace" ||
    key === "continuationCarry" ||
    key === "allowSuspend" ||
    key === "intentNudge"
  )
    return typeof value === "boolean"
  if (key === "sessionSummary") return value === "on" || value === "quiet" || value === "off"
  if (key === "escalation") return value === "ask" || value === "block"
  if (
    key === "metricsDir" ||
    key === "waiverMarker" ||
    key === "approvalMarker" ||
    key === "suspendMarker" ||
    key === "resumeMarker" ||
    key === "taskDoneMarker" ||
    key === "plansDir"
  ) {
    if (key === "metricsDir") {
      return typeof value === "string" && value.trim().length > 0 && path.isAbsolute(value)
    }
    return typeof value === "string" && value.trim().length > 0
  }
  if (key === "gateMarker" || key === "verdictMarker") return typeof value === "string"
  if (key === "gateEvidence" && (value === "enforce" || value === "flag" || value === "off"))
    return true
  if (key === "reviewEnsemble" && (value === "enforce" || value === "advise")) return true
  if (key === "evidencePattern" && typeof value === "string") {
    // A non-compiling pattern is rejected so `new RegExp` never throws later.
    try {
      new RegExp(value, "i")
      return true
    } catch {
      return false
    }
  }
  // 0 must be settable explicitly to arm/end the observe period mid-count;
  // every other numeric key keeps the positive-integer rule.
  if (key === "observeSessions")
    return typeof value === "number" && Number.isInteger(value) && value >= 0
  return typeof value === "number" && Number.isInteger(value) && value > 0
}

/** Scalar config keys whose valid values are integers (positive, or
 *  non-negative for `observeSessions`). */
type NumericConfigKey = Extract<
  keyof TurnstileConfig,
  | "journalMaxBytes"
  | "journalMaxGenerations"
  | "journalRotateEveryEntries"
  | "replayTailLines"
  | "maxReviewerRounds"
  | "maxPlannerRounds"
  | "maxPlanReviewerRounds"
  | "maxTestRunnerRounds"
  | "maxTotalDispatches"
  | "maxSessions"
  | "readWarn"
  | "readBlock"
  | "observeSessions"
>

/**
 * Assigns a validated scalar into the config without erasing the key→type
 * correlation the validator just established.
 * @param config The config to mutate.
 * @param key The validated config key.
 * @param value The validated value.
 */
function assignScalar(config: TurnstileConfig, key: keyof TurnstileConfig, value: unknown): void {
  if (key === "trace") config.trace = value as boolean
  else if (key === "sessionSummary") config.sessionSummary = value as "on" | "quiet" | "off"
  else if (key === "metricsDir") config.metricsDir = value as string
  else if (key === "waiverMarker") config.waiverMarker = value as string
  else if (key === "approvalMarker") config.approvalMarker = value as string
  else if (key === "plansDir") config.plansDir = value as string
  else if (key === "gateMarker") config.gateMarker = value as string
  else if (key === "verdictMarker") config.verdictMarker = value as string
  else if (key === "gateEvidence") config.gateEvidence = value as GateEvidenceMode
  else if (key === "reviewEnsemble") config.reviewEnsemble = value as ReviewEnsembleMode
  else if (key === "evidencePattern") config.evidencePattern = value as string
  else if (key === "continuationCarry") config.continuationCarry = value as boolean
  else if (key === "suspendMarker") config.suspendMarker = value as string
  else if (key === "resumeMarker") config.resumeMarker = value as string
  else if (key === "taskDoneMarker") config.taskDoneMarker = value as string
  else if (key === "allowSuspend") config.allowSuspend = value as boolean
  else if (key === "intentNudge") config.intentNudge = value as boolean
  else if (key === "observeSessions") config.observeSessions = value as number
  else config[key as NumericConfigKey] = value as number
}

/**
 * Merges a patch into a base config with per-key validation. Unknown keys
 * and wrongly-typed values are skipped and reported as warnings; the
 * `agents` sub-object merges one level deep.
 * @param base The config to merge into.
 * @param patch Candidate overrides (typically parsed JSON or injected opts).
 * @returns The merged config plus one warning string per skipped key.
 */
export function mergeConfig(
  base: TurnstileConfig,
  patch: unknown,
): { config: TurnstileConfig; warnings: string[] } {
  const warnings: string[] = []
  const config: TurnstileConfig = {
    ...base,
    agents: { ...base.agents },
    toolPolicy: { ...base.toolPolicy },
    gitGates: { ...base.gitGates },
  }
  if (patch === null || typeof patch !== "object" || Array.isArray(patch)) {
    if (patch !== undefined) {
      warnings.push(
        `config: expected an object, got ${Array.isArray(patch) ? "array" : typeof patch}`,
      )
    }
    return { config, warnings }
  }
  for (const [key, value] of Object.entries(patch as Record<string, unknown>)) {
    if (key === "agents") {
      if (value === null || typeof value !== "object" || Array.isArray(value)) {
        warnings.push(`config: agents must be an object; keeping defaults`)
        continue
      }
      for (const [agentKey, agentValue] of Object.entries(value as Record<string, unknown>)) {
        if (agentKey === "bareOutput") {
          if (
            Array.isArray(agentValue) &&
            agentValue.every((v) => typeof v === "string" && v.trim().length > 0)
          ) {
            // Copy: a mutated injected options object must not retro-mutate
            // the live config.
            config.agents.bareOutput = [...(agentValue as string[])]
          } else {
            warnings.push(
              `config: agents.bareOutput must be an array of non-empty strings; keeping default`,
            )
          }
          continue
        }
        if (!(agentKey in config.agents)) {
          warnings.push(`config: unknown agents key "${agentKey}" ignored`)
          continue
        }
        if (typeof agentValue === "string" && agentValue.trim().length > 0) {
          const name = agentKey as
            "reviewer" | "planReviewer" | "executor" | "testRunner" | "debugger"
          config.agents[name] = agentValue
        } else {
          warnings.push(`config: agents.${agentKey} must be a non-empty string; keeping default`)
        }
      }
      continue
    }
    if (key === "toolPolicy") {
      // Merge one level deep like `agents`. A non-object keeps all defaults; each
      // known sub-key is validated, and invalid bashDeny/pathDeny elements are
      // dropped individually (compiled with "i") with one warning each so a
      // config typo weakens the policy visibly in the journal, never silently.
      if (value === null || typeof value !== "object" || Array.isArray(value)) {
        warnings.push("config: toolPolicy must be an object; keeping defaults")
        continue
      }
      const merged: TurnstileToolPolicy = { ...config.toolPolicy }
      for (const [tpKey, tpValue] of Object.entries(value as Record<string, unknown>)) {
        if (tpKey === "mode") {
          // Legacy key from the removed tool-policy meta-mode: dropped, never
          // honored, and surfaced so a user config cannot silently lose the
          // knob it still names.
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
          // Only the value itself being non-array falls back to the default
          // (fail-safe); otherwise every element is validated so a single bad
          // element never discards the whole user list, nor silently widens the
          // policy by letting an empty/blank string through. Bad elements are
          // dropped individually and journaled ({type:"error"} via loadConfig),
          // mirroring the non-compiling-regex drop below.
          if (!Array.isArray(tpValue)) {
            warnings.push(
              `config: toolPolicy.${tpKey} must be an array of non-empty strings; keeping default`,
            )
            continue
          }
          const sources: string[] = []
          tpValue.forEach((src, i) => {
            if (typeof src !== "string" || src.trim().length === 0) {
              warnings.push(
                `config: toolPolicy.${tpKey}[${i}] is not a non-empty string; dropping element`,
              )
              return
            }
            try {
              new RegExp(src, "i")
              sources.push(src)
            } catch {
              warnings.push(
                `config: toolPolicy.${tpKey}[${i}] is not a valid regex; dropping element`,
              )
            }
          })
          merged[tpKey] = sources
        } else {
          warnings.push(`config: unknown toolPolicy key "${tpKey}" ignored`)
        }
      }
      config.toolPolicy = merged
      continue
    }
    if (key === "gitGates") {
      // Merge one level deep like `toolPolicy` and `agents`. A non-object keeps
      // all defaults; each known sub-key is validated individually with a
      // journaled warning so a config typo weakens the gate visibly, never
      // silently. `commitFormat` is a regex SOURCE (compilation checked with the
      // same `^…$` + `"s"` wrap the caller uses, so `new RegExp` never throws).
      if (value === null || typeof value !== "object" || Array.isArray(value)) {
        warnings.push("config: gitGates must be an object; keeping defaults")
        continue
      }
      const merged: TurnstileGitGates = { ...config.gitGates }
      for (const [gk, gv] of Object.entries(value as Record<string, unknown>)) {
        if (gk === "mode") {
          // Legacy key from the removed gitGates meta-mode: dropped, never
          // honored, and surfaced; the booleans are the only switches now.
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
        } else if (gk === "commitFormat") {
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
        } else {
          warnings.push(`config: unknown gitGates key "${gk}" ignored`)
        }
      }
      config.gitGates = merged
      continue
    }
    if (key === "$schema") {
      // Editor convention (VS Code json.schemas) lives in the config file the
      // schema validates; it is not a TurnstileConfig key, so it is consumed
      // here silently rather than warning "unknown key" on every load. A
      // non-string is not a usable URI/path, so it warns instead of being
      // dropped silently.
      if (typeof value !== "string") {
        warnings.push('config: "$schema" must be a string URI or path; ignored')
      }
      continue
    }
    if (key === "handsOnGate") {
      // Legacy key from the removed hands-on meta-mode: dropped, never
      // honored, and surfaced so a user config cannot silently lose the knob
      // it still names; the gate is always enforced now.
      warnings.push(
        'config: unknown key "handsOnGate" removed — the parent hands-on gate is now always enforced; use TURNSTILE OFF: to suspend',
      )
      continue
    }
    if (!(key in config)) {
      warnings.push(`config: unknown key "${key}" ignored`)
      continue
    }
    if (key === "gateEvidence") {
      // Validated/assigned by the shared helpers; only the warning wording is
      // special-cased to name the three accepted literals.
      if (isValidScalar(key as keyof TurnstileConfig, value)) {
        assignScalar(config, key as keyof TurnstileConfig, value)
      } else {
        warnings.push(`config: gateEvidence must be "enforce", "flag", or "off"; keeping default`)
      }
      continue
    }
    if (key === "reviewEnsemble") {
      // Mirrors the gateEvidence special case: shared validate/assign helpers,
      // only the warning wording is special-cased to name the two literals.
      if (isValidScalar(key as keyof TurnstileConfig, value)) {
        assignScalar(config, key as keyof TurnstileConfig, value)
      } else {
        warnings.push(`config: reviewEnsemble must be "enforce" or "advise"; keeping default`)
      }
      continue
    }
    if (key === "sessionSummary") {
      // Mirrors the gateEvidence/reviewEnsemble special case: shared
      // validate/assign helpers, only the warning wording is special-cased
      // to name the three accepted literals.
      if (isValidScalar(key as keyof TurnstileConfig, value)) {
        assignScalar(config, key as keyof TurnstileConfig, value)
      } else {
        warnings.push('config: sessionSummary must be "on", "quiet", or "off"; keeping default')
      }
      continue
    }
    if (key === "escalation") {
      // Mirrors the sessionSummary special case: shared validate/assign
      // helpers, only the warning wording is special-cased to name the two
      // accepted literals.
      if (isValidScalar(key as keyof TurnstileConfig, value)) {
        assignScalar(config, key as keyof TurnstileConfig, value)
      } else {
        warnings.push('config: escalation must be "block" or "ask"; keeping default')
      }
      continue
    }
    if (isValidScalar(key as keyof TurnstileConfig, value)) {
      assignScalar(config, key as keyof TurnstileConfig, value)
    } else {
      warnings.push(`config: invalid value for "${key}"; keeping default`)
    }
  }
  return { config, warnings }
}

/**
 * Journals a config warning to the env-resolved metrics directory. Used
 * only for problems detected before the real journaler exists, so the
 * sink honors the caller's injected env (tests stay off the user journal).
 * The injected TURNSTILE_METRICS_DIR is honored only when absolute,
 * mirroring the default-metrics-dir contract: a relative or empty value
 * falls through to the absolute default directory.
 * @param error The warning/error text.
 * @param env Environment providing TURNSTILE_METRICS_DIR / XDG_DATA_HOME.
 */
function journalConfigError(error: string, env: Record<string, string | undefined>): void {
  const abs = (v: string | undefined): string | undefined =>
    v !== undefined && path.isAbsolute(v) ? v : undefined
  const metricsDir =
    abs(env[ENV_KEYS.metricsDir]) ??
    abs(process.env[ENV_KEYS.metricsDir]) ??
    defaultMetricsDir({ ...process.env, ...env })
  appendLine(
    path.join(metricsDir, "turnstile.jsonl"),
    JSON.stringify({ ts: new Date().toISOString(), type: "error", error }),
  )
}

/**
 * Reads and parses the JSON config file, returning a patch object.
 * @param env Environment providing the config path override.
 * @returns The parsed patch (or undefined) plus any warning.
 */
function readFileLayer(env: Record<string, string | undefined>): {
  patch: unknown
  warnings: string[]
} {
  const configPath = env[ENV_KEYS.config] ?? CONFIG_PATH
  try {
    return { patch: JSON.parse(fs.readFileSync(configPath, "utf8")), warnings: [] }
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code
    if (code === "ENOENT") return { patch: undefined, warnings: [] }
    const warning =
      code === "EISDIR"
        ? `config file ${configPath} is a directory; ignored`
        : `config file ${configPath} unreadable/malformed: ${e}`
    journalConfigError(warning, env)
    return { patch: undefined, warnings: [warning] }
  }
}

/**
 * Applies the env layer on top of a merged config.
 * @param config The config to mutate.
 * @param env The environment to read.
 * @returns One warning string per invalid env value.
 */
function applyEnvLayer(config: TurnstileConfig, env: Record<string, string | undefined>): string[] {
  const warnings: string[] = []
  const trace = env[ENV_KEYS.trace]
  if (trace !== undefined) {
    if (trace === "0" || trace === "false") config.trace = false
    else if (trace === "1" || trace === "true") config.trace = true
    else
      warnings.push(
        `env ${ENV_KEYS.trace}=${trace} invalid (use 0/1/true/false); keeping current value`,
      )
  }
  const metricsDir = env[ENV_KEYS.metricsDir]
  if (metricsDir !== undefined) {
    if (metricsDir.trim().length === 0) {
      warnings.push(`env ${ENV_KEYS.metricsDir} empty; keeping current value`)
    } else if (!path.isAbsolute(metricsDir)) {
      warnings.push(`env ${ENV_KEYS.metricsDir}="${metricsDir}" is relative; keeping current value`)
    } else {
      config.metricsDir = metricsDir
    }
  }
  return warnings
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
  if (config.readWarn >= config.readBlock) {
    const warn = config.readWarn
    const block = config.readBlock
    config.readWarn = Math.max(block - 1, 0)
    warnings.push(
      `config: readWarn (${warn}) >= readBlock (${block}); clamping readWarn to ${config.readWarn}`,
    )
  }
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
  // The `enforce` ensemble needs a satisfiable count: with maxReviewerRounds <
  // 2 the second required reviewer dispatch is capped away, so the ensemble is
  // mechanically unsatisfiable. Warn (do not clamp — clamping upward would
  // violate the user's cap intent); the human escalation path is the escape.
  if (config.reviewEnsemble === "enforce" && config.maxReviewerRounds < 2) {
    warnings.push(
      `config: reviewEnsemble enforce needs maxReviewerRounds >= 2 (got ${config.maxReviewerRounds}); a second reviewer dispatch will be capped, escalate to the user`,
    )
  }
  return warnings
}

/**
 * Re-derives `bareOutput` from the configured agent names when the resolved
 * list is still the unset sentinel (i.e. nobody configured it), so a renamed
 * agent stays bare-output-qualified automatically. Derivation keys off the
 * configured/unset distinction by reference identity, not list equality, so
 * an explicit non-empty list — reordered or default-valued — is always kept
 * verbatim and no configured name ever vanishes. An explicit empty list is
 * treated as unset: it has no defensible meaning beyond denying every
 * child-session marker, and JSON cannot express the sentinel, so a config
 * copied from the shipped example must not silently disarm marker authority.
 * Mutates `agents.bareOutput`
 * in place (the sentinel array itself is replaced, never mutated).
 * @param agents The resolved agents block to update in place.
 */
function deriveBareOutput(agents: TurnstileAgents): void {
  if (agents.bareOutput !== BARE_OUTPUT_UNSET && agents.bareOutput.length > 0) return
  const derived = [agents.testRunner, agents.reviewer, agents.planReviewer].filter(
    (name): name is string => typeof name === "string" && name.trim().length > 0,
  )
  agents.bareOutput = derived.filter((name, i) => derived.indexOf(name) === i)
}

/**
 * Resolves the full layered configuration: defaults ⊕ config file ⊕ env ⊕
 * injected overrides. Config-file and validation problems are journaled to
 * the default metrics directory and returned as warnings, never thrown.
 * @param env Environment providing XDG_DATA_HOME, TURNSTILE_* variables.
 * @param overrides Final-layer overrides (injected options; tests).
 * @returns The resolved config plus one warning string per skipped/invalid
 *     key or file problem.
 */
export function loadConfig(
  env: Record<string, string | undefined> = process.env,
  overrides?: Partial<TurnstileConfig>,
): { config: TurnstileConfig; warnings: string[] } {
  const warnings: string[] = []
  const defaults = defaultConfig(env)
  const fileLayer = readFileLayer(env)
  const fileMerge = mergeConfig(defaults, fileLayer.patch)
  const config = fileMerge.config
  warnings.push(...fileLayer.warnings, ...fileMerge.warnings)
  warnings.push(...applyEnvLayer(config, env))
  let resolved = config
  if (overrides !== undefined) {
    const merged = mergeConfig(config, overrides)
    resolved = merged.config
    warnings.push(...merged.warnings)
  }
  warnings.push(...validateResolved(resolved))
  deriveBareOutput(resolved.agents)
  for (const warning of warnings) {
    if (!warning.startsWith("config file")) journalConfigError(warning, env)
  }
  return { config: resolved, warnings }
}

/**
 * Renders a resolved list of config-validation warnings as a compact,
 * model-facing block for the once-per-load surfacing in `src/setup.ts`. Pure
 * and side-effect free (throws nothing): a fixed header carries the count and
 * the journal path, one `- ` line per warning up to `maxLines`, and a tail
 * naming the hidden remainder past `maxLines` (the journal holds the full
 * list) — the header, line format, and block rendering are shared with
 * `formatNearMissDiagnostics` through `formatDiagnosticBlock`; only the
 * header wording, line prefix, and surfacing budget are warning-specific.
 * An empty list renders a zero-count header with no lines; callers gate on a
 * non-empty list so the block is never injected for a clean config.
 * @param warnings The resolved warning strings to render.
 * @param journalPath Absolute path of the JSONL journal (named in the header).
 * @param maxLines Maximum warning lines before the truncation tail (default 5).
 * @returns The formatted `[turnstile] config:` block.
 */
export function formatConfigWarnings(
  warnings: string[],
  journalPath: string,
  maxLines: number = 5,
): string {
  const header = `[turnstile] config: ${warnings.length} validation warning(s) (journal: ${journalPath}):`
  return formatDiagnosticBlock(
    header,
    warnings.map((w) => `- ${w}`),
    maxLines,
  )
}

/**
 * Renders the end-of-period observe-mode summary as a compact, model-facing
 * block for the once-per-load surfacing in `src/hooks-core.ts`. Pure and
 * side-effect free (throws nothing): a fixed first line reports the period
 * totals — how many deliberate blocks were suppressed and how many sessions
 * were observed — and names that enforcement is now on, followed by a single
 * journal-path line pointing at the JSONL journal that holds the full audit.
 * The shape (fixed header, one journal line) mirrors `formatConfigWarnings`;
 * both render through the shared `formatDiagnosticBlock` and diverge only in
 * wording.
 * @param counts The running observe-period totals at the moment of surfacing.
 * @param journalPath Absolute path of the JSONL journal (named in the block).
 * @returns The formatted `[turnstile] observe:` block.
 */
export function formatObserveSummary(
  counts: { observed: number; wouldBlocks: number },
  journalPath: string,
): string {
  const header = `[turnstile] observe: Observe period complete: ${counts.wouldBlocks} premature dispatch attempts would have been blocked, ${counts.observed} sessions observed. Enforcing from now on.`
  return formatDiagnosticBlock(header, [`[journal: ${journalPath}]`], 1)
}

/**
 * Computes a short, stable digest of a resolved config.
 *
 * The digest is the first 12 hex characters of the SHA-256 of the config's
 * JSON serialization: two setups with the same config produce the same
 * digest, and any config change flips it — so the digest ties a session's
 * journal entries to the exact config that drove them (and is reproducible
 * offline). `JSON.stringify` serializes a plain object's keys in insertion
 * order, and every config is built by the same literal + spread paths
 * (`defaultConfig`, `mergeConfig`), so the serialization is stable *today*.
 * A future refactor that conditionally inserts keys would change the
 * serialization and invalidate historical digests — by design, a changed
 * config should no longer match an old one.
 * @param config The resolved config to digest.
 * @returns 12 lowercase hex characters.
 */
export function configDigest(config: TurnstileConfig): string {
  return createHash("sha256").update(JSON.stringify(config)).digest("hex").slice(0, 12)
}
