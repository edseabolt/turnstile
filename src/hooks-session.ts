/**
 * @fileoverview Session-surface hook factory: binds the four session-hook
 * bodies (prompt, generate, context, compaction — see
 * `src/hooks-session-bodies.ts`) to the shared per-setup context and wraps
 * each in the fail-open try/catch contract (internal errors are journaled,
 * never thrown). Registration, tracking, and per-surface guards stay in
 * src/setup.ts.
 */

import type { TurnstileContext } from "./hooks-core.ts"
import {
  sessionCompactionBody,
  sessionContextBody,
  sessionGenerateBody,
  sessionPromptBody,
} from "./hooks-session-bodies.ts"
import type { CompactionDraft, GenerateDraft, PromptHookProperties } from "./types.ts"

/**
 * Session-surface hook bodies bound to one shared per-setup context. The
 * registration, tracking, and per-surface try/catch guards stay in
 * src/setup.ts; these bodies carry only the per-event behavior.
 * @param ctx The shared per-setup context (config, journaler, ledger,
 *     prompt counters, and admission state).
 * @returns The prompt, generate, context, and compaction hook bodies.
 */
/** The session-surface hook bodies `createSessionHooks` returns. */
interface SessionHookBodies {
  prompt(properties: PromptHookProperties): void
  generate(draft: GenerateDraft): void
  context(draft: GenerateDraft): void
  compaction(draft: CompactionDraft): void
}

export function createSessionHooks(ctx: TurnstileContext): SessionHookBodies {
  return {
    prompt(properties: PromptHookProperties): void {
      sessionPromptBody(ctx, properties)
    },
    generate(draft: GenerateDraft): void {
      try {
        sessionGenerateBody(ctx, draft)
      } catch (e) {
        ctx.journaler.journal({ type: "error", error: `generate hook: ${e}` })
      }
    },
    context(draft: GenerateDraft): void {
      try {
        sessionContextBody(ctx, draft)
      } catch (e) {
        ctx.journaler.journal({ type: "error", error: `context hook: ${e}` })
      }
    },
    compaction(draft: CompactionDraft): void {
      try {
        sessionCompactionBody(ctx, draft)
      } catch (e) {
        ctx.journaler.journal({ type: "error", error: `compaction hook: ${e}` })
      }
    },
  }
}
