/**
 * @fileoverview State-carry boundary: the fresh gate-state bucket factory and
 * the replay/continuation carry merge, extracted from `src/state.ts`. Pure
 * bookkeeping; the ledger boundary (`src/ledger.ts`) owns persistence.
 */

import type { GateState } from "./types.ts"
import { isInterruptedReview } from "./task-scope.ts"

/**
 * Builds the fresh boolean/display flag fields of a gate-state bucket.
 * @returns The flag fields at their fresh values.
 */
function freshFlags(): Pick<
  GateState,
  | "hasGatePass"
  | "unverifiedPass"
  | "lastGateMarker"
  | "lastVerdictMarker"
  | "hasPlanVerdict"
  | "hasReviewApprove"
  | "humanApproval"
  | "policyInjected"
  | "suppressedPending"
  | "readWarned"
> {
  return {
    hasGatePass: false,
    unverifiedPass: "",
    // Task-scoped last-marker text: fresh "" on every task-scope reset and never
    // carried through mergeAfterReplay (display-only, like unverifiedPass).
    lastGateMarker: "",
    lastVerdictMarker: "",
    hasPlanVerdict: false,
    hasReviewApprove: false,
    humanApproval: false,
    policyInjected: false,
    suppressedPending: 0,
    readWarned: false,
  }
}

/**
 * Builds the fresh standing-release and task-lifecycle flag fields.
 * @returns The release/retire/grace/engagement fields at their fresh values.
 */
function freshReleaseFlags(): Pick<
  GateState,
  "handsOnRelease" | "stickyRelease" | "taskComplete" | "replayGrace" | "engaged"
> {
  return {
    // Task-scoped standing release from a human `always` reply to a hands-on
    // ask. Fresh false on every task-scope reset; restart-restored by the
    // sticky-decision replay (a replayed `always` hands-on decision row
    // re-stamps it) and carried through mergeAfterReplay like the other
    // standing releases — a restart mid-task keeps the release (#228.2).
    handsOnRelease: false,
    // Task-scoped standing human release provenance (waiver captured through
    // the sticky decision-row family, or restored by replay). Fresh false;
    // restart-sticky.
    stickyRelease: false,
    // Explicit/implicit task retire: set by a GATE: PASS flip or a
    // taskDoneMarker prompt; the NEXT admitted task-scope resets for a fresh
    // task. Never carried through mergeAfterReplay.
    taskComplete: false,
    // A freshly-built bucket has no outstanding replay grace; only a journal
    // replay (createLedger) grants it, and only for one prompt.
    replayGrace: false,
    // Dormant-until-engaged: a fresh bucket never enforces until engagement
    // capture (or a planner dispatch) arms it. Restart-sticky through
    // mergeAfterReplay; every transition journals an `engagement` row.
    engaged: false,
  }
}

/**
 * Builds the fresh waiver family: task-scoped — cleared on an ordinary
 * task-scope reset, but carried one prompt through mergeAfterReplay (like the
 * restart-sticky flags) so a grace prompt keeps the waiver self-consistent
 * for the block messages that read it. Fresh here: scope [] (unscoped),
 * consumed false, the scoped-waiver allowance counter 0.
 * @returns The waiver-family fields at their fresh values.
 */
function freshWaiverFamily(): Pick<
  GateState,
  "userWaiver" | "userWaiverScope" | "userWaiverConsumed" | "reviewWaiverRounds"
> {
  return {
    userWaiver: "",
    userWaiverScope: [],
    userWaiverConsumed: false,
    reviewWaiverRounds: 0,
  }
}

/**
 * Builds the fresh per-reason single-dispatch grants (plan / landing /
 * hands-on): fresh "" on every task reset, task-scoped, never carried through
 * mergeAfterReplay.
 * @returns The once-grant fields at their fresh values.
 */
function freshOnceGrants(): Pick<GateState, "pendingOnceGrant"> {
  return {
    pendingOnceGrant: { plan: "", landing: "", handsOn: "" },
  }
}

/**
 * Builds the fresh metering counters: the round and dispatch counters, the
 * block counters, and the read counter. Per-leg loop caps are fresh 0 on
 * every task-scope reset, task-scoped, never carried through
 * mergeAfterReplay; the landing-block counter is restored by journal replay
 * across a restart; the hands-on block counter is never replay-restored (a
 * restart mid-task drops it; the ladder re-blocks and re-arms).
 * @returns The counter fields at their fresh values.
 */
function freshCounters(): Pick<
  GateState,
  | "reviewRounds"
  | "reviewerDispatches"
  | "plannerRounds"
  | "planReviewerRounds"
  | "testRunnerRounds"
  | "totalDispatches"
  | "landingBlocks"
  | "handsOnBlocks"
  | "reads"
