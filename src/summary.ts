/**
 * @fileoverview Session-summary boundary: pure counting and formatting over
 * parsed journal entries for the session-end summary surfaced at
 * `session.idle`. No host, no journaler, no state —
 * the caller reads the journal (`readJournalEntries` in `src/journal.ts`),
 * counts (`countSessionActivity`), and delivers; this module is shareable
 * with the observe-period summary surface, which can call
 * `formatSessionSummary` / `formatAllGreenLine` without touching hooks.
 * Pure and throw-free throughout.
 */

import type { JournalEntry } from "./journal.ts"

/** Session activity counts derived from the journal. */
export interface SessionSummaryCounts {
  /** Gate `PASS` entries for the session (verified test-claims). */
  verified: number
  /** `dispatch` entries stamped `blocked:true` (premature dispatches blocked). */
  blockedDispatches: number
  /** Gate `WAIVED` entries (waivers). */
  waivers: number
}

/**
 * True when every count is zero — the quiet-silent condition: a
 * zero-activity session prints nothing under the default `sessionSummary:
 * "quiet"` mode.
 * @param counts The derived counts.
 * @returns True when the session had no counted activity.
 */
export function isInactive(counts: SessionSummaryCounts): boolean {
  return counts.verified === 0 && counts.blockedDispatches === 0 && counts.waivers === 0
}

/**
 * Derives session activity counts from parsed journal entries, counting only
 * entries whose `sessionID` equals the given one (session IDs are unique, so
 * "this session's entries" is exact): gate `PASS` entries count verified
 * test-claims with the `event:"promoted"` entries excluded — the
 * promote-on-evidence path journals a second PASS for the same claim after
 * the marker first-sight entry, so counting them would double-count a
 * promoted session (a standalone promoted entry without its marker entry in
 * the window is reachable only when the journal rotated mid-session and is
 * still excluded by the same filter — the rotation undercount is documented
 * on the journal reader, not compensated here); dispatch entries stamped
 * `blocked:true` count premature dispatches blocked; gate `WAIVED` entries
 * count waivers. Pure; throws nothing.
 * @param entries The parsed journal entries, oldest-first.
 * @param sessionID The session the counts are derived for.
 * @returns The counts for that session.
 */
export function countSessionActivity(
  entries: JournalEntry[],
  sessionID: string,
): SessionSummaryCounts {
  const counts: SessionSummaryCounts = { verified: 0, blockedDispatches: 0, waivers: 0 }
  for (const entry of entries) {
    if (entry.sessionID !== sessionID) continue
    if (entry.type === "gate" && entry.result === "PASS" && entry.event !== "promoted") {
      counts.verified++
    } else if (entry.type === "dispatch" && entry.blocked === true) {
      counts.blockedDispatches++
    } else if (entry.type === "gate" && entry.result === "WAIVED") {
      counts.waivers++
    }
  }
  return counts
}

/**
 * Formats the one-line session-end summary, singularizing "dispatch"/"waiver"
 * when the count is exactly 1:
 * `turnstile: 5 test-claims verified · 1 premature dispatch blocked · 0 waivers · journal <path>`.
 * Pure; throws nothing.
 * @param counts The derived counts.
 * @param journalPath Absolute path of the JSONL journal (named in the line).
 * @returns The formatted summary line.
 */
export function formatSessionSummary(counts: SessionSummaryCounts, journalPath: string): string {
  const dispatchNoun =
    counts.blockedDispatches === 1 ? "premature dispatch blocked" : "premature dispatches blocked"
  const waiverNoun = counts.waivers === 1 ? "waiver" : "waivers"
  return `turnstile: ${counts.verified} test-claims verified · ${counts.blockedDispatches} ${dispatchNoun} · ${counts.waivers} ${waiverNoun} · journal ${journalPath}`
}

/**
 * Formats the zero-activity "all gates green" line shown under
 * `sessionSummary: "on"` for sessions with no counted activity:
 * `turnstile: all gates green this session · journal <path>`. Pure; throws
 * nothing.
 * @param journalPath Absolute path of the JSONL journal (named in the line).
 * @returns The formatted all-green line.
 */
export function formatAllGreenLine(journalPath: string): string {
  return `turnstile: all gates green this session · journal ${journalPath}`
}
