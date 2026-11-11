/**
 * @fileoverview Event-stream per-event handlers: the dispatch table consumed
 * by `startEventStream` (`src/hooks-events.ts`) — child→parent resolution and
 * marker parsing from child sessions (created/text/ended/delta), permission
 * ask/reply bookkeeping (plan-gate, landing-gate, and hands-on-gate latches),
 * inbox prompt admission, and the session-idle summary. Extracted from
 * `src/hooks-events.ts`; every handler reads only the shared context, and the
 * supervision loop (restart budget, clean-end note) stays in the factory.
 * Per-event failures are journaled by the outer loop, never fatal to the
 * stream.
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
import { verifyJournalChain } from "./verify.ts"
import { provDeniedEntry, type ProvDeniedKind } from "./decision-ledger.ts"
import type { TurnstileContext } from "./hooks-core.ts"
import {
  countSessionActivity,
  formatAllGreenLine,
  formatSessionSummary,
  isInactive,
} from "./summary.ts"
import type { EventProperties } from "./types.ts"

/** A per-event handler in consume()'s dispatch table, keyed by event type. */
export type EventHandler = (properties: EventProperties) => void | Promise<void>

/**
 * Reply latency under which a human could not plausibly have read and
 * answered the ask: a release reply arriving faster than this journals a
 * provenance suspicion. Heuristic only — the release still applies and the
 * row gates nothing; the journal keeps the audit trail honest about replies
 * that look machine-generated (a non-interactive client auto-answering).
 */
const FAST_REPLY_MS = 1000

/** Delivery-proof journal entry bound: 300 chars, like the trace's bound. */
const SUMMARY_TEXT_BOUND = 300

/**
 * Folds a text delta into the session's tail-bounded sliding window and
 * returns the folded window. Reassembles a possibly-split marker: the
 * shared-empty dedup scope suppresses every re-fire, so only a newly
 * completed marker across chunks is first-sighted.
 * @param ctx The shared per-setup context.
 * @param sid The child session the delta belongs to.
 * @param delta The newly arrived delta text.
 * @returns The window after appending the delta and tail-bounding it.
 */
function foldDeltaWindow(ctx: TurnstileContext, sid: string, delta: string): string {
  const window = ((ctx.deltaWindows.get(sid) ?? "") + delta).slice(-ctx.maxDeltaWindowChars)
  ctx.deltaWindows.set(sid, window)
  ctx.boundDeltaWindows()
  return window
}

/**
 * Seeds the per-session directory cache for a root session: a directory a
 * child event carries belongs to the parent's context, so only parent-less
 * events seed the per-session cache (the edge branch's parent is already
 * keyed by its own created event).
 * @param ctx The shared per-setup context.
 * @param sid The root session ID.
 * @param properties The resolved event properties.
 */
function seedRootSessionDir(ctx: TurnstileContext, sid: string, properties: EventProperties): void {
  const dir = readRecordString(properties, DIRECTORY_KEYS)
  if (dir !== "") {
    ctx.sessionDirs.set(sid, dir)
    ctx.boundSessionDirs()
  }
}

/**
 * Handles a session.created event: records the child→parent edge (and
 * back-fills evidence for a late edge), or marks a root session as a live
 * parent and seeds its directory; then seeds the emitter-authority cache
 * from the event's agent with or without the edge.
 * @param ctx The shared per-setup context.
 * @param properties The resolved event properties.
 */
function handleSessionCreated(ctx: TurnstileContext, properties: EventProperties): void {
  const sid = typeof properties.sessionID === "string" ? properties.sessionID : ""
  if (!sid) return
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
    seedRootSessionDir(ctx, sid, properties)
  }
  // Redundant emitter seed from the created event's agent: this
  // fires with or without the edge, so a child that streams a
  // marker before its edge lands (or an unresolved child) still
  // seeds the authority cache; a genuine delivery remains the
  // always-firing seed (see seedEmitter).
  ctx.seedEmitter(sid, agent)
}

