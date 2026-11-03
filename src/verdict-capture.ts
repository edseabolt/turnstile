/**
 * @fileoverview Verdict-capture concern: parsing `GATE:`/`VERDICT:` markers
 * out of assistant text, journaling first-sight observations (gate, verdict,
 * and authority-suppressed), recording streamed verdicts into the child
 * store, and the last-match helper the attribution paths share. Extracted
 * from `src/hooks-core.ts`; the shared per-setup state is threaded as one
 * typed state object. The marker regexes are compiled by the factory and
 * passed in — this module never re-parses marker syntax.
 */

import type { Journaler } from "./journal.ts"
import type { GateLedger } from "./ledger.ts"
import type { GateState, MarkerEvent, TurnstileConfig } from "./types.ts"
import { deTokenizeMarker, parseGateMarkers } from "./markers.ts"
import type { EvidenceTracker } from "./evidence.ts"

/**
 * The state the verdict-capture concern reads and mutates: the shared deps
 * and the cross-concern helpers it delegates to.
 */
export interface VerdictCaptureState {
  /** The resolved plugin configuration (the evidence mode). */
  config: TurnstileConfig
  /** The telemetry journal writer. */
  journaler: Journaler
  /** The gate-state ledger (parent resolution + verdict store + buckets). */
  ledger: GateLedger
  /** Compiled GATE marker regex. */
  gateRe: RegExp
  /** Compiled VERDICT marker regex. */
  verdictRe: RegExp
  /** Evidence tracker for plan-approval stamps. */
  evidence: EvidenceTracker
  /** Parent → Date.now() of its latest admitted prompt (task window). */
  taskWindows: Map<string, number>
  /** Per-kind authority predicate for a session's emitter. */
  markerKindAllowed(sessionID: string): (kind: "gate" | "verdict") => boolean
  /** Returns the session's resolved emitter agent, or "" when unresolved. */
  emitterAgent(sessionID: string): string
  /** Marks the parent's active task retired (a flipping PASS boundary). */
  markTaskComplete(sessionID: string, s: GateState): void
}

/**
 * The evidence-stamp fields one parse derives: the observed correlation
 * (undefined under "off"), the flip switch (only under "enforce"), and the
 * journal stamp pair (the observed value + the mode, omitted under "off").
 */
interface EvidenceStampFields {
  observed: boolean | undefined
  passVerified: boolean | undefined
  stampVerified: boolean | undefined
  stampMode: import("./types.ts").GateEvidenceMode | undefined
}

/**
 * Derives the evidence-stamp fields for one marker parse: under "enforce"
 * the flip switch is the observed correlation; under "flag" the flip switch
 * is omitted (always flips) while the journal is stamped; under "off" neither
 * the flip switch nor the stamp is passed, keeping events byte-identical to
 * legacy output. The correlation is windowed at the parent's task-window
 * stamp (the same bound the promotion join uses), so a keep-scope admission
 * cannot verify a claim with exit-0 hits that predate the prompt — the
 * per-prompt anti-fabrication bound survives the task-long-lived scope. A
 * parent that never admitted a prompt keeps the unbounded join (stamp 0).
 * @param config The resolved plugin configuration (the evidence mode).
 * @param evidence The evidence tracker (the correlation read).
 * @param sid The parent session the parse is keyed on.
 * @param taskWindows The parent → latest-admitted-prompt window map.
 * @returns The derived stamp fields.
 */
function evidenceStampFields(
  config: TurnstileConfig,
  evidence: EvidenceTracker,
  sid: string,
  taskWindows: Map<string, number>,
): EvidenceStampFields {
  const observed =
    config.gateEvidence === "off" ? undefined : evidence.has(sid, taskWindows.get(sid) ?? 0)
  return {
    observed,
    passVerified: config.gateEvidence === "enforce" ? observed : undefined,
    stampVerified: observed,
    stampMode: observed === undefined ? undefined : config.gateEvidence,
  }
}

