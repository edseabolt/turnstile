/**
 * @fileoverview Host-wiring boundary: registers turnstile's hooks with the
 * OpenCode v2 host and owns the plugin lifecycle: hook registration, the
 * stream-event loop, and cleanup. Enforcement decisions delegate to
 * src/gates.ts; marker parsing to src/markers.ts; persistence to
 * src/journal.ts; bookkeeping to src/state.ts. Configuration is resolved
 * once here (defaults ⊕ config file ⊕ env ⊕ injected overrides) and
 * injected downward; no module reads config after this point.
 *
 * Fail-open by contract: every hook body is guarded; only the deliberate
 * BLOCKED errors thrown by the gate layer propagate to the host.
 */

import * as fs from "node:fs"
import * as path from "node:path"
import { fileURLToPath } from "node:url"

import { configDigest, loadConfig } from "./config.ts"
import { createJournaler, type Journaler } from "./journal.ts"
import {
  agentFromTaskInput,
  compileMarkerRegex,
  parseGateMarkers,
  deTokenizeMarker,
  GATE_RE,
  VERDICT_RE,
} from "./markers.ts"
import { BlockError, createGates, type Gates } from "./gates.ts"
import { createEvidenceTracker } from "./evidence.ts"
import {
  LANDING_REQUIREMENT,
  createToolPolicy,
  isPushLanding,
  type ToolPolicy,
} from "./tool-policy.ts"
import { createLedger, formatGateSnapshot, type GateLedger } from "./state.ts"
import { worktreeFingerprint, shouldCarryGate } from "./fingerprint.ts"
import { ORCHESTRATOR_POLICY } from "./policy.ts"
import type {
  CompactionDraft,
  ChildVerdict,
  EventProperties,
  GateState,
  GenerateDraft,
  Host,
  MarkerEvent,
  PermissionEvaluateEvent,
  PromptHookProperties,
  SessionRecord,
  TaskInput,
  ToolHookEvent,
  TurnstileOptions,
} from "./types.ts"

/**
 * Coerces an unknown host value into a session-ID string, mirroring the
 * historical `String(value ?? "")` behavior at this boundary.
 * @param value Raw value from a host payload.
 * @returns The string form, or an empty string for nullish values.
 */
function asSessionID(value: unknown): string {
  return String(value ?? "")
}

/**
 * Picks the user prompt text from the host's candidate keys: the FIRST
 * candidate that is a NON-EMPTY string wins. An empty `text` no longer
 * shadows a marker-bearing `prompt` (and vice versa); when neither key holds a
 * non-empty string the prompt text is unresolvable and "" is returned (the
 * keyless-misconfiguration telemetry keys off exactly this). The THIRD candidate,
 * `prompt.text`, reads the object's text only when `prompt` is a non-null object
 * (a hostile getter on it throws and keeps the capture journal keys).
 * @param properties The `session.prompt` hook payload.
 * @returns The resolved prompt text, or "" when unresolvable.
 */
function promptTextOf(properties: PromptHookProperties | undefined): string {
  for (const candidate of [
    properties?.text,
    properties?.prompt,
    (properties?.prompt as { text?: unknown } | null)?.text,
  ]) {
    if (typeof candidate === "string" && candidate !== "") return candidate
  }
  return ""
}

/**
 * Tracks a hook registration handle so it can be disposed on teardown.
 * @param reg Registration handle returned by a host hook call.
 * @param cleanups Disposal list to append to.
 */
function track(reg: unknown, cleanups: Array<() => void>): void {
  if (reg && typeof (reg as { dispose?: unknown }).dispose === "function") {
    cleanups.push(() => (reg as { dispose: () => void }).dispose())
  }
}

/**
 * Reads the plugin version from package.json for the load heartbeat.
 *
 * Fail-open: returns null when package.json is unreadable (e.g. a bare
 * `setup.ts` + `src/` copy without it), mirroring the `install.mjs` version
 * read. Resolved from `import.meta.url` so it is correct under symlink
 * installs (Node realpaths the module URL to the repo) and npm installs
 * (`package.json` ships at the root). `pkgPath` is injectable so tests can
 * exercise the unreadable path without mocking `fs`.
 * @param pkgPath Optional package.json path override (tests).
 * @returns The version string, or null when it cannot be read.
 */
export function readPluginVersion(pkgPath?: string): string | null {
  try {
    const resolved =
      pkgPath ?? path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "package.json")
    return JSON.parse(fs.readFileSync(resolved, "utf8")).version ?? null
  } catch {
    return null
  }
}

/**
 * Message prefix the evaluate handler stamps on every plan-gate ask, so the
 * stream consumer can recognize a plan ask even when the host omits the
 * session id on the `permission.asked` event.
 */
const PLAN_ASK_MESSAGE_PREFIX = "turnstile: plan approval required"

/**
 * Message prefix the evaluate handler stamps on every landing-gate ask, so the
 * stream consumer can recognize a landing ask (even when the host omits the
 * session id) and route its reply to the landing gate.
 */
const LANDING_ASK_MESSAGE_PREFIX = "turnstile: push/PR requires a reviewer"

/**
 * Candidate keys for the parent id on a session record, in priority order,
 * dotted paths supported. The single source for the parent-id read so
 * `resolveParent` and `readRecordString` share one extraction rule.
 */
const PARENT_KEYS = ["parentID", "data.parentID"] as const

/**
 * Candidate keys for the project directory on a session record, in priority
 * order, dotted paths supported. The single source for the directory read so
 * `resolveProjectDir` and `readRecordString` share one extraction rule.
 */
const DIRECTORY_KEYS = [
  "directory",
  "location.directory",
  "data.directory",
  "data.location.directory",
] as const

/**
 * Candidate keys for the agent name on a session record, in priority order,
 * dotted paths supported. The single source for the agent-name read so
 * `resolveParent` and `readRecordString` share one extraction rule; an
 * unresolved read ("") fails the emitter-authority check (fail-closed for
 * text observation).
 */
const AGENT_KEYS = ["agent", "data.agent"] as const

/**
 * Returns the first non-empty string found at any key of `keys` on `rec`,
 * supporting dotted nested paths (e.g. `data.location.directory`). "" when
 * none holds a non-empty string or `rec` is absent. Shared candidate
 * extraction for `resolveParent` (parent id) and `resolveProjectDir` (project
 * directory): one field-extraction rule in one place.
 * @param rec The record to read from (may be undefined or non-object).
 * @param keys The candidate keys in priority order (dotted paths supported).
 * @returns The first non-empty string, or "" when none resolves.
 */
function readRecordString(rec: unknown, keys: readonly string[]): string {
  if (!rec || typeof rec !== "object") return ""
  const obj = rec as Record<string, unknown>
  for (const key of keys) {
    let cur: unknown = obj
    for (const part of key.split(".")) {
      if (cur && typeof cur === "object") cur = (cur as Record<string, unknown>)[part]
      else {
        cur = undefined
        break
      }
    }
    if (typeof cur === "string" && cur !== "") return cur
  }
  return ""
}

/**
 * Builds the turnstile plugin for a host: resolves the layered config,
 * creates the telemetry writer and gate ledger (replaying the journal),
 * then returns the async setup function that registers every hook.
 * @param _host The host context; unused at build time (hooks receive the
 *     live host at setup). Kept for factory-shape compatibility.
 * @param opts Injected config/env overrides (tests); defaults to env.
 * @returns The plugin setup function; resolves to a cleanup disposer.
 */