/**
 * Handles a message.part.updated event: a text part carries possibly
 * complete markers, parsed from the part's session once its parent is
 * resolved.
 * @param ctx The shared per-setup context.
 * @param properties The resolved event properties.
 */
async function handleTextUpdated(
  ctx: TurnstileContext,
  properties: EventProperties,
): Promise<void> {
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
 * @param ctx The shared per-setup context.
 * @param properties The resolved event properties.
 */
async function handleTextEnded(ctx: TurnstileContext, properties: EventProperties): Promise<void> {
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
 * @param ctx The shared per-setup context.
 * @param properties The resolved event properties.
 */
async function handleTextDelta(ctx: TurnstileContext, properties: EventProperties): Promise<void> {
  const sid = properties.sessionID
  const delta = properties.delta
  if (typeof sid === "string" && typeof delta === "string") {
    const window = foldDeltaWindow(ctx, sid, delta)
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
 * @param ctx The shared per-setup context.
 * @param properties The resolved event properties.
 */
function handleSessionError(ctx: TurnstileContext, properties: EventProperties): void {
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
 * @param ctx The shared per-setup context.
 * @param id The host request id of the ask.
 * @param parent The parent session the ask belongs to.
 */
function recordAskedLanding(ctx: TurnstileContext, id: string, parent: string): void {
  ctx.landingGateAsks.set(id, { sessionID: parent, recordedAt: Date.now() })
  ctx.boundLandingGateAsks()
}

/**
 * Records a hands-on-gate ask under the host request id, keyed to the
 * ask's parent session so replies apply per-session and concurrent
 * sessions cannot cross-apply; bounds the ask table. Mirrors
 * recordAskedLanding; the disjoint message prefixes keep a hands-on
 * approval from ever releasing the plan or landing gate (and vice versa).
 * @param ctx The shared per-setup context.
 * @param id The host request id of the ask.
 * @param parent The parent session the ask belongs to.
 */
function recordAskedHandsOn(ctx: TurnstileContext, id: string, parent: string): void {
  ctx.handsOnGateAsks.set(id, { sessionID: parent, recordedAt: Date.now() })
  ctx.boundHandsOnGateAsks()
}

/**
 * Records the plan-gate arm of a permission.asked: the prefixed echo (the
 * evaluate handler's message) or the stolen empty-message consume of a
 * live plan latch. Journals the steal for ladder diagnosability when the
 * latch was stolen (it carries no action/decision, so the human PERM table
 * is untouched and it is replay-inert), consumes the latch, and records
 * the ask keyed to the parent.
 * @param ctx The shared per-setup context.
 * @param id The host request id of the ask.
 * @param sid The session the ask was raised in.
 * @param parent The parent session the ask belongs to.
 */
function recordPlanAskLatch(ctx: TurnstileContext, id: string, sid: string, parent: string): void {
  ctx.awaitingPlanAsk.delete(sid)
  ctx.planGateAsks.set(id, { sessionID: parent, recordedAt: Date.now() })
  ctx.boundPlanAsks()
}

/**
 * Records an empty-message landing escalate echo for the landing gate
 * only. Reached only when the plan latch is NOT live — a coincident
 * double-escalation (both latches live, one empty-message echo) resolves
 * to the plan gate by branch order, a documented edge: the human still
 * sees one ask, and the other latch survives for its own prefixed echo.
 * @param ctx The shared per-setup context.
 * @param id The host request id of the ask.
 * @param sid The session the ask was raised in.
 */
function recordLandingAskEcho(ctx: TurnstileContext, id: string, sid: string): void {
  recordAskedLanding(ctx, id, ctx.ledger.parentOf(sid))
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
 * @param ctx The shared per-setup context.
 * @param id The host request id of the ask.
 * @param sid The session the ask was raised in.
 * @param message The ask's echoed message ("" when absent).
 */
function recordAskedPlan(ctx: TurnstileContext, id: string, sid: string, message: string): void {
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
    recordPlanAskLatch(ctx, id, sid, parent)
  } else if (message === "" && ctx.hasLiveLandingAsk(sid)) {
    recordLandingAskEcho(ctx, id, sid)
  }
}

/**
 * Handles a permission.asked event: records plan-gate, landing-gate, and
 * hands-on-gate asks (disjoint by message prefix). A missing/non-string id
 * is inert (nothing is recorded). Fail-open — the outer loop journals any
 * throw.
 * @param ctx The shared per-setup context.
 * @param properties The resolved event properties.
 */
function handlePermissionAsked(ctx: TurnstileContext, properties: EventProperties): void {
  const id = properties.id ?? properties.requestID
  if (typeof id !== "string" || id === "") return
  const sid = asSessionID(properties.sessionID)
  const message = typeof properties.message === "string" ? properties.message : ""
  // Landing-gate ask: message carries the landing-ask prefix
  // (the evaluate handler's echo). A landing ask is disjoint from
  // a plan ask (different prefix), so an approval of one never
  // releases the other.
  if (message.startsWith(LANDING_ASK_MESSAGE_PREFIX)) {
    recordAskedLanding(ctx, id, ctx.ledger.parentOf(sid))
  } else if (message.startsWith(HANDSON_ASK_MESSAGE_PREFIX)) {
    // Hands-on-gate ask: same prefix-dispatch contract.
    recordAskedHandsOn(ctx, id, ctx.ledger.parentOf(sid))
  } else {
    recordAskedPlan(ctx, id, sid, message)
  }
}

/**
 * Journals a fast-reply provenance suspicion when a recorded ask was
 * answered faster than a human could plausibly read it (see
 * {@link FAST_REPLY_MS}). Journal-only: the suspicion never gates, and the
 * release the reply carries still applies — the row keeps the audit trail
 * honest about machine-looking replies (a non-interactive client
 * auto-answering) without inventing a host signal that does not exist.
 * @param ctx The shared per-setup context.
 * @param ctxRecordedAt The ask's `permission.asked` arrival time.
 * @param parent The parent session the ask belongs to.
 * @param decision The reply being applied (`"always"` / `"once"`).
 */
function noteFastReply(
  ctx: TurnstileContext,
  ctxRecordedAt: number,
  parent: string,
  decision: string,
): void {
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
 * Journals one `prov:denied` decision-provenance row for a human permission
 * denial. Additive to the existing `decisionEntry` row (which replay folds
 * on and which stays untouched). Fail-open: a builder error journals an
 * `error` row and never throws.
 * @param ctx The shared per-setup context.
 * @param sessionID The parent session the denial occurred in.
 * @param kind The ask kind that was denied.
 */
function journalProvDenied(ctx: TurnstileContext, sessionID: string, kind: ProvDeniedKind): void {
  if (!ctx.config.decisionLedger.enabled) return
  try {
    ctx.journaler.journal(
      provDeniedEntry({ sessionID, kind }) as unknown as Record<string, unknown>,
    )
  } catch (e) {
    ctx.journaler.journal({ type: "error", sessionID, error: `prov: denied capture: ${e}` })
  }
}

/**
 * Applies a human reply to a RECORDED plan-gate ask (the dispatcher's
 * falsy-record guard guarantees the record exists): "always" releases
 * the plan gate for the rest of the task and records provenance; "once"
 * stamps a single-dispatch grant; any other reply leaves the gate red.
 * The record is consumed (deleted) on every path.
 * @param ctx The shared per-setup context.
 * @param rid The host request id matching the recorded ask.
 * @param reply The human reply ("once" / "always" / "reject").
 */
function applyPlanGrant(ctx: TurnstileContext, rid: string, reply: unknown): void {
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
    noteFastReply(ctx, planRecord.recordedAt, parent, "always")
    ctx.journaler.journal(decisionEntry(parent, "always", { kind: "plan" }))
  } else if (reply === "once") {
    // A plan-gate single-dispatch grant: consumed by exactly one
    // executor dispatch in execute.before (the .plan
    // short-circuit), so a stale grant cannot outlive that
    // single dispatch.
    s.pendingOnceGrant.plan = rid
    noteFastReply(ctx, planRecord.recordedAt, parent, "once")
    ctx.journaler.journal(decisionEntry(parent, "once"))
  } else {
    // reject (or any non-allow reply) leaves the gate red: the
    // next execute.before dispatch re-blocks.
    ctx.journaler.journal(decisionEntry(parent, "reject"))
    journalProvDenied(ctx, parent, "plan")
  }
}

/**
 * Applies a landing-gate "always" reply: a standing human approval
 * releases the landing gate for the rest of the task (the bash guard sees
 * hasReviewApprove and allows every push). A human release outranks the
 * ensemble, so the refusal stamp on the last ensemble entry is cleared:
 * replay restores the human release (refusedApprove absent/false) rather
 * than an earlier refused APPROVE. The bucket-free trace is credited too:
 * the flag dies on the next task-scope reset, but this human release is
 * credit the journal already records (the cleared refusal stamp), so the
 * trace keeps live and restart behavior identical and lets the landing
 * gate escalate the next turn's first push instead of throwing.
 * @param ctx The shared per-setup context.
 * @param parent The parent session the ask belongs to.
 * @param recordedAt The ask's `permission.asked` arrival time.
 */
function applyLandingAlways(ctx: TurnstileContext, parent: string, recordedAt: number): void {
  const s = ctx.ledger.state(parent)
  s.hasReviewApprove = true
  ctx.ledger.markCreditedApproval(parent)
  noteFastReply(ctx, recordedAt, parent, "always")
  ctx.journaler.journal(
    reviewerEnsembleEntry(parent, ctx.config.agents.reviewer, s.reviewerDispatches, false),
  )
  ctx.journaler.journal(decisionEntry(parent, "always", { kind: "landing" }))
}

/**
 * Applies a landing-gate "once" reply: a single-dispatch push grant,
 * consumed by exactly one bash dispatch in execute.before (the .landing
 * short-circuit), so a stale grant cannot outlive that single push.
 * @param ctx The shared per-setup context.
 * @param parent The parent session the ask belongs to.
 * @param recordedAt The ask's `permission.asked` arrival time.
 * @param rid The host request id matching the recorded ask.
 */
function applyLandingOnce(
  ctx: TurnstileContext,
  parent: string,
  recordedAt: number,
  rid: string,
): void {
  ctx.ledger.state(parent).pendingOnceGrant.landing = rid
  noteFastReply(ctx, recordedAt, parent, "once")
  ctx.journaler.journal(decisionEntry(parent, "once"))
}

/**
 * Applies a human reply to a RECORDED landing-gate ask (the dispatcher's
 * falsy-record guard guarantees the record exists): "always" releases
 * the landing gate for the rest of the task; "once" stamps a
 * single-dispatch push grant; any other reply leaves the gate red. The
 * record is consumed (deleted) on every path.
 * @param ctx The shared per-setup context.
 * @param rid The host request id matching the recorded ask.
 * @param reply The human reply ("once" / "always" / "reject").
 */
function applyLandingGrant(ctx: TurnstileContext, rid: string, reply: unknown): void {
  const landingRecord = ctx.landingGateAsks.get(rid)!
  ctx.landingGateAsks.delete(rid)
  const parent = landingRecord.sessionID
  if (reply === "always") {
    applyLandingAlways(ctx, parent, landingRecord.recordedAt)
  } else if (reply === "once") {
    applyLandingOnce(ctx, parent, landingRecord.recordedAt, rid)
  } else {
    // reject (or any non-allow reply) leaves the gate red: the
    // next execute.before push re-blocks and re-arms the ask.
    ctx.journaler.journal(decisionEntry(parent, "reject"))
    journalProvDenied(ctx, parent, "landing")
  }
}

/**
 * Applies a human reply to a RECORDED hands-on-gate ask (the dispatcher's
 * falsy-record guard guarantees the record exists): "always" releases the
 * hands-on gate for the rest of the task (task-scoped, dropped by the next
 * prompt); "once" stamps a single-edit grant consumed by exactly one parent
 * write/edit; any other reply leaves the gate red — the next parent edit
 * re-blocks and re-arms. The record is consumed (deleted) on every path.
 * @param ctx The shared per-setup context.
 * @param rid The host request id matching the recorded ask.
 * @param reply The human reply ("once" / "always" / "reject").
 */
function applyHandsOnGrant(ctx: TurnstileContext, rid: string, reply: unknown): void {
  const handsOnRecord = ctx.handsOnGateAsks.get(rid)!
  ctx.handsOnGateAsks.delete(rid)
  const parent = handsOnRecord.sessionID
  const s = ctx.ledger.state(parent)
  if (reply === "always") {
    // A standing human approval releases the rest of this task's parent
    // edits (the guard sees handsOnRelease and allows every write/edit).
    s.handsOnRelease = true
    noteFastReply(ctx, handsOnRecord.recordedAt, parent, "always")
    ctx.journaler.journal(decisionEntry(parent, "always", { kind: "hands-on" }))
  } else if (reply === "once") {
    // A hands-on-gate single-edit grant: consumed by exactly one parent
    // write/edit in execute.before (the .handsOn short-circuit), so a
    // stale grant cannot outlive that single edit.
    s.pendingOnceGrant.handsOn = rid
    noteFastReply(ctx, handsOnRecord.recordedAt, parent, "once")
    ctx.journaler.journal(decisionEntry(parent, "once"))
  } else {
    // reject (or any non-allow reply) leaves the gate red: the next
    // parent edit re-blocks and re-arms the ask.
    ctx.journaler.journal(decisionEntry(parent, "reject"))
    journalProvDenied(ctx, parent, "hands-on")
  }
}

/**
 * Journals a permission reply whose non-empty requestID matches no
 * recorded ask: the inert no-op is diagnosable, and the entry carries
 * no action/decision (the human PERM table is untouched and it is
 * replay-inert). A requestID-less reply is a distinct,
 * already-understood broken-host case and stays silent.
 * @param ctx The shared per-setup context.
 * @param rid The unmatched host request id.
 * @param sessionID The session the reply arrived in.
 */
function noteUnrecordedReply(ctx: TurnstileContext, rid: string, sessionID: string): void {
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
 * once, releases/holds the plan gate), a landing-gate ask (consumed
 * once, grants/holds a push), or a hands-on-gate ask. A requestID
 * absent from all three maps was never an ask we raised, so the reply
 * is inert — an approval of an unrelated permission ask cannot release
 * any gate. Fail-open — the outer loop journals any throw.
 * @param ctx The shared per-setup context.
 * @param properties The resolved event properties.
 */
function handlePermissionReplied(ctx: TurnstileContext, properties: EventProperties): void {
  const rid = String(properties.requestID ?? "")
  const reply = properties.reply
  if (ctx.planGateAsks.get(rid)) {
    applyPlanGrant(ctx, rid, reply)
  } else if (ctx.landingGateAsks.get(rid)) {
    applyLandingGrant(ctx, rid, reply)
  } else if (ctx.handsOnGateAsks.get(rid)) {
    applyHandsOnGrant(ctx, rid, reply)
  } else if (rid !== "") {
    noteUnrecordedReply(ctx, rid, asSessionID(properties.sessionID))
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
 * @param ctx The shared per-setup context.
 * @param properties The resolved event properties.
 */
function handleInboxEnqueued(ctx: TurnstileContext, properties: EventProperties): void {
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

/**
 * Best-effort toast delivery of the session-end summary: a rejecting or
 * throwing toast journals an `error` entry and changes nothing else
 * (fail-open) — the journal entry is the headless log line either way.
 * @param ctx The shared per-setup context.
 * @param line The summary line to toast.
 */
async function deliverToast(ctx: TurnstileContext, line: string): Promise<void> {
  if (!ctx.toast) return
  try {
    await ctx.toast(line, "success")
  } catch (e) {
    ctx.journaler.journal({ type: "error", error: `session-summary toast: ${e}` })
  }
}

/**
 * Runs the optional session-end chain+anchor verify (`verifyOnSessionEnd`)
 * and journals the verdict as a `chain-verify` row, toasting on failure
 * when the host offers a toast. Fail-open: a verify error journals and
 * never breaks the idle handler.
 * @param ctx The shared per-setup context.
 * @param sid The idle session ID.
 */
async function runSessionEndVerify(ctx: TurnstileContext, sid: string): Promise<void> {
  if (!ctx.config.tamperEvidence.verifyOnSessionEnd) return
  try {
    const report = await verifyJournalChain({
      metricsDir: ctx.config.metricsDir,
      sinks: ctx.anchorSinks,
      maxGenerations: ctx.config.journalMaxGenerations,
    })
    const broken = report.families.find((f) => f.verdict.status === "broken")
    const detail =
      broken && broken.verdict.status === "broken"
        ? `${broken.source}: ${broken.verdict.detail}`
        : report.ok
          ? ""
          : report.absentAnchored.length > 0
            ? report.absentAnchored.join("; ")
            : "unanchored epoch refs"
    ctx.journaler.journal(
      report.ok
        ? { type: "chain-verify", ok: true, sessionID: sid }
        : { type: "chain-verify", ok: false, sessionID: sid, detail },
    )
    if (!report.ok) await deliverToast(ctx, `[turnstile] chain verify failed: ${detail}`)
  } catch (e) {
    ctx.journaler.journal({ type: "error", error: `chain-verify: ${String(e)}` })
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
 * @param ctx The shared per-setup context.
 * @param properties The resolved event properties.
 */
async function handleSessionIdle(
  ctx: TurnstileContext,
  properties: EventProperties,
): Promise<void> {
  const sid = typeof properties.sessionID === "string" ? properties.sessionID : ""
  if (sid === "" || ctx.summarizedSessions.has(sid)) return
  ctx.summarizedSessions.add(sid)
  ctx.boundSummarizedSessions()
  // The session-end anchor trigger runs first and its publish is awaited, so
  // refs closed/published for this session count as anchored in the verify
  // that follows (no false "unanchored epoch refs" verdict). Fail-open by
  // the journaler's anchor contract.
  await ctx.journaler.anchorAsync("session-end", sid)
  // The chain verify is independent of the summary setting: it runs once per
  // session even when sessionSummary is "off".
  await runSessionEndVerify(ctx, sid)
  if (ctx.config.sessionSummary === "off") return
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
  await deliverToast(ctx, line)
}

/**
 * Builds the event-type → handler dispatch table, in stream source order.
 * Every handler is bound to the shared context; the table is consumed by
 * `startEventStream`'s consume loop, which journals per-event failures
 * fail-open.
 * @param ctx The shared per-setup context (journaler, ledger, marker
 *     services, ask latches, delta windows, admission state).
 * @returns The dispatch table keyed by host event type.
 */
export function createEventHandlers(ctx: TurnstileContext): Record<string, EventHandler> {
  return {
    "session.created": (p) => handleSessionCreated(ctx, p),
    "message.part.updated": (p) => handleTextUpdated(ctx, p),
    "session.text.ended": (p) => handleTextEnded(ctx, p),
    "session.text.delta": (p) => handleTextDelta(ctx, p),
    "session.error": (p) => handleSessionError(ctx, p),
    "permission.asked": (p) => handlePermissionAsked(ctx, p),
    "permission.replied": (p) => handlePermissionReplied(ctx, p),
    "session.inbox.enqueued": (p) => handleInboxEnqueued(ctx, p),
    "session.idle": (p) => handleSessionIdle(ctx, p),
  }
}
