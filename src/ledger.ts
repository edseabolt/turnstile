/**
 * @fileoverview Ledger boundary: the LRU-capped session maps behind the gate
 * bookkeeping — child→parent edges, the child verdict store, and live-parent
 * eviction protection — plus journal replay so a completed task's `GATE: PASS`
 * survives restarts. On a parent's prompt reset, also releases that parent's
 * registered children's metering counters. Pure bookkeeping; no enforcement
 * decisions here.
 */

import * as fs from "node:fs"

import type { ChildVerdict, GateState } from "./types.ts"
import { clearMeteringCounters, mergeAfterReplay, newState } from "./state.ts"

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
   * Returns the gate state for a session without creating one, for read-only
   * checks that must not insert a fresh bucket into the LRU (e.g. promotion
   * lookups for unknown bash sessions).
   * @param sessionID The session ID to look up.
   * @returns The session's mutable gate state, or `undefined` when none exists.
   */
  peek(sessionID: string): GateState | undefined
  /**
   * Resets a session's gate state for a new user prompt (a new prompt starts a
   * new task). The first prompt after a restart carries the journal-replayed
   * flags forward with a single-prompt grace (values, not provenance — a live
   * GATE: FAIL after replay is carried as false): `hasGatePass`,
   * `hasPlanVerdict`, `hasReviewApprove`, and its paired ensemble count
   * `reviewerDispatches`. Every later
   * prompt fully resets (fresh flags; `reviewRounds`/`plannerRounds`/
   * `planReviewerRounds`/`testRunnerRounds`/`totalDispatches`/`reads`/`seen`/
   * `seenFrom`/`suppressedPending` are always fresh). Fail-open: pure object map
   * operations.
   *
   * With continuation carry enabled, a continuation prompt (the same
   * worktree/branch — `taskFingerprint` unchanged) re-arms `replayGrace` on
   * the reset so the restart-sticky flags carry forward too: values, not
   * provenance, the same single-prompt grace the restart-resume path grants.
   * The carry is GATE-SCOPED — only an earned `hasGatePass` (paired with
   * `reviewerDispatches`) survives, so a continuation before any `GATE: PASS`
   * starts a clean cycle. `taskFingerprint` is stamped by setup after the
   * reset, so a fresh bucket starts empty and the next carry predicate keys
   * off the just-stamped identity.
   *
   * A new prompt also releases the session's registered children: their stored
   * verdict evidence is dropped and their metering counters are cleared (see
   * `clearMeteringCounters`), so a cap-exhausted child is re-dispatchable
   * after the parent's next prompt.
   * @param sessionID The parent session ID to reset.
   * @returns The number of registered child buckets whose metering counters
   *     were non-fresh before clearing (0 for a no-op release).
   */
  resetState(sessionID: string): number
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
   * Registers a session as a live parent so the `states` cap never evicts
   *  its bucket while it stays tracked. Registration is the
   *  eviction-protection signal; refreshed by every prompt, guarded
   *  dispatch, task delivery, edge resolution, and root-session event, so an
   *  active parent re-registers long before the registry's LRU churn can evict
   *  it (bounded by `maxTrackedParents`). No-op on an empty id.
   * @param sessionID The parent session ID.
   */
  markParent(sessionID: string): void
  /**
   * Whether a session is a currently-registered live parent (membership with
   *  LRU promotion — the registry is LRU by use).
   * @param sessionID The session ID to test.
   * @returns True when the session is a registered live parent.
   */
  isParent(sessionID: string): boolean
  /**
   * Returns the most-recently-admitted live parent (the MRU of the registry,
   * which `markParent` promotes to the end on), or "" when none is registered.
   * Used as a fallback when a compaction payload carries no `sessionID`: the
   * most-recently-active parent is otherwise unresolvable. Fail-open — the
   * registry is never mutated, so this reads without an LRU reorder.
   * @returns The last admitted parent session ID, or "" when the registry is empty.
   */
  lastParent(): string
  /**
   *
   * Overwrites the child's latest `VERDICT:` marker observation and its
   * provenance source label. Recording is verdict-kind only (only `VERDICT:`
   * markers are ever stored; never `GATE:`) and is conditioned on the caller
   * having emitter authority for the verdict kind (the authority decision lives
   * in the wiring layer — `src/setup.ts` — not here; the ledger itself stays
   * agent-agnostic). The plan gate is the sole consumer, and because
   * attribution is keyed by child ID this cannot leak a verdict to a different
   * child or let a GATE-only child suppress a plan-reviewer bare-output violation.
   *
   * Returns whether the stored observation actually changed (its `marker` or
   * `source` differed from the prior entry): the setup/store layer journals a
   * streamed verdict observation iff this is true, so per (child, marker,
   * source) first-sight journaling is owned here rather than by the parent
   * bucket's dedup set.
   * @param childID The child session ID.
   * @param marker The last `VERDICT:` marker observed in the child's text.
   * @param source Pipeline provenance label the marker was observed in.
   * @returns True when the stored `marker` or `source` changed; false on an
   *     identical re-record (a dedup hit for streamed sources).
   */
  recordChildVerdict(childID: string, marker: string, source: string): boolean
  /**
   /**
    * Returns the child's latest `VERDICT:` marker observation, or an empty
    * verdict (`{ marker: "", source: "", recordedAt: 0 }`) when the child has
    * none. Touches the child to keep it most-recently-used (LRU).
    * @param childID The child session ID.
    * @returns The stored observation, or the empty verdict default.
    */
  childVerdict(childID: string): ChildVerdict
  /**
   * Snapshot of children with a stored (non-empty) verdict, as
   * `{ child, verdict }` copies. Pure read — never promotes and never caps, so
   * it is safe to call from the attribution layer without disturbing the LRU
   * order (the plausibility scan reads, never writes).
   * @returns A new array of `{ child, verdict }` pairs with non-empty verdicts.
   */
  evidencedChildren(): Array<{ child: string; verdict: ChildVerdict }>
}

