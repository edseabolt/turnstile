/**
 * @fileoverview Prompt-admission concern: the single admission body for a
 * user-authored prompt (dedupe, dead-channel telemetry, task-scope decision,
 * and the capture sequence), the task-scope reset/carry machinery
 * (`carryOrReset`, `resetTaskScope`, `keepTaskScope`, `dropTaskScope`), and
 * the prompt-channel captures (waiver, human approval, task-done retire,
 * suspend/resume, near-miss scan, unresolvable-text telemetry, observe-mode
 * admission stamp). Extracted from `src/hooks-core.ts`; the shared per-setup
 * state is threaded as one typed state object and the cross-concern helpers
 * stay behind function-typed fields. Every capture is fail-open: a coercion
 * that throws is journaled and swallowed, never thrown at the host.
 */

import type { Journaler } from "./journal.ts"
import type { GateLedger } from "./ledger.ts"
import type { Gates } from "./gates.ts"
import type { ContextSurfaceFlags } from "./context-surface.ts"
import type { EngagementReason } from "./engagement.ts"
import type { GateState, PromptHookProperties, TurnstileConfig } from "./types.ts"
import { decisionEntry, observeEntry } from "./gates-common.ts"
import { parseWaiverScope, findMarkerNearMisses } from "./markers.ts"
import { classifyIntent } from "./intent.ts"
import { shouldEngage } from "./engagement.ts"
import { promptTextOf } from "./delivery.ts"
import { keepsTaskScope } from "./task-scope.ts"
import { shouldCarryGate, worktreeFingerprint } from "./fingerprint.ts"

/**
 * The mutable once-per-load latches the admission body consumes. Owned by
 * the factory and shared with this concern by reference.
 */
export interface PromptAdmissionFlags {
  /** True once the dead-channel telemetry row has been journaled. */
  deadChannelSurfaced: boolean
}

/**
 * The state the prompt-admission concern reads and mutates: the shared deps,
 * the maps it owns, the mutable counters (holder objects), and the
 * cross-concern helpers it delegates to.
 */
export interface PromptAdmissionState {
  /** The resolved plugin configuration. */
  config: TurnstileConfig
  /** The telemetry journal writer. */
  journaler: Journaler
  /** The gate-state ledger (buckets, suspension, observe phases). */
  ledger: GateLedger
  /** Gate decision service (plan-name parsing for approval binding). */
  gates: Gates
  /** Dedupe keys for admitted prompts. */
  admittedIds: Set<string>
  /** Cap on tracked dedupe keys. */
  maxTrackedAdmittedIds: number
  /** Evicts the oldest admitted-id dedupe keys past the cap. */
  boundAdmittedIds(): void
  /** Prompt-hook fire counter (incremented by the prompt hook). */
  promptHookFires: { current: number }
  /** Count of prompts whose text was unresolvable (telemetry, once). */
  keylessPrompts: { current: number }
  /** The once-per-load admission latches. */
  flags: PromptAdmissionFlags
  /** Near-miss marker diagnostics pending delivery, keyed by parent. */
  nearMissPending: Map<string, import("./types.ts").MarkerNearMiss[]>
  /** Evicts the oldest parents from nearMissPending past the cap. */
  boundNearMissPending(): void
  /** Parent → latest plan-reviewer dispatch timestamp. */
  planReviewerDispatch: Map<string, number>
  /** Parent → plan file names from its latest plan-reviewer dispatch. */
  planReviewTarget: Map<string, string[]>
  /** Evidence tracker (task-scoped correlation, cleared on scope change). */
  evidence: import("./evidence.ts").EvidenceTracker
  /** Parent → Date.now() of its latest admitted prompt (task window). */
  taskWindows: Map<string, number>
  /** Evicts the oldest task-window stamps past the cap. */
  boundTaskWindows(): void
  /** Parents escalated to a plan ask, awaiting the stream event. */
  awaitingPlanAsk: Map<string, number>
  /** Parents armed for a landing ask, awaiting the stream event. */
  pendingLandingAsk: Map<string, number>
  /** Parent → Date.now() of its last landing escalation (ask-row dedupe). */
  lastLandingEscalateAt: Map<string, number>
  /** Parents armed for a hands-on ask, awaiting the stream event. */
  pendingHandsOnAsk: Map<string, number>
  /** Parent → Date.now() of its last hands-on escalation (dedupe). */
  lastHandsOnEscalateAt: Map<string, number>
  /** Parent → pending intent-nudge kind awaiting the next tool delivery. */
  intentNudgePending: Map<string, import("./intent.ts").IntentKind>
  /** Parent → pending plan-impact advisory text awaiting the next delivery. */
  planImpactAdvisories: Map<string, string>
  /** The once-per-load context-surface latches (observe summary arming). */
  surfaceFlags: ContextSurfaceFlags
  /** Returns the last-known project directory for a session. */
  currentProjectDir(sessionID: string): string
  /** Journals one engagement transition row. */
  journalEngagement(sessionID: string, engaged: boolean, reason: EngagementReason): void
  /** Clears a session's entire intent-nudge state. */
  clearIntentNudge(sessionID: string): void
  /** Marks the parent's active task retired (a flipping PASS boundary). */
  markTaskComplete(sessionID: string, s: GateState): void
  /** Applies a plan approval's binding and the reset-at-capture scope rule. */
  applyApprovalBinding(
    sessionID: string,
    projectDir: string,
    candidates: string[],
    human: boolean,
  ): GateState
  /** Returns the optional identity/stamp fields a plan APPROVE journals. */
  planApprovalStampFields(s: GateState): {
    plan?: string
    planKey?: string
    plansSig?: string
  }
  /** Records the bound plan identity durably under the project. */
  recordDurablePlanApproval(s: GateState, projectDir: string): void
  /** Classifies an admitted prompt for intent and arms the advisory nudge. */
  handlePromptIntent(sessionID: string, properties: PromptHookProperties): void
}

