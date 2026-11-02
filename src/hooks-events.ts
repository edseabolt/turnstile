/**
 * @fileoverview Event-surface stream: consumes the host event stream for
 * child→parent resolution and marker parsing from child sessions (the
 * primary path when task results are summarized), permission ask/reply
 * bookkeeping (plan-gate and landing-gate latches), inbox prompt
 * admission, and session errors — the per-event handlers live in
 * `src/event-stream-handlers.ts`. Only a THROWN subscription/iterator
 * death burns the restart budget (one `event subscription:` journal per
 * death); a clean host recycle re-subscribes for free, so a healthy host
 * never spends the budget. Stream-ended telemetry journals once per stop,
 * not once per close. The supervision loop never rejects and resolves
 * with its stop reason; src/setup.ts journals the spent-budget
 * disablement from that resolution. Per-event failures are journaled,
 * never fatal to the stream. The abort controller and its cleanup stay
 * in src/setup.ts; the signal is injected.
 */

import type { TurnstileContext } from "./hooks-core.ts"
import { createEventHandlers } from "./event-stream-handlers.ts"
import type { EventHandler } from "./event-stream-handlers.ts"
import type { EventProperties, StreamEvent } from "./types.ts"

/** A consume() exit: the stream was torn down by an abort, or it completed cleanly. */
type StreamExit = "aborted" | "clean"
/** Why the supervision loop stopped: a dispose abort, or a spent restart budget. */
type StopReason = "aborted" | "budget"

/**
 * The mutable clean-end note shared between the consume loop and its
 * caller: a delivered event re-arms the note, and the first clean close
 * after armed state journals the stream-ended telemetry once.
 */
interface EndNote {
  noted: boolean
}

/**
 * Consumes the host event stream until aborted, dispatching each event
 * type to its handler through the dispatch table. Per-event failures
 * are journaled, never fatal to the stream. Fragmented
 * `session.text.delta` markers are recovered by the per-session sliding
 * window (see the text-delta handler). Resolves the exit reason:
 * "aborted" when the abort signal ends the stream, "clean" when the
 * host closed it normally.
 * @param ctx The shared per-setup context.
 * @param handlers The event-type → handler dispatch table.
 * @param subscribe The host event.subscribe function.
 * @param signal The abort signal that stops the stream on dispose.
 * @param endNote The mutable clean-end note (re-armed per delivered event).
 * @returns "aborted" when the abort signal ends the stream, "clean" when
 *     the host closed it normally.
 */
async function consumeStream(
  ctx: TurnstileContext,
  handlers: Record<string, EventHandler>,
  subscribe: (options?: { signal?: AbortSignal }) => AsyncIterable<StreamEvent>,
  signal: AbortSignal,
  endNote: EndNote,
): Promise<StreamExit> {
  for await (const event of subscribe({ signal })) {
    try {
      // A delivered event re-arms the stream-ended note: a recycle that
      // actually delivered work may re-note a later genuine stop.
      endNote.noted = false
      const properties: EventProperties = event.data ?? event.properties ?? {}
      await handlers[event.type]?.(properties)
    } catch (e) {
      ctx.journaler.journal({ type: "error", error: `event ${event.type}: ${e}` })
    }
  }
  // A normal completion (closed stream) is a silent death mode; an
  // abort/detach exit stays silent. The stream-ended telemetry journals
  // once per stop, not once per close: a run of clean recycles without
  // delivered work notes it only on the first close, and a delivered
  // event re-arms the note for a later genuine stop.
  if (!signal.aborted && !endNote.noted) {
    endNote.noted = true
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
 * @param ctx The shared per-setup context.
 * @param consume One consume run of the host stream.
 * @param signal The abort signal that stops the stream on dispose.
 * @returns "aborted" on dispose or "budget" once the restart budget is
 *     spent.
 */
async function superviseStream(
  ctx: TurnstileContext,
  consume: () => Promise<StreamExit>,
  signal: AbortSignal,
): Promise<StopReason> {
  const maxStreamRestarts = 5
  let streamRestarts = 0
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
  // Mutated inside the consume loop only (a delivered event re-arms the
  // note), never in a handler — so it stays local to the factory.
  const endNote: EndNote = { noted: false }
  const handlers = createEventHandlers(ctx)
  const consume = () => consumeStream(ctx, handlers, subscribe, signal, endNote)
  return superviseStream(ctx, consume, signal)
}