/**
 * Replays the journal's tail so completed `GATE: PASS` entries restore
 * gate state after a restart. Reads the last `tailLines` lines; skips
 * malformed lines. Only the *last flipping* gate result per session decides
 * the restored state, mirroring the runtime latest-wins rule (a trailing
 * `GATE: FAIL` keeps the gate red). Fail-open.
 *
 * A replayed green is journaled audited evidence, not runtime proof: the
 * flipping-entry filter skips enforce-mode `verified:false` PASSes (they
 * never flipped at runtime, so they must not restore), while flag-mode
 * `verified:false` PASSes restore green (they DID flip at runtime) and
 * field-less legacy PASSes restore (fail-open). `unverifiedPass` is never
 * restored here and is task-scoped like `seen`/`reads`: as a consequence, a
 * runtime `gate-unverified` block (unverified PASS awaiting evidence) can
 * become a `no-gate-pass` block after a restart — same enforcement strength,
 * different diagnostic message. Both restore loops
 * tag the bucket with `replayGrace` — the one-prompt survival window for the
 * first post-restart prompt; both loops touch the same bucket object when a
 * session has both a gate and a plan result, so the tag is set once. A plan
 * APPROVE entry may carry the bound identity fields `plan` (file name) and
 * `planKey` (that file's content hash); when present they restore
 * `approvedPlan`/`approvedPlanKey` (absent or non-string → unbound ""). It
 * may also carry `plansSig` (the plans-dir content signature stamped at
 * approval); when present it restores `plansSignature`, so a restored
 * unbound verdict is validated against the current dir like a live one — a
 * plan edited while the process was down drops it (`signature-mismatch`
 * STALE) instead of riding the accept-once window. A field-less or
 * non-string entry restores the empty stamp, which the grace prompt's
 * executor dispatch accepts once and re-stamps via reconcilePlanStamp —
 * edits _after_ restart still invalidate the restored approval. A
 * restored *bound* verdict is stricter than the unbound accept-once rule: it
 * is validated against the current files immediately on the next enforcing
 * dispatch (bound plan edited or removed → stale, no accept-once window).
 *
 * The reviewer-approval restore is refusal-suppressed: when the last counted
 * reviewer-ensemble entry for a session stamped `refusedApprove:true` (the
 * runtime refused to credit that APPROVE because fewer than two dispatches
 * were counted), replay does not restore `hasReviewApprove` — a refused credit
 * must not re-credit itself across a restart. An explicit clear on that last
 * entry (`refusedApprove:false`, a human grant) instead restores the flag so a
 * human release survives restart; an absent field lets a verdict through. The
 * ensemble count itself is always restored last-wins per session; a session
 * that also had a gate/plan verdict (or a clearing) restored keeps its
 * `replayGrace`, while an ensemble-only count line restores the bare count with
 * no grace and no one-prompt carry.
 * @param states The session→state map to populate.
 * @param journalPath Absolute path of the JSONL journal to replay; the prior
 *     generation (`${journalPath}.1`) is read first so the tail bound holds
 *     across both files. Exactly one generation is replayed — deliberately
 *     not following `journalMaxGenerations`, which sizes the write-side
 *     retention: replaying every kept generation would cost up to
 *     `journalMaxGenerations × journalMaxBytes` of boot I/O worst case.
 * @param tailLines Maximum number of combined journal lines replayed; older
 *     lines are dropped.
 */
