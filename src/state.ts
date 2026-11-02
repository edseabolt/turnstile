/**
 * @fileoverview State boundary: per-session gate state shape (fresh bucket,
 * metering-counter clearing), snapshot and pipeline rendering, and the
 * replay merge (`mergeAfterReplay`). The ledger boundary (`src/ledger.ts`) owns
 * persistence: the LRU session maps, journal replay, and eviction protection.
 * Pure bookkeeping; no enforcement decisions here.
 */

import type { GateState } from "./types.ts"

export { mergeAfterReplay, newState } from "./state-carry.ts"

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
    `- engaged: ${s.engaged ? "yes" : "no"}`,
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
