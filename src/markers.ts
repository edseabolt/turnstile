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

import type { MarkerNearMiss, TaskInput } from "./types.ts"

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
 * is the same rationale the orchestrator-policy placeholders encode: injected
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

/**
 * Classifies a marker's result from the regex's capture group 1 rather than
 * substring search, so a custom marker source whose matched span contains the
 * opposite keyword still classifies by what the regex captured. When group 1
 * is absent (a capture-less custom source, or a replayed marker from a
 * since-changed source) the legacy substring classification is the fallback,
 * preserving pre-existing semantics. Pure; safe on shared /g regexes
 * (`matchAll` clones, never advances `lastIndex`).
 * @param marker The full marker match text to classify.
 * @param re The marker regex that produced (or would produce) the marker;
 *     must carry the `g` flag (`matchAll` throws on non-global regexes).
 * @param primary The keyword mapping to the primary result (group 1 === primary).
 * @param other The keyword mapping to the other result.
 * @returns `primary` when group 1 (or the fallback substring search) matches
 *     `primary`, otherwise `other`.
 */
function classifyMarkerResult<K extends string>(
  marker: string,
  re: RegExp,
  primary: K,
  other: K,
): K {
  const group = Array.from(marker.matchAll(re), (m) => m[1]).at(0)
  if (group === primary) return primary
  if (group === other) return other
  return marker.includes(primary) ? primary : other
}

/**
 * Classifies a gate marker's result from the gate regex's capture group 1
 * (`PASS`/`FAIL`), falling back to substring classification when group 1 is
 * absent. See `classifyMarkerResult` for the rationale.
 * @param marker The full gate marker match text to classify.
 * @param re The gate marker regex that produced the marker; must carry the
 *     `g` flag. Defaults to the canonical `GATE_RE`.
 * @returns `"PASS"` when the capture group (or fallback substring) is `PASS`,
 *     otherwise `"FAIL"`.
 */
export function gateResultOf(marker: string, re: RegExp = GATE_RE): "PASS" | "FAIL" {
  return classifyMarkerResult(marker, re, "PASS", "FAIL")
}

/**
 * Classifies a verdict marker's result from the verdict regex's capture
 * group 1 (`APPROVE`/`BLOCK`), falling back to substring classification when
 * group 1 is absent. See `classifyMarkerResult` for the rationale.
 * @param marker The full verdict marker match text to classify.
 * @param re The verdict marker regex that produced the marker; must carry
 *     the `g` flag. Defaults to the canonical `VERDICT_RE`.
 * @returns `"APPROVE"` when the capture group (or fallback substring) is
 *     `APPROVE`, otherwise `"BLOCK"`.
 */
export function verdictResultOf(marker: string, re: RegExp = VERDICT_RE): "APPROVE" | "BLOCK" {
  return classifyMarkerResult(marker, re, "APPROVE", "BLOCK")
}

/**
 * Parses the configured agent names named in a waiver's raw text into its
 * scope. The grammar is literal configured stage names only — a name is in
 * scope iff its configured string occurs (case-insensitively) in the text —
 * so a waiver is deterministically scoped and never guessed. `agentNames` is
 * the resolved `config.agents` value, so a renamed install scopes by its own
 * names.
 *
 * Rules: non-string and blank names are skipped (the `config.agents` value
 * carries the `bareOutput` array, so a non-string is a real input, not a
 * guard); the names are scanned longest-first (stable, so equal-length names
 * keep their configured order) so a compound name (`plan-reviewer`) consumes
 * its span before a shorter name (`reviewer`) could claim it; on a hit the
 * name's span is masked with spaces so a shorter name cannot re-match inside
 * it; results are deduped and returned in scan (longest-first) order.
 * `[]` when nothing matches — deterministically unscoped.
 *
 * Pure: no journal, filesystem, or state.
 * @param text The raw waiver text to scan (the marker-onward window).
 * @param agentNames The configured agent names (the `config.agents` value);
 *     non-string and blank entries are skipped.
 * @returns The configured agent names named in the text, in scan order, or
 *     `[]` when none is named.
 */