/**
 * Returns the last verdict match in `text` for `re` (last-match-wins, the
 * same rule `parseGateMarkers` uses); "" when there is no match. Independent
 * of `String.match`'s global-regex lastIndex state because `.match` resets it.
 * @param text The text to scan.
 * @param re The compiled verdict regex.
 * @returns The last match text, or "" when `text` has no verdict match.
 */
function lastMatchBody(text: string, re: RegExp): string {
  return text.match(re)?.at(-1) ?? ""
}

/**
 * Records a child's latest VERDICT from the text itself, before the parent
 * edge is needed, so a child with an unresolved edge still records. Only
 * non-task-result sources enter the store: task-result markers are handled
 * by the delivery's own match during attribution, and keeping them out
 * preserves "a marker-less task-result delivery keeps the gate red".
 *
 * Store-backed verdict observations: the store records the child's latest
 * VERDICT (per (child, marker, source) first-sight) for the plan gate's
 * attribution reads; the parent-bucket dedup (markers.ts) keys on
 * (scope, marker), so identical re-delivery and a cross-source same-marker
 * replay (a source change with an unchanged marker, e.g. delta→ended) are
 * both silently suppressed; only a marker flip reaches the journal.
 * Authority gate: only a marker-contracted emitter (see markerKindAllowed)
 * may record or apply a verdict; a quoted/echoed verdict is denied here
 * (never stored) and surfaces as a suppressed observation when the gate
 * journals it.
 * @param st The verdict-capture state.
 * @param text The assistant text to scan.
 * @param sessionID The raw (possibly child) session ID.
 * @param source Provenance label for the text in journal entries.
 */
function recordStreamedVerdictBody(
  st: VerdictCaptureState,
  text: string,
  sessionID: string,
  source: string,
): void {
  const allowed = st.markerKindAllowed(sessionID)
  if (sessionID && source !== "task-result" && allowed("verdict")) {
    const m = lastMatchBody(text, st.verdictRe)
    if (m) st.ledger.recordChildVerdict(sessionID, m, source)
  }
}

/**
 * Journals a marker observation denied by the authority gate: keyed on the
 * EMITTER (not the parent) as a replay-inert type:"suppressed" audit
 * entry. Nothing is applied — the event is never returned to the caller,
 * so hasReviewApprove and own-match attribution cannot fire on it. Keyed
 * on the emitter (not the parent) because nothing replays against a denied
 * observation; this runs for every non-empty sessionID, including
 * unresolved-edge ones (self-keyed).
 * @param st The verdict-capture state.
 * @param event The denied marker observation. The `reason` field names the
 *   denial cause (unresolved emitter vs. kind not in the emitter's contract)
 *   so journal forensics do not require source reading.
 * @param sessionID The emitter (raw child) session ID.
 * @param source Provenance label for the text.
 */
function journalSuppressedObservationBody(
  st: VerdictCaptureState,
  event: MarkerEvent,
  sessionID: string,
  source: string,
): void {
  const agent = st.emitterAgent(sessionID)
  st.journaler.journal({
    type: "suppressed",
    sessionID,
    raw: sessionID,
    agent,
    kind: event.kind,
    marker: event.marker,
    source,
    reason: agent === "" ? "emitter agent unresolved" : "agent not contracted for kind",
  })
}
/**
 * Journals a first-sight `GATE:` observation: keyed by parent session so
 * journal replay restores state where the reviewer gate looks it up; raw
 * child ID kept for forensics. Spreads the evidence stamp (present only
 * when the evidence mode is not "off"), the task fingerprint (only when
 * the parent's bucket has stamped one, so replay can restore the carry
 * identity), and the suppressed-match count (only when > 0), and carries
 * the de-tokenized marker text for the compaction snapshot (the state
 * boundary records it, this helper journals the event).
 * @param st The verdict-capture state.
 * @param event The gate marker observation (authority never "suppressed").
 * @param suppressedCount The suppressed-match count spread, empty when 0.
 * @param sid The parent session the `gate` entry is keyed on.
 * @param sessionID The raw child session ID for the entry's `raw` field.
 * @param source Provenance label for the text.
 * @param s The parent's gate state (mutated: lastGateMarker).
 */
