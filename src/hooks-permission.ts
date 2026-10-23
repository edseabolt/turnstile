/**
 * @fileoverview Permission-surface hook body: the `evaluate` handler for
 * the task-dispatch plan-gate escalation and the bash/shell landing-gate
 * arm. The payload carries NO tool input, so escalation is driven purely
 * by the parent session's plan-gate state (planGateStatus), never the
 * dispatch target; the landing arm consults the one-shot latch the bash
 * guard armed rather than re-reading the command. The handler never
 * blocks the host: every failure journals fail-open.
 */

import { asSessionID, PLAN_ASK_MESSAGE_PREFIX } from "./delivery.ts"
import type { TurnstileContext } from "./hooks-core.ts"
import { LANDING_REQUIREMENT } from "./tool-policy.ts"
import type { PermissionEvaluateEvent } from "./types.ts"

/**
 * Permission-surface hook body bound to one shared per-setup context. The
 * registration, tracking, and per-surface try/catch guard stay in
 * src/setup.ts; this body carries only the per-event behavior.
 * @param ctx The shared per-setup context (config, journaler, ledger,
 *     gates, and the plan/landing ask latches).
 * @returns The evaluate hook body.
 */
export function createPermissionHooks(ctx: TurnstileContext): {
  evaluate(event: unknown): void
} {
  /**
   * Permission.evaluate body. The task arm: on a red plan gate for the
   * parent it forces the host to ask the human, naming the plan file +
   * head (the plan body is trace-gated per the SECURITY.md redaction
   * contract), journals the ask, and latches the parent as awaiting its
   * plan ask so the NEXT permission.asked stream event for this session
   * is the one recorded (only escalated asks can ever match). The
   * bash/shell arm: a live one-shot landing latch (armed by the guard on
   * a repeat attempt) forces an ask for the landing requirement and
   * consumes the latch; a hasReviewApprove state or an unarmed latch
   * returns inert. Returns without effect for any other action.
   * @param event The host permission evaluate payload (untyped at the wire).
   */
  function evaluate(event: unknown): void {
    try {
      const pe = event as PermissionEvaluateEvent
      const sessionID = asSessionID(pe?.sessionID)
      // Plan-approval arm: the task/subagent dispatch exposes
      // `action === "task"`; the payload carries no tool input, so
      // escalation is driven purely by the parent's plan-gate state.
      if (pe?.action === "task") {
        const parent = ctx.ledger.parentOf(sessionID)
        const status = ctx.gates.planGateStatus(ctx.currentProjectDir(parent), ctx.ledger, parent)
        if (!status.red) return
        // Red ⇒ summary is present by construction (planGateStatus builds
        // it from a scan whose active-plan preview was already resolved).
        // Escalate:
        // force the host to ask the human, naming the plan file + head.
        // Journal the ask so a reply can be matched (the requestID rides
        // the permission.asked stream event).
        const file = status.summary!.file
        // The plan body is prompt context; journal/quote it only when the
        // trace is enabled (SECURITY.md redaction contract), mirroring how
        // the waiver quote is trace-gated at capture. Without it the ask
        // still names the plan file.
        const head = ctx.config.trace ? status.summary!.head : ""
        pe.effect = "ask"
        pe.message = head
          ? `${PLAN_ASK_MESSAGE_PREFIX} — ${file}: ${head}`
          : `${PLAN_ASK_MESSAGE_PREFIX} — ${file}`
        // Mark this parent as awaiting its plan ask: the NEXT
        // permission.asked stream event for this session is recorded as
        // the plan-gate ask, so only escalated asks can ever match.
        ctx.awaitingPlanAsk.set(parent, Date.now())
        ctx.boundAwaitingAsks()
        ctx.journaler.journal({
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
        const parent = ctx.ledger.parentOf(sessionID)
        const st = ctx.ledger.state(parent)
        if (st.hasReviewApprove) return
        if (!ctx.hasLiveLandingAsk(parent)) return
        ctx.pendingLandingAsk.delete(parent)
        pe.effect = "ask"
        pe.message = `turnstile: ${LANDING_REQUIREMENT}`
        // Stamp the consume, not the ask: the guard already journaled the
        // `{action:"ask", reason:"landing"}` entry (the single PERM-ask record
        // status.mjs counts), so this row deliberately omits action and carries
        // event:"forced" — the consume is diagnosed by event, not by a
        // duplicated ask. Replay-inert (the ledger never replays permission
        // rows) and status-inert (no action/decision).
        ctx.journaler.journal({
          type: "permission",
          sessionID: parent,
          reason: "landing",
          event: "forced",
        })
        return
      }
      return
    } catch (e) {
      // Fail-open: the evaluate handler NEVER blocks the host.
      ctx.journaler.journal({ type: "error", error: `permission evaluate: ${e}` })
    }
  }

  return { evaluate }
}
