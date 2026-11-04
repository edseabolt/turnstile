/**
 * @fileoverview The ledger's parent-edge registry and credit trace: the
 * child→parent edge maps (with their journaling, re-seed, and child-release
 * concerns), the live-parent registry that protects `states` buckets from
 * LRU eviction, and the bucket-free credit-bearing reviewer APPROVE trace.
 * Extracted from `src/ledger.ts`'s `createLedger` factory; the shared LRU
 * primitives (`promote`, `cap`) live here too so every ledger concern
 * composes the same eviction discipline. Pure in-memory maps plus fail-open
 * journal appends (`appendLine` never throws).
 */

import { evictTo } from "./bounded.ts"
import type { ChildVerdict, GateState } from "./types.ts"
import { appendLine, now } from "./journal.ts"
import { clearMeteringCounters } from "./state.ts"

/**
 * Promotes a key to most-recently-used in an insertion-ordered map.
 * @param map The map to reorder.
 * @param key The key to touch (no-op when absent).
 */
export function promote<K, V>(map: Map<K, V>, key: K): void {
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
 * @param maxSessions The LRU cap (the configured session bound).
 * @param protect Optional predicate on keys; a `true` result is never
 *     evicted from this map.
 */
export function cap<K, V>(
  map: Map<K, V>,
  maxSessions: number,
  protect?: (key: K) => boolean,
): void {
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
 * The read-write maps and bounds one registry instance owns. The `states`
 * and `childVerdicts` maps are created by the ledger factory and shared with
 * the other concern stores; the registry owns the edge maps and the
 * live-parent registry itself.
 */
export interface LedgerRegistryDeps {
  /** The LRU cap for the session-keyed maps (the configured session bound). */
  maxSessions: number
  /** The live-parent registry bound (4× the states cap, floored at 256). */
  maxTrackedParents: number
  /** The journal path the `child-edge` rows append to. */
  journalPath: string
  /** The session bucket map, read by the child-release sweep. */
  states: Map<string, GateState>
  /** The child-verdict store, cleared by the child-release sweep. */
  childVerdicts: Map<string, ChildVerdict>
}

/**
 * The parent-edge registry capability: the edge maps plus the registration,
 * lookup, journaling, re-seed, and child-release operations.
 */
export interface LedgerRegistry {
  /** Child→parent session-ID mapping; readable for membership checks. */
  childToParent: Map<string, string>
  /**
   * Child→parent edges restored by the boot replay's `child-edge` fold,
   * pending the setup re-seed (`reseedEdges` applies them without journaling).
   */
  reseededEdges: Map<string, { parent: string; agent: string }>
  /** Registers a session as a live parent (MRU, bounded). */
  markParent(sessionID: string): void
  /** Whether a session is a currently-registered live parent (LRU by use). */
  isParent(sessionID: string): boolean
  /** The most-recently-admitted live parent, or "" when empty (pure read). */
  lastParent(): string
  /** Maps a session to its parent, falling back to the session itself. */
  parentOf(sessionID: string | undefined): string
  /** Records a resolved child→parent edge, journaling new-or-changed ones. */
  setParent(sessionID: string, parentID: string, agent?: string): void
  /** Re-applies the replay-restored edges without journaling. */
  reseedEdges(): Array<{ child: string; parent: string; agent: string }>
  /** Drops the registered children's verdict evidence and clears counters. */
  releaseChildren(sessionID: string): number
}

/**
 * Journals one `child-edge` row for a new-or-changed edge: the data the
 * setup re-seed replays after a plugin reload wipes the in-memory map. The
 * journaled agent feeds the post-reload emitter re-seed, so it must never be
 * frozen empty; an empty agent omits the field. Fail-open (`appendLine`
 * never throws).
 * @param journalPath The journal path to append to.
 * @param sessionID The child session ID.
 * @param parentID The parent session ID.
 * @param agent The child's resolved emitter agent name, or "" when
 *     unresolved (the journaled row then omits the field).
 */
function journalChildEdge(
  journalPath: string,
  sessionID: string,
  parentID: string,
  agent: string,
): void {
  appendLine(
    journalPath,
    JSON.stringify({
      ts: now(),
      type: "child-edge",
      sessionID,
      parent: parentID,
      ...(agent ? { agent } : {}),
    }),
  )
}

/**
 * The mutable state one registry instance owns: the shared deps plus the
 * edge maps and the live-parent registry it creates.
 */
interface RegistryState {
  /** The LRU cap for the session-keyed maps. */
  maxSessions: number
  /** The live-parent registry bound (4× the states cap, floored at 256). */
  maxTrackedParents: number
  /** The journal path the `child-edge` rows append to. */
  journalPath: string
  /** The session bucket map, read by the child-release sweep. */
  states: Map<string, GateState>
  /** The child-verdict store, cleared by the child-release sweep. */
  childVerdicts: Map<string, ChildVerdict>
  /** Child→parent session-ID mapping. */
  childToParent: Map<string, string>
  /** The emitter agent last journaled per child edge (parallel map). */
  edgeAgents: Map<string, string>
  /** Edges restored by the boot replay, pending the setup re-seed. */
  reseededEdges: Map<string, { parent: string; agent: string }>
  /** Sessions registered as live parents (the eviction-protection signal). */
  parents: Map<string, true>
}

/**
 * Registers a session as a live parent: keep it MRU — promote +
 * re-set — so an active parent re-registers long before the registry's LRU
 * churn can evict it. No-op on an empty id. Bounded by `maxTrackedParents`.
 * @param st The registry state.
 * @param sessionID The parent session ID.
 */
function registryMarkParent(st: RegistryState, sessionID: string): void {
  if (!sessionID) return
  promote(st.parents, sessionID)
  st.parents.set(sessionID, true)
  evictTo(st.parents, st.maxTrackedParents)
}

/**
 * Whether a session is a currently-registered live parent, with LRU
 * promotion (the registry is LRU by use).
 * @param st The registry state.
 * @param sessionID The session ID to test.
 * @returns True when the session is a registered live parent.
 */
function registryIsParent(st: RegistryState, sessionID: string): boolean {
  const known = st.parents.get(sessionID) === true
  if (known) promote(st.parents, sessionID)
  return known
}

/**
 * Returns the most-recently-admitted live parent: the registry map is
 * MRU-ordered (markParent promotes the key to the end on every admission),
 * so the last key is the most-recently-admitted parent. "" when the registry
 * is empty. Pure read — no LRU promotion — so a fallback lookup never
 * disturbs the registry ordering.
 * @param st The registry state.
 * @returns The last admitted parent session ID, or "" when empty.
 */
function registryLastParent(st: RegistryState): string {
  let last = ""
  for (const p of st.parents.keys()) last = p
  return last
}

/**
 * Maps a session to its parent, falling back to the session itself when
 * no parent edge is known, with LRU promotion on a hit.
 * @param st The registry state.
 * @param sessionID The (possibly undefined) session ID.
 * @returns The parent session ID, the session ID itself, or an empty
 *     string for nullish input.
 */
function registryParentOf(st: RegistryState, sessionID: string | undefined): string {
  if (!sessionID) return ""
  const parent = st.childToParent.get(sessionID)
  if (parent !== undefined) {
    promote(st.childToParent, sessionID)
    return parent
  }
  return sessionID
}

/**
 * Records a resolved child→parent edge. The edge is journaled as a
 * `child-edge` row (carrying the child's resolved emitter agent when one
 * is supplied) whenever it is new or changed — the data the setup re-seed
 * replays after a plugin reload wipes the in-memory map. An
 * unchanged re-set is silent (idempotent registrations stay journaled
 * once). An agent upgrade (a previously agent-less row gaining a resolved
 * agent, or an agent change) re-journals — the journaled agent feeds the
 * post-reload emitter re-seed, so it must never be frozen empty; an empty
 * agent never downgrades a journaled one. Both IDs and the optional agent
 * must already be validated by the caller; journaling is fail-open
 * (`appendLine` never throws).
 * @param st The registry state.
 * @param sessionID The child session ID.
 * @param parentID The parent session ID.
 * @param agent The child's resolved emitter agent name, or "" when
 *     unresolved (the journaled row then omits the field).
 */
function registrySetParent(
  st: RegistryState,
  sessionID: string,
  parentID: string,
  agent: string,
): void {
  // Journal only a new-or-changed edge: idempotent registrations
  // (session.created plus resolveParent both firing) stay journaled once.
  // An agent upgrade (a previously agent-less row gaining the resolved
  // emitter agent) counts as changed — the journaled agent feeds the
  // post-reload emitter re-seed, so an empty agent must not be frozen in.
  // The journaled agent is tracked in a parallel map (same cap) because
  // childToParent stores the parent only; a downgrade is never a change.
  const changed =
    st.childToParent.get(sessionID) !== parentID ||
    (agent !== "" && st.edgeAgents.get(sessionID) !== agent)
  st.childToParent.set(sessionID, parentID)
  cap(st.childToParent, st.maxSessions)
  if (changed) st.edgeAgents.set(sessionID, agent)
  cap(st.edgeAgents, st.maxSessions)
  if (changed) journalChildEdge(st.journalPath, sessionID, parentID, agent)
  // Edge resolution marks the parent live: its `states` bucket
  // is now protected from eviction until an unrelated parent churn evicts
  // this registration from the registry.
  registryMarkParent(st, parentID)
}

/**
 * Re-applies the child→parent edges restored by the boot replay's
 * `child-edge` fold (last-wins per child over the replay tail), rebuilding
 * the in-memory map after a plugin reload without journaling (a re-seed
 * must not re-append the rows it just folded, or every restart would grow
 * the journal and re-reseed forever). Each restored edge marks its parent
 * live and is LRU-capped like a live registration.
 * @param st The registry state.
 * @returns The restored edges as `{ child, parent, agent }` records, in
 *     replay order; empty when the tail held no `child-edge` rows.
 */
function registryReseedEdges(
  st: RegistryState,
): Array<{ child: string; parent: string; agent: string }> {
  const out: Array<{ child: string; parent: string; agent: string }> = []
  for (const [child, edge] of st.reseededEdges) {
    st.childToParent.set(child, edge.parent)
    cap(st.childToParent, st.maxSessions)
    registryMarkParent(st, edge.parent)
    out.push({ child, parent: edge.parent, agent: edge.agent })
  }
  return out
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
 * @param st The registry state.
 * @param sessionID The parent session ID whose new task triggers the release.
 * @returns The number of child buckets whose metering counters were
 *     non-fresh before clearing (0 for a pure no-op release).
 */
function registryReleaseChildren(st: RegistryState, sessionID: string): number {
  let freed = 0
  for (const c of st.childToParent.keys()) {
    if (st.childToParent.get(c) !== sessionID) continue
    st.childVerdicts.delete(c)
    const cs = st.states.get(c)
    if (cs && clearMeteringCounters(cs)) freed++
  }
  return freed
}

/**
 * Builds the parent-edge registry: the child→parent edge maps, the
 * live-parent registry, and their operations. The edge maps are LRU-capped
 * at `maxSessions`; the live-parent registry at `maxTrackedParents`. The
 * bodies live at module level; the factory only builds the state object.
 * @param deps The maps and bounds the registry shares with the ledger.
 * @returns The registry capability (see {@link LedgerRegistry}).
 */
export function createLedgerRegistry(deps: LedgerRegistryDeps): LedgerRegistry {
  const st: RegistryState = {
    ...deps,
    childToParent: new Map(),
    edgeAgents: new Map(),
    reseededEdges: new Map(),
    parents: new Map(),
  }
  return {
    childToParent: st.childToParent,
    reseededEdges: st.reseededEdges,
    markParent: (sessionID) => registryMarkParent(st, sessionID),
    isParent: (sessionID) => registryIsParent(st, sessionID),
    lastParent: () => registryLastParent(st),
    parentOf: (sessionID) => registryParentOf(st, sessionID),
    setParent: (sessionID, parentID, agent = "") =>
      registrySetParent(st, sessionID, parentID, agent),
    reseedEdges: () => registryReseedEdges(st),
    releaseChildren: (sessionID) => registryReleaseChildren(st, sessionID),
  }
}

/**
 * The bounds one credit-trace instance owns.
 */
export interface CreditTraceDeps {
  /** The LRU cap for the trace (the configured session bound). */
  maxSessions: number
}

/**
 * The credit-trace capability: the bucket-free provenance map plus its mark
 * and probe operations.
 */
export interface CreditTrace {
  /**
   * Credit-bearing reviewer APPROVE provenance (parent session → mark stamp).
   * Bucket-free and LRU-capped at `maxSessions`: the `hasReviewApprove` flag
   * lives on the session bucket (rebuilt by a task-scope reset), but the
   * journal-recorded credit outlives that reset, so the ledger carries this
   * provenance outside the bucket to drive the landing gate's escalation.
   * Refusal-stamped credits are never marked (replay honors the stamp before
   * the mark). No eviction protection: an evicted trace just falls back to
   * the ordinary first-block (fail-toward-strict, matching the other maps).
   */
  creditedApprovals: Map<string, number>
  /** Marks a parent session's reviewer APPROVE as credit-bearing. */
  markCreditedApproval(sessionID: string): void
  /** Whether a parent session carries a credit-bearing APPROVE mark. */
  hasCreditedApproval(sessionID: string): boolean
}

/**
 * The mutable state one credit-trace instance owns: the LRU cap and the
 * provenance map.
 */
interface CreditTraceState {
  /** The LRU cap for the trace (the configured session bound). */
  maxSessions: number
  /**
   * Credit-bearing reviewer APPROVE provenance (parent session → mark stamp).
   * Bucket-free and LRU-capped at `maxSessions`: the `hasReviewApprove` flag
   * lives on the session bucket (rebuilt by a task-scope reset), but the
   * journal-recorded credit outlives that reset, so the ledger carries this
   * provenance outside the bucket to drive the landing gate's escalation.
   * Refusal-stamped credits are never marked (replay honors the stamp before
   * the mark). No eviction protection: an evicted trace just falls back to
   * the ordinary first-block (fail-toward-strict, matching the other maps).
   */
  creditedApprovals: Map<string, number>
}

/**
 * Marks a parent session's reviewer APPROVE as credit-bearing on the
 * bucket-free trace (see the interface doc). The `hasReviewApprove` flag is
 * dropped by a task-scope reset but the journaled credit outlives it, so the
 * ledger keeps this provenance outside the bucket; it is what the landing
 * gate reads to escalate a credited session's first push. Re-marks refresh
 * the stamp (idempotent).
 * @param st The credit-trace state.
 * @param sessionID The parent session ID the credit is bound to.
 */
function markCreditedApprovalIn(st: CreditTraceState, sessionID: string): void {
  st.creditedApprovals.set(sessionID, Date.now())
  promote(st.creditedApprovals, sessionID)
  cap(st.creditedApprovals, st.maxSessions)
}

/**
 * Whether a parent session carries a credit-bearing reviewer APPROVE mark
 * (see the interface doc), with LRU promotion (the trace is LRU by use).
 * Refusal-stamped credits are never marked, so this reports the journaled
 * provenance, not the live bucket flag.
 * @param st The credit-trace state.
 * @param sessionID The parent session ID to test.
 * @returns True when the session carries an earned credit mark.
 */
function hasCreditedApprovalIn(st: CreditTraceState, sessionID: string): boolean {
  if (!st.creditedApprovals.has(sessionID)) return false
  promote(st.creditedApprovals, sessionID)
  return true
}

/**
 * Builds the bucket-free credit-bearing reviewer APPROVE trace. The map is
 * LRU-capped at `maxSessions` with no eviction protection (an evicted trace
 * falls back to the ordinary first-block, fail-toward-strict). The bodies
 * live at module level; the factory only builds the state object.
 * @param deps The bounds the trace shares with the ledger.
 * @returns The credit-trace capability (see {@link CreditTrace}).
 */
export function createCreditTrace(deps: CreditTraceDeps): CreditTrace {
  const st: CreditTraceState = { maxSessions: deps.maxSessions, creditedApprovals: new Map() }
  return {
    creditedApprovals: st.creditedApprovals,
    markCreditedApproval: (sessionID) => markCreditedApprovalIn(st, sessionID),
    hasCreditedApproval: (sessionID) => hasCreditedApprovalIn(st, sessionID),
  }
}
