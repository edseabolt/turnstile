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
 * journal everything else (fail-open contract).
 */
export class BlockError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "BlockError"
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
