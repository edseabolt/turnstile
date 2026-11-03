/**
 * @fileoverview Permission-surface hook factory: binds the evaluate handler
 * (extracted to `src/permission-evaluate.ts`) to one shared per-setup
 * context. The registration, tracking, and per-surface try/catch guard stay
 * in src/setup.ts; this body carries only the per-event behavior. The
 * handler never blocks the host: every failure journals fail-open.
 */

import type { TurnstileContext } from "./hooks-core.ts"
import { permissionEvaluate } from "./permission-evaluate.ts"

/**
 * Permission-surface hook body bound to one shared per-setup context. The
 * factory holds no state: the body delegates to the shared context.
 * @param ctx The shared per-setup context (config, journaler, ledger,
 *     gates, and the plan/landing ask latches).
 * @returns The evaluate hook body.
 */
export function createPermissionHooks(ctx: TurnstileContext): {
  evaluate(event: unknown): void
} {
  return {
    /**
     * Permission.evaluate body. The task arm: on a red plan gate for the
     * parent the behavior splits by `escalation` — under `"ask"` it forces
     * the host to ask the human (plan file + head, trace-gated), under
     * `"block"` (the default) it stays inert. The bash/shell arm: a live
     * one-shot landing latch forces an ask for the landing requirement and
     * consumes the latch. The write/edit arm mirrors it for the hands-on
     * gate. Returns without effect for any other action. Fail-open: every
     * failure journals, the host is never blocked.
     * @param event The host permission evaluate payload (untyped at the wire).
     */
    evaluate(event: unknown): void {
      try {
        permissionEvaluate(ctx, event)
      } catch (e) {
        // Fail-open: the evaluate handler NEVER blocks the host.
        ctx.journaler.journal({ type: "error", error: `permission evaluate: ${e}` })
      }
    },
  }
}
