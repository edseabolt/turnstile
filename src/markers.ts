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
 * @param onFallback Optional callback invoked with the compile failure
 *     (the caught value) before the fallback is returned, so callers can
 *     journal the silent fallback without this module depending on journaling.
 * @returns The compiled regex, or the fallback when the source is invalid.
 */
export function compileMarkerRegex(
  source: string,
  fallback: RegExp,
  onFallback?: (cause: unknown) => void,
): RegExp {
  try {
    return new RegExp(source, "gm")
  } catch (cause) {
    onFallback?.(cause)
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
 * Records first-sight provenance for a dedup key and accounts for a
 * cross-child suppression. Returns false when the key was already seen (the
 * marker is a dedup hit), true on first sight. On a dedup hit whose raw
 * session differs from the stored provenance, the pending cross-child
 * suppression counter is incremented; re-delivery by the same raw session
 * stays silent.
 * @param state Mutable gate state for the parent session.
 * @param key The dedup key (scope + marker identity).
 * @param raw Raw session ID that produced the marker.
 * @returns True on first sight (the caller should record it); false on a dedup hit.
 */
function observeMarker(state: GateState, key: string, raw: string): boolean {
  if (state.seen.has(key)) {
    if (raw && state.seenFrom.get(key) !== raw) state.suppressedPending += 1
    return false
  }
  state.seen.add(key)
  state.seenFrom.set(key, raw)
  return true
}

/**
 * Reads and zeroes the pending cross-child suppression counter. Returns the
 * count accumulated since the last emitted event (0 on a fresh bucket).
 * @param state Mutable gate state for the parent session.
 * @returns The pending suppression count, leaving `suppressedPending` at 0.
 */
function takePending(state: GateState): number {
  const pending = state.suppressedPending
  state.suppressedPending = 0
  return pending
}

/**
 * Parses GATE and VERDICT markers out of assistant text, mutating the given
 * gate state (dedup set, gate-pass flag, first-sight provenance) and returning
 * only first-sight observations for the caller to journal. The reviewer round
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
 * @param raw Raw session ID that produced the marker (child provenance).
 * @returns Marker events observed for the first time in this text.
 */
export function parseGateMarkers(
  state: GateState,
  text: string,
  gateRe: RegExp = GATE_RE,
  verdictRe: RegExp = VERDICT_RE,
  dedupScope = "",
  raw = "",
): MarkerEvent[] {
  const events: MarkerEvent[] = []
  if (!text) return events
  const gates = text.match(gateRe) ?? []
  const verdicts = text.match(verdictRe) ?? []
  const gate = gates[gates.length - 1] ?? null
  const verdict = verdicts[verdicts.length - 1] ?? null
  if (gate) {
    const key = `${dedupScope}gate\u0000${gate}`
    if (observeMarker(state, key, raw)) {
      const result: "PASS" | "FAIL" = gate.includes("PASS") ? "PASS" : "FAIL"
      // A re-run's FAIL un-greens a gate set by an earlier PASS, even across
      // different texts: the latest observed result wins.
      state.hasGatePass = result === "PASS"
      events.push({
        kind: "gate",
        marker: gate,
        result,
        suppressed: gates.length - 1 + takePending(state),
      })
    }
  }
  if (verdict) {
    const key = `${dedupScope}verdict\u0000${verdict}`
    if (observeMarker(state, key, raw)) {
      // `rounds` reflects the dispatch-based reviewer round count; verdicts
      // no longer increment it (cap is enforced per dispatch in gates.ts).
      events.push({
        kind: "verdict",
        marker: verdict,
        rounds: state.reviewRounds,
        suppressed: verdicts.length - 1 + takePending(state),
      })
    }
  }
  return events
}
