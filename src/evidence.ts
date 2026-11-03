/**
 * @fileoverview Evidence boundary: correlates an observed `GATE: PASS` against
 * journaled successful (exit 0) bash/shell test-command executions attributed
 * to the emitting session's parent, with an optional task-window lower bound
 * on the correlation and a pure-read snapshot for diagnostics.
 *
 * This owns only the *evidence* dimension — whether the claimed tests ran.
 * Marker authority (*who* may flip gates) is deliberately separate
 * and out of scope here. The ledger is in-memory only (never command text);
 * audited verdicts are journaled so replay restores evidence-bearing state
 * rather than re-proving it. Pure w.r.t. journal/fs by design.
 */

import { DEFAULT_EVIDENCE_PATTERN } from "./config.ts"
import { createEvidenceHits } from "./evidence-hits.ts"
import type { Journaler } from "./journal.ts"
import type { TurnstileConfig } from "./types.ts"

/** Fallback pattern used when the configured `evidencePattern` fails to compile. */
const FALLBACK_EVIDENCE_PATTERN = new RegExp(DEFAULT_EVIDENCE_PATTERN, "i")

/**
 * Compiles the evidence-pattern regex once, with a `compileMarkerRegex`-style
 * fallback: on a compile failure the caller is notified via `onFallback` and
 * the default pattern is used.
 * @param source The configured pattern source.
 * @param fallback Pattern to return on compile failure.
 * @param onFallback Optional callback invoked with the caught cause first.
 * @returns The compiled pattern (configured, or the fallback).
 */
function compileEvidencePattern(
  source: string,
  fallback: RegExp,
  onFallback?: (cause: unknown) => void,
): RegExp {
  try {
    return new RegExp(source, "i")
  } catch (cause) {
    onFallback?.(cause)
    return fallback
  }
}

/** Evidence tracker: recorded exit-0 bash/shell hits and their resolution. */
export interface EvidenceTracker {
  /**
   * Records a plausible exit-0 test execution under `raw`, returning whether a
   * hit was recorded. Non-zero exits and non-matching commands are ignored;
   * the command text is never stored.
   * @param raw The session ID that ran the command.
   * @param command The command string (matched, never retained).
   * @param exit The command exit code.
   * @returns True when a hit was recorded.
   */
  observe(raw: string, command: unknown, exit: unknown): boolean
  /**
   * True when `sid` or any child whose child→parent edge resolves to `sid`
   * has a recorded hit. Re-keys a found child bucket to `sid` (lazy
   * promotion, so an async parent edge established after `observe` still
   * resolves). With `since`, a bucket (direct or re-keyed) qualifies only
   * when its latest hit is at-or-after `since` (inclusive,
   * same-millisecond-tolerant); a filtered-out child stays keyed under the
   * child (no re-key on a miss, preserving laziness for a later call). When
   * a stale direct bucket exists and an in-window child qualifies, the
   * qualifying child bucket replaces the direct one (only stale timestamps
   * are discarded, since the direct bucket's latest hit predates `since`).
   * @param sid The parent (or raw) session ID to check.
   * @param since Optional inclusive lower bound (the task window).
   * @returns True when correlated evidence exists.
   */
  has(sid: string, since?: number): boolean
  /**
   * Diagnostic view: a copy of every tracked session ID with its latest hit
   * timestamp, in insertion order. Pure read: no LRU promotion, no cap, no
   * mutation — safe for the attribution layer that decides what a refusal
   * must name.
   * @returns One `{ session, last }` per tracked session.
   */
  snapshot(): Array<{ session: string; last: number }>
  /**
   * Drops `sid`'s bucket and every child's bucket whose edge resolves to `sid`.
   * @param sid The parent (or raw) session ID to clear.
   */
  clear(sid: string): void
}

/**
 * Creates an in-memory evidence tracker bound to a config + parent resolver.
 * A configured `evidencePattern` that fails to compile falls back to the
 * default pattern and journals the fallback via `journaler`.
 * @param config The resolved config (provides `evidencePattern`, `maxSessions`).
 * @param parentOf Resolves a raw session ID to its parent (the ledger's `parentOf`).
 * @param journaler Optional telemetry writer; used only to journal the
 *     pattern-fallback (a compile failure) when set.
 * @returns The observe/has/clear/snapshot tracker.
 */
export function createEvidenceTracker(
  config: TurnstileConfig,
  parentOf: (raw: string) => string,
  journaler?: Pick<Journaler, "journal">,
): EvidenceTracker {
  const pattern = compileEvidencePattern(
    config.evidencePattern,
    FALLBACK_EVIDENCE_PATTERN,
    (cause) =>
      journaler?.journal({
        type: "error",
        error: `config evidencePattern: invalid regex, using default: ${String(cause)}`,
      }),
  )
  return createEvidenceHits(config.maxSessions, pattern, parentOf)
}