export function createTurnstile(
  _host: Host | undefined | null,
  opts: TurnstileOptions = {},
): (h: Host) => Promise<(() => void) | void> {
  const env = opts.env ?? process.env
  const { config } = loadConfig(env, opts.config)
  // Version is read once here (fail-open, alongside loadConfig) for the load
  // heartbeat; null on exotic installs where package.json is unreadable.
  const version = readPluginVersion()
  const journaler: Journaler = createJournaler({
    metricsDir: config.metricsDir,
    trace: config.trace,
    maxBytes: config.journalMaxBytes,
    maxGenerations: config.journalMaxGenerations,
  })
  // Config warnings are already journaled by config.ts (the pre-journaler
  // sink); journaling them here too would double-write every entry.
  const gateRe = compileMarkerRegex(config.gateMarker, GATE_RE, (cause) =>
    journaler.journal({
      type: "error",
      error: `config gateMarker: invalid regex, using default: ${String(cause)}`,
    }),
  )
  const verdictRe = compileMarkerRegex(config.verdictMarker, VERDICT_RE, (cause) =>
    journaler.journal({
      type: "error",
      error: `config verdictMarker: invalid regex, using default: ${String(cause)}`,
    }),
  )

  /**
   * True when the text contains at least one GATE or VERDICT marker per the
   * compiled config regexes. Uses `String.match`, so the `g` flag's
   * `lastIndex` state is not an issue; scans the whole output (no window).
   * @param text The output text to scan.
   */
  function hasMarker(text: string): boolean {
    return (text.match(gateRe)?.length ?? 0) > 0 || (text.match(verdictRe)?.length ?? 0) > 0
  }

  /**
   * Records one `task`/`subagent` dispatch plus its trace line — the single
   * canonical copy, called at guard exit so an allowed dispatch is
   * byte-identical to before while a blocked attempt stamps `blocked:true`
   * (audit distinguishes dispatched from blocked-and-attempted).
   * @param sessionID The dispatching session ID.
   * @param agent The resolved agent name.
   * @param description The trace-gated dispatch description.
   * @param blocked Whether a guard rejected the dispatch (stamps `blocked:true`).
   */
  function recordDispatch(
    sessionID: string,
    agent: string,
    description: string,
    blocked: boolean,
  ): void {
    journaler.journal({
      type: "dispatch",
      sessionID,
      agent,
      description,
      ...(blocked ? { blocked: true } : {}),
    })
    journaler.traceEvent("orchestrator", "dispatch", `task -> ${agent}`, sessionID)
  }
  const ledger: GateLedger = createLedger(journaler.journalPath, config.maxSessions)
  const gates: Gates = createGates(config, journaler)
  // Stateless denylist for bash/shell and write/edit tools in execute.before
  // regexes compile once here; it throws the same BlockError gates
  // throw, so the hook's existing catch rethrows blocks and journals the rest.
  const toolPolicy: ToolPolicy = createToolPolicy(config, journaler)
  // Evidence tracker: correlates a GATE: PASS against journaled exit-0
  // bash/shell test executions attributed to the parent. Owns only the
  // *evidence* dimension; marker authority is separate.
  const evidence = createEvidenceTracker(config, (raw) => ledger.parentOf(raw), journaler)
  let projectDir: string = process.cwd()
  // Per-delivery dedup scope counter: each task result is a distinct
  // delivery, so a re-run emitting a byte-identical marker is still
  // journaled; streaming sources share the empty scope (re-delivery dedup).
  let taskDeliverySeq = 0

  // Host session API, bound at setup time (hooks already fire post-setup).
  // Kept in factory scope so the shared `resolveParent` helper can call it
  // without capturing the per-setup `h`; enables the plan-reviewer delivery
  // path to await edge resolution via `session.get`.
  let hostSession: Host["session"] | undefined = undefined

  // Parent-lookup bookkeeping, keyed by child session ID.
  // Values record how many lookups were attempted and why the record stayed
  // unresolved: `"not-visible"` (host `session.get` threw) or `"no-parent-id"`
  // (the record exists but has no parent edge); cleared on success. Capped so
  // long-lived hosts cannot grow it unboundedly.
  const failedLookups = new Map<string, { attempts: number; reason: string }>()
  // `"not-visible"`: host `session.get` threw the lookup is retryable.
  const LOOKUP_REASON_NOT_VISIBLE = "not-visible"
  // `"no-parent-id"`: the record exists but has no parent edge (negative cache).
  const LOOKUP_REASON_NO_PARENT_ID = "no-parent-id"
  // Parent session ID → Date.now() of its LATEST plan-reviewer dispatch
  // (last-wins; cleared on prompt reset for that parent). Plausibility
  // input: an unresolved-child verdict is plausible only within the parent's
  // current task scope (recorded at-or-after this time, and unique across
  // parents). Capped via boundDispatches, the same eviction idiom as
  // boundLookups.
  const planReviewerDispatch = new Map<string, number>()
  // Plan-gate permission asks, keyed by host request id → the parent session
  // the ask was raised for + when it was recorded. Only asks escalated by the
  // evaluate handler (reason "plan-gate") are recorded, so a reply to an
  // unrelated permission ask (bash, write, …) can never match or release the
  // plan gate, and concurrent sessions cannot clobber each other (values
  // carry their own session). Bounded: evict oldest past the cap.
  const planGateAsks = new Map<string, { sessionID: string; recordedAt: number }>()
  // Cap on tracked plan-gate asks: evict oldest (insertion order) past it.
  const maxTrackedPlanAsks = 50
  // Parents whose evaluate handler has escalated to an ask but whose
  // `permission.asked` stream event has not arrived yet: parent → escalation
  // time. The evaluate handler does not know the host request id (it rides the
  // later stream event), so the next ask for an escalated parent is treated as
  // the plan ask and recorded. Bounded by boundAwaitingAsks, and latches
  // expire (see awaitingPlanAskTtlMs) so a lost stream event cannot latch a
  // parent indefinitely.
  const awaitingPlanAsk = new Map<string, number>()
  // Latch TTL for awaiting-plan-ask markers: an escalation whose stream event
  // never arrives stops latching after this window, so a stale marker cannot
  // record an unrelated later ask (whose approval would then release the plan
  // gate). Fail-toward-strict: expired = not recorded = reply inert = the
  // gate re-asks on the next dispatch.
  const awaitingPlanAskTtlMs = 5_000
  // Parents whose evaluate handler has been armed to force a landing ask (the
  // guard sets this under `gitGates.mode: enforce` on a repeat `git push`
  // attempt: no reviewer approval AND >= 1 prior landing block). Parent → arm
  // time. The landing arm consults it (not the command, whose wire shape in the
  // permission event is unverified — the guard is the single source of truth
  // for landing-candidate detection via isPushLanding). Bounded by
  // boundLandingAsks; expires like awaitingPlanAsk so a lost stream event
  // cannot latch a parent indefinitely.
  const pendingLandingAsk = new Map<string, number>()
  const maxTrackedLandingAsks = 50
  const pendingLandingAskTtlMs = 5_000
  // Landing-gate permission asks, keyed by host request id → the parent session
  // the ask was raised for + when it was recorded. Only asks by the evaluate
  // handler's landing arm (message prefixed `turnstile: push/PR …`) are
  // recorded, so a reply to an unrelated permission ask can never match or
  // release the landing gate; per-reason keying keeps a landing `once` grant
  // from ever being consumed by a plan-gate (task) dispatch and vice versa.
  // Bounded: evict oldest past the cap.
  const landingGateAsks = new Map<string, { sessionID: string; recordedAt: number }>()
  const maxTrackedLandingGateAsks = 50
  // A thrown lookup may mean the child record is not yet visible to the
  // host API, so failures are retried up to this many times per session.
  const maxLookupAttempts = 3
  // Bound on tracked sessions: evict oldest (insertion order) when past.
  const maxTrackedLookups = 256
  // Bound on tracked per-session project directories: evict oldest (insertion
  // order) when past. Mirrors maxTrackedLookups.
  const maxTrackedSessionDirs = 50
  // Last-known project directory per session, resolved via session.get and
  // invalidated on session_move. The per-dispatch resolver caches fresh here so
  // the sync consumers (evaluate, continuation carry) read one dispatch behind;
  // the sync consumers fall back to a cached value, then the root
  // session.created seed, then process.cwd(). Bounded by boundSessionDirs.
  const sessionDirs = new Map<string, string>()

  /**
   * Bounds the failed-lookup map by evicting its oldest entries.
   */
  function boundLookups(): void {
    while (failedLookups.size > maxTrackedLookups) {
      // The loop condition guarantees a first entry exists.
      const oldest = failedLookups.keys().next().value as string
      failedLookups.delete(oldest)
    }
  }

  /**
   * Bounds the session-directory map by evicting its oldest entries.
   * Mirrors boundLookups; see sessionDirs.
   */
  function boundSessionDirs(): void {
    while (sessionDirs.size > maxTrackedSessionDirs) {
      // The loop condition guarantees a first entry exists.
      const oldest = sessionDirs.keys().next().value as string
      sessionDirs.delete(oldest)
    }
  }

  /**
   * Per-session sliding window of streamed child text: a host may split one
   * marker across `session.text.delta` chunks, and a fragment-only parse silently
   * loses the gate flip. Each delta re-parses the window's tail; markers.ts dedup
   * suppresses every re-fire, so only a newly completed marker is first-sighted.
   * Bounded by boundDeltaWindows; cleared on the next task dispatch (see
   * execute.before age-out) so stale fragments of a prior task do not leak.
   */
  const deltaWindows = new Map<string, string>()
  // Comfortably longer than any complete marker; the tail keeps a window whose
  // head was evicted so a marker split across many small deltas still completes.
  const maxDeltaWindowChars = 512
  const maxTrackedDeltaWindows = 50

  /**
   * Bounds the delta-window map by evicting its oldest entries.
   * Mirrors boundSessionDirs; see deltaWindows.
   */
  function boundDeltaWindows(): void {
    while (deltaWindows.size > maxTrackedDeltaWindows) {
      // The loop condition guarantees a first entry exists.
      const oldest = deltaWindows.keys().next().value as string
      deltaWindows.delete(oldest)
    }
  }

  /**
   * Bounds the dispatch-timestamp map by evicting its oldest entries.
   * Mirrors boundLookups; see planReviewerDispatch.
   */
  function boundDispatches(): void {
    while (planReviewerDispatch.size > maxTrackedLookups) {
      // The loop condition guarantees a first entry exists.
      const oldest = planReviewerDispatch.keys().next().value as string
      planReviewerDispatch.delete(oldest)
    }
  }

  /**
   * Bounds the plan-gate ask map by evicting its oldest recorded asks.
   * Mirrors boundLookups; see planGateAsks.
   */
  function boundPlanAsks(): void {
    while (planGateAsks.size > maxTrackedPlanAsks) {
      // The loop condition guarantees a first entry exists.
      const oldest = planGateAsks.keys().next().value as string
      planGateAsks.delete(oldest)
    }
  }

  /**
   * Bounds the awaiting-plan-ask map (parent → escalation time), evicting its
   * oldest entries. Mirrors boundPlanAsks; see awaitingPlanAsk.
   */
  function boundAwaitingAsks(): void {
    while (awaitingPlanAsk.size > maxTrackedPlanAsks) {
      // The loop condition guarantees a first entry exists.
      const oldest = awaitingPlanAsk.keys().next().value as string
      awaitingPlanAsk.delete(oldest)
    }
  }

  /**
   * Reads (and expires) the awaiting-plan-ask latch for a session: a marker
   * older than the TTL is dropped and reported as absent. Fail-toward-strict:
   * an expired latch records nothing, so a reply to any later ask stays inert
   * and the plan gate re-asks on the next dispatch.
   * @param sid The session whose latch is consulted.
   * @returns Whether a live (unexpired) latch exists for the session.
   */
  function hasLiveAwaitingAsk(sid: string): boolean {
    const at = awaitingPlanAsk.get(sid)
    if (at === undefined) return false
    if (Date.now() - at > awaitingPlanAskTtlMs) {
      awaitingPlanAsk.delete(sid)
      return false
    }
    return true
  }

  /**
   * Bounds the pending-landing-ask map (parent → arm time), evicting its oldest
   * entries. Mirrors boundAwaitingAsks; see pendingLandingAsk.
   */
  function boundLandingAsks(): void {
    while (pendingLandingAsk.size > maxTrackedLandingAsks) {
      const oldest = pendingLandingAsk.keys().next().value as string
      pendingLandingAsk.delete(oldest)
    }
  }

  /**
   * Bounds the landing-gate ask map (requestID → parent + record time),
   * evicting its oldest entries. Mirrors boundPlanAsks; see landingGateAsks.
   */
  function boundLandingGateAsks(): void {
    while (landingGateAsks.size > maxTrackedLandingGateAsks) {
      const oldest = landingGateAsks.keys().next().value as string
      landingGateAsks.delete(oldest)
    }
  }

  /**
   * Emitter-authority cache: a child session ID → its resolved agent name,
   * seeded at three redundant points (`resolveParent` record read,
   * `session.created`, and `execute.after` task input). Read by
   * `markerKindAllowed` to decide whether a session's `GATE:`/`VERDICT:` text
   * is authoritative for that kind. Bounded by boundSessionAgents.
   */
  const sessionAgents = new Map<string, string>()
  const maxTrackedEmitters = 50
  /**
   * Bounds the emitter-authority cache by evicting its oldest entries.
   * Mirrors boundLookups; see sessionAgents.
   */
  function boundSessionAgents(): void {
    while (sessionAgents.size > maxTrackedEmitters) {
      // The loop condition guarantees a first entry exists.
      const oldest = sessionAgents.keys().next().value as string
      sessionAgents.delete(oldest)
    }
  }
  /**
   * Seeds (or refreshes) a child session's emitter agent. No-op when either
   * argument is empty, so an unresolved record read ("") never clobbers a
   * known agent. `markerKindAllowed` reads the cache lazily at parse time, so
   * a seed arriving before the marker's parse still applies.
   * @param sessionID The child session ID.
   * @param agent The resolved agent name, or "" when unresolved.
   */
  function seedEmitter(sessionID: string, agent: string): void {
    if (sessionID && agent) {
      sessionAgents.set(sessionID, agent)
      boundSessionAgents()
    }
  }

  /**
   * Emits a predicate answering whether a gate/verdict kind is authoritative
   * for a session's emitter agent. A gate flips only for `test-runner`; a
   * verdict only for `reviewer`/`plan-reviewer` — each also required to be in
   * `bareOutput` (the aggregated marker-contracted set). Unseeded or unknown
   * agents are denied: text observation mutates only for contracted emitters,
   * and a legitimate child's markers always land authoritatively at
   * `execute.after` delivery, which seeds the agent from dispatch input.
   * @param sessionID The emitting session ID.
   * @returns A per-kind authority predicate.
   */
  function markerKindAllowed(sessionID: string): (kind: "gate" | "verdict") => boolean {
    const agent = sessionAgents.get(sessionID) ?? ""
    return (kind) => {
      if (agent === "" || !config.agents.bareOutput.includes(agent)) return false
      if (kind === "gate") return agent === config.agents.testRunner
      return agent === config.agents.reviewer || agent === config.agents.planReviewer
    }
  }

  /**
   * Reads (and expires) the pending-landing-ask latch for a session: an arm
   * older than the TTL is dropped and reported as absent. Fail-toward-strict:
   * an expired latch arms nothing, so a later ask is inert and the landing gate
   * re-blocks. Only armed under `gitGates.mode: enforce` on a repeat attempt, so
   * shadow/off never ask.
   * @param sid The parent session whose latch is consulted.
   * @returns Whether a live (unexpired) latch exists for the session.
   */
  function hasLiveLandingAsk(sid: string): boolean {
    const at = pendingLandingAsk.get(sid)
    if (at === undefined) return false
    if (Date.now() - at > pendingLandingAskTtlMs) {
      pendingLandingAsk.delete(sid)
      return false
    }
    return true
  }

  /**
   * Returns the last-known project directory for a session: the per-session
   * cache (resolved via `session.get`), then the root `session.created` seed,
   * then `process.cwd()`. Called by the synchronous consumers (evaluate,
   * continuation carry); each reads at most one dispatch behind a move, which
   * converges once the next `execute.before` re-resolves.
   * @param sessionID The session whose directory is read.
   * @returns The last-known project directory.
   */
  function currentProjectDir(sessionID: string): string {
    return sessionDirs.get(sessionID) ?? projectDir
  }

  /**
   * Resolves the project directory for a dispatch from the host's session
   * record, caching the result per session so the sync consumers can read it.
   * A fresh `session.get` is awaited and its directory wins; on an absent API,
   * a thrown lookup, or a record with no directory candidate the resolver
   * falls back to the cache then the seed, journaling nothing (fail-open; the
   * exact `type:"error"` counts in the open-suite must stay stable).
   * @param sessionID The dispatching session to resolve.
   * @returns The resolved (or fallback) project directory.
   */
  async function resolveProjectDir(sessionID: string): Promise<string> {
    const get = hostSession?.get
    if (typeof get !== "function") return currentProjectDir(sessionID)
    let rec: SessionRecord | undefined
    try {
      rec = await get({ sessionID })
    } catch {
      // lookup failure: retryable; fall back to the cache then the seed.
      return currentProjectDir(sessionID)
    }
    const dir = readRecordString(rec, DIRECTORY_KEYS)
    if (dir !== "") {
      sessionDirs.set(sessionID, dir)
      boundSessionDirs()
      return dir
    }
    return currentProjectDir(sessionID)
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
   * @param sessionID Child session ID to resolve.
   */
  async function resolveParent(sessionID: string | undefined): Promise<void> {
    if (!sessionID || ledger.childToParent.has(sessionID)) return
    const attempts = failedLookups.get(sessionID)?.attempts ?? 0
    if (attempts >= maxLookupAttempts) return
    const get = hostSession?.get
    if (typeof get !== "function") return
    try {
      const rec = await get({ sessionID })
      const parentID = readRecordString(rec, PARENT_KEYS)
      // Redundant emitter seed: an agent resolved from the record would make
      // streamed markers authoritative. resolveParent early-returns once the
      // edge is set (session.created seeds the edge), so this only fires when
      // the first resolve happens before the edge lands; `execute.after`
      // delivery remains the always-firing seed (see seedEmitter).
      seedEmitter(sessionID, readRecordString(rec, AGENT_KEYS))
      if (parentID !== "") {
        ledger.setParent(sessionID, parentID)
        failedLookups.delete(sessionID)
      } else {
        // Record present but parent-less: negatively cached (a stable signal).
        failedLookups.set(sessionID, {
          attempts: maxLookupAttempts,
          reason: LOOKUP_REASON_NO_PARENT_ID,
        })
        boundLookups()
      }
    } catch {
      // lookup failure: retryable; fall back to keying by the session
      // itself until the record becomes visible or attempts run out
      failedLookups.set(sessionID, { attempts: attempts + 1, reason: LOOKUP_REASON_NOT_VISIBLE })
      boundLookups()
    }
  }

  /**
   * Resolves the read-budget key for a whole-file read: awaits the child→parent
   * edge, then returns the parent session (or the session itself when the edge
   * is genuinely absent). Journals a bounded signal only when a lookup was
   * attempted but stayed inconclusive — a child whose record is not yet visible
   * to `session.get`. Root sessions that resolve cleanly as parent-less, and
   * children already resolved to a parent, never signal (no journal spam).
   * @param sid The reading session ID, already normalized via `asSessionID`.
   * @returns The session ID the read budget should be keyed against.
   */
  async function readBudgetKey(sid: string): Promise<string> {
    await resolveParent(sid)
    const key = ledger.parentOf(sid)
    if (key === sid) {
      // Byte-identical read: reads the attempts count off the
      // structured record; the gate (`attempts > 0 && attempts < max`) is
      // unchanged, so this signal is byte-identical to the pre-enrichment form.
      const attempts = failedLookups.get(sid)?.attempts ?? 0
      // Inconclusive window only: a lookup was tried and the record was not yet
      // visible (attempts climb 1..max-1). Zero means no host session API
      // (never knowable); at the cap means a resolved parent-less root. Bounded
      // to ≤ maxLookupAttempts-1 signals per session.
      if (attempts > 0 && attempts < maxLookupAttempts) {
        journaler.journal({
          type: "error",
          sessionID: sid,
          error: `read budget keyed by session; parent unresolved after ${attempts}/${maxLookupAttempts} lookup attempt(s)`,
        })
      }
    }
    return key
  }

  /**
   * Returns the last verdict match in `text` for `re` (last-match-wins, the
   * same rule `parseGateMarkers` uses); "" when there is no match. Independent
   * of `String.match`'s global-regex lastIndex state because `.match` resets it.
   * @param text The text to scan.
   * @param re The compiled verdict regex.
   * @returns The last match text, or "" when `text` has no verdict match.
   */
  function lastMatch(text: string, re: RegExp): string {
    return text.match(re)?.at(-1) ?? ""
  }

  /**
   * Stamps a plan-reviewer verdict's approval against the current plans-dir
   * signature so a later re-plan is detectable at dispatch time. An APPROVE
   * against an unreadable dir stamps "" (unknown): the approval is accepted
   * once and stamped on the next enforcing dispatch (fail-open); a BLOCK
   * clears the stamp (hygiene). Mutates `s` in place.
   * @param s The session's gate state (mutated).
   * @param result The verdict result ("APPROVE" or "BLOCK").
   * @param projectDir The current project directory (for the plans-dir scan).
   */
  function stampPlanApproval(s: GateState, result: string, projectDir: string): void {
    s.plansSignature = result === "APPROVE" ? (gates.plansSignature(projectDir) ?? "") : ""
  }

  /**
   * Splits a self-keyed delivery's attributable children into the
   * registered-edge scan (`edge`, today's scan) and every child with a stored
   * verdict that is not the delivery session itself (`unresolved`). `edge`
   * keeps its LRU promotion; `unresolved` is a pure snapshot that feeds the
   * plausibility join in plausibleUnresolved.
   * @param sid The delivery's parent id (=== child in the self-keyed branch).
   * @returns Registered candidates and verdict-bearing children (minus sid).
   */
  function discoverCandidates(sid: string): {
    edge: string[]
    unresolved: Array<{ child: string; verdict: ChildVerdict }>
  } {
    const edge: string[] = []
    for (const c of ledger.childToParent.keys()) {
      if (ledger.childToParent.get(c) === sid && ledger.childVerdict(c).marker !== "") edge.push(c)
    }
    return {
      edge,
      unresolved: ledger.evidencedChildren().filter(({ child }) => child !== sid),
    }
  }

  /**
   * Unresolved children plausibly this parent's next task: a plan-reviewer
   * dispatch is recorded for `sid` AND the verdict was recorded at-or-after it
   * (inclusive, tolerating same-millisecond ties) AND no OTHER parent
   * dispatched at-or-before that verdict (unique-owner rule; a verdict with two
   * candidate parents is ambiguous and excluded → fail-open). Pure read.
   * @param sid The delivery's parent id.
   * @param unresolved The `{ child, verdict }` candidates from discoverCandidates.
   * @returns The child ids plausibly belonging to `sid`.
   */
  function plausibleUnresolved(
    sid: string,
    unresolved: Array<{ child: string; verdict: ChildVerdict }>,
  ): string[] {
    const dispatchTs = planReviewerDispatch.get(sid)
    if (dispatchTs === undefined) return []
    const out: string[] = []
    for (const { child, verdict } of unresolved) {
      if (verdict.recordedAt < dispatchTs) continue
      // Unique-owner: another parent dispatched at-or-before this verdict's
      // recordedAt ⇒ ambiguous ⇒ excluded (never-guess).
      let ambiguous = false
      for (const [other, ts] of planReviewerDispatch) {
        if (other === sid) continue
        if (ts <= verdict.recordedAt) {
          ambiguous = true
          break
        }
      }
      if (!ambiguous) out.push(child)
    }
    return out
  }

  /**
   * The most-recently-recorded child among the given ids, by stored
   * `recordedAt` (ties keep insertion order); undefined when none. Pure read.
   * @param children The candidate child ids (from the plausible list).
   * @returns The most recently recorded child id, or undefined.
   */
  function mostRecentUnresolved(children: string[]): string | undefined {
    let best: string | undefined
    let bestAt = -1
    for (const c of children) {
      const at = ledger.childVerdict(c).recordedAt
      if (at > bestAt) {
        bestAt = at
        best = c
      }
    }
    return best
  }

  /**
   * Parent-lookup diagnostic for the delivery child, its parent (sid, when
   * distinct), and each unresolved candidate: `{ attempts, reason }` — the
   * current parent-lookup attempt count and why it stayed unresolved
   * (`"not-visible"` / `"no-parent-id"`, or `"resolved-or-never-tried"` when
   * clean). Distinct sessions are kept in the entry so the field can tell the
   * three root-cause hypotheses apart. Pure read; clears nothing.
   * @param child The delivery's session id.
   * @param unresolved The unresolved candidate child ids.
   * @returns A per-session `{ attempts, reason }` map.
   */
  function lookupDiag(
    child: string,
    unresolved: string[],
  ): Record<string, { attempts: number; reason: string }> {
    const out: Record<string, { attempts: number; reason: string }> = {}
    for (const s of [child, ...unresolved])
      out[s] = {
        attempts: failedLookups.get(s)?.attempts ?? 0,
        reason: failedLookups.get(s)?.reason ?? "resolved-or-never-tried",
      }
    for (const c of unresolved)
      out[c] = {
        attempts: failedLookups.get(c)?.attempts ?? 0,
        reason: failedLookups.get(c)?.reason ?? "resolved-or-never-tried",
      }
    return out
  }

  /**
   * Attributes a plan-reviewer result to the parent's plan-approval gate,
   * ensuring the journaled `plan` entry's `raw` is always an actual child
   * session ID (never the parent `sessionID`):
   *
   * - Edge-resolved (`childToParent.has(child)`): the delivery's own verdict
   *   wins over any stored child-text observation (delivery-wins only when the
   *   output itself carries a marker); the `source` names the winning pipeline.
   *   `raw = child`.
   * - Self-keyed (`parentOf(child) === child`, e.g. a host re-fire reporting
   *   the parent's own session ID): never reads `childVerdict(child)` (that is
   *   the parent's own quoted text, not a child's evidence). It journals a
   *   forensic `type:"attribution"` entry first (before any mutation,
   *   replay-inert, never containing the word "unattributable" so the
   *   /unattributable/ error count stays exactly one), then discovers
   *   attributable children from registered edges AND from unresolved children
   *   whose streamed verdict plausibly belongs to this parent, and
   *   attributes through the unique unanimous pool (`raw = first edge child,
   *   else most-recently-recorded unresolved child). The registered-edge scan
   *   is round-scoped to the parent's most-recent plan-reviewer dispatch
   *   (exactly as the unresolved scan is): an earlier-round BLOCK stored on an
   *   edge child left behind by a prior review round is superseded by this
   *   round's verdict, so a re-issued APPROVE is credited. Zero candidates, or
   *   more than one (a contradiction within this same round), journals the existing `type:"error"` and mutates nothing: a marker-less, unattributable
   *   parent-keyed delivery can never clobber a live approval with a BLOCK, and any plausible streamed APPROVE makes a self-keyed BLOCK unreachable
   *   (structural fail-open).
   *
   * Never throws (fail-open).
   * @param child The raw child session ID, for the `plan` entry's `raw` field.
   * @param output The delivery's own result text.
   */
  async function attributePlanVerdict(child: string, output: string): Promise<void> {
    const sid = ledger.parentOf(child)
    const own = lastMatch(output, verdictRe)
    // Edge-resolved: attribute through the child directly, delivery-wins merge.
    if (ledger.childToParent.has(child)) {
      const s = ledger.state(sid)
      const rec = ledger.childVerdict(child)
      const marker = own || rec.marker
      const markerSource = own ? "task-result" : rec.source || "task-result"
      const result = marker.includes("APPROVE") ? "APPROVE" : "BLOCK"
      s.hasPlanVerdict = result === "APPROVE"
      stampPlanApproval(s, result, await resolveProjectDir(sid))
      journaler.journal({
        type: "plan",
        sessionID: sid,
        raw: child,
        result,
        marker: marker || "<none>",
        source: markerSource,
      })
      journaler.traceEvent("plan-reviewer", "verdict", marker || "<no verdict marker>", sid)
      return
    }
    // Self-keyed: the delivery's own session id is not a registered child.
    const { edge, unresolved } = discoverCandidates(sid)
    const unresolvedIDs = unresolved.map(({ child: cid }) => cid)
    const plausible = plausibleUnresolved(sid, unresolved)
    // A self-keyed re-delivery for a re-reviewed plan can arrive while a
    // superseded earlier-round BLOCK child is still registered as this
    // parent's edge child. Round-scope the edge scan exactly as
    // plausibleUnresolved round-scopes the unresolved scan: keep only edge
    // children whose stored verdict was recorded at-or-after the parent's
    // most-recent plan-reviewer dispatch, so last round's BLOCK cannot
    // contradict this round's evidence. When no dispatch is recorded the scan
    // stays structural (a lone edge child still attributes, unchanged).
    const dispatchTs = planReviewerDispatch.get(sid)
    const edgeCandidates =
      dispatchTs === undefined
        ? edge
        : edge.filter((c) => ledger.childVerdict(c).recordedAt >= dispatchTs)
    const pool = [...edgeCandidates, ...plausible]
    const verdictOf = (c: string): "APPROVE" | "BLOCK" =>
      ledger.childVerdict(c).marker.includes("APPROVE") ? "APPROVE" : "BLOCK"
    const unanimous = new Set(pool.map(verdictOf))
    // Attribute only on a non-empty unanimous pool: today's lone-edge-candidate
    // attribution (edge-only) is unchanged; a plausible streamed APPROVE either
    // becomes the sole candidate (approved) or contradicts a BLOCK pool
    // (fail-open) — so a self-keyed BLOCK is unreachable while such evidence
    // exists.
    const attributed =
      pool.length > 0 && unanimous.size === 1
        ? (edgeCandidates[0] ?? mostRecentUnresolved(plausible))
        : undefined
    const decision = attributed ? "attributed" : "fail-open"
    // Journal the forensic entry first (before any gate mutation). A new journal
    // type is replay-inert; its wording avoids "unattributable" so the
    // single-error count is stable.
    journaler.journal({
      type: "attribution",
      sessionID: sid,
      raw: child,
      decision,
      deliveryIsParent: child === sid,
      sessionApi: typeof hostSession?.get === "function",
      candidates: {
        edge: edgeCandidates.length,
        unresolved: unresolved.length,
        plausible: plausible.length,
      },
      unresolvedIDs,
      lookup: lookupDiag(child, unresolvedIDs),
    })
    if (attributed) {
      const s = ledger.state(sid)
      const rec = ledger.childVerdict(attributed)
      // Attributed candidates are evidenced (a non-empty stored marker and a
      // non-empty source label), so marker needs no "<none>" fallback here —
      // the edge-resolved branch above keeps its fallback for marker-less
      // deliveries.
      const marker = own || rec.marker
      const markerSource = own ? "task-result" : rec.source
      const result = marker.includes("APPROVE") ? "APPROVE" : "BLOCK"
      s.hasPlanVerdict = result === "APPROVE"
      stampPlanApproval(s, result, await resolveProjectDir(sid))
      journaler.journal({
        type: "plan",
        sessionID: sid,
        raw: attributed,
        result,
        marker,
        source: markerSource,
      })
      journaler.traceEvent("plan-reviewer", "verdict", marker, sid)
      return
    }
    // Empty or contradictory evidence: fail-open. Gate untouched — never a
    // BLOCK, never a parent-keyed plan entry, never a clobber of a live
    // approval (the attribution entry above carries the diagnostics). A
    // one-candidate pool always attributes, so this error only fires with
    // zero or multiple candidates — plural noun always correct.
    journaler.journal({
      type: "error",
      sessionID: sid,
      error: `plan attribution: unattributable parent-keyed delivery; gate unchanged (${pool.length} evidenced candidates)`,
    })
  }

  /**
   * Parses markers out of assistant text and journals first-sight events.
   * @param text The assistant text to scan.
   * @param sessionID The raw (possibly child) session ID.
   * @param source Provenance label for the text in journal entries.
   * @param dedupScope Key prefix partitioning the marker dedup set.
   */
  function parseMarkers(
    text: string,
    sessionID: string,
    source: string,
    dedupScope = "",
  ): MarkerEvent[] {
    const events: MarkerEvent[] = []
    if (!text) return events
    // Record a child's latest VERDICT from the text itself, before the parent
    // edge is needed, so a child with an unresolved edge still records. Only
    // non-task-result sources enter the store: task-result markers are handled
    // by the delivery's own match during attribution, and keeping them out
    // preserves "a marker-less task-result delivery keeps the gate red".
    //
    // Store-backed verdict observations: the store records the child's latest
    // VERDICT (per (child, marker, source) first-sight) for the plan gate's
    // attribution reads; the parent-bucket dedup (markers.ts) keys on
    // (scope, marker), so identical re-delivery and a cross-source same-marker
    // replay (a source change with an unchanged marker, e.g. delta→ended) are
    // both silently suppressed; only a marker flip reaches the journal.
    // Authority gate: only a marker-contracted emitter (see markerKindAllowed)
    // may record or apply a verdict; a quoted/echoed verdict is denied here
    // (never stored) and surfaces as authority:"suppressed" below.
    const allowed = markerKindAllowed(sessionID)
    if (sessionID && source !== "task-result" && allowed("verdict")) {
      const m = lastMatch(text, verdictRe)
      if (m) ledger.recordChildVerdict(sessionID, m, source)
    }
    const sid = ledger.parentOf(sessionID)
    if (!sid) return events
    const s = ledger.state(sid)
    // Evidence verdict computed here: the caller owns the tracker + config.
    // Under "enforce" the flip switch is the observed correlation; under "flag"
    // the flip switch is omitted (always flips) while the journal is stamped;
    // under "off" neither the flip switch nor the stamp is passed, keeping
    // events byte-identical to legacy output.
    const observed = config.gateEvidence === "off" ? undefined : evidence.has(sid)
    const passVerified = config.gateEvidence === "enforce" ? observed : undefined
    const stampVerified = observed
    const stampMode = observed === undefined ? undefined : config.gateEvidence
    // Thread the raw child session ID as `raw`: dedup provenance is per-child,
    // so a dedup hit from a different child accounts as cross-child suppression
    // while the same child's re-delivery stays silent.
    for (const event of parseGateMarkers(
      s,
      text,
      gateRe,
      verdictRe,
      dedupScope,
      sessionID,
      passVerified,
      stampVerified,
      stampMode,
      allowed,
    )) {
      // Denied observation: journal it keyed on the EMITTER (sessionID, not
      // sid) as a replay-inert type:"suppressed" audit entry, then skip it —
      // it is never returned, so hasReviewApprove and own-match attribution
      // cannot fire on it. Keyed on the emitter (not the parent) because
      // nothing replays against a denied observation; this runs for every
      // non-empty sessionID, including unresolved-edge ones (self-keyed).
      if (event.authority === "suppressed") {
        journaler.journal({
          type: "suppressed",
          sessionID,
          raw: sessionID,
          agent: sessionAgents.get(sessionID) ?? "",
          kind: event.kind,
          marker: event.marker,
          source,
        })
        continue
      }
      // The `authority:"suppressed"` events above `continue` before here, so
      // every event reaching this point carries a defined numeric `suppressed`;
      // assert that shape to the type checker (it is not optional at runtime).
      const suppressed = event.suppressed!
      const suppressedCount = suppressed > 0 ? { suppressed } : {}
      if (event.kind === "gate") {
        // Keyed by parent session so journal replay restores state where the
        // reviewer gate looks it up; raw child ID kept for forensics.
        const evidenceStamp =
          event.verified !== undefined ? { verified: event.verified, mode: event.mode } : {}
        journaler.journal({
          type: "gate",
          sessionID: sid,
          raw: sessionID,
          result: event.result,
          source,
          marker: event.marker,
          ...evidenceStamp,
          ...suppressedCount,
        })
        journaler.traceEvent("test-runner", "gate", event.marker, sid)
        // Carry the de-tokenized marker text for the compaction snapshot; the
        // state boundary records it, the caller journals the event.
        s.lastGateMarker = deTokenizeMarker(event.marker)
      } else {
        // Streaming verdict dedup is per (child, marker, source) via the store
        // (a source change with an unchanged marker re-journals; identical
        // re-delivery never emits an event here because the parent-bucket
        // dedup on (scope, marker) suppresses it first). Gate-kind events
        // above are unaffected.
        journaler.journal({
          type: "verdict",
          sessionID: sid,
          raw: sessionID,
          marker: event.marker,
          rounds: event.rounds,
          source,
          ...suppressedCount,
        })
        journaler.traceEvent("reviewer", "verdict", event.marker, sid)
        s.lastVerdictMarker = deTokenizeMarker(event.marker)
      }
      // Collected for the caller: the execute.after reviewer branch uses these
      // events to detect a first-sight verdict APPROVE and set hasReviewApprove.
      events.push(event)
    }
    return events
  }

  /**
   * The plugin setup function handed to the host: registers the session,
   * tool, and event hooks, and returns a disposer that unwinds them all.
   * @param h The live OpenCode host context.
   * @returns A disposer that disposes every registration; failures inert.
   */
  return async function setup(h: Host): Promise<(() => void) | void> {
    const cleanups: Array<() => void> = []
    // Count of successfully registered hooks (3 session + 2 tool + 1 event
    // subscriber = 6 on a full host); feeds the load heartbeat below.
    let hooks = 0
    // Prompt-channel waiver capture: the waiver must
    // provenance from the user's prompt, never the dispatch prompt. A counter
    // tracks prompts where NEITHER candidate text key (`text`/`prompt`) holds a
    // non-empty string, so an unresolvable source is reported once (keylessPrompts hits
    // 1 exactly once) as a misconfiguration (mirrors the bash `command ?? cmd`
    // telemetry).
    let keylessPrompts = 0

    // Bind the host session API for the shared `resolveParent` helper (hooks
    // already fire post-setup).
    hostSession = h.session

    // Prompt-channel admission bookkeeping (per-plugin-load closure state):
    // `promptHookFires` counts prompt-hook dispatches (the hook increments it
    // before it admits); a zero count when the inbox stream admits means this
    // surface does not dispatch the prompt hook, so admission is served by the
    // inbox stream — surfaced once as a one-time telemetry error.
    let promptHookFires = 0
    // One-time flag backing the dead-channel surfacing below.
    let deadChannelSurfaced = false
    // Dedupe keys `${sessionID}:${admissionID}` for every prompt admitted, so
    // the hook path and the inbox stream each admit one prompt exactly once
    // (the normal host sequence is hook-then-inbox on the shared message id).
    const admittedIds = new Set<string>()
    // Cap on tracked dedupe keys (FIFO; evict the first-seen key past the
    // cap — Set insertion order is never refreshed, which is fine: the host
    // never re-fires an old admission id, so recency adds nothing) — bounded
    // memory per plugin instance.
    const maxTrackedAdmittedIds = 64
    /**
     * Bounds the admitted-id dedupe set by evicting its oldest keys.
     * Mirrors boundLookups; see admittedIds.
     */
    function boundAdmittedIds(): void {
      while (admittedIds.size > maxTrackedAdmittedIds) {
        // The loop condition guarantees a first entry exists.
        const oldest = admittedIds.keys().next().value as string
        admittedIds.delete(oldest)
      }
    }

    /**
     * Admits one user-authored prompt: resets prior task scope, then captures a
     * waiver and/or approval marker and emits the unresolvable-text telemetry.
     * This is the single admission body, reached either through the session
     * prompt hook or the correlated inbox stream; the caller dedupes by the
     * shared host message id so one prompt is admitted exactly once regardless
     * of which signal arrives first. Reads only — a transform hook mutates the
     * host event in place host-side, so turnstile must not mutate it.
     *
     * Fail-open: every read is guarded; a coercion that throws is journaled and
     * swallowed, never thrown at the host.
     * @param sessionID The (string) session the prompt is admitted for.
     * @param properties The prompt payload (hook shape or an inbox-derived
     *     `{ sessionID, text }`).
     * @param admissionID The shared host message id (`messageID`/`inboxID`), or
     *     "" to skip dedupe.
     */
    function admitPrompt(
      sessionID: string,
      properties: PromptHookProperties,
      admissionID: string,
    ): void {
      // Dedupe: the normal host sequence is hook-then-inbox on the same id, so
      // the other transport already admitted this prompt. An empty id has no
      // shared correlation key, so it never dedupes (documented double-arrival
      // edge, idempotent — any APPROVE replay restores the gate).
      if (admissionID !== "") {
        const dedupeKey = `${sessionID}:${admissionID}`
        if (admittedIds.has(dedupeKey)) return
        admittedIds.add(dedupeKey)
        boundAdmittedIds()
      }
      // Dead-channel surfacing: reaching here while the hook never fired means
      // the surface does not dispatch the prompt hook — capture is served by the
      // inbox stream. One-time, per plugin load.
      if (promptHookFires === 0 && !deadChannelSurfaced) {
        deadChannelSurfaced = true
        journaler.journal({
          type: "error",
          sessionID,
          error:
            "prompt channel: the session prompt hook never fired on this surface; prompt admission is served by the inbox event stream",
        })
      }
      // Mark the session a live parent before the reset: resetState
      // re-caps `states`, and a registered parent is never evicted,
      // so the rebuilt MRU slot stays pinned.
      ledger.markParent(sessionID)
      // Continuation carry (opt-in): arm the same one-prompt replay grace the
      // journal uses so `resetState` carries the restart-sticky flags when this
      // prompt re-admits the SAME worktree/branch the task was earned in. The
      // git probe is total (never throws), so this stays throw-free. The
      // carry decision is captured BEFORE mutating, not re-derived after.
      if (config.continuationCarry) {
        const prior = ledger.peek(sessionID)
        const fingerprint = worktreeFingerprint(currentProjectDir(sessionID))
        const carry = shouldCarryGate(prior, fingerprint, true)
        // shouldCarryGate guarantees carry ⇒ prior is defined, so the
        // non-null assertion cannot fire; keep the predicate's contract
        // intact if it ever changes.
        if (carry) prior!.replayGrace = true
        ledger.resetState(sessionID)
        ledger.state(sessionID).taskFingerprint = fingerprint
        if (carry) journaler.journal({ type: "continuation", sessionID })
      } else {
        ledger.resetState(sessionID)
      }
      // A prompt reset invalidates all prior dispatch-scoped
      // evidence for this parent, so an unresolved-child verdict is only
      // plausible within the parent's current task scope.
      planReviewerDispatch.delete(sessionID)
      // Evidence is task-scoped, exactly like gate state: a new user
      // prompt drops the in-memory correlation.
      evidence.clear(sessionID)
      // A prompt reset also drops any pending plan-ask latch: the
      // escalation's stream event belongs to the previous task scope, so
      // a new prompt must not let a later unrelated ask be recorded as
      // the plan ask.
      awaitingPlanAsk.delete(sessionID)
      // A landing-ask arm (an enforce repeat-attempt escalation) belongs
      // to the previous task scope too: a new prompt drops it, so the new
      // task starts from a pure first block again.
      pendingLandingAsk.delete(sessionID)
      // Waiver capture (prompt channel): the user's text following the
      // waiver marker waives both gates for the whole task. Read + capture
      // in one guarded block; a coercion that throws (a malformed prompt
      // value) is journaled under the historical "waiver capture" key and
      // swallowed — fail-open.
      try {
        const waiverText = promptTextOf(properties)
        const at = waiverText.indexOf(config.waiverMarker)
        if (at !== -1) {
          ledger.state(sessionID).userWaiver = config.trace
            ? waiverText.slice(at, at + 200)
            : "<present>"
        }
      } catch (e) {
        // Fail-open: capture never blocks a prompt.
        journaler.journal({ type: "error", error: `waiver capture: ${e}` })
      }
      // Human approval (item 7): a `PLAN APPROVED:` marker in the user
      // prompt releases the plan gate — the same release signal the
      // plan-reviewer verdict sets. Read + capture in one guarded block:
      // set hasPlanVerdict (execute.before reads it) and humanApproval
      // (provenance), and journal an APPROVE entry that replays identically
      // to a verdict (replayGatePasses accepts any type:"plan" APPROVE;
      // mergeAfterReplay carries it). A coercion that throws is journaled
      // and swallowed — fail-open.
      try {
        const approvalText = promptTextOf(properties)
        const atPlan = approvalText.indexOf(config.approvalMarker)
        if (atPlan !== -1) {
          const s = ledger.state(sessionID)
          s.hasPlanVerdict = true
          s.humanApproval = true
          journaler.journal({
            type: "plan",
            sessionID,
            result: "APPROVE",
            // Provenance only: replay reads only type+result, so this
            // restores exactly like a VERDICT: APPROVE verdict.
            source: "session-prompt",
            marker: config.approvalMarker,
          })
        }
      } catch (e) {
        // Fail-open: approval capture never blocks a prompt.
        journaler.journal({ type: "error", error: `approval capture: ${e}` })
      }
      // Misconfiguration telemetry: if none of the three candidate text keys
      // (`text` / `prompt` / `prompt.text`) holds a non-empty string, the prompt
      // text is unresolvable (an empty `text` does not count — it cannot carry a
      // marker). Report the first such prompt once (keylessPrompts hits 1 exactly
      // once) so a host-shape change stays observable without journaling on every
      // prompt. An unreadable payload (a hostile getter) counts as unresolvable
      // and is swallowed — fail-open.
      let unresolvable: boolean
      try {
        unresolvable = promptTextOf(properties) === ""
      } catch {
        unresolvable = true
      }
      if (unresolvable) {
        keylessPrompts++
        if (keylessPrompts === 1)
          journaler.journal({
            type: "error",
            sessionID,
            error:
              "waiver capture: neither prompt text key (text|prompt|prompt.text) is a string; does the host send the user prompt elsewhere?",
          })
      }
    }

    // Task-state reset: a new user prompt starts a new task.
    if (typeof h.session?.hook === "function") {
      try {
        const reg = await h.session.hook("prompt", (properties: PromptHookProperties) => {
          // Count dispatches even when the session id is unusable; a zero
          // count when the inbox stream admits marks this surface as hook-less
          // (the dead-channel telemetry key).
          promptHookFires++
          const sessionID = properties?.sessionID
          if (typeof sessionID === "string") {
            // One prompt is admitted once across both transport paths, deduped
            // by the shared host message id ("" when the host sent none).
            admitPrompt(
              sessionID,
              properties,
              typeof properties.messageID === "string" ? properties.messageID : "",
            )
          }
        })
        track(reg, cleanups)
        hooks++
      } catch (e) {
        journaler.journal({ type: "error", error: `session.prompt hook registration: ${e}` })
      }

      // Decoding clamps + compaction context.
      try {
        const reg = await h.session.hook("generate", (draft: GenerateDraft) => {
          try {
            if (!draft) return
            const agent = typeof draft.agent === "string" ? draft.agent : ""
            if (agent === config.agents.reviewer || agent === config.agents.planReviewer) {
              // Force 0 even when the host sent no options object at all:
              // today's early return skipped the clamp in exactly that case.
              if (!draft.options) draft.options = {}
              draft.options.temperature = 0
            } else if (
              agent === config.agents.executor ||
              agent === config.agents.testRunner ||
              agent === config.agents.debugger
            ) {
              // Clamp also applies when the host sent no temperature: an
              // unset temperature is whatever the host defaults to, which
              // is exactly what the ≤ 0.2 contract bounds.
              if (!draft.options) draft.options = {}
              const t = draft.options.temperature
              draft.options.temperature = typeof t === "number" ? Math.min(t, 0.2) : 0.2
            }
          } catch (e) {
            journaler.journal({ type: "error", error: `generate hook: ${e}` })
          }
        })
        track(reg, cleanups)
        hooks++
      } catch (e) {
        journaler.journal({ type: "error", error: `session.generate hook registration: ${e}` })
      }

      try {
        const reg = await h.session.hook("compaction", (draft: CompactionDraft) => {
          try {
            if (!Array.isArray(draft?.system)) return
            draft.system.push({
              type: "text",
              text: "Preserve verbatim: open findings, AC status table, last GATE/VERDICT markers, current worktree/branch paths.",
            })
            // Inject the concrete gate state from the live ledger alongside the
            // instruction: key off the parent bucket (child compaction maps to
            // its parent, matching the read-counter keying rule). The compaction
            // payload is typed leniently, so a host that omits `sessionID` falls
            // back to the most-recently-admitted parent; both paths that yield no
            // bucket degrade to instruction-only (fail-open, no mint, no journal
            // spam). The snapshot is de-tokenized, so it never re-parses.
            const id = asSessionID(draft.sessionID)
            const s = ledger.peek(ledger.parentOf(id) || ledger.lastParent())
            if (s) draft.system.push({ type: "text", text: formatGateSnapshot(s) })
          } catch (e) {
            journaler.journal({ type: "error", error: `compaction hook: ${e}` })
          }
        })
        track(reg, cleanups)
        hooks++
      } catch (e) {
        journaler.journal({ type: "error", error: `session.compaction hook registration: ${e}` })
      }
    }

    // Permission escalation (Phase 1): on a `task` dispatch the host asks the
    // plugin to evaluate whether the call should proceed. The payload carries
    // NO tool input, so escalation is driven by the parent session's plan-gate
    // state (planGateStatus), never the dispatch target. Optional surface: an
    // absent permission.hook degrades to today's behavior exactly.
    if (typeof h.permission?.hook === "function") {
      try {
        const reg = await h.permission.hook("evaluate", (event: unknown) => {
          try {
            const pe = event as PermissionEvaluateEvent
            const sessionID = asSessionID(pe?.sessionID)
            // Plan-approval arm: the task/subagent dispatch exposes
            // `action === "task"`; the payload carries no tool input, so
            // escalation is driven purely by the parent's plan-gate state.
            if (pe?.action === "task") {
              const parent = ledger.parentOf(sessionID)
              const status = gates.planGateStatus(currentProjectDir(parent), ledger, parent)
              if (!status.red) return
              // Red ⇒ summary is present by construction (planGateStatus builds
              // it from a scan whose names[0] was already read). Escalate:
              // force the host to ask the human, naming the plan file + head.
              // Journal the ask so a reply can be matched (the requestID rides
              // the permission.asked stream event).
              const file = status.summary!.file
              // The plan body is prompt context; journal/quote it only when the
              // trace is enabled (SECURITY.md redaction contract), mirroring how
              // the waiver quote is trace-gated at capture. Without it the ask
              // still names the plan file.
              const head = config.trace ? status.summary!.head : ""
              pe.effect = "ask"
              pe.message = head
                ? `${PLAN_ASK_MESSAGE_PREFIX} — ${file}: ${head}`
                : `${PLAN_ASK_MESSAGE_PREFIX} — ${file}`
              // Mark this parent as awaiting its plan ask: the NEXT
              // permission.asked stream event for this session is recorded as
              // the plan-gate ask, so only escalated asks can ever match.
              awaitingPlanAsk.set(parent, Date.now())
              boundAwaitingAsks()
              journaler.journal({
                type: "permission",
                sessionID: parent,
                action: "ask",
                // The requestID is attached to the subsequent permission.asked
                // stream event (matched below by message prefix / latch).
                reason: "plan-gate",
                plan: file,
              })
              return
            }
            // Landing arm: a bash/shell permission.evaluate whose landing ask
            // is armed (the guard set the pending-landing-ask latch under
            // enforce on a repeat attempt). Candidate detection lives in
            // `isPushLanding` (used by the guard); the evaluate handler
            // consults the arm rather than re-reading the command from the
            // (host-shape-uncertain) permission event — the guard is the single
            // source of truth for landing-candidate detection. Approval
            // releases the gate; a live latch means the human must decide this
            // landing (the first block already threw, and shadow never arms).
            // The arm is ONE-SHOT: it is consumed by the first evaluate it
            // forces. The permission request the arm is meant to attach to is
            // the very next one (the repeat push the guard just allowed through
            // for escalation), so a one-shot latch cannot mislabel a later
            // unrelated command with the push/PR ask inside the TTL window.
            if (pe?.action === "bash" || pe?.action === "shell") {
              const parent = ledger.parentOf(sessionID)
              const st = ledger.state(parent)
              if (st.hasReviewApprove) return
              if (!hasLiveLandingAsk(parent)) return
              pendingLandingAsk.delete(parent)
              pe.effect = "ask"
              pe.message = `turnstile: ${LANDING_REQUIREMENT}`
              // No journal of the ask here: guardLanding already journaled
              // `{type:"permission", action:"ask", reason:"landing"}` when it
              // armed the latch, so there is a single landing-ask entry.
              return
            }
            return
          } catch (e) {
            // Fail-open: the evaluate handler NEVER blocks the host.
            journaler.journal({ type: "error", error: `permission evaluate: ${e}` })
          }
        })
        track(reg, cleanups)
        hooks++
      } catch (e) {
        // A registration failure journals (fail-open); a bad hook leaves
        // today's behavior exactly.
        journaler.journal({ type: "error", error: `permission.evaluate hook registration: ${e}` })
      }
    }

    // Tool-level gate + trace.
    if (typeof h.tool?.hook === "function") {
      try {
        const reg = await h.tool.hook("execute.before", async (event: ToolHookEvent) => {
          try {
            if (event?.tool === "task" || event?.tool === "subagent") {
              const agent = agentFromTaskInput(event.input)
              const sessionID = asSessionID(event?.sessionID)
              // Sessions dispatching guarded subagents are parents by
              // definition: mark before the guards so their
              // state() inserts land pinned against LRU eviction.
              ledger.markParent(sessionID)
              // Age out streamed delta windows: the next dispatch is the task
              // boundary, so stale fragments of the previous task's child text
              // must not leak into the new scope (mirrors the prompt-reset
              // pattern of evidence.clear).
              deltaWindows.clear()
              const prompt = String(event.input?.prompt ?? "")
              // Prompt descriptions can carry sensitive context; record them
              // only when the trace is enabled (redacted elsewhere — here it is
              // the single copy passed to the dispatch-recording helper).
              const description = config.trace
                ? String(event.input?.description ?? "").slice(0, 200)
                : ""

              // Last-wins: record this parent's LATEST plan-reviewer
              // dispatch time for the plausibility join. A prompt reset clears it
              // (see the prompt hook), so a verdict is only plausible within the
              // parent's current task scope. Bounded by boundDispatches.
              if (agent === config.agents.planReviewer) {
                planReviewerDispatch.set(sessionID, Date.now())
                boundDispatches()
              }

              // An empty agent name is the only reliable misconfiguration
              // signal: the host input shape no longer uses
              // subagent_type/agent/subagent, so every gate condition misses.
              // Telemetry only — journaling cannot throw.
              if (!agent)
                journaler.journal({
                  type: "error",
                  sessionID,
                  error:
                    "task dispatch: could not resolve the agent name; does the host input shape still use subagent_type/agent/subagent?",
                })

              // Guards-then-journal: the dispatch entry is recorded at guard
              // exit, so an allowed dispatch stays byte-identical while a
              // deliberate block carries `blocked:true` (audit distinguishes a
              // dispatched entry from a blocked-and-attempted one). The once-grant
              // consume is an allowed dispatch. Only a BlockError — the guard's
              // deliberate refusal — is stamped blocked and re-thrown for the
              // outer catch to turn into the BLOCKED error; any other throw is an
              // internal error that propagates un-stamped to the fail-open handler.
              try {
                // Per-leg loop caps + total-dispatch budget: every
                // task/subagent dispatch — executor, planner, plan-reviewer,
                // test-runner, reviewer, debugger, unknown — draws down the
                // budget here, so the global backstop holds even against
                // grant-released dispatches (grants release *authorization*, not
                // *budget*). Before the once-grant short-circuit: a blocked
                // dispatch must not consume the grant.
                gates.guardDispatchBudget(sessionID, ledger, agent)

                // Once-granted human approval (from a `permission.replied` reply)
                // grants exactly ONE EXECUTOR dispatch past the plan gate and is
                // cleared immediately, so a stale grant cannot outlive the single
                // dispatch it was given for, short-circuiting the plan-gate block
                // below. Scoped to the executor dispatch class: the grant exists
                // solely to release the plan-gate block, so any other agent
                // (reviewer, plan-reviewer, …) leaves it pending and still runs
                // its own guards (guardReviewerDispatch / …). execute.before
                // consults only hasPlanVerdict / pendingOnceGrant — never
                // humanApproval, which is provenance only.
                if (
                  agent === config.agents.executor &&
                  ledger.state(sessionID).pendingOnceGrant.plan !== ""
                ) {
                  // Consume the plan-gate once grant (a `permission.replied`
                  // `once`): clears just `.plan` so a landing `.landing` grant,
                  // if any, survives for the push it was given for.
                  ledger.state(sessionID).pendingOnceGrant.plan = ""
                  recordDispatch(sessionID, agent, description, false)
                  return
                }

                if (agent === config.agents.reviewer) {
                  gates.guardReviewerDispatch(sessionID, ledger)
                }

                if (agent === config.agents.executor) {
                  const dir = await resolveProjectDir(sessionID)
                  gates.enforcePlanApproval(sessionID, dir, ledger)
                  gates.enforceDecomposition(sessionID, prompt, dir)
                }
                recordDispatch(sessionID, agent, description, false)
              } catch (e) {
                // Only a deliberate BlockError is a real block; a non-BlockError
                // is an internal error that propagates un-stamped to the
                // fail-open outer handler (which journals it), so the dispatch
                // entry is never mislabeled as blocked.
                if (e instanceof BlockError) recordDispatch(sessionID, agent, description, true)
                throw e
              }
            }

            if (event?.tool === "read") {
              // Keyed off the parent session: a subagent's reads draw down the
              // parent's budget (AGENTS.md contract), not a per-child one.
              // Resolve the child→parent edge first so an in-flight child keys
              // the parent's budget, not its own; a still-unresolved child
              // self-keys and journals a bounded signal.
              gates.guardReadLimit(await readBudgetKey(asSessionID(event?.sessionID)), ledger)
            }

            // Tool-call denylist: bash/shell commands and write/edit
            // target paths are matched against the configured denylist. The
            // extraction coerces the unconfirmed host payload (candidate keys
            // documented on each guard); an empty result fails open with
            // misconfiguration telemetry. A block throws BlockError (rethrown by
            // the catch below); shadow journals only; off is a no-op.
            if (event?.tool === "bash" || event?.tool === "shell") {
              const command = event.input?.command ?? event.input?.cmd
              const sid = asSessionID(event?.sessionID)
              // Denylist first: `gh pr create|merge` is denied wholesale, so it
              // wins over the landing telemetry/gate below and the two journal
              // reasons stay disjoint.
              toolPolicy.guardBash(event.tool, command, sid)
              // Conventional-commit lint (fail-closed under enforce for
              // uninspectable forms; audit-only under shadow; silent under off).
              toolPolicy.guardCommitMessage(event.tool, command, sid)
              // Landing telemetry (always) then the reviewer-gated landing gate.
              const text = String(command ?? "")
              toolPolicy.observeLanding(sid, text)
              // The stateful ledger stays out of tool-policy: only a shaped
              // capability is handed over. `parent` is the parent session (a
              // subagent's bash draws on the parent's task scope) and `st` is
              // its bucket, so a still-unattributed child self-keys its own
              // fresh state.
              const parent = ledger.parentOf(sid)
              const st = ledger.state(parent)
              // Landing once-grant (from a `permission.replied` `once` for a
              // landing ask) releases exactly ONE push, consumed here, before
              // the gate decides, so a stale grant cannot outlive that single
              // dispatch. Scoped to landing candidates: a non-push bash command
              // leaves the grant pending (burning it on `git status` would
              // defeat the "single push" contract). Keyed per-reason
              // (`.landing`), so it can never be consumed by a plan-gate (task)
              // dispatch or vice versa.
              if (st.pendingOnceGrant.landing !== "" && isPushLanding(text)) {
                st.pendingOnceGrant.landing = ""
                return
              }
              toolPolicy.guardLanding(event.tool, text, sid, {
                hasApproval: () => st.hasReviewApprove,
                priorBlocks: () => st.landingBlocks,
                recordBlock: () => {
                  st.landingBlocks += 1
                },
                escalate: () => {
                  // Arm the pending-landing-ask latch: the evaluate handler
                  // forces the human ask off this latch. Called by guardLanding
                  // only under `enforce` on a repeat attempt (no approval,
                  // >= 1 prior block); fail-toward-strict — a host reject leaves
                  // approval absent, so the next attempt re-blocks and re-arms.
                  pendingLandingAsk.set(parent, Date.now())
                  boundLandingAsks()
                },
              })
              return
            }
            if (event?.tool === "write" || event?.tool === "edit") {
              toolPolicy.guardPath(
                event.tool,
                event.input?.filePath ?? event.input?.path,
                asSessionID(event?.sessionID),
              )
              return
            }
            if (event?.tool === "session_move") {
              // Telemetry only (never blocks): journal the dispatched move. The
              // target directory comes from the (unconfirmed) tool payload.
              const moveDir = (event.input as { directory?: unknown } | undefined)?.directory
              const sid = asSessionID(event?.sessionID)
              toolPolicy.observeSessionMove(sid, moveDir)
              // Invalidate the per-session directory cache unconditionally,
              // regardless of telemetry config: mechanics must not hide behind
              // it. The next enforcement re-resolves via session.get, which
              // reflects the completed move. A self-keyed dispatch has
              // parentOf(sid) === sid, so the second delete is a no-op there.
              sessionDirs.delete(sid)
              sessionDirs.delete(ledger.parentOf(sid))
              return
            }
          } catch (e) {
            if (e instanceof BlockError) throw e
            journaler.journal({ type: "error", error: `tool.execute.before: ${e}` })
          }
        })
        track(reg, cleanups)
        hooks++
      } catch (e) {
        journaler.journal({ type: "error", error: `tool.before hook registration: ${e}` })
      }

      try {
        const reg = await h.tool.hook("execute.after", async (event: ToolHookEvent) => {
          try {
            if (event?.tool === "task" || event?.tool === "subagent") {
              const output = String(event.result?.output ?? "")
              const child = asSessionID(event?.sessionID)
              const agent =
                agentFromTaskInput(event.input) ||
                agentFromTaskInput(event.result?.input as TaskInput | undefined)
              // Delivery seed: the always-firing emitter-authority source. The
              // agent is resolved from dispatch input here, so a legitimate
              // child's markers land authoritatively even when every streaming
              // seed failed (fail-closed at streaming, authoritative at delivery).
              seedEmitter(child, agent)
              // Plan-reviewer delivery path only: await the child→parent edge
              // before marker parsing and attribution, so a continued subagent
              // session (no new session.created; edge resolved via session.get)
              // still attributes. Every other agent keeps today's byte-identical
              // sync ordering.
              if (agent === config.agents.planReviewer) {
                await resolveParent(child)
              }
              // Mark the resolved parent live: covers both host
              // delivery shapes (parent-keyed and child-keyed). A genuinely
              // unresolved child delivery self-marks, protecting one extra
              // bucket until the registry LRU ages it out — bounded, documented.
              ledger.markParent(ledger.parentOf(child))
              const markerEvents = parseMarkers(
                output,
                child,
                "task-result",
                `task-result\u0000${++taskDeliverySeq}`,
              )
              // Reviewer-APPROVE capture (landing gate): a reviewer
              // task-result delivery whose first-sight verdict is APPROVE sets
              // hasReviewApprove — the landing gate's release signal. Mirrors
              // the plan-reviewer verdict lifecycle but for the landing gate.
              // Streaming child text does NOT set it: this branch runs only on
              // task-result delivery, keeping the stream attribution-neutral
              // (a streamed verdict in child text can't release the landing
              // gate).
              if (agent === config.agents.reviewer) {
                const approved = markerEvents.some(
                  (e) => e.kind === "verdict" && e.marker.includes("APPROVE"),
                )
                if (approved) {
                  // Under reviewEnsemble:enforce the review is credited only
                  // once two unwaived reviewer dispatches were counted this
                  // task; an incomplete ensemble journals the refusal (and a
                  // suppressed-credit stamp) and leaves the landing gate red.
                  const parent = ledger.parentOf(child)
                  if (gates.reviewEnsembleComplete(parent, ledger))
                    ledger.state(parent).hasReviewApprove = true
                }
              }
              // Plan-approval attribution: only a plan-reviewer result moves
              // the plan gate. See attributePlanVerdict — `raw` is always an
              // actual child session ID, never the parent; an unattributable,
              // marker-less parent-keyed re-fire journals type:"error" and
              // leaves the gate untouched (never clobbers a live approval).
              if (agent === config.agents.planReviewer) {
                await attributePlanVerdict(child, output)
              }
              // The bare-output suppression — a streamed verdict in the
              // child's own text hiding a summarized, marker-less delivery —
              // is scoped to the plan-reviewer only. reviewer/test-runner keep
              // their pre-suppression behavior: a marker-less delivery
              // violates even when the child's streamed text quoted a VERDICT.
              const bare =
                config.agents.bareOutput.includes(agent) &&
                output !== "" &&
                !hasMarker(output) &&
                (agent !== config.agents.planReviewer || ledger.childVerdict(child).marker === "")
              if (bare) {
                journaler.journal({
                  type: "violation",
                  sessionID: child,
                  agent,
                  reason: "task output contained no GATE/VERDICT marker",
                })
              }
              // Orchestrator policy injection: prepend
              // the policy to the model-facing output text on the first
              // per-parent per-task delivery, so the model always carries the
              // pipeline contract. Scoped three ways: tool name (task/subagent
              // only), config-known subagent name (children dispatch under
              // their own name — defense in depth), and the policyInjected
              // flag (once per task; reset per prompt re-supplies it, also
              // after compaction). The mutation target is event.result.output
              // in place — the same production-proven target as the read-budget
              // warn prefix below. Fail-open via an inner try/catch scoped to
              // ONLY this phase; the handler's shared outer catch (marker
              // parsing, plan attribution, read-warn) is intentionally not
              // disturbed, so a policy failure journals injected:false and
              // swallows rather than blocking the tool.
              const subagentNames = new Set(
                (
                  [
                    "reviewer",
                    "planReviewer",
                    "executor",
                    "testRunner",
                    "debugger",
                    "planner",
                  ] as const
                ).map((name) => config.agents[name]),
              )
              if (typeof event.agent === "string" && subagentNames.has(event.agent)) return
              const policyState = ledger.state(child)
              if (policyState.policyInjected) return
              // A string result is the confirmed task/subagent shape; any other
              // shape fails open silently (no corruption, no journal entry).
              if (!event.result || typeof event.result.output !== "string") return
              try {
                event.result.output = ORCHESTRATOR_POLICY + "\n" + event.result.output
                policyState.policyInjected = true
                journaler.journal({ type: "policy", sessionID: child, injected: true })
              } catch (e) {
                journaler.journal({
                  type: "policy",
                  sessionID: child,
                  injected: false,
                  error: String(e),
                })
              }
              return
            }
            if (event?.tool === "read") {
              // Same parent keying as the guard: count and budget stay in
              // step regardless of which session ID the host reports. The
              // increment happens atomically in the before-hook (guardReadLimit);
              // this after-hook journals the running count and corrects it down
              // when the read did not produce a string output (a non-string
              // result never consumed budget).
              const sessionID = ledger.parentOf(asSessionID(event?.sessionID))
              const s = ledger.state(sessionID)
              // The before-hook already incremented; a read that did not produce
              // a string output never consumed budget — correct the charge down
              // (floor 0).
              if (typeof event.result?.output !== "string" && s.reads > 0) s.reads--
              journaler.journal({ type: "tool", sessionID, tool: "read", reads: s.reads })
              if (
                s.reads === config.readWarn &&
                event.result &&
                typeof event.result.output === "string"
              ) {
                event.result.output =
                  `[turnstile] Warning: ${config.readWarn} whole-file reads this session; prefer grep/glob. Blocks at ${config.readBlock}.\n` +
                  event.result.output
              }
              return
            }
            if (event?.tool === "bash" || event?.tool === "shell") {
              const meta = event.result?.metadata ?? {}
              journaler.journal({
                type: "tool",
                sessionID: asSessionID(event?.sessionID),
                tool: "bash",
                // Shell commands can contain secrets; record them only when
                // the trace is enabled.
                command: config.trace
                  ? String(
                      event.input?.command ?? event.input?.cmd ?? event.result?.title ?? "",
                    ).slice(0, 500)
                  : "<redacted>",
                exit: meta.exit ?? meta.exitCode ?? meta.code,
              })
              // Evidence correlation: record a plausible exit-0
              // test execution and promote an earlier unverified PASS the
              // moment its evidence arrives, within the same task lifetime.
              // No command text ever leaves memory (redaction contract).
              if (config.gateEvidence !== "off") {
                const obsSid = asSessionID(event?.sessionID)
                const exit = meta.exit ?? meta.exitCode ?? meta.code
                if (
                  evidence.observe(
                    obsSid,
                    event.input?.command ?? event.input?.cmd ?? event.result?.title ?? "",
                    exit,
                  )
                ) {
                  journaler.journal({
                    type: "evidence",
                    sessionID: obsSid,
                    event: "observed",
                    exit,
                  })
                }
                const parent = ledger.parentOf(obsSid)
                // Peek, don't insert: a fresh bucket can never carry a
                // non-empty `unverifiedPass`, so unknown bash sessions must
                // not enter the LRU (behavior-preserving guard).
                const ps = ledger.peek(parent)
                if (ps && ps.unverifiedPass && evidence.has(parent)) {
                  ps.hasGatePass = true
                  ps.unverifiedPass = ""
                  journaler.journal({
                    type: "gate",
                    sessionID: parent,
                    result: "PASS",
                    event: "promoted",
                    verified: true,
                    mode: config.gateEvidence,
                  })
                  journaler.traceEvent(
                    "test-runner",
                    "gate",
                    "GATE: PASS promoted on evidence",
                    parent,
                  )
                }
              }
            }
          } catch (e) {
            // execute.after performs no gating, so nothing here can throw a
            // BlockError; every failure is journaled and the call proceeds.
            journaler.journal({ type: "error", error: `tool.execute.after: ${e}` })
          }
        })
        track(reg, cleanups)
        hooks++
      } catch (e) {
        journaler.journal({ type: "error", error: `tool.after hook registration: ${e}` })
      }
    }

    // Event mirror: child→parent resolution, marker parsing from child
    // sessions (primary path if task results are summarized), errors.
    if (typeof h.event?.subscribe === "function") {
      const subscribe = h.event.subscribe
      const controller = new AbortController()

      /**
       * Consumes the host event stream until aborted, dispatching each
       * event type to its handler. Per-event failures are journaled, never
       * fatal to the stream. Fragmented `session.text.delta` markers are
       * recovered by the per-session sliding window (see the delta case).
       */
      const consume = async (): Promise<void> => {
        for await (const event of subscribe({ signal: controller.signal })) {
          try {
            const properties: EventProperties = event.data ?? event.properties ?? {}
            switch (event.type) {
              case "session.created": {
                const sid = typeof properties.sessionID === "string" ? properties.sessionID : ""
                if (sid) {
                  const agent = typeof properties.agent === "string" ? properties.agent : ""
                  if (typeof properties.parentID === "string") {
                    ledger.setParent(sid, properties.parentID)
                  } else {
                    // Root sessions are live parents; the edge branch above is
                    // covered by setParent marking the parent.
                    ledger.markParent(sid)
                    // Root sessions only: child-session created events must not
                    // move the project dir (any directory they carry belongs to
                    // the parent's context, and last-writer-wins across child
                    // events would point the plans scan at the wrong place).
                    if (typeof properties.location?.directory === "string")
                      projectDir = properties.location.directory
                    else if (typeof properties.directory === "string")
                      projectDir = properties.directory
                    // Seed the per-session directory cache beside the seed
                    // assignment so the continuation carry and the sync consumers
                    // read this root session's directory from the cache.
                    sessionDirs.set(sid, projectDir)
                    boundSessionDirs()
                  }
                  // Redundant emitter seed from the created event's agent: this
                  // fires with or without the edge, so a child that streams a
                  // marker before its edge lands (or an unresolved child) still
                  // seeds the authority cache; a genuine delivery remains the
                  // always-firing seed (see seedEmitter).
                  seedEmitter(sid, agent)
                }
                break
              }
              case "message.part.updated": {
                const part = properties.part ?? properties
                const partSession = asSessionID(properties.sessionID ?? part?.sessionID)
                if (part?.type === "text" && typeof part.text === "string" && partSession) {
                  await resolveParent(partSession)
                  parseMarkers(part.text, partSession, "child-message")
                }
                break
              }
              case "session.text.ended": {
                const sid = properties.sessionID
                const text = properties.text
                if (typeof sid === "string" && typeof text === "string") {
                  await resolveParent(sid)
                  parseMarkers(text, sid, "child-text")
                }
                break
              }
              case "session.text.delta": {
                const sid = properties.sessionID
                const delta = properties.delta
                if (typeof sid === "string" && typeof delta === "string") {
                  // Reassemble a possibly-split marker: fold this delta into the
                  // session's sliding window (tail-bounded) and re-parse it. The
                  // shared-empty dedup scope suppresses every re-fire, so only a
                  // newly completed marker across chunks is first-sighted.
                  const window = ((deltaWindows.get(sid) ?? "") + delta).slice(-maxDeltaWindowChars)
                  deltaWindows.set(sid, window)
                  boundDeltaWindows()
                  await resolveParent(sid)
                  // Parse from the map, not the local fold: a task dispatch that
                  // interleaves during the await clears the window (the task
                  // boundary), and a stale local string would complete a marker
                  // that the clear was meant to drop.
                  const pending = deltaWindows.get(sid)
                  if (pending === window) parseMarkers(window, sid, "child-text-delta")
                }
                break
              }
              case "session.error": {
                journaler.journal({
                  type: "error",
                  sessionID: properties.sessionID,
                  error: String(properties.error ?? "").slice(0, 500),
                })
                break
              }
              case "permission.asked": {
                // Record plan-gate AND landing-gate asks (disjoint by message
                // prefix). The value carries the ask's parent session so
                // replies apply per-session and concurrent sessions cannot
                // cross-apply. Fail-open — the outer loop journals any throw —
                // and a missing/non-string id is inert (nothing is recorded).
                const id = properties.id ?? properties.requestID
                if (typeof id === "string" && id !== "") {
                  const sid = asSessionID(properties.sessionID)
                  const message = typeof properties.message === "string" ? properties.message : ""
                  // Landing-gate ask: message carries the landing-ask prefix
                  // (the evaluate handler's echo). A landing ask is disjoint from
                  // a plan ask (different prefix), so an approval of one never
                  // releases the other.
                  if (message.startsWith(LANDING_ASK_MESSAGE_PREFIX)) {
                    landingGateAsks.set(id, {
                      sessionID: ledger.parentOf(sid),
                      recordedAt: Date.now(),
                    })
                    boundLandingGateAsks()
                  } else {
                    // Plan-gate ask: record when the message carries the
                    // plan-ask prefix (the evaluate echo) or when the session
                    // is live-latched and the ask carries no message of its own
                    // (the escalated echo). A non-empty message WITHOUT either
                    // prefix is an unrelated ask (bash, write, …) even under a
                    // latched escalation — the evaluate handler always composes
                    // a prefix into its message, so a prefixed-or-empty message
                    // is the expected echo and anything else must never be
                    // recorded (a human's approval of an unrelated ask cannot
                    // release the plan or landing gate).
                    const prefixed = message.startsWith(PLAN_ASK_MESSAGE_PREFIX)
                    if (prefixed || (message === "" && hasLiveAwaitingAsk(sid))) {
                      awaitingPlanAsk.delete(sid)
                      planGateAsks.set(id, {
                        sessionID: ledger.parentOf(sid),
                        recordedAt: Date.now(),
                      })
                      boundPlanAsks()
                    } else if (message === "" && hasLiveLandingAsk(sid)) {
                      // Empty-message landing escalate echo: record for the
                      // landing gate only. Reached only when the plan latch is
                      // NOT live — a coincident double-escalation (both latches
                      // live, one empty-message echo) resolves to the plan gate
                      // by branch order, a documented edge: the human still
                      // sees one ask, and the other latch survives for its own
                      // prefixed echo.
                      landingGateAsks.set(id, {
                        sessionID: ledger.parentOf(sid),
                        recordedAt: Date.now(),
                      })
                      boundLandingGateAsks()
                    }
                  }
                }
                break
              }
              case "permission.replied": {
                // Match the reply against RECORDED plan-gate asks only: a
                // Match the reply against RECORDED asks: plan-gate ask (keyed
                // by requestID, consumed once, releases/holds the plan gate)
                // OR landing-gate ask (consumed once, grants/holds a push). A
                // requestID absent from both maps was never an ask we raised, so
                // the reply is inert — an approval of an unrelated permission
                // ask cannot release either gate. Fail-open: the outer loop
                // journals any throw.
                const rid = String(properties.requestID ?? "")
                const reply = properties.reply
                const planRecord = planGateAsks.get(rid)
                if (planRecord) {
                  planGateAsks.delete(rid)
                  const parent = planRecord.sessionID
                  const s = ledger.state(parent)
                  if (reply === "always") {
                    // A standing human approval releases the plan gate for the
                    // rest of the task and records provenance.
                    s.humanApproval = true
                    s.hasPlanVerdict = true
                    journaler.journal({ type: "permission", sessionID: parent, decision: "always" })
                  } else if (reply === "once") {
                    // A plan-gate single-dispatch grant: consumed by exactly one
                    // executor dispatch in execute.before (the .plan
                    // short-circuit), so a stale grant cannot outlive that
                    // single dispatch.
                    s.pendingOnceGrant.plan = rid
                    journaler.journal({ type: "permission", sessionID: parent, decision: "once" })
                  } else {
                    // reject (or any non-allow reply) leaves the gate red: the
                    // next execute.before dispatch re-blocks.
                    journaler.journal({ type: "permission", sessionID: parent, decision: "reject" })
                  }
                } else if (landingGateAsks.get(rid)) {
                  const landingRecord = landingGateAsks.get(rid)
                  landingGateAsks.delete(rid)
                  const parent = landingRecord!.sessionID
                  const s = ledger.state(parent)
                  if (reply === "always") {
                    // A standing human approval releases the landing gate for
                    // the rest of the task (the bash guard sees hasReviewApprove
                    // and allows every push). A human release outranks the
                    // ensemble, so clear any refusal stamp on the last ensemble
                    // entry: replay restores the human release (refusedApprove
                    // absent/false) rather than an earlier refused APPROVE.
                    s.hasReviewApprove = true
                    journaler.journal({
                      type: "ensemble",
                      sessionID: parent,
                      agent: config.agents.reviewer,
                      count: s.reviewerDispatches,
                      refusedApprove: false,
                    })
                    journaler.journal({ type: "permission", sessionID: parent, decision: "always" })
                  } else if (reply === "once") {
                    // A landing-gate single-dispatch push grant: consumed by
                    // exactly one bash dispatch in execute.before (the
                    // .landing short-circuit), so a stale grant cannot outlive
                    // that single push.
                    s.pendingOnceGrant.landing = rid
                    journaler.journal({ type: "permission", sessionID: parent, decision: "once" })
                  } else {
                    // reject (or any non-allow reply) leaves the gate red: the
                    // next execute.before push re-blocks and re-arms the ask.
                    journaler.journal({ type: "permission", sessionID: parent, decision: "reject" })
                  }
                }
                break
              }
              case "session.inbox.enqueued": {
                // Prompt admission via the inbox stream — the transport adopted
                // because its publication is exact host-admission parity: the
                // host publishes it inside its own admit region, immediately after
                // the prompt hook fires. A user-authored prompt (type "user")
                // carrying non-empty text is admitted; agent/composition arrivals
                // (synthetic / compaction / move) never carry a user prompt, so
                // they stay inert (provenance invariant). The inbox id dedupes
                // against the hook path on the shared host message id. Fail-open:
                // the outer loop journals any throw. `delivered`/`cancelled` are
                // intentionally unhandled — the captured admission point is the
                // host's own publish, and a later drain or cancel cannot
                // retroactively un-admit it.
                const sid = properties.sessionID
                const inboxID = properties.inboxID
                const item = properties.item
                const text = item?.payload?.text
                if (
                  typeof sid === "string" &&
                  typeof inboxID === "string" &&
                  item?.type === "user" &&
                  typeof text === "string" &&
                  text !== ""
                ) {
                  admitPrompt(sid, { sessionID: sid, text }, inboxID)
                }
                break
              }
              default:
                break
            }
          } catch (e) {
            journaler.journal({ type: "error", error: `event ${event.type}: ${e}` })
          }
        }
        // A normal completion (closed stream) is a silent death mode; an
        // abort/detach exit stays silent. Telemetry only.
        if (!controller.signal.aborted)
          journaler.journal({ type: "error", error: "event stream ended" })
      }
      /**
       * Bounds consume() re-subscriptions on any non-abort exit so a broken
       * event stream disables (rather than silently exits) marker ingestion
       * after a small cumulative budget. A thrown subscription journals one
       * `event subscription:` entry per death; after the budget is spent the
       * terminal disablement journals and the loop stops re-subscribing (no
       * more session.text.* ingestion). A throw while aborted (dispose) stays
       * silent, matching the pre-existing .catch semantics.
       */
      const maxStreamRestarts = 5
      let streamRestarts = 0
      const supervise = async (): Promise<void> => {
        for (;;) {
          try {
            await consume()
          } catch (e) {
            if (!controller.signal.aborted)
              journaler.journal({ type: "error", error: `event subscription: ${e}` })
          }
          if (controller.signal.aborted) return
          streamRestarts++
          if (streamRestarts <= maxStreamRestarts) continue
          journaler.journal({
            type: "error",
            error:
              "event stream restart budget exhausted; session.text.* marker ingestion is disabled",
          })
          return
        }
      }
      const consuming = supervise()
      cleanups.push(() => {
        controller.abort()
        void consuming
      })
      hooks++
    }

    // Load heartbeat: one entry per host-session boot, emitted after every
    // registration so `hooks` is accurate. Telemetry only — it never blocks.
    journaler.journal({
      type: "setup",
      version,
      digest: configDigest(config),
      hooks,
      ...(config.trace
        ? { trace: true, agents: config.agents, metricsDir: config.metricsDir }
        : {}),
    })

    /**
     * Disposes every hook registration tracked during setup.
     * @returns Nothing; individual dispose failures are inert.
     */
    return () => {
      for (const fn of cleanups) {
        try {
          fn()
        } catch {
          // dispose failures are inert
        }
      }
    }
  }
}