function journalGateEventBody(
  st: VerdictCaptureState,
  event: MarkerEvent,
  suppressedCount: { suppressed?: number },
  sid: string,
  sessionID: string,
  source: string,
  s: GateState,
): void {
  const evidenceStamp =
    event.verified !== undefined ? { verified: event.verified, mode: event.mode } : {}
  const fp = s.taskFingerprint !== "" ? { fp: s.taskFingerprint } : {}
  st.journaler.journal({
    type: "gate",
    sessionID: sid,
    raw: sessionID,
    result: event.result,
    source,
    marker: event.marker,
    ...evidenceStamp,
    ...fp,
    ...suppressedCount,
  })
  // A green gate flip is the task's completion boundary: a flipping PASS
  // (an enforce-unverified claim never flipped) journals its task-complete
  // companion row and stamps the retire, so the next admitted prompt
  // starts a fresh scope.
  const flipped = event.verified !== false || event.mode === "flag"
  if (event.result === "PASS" && flipped) st.markTaskComplete(sid, s)
  st.journaler.traceEvent("test-runner", "gate", event.marker, sid)
  // Carry the de-tokenized marker text for the compaction snapshot; the
  // state boundary records it, the caller journals the event.
  s.lastGateMarker = deTokenizeMarker(event.marker)
}

/**
 * Journals a first-sight `VERDICT:` observation: keyed by parent session
 * with the raw child ID kept for forensics, the emitting agent (the
 * authority-checked emitter — the same resolution `markerKindAllowed` used
 * to authorize this event one synchronous step earlier — so replay
 * attributes the verdict and credits only reviewer-attributed ones),
 * spreading the suppressed-match count (only when > 0). Streaming verdict
 * dedup is per (child, marker, source) via the store (a source change with
 * an unchanged marker re-journals; identical re-delivery never emits an
 * event here because the parent-bucket dedup on (scope, marker) suppresses
 * it first). Gate-kind events are unaffected. Carries the de-tokenized
 * marker text for the compaction snapshot.
 * @param st The verdict-capture state.
 * @param event The verdict marker observation (authority never "suppressed").
 * @param suppressedCount The suppressed-match count spread, empty when 0.
 * @param sid The parent session the `verdict` entry is keyed on.
 * @param sessionID The raw child session ID for the entry's `raw` field.
 * @param source Provenance label for the text.
 * @param s The parent's gate state (mutated: lastVerdictMarker).
 */
function journalVerdictEventBody(
  st: VerdictCaptureState,
  event: MarkerEvent,
  suppressedCount: { suppressed?: number },
  sid: string,
  sessionID: string,
  source: string,
  s: GateState,
): void {
  st.journaler.journal({
    type: "verdict",
    sessionID: sid,
    raw: sessionID,
    agent: st.emitterAgent(sessionID),
    marker: event.marker,
    rounds: event.rounds,
    source,
    ...suppressedCount,
  })
  st.journaler.traceEvent("reviewer", "verdict", event.marker, sid)
  s.lastVerdictMarker = deTokenizeMarker(event.marker)
}

/**
 * Routes a first-sight marker observation to its kind-specific journal
 * helper: an observation denied by the authority gate journals as
 * suppressed and never falls through to the gate/verdict helpers.
 * @param st The verdict-capture state.
 * @param event The first-sight marker observation.
 * @param sid The parent session gate/verdict entries are keyed on.
 * @param sessionID The raw child (emitter) session ID.
 * @param source Provenance label for the text.
 * @param s The parent's gate state (mutated by the kind helpers).
 */
