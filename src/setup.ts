/**
 * @fileoverview Host-wiring boundary: registers turnstile's hooks with the
 * OpenCode v2 host and owns the plugin lifecycle: hook registration, the
 * stream-event loop, and cleanup. Shared state and services are built by
 * src/hooks-core.ts and consumed through the per-setup context; enforcement
 * decisions delegate to src/gates.ts; marker parsing to src/markers.ts;
 * persistence to src/journal.ts; bookkeeping to src/state.ts.
 *
 * Fail-open by contract: every hook body is guarded; only the deliberate
 * BLOCKED errors thrown by the gate layer propagate to the host.
 */

import * as fs from "node:fs"
import * as path from "node:path"
import { fileURLToPath } from "node:url"

import { configDigest } from "./config.ts"
import { agentFromTaskInput } from "./markers.ts"
import { BlockError } from "./gates.ts"
import { createHooksCore } from "./hooks-core.ts"
import { createPermissionHooks } from "./hooks-permission.ts"
import { createSessionHooks } from "./hooks-session.ts"
import {
  asSessionID,
  classifyDelivery,
  readRecordString,
  DIRECTORY_KEYS,
  LANDING_ASK_MESSAGE_PREFIX,
  PLAN_ASK_MESSAGE_PREFIX,
} from "./delivery.ts"
import type { EventProperties, Host, TaskInput, ToolHookEvent, TurnstileOptions } from "./types.ts"

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
 * Builds the turnstile plugin for a host: each setup call builds its own
 * shared context via createHooksCore (config, journaler, gates, ledger,
 * maps, services), then returns the async setup function that registers
 * every hook. All shared state is per-setup: a host calling setup() twice
 * gets fresh dedupe/metering state; the one-setup-per-load lifecycle makes
 * this unobservable.
 * @param _host The host context; unused at build time (hooks receive the
 *     live host at setup). Kept for factory-shape compatibility.
 * @param opts Injected config/env overrides (tests); defaults to env.
 * @returns The plugin setup function; resolves to a cleanup disposer.
 */
