/**
 * @fileoverview Dispatch-guard concern: the `task`/`subagent` execute.before
 * path — the dispatch prologue (agent resolution, parent pinning, task-boundary
 * delta age-out, plan-reviewer round bookkeeping, empty-agent telemetry), the
 * guard-and-meter chain (budget, reviewer evidence re-check, executor
 * maintenance classification, plan-gate once-grant, plan/decomposition gates),
 * and the single admitted-dispatch exit. Extracted from `src/hooks-core.ts`;
 * the shared per-setup state is threaded as one typed state object and the
 * cross-concern helpers stay behind function-typed fields. A deliberate guard
 * block throws `BlockError` for the caller's fail-open catch.
 */

import type { Journaler } from "./journal.ts"
import type { GateLedger } from "./ledger.ts"
import type { Gates } from "./gates.ts"
import type { EngagementReason } from "./engagement.ts"
import type { ToolHookEvent, TurnstileConfig } from "./types.ts"
import { agentFromDispatchEvent } from "./child-registration.ts"
import { asSessionID } from "./delivery.ts"
import {
  MAINTENANCE_MAX_PER_PLAN,
  maintenanceDeclared,
  maintenanceDiffEligible,
  maintenanceMarkerSensitive,
} from "./maintenance.ts"
import { BlockError } from "./gates.ts"
import * as fs from "node:fs"
import * as path from "node:path"
import { spawnSync } from "node:child_process"

/**
 * The state the dispatch-guard concern reads and mutates: the shared deps,
 * the maps it owns, and the cross-concern helpers it delegates to.
 */
export interface DispatchGuardState {
  /** The resolved plugin configuration. */
  config: TurnstileConfig
  /** The telemetry journal writer. */
  journaler: Journaler
  /** The gate-state ledger (buckets, counters, plan state). */
  ledger: GateLedger
  /** Gate decision service (budget, reviewer, plan, decomposition gates). */
  gates: Gates
  /** Per-session sliding window of streamed child text (aged out per task). */
  deltaWindows: Map<string, string>
  /** Parent → Date.now() of its latest plan-reviewer dispatch. */
  planReviewerDispatch: Map<string, number>
  /** Parent → plan file names from its latest plan-reviewer dispatch. */
  planReviewTarget: Map<string, string[]>
  /** Per-plan maintenance dispatch counters. */
  maintenanceCounts: Map<string, number>
  /** Evicts oldest entries from planReviewerDispatch past the cap. */
  boundDispatches(): void
  /** Evicts oldest entries from planReviewTarget past the cap. */
  boundTargets(): void
  /** Evicts oldest per-plan maintenance counters past the cap. */
  boundMaintenanceCounts(): void
  /** Journals one task/subagent dispatch entry (the canonical copy). */
  recordDispatch(sessionID: string, agent: string, description: string, blocked: boolean): void
  /** Whether reactive enforcement is armed for the session's parent. */
  enforcementArmed(sessionID: string): boolean
  /** Journals one engagement transition row. */
  journalEngagement(sessionID: string, engaged: boolean, reason: EngagementReason): void
  /** Re-evaluates evidence correlation for a parent with a pending PASS. */
  promoteOnEvidence(parent: string): void
  /** Builds the attribution diagnostic for a gate-unverified refusal. */
  evidenceSearch(sid: string): import("./gates.ts").EvidenceSearch
  /** Resolves the project directory via session.get, caching per session. */
  resolveProjectDir(sessionID: string): Promise<string>
  /** Settles a task-dispatch guard catch (observe/suspend/blocked stamp). */
  dispatchBlockOutcome(
    e: unknown,
    sessionID: string,
    agent: string,
    description: string,
    waived: boolean,
  ): boolean
}

/**
 * Records one parent's plan-reviewer round bookkeeping: the dispatch time for
 * the plausibility join and the prompt's plan mentions as the round's
 * approval-binding candidates. Last-wins; a prompt reset clears both (see the
 * prompt hook), so a verdict is only plausible — and only bindable — within
 * the parent's current task scope. Bounded by boundDispatches/boundTargets.
 * @param st The dispatch-guard state.
 * @param sessionID The dispatching parent session.
 * @param agent The resolved agent name.
 * @param prompt The dispatch prompt.
 */
