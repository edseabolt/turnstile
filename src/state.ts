/**
 * @fileoverview State boundary: per-session gate state shape (fresh bucket,
 * metering-counter clearing), snapshot and pipeline rendering, and the
 * replay merge (`mergeAfterReplay`). The ledger boundary (`src/ledger.ts`) owns
 * persistence: the LRU session maps, journal replay, and eviction protection.
 * Pure bookkeeping; no enforcement decisions here.
 */

import type { GateState } from "./types.ts"
import { isInterruptedReview } from "./task-scope.ts"

/**
 * Creates a fresh gate state bucket for one parent session.
 * @returns An empty GateState with an empty marker-dedup set.
 */
export function newState(): GateState {
  return {
    hasGatePass: false,
    unverifiedPass: "",
    // Task-scoped last-marker text: fresh "" on every task-scope reset and never
    // carried through mergeAfterReplay (display-only, like unverifiedPass).
    lastGateMarker: "",
    lastVerdictMarker: "",
    hasPlanVerdict: false,
    hasReviewApprove: false,
    // Waiver family: task-scoped — cleared on an ordinary task-scope reset, but
    // carried one prompt through mergeAfterReplay (like the restart-sticky
    // flags) so a grace prompt keeps the waiver self-consistent for the block
    // messages that read it. Fresh here: scope [] (unscoped), consumed false,
    // the scoped-waiver allowance counter 0.
    userWaiver: "",
    userWaiverScope: [],
    userWaiverConsumed: false,
    reviewWaiverRounds: 0,
    humanApproval: false,
    // Per-reason single-dispatch grants (plan / landing / hands-on): fresh ""
    // on every task reset, task-scoped, never carried through mergeAfterReplay.
    pendingOnceGrant: { plan: "", landing: "", handsOn: "" },
    policyInjected: false,
    seenFrom: new Map(),
    suppressedPending: 0,
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
    reads: 0,
    readWarned: false,
    seen: new Set(),
    plansSignature: "",
    // Bound plan identity: "" = unbound until a plan-reviewer dispatch names a
    // single existing plan file (see src/gates.ts). Restart-sticky, paired
    // with hasPlanVerdict across replay and the grace-prompt carry.
    approvedPlan: "",
    approvedPlanKey: "",
    // Active task identity: the path-free name of the most recently
    // plan-approved plan file; "" while planless (the worktree fingerprint
    // governs scope instead). Set only by a plan-approval event, restored by
    // the replay scope fold, carried through mergeAfterReplay while
    // hasPlanVerdict holds.
    activePlan: "",
    // Explicit/implicit task retire: set by a GATE: PASS flip or a
    // taskDoneMarker prompt; the NEXT admitted task-scope resets for a fresh
    // task. Never carried through mergeAfterReplay.
    taskComplete: false,
    // A freshly-built bucket has no outstanding replay grace; only a journal
    // replay (createLedger) grants it, and only for one prompt.
    replayGrace: false,
    // No task stamped yet on a fresh bucket; prompt admission stamps the
    // worktree/branch identity this carry predicate keys off.
    taskFingerprint: "",
  }
}

/**
 * Clears the metering counters on a gate state bucket so its dispatches are
 * re-admitted: the round and dispatch counters (`reviewRounds`,
 * `reviewWaiverRounds`, `plannerRounds`, `planReviewerRounds`,
 * `testRunnerRounds`, `totalDispatches`, `landingBlocks`, `handsOnBlocks`,
 * `reads`), the read warning flag, and any pending unverified gate-refusal
 * claim. Earned credit
 * (the gate/plan/review flags, the ensemble dispatch count, approvals, and
 * waivers) is untouched — clearing a counter never withdraws credit already
 * granted. The unverified-claim reset is the fail-open direction: it drops a
 * stale pending refusal, never grants credit; the next unverified claim
 * re-registers in the session's fresh window.
 * @param s The gate state bucket whose metering counters to clear.
 * @returns True iff any metering counter was non-fresh before clearing, so a
 *     caller can suppress a no-op release.
 */
export function clearMeteringCounters(s: GateState): boolean {
  const wasMetering =
    s.reviewRounds !== 0 ||
    s.reviewWaiverRounds !== 0 ||
    s.plannerRounds !== 0 ||
    s.planReviewerRounds !== 0 ||
    s.testRunnerRounds !== 0 ||
    s.totalDispatches !== 0 ||
    s.landingBlocks !== 0 ||
    s.handsOnBlocks !== 0 ||
    s.reads !== 0
  s.reviewRounds = 0
  s.reviewWaiverRounds = 0
  s.plannerRounds = 0
  s.planReviewerRounds = 0
  s.testRunnerRounds = 0
  s.totalDispatches = 0
  s.landingBlocks = 0
  s.handsOnBlocks = 0
  s.reads = 0
  s.readWarned = false
  s.unverifiedPass = ""
  return wasMetering
}

