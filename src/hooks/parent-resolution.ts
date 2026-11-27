/**
 * @fileoverview Parent-resolution concern: resolving a child session's
 * parent edge and project directory through the host session API (with
 * negative caching and bounded retries), the emitter-authority cache that
 * decides marker authority, and the boot re-seed that rebuilds both from
 * the journal after a plugin reload. Extracted from `src/hooks-core.ts`;
 * the shared per-setup state is threaded as one typed state object. Every
 * lookup failure is fail-open (retryable, journaled only where the contract
 * says so).
 */

import type { Journaler } from "./journal.ts"
import type { GateLedger } from "./ledger.ts"
import type { Host, SessionRecord, TurnstileConfig } from "./types.ts"
import { AGENT_KEYS, DIRECTORY_KEYS, PARENT_KEYS, readRecordString } from "./delivery.ts"
import { evictTo } from "./bounded.ts"
import { resolveChildStatus } from "./child-registration.ts"
import type { ToolPolicy } from "./tool-policy.ts"

/**
 * The state the parent-resolution concern reads and mutates: the shared
 * deps, the maps it owns, and the cross-concern helper it delegates to.
 */
export interface ParentResolutionState {
  /** The resolved plugin configuration. */
  config: TurnstileConfig
  /** The telemetry journal writer. */
  journaler: Journaler
  /** The gate-state ledger (edge map + re-seed + registration reads). */
  ledger: GateLedger
  /** Dispatchable agent names (the child-status exclusion set). */
  subagentNames: Set<string>
  /** The host session API holder, bound at setup time. */
  hostSessionRef: { current: Host["session"] | undefined }
  /** Child session ID → resolved agent name (emitter authority). */
  sessionAgents: Map<string, string>
  /** Cap on tracked emitter-authority entries. */
  maxTrackedEmitters: number
  /** Failed parent-lookup attempts, keyed by child session ID. */
  failedLookups: Map<string, { attempts: number; reason: string }>
  /** Max parent-lookup retries per session. */
  maxLookupAttempts: number
  /** Cap on tracked failed-lookup sessions. */
  maxTrackedLookups: number
  /** Lookup reason: host session.get threw (retryable). */
  lookupReasonNotVisible: string
  /** Lookup reason: record exists but has no parent edge. */
  lookupReasonNoParentId: string
  /** Last-known project directory per session. */
  sessionDirs: Map<string, string>
  /** Cap on tracked per-session project directories. */
  maxTrackedSessionDirs: number
  /** Tool policy (session-move telemetry). */
  toolPolicy: ToolPolicy
  /** Re-evaluates evidence correlation for a parent with a pending PASS. */
  promoteOnEvidence(parent: string): void
}

/**
 * Bounds the failed-lookup map by evicting its oldest entries.
 * @param st The parent-resolution state.
 */
function boundLookupsBody(st: ParentResolutionState): void {
  evictTo(st.failedLookups, st.maxTrackedLookups)
}

/**
 * Bounds the session-directory map by evicting its oldest entries.
 * @param st The parent-resolution state.
 */
function boundSessionDirsBody(st: ParentResolutionState): void {
  evictTo(st.sessionDirs, st.maxTrackedSessionDirs)
}

/**
 * Bounds the emitter-authority cache by evicting its oldest entries.
 * @param st The parent-resolution state.
 */
function boundSessionAgentsBody(st: ParentResolutionState): void {
  evictTo(st.sessionAgents, st.maxTrackedEmitters)
}

/**
 * Seeds (or refreshes) a child session's emitter agent. No-op when either
 * argument is empty, so an unresolved record read ("") never clobbers a
 * known agent. `markerKindAllowed` reads the cache lazily at parse time, so
 * a seed arriving before the marker's parse still applies.
 * @param st The parent-resolution state.
 * @param sessionID The child session ID.
 * @param agent The resolved agent name, or "" when unresolved.
 */
function seedEmitterBody(st: ParentResolutionState, sessionID: string, agent: string): void {
  if (sessionID && agent) {
    st.sessionAgents.set(sessionID, agent)
    boundSessionAgentsBody(st)
  }
}

/**
 * Rebuilds the post-reload child state from the journal tail (post-reload
 * defense
 * in depth): the ledger re-applies the journaled `child-edge` rows to
 * `childToParent` (a live executor/test-runner child is no longer gated as
 * a parent on its next write after a plugin setup re-fire), the
 * emitter-authority cache is re-seeded from each edge's journaled agent
 * (one entry covers both re-seeds), and one `reseed` row records the
 * edges-restored count so a post-reload parent-hands-on block is
 * diagnosable as a re-seed failure, not a gate malfunction. Fail-open: a
 * throwing re-seed journals an error and reports 0.
 * @param st The parent-resolution state.
 * @returns The number of child edges restored.
 */
