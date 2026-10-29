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
  HANDSON_ASK_MESSAGE_PREFIX,
  LANDING_ASK_MESSAGE_PREFIX,
  PLAN_ASK_MESSAGE_PREFIX,
} from "./delivery.ts"
import { decisionEntry, reviewerEnsembleEntry } from "./gates-common.ts"
import { readJournalEntries } from "./journal.ts"
import type { TurnstileContext } from "./hooks-core.ts"
import {
  countSessionActivity,
  formatAllGreenLine,
  formatSessionSummary,
  isInactive,
} from "./summary.ts"
import type { EventProperties, StreamEvent } from "./types.ts"

/** A consume() exit: the stream was torn down by an abort, or it completed cleanly. */
type StreamExit = "aborted" | "clean"
/** Why the supervision loop stopped: a dispose abort, or a spent restart budget. */
type StopReason = "aborted" | "budget"
/** A per-event handler in consume()'s dispatch table, keyed by event type. */
type EventHandler = (properties: EventProperties) => void | Promise<void>

/**
 * Reply latency under which a human could not plausibly have read and
 * answered the ask: a release reply arriving faster than this journals a
 * provenance suspicion. Heuristic only — the release still applies and the
 * row gates nothing; the journal keeps the audit trail honest about replies
 * that look machine-generated (a non-interactive client auto-answering).
 */
