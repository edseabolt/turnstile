/**
 * @fileoverview Event-surface stream: consumes the host event stream for
 * child→parent resolution and marker parsing from child sessions (the
 * primary path when task results are summarized), permission ask/reply
 * bookkeeping (plan-gate and landing-gate latches), inbox prompt
 * admission, and session errors. Only a THROWN subscription/iterator
 * death burns the restart budget (one `event subscription:` journal per
 * death); a clean host recycle re-subscribes for free, so a healthy host
 * never spends the budget. Stream-ended telemetry journals once per stop,
 * not once per close. The supervision loop never rejects and resolves
 * with its stop reason; src/setup.ts journals the spent-budget
 * disablement from that resolution. Per-event failures are journaled,
 * never fatal to the stream. The abort controller and its cleanup stay
 * in src/setup.ts; the signal is injected.
 */

import {
  asSessionID,
  readRecordString,
  DIRECTORY_KEYS,
  LANDING_ASK_MESSAGE_PREFIX,
  PLAN_ASK_MESSAGE_PREFIX,
} from "./delivery.ts"
import type { TurnstileContext } from "./hooks-core.ts"
import type { EventProperties, StreamEvent } from "./types.ts"

/** A consume() exit: the stream was torn down by an abort, or it completed cleanly. */
type StreamExit = "aborted" | "clean"
/** Why the supervision loop stopped: a dispose abort, or a spent restart budget. */
type StopReason = "aborted" | "budget"

/**
 * Starts the event stream for one setup: subscribes to the host stream
 * and supervises re-subscription. Only a thrown subscription/iterator
 * death burns the restart budget (one `event subscription:` journal per
 * death); a clean host recycle re-subscribes for free, so a healthy host
 * never spends the budget, and the stream-ended telemetry for a run of
 * clean closes journals once per stop, not once per close. The returned
 * promise is the supervision loop: it never rejects — every throw is
 * caught and journaled — and resolves with the stop reason so setup.ts
 * surfaces the spent-budget disablement exactly once.
 * @param ctx The shared per-setup context (journaler, ledger, marker
 *     services, ask latches, delta windows, admission state).
 * @param subscribe The host event.subscribe function.
 * @param signal The abort signal that stops the stream on dispose.
 * @returns The supervision loop promise, resolving "aborted" on dispose
 *     or "budget" once the restart budget is spent.
 */
export function startEventStream(
  ctx: TurnstileContext,
  subscribe: (options?: { signal?: AbortSignal }) => AsyncIterable<StreamEvent>,
  signal: AbortSignal,
): Promise<StopReason> {
  let cleanEndNoted = false
  /**
   * Consumes the host event stream until aborted, dispatching each
   * event type to its handler. Per-event failures are journaled, never
   * fatal to the stream. Fragmented `session.text.delta` markers are
   * recovered by the per-session sliding window (see the delta case).
   * Resolves the exit reason: "aborted" when the abort signal ends the
   * stream, "clean" when the host closed it normally.
   */
  const consume = async (): Promise<StreamExit> => {
    for await (const event of subscribe({ signal })) {
      try {
        // A delivered event re-arms the stream-ended note: a recycle that
        // actually delivered work may re-note a later genuine stop.
        cleanEndNoted = false
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
    // abort/detach exit stays silent. The stream-ended telemetry journals
    // once per stop, not once per close: a run of clean recycles without
    // delivered work notes it only on the first close, and a delivered
    // event re-arms the note for a later genuine stop.
    if (!signal.aborted && !cleanEndNoted) {
      cleanEndNoted = true
      ctx.journaler.journal({ type: "error", error: "event stream ended" })
    }
    return signal.aborted ? "aborted" : "clean"
  }
  /**
   * Re-subscribes forever until the restart budget or an abort ends
   * supervision. Only a thrown subscription/iterator death burns the
   * restart budget: each such death journals one `event subscription:`
   * entry, and once the budget is spent the loop resolves "budget" (the
   * spent-budget disablement is surfaced by setup.ts from that
   * resolution, so it journals exactly once per stop). A clean host
   * recycle or an abort is not a death: a clean exit re-subscribes for
   * free, and an abort (dispose) resolves "aborted" silently, matching
   * the pre-existing abort-silent semantics.
   */
  const maxStreamRestarts = 5
  let streamRestarts = 0
  const supervise = async (): Promise<StopReason> => {
    for (;;) {
      let exit: StreamExit
      try {
        exit = await consume()
      } catch (e) {
        // A thrown death is the only exit that burns the restart budget;
        // a throw while aborted (dispose) is a silent detach.
        if (signal.aborted) return "aborted"
        ctx.journaler.journal({ type: "error", error: `event subscription: ${e}` })
        streamRestarts++
        if (streamRestarts <= maxStreamRestarts) continue
        return "budget"
      }
      // A clean host recycle is not a death: re-subscribe for free so a
      // healthy host never spends the restart budget. Yield one event-loop
      // tick before re-subscribing: a host that clean-closes instantly
      // would otherwise re-subscribe unboundedly on the microtask queue
      // and starve the loop (dispose can never run to stop it).
      if (exit === "aborted") return "aborted"
      await new Promise<void>((resolve) => setImmediate(resolve))
    }
  }
  return supervise()
}
