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

import { loadConfig } from "./config.ts"
import { createJournaler, type Journaler } from "./journal.ts"
import {
  agentFromTaskInput,
  compileMarkerRegex,
  parseGateMarkers,
  GATE_RE,
  VERDICT_RE,
} from "./markers.ts"
import { BlockError, createGates, type Gates } from "./gates.ts"
import { createLedger, type GateLedger } from "./state.ts"
import type {
  CompactionDraft,
  EventProperties,
  GenerateDraft,
  Host,
  PromptHookProperties,
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
  const journaler: Journaler = createJournaler({
    metricsDir: config.metricsDir,
    trace: config.trace,
    maxBytes: config.journalMaxBytes,
    maxGenerations: config.journalMaxGenerations,
  })
  // Config warnings are already journaled by config.ts (the pre-journaler
  // sink); journaling them here too would double-write every entry.
  const gateRe = compileMarkerRegex(config.gateMarker, GATE_RE)
  const verdictRe = compileMarkerRegex(config.verdictMarker, VERDICT_RE)

  /**
   * True when the text contains at least one GATE or VERDICT marker per the
   * compiled config regexes. Uses `String.match`, so the `g` flag's
   * `lastIndex` state is not an issue; scans the whole output (no window).
   * @param text The output text to scan.
   */
  function hasMarker(text: string): boolean {
    return (text.match(gateRe)?.length ?? 0) > 0 || (text.match(verdictRe)?.length ?? 0) > 0
  }
  const ledger: GateLedger = createLedger(journaler.journalPath, config.maxSessions)
  const gates: Gates = createGates(config, journaler)
  let projectDir: string = process.cwd()
  // Per-delivery dedup scope counter: each task result is a distinct
  // delivery, so a re-run emitting a byte-identical marker is still
  // journaled; streaming sources share the empty scope (re-delivery dedup).
  let taskDeliverySeq = 0

  /**
   * Parses markers out of assistant text and journals first-sight events.
   * @param text The assistant text to scan.
   * @param sessionID The raw (possibly child) session ID.
   * @param source Provenance label for the text in journal entries.
   * @param dedupScope Key prefix partitioning the marker dedup set.
   */
  function parseMarkers(
    text: string,
    sessionID: string | undefined,
    source: string,
    dedupScope = "",
  ): void {
    if (!text) return
    const sid = ledger.parentOf(sessionID)
    if (!sid) return
    const s = ledger.state(sid)
    for (const event of parseGateMarkers(s, text, gateRe, verdictRe, dedupScope)) {
      const suppressed = event.suppressed > 0 ? { suppressed: event.suppressed } : {}
      if (event.kind === "gate") {
        // Keyed by parent session so journal replay restores state where the
        // reviewer gate looks it up; raw child ID kept for forensics.
        journaler.journal({
          type: "gate",
          sessionID: sid,
          raw: sessionID,
          result: event.result,
          source,
          marker: event.marker,
          ...suppressed,
        })
        journaler.traceEvent("test-runner", "gate", event.marker)
      } else {
        journaler.journal({
          type: "verdict",
          sessionID: sid,
          raw: sessionID,
          marker: event.marker,
          rounds: event.rounds,
          source,
          ...suppressed,
        })
        journaler.traceEvent("reviewer", "verdict", event.marker)
      }
    }
  }

  /**
   * The plugin setup function handed to the host: registers the session,
   * tool, and event hooks, and returns a disposer that unwinds them all.
   * @param h The live OpenCode host context.
   * @returns A disposer that disposes every registration; failures inert.
   */
  return async function setup(h: Host): Promise<(() => void) | void> {
    const cleanups: Array<() => void> = []

    // Parent-lookup bookkeeping, keyed by child session ID. Values are
    // attempts made; capped so long-lived hosts cannot grow it unboundedly.
    const failedLookups = new Map<string, number>()
    // A thrown lookup may mean the child record is not yet visible to the
    // host API, so failures are retried up to this many times per session.
    const maxLookupAttempts = 3
    // Bound on tracked sessions: evict oldest (insertion order) when past.
    const maxTrackedLookups = 256

    /**
     * Bounds the failed-lookup map by evicting its oldest entries.
     */
    function boundLookups(): void {
      while (failedLookups.size > maxTrackedLookups) {
        const oldest = failedLookups.keys().next()
        if (oldest.done) break
        failedLookups.delete(oldest.value)
      }
    }

    /**
     * Resolves and caches the parent of a child session via the host API.
     * Parent-less records are negatively cached (a stable signal: the
     * session exists and has no parent edge); thrown lookups are retried
     * up to `maxLookupAttempts` because the record may appear later.
     * Without a usable edge the caller falls back to keying by the session
     * itself.
     * @param sessionID Child session ID to resolve.
     */
    async function resolveParent(sessionID: string | undefined): Promise<void> {
      if (!sessionID || ledger.childToParent.has(sessionID)) return
      const attempts = failedLookups.get(sessionID) ?? 0
      if (attempts >= maxLookupAttempts) return
      const get = h.session?.get
      if (typeof get !== "function") return
      try {
        const rec = await get({ sessionID })
        const parentID = rec?.parentID ?? rec?.data?.parentID
        if (typeof parentID === "string") {
          ledger.setParent(sessionID, parentID)
          failedLookups.delete(sessionID)
        } else {
          failedLookups.set(sessionID, maxLookupAttempts)
          boundLookups()
        }
      } catch {
        // lookup failure: retryable; fall back to keying by the session
        // itself until the record becomes visible or attempts run out
        failedLookups.set(sessionID, attempts + 1)
        boundLookups()
      }
    }

    // Task-state reset: a new user prompt starts a new task.
    if (typeof h.session?.hook === "function") {
      try {
        const reg = await h.session.hook("prompt", (properties: PromptHookProperties) => {
          const sessionID = properties?.sessionID
          if (typeof sessionID === "string") ledger.resetState(sessionID)
        })
        track(reg, cleanups)
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
      } catch (e) {
        journaler.journal({ type: "error", error: `session.generate hook registration: ${e}` })
      }

      try {
        const reg = await h.session.hook("compaction", (draft: CompactionDraft) => {
          try {
            if (Array.isArray(draft?.system)) {
              draft.system.push({
                type: "text",
                text: "Preserve verbatim: open findings, AC status table, last GATE/VERDICT markers, current worktree/branch paths.",
              })
            }
          } catch (e) {
            journaler.journal({ type: "error", error: `compaction hook: ${e}` })
          }
        })
        track(reg, cleanups)
      } catch (e) {
        journaler.journal({ type: "error", error: `session.compaction hook registration: ${e}` })
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
              const prompt = String(event.input?.prompt ?? "")
              journaler.journal({
                type: "dispatch",
                sessionID,
                agent,
                // Prompt descriptions can carry sensitive context; record
                // them only when the trace is enabled.
                description: config.trace
                  ? String(event.input?.description ?? "").slice(0, 200)
                  : "",
              })
              journaler.traceEvent("orchestrator", "dispatch", `task -> ${agent}`)

              if (agent === config.agents.reviewer) {
                gates.guardReviewerDispatch(sessionID, prompt, ledger)
              }

              if (agent === config.agents.executor) {
                gates.enforcePlanApproval(sessionID, prompt, projectDir, ledger)
                gates.enforceDecomposition(sessionID, prompt, projectDir)
              }
              return
            }

            if (event?.tool === "read") {
              // Keyed off the parent session: a subagent's reads draw down
              // the parent's budget (AGENTS.md contract), not a per-child one.
              gates.guardReadLimit(ledger.parentOf(asSessionID(event?.sessionID)), ledger)
            }
          } catch (e) {
            if (e instanceof BlockError) throw e
            journaler.journal({ type: "error", error: `tool.execute.before: ${e}` })
          }
        })
        track(reg, cleanups)
      } catch (e) {
        journaler.journal({ type: "error", error: `tool.before hook registration: ${e}` })
      }

      try {
        const reg = await h.tool.hook("execute.after", async (event: ToolHookEvent) => {
          try {
            if (event?.tool === "task" || event?.tool === "subagent") {
              const output = String(event.result?.output ?? "")
              parseMarkers(
                output,
                asSessionID(event?.sessionID),
                "task-result",
                `task-result\u0000${++taskDeliverySeq}`,
              )
              const agent =
                agentFromTaskInput(event.input) ||
                agentFromTaskInput(event.result?.input as TaskInput | undefined)
              // Plan-approval attribution: only a plan-reviewer result moves
              // the plan gate. Latest verdict wins; a BLOCK or marker-less
              // result keeps the gate red. Keyed by parent session like the
              // other gate state.
              if (agent === config.agents.planReviewer) {
                const sid = ledger.parentOf(asSessionID(event?.sessionID))
                const s = ledger.state(sid)
                const verdicts = output.match(verdictRe) ?? []
                const marker = verdicts[verdicts.length - 1] ?? ""
                const result = marker.includes("APPROVE") ? "APPROVE" : "BLOCK"
                s.hasPlanVerdict = result === "APPROVE"
                journaler.journal({
                  type: "plan",
                  sessionID: sid,
                  raw: asSessionID(event?.sessionID),
                  result,
                  marker: marker || "<none>",
                  source: "task-result",
                })
                journaler.traceEvent("plan-reviewer", "verdict", marker || "<no verdict marker>")
              }
              const bare =
                config.agents.bareOutput.includes(agent) && output !== "" && !hasMarker(output)
              if (bare) {
                journaler.journal({
                  type: "violation",
                  sessionID: asSessionID(event?.sessionID),
                  agent,
                  reason: "task output contained no GATE/VERDICT marker",
                })
              }
              return
            }
            if (event?.tool === "read") {
              // Same parent keying as the guard: count and budget stay in
              // step regardless of which session ID the host reports.
              const sessionID = ledger.parentOf(asSessionID(event?.sessionID))
              const s = ledger.state(sessionID)
              s.reads++
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
            }
          } catch (e) {
            if (e instanceof BlockError) throw e
            journaler.journal({ type: "error", error: `tool.execute.after: ${e}` })
          }
        })
        track(reg, cleanups)
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
       * fatal to the stream.
       */
      const consume = async (): Promise<void> => {
        for await (const event of subscribe({ signal: controller.signal })) {
          try {
            const properties: EventProperties = event.data ?? event.properties ?? {}
            switch (event.type) {
              case "session.created": {
                if (
                  typeof properties.sessionID === "string" &&
                  typeof properties.parentID === "string"
                ) {
                  ledger.setParent(properties.sessionID, properties.parentID)
                } else if (typeof properties.sessionID === "string") {
                  // Root sessions only: child-session created events must not
                  // move the project dir (any directory they carry belongs to
                  // the parent's context, and last-writer-wins across child
                  // events would point the plans scan at the wrong place).
                  if (typeof properties.location?.directory === "string")
                    projectDir = properties.location.directory
                  else if (typeof properties.directory === "string")
                    projectDir = properties.directory
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
                  await resolveParent(sid)
                  parseMarkers(delta, sid, "child-text-delta")
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
              default:
                break
            }
          } catch (e) {
            journaler.journal({ type: "error", error: `event ${event.type}: ${e}` })
          }
        }
      }
      const consuming = consume().catch((e: unknown) => {
        if (!controller.signal.aborted)
          journaler.journal({ type: "error", error: `event subscription: ${e}` })
      })
      cleanups.push(() => {
        controller.abort()
        void consuming
      })
    }

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