function reseedChildEdgesBody(st: ParentResolutionState): number {
  try {
    const edges = st.ledger.reseedEdges()
    for (const edge of edges) seedEmitterBody(st, edge.child, edge.agent)
    st.journaler.journal({ type: "reseed", edges: edges.length })
    return edges.length
  } catch (e) {
    st.journaler.journal({ type: "error", error: `reseed: ${e}` })
    return 0
  }
}

/**
 * Reads the emitter-authority cache for a session: the resolved agent
 * name, or "" when the session's agent was never resolved. Pure read
 * (no LRU promotion); the delivery layer consults it as the fallback for
 * a delivery whose dispatch input names no agent, and the authority gate
 * and the suppressed-credit journal read it for the same decision.
 * @param st The parent-resolution state.
 * @param sessionID The session ID to read.
 * @returns The resolved agent name, or "" when unresolved.
 */
function emitterAgentBody(st: ParentResolutionState, sessionID: string): string {
  return st.sessionAgents.get(sessionID) ?? ""
}

/**
 * Resolves a tool event session's registration status through the
 * child-registration boundary: a non-empty event agent name in the
 * configured pipeline set is authoritative (edge or not — parents never
 * carry a subagent agent name); otherwise the child→parent edge plus the
 * emitter-authority fallback decides; anything unresolved is `"unknown"`
 * and gates like a parent (fail closed). Supersedes the former
 * edge-required check, so a generic-subagent dispatch or a child whose
 * edge was lost to a reload still exempts from its name.
 * @param st The parent-resolution state.
 * @param sid The tool event's session ID.
 * @param agent The resolved agent name candidate from the event ("" when none).
 * @returns The session's registration status at this boundary.
 */
function childStatusBody(
  st: ParentResolutionState,
  sid: string,
  agent: string,
): "child" | "parent" | "unknown" {
  return resolveChildStatus(sid, agent, st.ledger, st.subagentNames, (id) =>
    emitterAgentBody(st, id),
  )
}

/**
 * Emits a predicate answering whether a gate/verdict kind is authoritative
 * for a session's emitter agent. A gate flips only for `test-runner`; a
 * verdict only for `reviewer`/`plan-reviewer` — each also required to be in
 * `bareOutput` (the aggregated marker-contracted set). Unseeded or unknown
 * agents are denied: text observation mutates only for contracted emitters,
 * and a legitimate child's markers always land authoritatively at
 * `execute.after` delivery, which seeds the agent from dispatch input.
 * @param st The parent-resolution state.
 * @param sessionID The emitting session ID.
 * @returns A per-kind authority predicate.
 */
function markerKindAllowedBody(
  st: ParentResolutionState,
  sessionID: string,
): (kind: "gate" | "verdict") => boolean {
  const agent = emitterAgentBody(st, sessionID)
  return (kind) => {
    if (agent === "" || !st.config.agents.bareOutput.includes(agent)) return false
    if (kind === "gate") return agent === st.config.agents.testRunner
    return agent === st.config.agents.reviewer || agent === st.config.agents.planReviewer
  }
}

/**
 * Returns the last-known project directory for a session: the per-session
 * cache (resolved via `session.get`), else `process.cwd()`. Called by the
 * synchronous consumers (evaluate, continuation carry); each reads at most
 * one dispatch behind a move, which converges once the next
 * `execute.before` re-resolves.
 * @param st The parent-resolution state.
 * @param sessionID The session whose directory is read.
 * @returns The last-known project directory.
 */
function currentProjectDirBody(st: ParentResolutionState, sessionID: string): string {
  return st.sessionDirs.get(sessionID) ?? process.cwd()
}

/**
 * Resolves the project directory for a dispatch from the host's session
 * record, caching the result per session so the sync consumers can read it.
 * A fresh `session.get` is awaited and its directory wins; on an absent API,
 * a thrown lookup, or a record with no directory candidate the resolver
 * falls back to the cache then `process.cwd()`, journaling nothing
 * (fail-open; the exact `type:"error"` counts in the open-suite must stay
 * stable). One journal exception: when the resolved directory differs from
 * this session's cached one, a `session_move` telemetry entry
 * (`reason:"re-resolved"`) is written — a move the `session_move` tool hook
 * did not witness — so an enforced project switch is never silent.
 * @param st The parent-resolution state.
 * @param sessionID The dispatching session to resolve.
 * @returns The resolved (or fallback) project directory.
 */
async function resolveProjectDirBody(
  st: ParentResolutionState,
  sessionID: string,
): Promise<string> {
  const get = st.hostSessionRef.current?.get
  if (typeof get !== "function") return currentProjectDirBody(st, sessionID)
  let rec: SessionRecord | undefined
  try {
    rec = await get({ sessionID })
  } catch {
    // lookup failure: retryable; fall back to the cache then process.cwd().
    return currentProjectDirBody(st, sessionID)
  }
  const dir = readRecordString(rec, DIRECTORY_KEYS)
  if (dir !== "") {
    const prior = st.sessionDirs.get(sessionID)
    if (prior !== undefined && prior !== dir) {
      st.toolPolicy.observeSessionMove(sessionID, dir, "re-resolved")
    }
    st.sessionDirs.set(sessionID, dir)
    boundSessionDirsBody(st)
    return dir
  }
  return currentProjectDirBody(st, sessionID)
}

