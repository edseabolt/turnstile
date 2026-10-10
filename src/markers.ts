/**
 * @fileoverview Marker boundary: `GATE:`/`VERDICT:` marker parsing with
 * per-task dedup, plus agent attribution helpers. Pure with respect to
 * journal and filesystem, so callers journal the returned marker events.
 */

import type { GateState, MarkerEvent, TaskInput } from "./types.ts"

// `export const` keeps the regex literals load-bearing for
// scripts/check-markers.mjs, which extracts them by name and asserts the
// README's marker examples still parse. Keep each regex on one line and
// edit the README examples and these literals together.
// prettier-ignore
export const GATE_RE = /^\s*[`>#*\s]*GATE: (PASS|FAIL) tests=\d+ passed=\d+ failed=\d+/gm
// prettier-ignore
export const VERDICT_RE = /^\s*[`>#*\s]*VERDICT: (APPROVE|BLOCK) crit=\d+ high=\d+ med=\d+ low=\d+/gm

/** Agents contracted to emit GATE/VERDICT markers; marker-less output from
 * anything else is normal, not a violation. */
export const BARE_OUTPUT_AGENTS: readonly string[] = ["test-runner", "reviewer", "plan-reviewer"]

/**
 * Compiles a marker regex from a config-provided source string with `gm`
 * flags. Production matchers use `String.match`, so `lastIndex` state is
 * not an issue; tests must strip `g` before `.test`.
 * @param source Regex source string (no delimiters, no flags).
 * @param fallback Regex to return when the source fails to compile.
 * @returns The compiled regex, or the fallback when the source is invalid.
 */
export function compileMarkerRegex(source: string, fallback: RegExp): RegExp {
  try {
    return new RegExp(source, "gm")
  } catch {
    return fallback
  }
}

/**
 * Extracts the subagent name from a task dispatch input, trying the known
 * host field spellings in order.
 * @param input The dispatch input, or null/undefined.
 * @returns The agent name as a string, or an empty string when unknown.
 */
export function agentFromTaskInput(input: TaskInput | undefined | null): string {
  return String(input?.subagent_type ?? input?.agent ?? input?.subagent ?? "")
}

/**
 * Parses GATE and VERDICT markers out of assistant text, mutating the given
 * gate state (dedup set, gate-pass flag, verdict list) and returning only
 * first-sight observations for the caller to journal. The reviewer round
 * cap is counted per dispatch in `gates.ts`, not here.
 *
 * Only the last GATE/VERDICT match per text is observed (latest-wins);
 * earlier matches in the same text are reported via `suppressed` so the
 * caller can journal their loss. Latest-wins also applies across texts:
 * an observed `GATE: FAIL` clears a previously recorded `GATE: PASS`.
 *
 * Streaming sources (`message.part.updated`, text deltas) re-deliver the
 * same accumulated text; dedup on marker identity ensures the journal only
 * ever sees first sight. `dedupScope` partitions the dedup set: task-result
 * deliveries pass a unique scope per delivery so a re-run emitting a
 * byte-identical marker is still journaled, while streaming sources share
 * the empty scope.
 *
 * @param state Mutable gate state for the parent session.
 * @param text The assistant text to scan.
 * @param gateRe The gate marker regex (defaults to the canonical GATE_RE).
 * @param verdictRe The verdict marker regex (defaults to VERDICT_RE).
 * @param dedupScope Key prefix partitioning the dedup set (default "").
 * @returns Marker events observed for the first time in this text.
 */
export function parseGateMarkers(
  state: GateState,
  text: string,
  gateRe: RegExp = GATE_RE,
  verdictRe: RegExp = VERDICT_RE,
  dedupScope = "",
): MarkerEvent[] {
  const events: MarkerEvent[] = []
  if (!text) return events
  const gates = text.match(gateRe) ?? []
  const verdicts = text.match(verdictRe) ?? []
  const gate = gates[gates.length - 1] ?? null
  const verdict = verdicts[verdicts.length - 1] ?? null
  if (gate) {
    const key = `${dedupScope}gate\u0000${gate}`
    if (!state.seen.has(key)) {
      state.seen.add(key)
      const result: "PASS" | "FAIL" = gate.includes("PASS") ? "PASS" : "FAIL"
      // A re-run's FAIL un-greens a gate set by an earlier PASS, even across
      // different texts: the latest observed result wins.
      state.hasGatePass = result === "PASS"
      events.push({ kind: "gate", marker: gate, result, suppressed: gates.length - 1 })
    }
  }
  if (verdict) {
    const key = `${dedupScope}verdict\u0000${verdict}`
    if (!state.seen.has(key)) {
      state.seen.add(key)
      state.verdicts.push(verdict)
      // `rounds` reflects the dispatch-based reviewer round count; verdicts
      // no longer increment it (cap is enforced per dispatch in gates.ts).
      events.push({
        kind: "verdict",
        marker: verdict,
        rounds: state.reviewRounds,
        suppressed: verdicts.length - 1,
      })
    }
  }
  return events
}
