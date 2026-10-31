/**
 * @fileoverview Shared enforcement semantics for the per-gate modules: the
 * deliberate block error both gate families throw, and the live-waiver
 * coverage/rendering rules both families read from. Leaf boundary — depends
 * only on `types.ts`.
 */

import type { GateState } from "./types.ts"

/**
 * The only error type turnstile deliberately throws at the host: an
 * enforcement block. Hook guards rethrow `BlockError` instances and
 * journal everything else (fail-open contract). The optional `cause` names
 * the blocking gate for the observe-mode `would-block` audit entry (the hook
 * body's fallback ladder reads it without re-parsing the message); an
 * unstamped block falls back to the dispatch agent name or `"gate"`.
 */
export class BlockError extends Error {
  /** The blocking gate's audit name (unset for gates that do not stamp it). */
  cause: string | undefined
  constructor(message: string, cause?: string) {
    super(message)
    this.name = "BlockError"
    this.cause = cause
  }
}

/**
 * Whether a live waiver covers any of the given stage names. A waiver
 * covers when it is live AND either unscoped (scope `[]`) or its scope
 * intersects the stages. A consumed or absent waiver covers nothing.
 * @param s The gate state to read the waiver from.
 * @param stages The stage names the guarding gate spans.
 * @returns True when the live waiver covers at least one of the stages.
 */
export function waiverCovers(s: GateState, stages: readonly string[]): boolean {
  return (
    s.userWaiver !== "" &&
    (s.userWaiverScope.length === 0 || stages.some((st) => s.userWaiverScope.includes(st)))
  )
}

/**
 * Renders the waiver-state clause appended to a block message so a
 * refused dispatch reports whether a waiver is live-but-out-of-scope or
 * already consumed. Exactly two reachable non-empty arms. Reachability
 * invariant: every block site is gated on `!waiverCovers(...)`, so a live
 * waiver observed at a block site is necessarily OUT of scope (a live
 * unscoped waiver covers every stage ⇒ admits ⇒ no block; a live in-scope
 * waiver at the reviewer cap goes through `blockReviewRoundLimit`'s
 * allowance clause instead). A live-unscoped arm would be unreachable dead
 * code — never add one.
 * @param s The gate state to render the waiver state from.
 * @param stagePhrase The guarding stage phrase to name in the out-of-scope
 *     clause (the configured reviewer name at the reviewer gate, the
 *     "executor or plan-reviewer" pair at the plan gate).
 * @returns The clause (with a leading space), or "" when no clause applies.
 */
export function waiverStateNote(s: GateState, stagePhrase: string): string {
  if (s.userWaiver !== "")
    // invariant: scope is non-empty here (see the reachability note above)
    return ` A user waiver is live this task but is scoped to: ${s.userWaiverScope.join(
      ", ",
    )} — it does not cover this gate; name ${stagePhrase} in a new waiver or escalate.`
  if (s.userWaiverConsumed)
    return " The task's unscoped user waiver was consumed by the first dispatch it unlocked; a new waiver is needed for the next dispatch."
  return ""
}

/**
 * Builds the reviewer-ensemble journal entry recorded for a session. The
 * plain count entry (no `refusedApprove`) keeps the ensemble count
 * restart-sticky on every unwaived reviewer dispatch; a `refusedApprove` of
 * `true` stamps a refused APPROVE (replay skips restoring the credit for that
 * entry) and `false` clears it (a standing human release outranks an earlier
 * refusal). Pure: returns the entry, journals nothing.
 * @param sessionID The session the ensemble belongs to.
 * @param agent The reviewer agent name.
 * @param count The reviewer dispatch count at the moment of the stamp.
 * @param refusedApprove Optional refusal stamp: true stamps a refusal, false
 *     clears one; when omitted the entry is the plain count entry.
 * @returns The `ensemble` journal entry.
 */
export function reviewerEnsembleEntry(
  sessionID: string,
  agent: string,
  count: number,
  refusedApprove?: boolean,
): Record<string, unknown> {
  return {
    type: "ensemble",
    sessionID,
    agent,
    count,
    ...(refusedApprove === undefined ? {} : { refusedApprove }),
  }
}

