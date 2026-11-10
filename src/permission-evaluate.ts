/**
 * @fileoverview Permission-surface evaluate arms: the task-dispatch plan-gate
 * escalation arm, the bash/shell landing-gate arm, and the write/edit
 * hands-on-gate arm, plus the shared one-shot latch-consume helper. The
 * payload carries NO tool input, so the plan-gate arm is driven purely by the
 * parent session's plan-gate state (planGateStatus), never the dispatch
 * target; the landing and hands-on arms consult the one-shot latches their
 * guards armed rather than re-reading the command. Every arm is called from
 * the fail-open catch in `src/hooks-permission.ts` — the arms never throw.
 */

import { asSessionID, PLAN_ASK_MESSAGE_PREFIX } from "./delivery.ts"
import type { TurnstileContext } from "./hooks-core.ts"
import { waiverCovers } from "./gates-common.ts"
import { HANDSON_REQUIREMENT, LANDING_REQUIREMENT } from "./tool-policy.ts"
import type { PermissionEvaluateEvent } from "./types.ts"

/**
 * Forces the host ask for a red plan gate under `escalation: "ask"`: names
 * the plan file + head (the plan body is trace-gated per the SECURITY.md
 * redaction contract), journals the ask so a reply can be matched (the
 * requestID rides the permission.asked stream event), and latches the
 * parent as awaiting its plan ask so the NEXT permission.asked stream
 * event for this session is the one recorded (only escalated asks can ever
 * match).
 * @param ctx The shared per-setup context.
 * @param parent The parent session ID.
 * @param pe The host permission evaluate payload (mutated in place).
 * @param file The plan file path to name in the ask.
 * @param head The trace-gated plan head ("" when the trace is off).
 */
function forcePlanAsk(
  ctx: TurnstileContext,
  parent: string,
  pe: PermissionEvaluateEvent,
  file: string,
  head: string,
): void {
  pe.effect = "ask"
  pe.message = head
    ? `${PLAN_ASK_MESSAGE_PREFIX} — ${file}: ${head}`
    : `${PLAN_ASK_MESSAGE_PREFIX} — ${file}`
  ctx.awaitingPlanAsk.set(parent, Date.now())
  ctx.boundAwaitingAsks()
  ctx.journaler.journal({
    type: "permission",
    sessionID: parent,
    action: "ask",
    // The requestID is attached to the subsequent permission.asked
    // stream event (matched by message prefix / latch).
    reason: "plan-gate",
    plan: file,
  })
}

/**
 * The task-dispatch plan-gate escalation arm: on a red plan gate for the
 * parent the behavior splits by `escalation` — under `"ask"` it forces the
 * host to ask the human (see forcePlanAsk); under `"block"` (the default)
 * it stays inert — the dispatch guard blocks with the stop-and-report
 * instruction and release flows via `PLAN APPROVED:` plus the sticky
 * waiver/ask paths.
 * @param ctx The shared per-setup context.
 * @param parent The parent session ID.
 * @param pe The host permission evaluate payload (mutated in place).
 */
function evaluateTaskArm(ctx: TurnstileContext, parent: string, pe: PermissionEvaluateEvent): void {
  // Gate suspension: both evaluate arms are inert while the parent is
  // suspended — the dispatch guards already computed and journaled the
  // red status upstream, so no ask and no latch here.
  if (ctx.ledger.isSuspended(parent)) return
  const status = ctx.gates.planGateStatus(ctx.currentProjectDir(parent), ctx.ledger, parent)
  if (!status.red) return
  // Under `escalation: "block"` (the default) the arm stays inert: the
  // dispatch guard (`enforcePlanApproval`) blocks the dispatch with the
  // stop-and-report instruction and journals the `blocked` row, and the
  // release channels are `PLAN APPROVED:` (replay-restored) plus the
  // sticky waiver/ask paths — no permission ask is forced here.
  if (ctx.config.escalation !== "ask") return
  // The plan body is prompt context; journal/quote it only when the
  // trace is enabled (SECURITY.md redaction contract), mirroring how
  // the waiver quote is trace-gated at capture. Without it the ask
  // still names the plan file.
  forcePlanAsk(ctx, parent, pe, status.summary!.file, ctx.config.trace ? status.summary!.head : "")
}

