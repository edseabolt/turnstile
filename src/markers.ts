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

import type {
  GateEvidenceMode,
  GateState,
  MarkerEvent,
  MarkerNearMiss,
  TaskInput,
} from "./types.ts"

// `export const` keeps the regex literals load-bearing for
// scripts/check-markers.mjs, which extracts them by name and asserts the
// README's marker examples still parse. Keep each regex on one line and
// edit the README examples and these literals together.
// prettier-ignore
export const GATE_RE = /^\s*[`>#*\s]*GATE: (PASS|FAIL) tests=\d+ passed=\d+ failed=\d+/gm
// prettier-ignore
export const VERDICT_RE = /^\s*[`>#*\s]*VERDICT: (APPROVE|BLOCK) crit=\d+ high=\d+ med=\d+ low=\d+/gm

/**
 * Canonical example matching the default GATE_RE. Display and breadth-probe
 * source only (see `src/config.ts`): not a new marker-validated source, so it
 * is not checked by scripts/check-markers.mjs. Guarded by a test asserting it
 * still parses under GATE_RE, mirroring the policy-template probe precedent.
 */
export const CANONICAL_GATE_MARKER = "GATE: PASS tests=3 passed=3 failed=0"
/**
 * Canonical example matching the default VERDICT_RE. Display and breadth-probe
 * source only (see `src/config.ts`); guarded by a test asserting it still
 * parses under VERDICT_RE.
 */
export const CANONICAL_VERDICT_MARKER = "VERDICT: APPROVE crit=0 high=0 med=0 low=0"

/**
 * Strips a marker's leading authority token so de-tokenized text can never
 * re-parse as an authoritative first-sight marker. The default `GATE_RE`/
 * `VERDICT_RE` match a case-sensitive uppercase `GATE:`/`VERDICT:` token, so
 * lowercasing the token (leaving the rest of the marker verbatim) makes any
 * embedded value unparsable while keeping it legible to the orchestrator. This
 * is the same rationale the ORCHESTRATOR_POLICY placeholders encode: injected
 * context that must not be mistaken for a real marker (see `policy.ts`).
 * @param marker The raw marker text, e.g. `GATE: PASS tests=2 passed=2 failed=0`.
 * @returns The same text with `GATE:`/`VERDICT:` lowercased, or the input
 *     unchanged when neither token prefixes it.
 */
export function deTokenizeMarker(marker: string): string {
  return marker.replace(
    /^(GATE|VERDICT):/,
    (_full, kind: string): string => `${kind.toLowerCase()}:`,
  )
}

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
 * Escapes one space-separated word of a marker literal for embedding in a
 * RegExp source, neutralizing the metacharacters `[.*+?^${}()|[\]\\]` so a
 * custom literal cannot throw at compile time.
 * @param word The literal word to escape.
 * @returns The regex-escaped word.
 */
function escapeNearMissWord(word: string): string {
  return word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

/**
 * Scans user prompt text for marker-shaped near misses of the configured
 * waiver/approval literals. Pure with respect to journal and state: the
 * caller journals the returned hits and renders the surface block. A near miss
 * is a token resembling an exact literal under a case variant, a separator
 * variant (space ⇄ underscore), or a colon variant (zero, one, or two colons)
 * — but never byte-identical to it. When the text contains a literal verbatim
 * the gate path already speaks for itself, so that literal's scan is skipped
 * entirely (a prompt that quotes a marker in prose while correctly using it is
 * not flagged twice). Word-boundary guards reject substring hits inside longer
 * words; the case-insensitive flag plus the `found !== literal` filter makes
 * the case class diagnostic-only. Matches use `String.match`, so the `g` flag's
 * `lastIndex` state is not an issue (see the note at `compileMarkerRegex`).
 * @param text The user prompt text to scan.
 * @param literals The configured literals to probe, each with the gate label
 *     a hit tried to move (e.g. "waiver", "plan approval").
 * @param maxPerLiteral Cap on distinct near-miss tokens reported per literal
 *     (default 3).
 * @returns Near-miss hits in first-seen order, deduped per literal.
 */
export function findMarkerNearMisses(
  text: string,
  literals: ReadonlyArray<{ literal: string; label: string }>,
  maxPerLiteral = 3,
): MarkerNearMiss[] {
  const hits: MarkerNearMiss[] = []
  if (text === "") return hits
  for (const { literal, label } of literals) {
    if (literal.trim() === "") continue
    if (text.includes(literal)) continue
    const words = literal.replace(/:+$/, "").split(/\s+/).filter(Boolean)
    if (words.length === 0) continue
    const core = words.map(escapeNearMissWord).join("[\\s_]+")
    const pattern = new RegExp("(?<![\\w_])" + core + ":{0,2}(?![\\w_])", "gi")
    const seen = new Set<string>()
    let count = 0
    for (const match of text.match(pattern) ?? []) {
      if (match === literal || seen.has(match)) continue
      seen.add(match)
      count += 1
      hits.push({ found: match, label, literal })
      if (count >= maxPerLiteral) break
    }
  }
  return hits
}

/**
 * Renders marker near-miss hits as a compact, model-facing block for the
 * prompt-admission surfacing in `src/setup.ts`. Pure and side-effect free
 * (throws nothing), mirroring `formatConfigWarnings`: a fixed header carries
 * the count and the journal path, one `- ` line per hit up to `maxLines`, and
 * a tail naming the hidden remainder past `maxLines` (the journal holds every
 * hit). The exact configured literal is named on each line so the model can
 * retry with the byte-exact string; nothing here moves a gate.
 * @param hits The near-miss hits to render (first-seen order).
 * @param journalPath Absolute path of the JSONL journal (named in the header).
 * @param maxLines Maximum hit lines before the truncation tail (default 3).
 * @returns The formatted `[turnstile] marker:` block.
 */
export function formatNearMissDiagnostics(
  hits: MarkerNearMiss[],
  journalPath: string,
  maxLines = 3,
): string {
  const header = `[turnstile] marker: ${hits.length} near-miss marker(s) — the strict literal is required (journal: ${journalPath}):`
  const shown = hits.slice(0, maxLines)
  const tail = hits.length > maxLines ? `\n(${hits.length - maxLines} more; see the journal)` : ""
  const lines = shown.map(
    (h) => `- found "${h.found}" — the ${h.label} marker is "${h.literal}" (exact string)`,
  )
  return [header, ...lines].join("\n") + tail
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
