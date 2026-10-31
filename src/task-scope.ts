/**
 * @fileoverview Task-scope boundary: the active-task identity of a parent
 * session (`activePlan` — the path-free name of the most recently
 * plan-approved plan file — with the worktree fingerprint as the planless
 * fallback) and the pure predicates deciding whether an admitted prompt
 * changes the task scope. Scope resets exactly on: a plan-approval binding a
 * plan different from the bucket's `activePlan` (the capture resets before
 * stamping), an explicit retire (`taskComplete`), or a worktree-fingerprint
 * change while no plan is bound (the planless fallback keeps today's
 * per-prompt reset behavior). Prompt mentions of plan files never establish
 * or flip scope. Pure predicates over `GateState`; no fs, no journaling,
 * no throwing.
 */

import type { GateState } from "./types.ts"

/**
 * Decides whether an admitted prompt keeps the current task scope (no reset,
 * no task-scope drop). True only for a plan-bound bucket: a plan file is the
 * active task's identity, so every prompt while that plan is bound and the
 * task is not retired is the same scope — side chatter, follow-ups, and
 * unapproved mentions of other plans are no-ops for state. Everything else
 * resets: no prior bucket, a retired task (`taskComplete`), a planless
 * bucket (the worktree-fingerprint fallback preserves today's per-prompt
 * reset + continuation-carry behavior), and the `continuationCarry:false`
 * escape hatch (per-prompt reset even within the same plan scope; the
 * restart-replay `replayGrace` one-prompt grace is a separate mechanism and
 * is unaffected).
 * @param prior The prior prompt's gate state; `undefined` before any prompt.
 * @param continuationCarry The `continuationCarry` config flag, passed
 *     through so the predicate stays unit-testable without a real config.
 * @returns True when the admitted prompt is the same task scope (keep).
 */
export function keepsTaskScope(prior: GateState | undefined, continuationCarry: boolean): boolean {
  if (!continuationCarry) return false
  if (prior === undefined) return false
  if (prior.taskComplete) return false
  return prior.activePlan !== ""
}

/**
 * Decides whether a retired plan-bound task's earned state is recoverable: the
 * review phase was interrupted mid-flight. All three signals must hold — the
 * test gate went green (`hasGatePass`), no reviewer approval was credited yet
 * (`hasReviewApprove` false), and reviewer activity was already counted (at
 * least one counted dispatch or one waived reviewer round; waived dispatches
 * do not increment the dispatch counter, so the waiver counter is the only
 * witness for that path). A genuinely new task (no reviewer activity) or a
 * completed review (approval credited) is never recoverable. Pure predicate
 * over `GateState`; never throws.
 * @param prior The gate state to inspect.
 * @returns True when the state shows an interrupted post-PASS review.
 */
export function isInterruptedReview(prior: GateState): boolean {
  return (
    prior.hasGatePass &&
    !prior.hasReviewApprove &&
    (prior.reviewerDispatches >= 1 || prior.reviewWaiverRounds >= 1)
  )
}

/**
 * Decides whether a plan-approval event binding `boundPlan` changes the
 * bucket's task scope (the reset-at-capture rule). A binding approval resets
 * scope exactly when it binds a plan DIFFERENT from the bucket's current
 * `activePlan` — including the first binding over the empty planless
 * identity — or when the prior task is already retired (`taskComplete`: the
 * re-approval restarts the scope, matching the replay fold's post-completion
 * re-approval arm). An unbound approval (`""` — zero/ambiguous/unreadable
 * candidates) is a no-op for scope: it never establishes, flips, or resets.
 * Prompt mentions of plan files never reach this predicate (they only ride
 * the plan gate's prompt-referenced resolution).
 * @param priorActivePlan The bucket's current `activePlan` ("" when unbound).
 * @param boundPlan The plan name the approval binds ("" when unbound).
 * @param taskComplete True when the prior task is already retired.
 * @returns True when the approval must reset task scope before stamping.
 */
export function approvalResetsScope(
  priorActivePlan: string,
  boundPlan: string,
  taskComplete: boolean,
): boolean {
  return boundPlan !== "" && (taskComplete || boundPlan !== priorActivePlan)
}