/**
 * Drops the ask-latch family for a session: the pending plan-ask, landing
 * and hands-on arms, and their dedupe timestamps. A task-scope reset drops
 * them because each escalation belongs to the task scope that raised it —
 * the next task starts from a pure first block, and a stale dedupe
 * timestamp must not suppress a legitimate ask row for up to the latch TTL
 * after the scope change.
 * @param st The prompt-admission state.
 * @param sessionID The parent session whose ask latches drop.
 */
function dropAskLatches(st: PromptAdmissionState, sessionID: string): void {
  // A task-scope reset also drops any pending plan-ask latch: the
  // escalation's stream event belongs to the previous task scope, so the
  // next task must not let a later unrelated ask be recorded as the plan ask.
  st.awaitingPlanAsk.delete(sessionID)
  // A landing-ask arm (an enforce repeat-attempt escalation) belongs to the
  // previous task scope too: a scope change drops it, so the new task starts
  // from a pure first block again.
  st.pendingLandingAsk.delete(sessionID)
  // The landing dedupe timestamp belongs to the previous task scope the same
  // way: without this delete a stale timestamp could suppress a legitimate
  // ask row for up to `askLatchTtlMs` after the scope change.
  st.lastLandingEscalateAt.delete(sessionID)
  // A hands-on-ask arm belongs to the previous task scope the same way: a
  // scope change drops it, so the new task starts from a pure first block.
  st.pendingHandsOnAsk.delete(sessionID)
  // Mirror the hands-on dedupe timestamp (same rationale as the landing one).
  st.lastHandsOnEscalateAt.delete(sessionID)
}

/**
 * Drops all prior task-scoped dispatch state for a parent so the next task
 * scope starts clean: the plan-review dispatch targets, the in-memory
 * evidence correlation, the task-window stamp, the ask-latch family, the
 * pending near-miss diagnostics, the undelivered intent nudge, and the
 * undelivered plan-impact advisory. Runs only on a scope change (an
 * admission reset or a reset-at-capture approval) — a same-scope prompt
 * never reaches it.
 * @param st The prompt-admission state.
 * @param sessionID The parent session whose task-scoped state is dropped.
 */
function dropTaskScopeBody(st: PromptAdmissionState, sessionID: string): void {
  // A task-scope reset invalidates all prior dispatch-scoped evidence for
  // this parent, so an unresolved-child verdict is only plausible within the
  // parent's current task scope, and the prior round's plan-mention
  // candidates cannot bind a new task's approval.
  st.planReviewerDispatch.delete(sessionID)
  st.planReviewTarget.delete(sessionID)
  // Evidence is task-scoped, exactly like gate state: a task-scope change
  // drops the in-memory correlation.
  st.evidence.clear(sessionID)
  // Stamp the parent's current task window beside the evidence clear: from
  // this moment a GATE: PASS may only be promoted by executions journaled
  // at-or-after the stamp, so a stale prior-task execution (still keyed under
  // an unresolved child) cannot verify the new task's claim. A parent that
  // never admits a prompt keeps the unbounded join.
  st.taskWindows.set(sessionID, Date.now())
  st.boundTaskWindows()
  dropAskLatches(st, sessionID)
  // Undelivered diagnostics and advisories belong to the dropped task scope
  // too: they must not attach to a later task's deliveries. The near-miss
  // scan below re-seeds within the same admission, so the new prompt's own
  // near misses still surface; the per-kind intent dedupe keys survive the
  // drop by design (one nudge per detected intent within the task; a plan
  // approval or a task retire clears them, and the drop itself only runs on
  // a scope change).
  st.nearMissPending.delete(sessionID)
  st.intentNudgePending.delete(sessionID)
  st.planImpactAdvisories.delete(sessionID)
}