/**
 * Projects a live ledger bucket into the system-block turnstile appends at
 * compaction: the concrete gate state (last GATE/VERDICT markers, plan and
 * reviewer approval, round/dispatch counts, waiver/human flags, landing,
 * hands-on, and read counts, task fingerprint) rather than merely demanding
 * markers the orchestrator may no longer remember. A pure read of `GateState` — it never
 * journals, mints, or throws, so it is safe on the compaction hook — and a
 * restart-restored bucket still renders `GREEN`/`APPROVED` with `last=none`
 * because replay restores the flags (journaled) but not the raw marker text.
 * @param s The gate state bucket to render (from `ledger.peek`).
 * @returns The snapshot block, one fact per line, joined by newlines.
 */
export function formatGateSnapshot(s: GateState): string {
  const gateUnverified = s.unverifiedPass ? ` unverified=${s.unverifiedPass}` : ""
  // Exactly one of four waiver states: live+unscoped, live+scoped (the parsed
  // scope, comma-joined), consumed (an unscoped waiver the reviewer gate
  // spent), or none. `reviewWaiverRounds` is deliberately not rendered here —
  // the round-limit block message is the allowance authority, and the
  // `- rounds:` line stays byte-stable.
  const waiverStatus =
    s.userWaiver !== ""
      ? s.userWaiverScope.length > 0
        ? `ACTIVE(${s.userWaiverScope.join(", ")})`
        : "ACTIVE"
      : s.userWaiverConsumed
        ? "none(consumed)"
        : "none"
  return [
    "turnstile gate snapshot (live ledger; authoritative; do not re-derive):",
    `- gate: ${s.hasGatePass ? "GREEN" : "RED"} last=${s.lastGateMarker || "none"}${gateUnverified}`,
    `- plan: ${s.hasPlanVerdict ? "APPROVED" : "PENDING"}${s.approvedPlan !== "" ? ` plan=${s.approvedPlan}` : ""} stamp=${s.plansSignature ? "known" : "unknown"}`,
    `- reviewer: ${s.hasReviewApprove ? "APPROVED" : "PENDING"} dispatches=${s.reviewerDispatches} last=${s.lastVerdictMarker || "none"}`,
    `- waiver: ${waiverStatus} human: ${s.humanApproval ? "APPROVED" : "none"}`,
    `- rounds: planner=${s.plannerRounds} plan-reviewer=${s.planReviewerRounds} test-runner=${s.testRunnerRounds} reviewer=${s.reviewRounds} total=${s.totalDispatches}`,
    `- landing: blocks=${s.landingBlocks} reads=${s.reads} hands-on blocks=${s.handsOnBlocks}`,
    `- task: ${s.taskFingerprint || "unstamped"}`,
  ].join("\n")
}

/**
 * The unwaived reviewer dispatches counted per task that the landing gate
 * requires before a reviewer `APPROVE` is credited, under
 * `reviewEnsemble: enforce`. Canonical value consumed by both the
 * enforcement sites in `src/gates.ts` and the status renderer below, so the
 * count cannot drift between the gate and the line that reports it.
 */
export const REVIEW_ENSEMBLE_SIZE = 2

/**
 * The five pipeline stages' agent names, read from `config.agents`. A
 * structural shape, not a config-schema key: `config.agents` satisfies it
 * directly, so the status renderer routes successor names through the
 * configured values — a renamed install names its renamed stages.
 */
export interface PipelineStages {
  planner: string
  planReviewer: string
  executor: string
  testRunner: string
  reviewer: string
}

/**
 * Computes the successor stage for the pipeline stage that just completed.
 * Every transition is decidable from the gate flags on the just-arrived
 * delivery: the plan-reviewer re-dispatches the planner only while no verdict
 * is credited yet (BLOCK → re-plan); the test-runner re-dispatches the
 * executor only while the gate is not green (FAIL → re-run); the reviewer
 * names the second ensemble dispatch until the count reaches
 * `REVIEW_ENSEMBLE_SIZE`, names the landing after a credited `APPROVE`, and
 * escalates once the ensemble is exhausted without approval. A name that is
 * not one of the five stages (including the debugger and unknown names)
 * returns "" — the caller skips the status line; this matches the
 * injection's residual for non-pipeline deliveries.
 * @param s The gate state bucket after the just-arrived delivery.
 * @param stages The configured agent names for the five pipeline stages.
 * @param justCompleted The agent name of the stage that just completed.
 * @returns The configured name of the successor stage, or the literals
 *     "land"/"escalate"; "" when `justCompleted` is not a pipeline stage.
 */
