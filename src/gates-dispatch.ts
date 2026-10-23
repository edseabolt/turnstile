/**
 * @fileoverview Dispatch-domain enforcement decisions: the reviewer dispatch
 * gate (round cap + gate evidence), the ensemble-completeness credit
 * decision, the per-leg loop caps + total-dispatch budget, and the
 * whole-file read horizon. Functions here either return normally or throw a
 * deliberate BLOCKED error; every other failure fails open upstream (hooks
 * guard and journal). All tunables (thresholds, marker, agent names) come
 * from the injected config; persistence goes through the injected Journaler.
 */

import type { Journaler } from "./journal.ts"
import { REVIEW_ENSEMBLE_SIZE } from "./state.ts"
import type { GateLedger } from "./ledger.ts"
import type { GateState, TurnstileConfig } from "./types.ts"
import { BlockError, waiverCovers, waiverStateNote } from "./gates-common.ts"

/**
 * Attribution diagnostic for a gate-unverified refusal: which journaled test
 * executions exist and why none verified the claim. Built by the wiring layer
 * (the only layer that can see the evidence tracker) and consumed by
 * `guardReviewerDispatch` purely for the refusal text and the `searched`
 * journal field — never for the gate decision itself. Lists render in stable
 * order: attributed children first, then unresolved ones, insertion order.
 */
export interface EvidenceSearch {
  /**
   * Child sessions whose executions resolve to the searched parent but fall
   * outside its current task window (the executions are real and attributed;
   * they predate the task the claim belongs to).
   */
  attributed: string[]
  /**
   * Child sessions whose executions cannot be attributed to the searched
   * parent. `reason` is "no parent edge" when no child→parent edge is
   * registered and "edge: <parent>" when the edge resolves to a different
   * parent.
   */
  unresolved: Array<{ session: string; reason: string }>
  /**
   * Whether the searched parent itself carries an in-window hit bucket.
   * Always false on a live gate-unverified block: an in-window direct bucket
   * would have been promoted by the decision-time re-check that precedes the
   * guard. Retained for forensic completeness.
   */
  direct: boolean
}

/**
 * Dispatch-domain enforcement functions bound to one resolved config +
 * journaler. The method contracts are documented on the public `Gates`
 * interface in `gates.ts`, which re-exposes these four unchanged.
 */
interface DispatchGates {
  guardReviewerDispatch(sessionID: string, ledger: GateLedger, search?: EvidenceSearch): void
  reviewEnsembleComplete(sessionID: string, ledger: GateLedger): boolean
  guardDispatchBudget(sessionID: string, ledger: GateLedger, agent: string): void
  countDispatch(sessionID: string, ledger: GateLedger, agent: string): void
  guardReadLimit(sessionID: string, ledger: GateLedger): void
}

/**
 * The recovery tail for a cap block on an edge-registered child session. A
 * child never admits a user prompt, so it cannot "wait for new instructions"
 * for a reset that never arrives — instead it ends its turn and reports the
 * escalation payload in its final output, which the task-result delivery
 * surfaces to the parent orchestrator; the parent's next user prompt then
 * releases the child's counters.
 * @param what The escalation payload to report in the child's final output
 *     (the open findings / the repeated agent failures / the stuck pipeline).
 * @returns The child recovery tail, with a leading space.
 */
function childRecoveryTail(what: string): string {
  return ` now: finish your turn and put ${what} in your final output — your delivery reaches the parent orchestrator, and the parent's next user prompt releases your counters; this session never receives user prompts.`
}

/**
 * Composes a cap block message from a site's body, the blocked session's
 * registered edge, and the site's appendix clause. The recovery tail is the
 * parent's wait-for-a-new-prompt clause when the session has no edge
 * (byte-identical to the legacy message) and the child's end-the-turn-and-
 * report clause when it does; the appendix clause (the scoped-waiver
 * allowance or waiver-state note) always stays last. Centralizes the
 * edge ternary so the parent/child split is defined in one place.
 * @param body The site's base message through its escalation payload.
 * @param edge The blocked session's registered parent (undefined when none).
 * @param what The escalation payload named by the child recovery tail.
 * @param parentTail The parent's wait-for-a-new-prompt clause (leading space).
 * @param clause The site's appendix clause, always last.
 * @returns The composed block message.
 */
