/**
 * @fileoverview Config boundary: layered configuration for the plugin.
 * Precedence: code defaults ⊕ JSON config file ⊕ environment variables ⊕
 * injected overrides (tests). Config is read once at setup; restart
 * sessions to apply. Invalid keys are ignored and journaled to the
 * env-resolved metrics directory (the journaler does not exist until
 * config resolves): config errors never crash the host, per the fail-open
 * contract. Per-key merge arms live in `src/config-merge.ts`; scalar
 * validation and resolved-config invariants in `src/config-validate.ts`.
 */

import { createHash } from "node:crypto"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"

import { appendLine, defaultMetricsDir } from "./journal.ts"
import { GATE_RE, VERDICT_RE, formatDiagnosticBlock } from "./markers.ts"
import {
  defaultAgents,
  defaultGitGates,
  defaultToolPolicy,
  mergeConfigKey,
} from "./config-merge.ts"
import { BARE_OUTPUT_UNSET, validateResolved } from "./config-validate.ts"
import { DEFAULT_EPOCH_ENTRIES, type TurnstileConfig } from "./types.ts"

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

export { DEFAULT_EPOCH_ENTRIES } from "./types.ts"

export { BARE_OUTPUT_UNSET } from "./config-validate.ts"
export { CANONICAL_REVIEWER_AGENT, DEFAULT_COMMIT_FORMAT } from "./config-merge.ts"
export { validateResolved } from "./config-validate.ts"

/**
 * Builds the journal/trace defaults: where the JSONL journal lives and how it
 * rotates, plus the trace switch.
 * @param env Environment consulted for XDG_DATA_HOME only.
 * @returns The journal-shaped default fields.
 */
function defaultJournalScalars(
  env: Record<string, string | undefined>,
): Pick<
  TurnstileConfig,
  | "metricsDir"
  | "journalMaxBytes"
  | "journalMaxGenerations"
  | "journalRotateEveryEntries"
  | "journalPerSession"
  | "replayTailLines"
  | "trace"
> {
  return {
    metricsDir: defaultMetricsDir(env),
    journalMaxBytes: 5 * 1024 * 1024,
    journalMaxGenerations: 5,
    journalRotateEveryEntries: 512,
    journalPerSession: true,
    replayTailLines: 2000,
    trace: true,
  }
}

/**
 * Builds the dispatch-cap defaults.
 * @returns The loop-cap and session-cap default fields.
 */
function defaultLoopCaps(): Pick<
  TurnstileConfig,
  | "maxReviewerRounds"
  | "maxPlannerRounds"
  | "maxPlanReviewerRounds"
  | "maxTestRunnerRounds"
  | "maxRequirementsRounds"
  | "maxTotalDispatches"
  | "maxSessions"
  | "agentMarkerRetry"
> {
  return {
    maxReviewerRounds: 2,
    // Per-leg loop caps: a healthy task is ≤1 planner + ≤3
    // plan-reviewer + N executor chunks + ≤4 test-runner + ≤2 reviewer; 16
    // total leaves chunk headroom while staying an order of magnitude below an
    // unbounded loop. Waived dispatches are exempt.
    maxPlannerRounds: 3,
    maxPlanReviewerRounds: 3,
    maxTestRunnerRounds: 4,
    maxRequirementsRounds: 2,
    maxTotalDispatches: 16,
    maxSessions: 64,
    // Compliance retry: a marker-less bare-output delivery is re-prompted
    // once before it counts a violation — agent-compliance failure, not
    // work-quality. 0 disables the retry (first bare delivery violates).
    agentMarkerRetry: 1,
  }
}

/**
 * Builds the read-budget and observe-period defaults.
 * @returns The read/observe default fields.
 */
function defaultReadScalars(): Pick<TurnstileConfig, "readWarn" | "readBlock" | "observeSessions"> {
  return {
    readWarn: 8,
    readBlock: 15,
    observeSessions: 0,
  }
}

/**
 * Builds the marker-literal and trace defaults.
 * @returns The waiver/approval/plans/trace default fields.
 */
function defaultMarkerScalars(): Pick<
  TurnstileConfig,
  | "waiverMarker"
  | "approvalMarker"
  | "plansDir"
  | "planReviewAcceptMarker"
  | "planReviewRejectMarker"
  | "trace"
> {
  return {
    waiverMarker: "USER WAIVER:",
    approvalMarker: "PLAN APPROVED:",
    plansDir: path.join(".opencode", "plans"),
    // User plan review (opt-in via planUserReview): the prompt literals that
    // accept or reject the written plan. Config-controlled like taskDoneMarker.
    planReviewAcceptMarker: "PLAN REVIEWED:",
    planReviewRejectMarker: "PLAN REJECTED:",
    trace: true,
  }
}

/**
 * Builds the session-summary, escalation-ladder, and suspend-marker mode
 * defaults.
 * @returns The mode-shaped default fields.
 */
/** The `defaultModeScalars` shape: mode-shaped default config fields. */
type DefaultModeScalars = Pick<
  TurnstileConfig,
  | "sessionSummary"
  | "escalation"
  | "continuationCarry"
  | "suspendMarker"
  | "resumeMarker"
  | "taskDoneMarker"
  | "allowSuspend"
>