/**
 * Builds a permission-decision journal entry recording a human gate reply.
 * Pure: returns the entry, journals nothing.
 *
 * The sticky overload: a standing, task-scoped human release (`decision`
 * `"always"` from a gate ask, or `"waiver"` from prompt capture) is journaled
 * with `scope:"task"` plus a `kind` naming the released surface, so the boot
 * replay's sticky-decision fold can restore the release after a restart.
 * Only sticky rows carry `scope`/`kind` — `once`/`reject` rows stay in the
 * legacy shape and remain replay-inert. No new entry type: the decision row
 * is extended in place (single journal family for human releases).
 * @param sessionID The session that raised the gate ask.
 * @param decision The resolved reply (`"always"`, `"once"`, `"reject"`, or
 *     `"waiver"` for a prompt-captured waiver).
 * @param sticky The sticky-release stamp for a task-scoped standing release:
 *     `kind` names the released surface (`"plan"`, `"landing"`, `"hands-on"`,
 *     `"waiver"`) and `stages` carries a waiver's stage scope (empty for an
 *     unscoped waiver). Omitted for non-sticky rows.
 * @returns The `permission` journal entry.
 */
export function decisionEntry(
  sessionID: string,
  decision: string,
  sticky?: { kind: StickyReleaseKind; stages?: readonly string[] },
): Record<string, unknown> {
  if (sticky === undefined) return { type: "permission", sessionID, decision }
  return {
    type: "permission",
    sessionID,
    decision,
    scope: "task",
    kind: sticky.kind,
    ...(sticky.stages === undefined ? {} : { stages: [...sticky.stages] }),
  }
}

/** The released surface a sticky decision row names. */
export type StickyReleaseKind = "plan" | "landing" | "hands-on" | "waiver"

/**
 * Builds an `observe` journal entry stamped at a session's first admission
 * during an observe period: the session's phase plus the running period
 * totals at the moment of the stamp. Every observe-mode entry kind carries
 * both totals, so the last stamped line restores the whole period state at
 * replay. Pure: returns the entry, journals nothing.
 * @param sessionID The admitted session the entry belongs to.
 * @param phase The session's admission phase.
 * @param observed The total number of admitted sessions so far.
 * @param wouldBlocks The total number of suppressed blocks so far.
 * @returns The `observe` admission-stamp journal entry.
 */
export function observeEntry(
  sessionID: string,
  phase: "observe" | "enforce",
  observed: number,
  wouldBlocks: number,
): Record<string, unknown> {
  return { type: "observe", sessionID, phase, observed, wouldBlocks }
}

/**
 * Builds the end-of-period `observe` summary marker journaled once the
 * observe-summary prose has surfaced: it carries no phase (replay folds it
 * inert — its only role is proving the summary surfaced, so it never
 * re-fires after a restart). Pure: returns the entry, journals nothing.
 * @param sessionID The session whose admission completed the period.
 * @param observed The total number of admitted sessions at surfacing.
 * @param wouldBlocks The total number of suppressed blocks at surfacing.
 * @returns The `observe` summary marker entry.
 */
export function observeSummaryEntry(
  sessionID: string,
  observed: number,
  wouldBlocks: number,
): Record<string, unknown> {
  return { type: "observe", sessionID, kind: "summary", injected: true, observed, wouldBlocks }
}

/**
 * Builds a `would-block` journal entry stamped when a deliberate block is
 * suppressed during an observe period: the session, the blocking gate's
 * audit name, and the running period totals at the moment of the suppression.
 * Every observe-mode entry kind carries both totals, so the last stamped line
 * restores the whole period state at replay. The cause is truncated to 200
 * characters, mirroring the trace-detail truncation in `src/journal.ts` (a
 * cause is a guard phrase, never a payload — the bound keeps a hostile one
 * bounded too). Pure: returns the entry, journals nothing.
 * @param sessionID The session whose block was suppressed.
 * @param cause The blocking gate's audit name (stamped gate phrase, the
 *     dispatch agent name, or the `"gate"` fallback).
 * @param observed The total number of admitted sessions so far.
 * @param wouldBlocks The total number of suppressed blocks so far.
 * @returns The `would-block` audit journal entry.
 */
export function wouldBlockEntry(
  sessionID: string,
  cause: string,
  observed: number,
  wouldBlocks: number,
): Record<string, unknown> {
  return { type: "would-block", sessionID, cause: cause.slice(0, 200), observed, wouldBlocks }
}
