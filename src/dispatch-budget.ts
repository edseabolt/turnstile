/**
 * @fileoverview Dispatch budget enforcement: the per-leg loop caps, the
 * per-task total-dispatch budget, and the whole-file read horizon. Extracted
 * from `src/gates-dispatch.ts`; the shared cap-block message composers live
 * in `src/gate-messages.ts`, the shared cap-exhaustion exit in
 * `src/dispatch-review-gate.ts`. Functions here either return normally or
 * throw a deliberate BLOCKED error; every other failure fails open upstream
 * (hooks guard and journal).
 */

import type { GateLedger } from "./ledger.ts"
import type { GateState, TurnstileConfig } from "./types.ts"
import { BlockError, waiverCovers, waiverStateNote } from "./gates-common.ts"
import { capBlockMessage } from "./gate-messages.ts"
import { blockWithEscalation, type DispatchGateState } from "./dispatch-review-gate.ts"
import type { Journaler } from "./journal.ts"

/**
 * Resolves the dispatch leg for an agent, or null when the agent is not one
 * of the three capped legs (planner, plan-reviewer, test-runner) — executor,
 * debugger, reviewer, and unknown names all resolve to null and only draw
 * down the total budget. First match wins on agent-name collisions (a
 * pathological config; documented, not defended).
 * @param config The resolved plugin configuration (agent names + caps).
 * @param agent The dispatched agent name.
 * @returns The matching leg, or null.
 */
function resolveDispatchLeg(
  config: TurnstileConfig,
  agent: string,
): {
  label: "planner" | "planReviewer" | "testRunner"
  countKey: "plannerRounds" | "planReviewerRounds" | "testRunnerRounds"
  capKey: "maxPlannerRounds" | "maxPlanReviewerRounds" | "maxTestRunnerRounds"
  cap: number
} | null {
  if (agent === config.agents.planner)
    return {
      label: "planner",
      countKey: "plannerRounds",
      capKey: "maxPlannerRounds",
      cap: config.maxPlannerRounds,
    }
  if (agent === config.agents.planReviewer)
    return {
      label: "planReviewer",
      countKey: "planReviewerRounds",
      capKey: "maxPlanReviewerRounds",
      cap: config.maxPlanReviewerRounds,
    }
  if (agent === config.agents.testRunner)
    return {
      label: "testRunner",
      countKey: "testRunnerRounds",
      capKey: "maxTestRunnerRounds",
      cap: config.maxTestRunnerRounds,
    }
  return null
}

/**
 * A resolved per-leg dispatch budget line: the leg's journal label, state
 * counter, config cap key, and cap value.
 */
type DispatchLeg = NonNullable<ReturnType<typeof resolveDispatchLeg>>

/**
 * Journals the per-leg `loop-cap` `blocked` + `escalation` entries and
 * trace, then throws the loop-cap `BlockError` naming the exhausted leg.
 * When the blocked session has a registered edge, both journal entries are
 * stamped `parent` so the escalation is attributed to the actionable
 * session.
 * @param st The shared dispatch-gate state.
 * @param sessionID The parent session ID.
 * @param agent The dispatched agent name.
 * @param leg The resolved dispatch leg carrying its cap.
 * @param edge The blocked session's registered parent (undefined when none).
 * @param s The caller's resolved gate state (for the waiver-state note).
 * @throws Error with a `BLOCKED by turnstile:` prefix when the leg cap is
 *     exhausted.
 */
function blockLoopCap(
  st: DispatchGateState,
  sessionID: string,
  agent: string,
  leg: DispatchLeg,
  edge: string | undefined,
  s: GateState,
): void {
  const count = s[leg.countKey]
  blockWithEscalation(
    st.journaler,
    sessionID,
    agent,
    "loop-cap",
    count,
    leg.cap,
    edge,
    { leg: leg.label, count, cap: leg.cap },
    "cap exhausted; escalate",
    capBlockMessage(
      `BLOCKED by turnstile: ${agent} dispatch limit (${leg.cap}) reached this task — the pipeline is looping. STOP: do not re-dispatch ${agent}. Escalate to the user: report the repeated ${agent} failures`,
      edge,
      `the repeated ${agent} failures`,
      ` and wait for new instructions (a new task resets the caps; raise ${leg.capKey} in your config to widen the cap).`,
      waiverStateNote(s, `the ${agent} stage`),
    ),
  )
}

