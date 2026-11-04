/**
 * @fileoverview Gate-marker parsing boundary: the GATE/VERDICT marker arms
 * extracted from `parseGateMarkers` in `src/markers.ts`. Pure with respect to
 * journal and filesystem — the caller journals the returned marker events.
 * The marker regex literals stay canonical in `src/markers.ts`; this module
 * receives the compiled regexes as parameters.
 */

import type { GateEvidenceMode, GateState, MarkerEvent } from "./types.ts"
import { GATE_RE, VERDICT_RE } from "./markers.ts"

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
 * Applies a first-sight PASS gate marker: under `passVerified === false`
 * (enforce-only) the claim is flagged without flipping; otherwise the gate
 * greens and any stale unverified claim clears. The verified/mode stamp is
 * applied only when the caller supplied one (the `"off"` mode leaves both
 * undefined for byte-identical legacy output).
 * @param state Mutable gate state for the parent session.
 * @param gate The matched gate marker text.
 * @param gateCount Number of gate matches in the text (earlier ones are the
 *     suppressed count).
 * @param passVerified PASS flip switch: false flags without flipping;
 *     undefined or true flips.
 * @param stampVerified Journal stamp for the PASS event, or undefined when
 *     the event must stay byte-identical to legacy output.
 * @param stampMode Evidence mode at stamp time.
 * @param events The event list to append the emitted event to.
 */
function applyGatePass(
  state: GateState,
  gate: string,
  gateCount: number,
  passVerified: boolean | undefined,
  stampVerified: boolean | undefined,
  stampMode: GateEvidenceMode | undefined,
  events: MarkerEvent[],
): void {
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
  const stamp = stampVerified !== undefined ? { verified: stampVerified, mode: stampMode } : {}
  events.push({
    kind: "gate",
    marker: gate,
    result: "PASS",
    suppressed: gateCount - 1 + takePending(state),
    ...stamp,
  })
}

/**
 * Applies a first-sight gate marker after the dedup and authority checks,
 * dispatching on the marker's result. A re-run's FAIL un-greens a gate set by
 * an earlier PASS, even across different texts: the latest observed result
 * wins (and clears any unverified PASS left by an earlier enforce-only
 * rejection).
 * @param state Mutable gate state for the parent session.
 * @param gate The matched gate marker text.
 * @param gateCount Number of gate matches in the text.
 * @param passVerified PASS flip switch (see `applyGatePass`).
 * @param stampVerified Journal stamp for the PASS event, or undefined.
 * @param stampMode Evidence mode at stamp time.
 * @param events The event list to append the emitted event to.
 */
function applyGateResult(
  state: GateState,
  gate: string,
  gateCount: number,
  passVerified: boolean | undefined,
  stampVerified: boolean | undefined,
  stampMode: GateEvidenceMode | undefined,
  events: MarkerEvent[],
): void {
  const result: "PASS" | "FAIL" = gate.includes("PASS") ? "PASS" : "FAIL"
  if (result === "PASS") {
    applyGatePass(state, gate, gateCount, passVerified, stampVerified, stampMode, events)
    return
  }
  state.hasGatePass = false
  state.unverifiedPass = ""
  events.push({
    kind: "gate",
    marker: gate,
    result,
    suppressed: gateCount - 1 + takePending(state),
  })
}

/**
 * Applies the last gate marker in a text: dedup first, then the authority
 * predicate (a denied kind is applied nowhere and stamps nothing —
 * `observeMarker` has already registered the dedup key, so re-delivery of the
 * same text stays silent and the marker alone is emitted first-sight for
 * audit), then the result arm.
 * @param state Mutable gate state for the parent session.
 * @param gate The matched gate marker text.
 * @param gateCount Number of gate matches in the text.
 * @param dedupScope Key prefix partitioning the dedup set.
 * @param raw Raw session ID that produced the marker.
 * @param passVerified PASS flip switch (see `applyGatePass`).
 * @param stampVerified Journal stamp for the PASS event, or undefined.
 * @param stampMode Evidence mode at stamp time.
 * @param kindAllowed Optional predicate deciding whether a kind is
 *     authoritative for the emitting session.
 * @param events The event list to append the emitted event to.
 */
function applyGateMarker(
  state: GateState,
  gate: string,
  gateCount: number,
  dedupScope: string,
  raw: string,
  passVerified: boolean | undefined,
  stampVerified: boolean | undefined,
  stampMode: GateEvidenceMode | undefined,
  kindAllowed: ((kind: "gate" | "verdict") => boolean) | undefined,
  events: MarkerEvent[],
): void {
  const key = `${dedupScope}gate\u0000${gate}`
  if (!observeMarker(state, key, raw, true)) return
  if (kindAllowed && !kindAllowed("gate")) {
    events.push({ kind: "gate", marker: gate, authority: "suppressed" })
    return
  }
  applyGateResult(state, gate, gateCount, passVerified, stampVerified, stampMode, events)
}

/**
 * Applies the last verdict marker in a text: dedup first, then the authority
 * predicate (a denied kind is applied nowhere — not even the verdict store —
 * and stamps nothing; marker-only first-sight event for the caller to
 * journal). `rounds` reflects the dispatch-based reviewer round count;
 * verdicts no longer increment it (cap is enforced per dispatch in gates.ts).
 * @param state Mutable gate state for the parent session.
 * @param verdict The matched verdict marker text.
 * @param verdictCount Number of verdict matches in the text.
 * @param dedupScope Key prefix partitioning the dedup set.
 * @param raw Raw session ID that produced the marker.
 * @param kindAllowed Optional predicate deciding whether a kind is
 *     authoritative for the emitting session.
 * @param events The event list to append the emitted event to.
 */
function applyVerdictMarker(
  state: GateState,
  verdict: string,
  verdictCount: number,
  dedupScope: string,
  raw: string,
  kindAllowed: ((kind: "gate" | "verdict") => boolean) | undefined,
  events: MarkerEvent[],
): void {
  const key = `${dedupScope}verdict\u0000${verdict}`
  if (!observeMarker(state, key, raw, false)) return
  if (kindAllowed && !kindAllowed("verdict")) {
    events.push({ kind: "verdict", marker: verdict, authority: "suppressed" })
    return
  }
  events.push({
    kind: "verdict",
    marker: verdict,
    rounds: state.reviewRounds,
    suppressed: verdictCount - 1 + takePending(state),
  })
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
    applyGateMarker(
      state,
      gate,
      gates.length,
      dedupScope,
      raw,
      passVerified,
      stampVerified,
      stampMode,
      kindAllowed,
      events,
    )
  }
  if (verdict) {
    applyVerdictMarker(state, verdict, verdicts.length, dedupScope, raw, kindAllowed, events)
  }
  return events
}
