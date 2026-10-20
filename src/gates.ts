/**
 * @fileoverview Policy boundary: enforcement decisions: the reviewer
 * dispatch gate, the plan-approval gate, the whole-file read horizon, and
 * the decomposition gate.
 * Functions here either return normally or throw a deliberate BLOCKED
 * error; every other failure fails open upstream (hooks guard and journal).
 * All tunables (thresholds, marker, agent names) come from the injected
 * config; persistence goes through the injected Journaler.
 */

import * as fs from "node:fs"
import { createHash } from "node:crypto"
import * as path from "node:path"

import type { Journaler } from "./journal.ts"
import { REVIEW_ENSEMBLE_SIZE, type GateLedger } from "./state.ts"
import type { GateState, TurnstileConfig } from "./types.ts"
import { BlockError, waiverCovers, waiverStateNote } from "./gates-common.ts"

export { BlockError } from "./gates-common.ts"

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
   * A new user prompt drops the waiver. Without `search` the gate-unverified
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
   * session. Increments the dispatched leg's counter and `totalDispatches`
   * (single-count point: the reviewer's budget consumption lives here —
   * `guardReviewerDispatch` only advances its own `reviewRounds`).
   * @param sessionID The parent session ID.
   * @param ledger The gate ledger to read and mutate state from.
   * @param agent The dispatched agent name (resolved by the setup hook).
   * @throws Error with a `BLOCKED by turnstile:` prefix when the dispatch
   *     must not proceed.
   */
  guardDispatchBudget(sessionID: string, ledger: GateLedger, agent: string): void
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
   * Enforces the plan-approval gate: when any plan file exists in the
   * configured plans directory, executor dispatches require a current
   * plan-reviewer `VERDICT: APPROVE` for the session (or a waiver). A bound
   * approval (the session's plan identity) is invalidated only when THAT
   * plan's content changes or the file disappears; unbound approvals
   * invalidate on any plans-dir change (the dir-signature rule, path-free so
   * an approval survives a same-content move). A stale verdict is dropped
   * loudly, journaling a replay-inert `STALE` plan entry rather than a
   * silent mismatch. The block message names the resolved active plan
   * (prompt-named, then session-bound, then first sorted).
   * The waiver is the task's prompt-channel waiver
   * (`ledger.state().userWaiver`, captured from the user prompt): a waiver
   * covers every gate while unscoped (the reviewer gate consumes an unscoped
   * waiver on the first dispatch it unlocks); naming configured agent names
   * in the waiver text scopes it to those stages' gates — this gate is
   * covered by either its plan-reviewer or executor stage name — and a
   * scoped waiver stays live until that stage's waiver allowance is spent,
   * metered separately from the ordinary dispatch caps; a new user prompt
   * drops the waiver. A waiver covering this gate is never consumed (the
   * plan gate is sticky).
   * @param sessionID The parent session ID.
   * @param projectDir The current project directory.
   * @param ledger The gate ledger to read and mutate plan state from.
   * @param prompt Optional dispatch prompt text for active-plan resolution.
   * @throws Error with a `BLOCKED by turnstile:` prefix when no plan file
   *     exists yet is approved for this task.
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
   * Mirrors `enforcePlanApproval`'s guard (waived, absent/empty dir, or an
   * approved verdict is not red; otherwise red) so the evaluate handler and the
   * enforcing dispatch decide escalation from the exact same scan. Waiver and
   * approval are folded into `red`: a red result implies the task's waiver
   * does not cover this gate's stage group (no live waiver, or a waiver
   * scoped to other stages) and `hasPlanVerdict` is false, so the caller only
   * tests `red`. The red preview names the resolved active plan (prompt-named,
   * then session-bound, then the first sorted fallback).
   * @param projectDir The current project directory.
   * @param ledger The gate ledger to read (and reconcile) state from.
   * @param sessionID The parent session whose plan-gate state is read.
   * @param prompt Optional dispatch prompt text for active-plan resolution.
   * @returns `{ red: false }` when the gate is not red, or `{ red: true, summary }` when it is.
   */
  planGateStatus(
    projectDir: string,
    ledger: GateLedger,
    sessionID: string,
    prompt?: string,
  ): {
    red: boolean
    summary?: { file: string; head: string }
  }
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
 * Binds enforcement functions to a resolved config and journaler.
 * @param config The resolved plugin configuration.
 * @param journaler The telemetry writer for gate and blocked entries.
 * @returns The four enforcement functions plus the plan-scan helpers.
 */