/**
 * Journals the total-dispatch-budget `blocked` + `escalation` entries and
 * trace, then throws the dispatch-budget `BlockError`: the task has
 * dispatched more than maxTotalDispatches subagents across all legs, so
 * something is stuck. When the blocked session has a registered edge, both
 * journal entries are stamped `parent` so the escalation is attributed to
 * the actionable session.
 * @param st The shared dispatch-gate state.
 * @param sessionID The parent session ID.
 * @param agent The dispatched agent name.
 * @param edge The blocked session's registered parent (undefined when none).
 * @param s The caller's resolved gate state (for the waiver-state note).
 * @throws Error with a `BLOCKED by turnstile:` prefix when the total
 *     dispatch budget is exhausted.
 */
function blockDispatchBudget(
  st: DispatchGateState,
  sessionID: string,
  agent: string,
  edge: string | undefined,
  s: GateState,
): void {
  const count = s.totalDispatches
  blockWithEscalation(
    st.journaler,
    sessionID,
    agent,
    "dispatch-budget",
    count,
    st.config.maxTotalDispatches,
    edge,
    { count, cap: st.config.maxTotalDispatches },
    "budget exhausted; escalate",
    capBlockMessage(
      `BLOCKED by turnstile: task dispatch budget (${st.config.maxTotalDispatches}) exhausted — the pipeline is looping. STOP: do not dispatch further subagents. Escalate to the user: report the stuck pipeline`,
      edge,
      "the stuck pipeline",
      " and wait for new instructions (a new task resets the counters; raise maxTotalDispatches in your config to widen the budget).",
      waiverStateNote(s, `the ${agent} stage`),
    ),
  )
}

/**
 * Enforces the per-leg loop caps and the per-task total-dispatch budget.
 * A waiver covering the dispatched stage exempts its leg cap and the total
 * budget without counting (an unscoped waiver covers every stage — the
 * legacy whole-task exemption). A leg cap exhausted throws a loop-cap block
 * naming the leg; the
 * total budget exhausted throws a dispatch-budget block. Either way the
 * dispatcher is looping, so both journal an `escalation` entry and throw a
 * STOP-and-escalate `BlockError`. A waiver covering the dispatched stage
 * returns before either check, so when a block fires a live waiver is
 * necessarily out of scope or already consumed — each block appends
 * `waiverStateNote` so the message reports that state ("" otherwise).
 * Pure check: the counters advance in `countDispatch` (single-count point)
 * once every guard has admitted the dispatch — a blocked attempt draws down
 * nothing. The returned verdict is the waiver-exemption state snapshotted
 * at this check: the metering commit consumes it as given, because a later
 * guard in the same dispatch (the reviewer gate's consumption of a covered
 * unscoped waiver) may clear the waiver between this check and the commit.
 * @param st The shared dispatch-gate state.
 * @param sessionID The parent session ID.
 * @param ledger The gate ledger to read and mutate state from.
 * @param agent The dispatched agent name (resolved by the setup hook).
 * @returns True when the live waiver covered the dispatched stage (the
 *     admission-time exemption verdict), false when the dispatch passed the
 *     caps and the budget.
 * @throws Error with a `BLOCKED by turnstile:` prefix when the dispatch
 *     must not proceed.
 */