function nextStage(s: GateState, stages: PipelineStages, justCompleted: string): string {
  if (justCompleted === stages.planner) return stages.planReviewer
  if (justCompleted === stages.planReviewer)
    return s.hasPlanVerdict ? stages.executor : stages.planner
  if (justCompleted === stages.executor) return stages.testRunner
  if (justCompleted === stages.testRunner) return s.hasGatePass ? stages.reviewer : stages.executor
  if (justCompleted === stages.reviewer)
    return s.hasReviewApprove
      ? "land"
      : s.reviewerDispatches < REVIEW_ENSEMBLE_SIZE
        ? stages.reviewer
        : "escalate"
  return ""
}

/**
 * Renders the per-delivery pipeline status line appended to the model-visible
 * task result: one line reporting the just-completed stage, the live plan and
 * test gate flags, the reviewer ensemble count, and the successor stage the
 * orchestrator should dispatch next. A pure read of `GateState` — it never
 * journals, mints, or throws — so it is safe on the injection path, and a
 * restart-restored bucket still renders from the restored flags. Returns ""
 * for a `justCompleted` that is not a pipeline stage; the caller skips the
 * append entirely, leaving non-pipeline deliveries byte-identical.
 *
 * Every status word is a non-marker token, so an echoed copy of the line
 * never parses as a `GATE:`/`VERDICT:` marker — the same `<n>`-placeholder
 * philosophy the injected policy follows.
 *
 * Capped-leg residual (documented, not threaded): the other legs carry
 * dispatch caps too (planner 3, plan-reviewer 3, test-runner 4). On a capped
 * round the line may name a stage the dispatch gate will refuse; it reports
 * the pipeline's nominal successor, not the gate's cap check.
 * @param s The gate state bucket after the just-arrived delivery.
 * @param stages The configured agent names for the five pipeline stages.
 * @param justCompleted The agent name of the stage that just completed.
 * @returns The status line, or "" when `justCompleted` is not a pipeline stage.
 */
export function formatPipelineStatus(
  s: GateState,
  stages: PipelineStages,
  justCompleted: string,
): string {
  const next = nextStage(s, stages, justCompleted)
  if (next === "") return ""
  const plan = s.hasPlanVerdict ? "APPROVED" : "PENDING"
  const tests = s.hasGatePass ? "GREEN" : "RED"
  const tail =
    next === "land"
      ? "task complete; land through the gated push"
      : next === "escalate"
        ? "escalate to the user"
        : "dispatch the next agent in this same turn"
  return `PIPELINE: ${justCompleted}=done plan=${plan} tests=${tests} reviewer=${s.reviewerDispatches}/${REVIEW_ENSEMBLE_SIZE} next=${next} — ${tail}`
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
  s.hasGatePass = prior.hasGatePass
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
  s.plansSignature = prior.hasPlanVerdict ? prior.plansSignature : ""
  // Bound plan identity travels with hasPlanVerdict exactly like the dir
  // signature: a wiped (or absent) verdict carries no identity.
  s.approvedPlan = prior.hasPlanVerdict ? prior.approvedPlan : ""
  s.approvedPlanKey = prior.hasPlanVerdict ? prior.approvedPlanKey : ""
  // The active task's plan identity travels with hasPlanVerdict exactly like
  // the bound identity: a wiped (or absent) verdict carries no scope.
  s.activePlan = prior.hasPlanVerdict ? prior.activePlan : ""
  // The waiver family travels together so the carried bucket stays
  // self-consistent: the block-message readers pair its fields, so dropping
  // any one would misreport the others at the next block site. Replay
  // restores the redacted presence marker (`"<present>"`) through the scope
  // fold, so a journal-replay bucket can arrive with a live waiver too — the
  // carry then keeps the restored family intact for the grace prompt (and a
  // continuation-carry bucket may hold a fully-captured one).
  s.userWaiver = prior.userWaiver
  s.userWaiverScope = [...prior.userWaiverScope]
  s.userWaiverConsumed = prior.userWaiverConsumed
  s.reviewWaiverRounds = prior.reviewWaiverRounds
  return s
}
