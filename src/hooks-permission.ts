/**
 * @fileoverview Permission-surface hook body: the `evaluate` handler for
 * the task-dispatch plan-gate escalation (ask under `escalation: "ask"`,
 * inert under the default `"block"` — the dispatch guard blocks instead),
 * the bash/shell landing-gate arm,
 * and the write/edit hands-on-gate arm. The payload carries NO tool input,
 * so the plan-gate arm is driven purely by the parent session's plan-gate
 * state (planGateStatus), never the dispatch target; the landing and
 * hands-on arms
 * consult the one-shot latches their guards armed rather than re-reading the
 * command. The handler never blocks the host: every failure journals
 * fail-open.
 */

import { asSessionID, PLAN_ASK_MESSAGE_PREFIX } from "./delivery.ts"
import type { TurnstileContext } from "./hooks-core.ts"
import { waiverCovers } from "./gates-common.ts"
import { HANDSON_REQUIREMENT, LANDING_REQUIREMENT } from "./tool-policy.ts"
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
   * parent the behavior splits by `escalation` — under `"ask"` it forces
   * the host to ask the human, naming the plan file + head (the plan body
   * is trace-gated per the SECURITY.md redaction contract), journals the
   * ask, and latches the parent as awaiting its plan ask so the NEXT
   * permission.asked stream event for this session is the one recorded
   * (only escalated asks can ever match); under `"block"` (the default) it
   * stays inert — the dispatch guard blocks with the stop-and-report
   * instruction and release flows via `PLAN APPROVED:` plus the sticky
   * waiver/ask paths. The
   * bash/shell arm: a live one-shot landing latch (armed by the guard on
   * a repeat attempt) forces an ask for the landing requirement and
   * consumes the latch; a hasReviewApprove state or an unarmed latch
   * returns inert. The write/edit arm mirrors the landing arm for the
   * hands-on gate: a live one-shot hands-on latch forces an ask naming the
   * hands-on requirement and consumes the latch; a live `always` release,
   * an executor-scoped waiver, a suspended parent, or an unarmed latch
   * returns inert (suspension also deletes the latch — the one-shot
   * consume, so a pre-suspension arm cannot fire a mislabeled ask after
   * `TURNSTILE ON:`; the guard re-arms on a fresh repeat attempt). Plan
   * approval does not release the hands-on arm. Returns without effect for
   * any other action.
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
        // Under `escalation: "ask"`: force the host to ask the human, naming
        // the plan file + head (the plan body is trace-gated per the
        // SECURITY.md redaction contract). Journal the ask so a reply can be
        // matched (the requestID rides the permission.asked stream event).
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
      // is armed (the guard set the pending-landing-ask latch on an armed
      // attempt under `escalation: "ask"` — under the default `"block"` no
      // latch is ever armed, so this arm stays inert by construction). Candidate detection lives in
      // `isPushLanding` (used by the guard); the evaluate handler
      // consults the arm rather than re-reading the command from the
      // (host-shape-uncertain) permission event — the guard is the single
      // source of truth for landing-candidate detection. Approval
      // releases the gate; a live latch means the human must decide this
      // landing (the first block already threw).
      // The arm is ONE-SHOT: it is consumed by the first evaluate it
      // forces. The permission request the arm is meant to attach to is
      // the very next one (the repeat push the guard just allowed through
      // for escalation), so a one-shot latch cannot mislabel a later
      // unrelated command with the push/PR ask inside the TTL window.
      if (pe?.action === "bash" || pe?.action === "shell") {
        const parent = ctx.ledger.parentOf(sessionID)
        // Gate suspension: inert, and the armed landing latch is deleted (the
        // one-shot consume, mirroring the forced ask below) so a latch armed
        // before the suspension cannot fire a mislabeled landing ask after
        // `TURNSTILE ON:` — the guard re-arms on a fresh repeat attempt, so
        // no enforcement is lost.
        if (ctx.ledger.isSuspended(parent)) {
          ctx.pendingLandingAsk.delete(parent)
          // Mirror the suspension consume on the dedupe map: a stale
          // timestamp must not suppress a legitimate ask row after the
          // suspension (the guard re-arms on a fresh attempt).
          ctx.lastLandingEscalateAt.delete(parent)
          return
        }
        const st = ctx.ledger.state(parent)
        if (st.hasReviewApprove) return
        if (!ctx.hasLiveLandingAsk(parent)) return
        ctx.pendingLandingAsk.delete(parent)
        // One-shot consume: the dedupe timestamp goes with the latch so the
        // next (genuinely new) escalation can journal a fresh ask row.
        ctx.lastLandingEscalateAt.delete(parent)
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
      // Hands-on arm: a write/edit permission.evaluate whose hands-on ask is
      // armed (the guard set the pending-hands-on-ask latch on a repeat
      // parent attempt under `escalation: "ask"` — under the default
      // `"block"` no latch is ever armed, so this arm stays inert by
      // construction). The guard is the single source of truth for
      // the parent-only contract; the evaluate handler consults the arm
      // rather than re-reading the (host-shape-uncertain) event. A live
      // `always` release or an executor-scoped waiver inerts the arm without
      // consuming the latch (the release outlives the one-shot ask). Plan
      // approval never releases it. The arm is ONE-SHOT (consumed by the
      // first evaluate it forces, same contract as the landing arm).
      if (pe?.action === "write" || pe?.action === "edit") {
        const parent = ctx.ledger.parentOf(sessionID)
        // Gate suspension: inert, and the armed hands-on latch is deleted
        // (the one-shot consume, mirroring the forced ask below) so a latch
        // armed before the suspension cannot fire a mislabeled hands-on ask
        // after `TURNSTILE ON:` — the guard re-arms on a fresh repeat
        // attempt, so no enforcement is lost.
        if (ctx.ledger.isSuspended(parent)) {
          ctx.pendingHandsOnAsk.delete(parent)
          // Mirror the suspension consume on the dedupe map (same rationale
          // as the landing arm above).
          ctx.lastHandsOnEscalateAt.delete(parent)
          return
        }
        const st = ctx.ledger.state(parent)
        if (st.handsOnRelease || waiverCovers(st, ["executor"])) return
        if (!ctx.hasLiveHandsOnAsk(parent)) return
        ctx.pendingHandsOnAsk.delete(parent)
        // One-shot consume: the dedupe timestamp goes with the latch so the
        // next (genuinely new) escalation can journal a fresh ask row.
        ctx.lastHandsOnEscalateAt.delete(parent)
        pe.effect = "ask"
        pe.message = `turnstile: ${HANDSON_REQUIREMENT}`
        // Stamp the consume, not the ask: the guard already journaled the
        // `{action:"ask", reason:"hands-on"}` entry (the single PERM-ask
        // record status.mjs counts), so this row deliberately omits action
        // and carries event:"forced" — the consume is diagnosed by event.
        // Replay-inert (the ledger never replays permission rows).
        ctx.journaler.journal({
          type: "permission",
          sessionID: parent,
          reason: "hands-on",
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
