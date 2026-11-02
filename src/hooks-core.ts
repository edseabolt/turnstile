/**
 * @fileoverview Shared hook state and services for turnstile's per-surface
 * hook modules. Builds the per-setup context: config, journaler, gates,
 * ledger, maps, constants, bounders, and the service closures that wire
 * them together. No hook bodies live here; per-surface hook modules own
 * their own registration bodies.
 */

import { evictTo } from "./bounded.ts"
import { loadConfig } from "./config.ts"
import { createJournaler, type Journaler } from "./journal.ts"
import {
  compileMarkerRegex,
  deltaWindowFloorChars,
  formatNearMissDiagnostics,
  GATE_RE,
  VERDICT_RE,
} from "./markers.ts"
import { BlockError, createGates, type EvidenceSearch, type Gates } from "./gates.ts"
import { wouldBlockEntry } from "./gates-common.ts"
import { createEvidenceTracker, type EvidenceTracker } from "./evidence.ts"
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
  /** Stamps a plan-reviewer verdict's approval against the plans dir. */
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
  // Per-session sink routing resolves through the ledger's parent map. The
  // resolver closure reads `ledger` before its declaration line, but it only
  // fires once hooks run — after `createHooksCore` finished constructing both
  // the journaler and the ledger. `parentOf` returns the session itself for
  // unregistered parents (a parent's own entries → its own file) and falls
  // back to the session when a child's edge is not yet resolved; both files
  // are read by replay, so nothing is lost.
  const journaler: Journaler = createJournaler({
    metricsDir: config.metricsDir,
    trace: config.trace,
    maxBytes: config.journalMaxBytes,
    maxGenerations: config.journalMaxGenerations,
    rotateEveryEntries: config.journalRotateEveryEntries,
    perSession: config.journalPerSession,
    sinkFor: (sessionID) => ledger.parentOf(sessionID),
  })
  // Config warnings are journaled exactly once, by config.ts (the pre-journaler
  // sink); they are now also *surfaced* once into the model context by the
  // first tool delivery that carries string output (see
  // `surfaceConfigWarnings`), and never re-journaled here (that would
  // double-write every entry). The once-per-load latches the context surfaces
  // consume live on this shared flags object (see ContextSurfaceFlags): the
  // boot replay and the admission stamp arm `observeSummaryPending`; the
  // surfaces consume the latches one-shot.
  const surfaceFlags: ContextSurfaceFlags = {
    configWarningsPending: configWarnings.length > 0,
    observeSummaryPending: false,
    draftDiagnosticDone: false,
    draftShapeErrorJournaled: false,
  }
  // Surfaces unresolved config-validation warnings once per plugin load by
  // prepending a `[turnstile] config:` block to the first tool result with
  // string output — from any session, primary or child — the model-facing
  // channel proven by the policy injection and the read-budget prefix.
  // Fail-open: a throwing mutation journals
  // `{type:"config", surfaced:false}` and never blocks the tool; the journal
  // already carries every warning (loadConfig journaled them), so this entry
  // is a surface audit (surfaced/count), not a second copy of the warnings.
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
    config.agents.reviewer,
  )
  // Re-arm the end-of-period summary at boot: the replayed tail may show a
  // completed period whose summary never surfaced (the process died between
  // the completing stamp and the first string-output delivery) — replay
  // re-arms the one-shot so the summary still lands on this load. A tail
  // that already holds the `kind:"summary"` marker re-arms nothing; a
  // default (off) period never completes, so this is a no-op there.
  if (ledger.observeCounts().pendingSummary) surfaceFlags.observeSummaryPending = true
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
  // Kept in a holder object so the parent-resolution concern (and the local
  // retry/attribution helpers) read the live binding without capturing the
  // per-setup `h`; enables the plan-reviewer delivery path to await edge
  // resolution via `session.get`.
  const hostSessionRef: { current: Host["session"] | undefined } = { current: undefined }

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
  // handler's landing arm (message prefixed with `LANDING_ASK_MESSAGE_PREFIX`
  // from `src/delivery.ts`) are
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
  // evaluate handler's hands-on arm (message prefixed with
  // `HANDSON_ASK_MESSAGE_PREFIX` from `src/delivery.ts`) are recorded, so a reply to an unrelated
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
  // Pending plan-impact advisories, keyed by parent session ID: the text
  // stashed by the plan-impact classifier (hooks-core) for one classified
  // parent write/edit/write-shaped bash call, consumed one-shot by the next
  // parent-facing delivery (same channel as the intent nudge). Latest-wins
  // when a second classification lands before delivery; a task-scope reset
  // drops the undelivered advisory with the intent-nudge state. Bounded by
  // boundIntentNudges alongside the pending-nudge map.
  const planImpactAdvisories = new Map<string, string>()
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
    evictTo(planImpactAdvisories, config.maxSessions)
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

  /** Per-child marker-retry attempts used; bounded by boundMarkerRetries. */
  const markerRetries = new Map<string, number>()

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

  // ── concern modules (10a) ─────────────────────────────────────────────────
  // The context-surface, parent-resolution, verdict-capture, and plan-verdict
  // concerns live in their own modules; each receives the shared per-setup
  // state it needs as one typed state object. The destructured aliases below
  // keep every existing call site (and the returned context literal)
  // unchanged. Cross-concern helpers that stay local for now (10b scope) are
  // threaded as function references; function declarations hoist, so the
  // wiring order matches the state-block order, not the declaration order.
  const contextSurface = createContextSurface({
    journaler,
    ledger,
    subagentNames,
    policyText,
    configWarnings,
    flags: surfaceFlags,
    intentNudgePending,
    journalPolicy,
    enforcementArmed,
  })
  const { surfaceConfigWarnings, surfaceObserveSummary, observeRequestDraft, injectContextPolicy } =
    contextSurface
  const parentResolution = createParentResolution({
    config,
    journaler,
    ledger,
    subagentNames,
    hostSessionRef,
    sessionAgents,
    maxTrackedEmitters,
    failedLookups,
    maxLookupAttempts,
    maxTrackedLookups,
    lookupReasonNotVisible: LOOKUP_REASON_NOT_VISIBLE,
    lookupReasonNoParentId: LOOKUP_REASON_NO_PARENT_ID,
    sessionDirs,
    maxTrackedSessionDirs,
    toolPolicy,
    promoteOnEvidence,
  })
  const {
    boundSessionDirs,
    seedEmitter,
    reseedChildEdges,
    emitterAgent,
    childStatus,
    markerKindAllowed,
    currentProjectDir,
    resolveProjectDir,
    resolveParent,
  } = parentResolution
  const verdictCapture = createVerdictCapture({
    config,
    journaler,
    ledger,
    gateRe,
    verdictRe,
    evidence,
    taskWindows,
    markerKindAllowed,
    emitterAgent,
    markTaskComplete,
  })
  const { parseMarkers, lastMatch } = verdictCapture
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
   * Re-evaluates evidence correlation for a parent whose pending unverified
   * PASS may now verify: peeks the parent bucket (never mints one — a fresh
   * bucket can never carry a claim, so unknown sessions stay out of the LRU)
   * and, when the bucket holds an unverified claim and the tracker still
   * correlates an in-window exit-0 hit for it, flips the gate green, clears
   * the claim, and journals the promoted gate entry plus its trace event —
   * byte-identical to the evidence-arrival promotion this helper was
   * extracted from. The promoted entry carries the parent's task fingerprint
   * only when its bucket has stamped one (omitted when empty, like the live
   * gate rows), so replay restores the carry identity. A parent with no
   * admitted-prompt task-window stamp keeps
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
        ...(ps.taskFingerprint !== "" ? { fp: ps.taskFingerprint } : {}),
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
    // Dormant-until-engaged: the whole-file read horizon sleeps until the
    // parent engages.
    if (!enforcementArmed(key)) return
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
    prependPlanImpactAdvisory(event, parent, delivery)
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
    // Dormant-until-engaged: a dormant session's deliveries stay clean — the
    // policy head lands only once enforcement is armed.
    if (!enforcementArmed(parent)) return
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
      // Engagement replaced the nudge for the engaging kinds: a dispatch or
      // plan-reference prompt journals its intent row but never nudges (the
      // pipeline is armed instead) — consistently, regardless of
      // `alwaysEnforce`. Issue/work intents keep the one-shot advisory
      // nudge: that is dormant mode's one-time hint.
      if (shouldEngage(kind)) {
        journaler.journal({ type: "intent", sessionID, kind })
        return
      }
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
   * Delivers a pending plan-impact advisory on a classified task/subagent
   * delivery: consumes the parent's stashed advisory (one-shot) and prepends
   * the text ahead of the delivery text — the same channel and one-shot
   * semantics as the intent nudge. Deliveries that cannot carry text keep
   * the advisory pending for a later delivery. Fail-open: a throwing
   * mutation journals `type:"error"` and never blocks.
   * @param event The execute.after payload whose result is mutated.
   * @param parent The resolved parent session for the delivery.
   * @param delivery The classified delivery (see `classifyDelivery`).
   */
  function prependPlanImpactAdvisory(
    event: ToolHookEvent,
    parent: string,
    delivery: Delivery,
  ): void {
    if (delivery.kind !== "string" && delivery.kind !== "structured") return
    const text = planImpactAdvisories.get(parent)
    if (text === undefined) return
    planImpactAdvisories.delete(parent)
    try {
      prependDeliveryText(event, delivery, text)
    } catch (e) {
      journaler.journal({ type: "error", sessionID: parent, error: `plan-impact advisory: ${e}` })
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
      sessionApi: typeof hostSessionRef.current?.get === "function",
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
   * Whether reactive gate enforcement is armed for the session's parent:
   * the configured `alwaysEnforce` short-circuits to always-armed; otherwise
   * the parent bucket's `engaged` flag decides (dormant-until-engaged).
   * Children draw on the parent's engagement via `ledger.parentOf`, matching
   * the per-parent state rule. Fail toward the configured mode: any ledger
   * throw journals and returns `config.alwaysEnforce` — a broken engagement
   * read must not silently arm or disarm beyond the configured default.
   * @param sessionID The session whose enforcement decision is being made.
   * @returns True when reactive enforcement is armed for the session's parent.
   */
  function enforcementArmed(sessionID: string): boolean {
    if (config.alwaysEnforce) return true
    try {
      return ledger.state(ledger.parentOf(sessionID)).engaged
    } catch (e) {
      journaler.journal({ type: "error", sessionID, error: `engagement read: ${e}` })
      return false
    }
  }

  /**
   * Journals one `type:"engagement"` row for a transition that already
   * mutated the bucket's `engaged` flag. Fail-open: a journaling failure
   * propagates to the caller's guard (the journaler itself never throws
   * through the hook bodies).
   * @param sessionID The parent session whose engagement changed.
   * @param engaged The new engagement value.
   * @param reason Why the value changed.
   */
  function journalEngagement(sessionID: string, engaged: boolean, reason: EngagementReason): void {
    journaler.journal(engagementEntry(sessionID, engaged, reason))
  }

  /**
   * Whether gate enforcement is suspended for the session's parent: the
   * session-level suspend state (decisions keep computing and journaling,
   * but deliberate blocks are suppressed). Children draw on the parent's
   * suspension via `ledger.parentOf`, matching the per-parent state rule.
   * Fail-open: any ledger throw journals and returns false — a broken
   * suspension read must not silently un-guard the pipeline.
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

  // Prompt-channel waiver capture: the waiver must
  // provenance from the user's prompt, never the dispatch prompt. A counter
  // tracks prompts where NEITHER candidate text key (`text`/`prompt`) holds a
  // non-empty string, so an unresolvable source is reported once (keylessPrompts hits
  // 1 exactly once) as a misconfiguration (mirrors the bash `command ?? cmd`
  // telemetry).
  const keylessPrompts = { current: 0 }

  // Prompt-channel admission bookkeeping (per-plugin-load closure state):
  // `promptHookFires` counts prompt-hook dispatches (the hook increments it
  // before it admits); a zero count when the inbox stream admits means this
  // surface does not dispatch the prompt hook, so admission is served by the
  // inbox stream — surfaced once as a one-time telemetry error.
  const promptHookFires = { current: 0 }
  // One-time flag backing the dead-channel surfacing below.
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

  // ── concern modules (10b) ─────────────────────────────────────────────────
  // The dispatch-guard, bash-write-guard, and prompt-admission concerns live
  // in their own modules; each receives the shared per-setup state it needs
  // as one typed state object. The destructured aliases below keep every
  // remaining call site (and the returned context literal) unchanged.
  const maintenanceCounts = new Map<string, number>()
  /** Cap on tracked per-plan maintenance counters (bounded memory). */
  const maxTrackedMaintenancePlans = 16
  /**
   * Bounds the per-plan maintenance counters by evicting their oldest entries.
   */
  function boundMaintenanceCounts(): void {
    evictTo(maintenanceCounts, maxTrackedMaintenancePlans)
  }
  const dispatchGuard = createDispatchGuard({
    config,
    journaler,
    ledger,
    gates,
    deltaWindows,
    planReviewerDispatch,
    planReviewTarget,
    maintenanceCounts,
    boundDispatches,
    boundTargets,
    boundMaintenanceCounts,
    recordDispatch,
    enforcementArmed,
    journalEngagement,
    promoteOnEvidence,
    evidenceSearch,
    resolveProjectDir,
    dispatchBlockOutcome,
  })
  const { handleTaskDispatch, guardedTaskDispatch, allowDispatch } = dispatchGuard
  const bashWriteGuard = createBashWriteGuard({
    config,
    journaler,
    ledger,
    gates,
    toolPolicy,
    sessionDirs,
    planImpactAdvisories,
    childStatus,
    currentProjectDir,
    enforcementArmed,
    armLandingAsk,
    armHandsOnAsk,
    boundIntentNudges,
  })
  const { handleBashDispatch, handleWriteEditDispatch, handleSessionMove } = bashWriteGuard

  // The plan-verdict and prompt-admission concerns are mutually recursive at
  // the wiring level (an approval binding resets the task scope; the
  // admission's approval capture applies the binding), so the plan-verdict
  // concern is threaded through a holder the admission wrappers read; every
  // wrapper fires at runtime (the admission capture sequence), so the holder
  // is always populated before first use.
  const admissionFlags: PromptAdmissionFlags = { deadChannelSurfaced: false }
  const planVerdictRef: {
    current: ReturnType<typeof createPlanVerdict> | undefined
  } = { current: undefined }
  const promptAdmission = createPromptAdmission({
    config,
    journaler,
    ledger,
    gates,
    admittedIds,
    maxTrackedAdmittedIds,
    boundAdmittedIds,
    promptHookFires,
    keylessPrompts,
    flags: admissionFlags,
    nearMissPending,
    boundNearMissPending,
    planReviewerDispatch,
    planReviewTarget,
    evidence,
    taskWindows,
    boundTaskWindows,
    awaitingPlanAsk,
    pendingLandingAsk,
    lastLandingEscalateAt,
    pendingHandsOnAsk,
    lastHandsOnEscalateAt,
    intentNudgePending,
    planImpactAdvisories,
    surfaceFlags,
    currentProjectDir,
    journalEngagement,
    clearIntentNudge,
    markTaskComplete,
    applyApprovalBinding: (sessionID, projectDir, candidates, human) =>
      planVerdictRef.current!.applyApprovalBinding(sessionID, projectDir, candidates, human),
    planApprovalStampFields: (s) => planVerdictRef.current!.planApprovalStampFields(s),
    recordDurablePlanApproval: (s, projectDir) =>
      planVerdictRef.current!.recordDurablePlanApproval(s, projectDir),
    handlePromptIntent,
  })
  const { admitPrompt, resetTaskScope } = promptAdmission
  const planVerdict = createPlanVerdict({
    journaler,
    ledger,
    gates,
    planReviewTarget,
    resolveProjectDir,
    clearIntentNudge,
    resetTaskScope,
  })
  planVerdictRef.current = planVerdict
  const { journalPlanApproval, planApprovalStampFields } = planVerdict

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
    // Dormant-until-engaged: a retired task sleeps the pipeline again.
    if (s.engaged) {
      s.engaged = false
      journalEngagement(sessionID, false, "task-complete")
    }
    // The successor task must be able to nudge again: a retire clears the
    // per-kind dedupe latch exactly like a plan approval does (both retire
    // paths — the explicit marker and the gate flip — route here).
    clearIntentNudge(sessionID)
    journaler.journal({ type: "task-complete", sessionID, plan: s.activePlan })
  }

  /**
   * Binds the host session API for the shared `resolveParent` helper.
   * @param session The live host session API.
   */
  function bindHost(session: Host["session"]): void {
    hostSessionRef.current = session
  }

  /**
   * Journals a terminal marker-retry outcome (exhausted or skipped) and
   * reports the retry as not sent.
   * @param child The bare-output child session ID.
   * @param agent The dispatch-input agent name.
   * @param used Retry attempts already consumed for this child.
   * @param outcome Why the retry did not send a prompt.
   * @returns Always false: no reminder was delivered.
   */
  function noteRetrySkipped(
    child: string,
    agent: string,
    used: number,
    outcome: "exhausted" | "skipped-no-api",
  ): false {
    journaler.journal({ type: "marker-retry", sessionID: child, agent, attempt: used, outcome })
    return false
  }

  /**
   * Attempts one bounded compliance re-prompt for a bare-output child
   * delivery: journals the attempt, sends the marker reminder via the
   * host's session.prompt when available, and reports whether the
   * reminder was actually sent. Fail-open: a prompt failure journals a
   * type:"error" row and never throws.
   * @param child The bare-output child session ID.
   * @param agent The dispatch-input agent name.
   * @returns True only when the reminder prompt was sent.
   */
  async function retryMarker(child: string, agent: string): Promise<boolean> {
    if (config.agentMarkerRetry === 0) return false
    const used = markerRetries.get(child) ?? 0
    if (used >= config.agentMarkerRetry) return noteRetrySkipped(child, agent, used, "exhausted")
    if (typeof hostSessionRef.current?.prompt !== "function")
      return noteRetrySkipped(child, agent, used, "skipped-no-api")
    journaler.journal({
      type: "marker-retry",
      sessionID: child,
      agent,
      attempt: used,
      outcome: "prompted",
    })
    markerRetries.set(child, used + 1)
    evictTo(markerRetries, MAX_TRACKED_MARKER_RETRIES)
    try {
      await hostSessionRef.current.prompt({ sessionID: child, text: MARKER_RETRY_PROMPT })
    } catch (e) {
      journaler.journal({ type: "error", error: `marker-retry prompt failed: ${String(e)}` })
      return false
    }
    return true
  }

  /**
   * Increments the prompt-hook fire counter.
   */
  function bumpPromptFires(): void {
    promptHookFires.current++
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
    planImpactAdvisories,
    landingGateAsks,
    handsOnGateAsks,
    sessionDirs,
    markerRetries,
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
    observeRequestDraft,
    injectContextPolicy,
    applyPolicyResult,
    attributePlanVerdict,
    creditReviewApproval,
    handleTaskDispatch,
    guardedTaskDispatch,
    handleBashDispatch,
    handleWriteEditDispatch,
    handleSessionMove,
    suspendBlock,
    parseMarkers,
    admitPrompt,
    retryMarker,
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