const FAST_REPLY_MS = 1000

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
   * Folds a text delta into the session's tail-bounded sliding window and
   * returns the folded window. Reassembles a possibly-split marker: the
   * shared-empty dedup scope suppresses every re-fire, so only a newly
   * completed marker across chunks is first-sighted.
   * @param sid The child session the delta belongs to.
   * @param delta The newly arrived delta text.
   * @returns The window after appending the delta and tail-bounding it.
   */
  const foldDeltaWindow = (sid: string, delta: string): string => {
    const window = ((ctx.deltaWindows.get(sid) ?? "") + delta).slice(-ctx.maxDeltaWindowChars)
    ctx.deltaWindows.set(sid, window)
    ctx.boundDeltaWindows()
    return window
  }
  /**
   * Handles a session.created event: records the child→parent edge (and
   * back-fills evidence for a late edge), or marks a root session as a live
   * parent and seeds its directory; then seeds the emitter-authority cache
   * from the event's agent with or without the edge.
   * @param properties The resolved event properties.
   */
  const handleSessionCreated = (properties: EventProperties): void => {
    const sid = typeof properties.sessionID === "string" ? properties.sessionID : ""
    if (sid) {
      const agent = typeof properties.agent === "string" ? properties.agent : ""
      if (typeof properties.parentID === "string") {
        ctx.ledger.setParent(sid, properties.parentID, agent)
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
  }
  /**
   * Handles a message.part.updated event: a text part carries possibly
   * complete markers, parsed from the part's session once its parent is
   * resolved.
   * @param properties The resolved event properties.
   */
  const handleTextUpdated = async (properties: EventProperties): Promise<void> => {
    const part = properties.part ?? properties
    const partSession = asSessionID(properties.sessionID ?? part?.sessionID)
    if (part?.type === "text" && typeof part.text === "string" && partSession) {
      await ctx.resolveParent(partSession)
      ctx.parseMarkers(part.text, partSession, "child-message")
    }
  }
  /**
   * Handles a session.text.ended event: the finished text carries possibly
   * complete markers, parsed once the session's parent is resolved.
   * @param properties The resolved event properties.
   */
  const handleTextEnded = async (properties: EventProperties): Promise<void> => {
    const sid = properties.sessionID
    const text = properties.text
    if (typeof sid === "string" && typeof text === "string") {
      await ctx.resolveParent(sid)
      ctx.parseMarkers(text, sid, "child-text")
    }
  }
  /**
   * Handles a session.text.delta event: folds the delta into the session's
   * sliding window, resolves the parent, then re-parses the window.
   * @param properties The resolved event properties.
   */
  const handleTextDelta = async (properties: EventProperties): Promise<void> => {
    const sid = properties.sessionID
    const delta = properties.delta
    if (typeof sid === "string" && typeof delta === "string") {
      const window = foldDeltaWindow(sid, delta)
      await ctx.resolveParent(sid)
      // Parse from the map, not the local fold: a task dispatch that
      // interleaves during the await clears the window (the task
      // boundary), and a stale local string would complete a marker
      // that the clear was meant to drop.
      const pending = ctx.deltaWindows.get(sid)
      if (pending === window) ctx.parseMarkers(window, sid, "child-text-delta")
    }
  }
  /**
   * Handles a session.error event: journals the error (bounded to 500
   * chars) so a child failure stays visible without killing the stream.
   * @param properties The resolved event properties.
   */
  const handleSessionError = (properties: EventProperties): void => {
    ctx.journaler.journal({
      type: "error",
      sessionID: properties.sessionID,
      error: String(properties.error ?? "").slice(0, 500),
    })
  }
  /**
   * Records a landing-gate ask under the host request id, keyed to the
   * ask's parent session so replies apply per-session and concurrent
   * sessions cannot cross-apply; bounds the ask table.
   * @param id The host request id of the ask.
   * @param parent The parent session the ask belongs to.
   */
  const recordAskedLanding = (id: string, parent: string): void => {
    ctx.landingGateAsks.set(id, { sessionID: parent, recordedAt: Date.now() })
    ctx.boundLandingGateAsks()
  }
  /**
   * Records a hands-on-gate ask under the host request id, keyed to the
   * ask's parent session so replies apply per-session and concurrent
   * sessions cannot cross-apply; bounds the ask table. Mirrors
   * recordAskedLanding; the disjoint message prefixes keep a hands-on
   * approval from ever releasing the plan or landing gate (and vice versa).
   * @param id The host request id of the ask.
   * @param parent The parent session the ask belongs to.
   */
  const recordAskedHandsOn = (id: string, parent: string): void => {
    ctx.handsOnGateAsks.set(id, { sessionID: parent, recordedAt: Date.now() })
    ctx.boundHandsOnGateAsks()
  }
  /**
   * Records a plan-gate ask: when the message carries the plan-ask prefix
   * (the evaluate echo) or when the session is live-latched and the ask
   * carries no message of its own (the escalated echo). A non-empty
   * message WITHOUT either prefix is an unrelated ask (bash, write, …)
   * even under a latched escalation — the evaluate handler always composes
   * a prefix into its message, so a prefixed-or-empty message is the
   * expected echo and anything else must never be recorded (a human's
   * approval of an unrelated ask cannot release the plan or landing
   * gate). An empty-message ask under a live landing latch (the plan
   * latch not live) is a landing escalate echo: recorded for the landing
   * gate only.
   * @param id The host request id of the ask.
   * @param sid The session the ask was raised in.
   * @param message The ask's echoed message ("" when absent).
   */
  const recordAskedPlan = (id: string, sid: string, message: string): void => {
    const prefixed = message.startsWith(PLAN_ASK_MESSAGE_PREFIX)
    // The empty-message consume of a live plan latch is the
    // steal-able window: an unrelated ask wins the latch over the
    // escalate echo. A prefixed ask (the normal echo) never does.
    const stolen = !prefixed && message === "" && ctx.hasLiveAwaitingAsk(sid)
    if (prefixed || stolen) {
      const parent = ctx.ledger.parentOf(sid)
      if (stolen) {
        // Journal the steal for ladder diagnosability; it carries
        // no action/decision, so the human PERM table (status.mjs
        // counts only e.action === "ask") is untouched and it is
        // replay-inert (the ledger never replays permission rows).
        ctx.journaler.journal({
          type: "permission",
          sessionID: parent,
          event: "latch-steal",
          reason: "plan-gate",
        })
      }
      ctx.awaitingPlanAsk.delete(sid)
      ctx.planGateAsks.set(id, { sessionID: parent, recordedAt: Date.now() })
      ctx.boundPlanAsks()
    } else if (message === "" && ctx.hasLiveLandingAsk(sid)) {
      // Empty-message landing escalate echo: record for the
      // landing gate only. Reached only when the plan latch is
      // NOT live — a coincident double-escalation (both latches
      // live, one empty-message echo) resolves to the plan gate
      // by branch order, a documented edge: the human still
      // sees one ask, and the other latch survives for its own
      // prefixed echo.
      recordAskedLanding(id, ctx.ledger.parentOf(sid))
    }
  }
  /**
   * Handles a permission.asked event: records plan-gate and landing-gate
   * asks (disjoint by message prefix). A missing/non-string id is inert
   * (nothing is recorded). Fail-open — the outer loop journals any throw.
   * @param properties The resolved event properties.
   */
  const handlePermissionAsked = (properties: EventProperties): void => {
    const id = properties.id ?? properties.requestID
    if (typeof id === "string" && id !== "") {
      const sid = asSessionID(properties.sessionID)
      const message = typeof properties.message === "string" ? properties.message : ""
      // Landing-gate ask: message carries the landing-ask prefix
      // (the evaluate handler's echo). A landing ask is disjoint from
      // a plan ask (different prefix), so an approval of one never
      // releases the other.
      if (message.startsWith(LANDING_ASK_MESSAGE_PREFIX)) {
        // Landing-gate ask: message carries the landing-ask prefix
        // (the evaluate handler's echo). A landing ask is disjoint from
        // a plan ask (different prefix), so an approval of one never
        // releases the other.
        recordAskedLanding(id, ctx.ledger.parentOf(sid))
      } else if (message.startsWith(HANDSON_ASK_MESSAGE_PREFIX)) {
        // Hands-on-gate ask: same prefix-dispatch contract.
        recordAskedHandsOn(id, ctx.ledger.parentOf(sid))
      } else {
        recordAskedPlan(id, sid, message)
      }
    }
  }
  /**
   * Journals a fast-reply provenance suspicion when a recorded ask was
   * answered faster than a human could plausibly read it (see
   * {@link FAST_REPLY_MS}). Journal-only: the suspicion never gates, and the
   * release the reply carries still applies — the row keeps the audit trail
   * honest about machine-looking replies (a non-interactive client
   * auto-answering) without inventing a host signal that does not exist.
   * @param ctxRecordedAt The ask's `permission.asked` arrival time.
   * @param parent The parent session the ask belongs to.
   * @param decision The reply being applied (`"always"` / `"once"`).
   */
  const noteFastReply = (ctxRecordedAt: number, parent: string, decision: string): void => {
    if (Date.now() - ctxRecordedAt >= FAST_REPLY_MS) return
    ctx.journaler.journal({
      type: "permission",
      sessionID: parent,
      event: "suspicion",
      reason: "no-interactive-human",
      // `reply`, deliberately NOT `decision`: the row must stay outside the
      // decision family (status.mjs's PERM counts and any journal tail
      // scanning on `decision` must not read a suspicion as a decision).
      reply: decision,
    })
  }
  /**
   * Applies a human reply to a RECORDED plan-gate ask (the dispatcher's
   * falsy-record guard guarantees the record exists): "always" releases
   * the plan gate for the rest of the task and records provenance; "once"
   * stamps a single-dispatch grant; any other reply leaves the gate red.
   * The record is consumed (deleted) on every path.
   * @param rid The host request id matching the recorded ask.
   * @param reply The human reply ("once" / "always" / "reject").
   */
  const applyPlanGrant = (rid: string, reply: unknown): void => {
    const planRecord = ctx.planGateAsks.get(rid)!
    ctx.planGateAsks.delete(rid)
    const parent = planRecord.sessionID
    const s = ctx.ledger.state(parent)
    if (reply === "always") {
      // A standing human approval releases the plan gate for the
      // rest of the task and records provenance. The sticky row
      // (scope/kind) is what the boot replay folds back into a
      // restored standing release after a restart.
      s.humanApproval = true
      s.hasPlanVerdict = true
      noteFastReply(planRecord.recordedAt, parent, "always")
      ctx.journaler.journal(decisionEntry(parent, "always", { kind: "plan" }))
    } else if (reply === "once") {
      // A plan-gate single-dispatch grant: consumed by exactly one
      // executor dispatch in execute.before (the .plan
      // short-circuit), so a stale grant cannot outlive that
      // single dispatch.
      s.pendingOnceGrant.plan = rid
      noteFastReply(planRecord.recordedAt, parent, "once")
      ctx.journaler.journal(decisionEntry(parent, "once"))
    } else {
      // reject (or any non-allow reply) leaves the gate red: the
      // next execute.before dispatch re-blocks.
      ctx.journaler.journal(decisionEntry(parent, "reject"))
    }
  }
  /**
   * Applies a human reply to a RECORDED landing-gate ask (the dispatcher's
   * falsy-record guard guarantees the record exists): "always" releases
   * the landing gate for the rest of the task; "once" stamps a
   * single-dispatch push grant; any other reply leaves the gate red. The
   * record is consumed (deleted) on every path.
   * @param rid The host request id matching the recorded ask.
   * @param reply The human reply ("once" / "always" / "reject").
   */
  const applyLandingGrant = (rid: string, reply: unknown): void => {
    const landingRecord = ctx.landingGateAsks.get(rid)!
    ctx.landingGateAsks.delete(rid)
    const parent = landingRecord.sessionID
    const s = ctx.ledger.state(parent)
    if (reply === "always") {
      // A standing human approval releases the landing gate for
      // the rest of the task (the bash guard sees hasReviewApprove
      // and allows every push). A human release outranks the
      // ensemble, so clear any refusal stamp on the last ensemble
      // entry: replay restores the human release (refusedApprove
      // absent/false) rather than an earlier refused APPROVE.
      s.hasReviewApprove = true
      // Credit the bucket-free trace too: the flag above dies on the next
      // prompt reset, but this human release is credit the journal already
      // records (the cleared refusal stamp), so the trace keeps live and
      // restart behavior identical and lets the landing gate escalate the
      // next turn's first push instead of throwing.
      ctx.ledger.markCreditedApproval(parent)
      noteFastReply(landingRecord.recordedAt, parent, "always")
      ctx.journaler.journal(
        reviewerEnsembleEntry(parent, ctx.config.agents.reviewer, s.reviewerDispatches, false),
      )
      ctx.journaler.journal(decisionEntry(parent, "always", { kind: "landing" }))
    } else if (reply === "once") {
      // A landing-gate single-dispatch push grant: consumed by
      // exactly one bash dispatch in execute.before (the
      // .landing short-circuit), so a stale grant cannot outlive
      // that single push.
      s.pendingOnceGrant.landing = rid
      noteFastReply(landingRecord.recordedAt, parent, "once")
      ctx.journaler.journal(decisionEntry(parent, "once"))
    } else {
      // reject (or any non-allow reply) leaves the gate red: the
      // next execute.before push re-blocks and re-arms the ask.
      ctx.journaler.journal(decisionEntry(parent, "reject"))
    }
  }
  /**
   * Applies a human reply to a RECORDED hands-on-gate ask (the dispatcher's
   * falsy-record guard guarantees the record exists): "always" releases the
   * hands-on gate for the rest of the task (task-scoped, dropped by the next
   * prompt); "once" stamps a single-edit grant consumed by exactly one parent
   * write/edit; any other reply leaves the gate red — the next parent edit
   * re-blocks and re-arms. The record is consumed (deleted) on every path.
   * @param rid The host request id matching the recorded ask.
   * @param reply The human reply ("once" / "always" / "reject").
   */
  const applyHandsOnGrant = (rid: string, reply: unknown): void => {
    const handsOnRecord = ctx.handsOnGateAsks.get(rid)!
    ctx.handsOnGateAsks.delete(rid)
    const parent = handsOnRecord.sessionID
    const s = ctx.ledger.state(parent)
    if (reply === "always") {
      // A standing human approval releases the rest of this task's parent
      // edits (the guard sees handsOnRelease and allows every write/edit).
      s.handsOnRelease = true
      noteFastReply(handsOnRecord.recordedAt, parent, "always")
      ctx.journaler.journal(decisionEntry(parent, "always", { kind: "hands-on" }))
    } else if (reply === "once") {
      // A hands-on-gate single-edit grant: consumed by exactly one parent
      // write/edit in execute.before (the .handsOn short-circuit), so a
      // stale grant cannot outlive that single edit.
      s.pendingOnceGrant.handsOn = rid
      noteFastReply(handsOnRecord.recordedAt, parent, "once")
      ctx.journaler.journal(decisionEntry(parent, "once"))
    } else {
      // reject (or any non-allow reply) leaves the gate red: the next
      // parent edit re-blocks and re-arms the ask.
      ctx.journaler.journal(decisionEntry(parent, "reject"))
    }
  }
  /**
   * Journals a permission reply whose non-empty requestID matches no
   * recorded ask: the inert no-op is diagnosable, and the entry carries
   * no action/decision (the human PERM table is untouched and it is
   * replay-inert). A requestID-less reply is a distinct,
   * already-understood broken-host case and stays silent.
   * @param rid The unmatched host request id.
   * @param sessionID The session the reply arrived in.
   */
  const noteUnrecordedReply = (rid: string, sessionID: string): void => {
    ctx.journaler.journal({
      type: "permission",
      sessionID,
      event: "unrecorded-reply",
      requestID: rid,
    })
  }
  /**
   * Handles a permission.replied event: matches the reply against
   * RECORDED asks only — a plan-gate ask (keyed by requestID, consumed
   * once, releases/holds the plan gate) or a landing-gate ask (consumed
   * once, grants/holds a push). A requestID absent from both maps was
   * never an ask we raised, so the reply is inert — an approval of an
   * unrelated permission ask cannot release either gate. Fail-open — the
   * outer loop journals any throw.
   * @param properties The resolved event properties.
   */
  const handlePermissionReplied = (properties: EventProperties): void => {
    const rid = String(properties.requestID ?? "")
    const reply = properties.reply
    const planRecord = ctx.planGateAsks.get(rid)
    if (planRecord) {
      applyPlanGrant(rid, reply)
    } else if (ctx.landingGateAsks.get(rid)) {
      applyLandingGrant(rid, reply)
    } else if (ctx.handsOnGateAsks.get(rid)) {
      applyHandsOnGrant(rid, reply)
    } else if (rid !== "") {
      noteUnrecordedReply(rid, asSessionID(properties.sessionID))
    }
  }
  /**
   * Handles a session.inbox.enqueued event: prompt admission via the
   * inbox stream — the transport adopted because its publication is exact
   * host-admission parity: the host publishes it inside its own admit
   * region, immediately after the prompt hook fires. A user-authored
   * prompt (type "user") carrying non-empty text is admitted;
   * agent/composition arrivals (synthetic / compaction / move) never
   * carry a user prompt, so they stay inert (provenance invariant). The
   * inbox id dedupes against the hook path on the shared host message id.
   * `delivered`/`cancelled` are intentionally unhandled — the captured
   * admission point is the host's own publish, and a later drain or cancel
   * cannot retroactively un-admit it. Fail-open — the outer loop journals
   * any throw.
   * @param properties The resolved event properties.
   */
  const handleInboxEnqueued = (properties: EventProperties): void => {
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
  }
  /** Delivery-proof journal entry bound: 300 chars, like the trace's bound. */
  const SUMMARY_TEXT_BOUND = 300
  /**
   * Best-effort toast delivery of the session-end summary: a rejecting or
   * throwing toast journals an `error` entry and changes nothing else
   * (fail-open) — the journal entry is the headless log line either way.
   * @param line The summary line to toast.
   */
  const deliverToast = async (line: string): Promise<void> => {
    if (!ctx.toast) return
    try {
      await ctx.toast(line, "success")
    } catch (e) {
      ctx.journaler.journal({ type: "error", error: `session-summary toast: ${e}` })
    }
  }
  /**
   * Handles a session.idle event: surfaces the once-per-session summary line
   * per the `sessionSummary` config. "off" is silent; a zero-activity session
   * is silent under "quiet" and prints the all-green line under "on"; an
   * active session prints the recap line (verified test-claims, premature
   * dispatches blocked, waivers — counts derived from this session's journal
   * entries via `countSessionActivity`). Delivery: journaled always as a
   * `type:"session-summary"` delivery-proof entry (the headless log),
   * toasted best-effort when the host offers `tui.toast` — a toast failure
   * journals and changes nothing else (fail-open). Deduped per session via
   * the bounded `ctx.summarizedSessions` set, so one summary per session per
   * host process; a host restart may re-summary a still-idle session once
   * (accepted; the journal entry makes it diagnosable). Fail-open — the
   * outer loop journals any throw.
   * @param properties The resolved event properties.
   */
  const handleSessionIdle = async (properties: EventProperties): Promise<void> => {
    const sid = typeof properties.sessionID === "string" ? properties.sessionID : ""
    if (sid === "" || ctx.summarizedSessions.has(sid)) return
    if (ctx.config.sessionSummary === "off") return
    ctx.summarizedSessions.add(sid)
    ctx.boundSummarizedSessions()
    const counts = countSessionActivity(readJournalEntries(ctx.journaler.journalPath), sid)
    const inactive = isInactive(counts)
    if (inactive && ctx.config.sessionSummary === "quiet") return
    const line = inactive
      ? formatAllGreenLine(ctx.journaler.journalPath)
      : formatSessionSummary(counts, ctx.journaler.journalPath)
    ctx.journaler.journal({
      type: "session-summary",
      sessionID: sid,
      ...counts,
      text: line.slice(0, SUMMARY_TEXT_BOUND),
    })
    await deliverToast(line)
  }
  /** The event-type → handler dispatch table, in stream source order. */
  const handlers: Record<string, EventHandler> = {
    "session.created": handleSessionCreated,
    "message.part.updated": handleTextUpdated,
    "session.text.ended": handleTextEnded,
    "session.text.delta": handleTextDelta,
    "session.error": handleSessionError,
    "permission.asked": handlePermissionAsked,
    "permission.replied": handlePermissionReplied,
    "session.inbox.enqueued": handleInboxEnqueued,
    "session.idle": handleSessionIdle,
  }
  /**
   * Consumes the host event stream until aborted, dispatching each event
   * type to its handler through the dispatch table. Per-event failures
   * are journaled, never fatal to the stream. Fragmented
   * `session.text.delta` markers are recovered by the per-session sliding
   * window (see the text-delta handler). Resolves the exit reason:
   * "aborted" when the abort signal ends the stream, "clean" when the
   * host closed it normally.
   */
  const consume = async (): Promise<StreamExit> => {
    for await (const event of subscribe({ signal })) {
      try {
        // A delivered event re-arms the stream-ended note: a recycle that
        // actually delivered work may re-note a later genuine stop.
        cleanEndNoted = false
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