function replayGatePasses(
  states: Map<string, GateState>,
  journalPath: string,
  tailLines: number,
): void {
  try {
    // Read the rotated generation first (`.1`, older) then the current file,
    // oldest-first, so the tail bound holds across both files. Generations are
    // time-ordered, so latest-wins still falls out naturally.
    const generations = [`${journalPath}.1`, journalPath].filter((p) => fs.existsSync(p))
    if (generations.length > 0) {
      const lines = generations.flatMap((p) =>
        fs.readFileSync(p, "utf8").split("\n").filter(Boolean),
      )
      const lastGateResult = new Map<string, string>()
      // The last flipping plan entry per session: the result, the bound
      // identity fields (plan/planKey) so a fielded APPROVE restores a bound
      // approval, and the journaled dir signature (plansSig) so a stamped
      // APPROVE restores its stamp; a field-less legacy line restores
      // unbound and unstamped.
      const lastPlanResult = new Map<
        string,
        { result: string; plan: unknown; planKey: unknown; sig: unknown }
      >()
      const lastReviewVerdict = new Map<string, string>()
      // The last ensemble entry per session. lastEnsemble is the restored
      // count; lastRefusedApprove records that entry's refusal state, which the
      // verdict loop consults to skip a refused APPROVE's restore and the
      // clearing loop consults to restore a human grant. All three maps are
      // last-wins over valid entries only.
      const lastEnsemble = new Map<string, number>()
      // Last explicit refusal state of the final ensemble entry for a session:
      // true (stamped refusedApprove:true), false (cleared by a human grant),
      // or absent from the map (no explicit stamp recorded, or the last valid
      // entry had no field — an ordinary dispatch). Absent entries delete so a
      // later dispatch un-stamps a prior refusal, matching the runtime rule.
      const lastRefusedApprove = new Map<string, boolean>()
      for (const line of lines.slice(-tailLines)) {
        try {
          const e = JSON.parse(line) as {
            type?: unknown
            sessionID?: unknown
            result?: unknown
            marker?: unknown
            source?: unknown
            verified?: unknown
            mode?: unknown
            count?: unknown
            refusedApprove?: unknown
            plan?: unknown
            planKey?: unknown
            plansSig?: unknown
          }
          if (e.type === "gate" && e.sessionID && (e.result === "PASS" || e.result === "FAIL")) {
            // Flipping-entry rule (map-fill, not the restore loop): an
            // enforce-mode unverified PASS never flips (nor did it at runtime),
            // so it is not recorded as the deciding last result. A flag-mode
            // verified:false PASS DID flip at runtime and restores green; a
            // legacy field-less PASS restores (fail-open, documented).
            if (e.result === "PASS" && e.verified === false && e.mode !== "flag") continue
            lastGateResult.set(e.sessionID as string, e.result)
          }
          if (
            e.type === "plan" &&
            e.sessionID &&
            (e.result === "APPROVE" || e.result === "BLOCK")
          ) {
            lastPlanResult.set(e.sessionID as string, {
              result: e.result,
              plan: e.plan,
              planKey: e.planKey,
              sig: e.plansSig,
            })
          }
          // Reviewer-APPROVE restore (landing gate): a `VERDICT:
          // APPROVE` verdict delivered on a task-result restores
          // hasReviewApprove with the same latest-flipping rule hasPlanVerdict
          // uses. Only `source:"task-result"` verdicts are credited — the
          // landing gate releases only on a delivery-attributed reviewer
          // verdict, so a verdict streamed in child text (`source:"child-*"`)
          // never restores the flag (this is how the invariant holds across a
          // restart too). A trailing `VERDICT: BLOCK` leaves the flag off (the recency
          // boundary is the last verdict, not task reset — a GATE: FAIL never
          // clears it).
          if (
            e.type === "verdict" &&
            e.sessionID &&
            typeof e.marker === "string" &&
            e.source === "task-result"
          ) {
            lastReviewVerdict.set(
              e.sessionID as string,
              e.marker.includes("APPROVE") ? "APPROVE" : "BLOCK",
            )
          }
          // The last counted ensemble entry per session: a non-negative integer
          // count on a known session, last-wins like the other three maps. The
          // same entry stamps lastRefusedApprove: an explicit refusal stamp, an
          // explicit human-grant clear, or (absent) a last-wins un-stamp, so the
          // verdict loop can skip a refused APPROVE's restore and the clearing
          // loop can restore a human grant.
          if (
            e.type === "ensemble" &&
            e.sessionID &&
            Number.isInteger(e.count) &&
            (e.count as number) >= 0
          ) {
            lastEnsemble.set(e.sessionID as string, e.count as number)
            if (e.refusedApprove === true) lastRefusedApprove.set(e.sessionID as string, true)
            else if (e.refusedApprove === false)
              lastRefusedApprove.set(e.sessionID as string, false)
            else lastRefusedApprove.delete(e.sessionID as string)
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
      for (const [sessionID, entry] of lastPlanResult) {
        if (entry.result !== "APPROVE") continue
        const s = states.get(sessionID) ?? newState()
        s.hasPlanVerdict = true
        s.replayGrace = true
        // Bound identity restores verbatim: a string field binds, anything
        // absent or non-string degrades to unbound "" (legacy lines replay
        // unchanged). A restored bound verdict is validated against the
        // current plans dir immediately on the next enforcing dispatch —
        // stricter than the unbound accept-once rule.
        s.approvedPlan = typeof entry.plan === "string" ? entry.plan : ""
        s.approvedPlanKey = typeof entry.planKey === "string" ? entry.planKey : ""
        // A restored unbound verdict flows into the existing signature check
        // instead of the accept-once arm; "" keeps legacy and unstampable
        // approvals on the documented accept-once path.
        s.plansSignature = typeof entry.sig === "string" ? entry.sig : ""
        states.set(sessionID, s)
      }
      for (const [sessionID, result] of lastReviewVerdict) {
        if (result !== "APPROVE") continue
        // A refused credit is stamped on the last ensemble entry for the
        // session; do not let replay re-credit that APPROVE on restart. An
        // explicit clear (refusedApprove:false) or an absent field both let the
        // verdict through — only an explicit refusal suppresses it.
        if (lastRefusedApprove.get(sessionID) === true) continue
        const s = states.get(sessionID) ?? newState()
        s.hasReviewApprove = true
        s.replayGrace = true
        states.set(sessionID, s)
      }
      // A human always-grant releases the landing gate by stamping the last
      // ensemble entry refusedApprove:false (a clear). Restore the flag so the
      // human release survives restart — independent of any verdict, since a
      // human release outranks the mechanical ensemble. A still-refused session
      // (last entry refusedApprove:true) falls through and is not re-credited.
      for (const [sessionID, refused] of lastRefusedApprove) {
        if (refused !== false) continue
        const s = states.get(sessionID) ?? newState()
        s.hasReviewApprove = true
        s.replayGrace = true
        states.set(sessionID, s)
      }
      // Restore the ensemble count. A session that also had a flag restored
      // already carries replayGrace from the loops above, so it survives the
      // grace prompt together with its count; an ensemble-only line restores
      // the bare count with no grace and no grace carry.
      for (const [sessionID, count] of lastEnsemble) {
        const s = states.get(sessionID) ?? newState()
        s.reviewerDispatches = count
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
 * Live parents register via `markParent` (per prompt, guarded dispatch, task
 * delivery, edge resolution, and root-session event). A registered parent is
 * never evicted from `states` while it stays in the bounded registry — leaked child buckets now only evict each other. Protection never
 * creates a bucket (minting is unchanged) and boot replay stays strict (the
 * registry is empty at replay, so the `replayGrace` loss behavior is
 * unchanged).
 * @param journalPath Absolute path of the JSONL journal to replay.
 * @param maxSessions LRU cap for tracked sessions (states + parent map).
 * @param replayTailLines Replay tail window in lines for the boot replay
 *     (see `replayGatePasses`).
 * @returns A ledger bound to a fresh in-memory session map.
 */
export function createLedger(
  journalPath: string,
  maxSessions: number,
  replayTailLines: number,
): GateLedger {
  const states = new Map<string, GateState>()
  const childToParent = new Map<string, string>()
  // Latest VERDICT marker observation per child session, LRU-capped and
  // promote-on-touch like the other session maps. Verdict-kind only, keyed by
  // child ID so it never leaks across children. A re-observation that changes
  // marker/source re-journals its verdict entry (the store is the dedup
  // ledger, not a deduplicator); eviction above maxSessions re-journals on a
  // later re-observation — bounded and acceptable, documented at recordChildVerdict.
  const childVerdicts = new Map<string, ChildVerdict>()
  // Sessions registered as live parents (orchestrator/primary). LRU-touched
  // like the other maps, bounded by `maxTrackedParents`; registration is the
  // eviction-protection signal for the `states` cap.
  const parents = new Map<string, true>()
  const maxTrackedParents = Math.max(256, maxSessions * 4) // mirrors maxTrackedLookups in hooks-core.ts

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
   * Evicts least-recently-used entries until the map is within the cap,
   * skipping any entry for which `protect` returns true. Scans insertion
   * order for the first unprotected entry; when every remaining entry is
   * protected, over-cap is tolerated (bounded by the registry bound).
   * @param map The map to trim.
   * @param protect Optional predicate on keys; a `true` result is never
   *     evicted from this map.
   */
  function cap<K, V>(map: Map<K, V>, protect?: (key: K) => boolean): void {
    while (map.size > maxSessions) {
      let evicted = false
      for (const key of map.keys()) {
        // Insertion order: the first unprotected entry is the victim.
        if (protect?.(key)) continue
        map.delete(key)
        evicted = true
        break
      }
      // Every remaining entry is protected; over-cap is tolerated (bounded by
      // the registry bound), so the scan-found-empty case stops the loop.
      if (!evicted) break
    }
  }

  /**
   * Registers a session as a live parent: keep it MRU — promote +
   * re-set — so an active parent re-registers long before the registry's LRU
   * churn can evict it. No-op on an empty id. Bounded by `maxTrackedParents`.
   * @param sessionID The parent session ID.
   */
  function markParent(sessionID: string): void {
    if (!sessionID) return
    promote(parents, sessionID)
    parents.set(sessionID, true)
    while (parents.size > maxTrackedParents) {
      // The loop condition guarantees a first entry exists.
      const oldest = parents.keys().next().value as string
      parents.delete(oldest)
    }
  }

  /**
   * Whether a session is a currently-registered live parent, with LRU
   * promotion (the registry is LRU by use).
   * @param sessionID The session ID to test.
   * @returns True when the session is a registered live parent.
   */
  function isParent(sessionID: string): boolean {
    const known = parents.get(sessionID) === true
    if (known) promote(parents, sessionID)
    return known
  }

  /**
   * Returns the most-recently-admitted live parent: the registry map is
   * MRU-ordered (markParent promotes the key to the end on every admission),
   * so the last key is the most-recently-admitted parent. "" when the registry
   * is empty. Pure read — no LRU promotion — so a fallback lookup never
   * disturbs the registry ordering.
   * @returns The last admitted parent session ID, or "" when empty.
   */
  function lastParent(): string {
    let last = ""
    for (const p of parents.keys()) last = p
    return last
  }

  /**
   * Drops a parent's registered children's verdict evidence and clears their
   * metering counters when the parent starts a new task. Scoped to the
   * registered children of `sessionID` only, so a concurrent task on another
   * parent keeps its own child-verdict evidence and counters intact. A child
   * whose edge is registered but whose state bucket was never minted is
   * skipped (the edge can precede the child's first metered dispatch). Earned
   * credit on each child's bucket is preserved — only the counters that block
   * re-dispatch are cleared.
   * @param sessionID The parent session ID whose new task triggers the release.
   * @returns The number of child buckets whose metering counters were
   *     non-fresh before clearing (0 for a pure no-op release).
   */
  function releaseChildren(sessionID: string): number {
    let freed = 0
    for (const c of childToParent.keys()) {
      if (childToParent.get(c) !== sessionID) continue
      childVerdicts.delete(c)
      const cs = states.get(c)
      if (cs && clearMeteringCounters(cs)) freed++
    }
    return freed
  }

  // Replay runs before capping so the restored set honors the LRU cap too.
  replayGatePasses(states, journalPath, replayTailLines)
  cap(states, isParent)

  return {
    childToParent,
    markParent,
    isParent,
    lastParent,
    state(sessionID: string): GateState {
      promote(states, sessionID)
      let s = states.get(sessionID)
      if (!s) {
        s = newState()
        states.set(sessionID, s)
        cap(states, isParent)
      }
      return s
    },
    peek(sessionID: string): GateState | undefined {
      // Pure read: no insertion, no LRU reorder.
      return states.get(sessionID)
    },
    resetState(sessionID: string): number {
      // delete+set keeps the LRU MRU position and the cap, as a plain reset.
      const prior = states.get(sessionID)
      states.delete(sessionID)
      states.set(sessionID, prior?.replayGrace ? mergeAfterReplay(prior) : newState())
      cap(states, isParent)
      // A new prompt also releases this parent's registered children: their
      // verdict evidence is dropped and their metering counters cleared, so a
      // marker-less re-fire can never re-attribute against a stale streamed
      // APPROVE and a cap-exhausted child is re-dispatchable. Unresolved
      // children (no registered edge) keep their verdicts by design — the
      // timestamp join keeps a previous task's streamed APPROVE from approving
      // the next task.
      return releaseChildren(sessionID)
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
      // Edge resolution marks the parent live: its `states` bucket
      // is now protected from eviction until an unrelated parent churn evicts
      // this registration from the registry.
      markParent(parentID)
    },
    recordChildVerdict(childID: string, marker: string, source: string): boolean {
      // changed = the marker or source actually moved; the setup layer journals
      // a streamed verdict observation iff this is true (per (child, marker,
      // source) first-sight dedup). LRU promotion + cap are unchanged; the
      // recordedAt stamp refreshes on every re-observation (the plausibility
      // join keeps a verdict plausible while its parent's task is live).
      const prev = childVerdicts.get(childID) ?? { marker: "", source: "", recordedAt: 0 }
      const changed = prev.marker !== marker || prev.source !== source
      promote(childVerdicts, childID)
      childVerdicts.set(childID, { marker, source, recordedAt: Date.now() })
      cap(childVerdicts)
      return changed
    },
    childVerdict(childID: string): ChildVerdict {
      promote(childVerdicts, childID)
      return childVerdicts.get(childID) ?? { marker: "", source: "", recordedAt: 0 }
    },
    // Snapshot only: no LRU promotion, no cap (pure read for the attribution
    // scan). Returns copies so callers cannot mutate the store in place.
    evidencedChildren(): Array<{ child: string; verdict: ChildVerdict }> {
      const out: Array<{ child: string; verdict: ChildVerdict }> = []
      for (const [child, v] of childVerdicts)
        if (v.marker !== "") out.push({ child, verdict: { ...v } })
      return out
    },
  }
}
