/**
 * @fileoverview Tool-surface hook factory: binds the execute.before and
 * execute.after bodies (extracted to `src/tool-hooks-before.ts` and
 * `src/tool-hooks-after.ts`) to one shared per-setup context. The
 * registration, tracking, and the before wrapper's BlockError rethrow
 * stay in src/setup.ts; these bodies carry only the per-event behavior.
 */

import type { TurnstileContext } from "./hooks-core.ts"
import { toolHooksAfter } from "./tool-hooks-after.ts"
import { toolHooksBefore } from "./tool-hooks-before.ts"
import type { ToolHookEvent } from "./types.ts"

/**
 * Tool-surface hook bodies bound to one shared per-setup context. The
 * factory holds no state: both bodies delegate to the shared context.
 * @param ctx The shared per-setup context (config, journaler, ledger,
 *     gates, tool policy, evidence tracker, and the dispatch/verdict
 *     services).
 * @returns The execute.before and execute.after hook bodies.
 */
export function createToolHooks(ctx: TurnstileContext): {
  before(event: ToolHookEvent): Promise<void>
  after(event: ToolHookEvent): Promise<void>
} {
  return {
    before: (event) => toolHooksBefore(ctx, event),
    after: (event) => toolHooksAfter(ctx, event),
  }
}
