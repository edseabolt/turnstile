/**
 * @fileoverview State boundary: per-session gate state, the child→parent
 * session mapping, and journal replay so a completed task's `GATE: PASS`
 * survives restarts. Pure bookkeeping — no enforcement decisions here.
 */

import * as fs from "node:fs"

import type { GateState } from "./types.ts"

/**
 * Creates a fresh gate state bucket for one parent session.
 * @returns An empty GateState with an empty marker-dedup set.
 */
export function newState(): GateState {
  return {
    hasGatePass: false,
    verdicts: [],
    reviewRounds: 0,
    reads: 0,
    seen: new Set(),
  }
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
   * Replaces the gate state for a session with a fresh bucket. Used on
   * each new user prompt: a new prompt starts a new task.
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
}

/**
 * Replays the journal's tail so completed `GATE: PASS` entries restore
 * gate state after a restart. Reads the last 2000 lines; skips malformed
 * lines. Only the *last* gate result per session decides the restored
 * state, mirroring the runtime latest-wins rule: a trailing `GATE: FAIL`
 * keeps the gate red. Fail-open.
 * @param states The session→state map to populate.
 * @param journalPath Absolute path of the JSONL journal to replay.
 */
function replayGatePasses(states: Map<string, GateState>, journalPath: string): void {
  try {
    if (fs.existsSync(journalPath)) {
      const lines = fs.readFileSync(journalPath, "utf8").split("\n").filter(Boolean)
      const lastGateResult = new Map<string, string>()
      for (const line of lines.slice(-2000)) {
        try {
          const e = JSON.parse(line) as { type?: unknown; sessionID?: unknown; result?: unknown }
          if (e.type === "gate" && e.sessionID && (e.result === "PASS" || e.result === "FAIL")) {
            lastGateResult.set(e.sessionID as string, e.result)
          }
        } catch {
          // skip malformed lines
        }
      }
      for (const [sessionID, result] of lastGateResult) {
        if (result !== "PASS") continue
        const s = states.get(sessionID) ?? newState()
        s.hasGatePass = true
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
 * beyond the cap the least-recently-used entry is evicted.
 * @param journalPath Absolute path of the JSONL journal to replay.
 * @param maxSessions LRU cap for tracked sessions (states + parent map).
 * @returns A ledger bound to a fresh in-memory session map.
 */
export function createLedger(journalPath: string, maxSessions: number = 64): GateLedger {
  const states = new Map<string, GateState>()
  const childToParent = new Map<string, string>()

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
      states.delete(sessionID)
      states.set(sessionID, newState())
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
  }
}