/**
 * The shared one-shot latch consume for the landing and hands-on arms:
 * deletes the armed latch and its dedupe timestamp (the one-shot consume —
 * the dedupe timestamp goes with the latch so the next genuinely new
 * escalation can journal a fresh ask row), forces the host ask naming the
 * requirement, and journals the consume row. Stamp the consume, not the
 * ask: the guard already journaled the `{action:"ask", reason:…}` entry
 * (the single PERM-ask record status.mjs counts), so this row deliberately
 * omits action and carries event:"forced" — the consume is diagnosed by
 * event, not by a duplicated ask. Replay-inert (the ledger never replays
 * permission rows) and status-inert (no action/decision).
 * @param ctx The shared per-setup context.
 * @param parent The parent session ID.
 * @param pe The host permission evaluate payload (mutated in place).
 * @param requirement The human-facing requirement text for the ask message.
 * @param reason The gate reason ("landing" or "hands-on") for the row.
 * @param latchMap The armed one-shot latch map to consume from.
 * @param dedupeMap The escalation dedupe timestamp map to consume from.
 */
function consumeEscalationLatch(
  ctx: TurnstileContext,
  parent: string,
  pe: PermissionEvaluateEvent,
  requirement: string,
  reason: string,
  latchMap: Map<string, number>,
  dedupeMap: Map<string, number>,
): void {
  latchMap.delete(parent)
  dedupeMap.delete(parent)
  pe.effect = "ask"
  pe.message = `turnstile: ${requirement}`
  ctx.journaler.journal({
    type: "permission",
    sessionID: parent,
    reason,
    event: "forced",
  })
}

/**
 * The bash/shell landing-gate arm: a live one-shot landing latch (armed by
 * the guard on a repeat attempt in BOTH `escalation` modes — the ask-first
 * ladder arms the latch and the block-throw is only the no-human fallback)
 * forces an ask for the landing requirement and consumes the
 * latch; a hasReviewApprove state or an unarmed latch returns inert.
 * Candidate detection lives in `isPushLanding` (used by the guard); the arm
 * consults the latch rather than re-reading the command from the
 * (host-shape-uncertain) permission event — the guard is the single source
 * of truth for landing-candidate detection. Approval releases the gate; a
 * live latch means the human must decide this landing (the first block
 * already threw). The arm is ONE-SHOT: it is consumed by the first evaluate
 * it forces. The permission request the arm is meant to attach to is the
 * very next one (the repeat push the guard just allowed through for
 * escalation), so a one-shot latch cannot mislabel a later unrelated
 * command with the push/PR ask inside the TTL window.
 * @param ctx The shared per-setup context.
 * @param parent The parent session ID.
 * @param pe The host permission evaluate payload (mutated in place).
 */
function evaluateLandingArm(
  ctx: TurnstileContext,
  parent: string,
  pe: PermissionEvaluateEvent,
): void {
  // Gate suspension: inert, and the armed landing latch is deleted (the
  // one-shot consume, mirroring the forced ask) so a latch armed before
  // the suspension cannot fire a mislabeled landing ask after
  // `TURNSTILE ON:` — the guard re-arms on a fresh repeat attempt, so
  // no enforcement is lost. The dedupe map is consumed with it: a stale
  // timestamp must not suppress a legitimate ask row after the suspension.
  if (ctx.ledger.isSuspended(parent)) {
    ctx.pendingLandingAsk.delete(parent)
    ctx.lastLandingEscalateAt.delete(parent)
    return
  }
  if (ctx.ledger.state(parent).hasReviewApprove) return
  if (!ctx.hasLiveLandingAsk(parent)) return
  consumeEscalationLatch(
    ctx,
    parent,
    pe,
    LANDING_REQUIREMENT,
    "landing",
    ctx.pendingLandingAsk,
    ctx.lastLandingEscalateAt,
  )
}