function recordPlanReviewDispatch(
  st: DispatchGuardState,
  sessionID: string,
  agent: string,
  prompt: string,
): void {
  if (agent !== st.config.agents.planReviewer) return
  st.planReviewerDispatch.set(sessionID, Date.now())
  st.boundDispatches()
  st.planReviewTarget.set(sessionID, st.gates.promptPlanNames(prompt))
  st.boundTargets()
}

/**
 * Journals the empty-agent misconfiguration signal: an empty agent name is
 * the only reliable misconfiguration signal (the host input shape no longer
 * uses subagent_type/agent/subagent, so every gate condition misses).
 * Telemetry only — journaling cannot throw.
 * @param st The dispatch-guard state.
 * @param sessionID The dispatching session ID.
 * @param agent The resolved agent name ("" when unresolved).
 */
function journalUnresolvedAgent(st: DispatchGuardState, sessionID: string, agent: string): void {
  if (agent) return
  st.journaler.journal({
    type: "error",
    sessionID,
    error:
      "task dispatch: could not resolve the agent name; does the host input shape still use subagent_type/agent/subagent?",
  })
}

/**
 * Prologue for a `task`/`subagent` dispatch: resolves the agent name and the
 * dispatching session, pins the session against LRU eviction, ages out the
 * previous task's streamed delta windows, extracts the trace-gated
 * description, records plan-reviewer round bookkeeping, and journals the
 * empty-agent misconfiguration signal — then defers the guard-and-journal
 * section to guardedTaskDispatch.
 * @param st The dispatch-guard state.
 * @param event The execute.before tool event (task/subagent shape).
 * @returns A promise resolving when the dispatch is settled.
 */
function handleTaskDispatchBody(st: DispatchGuardState, event: ToolHookEvent): Promise<void> {
  // Dispatch-input-first resolution is safe here: `event.input` IS the
  // dispatch input (execute.before, no structured result echo exists),
  // so the `event.agent` fallback cannot shadow a child name the way it
  // can on delivery payloads (see agentFromDeliveryEvent).
  const agent = agentFromDispatchEvent(event)
  const sessionID = asSessionID(event?.sessionID)
  // Sessions dispatching guarded subagents are parents by definition: mark
  // before the guards so their state() inserts land pinned against LRU
  // eviction.
  st.ledger.markParent(sessionID)
  // Age out streamed delta windows: the next dispatch is the task boundary,
  // so stale fragments of the previous task's child text must not leak into
  // the new scope (mirrors the prompt-reset pattern of evidence.clear).
  st.deltaWindows.clear()
  const prompt = String(event.input?.prompt ?? "")
  // Prompt descriptions can carry sensitive context; record them only when
  // the trace is enabled (redacted elsewhere — here it is the single copy
  // passed to the dispatch-recording helper).
  const description = st.config.trace ? String(event.input?.description ?? "").slice(0, 200) : ""
  recordPlanReviewDispatch(st, sessionID, agent, prompt)
  journalUnresolvedAgent(st, sessionID, agent)
  return guardedTaskDispatchBody(st, sessionID, agent, prompt, description)
}

/**
 * The single admitted-dispatch exit: advance the loop counters (the check
 * half ran at guard entry; a refusal never reaches this line, so blocked
 * attempts draw down nothing), then journal the dispatch at guard exit. Both
 * halves stay paired here so the metering can never run without its journal
 * entry nor the other way around. The waiver verdict is threaded in from the
 * budget guard's admission-time snapshot — the commit never re-reads the
 * waiver, because a later guard (the reviewer gate) may have consumed it in
 * between.
 * @param st The dispatch-guard state.
 * @param sessionID The dispatching session ID.
 * @param agent The resolved agent name.
 * @param description The trace-gated dispatch description.
 * @param waived The budget guard's admission-time waiver-exemption verdict.
 */
function allowDispatchBody(
  st: DispatchGuardState,
  sessionID: string,
  agent: string,
  description: string,
  waived: boolean,
): void {
  st.gates.countDispatch(sessionID, st.ledger, agent, waived)
  st.recordDispatch(sessionID, agent, description, false)
}

/**
 * A task dispatch's pre-guard budget half: the per-leg and total-dispatch
 * budget guard. The plan-gate once-grant is consumed only inside the
 * executor branch (after maintenance classification), so a dispatch that
 * rides the maintenance path never burns a user's one-shot approval it never
 * needed, and a blocked dispatch cannot consume the grant (the budget guard
 * runs first; a BlockError from it propagates to the caller's settle).
 * @param st The dispatch-guard state.
 * @param sessionID The dispatching session ID.
 * @param agent The resolved agent name.
 * @returns The budget guard's waiver-exemption verdict.
 */