> {
  return {
    reviewRounds: 0,
    // Task-scoped ensemble count of unwaived reviewer dispatches; restart-sticky
    // (restored by journal replay, carried one prompt via mergeAfterReplay),
    // fresh 0 on an ordinary task-scope reset.
    reviewerDispatches: 0,
    // Per-leg loop caps: fresh 0 on every task-scope reset, task-scoped,
    // never carried through mergeAfterReplay. A dispatcher that exhausts its leg
    // cap is reported as looping; totalDispatches is the global backstop.
    plannerRounds: 0,
    planReviewerRounds: 0,
    testRunnerRounds: 0,
    totalDispatches: 0,
    // Task-scoped landing-gate block counter: fresh 0 on every task-scope reset.
    // Restored by journal replay across a restart.
    landingBlocks: 0,
    // Task-scoped parent hands-on (write/edit) block counter: arms the
    // permission-ask escalation on a repeat attempt. Fresh 0 on every task-scope
    // reset, never carried through mergeAfterReplay and never replay-restored
    // (a restart mid-task drops it; the ladder re-blocks and re-arms).
    handsOnBlocks: 0,
    reads: 0,
  }
}

/**
 * Builds the fresh plan/task identity fields. Bound plan identity: "" =
 * unbound until a plan-reviewer dispatch names a single existing plan file
 * (see src/gates.ts); restart-sticky, paired with hasPlanVerdict across
 * replay and the grace-prompt carry.
 * @returns The identity fields at their fresh values.
 */
function freshPlanIdentity(): Pick<
  GateState,
  "plansSignature" | "approvedPlan" | "approvedPlanKey" | "activePlan" | "taskFingerprint"
> {
  return {
    plansSignature: "",
    approvedPlan: "",
    approvedPlanKey: "",
    // Active task identity: the path-free name of the most recently
    // plan-approved plan file; "" while planless (the worktree fingerprint
    // governs scope instead). Set only by a plan-approval event, restored by
    // the replay scope fold, carried through mergeAfterReplay while
    // hasPlanVerdict holds.
    activePlan: "",
    // No task stamped yet on a fresh bucket; prompt admission stamps the
    // worktree/branch identity this carry predicate keys off.
    taskFingerprint: "",
  }
}

/**
 * Builds the fresh marker-dedup provenance structures.
 * @returns The dedup map/set fields at their fresh values.
 */
function freshDedup(): Pick<GateState, "seenFrom" | "seen"> {
  return {
    seenFrom: new Map(),
    seen: new Set(),
  }
}

/**
 * Creates a fresh gate state bucket for one parent session.
 * @returns An empty GateState with an empty marker-dedup set.
 */
export function newState(): GateState {
  return {
    ...freshFlags(),
    ...freshReleaseFlags(),
    ...freshWaiverFamily(),
    ...freshOnceGrants(),
    ...freshCounters(),
    ...freshPlanIdentity(),
    ...freshDedup(),
  }
}

/**
 * Carries the restart-sticky flag bundle into the grace-prompt bucket:
 * `hasGatePass`, `engaged`, `hasPlanVerdict`, `humanApproval`,
 * `hasReviewApprove`, `handsOnRelease`, `stickyRelease`, and the ensemble
 * dispatch count (restart-sticky *paired with* hasReviewApprove: journaled
 * dispatches and the credited review must agree across a restart).
 * @param s The grace-prompt bucket to mutate.
 * @param prior The replayed or continuation-carry bucket being reset.
 */
function carryStickyFlags(s: GateState, prior: GateState): void {
  s.hasGatePass = prior.hasGatePass
  // Engagement is restart-sticky like the gate flags: a restart mid-task
  // keeps enforcement armed; the no-carry reset (a fresh bucket from the
  // early return or a non-carried reset) drops it — the "no continuation
  // credit" disengagement case.
  s.engaged = prior.engaged
  s.hasPlanVerdict = prior.hasPlanVerdict
  // Restart-sticky like hasPlanVerdict: a restored human approval survives the
  // first post-restart prompt (restart-sticky provenance, never task-scoped).
  s.humanApproval = prior.humanApproval
  // hasReviewApprove is the landing gate's release signal, restart-sticky like
  // hasPlanVerdict: a reviewer APPROVE restored by replay survives the first
  // post-restart prompt (and the reset below clears it on the next prompt).
  s.hasReviewApprove = prior.hasReviewApprove
  // Standing releases are restart-sticky like the flags above: a hands-on
  // `always` release restored by the sticky-decision replay (and the waiver
  // sticky-release provenance) survives the first post-restart prompt — the
  // task-scoped human release must not be dropped by a restart.
  s.handsOnRelease = prior.handsOnRelease
  s.stickyRelease = prior.stickyRelease
  // The ensemble count is restart-sticky *paired with* hasReviewApprove: journaled
  // dispatches and the credited review must agree across a restart, so the grace
  // prompt carries the carried-together count too.
  s.reviewerDispatches = prior.reviewerDispatches
}