function defaultModeScalars(): DefaultModeScalars {
  return {
    // Session-end summary: "quiet" prints one recap line at session.idle for
    // sessions that did something (silent for zero-activity sessions); "on"
    // also prints an all-gates-green line for zero-activity sessions; "off"
    // restores pre-summary behavior exactly.
    sessionSummary: "quiet",
    // Escalation ladder: on a retried landing/hands-on attempt BOTH modes
    // arm the one-shot ask latch and raise the permission ask; the
    // block-throw is only the no-human fallback, so an auto-accepting host
    // can silently collapse the ask tier into an allow (one reason the
    // default is "block"). Release is also waiver/approval-marker or earned
    // reviewer verdict. The plan-gate escalation is the only mode-gated one.
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
  }
}

/**
 * Builds the enforcement-arming defaults.
 * @returns The enforcement-shaped default fields.
 */
/** The `defaultEnforcementScalars` shape: enforcement-arming default fields. */
type DefaultEnforcementScalars = Pick<
  TurnstileConfig,
  "intentNudge" | "alwaysEnforce" | "planImpactStrict" | "planUserReview" | "requirementsPhase"
>

function defaultEnforcementScalars(): DefaultEnforcementScalars {
  return {
    // Advisory intent nudge is on by default: an admitted prompt classified
    // as implementation intent with no plan approval journals `{type:"intent"}`
    // and prepends one advisory pipeline-entry nudge to the next tool
    // delivery. `intentNudge: false` disables detection entirely (no journal
    // row, no nudge).
    intentNudge: true,
    // Dormant-until-engaged: `true` restores the legacy always-armed
    // behavior (enforcement from the first prompt). The default `false`
    // arms enforcement when the user provides a plan (a `PLAN APPROVED:`
    // marker or a plan-file reference) or asks to run the planner/pipeline,
    // and sleeps again on task completion, `TURNSTILE OFF:`, or a prompt
    // with no continuation credit. The user-configured denylists
    // (`toolPolicy.bashDeny`/`pathDeny`) enforce regardless.
    alwaysEnforce: false,
    // Plan-impact advisory: parent edit/write/write-shaped bash calls that
    // overlap the bound active plan's scope are allowed with a journaled
    // plan-impact classification instead of the parent-hands-on block.
    // `planImpactStrict: true` restores blocking for structural overlap
    // (files or the ## Decomposition section named by the plan).
    planImpactStrict: false,
    // User plan review (opt-in): when true, the plan-reviewer dispatch is
    // blocked after a planner dispatch until the user's own prompt carries
    // the accept or reject literal. Default false — fully-automated flow.
    planUserReview: false,
    // Requirements phase (opt-in): when true, non-trivial tasks dispatch the
    // requirements subagent before the planner; the orchestrator relays the
    // spec's Open Questions to the user and passes the finalized spec verbatim
    // into the planner dispatch. Soft and ungated: the leg is loop-capped via
    // maxRequirementsRounds but emits no marker and no gate.
    requirementsPhase: false,
  }
}

/**
 * Builds the marker regex-source and evidence-mode defaults.
 * @returns The marker-source default fields.
 */
function defaultMarkerSources(): Pick<
  TurnstileConfig,
  "gateMarker" | "verdictMarker" | "gateEvidence" | "reviewEnsemble" | "evidencePattern"
> {
  return {
    gateMarker: GATE_RE.source,
    verdictMarker: VERDICT_RE.source,
    gateEvidence: "enforce",
    reviewEnsemble: "enforce",
    evidencePattern: DEFAULT_EVIDENCE_PATTERN,
  }
}

/**
 * Builds the decision-ledger defaults.
 * @returns The decision-ledger-shaped default fields.
 */
function defaultDecisionLedgerScalars(): Pick<TurnstileConfig, "decisionLedger"> {
  return {
    // Default on: the ledger is observe-only (no gate reads `prov:*` rows),
    // so capture costs journal volume only; `decisionLedger.enabled: false`
    // silences every `prov:*` write.
    decisionLedger: { enabled: true },
  }
}

/**
 * Builds the tamper-evidence defaults. The chain is off by default so
 * existing journal consumers and exact-shape tests keep the unchained row
 * shape; `enabled: true` opts in.
 * @returns The tamper-evidence-shaped default fields.
 */
function defaultTamperEvidence(): Pick<TurnstileConfig, "tamperEvidence"> {
  return {
    tamperEvidence: {
      enabled: false,
      anchor: "session-state",
      // Matches journalRotateEveryEntries so epoch and rotation cadence
      // align by default without coupling the keys.
      epochEntries: DEFAULT_EPOCH_ENTRIES,
      verifyOnSessionEnd: false,
    },
  }
}

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
    ...defaultJournalScalars(env),
    ...defaultLoopCaps(),
    ...defaultReadScalars(),
    ...defaultMarkerScalars(),
    ...defaultModeScalars(),
    ...defaultEnforcementScalars(),
    ...defaultDecisionLedgerScalars(),
    ...defaultTamperEvidence(),
    agents: defaultAgents(),
    ...defaultMarkerSources(),
    toolPolicy: defaultToolPolicy(),
    gitGates: defaultGitGates(),
  }
}

/**
 * Merges a patch into a base config with per-key validation. Unknown keys
 * and wrongly-typed values are skipped and reported as warnings; the
 * `agents` sub-object merges one level deep. Per-key arms live in
 * `src/config-merge.ts` (`mergeConfigKey`); this function owns the shallow
 * copy and the non-object patch guard.
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
    decisionLedger: { ...base.decisionLedger },
    tamperEvidence: { ...base.tamperEvidence },
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
    mergeConfigKey(config, key, value, warnings)
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
function deriveBareOutput(agents: TurnstileConfig["agents"]): void {
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
