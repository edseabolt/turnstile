/**
 * @fileoverview Shared hook state and services for turnstile's per-surface
 * hook modules. Builds the per-setup context: config, journaler, gates,
 * ledger, maps, constants, bounders, and the service closures that wire
 * them together. No hook bodies live here; per-surface hook modules own
 * their own registration bodies.
 */

import { evictTo } from "./bounded.ts"
import { agentFromDispatchEvent, resolveChildStatus } from "./child-registration.ts"
import { spawnSync } from "node:child_process"
import { formatConfigWarnings, formatObserveSummary, loadConfig } from "./config.ts"
import { createJournaler, type Journaler } from "./journal.ts"
import {
  compileMarkerRegex,
  deltaWindowFloorChars,
  parseGateMarkers,
  parseWaiverScope,
  deTokenizeMarker,
  findMarkerNearMisses,
  formatNearMissDiagnostics,
  GATE_RE,
  VERDICT_RE,
} from "./markers.ts"
import { BlockError, createGates, type EvidenceSearch, type Gates } from "./gates.ts"
import {
  decisionEntry,
  observeEntry,
  observeSummaryEntry,
  wouldBlockEntry,
} from "./gates-common.ts"
import { waiverCovers } from "./gates-common.ts"
import { createEvidenceTracker, type EvidenceTracker } from "./evidence.ts"
import {
  createToolPolicy,
  isPushLanding,
  type HandsOnGateCapability,
  type LandingGateCapability,
  type BashWriteGateCapability,
  type ToolPolicy,
} from "./tool-policy.ts"
import { classifyBashWrite } from "./bash-write.ts"
import {
  MAINTENANCE_MAX_PER_PLAN,
  maintenanceDeclared,
  maintenanceDiffEligible,
  maintenanceMarkerSensitive,
} from "./maintenance.ts"
import * as fs from "node:fs"
import * as path from "node:path"
import { formatPipelineStatus } from "./state.ts"
import { classifyIntent, INTENT_KINDS, type IntentKind } from "./intent.ts"
import { intentNudge, orchestratorPolicyFor } from "./policy.ts"
import { createLedger, type GateLedger } from "./ledger.ts"
import { worktreeFingerprint, shouldCarryGate } from "./fingerprint.ts"
import { approvalResetsScope, keepsTaskScope } from "./task-scope.ts"
import { isEmptyDiffPush } from "./empty-diff.ts"
import {
  asSessionID,
  mutateDeliveryText,
  prependDeliveryText,
  promptTextOf,
  readRecordString,
  AGENT_KEYS,
  DIRECTORY_KEYS,
  PARENT_KEYS,
  type Delivery,
} from "./delivery.ts"
import type {
  ChildVerdict,
  GateState,
  Host,
  MarkerEvent,
  MarkerNearMiss,
  PromptHookProperties,
  SessionRecord,
  ToolHookEvent,
  TurnstileConfig,
  TurnstileOptions,
} from "./types.ts"

/** The host `tui.toast.show` function, when the TUI surface exists. */
type ToastShow = NonNullable<NonNullable<Host["tui"]>["toast"]>["show"]

/**
 * TTL (ms) shared by both ask-latch maps (awaiting-plan-ask and
 * pending-landing-ask): an escalation/arm whose `permission.asked` stream
 * event never arrives stops latching after this window, so a stale latch
 * cannot record an unrelated later ask. Fail-toward-strict: expired = not
 * recorded = a reply to any later ask stays inert and the gate re-asks on
 * the next dispatch — the safe direction when a stream event is lost. No
 * config key: users rarely reason about timing defaults, and the strict
 * expiry is never a user-visible behavior worth tuning.
 */
const askLatchTtlMs = 5_000

/** Shared per-setup context consumed by turnstile's per-surface hook modules. */
export interface TurnstileContext {
  // ── deps ──────────────────────────────────────────────────────────────────
  /** Resolved turnstile config. */
  config: TurnstileConfig
  /** Telemetry journal writer. */
  journaler: Journaler
  /** Compiled GATE marker regex. */
  gateRe: RegExp
  /** Compiled VERDICT marker regex. */
  verdictRe: RegExp
  /** Gate-state ledger (replays journal on construction). */
  ledger: GateLedger
  /**
   * Re-applies the boot replay's restored child→parent edges and re-seeds
   * the emitter-authority cache from them, journaling the `reseed` row;
   * called once per setup before hooks register (#225 re-seed).
   * @returns The number of child edges restored.
   */
  reseedChildEdges(): number
  /** Gate decision service. */
  gates: Gates
  /** Tool policy (push-landing requirement, denylist, etc.). */
  toolPolicy: ToolPolicy
  /** Evidence tracker for plan-approval stamps. */
  evidence: EvidenceTracker
  /** Set of known subagent names (name-guard skips). */
  subagentNames: Set<string>
  // ── maps ──────────────────────────────────────────────────────────────────
  /** Near-miss marker diagnostics pending delivery, keyed by parent. */
  nearMissPending: Map<string, MarkerNearMiss[]>
  /** Failed parent-lookup attempts, keyed by child session ID. */
  failedLookups: Map<string, { attempts: number; reason: string }>
  /** Parent → latest plan-reviewer dispatch timestamp. */
  planReviewerDispatch: Map<string, number>
  /** Parent → plan file names from its latest plan-reviewer dispatch. */
  planReviewTarget: Map<string, string[]>
  /** Parent → Date.now() of its latest admitted prompt (task window). */
  taskWindows: Map<string, number>
  /** Plan-gate permission asks, keyed by host request id. */
  planGateAsks: Map<string, { sessionID: string; recordedAt: number }>
  /** Parents escalated to a plan ask, awaiting the stream event. */
  awaitingPlanAsk: Map<string, number>
  /** Parents armed for a landing ask, awaiting the stream event. */
  pendingLandingAsk: Map<string, number>
  /** Parents armed for a hands-on ask, awaiting the stream event. */
  pendingHandsOnAsk: Map<string, number>
  /** Parent → Date.now() of its last landing escalation (ask-row dedupe). */
  lastLandingEscalateAt: Map<string, number>
  /** Parent → Date.now() of its last hands-on escalation (ask-row dedupe). */
  lastHandsOnEscalateAt: Map<string, number>
  /** Landing-gate permission asks, keyed by host request id. */
  landingGateAsks: Map<string, { sessionID: string; recordedAt: number }>
  /** Hands-on-gate permission asks, keyed by host request id. */
  handsOnGateAsks: Map<string, { sessionID: string; recordedAt: number }>
  /** Parent → pending intent-nudge kind awaiting the next tool delivery. */
  intentNudgePending: Map<string, IntentKind>
  /** `${sessionID}:${kind}` keys already nudged (one-shot per intent). */
  intentNudgedKinds: Set<string>
  /** Last-known project directory per session. */
  sessionDirs: Map<string, string>
  /** Per-session sliding window of streamed child text. */
  deltaWindows: Map<string, string>
  /** Child session ID → resolved agent name (emitter authority). */
  sessionAgents: Map<string, string>
  /** Dedupe keys for admitted prompts. */
  admittedIds: Set<string>
  /** Sessions already given their one session-end summary (per host process). */
  summarizedSessions: Set<string>
  // ── constants ─────────────────────────────────────────────────────────────
  /** Cap on parents holding pending near-miss diagnostics. */
  maxTrackedNearMiss: number
  /** Cap on tracked plan-gate asks. */
  maxTrackedPlanAsks: number
  /** Latch TTL for awaiting-plan-ask markers. */
  awaitingPlanAskTtlMs: number
  /** Cap on tracked pending-landing-ask arms. */
  maxTrackedLandingAsks: number
  /** Latch TTL for pending-landing-ask arms. */
  pendingLandingAskTtlMs: number
  /** Cap on tracked pending-hands-on-ask arms. */
  maxTrackedHandsOnAsks: number
  /** Latch TTL for pending-hands-on-ask arms. */
  pendingHandsOnAskTtlMs: number
  /** Cap on tracked landing-gate asks. */
  maxTrackedLandingGateAsks: number
  /** Cap on tracked hands-on-gate asks. */
  maxTrackedHandsOnGateAsks: number
  /** Cap on tracked intent-nudge dedupe keys. */
  maxTrackedIntentNudges: number
  /** Max parent-lookup retries per session. */
  maxLookupAttempts: number
  /** Cap on tracked failed-lookup sessions. */
  maxTrackedLookups: number
  /** Cap on tracked per-session project directories. */
  maxTrackedSessionDirs: number
  /** Max delta-window text chars (derived from the effective marker sources; floor 512). */
  maxDeltaWindowChars: number
  /** Cap on tracked delta-window entries. */
  maxTrackedDeltaWindows: number
  /** Cap on tracked emitter-authority entries. */
  maxTrackedEmitters: number
  /** Cap on tracked admitted-id dedupe keys. */
  maxTrackedAdmittedIds: number
  /** Lookup reason: host session.get threw (retryable). */
  LOOKUP_REASON_NOT_VISIBLE: string
  /** Lookup reason: record exists but has no parent edge. */
  LOOKUP_REASON_NO_PARENT_ID: string
  // ── bounders ──────────────────────────────────────────────────────────────
  /** Evicts oldest parents from nearMissPending past the cap. */
  boundNearMissPending(): void
  /** Evicts oldest entries from failedLookups past the cap. */
  boundLookups(): void
  /** Evicts oldest entries from sessionDirs past the cap. */
  boundSessionDirs(): void
  /** Evicts oldest entries from deltaWindows past the cap. */
  boundDeltaWindows(): void
  /** Evicts oldest entries from planReviewerDispatch past the cap. */
  boundDispatches(): void
  /** Evicts oldest entries from planReviewTarget past the cap. */
  boundTargets(): void
  /** Evicts oldest entries from taskWindows past the cap. */
  boundTaskWindows(): void
  /** Evicts oldest entries from planGateAsks past the cap. */
  boundPlanAsks(): void
  /** Evicts oldest entries from awaitingPlanAsk past the cap. */
  boundAwaitingAsks(): void
  /** Evicts oldest entries from pendingLandingAsk past the cap. */
  boundLandingAsks(): void
  /** Evicts oldest entries from pendingHandsOnAsk past the cap. */
  boundHandsOnAsks(): void
  /** Evicts oldest entries from landingGateAsks past the cap. */
  boundLandingGateAsks(): void
  /** Evicts oldest entries from handsOnGateAsks past the cap. */
  boundHandsOnGateAsks(): void
  /** Evicts oldest keys from the intent-nudge dedupe set and pending map. */
  boundIntentNudges(): void
  /** Evicts oldest entries from sessionAgents past the cap. */
  boundSessionAgents(): void
  /** Evicts oldest keys from admittedIds past the cap. */
  boundAdmittedIds(): void
  /** Evicts oldest keys from summarizedSessions past the cap. */
  boundSummarizedSessions(): void
  // ── services ──────────────────────────────────────────────────────────────
  /** Surfaces config warnings once into the first tool delivery. */
  surfaceConfigWarnings(event: ToolHookEvent): void
  /** Surfaces the end-of-period observe summary once into the first tool delivery. */
  surfaceObserveSummary(event: ToolHookEvent): void
  /** True when text contains at least one GATE or VERDICT marker. */
  hasMarker(text: string): boolean
  /** Journals one task/subagent dispatch entry. */
  recordDispatch(sessionID: string, agent: string, description: string, blocked: boolean): void
  /** Surfaces pending near-miss diagnostics into the first tool delivery. */
  surfaceNearMissDiagnostics(event: ToolHookEvent): void
  /** Seeds (or refreshes) a child session's emitter agent. */
  seedEmitter(sessionID: string, agent: string): void
  /** Returns the session's resolved emitter agent, or "" when unresolved. */
  emitterAgent(sessionID: string): string
  /** Returns a per-kind authority predicate for the session's emitter. */
  markerKindAllowed(sessionID: string): (kind: "gate" | "verdict") => boolean
  /** True when a live (unexpired) awaiting-plan-ask latch exists. */
  hasLiveAwaitingAsk(sid: string): boolean
  /** True when a live (unexpired) pending-landing-ask latch exists. */
  hasLiveLandingAsk(sid: string): boolean
  /** True when a live (unexpired) pending-hands-on-ask latch exists. */
  hasLiveHandsOnAsk(sid: string): boolean
  /** Returns the last-known project directory for a session. */
  currentProjectDir(sessionID: string): string
  /** Resolves the project directory via session.get, caching per session. */
  resolveProjectDir(sessionID: string): Promise<string>
  /** Resolves and caches the parent of a child session via the host API. */
  resolveParent(sessionID: string | undefined): Promise<void>
  /** Re-evaluates evidence correlation for a parent with a pending PASS. */
  promoteOnEvidence(parent: string): void
  /** Builds the attribution diagnostic for a gate-unverified refusal. */
  evidenceSearch(sid: string): EvidenceSearch
  /** Resolves the read-budget key (parent or self) for a session. */
  readBudgetKey(sid: string): Promise<string>
  /** Runs the read-budget guard, suppressing a deliberate block in the observe period. */
  handleReadBudget(key: string): void
  /** Returns the last verdict match in text for re. */
  lastMatch(text: string, re: RegExp): string
  /** Stamps a plan-reviewer verdict's approval against the plans dir. */
  stampPlanApproval(s: GateState, result: string, projectDir: string, candidates: string[]): void
  /** Returns the optional identity/stamp fields a plan APPROVE journals. */
  planApprovalStampFields(s: GateState): {
    plan?: string
    planKey?: string
    plansSig?: string
  }
  /** Splits a self-keyed delivery's children into edge and unresolved. */
  discoverCandidates(sid: string): {
    edge: string[]
    unresolved: Array<{ child: string; verdict: ChildVerdict }>
  }
  /** Returns unresolved children plausibly this parent's next task. */
  plausibleUnresolved(
    sid: string,
    unresolved: Array<{ child: string; verdict: ChildVerdict }>,
  ): string[]
  /** Returns the most-recently-recorded child among the given ids. */
  mostRecentUnresolved(children: string[]): string | undefined
  /** Returns per-session lookup diagnostics for the delivery child. */
  lookupDiag(
    child: string,
    unresolved: string[],
  ): Record<string, { attempts: number; reason: string }>
  /** Journals a policy-injection outcome for a session. */
  journalPolicy(sessionID: string, injected: boolean, extra?: Record<string, unknown>): void
  /** True when the conservative event.agent name guard must skip. */
  nameGuardSkips(event: ToolHookEvent, child: string): boolean
  /** Injects the orchestrator policy into the first task delivery. */
  injectOrchestratorPolicy(
    event: ToolHookEvent,
    child: string,
    delivery: Delivery,
    agent: string,
  ): Promise<void>
  /** Appends the per-delivery pipeline status tail. */
  appendPipelineStatus(
    parent: string,
    event: ToolHookEvent,
    delivery: Extract<Delivery, { kind: "string" | "structured" }>,
    agent: string,
  ): void
  /** Prepends the orchestrator policy head once per task. */
  prependPolicy(
    parent: string,
    event: ToolHookEvent,
    delivery: Extract<Delivery, { kind: "string" | "structured" }>,
  ): void
  /**
   * Delivers a pending intent nudge on a classified task delivery: consumes
   * the parent's pending nudge (one-shot) and prepends the advisory text.
   */
  prependIntentNudge(event: ToolHookEvent, parent: string, delivery: Delivery): void
  /**
   * Delivers a pending intent nudge on a parent-keyed read delivery: consumes
   * the pending nudge (one-shot) and prepends the advisory text to a string
   * output; non-string outputs keep the nudge pending.
   */
  prependIntentNudgeRead(event: ToolHookEvent): void
  /** Applies the injection dispatch table once the name guard passes. */
  applyPolicyResult(parent: string, event: ToolHookEvent, delivery: Delivery, agent: string): void
  /** Attributes a plan-reviewer result to the parent's plan-approval gate. */
  attributePlanVerdict(child: string, output: string): Promise<void>
  /** Credits a reviewer APPROVE onto the parent bucket (ensemble-gated). */
  creditReviewApproval(child: string, markerEvents: MarkerEvent[]): void
  /** Prologue for a task/subagent dispatch. */
  handleTaskDispatch(event: ToolHookEvent): Promise<void>
  /** Guard-and-journal section of a task dispatch. */
  guardedTaskDispatch(
    sessionID: string,
    agent: string,
    prompt: string,
    description: string,
  ): Promise<void>
  /** Handles a bash/shell tool call. */
  handleBashDispatch(event: ToolHookEvent, tool: "bash" | "shell"): void
  /** Consumes the hands-on once-grant when one is pending; true = released. */
  consumeHandsOnGrant(st: GateState): boolean
  /** Handles a write/edit tool call (denylist + hands-on gate; parent sessions and non-pipeline subagents gate, only registered pipeline children are exempt). */
  handleWriteEditDispatch(event: ToolHookEvent, tool: "write" | "edit"): void
  /**
   * Swallows a deliberate BlockError at the catch-all execute.before choke
   * point while a user-typed gate suspension is active for the event's
   * parent (journaled, tool proceeds); false when no suspension is active.
   */
  suspendBlock(event: ToolHookEvent, e: BlockError): boolean
  /** Handles a session_move tool call. */
  handleSessionMove(event: ToolHookEvent): void
  /** Parses markers out of assistant text and journals first-sight events. */
  parseMarkers(text: string, sessionID: string, source: string, dedupScope?: string): MarkerEvent[]
  /** Admits one user-authored prompt. */
  admitPrompt(sessionID: string, properties: PromptHookProperties, admissionID: string): void
  // ── methods ───────────────────────────────────────────────────────────────
  /** Binds the host session API for resolveParent. */
  bindHost(session: Host["session"]): void
  /** Bound toast deliverer (undefined when the host offers no TUI surface). */
  toast?: (message: string, variant: "info" | "success" | "warning") => Promise<void>
  /** Binds the host toast surface for the session-end summary delivery. */
  bindToast(show: ToastShow | undefined): void
  /** Increments the prompt-hook fire counter. */
  bumpPromptFires(): void
  /** Returns the next task-delivery sequence number. */
  nextTaskDeliverySeq(): number
}

/**
 * Builds the shared per-setup context for turnstile's hook registrations.
 * All shared state (config, journaler, gates, maps, services) is scoped to
 * one setup() call: a host calling setup() twice gets fresh dedupe/metering
 * state. The one-setup-per-load lifecycle makes this unobservable.
 * @param opts Injected config/env overrides; see TurnstileOptions.
 * @returns The shared context consumed by per-surface hook modules.
 */
