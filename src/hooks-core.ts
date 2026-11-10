/**
 * @fileoverview Shared hook state and services for turnstile's per-surface
 * hook modules. Composes the per-setup context from a `CoreState` object:
 * module-level builders construct the deps, bounded maps, constants, holders,
 * and bound helper fields; the concern modules (context-surface,
 * parent-resolution, verdict-capture, plan-verdict, dispatch-guard,
 * bash-write-guard, prompt-admission) are wired against that state; and
 * `coreContext` assembles the returned `TurnstileContext`. No hook bodies
 * live here; per-surface hook modules own their own registration bodies.
 */

import { evictTo } from "./bounded.ts"
import { loadConfig } from "./config.ts"
import { createJournaler, type Journaler } from "./journal.ts"
import {
  compileMarkerRegex,
  deltaWindowFloorChars,
  formatNearMissDiagnostics,
  GATE_RE,
  verdictResultOf,
  VERDICT_RE,
} from "./markers.ts"
import { BlockError, createGates, type EvidenceSearch, type Gates } from "./gates.ts"
import { wouldBlockEntry } from "./gates-common.ts"
import { createEvidenceTracker, type EvidenceTracker } from "./evidence.ts"
import { createOverrideAdjacency, type OverrideAdjacency } from "./override-adjacency.ts"
import { createToolPolicy, type ToolPolicy } from "./tool-policy.ts"
import { formatPipelineStatus } from "./state.ts"
import { classifyIntent, INTENT_KINDS, type IntentKind } from "./intent.ts"
import { engagementEntry, shouldEngage, type EngagementReason } from "./engagement.ts"
import { intentNudge, orchestratorPolicyFor } from "./policy.ts"
import { createLedger, type GateLedger } from "./ledger.ts"
import { createContextSurface, type ContextSurfaceFlags } from "./context-surface.ts"
import { createParentResolution } from "./parent-resolution.ts"
import { createVerdictCapture } from "./verdict-capture.ts"
import { createPlanVerdict } from "./plan-verdict.ts"
import { createDispatchGuard } from "./dispatch-guard.ts"
import { createBashWriteGuard } from "./bash-write-guard.ts"
import { createPromptAdmission, type PromptAdmissionFlags } from "./prompt-admission.ts"
import {
  asSessionID,
  mutateDeliveryText,
  prependDeliveryText,
  promptTextOf,
  type Delivery,
} from "./delivery.ts"
import type {
  ChildVerdict,
  GateState,
  Host,
  MarkerEvent,
  MarkerNearMiss,
  GenerateDraft,
  PromptHookProperties,
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

/** Cap on tracked per-child marker-retry counters (maxSessions scale). */
const MAX_TRACKED_MARKER_RETRIES = 64

/** Compliance reminder sent to a child whose delivery carried no marker. */
const MARKER_RETRY_PROMPT =
  "[turnstile] Your output was received but contained no `GATE:`/`VERDICT:` " +
  "marker. Restate your verdict using the required marker (GATE: PASS|FAIL " +
  "tests=<n> passed=<n> failed=<n> for the test-runner, VERDICT: APPROVE|BLOCK " +
  "crit=<n> high=<n> med=<n> low=<n> for the reviewer and plan-reviewer)."

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
   * called once per setup before hooks register (re-seed telemetry).
   * @returns The number of child edges restored.
   */
  reseedChildEdges(): number
  /** Gate decision service. */
  gates: Gates
  /** Tool policy (push-landing requirement, denylist, etc.). */
  toolPolicy: ToolPolicy
  /** Evidence tracker for plan-approval stamps. */
  evidence: EvidenceTracker
  /** In-memory child-write adjacency for prov:override capture; not persisted. */
  overrideAdjacency: OverrideAdjacency
  /** Resolves a session's registration status (pipeline-child exemption). */
  childStatus: ReturnType<typeof createParentResolution>["childStatus"]
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
  /** Parent → pending plan-impact advisory text awaiting the next delivery. */
  planImpactAdvisories: Map<string, string>
  /** Last-known project directory per session. */
  sessionDirs: Map<string, string>
  /** Child session ID → marker-retry attempts already used. */
  markerRetries: Map<string, number>
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
   * Journals the one-per-boot generation-draft telemetry row for a context or
   * generate hook fire (bounded, content-free descriptor).
   */
  observeRequestDraft(surface: "context" | "generate", draft: GenerateDraft): void
  /**
   * Injects the policy head and any pending intent nudge into a primary-turn
   * context draft's system array (parent-guarded, latched, fail-open).
   */
  injectContextPolicy(draft: GenerateDraft): void
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
  /**
   * Attempts one bounded compliance re-prompt for a bare-output child
   * delivery. Returns true only when the reminder was actually sent.
   */
  retryMarker(child: string, agent: string): Promise<boolean>
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
 * The shared per-setup state threaded through the hooks-core module functions:
 * the resolved deps, the bounded maps/sets, the constants, the mutable holders,
 * the concern objects, and every cross-concern helper as a bound function
 * field. Built once by {@link createCoreState}; never exported.
 */
interface CoreState {
  // deps
  policyText: string
  journaler: Journaler
  surfaceFlags: ContextSurfaceFlags
  gateRe: RegExp
  verdictRe: RegExp
  ledger: GateLedger
  nearMissPending: Map<string, MarkerNearMiss[]>
  maxTrackedNearMiss: number
  gates: Gates
  toolPolicy: ToolPolicy
  evidence: EvidenceTracker
  overrideAdjacency: OverrideAdjacency
  subagentNames: Set<string>
  failedLookups: Map<string, { attempts: number; reason: string }>
  lookupReasonNotVisible: string
  lookupReasonNoParentId: string
  planReviewerDispatch: Map<string, number>
  planReviewTarget: Map<string, string[]>
  taskWindows: Map<string, number>
  planGateAsks: Map<string, { sessionID: string; recordedAt: number }>
  maxTrackedPlanAsks: number
  awaitingPlanAsk: Map<string, number>
  awaitingPlanAskTtlMs: number
  pendingLandingAsk: Map<string, number>
  maxTrackedLandingAsks: number
  pendingLandingAskTtlMs: number
  landingGateAsks: Map<string, { sessionID: string; recordedAt: number }>
  maxTrackedLandingGateAsks: number
  pendingHandsOnAsk: Map<string, number>
  maxTrackedHandsOnAsks: number
  pendingHandsOnAskTtlMs: number
  lastLandingEscalateAt: Map<string, number>
  lastHandsOnEscalateAt: Map<string, number>
  handsOnGateAsks: Map<string, { sessionID: string; recordedAt: number }>
  maxTrackedHandsOnGateAsks: number
  intentNudgePending: Map<string, IntentKind>
  planImpactAdvisories: Map<string, string>
  intentNudgedKinds: Set<string>
  maxTrackedIntentNudges: number
  maxLookupAttempts: number
  maxTrackedLookups: number
  maxTrackedSessionDirs: number
  sessionDirs: Map<string, string>
  markerRetries: Map<string, number>
  deltaWindows: Map<string, string>
  maxDeltaWindowChars: number
  maxTrackedDeltaWindows: number
  sessionAgents: Map<string, string>
  maxTrackedEmitters: number
  admittedIds: Set<string>
  maxTrackedAdmittedIds: number
  summarizedSessions: Set<string>
  maintenanceCounts: Map<string, number>
  maxTrackedMaintenancePlans: number
  config: TurnstileConfig
  configWarnings: string[]
  // holders
  flags: ContextSurfaceFlags
  admissionFlags: PromptAdmissionFlags
  hostSessionRef: { current: Host["session"] | undefined }
  promptHookFires: { current: number }
  keylessPrompts: { current: number }
  taskDeliverySeq: { current: number }
  toast: {
    current:
      ((message: string, variant: "info" | "success" | "warning") => Promise<void>) | undefined
  }
  planVerdictRef: { current: ReturnType<typeof createPlanVerdict> | undefined }
  // concern objects
  contextSurface: ReturnType<typeof createContextSurface>
  parentResolution: ReturnType<typeof createParentResolution>
  verdictCapture: ReturnType<typeof createVerdictCapture>
  dispatchGuard: ReturnType<typeof createDispatchGuard>
  bashWriteGuard: ReturnType<typeof createBashWriteGuard>
  promptAdmission: ReturnType<typeof createPromptAdmission>
  planVerdict: ReturnType<typeof createPlanVerdict>
  // bound module functions + flattened concern methods
  surfaceConfigWarnings: ReturnType<typeof createContextSurface>["surfaceConfigWarnings"]
  surfaceObserveSummary: ReturnType<typeof createContextSurface>["surfaceObserveSummary"]
  observeRequestDraft: ReturnType<typeof createContextSurface>["observeRequestDraft"]
  injectContextPolicy: ReturnType<typeof createContextSurface>["injectContextPolicy"]
  boundSessionDirs: ReturnType<typeof createParentResolution>["boundSessionDirs"]
  seedEmitter: ReturnType<typeof createParentResolution>["seedEmitter"]
  reseedChildEdges: ReturnType<typeof createParentResolution>["reseedChildEdges"]
  emitterAgent: ReturnType<typeof createParentResolution>["emitterAgent"]
  childStatus: ReturnType<typeof createParentResolution>["childStatus"]
  markerKindAllowed: ReturnType<typeof createParentResolution>["markerKindAllowed"]
  currentProjectDir: ReturnType<typeof createParentResolution>["currentProjectDir"]
  resolveProjectDir: ReturnType<typeof createParentResolution>["resolveProjectDir"]
  resolveParent: ReturnType<typeof createParentResolution>["resolveParent"]
  parseMarkers: ReturnType<typeof createVerdictCapture>["parseMarkers"]
  lastMatch: ReturnType<typeof createVerdictCapture>["lastMatch"]
  handleTaskDispatch: ReturnType<typeof createDispatchGuard>["handleTaskDispatch"]
  guardedTaskDispatch: ReturnType<typeof createDispatchGuard>["guardedTaskDispatch"]
  allowDispatch: ReturnType<typeof createDispatchGuard>["allowDispatch"]
  handleBashDispatch: ReturnType<typeof createBashWriteGuard>["handleBashDispatch"]
  handleWriteEditDispatch: ReturnType<typeof createBashWriteGuard>["handleWriteEditDispatch"]
  handleSessionMove: ReturnType<typeof createBashWriteGuard>["handleSessionMove"]
  admitPrompt: ReturnType<typeof createPromptAdmission>["admitPrompt"]
  resetTaskScope: ReturnType<typeof createPromptAdmission>["resetTaskScope"]
  journalPlanApproval: ReturnType<typeof createPlanVerdict>["journalPlanApproval"]
  planApprovalStampFields: ReturnType<typeof createPlanVerdict>["planApprovalStampFields"]
  recordDurablePlanApproval: ReturnType<typeof createPlanVerdict>["recordDurablePlanApproval"]
  applyApprovalBinding: ReturnType<typeof createPlanVerdict>["applyApprovalBinding"]
  /** See {@link hasMarker}. */
  hasMarker(text: string): boolean
  /** See {@link recordDispatch}. */
  recordDispatch(sessionID: string, agent: string, description: string, blocked: boolean): void
  /** See {@link boundNearMissPending}. */
  boundNearMissPending(): void
  /** See {@link surfaceNearMissDiagnostics}. */
  surfaceNearMissDiagnostics(event: ToolHookEvent): void
  /** See {@link boundIntentNudges}. */
  boundIntentNudges(): void
  /** See {@link clearIntentNudge}. */
  clearIntentNudge(sessionID: string): void
  /** See {@link boundDeltaWindows}. */
  boundDeltaWindows(): void
  /** See {@link boundDispatches}. */
  boundDispatches(): void
  /** See {@link boundTargets}. */
  boundTargets(): void
  /** See {@link boundTaskWindows}. */
  boundTaskWindows(): void
  /** See {@link boundPlanAsks}. */
  boundPlanAsks(): void
  /** See {@link boundAwaitingAsks}. */
  boundAwaitingAsks(): void
  /** See {@link hasLiveAwaitingAsk}. */
  hasLiveAwaitingAsk(sid: string): boolean
  /** See {@link boundLandingAsks}. */
  boundLandingAsks(): void
  /** See {@link boundHandsOnAsks}. */
  boundHandsOnAsks(): void
  /** See {@link boundHandsOnGateAsks}. */
  boundHandsOnGateAsks(): void
  /** See {@link boundLandingGateAsks}. */
  boundLandingGateAsks(): void
  /** See {@link hasLiveLandingAsk}. */
  hasLiveLandingAsk(sid: string): boolean
  /** See {@link hasLiveHandsOnAsk}. */
  hasLiveHandsOnAsk(sid: string): boolean
  /** See {@link promoteOnEvidence}. */
  promoteOnEvidence(parent: string): void
  /** See {@link evidenceSearch}. */
  evidenceSearch(sid: string): EvidenceSearch
  /** See {@link readBudgetKey}. */
  readBudgetKey(sid: string): Promise<string>
  /** See {@link handleReadBudget}. */
  handleReadBudget(key: string): void
  /** See {@link discoverCandidates}. */
  discoverCandidates(sid: string): {
    edge: string[]
    unresolved: Array<{ child: string; verdict: ChildVerdict }>
  }
  /** See {@link plausibleUnresolved}. */
  plausibleUnresolved(
    sid: string,
    unresolved: Array<{ child: string; verdict: ChildVerdict }>,
  ): string[]
  /** See {@link mostRecentUnresolved}. */
  mostRecentUnresolved(children: string[]): string | undefined
  /** See {@link lookupDiag}. */
  lookupDiag(
    child: string,
    unresolved: string[],
  ): Record<string, { attempts: number; reason: string }>
  /** See {@link journalPolicy}. */
  journalPolicy(sessionID: string, injected: boolean, extra?: Record<string, unknown>): void
  /** See {@link nameGuardSkips}. */
  nameGuardSkips(event: ToolHookEvent, child: string): boolean
  /** See {@link injectOrchestratorPolicy}. */
  injectOrchestratorPolicy(
    event: ToolHookEvent,
    child: string,
    delivery: Delivery,
    agent: string,
  ): Promise<void>
  /** See {@link appendPipelineStatus}. */
  appendPipelineStatus(
    parent: string,
    event: ToolHookEvent,
    delivery: Extract<Delivery, { kind: "string" | "structured" }>,
    agent: string,
  ): void
  /** See {@link prependPolicy}. */
  prependPolicy(
    parent: string,
    event: ToolHookEvent,
    delivery: Extract<Delivery, { kind: "string" | "structured" }>,
  ): void
  /** See {@link applyPolicyResult}. */
  applyPolicyResult(parent: string, event: ToolHookEvent, delivery: Delivery, agent: string): void
  /** See {@link handlePromptIntent}. */
  handlePromptIntent(sessionID: string, properties: PromptHookProperties): void
  /** See {@link prependIntentNudge}. */
  prependIntentNudge(event: ToolHookEvent, parent: string, delivery: Delivery): void
  /** See {@link prependPlanImpactAdvisory}. */
  prependPlanImpactAdvisory(event: ToolHookEvent, parent: string, delivery: Delivery): void
  /** See {@link prependIntentNudgeRead}. */
  prependIntentNudgeRead(event: ToolHookEvent): void
  /** See {@link creditReviewApproval}. */
  creditReviewApproval(child: string, markerEvents: MarkerEvent[]): void
  /** See {@link attributeEdgeVerdict}. */
  attributeEdgeVerdict(sid: string, child: string, own: string): Promise<void>
  /** See {@link selectAttributedChild}. */
  selectAttributedChild(sid: string): AttributedChildDiscovery
  /** See {@link attributionEntry}. */
  attributionEntry(sid: string, child: string, d: AttributedChildDiscovery): Record<string, unknown>
  /** See {@link noteUnattributable}. */
  noteUnattributable(sid: string, poolSize: number): void
  /** See {@link attributePlanVerdict}. */
  attributePlanVerdict(child: string, output: string): Promise<void>
  /** See {@link observeActive}. */
  observeActive(sessionID: string): boolean
  /** See {@link enforcementArmed}. */
  enforcementArmed(sessionID: string): boolean
  /** See {@link journalEngagement}. */
  journalEngagement(sessionID: string, engaged: boolean, reason: EngagementReason): void
  /** See {@link suspendSuppressionActive}. */
  suspendSuppressionActive(sessionID: string): boolean
  /** See {@link journalSuspendedWouldBlock}. */
  journalSuspendedWouldBlock(sessionID: string, cause: string): void
  /** See {@link suspendDispatchOutcome}. */
  suspendDispatchOutcome(
    e: BlockError,
    sessionID: string,
    agent: string,
    description: string,
    waived: boolean,
  ): boolean
  /** See {@link blockCause}. */
  blockCause(e: BlockError, agent: string): string
  /** See {@link dispatchBlockOutcome}. */
  dispatchBlockOutcome(
    e: unknown,
    sessionID: string,
    agent: string,
    description: string,
    waived: boolean,
  ): boolean
  /** See {@link armLandingAsk}. */
  armLandingAsk(parent: string): boolean
  /** See {@link armHandsOnAsk}. */
  armHandsOnAsk(parent: string): boolean
  /** See {@link suspendBlock}. */
  suspendBlock(event: ToolHookEvent, e: BlockError): boolean
  /** See {@link boundAdmittedIds}. */
  boundAdmittedIds(): void
  /** See {@link boundSummarizedSessions}. */
  boundSummarizedSessions(): void
  /** See {@link boundMaintenanceCounts}. */
  boundMaintenanceCounts(): void
  /** See {@link bindToast}. */
  bindToast(show: ToastShow | undefined): void
  /** See {@link markTaskComplete}. */
  markTaskComplete(sessionID: string, s: GateState): void
  /**
   * Retires the parent's task unconditionally — the planless-tolerant retire
   * used when no plan is bound; see {@link markTaskComplete} for the
   * plan-bound form.
   */
  retireTask(sessionID: string, s: GateState): void
  /** See {@link bindHost}. */
  bindHost(session: Host["session"]): void
  /** See {@link noteRetrySkipped}. */
  noteRetrySkipped(
    child: string,
    agent: string,
    used: number,
    outcome: "exhausted" | "skipped-no-api",
  ): false
  /** See {@link retryMarker}. */
  retryMarker(child: string, agent: string): Promise<boolean>
  /** See {@link bumpPromptFires}. */
  bumpPromptFires(): void
  /** See {@link nextTaskDeliverySeq}. */
  nextTaskDeliverySeq(): number
}

type AttributedChildDiscovery = {
  edgeCount: number
  unresolvedCount: number
  plausibleCount: number
  unresolvedIDs: string[]
  attributed: string | undefined
  decision: "attributed" | "fail-open"
  poolSize: number
}

function hasMarker(st: CoreState, text: string): boolean {
  return (text.match(st.gateRe)?.length ?? 0) > 0 || (text.match(st.verdictRe)?.length ?? 0) > 0
}

function recordDispatch(
  st: CoreState,
  sessionID: string,
  agent: string,
  description: string,
  blocked: boolean,
): void {
  st.journaler.journal({
    type: "dispatch",
    sessionID,
    agent,
    description,
    ...(blocked ? { blocked: true } : {}),
  })
  st.journaler.traceEvent("orchestrator", "dispatch", `task -> ${agent}`, sessionID)
}

function boundNearMissPending(st: CoreState): void {
  evictTo(st.nearMissPending, st.maxTrackedNearMiss)
}

function surfaceNearMissDiagnostics(st: CoreState, event: ToolHookEvent): void {
  const sessionID = st.ledger.parentOf(asSessionID(event?.sessionID))
  const hits = st.nearMissPending.get(sessionID)
  if (!hits || hits.length === 0) return
  if (!event?.result || typeof event.result.output !== "string") return
  try {
    event.result.output =
      formatNearMissDiagnostics(hits, st.journaler.journalPath) + "\n" + event.result.output
    st.nearMissPending.delete(sessionID)
    st.journaler.journal({
      type: "marker",
      event: "surfaced",
      sessionID,
      surfaced: true,
      count: hits.length,
    })
  } catch (e) {
    st.journaler.journal({
      type: "marker",
      event: "surfaced",
      sessionID,
      surfaced: false,
      count: hits.length,
      error: String(e),
    })
  }
}

function boundIntentNudges(st: CoreState): void {
  evictTo(st.intentNudgedKinds, st.maxTrackedIntentNudges)
  evictTo(st.intentNudgePending, st.config.maxSessions)
  evictTo(st.planImpactAdvisories, st.config.maxSessions)
}

function clearIntentNudge(st: CoreState, sessionID: string): void {
  st.intentNudgePending.delete(sessionID)
  for (const kind of INTENT_KINDS) {
    st.intentNudgedKinds.delete(`${sessionID}:${kind}`)
  }
}

function boundDeltaWindows(st: CoreState): void {
  evictTo(st.deltaWindows, st.maxTrackedDeltaWindows)
}

function boundDispatches(st: CoreState): void {
  evictTo(st.planReviewerDispatch, st.maxTrackedLookups)
}

function boundTargets(st: CoreState): void {
  evictTo(st.planReviewTarget, st.maxTrackedLookups)
}

function boundTaskWindows(st: CoreState): void {
  evictTo(st.taskWindows, st.maxTrackedLookups)
}

function boundPlanAsks(st: CoreState): void {
  evictTo(st.planGateAsks, st.maxTrackedPlanAsks)
}

function boundAwaitingAsks(st: CoreState): void {
  evictTo(st.awaitingPlanAsk, st.maxTrackedPlanAsks)
}

function hasLiveAwaitingAsk(st: CoreState, sid: string): boolean {
  const at = st.awaitingPlanAsk.get(sid)
  if (at === undefined) return false
  if (Date.now() - at > st.awaitingPlanAskTtlMs) {
    st.awaitingPlanAsk.delete(sid)
    return false
  }
  return true
}

function boundLandingAsks(st: CoreState): void {
  evictTo(st.pendingLandingAsk, st.maxTrackedLandingAsks)
  evictTo(st.lastLandingEscalateAt, st.maxTrackedLandingAsks)
}

function boundHandsOnAsks(st: CoreState): void {
  evictTo(st.pendingHandsOnAsk, st.maxTrackedHandsOnAsks)
  evictTo(st.lastHandsOnEscalateAt, st.maxTrackedHandsOnAsks)
}

function boundHandsOnGateAsks(st: CoreState): void {
  evictTo(st.handsOnGateAsks, st.maxTrackedHandsOnGateAsks)
}

function boundLandingGateAsks(st: CoreState): void {
  evictTo(st.landingGateAsks, st.maxTrackedLandingGateAsks)
}

function hasLiveLandingAsk(st: CoreState, sid: string): boolean {
  const at = st.pendingLandingAsk.get(sid)
  if (at === undefined) return false
  if (Date.now() - at > st.pendingLandingAskTtlMs) {
    st.pendingLandingAsk.delete(sid)
    // Mirror the expiry on the dedupe map too: a stale timestamp must not
    // suppress a legitimate new ask row after the latch expired.
    st.lastLandingEscalateAt.delete(sid)
    return false
  }
  return true
}

function hasLiveHandsOnAsk(st: CoreState, sid: string): boolean {
  const at = st.pendingHandsOnAsk.get(sid)
  if (at === undefined) return false
  if (Date.now() - at > st.pendingHandsOnAskTtlMs) {
    st.pendingHandsOnAsk.delete(sid)
    // Mirror the expiry on the dedupe map too: a stale timestamp must not
    // suppress a legitimate new ask row after the latch expired.
    st.lastHandsOnEscalateAt.delete(sid)
    return false
  }
  return true
}

function promoteOnEvidence(st: CoreState, parent: string): void {
  const ps = st.ledger.peek(parent)
  if (ps && ps.unverifiedPass && st.evidence.has(parent, st.taskWindows.get(parent) ?? 0)) {
    ps.hasGatePass = true
    ps.unverifiedPass = ""
    st.journaler.journal({
      type: "gate",
      sessionID: parent,
      result: "PASS",
      event: "promoted",
      verified: true,
      mode: st.config.gateEvidence,
      ...(ps.taskFingerprint !== "" ? { fp: ps.taskFingerprint } : {}),
    })
    // The gate's green flip is the task's completion boundary:
    // the flip journals its task-complete companion row and stamps the
    // retire, so the next admitted prompt starts a fresh scope.
    st.markTaskComplete(parent, ps)
    st.journaler.traceEvent("test-runner", "gate", "GATE: PASS promoted on evidence", parent)
  }
}

function evidenceSearch(st: CoreState, sid: string): EvidenceSearch {
  const window = st.taskWindows.get(sid) ?? 0
  const attributed: string[] = []
  const unresolved: Array<{ session: string; reason: string }> = []
  let direct = false
  for (const { session, last } of st.evidence.snapshot()) {
    if (session === sid) {
      direct = last >= window
      continue
    }
    const parent = st.ledger.parentOf(session)
    if (parent === sid) {
      // In-window attributed hits were already promoted (the decision-time
      // re-check ran first), so only stale ones reach a refusal.
      if (last < window) attributed.push(session)
      continue
    }
    unresolved.push({
      session,
      reason: st.ledger.childToParent.has(session) ? `edge: ${parent}` : "no parent edge",
    })
  }
  return { attributed, unresolved, direct }
}

async function readBudgetKey(st: CoreState, sid: string): Promise<string> {
  await st.resolveParent(sid)
  const key = st.ledger.parentOf(sid)
  if (key === sid) {
    // Byte-identical read: reads the attempts count off the
    // structured record; the gate (`attempts > 0 && attempts < max`) is
    // unchanged, so this signal is byte-identical to the pre-enrichment form.
    const attempts = st.failedLookups.get(sid)?.attempts ?? 0
    // Inconclusive window only: a lookup was tried and the record was not yet
    // visible (attempts climb 1..max-1). Zero means no host session API
    // (never knowable); at the cap means a resolved parent-less root. Bounded
    // to ≤ maxLookupAttempts-1 signals per session.
    if (attempts > 0 && attempts < st.maxLookupAttempts) {
      st.journaler.journal({
        type: "error",
        sessionID: sid,
        error: `read budget keyed by session; parent unresolved after ${attempts}/${st.maxLookupAttempts} lookup attempt(s)`,
      })
    }
  }
  return key
}

function handleReadBudget(st: CoreState, key: string): void {
  // Dormant-until-engaged: the whole-file read horizon sleeps until the
  // parent engages.
  if (!st.enforcementArmed(key)) return
  try {
    st.gates.guardReadLimit(key, st.ledger)
  } catch (e) {
    if (e instanceof BlockError && st.observeActive(key)) {
      const totals = st.ledger.noteWouldBlock(key)
      st.journaler.journal(wouldBlockEntry(key, "read-budget", totals.observed, totals.wouldBlocks))
      return
    }
    if (e instanceof BlockError && st.suspendSuppressionActive(key)) {
      st.journalSuspendedWouldBlock(key, "read-budget")
      return
    }
    throw e
  }
}

function discoverCandidates(
  st: CoreState,
  sid: string,
): {
  edge: string[]
  unresolved: Array<{ child: string; verdict: ChildVerdict }>
} {
  const edge: string[] = []
  for (const c of st.ledger.childToParent.keys()) {
    if (st.ledger.childToParent.get(c) === sid && st.ledger.childVerdict(c).marker !== "")
      edge.push(c)
  }
  return {
    edge,
    unresolved: st.ledger.evidencedChildren().filter(({ child }) => child !== sid),
  }
}

function plausibleUnresolved(
  st: CoreState,
  sid: string,
  unresolved: Array<{ child: string; verdict: ChildVerdict }>,
): string[] {
  const dispatchTs = st.planReviewerDispatch.get(sid)
  if (dispatchTs === undefined) return []
  const out: string[] = []
  for (const { child, verdict } of unresolved) {
    if (verdict.recordedAt < dispatchTs) continue
    // Unique-owner: another parent dispatched at-or-before this verdict's
    // recordedAt ⇒ ambiguous ⇒ excluded (never-guess).
    let ambiguous = false
    for (const [other, ts] of st.planReviewerDispatch) {
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

function mostRecentUnresolved(st: CoreState, children: string[]): string | undefined {
  let best: string | undefined
  let bestAt = -1
  for (const c of children) {
    const at = st.ledger.childVerdict(c).recordedAt
    if (at > bestAt) {
      bestAt = at
      best = c
    }
  }
  return best
}

function lookupDiag(
  st: CoreState,
  child: string,
  unresolved: string[],
): Record<string, { attempts: number; reason: string }> {
  const out: Record<string, { attempts: number; reason: string }> = {}
  for (const s of [child, ...unresolved])
    out[s] = {
      attempts: st.failedLookups.get(s)?.attempts ?? 0,
      reason: st.failedLookups.get(s)?.reason ?? "resolved-or-never-tried",
    }
  return out
}

function journalPolicy(
  st: CoreState,
  sessionID: string,
  injected: boolean,
  extra: Record<string, unknown> = {},
): void {
  st.journaler.journal({ type: "policy", sessionID, injected, ...extra })
}

function nameGuardSkips(st: CoreState, event: ToolHookEvent, child: string): boolean {
  if (st.ledger.childToParent.has(child)) return false
  const knownName = typeof event.agent === "string" && st.subagentNames.has(event.agent)
  if (knownName) st.journalPolicy(child, false, { skipped: true, reason: "agent-name" })
  return knownName
}

async function injectOrchestratorPolicy(
  st: CoreState,
  event: ToolHookEvent,
  child: string,
  delivery: Delivery,
  agent: string,
): Promise<void> {
  // Close the late-edge window for background dispatches before deciding:
  // idempotent (early-returns on a registered edge) and bounded by the
  // failedLookups retry cap, so the await is cheap on the common path.
  await st.resolveParent(child)
  const parent = st.ledger.parentOf(child)
  // Name guard first: a child-facing delivery the guard skips (unresolvable
  // edge + config-known subagent name) returns here and never receives the
  // parent-addressed nudge text below.
  if (delivery.kind !== "structured" && st.nameGuardSkips(event, child)) return
  // Advisory intent nudge: independent of the policy head, delivered on the
  // first classified parent-facing delivery after admission.
  st.prependIntentNudge(event, parent, delivery)
  st.prependPlanImpactAdvisory(event, parent, delivery)
  st.applyPolicyResult(parent, event, delivery, agent)
}

function appendPipelineStatus(
  st: CoreState,
  parent: string,
  event: ToolHookEvent,
  delivery: Extract<Delivery, { kind: "string" | "structured" }>,
  agent: string,
): void {
  const line = formatPipelineStatus(st.ledger.state(parent), st.config.agents, agent)
  if (line === "") return
  try {
    mutateDeliveryText(event, delivery, (text) => text + "\n" + line, "append")
  } catch (e) {
    st.journaler.journal({ type: "error", error: `pipeline-status: ${e}` })
  }
}

function prependPolicy(
  st: CoreState,
  parent: string,
  event: ToolHookEvent,
  delivery: Extract<Delivery, { kind: "string" | "structured" }>,
): void {
  // Dormant-until-engaged: a dormant session's deliveries stay clean — the
  // policy head lands only once enforcement is armed.
  if (!st.enforcementArmed(parent)) return
  const policyState = st.ledger.state(parent)
  if (policyState.policyInjected) return
  try {
    prependDeliveryText(event, delivery, st.policyText)
    policyState.policyInjected = true
    st.journalPolicy(parent, true)
  } catch (e) {
    st.journalPolicy(parent, false, { error: String(e) })
  }
}

function applyPolicyResult(
  st: CoreState,
  parent: string,
  event: ToolHookEvent,
  delivery: Delivery,
  agent: string,
): void {
  if (delivery.kind === "absent") return
  if (delivery.kind === "unknown") {
    st.journalPolicy(parent, false, { reason: "unknown-shape", shape: delivery.shape })
    return
  }
  st.appendPipelineStatus(parent, event, delivery, agent)
  st.prependPolicy(parent, event, delivery)
}

function handlePromptIntent(
  st: CoreState,
  sessionID: string,
  properties: PromptHookProperties,
): void {
  if (!st.config.intentNudge) return
  try {
    const kind = classifyIntent(promptTextOf(properties))
    if (kind === null) return
    // Engagement replaced the nudge for the engaging kinds: a dispatch or
    // plan-reference prompt journals its intent row but never nudges (the
    // pipeline is armed instead) — consistently, regardless of
    // `alwaysEnforce`. Issue/work intents keep the one-shot advisory
    // nudge: that is dormant mode's one-time hint.
    if (shouldEngage(kind)) {
      st.journaler.journal({ type: "intent", sessionID, kind })
      return
    }
    if (st.ledger.state(sessionID).hasPlanVerdict) return
    st.journaler.journal({ type: "intent", sessionID, kind })
    const key = `${sessionID}:${kind}`
    if (st.intentNudgedKinds.has(key)) return
    st.intentNudgedKinds.add(key)
    st.intentNudgePending.set(sessionID, kind)
    st.boundIntentNudges()
  } catch (e) {
    st.journaler.journal({ type: "error", sessionID, error: `intent classification: ${e}` })
  }
}

function prependIntentNudge(
  st: CoreState,
  event: ToolHookEvent,
  parent: string,
  delivery: Delivery,
): void {
  if (delivery.kind !== "string" && delivery.kind !== "structured") return
  const kind = st.intentNudgePending.get(parent)
  if (kind === undefined) return
  st.intentNudgePending.delete(parent)
  try {
    prependDeliveryText(event, delivery, intentNudge(kind))
  } catch (e) {
    st.journaler.journal({ type: "error", sessionID: parent, error: `intent nudge: ${e}` })
  }
}

function prependPlanImpactAdvisory(
  st: CoreState,
  event: ToolHookEvent,
  parent: string,
  delivery: Delivery,
): void {
  if (delivery.kind !== "string" && delivery.kind !== "structured") return
  const text = st.planImpactAdvisories.get(parent)
  if (text === undefined) return
  st.planImpactAdvisories.delete(parent)
  try {
    prependDeliveryText(event, delivery, text)
  } catch (e) {
    st.journaler.journal({ type: "error", sessionID: parent, error: `plan-impact advisory: ${e}` })
  }
}

function prependIntentNudgeRead(st: CoreState, event: ToolHookEvent): void {
  const raw = asSessionID(event?.sessionID)
  const parent = st.ledger.parentOf(raw)
  if (parent !== raw) return
  const kind = st.intentNudgePending.get(parent)
  if (kind === undefined) return
  if (!event?.result || typeof event.result.output !== "string") return
  st.intentNudgePending.delete(parent)
  try {
    event.result.output = `${intentNudge(kind)}\n${event.result.output}`
  } catch (e) {
    st.journaler.journal({ type: "error", sessionID: parent, error: `intent nudge: ${e}` })
  }
}

function creditReviewApproval(st: CoreState, child: string, markerEvents: MarkerEvent[]): void {
  if (
    !markerEvents.some(
      (e) => e.kind === "verdict" && verdictResultOf(e.marker, st.verdictRe) === "APPROVE",
    )
  )
    return
  const parent = st.ledger.parentOf(child)
  if (!st.gates.reviewEnsembleComplete(parent, st.ledger)) return
  st.ledger.state(parent).hasReviewApprove = true
  // Credit the bucket-free trace too: the flag above dies on the landing
  // prompt's reset, but the journaled APPROVE outlives it — the trace is
  // what the landing gate reads to escalate the first push instead of
  // throwing the misleading `no-landing-approval` block.
  st.ledger.markCreditedApproval(parent)
}

async function attributeEdgeVerdict(
  st: CoreState,
  sid: string,
  child: string,
  own: string,
): Promise<void> {
  const rec = st.ledger.childVerdict(child)
  const marker = own || rec.marker
  const markerSource = own ? "task-result" : rec.source || "task-result"
  const result = verdictResultOf(marker, st.verdictRe)
  await st.journalPlanApproval(
    sid,
    child,
    result,
    marker || "<none>",
    markerSource,
    marker || "<no verdict marker>",
  )
}

function selectAttributedChild(st: CoreState, sid: string): AttributedChildDiscovery {
  const { edge, unresolved } = st.discoverCandidates(sid)
  const unresolvedIDs = unresolved.map(({ child: cid }) => cid)
  const plausible = st.plausibleUnresolved(sid, unresolved)
  const dispatchTs = st.planReviewerDispatch.get(sid)
  const edgeCandidates =
    dispatchTs === undefined
      ? edge
      : edge.filter((c) => st.ledger.childVerdict(c).recordedAt >= dispatchTs)
  const pool = [...edgeCandidates, ...plausible]
  const verdictOf = (c: string): "APPROVE" | "BLOCK" =>
    verdictResultOf(st.ledger.childVerdict(c).marker, st.verdictRe)
  const unanimous = new Set(pool.map(verdictOf))
  const attributed =
    pool.length > 0 && unanimous.size === 1
      ? (edgeCandidates[0] ?? st.mostRecentUnresolved(plausible))
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

function attributionEntry(
  st: CoreState,
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
    sessionApi: typeof st.hostSessionRef.current?.get === "function",
    candidates: {
      edge: d.edgeCount,
      unresolved: d.unresolvedCount,
      plausible: d.plausibleCount,
    },
    unresolvedIDs: d.unresolvedIDs,
    lookup: st.lookupDiag(child, d.unresolvedIDs),
  }
}

function noteUnattributable(st: CoreState, sid: string, poolSize: number): void {
  st.journaler.journal({
    type: "error",
    sessionID: sid,
    error: `plan attribution: unattributable parent-keyed delivery; gate unchanged (${poolSize} evidenced candidates)`,
  })
}

async function attributePlanVerdict(st: CoreState, child: string, output: string): Promise<void> {
  const sid = st.ledger.parentOf(child)
  const own = st.lastMatch(output, st.verdictRe)
  // Edge-resolved: attribute through the child directly, delivery-wins merge.
  if (st.ledger.childToParent.has(child)) {
    await st.attributeEdgeVerdict(sid, child, own)
    return
  }
  // Self-keyed: the delivery's own session id is not a registered child.
  const d = st.selectAttributedChild(sid)
  // Journal the forensic entry first (before any gate mutation). A new journal
  // type is replay-inert; its wording avoids "unattributable" so the
  // single-error count is stable.
  st.journaler.journal(st.attributionEntry(sid, child, d))
  if (d.attributed) {
    const rec = st.ledger.childVerdict(d.attributed)
    // Attributed candidates are evidenced (a non-empty stored marker and a
    // non-empty source label), so marker needs no "<none>" fallback here —
    // the edge-resolved branch above keeps its fallback for marker-less
    // deliveries.
    const marker = own || rec.marker
    const markerSource = own ? "task-result" : rec.source
    const result = verdictResultOf(marker, st.verdictRe)
    await st.journalPlanApproval(sid, d.attributed, result, marker, markerSource, marker)
    return
  }
  st.noteUnattributable(sid, d.poolSize)
}

function observeActive(st: CoreState, sessionID: string): boolean {
  try {
    return st.ledger.observePhase(sessionID).phase === "observe"
  } catch (e) {
    st.journaler.journal({ type: "error", sessionID, error: `observe phase read: ${e}` })
    return false
  }
}

function enforcementArmed(st: CoreState, sessionID: string): boolean {
  if (st.config.alwaysEnforce) return true
  try {
    return st.ledger.state(st.ledger.parentOf(sessionID)).engaged
  } catch (e) {
    st.journaler.journal({ type: "error", sessionID, error: `engagement read: ${e}` })
    return false
  }
}

function journalEngagement(
  st: CoreState,
  sessionID: string,
  engaged: boolean,
  reason: EngagementReason,
): void {
  st.journaler.journal(engagementEntry(sessionID, engaged, reason))
}

function suspendSuppressionActive(st: CoreState, sessionID: string): boolean {
  try {
    return st.ledger.isSuspended(st.ledger.parentOf(sessionID))
  } catch (e) {
    st.journaler.journal({ type: "error", sessionID, error: `suspension read: ${e}` })
    return false
  }
}

function journalSuspendedWouldBlock(st: CoreState, sessionID: string, cause: string): void {
  st.journaler.journal({
    type: "suspended",
    sessionID,
    event: "would-block",
    cause: cause.slice(0, 200),
  })
}

function suspendDispatchOutcome(
  st: CoreState,
  e: BlockError,
  sessionID: string,
  agent: string,
  description: string,
  waived: boolean,
): boolean {
  if (!st.suspendSuppressionActive(sessionID)) return false
  st.journalSuspendedWouldBlock(sessionID, st.blockCause(e, agent))
  st.allowDispatch(sessionID, agent, description, waived)
  return true
}

function blockCause(st: CoreState, e: BlockError, agent: string): string {
  return e.cause ?? (agent || "gate")
}

function dispatchBlockOutcome(
  st: CoreState,
  e: unknown,
  sessionID: string,
  agent: string,
  description: string,
  waived: boolean,
): boolean {
  if (!(e instanceof BlockError)) return false
  if (st.observeActive(sessionID)) {
    const cause = st.blockCause(e, agent)
    const totals = st.ledger.noteWouldBlock(sessionID)
    st.journaler.journal(wouldBlockEntry(sessionID, cause, totals.observed, totals.wouldBlocks))
    st.allowDispatch(sessionID, agent, description, waived)
    return true
  }
  if (st.suspendDispatchOutcome(e, sessionID, agent, description, waived)) return true
  st.recordDispatch(sessionID, agent, description, true)
  return false
}

function armLandingAsk(st: CoreState, parent: string): boolean {
  const now = Date.now()
  const last = st.lastLandingEscalateAt.get(parent)
  st.pendingLandingAsk.set(parent, now)
  st.boundLandingAsks()
  if (last !== undefined && now - last < askLatchTtlMs) return false
  st.lastLandingEscalateAt.set(parent, now)
  st.boundLandingAsks()
  return true
}

function armHandsOnAsk(st: CoreState, parent: string): boolean {
  const now = Date.now()
  const last = st.lastHandsOnEscalateAt.get(parent)
  st.pendingHandsOnAsk.set(parent, now)
  st.boundHandsOnAsks()
  if (last !== undefined && now - last < askLatchTtlMs) return false
  st.lastHandsOnEscalateAt.set(parent, now)
  st.boundHandsOnAsks()
  return true
}

function suspendBlock(st: CoreState, event: ToolHookEvent, e: BlockError): boolean {
  const parent = st.ledger.parentOf(asSessionID(event?.sessionID))
  if (!st.suspendSuppressionActive(parent)) return false
  st.journalSuspendedWouldBlock(parent, st.blockCause(e, ""))
  return true
}

function boundAdmittedIds(st: CoreState): void {
  evictTo(st.admittedIds, st.maxTrackedAdmittedIds)
}

function boundSummarizedSessions(st: CoreState): void {
  evictTo(st.summarizedSessions, st.config.maxSessions)
}

function boundMaintenanceCounts(st: CoreState): void {
  evictTo(st.maintenanceCounts, st.maxTrackedMaintenancePlans)
}

function bindToast(st: CoreState, show: ToastShow | undefined): void {
  st.toast.current =
    typeof show === "function"
      ? async (message: string, variant: "info" | "success" | "warning"): Promise<void> => {
          await show({ message, variant })
        }
      : undefined
}

function retireTaskBody(st: CoreState, sessionID: string, s: GateState): void {
  s.taskComplete = true
  // Dormant-until-engaged: a retired task sleeps the pipeline again.
  if (s.engaged) {
    s.engaged = false
    st.journalEngagement(sessionID, false, "task-complete")
  }
  // The successor task must be able to nudge again: a retire clears the
  // per-kind dedupe latch exactly like a plan approval does (all retire
  // paths — the explicit marker, the gate flip, and the plan-review
  // reject — route here).
  st.clearIntentNudge(sessionID)
  st.journaler.journal({ type: "task-complete", sessionID, plan: s.activePlan })
}

function markTaskComplete(st: CoreState, sessionID: string, s: GateState): void {
  if (s.taskComplete || s.activePlan === "") return
  retireTaskBody(st, sessionID, s)
}

function bindHost(st: CoreState, session: Host["session"]): void {
  st.hostSessionRef.current = session
}

function noteRetrySkipped(
  st: CoreState,
  child: string,
  agent: string,
  used: number,
  outcome: "exhausted" | "skipped-no-api",
): false {
  st.journaler.journal({ type: "marker-retry", sessionID: child, agent, attempt: used, outcome })
  return false
}

async function retryMarker(st: CoreState, child: string, agent: string): Promise<boolean> {
  if (st.config.agentMarkerRetry === 0) return false
  const used = st.markerRetries.get(child) ?? 0
  if (used >= st.config.agentMarkerRetry)
    return st.noteRetrySkipped(child, agent, used, "exhausted")
  if (typeof st.hostSessionRef.current?.prompt !== "function")
    return st.noteRetrySkipped(child, agent, used, "skipped-no-api")
  st.journaler.journal({
    type: "marker-retry",
    sessionID: child,
    agent,
    attempt: used,
    outcome: "prompted",
  })
  st.markerRetries.set(child, used + 1)
  evictTo(st.markerRetries, MAX_TRACKED_MARKER_RETRIES)
  try {
    await st.hostSessionRef.current.prompt({ sessionID: child, text: MARKER_RETRY_PROMPT })
  } catch (e) {
    st.journaler.journal({ type: "error", error: `marker-retry prompt failed: ${String(e)}` })
    return false
  }
  return true
}

function bumpPromptFires(st: CoreState): void {
  st.promptHookFires.current++
}

function nextTaskDeliverySeq(st: CoreState): number {
  return ++st.taskDeliverySeq.current
}

function buildCoreConfig(opts: TurnstileOptions, st: CoreState): void {
  const env = opts.env ?? process.env
  const { config, warnings: configWarnings } = loadConfig(env, opts.config)
  st.config = config
  st.configWarnings = configWarnings
  // The policy head is built once per plugin load from the resolved config so
  // the injected prose (caps, markers, journal paths) matches the mechanical
  // enforcement; it is constant for the load's lifetime.
  st.policyText = orchestratorPolicyFor(st.config)
}

function buildCoreJournaler(st: CoreState): void {
  // Per-session sink routing resolves through the ledger's parent map. The
  // resolver closure reads `ledger` before its declaration line, but it only
  // fires once hooks run — after `createHooksCore` finished constructing both
  // the journaler and the ledger. `parentOf` returns the session itself for
  // unregistered parents (a parent's own entries → its own file) and falls
  // back to the session when a child's edge is not yet resolved; both files
  // are read by replay, so nothing is lost.
  st.journaler = createJournaler({
    metricsDir: st.config.metricsDir,
    trace: st.config.trace,
    maxBytes: st.config.journalMaxBytes,
    maxGenerations: st.config.journalMaxGenerations,
    rotateEveryEntries: st.config.journalRotateEveryEntries,
    perSession: st.config.journalPerSession,
    sinkFor: (sessionID) => st.ledger.parentOf(sessionID),
  })
}

function buildCoreRegexes(st: CoreState): void {
  // Surfaces unresolved config-validation warnings once per plugin load by
  // prepending a `[turnstile] config:` block to the first tool result with
  // string output — from any session, primary or child — the model-facing
  // channel proven by the policy injection and the read-budget prefix.
  // Fail-open: a throwing mutation journals
  // `{type:"config", surfaced:false}` and never blocks the tool; the journal
  // already carries every warning (loadConfig journaled them), so this entry
  // is a surface audit (surfaced/count), not a second copy of the warnings.
  st.gateRe = compileMarkerRegex(st.config.gateMarker, GATE_RE, (cause) =>
    st.journaler.journal({
      type: "error",
      error: `config gateMarker: invalid regex, using default: ${String(cause)}`,
    }),
  )

  st.verdictRe = compileMarkerRegex(st.config.verdictMarker, VERDICT_RE, (cause) =>
    st.journaler.journal({
      type: "error",
      error: `config verdictMarker: invalid regex, using default: ${String(cause)}`,
    }),
  )
}

function buildCoreServices(st: CoreState): void {
  st.gates = createGates(st.config, st.journaler)

  // Stateless denylist for bash/shell and write/edit tools in execute.before
  // regexes compile once here; it throws the same BlockError gates
  // throw, so the hook's existing catch rethrows blocks and journals the rest.
  st.toolPolicy = createToolPolicy(st.config, st.journaler)
}

function buildCoreFlags(st: CoreState): void {
  // Config warnings are journaled exactly once, by config.ts (the pre-journaler
  // sink); they are now also *surfaced* once into the model context by the
  // first tool delivery that carries string output (see
  // `surfaceConfigWarnings`), and never re-journaled here (that would
  // double-write every entry). The once-per-load latches the context surfaces
  // consume live on this shared flags object (see ContextSurfaceFlags): the
  // boot replay and the admission stamp arm `observeSummaryPending`; the
  // surfaces consume the latches one-shot.
  st.surfaceFlags = {
    configWarningsPending: st.configWarnings.length > 0,
    observeSummaryPending: false,
    draftDiagnosticDone: false,
    draftShapeErrorJournaled: false,
  }
  st.flags = st.surfaceFlags
}

function buildCoreLedger(opts: TurnstileOptions, st: CoreState): void {
  st.ledger = createLedger(
    st.journaler.journalPath,
    st.config.maxSessions,
    st.config.replayTailLines,
    opts.approvalLedgerPath,
    st.config.observeSessions,
    st.config.agents.reviewer,
  )

  // Evidence tracker: correlates a GATE: PASS against journaled exit-0
  // bash/shell test executions attributed to the parent. Owns only the
  // *evidence* dimension; marker authority is separate.
  st.evidence = createEvidenceTracker(st.config, (raw) => st.ledger.parentOf(raw), st.journaler)
  // Child-write adjacency for prov:override capture: in-process only, never
  // persisted; the journaled childWrite telemetry rows are the durable trail.
  st.overrideAdjacency = createOverrideAdjacency()
  if (st.ledger.observeCounts().pendingSummary) st.surfaceFlags.observeSummaryPending = true
}

function buildCoreNearMissMaps(st: CoreState): void {
  // Near-miss marker diagnostics pending surfacing, keyed by parent session ID.
  // Hits are detected and journaled at prompt admission (see admitPrompt) and
  // parked here; the session's next string-output tool delivery surfaces them
  // once as a `[turnstile] marker:` block — the same model-facing channel as
  // the config-warning and read-budget blocks. A blocked dispatch never reaches
  // execute.after, so the diagnostic lands on the next string output. Bounded
  // like the admission dedupe set: FIFO-evict the oldest parent past the cap.
  st.nearMissPending = new Map<string, MarkerNearMiss[]>()

  // Cap on parents holding pending near-miss diagnostics (bounded memory).
  st.maxTrackedNearMiss = 16
}

function buildCoreDeliveryMaps(st: CoreState): void {
  // Dispatchable agent names, the conservative-exclusion fallback for
  // orchestrator-policy injection: a delivery carrying one of these names
  // with an UNRESOLVABLE child→parent edge is skipped (and journaled)
  // rather than injected self-keyed. Same config.agents keys the dispatch
  // guards read, so a renamed agent is excluded by name exactly as before.
  st.subagentNames = new Set(
    (
      [
        "reviewer",
        "planReviewer",
        "executor",
        "testRunner",
        "debugger",
        "planner",
        "requirements",
      ] as const
    ).map((name) => st.config.agents[name]),
  )

  // Host session API, bound at setup time (hooks already fire post-setup).
  // Kept in a holder object so the parent-resolution concern (and the local
  // retry/attribution helpers) read the live binding without capturing the
  // per-setup `h`; enables the plan-reviewer delivery path to await edge
  // resolution via `session.get`.
  st.hostSessionRef = { current: undefined }

  /** Per-child marker-retry attempts used; bounded by boundMarkerRetries. */
  st.markerRetries = new Map<string, number>()
  st.taskDeliverySeq = { current: 0 }
}

function buildCoreDeltaMaps(st: CoreState): void {
  /**
   * Per-session sliding window of streamed child text: a host may split one
   * marker across `session.text.delta` chunks, and a fragment-only parse silently
   * loses the gate flip. Each delta re-parses the window's tail; markers.ts dedup
   * suppresses every re-fire, so only a newly completed marker is first-sighted.
   * Bounded by boundDeltaWindows; cleared on the next task dispatch (see
   * execute.before age-out) so stale fragments of a prior task do not leak.
   */
  st.deltaWindows = new Map<string, string>()

  // Derived from the effective compiled marker sources with a 512-char floor
  // (deltaWindowFloorChars): the tail keeps a window whose head was evicted so
  // a marker split across many small deltas still completes, including one
  // whose configured literal is longer than the historical bound.
  st.maxDeltaWindowChars = deltaWindowFloorChars(st.gateRe.source, st.verdictRe.source)

  st.maxTrackedDeltaWindows = 50
}

function buildCoreAdmissionMaps(st: CoreState): void {
  /**
   * Emitter-authority cache: a child session ID → its resolved agent name,
   * seeded at three redundant points (`resolveParent` record read,
   * `session.created`, and `execute.after` task input). Read by
   * `markerKindAllowed` to decide whether a session's `GATE:`/`VERDICT:` text
   * is authoritative for that kind. Bounded by boundSessionAgents.
   */
  st.sessionAgents = new Map<string, string>()

  st.maxTrackedEmitters = 50

  // One-time flag backing the dead-channel surfacing below.
  // Dedupe keys `${sessionID}:${admissionID}` for every prompt admitted, so
  // the hook path and the inbox stream each admit one prompt exactly once
  // (the normal host sequence is hook-then-inbox on the shared message id).
  st.admittedIds = new Set<string>()

  // Cap on tracked dedupe keys (FIFO; evict the first-seen key past the
  // cap — Set insertion order is never refreshed, which is fine: the host
  // never re-fires an old admission id, so recency adds nothing) — bounded
  // memory per plugin instance.
  st.maxTrackedAdmittedIds = 64
}

function buildCoreSummaryMaps(st: CoreState): void {
  // Session-end summary dedupe: one summary per session per host process.
  // In-memory only — after a restart the same session may re-summary once
  // (accepted; the journaled `session-summary` entry makes it diagnosable).
  // Bounded like the admitted-id set (cap = maxSessions, the same LRU bound
  // the ledger uses; a session that idled once never fires again).
  st.summarizedSessions = new Set<string>()
}

function buildCoreDispatchMaps(st: CoreState): void {
  // Parent session ID → Date.now() of its LATEST plan-reviewer dispatch
  // (last-wins; cleared on task-scope reset for that parent). Plausibility
  // input: an unresolved-child verdict is plausible only within the parent's
  // current task scope (recorded at-or-after this time, and unique across
  // parents). Capped via boundDispatches, the same eviction idiom as
  // boundLookups.
  st.planReviewerDispatch = new Map<string, number>()

  // Parent session ID → plan file names extracted from its LATEST
  // plan-reviewer dispatch prompt (last-wins; cleared on task-scope reset for
  // that parent). Binding input: when the round's plan-reviewer APPROVE
  // lands, this is the candidate set the approval binds to via
  // gates.planApprovalBinding (a unique existing mention binds the plan name
  // + content key; anything else stays unbound). Capped via boundTargets,
  // the same eviction idiom as boundDispatches.
  st.planReviewTarget = new Map<string, string[]>()
}

function buildCoreTaskWindowMaps(st: CoreState): void {
  // Parent session ID → Date.now() of its LATEST admitted prompt: the current
  // task's evidence window. A GATE: PASS may only be promoted by executions
  // journaled at-or-after the stamp, so a stale prior-task execution
  // (surviving under an unresolved child) cannot verify a new task's claim.
  // A parent that never admits a prompt has no stamp and keeps the unbounded
  // join (fail-open, documented). Capped via boundTaskWindows, the same
  // eviction idiom as boundDispatches.
  st.taskWindows = new Map<string, number>()

  // ── concern modules (10b) ─────────────────────────────────────────────────
  // The dispatch-guard, bash-write-guard, and prompt-admission concerns live
  // in their own modules; each receives the shared per-setup state it needs
  // as one typed state object. The destructured aliases below keep every
  // remaining call site (and the returned context literal) unchanged.
  st.maintenanceCounts = new Map<string, number>()

  /** Cap on tracked per-plan maintenance counters (bounded memory). */
  st.maxTrackedMaintenancePlans = 16
}

function buildCorePlanAskMaps(st: CoreState): void {
  // Plan-gate permission asks, keyed by host request id → the parent session
  // the ask was raised for + when it was recorded. Only asks escalated by the
  // evaluate handler (reason "plan-gate") are recorded, so a reply to an
  // unrelated permission ask (bash, write, …) can never match or release the
  // plan gate, and concurrent sessions cannot clobber each other (values
  // carry their own session). Bounded: evict oldest past the cap.
  st.planGateAsks = new Map<string, { sessionID: string; recordedAt: number }>()

  // Cap on tracked plan-gate asks: evict oldest (insertion order) past it.
  st.maxTrackedPlanAsks = 50

  // Parents whose evaluate handler has escalated to an ask but whose
  // `permission.asked` stream event has not arrived yet: parent → escalation
  // time. The evaluate handler does not know the host request id (it rides the
  // later stream event), so the next ask for an escalated parent is treated as
  // the plan ask and recorded. Bounded by boundAwaitingAsks, and latches
  // expire (see awaitingPlanAskTtlMs) so a lost stream event cannot latch a
  // parent indefinitely.
  st.awaitingPlanAsk = new Map<string, number>()

  // Latch TTL for awaiting-plan-ask markers: an escalation whose stream event
  // never arrives stops latching after this window, so a stale marker cannot
  // record an unrelated later ask (whose approval would then release the plan
  // gate). The value is single-sourced at module scope (`askLatchTtlMs`).
  st.awaitingPlanAskTtlMs = askLatchTtlMs
}

function buildCoreLandingAskMaps(st: CoreState): void {
  // Parents whose evaluate handler has been armed to force a landing ask (the
  // guard sets this on a repeat `git push` attempt: no reviewer approval AND
  // >= 1 prior landing block). Parent → arm
  // time. The landing arm consults it (not the command, whose wire shape in the
  // permission event is unverified — the guard is the single source of truth
  // for landing-candidate detection via isPushLanding). Bounded by
  // boundLandingAsks; expires like awaitingPlanAsk so a lost stream event
  // cannot latch a parent indefinitely.
  st.pendingLandingAsk = new Map<string, number>()

  st.maxTrackedLandingAsks = 50

  // The landing arm shares the awaiting-plan-ask TTL: same fail-toward-strict
  // expiry, single-sourced at module scope (`askLatchTtlMs`).
  st.pendingLandingAskTtlMs = askLatchTtlMs
}

function buildCoreLandingGateAsks(st: CoreState): void {
  // Landing-gate permission asks, keyed by host request id → the parent session
  // the ask was raised for + when it was recorded. Only asks by the evaluate
  // handler's landing arm (message prefixed with `LANDING_ASK_MESSAGE_PREFIX`
  // from `src/delivery.ts`) are
  // recorded, so a reply to an unrelated permission ask can never match or
  // release the landing gate; per-reason keying keeps a landing `once` grant
  // from ever being consumed by a plan-gate (task) dispatch and vice versa.
  // Bounded: evict oldest past the cap.
  st.landingGateAsks = new Map<string, { sessionID: string; recordedAt: number }>()

  st.maxTrackedLandingGateAsks = 50

  // Landing-ask dedupe: parent → Date.now() of the parent's last landing
  // escalation. A re-arm within `askLatchTtlMs` of the previous escalation
  // collapses into the already-armed latch's single ask row — the guard
  // journals no second `permission` ask row and takes the block path instead
  // while the latch stays live for the evaluate handler. Bounded by
  // boundLandingAsks; cleared wherever pendingLandingAsk is cleared.
  st.lastLandingEscalateAt = new Map<string, number>()
}

function buildCoreHandsOnAskMaps(st: CoreState): void {
  // Parents whose evaluate handler has been armed to force a hands-on ask
  // (the guard sets this on a repeat parent
  // write/edit attempt: no release AND >= 1 prior hands-on block). Parent →
  // arm time. Bounded by boundHandsOnAsks; expires like the other latches so
  // a lost stream event cannot latch a parent indefinitely.
  st.pendingHandsOnAsk = new Map<string, number>()

  st.maxTrackedHandsOnAsks = 50

  // The hands-on arm shares the ask-latch TTL: same fail-toward-strict
  // expiry, single-sourced at module scope (`askLatchTtlMs`).
  st.pendingHandsOnAskTtlMs = askLatchTtlMs

  // Hands-on-ask dedupe (mirrors lastLandingEscalateAt for the hands-on
  // gate): bounded by boundHandsOnAsks; cleared wherever pendingHandsOnAsk
  // is cleared.
  st.lastHandsOnEscalateAt = new Map<string, number>()
}

function buildCoreHandsOnGateAsks(st: CoreState): void {
  // Hands-on-gate permission asks, keyed by host request id → the parent
  // session the ask was raised for + when it was recorded. Only asks by the
  // evaluate handler's hands-on arm (message prefixed with
  // `HANDSON_ASK_MESSAGE_PREFIX` from `src/delivery.ts`) are recorded, so a reply to an unrelated
  // permission ask can never match or release the hands-on gate; per-reason
  // keying keeps a hands-on `once` grant from ever being consumed by a
  // plan-gate (task) dispatch or a landing push and vice versa. Bounded: evict
  // oldest past the cap.
  st.handsOnGateAsks = new Map<string, { sessionID: string; recordedAt: number }>()

  st.maxTrackedHandsOnGateAsks = 50
}

function buildCoreIntentMaps(st: CoreState): void {
  // Pending intent nudges: parent → the detected IntentKind awaiting the
  // parent's next tool delivery (armed by prompt admission, consumed once).
  // Latest-wins when one prompt's nudge is still undelivered and a later
  // prompt classifies a different kind: the earlier kind is preserved in the
  // journaled `intent` row, but only the latest armed kind rides the next
  // delivery — the pending map holds one kind per parent by design (a
  // per-parent queue would let stale nudges land long after their prompt).
  // A task-scope drop releases any undelivered nudge (task-scoped delivery
  // state); bounded by boundIntentNudges alongside the dedupe set.
  st.intentNudgePending = new Map<string, IntentKind>()

  // Pending plan-impact advisories, keyed by parent session ID: the text
  // stashed by the plan-impact classifier (hooks-core) for one classified
  // parent write/edit/write-shaped bash call, consumed one-shot by the next
  // parent-facing delivery (same channel as the intent nudge). Latest-wins
  // when a second classification lands before delivery; a task-scope reset
  // drops the undelivered advisory with the intent-nudge state. Bounded by
  // boundIntentNudges alongside the pending-nudge map.
  st.planImpactAdvisories = new Map<string, string>()

  // Intent-nudge one-shot latch: `${sessionID}:${kind}` keys already nudged.
  // One nudge per detected intent signal, deduped across the task scope (a
  // repeated intent prompt journals but does not re-nudge); the
  // latch is NOT cleared by a task-scope drop — a plan approval clears it, so
  // a later task's intents can nudge again. Bounded: evict oldest past the cap.
  st.intentNudgedKinds = new Set<string>()

  st.maxTrackedIntentNudges = 64
}

function buildCoreLookupMaps(st: CoreState): void {
  // Parent-lookup bookkeeping, keyed by child session ID.
  // Values record how many lookups were attempted and why the record stayed
  // unresolved: `"not-visible"` (host `session.get` threw) or `"no-parent-id"`
  // (the record exists but has no parent edge); cleared on success. Capped so
  // long-lived hosts cannot grow it unboundedly.
  st.failedLookups = new Map<string, { attempts: number; reason: string }>()

  // `"not-visible"`: host `session.get` threw the lookup is retryable.
  st.lookupReasonNotVisible = "not-visible"

  // `"no-parent-id"`: the record exists but has no parent edge (negative cache).
  st.lookupReasonNoParentId = "no-parent-id"

  // A thrown lookup may mean the child record is not yet visible to the
  // host API, so failures are retried up to this many times per session.
  st.maxLookupAttempts = 3

  // Bound on tracked sessions: evict oldest (insertion order) when past.
  st.maxTrackedLookups = 256
}

function buildCoreSessionDirMaps(st: CoreState): void {
  // Bound on tracked per-session project directories: evict oldest (insertion
  // order) when past. Mirrors maxTrackedLookups.
  st.maxTrackedSessionDirs = 50

  // Last-known project directory per session, resolved via session.get and
  // invalidated on session_move. The per-dispatch resolver caches fresh here so
  // the sync consumers (evaluate, continuation carry) read one dispatch behind;
  // the sync consumers fall back to a cached value, then process.cwd().
  // Bounded by boundSessionDirs.
  st.sessionDirs = new Map<string, string>()
}

function buildCorePromptHolders(st: CoreState): void {
  // Prompt-channel waiver capture: the waiver must
  // provenance from the user's prompt, never the dispatch prompt. A counter
  // tracks prompts where NEITHER candidate text key (`text`/`prompt`) holds a
  // non-empty string, so an unresolvable source is reported once (keylessPrompts hits
  // 1 exactly once) as a misconfiguration (mirrors the bash `command ?? cmd`
  // telemetry).
  st.keylessPrompts = { current: 0 }

  // Prompt-channel admission bookkeeping (per-plugin-load closure state):
  // `promptHookFires` counts prompt-hook dispatches (the hook increments it
  // before it admits); a zero count when the inbox stream admits means this
  // surface does not dispatch the prompt hook, so admission is served by the
  // inbox stream — surfaced once as a one-time telemetry error.
  st.promptHookFires = { current: 0 }

  // The plan-verdict and prompt-admission concerns are mutually recursive at
  // the wiring level (an approval binding resets the task scope; the
  // admission's approval capture applies the binding), so the plan-verdict
  // concern is threaded through a holder the admission wrappers read; every
  // wrapper fires at runtime (the admission capture sequence), so the holder
  // is always populated before first use.
  st.admissionFlags = { deadChannelSurfaced: false }

  st.planVerdictRef = { current: undefined }
  st.toast = { current: undefined }
}

function buildCoreMaps(st: CoreState): void {
  buildCoreNearMissMaps(st)
  buildCoreDeliveryMaps(st)
  buildCoreDeltaMaps(st)
  buildCoreAdmissionMaps(st)
  buildCoreSummaryMaps(st)
  buildCoreDispatchMaps(st)
  buildCoreTaskWindowMaps(st)
  buildCorePlanAskMaps(st)
  buildCoreLandingAskMaps(st)
  buildCoreLandingGateAsks(st)
  buildCoreHandsOnAskMaps(st)
  buildCoreHandsOnGateAsks(st)
  buildCoreIntentMaps(st)
  buildCoreLookupMaps(st)
  buildCoreSessionDirMaps(st)
  buildCorePromptHolders(st)
}

function bindCoreBounders(st: CoreState): void {
  st.boundNearMissPending = boundNearMissPending.bind(null, st)
  st.boundIntentNudges = boundIntentNudges.bind(null, st)
  st.boundDeltaWindows = boundDeltaWindows.bind(null, st)
  st.boundDispatches = boundDispatches.bind(null, st)
  st.boundTargets = boundTargets.bind(null, st)
  st.boundTaskWindows = boundTaskWindows.bind(null, st)
  st.boundPlanAsks = boundPlanAsks.bind(null, st)
  st.boundAwaitingAsks = boundAwaitingAsks.bind(null, st)
  st.boundLandingAsks = boundLandingAsks.bind(null, st)
  st.boundHandsOnAsks = boundHandsOnAsks.bind(null, st)
  st.boundHandsOnGateAsks = boundHandsOnGateAsks.bind(null, st)
  st.boundLandingGateAsks = boundLandingGateAsks.bind(null, st)
  st.boundAdmittedIds = boundAdmittedIds.bind(null, st)
  st.boundSummarizedSessions = boundSummarizedSessions.bind(null, st)
  st.boundMaintenanceCounts = boundMaintenanceCounts.bind(null, st)
}

function bindCoreGuards(st: CoreState): void {
  st.observeActive = observeActive.bind(null, st)
  st.enforcementArmed = enforcementArmed.bind(null, st)
  st.journalEngagement = journalEngagement.bind(null, st)
  st.suspendSuppressionActive = suspendSuppressionActive.bind(null, st)
  st.journalSuspendedWouldBlock = journalSuspendedWouldBlock.bind(null, st)
  st.suspendDispatchOutcome = suspendDispatchOutcome.bind(null, st)
  st.blockCause = blockCause.bind(null, st)
  st.dispatchBlockOutcome = dispatchBlockOutcome.bind(null, st)
  st.armLandingAsk = armLandingAsk.bind(null, st)
  st.armHandsOnAsk = armHandsOnAsk.bind(null, st)
  st.suspendBlock = suspendBlock.bind(null, st)
  st.markTaskComplete = markTaskComplete.bind(null, st)
  st.retireTask = retireTaskBody.bind(null, st)
  st.bindToast = bindToast.bind(null, st)
  st.bindHost = bindHost.bind(null, st)
}

function bindCoreDeliveryHelpers(st: CoreState): void {
  st.hasMarker = hasMarker.bind(null, st)
  st.recordDispatch = recordDispatch.bind(null, st)
  st.surfaceNearMissDiagnostics = surfaceNearMissDiagnostics.bind(null, st)
  st.clearIntentNudge = clearIntentNudge.bind(null, st)
  st.hasLiveAwaitingAsk = hasLiveAwaitingAsk.bind(null, st)
  st.hasLiveLandingAsk = hasLiveLandingAsk.bind(null, st)
  st.hasLiveHandsOnAsk = hasLiveHandsOnAsk.bind(null, st)
  st.promoteOnEvidence = promoteOnEvidence.bind(null, st)
  st.evidenceSearch = evidenceSearch.bind(null, st)
  st.readBudgetKey = readBudgetKey.bind(null, st)
  st.handleReadBudget = handleReadBudget.bind(null, st)
  st.discoverCandidates = discoverCandidates.bind(null, st)
  st.plausibleUnresolved = plausibleUnresolved.bind(null, st)
  st.mostRecentUnresolved = mostRecentUnresolved.bind(null, st)
  st.lookupDiag = lookupDiag.bind(null, st)
  st.journalPolicy = journalPolicy.bind(null, st)
  st.nameGuardSkips = nameGuardSkips.bind(null, st)
}

function bindCoreVerdictHelpers(st: CoreState): void {
  st.injectOrchestratorPolicy = injectOrchestratorPolicy.bind(null, st)
  st.appendPipelineStatus = appendPipelineStatus.bind(null, st)
  st.prependPolicy = prependPolicy.bind(null, st)
  st.applyPolicyResult = applyPolicyResult.bind(null, st)
  st.handlePromptIntent = handlePromptIntent.bind(null, st)
  st.prependIntentNudge = prependIntentNudge.bind(null, st)
  st.prependPlanImpactAdvisory = prependPlanImpactAdvisory.bind(null, st)
  st.prependIntentNudgeRead = prependIntentNudgeRead.bind(null, st)
  st.creditReviewApproval = creditReviewApproval.bind(null, st)
  st.attributeEdgeVerdict = attributeEdgeVerdict.bind(null, st)
  st.selectAttributedChild = selectAttributedChild.bind(null, st)
  st.attributionEntry = attributionEntry.bind(null, st)
  st.noteUnattributable = noteUnattributable.bind(null, st)
  st.attributePlanVerdict = attributePlanVerdict.bind(null, st)
  st.noteRetrySkipped = noteRetrySkipped.bind(null, st)
  st.retryMarker = retryMarker.bind(null, st)
  st.bumpPromptFires = bumpPromptFires.bind(null, st)
  st.nextTaskDeliverySeq = nextTaskDeliverySeq.bind(null, st)
}

function bindCoreHelpers(st: CoreState): void {
  bindCoreBounders(st)
  bindCoreGuards(st)
  bindCoreDeliveryHelpers(st)
  bindCoreVerdictHelpers(st)
}

function wireSurfaceConcerns(st: CoreState): void {
  st.contextSurface = createContextSurface(st)
  st.surfaceConfigWarnings = st.contextSurface.surfaceConfigWarnings
  st.surfaceObserveSummary = st.contextSurface.surfaceObserveSummary
  st.observeRequestDraft = st.contextSurface.observeRequestDraft
  st.injectContextPolicy = st.contextSurface.injectContextPolicy
  st.parentResolution = createParentResolution(st)
  st.boundSessionDirs = st.parentResolution.boundSessionDirs
  st.seedEmitter = st.parentResolution.seedEmitter
  st.reseedChildEdges = st.parentResolution.reseedChildEdges
  st.emitterAgent = st.parentResolution.emitterAgent
  st.childStatus = st.parentResolution.childStatus
  st.markerKindAllowed = st.parentResolution.markerKindAllowed
  st.currentProjectDir = st.parentResolution.currentProjectDir
  st.resolveProjectDir = st.parentResolution.resolveProjectDir
  st.resolveParent = st.parentResolution.resolveParent
  st.verdictCapture = createVerdictCapture(st)
  st.parseMarkers = st.verdictCapture.parseMarkers
  st.lastMatch = st.verdictCapture.lastMatch
}

function wireGuardConcerns(st: CoreState): void {
  st.dispatchGuard = createDispatchGuard(st)
  st.handleTaskDispatch = st.dispatchGuard.handleTaskDispatch
  st.guardedTaskDispatch = st.dispatchGuard.guardedTaskDispatch
  st.allowDispatch = st.dispatchGuard.allowDispatch
  st.bashWriteGuard = createBashWriteGuard(st)
  st.handleBashDispatch = st.bashWriteGuard.handleBashDispatch
  st.handleWriteEditDispatch = st.bashWriteGuard.handleWriteEditDispatch
  st.handleSessionMove = st.bashWriteGuard.handleSessionMove
}

function wireAdmissionConcerns(st: CoreState): void {
  st.promptAdmission = createPromptAdmission({
    ...st,
    flags: st.admissionFlags,
    applyApprovalBinding: (sessionID, projectDir, candidates, human) =>
      st.planVerdictRef.current!.applyApprovalBinding(sessionID, projectDir, candidates, human),
    planApprovalStampFields: (s) => st.planVerdictRef.current!.planApprovalStampFields(s),
    recordDurablePlanApproval: (s, projectDir) =>
      st.planVerdictRef.current!.recordDurablePlanApproval(s, projectDir),
  })
  st.admitPrompt = st.promptAdmission.admitPrompt
  st.resetTaskScope = st.promptAdmission.resetTaskScope
  st.planVerdict = createPlanVerdict(st)
  st.planVerdictRef.current = st.planVerdict
  st.journalPlanApproval = st.planVerdict.journalPlanApproval
  st.planApprovalStampFields = st.planVerdict.planApprovalStampFields
  st.recordDurablePlanApproval = st.planVerdict.recordDurablePlanApproval
  st.applyApprovalBinding = st.planVerdict.applyApprovalBinding
}

function wireConcerns(st: CoreState): void {
  wireSurfaceConcerns(st)
  wireGuardConcerns(st)
  wireAdmissionConcerns(st)
}

/** The `coreDeps` view: shared concern handles re-exposed on the context. */
type CoreDeps = Pick<
  TurnstileContext,
  | "config"
  | "journaler"
  | "gateRe"
  | "verdictRe"
  | "ledger"
  | "gates"
  | "toolPolicy"
  | "evidence"
  | "overrideAdjacency"
  | "childStatus"
  | "subagentNames"
>

function coreDeps(st: CoreState): CoreDeps {
  return {
    config: st.config,
    journaler: st.journaler,
    gateRe: st.gateRe,
    verdictRe: st.verdictRe,
    ledger: st.ledger,
    gates: st.gates,
    toolPolicy: st.toolPolicy,
    evidence: st.evidence,
    overrideAdjacency: st.overrideAdjacency,
    childStatus: st.childStatus,
    subagentNames: st.subagentNames,
  }
}

/** The `coreMapViews` view: per-session mutable map cells on the context. */
type CoreMapViews = Pick<
  TurnstileContext,
  | "nearMissPending"
  | "failedLookups"
  | "planReviewerDispatch"
  | "planReviewTarget"
  | "taskWindows"
  | "planGateAsks"
  | "awaitingPlanAsk"
  | "pendingLandingAsk"
  | "pendingHandsOnAsk"
  | "lastLandingEscalateAt"
  | "lastHandsOnEscalateAt"
  | "intentNudgePending"
  | "intentNudgedKinds"
  | "planImpactAdvisories"
  | "landingGateAsks"
  | "handsOnGateAsks"
  | "sessionDirs"
  | "markerRetries"
  | "deltaWindows"
  | "sessionAgents"
  | "admittedIds"
  | "summarizedSessions"
>

function coreMapViews(st: CoreState): CoreMapViews {
  return {
    nearMissPending: st.nearMissPending,
    failedLookups: st.failedLookups,
    planReviewerDispatch: st.planReviewerDispatch,
    planReviewTarget: st.planReviewTarget,
    taskWindows: st.taskWindows,
    planGateAsks: st.planGateAsks,
    awaitingPlanAsk: st.awaitingPlanAsk,
    pendingLandingAsk: st.pendingLandingAsk,
    pendingHandsOnAsk: st.pendingHandsOnAsk,
    lastLandingEscalateAt: st.lastLandingEscalateAt,
    lastHandsOnEscalateAt: st.lastHandsOnEscalateAt,
    intentNudgePending: st.intentNudgePending,
    intentNudgedKinds: st.intentNudgedKinds,
    planImpactAdvisories: st.planImpactAdvisories,
    landingGateAsks: st.landingGateAsks,
    handsOnGateAsks: st.handsOnGateAsks,
    sessionDirs: st.sessionDirs,
    markerRetries: st.markerRetries,
    deltaWindows: st.deltaWindows,
    sessionAgents: st.sessionAgents,
    admittedIds: st.admittedIds,
    summarizedSessions: st.summarizedSessions,
  }
}

/** The `coreConstViews` view: config-derived scalar constants on the context. */
type CoreConstViews = Pick<
  TurnstileContext,
  | "maxTrackedNearMiss"
  | "maxTrackedPlanAsks"
  | "awaitingPlanAskTtlMs"
  | "maxTrackedLandingAsks"
  | "pendingLandingAskTtlMs"
  | "maxTrackedHandsOnAsks"
  | "pendingHandsOnAskTtlMs"
  | "maxTrackedLandingGateAsks"
  | "maxTrackedHandsOnGateAsks"
  | "maxTrackedIntentNudges"
  | "maxLookupAttempts"
  | "maxTrackedLookups"
  | "maxTrackedSessionDirs"
  | "maxDeltaWindowChars"
  | "maxTrackedDeltaWindows"
  | "maxTrackedEmitters"
  | "maxTrackedAdmittedIds"
  | "LOOKUP_REASON_NOT_VISIBLE"
  | "LOOKUP_REASON_NO_PARENT_ID"
>

function coreConstViews(st: CoreState): CoreConstViews {
  return {
    maxTrackedNearMiss: st.maxTrackedNearMiss,
    maxTrackedPlanAsks: st.maxTrackedPlanAsks,
    awaitingPlanAskTtlMs: st.awaitingPlanAskTtlMs,
    maxTrackedLandingAsks: st.maxTrackedLandingAsks,
    pendingLandingAskTtlMs: st.pendingLandingAskTtlMs,
    maxTrackedHandsOnAsks: st.maxTrackedHandsOnAsks,
    pendingHandsOnAskTtlMs: st.pendingHandsOnAskTtlMs,
    maxTrackedLandingGateAsks: st.maxTrackedLandingGateAsks,
    maxTrackedHandsOnGateAsks: st.maxTrackedHandsOnGateAsks,
    maxTrackedIntentNudges: st.maxTrackedIntentNudges,
    maxLookupAttempts: st.maxLookupAttempts,
    maxTrackedLookups: st.maxTrackedLookups,
    maxTrackedSessionDirs: st.maxTrackedSessionDirs,
    maxDeltaWindowChars: st.maxDeltaWindowChars,
    maxTrackedDeltaWindows: st.maxTrackedDeltaWindows,
    maxTrackedEmitters: st.maxTrackedEmitters,
    maxTrackedAdmittedIds: st.maxTrackedAdmittedIds,
    LOOKUP_REASON_NOT_VISIBLE: st.lookupReasonNotVisible,
    LOOKUP_REASON_NO_PARENT_ID: st.lookupReasonNoParentId,
  }
}

/** The `coreBounderViews` view: LRU-bound helpers over the map cells. */
type CoreBounderViews = Pick<
  TurnstileContext,
  | "boundSessionDirs"
  | "boundNearMissPending"
  | "boundIntentNudges"
  | "boundDeltaWindows"
  | "boundDispatches"
  | "boundTargets"
  | "boundTaskWindows"
  | "boundPlanAsks"
  | "boundAwaitingAsks"
  | "boundLandingAsks"
  | "boundHandsOnAsks"
  | "boundHandsOnGateAsks"
  | "boundLandingGateAsks"
  | "boundAdmittedIds"
  | "boundSummarizedSessions"
>

function coreBounderViews(st: CoreState): CoreBounderViews {
  return {
    boundSessionDirs: st.boundSessionDirs,
    boundNearMissPending: st.boundNearMissPending,
    boundIntentNudges: st.boundIntentNudges,
    boundDeltaWindows: st.boundDeltaWindows,
    boundDispatches: st.boundDispatches,
    boundTargets: st.boundTargets,
    boundTaskWindows: st.boundTaskWindows,
    boundPlanAsks: st.boundPlanAsks,
    boundAwaitingAsks: st.boundAwaitingAsks,
    boundLandingAsks: st.boundLandingAsks,
    boundHandsOnAsks: st.boundHandsOnAsks,
    boundHandsOnGateAsks: st.boundHandsOnGateAsks,
    boundLandingGateAsks: st.boundLandingGateAsks,
    boundAdmittedIds: st.boundAdmittedIds,
    boundSummarizedSessions: st.boundSummarizedSessions,
  }
}

/** The `coreServiceViews1` view: surface + marker + project-dir services. */
type CoreServiceViews1 = Pick<
  TurnstileContext,
  | "surfaceConfigWarnings"
  | "surfaceObserveSummary"
  | "hasMarker"
  | "recordDispatch"
  | "surfaceNearMissDiagnostics"
  | "seedEmitter"
  | "emitterAgent"
  | "reseedChildEdges"
  | "markerKindAllowed"
  | "hasLiveAwaitingAsk"
  | "hasLiveLandingAsk"
  | "hasLiveHandsOnAsk"
  | "currentProjectDir"
  | "resolveProjectDir"
  | "resolveParent"
  | "promoteOnEvidence"
>

function coreServiceViews1(st: CoreState): CoreServiceViews1 {
  return {
    surfaceConfigWarnings: st.surfaceConfigWarnings,
    surfaceObserveSummary: st.surfaceObserveSummary,
    hasMarker: st.hasMarker,
    recordDispatch: st.recordDispatch,
    surfaceNearMissDiagnostics: st.surfaceNearMissDiagnostics,
    seedEmitter: st.seedEmitter,
    emitterAgent: st.emitterAgent,
    reseedChildEdges: st.reseedChildEdges,
    markerKindAllowed: st.markerKindAllowed,
    hasLiveAwaitingAsk: st.hasLiveAwaitingAsk,
    hasLiveLandingAsk: st.hasLiveLandingAsk,
    hasLiveHandsOnAsk: st.hasLiveHandsOnAsk,
    currentProjectDir: st.currentProjectDir,
    resolveProjectDir: st.resolveProjectDir,
    resolveParent: st.resolveParent,
    promoteOnEvidence: st.promoteOnEvidence,
  }
}

/** The `coreServiceViews2` view: evidence, lookup, and policy services. */
type CoreServiceViews2 = Pick<
  TurnstileContext,
  | "evidenceSearch"
  | "readBudgetKey"
  | "handleReadBudget"
  | "lastMatch"
  | "planApprovalStampFields"
  | "discoverCandidates"
  | "plausibleUnresolved"
  | "mostRecentUnresolved"
  | "lookupDiag"
  | "journalPolicy"
  | "nameGuardSkips"
  | "injectOrchestratorPolicy"
  | "appendPipelineStatus"
  | "prependPolicy"
  | "prependIntentNudge"
  | "prependIntentNudgeRead"
>

function coreServiceViews2(st: CoreState): CoreServiceViews2 {
  return {
    evidenceSearch: st.evidenceSearch,
    readBudgetKey: st.readBudgetKey,
    handleReadBudget: st.handleReadBudget,
    lastMatch: st.lastMatch,
    planApprovalStampFields: st.planApprovalStampFields,
    discoverCandidates: st.discoverCandidates,
    plausibleUnresolved: st.plausibleUnresolved,
    mostRecentUnresolved: st.mostRecentUnresolved,
    lookupDiag: st.lookupDiag,
    journalPolicy: st.journalPolicy,
    nameGuardSkips: st.nameGuardSkips,
    injectOrchestratorPolicy: st.injectOrchestratorPolicy,
    appendPipelineStatus: st.appendPipelineStatus,
    prependPolicy: st.prependPolicy,
    prependIntentNudge: st.prependIntentNudge,
    prependIntentNudgeRead: st.prependIntentNudgeRead,
  }
}

/** The `coreServiceViews3` view: dispatch, admission, and gate services. */
type CoreServiceViews3 = Pick<
  TurnstileContext,
  | "observeRequestDraft"
  | "injectContextPolicy"
  | "applyPolicyResult"
  | "attributePlanVerdict"
  | "creditReviewApproval"
  | "handleTaskDispatch"
  | "guardedTaskDispatch"
  | "handleBashDispatch"
  | "handleWriteEditDispatch"
  | "handleSessionMove"
  | "suspendBlock"
  | "parseMarkers"
  | "admitPrompt"
  | "retryMarker"
>

function coreServiceViews3(st: CoreState): CoreServiceViews3 {
  return {
    observeRequestDraft: st.observeRequestDraft,
    injectContextPolicy: st.injectContextPolicy,
    applyPolicyResult: st.applyPolicyResult,
    attributePlanVerdict: st.attributePlanVerdict,
    creditReviewApproval: st.creditReviewApproval,
    handleTaskDispatch: st.handleTaskDispatch,
    guardedTaskDispatch: st.guardedTaskDispatch,
    handleBashDispatch: st.handleBashDispatch,
    handleWriteEditDispatch: st.handleWriteEditDispatch,
    handleSessionMove: st.handleSessionMove,
    suspendBlock: st.suspendBlock,
    parseMarkers: st.parseMarkers,
    admitPrompt: st.admitPrompt,
    retryMarker: st.retryMarker,
  }
}

/** The `coreMethodViews` view: host-binding and delivery-seq methods. */
type CoreMethodViews = Pick<
  TurnstileContext,
  "bindHost" | "bindToast" | "bumpPromptFires" | "nextTaskDeliverySeq"
>

function coreMethodViews(st: CoreState): CoreMethodViews {
  return {
    bindHost: st.bindHost,
    bindToast: st.bindToast,
    bumpPromptFires: st.bumpPromptFires,
    nextTaskDeliverySeq: st.nextTaskDeliverySeq,
  }
}

function coreContext(st: CoreState): TurnstileContext {
  return {
    ...coreDeps(st),
    ...coreMapViews(st),
    ...coreConstViews(st),
    ...coreBounderViews(st),
    ...coreServiceViews1(st),
    ...coreServiceViews2(st),
    ...coreServiceViews3(st),
    ...coreMethodViews(st),
    get toast() {
      return st.toast.current
    },
  }
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
  const st = createCoreState(opts)
  return coreContext(st)
}

function createCoreState(opts: TurnstileOptions): CoreState {
  const st = {} as CoreState
  buildCoreConfig(opts, st)
  buildCoreJournaler(st)
  buildCoreRegexes(st)
  buildCoreServices(st)
  buildCoreFlags(st)
  buildCoreLedger(opts, st)
  buildCoreMaps(st)
  bindCoreHelpers(st)
  wireConcerns(st)
  return st
}