/**
 * Performs a full task-scope reset for a parent: rebuilds the gate bucket
 * (releasing registered children) and drops all task-scoped dispatch state,
 * journaling a `child-reset` entry when any registered child's metering
 * counters were freed. This is the clear both an admission reset (the
 * scope-change arms of `carryOrReset`) and a reset-at-capture plan approval
 * perform.
 * @param st The prompt-admission state.
 * @param sessionID The parent session whose task scope resets.
 * @param merge Whether the rebuild may merge the restart-sticky flags
 *     through the bucket's armed `replayGrace`. Omitted (the admission arms)
 *     keeps the armed-grace default; false (a reset-at-capture approval)
 *     forces a clean rebuild — the old scope's releases must not ride the
 *     grace into the new one.
 */
function resetTaskScopeBody(st: PromptAdmissionState, sessionID: string, merge?: boolean): void {
  const freed = st.ledger.resetState(sessionID, merge)
  dropTaskScopeBody(st, sessionID)
  if (freed > 0) st.journaler.journal({ type: "child-reset", sessionID, children: freed })
}

/**
 * Admits a same-scope prompt: no reset, no task-scope drop — every gate
 * flag, waiver, counter, and latch survives (side chatter and follow-ups
 * never reset anything while a plan is bound and the task is not retired).
 * Two per-prompt duties survive the keep despite the task-long-lived scope
 * (pinned choice — option (i) of the evidence-window decision): the evidence
 * join stays PER-PROMPT, so every admission re-stamps the task window and a
 * `GATE: PASS` claim can only be promoted by exit-0 hits at-or-after the
 * prompt that admitted it (fail-closed anti-fabrication); and a failed
 * claim's residue — the pending unverified text, its streaming-scope dedupe
 * key, and the display marker — is dropped, so a corrected re-claim
 * re-registers instead of wedging the task red (the claim itself is never
 * honored: the gate stays red until a flipping PASS). Consumes the
 * one-prompt `replayGrace` (the first post-restart prompt has now carried
 * naturally; leaving it armed would let a much later scope-change reset
 * carry flags across a task boundary) and refreshes the worktree fingerprint
 * stamp (plan-bound scope ignores fingerprint changes; the stamp stays
 * factual).
 * @param st The prompt-admission state.
 * @param sessionID The parent session whose scope is kept.
 * @param fingerprint The freshly-computed worktree/branch identity.
 */