/**
 * Carries the plan identity fields, each gated on `hasPlanVerdict`: a wiped
 * (or absent) verdict carries no identity.
 * @param s The grace-prompt bucket to mutate.
 * @param prior The replayed or continuation-carry bucket being reset.
 */
function carryPlanIdentity(s: GateState, prior: GateState): void {
  s.plansSignature = prior.hasPlanVerdict ? prior.plansSignature : ""
  // Bound plan identity travels with hasPlanVerdict exactly like the dir
  // signature: a wiped (or absent) verdict carries no identity.
  s.approvedPlan = prior.hasPlanVerdict ? prior.approvedPlan : ""
  s.approvedPlanKey = prior.hasPlanVerdict ? prior.approvedPlanKey : ""
  // The active task's plan identity travels with hasPlanVerdict exactly like
  // the bound identity: a wiped (or absent) verdict carries no scope.
  s.activePlan = prior.hasPlanVerdict ? prior.activePlan : ""
}

/**
 * Carries the waiver family as a unit so the carried bucket stays
 * self-consistent: the block-message readers pair its fields, so dropping any
 * one would misreport the others at the next block site. Replay restores the
 * redacted presence marker (`"<present>"`) through the scope fold, so a
 * journal-replay bucket can arrive with a live waiver too — the carry then
 * keeps the restored family intact for the grace prompt (and a
 * continuation-carry bucket may hold a fully-captured one).
 * @param s The grace-prompt bucket to mutate.
 * @param prior The replayed or continuation-carry bucket being reset.
 */
function carryWaiverFamily(s: GateState, prior: GateState): void {
  s.userWaiver = prior.userWaiver
  s.userWaiverScope = [...prior.userWaiverScope]
  s.userWaiverConsumed = prior.userWaiverConsumed
  s.reviewWaiverRounds = prior.reviewWaiverRounds
}

/**
 * Builds the gate state for the grace prompt — the first prompt after a
 * journal replay or a same-worktree continuation re-admission: carries the
 * prior bucket's current flag _values_ forward — not provenance — so a live
 * `GATE: FAIL` after replay is never resurrected. The carry set is the
 * restart-sticky bundle: `hasGatePass`, `hasPlanVerdict`, `humanApproval`,
 * `hasReviewApprove`, `handsOnRelease`, `stickyRelease`,
 * `reviewerDispatches`, and the fields paired with
 * `hasPlanVerdict` — the `plansSignature` stamp and the bound plan identity
 * (`approvedPlan`/`approvedPlanKey`) — carried only while `hasPlanVerdict`
 * itself survives. The waiver family (`userWaiver`, `userWaiverScope`,
 * `userWaiverConsumed`, `reviewWaiverRounds`) travels as a unit: replay
 * restores the redacted presence marker (`"<present>"`) through the scope
 * folds (`restoreScopeFolds` in `src/ledger.ts`), so a journal-replay bucket
 * can arrive with a live waiver — the carry keeps the restored family intact
 * for the grace prompt (and a continuation-carry bucket may hold a fully-
 * captured one). The family must stay self-consistent because the
 * block-message readers pair its fields (`waiverCovers` reads the quote +
 * scope, `waiverStateNote` adds the consumed flag, and the reviewer round-cap
 * allowance clause reads the scope + spent slots) — dropping any one would
 * misreport the others at the next block site. Everything else is
 * deliberately dropped: `unverifiedPass` and the raw marker text are
 * display/diagnostic state whose flags are already replay-restored,
 * `pendingOnceGrant` must not outlive its single dispatch, `policyInjected`
 * is per-task policy re-supply, the loop-cap counters (`reviewRounds`,
 * `plannerRounds`, `planReviewerRounds`, `testRunnerRounds`,
 * `totalDispatches`, `landingBlocks`, `handsOnBlocks`) intentionally re-arm
 * on every task-scope reset, and the dedup/telemetry/fingerprint fields
 * (`seenFrom`, `suppressedPending`, `reads`, `readWarned`, `seen`,
 * `replayGrace`, `taskFingerprint`) are intrinsic to this bucket —
 * `replayGrace` is consumed by design and `taskFingerprint` is re-stamped
 * by the caller. The returned bucket's `replayGrace` is consumed (false).
 * @param prior The replayed or continuation-carry bucket being reset.
 * @returns A reset bucket with the prior flags; grace consumed.
 */
export function mergeAfterReplay(prior: GateState): GateState {
  const s = newState()
  // A completed task carries NOTHING: the retire is the task boundary, so no
  // flag, release, counter, or plan identity from it reaches the next task —
  // except the interrupted-review recovery: a green gate with reviewer
  // activity already counted and no credited approval was an aborted review,
  // so the earned context rides the grace window for re-dispatch.
  if (prior.taskComplete && !isInterruptedReview(prior)) return s
  carryStickyFlags(s, prior)
  carryPlanIdentity(s, prior)
  carryWaiverFamily(s, prior)
  return s
}
