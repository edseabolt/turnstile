/**
 * @fileoverview Evidence boundary: correlates an observed `GATE: PASS` against
 * journaled successful (exit 0) bash/shell test-command executions attributed
 * to the emitting session's parent within the current task window.
 *
 * This owns only the *evidence* dimension — whether the claimed tests ran.
 * Marker authority (*who* may flip gates) is deliberately separate
 * and out of scope here. The ledger is in-memory only (never command text);
 * audited verdicts are journaled so replay restores evidence-bearing state
 * rather than re-proving it. Pure w.r.t. journal/fs by design.
 */

import { DEFAULT_EVIDENCE_PATTERN } from "./config.ts"
import type { Journaler } from "./journal.ts"
import type { TurnstileConfig } from "./types.ts"

/** Per-session hit cap: a ring buffer of exit-0 hit timestamps. */
const MAX_HITS_PER_SESSION = 8

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
   * resolves).
   * @param sid The parent (or raw) session ID to check.
   * @returns True when correlated evidence exists.
   */
  has(sid: string): boolean
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
 * @returns The observe/has/clear tracker.
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
  // Raw session ID → ring of exit-0 hit timestamps; insertion-order LRU,
  // capped at `config.maxSessions` (mirroring state.ts bookkeeping).
  const hits = new Map<string, number[]>()

  /**
   * Promotes a key to most-recently-used in an insertion-ordered map.
   * @param map The map to reorder.
   * @param key The key to touch (no-op when absent).
   */
  function promote(map: Map<string, number[]>, key: string): void {
    const v = map.get(key)
    if (v !== undefined) {
      map.delete(key)
      map.set(key, v)
    }
  }

  /**
   * Evicts least-recently-used entries until within the cap.
   * @param map The map to trim.
   */
  function cap(map: Map<string, number[]>): void {
    while (map.size > config.maxSessions) {
      // The loop condition guarantees a first entry exists.
      const oldest = map.keys().next().value as string
      map.delete(oldest)
    }
  }

  function observe(raw: string, command: unknown, exit: unknown): boolean {
    if (!raw) return false
    if (exit !== 0) return false
    if (!pattern.test(String(command ?? ""))) return false
    const bucket = [...(hits.get(raw) ?? []), Date.now()]
    if (bucket.length > MAX_HITS_PER_SESSION) bucket.length = MAX_HITS_PER_SESSION
    hits.set(raw, bucket)
    cap(hits)
    return true
  }

  function has(sid: string): boolean {
    if (!sid) return false
    // Touch unconditionally: present keys reorder to MRU, absent keys no-op.
    promote(hits, sid)
    if (hits.has(sid)) return true
    for (const [child, bucket] of hits) {
      if (parentOf(child) === sid) {
        hits.delete(child)
        hits.set(sid, bucket)
        promote(hits, sid)
        return true
      }
    }
    return false
  }

  function clear(sid: string): void {
    if (!sid) return
    hits.delete(sid)
    for (const [child] of hits) {
      if (parentOf(child) === sid) hits.delete(child)
    }
  }

  return { observe, has, clear }
}