export function createTurnstile(
  _host: Host | undefined | null,
  opts: TurnstileOptions = {},
): (h: Host) => Promise<(() => void) | void> {
  // Version is read once here (fail-open, alongside the shared context build) for the
  // load heartbeat; null on exotic installs where package.json is unreadable.
  const version = readPluginVersion()

  /**
   * The plugin setup function handed to the host: registers the session,
   * tool, and event hooks, and returns a disposer that unwinds them all.
   * @param h The live OpenCode host context.
   * @returns A disposer that disposes every registration; failures inert.
   */
  return async function setup(h: Host): Promise<(() => void) | void> {
    const ctx = createHooksCore(opts)

    // Bind the host session API for the shared `resolveParent` helper (hooks
    // already fire post-setup).
    ctx.bindHost(h.session)
    const cleanups: Array<() => void> = []
    // Count of successfully registered hooks (3 session + 2 tool + 1 event
    // subscriber = 6 on a full host); feeds the load heartbeat below.
    let hooks = 0
    // Task-state reset: a new user prompt starts a new task.
    if (typeof h.session?.hook === "function") {
      const sessionHooks = createSessionHooks(ctx)

      try {
        const reg = await h.session.hook("prompt", sessionHooks.prompt)
        track(reg, cleanups)
        hooks++
      } catch (e) {
        ctx.journaler.journal({ type: "error", error: `session.prompt hook registration: ${e}` })
      }

      // Decoding clamps + compaction context.
      try {
        const reg = await h.session.hook("generate", sessionHooks.generate)
        track(reg, cleanups)
        hooks++
      } catch (e) {
        ctx.journaler.journal({ type: "error", error: `session.generate hook registration: ${e}` })
      }

      try {
        const reg = await h.session.hook("compaction", sessionHooks.compaction)
        track(reg, cleanups)
        hooks++
      } catch (e) {
        ctx.journaler.journal({
          type: "error",
          error: `session.compaction hook registration: ${e}`,
        })
      }
    }

    // Permission escalation (Phase 1): on a `task` dispatch the host asks the
    // plugin to evaluate whether the call should proceed. The payload carries
    // NO tool input, so escalation is driven by the parent session's plan-gate
    // state (planGateStatus), never the dispatch target. Optional surface: an
    // absent permission.hook degrades to today's behavior exactly.
    if (typeof h.permission?.hook === "function") {
      const permissionHooks = createPermissionHooks(ctx)

      try {
        const reg = await h.permission.hook("evaluate", permissionHooks.evaluate)
        track(reg, cleanups)
        hooks++
      } catch (e) {
        // A registration failure journals (fail-open); a bad hook leaves
        // today's behavior exactly.
        ctx.journaler.journal({
          type: "error",
          error: `permission.evaluate hook registration: ${e}`,
        })
      }
    }

    // Tool-level gate + trace.
    if (typeof h.tool?.hook === "function") {
      try {
        const reg = await h.tool.hook("execute.before", async (event: ToolHookEvent) => {
          try {
            if (event?.tool === "task" || event?.tool === "subagent") {
              await ctx.handleTaskDispatch(event)
              return
            }
            if (event?.tool === "read") {
              // Keyed off the parent session: a subagent's reads draw down the
              // parent's budget (AGENTS.md contract), not a per-child one.
              ctx.gates.guardReadLimit(
                await ctx.readBudgetKey(asSessionID(event?.sessionID)),
                ctx.ledger,
              )
              return
            }
            // Tool-call denylist: bash/shell commands and write/edit
            // target paths are matched against the configured denylist. The
            // extraction coerces the unconfirmed host payload (candidate keys
            // documented on each guard); an empty result fails open with
            // misconfiguration telemetry. A block throws BlockError (rethrown by
            // the catch below); shadow journals only; off is a no-op.
            if (event?.tool === "bash" || event?.tool === "shell") {
              ctx.handleBashDispatch(event, event.tool)
              return
            }
            if (event?.tool === "write" || event?.tool === "edit") {
              ctx.toolPolicy.guardPath(
                event.tool,
                event.input?.filePath ?? event.input?.path,
                asSessionID(event?.sessionID),
              )
              return
            }
            if (event?.tool === "session_move") {
              ctx.handleSessionMove(event)
              return
            }
          } catch (e) {
            if (e instanceof BlockError) throw e
            ctx.journaler.journal({ type: "error", error: `tool.execute.before: ${e}` })
          }
        })
        track(reg, cleanups)
        hooks++
      } catch (e) {
        ctx.journaler.journal({ type: "error", error: `tool.before hook registration: ${e}` })
      }

      try {
        const reg = await h.tool.hook("execute.after", async (event: ToolHookEvent) => {
          try {
            // Invariant: this runs BEFORE the injection below, so on a task
            // delivery carrying every surface the output reads
            // ORCHESTRATOR_POLICY (prepended head), then `[turnstile]
            // config:` (once-per-plugin-load block), then `[turnstile]
            // marker:` (once-per-prompt near-miss diagnostics), then the
            // child's own output, then the appended PIPELINE: status line
            // (last — per-delivery, so it lands even on a delivery whose
            // policy head already landed). All fail-open; the head, config
            // block, and marker block are once-per-scope, the status tail is
            // per-delivery.
            ctx.surfaceConfigWarnings(event)
            ctx.surfaceNearMissDiagnostics(event)
            if (event?.tool === "task" || event?.tool === "subagent") {
              // One shape decision per delivery: marker parsing, the
              // bare-output check, and policy injection all read the
              // classified child and text ("" for unknown/absent, so the
              // marker and bare paths no-op on an unclassifiable shape).
              const delivery = classifyDelivery(event)
              const output = delivery.text
              const child = delivery.child
              const agent =
                agentFromTaskInput(event.input) ||
                agentFromTaskInput(event.result?.input as TaskInput | undefined)
              // Delivery seed: the always-firing emitter-authority source. The
              // agent is resolved from dispatch input here, so a legitimate
              // child's markers land authoritatively even when every streaming
              // seed failed (fail-closed at streaming, authoritative at delivery).
              ctx.seedEmitter(child, agent)
              // Plan-reviewer and test-runner delivery paths only: await the
              // child→parent edge before marker parsing and attribution, so a
              // background dispatch whose edge resolves late (or only via
              // session.get) still attributes. Every other agent keeps today's
              // byte-identical sync ordering.
              if (
                agent === ctx.config.agents.planReviewer ||
                agent === ctx.config.agents.testRunner
              ) {
                await ctx.resolveParent(child)
              }
              // Mark the resolved parent live: covers both host
              // delivery shapes (parent-keyed and child-keyed). A genuinely
              // unresolved child delivery self-marks, protecting one extra
              // bucket until the registry LRU ages it out — bounded, documented.
              ctx.ledger.markParent(ctx.ledger.parentOf(child))
              const markerEvents = ctx.parseMarkers(
                output,
                child,
                "task-result",
                `task-result\u0000${ctx.nextTaskDeliverySeq()}`,
              )
              // Reviewer-APPROVE capture (landing gate): a reviewer
              // task-result delivery whose first-sight verdict is APPROVE sets
              // hasReviewApprove — the landing gate's release signal. Mirrors
              // the plan-reviewer verdict lifecycle but for the landing gate.
              // Streaming child text does NOT set it: this branch runs only on
              // task-result delivery, keeping the stream attribution-neutral
              // (a streamed verdict in child text can't release the landing
              // gate).
              if (agent === ctx.config.agents.reviewer) {
                const approved = markerEvents.some(
                  (e) => e.kind === "verdict" && e.marker.includes("APPROVE"),
                )
                if (approved) {
                  // Under reviewEnsemble:enforce the review is credited only
                  // once two unwaived reviewer dispatches were counted this
                  // task; an incomplete ensemble journals the refusal (and a
                  // suppressed-credit stamp) and leaves the landing gate red.
                  const parent = ctx.ledger.parentOf(child)
                  if (ctx.gates.reviewEnsembleComplete(parent, ctx.ledger))
                    ctx.ledger.state(parent).hasReviewApprove = true
                }
              }
              // Plan-approval attribution: only a plan-reviewer result moves
              // the plan gate. See attributePlanVerdict — `raw` is always an
              // actual child session ID, never the parent; an unattributable,
              // marker-less parent-keyed re-fire journals type:"error" and
              // leaves the gate untouched (never clobbers a live approval).
              if (agent === ctx.config.agents.planReviewer) {
                await ctx.attributePlanVerdict(child, output)
              }
              // The bare-output suppression — a streamed verdict in the
              // child's own text hiding a summarized, marker-less delivery —
              // is scoped to the plan-reviewer only. reviewer/test-runner keep
              // their pre-suppression behavior: a marker-less delivery
              // violates even when the child's streamed text quoted a VERDICT.
              const bare =
                ctx.config.agents.bareOutput.includes(agent) &&
                output !== "" &&
                !ctx.hasMarker(output) &&
                (agent !== ctx.config.agents.planReviewer ||
                  ctx.ledger.childVerdict(child).marker === "")
              if (bare) {
                ctx.journaler.journal({
                  type: "violation",
                  sessionID: child,
                  agent,
                  reason: "task output contained no GATE/VERDICT marker",
                })
              }
              // Orchestrator policy injection: see injectOrchestratorPolicy.
              // Attribution is edge-first via childToParent (both host
              // delivery shapes inject when the edge resolves); the name
              // guard is a conservative fallback for unregistered children
              // only, and its skip is journaled. Runs after the bare-output
              // phase, so the config-surface ordering invariant above (policy
              // prepend lands on top) is preserved.
              await ctx.injectOrchestratorPolicy(event, child, delivery, agent)
              return
            }
            if (event?.tool === "read") {
              // Same parent keying as the guard: count and budget stay in
              // step regardless of which session ID the host reports. The
              // increment happens atomically in the before-hook (guardReadLimit);
              // this after-hook journals the running count and corrects it down
              // when the read did not produce a string output (a non-string
              // result never consumed budget).
              const sessionID = ctx.ledger.parentOf(asSessionID(event?.sessionID))
              const s = ctx.ledger.state(sessionID)
              // The before-hook already incremented; a read that did not produce
              // a string output never consumed budget — correct the charge down
              // (floor 0).
              if (typeof event.result?.output !== "string" && s.reads > 0) s.reads--
              ctx.journaler.journal({ type: "tool", sessionID, tool: "read", reads: s.reads })
              // The warn prefix is once per task: the corrected `reads` counter
              // is not monotonic, so equality with readWarn could re-inject on
              // a later climb — the task-scoped flag (fresh on every prompt
              // reset) suppresses the repeat. `>=` rather than `==`: a burst of
              // before-reads can carry the counter past the threshold before
              // any string-output after-read runs, so equality could skip the
              // warn entirely.
              if (
                !s.readWarned &&
                s.reads >= ctx.config.readWarn &&
                event.result &&
                typeof event.result.output === "string"
              ) {
                event.result.output =
                  `[turnstile] Warning: ${ctx.config.readWarn} whole-file reads this session; prefer grep/glob. Blocks at ${ctx.config.readBlock}.\n` +
                  event.result.output
                s.readWarned = true
              }
              return
            }
            if (event?.tool === "bash" || event?.tool === "shell") {
              const meta = event.result?.metadata ?? {}
              ctx.journaler.journal({
                type: "tool",
                sessionID: asSessionID(event?.sessionID),
                tool: "bash",
                // Shell commands can contain secrets; record them only when
                // the trace is enabled.
                command: ctx.config.trace
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
              if (ctx.config.gateEvidence !== "off") {
                const obsSid = asSessionID(event?.sessionID)
                const exit = meta.exit ?? meta.exitCode ?? meta.code
                if (
                  ctx.evidence.observe(
                    obsSid,
                    event.input?.command ?? event.input?.cmd ?? event.result?.title ?? "",
                    exit,
                  )
                ) {
                  ctx.journaler.journal({
                    type: "evidence",
                    sessionID: obsSid,
                    event: "observed",
                    exit,
                  })
                }
                // Promote a pending unverified PASS the moment in-window
                // evidence correlates; the helper peeks (never mints) the
                // parent bucket, so unknown bash sessions stay out of the LRU.
                ctx.promoteOnEvidence(ctx.ledger.parentOf(obsSid))
              }
            }
          } catch (e) {
            // execute.after performs no gating, so nothing here can throw a
            // BlockError; every failure is journaled and the call proceeds.
            ctx.journaler.journal({ type: "error", error: `tool.execute.after: ${e}` })
          }
        })
        track(reg, cleanups)
        hooks++
      } catch (e) {
        ctx.journaler.journal({ type: "error", error: `tool.after hook registration: ${e}` })
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
                    ctx.ledger.setParent(sid, properties.parentID)
                    // Back-fill: a background child's edge often lands after
                    // its evidence and claim were recorded.
                    ctx.promoteOnEvidence(properties.parentID)
                  } else {
                    // Root sessions are live parents; the edge branch above is
                    // covered by setParent marking the parent.
                    ctx.ledger.markParent(sid)
                    // Root sessions only: the edge branch's parent is already
                    // keyed by its own created event, and a directory a child
                    // event carries belongs to the parent's context, so only
                    // parent-less events seed the per-session cache.
                    const dir = readRecordString(properties, DIRECTORY_KEYS)
                    if (dir !== "") {
                      ctx.sessionDirs.set(sid, dir)
                      ctx.boundSessionDirs()
                    }
                  }
                  // Redundant emitter seed from the created event's agent: this
                  // fires with or without the edge, so a child that streams a
                  // marker before its edge lands (or an unresolved child) still
                  // seeds the authority cache; a genuine delivery remains the
                  // always-firing seed (see seedEmitter).
                  ctx.seedEmitter(sid, agent)
                }
                break
              }
              case "message.part.updated": {
                const part = properties.part ?? properties
                const partSession = asSessionID(properties.sessionID ?? part?.sessionID)
                if (part?.type === "text" && typeof part.text === "string" && partSession) {
                  await ctx.resolveParent(partSession)
                  ctx.parseMarkers(part.text, partSession, "child-message")
                }
                break
              }
              case "session.text.ended": {
                const sid = properties.sessionID
                const text = properties.text
                if (typeof sid === "string" && typeof text === "string") {
                  await ctx.resolveParent(sid)
                  ctx.parseMarkers(text, sid, "child-text")
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
                  const window = ((ctx.deltaWindows.get(sid) ?? "") + delta).slice(
                    -ctx.maxDeltaWindowChars,
                  )
                  ctx.deltaWindows.set(sid, window)
                  ctx.boundDeltaWindows()
                  await ctx.resolveParent(sid)
                  // Parse from the map, not the local fold: a task dispatch that
                  // interleaves during the await clears the window (the task
                  // boundary), and a stale local string would complete a marker
                  // that the clear was meant to drop.
                  const pending = ctx.deltaWindows.get(sid)
                  if (pending === window) ctx.parseMarkers(window, sid, "child-text-delta")
                }
                break
              }
              case "session.error": {
                ctx.journaler.journal({
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
                    ctx.landingGateAsks.set(id, {
                      sessionID: ctx.ledger.parentOf(sid),
                      recordedAt: Date.now(),
                    })
                    ctx.boundLandingGateAsks()
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
                    if (prefixed || (message === "" && ctx.hasLiveAwaitingAsk(sid))) {
                      ctx.awaitingPlanAsk.delete(sid)
                      ctx.planGateAsks.set(id, {
                        sessionID: ctx.ledger.parentOf(sid),
                        recordedAt: Date.now(),
                      })
                      ctx.boundPlanAsks()
                    } else if (message === "" && ctx.hasLiveLandingAsk(sid)) {
                      // Empty-message landing escalate echo: record for the
                      // landing gate only. Reached only when the plan latch is
                      // NOT live — a coincident double-escalation (both latches
                      // live, one empty-message echo) resolves to the plan gate
                      // by branch order, a documented edge: the human still
                      // sees one ask, and the other latch survives for its own
                      // prefixed echo.
                      ctx.landingGateAsks.set(id, {
                        sessionID: ctx.ledger.parentOf(sid),
                        recordedAt: Date.now(),
                      })
                      ctx.boundLandingGateAsks()
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
                const planRecord = ctx.planGateAsks.get(rid)
                if (planRecord) {
                  ctx.planGateAsks.delete(rid)
                  const parent = planRecord.sessionID
                  const s = ctx.ledger.state(parent)
                  if (reply === "always") {
                    // A standing human approval releases the plan gate for the
                    // rest of the task and records provenance.
                    s.humanApproval = true
                    s.hasPlanVerdict = true
                    ctx.journaler.journal({
                      type: "permission",
                      sessionID: parent,
                      decision: "always",
                    })
                  } else if (reply === "once") {
                    // A plan-gate single-dispatch grant: consumed by exactly one
                    // executor dispatch in execute.before (the .plan
                    // short-circuit), so a stale grant cannot outlive that
                    // single dispatch.
                    s.pendingOnceGrant.plan = rid
                    ctx.journaler.journal({
                      type: "permission",
                      sessionID: parent,
                      decision: "once",
                    })
                  } else {
                    // reject (or any non-allow reply) leaves the gate red: the
                    // next execute.before dispatch re-blocks.
                    ctx.journaler.journal({
                      type: "permission",
                      sessionID: parent,
                      decision: "reject",
                    })
                  }
                } else if (ctx.landingGateAsks.get(rid)) {
                  const landingRecord = ctx.landingGateAsks.get(rid)
                  ctx.landingGateAsks.delete(rid)
                  const parent = landingRecord!.sessionID
                  const s = ctx.ledger.state(parent)
                  if (reply === "always") {
                    // A standing human approval releases the landing gate for
                    // the rest of the task (the bash guard sees hasReviewApprove
                    // and allows every push). A human release outranks the
                    // ensemble, so clear any refusal stamp on the last ensemble
                    // entry: replay restores the human release (refusedApprove
                    // absent/false) rather than an earlier refused APPROVE.
                    s.hasReviewApprove = true
                    ctx.journaler.journal({
                      type: "ensemble",
                      sessionID: parent,
                      agent: ctx.config.agents.reviewer,
                      count: s.reviewerDispatches,
                      refusedApprove: false,
                    })
                    ctx.journaler.journal({
                      type: "permission",
                      sessionID: parent,
                      decision: "always",
                    })
                  } else if (reply === "once") {
                    // A landing-gate single-dispatch push grant: consumed by
                    // exactly one bash dispatch in execute.before (the
                    // .landing short-circuit), so a stale grant cannot outlive
                    // that single push.
                    s.pendingOnceGrant.landing = rid
                    ctx.journaler.journal({
                      type: "permission",
                      sessionID: parent,
                      decision: "once",
                    })
                  } else {
                    // reject (or any non-allow reply) leaves the gate red: the
                    // next execute.before push re-blocks and re-arms the ask.
                    ctx.journaler.journal({
                      type: "permission",
                      sessionID: parent,
                      decision: "reject",
                    })
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
                  ctx.admitPrompt(sid, { sessionID: sid, text }, inboxID)
                }
                break
              }
              default:
                break
            }
          } catch (e) {
            ctx.journaler.journal({ type: "error", error: `event ${event.type}: ${e}` })
          }
        }
        // A normal completion (closed stream) is a silent death mode; an
        // abort/detach exit stays silent. Telemetry only.
        if (!controller.signal.aborted)
          ctx.journaler.journal({ type: "error", error: "event stream ended" })
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
              ctx.journaler.journal({ type: "error", error: `event subscription: ${e}` })
          }
          if (controller.signal.aborted) return
          streamRestarts++
          if (streamRestarts <= maxStreamRestarts) continue
          ctx.journaler.journal({
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
    ctx.journaler.journal({
      type: "setup",
      version,
      digest: configDigest(ctx.config),
      hooks,
      ...(ctx.config.trace
        ? { trace: true, agents: ctx.config.agents, metricsDir: ctx.config.metricsDir }
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