/**
 * Applies a successfully fetched session record to the parent-resolution
 * state: seeds the emitter authority from the record's agent, registers the
 * edge (with the agent, so the journaled row feeds the post-reload re-seed)
 * when the record names a parent, and back-fills the evidence promotion —
 * the edge may land after the claim and its evidence were recorded, so a
 * pending unverified PASS verifies the moment it can. A parent-less record
 * is negatively cached (a stable signal: the session exists and has no
 * parent edge).
 * @param st The parent-resolution state.
 * @param sessionID The child session ID.
 * @param rec The fetched session record.
 */
function applyResolvedRecord(
  st: ParentResolutionState,
  sessionID: string,
  rec: SessionRecord | undefined,
): void {
  const parentID = readRecordString(rec, PARENT_KEYS)
  const agentName = readRecordString(rec, AGENT_KEYS)
  // Redundant emitter seed: an agent resolved from the record would make
  // streamed markers authoritative. resolveParent early-returns once the
  // edge is set (session.created seeds the edge), so this only fires when
  // the first resolve happens before the edge lands; `execute.after`
  // delivery remains the always-firing seed (see seedEmitter).
  seedEmitterBody(st, sessionID, agentName)
  if (parentID !== "") {
    st.ledger.setParent(sessionID, parentID, agentName)
    st.promoteOnEvidence(parentID)
    st.failedLookups.delete(sessionID)
  } else {
    // Record present but parent-less: negatively cached (a stable signal).
    st.failedLookups.set(sessionID, {
      attempts: st.maxLookupAttempts,
      reason: st.lookupReasonNoParentId,
    })
    boundLookupsBody(st)
  }
}

/**
 * Resolves and caches the parent of a child session via the host API.
 * Parent-less records are negatively cached (a stable signal: the session
 * exists and has no parent edge); thrown lookups are retried up to
 * `maxLookupAttempts` because the record may appear later. Each failure is
 * recorded as `{ attempts, reason }`: `"not-visible"` when
 * `session.get` threw, `"no-parent-id"` when the record has no parent edge;
 * cleared on success.
 * Without a usable edge the caller falls back to keying by the session
 * itself. The parent-id read is delegated to `readRecordString`, the shared
 * candidate-extraction helper also used by `resolveProjectDir`; the
 * negative-cache and retry semantics are unchanged.
 * @param st The parent-resolution state.
 * @param sessionID Child session ID to resolve.
 */
async function resolveParentBody(
  st: ParentResolutionState,
  sessionID: string | undefined,
): Promise<void> {
  if (!sessionID || st.ledger.childToParent.has(sessionID)) return
  const attempts = st.failedLookups.get(sessionID)?.attempts ?? 0
  if (attempts >= st.maxLookupAttempts) return
  const get = st.hostSessionRef.current?.get
  if (typeof get !== "function") return
  try {
    const rec = await get({ sessionID })
    applyResolvedRecord(st, sessionID, rec)
  } catch {
    // lookup failure: retryable; fall back to keying by the session
    // itself until the record becomes visible or attempts run out
    st.failedLookups.set(sessionID, { attempts: attempts + 1, reason: st.lookupReasonNotVisible })
    boundLookupsBody(st)
  }
}

/**
 * Creates the parent-resolution concern bound to the factory's shared
 * state. The bodies live at module level; the factory only builds the
 * state object.
 * @param st The parent-resolution state (see {@link ParentResolutionState}).
 * @returns The parent-resolution methods the shared context exposes.
 */
export function createParentResolution(st: ParentResolutionState): {
  boundSessionDirs(): void
  seedEmitter(sessionID: string, agent: string): void
  reseedChildEdges(): number
  emitterAgent(sessionID: string): string
  childStatus(sid: string, agent: string): "child" | "parent" | "unknown"
  markerKindAllowed(sessionID: string): (kind: "gate" | "verdict") => boolean
  currentProjectDir(sessionID: string): string
  resolveProjectDir(sessionID: string): Promise<string>
  resolveParent(sessionID: string | undefined): Promise<void>
} {
  return {
    boundSessionDirs: () => boundSessionDirsBody(st),
    seedEmitter: (sessionID, agent) => seedEmitterBody(st, sessionID, agent),
    reseedChildEdges: () => reseedChildEdgesBody(st),
    emitterAgent: (sessionID) => emitterAgentBody(st, sessionID),
    childStatus: (sid, agent) => childStatusBody(st, sid, agent),
    markerKindAllowed: (sessionID) => markerKindAllowedBody(st, sessionID),
    currentProjectDir: (sessionID) => currentProjectDirBody(st, sessionID),
    resolveProjectDir: (sessionID) => resolveProjectDirBody(st, sessionID),
    resolveParent: (sessionID) => resolveParentBody(st, sessionID),
  }
}