function guardDispatchBudget(
  st: DispatchGateState,
  sessionID: string,
  ledger: GateLedger,
  agent: string,
): boolean {
  const s = ledger.state(sessionID)
  // A waiver covering the dispatched stage exempts its leg cap and the
  // total budget without counting: a loop the user explicitly waived is
  // bounded by the user, not the plugin. An unscoped waiver covers every
  // stage (the legacy whole-task exemption, byte-identical). The verdict is
  // returned for the metering commit, which must not re-read the waiver:
  // a later guard may consume it before the commit runs.
  if (waiverCovers(s, [agent])) return true

  // One edge read feeds both cap sites' message tail swap and journal stamps.
  const edge = ledger.childToParent.get(sessionID)
  const leg = resolveDispatchLeg(st.config, agent)
  // Per-leg loop cap: the dispatching leg has hit its cap — the leg is
  // re-dispatching in a loop.
  if (leg && s[leg.countKey] >= st.config[leg.capKey])
    blockLoopCap(st, sessionID, agent, leg, edge, s)
  // Global backstop: the task has dispatched more than maxTotalDispatches
  // subagents across all legs — something is stuck. Leg agents block on
  // their leg cap first, so this reason wins only when the leg cap is not
  // also exhausted (e.g. the reviewer has no leg, so when its round cap and
  // the budget are both exhausted the budget reason wins).
  if (s.totalDispatches >= st.config.maxTotalDispatches)
    blockDispatchBudget(st, sessionID, agent, edge, s)
  return false
}

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
 * @param st The shared dispatch-gate state.
 * @param sessionID The parent session ID.
 * @param ledger The gate ledger to read and mutate state from.
 * @param agent The dispatched agent name (resolved by the setup hook).
 * @param waived The admission-time waiver-exemption verdict returned by
 *     `guardDispatchBudget` (true exempts this dispatch from the counters).
 */
function countDispatch(
  st: DispatchGateState,
  sessionID: string,
  ledger: GateLedger,
  agent: string,
  waived: boolean,
): void {
  const s = ledger.state(sessionID)
  if (waived) return
  const leg = resolveDispatchLeg(st.config, agent)
  if (leg) s[leg.countKey]++
  s.totalDispatches++
}

/**
 * Enforces the whole-file read horizon for a session with an atomic
 * check-then-increment, exactly like the reviewer cap: the read is allowed
 * when the count is below `readBlock`, then the count is advanced in the same
 * synchronous step (the awaited edge-resolution above already completed, so
 * there is no await between check and increment). This closes the TOCTOU
 * window between the before/after hooks.
 * @param st The shared dispatch-gate state.
 * @param sessionID The parent session ID.
 * @param ledger The gate ledger to read and mutate state from.
 * @throws Error with a `BLOCKED by turnstile:` prefix once the read
 *     count has reached the configured block threshold.
 */
function guardReadLimit(st: DispatchGateState, sessionID: string, ledger: GateLedger): void {
  const s = ledger.state(sessionID)
  if (s.reads >= st.config.readBlock) {
    st.journaler.journal({ type: "blocked", sessionID, tool: "read", reason: "read-limit" })
    throw new BlockError(
      `BLOCKED by turnstile: ${st.config.readBlock} whole-file reads this session. Switch to grep/glob for targeted retrieval, or report being stuck and escalate to the user.`,
    )
  }
  // Check-then-increment: the Nth read succeeds and the (N+1)th blocks, so
  // exactly `readBlock` whole-file reads succeed per task.
  s.reads++
}

/**
 * Binds the dispatch budget enforcement to a resolved config and journaler.
 * @param config The resolved plugin configuration.
 * @param journaler The telemetry writer for gate and blocked entries.
 * @returns `guardDispatchBudget`, `countDispatch`, and `guardReadLimit`.
 */
export function createDispatchBudget(
  config: TurnstileConfig,
  journaler: Journaler,
): {
  guardDispatchBudget(sessionID: string, ledger: GateLedger, agent: string): boolean
  countDispatch(sessionID: string, ledger: GateLedger, agent: string, waived: boolean): void
  guardReadLimit(sessionID: string, ledger: GateLedger): void
} {
  const st: DispatchGateState = { config, journaler }
  return {
    guardDispatchBudget: (sessionID, ledger, agent) =>
      guardDispatchBudget(st, sessionID, ledger, agent),
    countDispatch: (sessionID, ledger, agent, waived) =>
      countDispatch(st, sessionID, ledger, agent, waived),
    guardReadLimit: (sessionID, ledger) => guardReadLimit(st, sessionID, ledger),
  }
}
