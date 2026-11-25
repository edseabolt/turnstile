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
import type { TokenUsageTotals } from "./token-usage.ts"

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
 * Reads a token-usage row's numeric component, falling back to 0 for absent
 * or non-numeric values (malformed rows count as zeros, not drops).
 * @param row The parsed journal entry.
 * @param field The totals component to read.
 * @returns The numeric value, or 0.
 */
function tokenField(row: JournalEntry, field: string): number {
  const tokens = row.tokens
  if (tokens === null || typeof tokens !== "object") return 0
  const value = (tokens as Record<string, unknown>)[field]
  return typeof value === "number" && Number.isFinite(value) ? value : 0
}

/**
 * Reads a token-usage row's cost, falling back to 0 for absent or
 * non-numeric values.
 * @param row The parsed journal entry.
 * @returns The numeric cost, or 0.
 */
function tokenCost(row: JournalEntry): number {
  const value = row.cost
  return typeof value === "number" && Number.isFinite(value) ? value : 0
}

/**
 * Adds one token-usage row's components into a totals accumulator.
 * @param totals The running totals (mutated).
 * @param row The parsed token-usage row.
 */
function addRow(totals: TokenUsageTotals, row: JournalEntry): void {
  totals.input += tokenField(row, "input")
  totals.output += tokenField(row, "output")
  totals.reasoning += tokenField(row, "reasoning")
  totals.cacheRead += tokenField(row, "cacheRead")
  totals.cacheWrite += tokenField(row, "cacheWrite")
  totals.cost += tokenCost(row)
}

/**
 * True when every totals component is zero.
 * @param totals The totals to test.
 * @returns True when the totals carry no information.
 */
function allZeroTotals(totals: TokenUsageTotals): boolean {
  return (
    totals.input === 0 &&
    totals.output === 0 &&
    totals.reasoning === 0 &&
    totals.cacheRead === 0 &&
    totals.cacheWrite === 0 &&
    totals.cost === 0
  )
}

/**
 * Folds the journal's `token-usage` rows for one session into componentwise
 * totals, mirroring the status surface's source rule: a session with a
 * `session-rollup` row counts from its rollup rows only (per-message mode
 * also flushes a rollup at `session.idle`, so counting both would
 * double-count); a session with only per-message rows sums them. Pure;
 * throws nothing.
 * @param entries The parsed journal entries, oldest-first.
 * @param sessionID The session the totals are derived for.
 * @returns The totals, or null when no rows match or every component is zero.
 */
export function sessionTokenTotals(
  entries: JournalEntry[],
  sessionID: string,
): TokenUsageTotals | null {
  const rollup: TokenUsageTotals = {
    input: 0,
    output: 0,
    reasoning: 0,
    cacheRead: 0,
    cacheWrite: 0,
    cost: 0,
  }
  const perMessage: TokenUsageTotals = { ...rollup }
  let sawRollup = false
  for (const entry of entries) {
    if (entry.type !== "token-usage" || entry.sessionID !== sessionID) continue
    if (entry.event === "session-rollup") {
      sawRollup = true
      addRow(rollup, entry)
    } else {
      addRow(perMessage, entry)
    }
  }
  const totals = sawRollup ? rollup : perMessage
  return allZeroTotals(totals) ? null : totals
}

/**
 * Renders one token count compactly: under 1000 raw, otherwise one decimal
 * with a k suffix (12.3k).
 * @param n The token count.
 * @returns The rendered count.
 */
function fmtCompact(n: number): string {
  return n < 1000 ? String(n) : `${(n / 1000).toFixed(1)}k`
}

/**
 * Formats the one-line session-end summary, singularizing "dispatch"/"waiver"
 * when the count is exactly 1:
 * `turnstile: 5 test-claims verified · 1 premature dispatch blocked · 0 waivers · journal <path>`.
 * When non-null token totals are passed, a
 * ` · <in>/<out> tok · $<cost>` segment inserts before the journal segment
 * (cost at four decimals); null or all-zero totals omit the segment, so the
 * two-argument output is byte-identical to the no-tokens line. Pure; throws
 * nothing.
 * @param counts The derived counts.
 * @param journalPath Absolute path of the JSONL journal (named in the line).
 * @param tokens Optional session token/cost totals to append.
 * @returns The formatted summary line.
 */
export function formatSessionSummary(
  counts: SessionSummaryCounts,
  journalPath: string,
  tokens?: TokenUsageTotals | null,
): string {
  const dispatchNoun =
    counts.blockedDispatches === 1 ? "premature dispatch blocked" : "premature dispatches blocked"
  const waiverNoun = counts.waivers === 1 ? "waiver" : "waivers"
  const tokenSegment =
    tokens &&
    !(
      tokens.input === 0 &&
      tokens.output === 0 &&
      tokens.reasoning === 0 &&
      tokens.cacheRead === 0 &&
      tokens.cacheWrite === 0 &&
      tokens.cost === 0
    )
      ? ` · ${fmtCompact(tokens.input)} in/${fmtCompact(tokens.output)} out tok · $${tokens.cost.toFixed(4)}`
      : ""
  return `turnstile: ${counts.verified} test-claims verified · ${counts.blockedDispatches} ${dispatchNoun} · ${counts.waivers} ${waiverNoun}${tokenSegment} · journal ${journalPath}`
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