function keepTaskScopeBody(st: PromptAdmissionState, sessionID: string, fingerprint: string): void {
  // `ledger.state` (not `peek`): this path mutates the bucket, and the
  // session is already marked a live parent, so the mint cannot be evicted.
  const s = st.ledger.state(sessionID)
  s.replayGrace = false
  st.taskWindows.set(sessionID, Date.now())
  st.boundTaskWindows()
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
 * The carry arm of a scope-changing admission: continuation carry is armed
 * and the same worktree/branch is re-admitted, so the restart-sticky flags
 * merge into the rebuilt bucket and a `continuation` row journals the carry.
 * A retired prior bucket journals the row only when the recovery carry
 * actually fired out of the retire (an interrupted review); those rows carry
 * `recovery: true` so the audit trail distinguishes them from ordinary
 * same-task continuations.
 * @param st The prompt-admission state.
 * @param sessionID The parent session whose scope resets with carry.
 * @param prior The pre-reset bucket (defined when a bucket existed).
 * @param fingerprint The freshly-computed worktree/branch identity.
 * @param droppedEngagement Whether the prior bucket was engaged.
 */
function carryGateScope(
  st: PromptAdmissionState,
  sessionID: string,
  prior: GateState | undefined,
  fingerprint: string,
  droppedEngagement: boolean,
): void {
  // The carry decision is captured BEFORE mutating, not re-derived after.
  // The git probe is total (never throws), so this stays throw-free.
  const carry = shouldCarryGate(prior, fingerprint, true)
  // shouldCarryGate guarantees carry ⇒ prior is defined, so the non-null
  // assertion cannot fire; keep the predicate's contract intact if it ever
  // changes.
  if (carry) prior!.replayGrace = true
  resetTaskScopeBody(st, sessionID)
  st.ledger.state(sessionID).taskFingerprint = fingerprint
  if (carry) {
    st.journaler.journal({
      type: "continuation",
      sessionID,
      ...(prior!.taskComplete ? { recovery: true } : {}),
    })
  } else if (droppedEngagement) {
    st.journalEngagement(sessionID, false, "continuation-drop")
  }
}

/**
 * The reset arm of a scope-changing admission: no continuation credit (or
 * carry disabled), so the task scope rebuilds without merging and a dropped
 * engagement sleeps the pipeline again (dormant-until-engaged).
 * @param st The prompt-admission state.
 * @param sessionID The parent session whose scope resets.
 * @param droppedEngagement Whether the prior bucket was engaged.
 */
function resetWithoutCarry(
  st: PromptAdmissionState,
  sessionID: string,
  droppedEngagement: boolean,
): void {
  resetTaskScopeBody(st, sessionID)
  if (droppedEngagement) st.journalEngagement(sessionID, false, "continuation-drop")
}

/**
 * Resets this parent's gate state for a scope-changing admitted prompt,
 * carrying the restart-sticky flags when continuation carry is armed and the
 * same worktree/branch is re-admitted. Journals a `continuation` entry when
 * the carry fired and a `child-reset` entry when any registered child's
 * metering counters were freed. A same-scope prompt (plan-bound, not
 * retired, carry on) skips both the reset and the task-scope drop entirely —
 * the parent is still marked pinned first either way.
 * @param st The prompt-admission state.
 * @param sessionID The parent session whose state is (maybe) reset.
 */
function carryOrResetBody(st: PromptAdmissionState, sessionID: string): void {
  // Mark the session a live parent before any reset: resetState re-caps
  // `states`, and a registered parent is never evicted, so the rebuilt MRU
  // slot stays pinned.
  st.ledger.markParent(sessionID)
  const prior = st.ledger.peek(sessionID)
  if (keepsTaskScope(prior, st.config.continuationCarry)) {
    keepTaskScopeBody(st, sessionID, worktreeFingerprint(st.currentProjectDir(sessionID)))
    return
  }
  // Dormant-until-engaged: a scope-changing reset that drops an engaged
  // bucket without continuation credit sleeps the pipeline again. On a
  // carry, mergeAfterReplay preserves `engaged` — no row.
  const droppedEngagement = prior?.engaged === true
  const fingerprint = worktreeFingerprint(st.currentProjectDir(sessionID))
  if (st.config.continuationCarry) {
    carryGateScope(st, sessionID, prior, fingerprint, droppedEngagement)
  } else {
    resetWithoutCarry(st, sessionID, droppedEngagement)
  }
}

/**
 * Waiver capture (prompt channel): a waiver covers every gate while
 * unscoped, but the reviewer gate consumes an unscoped waiver on the first
 * dispatch it unlocks; naming configured agent names in the waiver text
 * scopes it to those stages' gates (the plan gate is covered by either its
 * plan-reviewer or executor stage name), and a scoped waiver stays live
 * until that stage's waiver allowance is spent — metered separately from the
 * ordinary dispatch caps. The waiver holds for the whole task scope: only a
 * task-scope change (a different-plan approval, a task retire, a planless
 * fingerprint change) clears it. Read + capture in one guarded block; a
 * coercion that throws (a malformed prompt value) is journaled under the
 * historical "waiver capture" key and swallowed — fail-open.
 * @param st The prompt-admission state.
 * @param sessionID The parent session the waiver is captured for.
 * @param properties The prompt payload to scan for the waiver marker.
 */
function captureWaiverBody(
  st: PromptAdmissionState,
  sessionID: string,
  properties: PromptHookProperties,
): void {
  try {
    const waiverText = promptTextOf(properties)
    const at = waiverText.indexOf(st.config.waiverMarker)
    if (at !== -1) {
      const s = st.ledger.state(sessionID)
      s.userWaiver = st.config.trace ? waiverText.slice(at, at + 200) : "<present>"
      // Scope is parsed from the raw window before trace redaction: the
      // stored quote may be "<present>", but the scope needs the words.
      const scope = parseWaiverScope(waiverText.slice(at), Object.values(st.config.agents))
      s.userWaiverScope = scope
      // Task-scoped standing release: the waiver joins the sticky
      // decision-row family (no separate journal type), so the boot replay
      // restores it through the same scope fold as ask `always` grants.
      // `stickyRelease` is provenance; the gates keep reading the waiver
      // family itself.
      s.stickyRelease = true
      st.journaler.journal(decisionEntry(sessionID, "waiver", { kind: "waiver", stages: scope }))
    }
  } catch (e) {
    // Fail-open: capture never blocks a prompt.
    st.journaler.journal({ type: "error", error: `waiver capture: ${e}` })
  }
}

/**
 * Human approval: an approval marker in the user prompt releases the plan
 * gate — the same release signal the plan-reviewer verdict sets. Read +
 * capture in one guarded block: bind the approval against the plan
 * candidates the prompt itself names (the `promptPlanNames` `*.md` parse,
 * resolved against the current plans dir — a unique existing mention binds
 * it, so the human channel can establish `activePlan` exactly like a
 * reviewer verdict) and apply the reset-at-capture scope rule when the
 * binding differs from the bucket's `activePlan`; a prompt naming nothing
 * (or no unique existing plan) binds nothing and is a no-op for scope. Also
 * stamps the plans-dir signature (so a restart replays the approval stamped
 * and an offline plan edit invalidates it) and journals an APPROVE entry
 * that replays identically to a verdict. Runs BEFORE the waiver capture in
 * the same admission, so a waiver sharing the prompt lands in the (possibly
 * reset) new scope. A coercion that throws is journaled and swallowed —
 * fail-open.
 * @param st The prompt-admission state.
 * @param sessionID The parent session the approval is captured for.
 * @param properties The prompt payload to scan for the approval marker.
 */
function captureApprovalBody(
  st: PromptAdmissionState,
  sessionID: string,
  properties: PromptHookProperties,
): void {
  try {
    const approvalText = promptTextOf(properties)
    if (approvalText.indexOf(st.config.approvalMarker) === -1) return
    const projectDir = st.currentProjectDir(sessionID)
    const s = st.applyApprovalBinding(
      sessionID,
      projectDir,
      st.gates.promptPlanNames(approvalText),
      true,
    )
    // The task has its plan: forget prior intent nudges so a later task's
    // detected intents can nudge again.
    st.clearIntentNudge(sessionID)
    st.journaler.journal({
      type: "plan",
      sessionID,
      result: "APPROVE",
      // Provenance only: replay reads only type+result+plansSig.
      source: "session-prompt",
      marker: st.config.approvalMarker,
      ...st.planApprovalStampFields(s),
    })
    st.recordDurablePlanApproval(s, projectDir)
  } catch (e) {
    // Fail-open: approval capture never blocks a prompt.
    st.journaler.journal({ type: "error", error: `approval capture: ${e}` })
  }
}

/**
 * Captures pipeline engagement from an admitted prompt: a prompt carrying
 * the approval marker, classified as a plan reference, or classified as a
 * dispatch request arms the parent's `engaged` flag (once — an
 * already-engaged bucket journals nothing). Runs after `captureApproval` in
 * the admission sequence. Fail-open: any throw journals an `error` row and
 * never propagates from the prompt path.
 * @param st The prompt-admission state.
 * @param sessionID The admitted parent session.
 * @param properties The prompt payload to classify.
 */
function captureEngagementBody(
  st: PromptAdmissionState,
  sessionID: string,
  properties: PromptHookProperties,
): void {
  try {
    const text = promptTextOf(properties)
    const kind = classifyIntent(text)
    const approved = text.indexOf(st.config.approvalMarker) !== -1
    if (!approved && !shouldEngage(kind)) return
    const s = st.ledger.state(sessionID)
    if (s.engaged) return
    s.engaged = true
    const reason: EngagementReason = approved
      ? "plan-approved"
      : kind === "dispatch"
        ? "dispatch-request"
        : "plan-reference"
    st.journalEngagement(sessionID, true, reason)
  } catch (e) {
    st.journaler.journal({ type: "error", sessionID, error: `engagement capture: ${e}` })
  }
}

/**
 * Explicit user retire (prompt channel): a task-done literal in the user's
 * own prompt retires the session's active task for the NEXT admitted prompt
 * (admission-only: child results and dispatch prompts never retire a task).
 * Read + capture in one guarded block; a coercion that throws is journaled
 * under the "task-done capture" key and swallowed — fail-open.
 * @param st The prompt-admission state.
 * @param sessionID The parent session the retire marker is scanned for.
 * @param properties The prompt payload to scan for the retire marker.
 */
function captureTaskDoneBody(
  st: PromptAdmissionState,
  sessionID: string,
  properties: PromptHookProperties,
): void {
  try {
    if (promptTextOf(properties).indexOf(st.config.taskDoneMarker) === -1) return
    st.markTaskComplete(sessionID, st.ledger.state(sessionID))
  } catch (e) {
    // Fail-open: the retire capture never blocks a prompt.
    st.journaler.journal({ type: "error", sessionID, error: `task-done capture: ${e}` })
  }
}

/**
 * Refuses a suspend/resume marker under `allowSuspend:false`: journals the
 * refused entry (`refused:true`) and parks the marker-style near-miss
 * diagnostic for surfacing (the same diagnostic shape and channel as the
 * near-miss scanner) so the user learns the literal is disabled. Never
 * touches ledger state — a refused capture cannot wipe earned credit.
 * @param st The prompt-admission state.
 * @param sessionID The parent session the marker was typed in.
 * @param action The refused action (`"off"` for the suspend marker, `"on"`
 *     for the resume marker).
 * @param marker The configured literal that was refused (surfaces in the
 *     diagnostic).
 */
function refuseSuspend(
  st: PromptAdmissionState,
  sessionID: string,
  action: "off" | "on",
  marker: string,
): void {
  st.journaler.journal({ type: "suspended", sessionID, action, refused: true })
  const pending = st.nearMissPending.get(sessionID) ?? []
  pending.push({
    label: "suspend",
    // The seen token minus its trailing colon — the same colon-stripped
    // shape the near-miss scanner reports (the marker itself is
    // config-controlled, so a custom literal surfaces its own core).
    found: marker.replace(/:$/, ""),
    literal: marker,
  })
  st.nearMissPending.set(sessionID, pending)
  st.boundNearMissPending()
}

/**
 * Applies an allowed OFF: journals the suspension, marks the parent a live
 * parent, and clears the bucket state fresh (the clear is authoritative over
 * the waiver/approval captures above — same admission). For journal honesty,
 * a waiver or approval literal sharing the prompt is reported as a skip
 * notice: its capture was wiped by the clear, so the captured row must not
 * read as earned credit.
 * @param st The prompt-admission state.
 * @param sessionID The parent session suspending.
 * @param text The prompt text (scanned for co-present waiver/approval
 *     literals).
 */
function applySuspendOff(st: PromptAdmissionState, sessionID: string, text: string): void {
  st.journaler.journal({ type: "suspended", sessionID, action: "off" })
  for (const [marker, kind] of [
    [st.config.waiverMarker, "waiver"],
    [st.config.approvalMarker, "approval"],
  ] as const) {
    if (text.indexOf(marker) === -1) continue
    st.journaler.journal({
      type: "error",
      sessionID,
      error: `${kind} capture skipped: prompt also suspended the gate`,
    })
  }
  st.ledger.markParent(sessionID)
  // Fresh start: the clear is authoritative over the captures above (same
  // admission — `carryOrReset` already released the registered children, so
  // this clear only wipes the bucket credit).
  st.ledger.clearState(sessionID)
  st.ledger.setSuspended(sessionID, true)
  // The fresh bucket is dormant by construction; journal the abort
  // transition so replay restores dormancy last-wins.
  st.journalEngagement(sessionID, false, "abort")
}

/**
 * Gate suspend/resume capture (prompt channel): scans the user's own prompt
 * for the configured suspend/resume literals (strict `indexOf`, no
 * near-miss admission) and applies the later-occurring marker's action
 * (last-wins). An OFF suspends enforcement for the session (decisions keep
 * computing and journaling, but deliberate blocks are suppressed) and clears
 * the gate state fresh; an ON resumes enforcement and clears the state fresh
 * too — no credit earned while suspended rehydrates. A marker is refused
 * when `allowSuspend` is false — BOTH the OFF and the ON marker: the refusal
 * is journaled and a marker-style diagnostic is parked for surfacing, and no
 * state changes. Both markers are plain prompt literals, never
 * agent-relayed: only admitted user prompts reach this scanner.
 *
 * Capture ordering contract: this runs AFTER waiver/approval capture, so a
 * plan-approval or waiver literal in the same prompt as an allowed OFF is
 * captured and then wiped by the fresh-start clear (the clear is
 * authoritative). To keep the journal honest (no captured-then-discarded
 * waiver/approval row going unexplained), the allowed-OFF branch journals a
 * skip notice when the prompt also carried the waiver or approval literal.
 *
 * Fail-open: a coercion that throws is journaled under the distinct
 * `suspend capture:` key and swallowed — never thrown at the host.
 * @param st The prompt-admission state.
 * @param sessionID The parent session the markers are captured for.
 * @param properties The prompt payload to scan.
 */
function captureSuspendBody(
  st: PromptAdmissionState,
  sessionID: string,
  properties: PromptHookProperties,
): void {
  try {
    const text = promptTextOf(properties)
    const atOff = text.indexOf(st.config.suspendMarker)
    const atOn = text.indexOf(st.config.resumeMarker)
    if (atOff === -1 && atOn === -1) return
    // Last-wins: the marker occurring later in the prompt decides.
    const resume = atOn !== -1 && (atOff === -1 || atOn > atOff)
    const action = resume ? "on" : "off"
    const marker = resume ? st.config.resumeMarker : st.config.suspendMarker
    if (!st.config.allowSuspend) {
      refuseSuspend(st, sessionID, action, marker)
      return
    }
    if (resume) {
      st.journaler.journal({ type: "suspended", sessionID, action: "on" })
      st.ledger.setSuspended(sessionID, false)
      // Fresh start: admission's `carryOrReset` already released the
      // registered children (and journaled any child-reset), so this clear
      // only wipes the bucket credit — no counter can free here.
      st.ledger.clearState(sessionID)
      return
    }
    applySuspendOff(st, sessionID, text)
  } catch (e) {
    // Fail-open: suspend capture never blocks a prompt.
    st.journaler.journal({ type: "error", sessionID, error: `suspend capture: ${e}` })
  }
}

/**
 * Near-miss marker scan (diagnostic-only): a prompt that mistypes the
 * waiver/approval literal (case, separator, or colon variant) admits nothing
 * — the strict `indexOf` capture is untouched — but is journaled as a
 * `marker`/`near-miss` entry and parked for surfacing so the model learns
 * the exact expected string instead of guessing. Only the matched token and
 * the configured literal are journaled, never the prompt text (redaction
 * contract, mirrors the bash `command` note). The distinct
 * `marker near-miss:` error key keeps the two existing fail-open tests
 * (which filter by `waiver capture:` / `approval capture:`) green on a
 * hostile-getter prompt. Fail-open: a coercion that throws is journaled and
 * swallowed, never thrown at the host.
 * @param st The prompt-admission state.
 * @param sessionID The parent session the scan runs for.
 * @param properties The prompt payload to scan for near-miss markers.
 */
function scanNearMissesBody(
  st: PromptAdmissionState,
  sessionID: string,
  properties: PromptHookProperties,
): void {
  try {
    const nearMissText = promptTextOf(properties)
    const hits = findMarkerNearMisses(nearMissText, [
      { literal: st.config.waiverMarker, label: "waiver" },
      { literal: st.config.approvalMarker, label: "plan approval" },
    ])
    if (hits.length > 0) {
      const pending = st.nearMissPending.get(sessionID) ?? []
      for (const hit of hits) {
        st.journaler.journal({
          type: "marker",
          event: "near-miss",
          sessionID,
          found: hit.found,
          literal: hit.literal,
        })
        pending.push(hit)
      }
      st.nearMissPending.set(sessionID, pending)
      st.boundNearMissPending()
    }
  } catch (e) {
    // Fail-open: the near-miss scan never blocks a prompt.
    st.journaler.journal({ type: "error", error: `marker near-miss: ${e}` })
  }
}

/**
 * Misconfiguration telemetry: if none of the three candidate text keys
 * (`text` / `prompt` / `prompt.text`) holds a non-empty string, the prompt
 * text is unresolvable (an empty `text` does not count — it cannot carry a
 * marker). Report the first such prompt once (the counter hits 1 exactly
 * once) so a host-shape change stays observable without journaling on every
 * prompt. An unreadable payload (a hostile getter) counts as unresolvable
 * and is swallowed — fail-open.
 * @param st The prompt-admission state.
 * @param sessionID The session the unresolvable-text telemetry is journaled
 *     for.
 * @param properties The prompt payload whose text resolvability is probed.
 */
function surfaceKeylessPromptBody(
  st: PromptAdmissionState,
  sessionID: string,
  properties: PromptHookProperties,
): void {
  let unresolvable: boolean
  try {
    unresolvable = promptTextOf(properties) === ""
  } catch {
    unresolvable = true
  }
  if (unresolvable) {
    st.keylessPrompts.current++
    if (st.keylessPrompts.current === 1) {
      st.journaler.journal({
        type: "error",
        sessionID,
        error:
          "waiver capture: neither prompt text key (text|prompt|prompt.text) is a string; does the host send the user prompt elsewhere?",
      })
    }
  }
}

/**
 * Stamps a session's observe-mode admission phase and journals the admission
 * entry the first time the process sees it: the phase plus the running
 * period totals (every observe-mode entry carries both, so the last stamped
 * line restores the whole period at replay). Repeat admissions of an
 * already-stamped session journal nothing new. The completing stamp — the
 * session admitted past the period boundary, whose phase is `enforce` —
 * additionally arms the once-per-load observe summary block for the first
 * string-output delivery after it (see `surfaceObserveSummary`).
 * Fail-toward-enforce: any ledger throw is journaled and swallowed — a
 * broken observer must not disturb prompt admission, and the unstamped
 * session re-stamps (or fails the same way) on its next enforcement read,
 * where it fails toward enforce.
 * @param st The prompt-admission state.
 * @param sessionID The admitted session to stamp.
 */
function stampObserveAdmissionBody(st: PromptAdmissionState, sessionID: string): void {
  try {
    const stamp = st.ledger.observePhase(sessionID)
    if (!stamp.isNew) return
    const phase: "observe" | "enforce" = stamp.phase === "observe" ? "observe" : "enforce"
    const counts = st.ledger.observeCounts()
    st.journaler.journal(observeEntry(sessionID, phase, counts.observed, counts.wouldBlocks))
    if (stamp.completed) st.surfaceFlags.observeSummaryPending = true
  } catch (e) {
    st.journaler.journal({ type: "error", sessionID, error: `observe admission stamp: ${e}` })
  }
}

/**
 * The dedupe + dead-channel preamble of prompt admission: dedupes by the
 * shared host message id (the normal host sequence is hook-then-inbox on the
 * same id, so the other transport already admitted this prompt; an empty id
 * has no shared correlation key, so it never dedupes — a documented
 * double-arrival edge, idempotent: any APPROVE replay restores the gate) and
 * surfaces the dead-channel telemetry once (reaching admission while the
 * prompt hook never fired means the surface does not dispatch the prompt
 * hook — capture is served by the inbox stream).
 * @param st The prompt-admission state.
 * @param sessionID The session the prompt is admitted for.
 * @param admissionID The shared host message id, or "" to skip dedupe.
 * @returns True when the prompt was already admitted (the caller skips it).
 */
function admitPromptDedupe(
  st: PromptAdmissionState,
  sessionID: string,
  admissionID: string,
): boolean {
  if (admissionID !== "") {
    const dedupeKey = `${sessionID}:${admissionID}`
    if (st.admittedIds.has(dedupeKey)) return true
    st.admittedIds.add(dedupeKey)
    st.boundAdmittedIds()
  }
  // Dead-channel surfacing: one-time, per plugin load.
  if (st.promptHookFires.current === 0 && !st.flags.deadChannelSurfaced) {
    st.flags.deadChannelSurfaced = true
    st.journaler.journal({
      type: "error",
      sessionID,
      error:
        "prompt channel: the session prompt hook never fired on this surface; prompt admission is served by the inbox event stream",
    })
  }
  return false
}

/**
 * Admits one user-authored prompt: dedupes by the shared host message id,
 * surfaces the dead-channel telemetry once, then resets prior task scope
 * (carrying restart-sticky flags when continuation carry is armed), drops
 * all task-scoped dispatch state, and captures a waiver and/or approval
 * marker plus the gate suspend/resume markers (later-occurrence-wins) and
 * the unresolvable-text telemetry. This is the single admission body,
 * reached either through the session prompt hook or the correlated inbox
 * stream; the caller dedupes by the shared host message id so one prompt is
 * admitted exactly once regardless of which signal arrives first. Reads only
 * — a transform hook mutates the host event in place host-side, so turnstile
 * must not mutate it.
 *
 * Fail-open: every read is guarded; a coercion that throws is journaled and
 * swallowed, never thrown at the host.
 * @param st The prompt-admission state.
 * @param sessionID The (string) session the prompt is admitted for.
 * @param properties The prompt payload (hook shape or an inbox-derived
 *     `{ sessionID, text }`).
 * @param admissionID The shared host message id (`messageID`/`inboxID`), or
 *     "" to skip dedupe.
 */
function admitPromptBody(
  st: PromptAdmissionState,
  sessionID: string,
  properties: PromptHookProperties,
  admissionID: string,
): void {
  if (admitPromptDedupe(st, sessionID, admissionID)) return
  // Task-scope decision first: a same-scope prompt (plan-bound, not retired,
  // continuation carry on) keeps every flag, waiver, counter, and latch —
  // the "chat resets everything" fix. A scope-changing prompt resets
  // (carrying restart-sticky flags when the carry is armed) and drops the
  // task-scoped dispatch state with it (`resetTaskScope`).
  carryOrResetBody(st, sessionID)
  stampObserveAdmissionBody(st, sessionID)
  // Approval capture runs BEFORE the waiver capture so a waiver sharing the
  // prompt lands in the (possibly reset) new scope.
  captureApprovalBody(st, sessionID, properties)
  captureEngagementBody(st, sessionID, properties)
  captureWaiverBody(st, sessionID, properties)
  captureTaskDoneBody(st, sessionID, properties)
  captureSuspendBody(st, sessionID, properties)
  scanNearMissesBody(st, sessionID, properties)
  surfaceKeylessPromptBody(st, sessionID, properties)
  st.handlePromptIntent(sessionID, properties)
}

/**
 * Creates the prompt-admission concern bound to the factory's shared state.
 * The bodies live at module level; the factory only builds the state object.
 * @param st The prompt-admission state (see {@link PromptAdmissionState}).
 * @returns The prompt-admission methods the shared context exposes.
 */
export function createPromptAdmission(st: PromptAdmissionState): {
  admitPrompt(sessionID: string, properties: PromptHookProperties, admissionID: string): void
  resetTaskScope(sessionID: string, merge?: boolean): void
} {
  return {
    admitPrompt: (sessionID, properties, admissionID) =>
      admitPromptBody(st, sessionID, properties, admissionID),
    resetTaskScope: (sessionID, merge) => resetTaskScopeBody(st, sessionID, merge),
  }
}
