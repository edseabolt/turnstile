/**
 * @fileoverview State boundary: per-session gate state, the child→parent
 * session mapping, and journal replay so a completed task's `GATE: PASS`
 * survives restarts. Pure bookkeeping; no enforcement decisions here.
 */

import * as fs from "node:fs"

import type { ChildVerdict, GateState } from "./types.ts"

/**
 * Creates a fresh gate state bucket for one parent session.
 * @returns An empty GateState with an empty marker-dedup set.
 */
export function newState(): GateState {
  return {
    hasGatePass: false,
    hasPlanVerdict: false,
    seenFrom: new Map(),
    suppressedPending: 0,
    reviewRounds: 0,
    reads: 0,
    seen: new Set(),
    plansSignature: "",
    // A freshly-built bucket has no outstanding replay grace; only a journal
    // replay (createLedger) grants it, and only for one prompt.
    replayGrace: false,
  }
}

/**
 * Builds the gate state for the first post-restart prompt (the grace prompt):
 * carries the replayed bucket's current flag _values_ forward — not provenance
 * — so a live `GATE: FAIL` after replay is never resurrected. All other fields
 * (`seenFrom`, `suppressedPending`, `reviewRounds`, `reads`, `seen`, the empty
 * `plansSignature` stamp) come fresh; the returned bucket's `replayGrace` is
 * consumed (false).
 * @param prior The replayed bucket being reset.
 * @returns A reset bucket with the prior flags; grace consumed.
 */
function mergeAfterReplay(prior: GateState): GateState {
  const s = newState()
  s.hasGatePass = prior.hasGatePass
  s.hasPlanVerdict = prior.hasPlanVerdict
  s.plansSignature = prior.hasPlanVerdict ? prior.plansSignature : ""
  return s
}

/** Live gate bookkeeping shared by the gate, marker, and wiring layers. */
export interface GateLedger {
  /** Child→parent session-ID mapping; readable for membership checks. */
  childToParent: Map<string, string>
  /**
   * Returns the gate state for a parent session, creating an empty one on
   * first access.
   * @param sessionID The parent session ID.
   * @returns The session's mutable gate state.
   */
  state(sessionID: string): GateState
  /**
   * Resets a session's gate state for a new user prompt (a new prompt starts a
   * new task). The first prompt after a restart carries the journal-replayed
   * flags forward with a single-prompt grace (values, not provenance — a live
   * GATE: FAIL after replay is carried as false); every later prompt fully
   * resets (fresh flags; `reviewRounds`/`reads`/`seen`/`seenFrom`/
   * `suppressedPending` are always fresh). Fail-open: pure object map
   * operations.
   * @param sessionID The parent session ID to reset.
   */
  resetState(sessionID: string): void
  /**
   * Maps a session to its parent, falling back to the session itself when
   * no parent edge is known.
   * @param sessionID The (possibly undefined) session ID.
   * @returns The parent session ID, the session ID itself, or an empty
   *     string for nullish input.
   */
  parentOf(sessionID: string | undefined): string
  /**
   * Records a resolved child→parent edge.
   * @param sessionID The child session ID.
   * @param parentID The parent session ID.
   */
  setParent(sessionID: string, parentID: string): void
  /**
   * Overwrites the child's latest `VERDICT:` marker observation and its
   * provenance source label. Recording is verdict-kind only (only `VERDICT:`
   * markers are ever stored; never `GATE:`) and is unconditioned on agent
   * type: the plan gate is the sole consumer, and because attribution is
   * keyed by child ID this cannot leak a verdict to a different child or let
   * a GATE-only child suppress a plan-reviewer bare-output violation.
   * @param childID The child session ID.
   * @param marker The last `VERDICT:` marker observed in the child's text.
   * @param source Pipeline provenance label the marker was observed in.
   */
  recordChildVerdict(childID: string, marker: string, source: string): void
  /**
   * Returns the child's latest `VERDICT:` marker observation, or an empty
   * verdict ({ marker: "", source: "" }) when the child has none. Touches
   * the child to keep it most-recently-used (LRU).
   * @param childID The child session ID.
   * @returns The stored observation, or { marker: "", source: "" }.
   */
  childVerdict(childID: string): ChildVerdict
}

/**
 * Replays the journal's tail so completed `GATE: PASS` entries restore
 * gate state after a restart. Reads the last 2000 lines; skips malformed
 * lines. Only the *last* gate result per session decides the restored
 * state, mirroring the runtime latest-wins rule: a trailing `GATE: FAIL`
 * keeps the gate red. Fail-open. Both restore loops tag the bucket with
 * `replayGrace` — the one-prompt survival window for the first post-restart
 * prompt; both loops touch the same bucket object when a session has both a
 * gate and a plan result, so the tag is set once. A restored `hasPlanVerdict`
 * is trusted for exactly the current plans-dir state (no signature is journaled,
 * so it stamps an empty ""), which the grace prompt's executor dispatch accepts
 * once and re-stamps via reconcilePlanStamp — edits _after_ restart still
 * invalidate the restored approval.
 * @param states The session→state map to populate.
 * @param journalPath Absolute path of the JSONL journal to replay; the prior
 *     generation (`${journalPath}.1`) is read first so the 2000-line tail
 *     bound holds across both files. Exactly one generation deep — README:474
 *     keeps 5, but a 5-file replay would cost ~25 MB of boot I/O worst case,
 *     so one generation is replayed.
 */
