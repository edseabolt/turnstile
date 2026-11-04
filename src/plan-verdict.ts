/**
 * @fileoverview Plan-verdict concern: stamping a plan-reviewer verdict's
 * approval against the current plans dir (binding the plan identity),
 * journaling the attributed `plan` entry, recording the durable approval,
 * and applying the reset-at-capture scope rule when the bound plan changes.
 * Extracted from `src/hooks-core.ts`; the shared per-setup state is threaded
 * as one typed state object. Never throws (fail-open callers guard the
 * capture paths).
 */

import type { Journaler } from "./journal.ts"
import type { GateLedger } from "./ledger.ts"
import type { GateState } from "./types.ts"
import type { Gates } from "./gates.ts"
import { approvalResetsScope } from "./task-scope.ts"

/**
 * The state the plan-verdict concern reads and mutates: the shared deps and
 * the cross-concern helpers it delegates to.
 */
export interface PlanVerdictState {
  /** The telemetry journal writer. */
  journaler: Journaler
  /** The gate-state ledger (buckets + the durable approval store). */
  ledger: GateLedger
  /** Gate decision service (plans-dir signature + binding resolution). */
  gates: Gates
  /** Parent → plan file names from its latest plan-reviewer dispatch. */
  planReviewTarget: Map<string, string[]>
  /** Resolves the project directory via session.get, caching per session. */
  resolveProjectDir(sessionID: string): Promise<string>
  /** Clears a session's entire intent-nudge state. */
  clearIntentNudge(sessionID: string): void
  /** Performs a full task-scope reset for a parent. */
  resetTaskScope(sessionID: string, merge?: boolean): void
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
 * @param st The plan-verdict state.
 * @param s The session's gate state (mutated).
 * @param result The verdict result ("APPROVE" or "BLOCK").
 * @param projectDir The current project directory (for the plans-dir scan).
 * @param candidates The plan names extracted from the dispatch prompt
 *     (the round's binding candidates).
 */
function stampPlanApprovalBody(
  st: PlanVerdictState,
  s: GateState,
  result: string,
  projectDir: string,
  candidates: string[],
): void {
  if (result === "APPROVE") {
    s.plansSignature = st.gates.plansSignature(projectDir) ?? ""
    const b = st.gates.planApprovalBinding(projectDir, candidates)
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
function planApprovalStampFieldsBody(s: GateState): {
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
 * @param st The plan-verdict state.
 * @param s The session's gate state (stamped by stampPlanApproval).
 * @param projectDir The project directory the approval is recorded under.
 */
function recordDurablePlanApprovalBody(
  st: PlanVerdictState,
  s: GateState,
  projectDir: string,
): void {
  if (s.approvedPlan === "") return
  st.ledger.recordPlanApprovalDurable(s.approvedPlan, s.approvedPlanKey, projectDir)
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
 * @param st The plan-verdict state.
 * @param sessionID The parent session the approval binds for.
 * @param projectDir The current project directory (for the plans-dir scan).
 * @param candidates The plan names the approval's dispatch prompt named.
 * @param human True when the approval provenance is a human prompt marker.
 * @returns The approved bucket (post-reset when the scope changed).
 */
function applyApprovalBindingBody(
  st: PlanVerdictState,
  sessionID: string,
  projectDir: string,
  candidates: string[],
  human: boolean,
): GateState {
  const s0 = st.ledger.state(sessionID)
  const priorActive = s0.activePlan
  let s = s0
  stampPlanApprovalBody(st, s, "APPROVE", projectDir, candidates)
  const bound = s.approvedPlan
  if (approvalResetsScope(priorActive, bound, s0.taskComplete)) {
    // Reset-at-capture: snapshot the just-stamped identity, rebuild the
    // task scope CLEAN (no grace merge — see the doc), and re-apply it to
    // the fresh bucket.
    const savedPlan = s.approvedPlan
    const savedKey = s.approvedPlanKey
    const savedSig = s.plansSignature
    const savedFingerprint = s0.taskFingerprint
    st.resetTaskScope(sessionID, false)
    s = st.ledger.state(sessionID)
    s.approvedPlan = savedPlan
    s.approvedPlanKey = savedKey
    s.plansSignature = savedSig
    // The worktree identity is not task scope: the clean rebuild must not
    // wipe the stamp, or a later interrupted-review recovery carry would
    // find no fingerprint to match against.
    s.taskFingerprint = savedFingerprint
  }
  s.hasPlanVerdict = true
  if (human) s.humanApproval = true
  if (bound !== "") s.activePlan = bound
  return s
}

/**
 * The verdict-stamping arm of `journalPlanApproval`: an APPROVE applies the
 * reset-at-capture scope rule (a binding different from the bucket's
 * activePlan rebuilds the task scope before the new identity is used); a
 * BLOCK only stamps the hygiene clear.
 * @param st The plan-verdict state.
 * @param sessionID The parent session the approval binds for.
 * @param s The parent's gate state (`hasPlanVerdict` already set).
 * @param result The verdict result ("APPROVE" or "BLOCK").
 * @param projectDir The current project directory.
 * @param candidates The round's binding candidates.
 * @returns The approved bucket (post-reset when the scope changed).
 */
function stampPlanVerdict(
  st: PlanVerdictState,
  sessionID: string,
  s: GateState,
  result: "APPROVE" | "BLOCK",
  projectDir: string,
  candidates: string[],
): GateState {
  if (result === "APPROVE") {
    return applyApprovalBindingBody(st, sessionID, projectDir, candidates, false)
  }
  stampPlanApprovalBody(st, s, result, projectDir, candidates)
  return s
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
 * @param st The plan-verdict state.
 * @param sid The parent session the `plan` entry is keyed on.
 * @param raw The attributed child session ID for the entry's `raw` field.
 * @param result The verdict result ("APPROVE" or "BLOCK").
 * @param journalMarker The marker text to journal (each arm applies its own
 *     "<none>" fallback; the attributed arm's marker is always non-empty).
 * @param source The provenance label for the winning pipeline.
 * @param traceMarker The marker text for the trace event (each arm applies
 *     its own "<no verdict marker>" fallback).
 */
async function journalPlanApprovalBody(
  st: PlanVerdictState,
  sid: string,
  raw: string,
  result: "APPROVE" | "BLOCK",
  journalMarker: string,
  source: string,
  traceMarker: string,
): Promise<void> {
  const candidates = st.planReviewTarget.get(sid) ?? []
  const s = st.ledger.state(sid)
  s.hasPlanVerdict = result === "APPROVE"
  const projectDir = await st.resolveProjectDir(sid)
  const approved = stampPlanVerdict(st, sid, s, result, projectDir, candidates)
  st.journaler.journal({
    type: "plan",
    sessionID: sid,
    raw,
    result,
    marker: journalMarker,
    source,
    // Bound identity (so replay restores it) and the stamped dir signature
    // (so replay re-validates against the current plans dir); an unbound or
    // unstampable approval spreads nothing (legacy lines unchanged).
    ...planApprovalStampFieldsBody(approved),
  })
  st.journaler.traceEvent("plan-reviewer", "verdict", traceMarker, sid)
  if (result === "APPROVE") {
    // The attributed task has its plan: clear the intent-nudge latch exactly
    // like the human-marker approval arm, so a later task's detected intents
    // can nudge again.
    st.clearIntentNudge(sid)
  }
  recordDurablePlanApprovalBody(st, approved, projectDir)
}

/**
 * Creates the plan-verdict concern bound to the factory's shared state.
 * The bodies live at module level; the factory only builds the state object.
 * @param st The plan-verdict state (see {@link PlanVerdictState}).
 * @returns The plan-verdict methods the shared context exposes.
 */
export function createPlanVerdict(st: PlanVerdictState): {
  planApprovalStampFields(s: GateState): { plan?: string; planKey?: string; plansSig?: string }
  recordDurablePlanApproval(s: GateState, projectDir: string): void
  applyApprovalBinding(
    sessionID: string,
    projectDir: string,
    candidates: string[],
    human: boolean,
  ): GateState
  journalPlanApproval(
    sid: string,
    raw: string,
    result: "APPROVE" | "BLOCK",
    journalMarker: string,
    source: string,
    traceMarker: string,
  ): Promise<void>
} {
  return {
    planApprovalStampFields: (s) => planApprovalStampFieldsBody(s),
    recordDurablePlanApproval: (s, projectDir) => recordDurablePlanApprovalBody(st, s, projectDir),
    applyApprovalBinding: (sessionID, projectDir, candidates, human) =>
      applyApprovalBindingBody(st, sessionID, projectDir, candidates, human),
    journalPlanApproval: (sid, raw, result, journalMarker, source, traceMarker) =>
      journalPlanApprovalBody(st, sid, raw, result, journalMarker, source, traceMarker),
  }
}