export function createHooksCore(opts: TurnstileOptions): TurnstileContext {
  const env = opts.env ?? process.env
  const { config, warnings: configWarnings } = loadConfig(env, opts.config)
  // The policy head is built once per plugin load from the resolved config so
  // the injected prose (caps, markers, journal paths) matches the mechanical
  // enforcement; it is constant for the load's lifetime.
  const policyText = orchestratorPolicyFor(config)
  const journaler: Journaler = createJournaler({
    metricsDir: config.metricsDir,
    trace: config.trace,
    maxBytes: config.journalMaxBytes,
    maxGenerations: config.journalMaxGenerations,
    rotateEveryEntries: config.journalRotateEveryEntries,
  })
  // Config warnings are journaled exactly once, by config.ts (the pre-journaler
  // sink); they are now also *surfaced* once into the model context by the
  // first tool delivery that carries string output (see
  // `surfaceConfigWarnings`), and never re-journaled here (that would
  // double-write every entry).
  // One-time config-warning surfacing: true while `configWarnings` still
  // deserve a context block. Set at plugin build (no warnings ⇒ already
  // surfaced, zero behavior change); consumed by the first execute.after
  // delivery that carries string output — the same model-facing channel as
  // the policy injection and the read-budget warning prefix.
  let configWarningsPending = configWarnings.length > 0
  // End-of-period observe summary: true while the once-per-load
  // `[turnstile] observe:` block still deserves a context slot. Armed by the
  // admission stamp that completes the observe period (see
  // `stampObserveAdmission`) and re-armed at boot when the replayed journal
  // tail shows a completed period whose summary never surfaced (the
  // journaled `kind:"summary"` marker is the one-shot proof — a tail that
  // holds it re-arms nothing). Consumed by the first tool delivery that
  // carries string output (see `surfaceObserveSummary`); a default (off)
  // period never arms it.
  let observeSummaryPending = false
  // Surfaces unresolved config-validation warnings once per plugin load by
  // prepending a `[turnstile] config:` block to the first tool result with
  // string output — from any session, primary or child — the model-facing
  // channel proven by the policy injection and the read-budget prefix.
  // Fail-open: a throwing mutation journals
  // `{type:"config", surfaced:false}` and never blocks the tool; the journal
  // already carries every warning (loadConfig journaled them), so this entry
  // is a surface audit (surfaced/count), not a second copy of the warnings.
  function surfaceConfigWarnings(event: ToolHookEvent): void {
    if (!configWarningsPending) return
    if (!event?.result || typeof event.result.output !== "string") return
    const sessionID = asSessionID(event.sessionID)
    try {
      event.result.output =
        formatConfigWarnings(configWarnings, journaler.journalPath) + "\n" + event.result.output
      configWarningsPending = false
      journaler.journal({
        type: "config",
        sessionID,
        surfaced: true,
        count: configWarnings.length,
      })
    } catch (e) {
      journaler.journal({
        type: "config",
        sessionID,
        surfaced: false,
        error: String(e),
      })
    }
  }
  /**
   * Surfaces the end-of-period observe summary once per plugin load by
   * prepending a `[turnstile] observe:` block to the first tool result with
   * string output — the same model-facing channel as the config-warning and
   * read-budget blocks. Armed by the period-completing admission stamp and by
   * boot replay of a completed period lacking its journaled summary marker
   * (never armed by a default, off period). Fail-open: a throwing mutation
   * journals `type:"error"` and never blocks the tool, and the block stays
   * pending for a later delivery — the `kind:"summary"` marker is journaled
   * only after a successful prepend, so a restart re-surfaces exactly once.
   * @param event The host execute.after tool-hook payload (mutated in place).
   */
  function surfaceObserveSummary(event: ToolHookEvent): void {
    if (!observeSummaryPending) return
    if (!event?.result || typeof event.result.output !== "string") return
    const sessionID = asSessionID(event.sessionID)
    try {
      const counts = ledger.observeCounts()
      event.result.output =
        formatObserveSummary(counts, journaler.journalPath) + "\n" + event.result.output
      observeSummaryPending = false
      journaler.journal(observeSummaryEntry(sessionID, counts.observed, counts.wouldBlocks))
    } catch (e) {
      journaler.journal({
        type: "error",
        sessionID,
        error: `observe summary injection: ${e}`,
      })
    }
  }
  const gateRe = compileMarkerRegex(config.gateMarker, GATE_RE, (cause) =>
    journaler.journal({
      type: "error",
      error: `config gateMarker: invalid regex, using default: ${String(cause)}`,
    }),
  )
  const verdictRe = compileMarkerRegex(config.verdictMarker, VERDICT_RE, (cause) =>
    journaler.journal({
      type: "error",
      error: `config verdictMarker: invalid regex, using default: ${String(cause)}`,
    }),
  )

  /**
   * True when the text contains at least one GATE or VERDICT marker per the
   * compiled config regexes. Uses `String.match`, so the `g` flag's
   * `lastIndex` state is not an issue; scans the whole output (no window).
   * @param text The output text to scan.
   */
  function hasMarker(text: string): boolean {
    return (text.match(gateRe)?.length ?? 0) > 0 || (text.match(verdictRe)?.length ?? 0) > 0
  }

  /**
   * Records one `task`/`subagent` dispatch plus its trace line — the single
   * canonical copy, called at guard exit so an allowed dispatch is
   * byte-identical to before while a blocked attempt stamps `blocked:true`
   * (audit distinguishes dispatched from blocked-and-attempted).
   * @param sessionID The dispatching session ID.
   * @param agent The resolved agent name.
   * @param description The trace-gated dispatch description.
   * @param blocked Whether a guard rejected the dispatch (stamps `blocked:true`).
   */
  function recordDispatch(
    sessionID: string,
    agent: string,
    description: string,
    blocked: boolean,
  ): void {
    journaler.journal({
      type: "dispatch",
      sessionID,
      agent,
      description,
      ...(blocked ? { blocked: true } : {}),
    })
    journaler.traceEvent("orchestrator", "dispatch", `task -> ${agent}`, sessionID)
  }
  const ledger: GateLedger = createLedger(
    journaler.journalPath,
    config.maxSessions,
    config.replayTailLines,
    opts.approvalLedgerPath,
    config.observeSessions,
  )
  // Re-arm the end-of-period summary at boot: the replayed tail may show a
  // completed period whose summary never surfaced (the process died between
  // the completing stamp and the first string-output delivery) — replay
  // re-arms the one-shot so the summary still lands on this load. A tail
  // that already holds the `kind:"summary"` marker re-arms nothing; a
  // default (off) period never completes, so this is a no-op there.
  if (ledger.observeCounts().pendingSummary) observeSummaryPending = true
  // Near-miss marker diagnostics pending surfacing, keyed by parent session ID.
  // Hits are detected and journaled at prompt admission (see admitPrompt) and
  // parked here; the session's next string-output tool delivery surfaces them
  // once as a `[turnstile] marker:` block — the same model-facing channel as
  // the config-warning and read-budget blocks. A blocked dispatch never reaches
  // execute.after, so the diagnostic lands on the next string output. Bounded
  // like the admission dedupe set: FIFO-evict the oldest parent past the cap.
  const nearMissPending = new Map<string, MarkerNearMiss[]>()
  // Cap on parents holding pending near-miss diagnostics (bounded memory).
  const maxTrackedNearMiss = 16
  /**
   * Bounds the pending near-miss map by evicting its oldest parents.
   */
  function boundNearMissPending(): void {
    evictTo(nearMissPending, maxTrackedNearMiss)
  }
  /**
   * Surfaces pending near-miss marker diagnostics once into the model context
   * by prepending a `[turnstile] marker:` block to the first tool result with
   * string output for a parent that has a pending entry — the same channel as
   * `surfaceConfigWarnings`. The hits were already journaled at detection
   * (prompt admission), so this entry is a surface audit only (surfaced/count),
   * not a second copy. Fail-open: a throwing mutation journals
   * `{type:"marker", event:"surfaced", surfaced:false}` and never blocks the
   * tool; a non-string output retries on the next delivery (the pending entry
   * stays). Child deliveries surface to their parent (same keying as the
   * read-budget warning); an unregistered child self-keys.
   * @param event The `execute.after` tool hook payload.
   */
  function surfaceNearMissDiagnostics(event: ToolHookEvent): void {
    const sessionID = ledger.parentOf(asSessionID(event?.sessionID))
    const hits = nearMissPending.get(sessionID)
    if (!hits || hits.length === 0) return
    if (!event?.result || typeof event.result.output !== "string") return
    try {
      event.result.output =
        formatNearMissDiagnostics(hits, journaler.journalPath) + "\n" + event.result.output
      nearMissPending.delete(sessionID)
      journaler.journal({
        type: "marker",
        event: "surfaced",
        sessionID,
        surfaced: true,
        count: hits.length,
      })
    } catch (e) {
      journaler.journal({
        type: "marker",
        event: "surfaced",
        sessionID,
        surfaced: false,
        count: hits.length,
        error: String(e),
      })
    }
  }
  const gates: Gates = createGates(config, journaler)
  // Stateless denylist for bash/shell and write/edit tools in execute.before
  // regexes compile once here; it throws the same BlockError gates
  // throw, so the hook's existing catch rethrows blocks and journals the rest.
  const toolPolicy: ToolPolicy = createToolPolicy(config, journaler)
  // Evidence tracker: correlates a GATE: PASS against journaled exit-0
  // bash/shell test executions attributed to the parent. Owns only the
  // *evidence* dimension; marker authority is separate.
  const evidence = createEvidenceTracker(config, (raw) => ledger.parentOf(raw), journaler)
  // Per-delivery dedup scope counter: each task result is a distinct
  // delivery, so a re-run emitting a byte-identical marker is still
  // journaled; streaming sources share the empty scope (re-delivery dedup).
  let taskDeliverySeq = 0
  // Dispatchable agent names, the conservative-exclusion fallback for
  // orchestrator-policy injection: a delivery carrying one of these names
  // with an UNRESOLVABLE child→parent edge is skipped (and journaled)
  // rather than injected self-keyed. Same config.agents keys the dispatch
  // guards read, so a renamed agent is excluded by name exactly as before.
  const subagentNames = new Set(
    (["reviewer", "planReviewer", "executor", "testRunner", "debugger", "planner"] as const).map(
      (name) => config.agents[name],
    ),
  )

  // Host session API, bound at setup time (hooks already fire post-setup).
  // Kept in factory scope so the shared `resolveParent` helper can call it
  // without capturing the per-setup `h`; enables the plan-reviewer delivery
  // path to await edge resolution via `session.get`.
  let hostSession: Host["session"] | undefined = undefined

  // Parent-lookup bookkeeping, keyed by child session ID.
  // Values record how many lookups were attempted and why the record stayed
  // unresolved: `"not-visible"` (host `session.get` threw) or `"no-parent-id"`
  // (the record exists but has no parent edge); cleared on success. Capped so
  // long-lived hosts cannot grow it unboundedly.
  const failedLookups = new Map<string, { attempts: number; reason: string }>()
  // `"not-visible"`: host `session.get` threw the lookup is retryable.
  const LOOKUP_REASON_NOT_VISIBLE = "not-visible"
  // `"no-parent-id"`: the record exists but has no parent edge (negative cache).
  const LOOKUP_REASON_NO_PARENT_ID = "no-parent-id"
  // Parent session ID → Date.now() of its LATEST plan-reviewer dispatch
  // (last-wins; cleared on task-scope reset for that parent). Plausibility
  // input: an unresolved-child verdict is plausible only within the parent's
  // current task scope (recorded at-or-after this time, and unique across
  // parents). Capped via boundDispatches, the same eviction idiom as
  // boundLookups.
  const planReviewerDispatch = new Map<string, number>()
  // Parent session ID → plan file names extracted from its LATEST
  // plan-reviewer dispatch prompt (last-wins; cleared on task-scope reset for
  // that parent). Binding input: when the round's plan-reviewer APPROVE
  // lands, this is the candidate set the approval binds to via
  // gates.planApprovalBinding (a unique existing mention binds the plan name
  // + content key; anything else stays unbound). Capped via boundTargets,
  // the same eviction idiom as boundDispatches.
  const planReviewTarget = new Map<string, string[]>()
  // Parent session ID → Date.now() of its LATEST admitted prompt: the current
  // task's evidence window. A GATE: PASS may only be promoted by executions
  // journaled at-or-after the stamp, so a stale prior-task execution
  // (surviving under an unresolved child) cannot verify a new task's claim.
  // A parent that never admits a prompt has no stamp and keeps the unbounded
  // join (fail-open, documented). Capped via boundTaskWindows, the same
  // eviction idiom as boundDispatches.
  const taskWindows = new Map<string, number>()
  // Plan-gate permission asks, keyed by host request id → the parent session
  // the ask was raised for + when it was recorded. Only asks escalated by the
  // evaluate handler (reason "plan-gate") are recorded, so a reply to an
  // unrelated permission ask (bash, write, …) can never match or release the
  // plan gate, and concurrent sessions cannot clobber each other (values
  // carry their own session). Bounded: evict oldest past the cap.
  const planGateAsks = new Map<string, { sessionID: string; recordedAt: number }>()
  // Cap on tracked plan-gate asks: evict oldest (insertion order) past it.
  const maxTrackedPlanAsks = 50
  // Parents whose evaluate handler has escalated to an ask but whose
  // `permission.asked` stream event has not arrived yet: parent → escalation
  // time. The evaluate handler does not know the host request id (it rides the
  // later stream event), so the next ask for an escalated parent is treated as
  // the plan ask and recorded. Bounded by boundAwaitingAsks, and latches
  // expire (see awaitingPlanAskTtlMs) so a lost stream event cannot latch a
  // parent indefinitely.
  const awaitingPlanAsk = new Map<string, number>()
  // Latch TTL for awaiting-plan-ask markers: an escalation whose stream event
  // never arrives stops latching after this window, so a stale marker cannot
  // record an unrelated later ask (whose approval would then release the plan
  // gate). The value is single-sourced at module scope (`askLatchTtlMs`).
  const awaitingPlanAskTtlMs = askLatchTtlMs
  // Parents whose evaluate handler has been armed to force a landing ask (the
  // guard sets this on a repeat `git push` attempt: no reviewer approval AND
  // >= 1 prior landing block). Parent → arm
  // time. The landing arm consults it (not the command, whose wire shape in the
  // permission event is unverified — the guard is the single source of truth
  // for landing-candidate detection via isPushLanding). Bounded by
  // boundLandingAsks; expires like awaitingPlanAsk so a lost stream event
  // cannot latch a parent indefinitely.
  const pendingLandingAsk = new Map<string, number>()
  const maxTrackedLandingAsks = 50
  // The landing arm shares the awaiting-plan-ask TTL: same fail-toward-strict
  // expiry, single-sourced at module scope (`askLatchTtlMs`).
  const pendingLandingAskTtlMs = askLatchTtlMs
  // Landing-gate permission asks, keyed by host request id → the parent session
  // the ask was raised for + when it was recorded. Only asks by the evaluate
  // handler's landing arm (message prefixed `turnstile: push/PR …`) are
  // recorded, so a reply to an unrelated permission ask can never match or
  // release the landing gate; per-reason keying keeps a landing `once` grant
  // from ever being consumed by a plan-gate (task) dispatch and vice versa.
  // Bounded: evict oldest past the cap.
  const landingGateAsks = new Map<string, { sessionID: string; recordedAt: number }>()
  const maxTrackedLandingGateAsks = 50
  // Parents whose evaluate handler has been armed to force a hands-on ask
  // (the guard sets this on a repeat parent
  // write/edit attempt: no release AND >= 1 prior hands-on block). Parent →
  // arm time. Bounded by boundHandsOnAsks; expires like the other latches so
  // a lost stream event cannot latch a parent indefinitely.
  const pendingHandsOnAsk = new Map<string, number>()
  const maxTrackedHandsOnAsks = 50
  // The hands-on arm shares the ask-latch TTL: same fail-toward-strict
  // expiry, single-sourced at module scope (`askLatchTtlMs`).
  const pendingHandsOnAskTtlMs = askLatchTtlMs
  // Landing-ask dedupe: parent → Date.now() of the parent's last landing
  // escalation. A re-arm within `askLatchTtlMs` of the previous escalation
  // collapses into the already-armed latch's single ask row — the guard
  // journals no second `permission` ask row and takes the block path instead
  // while the latch stays live for the evaluate handler. Bounded by
  // boundLandingAsks; cleared wherever pendingLandingAsk is cleared.
  const lastLandingEscalateAt = new Map<string, number>()
  // Hands-on-ask dedupe (mirrors lastLandingEscalateAt for the hands-on
  // gate): bounded by boundHandsOnAsks; cleared wherever pendingHandsOnAsk
  // is cleared.
  const lastHandsOnEscalateAt = new Map<string, number>()
  // Hands-on-gate permission asks, keyed by host request id → the parent
  // session the ask was raised for + when it was recorded. Only asks by the
  // evaluate handler's hands-on arm (message prefixed
  // `turnstile: hands-on edits …`) are recorded, so a reply to an unrelated
  // permission ask can never match or release the hands-on gate; per-reason
  // keying keeps a hands-on `once` grant from ever being consumed by a
  // plan-gate (task) dispatch or a landing push and vice versa. Bounded: evict
  // oldest past the cap.
  const handsOnGateAsks = new Map<string, { sessionID: string; recordedAt: number }>()
  const maxTrackedHandsOnGateAsks = 50
  // Pending intent nudges: parent → the detected IntentKind awaiting the
  // parent's next tool delivery (armed by prompt admission, consumed once).
  // Latest-wins when one prompt's nudge is still undelivered and a later
  // prompt classifies a different kind: the earlier kind is preserved in the
  // journaled `intent` row, but only the latest armed kind rides the next
  // delivery — the pending map holds one kind per parent by design (a
  // per-parent queue would let stale nudges land long after their prompt).
  // A task-scope drop releases any undelivered nudge (task-scoped delivery
  // state); bounded by boundIntentNudges alongside the dedupe set.
  const intentNudgePending = new Map<string, IntentKind>()
  // Intent-nudge one-shot latch: `${sessionID}:${kind}` keys already nudged.
  // One nudge per detected intent signal, deduped across the task scope (a
  // repeated intent prompt journals but does not re-nudge); the
  // latch is NOT cleared by a task-scope drop — a plan approval clears it, so
  // a later task's intents can nudge again. Bounded: evict oldest past the cap.
  const intentNudgedKinds = new Set<string>()
  const maxTrackedIntentNudges = 64

  /**
   * Bounds the intent-nudge state: evicts the oldest dedupe keys past the
   * latch cap and the oldest pending nudges past the session cap.
   */
  function boundIntentNudges(): void {
    evictTo(intentNudgedKinds, maxTrackedIntentNudges)
    evictTo(intentNudgePending, config.maxSessions)
  }

  /**
   * Clears a session's entire intent-nudge state: the pending (undelivered)
   * nudge and every per-kind dedupe key. Called when a plan approval lands —
   * the task got its plan, so a later task's intents may nudge again — and
   * when the active task retires (both retire paths route through
   * `markTaskComplete`), so the successor task's first repeated intent can
   * nudge. (The task-scope reset drops only the undelivered pending nudge;
   * the dedupe keys survive it by design.)
   * @param sessionID The parent session whose nudge state is cleared.
   */
  function clearIntentNudge(sessionID: string): void {
    intentNudgePending.delete(sessionID)
    for (const kind of INTENT_KINDS) {
      intentNudgedKinds.delete(`${sessionID}:${kind}`)
    }
  }
  // A thrown lookup may mean the child record is not yet visible to the
  // host API, so failures are retried up to this many times per session.
  const maxLookupAttempts = 3
  // Bound on tracked sessions: evict oldest (insertion order) when past.
  const maxTrackedLookups = 256
  // Bound on tracked per-session project directories: evict oldest (insertion
  // order) when past. Mirrors maxTrackedLookups.
  const maxTrackedSessionDirs = 50
  // Last-known project directory per session, resolved via session.get and
  // invalidated on session_move. The per-dispatch resolver caches fresh here so
  // the sync consumers (evaluate, continuation carry) read one dispatch behind;
  // the sync consumers fall back to a cached value, then process.cwd().
  // Bounded by boundSessionDirs.
  const sessionDirs = new Map<string, string>()

  /**
   * Bounds the failed-lookup map by evicting its oldest entries.
   */
  function boundLookups(): void {
    evictTo(failedLookups, maxTrackedLookups)
  }

  /**
   * Bounds the session-directory map by evicting its oldest entries.
   */
  function boundSessionDirs(): void {
    evictTo(sessionDirs, maxTrackedSessionDirs)
  }

  /**
   * Per-session sliding window of streamed child text: a host may split one
   * marker across `session.text.delta` chunks, and a fragment-only parse silently
   * loses the gate flip. Each delta re-parses the window's tail; markers.ts dedup
   * suppresses every re-fire, so only a newly completed marker is first-sighted.
   * Bounded by boundDeltaWindows; cleared on the next task dispatch (see
   * execute.before age-out) so stale fragments of a prior task do not leak.
   */
  const deltaWindows = new Map<string, string>()
  // Derived from the effective compiled marker sources with a 512-char floor
  // (deltaWindowFloorChars): the tail keeps a window whose head was evicted so
  // a marker split across many small deltas still completes, including one
  // whose configured literal is longer than the historical bound.
  const maxDeltaWindowChars = deltaWindowFloorChars(gateRe.source, verdictRe.source)
  const maxTrackedDeltaWindows = 50

  /**
   * Bounds the delta-window map by evicting its oldest entries.
   */
  function boundDeltaWindows(): void {
    evictTo(deltaWindows, maxTrackedDeltaWindows)
  }

  /**
   * Bounds the dispatch-timestamp map by evicting its oldest entries.
   */
  function boundDispatches(): void {
    evictTo(planReviewerDispatch, maxTrackedLookups)
  }

  /**
   * Bounds the plan-review-target map by evicting its oldest entries.
   */
  function boundTargets(): void {
    evictTo(planReviewTarget, maxTrackedLookups)
  }

  /**
   * Bounds the task-window map by evicting its oldest entries.
   */
  function boundTaskWindows(): void {
    evictTo(taskWindows, maxTrackedLookups)
  }

  /**
   * Bounds the plan-gate ask map by evicting its oldest recorded asks.
   */
  function boundPlanAsks(): void {
    evictTo(planGateAsks, maxTrackedPlanAsks)
  }

  /**
   * Bounds the awaiting-plan-ask map (parent → escalation time), evicting its
   * oldest entries.
   */
  function boundAwaitingAsks(): void {
    evictTo(awaitingPlanAsk, maxTrackedPlanAsks)
  }

  /**
   * Reads (and expires) the awaiting-plan-ask latch for a session: a marker
   * older than the TTL is dropped and reported as absent. Fail-toward-strict:
   * an expired latch records nothing, so a reply to any later ask stays inert
   * and the plan gate re-asks on the next dispatch.
   * @param sid The session whose latch is consulted.
   * @returns Whether a live (unexpired) latch exists for the session.
   */
  function hasLiveAwaitingAsk(sid: string): boolean {
    const at = awaitingPlanAsk.get(sid)
    if (at === undefined) return false
    if (Date.now() - at > awaitingPlanAskTtlMs) {
      awaitingPlanAsk.delete(sid)
      return false
    }
    return true
  }

  /**
   * Bounds the pending-landing-ask map (parent → arm time) and the landing
   * dedupe-timestamp map, evicting their oldest entries.
   */
  function boundLandingAsks(): void {
    evictTo(pendingLandingAsk, maxTrackedLandingAsks)
    evictTo(lastLandingEscalateAt, maxTrackedLandingAsks)
  }

  /**
   * Bounds the pending-hands-on-ask map (parent → arm time) and the hands-on
   * dedupe-timestamp map, evicting their oldest entries.
   */
  function boundHandsOnAsks(): void {
    evictTo(pendingHandsOnAsk, maxTrackedHandsOnAsks)
    evictTo(lastHandsOnEscalateAt, maxTrackedHandsOnAsks)
  }

  /**
   * Bounds the hands-on-gate ask map (requestID → parent + record time),
   * evicting its oldest entries.
   */
  function boundHandsOnGateAsks(): void {
    evictTo(handsOnGateAsks, maxTrackedHandsOnGateAsks)
  }

  /**
   * Bounds the landing-gate ask map (requestID → parent + record time),
   * evicting its oldest entries.
   */
  function boundLandingGateAsks(): void {
    evictTo(landingGateAsks, maxTrackedLandingGateAsks)
  }

  /**
   * Emitter-authority cache: a child session ID → its resolved agent name,
   * seeded at three redundant points (`resolveParent` record read,
   * `session.created`, and `execute.after` task input). Read by
   * `markerKindAllowed` to decide whether a session's `GATE:`/`VERDICT:` text
   * is authoritative for that kind. Bounded by boundSessionAgents.
   */
  const sessionAgents = new Map<string, string>()
  const maxTrackedEmitters = 50
  /**
   * Bounds the emitter-authority cache by evicting its oldest entries.
   */
  function boundSessionAgents(): void {
    evictTo(sessionAgents, maxTrackedEmitters)
  }
  /**
   * Seeds (or refreshes) a child session's emitter agent. No-op when either
   * argument is empty, so an unresolved record read ("") never clobbers a
   * known agent. `markerKindAllowed` reads the cache lazily at parse time, so
   * a seed arriving before the marker's parse still applies.
   * @param sessionID The child session ID.
   * @param agent The resolved agent name, or "" when unresolved.
   */
  function seedEmitter(sessionID: string, agent: string): void {
    if (sessionID && agent) {
      sessionAgents.set(sessionID, agent)
      boundSessionAgents()
    }
  }

  /**
   * Rebuilds the post-reload child state from the journal tail (#225 defense
   * in depth): the ledger re-applies the journaled `child-edge` rows to
   * `childToParent` (a live executor/test-runner child is no longer gated as
   * a parent on its next write after a plugin setup re-fire), the
   * emitter-authority cache is re-seeded from each edge's journaled agent
   * (one entry covers both re-seeds), and one `reseed` row records the
   * edges-restored count so a post-reload parent-hands-on block is
   * diagnosable as a re-seed failure, not a gate malfunction. Fail-open: a
   * throwing re-seed journals an error and reports 0.
   * @returns The number of child edges restored.
   */
  function reseedChildEdges(): number {
    try {
      const edges = ledger.reseedEdges()
      for (const edge of edges) seedEmitter(edge.child, edge.agent)
      journaler.journal({ type: "reseed", edges: edges.length })
      return edges.length
    } catch (e) {
      journaler.journal({ type: "error", error: `reseed: ${e}` })
      return 0
    }
  }

  /**
   * Reads the emitter-authority cache for a session: the resolved agent
   * name, or "" when the session's agent was never resolved. Pure read
   * (no LRU promotion); the delivery layer consults it as the fallback for
   * a delivery whose dispatch input names no agent, and the authority gate
   * and the suppressed-credit journal read it for the same decision.
   * @param sessionID The session ID to read.
   * @returns The resolved agent name, or "" when unresolved.
   */
  function emitterAgent(sessionID: string): string {
    return sessionAgents.get(sessionID) ?? ""
  }

  /**
   * Resolves a tool event session's registration status through the
   * child-registration boundary: a non-empty event agent name in the
   * configured pipeline set is authoritative (edge or not — parents never
   * carry a subagent agent name); otherwise the child→parent edge plus the
   * emitter-authority fallback decides; anything unresolved is `"unknown"`
   * and gates like a parent (fail closed). Supersedes the former
   * edge-required check, so a generic-subagent dispatch or a child whose
   * edge was lost to a reload still exempts from its name.
   * @param sid The tool event's session ID.
   * @param agent The resolved agent name candidate from the event ("" when none).
   * @returns The session's registration status at this boundary.
   */
  function childStatus(sid: string, agent: string): "child" | "parent" | "unknown" {
    return resolveChildStatus(sid, agent, ledger, subagentNames, emitterAgent)
  }

  /**
   * Emits a predicate answering whether a gate/verdict kind is authoritative
   * for a session's emitter agent. A gate flips only for `test-runner`; a
   * verdict only for `reviewer`/`plan-reviewer` — each also required to be in
   * `bareOutput` (the aggregated marker-contracted set). Unseeded or unknown
   * agents are denied: text observation mutates only for contracted emitters,
   * and a legitimate child's markers always land authoritatively at
   * `execute.after` delivery, which seeds the agent from dispatch input.
   * @param sessionID The emitting session ID.
   * @returns A per-kind authority predicate.
   */
  function markerKindAllowed(sessionID: string): (kind: "gate" | "verdict") => boolean {
    const agent = emitterAgent(sessionID)
    return (kind) => {
      if (agent === "" || !config.agents.bareOutput.includes(agent)) return false
      if (kind === "gate") return agent === config.agents.testRunner
      return agent === config.agents.reviewer || agent === config.agents.planReviewer
    }
  }

  /**
   * Reads (and expires) the pending-landing-ask latch for a session: an arm
   * older than the TTL is dropped and reported as absent. Fail-toward-strict:
   * an expired latch arms nothing, so a later ask is inert and the landing gate
   * re-blocks.
   * @param sid The parent session whose latch is consulted.
   * @returns Whether a live (unexpired) latch exists for the session.
   */
  function hasLiveLandingAsk(sid: string): boolean {
    const at = pendingLandingAsk.get(sid)
    if (at === undefined) return false
    if (Date.now() - at > pendingLandingAskTtlMs) {
      pendingLandingAsk.delete(sid)
      // Mirror the expiry on the dedupe map too: a stale timestamp must not
      // suppress a legitimate new ask row after the latch expired.
      lastLandingEscalateAt.delete(sid)
      return false
    }
    return true
  }

  /**
   * Reads (and expires) the pending-hands-on-ask latch for a session: an arm
   * older than the TTL is dropped and reported as absent. Fail-toward-strict:
   * an expired latch arms nothing, so a later ask is inert and the hands-on
   * gate re-blocks.
   * @param sid The parent session whose latch is consulted.
   * @returns Whether a live (unexpired) latch exists for the session.
   */
  function hasLiveHandsOnAsk(sid: string): boolean {
    const at = pendingHandsOnAsk.get(sid)
    if (at === undefined) return false
    if (Date.now() - at > pendingHandsOnAskTtlMs) {
      pendingHandsOnAsk.delete(sid)
      // Mirror the expiry on the dedupe map too: a stale timestamp must not
      // suppress a legitimate new ask row after the latch expired.
      lastHandsOnEscalateAt.delete(sid)
      return false
    }
    return true
  }

  /**
   * Returns the last-known project directory for a session: the per-session
   * cache (resolved via `session.get`), else `process.cwd()`. Called by the
   * synchronous consumers (evaluate, continuation carry); each reads at most
   * one dispatch behind a move, which converges once the next
   * `execute.before` re-resolves.
   * @param sessionID The session whose directory is read.
   * @returns The last-known project directory.
   */
  function currentProjectDir(sessionID: string): string {
    return sessionDirs.get(sessionID) ?? process.cwd()
  }

  /**
   * Resolves the project directory for a dispatch from the host's session
   * record, caching the result per session so the sync consumers can read it.
   * A fresh `session.get` is awaited and its directory wins; on an absent API,
   * a thrown lookup, or a record with no directory candidate the resolver
   * falls back to the cache then `process.cwd()`, journaling nothing
   * (fail-open; the exact `type:"error"` counts in the open-suite must stay
   * stable). One journal exception: when the resolved directory differs from
   * this session's cached one, a `session_move` telemetry entry
   * (`reason:"re-resolved"`) is written — a move the `session_move` tool hook
   * did not witness — so an enforced project switch is never silent.
   * @param sessionID The dispatching session to resolve.
   * @returns The resolved (or fallback) project directory.
   */
  async function resolveProjectDir(sessionID: string): Promise<string> {
    const get = hostSession?.get
    if (typeof get !== "function") return currentProjectDir(sessionID)
    let rec: SessionRecord | undefined
    try {
      rec = await get({ sessionID })
    } catch {
      // lookup failure: retryable; fall back to the cache then process.cwd().
      return currentProjectDir(sessionID)
    }
    const dir = readRecordString(rec, DIRECTORY_KEYS)
    if (dir !== "") {
      const prior = sessionDirs.get(sessionID)
      if (prior !== undefined && prior !== dir) {
        toolPolicy.observeSessionMove(sessionID, dir, "re-resolved")
      }
      sessionDirs.set(sessionID, dir)
      boundSessionDirs()
      return dir
    }
    return currentProjectDir(sessionID)
  }

  /**
   * Resolves and caches the parent of a child session via the host API.
   * Parent-less records are negatively cached (a stable signal: the session
   * exists and has no parent edge); thrown lookups are retried up to
   * `maxLookupAttempts` because the record may appear later. Each failure is
   * recorded as `{ attempts, reason }`: `"not-visible"` when
   * `session.get` threw, `"no-parent-id"` when the record has no parent edge;
   * cleared on success.
   * Without a usable edge the caller falls back to keying by the session
   * itself. The parent-id read is delegated to `readRecordString`, the shared
   * candidate-extraction helper also used by `resolveProjectDir`; the
   * negative-cache and retry semantics are unchanged.
   * @param sessionID Child session ID to resolve.
   */
  async function resolveParent(sessionID: string | undefined): Promise<void> {
    if (!sessionID || ledger.childToParent.has(sessionID)) return
    const attempts = failedLookups.get(sessionID)?.attempts ?? 0
    if (attempts >= maxLookupAttempts) return
    const get = hostSession?.get
    if (typeof get !== "function") return
    try {
      const rec = await get({ sessionID })
      const parentID = readRecordString(rec, PARENT_KEYS)
      const agentName = readRecordString(rec, AGENT_KEYS)
      // Redundant emitter seed: an agent resolved from the record would make
      // streamed markers authoritative. resolveParent early-returns once the
      // edge is set (session.created seeds the edge), so this only fires when
      // the first resolve happens before the edge lands; `execute.after`
      // delivery remains the always-firing seed (see seedEmitter).
      seedEmitter(sessionID, agentName)
      if (parentID !== "") {
        ledger.setParent(sessionID, parentID, agentName)
        // Back-fill: the edge may land after the claim and its evidence were
        // recorded, so a pending unverified PASS verifies the moment it can.
        promoteOnEvidence(parentID)
        failedLookups.delete(sessionID)
      } else {
        // Record present but parent-less: negatively cached (a stable signal).
        failedLookups.set(sessionID, {
          attempts: maxLookupAttempts,
          reason: LOOKUP_REASON_NO_PARENT_ID,
        })
        boundLookups()
      }
    } catch {
      // lookup failure: retryable; fall back to keying by the session
      // itself until the record becomes visible or attempts run out
      failedLookups.set(sessionID, { attempts: attempts + 1, reason: LOOKUP_REASON_NOT_VISIBLE })
      boundLookups()
    }
  }

  /**
   * Re-evaluates evidence correlation for a parent whose pending unverified
   * PASS may now verify: peeks the parent bucket (never mints one — a fresh
   * bucket can never carry a claim, so unknown sessions stay out of the LRU)
   * and, when the bucket holds an unverified claim and the tracker still
   * correlates an in-window exit-0 hit for it, flips the gate green, clears
   * the claim, and journals the promoted gate entry plus its trace event —
   * byte-identical to the evidence-arrival promotion this helper was
   * extracted from. A parent with no admitted-prompt task-window stamp keeps
   * the unbounded join (`?? 0`), preserving today's correlation for hosts
   * that never admit a prompt (fail-open, documented). No-op otherwise;
   * never throws.
   * @param parent The parent session whose pending claim is re-evaluated.
   */
  function promoteOnEvidence(parent: string): void {
    const ps = ledger.peek(parent)
    if (ps && ps.unverifiedPass && evidence.has(parent, taskWindows.get(parent) ?? 0)) {
      ps.hasGatePass = true
      ps.unverifiedPass = ""
      journaler.journal({
        type: "gate",
        sessionID: parent,
        result: "PASS",
        event: "promoted",
        verified: true,
        mode: config.gateEvidence,
      })
      // The gate's green flip is the task's completion boundary (Phase 3):
      // the flip journals its task-complete companion row and stamps the
      // retire, so the next admitted prompt starts a fresh scope.
      markTaskComplete(parent, ps)
      journaler.traceEvent("test-runner", "gate", "GATE: PASS promoted on evidence", parent)
    }
  }

  /**
   * Builds the attribution diagnostic for a gate-unverified refusal: which
   * journaled test executions exist and why none verified the claim. A child
   * whose executions resolve to `sid` but predate its task window is
   * `attributed`; every other execution-bearing child is `unresolved` with
   * its reason ("no parent edge" when no edge is registered,
   * "edge: <parent>" when the edge resolves elsewhere); `direct` reports an
   * in-window bucket on `sid` itself (always false on a live refusal — see
   * EvidenceSearch). Pure read with respect to the evidence tracker: the
   * tracker is never mutated and nothing is journaled. `ledger.parentOf`
   * does LRU bookkeeping on the ledger's edge map (state-boundary
   * contract), so the purity claim is scoped to the tracker and gate state,
   * not the edge map's ordering.
   * @param sid The parent session the reviewer dispatch was searched for.
   * @returns The EvidenceSearch diagnostic for `sid`.
   */
  function evidenceSearch(sid: string): EvidenceSearch {
    const window = taskWindows.get(sid) ?? 0
    const attributed: string[] = []
    const unresolved: Array<{ session: string; reason: string }> = []
    let direct = false
    for (const { session, last } of evidence.snapshot()) {
      if (session === sid) {
        direct = last >= window
        continue
      }
      const parent = ledger.parentOf(session)
      if (parent === sid) {
        // In-window attributed hits were already promoted (the decision-time
        // re-check ran first), so only stale ones reach a refusal.
        if (last < window) attributed.push(session)
        continue
      }
      unresolved.push({
        session,
        reason: ledger.childToParent.has(session) ? `edge: ${parent}` : "no parent edge",
      })
    }
    return { attributed, unresolved, direct }
  }

  /**
   * Resolves the read-budget key for a whole-file read: awaits the child→parent
   * edge, then returns the parent session (or the session itself when the edge
   * is genuinely absent). Journals a bounded signal only when a lookup was
   * attempted but stayed inconclusive — a child whose record is not yet visible
   * to `session.get`. Root sessions that resolve cleanly as parent-less, and
   * children already resolved to a parent, never signal (no journal spam).
   * Observe-mode edge: when the edge is genuinely absent the caller keys the
   * suppression check on the session itself, so a suppressed read there can
   * stamp the child as an extra observed session (shifting the period boundary
   * by one per unresolved child) and carry the `would-block` entry under the
   * child key rather than a parent key. Accepted: it only happens while an
   * observe period is armed (an off phase stamps nothing) and the audit stays
   * internally consistent — the entry is keyed like the suppression that
   * produced it.
   * @param sid The reading session ID, already normalized via `asSessionID`.
   * @returns The session ID the read budget should be keyed against.
   */
  async function readBudgetKey(sid: string): Promise<string> {
    await resolveParent(sid)
    const key = ledger.parentOf(sid)
    if (key === sid) {
      // Byte-identical read: reads the attempts count off the
      // structured record; the gate (`attempts > 0 && attempts < max`) is
      // unchanged, so this signal is byte-identical to the pre-enrichment form.
      const attempts = failedLookups.get(sid)?.attempts ?? 0
      // Inconclusive window only: a lookup was tried and the record was not yet
      // visible (attempts climb 1..max-1). Zero means no host session API
      // (never knowable); at the cap means a resolved parent-less root. Bounded
      // to ≤ maxLookupAttempts-1 signals per session.
      if (attempts > 0 && attempts < maxLookupAttempts) {
        journaler.journal({
          type: "error",
          sessionID: sid,
          error: `read budget keyed by session; parent unresolved after ${attempts}/${maxLookupAttempts} lookup attempt(s)`,
        })
      }
    }
    return key
  }

  /**
   * Runs the whole-file read horizon for a session with observe-mode
   * suppression: the guard evaluation is unchanged (the same
   * check-then-increment), and when a deliberate block fires during an
   * observe period the `would-block` audit entry is journaled and the read
   * proceeds instead of the block throwing. A non-BlockError failure
   * propagates to the fail-open handler (only deliberate blocks are
   * suppressible).
   * Deliberate asymmetry with the dispatch path: the read guard journals its
   * own `blocked`/`read-limit` line before throwing (that stamping stays
   * byte-identical for enforce users, so the suppression cannot remove it),
   * whereas a suppressed dispatch journals no `blocked` stamp at all (its
   * catch branch skips it). A suppressed read therefore co-journals both that
   * `blocked` line and the `would-block` audit entry; the dispatch path
   * journals the `would-block` entry alone. The same suppression applies
   * when a user-typed gate suspension is active (keyed on the same budget
   * key): the `suspended` audit flavor is journaled and the read proceeds.
   * @param key The session ID the read budget is keyed against (the parent,
   *     or the session itself when the edge is genuinely absent).
   * @throws The deliberate read-budget block error when the block is not
   *     suppressed.
   */
  function handleReadBudget(key: string): void {
    try {
      gates.guardReadLimit(key, ledger)
    } catch (e) {
      if (e instanceof BlockError && observeActive(key)) {
        const totals = ledger.noteWouldBlock(key)
        journaler.journal(wouldBlockEntry(key, "read-budget", totals.observed, totals.wouldBlocks))
        return
      }
      if (e instanceof BlockError && suspendSuppressionActive(key)) {
        journalSuspendedWouldBlock(key, "read-budget")
        return
      }
      throw e
    }
  }

  /**
   * Returns the last verdict match in `text` for `re` (last-match-wins, the
   * same rule `parseGateMarkers` uses); "" when there is no match. Independent
   * of `String.match`'s global-regex lastIndex state because `.match` resets it.
   * @param text The text to scan.
   * @param re The compiled verdict regex.
   * @returns The last match text, or "" when `text` has no verdict match.
   */
  function lastMatch(text: string, re: RegExp): string {
    return text.match(re)?.at(-1) ?? ""
  }

  /**
   * Stamps a plan-reviewer verdict's approval against the current plans-dir
   * signature so a later re-plan is detectable at dispatch time. An APPROVE
   * against an unreadable dir stamps "" (unknown): the approval is accepted
   * once and stamped on the next enforcing dispatch (fail-open). An APPROVE
   * also binds the plan identity from the dispatch prompt's candidates: a
   * unique existing mention sets `approvedPlan`/`approvedPlanKey` (per-plan
   * staleness); an absent, ambiguous, or unreadable binding leaves the
   * approval unbound (the dir-signature rule applies). A BLOCK clears the
   * stamp and the identity (hygiene). Mutates `s` in place.
   * @param s The session's gate state (mutated).
   * @param result The verdict result ("APPROVE" or "BLOCK").
   * @param projectDir The current project directory (for the plans-dir scan).
   * @param candidates The plan names extracted from the dispatch prompt
   *     (the round's binding candidates).
   */
  function stampPlanApproval(
    s: GateState,
    result: string,
    projectDir: string,
    candidates: string[],
  ): void {
    if (result === "APPROVE") {
      s.plansSignature = gates.plansSignature(projectDir) ?? ""
      const b = gates.planApprovalBinding(projectDir, candidates)
      s.approvedPlan = b?.name ?? ""
      s.approvedPlanKey = b?.key ?? ""
    } else {
      s.plansSignature = ""
      s.approvedPlan = ""
      s.approvedPlanKey = ""
    }
  }

  /**
   * The optional identity/stamp fields a plan APPROVE journals so replay can
   * re-validate it: a bound approval carries its plan name + content key; a
   * stamped approval carries the path-free plans-dir signature. An unbound or
   * unstampable approval journals neither field, so legacy-shaped lines are
   * unchanged. Pure read of `s`.
   * @param s The session's gate state (already stamped by stampPlanApproval).
   * @returns The spreadable fields to append to a `type:"plan"` APPROVE entry.
   */
  function planApprovalStampFields(s: GateState): {
    plan?: string
    planKey?: string
    plansSig?: string
  } {
    return {
      ...(s.approvedPlan !== "" ? { plan: s.approvedPlan, planKey: s.approvedPlanKey } : {}),
      ...(s.plansSignature !== "" ? { plansSig: s.plansSignature } : {}),
    }
  }

  /**
   * The shared tail of the two plan-approval credit sites: records the bound
   * plan identity (name + content key) durably under the project, outside the
   * session bucket and the journal replay window, so the approval survives
   * replay aging, a restart, and a task-scope reset. An unbound approval
   * records nothing — a human prompt approval binds no plan identity, and a
   * reviewer approval whose dispatch named no resolvable plan stays
   * session-scoped. The ledger sanitizes its arguments and fails open, so
   * this never throws.
   * @param s The session's gate state (stamped by stampPlanApproval).
   * @param projectDir The project directory the approval is recorded under.
   */
  function recordDurablePlanApproval(s: GateState, projectDir: string): void {
    if (s.approvedPlan === "") return
    ledger.recordPlanApprovalDurable(s.approvedPlan, s.approvedPlanKey, projectDir)
  }

  /**
   * Splits a self-keyed delivery's attributable children into the
   * registered-edge scan (`edge`, today's scan) and every child with a stored
   * verdict that is not the delivery session itself (`unresolved`). `edge`
   * keeps its LRU promotion; `unresolved` is a pure snapshot that feeds the
   * plausibility join in plausibleUnresolved.
   * @param sid The delivery's parent id (=== child in the self-keyed branch).
   * @returns Registered candidates and verdict-bearing children (minus sid).
   */
  function discoverCandidates(sid: string): {
    edge: string[]
    unresolved: Array<{ child: string; verdict: ChildVerdict }>
  } {
    const edge: string[] = []
    for (const c of ledger.childToParent.keys()) {
      if (ledger.childToParent.get(c) === sid && ledger.childVerdict(c).marker !== "") edge.push(c)
    }
    return {
      edge,
      unresolved: ledger.evidencedChildren().filter(({ child }) => child !== sid),
    }
  }

  /**
   * Unresolved children plausibly this parent's next task: a plan-reviewer
   * dispatch is recorded for `sid` AND the verdict was recorded at-or-after it
   * (inclusive, tolerating same-millisecond ties) AND no OTHER parent
   * dispatched at-or-before that verdict (unique-owner rule; a verdict with two
   * candidate parents is ambiguous and excluded → fail-open). Pure read.
   * @param sid The delivery's parent id.
   * @param unresolved The `{ child, verdict }` candidates from discoverCandidates.
   * @returns The child ids plausibly belonging to `sid`.
   */
  function plausibleUnresolved(
    sid: string,
    unresolved: Array<{ child: string; verdict: ChildVerdict }>,
  ): string[] {
    const dispatchTs = planReviewerDispatch.get(sid)
    if (dispatchTs === undefined) return []
    const out: string[] = []
    for (const { child, verdict } of unresolved) {
      if (verdict.recordedAt < dispatchTs) continue
      // Unique-owner: another parent dispatched at-or-before this verdict's
      // recordedAt ⇒ ambiguous ⇒ excluded (never-guess).
      let ambiguous = false
      for (const [other, ts] of planReviewerDispatch) {
        if (other === sid) continue
        if (ts <= verdict.recordedAt) {
          ambiguous = true
          break
        }
      }
      if (!ambiguous) out.push(child)
    }
    return out
  }

  /**
   * The most-recently-recorded child among the given ids, by stored
   * `recordedAt` (ties keep insertion order); undefined when none. Pure read.
   * @param children The candidate child ids (from the plausible list).
   * @returns The most recently recorded child id, or undefined.
   */
  function mostRecentUnresolved(children: string[]): string | undefined {
    let best: string | undefined
    let bestAt = -1
    for (const c of children) {
      const at = ledger.childVerdict(c).recordedAt
      if (at > bestAt) {
        bestAt = at
        best = c
      }
    }
    return best
  }

  /**
   * Parent-lookup diagnostic for the delivery child, its parent (sid, when
   * distinct), and each unresolved candidate: `{ attempts, reason }` — the
   * current parent-lookup attempt count and why it stayed unresolved
   * (`"not-visible"` / `"no-parent-id"`, or `"resolved-or-never-tried"` when
   * clean). Distinct sessions are kept in the entry so the field can tell the
   * three root-cause hypotheses apart. Pure read; clears nothing.
   * @param child The delivery's session id.
   * @param unresolved The unresolved candidate child ids.
   * @returns A per-session `{ attempts, reason }` map.
   */
  function lookupDiag(
    child: string,
    unresolved: string[],
  ): Record<string, { attempts: number; reason: string }> {
    const out: Record<string, { attempts: number; reason: string }> = {}
    for (const s of [child, ...unresolved])
      out[s] = {
        attempts: failedLookups.get(s)?.attempts ?? 0,
        reason: failedLookups.get(s)?.reason ?? "resolved-or-never-tried",
      }
    return out
  }

  /**
   * Journals a policy-injection outcome for a session: `{ type: "policy",
   * sessionID, injected }` plus any extra fields. One source for the shared
   * entry shape so the skip/success/failure call sites stay under the
   * function-size ceiling instead of repeating the literals inline.
   * @param sessionID The session the entry names: the child on a name-skip,
   *     the resolved parent on success or failure.
   * @param injected Whether the policy landed (`true`) or was rejected
   *     (`false`).
   * @param extra Additional entry fields, or an empty object when none.
   */
  function journalPolicy(
    sessionID: string,
    injected: boolean,
    extra: Record<string, unknown> = {},
  ): void {
    journaler.journal({ type: "policy", sessionID, injected, ...extra })
  }

  /**
   * Whether the conservative `event.agent` name guard must skip injection:
   * only when the child→parent edge is unresolvable AND the delivery carries
   * a config-known subagent name. The registered-edge case returns first (it
   * always injects), so the name guard never contradicts a resolved edge;
   * the skip is journaled so the decision stays observable.
   * @param event The execute.after payload.
   * @param child The delivery's session ID.
   * @returns True when the delivery is skipped without injecting.
   */
  function nameGuardSkips(event: ToolHookEvent, child: string): boolean {
    if (ledger.childToParent.has(child)) return false
    const knownName = typeof event.agent === "string" && subagentNames.has(event.agent)
    if (knownName) journalPolicy(child, false, { skipped: true, reason: "agent-name" })
    return knownName
  }

  /**
   * Prepends the orchestrator policy to the first parent-side
   * `task`/`subagent` result delivery per task, so the model always carries
   * the pipeline contract. Attribution is edge-first: the child→parent edge
   * (`ledger.childToParent`, seeded by `session.created` and back-filled via
   * `session.get` in `resolveParent`) decides where the policy lands, so
   * both host delivery shapes — the v1 string shape (child-keyed event,
   * text in `result.output`) and the v2 structured shape (parent-keyed
   * event, child on `metadata.sessionID`, canonical text in
   * `output.output`, string or block-array `content`) — inject when the
   * edge resolves; the once-flag and the `injected:true`
   * journal entry key on the resolved parent (identical to the raw child
   * for the self-keyed shape). The `event.agent` name guard is a
   * conservative fallback that fires ONLY for non-structured deliveries
   * when the edge is unresolvable (no `session.created` record AND no
   * `session.get` record) and the delivery carries a config-known subagent
   * name: refusing there is the safe choice, and the skip is journaled
   * (`skipped:true`, `reason:"agent-name"`) so the decision is observable.
   * Structured deliveries skip the guard by construction: the host builds
   * that result on the parent's own tool call, so it is always the
   * parent-facing channel and `event.agent` there is the parent's agent
   * name — consulting it risks a bogus skip for a parent running under a
   * config-known name. The one residual corner that still injects without
   * an edge is a config-UNKNOWN agent name on a host without a session API:
   * with no edge and no name signal there is no way to tell a parent-facing
   * delivery from a child-own session one, so the self-keyed injection
   * there is a documented, accepted residual (the handler fires only on
   * `task`/`subagent` tool results, so child streaming text never reaches
   * it). Every non-injection is journaled except one documented silent
   * case: an absent result (nothing to deliver). A present-but-unclassifiable
   * result journals loudly (`reason:"unknown-shape"` with a safe shape
   * descriptor) on EVERY such delivery — the once-flag no longer gates that
   * journal, so a repeated unclassifiable delivery journals again. When the
   * delivery classifies (string or structured), the per-delivery PIPELINE:
   * status tail is appended for a pipeline stage (independent of the
   * once-flag), and the policy head is prepended once per task; the tail and
   * the head are independent fail-open paths — a tail failure journals a
   * `pipeline-status:` error and the head still lands, and a head failure
   * journals `injected:false` and the tail still landed.
   * @param event The execute.after payload whose result is mutated.
   * @param child The delivery's child session ID (classified, per shape).
   * @param delivery The classified delivery (see `classifyDelivery`).
   * @param agent The resolved agent name (the just-completed pipeline stage).
   */
  async function injectOrchestratorPolicy(
    event: ToolHookEvent,
    child: string,
    delivery: Delivery,
    agent: string,
  ): Promise<void> {
    // Close the late-edge window for background dispatches before deciding:
    // idempotent (early-returns on a registered edge) and bounded by the
    // failedLookups retry cap, so the await is cheap on the common path.
    await resolveParent(child)
    const parent = ledger.parentOf(child)
    // Name guard first: a child-facing delivery the guard skips (unresolvable
    // edge + config-known subagent name) returns here and never receives the
    // parent-addressed nudge text below.
    if (delivery.kind !== "structured" && nameGuardSkips(event, child)) return
    // Advisory intent nudge: independent of the policy head, delivered on the
    // first classified parent-facing delivery after admission.
    prependIntentNudge(event, parent, delivery)
    applyPolicyResult(parent, event, delivery, agent)
  }

  /**
   * Appends the per-delivery pipeline status tail to a classified delivery's
   * model-visible text: runs on EVERY delivery for a pipeline stage, so a
   * follow-up delivery still names the next stage even after the policy head
   * already landed. The line is a pure read of the resolved parent's gate
   * state via `formatPipelineStatus` (never throws and never journals by
   * itself); a non-pipeline agent renders "" and the append is a no-op,
   * leaving such deliveries byte-identical. Fail-open: a throwing mutation
   * journals `{type:"error", error:"pipeline-status: …"}` and never rethrows,
   * so the independent policy-prepend path below still runs.
   * @param parent The resolved parent session for the delivery.
   * @param event The execute.after payload whose result is mutated.
   * @param delivery The classified delivery (string or structured only).
   * @param agent The resolved agent name (the just-completed pipeline stage).
   */
  function appendPipelineStatus(
    parent: string,
    event: ToolHookEvent,
    delivery: Extract<Delivery, { kind: "string" | "structured" }>,
    agent: string,
  ): void {
    const line = formatPipelineStatus(ledger.state(parent), config.agents, agent)
    if (line === "") return
    try {
      mutateDeliveryText(event, delivery, (text) => text + "\n" + line, "append")
    } catch (e) {
      journaler.journal({ type: "error", error: `pipeline-status: ${e}` })
    }
  }

  /**
   * Prepends the orchestrator policy head to a classified delivery's
   * model-visible text once per task: the silent per-task once-flag path.
   * Fail-open: a throwing mutation journals `{type:"policy", injected:false}`
   * and never rethrows.
   * @param parent The resolved parent session for the delivery.
   * @param event The execute.after payload whose result is mutated.
   * @param delivery The classified delivery (string or structured only).
   */
  function prependPolicy(
    parent: string,
    event: ToolHookEvent,
    delivery: Extract<Delivery, { kind: "string" | "structured" }>,
  ): void {
    const policyState = ledger.state(parent)
    if (policyState.policyInjected) return
    try {
      prependDeliveryText(event, delivery, policyText)
      policyState.policyInjected = true
      journalPolicy(parent, true)
    } catch (e) {
      journalPolicy(parent, false, { error: String(e) })
    }
  }

  /**
   * Applies the injection once the name guard passes. Dispatch table: an
   * absent result (silent), a present-but-unclassifiable result (journaled
   * loudly as `reason:"unknown-shape"` with the shape descriptor on EVERY such
   * delivery — the once-flag no longer gates it), then the per-delivery
   * status tail (every pipeline-stage delivery, independent of the once-flag),
   * then the once-per-task policy head. The two text mutations are independent
   * fail-open paths: a tail failure journals a `pipeline-status:` error and the
   * head still lands, and vice versa.
   * @param parent The resolved parent session for the delivery.
   * @param event The execute.after payload whose result is mutated.
   * @param delivery The classified delivery (see `classifyDelivery`).
   * @param agent The resolved agent name (the just-completed pipeline stage).
   */
  function applyPolicyResult(
    parent: string,
    event: ToolHookEvent,
    delivery: Delivery,
    agent: string,
  ): void {
    if (delivery.kind === "absent") return
    if (delivery.kind === "unknown") {
      journalPolicy(parent, false, { reason: "unknown-shape", shape: delivery.shape })
      return
    }
    appendPipelineStatus(parent, event, delivery, agent)
    prependPolicy(parent, event, delivery)
  }

  /**
   * Classifies an admitted parent prompt for implementation intent and arms
   * the advisory pipeline-entry nudge. Runs only when the intent-nudge key is
   * enabled (disabled = full no-op: no journal, no nudge); every detection is
   * journaled `{type:"intent", sessionID, kind}`, but the nudge arms only
   * when the parent has no plan approval (the active-plan proxy — a parent
   * already working under an approved plan needs no pipeline-entry reminder)
   * and only once per detected intent signal (the dedupe latch survives
   * task-scope resets; a plan approval or a task retire clears it). Fail-open:
   * the classification
   * step is wrapped, so a throw anywhere in it journals an `error` row and
   * never propagates from the prompt path.
   * @param sessionID The admitted parent session.
   * @param properties The prompt payload to classify.
   */
  function handlePromptIntent(sessionID: string, properties: PromptHookProperties): void {
    if (!config.intentNudge) return
    try {
      const kind = classifyIntent(promptTextOf(properties))
      if (kind === null) return
      if (ledger.state(sessionID).hasPlanVerdict) return
      journaler.journal({ type: "intent", sessionID, kind })
      const key = `${sessionID}:${kind}`
      if (intentNudgedKinds.has(key)) return
      intentNudgedKinds.add(key)
      intentNudgePending.set(sessionID, kind)
      boundIntentNudges()
    } catch (e) {
      journaler.journal({ type: "error", sessionID, error: `intent classification: ${e}` })
    }
  }

  /**
   * Delivers a pending intent nudge on a classified task/subagent delivery:
   * consumes the parent's pending nudge (one-shot) and prepends the advisory
   * text ahead of the delivery text. Deliveries that cannot carry text
   * (absent/unclassifiable) keep the nudge pending for a later delivery.
   * Fail-open: a throwing mutation journals `type:"error"` and never blocks.
   * @param event The execute.after payload whose result is mutated.
   * @param parent The resolved parent session for the delivery.
   * @param delivery The classified delivery (see `classifyDelivery`).
   */
  function prependIntentNudge(event: ToolHookEvent, parent: string, delivery: Delivery): void {
    if (delivery.kind !== "string" && delivery.kind !== "structured") return
    const kind = intentNudgePending.get(parent)
    if (kind === undefined) return
    intentNudgePending.delete(parent)
    try {
      prependDeliveryText(event, delivery, intentNudge(kind))
    } catch (e) {
      journaler.journal({ type: "error", sessionID: parent, error: `intent nudge: ${e}` })
    }
  }

  /**
   * Delivers a pending intent nudge on a parent-keyed read delivery: the
   * parent's own read results are the exploration-phase channel the nudge
   * rides. A child-keyed read (the event session differs from the resolved
   * parent) is left untouched — the nudge is addressed to the parent. A
   * non-string output keeps the nudge pending for a later delivery.
   * Fail-open: a throwing mutation journals `type:"error"` and never blocks.
   * @param event The execute.after payload whose result is mutated.
   */
  function prependIntentNudgeRead(event: ToolHookEvent): void {
    const raw = asSessionID(event?.sessionID)
    const parent = ledger.parentOf(raw)
    if (parent !== raw) return
    const kind = intentNudgePending.get(parent)
    if (kind === undefined) return
    if (!event?.result || typeof event.result.output !== "string") return
    intentNudgePending.delete(parent)
    try {
      event.result.output = `${intentNudge(kind)}\n${event.result.output}`
    } catch (e) {
      journaler.journal({ type: "error", sessionID: parent, error: `intent nudge: ${e}` })
    }
  }

  /**
   * Reviewer-APPROVE credit (landing-gate release signal): sets the child's
   * parent-bucket `hasReviewApprove` when the delivery's first-sight marker
   * events carry a reviewer `VERDICT: APPROVE` and the parent's review
   * ensemble is complete. The credit fires only on a first-sight APPROVE
   * event surfaced by task-result parsing (streaming never credits: a
   * denied or unseeded observation is suppressed and never returned), and
   * it lands on the parent bucket via `ledger.parentOf(child)` — the caller
   * awaits the child→parent edge for deliveries whose dispatch input names
   * no agent, so a background dispatch credits the parent, not the
   * unregistered child. An incomplete ensemble journals the refusal (and a
   * `refusedApprove:true` stamp) through `reviewEnsembleComplete` and leaves
   * the gate red. Never throws.
   * @param child The raw child session ID that delivered the verdict.
   * @param markerEvents The first-sight authoritative marker events parsed
   *     from the delivery text (suppressed events are already journaled and
   *     excluded).
   */
  function creditReviewApproval(child: string, markerEvents: MarkerEvent[]): void {
    if (!markerEvents.some((e) => e.kind === "verdict" && e.marker.includes("APPROVE"))) return
    const parent = ledger.parentOf(child)
    if (!gates.reviewEnsembleComplete(parent, ledger)) return
    ledger.state(parent).hasReviewApprove = true
    // Credit the bucket-free trace too: the flag above dies on the landing
    // prompt's reset, but the journaled APPROVE outlives it — the trace is
    // what the landing gate reads to escalate the first push instead of
    // throwing the misleading `no-landing-approval` block.
    ledger.markCreditedApproval(parent)
  }

  /** The discovery snapshot for a self-keyed plan-verdict delivery. */
  type AttributedChildDiscovery = {
    edgeCount: number
    unresolvedCount: number
    plausibleCount: number
    unresolvedIDs: string[]
    attributed: string | undefined
    decision: "attributed" | "fail-open"
    poolSize: number
  }

  /**
   * Edge-resolved arm of the plan-verdict attribution: the delivery's own
   * session is a registered edge child, so attribute the verdict through the
   * child directly (delivery-wins merge: the delivery's own marker wins only
   * when the output itself carries a marker). The `source` names the winning
   * pipeline; `raw` is the child itself.
   * @param sid The parent session the `plan` entry is keyed on.
   * @param child The raw child session ID (a registered edge child).
   * @param own The delivery's own last verdict marker, or "" when marker-less.
   */
  async function attributeEdgeVerdict(sid: string, child: string, own: string): Promise<void> {
    const rec = ledger.childVerdict(child)
    const marker = own || rec.marker
    const markerSource = own ? "task-result" : rec.source || "task-result"
    const result = marker.includes("APPROVE") ? "APPROVE" : "BLOCK"
    await journalPlanApproval(
      sid,
      child,
      result,
      marker || "<none>",
      markerSource,
      marker || "<no verdict marker>",
    )
  }

  /**
   * Candidate discovery for a self-keyed plan-verdict delivery: discovers
   * attributable children from registered edges AND from unresolved children
   * whose streamed verdict plausibly belongs to this parent, and attributes
   * through the unique unanimous pool (`raw` = first edge child, else
   * most-recently-recorded unresolved child).
   *
   * The registered-edge scan is round-scoped to the parent's most-recent
   * plan-reviewer dispatch (exactly as the unresolved scan is): an
   * earlier-round BLOCK stored on an edge child left behind by a prior review
   * round is superseded by this round's verdict, so a re-issued APPROVE is
   * credited. When no dispatch is recorded the scan stays structural (a lone
   * edge child still attributes, unchanged).
   *
   * Attribute only on a non-empty unanimous pool: a lone-edge-candidate
   * attribution (edge-only) is unchanged; a plausible streamed APPROVE either
   * becomes the sole candidate (approved) or contradicts a BLOCK pool
   * (fail-open) — so a self-keyed BLOCK is unreachable while such evidence
   * exists. Zero candidates, or more than one (a contradiction within this
   * same round), attributes nothing: a marker-less, unattributable
   * parent-keyed delivery can never clobber a live approval with a BLOCK
   * (structural fail-open).
   *
   * Pure read: journals nothing, mutates nothing.
   * @param sid The delivery's parent id.
   * @returns The discovery snapshot: forensic candidate counts and
   *     unresolved ids, the attributed child (if any), the pool size (for the
   *     fail-open error), and the decision label for the forensic attribution
   *     entry.
   */
  function selectAttributedChild(sid: string): AttributedChildDiscovery {
    const { edge, unresolved } = discoverCandidates(sid)
    const unresolvedIDs = unresolved.map(({ child: cid }) => cid)
    const plausible = plausibleUnresolved(sid, unresolved)
    const dispatchTs = planReviewerDispatch.get(sid)
    const edgeCandidates =
      dispatchTs === undefined
        ? edge
        : edge.filter((c) => ledger.childVerdict(c).recordedAt >= dispatchTs)
    const pool = [...edgeCandidates, ...plausible]
    const verdictOf = (c: string): "APPROVE" | "BLOCK" =>
      ledger.childVerdict(c).marker.includes("APPROVE") ? "APPROVE" : "BLOCK"
    const unanimous = new Set(pool.map(verdictOf))
    const attributed =
      pool.length > 0 && unanimous.size === 1
        ? (edgeCandidates[0] ?? mostRecentUnresolved(plausible))
        : undefined
    const decision = attributed ? "attributed" : "fail-open"
    return {
      edgeCount: edgeCandidates.length,
      unresolvedCount: unresolved.length,
      plausibleCount: plausible.length,
      unresolvedIDs,
      attributed,
      decision,
      poolSize: pool.length,
    }
  }

  /**
   * Builds the replay-inert forensic `type:"attribution"` entry for a
   * self-keyed delivery: the decision label, the parent/self delivery flag,
   * the session-API availability, the candidate counts, the unresolved child
   * ids, and the per-session lookup diagnostics. The wording deliberately
   * avoids "unattributable" so the /unattributable/ error count stays exactly
   * one (only the fail-open gate error uses it).
   * @param sid The delivery's parent id.
   * @param child The delivery's raw session id.
   * @param d The discovery snapshot from selectAttributedChild.
   * @returns The entry object for the caller to journal before any gate
   *     mutation.
   */
  function attributionEntry(
    sid: string,
    child: string,
    d: AttributedChildDiscovery,
  ): Record<string, unknown> {
    return {
      type: "attribution",
      sessionID: sid,
      raw: child,
      decision: d.decision,
      deliveryIsParent: child === sid,
      sessionApi: typeof hostSession?.get === "function",
      candidates: {
        edge: d.edgeCount,
        unresolved: d.unresolvedCount,
        plausible: d.plausibleCount,
      },
      unresolvedIDs: d.unresolvedIDs,
      lookup: lookupDiag(child, d.unresolvedIDs),
    }
  }

  /**
   * The shared journal+trace pair for the two attributed arms of
   * `attributePlanVerdict`: stamps the plan approval against the current
   * plans dir (so replay re-validates it), sets the parent's plan-verdict
   * flag, journals the `plan` entry keyed on the parent with `raw` = the
   * attributed child, and traces the verdict. The stamp runs before the
   * journal so the journaled line already carries the dir signature. (The
   * human-prompt approval journal keeps its own position in prompt admission
   * and does not route through this helper.)
   * @param sid The parent session the `plan` entry is keyed on.
   * @param raw The attributed child session ID for the entry's `raw` field.
   * @param result The verdict result ("APPROVE" or "BLOCK").
   * @param journalMarker The marker text to journal (each arm applies its own
   *     "<none>" fallback; the attributed arm's marker is always non-empty).
   * @param source The provenance label for the winning pipeline.
   * @param traceMarker The marker text for the trace event (each arm applies
   *     its own "<no verdict marker>" fallback).
   */
  async function journalPlanApproval(
    sid: string,
    raw: string,
    result: "APPROVE" | "BLOCK",
    journalMarker: string,
    source: string,
    traceMarker: string,
  ): Promise<void> {
    const candidates = planReviewTarget.get(sid) ?? []
    const s = ledger.state(sid)
    s.hasPlanVerdict = result === "APPROVE"
    const projectDir = await resolveProjectDir(sid)
    // APPROVE applies the reset-at-capture scope rule (a binding different
    // from the bucket's activePlan rebuilds the task scope before the new
    // identity is used); BLOCK only stamps the hygiene clear.
    const approved =
      result === "APPROVE" ? applyApprovalBinding(sid, projectDir, candidates, false) : s
    if (result === "BLOCK") stampPlanApproval(s, result, projectDir, candidates)
    journaler.journal({
      type: "plan",
      sessionID: sid,
      raw,
      result,
      marker: journalMarker,
      source,
      // Bound identity (so replay restores it) and the stamped dir signature
      // (so replay re-validates against the current plans dir); an unbound or
      // unstampable approval spreads nothing (legacy lines unchanged).
      ...planApprovalStampFields(approved),
    })
    journaler.traceEvent("plan-reviewer", "verdict", traceMarker, sid)
    if (result === "APPROVE") {
      // The attributed task has its plan: clear the intent-nudge latch exactly
      // like the human-marker approval arm, so a later task's detected intents
      // can nudge again.
      clearIntentNudge(sid)
    }
    recordDurablePlanApproval(approved, projectDir)
  }

  /**
   * The fail-open tail of a self-keyed plan-verdict delivery: journals the
   * single `plan attribution:` error and leaves the gate untouched — never a
   * BLOCK, never a parent-keyed plan entry, never a clobber of a live
   * approval (the attribution entry carries the diagnostics). A
   * one-candidate pool always attributes, so this error only fires with zero
   * or multiple candidates — plural noun always correct.
   * @param sid The parent session the error is keyed on.
   * @param poolSize The number of evidenced candidates the discovery snapshot
   *     counted.
   */
  function noteUnattributable(sid: string, poolSize: number): void {
    journaler.journal({
      type: "error",
      sessionID: sid,
      error: `plan attribution: unattributable parent-keyed delivery; gate unchanged (${poolSize} evidenced candidates)`,
    })
  }

  /**
   * Attributes a plan-reviewer result to the parent's plan-approval gate,
   * ensuring the journaled `plan` entry's `raw` is always an actual child
   * session ID (never the parent `sessionID`):
   *
   * - Edge-resolved (`childToParent.has(child)`): the delivery's own verdict
   *   wins over any stored child-text observation (delivery-wins only when the
   *   output itself carries a marker); the `source` names the winning pipeline.
   *   `raw = child`.
   * - Self-keyed (`parentOf(child) === child`, e.g. a host re-fire reporting
   *   the parent's own session ID): never reads `childVerdict(child)` (that is
   *   the parent's own quoted text, not a child's evidence). It journals a
   *   forensic `type:"attribution"` entry first (before any mutation,
   *   replay-inert, never containing the word "unattributable" so the
   *   /unattributable/ error count stays exactly one), then attributes
   *   through the unique unanimous pool discovered by
   *   `selectAttributedChild` (`raw` = first edge child, else
   *   most-recently-recorded unresolved child); zero or contradictory
   *   candidates journal the fail-open error and mutate nothing.
   *
   * An APPROVE also binds the plan identity from the round's dispatch-prompt
   * candidates (`planReviewTarget`): a unique existing plan mention journals
   * `plan`/`planKey` on the `plan` entry (restored by journal replay); an
   * unbound approval journals neither field (legacy lines unchanged).
   *
   * Never throws (fail-open).
   * @param child The raw child session ID, for the `plan` entry's `raw` field.
   * @param output The delivery's own result text.
   */
  async function attributePlanVerdict(child: string, output: string): Promise<void> {
    const sid = ledger.parentOf(child)
    const own = lastMatch(output, verdictRe)
    // Edge-resolved: attribute through the child directly, delivery-wins merge.
    if (ledger.childToParent.has(child)) {
      await attributeEdgeVerdict(sid, child, own)
      return
    }
    // Self-keyed: the delivery's own session id is not a registered child.
    const d = selectAttributedChild(sid)
    // Journal the forensic entry first (before any gate mutation). A new journal
    // type is replay-inert; its wording avoids "unattributable" so the
    // single-error count is stable.
    journaler.journal(attributionEntry(sid, child, d))
    if (d.attributed) {
      const rec = ledger.childVerdict(d.attributed)
      // Attributed candidates are evidenced (a non-empty stored marker and a
      // non-empty source label), so marker needs no "<none>" fallback here —
      // the edge-resolved branch above keeps its fallback for marker-less
      // deliveries.
      const marker = own || rec.marker
      const markerSource = own ? "task-result" : rec.source
      const result = marker.includes("APPROVE") ? "APPROVE" : "BLOCK"
      await journalPlanApproval(sid, d.attributed, result, marker, markerSource, marker)
      return
    }
    noteUnattributable(sid, d.poolSize)
  }

  /**
   * Prologue for a `task`/`subagent` dispatch: resolves the agent name and the
   * dispatching session, pins the session against LRU eviction, ages out the
   * previous task's streamed delta windows, extracts the trace-gated
   * description, records plan-reviewer round bookkeeping, and journals the
   * empty-agent misconfiguration signal — then defers the guard-and-journal
   * section to guardedTaskDispatch.
   * @param event The execute.before tool event (task/subagent shape).
   */
  async function handleTaskDispatch(event: ToolHookEvent): Promise<void> {
    // Dispatch-input-first resolution is safe here: `event.input` IS the
    // dispatch input (execute.before, no structured result echo exists),
    // so the `event.agent` fallback cannot shadow a child name the way it
    // can on delivery payloads (see agentFromDeliveryEvent).
    const agent = agentFromDispatchEvent(event)
    const sessionID = asSessionID(event?.sessionID)
    // Sessions dispatching guarded subagents are parents by
    // definition: mark before the guards so their
    // state() inserts land pinned against LRU eviction.
    ledger.markParent(sessionID)
    // Age out streamed delta windows: the next dispatch is the task
    // boundary, so stale fragments of the previous task's child text
    // must not leak into the new scope (mirrors the prompt-reset
    // pattern of evidence.clear).
    deltaWindows.clear()
    const prompt = String(event.input?.prompt ?? "")
    // Prompt descriptions can carry sensitive context; record them
    // only when the trace is enabled (redacted elsewhere — here it is
    // the single copy passed to the dispatch-recording helper).
    const description = config.trace ? String(event.input?.description ?? "").slice(0, 200) : ""

    // Last-wins: record this parent's LATEST plan-reviewer
    // dispatch time for the plausibility join, and the prompt's plan
    // mentions as the round's approval-binding candidates. A prompt
    // reset clears both (see the prompt hook), so a verdict is only
    // plausible — and only bindable — within the parent's current
    // task scope. Bounded by boundDispatches / boundTargets.
    if (agent === config.agents.planReviewer) {
      planReviewerDispatch.set(sessionID, Date.now())
      boundDispatches()
      planReviewTarget.set(sessionID, gates.promptPlanNames(prompt))
      boundTargets()
    }

    // An empty agent name is the only reliable misconfiguration
    // signal: the host input shape no longer uses
    // subagent_type/agent/subagent, so every gate condition misses.
    // Telemetry only — journaling cannot throw.
    if (!agent)
      journaler.journal({
        type: "error",
        sessionID,
        error:
          "task dispatch: could not resolve the agent name; does the host input shape still use subagent_type/agent/subagent?",
      })

    return guardedTaskDispatch(sessionID, agent, prompt, description)
  }

  /**
   * The single admitted-dispatch exit: advance the loop counters (the
   * check half ran at guard entry; a refusal never reaches this line, so
   * blocked attempts draw down nothing), then journal the dispatch at
   * guard exit. Both halves stay paired here so the metering can never
   * run without its journal entry nor the other way around. The waiver
   * verdict is threaded in from the budget guard's admission-time
   * snapshot — the commit never re-reads the waiver, because a later
   * guard (the reviewer gate) may have consumed it in between.
   * @param sessionID The dispatching session ID.
   * @param agent The resolved agent name.
   * @param description The trace-gated dispatch description.
   * @param waived The budget guard's admission-time waiver-exemption
   *     verdict (true exempts the dispatch from the counters).
   */
  function allowDispatch(
    sessionID: string,
    agent: string,
    description: string,
    waived: boolean,
  ): void {
    gates.countDispatch(sessionID, ledger, agent, waived)
    recordDispatch(sessionID, agent, description, false)
  }

  /**
   * Consumes the executor's plan-gate once-grant when one is pending and this
   * is an executor dispatch, and reports whether the dispatch is thereby
   * admitted.
   *
   * A once-granted human approval (from a `permission.replied` reply) grants
   * exactly ONE EXECUTOR dispatch past the plan gate and is cleared
   * immediately, so a stale grant cannot outlive the single dispatch it was
   * given for, short-circuiting the plan-gate enforcement in
   * `enforceExecutorGates`. Scoped to the executor dispatch class: the grant
   * exists solely to release the plan-gate block, so any other agent
   * (reviewer, plan-reviewer, …) leaves it pending and still runs its own
   * guards (guardReviewerDispatch / …). execute.before consults only
   * hasPlanVerdict / pendingOnceGrant — never humanApproval, which is
   * provenance only.
   * @param sessionID The dispatching session ID.
   * @param agent The resolved agent name.
   * @returns True when the once-grant was consumed (the dispatch is admitted
   *     by it).
   */
  function consumePlanGrant(sessionID: string, agent: string): boolean {
    if (agent === config.agents.executor && ledger.state(sessionID).pendingOnceGrant.plan !== "") {
      // Consume the plan-gate once grant (a `permission.replied`
      // `once`): clears just `.plan` so a landing `.landing` grant,
      // if any, survives for the push it was given for.
      ledger.state(sessionID).pendingOnceGrant.plan = ""
      return true
    }
    return false
  }

  /**
   * Decision-time re-check for a reviewer dispatch: edges may have resolved
   * since the last promotion opportunity (a session.get lookup, a stream
   * event); re-runs the correlation against the fully resolved ledger at the
   * exact moment of enforcement, then lets the guard name what it searched
   * when it refuses.
   * @param sessionID The dispatching session ID.
   */
  function reviewerDecisionRecheck(sessionID: string): void {
    promoteOnEvidence(sessionID)
    gates.guardReviewerDispatch(sessionID, ledger, evidenceSearch(sessionID))
  }

  /**
   * The executor's plan/decomposition guards: resolves the project dir,
   * enforces the plan-approval gate against it, then the decomposition
   * requirement.
   * @param sessionID The dispatching session ID.
   * @param prompt The dispatch prompt.
   */
  async function enforceExecutorGates(sessionID: string, prompt: string): Promise<void> {
    const dir = await resolveProjectDir(sessionID)
    gates.enforcePlanApproval(sessionID, dir, ledger, prompt)
    gates.enforceDecomposition(sessionID, prompt, dir, ledger)
  }

  /**
   * The configured plans dir as a repo-relative path for one project dir: a
   * relative `plansDir` is used as-is; an absolute one is relativized against
   * the project dir (a dir outside the project yields a `..`-based path that
   * the eligibility rule treats as matching nothing — fail closed). Single
   * source for the maintenance eligibility call sites.
   * @param projectDir The session's project directory.
   * @returns The repo-relative plans dir.
   */
  function maintenancePlansDirRel(projectDir: string): string {
    return path.isAbsolute(config.plansDir)
      ? path.relative(projectDir, config.plansDir)
      : config.plansDir
  }

  // ── Maintenance dispatch classification (orchestration) ────────────────
  // Bookkeeping-only executor dispatches (plan-progress upkeep, doc prose)
  // ride a lighter path: they skip the plan-approval and decomposition gates
  // (no plan-reviewer re-approval cycle) and journal a `maintenance` row.
  // Eligibility is structural, not trust-based (see the module-level
  // MAINTENANCE_* rules): the prompt declares maintenance scope for the
  // active plan AND the current working-tree diff touches only non-src
  // surfaces; anything else gates as ordinary implementation work.
  const maintenanceCounts = new Map<string, number>()
  /** Cap on tracked per-plan maintenance counters (bounded memory). */
  const maxTrackedMaintenancePlans = 16
  function boundMaintenanceCounts(): void {
    evictTo(maintenanceCounts, maxTrackedMaintenancePlans)
  }

  /**
   * Runs the repo's `scripts/check-markers.mjs` guard: the marker-drift CI
   * check, executed against the project's current tree. A missing script, a
   * non-zero exit, or a run exceeding the 10s spawn timeout fails the guard
   * (fail closed — a timed-out spawn reports `status === null`) — a
   * marker-validated surface then cannot qualify for a maintenance dispatch.
   * @param projectDir The project directory to run the guard in.
   * @returns True when the guard exists and passes.
   */
  function markerGuardPasses(projectDir: string): boolean {
    const script = path.join(projectDir, "scripts", "check-markers.mjs")
    if (!fs.existsSync(script)) return false
    const r = spawnSync(process.execPath, [script], {
      cwd: projectDir,
      encoding: "utf8",
      timeout: 10_000,
    })
    return r.status === 0
  }

  /**
   * Lists the working-tree's changed files: tracked modifications/staging
   * (`git diff --name-only HEAD`) plus untracked non-ignored files (`git
   * ls-files --others --exclude-standard` — gitignored plan files stay out,
   * so a progress-only plan edit never disqualifies). Any probe failure
   * (git absent, unborn HEAD, non-zero exit) returns null — the caller
   * treats that as ineligible (fail closed).
   * @param projectDir The repository directory to probe.
   * @returns The repo-relative changed paths, or null on probe failure.
   */
  function gitWorkingTreeFiles(projectDir: string): string[] | null {
    const diff = spawnSync("git", ["diff", "--name-only", "HEAD"], {
      cwd: projectDir,
      encoding: "utf8",
    })
    const untracked = spawnSync("git", ["ls-files", "--others", "--exclude-standard"], {
      cwd: projectDir,
      encoding: "utf8",
    })
    if (diff.error || diff.status !== 0 || untracked.error || untracked.status !== 0) return null
    return [...diff.stdout.split("\n"), ...untracked.stdout.split("\n")].filter(
      (s) => s.trim() !== "",
    )
  }

  /**
   * Approval freshness for a maintenance dispatch: the session must carry a
   * live bound approval (verdict + bound plan + key), the prompt must declare
   * maintenance scope for that plan, and the bound approval must still cover
   * the plan's CURRENT spec region (same spec-slice key shape as capture and
   * reconcile — one extractor; a spec edit reconcile has not yet observed, or
   * an unresolvable binding, is stale — fail closed).
   * @param sessionID The dispatching session ID.
   * @param prompt The dispatch prompt text.
   * @returns The approved plan name and its project dir, or null when the
   *     dispatch is ordinary work.
   */
  async function maintenanceApprovalFresh(
    sessionID: string,
    prompt: string,
  ): Promise<{ plan: string; dir: string } | null> {
    const s = ledger.state(sessionID)
    // The maintenance path skips plan-reviewer *re*-approval: it requires a
    // live bound approval to skip at all. No verdict, no bound plan, or a
    // stale one (already dropped by reconcile) is ordinary work.
    if (!s.hasPlanVerdict || s.approvedPlanKey === "") return null
    const plan = s.approvedPlan
    if (!maintenanceDeclared(prompt, plan, gates.promptPlanNames(prompt))) return null
    const dir = await resolveProjectDir(sessionID)
    if (gates.planApprovalBinding(dir, [plan])?.key !== s.approvedPlanKey) return null
    return { plan, dir }
  }

  /**
   * The whole-diff eligibility probe for a maintenance dispatch: lists the
   * working-tree's changed files, runs the marker guard only when a
   * marker-validated surface is touched, and applies the pure eligibility
   * rules against the configured plans dir.
   * @param dir The session's project directory.
   * @returns True when every touched file is an allowed surface.
   */
  function maintenanceDiffAllowed(dir: string): boolean {
    const files = gitWorkingTreeFiles(dir)
    const needsGuard = files !== null && files.some(maintenanceMarkerSensitive)
    return maintenanceDiffEligible(
      files,
      needsGuard ? markerGuardPasses(dir) : false,
      maintenancePlansDirRel(dir),
    )
  }

  /**
   * Meters one admitted-scope maintenance dispatch against the per-plan cap:
   * under the cap, a slot is consumed and the admitted row journaled; at the
   * cap, the capped attempt row is journaled and nothing is consumed.
   * @param sessionID The dispatching session ID.
   * @param plan The maintenance dispatch's active plan.
   * @returns `"admit"` (a slot was consumed) or `"capped"` (the caller
   *     escalates like any blocked dispatch).
   */
  function meterMaintenanceCap(sessionID: string, plan: string): "admit" | "capped" {
    const count = maintenanceCounts.get(plan) ?? 0
    if (count >= MAINTENANCE_MAX_PER_PLAN) {
      journaler.journal({ type: "maintenance", sessionID, plan, capped: true })
      return "capped"
    }
    maintenanceCounts.set(plan, count + 1)
    boundMaintenanceCounts()
    journaler.journal({ type: "maintenance", sessionID, plan, capped: false })
    return "admit"
  }

  /**
   * Classifies an executor dispatch as maintenance or ordinary work, and
   * meters the per-plan maintenance cap. Returns `"admit"` (an admitted
   * `{type:"maintenance", capped:false}` row was journaled and a cap slot
   * consumed), `"capped"` (the `capped:true` attempt row was journaled; the
   * caller escalates like any blocked dispatch), or `"ordinary"` (the
   * ordinary gates apply). Any internal error fails open to `"ordinary"` with
   * a journaled error entry — classification must never block a dispatch by
   * itself; the ordinary gates still run.
   * @param sessionID The dispatching session ID.
   * @param prompt The dispatch prompt text.
   * @returns The classification verdict.
   */
  async function classifyMaintenanceDispatch(
    sessionID: string,
    prompt: string,
  ): Promise<"admit" | "capped" | "ordinary"> {
    try {
      const fresh = await maintenanceApprovalFresh(sessionID, prompt)
      if (fresh === null) return "ordinary"
      if (!maintenanceDiffAllowed(fresh.dir)) return "ordinary"
      return meterMaintenanceCap(sessionID, fresh.plan)
    } catch (e) {
      journaler.journal({ type: "error", sessionID, error: `maintenance classification: ${e}` })
      return "ordinary"
    }
  }

  /**
   * Escalates a cap-exceeded maintenance dispatch: journals the
   * `maintenance-capped` blocked row and throws the deliberate
   * `BLOCKED by turnstile:` error (the ordinary block vocabulary, so the
   * caller's settle stamps and re-throws it like any guard block).
   * @param sessionID The dispatching session ID.
   * @param plan The plan whose cap is spent.
   */
  function maintenanceCappedBlock(sessionID: string, plan: string): never {
    journaler.journal({
      type: "blocked",
      sessionID,
      agent: config.agents.executor,
      reason: "maintenance-capped",
      plan,
    })
    throw new BlockError(
      `BLOCKED by turnstile: the maintenance dispatch cap (${MAINTENANCE_MAX_PER_PLAN}) is spent ` +
        `for plan "${plan}" — dispatch the ${config.agents.planReviewer} subagent for a ` +
        `re-review, or obtain an explicit user waiver (a user prompt this task must contain ` +
        `the literal marker '${config.waiverMarker}' followed by the user's words).`,
      "plan-gate",
    )
  }

  /**
   * True while the session is inside its observe period: gate decisions are
   * computed and journaled, but the deliberate block is suppressed. Reads the
   * stored admission-phase stamp (admission is the stamping point; a mid-task
   * read of an already-stamped session re-stamps nothing). Fail-toward-
   * enforce: any ledger throw journals and returns false — a broken observer
   * must not silently un-guard the pipeline (the fail-toward-strict direction
   * this codebase takes when an auxiliary read fails).
   * @param sessionID The session whose enforcement decision is being made.
   * @returns True when the deliberate block should be suppressed and
   *     journaled as a would-have-blocked event.
   */
  function observeActive(sessionID: string): boolean {
    try {
      return ledger.observePhase(sessionID).phase === "observe"
    } catch (e) {
      journaler.journal({ type: "error", sessionID, error: `observe phase read: ${e}` })
      return false
    }
  }

  /**
   * Whether gate enforcement is suspended for the session's parent: the
   * session-level `TURNSTILE OFF:` state (decisions keep computing and
   * journaling, but deliberate blocks are suppressed). Children draw on the
   * parent's suspension via `ledger.parentOf`, matching the per-parent
   * state rule. Fail-open: any ledger throw journals and returns false —
   * a broken suspension read must not silently un-guard the pipeline.
   * @param sessionID The session whose enforcement decision is being made.
   * @returns True when enforcement is suspended for the session's parent.
   */
  function suspendSuppressionActive(sessionID: string): boolean {
    try {
      return ledger.isSuspended(ledger.parentOf(sessionID))
    } catch (e) {
      journaler.journal({ type: "error", sessionID, error: `suspension read: ${e}` })
      return false
    }
  }

  /**
   * Journals one replay-inert `suspended` audit entry for a block suppressed
   * by an active gate suspension: the parent-keyed session, the
   * `event:"would-block"` audit flavor, and the blocking gate's audit cause
   * truncated to 200 characters. One entry per suppressed deliberate block;
   * replay folds it inert (it records a suppression, never a state change).
   * @param sessionID The session the entry is keyed on (the parent).
   * @param cause The blocking gate's audit cause.
   */
  function journalSuspendedWouldBlock(sessionID: string, cause: string): void {
    journaler.journal({
      type: "suspended",
      sessionID,
      event: "would-block",
      cause: cause.slice(0, 200),
    })
  }

  /**
   * Settles a task-dispatch guard catch under an active gate suspension
   * (the observe arm above wins the flavor when both are active): the
   * `suspended` audit entry is journaled and the dispatch is metered like
   * any admit. Returns false when the suspension is not the active
   * suppressor, so the caller keeps its ordinary blocked-stamp path.
   * @param e The caught guard failure (an already-checked BlockError).
   * @param sessionID The dispatching session ID.
   * @param agent The resolved agent name.
   * @param description The trace-gated dispatch description.
   * @param waived The budget guard's admission-time waiver-exemption verdict.
   * @returns True when the suspension suppressed the block (dispatch
   *     proceeded, metered).
   */
  function suspendDispatchOutcome(
    e: BlockError,
    sessionID: string,
    agent: string,
    description: string,
    waived: boolean,
  ): boolean {
    if (!suspendSuppressionActive(sessionID)) return false
    journalSuspendedWouldBlock(sessionID, blockCause(e, agent))
    allowDispatch(sessionID, agent, description, waived)
    return true
  }

  /**
   * Names the blocking gate for a suppressed dispatch: the gate's stamped
   * audit cause when the throw site carries one, else the dispatched agent
   * name, else the `"gate"` fallback. Never re-parses the block message —
   * the message is byte-identity-sensitive (goldens pin it), the cause is
   * audit-only.
   * @param e The deliberate block error.
   * @param agent The dispatched agent name ("" when the host named none).
   * @returns The audit cause for the `would-block` entry.
   */
  function blockCause(e: BlockError, agent: string): string {
    return e.cause ?? (agent || "gate")
  }

  /**
   * Settles a task-dispatch guard catch. A deliberate BlockError inside an
   * observe period is suppressed: the `would-block` audit entry is journaled
   * with the running totals and the dispatch is metered like any admit — the
   * suppressed dispatch happened, so counters mean the same thing in both
   * modes and a "would have been blocked" count is an attempt count, not a
   * counter delta. The same applies when a user-typed gate suspension is
   * active (the observe arm wins the flavor when both are active): the
   * `suspended` audit entry is journaled instead. Outside both suppression
   * modes the BlockError stamps
   * `blocked:true` (a blocked attempt draws down nothing) and is re-thrown
   * for the fail-open wrapper; any non-BlockError is an internal error that
   * propagates un-stamped, so the dispatch entry is never mislabeled.
   * @param e The caught guard failure.
   * @param sessionID The dispatching session ID.
   * @param agent The resolved agent name.
   * @param description The trace-gated dispatch description.
   * @param waived The budget guard's admission-time waiver-exemption verdict
   *     (false when the budget guard itself threw).
   * @returns True when the block was suppressed (the dispatch proceeded).
   */
  function dispatchBlockOutcome(
    e: unknown,
    sessionID: string,
    agent: string,
    description: string,
    waived: boolean,
  ): boolean {
    if (!(e instanceof BlockError)) return false
    if (observeActive(sessionID)) {
      const cause = blockCause(e, agent)
      const totals = ledger.noteWouldBlock(sessionID)
      journaler.journal(wouldBlockEntry(sessionID, cause, totals.observed, totals.wouldBlocks))
      allowDispatch(sessionID, agent, description, waived)
      return true
    }
    if (suspendDispatchOutcome(e, sessionID, agent, description, waived)) return true
    recordDispatch(sessionID, agent, description, true)
    return false
  }

  /**
   * A task dispatch's pre-guard budget half: the per-leg and total-dispatch
   * budget guard. The plan-gate once-grant is consumed only inside the
   * executor branch (after maintenance classification), so a dispatch that
   * rides the maintenance path never burns a user's one-shot approval it
   * never needed, and a blocked dispatch cannot consume the grant (the
   * budget guard runs first; a BlockError from it propagates to the
   * caller's settle).
   * @param sessionID The dispatching session ID.
   * @param agent The resolved agent name.
   * @returns The budget guard's waiver-exemption verdict.
   */
  function dispatchBudget(sessionID: string, agent: string): boolean {
    return gates.guardDispatchBudget(sessionID, ledger, agent)
  }

  /**
   * Guard-and-meter-and-journal section of a task dispatch: the budget
   * guard (dispatchBudget), the reviewer evidence guard, and the executor
   * branch: maintenance classification first (an admitted dispatch is
   * allowed without touching the plan gates; a capped one escalates), then
   * the deferred plan-gate once-grant consume (an ordinary dispatch
   * released by the grant skips the gates), then the plan/decomposition
   * guards — then the counters advance and the dispatch entry is recorded
   * at the admitted exit (a blocked attempt draws down nothing; stamped
   * `blocked:true` only on a deliberate BlockError, which is re-thrown for
   * the outer fail-open catch).
   * @param sessionID The dispatching session ID.
   * @param agent The resolved agent name.
   * @param prompt The dispatch prompt.
   * @param description The trace-gated dispatch description.
   */
  async function guardedTaskDispatch(
    sessionID: string,
    agent: string,
    prompt: string,
    description: string,
  ): Promise<void> {
    let waived = false
    try {
      waived = dispatchBudget(sessionID, agent)
      if (agent === config.agents.reviewer) reviewerDecisionRecheck(sessionID)
      if (agent === config.agents.executor) {
        const maintenance = await classifyMaintenanceDispatch(sessionID, prompt)
        if (maintenance === "admit") {
          allowDispatch(sessionID, agent, description, waived)
          return
        }
        if (maintenance === "capped") {
          maintenanceCappedBlock(sessionID, ledger.state(sessionID).approvedPlan)
        }
        if (consumePlanGrant(sessionID, agent)) {
          allowDispatch(sessionID, agent, description, waived)
          return
        }
        await enforceExecutorGates(sessionID, prompt)
      }
      allowDispatch(sessionID, agent, description, waived)
    } catch (e) {
      if (dispatchBlockOutcome(e, sessionID, agent, description, waived)) return
      throw e
    }
  }

  /**
   * Consumes the landing once-grant for a push candidate when one is
   * pending, and reports whether the push is thereby released.
   *
   * A landing once-grant (from a `permission.replied` `once` for a landing
   * ask) releases exactly ONE push, consumed here, before the gate decides,
   * so a stale grant cannot outlive that single dispatch. Scoped to landing
   * candidates: a non-push bash command leaves the grant pending (burning it
   * on `git status` would defeat the "single push" contract). Keyed
   * per-reason (`.landing`), so it can never be consumed by a plan-gate
   * (task) dispatch or vice versa.
   * @param st The parent's gate-state bucket.
   * @param text The bash command text.
   * @returns True when the landing once-grant was consumed (the push is
   *     released by it).
   */
  function consumeLandingGrant(st: GateState, text: string): boolean {
    if (st.pendingOnceGrant.landing !== "" && isPushLanding(text)) {
      st.pendingOnceGrant.landing = ""
      return true
    }
    return false
  }

  /**
   * The stateful landing-gate capability handed to
   * `toolPolicy.guardLanding`: only a shaped capability crosses the
   * boundary, so the stateful ledger never enters the pure tool-policy
   * module. `recordBlock`/`escalate` are its only mutators; `escalate`
   * arms the pending-landing-ask latch (the evaluate handler forces the
   * human ask off it) and is called by guardLanding only under
   * `escalation: "ask"` on an armed attempt (a repeat attempt, or a
   * credited first attempt); it returns whether the ask row must be
   * journaled (within-TTL duplicate arms return false); fail-toward-strict
   * — a host reject leaves approval absent, so the next attempt re-blocks. `hasCreditedApproval` is a read of the ledger's bucket-free
   * credit trace (a journaled, non-refused reviewer APPROVE that a prompt
   * reset dropped the `hasReviewApprove` flag for) that guardLanding
   * consults to escalate a credited session's first push instead of throwing
   * the first block. `isEmptyDiff` runs the static empty-diff probe against
   * the session's project directory (lazily resolved at probe time) and is
   * consulted by guardLanding only under `gitGates.emptyDiffExempt`; a false
   * result or a probe failure falls through to the gate — fail-toward-strict.
   * @param st The parent's gate-state bucket.
   * @param parent The parent session (the latch's key).
   * @param sid The session whose project directory the probe resolves.
   * @returns The landing-gate capability record.
   */
  function landingGateHandles(st: GateState, parent: string, sid: string): LandingGateCapability {
    return {
      hasApproval: () => st.hasReviewApprove,
      hasCreditedApproval: () => ledger.hasCreditedApproval(parent),
      priorBlocks: () => st.landingBlocks,
      recordBlock: () => {
        st.landingBlocks += 1
      },
      escalate: (): boolean => armLandingAsk(parent),
      isEmptyDiff: (command: string): boolean => isEmptyDiffPush(command, currentProjectDir(sid)),
    }
  }

  /**
   * Arms the pending-landing-ask latch and reports whether the caller must
   * journal the ask row: a re-arm within `askLatchTtlMs` of the parent's
   * previous escalation is a same-tick duplicate — the latch is (re-)armed
   * so the evaluate handler still forces the ask, but the ask row is
   * collapsed into the already-journaled one and the guard takes the block
   * path. The latch set happens before the dedupe check so a duplicate arm
   * refreshes the latch the evaluate handler consumes.
   * @param parent The parent session (the latch's and dedupe map's key).
   * @returns True when the caller must journal the `permission` ask row.
   */
  function armLandingAsk(parent: string): boolean {
    const now = Date.now()
    const last = lastLandingEscalateAt.get(parent)
    pendingLandingAsk.set(parent, now)
    boundLandingAsks()
    if (last !== undefined && now - last < askLatchTtlMs) return false
    lastLandingEscalateAt.set(parent, now)
    boundLandingAsks()
    return true
  }

  /**
   * Hands-on twin of {@link armLandingAsk}: arms the pending-hands-on-ask
   * latch and dedupes same-tick escalations by the same within-TTL rule.
   * @param parent The parent session (the latch's and dedupe map's key).
   * @returns True when the caller must journal the `permission` ask row.
   */
  function armHandsOnAsk(parent: string): boolean {
    const now = Date.now()
    const last = lastHandsOnEscalateAt.get(parent)
    pendingHandsOnAsk.set(parent, now)
    boundHandsOnAsks()
    if (last !== undefined && now - last < askLatchTtlMs) return false
    lastHandsOnEscalateAt.set(parent, now)
    boundHandsOnAsks()
    return true
  }

  /**
   * Handles a `bash`/`shell` tool call: the denylist guard, the
   * conventional-commit lint, the landing telemetry, and the hands-on bash
   * telemetry + write-shaped bash gate, then the reviewer-gated landing
   * gate with a landing once-grant short-circuit for push candidates. A
   * denylist, hands-on, or landing block throws BlockError (re-thrown by
   * the outer catch).
   * @param event The execute.before tool event (bash/shell shape).
   * @param tool The narrowed tool name (`"bash"` or `"shell"`).
   */
  function handleBashDispatch(event: ToolHookEvent, tool: "bash" | "shell"): void {
    const command = event.input?.command ?? event.input?.cmd
    const sid = asSessionID(event?.sessionID)
    // Denylist first: a configured `gh pr` deny wins over the landing
    // telemetry/gate below, and the two journal reasons stay disjoint
    // (under the empty default there is no such deny, so `gh pr` flows to
    // the landing telemetry below).
    toolPolicy.guardBash(tool, command, sid)
    // Conventional-commit lint (fail-closed for uninspectable forms).
    toolPolicy.guardCommitMessage(tool, command, sid)
    // Landing telemetry (always) then the reviewer-gated landing gate.
    const text = String(command ?? "")
    toolPolicy.observeLanding(sid, text)
    // Hands-on bash telemetry (all sessions, never blocks), then the
    // write-shaped bash gate for parents and non-pipeline subagents —
    // a registered pipeline child's own file-writing bash is its work.
    // The verdict is computed ONCE here and threaded into both the
    // telemetry and the guard.
    const gw = classifyBashWrite(text)
    toolPolicy.observeBashWrite(sid, text, gw)
    // Fail-closed exemption, mirroring the write/edit arm: only a pipeline
    // child's own bash is exempt (agent-name precedence first, then the
    // edge + emitter fallback), and an unresolved status gates like a
    // parent. The exemption sits AFTER the telemetry (so a child still
    // journals its `handsOn` row) and BEFORE the guards (so the bash-write
    // guard — and with it the parent bucket's pending hands-on once-grant —
    // and the landing gate are never reached by a child dispatch).
    if (childStatus(sid, typeof event?.agent === "string" ? event.agent : "") === "child") return
    const parent = ledger.parentOf(sid)
    const st = ledger.state(parent)
    // Invariant: this arm runs BEFORE `consumeLandingGrant` and the hands-on
    // once-grant is consumed inside `guardBashWrite` itself — so a landing
    // grant can never release a bash write, and a hands-on block throws
    // before the landing grant is burned.
    toolPolicy.guardBashWrite(tool, text, gw, sid, bashWriteGateHandles(st, parent))
    if (consumeLandingGrant(st, text)) return
    toolPolicy.guardLanding(tool, text, sid, landingGateHandles(st, parent, sid))
    return
  }

  /**
   * Consumes the hands-on once-grant when one is pending and reports whether
   * the parent write/edit is thereby released. A hands-on once-grant (from a
   * `permission.replied` `once` for a hands-on ask) releases exactly ONE
   * parent edit, consumed before the gate decides, so a stale grant cannot
   * outlive the single edit it was given for. Every write/edit is a hands-on
   * candidate, so no command-shape predicate is needed (unlike the landing
   * grant). Keyed per-reason (`.handsOn`), so it can never be consumed by a
   * plan-gate (task) dispatch or a landing push and vice versa.
   * @param st The parent's gate-state bucket (mutated on consume).
   * @returns True when the hands-on once-grant was consumed (the edit is
   *     released by it).
   */
  function consumeHandsOnGrant(st: GateState): boolean {
    if (st.pendingOnceGrant.handsOn === "") return false
    st.pendingOnceGrant.handsOn = ""
    return true
  }

  /**
   * The stateful hands-on-gate capability handed to `toolPolicy.guardHandsOn`
   * (mirrors landingGateHandles): only a shaped capability crosses the
   * boundary. `escalate` arms the pending-hands-on-ask latch (the evaluate
   * handler forces the human ask off it) and is called by guardHandsOn only
   * under `escalation: "ask"` on a repeat attempt (no release, >= 1 prior
   * block); it returns whether the ask row must be journaled (within-TTL
   * duplicate arms return false);
   * fail-toward-strict — a host reject leaves the gate red, so the next
   * attempt re-blocks.
   * @param st The parent's gate-state bucket.
   * @param parent The parent session (the latch's key).
   * @returns The hands-on-gate capability record.
   */
  function handsOnGateHandles(st: GateState, parent: string): HandsOnGateCapability {
    return {
      hasRelease: () => st.handsOnRelease,
      hasWaiver: () => waiverCovers(st, ["executor"]),
      priorBlocks: () => st.handsOnBlocks,
      recordBlock: () => {
        st.handsOnBlocks += 1
      },
      escalate: (): boolean => armHandsOnAsk(parent),
    }
  }

  /**
   * The stateful bash-write-gate capability handed to
   * `toolPolicy.guardBashWrite`: the hands-on capability plus the once-grant
   * consume. The consume is NOT called at the arm site — `guardBashWrite`
   * runs it itself, after its flag and verdict checks, so a disabled gate or
   * a non-gate shape never burns a pending grant.
   * @param st The parent's gate-state bucket.
   * @param parent The parent session (the latch's key).
   * @returns The bash-write-gate capability record.
   */
  function bashWriteGateHandles(st: GateState, parent: string): BashWriteGateCapability {
    return {
      ...handsOnGateHandles(st, parent),
      consumeGrant: () => consumeHandsOnGrant(st),
    }
  }

  /**
   * Handles a parent-session `write`/`edit` tool call: the path denylist
   * guard first (a configured `pathDeny` wins outright and the two journal
   * reasons stay disjoint — the same denylist-before-gate ordering the bash
   * path uses), then the hands-on gate. A pipeline child's
   * write/edit is the executor's own work and never gates: a non-empty
   * event agent name in the configured pipeline set is authoritative
   * evidence (edge or not — parents never carry a subagent agent name);
   * without an event name the child→parent edge plus the seeded emitter
   * cache decides, and any unresolved status gates like a parent
   * (fail-closed). A hands-on block throws BlockError (re-thrown by the
   * outer catch).
   * @param event The execute.before tool event (write/edit shape).
   * @param tool The narrowed tool name (`"write"` or `"edit"`).
   */
  function handleWriteEditDispatch(event: ToolHookEvent, tool: "write" | "edit"): void {
    const sid = asSessionID(event?.sessionID)
    const filePath = event.input?.filePath ?? event.input?.path
    // Denylist first: a configured pathDeny wins and the journal reasons stay
    // disjoint (mirrors the bash denylist-before-landing-gate ordering).
    toolPolicy.guardPath(tool, filePath, sid)
    // Hands-on gate: parent sessions and non-pipeline subagents; only a
    // pipeline child's own write/edit (the executor's work) is exempt
    // (agent-name precedence first, then the edge + emitter fallback), and
    // an unresolved status fails closed (gated).
    if (childStatus(sid, typeof event?.agent === "string" ? event.agent : "") === "child") return
    const parent = ledger.parentOf(sid) // == sid for a parent; self-keys if unregistered
    const st = ledger.state(parent)
    if (consumeHandsOnGrant(st)) return // once-grant: released for this one edit
    toolPolicy.guardHandsOn(tool, filePath, sid, handsOnGateHandles(st, parent))
  }

  /**
   * Handles a `session_move` tool call: journals the dispatched move
   * (telemetry only, never blocks) and invalidates the per-session
   * directory cache for the session and its parent so the next
   * enforcement re-resolves the moved location.
   * @param event The execute.before tool event (session_move shape).
   */
  function handleSessionMove(event: ToolHookEvent): void {
    // Telemetry only (never blocks): journal the dispatched move. The
    // target directory comes from the (unconfirmed) tool payload.
    const moveDir = (event.input as { directory?: unknown } | undefined)?.directory
    const sid = asSessionID(event?.sessionID)
    toolPolicy.observeSessionMove(sid, moveDir)
    // Invalidate the per-session directory cache unconditionally,
    // regardless of telemetry config: mechanics must not hide behind
    // it. The next enforcement re-resolves via session.get, which
    // reflects the completed move. A self-keyed dispatch has
    // parentOf(sid) === sid, so the second delete is a no-op there.
    sessionDirs.delete(sid)
    sessionDirs.delete(ledger.parentOf(sid))
    return
  }

  /**
   * Swallows a deliberate BlockError thrown at the catch-all
   * `execute.before` choke point (bash denylist, commit lint, landing gate)
   * while a user-typed gate suspension is active for the event's parent:
   * the `suspended` audit entry is journaled (cause from the block, bounded)
   * and the tool call proceeds. Returns false when no suspension is active,
   * so the caller rethrows (the ordinary enforce path).
   * @param event The execute.before tool event.
   * @param e The deliberate block error (an already-checked BlockError).
   * @returns True when the suspension suppressed the block.
   */
  function suspendBlock(event: ToolHookEvent, e: BlockError): boolean {
    const parent = ledger.parentOf(asSessionID(event?.sessionID))
    if (!suspendSuppressionActive(parent)) return false
    journalSuspendedWouldBlock(parent, blockCause(e, ""))
    return true
  }

  /**
   * Records a child's latest VERDICT from the text itself, before the parent
   * edge is needed, so a child with an unresolved edge still records. Only
   * non-task-result sources enter the store: task-result markers are handled
   * by the delivery's own match during attribution, and keeping them out
   * preserves "a marker-less task-result delivery keeps the gate red".
   *
   * Store-backed verdict observations: the store records the child's latest
   * VERDICT (per (child, marker, source) first-sight) for the plan gate's
   * attribution reads; the parent-bucket dedup (markers.ts) keys on
   * (scope, marker), so identical re-delivery and a cross-source same-marker
   * replay (a source change with an unchanged marker, e.g. delta→ended) are
   * both silently suppressed; only a marker flip reaches the journal.
   * Authority gate: only a marker-contracted emitter (see markerKindAllowed)
   * may record or apply a verdict; a quoted/echoed verdict is denied here
   * (never stored) and surfaces as a suppressed observation when the gate
   * journals it.
   * @param text The assistant text to scan.
   * @param sessionID The raw (possibly child) session ID.
   * @param source Provenance label for the text in journal entries.
   */
  function recordStreamedVerdict(text: string, sessionID: string, source: string): void {
    const allowed = markerKindAllowed(sessionID)
    if (sessionID && source !== "task-result" && allowed("verdict")) {
      const m = lastMatch(text, verdictRe)
      if (m) ledger.recordChildVerdict(sessionID, m, source)
    }
  }

  /**
   * Journals a marker observation denied by the authority gate: keyed on the
   * EMITTER (not the parent) as a replay-inert type:"suppressed" audit
   * entry. Nothing is applied — the event is never returned to the caller,
   * so hasReviewApprove and own-match attribution cannot fire on it. Keyed
   * on the emitter (not the parent) because nothing replays against a denied
   * observation; this runs for every non-empty sessionID, including
   * unresolved-edge ones (self-keyed).
   * @param event The denied marker observation.
   * @param sessionID The emitter (raw child) session ID.
   * @param source Provenance label for the text.
   */
  function journalSuppressedObservation(
    event: MarkerEvent,
    sessionID: string,
    source: string,
  ): void {
    journaler.journal({
      type: "suppressed",
      sessionID,
      raw: sessionID,
      agent: emitterAgent(sessionID),
      kind: event.kind,
      marker: event.marker,
      source,
    })
  }

  /**
   * Journals a first-sight `GATE:` observation: keyed by parent session so
   * journal replay restores state where the reviewer gate looks it up; raw
   * child ID kept for forensics. Spreads the evidence stamp (present only
   * when the evidence mode is not "off") and the suppressed-match count
   * (only when > 0), and carries the de-tokenized marker text for the
   * compaction snapshot (the state boundary records it, this helper
   * journals the event).
   * @param event The gate marker observation (authority never "suppressed").
   * @param suppressedCount The suppressed-match count spread, empty when 0.
   * @param sid The parent session the `gate` entry is keyed on.
   * @param sessionID The raw child session ID for the entry's `raw` field.
   * @param source Provenance label for the text.
   * @param s The parent's gate state (mutated: lastGateMarker).
   */
  function journalGateEvent(
    event: MarkerEvent,
    suppressedCount: { suppressed?: number },
    sid: string,
    sessionID: string,
    source: string,
    s: GateState,
  ): void {
    const evidenceStamp =
      event.verified !== undefined ? { verified: event.verified, mode: event.mode } : {}
    journaler.journal({
      type: "gate",
      sessionID: sid,
      raw: sessionID,
      result: event.result,
      source,
      marker: event.marker,
      ...evidenceStamp,
      ...suppressedCount,
    })
    // A green gate flip is the task's completion boundary: a flipping PASS
    // (an enforce-unverified claim never flipped) journals its task-complete
    // companion row and stamps the retire, so the next admitted prompt
    // starts a fresh scope.
    const flipped = event.verified !== false || event.mode === "flag"
    if (event.result === "PASS" && flipped) markTaskComplete(sid, s)
    journaler.traceEvent("test-runner", "gate", event.marker, sid)
    // Carry the de-tokenized marker text for the compaction snapshot; the
    // state boundary records it, the caller journals the event.
    s.lastGateMarker = deTokenizeMarker(event.marker)
  }

  /**
   * Journals a first-sight `VERDICT:` observation: keyed by parent session
   * with the raw child ID kept for forensics, spreading the
   * suppressed-match count (only when > 0). Streaming verdict dedup is per
   * (child, marker, source) via the store (a source change with an unchanged
   * marker re-journals; identical re-delivery never emits an event here
   * because the parent-bucket dedup on (scope, marker) suppresses it first).
   * Gate-kind events are unaffected. Carries the de-tokenized marker text
   * for the compaction snapshot.
   * @param event The verdict marker observation (authority never "suppressed").
   * @param suppressedCount The suppressed-match count spread, empty when 0.
   * @param sid The parent session the `verdict` entry is keyed on.
   * @param sessionID The raw child session ID for the entry's `raw` field.
   * @param source Provenance label for the text.
   * @param s The parent's gate state (mutated: lastVerdictMarker).
   */
  function journalVerdictEvent(
    event: MarkerEvent,
    suppressedCount: { suppressed?: number },
    sid: string,
    sessionID: string,
    source: string,
    s: GateState,
  ): void {
    journaler.journal({
      type: "verdict",
      sessionID: sid,
      raw: sessionID,
      marker: event.marker,
      rounds: event.rounds,
      source,
      ...suppressedCount,
    })
    journaler.traceEvent("reviewer", "verdict", event.marker, sid)
    s.lastVerdictMarker = deTokenizeMarker(event.marker)
  }

  /**
   * Routes a first-sight marker observation to its kind-specific journal
   * helper: an observation denied by the authority gate journals as
   * suppressed and never falls through to the gate/verdict helpers.
   * @param event The first-sight marker observation.
   * @param sid The parent session gate/verdict entries are keyed on.
   * @param sessionID The raw child (emitter) session ID.
   * @param source Provenance label for the text.
   * @param s The parent's gate state (mutated by the kind helpers).
   */
  function journalMarkerEvent(
    event: MarkerEvent,
    sid: string,
    sessionID: string,
    source: string,
    s: GateState,
  ): void {
    if (event.authority === "suppressed") {
      journalSuppressedObservation(event, sessionID, source)
      return
    }
    // Every event that passes the authority check above carries a defined
    // numeric `suppressed` count (denied events omit it); assert that shape
    // to the type checker (it is not optional at runtime).
    const suppressed = event.suppressed!
    const suppressedCount = suppressed > 0 ? { suppressed } : {}
    if (event.kind === "gate") {
      journalGateEvent(event, suppressedCount, sid, sessionID, source, s)
      return
    }
    journalVerdictEvent(event, suppressedCount, sid, sessionID, source, s)
  }

  /**
   * Parses markers out of assistant text and journals first-sight events.
   * @param text The assistant text to scan.
   * @param sessionID The raw (possibly child) session ID.
   * @param source Provenance label for the text in journal entries.
   * @param dedupScope Key prefix partitioning the marker dedup set.
   * @returns The first-sight events that were journaled (the caller uses
   *     them to credit reviewer approvals); suppressed observations are
   *     journaled but excluded.
   */
  function parseMarkers(
    text: string,
    sessionID: string,
    source: string,
    dedupScope = "",
  ): MarkerEvent[] {
    const events: MarkerEvent[] = []
    if (!text) return events
    recordStreamedVerdict(text, sessionID, source)
    const sid = ledger.parentOf(sessionID)
    if (!sid) return events
    const s = ledger.state(sid)
    // Evidence verdict computed here: the caller owns the tracker + config.
    // Under "enforce" the flip switch is the observed correlation; under "flag"
    // the flip switch is omitted (always flips) while the journal is stamped;
    // under "off" neither the flip switch nor the stamp is passed, keeping
    // events byte-identical to legacy output. The correlation is windowed at
    // the parent's task-window stamp (the same bound the promotion join
    // uses), so a keep-scope admission cannot verify a claim with exit-0
    // hits that predate the prompt — the per-prompt anti-fabrication bound
    // survives the task-long-lived scope. A parent that never admitted a
    // prompt keeps the unbounded join (stamp 0).
    const observed =
      config.gateEvidence === "off" ? undefined : evidence.has(sid, taskWindows.get(sid) ?? 0)
    const passVerified = config.gateEvidence === "enforce" ? observed : undefined
    const stampVerified = observed
    const stampMode = observed === undefined ? undefined : config.gateEvidence
    // Thread the raw child session ID as `raw`: dedup provenance is per-child,
    // so a dedup hit from a different child accounts as cross-child suppression
    // while the same child's re-delivery stays silent.
    for (const event of parseGateMarkers(
      s,
      text,
      gateRe,
      verdictRe,
      dedupScope,
      sessionID,
      passVerified,
      stampVerified,
      stampMode,
      markerKindAllowed(sessionID),
    )) {
      journalMarkerEvent(event, sid, sessionID, source, s)
      // Collected for the caller: the execute.after reviewer branch uses these
      // events to detect a first-sight verdict APPROVE and set hasReviewApprove.
      // Suppressed observations are journaled above and excluded.
      if (event.authority !== "suppressed") events.push(event)
    }
    return events
  }
  // Prompt-channel waiver capture: the waiver must
  // provenance from the user's prompt, never the dispatch prompt. A counter
  // tracks prompts where NEITHER candidate text key (`text`/`prompt`) holds a
  // non-empty string, so an unresolvable source is reported once (keylessPrompts hits
  // 1 exactly once) as a misconfiguration (mirrors the bash `command ?? cmd`
  // telemetry).
  let keylessPrompts = 0

  // Prompt-channel admission bookkeeping (per-plugin-load closure state):
  // `promptHookFires` counts prompt-hook dispatches (the hook increments it
  // before it admits); a zero count when the inbox stream admits means this
  // surface does not dispatch the prompt hook, so admission is served by the
  // inbox stream — surfaced once as a one-time telemetry error.
  let promptHookFires = 0
  // One-time flag backing the dead-channel surfacing below.
  let deadChannelSurfaced = false
  // Dedupe keys `${sessionID}:${admissionID}` for every prompt admitted, so
  // the hook path and the inbox stream each admit one prompt exactly once
  // (the normal host sequence is hook-then-inbox on the shared message id).
  const admittedIds = new Set<string>()
  // Cap on tracked dedupe keys (FIFO; evict the first-seen key past the
  // cap — Set insertion order is never refreshed, which is fine: the host
  // never re-fires an old admission id, so recency adds nothing) — bounded
  // memory per plugin instance.
  const maxTrackedAdmittedIds = 64
  /**
   * Bounds the admitted-id dedupe set by evicting its oldest keys.
   */
  function boundAdmittedIds(): void {
    evictTo(admittedIds, maxTrackedAdmittedIds)
  }

  // Session-end summary dedupe: one summary per session per host process.
  // In-memory only — after a restart the same session may re-summary once
  // (accepted; the journaled `session-summary` entry makes it diagnosable).
  // Bounded like the admitted-id set (cap = maxSessions, the same LRU bound
  // the ledger uses; a session that idled once never fires again).
  const summarizedSessions = new Set<string>()
  /**
   * Bounds the summarized-session dedupe set by evicting its oldest keys.
   */
  function boundSummarizedSessions(): void {
    evictTo(summarizedSessions, config.maxSessions)
  }

  // Host toast surface, bound at setup time (guarded — an absent or
  // non-function `tui.toast.show` leaves it undefined and the summary
  // delivers journal-only, the headless path).
  let toast:
    ((message: string, variant: "info" | "success" | "warning") => Promise<void>) | undefined
  /**
   * Binds the host toast surface: stores a guarded closure over `show` so
   * the caller (the idle handler) passes a plain (message, variant) call.
   * The closure itself never catches — the caller wraps the invocation in
   * its own try/catch (fail-open) so a rejecting toast journals there.
   * @param show The host `tui.toast.show` function, or undefined when the
   *     TUI surface is absent.
   */
  function bindToast(show: ToastShow | undefined): void {
    toast =
      typeof show === "function"
        ? async (message: string, variant: "info" | "success" | "warning"): Promise<void> => {
            await show({ message, variant })
          }
        : undefined
  }

  /**
   * Performs a full task-scope reset for a parent: rebuilds the gate bucket
   * (releasing registered children) and drops all task-scoped dispatch
   * state, journaling a `child-reset` entry when any registered child's
   * metering counters were freed. This is the clear both an admission reset
   * (the scope-change arms of `carryOrReset`) and a reset-at-capture plan
   * approval perform.
   * @param sessionID The parent session whose task scope resets.
   * @param merge Whether the rebuild may merge the restart-sticky flags
   *     through the bucket's armed `replayGrace`. Omitted (the admission
   *     arms) keeps the armed-grace default; false (a reset-at-capture
   *     approval) forces a clean rebuild — the old scope's releases must
   *     not ride the grace into the new one.
   */
  function resetTaskScope(sessionID: string, merge?: boolean): void {
    const freed = ledger.resetState(sessionID, merge)
    dropTaskScope(sessionID)
    if (freed > 0) journaler.journal({ type: "child-reset", sessionID, children: freed })
  }

  /**
   * Admits a same-scope prompt: no reset, no task-scope drop — every gate
   * flag, waiver, counter, and latch survives (side chatter and follow-ups
   * never reset anything while a plan is bound and the task is not retired).
   * Two per-prompt duties survive the keep despite the task-long-lived scope
   * (pinned choice — option (i) of the evidence-window decision): the
   * evidence join stays PER-PROMPT, so every admission re-stamps the task
   * window and a `GATE: PASS` claim can only be promoted by exit-0 hits
   * at-or-after the prompt that admitted it (fail-closed anti-fabrication);
   * and a failed claim's residue — the pending unverified text, its
   * streaming-scope dedupe key, and the display marker — is dropped, so a
   * corrected re-claim re-registers instead of wedging the task red (the
   * claim itself is never honored: the gate stays red until a flipping
   * PASS). Consumes the one-prompt `replayGrace` (the first post-restart
   * prompt has now carried naturally; leaving it armed would let a much
   * later scope-change reset carry flags across a task boundary) and
   * refreshes the worktree fingerprint stamp (plan-bound scope ignores
   * fingerprint changes; the stamp stays factual).
   * @param sessionID The parent session whose scope is kept.
   * @param fingerprint The freshly-computed worktree/branch identity.
   */
  function keepTaskScope(sessionID: string, fingerprint: string): void {
    // `ledger.state` (not `peek`): this path mutates the bucket, and the
    // session is already marked a live parent, so the mint cannot be evicted.
    const s = ledger.state(sessionID)
    s.replayGrace = false
    taskWindows.set(sessionID, Date.now())
    boundTaskWindows()
    if (s.unverifiedPass !== "") {
      // The streaming channels share the empty dedup scope; a task-result
      // delivery re-scopes per delivery, so only the streaming key can wedge.
      s.seen.delete(`gate\u0000${s.unverifiedPass}`)
      s.unverifiedPass = ""
      s.lastGateMarker = ""
    }
    s.taskFingerprint = fingerprint
  }

  /**
   * Resets this parent's gate state for a scope-changing admitted prompt,
   * carrying the restart-sticky flags when continuation carry is armed and
   * the same worktree/branch is re-admitted. Journals a `continuation` entry
   * when the carry fired and a `child-reset` entry when any registered
   * child's metering counters were freed. A same-scope prompt (plan-bound,
   * not retired, carry on) skips both the reset and the task-scope drop
   * entirely — the parent is still marked pinned first either way.
   * @param sessionID The parent session whose state is (maybe) reset.
   */
  function carryOrReset(sessionID: string): void {
    // Mark the session a live parent before any reset: resetState re-caps
    // `states`, and a registered parent is never evicted, so the rebuilt MRU
    // slot stays pinned.
    ledger.markParent(sessionID)
    const prior = ledger.peek(sessionID)
    if (keepsTaskScope(prior, config.continuationCarry)) {
      keepTaskScope(sessionID, worktreeFingerprint(currentProjectDir(sessionID)))
      return
    }
    const fingerprint = worktreeFingerprint(currentProjectDir(sessionID))
    // The carry decision is captured BEFORE mutating, not re-derived after.
    // The git probe is total (never throws), so this stays throw-free. A
    // retired prior bucket journals no continuation row: the merge carries
    // nothing out of a completed task, so the audit row must not claim a
    // carry that did not happen.
    if (config.continuationCarry) {
      const carry = shouldCarryGate(prior, fingerprint, true) && prior!.taskComplete === false
      // shouldCarryGate guarantees carry ⇒ prior is defined, so the
      // non-null assertion cannot fire; keep the predicate's contract
      // intact if it ever changes.
      if (carry) prior!.replayGrace = true
      resetTaskScope(sessionID)
      ledger.state(sessionID).taskFingerprint = fingerprint
      if (carry) journaler.journal({ type: "continuation", sessionID })
    } else {
      resetTaskScope(sessionID)
    }
  }

  /**
   * Drops all prior task-scoped dispatch state for a parent so the next task
   * scope starts clean: the plan-review dispatch targets, the in-memory
   * evidence correlation, the task-window stamp, and the pending plan-ask,
   * landing-ask, and near-miss latches. Runs only on a scope change (an
   * admission reset or a reset-at-capture approval) — a same-scope prompt
   * never reaches it.
   * @param sessionID The parent session whose task-scoped state is dropped.
   */
  function dropTaskScope(sessionID: string): void {
    // A task-scope reset invalidates all prior dispatch-scoped
    // evidence for this parent, so an unresolved-child verdict is only
    // plausible within the parent's current task scope, and the prior
    // round's plan-mention candidates cannot bind a new task's approval.
    planReviewerDispatch.delete(sessionID)
    planReviewTarget.delete(sessionID)
    // Evidence is task-scoped, exactly like gate state: a task-scope
    // change drops the in-memory correlation.
    evidence.clear(sessionID)
    // Stamp the parent's current task window beside the evidence clear:
    // from this moment a GATE: PASS may only be promoted by executions
    // journaled at-or-after the stamp, so a stale prior-task execution
    // (still keyed under an unresolved child) cannot verify the new task's
    // claim. A parent that never admits a prompt keeps the unbounded join.
    taskWindows.set(sessionID, Date.now())
    boundTaskWindows()
    // A task-scope reset also drops any pending plan-ask latch: the
    // escalation's stream event belongs to the previous task scope, so
    // the next task must not let a later unrelated ask be recorded as
    // the plan ask.
    awaitingPlanAsk.delete(sessionID)
    // A landing-ask arm (an enforce repeat-attempt escalation) belongs
    // to the previous task scope too: a scope change drops it, so the new
    // task starts from a pure first block again.
    pendingLandingAsk.delete(sessionID)
    // The landing dedupe timestamp belongs to the previous task scope the
    // same way: without this delete a stale timestamp could suppress a
    // legitimate ask row for up to `askLatchTtlMs` after the scope change.
    lastLandingEscalateAt.delete(sessionID)
    // A hands-on-ask arm belongs to the previous task scope the same way:
    // a scope change drops it, so the new task starts from a pure first block.
    pendingHandsOnAsk.delete(sessionID)
    // Mirror the hands-on dedupe timestamp (same rationale as the landing
    // one above).
    lastHandsOnEscalateAt.delete(sessionID)
    // A task-scope reset also drops undelivered near-miss diagnostics: they
    // belong to the previous task scope. The scan below re-seeds within the
    // same admission, so the new prompt's own near misses still surface.
    nearMissPending.delete(sessionID)
    // A pending intent nudge belongs to the dropped task scope too: an
    // undelivered nudge must not attach to a later task's deliveries. The
    // per-kind dedupe keys survive this drop by design (one nudge per
    // detected intent within the task; a plan approval or a task retire
    // clears them, and the drop itself only runs on a scope change).
    intentNudgePending.delete(sessionID)
  }

  /**
   * Applies a plan-approval's binding and the pinned scope-transition rule:
   * stamps the approval against the current plans dir FIRST (the binding name
   * falls out of the stamp), then — when the bound name differs from the
   * bucket's `activePlan` (including the first binding over the planless "")
   * — resets the task scope with a clean (non-merge) rebuild — counters,
   * waiver family, ask latches, evidence, dispatch targets — BEFORE the new
   * scope is used, re-applying the saved stamp identity to the fresh bucket.
   * The clean rebuild matters: `resetState`'s merge arm would carry the old
   * scope's releases into the new one whenever the boot-replay grace is
   * still armed (a reviewer verdict arriving with no parent prompt admitted
   * since the restart). An unbound approval (`""`) is a no-op for scope: no
   * reset, no `activePlan` write (an unbound stamp must not wipe the live
   * identity — the planless fallback would silently revert to per-prompt
   * resets). Either way the approved bucket gets `hasPlanVerdict` (plus
   * `humanApproval` when the capture is human); a bound approval also sets
   * `activePlan` to the bound name.
   * @param sessionID The parent session the approval binds for.
   * @param projectDir The current project directory (for the plans-dir scan).
   * @param candidates The plan names the approval's dispatch prompt named.
   * @param human True when the approval provenance is a human prompt marker.
   * @returns The approved bucket (post-reset when the scope changed).
   */
  function applyApprovalBinding(
    sessionID: string,
    projectDir: string,
    candidates: string[],
    human: boolean,
  ): GateState {
    const s0 = ledger.state(sessionID)
    const priorActive = s0.activePlan
    let s = s0
    stampPlanApproval(s, "APPROVE", projectDir, candidates)
    const bound = s.approvedPlan
    if (approvalResetsScope(priorActive, bound, s0.taskComplete)) {
      // Reset-at-capture: snapshot the just-stamped identity, rebuild the
      // task scope CLEAN (no grace merge — see the doc), and re-apply it to
      // the fresh bucket.
      const savedPlan = s.approvedPlan
      const savedKey = s.approvedPlanKey
      const savedSig = s.plansSignature
      resetTaskScope(sessionID, false)
      s = ledger.state(sessionID)
      s.approvedPlan = savedPlan
      s.approvedPlanKey = savedKey
      s.plansSignature = savedSig
    }
    s.hasPlanVerdict = true
    if (human) s.humanApproval = true
    if (bound !== "") s.activePlan = bound
    return s
  }

  /**
   * Waiver capture (prompt channel): a waiver covers every gate while unscoped,
   * but the reviewer gate consumes an unscoped waiver on the first dispatch it
   * unlocks; naming configured agent names in the waiver text scopes it to
   * those stages' gates (the plan gate is covered by either its plan-reviewer
   * or executor stage name), and a scoped waiver stays live until that
   * stage's waiver allowance is spent — metered separately from the ordinary
   * dispatch caps. The waiver holds for the whole task scope: only a
   * task-scope change (a different-plan approval, a task retire, a planless
   * fingerprint change) clears it. Read + capture in one guarded block; a
   * coercion that throws (a malformed prompt value) is journaled under the
   * historical "waiver capture" key and swallowed — fail-open.
   * @param sessionID The parent session the waiver is captured for.
   * @param properties The prompt payload to scan for the waiver marker.
   */
  function captureWaiver(sessionID: string, properties: PromptHookProperties): void {
    try {
      const waiverText = promptTextOf(properties)
      const at = waiverText.indexOf(config.waiverMarker)
      if (at !== -1) {
        const s = ledger.state(sessionID)
        s.userWaiver = config.trace ? waiverText.slice(at, at + 200) : "<present>"
        // Scope is parsed from the raw window before trace redaction: the
        // stored quote may be "<present>", but the scope needs the words.
        const scope = parseWaiverScope(waiverText.slice(at), Object.values(config.agents))
        s.userWaiverScope = scope
        // Task-scoped standing release: the waiver joins the sticky
        // decision-row family (no separate journal type), so the boot
        // replay restores it through the same scope fold as ask `always`
        // grants. `stickyRelease` is provenance; the gates keep reading
        // the waiver family itself.
        s.stickyRelease = true
        journaler.journal(decisionEntry(sessionID, "waiver", { kind: "waiver", stages: scope }))
      }
    } catch (e) {
      // Fail-open: capture never blocks a prompt.
      journaler.journal({ type: "error", error: `waiver capture: ${e}` })
    }
  }

  /**
   * Human approval (item 7): a `PLAN APPROVED:` marker in the user prompt
   * releases the plan gate — the same release signal the plan-reviewer verdict
   * sets. Read + capture in one guarded block: bind the approval against the
   * plan candidates the prompt itself names (the `promptPlanNames` `*.md`
   * parse, resolved against the current plans dir — a unique existing mention
   * binds it, so the human channel can establish `activePlan` exactly like a
   * reviewer verdict) and apply the reset-at-capture scope rule when the
   * binding differs from the bucket's `activePlan`; a prompt naming nothing
   * (or no unique existing plan) binds nothing and is a no-op for scope.
   * Also stamps the plans-dir signature (so a restart replays the approval
   * stamped and an offline plan edit invalidates it) and journals an APPROVE
   * entry that replays identically to a verdict. Runs BEFORE the waiver
   * capture in the same admission, so a waiver sharing the prompt lands in
   * the (possibly reset) new scope. A coercion that throws is journaled and
   * swallowed — fail-open.
   * @param sessionID The parent session the approval is captured for.
   * @param properties The prompt payload to scan for the approval marker.
   */
  function captureApproval(sessionID: string, properties: PromptHookProperties): void {
    try {
      const approvalText = promptTextOf(properties)
      if (approvalText.indexOf(config.approvalMarker) === -1) return
      const projectDir = currentProjectDir(sessionID)
      const s = applyApprovalBinding(
        sessionID,
        projectDir,
        gates.promptPlanNames(approvalText),
        true,
      )
      // The task has its plan: forget prior intent nudges so a later
      // task's detected intents can nudge again.
      clearIntentNudge(sessionID)
      journaler.journal({
        type: "plan",
        sessionID,
        result: "APPROVE",
        // Provenance only: replay reads only type+result+plansSig.
        source: "session-prompt",
        marker: config.approvalMarker,
        ...planApprovalStampFields(s),
      })
      recordDurablePlanApproval(s, projectDir)
    } catch (e) {
      // Fail-open: approval capture never blocks a prompt.
      journaler.journal({ type: "error", error: `approval capture: ${e}` })
    }
  }

  /**
   * Marks the parent's active task retired: stamps `taskComplete` and
   * journals one `{type:"task-complete", plan}` row (the plan being the
   * bucket's `activePlan`). Only a plan-bound task retires — a planless
   * session's gate flip changes nothing (there is no plan to retire, and the
   * planless fallback preserves today's per-task-scope reset + carry behavior).
   * Idempotent within the task — the first PASS (or retire marker) journals,
   * repeats are silent — so the ordered replay fold sees exactly one retire
   * per task.
   * @param sessionID The parent session whose task retires.
   * @param s The parent's gate state (mutated: taskComplete).
   */
  function markTaskComplete(sessionID: string, s: GateState): void {
    if (s.taskComplete || s.activePlan === "") return
    s.taskComplete = true
    // The successor task must be able to nudge again: a retire clears the
    // per-kind dedupe latch exactly like a plan approval does (both retire
    // paths — the explicit marker and the gate flip — route here).
    clearIntentNudge(sessionID)
    journaler.journal({ type: "task-complete", sessionID, plan: s.activePlan })
  }

  /**
   * Explicit user retire (prompt channel): a `TASK DONE:` literal in the
   * user's own prompt retires the session's active task for the NEXT
   * admitted prompt (admission-only: child results and dispatch prompts
   * never retire a task). Read + capture in one guarded block; a coercion
   * that throws is journaled under the "task-done capture" key and swallowed
   * — fail-open.
   * @param sessionID The parent session the retire marker is scanned for.
   * @param properties The prompt payload to scan for the retire marker.
   */
  function captureTaskDone(sessionID: string, properties: PromptHookProperties): void {
    try {
      if (promptTextOf(properties).indexOf(config.taskDoneMarker) === -1) return
      markTaskComplete(sessionID, ledger.state(sessionID))
    } catch (e) {
      // Fail-open: the retire capture never blocks a prompt.
      journaler.journal({ type: "error", sessionID, error: `task-done capture: ${e}` })
    }
  }

  /**
   * Gate suspend/resume capture (prompt channel): scans the user's own prompt
   * for the configured `TURNSTILE OFF:` / `TURNSTILE ON:` literals (strict
   * `indexOf`, no near-miss admission) and applies the later-occurring
   * marker's action (last-wins). An OFF suspends enforcement for the session
   * (decisions keep computing and journaling, but deliberate blocks are
   * suppressed) and clears the gate state fresh; an ON resumes enforcement
   * and clears the state fresh too — no credit earned while suspended
   * rehydrates. A marker is refused when `allowSuspend` is false — BOTH the
   * OFF and the ON marker: the refusal
   * is journaled and a marker-style diagnostic is parked for surfacing, and
   * no state changes. Both markers are plain prompt literals, never
   * agent-relayed: only admitted user prompts reach this scanner.
   *
   * Capture ordering contract: this runs AFTER waiver/approval capture, so a
   * `PLAN APPROVED:` or `USER WAIVER:` in the same prompt as an allowed OFF
   * is captured and
   * then wiped by the fresh-start clear (the clear is authoritative). To keep
   * the journal honest (no captured-then-discarded waiver/approval row going
   * unexplained), the allowed-OFF branch journals a skip notice when the
   * prompt also carried the waiver or approval literal.
   *
   * Fail-open: a coercion that throws is journaled under the distinct
   * `suspend capture:` key and swallowed — never thrown at the host.
   * @param sessionID The parent session the markers are captured for.
   * @param properties The prompt payload to scan.
   */
  function captureSuspend(sessionID: string, properties: PromptHookProperties): void {
    try {
      const text = promptTextOf(properties)
      const atOff = text.indexOf(config.suspendMarker)
      const atOn = text.indexOf(config.resumeMarker)
      if (atOff === -1 && atOn === -1) return
      // Last-wins: the marker occurring later in the prompt decides.
      const resume = atOn !== -1 && (atOff === -1 || atOn > atOff)
      const action = resume ? "on" : "off"
      const marker = resume ? config.resumeMarker : config.suspendMarker
      if (!config.allowSuspend) {
        refuseSuspend(sessionID, action, marker)
        return
      }
      if (resume) {
        journaler.journal({ type: "suspended", sessionID, action: "on" })
        ledger.setSuspended(sessionID, false)
        // Fresh start: admission's `carryOrReset` already released the
        // registered children (and journaled any child-reset), so this clear
        // only wipes the bucket credit — no counter can free here.
        ledger.clearState(sessionID)
        return
      }
      applySuspendOff(sessionID, text)
    } catch (e) {
      // Fail-open: suspend capture never blocks a prompt.
      journaler.journal({ type: "error", sessionID, error: `suspend capture: ${e}` })
    }
  }

  /**
   * Refuses a suspend/resume marker under `allowSuspend:false`: journals the
   * refused entry (`refused:true`) and parks the marker-style near-miss
   * diagnostic for surfacing (the same diagnostic shape and channel as the
   * near-miss scanner) so the user learns the literal is disabled. Never
   * touches ledger state — a refused capture cannot wipe earned credit.
   * @param sessionID The parent session the marker was typed in.
   * @param action The refused action (`"off"` for the suspend marker, `"on"`
   *     for the resume marker).
   * @param marker The configured literal that was refused (surfaces in the
   *     diagnostic).
   */
  function refuseSuspend(sessionID: string, action: "off" | "on", marker: string): void {
    journaler.journal({ type: "suspended", sessionID, action, refused: true })
    const pending = nearMissPending.get(sessionID) ?? []
    pending.push({
      label: "suspend",
      // The seen token minus its trailing colon — the same colon-stripped
      // shape the near-miss scanner reports (the marker itself is
      // config-controlled, so a custom literal surfaces its own core).
      found: marker.replace(/:$/, ""),
      literal: marker,
    })
    nearMissPending.set(sessionID, pending)
    boundNearMissPending()
  }

  /**
   * Applies an allowed OFF: journals the suspension, marks the parent a live
   * parent, and clears the bucket state fresh (the clear is authoritative
   * over the waiver/approval captures above — same admission). For journal
   * honesty, a waiver or approval literal sharing the prompt is reported as a
   * skip notice: its capture was wiped by the clear, so the captured row must
   * not read as earned credit.
   * @param sessionID The parent session suspending.
   * @param text The prompt text (scanned for co-present waiver/approval
   *     literals).
   */
  function applySuspendOff(sessionID: string, text: string): void {
    journaler.journal({ type: "suspended", sessionID, action: "off" })
    for (const [marker, kind] of [
      [config.waiverMarker, "waiver"],
      [config.approvalMarker, "approval"],
    ] as const) {
      if (text.indexOf(marker) === -1) continue
      journaler.journal({
        type: "error",
        sessionID,
        error: `${kind} capture skipped: prompt also suspended the gate`,
      })
    }
    ledger.markParent(sessionID)
    // Fresh start: the clear is authoritative over the captures above
    // (same admission — `carryOrReset` already released the registered
    // children, so this clear only wipes the bucket credit).
    ledger.clearState(sessionID)
    ledger.setSuspended(sessionID, true)
  }

  /**
   * Near-miss marker scan (diagnostic-only): a prompt that mistypes the
   * waiver/approval literal (case, separator, or colon variant) admits nothing
   * — the strict `indexOf` capture is untouched — but is journaled as a
   * `marker`/`near-miss` entry and parked for surfacing so the model learns the
   * exact expected string instead of guessing. Only the matched token and the
   * configured literal are journaled, never the prompt text (redaction
   * contract, mirrors the bash `command` note). The distinct `marker near-miss:`
   * error key keeps the two existing fail-open tests (which filter by
   * `waiver capture:` / `approval capture:`) green on a hostile-getter prompt.
   * Fail-open: a coercion that throws is journaled and swallowed, never thrown
   * at the host.
   * @param sessionID The parent session the scan runs for.
   * @param properties The prompt payload to scan for near-miss markers.
   */
  function scanNearMisses(sessionID: string, properties: PromptHookProperties): void {
    try {
      const nearMissText = promptTextOf(properties)
      const hits = findMarkerNearMisses(nearMissText, [
        { literal: config.waiverMarker, label: "waiver" },
        { literal: config.approvalMarker, label: "plan approval" },
      ])
      if (hits.length > 0) {
        const pending = nearMissPending.get(sessionID) ?? []
        for (const hit of hits) {
          journaler.journal({
            type: "marker",
            event: "near-miss",
            sessionID,
            found: hit.found,
            literal: hit.literal,
          })
          pending.push(hit)
        }
        nearMissPending.set(sessionID, pending)
        boundNearMissPending()
      }
    } catch (e) {
      // Fail-open: the near-miss scan never blocks a prompt.
      journaler.journal({ type: "error", error: `marker near-miss: ${e}` })
    }
  }

  /**
   * Misconfiguration telemetry: if none of the three candidate text keys
   * (`text` / `prompt` / `prompt.text`) holds a non-empty string, the prompt
   * text is unresolvable (an empty `text` does not count — it cannot carry a
   * marker). Report the first such prompt once (keylessPrompts hits 1 exactly
   * once) so a host-shape change stays observable without journaling on every
   * prompt. An unreadable payload (a hostile getter) counts as unresolvable
   * and is swallowed — fail-open.
   * @param sessionID The session the unresolvable-text telemetry is journaled for.
   * @param properties The prompt payload whose text resolvability is probed.
   */
  function surfaceKeylessPrompt(sessionID: string, properties: PromptHookProperties): void {
    let unresolvable: boolean
    try {
      unresolvable = promptTextOf(properties) === ""
    } catch {
      unresolvable = true
    }
    if (unresolvable) {
      keylessPrompts++
      if (keylessPrompts === 1)
        journaler.journal({
          type: "error",
          sessionID,
          error:
            "waiver capture: neither prompt text key (text|prompt|prompt.text) is a string; does the host send the user prompt elsewhere?",
        })
    }
  }

  /**
   * Stamps a session's observe-mode admission phase and journals the
   * admission entry the first time the process sees it: the phase plus the
   * running period totals (every observe-mode entry carries both, so the
   * last stamped line restores the whole period at replay). Repeat
   * admissions of an already-stamped session journal nothing new. The
   * completing stamp — the session admitted past the period boundary, whose
   * phase is `enforce` — additionally arms the once-per-load
   * `[turnstile] observe:` summary block for the first string-output
   * delivery after it (see `surfaceObserveSummary`).
   * Fail-toward-enforce: any ledger throw is journaled and swallowed — a
   * broken observer must not disturb prompt admission, and the unstamped
   * session re-stamps (or fails the same way) on its next enforcement read,
   * where it fails toward enforce.
   * @param sessionID The admitted session to stamp.
   */
  function stampObserveAdmission(sessionID: string): void {
    try {
      const stamp = ledger.observePhase(sessionID)
      if (!stamp.isNew) return
      const phase: "observe" | "enforce" = stamp.phase === "observe" ? "observe" : "enforce"
      const counts = ledger.observeCounts()
      journaler.journal(observeEntry(sessionID, phase, counts.observed, counts.wouldBlocks))
      if (stamp.completed) observeSummaryPending = true
    } catch (e) {
      journaler.journal({ type: "error", sessionID, error: `observe admission stamp: ${e}` })
    }
  }

  /**
   * Admits one user-authored prompt: dedupes by the shared host message id,
   * surfaces the dead-channel telemetry once, then resets prior task scope
   * (carrying restart-sticky flags when continuation carry is armed), drops all
   * task-scoped dispatch state, and captures a waiver and/or approval marker
   * plus the gate suspend/resume markers (`TURNSTILE OFF:` / `TURNSTILE ON:`,
   * later-occurrence-wins) and the unresolvable-text telemetry. This is the single admission body,
   * reached either through the session prompt hook or the correlated inbox
   * stream; the caller dedupes by the shared host message id so one prompt is
   * admitted exactly once regardless of which signal arrives first. Reads only
   * — a transform hook mutates the host event in place host-side, so turnstile
   * must not mutate it.
   *
   * Fail-open: every read is guarded; a coercion that throws is journaled and
   * swallowed, never thrown at the host.
   * @param sessionID The (string) session the prompt is admitted for.
   * @param properties The prompt payload (hook shape or an inbox-derived
   *     `{ sessionID, text }`).
   * @param admissionID The shared host message id (`messageID`/`inboxID`), or
   *     "" to skip dedupe.
   */
  function admitPrompt(
    sessionID: string,
    properties: PromptHookProperties,
    admissionID: string,
  ): void {
    // Dedupe: the normal host sequence is hook-then-inbox on the same id, so
    // the other transport already admitted this prompt. An empty id has no
    // shared correlation key, so it never dedupes (documented double-arrival
    // edge, idempotent — any APPROVE replay restores the gate).
    if (admissionID !== "") {
      const dedupeKey = `${sessionID}:${admissionID}`
      if (admittedIds.has(dedupeKey)) return
      admittedIds.add(dedupeKey)
      boundAdmittedIds()
    }
    // Dead-channel surfacing: reaching here while the hook never fired means
    // the surface does not dispatch the prompt hook — capture is served by the
    // inbox stream. One-time, per plugin load.
    if (promptHookFires === 0 && !deadChannelSurfaced) {
      deadChannelSurfaced = true
      journaler.journal({
        type: "error",
        sessionID,
        error:
          "prompt channel: the session prompt hook never fired on this surface; prompt admission is served by the inbox event stream",
      })
    }
    // Task-scope decision first: a same-scope prompt (plan-bound, not
    // retired, continuation carry on) keeps every flag, waiver, counter, and
    // latch — the "chat resets everything" fix. A scope-changing prompt
    // resets (carrying restart-sticky flags when the carry is armed) and
    // drops the task-scoped dispatch state with it (`resetTaskScope`).
    carryOrReset(sessionID)
    stampObserveAdmission(sessionID)
    // Approval capture runs BEFORE the waiver capture so a waiver sharing the
    // prompt lands in the (possibly reset) new scope.
    captureApproval(sessionID, properties)
    captureWaiver(sessionID, properties)
    captureTaskDone(sessionID, properties)
    captureSuspend(sessionID, properties)
    scanNearMisses(sessionID, properties)
    surfaceKeylessPrompt(sessionID, properties)
    handlePromptIntent(sessionID, properties)
  }
  /**
   * Binds the host session API for the shared `resolveParent` helper.
   * @param session The live host session API.
   */
  function bindHost(session: Host["session"]): void {
    hostSession = session
  }

  /**
   * Increments the prompt-hook fire counter.
   */
  function bumpPromptFires(): void {
    promptHookFires++
  }

  /**
   * Returns the next task-delivery sequence number (post-increment).
   * @returns The new sequence number.
   */
  function nextTaskDeliverySeq(): number {
    return ++taskDeliverySeq
  }

  return {
    // deps
    config,
    journaler,
    gateRe,
    verdictRe,
    ledger,
    gates,
    toolPolicy,
    evidence,
    subagentNames,
    // maps
    nearMissPending,
    failedLookups,
    planReviewerDispatch,
    planReviewTarget,
    taskWindows,
    planGateAsks,
    awaitingPlanAsk,
    pendingLandingAsk,
    pendingHandsOnAsk,
    lastLandingEscalateAt,
    lastHandsOnEscalateAt,
    intentNudgePending,
    intentNudgedKinds,
    landingGateAsks,
    handsOnGateAsks,
    sessionDirs,
    deltaWindows,
    sessionAgents,
    admittedIds,
    summarizedSessions,
    // constants
    maxTrackedNearMiss,
    maxTrackedPlanAsks,
    awaitingPlanAskTtlMs,
    maxTrackedLandingAsks,
    pendingLandingAskTtlMs,
    maxTrackedHandsOnAsks,
    pendingHandsOnAskTtlMs,
    maxTrackedLandingGateAsks,
    maxTrackedHandsOnGateAsks,
    maxTrackedIntentNudges,
    maxLookupAttempts,
    maxTrackedLookups,
    maxTrackedSessionDirs,
    maxDeltaWindowChars,
    maxTrackedDeltaWindows,
    maxTrackedEmitters,
    maxTrackedAdmittedIds,
    LOOKUP_REASON_NOT_VISIBLE,
    LOOKUP_REASON_NO_PARENT_ID,
    // bounders
    boundNearMissPending,
    boundLookups,
    boundSessionDirs,
    boundDeltaWindows,
    boundDispatches,
    boundTargets,
    boundTaskWindows,
    boundPlanAsks,
    boundAwaitingAsks,
    boundLandingAsks,
    boundHandsOnAsks,
    boundLandingGateAsks,
    boundHandsOnGateAsks,
    boundIntentNudges,
    boundSessionAgents,
    boundAdmittedIds,
    boundSummarizedSessions,
    // services
    surfaceConfigWarnings,
    surfaceObserveSummary,
    hasMarker,
    recordDispatch,
    surfaceNearMissDiagnostics,
    seedEmitter,
    emitterAgent,
    reseedChildEdges,
    markerKindAllowed,
    hasLiveAwaitingAsk,
    hasLiveLandingAsk,
    hasLiveHandsOnAsk,
    currentProjectDir,
    resolveProjectDir,
    resolveParent,
    promoteOnEvidence,
    evidenceSearch,
    readBudgetKey,
    handleReadBudget,
    lastMatch,
    stampPlanApproval,
    planApprovalStampFields,
    discoverCandidates,
    plausibleUnresolved,
    mostRecentUnresolved,
    lookupDiag,
    journalPolicy,
    nameGuardSkips,
    injectOrchestratorPolicy,
    appendPipelineStatus,
    prependPolicy,
    prependIntentNudge,
    prependIntentNudgeRead,
    applyPolicyResult,
    attributePlanVerdict,
    creditReviewApproval,
    handleTaskDispatch,
    guardedTaskDispatch,
    handleBashDispatch,
    consumeHandsOnGrant,
    handleWriteEditDispatch,
    handleSessionMove,
    suspendBlock,
    parseMarkers,
    admitPrompt,
    // methods
    bindHost,
    bindToast,
    get toast(): typeof toast {
      return toast
    },
    bumpPromptFires,
    nextTaskDeliverySeq,
  }
}
