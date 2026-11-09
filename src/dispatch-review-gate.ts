/**
 * @fileoverview Reviewer dispatch gate: the round-cap + gate-evidence
 * enforcement for a pending reviewer `task` dispatch, the waiver journaling
 * and consumption, and the ensemble-completeness credit decision for the
 * landing gate. Extracted from `src/gates-dispatch.ts`; the shared cap-block
 * message composers live in `src/gate-messages.ts`. Functions here either
 * return normally or throw a deliberate BLOCKED error (`reviewEnsembleComplete`
 * never throws — enforcement is "do not credit the review"); every other
 * failure fails open upstream (hooks guard and journal).
 */

import type { Journaler } from "./journal.ts"
import { REVIEW_ENSEMBLE_SIZE } from "./state.ts"
import type { GateLedger } from "./ledger.ts"
import type { GateState, TurnstileConfig } from "./types.ts"
import {
  BlockError,
  journalProvWaiver,
  reviewerEnsembleEntry,
  waiverCovers,
  waiverStateNote,
} from "./gates-common.ts"
import {
  capBlockMessage,
  searchedSessionIds,
  unverifiedBlockMessage,
  type EvidenceSearch,
} from "./gate-messages.ts"

/**
 * The read-only state shared by the dispatch-domain gate modules: the
 * resolved config and the telemetry writer.
 */
export interface DispatchGateState {
  /** The resolved plugin configuration. */
  config: TurnstileConfig
  /** The telemetry writer for gate and blocked entries. */
  journaler: Journaler
}

/**
 * Journals the `gate WAIVED` entry + trace for a covered reviewer dispatch.
 * The `scope` field is stamped only when the waiver is scoped, so an
 * unscoped entry stays byte-identical to the legacy shape. Provenance: the
 * waiver opened the gate from the user prompt, not a dispatch prompt. The
 * waiver quote carries raw prompt context and is already trace-gated by
 * the prompt-hook capture (SECURITY.md redaction contract). The
 * decision-ledger row carries only the covered stages (no waiver text).
 * @param st The dispatch gate state (journaler, config).
 * @param sessionID The parent session ID.
 * @param s The gate state carrying the live waiver.
 */
function journalReviewerWaiver(st: DispatchGateState, sessionID: string, s: GateState): void {
  const { journaler } = st
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
  journalProvWaiver(st.journaler, st.config, sessionID, [st.config.agents.reviewer])
}

/**
 * Shared cap-exhaustion exit: journals the `blocked` entry (site-specific
 * extra fields after `reason`) and the `escalation` entry (uniform
 * `count`/`cap`), both stamped `parent` when the blocked session has a
 * registered edge; journals the trace; then throws the composed `BlockError`.
 * Every escalating cap site delegates here so the journal/trace/throw pair
 * and the entry field order live in one place.
 * @param journaler The telemetry writer.
 * @param sessionID The blocked session ID.
 * @param agent The agent being blocked.
 * @param reason The cap-reason token (`"round-limit"`, `"loop-cap"`, or
 *     `"dispatch-budget"`).
 * @param count The exhausted count to journal.
 * @param cap The exhausted cap to journal.
 * @param edge The blocked session's registered parent (undefined when none);
 *     when set, both entries are stamped `parent`.
 * @param blockedExtras Site-specific fields emitted after `reason` in the
 *     `blocked` entry (none for the round limit; the leg label for a loop
 *     cap; count/cap for the dispatch budget).
 * @param traceMessage The trace detail (`"cap exhausted; escalate"` for the
 *     round/loop caps, `"budget exhausted; escalate"` for the dispatch
 *     budget).
 * @param message The composed `BLOCKED by turnstile:` message to throw.
 */