function replayGatePasses(states: Map<string, GateState>, journalPath: string): void {
  try {
    // Read the rotated generation first (`.1`, older) then the current file,
    // oldest-first, so the slice(-2000) tail bound holds across both files.
    // Generations are time-ordered, so latest-wins still falls out naturally.
    const generations = [`${journalPath}.1`, journalPath].filter((p) => fs.existsSync(p))
    if (generations.length > 0) {
      const lines = generations.flatMap((p) =>
        fs.readFileSync(p, "utf8").split("\n").filter(Boolean),
      )
      const lastGateResult = new Map<string, string>()
      const lastPlanResult = new Map<string, string>()
      for (const line of lines.slice(-2000)) {
        try {
          const e = JSON.parse(line) as { type?: unknown; sessionID?: unknown; result?: unknown }
          if (e.type === "gate" && e.sessionID && (e.result === "PASS" || e.result === "FAIL")) {
            lastGateResult.set(e.sessionID as string, e.result)
          }
          if (
            e.type === "plan" &&
            e.sessionID &&
            (e.result === "APPROVE" || e.result === "BLOCK")
          ) {
            lastPlanResult.set(e.sessionID as string, e.result)
          }
        } catch {
          // skip malformed lines
        }
      }
      for (const [sessionID, result] of lastGateResult) {
        if (result !== "PASS") continue
        const s = states.get(sessionID) ?? newState()
        s.hasGatePass = true
        s.replayGrace = true
        states.set(sessionID, s)
      }
      for (const [sessionID, result] of lastPlanResult) {
        if (result !== "APPROVE") continue
        const s = states.get(sessionID) ?? newState()
        s.hasPlanVerdict = true
        s.replayGrace = true
        states.set(sessionID, s)
      }
    }
  } catch {
    // fail-open
  }
}

/**
 * Creates the gate ledger and replays prior gate passes from the journal.
 * Both session maps are LRU-capped at `maxSessions` (promote-on-touch);
 * beyond the cap the least-recently-used entry is evicted. A replayed bucket
 * evicted before its grace prompt loses the one-prompt survival (fail-toward-
 * strict); without the tag the next prompt is an ordinary full reset.
 * @param journalPath Absolute path of the JSONL journal to replay.
 * @param maxSessions LRU cap for tracked sessions (states + parent map).
 * @returns A ledger bound to a fresh in-memory session map.
 */
export function createLedger(journalPath: string, maxSessions: number = 64): GateLedger {
  const states = new Map<string, GateState>()
  const childToParent = new Map<string, string>()
  // Latest VERDICT marker observation per child session, LRU-capped and
  // promote-on-touch like the other session maps. Verdict-kind only, keyed by
  // child ID so it never leaks across children.
  const childVerdicts = new Map<string, ChildVerdict>()

  /**
   * Promotes a key to most-recently-used in an insertion-ordered map.
   * @param map The map to reorder.
   * @param key The key to touch (no-op when absent).
   */
  function promote<K, V>(map: Map<K, V>, key: K): void {
    const v = map.get(key)
    if (v !== undefined) {
      map.delete(key)
      map.set(key, v)
    }
  }

  /**
   * Evicts least-recently-used entries until the map is within the cap.
   * @param map The map to trim.
   */
  function cap<K, V>(map: Map<K, V>): void {
    while (map.size > maxSessions) {
      const oldest = map.keys().next()
      if (oldest.done) break
      map.delete(oldest.value)
    }
  }

  // Replay runs before capping so the restored set honors the LRU cap too.
  replayGatePasses(states, journalPath)
  cap(states)

  return {
    childToParent,
    state(sessionID: string): GateState {
      promote(states, sessionID)
      let s = states.get(sessionID)
      if (!s) {
        s = newState()
        states.set(sessionID, s)
        cap(states)
      }
      return s
    },
    resetState(sessionID: string): void {
      // delete+set keeps the LRU MRU position and the cap, as a plain reset.
      const prior = states.get(sessionID)
      states.delete(sessionID)
      states.set(sessionID, prior?.replayGrace ? mergeAfterReplay(prior) : newState())
      cap(states)
    },
    parentOf(sessionID: string | undefined): string {
      if (!sessionID) return ""
      const parent = childToParent.get(sessionID)
      if (parent !== undefined) {
        promote(childToParent, sessionID)
        return parent
      }
      return sessionID
    },
    setParent(sessionID: string, parentID: string): void {
      childToParent.set(sessionID, parentID)
      cap(childToParent)
    },
    recordChildVerdict(childID: string, marker: string, source: string): void {
      promote(childVerdicts, childID)
      childVerdicts.set(childID, { marker, source })
      cap(childVerdicts)
    },
    childVerdict(childID: string): ChildVerdict {
      promote(childVerdicts, childID)
      return childVerdicts.get(childID) ?? { marker: "", source: "" }
    },
  }
}