function capBlockMessage(
  body: string,
  edge: string | undefined,
  what: string,
  parentTail: string,
  clause: string,
): string {
  return body + (edge ? childRecoveryTail(what) : parentTail) + clause
}

/**
 * Binds the dispatch-domain enforcement functions to a resolved config and
 * journaler.
 * @param config The resolved plugin configuration.
 * @param journaler The telemetry writer for gate and blocked entries.
 * @returns The four dispatch-domain enforcement functions.
 */
export function createDispatchGates(config: TurnstileConfig, journaler: Journaler): DispatchGates {
  /**
   * The session IDs a gate-unverified refusal searched: the searched parent
   * first, then every child named by the search (attributed, then
   * unresolved, in the search's stable order). IDs only — no command text
   * (redaction contract) — so the refusal is forensically reconstructable.
   * @param sessionID The searched parent session ID.
   * @param search The attribution diagnostic.
   * @returns The searched session IDs.
   */
  function searchedSessionIds(sessionID: string, search: EvidenceSearch): string[] {
    return [sessionID, ...search.attributed, ...search.unresolved.map((u) => u.session)]
  }

  /**
   * Renders the gate-unverified block message. Without a search context the
   * legacy message renders byte-identical; with one, the searched parent and
   * the attribution summary of the journaled executions are inserted between
   * the finding and the remediation clause.
   * @param sessionID The searched parent session ID.
   * @param search Optional attribution diagnostic.
   * @returns The block message.
   */
  function unverifiedBlockMessage(sessionID: string, search?: EvidenceSearch): string {
    const finding =
      "BLOCKED by turnstile: reviewer dispatch without gate evidence: a GATE: PASS " +
      "was recorded without a journaled successful test-command execution for this session"
    const remediation =
      `Run the ${config.agents.testRunner} subagent first, or obtain an explicit user waiver ` +
      `(a user prompt this task must contain the literal marker '${config.waiverMarker}' followed by the user's words).`
    if (search === undefined) return `${finding}. ${remediation}`
    return `${finding} (searched ${sessionID}; journaled test executions: ${searchSummary(
      search,
    )}). ${remediation}`
  }

  /**
   * Renders the attribution summary of journaled test executions for a
   * gate-unverified refusal: "none" when no execution is on record anywhere
   * for the searched scope; a comma-joined `id (reason)` list when
   * attributable executions exist (attributed children first, then
   * unattributable ones, insertion order); or an unattributable list after a
   * "none —" lead-in when only unattributable children carry executions.
   * Labels stay timestamp-factual: the evidence layer stores execution
   * timestamps only, so an attributed child's executions predate the current
   * task window (a verdict-layer "unwaived" notion would over-claim here).
   * @param search The attribution diagnostic.
   * @returns The summary text.
   */
  function searchSummary(search: EvidenceSearch): string {
    const attributable = search.attributed.map(
      (child) => `${child} (executions predate the current task window)`,
    )
    const unattributable = search.unresolved.map((u) => `${u.session} (${u.reason})`)
    if (attributable.length > 0) return [...attributable, ...unattributable].join(", ")
    if (unattributable.length === 0) return "none"
    const n = unattributable.length
    const was = n === 1 ? "was" : "were"
    const noun = n === 1 ? "session" : "sessions"
    return `none — ${n} child ${noun} with executions ${was} unattributable: ${unattributable.join(", ")}`
  }

  /**
   * Journals the `gate WAIVED` entry + trace for a covered reviewer dispatch.
   * The `scope` field is stamped only when the waiver is scoped, so an
   * unscoped entry stays byte-identical to the legacy shape. Provenance: the
   * waiver opened the gate from the user prompt, not a dispatch prompt. The
   * waiver quote carries raw prompt context and is already trace-gated by
   * the prompt-hook capture (SECURITY.md redaction contract).
   * @param sessionID The parent session ID.
   * @param s The gate state carrying the live waiver.
   */
  function journalReviewerWaiver(sessionID: string, s: GateState): void {
    journaler.journal({
      type: "gate",
      sessionID,
      result: "WAIVED",
      // Provenance: this waiver opened the gate from the user prompt, not a
      // dispatch prompt.
      channel: "prompt",
      // Waiver quotes carry raw prompt context; journal them only when
      // the trace is enabled (SECURITY.md redaction contract). `s.userWaiver`
      // is already trace-gated by the prompt-hook capture.
      waiver: s.userWaiver,
      // The parsed scope is stamped only when the waiver is scoped, so
      // unscoped entries stay byte-identical to the legacy shape.
      ...(s.userWaiverScope.length > 0 ? { scope: s.userWaiverScope.join(", ") } : {}),
    })
    journaler.traceEvent("user", "waiver", s.userWaiver, sessionID)
  }

  /**
   * Journals the round-limit `blocked` + `escalation` entries and trace, then
   * throws the round-limit `BlockError`. The message is the base body plus a
   * recovery tail that depends on whether the blocked session is an
   * edge-registered child (the child end-the-turn-and-report clause) or a
   * parent (the wait-for-a-new-prompt clause), plus the given clause, which
   * stays last on both arms. The clause is "" for the ordinary unwaived cap
   * (byte-identical message) and the scoped-allowance-exhausted clause for the
   * waiver pool. When the blocked session has a registered edge, both journal
   * entries are stamped `parent` so the escalation is attributed to the
   * actionable session.
   * @param sessionID The parent session ID.
   * @param ledger The gate ledger, read for the blocked session's edge.
   * @param count The exhausted count to journal.
   * @param cap The exhausted cap to journal and name in the message.
   * @param clause The appended clause ("" for the legacy message).
   */
  function blockReviewRoundLimit(
    sessionID: string,
    ledger: GateLedger,
    count: number,
    cap: number,
    clause: string,
  ): void {
    // One edge read feeds both the message tail swap and the journal stamps.
    const edge = ledger.childToParent.get(sessionID)
    journaler.journal({
      type: "blocked",
      sessionID,
      agent: config.agents.reviewer,
      reason: "round-limit",
      ...(edge ? { parent: edge } : {}),
    })
    // Visible escalation: exhausting the round cap means the reviewer is
    // re-dispatched in a loop — journal an `escalation` entry and stop+
    // escalate (a subagent never receives a fresh user prompt to reset the
    // cap, so "wait for a new prompt" would dead-end).
    journaler.journal({
      type: "escalation",
      sessionID,
      agent: config.agents.reviewer,
      reason: "round-limit",
      count,
      cap,
      ...(edge ? { parent: edge } : {}),
    })
    journaler.traceEvent(
      config.agents.reviewer,
      "round-limit",
      "cap exhausted; escalate",
      sessionID,
    )
    throw new BlockError(
      capBlockMessage(
        `BLOCKED by turnstile: reviewer round limit (${cap}) reached — the pipeline is looping. STOP: do not re-dispatch the reviewer. Escalate the open findings to the user`,
        edge,
        "the open findings",
        " and wait for new instructions (a new user prompt resets the cap).",
        clause,
      ),
    )
  }

  /**
   * Enforces the reviewer round caps. Two independently bounded pools: the
   * scoped-waiver allowance (reviewWaiverRounds) and the ordinary unwaived
   * cap (reviewRounds). A covered unscoped waiver is fully cap-exempt
   * (neither test fires). Every side effect (the edge read, the journal
   * pair, the trace, the message) lives in `blockReviewRoundLimit`, so the
   * call sites stay verbatim.
   * @param sessionID The parent session ID.
   * @param ledger The gate ledger, threaded to `blockReviewRoundLimit`, which
   *     reads the blocked session's edge.
   * @param s The caller's resolved gate state.
   * @param covered Whether the live waiver covers the reviewer stage.
   * @param scoped Whether the covering waiver is scoped.
   * @throws Error with a `BLOCKED by turnstile:` prefix when a round-cap
   *     pool is exhausted.
   */
  function enforceReviewerRoundCaps(
    sessionID: string,
    ledger: GateLedger,
    s: GateState,
    covered: boolean,
    scoped: boolean,
  ): void {
    if (covered && scoped && s.reviewWaiverRounds >= config.maxReviewerRounds) {
      blockReviewRoundLimit(
        sessionID,
        ledger,
        s.reviewWaiverRounds,
        config.maxReviewerRounds,
        ` The scoped waiver's allowance of ${config.maxReviewerRounds} waiver-unblocked dispatches is exhausted; obtain a new waiver or escalate to the user.`,
      )
    }
    if (!covered && s.reviewRounds >= config.maxReviewerRounds) {
      blockReviewRoundLimit(
        sessionID,
        ledger,
        s.reviewRounds,
        config.maxReviewerRounds,
        waiverStateNote(s, config.agents.reviewer),
      )
    }
  }

  /**
   * Journals the `gate-unverified` `blocked` entry and throws the
   * gate-unverified `BlockError`, naming the evidence contract for a
   * dispatch that claimed a PASS without correlated test execution. The
   * `searched` journal field carries searched session IDs only (no command
   * text — redaction contract), so the refusal is forensically
   * reconstructable.
   * @param sessionID The parent session ID.
   * @param s The caller's resolved gate state (for the waiver-state note).
   * @param search Optional attribution diagnostic for the refusal text and
   *     the `searched` journal field.
   * @throws Error with a `BLOCKED by turnstile:` prefix when the dispatch
   *     must not proceed.
   */
  function blockUnverifiedGate(sessionID: string, s: GateState, search?: EvidenceSearch): void {
    journaler.journal({
      type: "blocked",
      sessionID,
      agent: config.agents.reviewer,
      reason: "gate-unverified",
      ...(search ? { searched: searchedSessionIds(sessionID, search) } : {}),
    })
    throw new BlockError(
      unverifiedBlockMessage(sessionID, search) + waiverStateNote(s, config.agents.reviewer),
    )
  }

  /**
   * Journals the `no-gate-pass` `blocked` entry and throws the no-gate-pass
   * `BlockError`: the legacy refusal for a reviewer dispatch before the test
   * gate is green (no unverified claim was recorded when this arm runs),
   * with the waiver-state note appended last.
   * @param sessionID The parent session ID.
   * @param s The caller's resolved gate state (for the waiver-state note).
   * @throws Error with a `BLOCKED by turnstile:` prefix when the dispatch
   *     must not proceed.
   */
  function blockNoGatePass(sessionID: string, s: GateState): void {
    journaler.journal({
      type: "blocked",
      sessionID,
      agent: config.agents.reviewer,
      reason: "no-gate-pass",
    })
    throw new BlockError(
      "BLOCKED by turnstile: no reviewer dispatch before the test gate is green. " +
        `Run the ${config.agents.testRunner} subagent first; dispatch ${config.agents.reviewer} only after its first line is ` +
        "`GATE: PASS tests=<n> passed=<n> failed=<n>`, or obtain an explicit user waiver " +
        `(a user prompt this task must contain the literal marker '${config.waiverMarker}' followed by the user's words).` +
        waiverStateNote(s, config.agents.reviewer),
    )
  }

  /**
   * Applies the reviewer dispatch's final state mutation: an unwaived
   * dispatch advances the ordinary cap and the ensemble count (counted
   * toward the landing gate's ensemble and journaled so the count is
   * restart-sticky); a scoped-waived dispatch spends one allowance slot; a
   * covered unscoped waiver is consumed (it cannot grant a later reviewer
   * dispatch).
   * @param sessionID The parent session ID.
   * @param s The caller's resolved gate state to mutate.
   * @param covered Whether the live waiver covers the reviewer stage.
   * @param scoped Whether the covering waiver is scoped.
   */
  function applyReviewerMutation(
    sessionID: string,
    s: GateState,
    covered: boolean,
    scoped: boolean,
  ): void {
    if (!covered) {
      s.reviewRounds++
      s.reviewerDispatches++
      journaler.journal({
        type: "ensemble",
        sessionID,
        agent: config.agents.reviewer,
        count: s.reviewerDispatches,
      })
    } else if (scoped) {
      s.reviewWaiverRounds++
    } else {
      s.userWaiver = ""
      s.userWaiverScope = []
      s.userWaiverConsumed = true
    }
  }

  /**
   * Enforces the reviewer dispatch gate for a pending `task` dispatch.
   * Waives the dispatch when the task's prompt-channel waiver
   * (`s.userWaiver`, captured from the user prompt in the setup hook) covers
   * the reviewer stage, then blocks when the dispatch cap is exhausted or
   * the test gate has not gone green. The canonical waiver semantics: a
   * waiver covers every gate while unscoped, but the reviewer gate consumes
   * an unscoped waiver on the first dispatch it unlocks; naming configured
   * agent names in the waiver text scopes it to those stages' gates (the
   * plan gate is covered by either its plan-reviewer or executor stage name),
   * and a scoped waiver stays live until that stage's waiver allowance is
   * spent — metered separately from the ordinary dispatch caps. A new user
   * prompt drops the waiver. The cap counts reviewer dispatches themselves
   * (per the documented "max 2 reviewer dispatches per task" contract), not
   * BLOCK verdicts: the ordinary unwaived cap is `reviewRounds`, and a
   * scoped-waived dispatch is metered on the separate `reviewWaiverRounds`
   * allowance instead. A covered unscoped waiver stays fully cap-exempt and
   * is consumed by the dispatch that unlocks it. Provenance matters: the
   * waiver is read from the task prompt, never the dispatch prompt.
   * @param sessionID The parent session ID.
   * @param ledger The gate ledger to read and mutate state from.
   * @param search Optional attribution diagnostic for the refusal text and
   *     the `searched` journal field.
   * @throws Error with a `BLOCKED by turnstile:` prefix when the dispatch
   *     must not proceed.
   */
  function guardReviewerDispatch(
    sessionID: string,
    ledger: GateLedger,
    search?: EvidenceSearch,
  ): void {
    const s = ledger.state(sessionID)
    const covered = waiverCovers(s, [config.agents.reviewer])
    const scoped = covered && s.userWaiverScope.length > 0
    enforceReviewerRoundCaps(sessionID, ledger, s, covered, scoped)
    // Journal the WAIVED transition only after the allowance checks admit
    // the dispatch: a dispatch refused on the cap must not record a waived
    // gate transition that never happened.
    if (covered) journalReviewerWaiver(sessionID, s)
    if (!s.hasGatePass && !covered) {
      // An unverified PASS (evidence correlation, gateEvidence:enforce) leaves
      // unverifiedPass set: the gate is genuinely not green, so the block names
      // the evidence contract. The legacy no-gate-pass path stays byte-identical
      // when no unverified claim was recorded (s.unverifiedPass === "").
      if (s.unverifiedPass !== "") blockUnverifiedGate(sessionID, s, search)
      else blockNoGatePass(sessionID, s)
    }
    // Check-then-increment: the Nth dispatch is allowed and the (N+1)th is
    // blocked, so exactly `maxReviewerRounds` dispatches succeed per task.
    applyReviewerMutation(sessionID, s, covered, scoped)
  }

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
  function reviewEnsembleComplete(sessionID: string, ledger: GateLedger): boolean {
    const s = ledger.state(sessionID)
    // Already-approved short-circuit: when the landing gate is released (e.g.
    // by a human grant), a later APPROVE delivery at a smaller count must not
    // journal the refusal stamp — the stamp's last-wins replay would overwrite
    // the human's clearing entry and drop the release on restart. This branch
    // journals nothing and credits, so the credit decision is idempotent.
    if (s.hasReviewApprove) return true
    if (config.reviewEnsemble === "advise" || s.reviewerDispatches >= REVIEW_ENSEMBLE_SIZE)
      return true
    journaler.journal({
      type: "blocked",
      sessionID,
      agent: config.agents.reviewer,
      reason: "ensemble-incomplete",
      count: s.reviewerDispatches,
      need: REVIEW_ENSEMBLE_SIZE,
    })
    // Stamp the refusal on the last ensemble entry for the session: replay
    // skips restoring hasReviewApprove when that entry carries
    // refusedApprove:true, so a refused APPROVE cannot re-credit itself on a
    // later boot. A later count-2 dispatch (or a human grant) writes a
    // clearing refusedApprove:false entry that wins last-wins.
    journaler.journal({
      type: "ensemble",
      sessionID,
      agent: config.agents.reviewer,
      count: s.reviewerDispatches,
      refusedApprove: true,
    })
    journaler.traceEvent(
      config.agents.reviewer,
      "ensemble",
      `${s.reviewerDispatches} of ${REVIEW_ENSEMBLE_SIZE} dispatches; not credited`,
      sessionID,
    )
    return false
  }

  /**
   * Resolves the dispatch leg for an agent, or null when the agent is not one
   * of the three capped legs (planner, plan-reviewer, test-runner) — executor,
   * debugger, reviewer, and unknown names all resolve to null and only draw
   * down the total budget. First match wins on agent-name collisions (a
   * pathological config; documented, not defended).
   * @param agent The dispatched agent name.
   * @returns The matching leg, or null.
   */
  function resolveDispatchLeg(agent: string): {
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
   * @param sessionID The parent session ID.
   * @param agent The dispatched agent name.
   * @param leg The resolved dispatch leg carrying its cap.
   * @param edge The blocked session's registered parent (undefined when none).
   * @param s The caller's resolved gate state (for the waiver-state note).
   * @throws Error with a `BLOCKED by turnstile:` prefix when the leg cap is
   *     exhausted.
   */
  function blockLoopCap(
    sessionID: string,
    agent: string,
    leg: DispatchLeg,
    edge: string | undefined,
    s: GateState,
  ): void {
    const count = s[leg.countKey]
    journaler.journal({
      type: "blocked",
      sessionID,
      agent,
      reason: "loop-cap",
      leg: leg.label,
      count,
      cap: leg.cap,
      ...(edge ? { parent: edge } : {}),
    })
    journaler.journal({
      type: "escalation",
      sessionID,
      agent,
      reason: "loop-cap",
      count,
      cap: leg.cap,
      ...(edge ? { parent: edge } : {}),
    })
    journaler.traceEvent(agent, "loop-cap", "cap exhausted; escalate", sessionID)
    throw new BlockError(
      capBlockMessage(
        `BLOCKED by turnstile: ${agent} dispatch limit (${leg.cap}) reached this task — the pipeline is looping. STOP: do not re-dispatch ${agent}. Escalate to the user: report the repeated ${agent} failures`,
        edge,
        `the repeated ${agent} failures`,
        ` and wait for new instructions (a new user prompt resets the caps; raise ${leg.capKey} in your config to widen the cap).`,
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
   * @param sessionID The parent session ID.
   * @param agent The dispatched agent name.
   * @param edge The blocked session's registered parent (undefined when none).
   * @param s The caller's resolved gate state (for the waiver-state note).
   * @throws Error with a `BLOCKED by turnstile:` prefix when the total
   *     dispatch budget is exhausted.
   */
  function blockDispatchBudget(
    sessionID: string,
    agent: string,
    edge: string | undefined,
    s: GateState,
  ): void {
    const count = s.totalDispatches
    journaler.journal({
      type: "blocked",
      sessionID,
      agent,
      reason: "dispatch-budget",
      count,
      cap: config.maxTotalDispatches,
      ...(edge ? { parent: edge } : {}),
    })
    journaler.journal({
      type: "escalation",
      sessionID,
      agent,
      reason: "dispatch-budget",
      count,
      cap: config.maxTotalDispatches,
      ...(edge ? { parent: edge } : {}),
    })
    journaler.traceEvent(agent, "dispatch-budget", "budget exhausted; escalate", sessionID)
    throw new BlockError(
      capBlockMessage(
        `BLOCKED by turnstile: task dispatch budget (${config.maxTotalDispatches}) exhausted — the pipeline is looping. STOP: do not dispatch further subagents. Escalate to the user: report the stuck pipeline`,
        edge,
        "the stuck pipeline",
        " and wait for new instructions (a new user prompt resets the counters; raise maxTotalDispatches in your config to widen the budget).",
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
   * nothing.
   * @param sessionID The parent session ID.
   * @param ledger The gate ledger to read and mutate state from.
   * @param agent The dispatched agent name (resolved by the setup hook).
   * @throws Error with a `BLOCKED by turnstile:` prefix when the dispatch
   *     must not proceed.
   */
  function guardDispatchBudget(sessionID: string, ledger: GateLedger, agent: string): void {
    const s = ledger.state(sessionID)
    // A waiver covering the dispatched stage exempts its leg cap and the
    // total budget without counting: a loop the user explicitly waived is
    // bounded by the user, not the plugin. An unscoped waiver covers every
    // stage (the legacy whole-task exemption, byte-identical).
    if (waiverCovers(s, [agent])) return

    // One edge read feeds both cap sites' message tail swap and journal stamps.
    const edge = ledger.childToParent.get(sessionID)
    const leg = resolveDispatchLeg(agent)
    // Per-leg loop cap: the dispatching leg has hit its cap — the leg is
    // re-dispatching in a loop.
    if (leg && s[leg.countKey] >= config[leg.capKey]) blockLoopCap(sessionID, agent, leg, edge, s)
    // Global backstop: the task has dispatched more than maxTotalDispatches
    // subagents across all legs — something is stuck. Before the increment
    // below. Leg agents block on their leg cap first, so this reason wins
    // only when the leg cap is not also exhausted (e.g. the reviewer has no
    // leg, so when its round cap and the budget are both exhausted the
    // budget reason wins).
    if (s.totalDispatches >= config.maxTotalDispatches)
      blockDispatchBudget(sessionID, agent, edge, s)
  }

  /**
   * Advances the dispatched leg's counter and the per-task total-dispatch
   * budget. Sole advance of both counters: the check half
   * (`guardDispatchBudget`) runs at guard entry and never touches them; a
   * refusal never reaches this call, so a blocked dispatch draws down
   * nothing. Mirrors the waiver exemption in the guard: when the live waiver
   * covers the dispatched stage, this call returns without counting (the
   * shared `waiverCovers` predicate keeps the two in lockstep). Must be
   * paired with `guardDispatchBudget` at every admitted dispatch — the wiring
   * layer invokes it only once every guard has admitted the dispatch.
   * @param sessionID The parent session ID.
   * @param ledger The gate ledger to read and mutate state from.
   * @param agent The dispatched agent name (resolved by the setup hook).
   */
  function countDispatch(sessionID: string, ledger: GateLedger, agent: string): void {
    const s = ledger.state(sessionID)
    // A waiver exempts without counting: the guard admitted this dispatch
    // without touching the counters, so the metering mirror stays in lockstep
    // with the check (one shared waiver predicate).
    if (waiverCovers(s, [agent])) return
    const leg = resolveDispatchLeg(agent)
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
   * @param sessionID The parent session ID.
   * @param ledger The gate ledger to read and mutate state from.
   * @throws Error with a `BLOCKED by turnstile:` prefix once the read
   *     count has reached the configured block threshold.
   */
  function guardReadLimit(sessionID: string, ledger: GateLedger): void {
    const s = ledger.state(sessionID)
    if (s.reads >= config.readBlock) {
      journaler.journal({ type: "blocked", sessionID, tool: "read", reason: "read-limit" })
      throw new BlockError(
        `BLOCKED by turnstile: ${config.readBlock} whole-file reads this session. Switch to grep/glob for targeted retrieval, or report being stuck and escalate to the user.`,
      )
    }
    // Check-then-increment: the Nth read succeeds and the (N+1)th blocks, so
    // exactly `readBlock` whole-file reads succeed per task.
    s.reads++
  }

  return {
    guardReviewerDispatch,
    reviewEnsembleComplete,
    guardDispatchBudget,
    countDispatch,
    guardReadLimit,
  }
}