export function createGates(config: TurnstileConfig, journaler: Journaler): Gates {
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
   * The plan gate's guarding stage group: a user's waiver vocabulary for the
   * plan gate names the plan-reviewer stage as often as the executor stage
   * ("approve the plan, skip the plan-reviewer"), so either configured name
   * covers the plan gate. One constant; the enforcing dispatch
   * (`enforcePlanApproval`) and the status mirror (`planGateStatus`) both read
   * it, so the handler/dispatch agreement stays exact.
   */
  const planGateStages = [config.agents.planReviewer, config.agents.executor]

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
   *
   * Size note (AGENTS.md 20–30-line cap): the body exceeds the cap because the
   * two-round-cap + gate-evidence + three-way mutation decision flow reads
   * top-to-bottom as one; the WAIVED journal and the round-limit escalation
   * are extracted into `journalReviewerWaiver` / `blockReviewRoundLimit` so
   * this body carries only the decisions.
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
    // Two independently bounded pools: the scoped-waiver allowance
    // (reviewWaiverRounds) and the ordinary unwaived cap (reviewRounds). A
    // covered unscoped waiver is fully cap-exempt (neither test fires).
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
    // Journal the WAIVED transition only after the allowance checks admit
    // the dispatch: a dispatch refused on the cap must not record a waived
    // gate transition that never happened.
    if (covered) journalReviewerWaiver(sessionID, s)
    if (!s.hasGatePass && !covered) {
      // An unverified PASS (evidence correlation, gateEvidence:enforce) leaves
      // unverifiedPass set: the gate is genuinely not green, so the block names
      // the evidence contract. The legacy no-gate-pass path stays byte-identical
      // when no unverified claim was recorded (s.unverifiedPass === "").
      if (s.unverifiedPass !== "") {
        journaler.journal({
          type: "blocked",
          sessionID,
          agent: config.agents.reviewer,
          reason: "gate-unverified",
          // Searched session IDs only (no command text — redaction contract),
          // so the refusal is forensically reconstructable.
          ...(search ? { searched: searchedSessionIds(sessionID, search) } : {}),
        })
        throw new BlockError(
          unverifiedBlockMessage(sessionID, search) + waiverStateNote(s, config.agents.reviewer),
        )
      }
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
    // Check-then-increment: the Nth dispatch is allowed and the (N+1)th is
    // blocked, so exactly `maxReviewerRounds` dispatches succeed per task.
    // Three-way final mutation: an unwaived dispatch advances the ordinary
    // cap and the ensemble count; a scoped-waived dispatch spends one
    // allowance slot; a covered unscoped waiver is consumed (it cannot grant
    // a later reviewer dispatch).
    if (!covered) {
      s.reviewRounds++
      // Count this unwaived reviewer dispatch toward the landing gate's
      // ensemble; journaled so the count is restart-sticky.
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
   * Increments the dispatched leg's counter and
   * `totalDispatches`; the reviewer has no leg and is counted toward the budget
   * solely here (single-count point — never in guardReviewerDispatch).
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
    if (leg && s[leg.countKey] >= config[leg.capKey]) {
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
    // Global backstop: the task has dispatched more than maxTotalDispatches
    // subagents across all legs — something is stuck. Before the increment
    // below. Leg agents block on their leg cap first, so this reason wins
    // only when the leg cap is not also exhausted (e.g. the reviewer has no
    // leg, so when its round cap and the budget are both exhausted the
    // budget reason wins).
    if (s.totalDispatches >= config.maxTotalDispatches) {
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
    // Check-then-increment: the leg counter then the total budget advance. The
    // reviewer has no leg and is counted toward totalDispatches solely here —
    // guardReviewerDispatch never advances totalDispatches (single-count point).
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

  /**
   * Enforces the decomposition gate: when any plan file in the configured
   * plans directory carries a `## Decomposition` block, executor
   * dispatches must cite the chunk-N / AC-n they implement.
   * @param sessionID The parent session ID (used in journal entries).
   * @param prompt The dispatch prompt text to check for chunk citations.
   * @param projectDir The current project directory.
   * @throws Error with a `BLOCKED by turnstile:` prefix when a decomposed
   *     plan exists and the prompt cites no chunk.
   */
  // Cached plans-dir scan keyed by the directory's content signature
  // (`name:sha256hex,…`). A key hit returns the cached scan and skips the
  // per-file hashing, the utf8 decode, and the `## Decomposition` search; a
  // key miss recomputes the scan (fileKeys, decomp, decompFile). Any fs
  // error throws to the caller's fail-open.
  let plansCache: { key: string; scan: PlansScan } | null = null

  /** What one plans-dir scan establishes for both plan gates. */
  interface PlansScan {
    /**
     * Content signature of the plans dir: `name:sha256hex,…`. Two scans
     * with different keys mean the plans dir _content_ changed (an add,
     * delete, rename, or same-size/content edit); a utimes-only or dir touch
     * leaves it identical — dir mtime is deliberately not hashed. The key is
     * path-free so an approval issued against one checkout survives a
     * same-content move; the empty dir maps to the `"empty"` sentinel (never
     * `""`, which would collide with the accept-once stamp).
     */
    key: string
    /** Sorted plan file names (empty when the dir holds no plans). */
    names: string[]
    /**
     * First (sorted) plan carrying a `## Decomposition` block, or null.
     * Derived from `decomp` for the legacy no-ledger rule; superseded by
     * active-plan resolution when a plan is bound or named.
     */
    decompFile: string | null
    /** Every plan name whose bytes carry a `## Decomposition` block. */
    decomp: Set<string>
    /** Every plan name → sha256 hex of its bytes (the bound-staleness key). */
    fileKeys: Map<string, string>
  }

  /**
   * Sorted `.md` names with per-file content buffers, one readdir + read
   * each; the buffers feed the digest so `scanPlans` never re-reads a file.
   * @param dir Absolute plans directory path.
   * @returns Sorted `{ name, bytes }` for every `.md` entry (empty when none).
   */
  function readEntries(dir: string): Array<{ name: string; bytes: Buffer }> {
    const names = fs
      .readdirSync(dir)
      .filter((f) => f.endsWith(".md"))
      .sort()
    return names.map((name) => ({ name, bytes: fs.readFileSync(path.join(dir, name)) }))
  }

  /**
   * sha256 hex of one plan file's bytes: the per-file content identity that
   * both the dir key and a bound approval's key are built from — one hash per
   * file per scan, never recomputed.
   * @param bytes The plan file bytes.
   * @returns The hex digest.
   */
  function hashEntry(bytes: Buffer): string {
    return createHash("sha256").update(bytes).digest("hex")
  }

  /**
   * Content signature of the plans dir: `name:sha256hex,…`, path-free so a
   * same-content move survives an approval. Identical iff the plans dir's
   * content is identical — an add, delete, rename, or same-size/content edit
   * changes it; a utimes-only or dir touch does not. The empty dir emits the
   * literal sentinel `"empty"` (never `""`, which collides with the accept-once
   * stamp: an approval stamped on an empty dir must mismatch once a plan file
   * appears, journaling STALE loudly rather than silently re-stamping green).
   * @param pairs The plan name + per-file sha256 hex pairs from the scan.
   * @returns The path-free content signature, or `"empty"` when there are none.
   */
  function plansKey(pairs: Array<{ name: string; hash: string }>): string {
    if (pairs.length === 0) return "empty"
    return pairs.map((p) => `${p.name}:${p.hash}`).join(",")
  }

  /**
   * Scans the plans directory, returning the scan whose `key` is the dir's
   * content signature. The cache skips a redundant rescan: a key hit returns
   * the cached scan, skipping the utf8 decode and `## Decomposition` search;
   * a key miss replaces it — either way the returned key reports the dir's
   * current content. The key is path-free, so the cached scan is
   * directory-agnostic and a same-content move reuses it. One sha256 per file
   * per scan feeds both the dir key and the per-file `fileKeys` map.
   * @param dir Absolute plans directory path.
   * @returns The current scan; `scan.key` is the dir's path-free content signature.
   */
  function scanPlans(dir: string): PlansScan {
    const entries = readEntries(dir)
    const pairs = entries.map((e) => ({ name: e.name, hash: hashEntry(e.bytes) }))
    const key = plansKey(pairs)
    const cached = plansCache
    if (cached !== null && cached.key === key) return cached.scan
    const names = entries.map((e) => e.name)
    const decomp = new Set<string>()
    for (const e of entries) {
      if (e.bytes.toString("utf8").includes("## Decomposition")) decomp.add(e.name)
    }
    const scan: PlansScan = {
      key,
      names,
      decomp,
      fileKeys: new Map(pairs.map((p) => [p.name, p.hash])),
      decompFile: names.find((n) => decomp.has(n)) ?? null,
    }
    plansCache = { key, scan }
    return scan
  }

  /**
   * Single source for the plans-dir location: a relative value (the default)
   * joins the per-dispatch project dir; an absolute value is honored as-is
   * (validateResolved journaled a warning at load). Kept in one closure so the
   * plan-gate consumers never recompute the path.
   */
  function resolvePlansDir(projectDir: string): string {
    return path.isAbsolute(config.plansDir)
      ? config.plansDir
      : path.join(projectDir, config.plansDir)
  }

  /**
   * Extracts the plan file names a dispatch prompt mentions: the basenames of
   * every `*.md` token, last five (keeps a hostile or pathological prompt
   * bounded). Pure text — no fs, no membership check; callers resolve the
   * candidates against the current scan.
   * @param prompt The dispatch prompt text.
   * @returns The mentioned plan basenames in prompt order, capped at five.
   */
  function promptPlanNames(prompt: string): string[] {
    const matches = prompt.match(/[\w.-]+\.md/g)
    if (matches === null) return []
    return matches.map((m) => path.basename(m)).slice(-5)
  }

  /**
   * Resolves the plan a gate acts on: the dispatch prompt's name when it
   * names exactly one existing plan file (a prompt name beats the session
   * binding); else the session's bound plan when it still exists in the dir;
   * else null (callers fall back to the legacy first-sorted rule). A prompt
   * that names no plans, two or more distinct plans, or only missing files
   * resolves nothing from the prompt.
   * @param s The session's gate state (bound identity).
   * @param scan The current plans-dir scan.
   * @param prompt The dispatch prompt text.
   * @returns The resolved plan name, or null when unresolved.
   */
  function resolveActivePlan(s: GateState, scan: PlansScan, prompt: string): string | null {
    const named = new Set(promptPlanNames(prompt).filter((n) => scan.names.includes(n)))
    if (named.size === 1) return [...named][0]!
    if (s.approvedPlan !== "" && scan.names.includes(s.approvedPlan)) return s.approvedPlan
    return null
  }

  /**
   * Reconciles a session's approval with the current scan. A bound approval
   * (verdict + bound plan name + that file's content key) is checked
   * per-plan by `reconcileBoundStamp`; every other shape — including a bound
   * name with an empty key — keeps the dir-signature rule verbatim: a
   * non-empty stamp that differs from `scan.key` means the plan was
   * re-planned since approval, so the verdict is stale and re-review is
   * required; a green pass re-stamps the current key (idempotent, and how a
   * replay-restored "" becomes validated). A "" stamp is unknown: replayed
   * approvals now usually carry their journaled dir signature and validate
   * like live ones, so "" covers only field-less legacy lines and
   * genuinely unstampable approvals (absent/unreadable dir) — it is
   * accepted once, mirroring the old first-scan rule. The accept-once window also covers a
   * session that approved but never ran an enforcing dispatch: its stamp is
   * still empty until the first green dispatch stamps it.
   * @param s The session's gate state (mutated).
   * @param scan The current plans-dir scan.
   * @param sessionID The session whose stale drop is journaled.
   */
  function reconcilePlanStamp(s: GateState, scan: PlansScan, sessionID: string): void {
    if (s.hasPlanVerdict && s.approvedPlan !== "" && s.approvedPlanKey !== "") {
      reconcileBoundStamp(s, scan, sessionID)
      return
    }
    if (s.hasPlanVerdict && s.plansSignature !== "" && s.plansSignature !== scan.key) {
      s.hasPlanVerdict = false
      journaler.journal({ type: "plan", sessionID, result: "STALE", reason: "signature-mismatch" })
      journaler.traceEvent("plan-gate", "stale", "signature-mismatch", sessionID)
    }
    if (s.hasPlanVerdict) s.plansSignature = scan.key
  }

  /**
   * The bound half of `reconcilePlanStamp`: a bound approval is stale when the
   * bound plan has disappeared from the dir (`plan-missing`) or its content
   * key has changed (`plan-edited`) — changes to OTHER plans-dir files never
   * invalidate it. A still-matching bound plan re-stamps its key and the dir
   * signature idempotently (how a replay-restored bound verdict validates on
   * the next enforcing dispatch). A stale drop keeps the identity fields
   * (they inform the red preview and clear on the next stamp or reset).
   * @param s The session's gate state (mutated).
   * @param scan The current plans-dir scan.
   * @param sessionID The session whose stale drop is journaled.
   */
  function reconcileBoundStamp(s: GateState, scan: PlansScan, sessionID: string): void {
    const name = s.approvedPlan
    if (!scan.names.includes(name)) {
      s.hasPlanVerdict = false
      journaler.journal({ type: "plan", sessionID, result: "STALE", reason: "plan-missing" })
      journaler.traceEvent("plan-gate", "stale", "plan-missing", sessionID)
      return
    }
    // The name is a scan member, so its key exists (both structures are built
    // from the same entries); the assertion cannot fire.
    const currentKey = scan.fileKeys.get(name)!
    if (currentKey !== s.approvedPlanKey) {
      s.hasPlanVerdict = false
      journaler.journal({ type: "plan", sessionID, result: "STALE", reason: "plan-edited" })
      journaler.traceEvent("plan-gate", "stale", "plan-edited", sessionID)
      return
    }
    s.approvedPlanKey = currentKey
    s.plansSignature = scan.key
  }

  /**
   * The leading preview of one plan file's body: the first ~40 non-heading
   * lines (lines not beginning with '#' after optional leading whitespace),
   * joined and trimmed. Feeds the permission-ask message so the human sees the
   * plan's body without the heading scaffold.
   * @param bytes The plan file bytes.
   * @returns The head text, or "" when the file has no non-heading lines.
   */
  function planHead(bytes: Buffer): string {
    const lines = bytes.toString("utf8").split("\n")
    const body = lines
      .filter((line) => !/^\s*#/.test(line))
      .slice(0, 40)
      .join("\n")
    return body.trim()
  }

  /**
   * Builds the `{ file, head }` preview for one plan of a scan — the resolved
   * active name when given, else the first sorted plan (the legacy preview) —
   * reading that plan's bytes once (they were already read to compute the
   * scan key). Shared by both `planSummary` and the escalatable plan gate so
   * the ask names exactly the plan the resolved enforcement would act on.
   * @param scan The current plans-dir scan.
   * @param plansDir The absolute plans directory of `scan`.
   * @param activeName The resolved active plan name, or null/undefined for
   *     the first-sorted fallback.
   * @returns The plan's `{ file, head }`.
   */
  function planPreview(
    scan: PlansScan,
    plansDir: string,
    activeName?: string | null,
  ): { file: string; head: string } {
    // The callers guard names.length === 0 before calling, so names[0] exists;
    // the non-null assertion is enforced by that guard, not silently assumed.
    const name = activeName ?? scan.names[0]!
    const bytes = fs.readFileSync(path.join(plansDir, name))
    return { file: name, head: planHead(bytes) }
  }

  /**
   * Returns a plan file's name and a short body preview, or undefined when
   * the plans dir is absent, unreadable, or empty (fail-open; a named plan
   * that has since vanished fails open the same way). The preview is the
   * first ~40 non-heading lines of the named plan when `activeName` is
   * given, else the first sorted plan; shared with the escalatable plan gate
   * so the ask the evaluate handler surfaces names the same file and shows
   * its body.
   * @param projectDir The current project directory.
   * @param activeName Optional resolved active plan name; undefined falls
   *     back to the first sorted plan.
   * @returns `{ file, head }` for the active (or first sorted) plan, or undefined.
   */
  function planSummary(
    projectDir: string,
    activeName?: string,
  ): { file: string; head: string } | undefined {
    const plansDir = resolvePlansDir(projectDir)
    try {
      if (!fs.existsSync(plansDir)) return undefined
      const scan = scanPlans(plansDir)
      if (scan.names.length === 0) return undefined
      return planPreview(scan, plansDir, activeName)
    } catch (e) {
      // Journal the fail-open so the unreadable plans dir stays observable.
      journaler.journal({ type: "error", error: `plans dir unreadable: ${e}` })
      return undefined
    }
  }

  /**
   * Returns whether the plan-approval gate is currently red for a parent, and
   * when red, the plan file + body preview to surface in a permission ask.
   * Mirrors `enforcePlanApproval`'s guard (waived, absent/empty dir, or an
   * approved verdict is not red; otherwise red) so the evaluate handler and the
   * enforcing dispatch decide escalation from the exact same scan. Waiver and
   * approval are folded into `red`: a red result implies the task's waiver
   * does not cover this gate's stage group (no live waiver, or a waiver
   * scoped to other stages) and `hasPlanVerdict` is false, so the caller only
   * tests `red`. The
   * red preview names the resolved active plan (prompt-named, then
   * session-bound, then the first sorted fallback) — the same plan the
   * enforcement would act on, so a stale bound approval's ask still names
   * that plan.
   * @param projectDir The current project directory.
   * @param ledger The gate ledger to read (and reconcile) state from.
   * @param sessionID The parent session whose plan-gate state is read.
   * @param prompt Optional dispatch prompt text for active-plan resolution.
   * @returns `{ red: false }` when not red, or `{ red: true, summary }` when red.
   */
  function planGateStatus(
    projectDir: string,
    ledger: GateLedger,
    sessionID: string,
    prompt?: string,
  ): { red: boolean; summary?: { file: string; head: string } } {
    const s = ledger.state(sessionID)
    if (waiverCovers(s, planGateStages)) return { red: false }
    const plansDir = resolvePlansDir(projectDir)
    try {
      if (!fs.existsSync(plansDir)) return { red: false }
      const scan = scanPlans(plansDir)
      if (scan.names.length === 0) return { red: false }
      // Resolve the active plan BEFORE reconciling: a reconcile drop (bound
      // plan edited or missing) must still name that plan in the red preview
      // (the identity outlives the drop until the next stamp or reset).
      const active = resolveActivePlan(s, scan, prompt ?? "")
      // Reconcile this session's approval with the current scan (bound
      // per-plan rule or the unbound dir-signature rule — same as
      // enforcePlanApproval, so the handler and the dispatch agree). A stale
      // verdict is dropped loudly (STALE journaled) so the evaluate ask never
      // re-grants a stale approval.
      reconcilePlanStamp(s, scan, sessionID)
      if (s.hasPlanVerdict) return { red: false }
      return { red: true, summary: planPreview(scan, plansDir, active) }
    } catch (e) {
      // Journal the fail-open so an unreadable plans dir stays observable.
      journaler.journal({ type: "error", error: `plans dir unreadable: ${e}` })
      return { red: false }
    }
  }

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
  function enforceDecomposition(
    sessionID: string,
    prompt: string,
    projectDir: string,
    ledger?: GateLedger,
  ): void {
    if (/\b(?:chunk-\d+|AC-\d+)\b/.test(prompt)) return
    const plansDir = resolvePlansDir(projectDir)
    try {
      if (!fs.existsSync(plansDir)) return
      const scan = scanPlans(plansDir)
      const active = ledger ? resolveActivePlan(ledger.state(sessionID), scan, prompt) : null
      const target = active ?? scan.decompFile
      if (target !== null && scan.decomp.has(target)) {
        journaler.journal({
          type: "blocked",
          sessionID,
          agent: config.agents.executor,
          reason: "missing-chunk-ref",
          plan: target,
        })
        throw new BlockError(
          `BLOCKED by turnstile: plan "${target}" has a ## Decomposition block — executor dispatches must cite the chunk-N / AC-n they implement.`,
        )
      }
    } catch (e) {
      if (e instanceof BlockError) throw e
      // Journal the fail-open so an unreadable plans dir stays observable.
      journaler.journal({ type: "error", error: `plans dir unreadable: ${e}` })
    }
  }

  /**
   * Returns the current plans-dir signature for approval-time stamping, or
   * null when the dir is absent or unreadable (fail-open: an unstampable
   * approval behaves as unknown and is validated on the next enforcing
   * dispatch).
   * @param projectDir The current project directory.
   * @returns The plans-dir content signature, or null when absent/unreadable.
   */
  function plansSignature(projectDir: string): string | null {
    const plansDir = resolvePlansDir(projectDir)
    if (!fs.existsSync(plansDir)) return null
    try {
      return scanPlans(plansDir).key
    } catch (e) {
      // Journal the fail-open so the unreadable plans dir stays observable.
      journaler.journal({ type: "error", error: `plans dir unreadable: ${e}` })
      return null
    }
  }

  /**
   * Returns the plan identity to bind an approval to: the dispatch prompt's
   * plan candidates intersected with the current plans dir. Exactly one
   * distinct candidate that exists in the dir binds (`{ name, key }`, the
   * key being that file's sha256 hex); zero candidates, an ambiguous set, an
   * absent dir, or an unreadable dir fail open to undefined (the approval
   * stays unbound and keeps the dir-signature rule).
   * @param projectDir The current project directory.
   * @param candidates The plan names extracted from the dispatch prompt
   *     (`promptPlanNames` output).
   * @returns The unique bound identity, or undefined when unresolvable.
   */
  function planApprovalBinding(
    projectDir: string,
    candidates: string[],
  ): { name: string; key: string } | undefined {
    const plansDir = resolvePlansDir(projectDir)
    try {
      if (!fs.existsSync(plansDir)) return undefined
      const scan = scanPlans(plansDir)
      // Dedupe mentions: a prompt that names one plan twice is still unique.
      const hits = [...new Set(candidates)].filter((c) => scan.names.includes(c))
      if (hits.length !== 1) return undefined
      const name = hits[0]!
      // The name is a scan member, so its key exists.
      return { name, key: scan.fileKeys.get(name)! }
    } catch (e) {
      // Journal the fail-open so the unreadable plans dir stays observable.
      journaler.journal({ type: "error", error: `plans dir unreadable: ${e}` })
      return undefined
    }
  }

  /**
   * Enforces the plan-approval gate: when any plan file exists in the
   * configured plans directory, executor dispatches require a current
   * plan-reviewer `VERDICT: APPROVE` for the session (or a waiver). A bound
   * approval (the session's plan identity) is invalidated only when THAT
   * plan's content changes or the file disappears; unbound approvals
   * invalidate on any plans-dir change (the dir-signature rule). A stale
   * verdict is dropped loudly, journaling a replay-inert `STALE` plan entry
   * rather than a silent mismatch. The block message names the resolved
   * active plan (prompt-named, then session-bound, then first sorted).
   * The waiver is the task's prompt-channel waiver
   * (`ledger.state().userWaiver`, captured from the user prompt): a waiver
   * covers every gate while unscoped (the reviewer gate consumes an unscoped
   * waiver on the first dispatch it unlocks); naming configured agent names
   * in the waiver text scopes it to those stages' gates — this gate is
   * covered by either its plan-reviewer or executor stage name — and a
   * scoped waiver stays live until that stage's waiver allowance is spent,
   * metered separately from the ordinary dispatch caps; a new user prompt
   * drops the waiver. A waiver covering this gate is never consumed (the
   * plan gate is sticky).
   * @param sessionID The parent session ID.
   * @param projectDir The current project directory.
   * @param ledger The gate ledger to read and mutate plan state from.
   * @param prompt Optional dispatch prompt text for active-plan resolution.
   * @throws Error with a `BLOCKED by turnstile:` prefix when no plan file
   *     exists yet is approved for this task.
   */
  function enforcePlanApproval(
    sessionID: string,
    projectDir: string,
    ledger: GateLedger,
    prompt?: string,
  ): void {
    const s = ledger.state(sessionID)
    if (waiverCovers(s, planGateStages)) {
      journaler.journal({
        type: "plan",
        sessionID,
        result: "WAIVED",
        // Provenance: this waiver opened the gate from the user prompt, not a
        // dispatch prompt.
        channel: "prompt",
        // Waiver quotes carry raw prompt context; journal them only when
        // the trace is enabled (SECURITY.md redaction contract). `s.userWaiver`
        // is already trace-gated by the prompt-hook capture.
        waiver: s.userWaiver,
      })
      journaler.traceEvent("user", "plan-waiver", s.userWaiver, sessionID)
      return
    }
    const status = planGateStatus(projectDir, ledger, sessionID, prompt)
    // status.red ⇒ summary is always present: planGateStatus builds it from a
    // scan whose plan bytes were already read to compute the scan key, so the
    // non-null assertion is sound.
    if (status.red) {
      const plan = status.summary!.file
      journaler.journal({
        type: "blocked",
        sessionID,
        agent: config.agents.executor,
        reason: "no-plan-verdict",
        plan,
      })
      throw new BlockError(
        `BLOCKED by turnstile: no plan approval for "${plan}". Dispatch the ${config.agents.planReviewer} subagent first; proceed with ${config.agents.executor} only after the ${config.agents.planReviewer}'s first line is ` +
          "`VERDICT: APPROVE crit=<n> high=<n> med=<n> low=<n>`, or obtain an explicit user waiver " +
          `(a user prompt this task must contain the literal marker '${config.waiverMarker}' followed by the user's words).` +
          waiverStateNote(s, `${config.agents.executor} or ${config.agents.planReviewer}`),
      )
    }
  }

  return {
    guardReviewerDispatch,
    reviewEnsembleComplete,
    guardDispatchBudget,
    guardReadLimit,
    enforceDecomposition,
    enforcePlanApproval,
    plansSignature,
    planSummary,
    planGateStatus,
    promptPlanNames,
    planApprovalBinding,
  }
}
