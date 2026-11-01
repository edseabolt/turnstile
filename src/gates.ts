/**
 * @fileoverview Policy boundary: composition of the per-gate enforcement
 * modules (dispatch gates, plan gates) — this module wires them into the
 * host-facing `Gates` interface.
 * Functions here either return normally or throw a deliberate BLOCKED
 * error; every other failure fails open upstream (hooks guard and journal).
 * All tunables (thresholds, marker, agent names) come from the injected
 * config; persistence goes through the injected Journaler.
 */

import type { Journaler } from "./journal.ts"
import type { GateLedger } from "./ledger.ts"
import type { TurnstileConfig } from "./types.ts"
import { createDispatchGates } from "./gates-dispatch.ts"
import type { EvidenceSearch } from "./gates-dispatch.ts"
import { createPlanGates } from "./gates-plan.ts"
import type { PlanGateRed } from "./gates-plan.ts"
import type { PlanImpact } from "./plan-scope.ts"

export { BlockError } from "./gates-common.ts"
export type { EvidenceSearch } from "./gates-dispatch.ts"

/** Enforcement functions bound to one resolved config + journaler. */
export interface Gates {
  /**
   * Enforces the reviewer dispatch gate for a pending `task` dispatch:
   * waives the dispatch when the task's prompt-channel waiver
   * (`ledger.state().userWaiver`, captured from the user prompt in the setup
   * hook) covers the reviewer stage, then blocks when the dispatch cap is
   * exhausted or the test gate has not gone green. The canonical waiver
   * semantics: a waiver covers every gate while unscoped, but the reviewer
   * gate consumes an unscoped waiver on the first dispatch it unlocks; naming
   * configured agent names in the waiver text scopes it to those stages'
   * gates (the plan gate is covered by either its plan-reviewer or executor
   * stage name), and a scoped waiver stays live until that stage's waiver
   * allowance is spent — metered separately from the ordinary dispatch caps.
   * The waiver holds for the whole task scope; a task-scope change drops it.
   * Without `search` the gate-unverified
   * refusal renders byte-identical to the legacy message and journals no
   * `searched` field; with one, the refusal names the searched sessions and
   * the `blocked` entry gains `searched` (IDs only).
   * @param sessionID The parent session ID.
   * @param ledger The gate ledger to read and mutate state from.
   * @param search Optional attribution diagnostic for the refusal text.
   * @throws Error with a `BLOCKED by turnstile:` prefix when the dispatch
   *     must not proceed.
   */
  guardReviewerDispatch(sessionID: string, ledger: GateLedger, search?: EvidenceSearch): void
  /**
   * Decides whether the landing gate may credit a reviewer `VERDICT: APPROVE`
   * for a task. Under `reviewEnsemble: enforce` the task needs at least two
   * unwaived reviewer dispatches counted this task (`reviewerDispatches >= 2`);
   * `advise` credits unconditionally. When the landing gate is already
   * released (`hasReviewApprove`), a later APPROVE delivery is credited
   * without journaling — the release (e.g. a human grant) must not be
   * re-stamped as a refusal by a smaller-count delivery. With too few
   * dispatches under `enforce`
   * it journals a `blocked` (`reason:"ensemble-incomplete"`, carrying `count`
   * and `need`), a `refusedApprove`-stamped `ensemble` entry (so replay cannot
   * re-credit the refused APPROVE across a restart), and a diagnostic trace,
   * then returns false. It never throws: enforcement is "do not credit the
   * review", and the existing landing-gate escalation ladder decides.
   * @param sessionID The parent session ID whose ensemble is being checked.
   * @param ledger The gate ledger to read the ensemble count from.
   * @returns True when the APPROVE may be credited; false when the ensemble is
   *     incomplete under `enforce`.
   */
  reviewEnsembleComplete(sessionID: string, ledger: GateLedger): boolean
  /**
   * Enforces the per-leg loop caps and the per-task total-dispatch budget for
   * a pending `task` dispatch of any leg (planner, plan-reviewer, test-runner,
   * executor, debugger, reviewer, unknown): the dispatcher's leg cap
   * (`maxPlannerRounds` / `maxPlanReviewerRounds` / `maxTestRunnerRounds`) and
   * the global budget (`maxTotalDispatches`) are mechanical loop backstops,
   * analogous to `reviewRounds`. A waiver covering the dispatched stage
   * exempts its leg cap and the budget without counting (an unscoped waiver
   * covers every stage — the legacy whole-task exemption) — the user
   * authorized the loop. When
   * a leg cap is exceeded the block names the leg, journals a
   * `{type:"escalation"}` entry, and tells the dispatcher to STOP and escalate;
   * when the budget is exceeded it refuses every further dispatch. Either way
   * the dispatcher is looping, so the message is STOP-and-escalate from any
   * session. The counters advance in `countDispatch` (single-count point) once
   * every guard has admitted the dispatch — a blocked attempt draws down
   * nothing. The returned verdict is the waiver-exemption state snapshotted
   * at this check: the metering commit consumes it as given, because a later
   * guard in the same dispatch (the reviewer gate's consumption of a covered
   * unscoped waiver) may clear the waiver between this check and the commit.
   * @param sessionID The parent session ID.
   * @param ledger The gate ledger to read and mutate state from.
   * @param agent The dispatched agent name (resolved by the setup hook).
   * @returns True when the live waiver covered the dispatched stage (the
   *     admission-time exemption verdict), false when the dispatch passed the
   *     caps and the budget.
   * @throws Error with a `BLOCKED by turnstile:` prefix when the dispatch
   *     must not proceed.
   */
  guardDispatchBudget(sessionID: string, ledger: GateLedger, agent: string): boolean
  /**
   * Advances the dispatched leg's counter and the per-task total-dispatch
   * budget. Sole advance of both counters: the check half
   * (`guardDispatchBudget`) runs at guard entry and never touches them; a
   * refusal never reaches this call, so a blocked dispatch draws down
   * nothing. The waiver-exemption verdict is threaded in from the guard's
   * admission-time snapshot rather than re-read here: a later guard in the
   * same dispatch (the reviewer gate's consumption of a covered unscoped
   * waiver) may clear the waiver between the budget check and this commit,
   * and a re-read would count a dispatch the guard exempted. A true verdict
   * exempts without counting, mirroring the guard's waiver short-circuit.
   * Must be paired with `guardDispatchBudget` at every admitted dispatch —
   * the wiring layer invokes it only once every guard has admitted the
   * dispatch, with the verdict that guard returned.
   * @param sessionID The parent session ID.
   * @param ledger The gate ledger to read and mutate state from.
   * @param agent The dispatched agent name (resolved by the setup hook).
   * @param waived The admission-time waiver-exemption verdict returned by
   *     `guardDispatchBudget` (true exempts this dispatch from the counters).
   */
  countDispatch(sessionID: string, ledger: GateLedger, agent: string, waived: boolean): void
  /**
   * Enforces the whole-file read horizon for a session with an atomic
   * check-then-increment: the read is allowed when the count is below
   * `readBlock`, and the count is then advanced in the same synchronous step,
   * so exactly `readBlock` whole-file reads succeed and concurrent interleaved
   * hooks cannot both pass at count-1.
   * @param sessionID The parent session ID.
   * @param ledger The gate ledger to read and mutate state from.
   * @throws Error with a `BLOCKED by turnstile:` prefix once the read
   *     count has reached the configured block threshold.
   */
  guardReadLimit(sessionID: string, ledger: GateLedger): void
  /**
   * Enforces the decomposition gate: when the resolved plan carries a
   * `## Decomposition` block, executor dispatches must cite the chunk-N /
   * AC-n they implement. The resolved plan is the dispatch prompt's named
   * plan when it names exactly one existing plan file, else the session's
   * bound plan when it still exists, else the first sorted decomposed plan
   * (the legacy rule — what a no-ledger call enforces, byte-identically).
   * Unreadable plans dirs fail open.
   * @param sessionID The parent session ID (used in journal entries).
   * @param prompt The dispatch prompt text to check for chunk citations.
   * @param projectDir The current project directory.
   * @param ledger Optional gate ledger for active-plan resolution (session
   *     binding or prompt naming); when absent the legacy first-sorted rule
   *     applies.
   * @throws Error with a `BLOCKED by turnstile:` prefix when the resolved
   *     plan carries a decomposition and the prompt cites no chunk.
   */
  enforceDecomposition(
    sessionID: string,
    prompt: string,
    projectDir: string,
    ledger?: GateLedger,
  ): void
  /**
   * Enforces the plan-approval gate: executor dispatches require a current
   * plan-reviewer `VERDICT: APPROVE` for the session (or a waiver) for the
   * plans the dispatch resolves — the prompt-referenced existing plans, else
   * the session's bound plan, else (nothing resolvable) every pending plan;
   * a plans dir holding only unrelated stale plans no longer blocks a
   * dispatch whose own plan approval is live. A bound approval (the
   * session's plan identity) is invalidated only when THAT plan's content
   * changes or the file disappears; unbound approvals invalidate on any
   * plans-dir change (the dir-signature rule, path-free so an approval
   * survives a same-content move). A stale verdict is dropped loudly,
   * journaling a replay-inert `STALE` plan entry rather than a silent
   * mismatch. The blocker set is an exclusive fallback, not a union: the
   * prompt-referenced pending plans in prompt order if any referenced plan
   * is pending, else the session-bound pending plan, else (nothing
   * resolvable) every pending plan in sorted scan order.
   * The waiver is the task's prompt-channel waiver
   * (`ledger.state().userWaiver`, captured from the user prompt): a waiver
   * covers every gate while unscoped (the reviewer gate consumes an unscoped
   * waiver on the first dispatch it unlocks); naming configured agent names
   * in the waiver text scopes it to those stages' gates — this gate is
   * covered by either its plan-reviewer or executor stage name — and a
   * scoped waiver stays live until that stage's waiver allowance is spent,
   * metered separately from the ordinary dispatch caps; the waiver holds for
   * the whole task scope, a task-scope change drops it. A waiver covering
   * this gate is never consumed (the plan gate is sticky).
   * @param sessionID The parent session ID.
   * @param projectDir The current project directory.
   * @param ledger The gate ledger to read and mutate plan state from.
   * @param prompt Optional dispatch prompt text for active-plan resolution.
   * @throws Error with a `BLOCKED by turnstile:` prefix when the plans the
   *     dispatch resolves are pending (no live approval covers them).
   */
  enforcePlanApproval(
    sessionID: string,
    projectDir: string,
    ledger: GateLedger,
    prompt?: string,
  ): void
  /**
   * Returns the current plans-dir signature for approval-time stamping, or
   * null when the dir is absent or unreadable (fail-open: an unstampable
   * approval behaves as unknown and is validated on the next enforcing
   * dispatch).
   * @param projectDir The current project directory.
   * @returns The plans-dir content signature, or null when absent/unreadable.
   */
  plansSignature(projectDir: string): string | null
  /**
   * Returns a plan file's name and a short body preview, or undefined when
   * the plans dir is absent, unreadable, or empty (fail-open). The preview
   * is the first ~40 non-heading lines of the named plan when `activeName`
   * is given, else the first sorted plan; shared by the escalatable plan
   * gate so the ask the evaluate handler surfaces names the same file and
   * shows its body.
   * @param projectDir The current project directory.
   * @param activeName Optional resolved active plan name; undefined falls
   *     back to the first sorted plan.
   * @returns `{ file, head }` for the active (or first sorted) plan, or undefined.
   */
  planSummary(projectDir: string, activeName?: string): { file: string; head: string } | undefined
  /**
   * Returns whether the plan-approval gate is currently red for a parent, and
   * when red, the plan file + body preview to surface in a permission ask.
   * Mirrors `enforcePlanApproval`'s guard (waived, absent/empty dir, a green
   * verdict, or no pending plan is not red; otherwise red) so the evaluate
   * handler and the enforcing dispatch decide escalation from the exact same
   * scan. Waiver, approval, and the pending set are folded into `red`: a red
   * result implies the task's waiver does not cover this gate's stage group
   * (no live waiver, or a waiver scoped to other stages), `hasPlanVerdict`
   * is false, and at least one genuine blocker is pending, so the caller
   * only tests `red`. "Pending" means the plan's bytes carry no live durable,
   * project-scoped approval in the ledger's approval store (a legacy
   * whole-file record whose bytes are unchanged is live and transparently
   * re-keyed). The gate resolves
   * the dispatch's relevant plans — the prompt-referenced existing plans, else
   * the session-bound plan, else (nothing resolvable) every pending plan —
   * and is red only when that resolution still holds a pending plan: a
   * dispatch whose own plan holds a live (durable or session) approval is
   * green even while unrelated plans stay pending, but with nothing
   * resolvable every pending plan blocks, as before. The red preview and
   * `blockers` name the resolved set's pending plans only — the
   * prompt-referenced pending plans in prompt order, else the session-bound
   * pending plan, else (nothing resolvable) every pending plan in sorted
   * scan order; the preview names `blockers[0]`, so a stale bound
   * approval's ask still names that plan. The red `cause` classifies
   * `blockers[0]`: `durable-key-stale` when a durable record matches neither
   * key scheme (the plan changed after approval, or the record is from an
   * obsolete scheme that cannot prove the spec region unchanged — one
   * re-approval re-keys it), `never-approved` otherwise.
   * @param projectDir The current project directory.
   * @param ledger The gate ledger to read (and reconcile) state from.
   * @param sessionID The parent session whose plan-gate state is read.
   * @param prompt Optional dispatch prompt text for active-plan resolution.
   * @returns `{ red: false }` when not red, or the red shape (summary is the
   *     first blocker's preview, `cause` its pending classification).
   */
  planGateStatus(
    projectDir: string,
    ledger: GateLedger,
    sessionID: string,
    prompt?: string,
  ): { red: false } | PlanGateRed
  /**
   * Extracts the plan file names a dispatch prompt mentions: the basenames of
   * every `*.md` token, last five (keeps a hostile or pathological prompt
   * bounded). Pure text — no fs, no membership check; callers resolve the
   * candidates against the current scan.
   * @param prompt The dispatch prompt text.
   * @returns The mentioned plan basenames in prompt order, capped at five.
   */
  promptPlanNames(prompt: string): string[]
  /**
   * Resolves the plan identity to bind an approval to: the dispatch prompt's
   * plan candidates intersected with the current plans dir. Exactly one
   * distinct candidate that exists in the dir binds (`{ name, key }`, the key
   * being that file's sha256 hex); zero candidates, an ambiguous set, an
   * absent dir, or an unreadable dir fail open to undefined (the approval
   * stays unbound and keeps the dir-signature rule).
   * @param projectDir The current project directory.
   * @param candidates The plan names extracted from the dispatch prompt
   *     (`promptPlanNames` output).
   * @returns The unique bound identity, or undefined when unresolvable.
   */
  planApprovalBinding(
    projectDir: string,
    candidates: string[],
  ): { name: string; key: string } | undefined
  /**
   * Classifies a parent tool call's target path against the bound active
   * plan's scope. Fail-open: any resolution error classifies "none".
   * @param projectDir The current project directory.
   * @param activePlan The bound active plan name ("" means none bound).
   * @param targetPath The write/edit file path, or the bash command text.
   * @param matchInText True for containment matching (bash command text),
   *     false for equality matching (write/edit targets).
   * @returns The impact classification, per `PlanImpact`.
   */
  planImpact(
    projectDir: string,
    activePlan: string,
    targetPath: string,
    matchInText: boolean,
  ): PlanImpact
}

/**
 * Binds enforcement functions to a resolved config and journaler.
 * @param config The resolved plugin configuration.
 * @param journaler The telemetry writer for gate and blocked entries.
 * @returns The dispatch- and plan-domain enforcement functions, each bound
 *          to one config + journaler pair.
 */
export function createGates(config: TurnstileConfig, journaler: Journaler): Gates {
  const dispatch = createDispatchGates(config, journaler)
  const plan = createPlanGates(config, journaler)

  return { ...dispatch, ...plan, planImpact: plan.planImpactFor }
}
