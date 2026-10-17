/**
 * @fileoverview Marker boundary: `GATE:`/`VERDICT:` marker parsing with
 * per-task dedup, plus agent attribution helpers. Pure with respect to
 * journal and filesystem, so callers journal the returned marker events.
 *
 * The caller computes the evidence verdict (it owns the evidence tracker and
 * config) and threads it in as optional trailing params: `passVerified` flips
 * the gate only under `enforce`, while `stampVerified`/`stampMode` label the
 * journal entry under `enforce` and `flag` (absent under `off`, keeping those
 * events byte-identical to legacy output).
 */

import type { GateEvidenceMode, GateState, MarkerEvent, TaskInput } from "./types.ts"

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
 * suppression counter is incremented — but only for gate-kind keys (see the
 * MED note below); re-delivery by the same raw session stays silent.
 * @param state Mutable gate state for the parent session.
 * @param key The dedup key (scope + marker identity).
 * @param raw Raw session ID that produced the marker.
 * @param gate True when the key gates a gate-kind marker (a `GATE:` match),
 *     false for a verdict-kind marker (a `VERDICT:` match).
 * @returns True on first sight (the caller should record it); false on a dedup hit.
 */
function observeMarker(state: GateState, key: string, raw: string, gate: boolean): boolean {
  if (state.seen.has(key)) {
    // Cross-child suppression is charged to `suppressedPending` only for
    // gate-kind hits: a verdict-kind dedup hit is suppressed
    // here and owned by the marker-gated store-diff layer, so it must not bleed
    // into the next emitted event's `suppressed` field (which, for a gate
    // event, is the gate-event `suppressed` reported in the journal).
    if (gate && raw && state.seenFrom.get(key) !== raw) state.suppressedPending += 1
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
 * Provenance note: the bucket `seen`/`seenFrom`/`suppressedPending` set now
 * tracks gate-kind first-sight and cross-child suppression (the pending
 * counter charges only gate-kind hits, so verdict-kind cross-child hits never
 * surface as a gate-event suppression). Streaming VERDICT dedup keys on
 * `(scope, marker)`, so identical re-delivery and a cross-source same-marker
 * replay are both suppressed here, and only a marker flip is emitted for the
 * setup layer to journal; the store records source changes for attribution but
 * journaling stays marker-gated (the store records source changes for
 * attribution; the journal sees only marker flips).
 *
 * @param state Mutable gate state for the parent session.
 * @param text The assistant text to scan.
 * @param gateRe The gate marker regex (defaults to the canonical GATE_RE).
 * @param verdictRe The verdict marker regex (defaults to VERDICT_RE).
 * @param dedupScope Key prefix partitioning the dedup set (default "").
 * @param raw Raw session ID that produced the marker (child provenance).
 * @param passVerified PASS flip switch: false (enforce-only) flags the last
 *     unverified claim without flipping; undefined (flag/off) or true flips.
 * @param stampVerified Journal stamp for the PASS event, or undefined when the
 *     event must stay byte-identical to legacy output (the `"off"` mode).
 * @param stampMode Evidence mode at stamp time (replay uses it to distinguish
 *     enforce non-flipping entries from flag flipping ones).
 * @param kindAllowed Optional predicate deciding whether a kind is
 *     authoritative for the emitting session. Absent ⇒ every kind is allowed
 *     (all existing callers are byte-identical); when present, a denied kind
 *     is applied nowhere and emitted first-sight with `authority:"suppressed"`
 *     for the caller to journal and drop (dedup is still registered, so the
 *     same text re-delivered stays silent).
 * @returns Marker events observed for the first time in this text.
 */
export function parseGateMarkers(
  state: GateState,
  text: string,
  gateRe: RegExp = GATE_RE,
  verdictRe: RegExp = VERDICT_RE,
  dedupScope = "",
  raw = "",
  passVerified?: boolean,
  stampVerified?: boolean,
  stampMode?: GateEvidenceMode,
  kindAllowed?: (kind: "gate" | "verdict") => boolean,
): MarkerEvent[] {
  const events: MarkerEvent[] = []
  if (!text) return events
  const gates = text.match(gateRe) ?? []
  const verdicts = text.match(verdictRe) ?? []
  const gate = gates[gates.length - 1] ?? null
  const verdict = verdicts[verdicts.length - 1] ?? null
  if (gate) {
    const key = `${dedupScope}gate\u0000${gate}`
    if (observeMarker(state, key, raw, true)) {
      // Denied kind: applied nowhere and stamps nothing. observeMarker has
      // already registered the dedup key, so re-delivery of the same text
      // stays silent; the marker alone is emitted first-sight for audit.
      if (kindAllowed && !kindAllowed("gate")) {
        events.push({ kind: "gate", marker: gate, authority: "suppressed" })
      } else {
        const result: "PASS" | "FAIL" = gate.includes("PASS") ? "PASS" : "FAIL"
        if (result === "PASS") {
          // passVerified === false (enforce-only) flags the last unverified
          // claim without flipping; undefined (flag/off) or true flips as before.
          if (passVerified === false) {
            state.unverifiedPass = gate
          } else {
            state.hasGatePass = true
            state.unverifiedPass = ""
          }
          // Stamp verified/mode only when the caller supplied a stamp: the
          // `"off"` mode leaves both undefined for byte-identical legacy output.
          const stamp =
            stampVerified !== undefined ? { verified: stampVerified, mode: stampMode } : {}
          events.push({
            kind: "gate",
            marker: gate,
            result,
            suppressed: gates.length - 1 + takePending(state),
            ...stamp,
          })
        } else {
          // A re-run's FAIL un-greens a gate set by an earlier PASS, even across
          // different texts: the latest observed result wins. Clears any
          // unverified PASS left by an earlier enforce-only rejection.
          state.hasGatePass = false
          state.unverifiedPass = ""
          events.push({
            kind: "gate",
            marker: gate,
            result,
            suppressed: gates.length - 1 + takePending(state),
          })
        }
      }
    }
  }
  if (verdict) {
    const key = `${dedupScope}verdict\u0000${verdict}`
    if (observeMarker(state, key, raw, false)) {
      // Denied kind: applied nowhere (not even the verdict store) and stamps
      // nothing; marker-only first-sight event for the caller to journal.
      if (kindAllowed && !kindAllowed("verdict")) {
        events.push({ kind: "verdict", marker: verdict, authority: "suppressed" })
      } else {
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
  }
  return events
}