function dispatchBudgetBody(st: DispatchGuardState, sessionID: string, agent: string): boolean {
  return st.gates.guardDispatchBudget(sessionID, st.ledger, agent)
}

/**
 * Consumes the executor's plan-gate once-grant when one is pending and this
 * is an executor dispatch, and reports whether the dispatch is thereby
 * admitted. A once-granted human approval (from a `permission.replied`
 * reply) grants exactly ONE EXECUTOR dispatch past the plan gate and is
 * cleared immediately, so a stale grant cannot outlive the single dispatch
 * it was given for. Scoped to the executor dispatch class: the grant exists
 * solely to release the plan-gate block, so any other agent leaves it
 * pending and still runs its own guards. execute.before consults only
 * hasPlanVerdict / pendingOnceGrant — never humanApproval, which is
 * provenance only.
 * @param st The dispatch-guard state.
 * @param sessionID The dispatching session ID.
 * @param agent The resolved agent name.
 * @returns True when the once-grant was consumed (the dispatch is admitted).
 */
function consumePlanGrantBody(st: DispatchGuardState, sessionID: string, agent: string): boolean {
  if (
    agent === st.config.agents.executor &&
    st.ledger.state(sessionID).pendingOnceGrant.plan !== ""
  ) {
    // Consume the plan-gate once grant (a `permission.replied` `once`):
    // clears just `.plan` so a landing `.landing` grant, if any, survives
    // for the push it was given for.
    st.ledger.state(sessionID).pendingOnceGrant.plan = ""
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
 * @param st The dispatch-guard state.
 * @param sessionID The dispatching session ID.
 */
function reviewerDecisionRecheckBody(st: DispatchGuardState, sessionID: string): void {
  st.promoteOnEvidence(sessionID)
  st.gates.guardReviewerDispatch(sessionID, st.ledger, st.evidenceSearch(sessionID))
}

/**
 * The executor's plan/decomposition guards: resolves the project dir,
 * enforces the plan-approval gate against it, then the decomposition
 * requirement.
 * @param st The dispatch-guard state.
 * @param sessionID The dispatching session ID.
 * @param prompt The dispatch prompt.
 */
async function enforceExecutorGatesBody(
  st: DispatchGuardState,
  sessionID: string,
  prompt: string,
): Promise<void> {
  const dir = await st.resolveProjectDir(sessionID)
  st.gates.enforcePlanApproval(sessionID, dir, st.ledger, prompt)
  st.gates.enforceDecomposition(sessionID, prompt, dir, st.ledger)
}

/**
 * The configured plans dir as a repo-relative path for one project dir: a
 * relative `plansDir` is used as-is; an absolute one is relativized against
 * the project dir (a dir outside the project yields a `..`-based path that
 * the eligibility rule treats as matching nothing — fail closed). Single
 * source for the maintenance eligibility call sites.
 * @param st The dispatch-guard state.
 * @param projectDir The session's project directory.
 * @returns The repo-relative plans dir.
 */
function maintenancePlansDirRel(st: DispatchGuardState, projectDir: string): string {
  return path.isAbsolute(st.config.plansDir)
    ? path.relative(projectDir, st.config.plansDir)
    : st.config.plansDir
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
 * so a progress-only plan edit never disqualifies). Any probe failure (git
 * absent, unborn HEAD, non-zero exit) returns null — the caller treats that
 * as ineligible (fail closed).
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
 * @param st The dispatch-guard state.
 * @param sessionID The dispatching session ID.
 * @param prompt The dispatch prompt text.
 * @returns The approved plan name and its project dir, or null when the
 *     dispatch is ordinary work.
 */
async function maintenanceApprovalFresh(
  st: DispatchGuardState,
  sessionID: string,
  prompt: string,
): Promise<{ plan: string; dir: string } | null> {
  const s = st.ledger.state(sessionID)
  // The maintenance path skips plan-reviewer *re*-approval: it requires a
  // live bound approval to skip at all. No verdict, no bound plan, or a
  // stale one (already dropped by reconcile) is ordinary work.
  if (!s.hasPlanVerdict || s.approvedPlanKey === "") return null
  const plan = s.approvedPlan
  if (!maintenanceDeclared(prompt, plan, st.gates.promptPlanNames(prompt))) return null
  const dir = await st.resolveProjectDir(sessionID)
  if (st.gates.planApprovalBinding(dir, [plan])?.key !== s.approvedPlanKey) return null
  return { plan, dir }
}

/**
 * The whole-diff eligibility probe for a maintenance dispatch: lists the
 * working-tree's changed files, runs the marker guard only when a
 * marker-validated surface is touched, and applies the pure eligibility
 * rules against the configured plans dir.
 * @param st The dispatch-guard state.
 * @param dir The session's project directory.
 * @returns True when every touched file is an allowed surface.
 */
function maintenanceDiffAllowed(st: DispatchGuardState, dir: string): boolean {
  const files = gitWorkingTreeFiles(dir)
  const needsGuard = files !== null && files.some(maintenanceMarkerSensitive)
  return maintenanceDiffEligible(
    files,
    needsGuard ? markerGuardPasses(dir) : false,
    maintenancePlansDirRel(st, dir),
  )
}

/**
 * Meters one admitted-scope maintenance dispatch against the per-plan cap:
 * under the cap, a slot is consumed and the admitted row journaled; at the
 * cap, the capped attempt row is journaled and nothing is consumed.
 * @param st The dispatch-guard state.
 * @param sessionID The dispatching session ID.
 * @param plan The maintenance dispatch's active plan.
 * @returns `"admit"` (a slot was consumed) or `"capped"` (the caller
 *     escalates like any blocked dispatch).
 */
function meterMaintenanceCap(
  st: DispatchGuardState,
  sessionID: string,
  plan: string,
): "admit" | "capped" {
  const count = st.maintenanceCounts.get(plan) ?? 0
  if (count >= MAINTENANCE_MAX_PER_PLAN) {
    st.journaler.journal({ type: "maintenance", sessionID, plan, capped: true })
    return "capped"
  }
  st.maintenanceCounts.set(plan, count + 1)
  st.boundMaintenanceCounts()
  st.journaler.journal({ type: "maintenance", sessionID, plan, capped: false })
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
 * @param st The dispatch-guard state.
 * @param sessionID The dispatching session ID.
 * @param prompt The dispatch prompt text.
 * @returns The classification verdict.
 */
async function classifyMaintenanceDispatchBody(
  st: DispatchGuardState,
  sessionID: string,
  prompt: string,
): Promise<"admit" | "capped" | "ordinary"> {
  try {
    const fresh = await maintenanceApprovalFresh(st, sessionID, prompt)
    if (fresh === null) return "ordinary"
    if (!maintenanceDiffAllowed(st, fresh.dir)) return "ordinary"
    return meterMaintenanceCap(st, sessionID, fresh.plan)
  } catch (e) {
    st.journaler.journal({ type: "error", sessionID, error: `maintenance classification: ${e}` })
    return "ordinary"
  }
}

/**
 * Escalates a cap-exceeded maintenance dispatch: journals the
 * `maintenance-capped` blocked row and throws the deliberate
 * `BLOCKED by turnstile:` error (the ordinary block vocabulary, so the
 * caller's settle stamps and re-throws it like any guard block).
 * @param st The dispatch-guard state.
 * @param sessionID The dispatching session ID.
 * @param plan The plan whose cap is spent.
 */
function maintenanceCappedBlockBody(
  st: DispatchGuardState,
  sessionID: string,
  plan: string,
): never {
  st.journaler.journal({
    type: "blocked",
    sessionID,
    agent: st.config.agents.executor,
    reason: "maintenance-capped",
    plan,
  })
  throw new BlockError(
    `BLOCKED by turnstile: the maintenance dispatch cap (${MAINTENANCE_MAX_PER_PLAN}) is spent ` +
      `for plan "${plan}" — dispatch the ${st.config.agents.planReviewer} subagent for a ` +
      `re-review, or obtain an explicit user waiver (a user prompt this task must contain ` +
      `the literal marker '${st.config.waiverMarker}' followed by the user's words).`,
    "plan-gate",
  )
}

/**
 * The executor branch of the guard chain: maintenance classification first
 * (an admitted dispatch is allowed without touching the plan gates; a capped
 * one escalates), then the deferred plan-gate once-grant consume (an
 * ordinary dispatch released by the grant skips the gates), then the
 * plan/decomposition guards.
 * @param st The dispatch-guard state.
 * @param sessionID The dispatching session ID.
 * @param agent The resolved agent name.
 * @param prompt The dispatch prompt.
 * @param description The trace-gated dispatch description.
 * @param waived The budget guard's waiver-exemption verdict.
 * @returns True when the dispatch was admitted inside this arm (the caller
 *     returns without the ordinary admit exit).
 */
async function guardExecutorDispatch(
  st: DispatchGuardState,
  sessionID: string,
  agent: string,
  prompt: string,
  description: string,
  waived: boolean,
): Promise<boolean> {
  const maintenance = await classifyMaintenanceDispatchBody(st, sessionID, prompt)
  if (maintenance === "admit") {
    allowDispatchBody(st, sessionID, agent, description, waived)
    return true
  }
  if (maintenance === "capped") {
    maintenanceCappedBlockBody(st, sessionID, st.ledger.state(sessionID).approvedPlan)
  }
  if (consumePlanGrantBody(st, sessionID, agent)) {
    allowDispatchBody(st, sessionID, agent, description, waived)
    return true
  }
  await enforceExecutorGatesBody(st, sessionID, prompt)
  return false
}

/**
 * The dormant-until-engaged arm of a task dispatch: a dormant session's
 * dispatch is allowed without touching the plan gates — except an actual
 * planner dispatch, which engages the pipeline first (R2's dispatch trigger).
 * @param st The dispatch-guard state.
 * @param sessionID The dispatching session ID.
 * @param agent The resolved agent name.
 * @param description The trace-gated dispatch description.
 * @returns True when the dispatch was settled inside this arm (the caller
 *     returns without running the guard chain).
 */
function dormantDispatchArm(
  st: DispatchGuardState,
  sessionID: string,
  agent: string,
  description: string,
): boolean {
  if (st.enforcementArmed(sessionID)) return false
  const s = st.ledger.state(sessionID)
  if (agent === st.config.agents.planner && !s.engaged) {
    s.engaged = true
    st.journalEngagement(sessionID, true, "dispatch-request")
    // Fall through to the full guard chain: the planner dispatch that
    // armed enforcement is itself governed.
    return false
  }
  allowDispatchBody(st, sessionID, agent, description, false)
  if (agent === st.config.agents.reviewer) {
    // Symmetry with the engaged path: the ensemble counter and its journal
    // entry live outside countDispatch, so the dormant arm must count the
    // reviewer leg explicitly or a mid-task engagement drop wedges the
    // landing gate (reviewerDispatches stays 0 at APPROVE time).
    st.gates.countReviewerEnsemble(sessionID, st.ledger)
  }
  return true
}

/**
 * Arms the user-review pause at planner-dispatch admit time: a planner
 * dispatch is the moment a plan-writing round begins, so the pause survives
 * the next prompt boundary regardless of task-scope reset (the flag is in
 * the `carryStickyFlags` set). Inert unless `planUserReview` is on; a
 * re-plan re-arms naturally (an already-pending flag journals nothing).
 * @param st The dispatch-guard state.
 * @param sessionID The dispatching session ID.
 */
function armPlanReviewBody(st: DispatchGuardState, sessionID: string): void {
  if (!st.config.planUserReview) return
  const s = st.ledger.state(sessionID)
  if (s.planReviewPending) return
  s.planReviewPending = true
  st.journaler.journal({ type: "plan-review", sessionID, action: "pause" })
}

/**
 * The user-review pause arm for a plan-reviewer dispatch: while the pending
 * flag holds (and `planUserReview` is on), the dispatch is blocked with a
 * deliberate `BLOCKED by turnstile:` error naming the plans dir and both
 * literals — fail-toward-strict, consistent with the plan-approval gate it
 * precedes. Returns without throwing when the feature is off or nothing is
 * pending; otherwise journals the blocked row and throws (never returns
 * normally while pending).
 * @param st The dispatch-guard state.
 * @param sessionID The dispatching session ID.
 */
function planReviewPendingBlockBody(st: DispatchGuardState, sessionID: string): void {
  if (!st.config.planUserReview) return
  if (!st.ledger.state(sessionID).planReviewPending) return
  st.journaler.journal({
    type: "blocked",
    sessionID,
    agent: st.config.agents.planReviewer,
    reason: "plan-review-pending",
  })
  throw new BlockError(
    `BLOCKED by turnstile: user plan review is enabled (planUserReview) and the planner ` +
      `wrote a plan for this task. Present the plan file(s) under ${st.config.plansDir} to ` +
      `the user for review and edits; dispatch this ${st.config.agents.planReviewer} only ` +
      `after the user's OWN prompt contains ${st.config.planReviewAcceptMarker} (accept — ` +
      `the edited file is what the reviewer reads), or ${st.config.planReviewRejectMarker} ` +
      `to abort/regenerate without a reviewer round. Do not fabricate or relay these markers.`,
    "plan-gate",
  )
}

/**
 * Guard-and-meter-and-journal section of a task dispatch: the budget guard,
 * the reviewer evidence guard, and the executor branch — then the counters
 * advance and the dispatch entry is recorded at the admitted exit (a blocked
 * attempt draws down nothing; stamped `blocked:true` only on a deliberate
 * BlockError, which is re-thrown for the outer fail-open catch).
 * @param st The dispatch-guard state.
 * @param sessionID The dispatching session ID.
 * @param agent The resolved agent name.
 * @param prompt The dispatch prompt.
 * @param description The trace-gated dispatch description.
 */
async function guardedTaskDispatchBody(
  st: DispatchGuardState,
  sessionID: string,
  agent: string,
  prompt: string,
  description: string,
): Promise<void> {
  let waived = false
  try {
    if (dormantDispatchArm(st, sessionID, agent, description)) return
    waived = dispatchBudgetBody(st, sessionID, agent)
    if (agent === st.config.agents.reviewer) reviewerDecisionRecheckBody(st, sessionID)
    // The user-review pause sits after the reviewer recheck and before the
    // executor branch. It is unreachable while dormant: arming implies
    // engagement (the planner dispatch that armed the pause ran the full
    // chain and engaged the pipeline), so a dormant session never has the
    // pending flag set. The pending read is wrapped fail-open: an internal
    // error journals and falls through (dispatch allowed) — only the
    // deliberate block throws.
    if (agent === st.config.agents.planReviewer) planReviewPauseFailOpen(st, sessionID)
    if (
      agent === st.config.agents.executor &&
      (await guardExecutorDispatch(st, sessionID, agent, prompt, description, waived))
    ) {
      return
    }
    if (agent === st.config.agents.planner) planReviewArmFailOpen(st, sessionID)
    allowDispatchBody(st, sessionID, agent, description, waived)
  } catch (e) {
    if (st.dispatchBlockOutcome(e, sessionID, agent, description, waived)) return
    throw e
  }
}

/**
 * Runs the plan-reviewer user-review pause wrapped fail-open: an internal
 * error journals and falls through (dispatch allowed) — only the deliberate
 * block rethrows for the outer fail-open catch.
 * @param st The dispatch-guard state.
 * @param sessionID The dispatching session ID.
 */
function planReviewPauseFailOpen(st: DispatchGuardState, sessionID: string): void {
  try {
    planReviewPendingBlockBody(st, sessionID)
  } catch (e) {
    if (e instanceof BlockError) throw e
    st.journaler.journal({ type: "error", sessionID, error: `plan-review gate: ${e}` })
  }
}

/**
 * Arms the plan-review pause for a planner dispatch wrapped fail-open: an
 * internal error journals and falls through (dispatch allowed). The arm
 * body never throws a deliberate block today; if it ever does, the error is
 * journaled like any other internal failure rather than blocking.
 * @param st The dispatch-guard state.
 * @param sessionID The dispatching session ID.
 */
function planReviewArmFailOpen(st: DispatchGuardState, sessionID: string): void {
  try {
    armPlanReviewBody(st, sessionID)
  } catch (e) {
    st.journaler.journal({ type: "error", sessionID, error: `plan-review arm: ${e}` })
  }
}

/**
 * Creates the dispatch-guard concern bound to the factory's shared state.
 * The bodies live at module level; the factory only builds the state object.
 * @param st The dispatch-guard state (see {@link DispatchGuardState}).
 * @returns The dispatch-guard methods the shared context exposes.
 */
export function createDispatchGuard(st: DispatchGuardState): {
  handleTaskDispatch(event: ToolHookEvent): Promise<void>
  guardedTaskDispatch(
    sessionID: string,
    agent: string,
    prompt: string,
    description: string,
  ): Promise<void>
  allowDispatch(sessionID: string, agent: string, description: string, waived: boolean): void
} {
  return {
    handleTaskDispatch: (event) => handleTaskDispatchBody(st, event),
    guardedTaskDispatch: (sessionID, agent, prompt, description) =>
      guardedTaskDispatchBody(st, sessionID, agent, prompt, description),
    allowDispatch: (sessionID, agent, description, waived) =>
      allowDispatchBody(st, sessionID, agent, description, waived),
  }
}
