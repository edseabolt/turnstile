/**
 * @fileoverview Shared gate-message builders for the dispatch-domain gates:
 * the cap-block composer (edge-aware parent/child recovery tails) and the
 * gate-unverified refusal renderer with its attribution summary. Extracted
 * from `src/gates-dispatch.ts` so the review gate and the dispatch-budget
 * modules compose the same messages without duplication; `gates-common.ts`
 * keeps its own export list untouched. Pure text: no I/O, no state.
 */

import type { TurnstileConfig } from "./types.ts"

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
export function capBlockMessage(
  body: string,
  edge: string | undefined,
  what: string,
  parentTail: string,
  clause: string,
): string {
  return body + (edge ? childRecoveryTail(what) : parentTail) + clause
}

/**
 * The session IDs a gate-unverified refusal searched: the searched parent
 * first, then every child named by the search (attributed, then
 * unresolved, in the search's stable order). IDs only — no command text
 * (redaction contract) — so the refusal is forensically reconstructable.
 * @param sessionID The searched parent session ID.
 * @param search The attribution diagnostic.
 * @returns The searched session IDs.
 */
export function searchedSessionIds(sessionID: string, search: EvidenceSearch): string[] {
  return [sessionID, ...search.attributed, ...search.unresolved.map((u) => u.session)]
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
export function searchSummary(search: EvidenceSearch): string {
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
 * Renders the gate-unverified block message. Without a search context the
 * legacy message renders byte-identical; with one, the searched parent and
 * the attribution summary of the journaled executions are inserted between
 * the finding and the remediation clause.
 * @param config The resolved plugin configuration (agent + waiver marker names).
 * @param sessionID The searched parent session ID.
 * @param search Optional attribution diagnostic.
 * @returns The block message.
 */
export function unverifiedBlockMessage(
  config: TurnstileConfig,
  sessionID: string,
  search?: EvidenceSearch,
): string {
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