export function parseWaiverScope(text: string, agentNames: readonly unknown[]): string[] {
  const found: string[] = []
  if (text === "") return found
  const names = agentNames
    .filter((name): name is string => typeof name === "string" && name.trim() !== "")
    .map((name) => ({ name, lower: name.toLowerCase() }))
    // Longest first (stable for equal lengths) so a compound name masks its
    // span before a shorter name can claim it.
    .sort((a, b) => b.lower.length - a.lower.length)
  let working = text.toLowerCase()
  for (const { name, lower } of names) {
    const at = working.indexOf(lower)
    if (at === -1) continue
    if (found.includes(name)) continue
    found.push(name)
    // Mask the matched span so a shorter name cannot re-match inside it.
    working = working.slice(0, at) + " ".repeat(lower.length) + working.slice(at + lower.length)
  }
  return found
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
 * Computes the floor bound (in chars) for the streamed-marker sliding
 * window, from the *effective* compiled marker regex sources. A window
 * shorter than a complete marker cannot reassemble a marker split across
 * `session.text.delta` chunks, so the bound must cover at least the sum of
 * both sources (either regex alone then gets ≥2× slack over its own source
 * length); the 512 floor preserves the historical "comfortably longer"
 * heuristic for short (default) sources, so the default-config window is
 * unchanged. This is a floor heuristic covering the identified failure mode
 * (a long literal prefix), not a hard guarantee: a source with quantifier
 * expansion (e.g. `\d+`) can still match text longer than its source length.
 * @param gateSource The effective compiled GATE marker regex source.
 * @param verdictSource The effective compiled VERDICT marker regex source.
 * @returns The window bound in chars (never below 512).
 */
export function deltaWindowFloorChars(gateSource: string, verdictSource: string): number {
  return Math.max(512, gateSource.length + verdictSource.length)
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
 * Renders one model-facing diagnostic block: a fixed header, one line per
 * entry up to `maxLines`, and a tail naming the hidden remainder past
 * `maxLines` (the journal holds the full list, so the tail always points at
 * it). Pure and side-effect free (throws nothing); both diagnostic surfaces
 * (`formatNearMissDiagnostics` here and `formatConfigWarnings` in
 * `src/config.ts`) are thin wrappers over this shared renderer, keeping only
 * their header and line format divergent.
 * @param header The first line of the block (caller-specific wording).
 * @param lines The entry lines to render (first-seen order).
 * @param maxLines Maximum entry lines before the truncation tail.
 * @returns The joined block, with the truncation tail only when `lines`
 *     exceeds `maxLines`.
 */
export function formatDiagnosticBlock(header: string, lines: string[], maxLines: number): string {
  const shown = lines.slice(0, maxLines)
  const tail = lines.length > maxLines ? `\n(${lines.length - maxLines} more; see the journal)` : ""
  return [header, ...shown].join("\n") + tail
}

/**
 * Renders marker near-miss hits as a compact, model-facing block for the
 * prompt-admission surfacing in `src/setup.ts`. Pure and side-effect free
 * (throws nothing): a fixed header carries the count and the journal path,
 * one `- ` line per hit up to `maxLines`, and a tail naming the hidden
 * remainder past `maxLines` (the journal holds every hit) — all rendered by
 * `formatDiagnosticBlock`. The exact configured literal is named on each line
 * so the model can retry with the byte-exact string; nothing here moves a gate.
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
  const lines = hits.map(
    (h) => `- found "${h.found}" — the ${h.label} marker is "${h.literal}" (exact string)`,
  )
  return formatDiagnosticBlock(header, lines, maxLines)
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

export { parseGateMarkers } from "./gate-markers-parse.ts"