export function blockWithEscalation(
  journaler: Journaler,
  sessionID: string,
  agent: string,
  reason: string,
  count: number,
  cap: number,
  edge: string | undefined,
  blockedExtras: Record<string, unknown>,
  traceMessage: string,
  message: string,
): void {
  journaler.journal({
    type: "blocked",
    sessionID,
    agent,
    reason,
    ...blockedExtras,
    ...(edge ? { parent: edge } : {}),
  })
  journaler.journal({
    type: "escalation",
    sessionID,
    agent,
    reason,
    count,
    cap,
    ...(edge ? { parent: edge } : {}),
  })
  journaler.traceEvent(agent, reason, traceMessage, sessionID)
  throw new BlockError(message)
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
 * @param st The shared dispatch-gate state.
 * @param sessionID The parent session ID.
 * @param ledger The gate ledger, read for the blocked session's edge.
 * @param count The exhausted count to journal.
 * @param cap The exhausted cap to journal and name in the message.
 * @param clause The appended clause ("" for the legacy message).
 */
function blockReviewRoundLimit(
  st: DispatchGateState,
  sessionID: string,
  ledger: GateLedger,
  count: number,
  cap: number,
  clause: string,
): void {
  // One edge read feeds both the message tail swap and the journal stamps.
  const edge = ledger.childToParent.get(sessionID)
  // Exhausting the round cap means the reviewer is re-dispatched in a loop —
  // escalate and stop (a subagent never receives a fresh user prompt to
  // reset the cap, so "wait for a new task" would dead-end).
  blockWithEscalation(
    st.journaler,
    sessionID,
    st.config.agents.reviewer,
    "round-limit",
    count,
    cap,
    edge,
    {},
    "cap exhausted; escalate",
    capBlockMessage(
      `BLOCKED by turnstile: reviewer round limit (${cap}) reached — the pipeline is looping. STOP: do not re-dispatch the reviewer. Escalate the open findings to the user`,
      edge,
      "the open findings",
      " and wait for new instructions (a new task resets the cap).",
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
 * @param st The shared dispatch-gate state.
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
  st: DispatchGateState,
  sessionID: string,
  ledger: GateLedger,
  s: GateState,
  covered: boolean,
  scoped: boolean,
): void {
  if (covered && scoped && s.reviewWaiverRounds >= st.config.maxReviewerRounds) {
    blockReviewRoundLimit(
      st,
      sessionID,
      ledger,
      s.reviewWaiverRounds,
      st.config.maxReviewerRounds,
      ` The scoped waiver's allowance of ${st.config.maxReviewerRounds} waiver-unblocked dispatches is exhausted; obtain a new waiver or escalate to the user.`,
    )
  }
  if (!covered && s.reviewRounds >= st.config.maxReviewerRounds) {
    blockReviewRoundLimit(
      st,
      sessionID,
      ledger,
      s.reviewRounds,
      st.config.maxReviewerRounds,
      waiverStateNote(s, st.config.agents.reviewer),
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
 * @param st The shared dispatch-gate state.
 * @param sessionID The parent session ID.
 * @param s The caller's resolved gate state (for the waiver-state note).
 * @param search Optional attribution diagnostic for the refusal text and
 *     the `searched` journal field.
 * @throws Error with a `BLOCKED by turnstile:` prefix when the dispatch
 *     must not proceed.
 */
function blockUnverifiedGate(
  st: DispatchGateState,
  sessionID: string,
  s: GateState,
  search?: EvidenceSearch,
): void {
  st.journaler.journal({
    type: "blocked",
    sessionID,
    agent: st.config.agents.reviewer,
    reason: "gate-unverified",
    ...(search ? { searched: searchedSessionIds(sessionID, search) } : {}),
  })
  throw new BlockError(
    unverifiedBlockMessage(st.config, sessionID, search) +
      waiverStateNote(s, st.config.agents.reviewer),
  )
}

/**
 * Journals the `no-gate-pass` `blocked` entry and throws the no-gate-pass
 * `BlockError`: the legacy refusal for a reviewer dispatch before the test
 * gate is green (no unverified claim was recorded when this arm runs),
 * with the waiver-state note appended last.
 * @param st The shared dispatch-gate state.
 * @param sessionID The parent session ID.
 * @param s The caller's resolved gate state (for the waiver-state note).
 * @throws Error with a `BLOCKED by turnstile:` prefix when the dispatch
 *     must not proceed.
 */
function blockNoGatePass(st: DispatchGateState, sessionID: string, s: GateState): void {
  st.journaler.journal({
    type: "blocked",
    sessionID,
    agent: st.config.agents.reviewer,
    reason: "no-gate-pass",
  })
  throw new BlockError(
    "BLOCKED by turnstile: no reviewer dispatch before the test gate is green. " +
      `Run the ${st.config.agents.testRunner} subagent first; dispatch ${st.config.agents.reviewer} only after its first line is ` +
      "`GATE: PASS tests=<n> passed=<n> failed=<n>`, or obtain an explicit user waiver " +
      `(a user prompt this task must contain the literal marker '${st.config.waiverMarker}' followed by the user's words).` +
      waiverStateNote(s, st.config.agents.reviewer),
  )
}

/**
 * Counts one unwaived reviewer dispatch toward the ensemble: advances
 * `reviewerDispatches` and journals the plain count entry (restart-sticky,
 * and — replay-side — clears a prior refusal stamp). Shared by the engaged
 * path (`applyReviewerMutation`) and the dormant arm's admit path.
 * @param st The shared dispatch-gate state.
 * @param sessionID The parent session ID.
 * @param s The caller's resolved gate state to mutate.
 */
export function countReviewerEnsemble(
  st: DispatchGateState,
  sessionID: string,
  s: GateState,
): void {
  s.reviewerDispatches++
  st.journaler.journal(
    reviewerEnsembleEntry(sessionID, st.config.agents.reviewer, s.reviewerDispatches),
  )
}

/**
 * Applies the reviewer dispatch's final state mutation: an unwaived
 * dispatch advances the ordinary cap and the ensemble count (counted
 * toward the landing gate's ensemble and journaled so the count is
 * restart-sticky); a scoped-waived dispatch spends one allowance slot; a
 * covered unscoped waiver is consumed (it cannot grant a later reviewer
 * dispatch).
 * @param st The shared dispatch-gate state.
 * @param sessionID The parent session ID.
 * @param s The caller's resolved gate state to mutate.
 * @param covered Whether the live waiver covers the reviewer stage.
 * @param scoped Whether the covering waiver is scoped.
 */
function applyReviewerMutation(
  st: DispatchGateState,
  sessionID: string,
  s: GateState,
  covered: boolean,
  scoped: boolean,
): void {
  if (!covered) {
    // Engaged-path-only: the round cap is not consumed while dormant (the
    // dormant arm counts the ensemble without advancing reviewRounds).
    s.reviewRounds++
    countReviewerEnsemble(st, sessionID, s)
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
 * @param st The shared dispatch-gate state.
 * @param sessionID The parent session ID.
 * @param ledger The gate ledger to read and mutate state from.
 * @param search Optional attribution diagnostic for the refusal text and
 *     the `searched` journal field.
 * @throws Error with a `BLOCKED by turnstile:` prefix when the dispatch
 *     must not proceed.
 */
function guardReviewerDispatch(
  st: DispatchGateState,
  sessionID: string,
  ledger: GateLedger,
  search?: EvidenceSearch,
): void {
  const s = ledger.state(sessionID)
  const covered = waiverCovers(s, [st.config.agents.reviewer])
  const scoped = covered && s.userWaiverScope.length > 0
  enforceReviewerRoundCaps(st, sessionID, ledger, s, covered, scoped)
  // Journal the WAIVED transition only after the allowance checks admit
  // the dispatch: a dispatch refused on the cap must not record a waived
  // gate transition that never happened.
  if (covered) journalReviewerWaiver(st, sessionID, s)
  if (!s.hasGatePass && !covered) {
    // An unverified PASS (evidence correlation, gateEvidence:enforce) leaves
    // unverifiedPass set: the gate is genuinely not green, so the block names
    // the evidence contract. The legacy no-gate-pass path stays byte-identical
    // when no unverified claim was recorded (s.unverifiedPass === "").
    if (s.unverifiedPass !== "") blockUnverifiedGate(st, sessionID, s, search)
    else blockNoGatePass(st, sessionID, s)
  }
  // Check-then-increment: the Nth dispatch is allowed and the (N+1)th is
  // blocked, so exactly `maxReviewerRounds` dispatches succeed per task.
  applyReviewerMutation(st, sessionID, s, covered, scoped)
}

/**
 * Journals the ensemble-incomplete refusal: the `blocked` entry (carrying
 * `count` and `need`), the `refusedApprove`-stamped `ensemble` entry (so
 * replay cannot re-credit the refused APPROVE across a restart), and a
 * diagnostic trace.
 * @param st The shared dispatch-gate state.
 * @param sessionID The parent session ID whose ensemble is incomplete.
 * @param s The caller's resolved gate state (the dispatch count).
 */
function journalEnsembleRefusal(st: DispatchGateState, sessionID: string, s: GateState): void {
  st.journaler.journal({
    type: "blocked",
    sessionID,
    agent: st.config.agents.reviewer,
    reason: "ensemble-incomplete",
    count: s.reviewerDispatches,
    need: REVIEW_ENSEMBLE_SIZE,
  })
  // Stamp the refusal on the last ensemble entry for the session: replay
  // skips restoring hasReviewApprove when that entry carries
  // refusedApprove:true, so a refused APPROVE cannot re-credit itself on a
  // later boot. A later count-2 dispatch (or a human grant) writes a
  // clearing refusedApprove:false entry that wins last-wins.
  st.journaler.journal(
    reviewerEnsembleEntry(sessionID, st.config.agents.reviewer, s.reviewerDispatches, true),
  )
  st.journaler.traceEvent(
    st.config.agents.reviewer,
    "ensemble",
    `${s.reviewerDispatches} of ${REVIEW_ENSEMBLE_SIZE} dispatches; not credited`,
    sessionID,
  )
}

/**
 * Decides whether the landing gate may credit a reviewer `VERDICT: APPROVE`
 * for a task. Under `reviewEnsemble: enforce` the task needs at least two
 * unwaived reviewer dispatches counted this task (`reviewerDispatches >= 2`);
 * `advise` credits unconditionally. When the landing gate is already
 * released (`hasReviewApprove`), a later APPROVE delivery is credited
 * without journaling — the release (e.g. a human grant) must not be
 * re-stamped as a refusal by a smaller-count delivery. With too few
 * dispatches under `enforce` it journals the refusal (see
 * {@link journalEnsembleRefusal}) and returns false. It never throws:
 * enforcement is "do not credit the review", and the existing landing-gate
 * escalation ladder decides.
 * @param st The shared dispatch-gate state.
 * @param sessionID The parent session ID whose ensemble is being checked.
 * @param ledger The gate ledger to read the ensemble count from.
 * @returns True when the APPROVE may be credited; false when the ensemble is
 *     incomplete under `enforce`.
 */
function reviewEnsembleComplete(
  st: DispatchGateState,
  sessionID: string,
  ledger: GateLedger,
): boolean {
  const s = ledger.state(sessionID)
  // Already-approved short-circuit: when the landing gate is released (e.g.
  // by a human grant), a later APPROVE delivery at a smaller count must not
  // journal the refusal stamp — the stamp's last-wins replay would overwrite
  // the human's clearing entry and drop the release on restart. This branch
  // journals nothing and credits, so the credit decision is idempotent.
  if (s.hasReviewApprove) return true
  if (st.config.reviewEnsemble === "advise" || s.reviewerDispatches >= REVIEW_ENSEMBLE_SIZE)
    return true
  journalEnsembleRefusal(st, sessionID, s)
  return false
}

/**
 * Binds the reviewer dispatch gate to a resolved config and journaler.
 * @param config The resolved plugin configuration.
 * @param journaler The telemetry writer for gate and blocked entries.
 * @returns `guardReviewerDispatch` and `reviewEnsembleComplete`.
 */
export function createReviewGate(
  config: TurnstileConfig,
  journaler: Journaler,
): {
  guardReviewerDispatch(sessionID: string, ledger: GateLedger, search?: EvidenceSearch): void
  reviewEnsembleComplete(sessionID: string, ledger: GateLedger): boolean
  countReviewerEnsemble(sessionID: string, ledger: GateLedger): void
} {
  const st: DispatchGateState = { config, journaler }
  return {
    guardReviewerDispatch: (sessionID, ledger, search) =>
      guardReviewerDispatch(st, sessionID, ledger, search),
    reviewEnsembleComplete: (sessionID, ledger) => reviewEnsembleComplete(st, sessionID, ledger),
    countReviewerEnsemble: (sessionID, ledger) =>
      countReviewerEnsemble(st, sessionID, ledger.state(sessionID)),
  }
}