function journalMarkerEventBody(
  st: VerdictCaptureState,
  event: MarkerEvent,
  sid: string,
  sessionID: string,
  source: string,
  s: GateState,
): void {
  if (event.authority === "suppressed") {
    journalSuppressedObservationBody(st, event, sessionID, source)
    return
  }
  // Every event that passes the authority check above carries a defined
  // numeric `suppressed` count (denied events omit it); assert that shape
  // to the type checker (it is not optional at runtime).
  const suppressed = event.suppressed!
  const suppressedCount = suppressed > 0 ? { suppressed } : {}
  if (event.kind === "gate") {
    journalGateEventBody(st, event, suppressedCount, sid, sessionID, source, s)
    return
  }
  journalVerdictEventBody(st, event, suppressedCount, sid, sessionID, source, s)
}

/**
 * Parses markers out of assistant text and journals first-sight events.
 * @param st The verdict-capture state.
 * @param text The assistant text to scan.
 * @param sessionID The raw (possibly child) session ID.
 * @param source Provenance label for the text in journal entries.
 * @param dedupScope Key prefix partitioning the marker dedup set.
 * @returns The first-sight events that were journaled (the caller uses
 *     them to credit reviewer approvals); suppressed observations are
 *     journaled but excluded.
 */
function parseMarkersBody(
  st: VerdictCaptureState,
  text: string,
  sessionID: string,
  source: string,
  dedupScope = "",
): MarkerEvent[] {
  const events: MarkerEvent[] = []
  if (!text) return events
  recordStreamedVerdictBody(st, text, sessionID, source)
  const sid = st.ledger.parentOf(sessionID)
  if (!sid) return events
  const s = st.ledger.state(sid)
  // Evidence verdict computed here: the caller owns the tracker + config
  // (see evidenceStampFields for the per-mode derivation).
  const stamps = evidenceStampFields(st.config, st.evidence, sid, st.taskWindows)
  // Thread the raw child session ID as `raw`: dedup provenance is per-child,
  // so a dedup hit from a different child accounts as cross-child suppression
  // while the same child's re-delivery stays silent.
  for (const event of parseGateMarkers(
    s,
    text,
    st.gateRe,
    st.verdictRe,
    dedupScope,
    sessionID,
    stamps.passVerified,
    stamps.stampVerified,
    stamps.stampMode,
    st.markerKindAllowed(sessionID),
  )) {
    collectMarkerEvent(st, events, event, sid, sessionID, source, s)
  }
  return events
}

/**
 * Journals one first-sight marker observation and collects it for the
 * caller when it is authoritative: the execute.after reviewer branch uses
 * the collected events to detect a first-sight verdict APPROVE and set
 * `hasReviewApprove`; suppressed observations are journaled and excluded.
 * @param st The verdict-capture state.
 * @param events The accumulator the authoritative events are pushed to.
 * @param event The first-sight marker observation.
 * @param sid The parent session gate/verdict entries are keyed on.
 * @param sessionID The raw child (emitter) session ID.
 * @param source Provenance label for the text.
 * @param s The parent's gate state (mutated by the kind helpers).
 */
function collectMarkerEvent(
  st: VerdictCaptureState,
  events: MarkerEvent[],
  event: MarkerEvent,
  sid: string,
  sessionID: string,
  source: string,
  s: GateState,
): void {
  journalMarkerEventBody(st, event, sid, sessionID, source, s)
  if (event.authority !== "suppressed") events.push(event)
}

/**
 * Creates the verdict-capture concern bound to the factory's shared state.
 * The bodies live at module level; the factory only builds the state object.
 * @param st The verdict-capture state (see {@link VerdictCaptureState}).
 * @returns The verdict-capture methods the shared context exposes.
 */
export function createVerdictCapture(st: VerdictCaptureState): {
  parseMarkers(text: string, sessionID: string, source: string, dedupScope?: string): MarkerEvent[]
  lastMatch(text: string, re: RegExp): string
} {
  return {
    parseMarkers: (text, sessionID, source, dedupScope) =>
      parseMarkersBody(st, text, sessionID, source, dedupScope),
    lastMatch: (text, re) => lastMatchBody(text, re),
  }
}
