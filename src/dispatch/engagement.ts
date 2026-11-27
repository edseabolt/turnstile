/**
 * @fileoverview Engagement decision helpers for dormant-until-engaged
 * enforcement: the pure predicate deciding whether a classified prompt
 * intent engages the pipeline, and the pure builder for the
 * `type:"engagement"` journal entry. Depends only on the intent classifier
 * and shared types — no fs, no host access, no throwing.
 */

import type { IntentKind } from "./intent.ts"

/**
 * Why the pipeline engaged or disengaged, journaled on the
 * `type:"engagement"` row. Arm reasons: `plan-approved` (the prompt carried
 * the approval marker), `dispatch-request` (a dispatch-classified prompt or
 * an actual planner dispatch), `plan-reference` (a plan-file-classified
 * prompt). Sleep reasons: `task-complete` (task retire), `abort` (the
 * `TURNSTILE OFF:` suspend clear), `continuation-drop` (a new prompt with no
 * continuation credit reset an engaged bucket).
 */
export type EngagementReason =
  | "plan-approved"
  | "dispatch-request"
  | "plan-reference"
  | "task-complete"
  | "abort"
  | "continuation-drop"

/**
 * True when the classified prompt intent engages the pipeline: a
 * plan-dispatch request or a plan-file reference. Issue references and work
 * verbs keep the advisory nudge path and never engage; a null
 * classification (questions, chat) never engages.
 * @param kind The classified intent kind, or null when unclassified.
 * @returns True when the intent arms enforcement.
 */
export function shouldEngage(kind: IntentKind | null): boolean {
  return kind === "dispatch" || kind === "plan-ref"
}

/**
 * Builds the `type:"engagement"` journal entry for one transition. Pure:
 * the caller journals it through the journaler.
 * @param sessionID The parent session whose engagement changed.
 * @param engaged The new engagement value.
 * @param reason Why the value changed (see {@link EngagementReason}).
 * @returns The journal entry record.
 */
export function engagementEntry(
  sessionID: string,
  engaged: boolean,
  reason: EngagementReason,
): Record<string, unknown> {
  return { type: "engagement", sessionID, engaged, reason }
}