/**
 * The write/edit hands-on-gate arm: mirrors the landing arm for the
 * hands-on gate — a live one-shot hands-on latch (armed by the guard on a
 * repeat parent attempt in BOTH `escalation` modes — the ask-first
 * ladder arms the latch and the block-throw is only the no-human fallback)
 * forces an ask naming the
 * hands-on requirement and consumes the latch; a live `always` release, an
 * executor-scoped waiver, a suspended parent, or an unarmed latch returns
 * inert (suspension also deletes the latch — the one-shot consume, so a
 * pre-suspension arm cannot fire a mislabeled ask after `TURNSTILE ON:`;
 * the guard re-arms on a fresh repeat attempt). A live `always` release or
 * an executor-scoped waiver inerts the arm WITHOUT consuming the latch (the
 * release outlives the one-shot ask). Plan approval never releases it.
 * @param ctx The shared per-setup context.
 * @param parent The parent session ID.
 * @param pe The host permission evaluate payload (mutated in place).
 */
function evaluateHandsOnArm(
  ctx: TurnstileContext,
  parent: string,
  pe: PermissionEvaluateEvent,
): void {
  // Gate suspension: inert, and the armed hands-on latch is deleted (the
  // one-shot consume, mirroring the forced ask) so a latch armed before
  // the suspension cannot fire a mislabeled hands-on ask after
  // `TURNSTILE ON:` — the guard re-arms on a fresh repeat attempt, so
  // no enforcement is lost. The dedupe map is consumed with it (same
  // rationale as the landing arm).
  if (ctx.ledger.isSuspended(parent)) {
    ctx.pendingHandsOnAsk.delete(parent)
    ctx.lastHandsOnEscalateAt.delete(parent)
    return
  }
  const st = ctx.ledger.state(parent)
  if (st.handsOnRelease || waiverCovers(st, ["executor"])) return
  if (!ctx.hasLiveHandsOnAsk(parent)) return
  consumeEscalationLatch(
    ctx,
    parent,
    pe,
    HANDSON_REQUIREMENT,
    "hands-on",
    ctx.pendingHandsOnAsk,
    ctx.lastHandsOnEscalateAt,
  )
}

/**
 * Permission.evaluate body: coerces the session ID, dispatches to the arm
 * matching the action (task → plan-gate escalation, bash/shell → landing
 * gate, write/edit → hands-on gate), and returns without effect for any
 * other action. The caller wraps this in the fail-open catch — the arms
 * never throw.
 * @param ctx The shared per-setup context (config, journaler, ledger,
 *     gates, and the plan/landing ask latches).
 * @param event The host permission evaluate payload (untyped at the wire).
 */
export function permissionEvaluate(ctx: TurnstileContext, event: unknown): void {
  const pe = event as PermissionEvaluateEvent
  const sessionID = asSessionID(pe?.sessionID)
  const parent = ctx.ledger.parentOf(sessionID)
  // Plan-approval arm: the task/subagent dispatch exposes
  // `action === "task"`; the payload carries no tool input, so
  // escalation is driven purely by the parent's plan-gate state.
  if (pe?.action === "task") return evaluateTaskArm(ctx, parent, pe)
  // Landing arm: a bash/shell permission.evaluate whose landing ask is
  // armed (see evaluateLandingArm).
  if (pe?.action === "bash" || pe?.action === "shell") return evaluateLandingArm(ctx, parent, pe)
  // Hands-on arm: a write/edit permission.evaluate whose hands-on ask is
  // armed (see evaluateHandsOnArm).
  if (pe?.action === "write" || pe?.action === "edit") return evaluateHandsOnArm(ctx, parent, pe)
}
