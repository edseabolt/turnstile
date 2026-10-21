/**
 * @fileoverview Session-surface hook bodies: prompt admission (counted on
 * every fire as the dead-channel telemetry key, deduped across the hook +
 * inbox transport paths), the pipeline-agent decoding clamps (reviewer and
 * plan-reviewer forced to temperature 0; executor, test-runner, and
 * debugger clamped to ≤ 0.2), and the compaction context (the
 * preserve-verbatim instruction plus the live gate snapshot). The bodies
 * are fail-open: their inner try/catch journal every failure, and the
 * registration guard in src/setup.ts catches registration errors.
 */

import { asSessionID } from "./delivery.ts"
import type { TurnstileContext } from "./hooks-core.ts"
import { formatGateSnapshot } from "./state.ts"
import type { CompactionDraft, GenerateDraft, PromptHookProperties } from "./types.ts"

/**
 * Session-surface hook bodies bound to one shared per-setup context. The
 * registration, tracking, and per-surface try/catch guards stay in
 * src/setup.ts; these bodies carry only the per-event behavior.
 * @param ctx The shared per-setup context (config, journaler, ledger,
 *     prompt counters, and admission state).
 * @returns The prompt, generate, and compaction hook bodies.
 */
export function createSessionHooks(ctx: TurnstileContext): {
  prompt(properties: PromptHookProperties): void
  generate(draft: GenerateDraft): void
  compaction(draft: CompactionDraft): void
} {
  /**
   * Prompt-hook body: counts the fire (a zero count when the inbox stream
   * admits marks this surface as hook-less — the dead-channel telemetry
   * key) and admits the prompt once across both transport paths.
   * @param properties The host prompt-hook payload.
   */
  function prompt(properties: PromptHookProperties): void {
    // Count dispatches even when the session id is unusable; a zero
    // count when the inbox stream admits marks this surface as hook-less
    // (the dead-channel telemetry key).
    ctx.bumpPromptFires()
    const sessionID = properties?.sessionID
    if (typeof sessionID === "string") {
      // One prompt is admitted once across both transport paths, deduped
      // by the shared host message id ("" when the host sent none).
      ctx.admitPrompt(
        sessionID,
        properties,
        typeof properties.messageID === "string" ? properties.messageID : "",
      )
    }
  }

  /**
   * Generate-hook body: reviewer and plan-reviewer run at temperature 0 —
   * forced even when the host sent no options object at all, since the
   * early return would otherwise skip the clamp in exactly that case.
   * Executor, test-runner, and debugger clamp to ≤ 0.2 — the clamp also
   * applies when the host sent no temperature, since an unset temperature
   * is whatever the host defaults to, which is exactly what the ≤ 0.2
   * contract bounds.
   * @param draft The host generate-hook draft (mutated in place).
   */
  function generate(draft: GenerateDraft): void {
    try {
      if (!draft) return
      const agent = typeof draft.agent === "string" ? draft.agent : ""
      if (agent === ctx.config.agents.reviewer || agent === ctx.config.agents.planReviewer) {
        // Force 0 even when the host sent no options object at all:
        // today's early return skipped the clamp in exactly that case.
        if (!draft.options) draft.options = {}
        draft.options.temperature = 0
      } else if (
        agent === ctx.config.agents.executor ||
        agent === ctx.config.agents.testRunner ||
        agent === ctx.config.agents.debugger
      ) {
        // Clamp also applies when the host sent no temperature: an
        // unset temperature is whatever the host defaults to, which
        // is exactly what the ≤ 0.2 contract bounds.
        if (!draft.options) draft.options = {}
        const t = draft.options.temperature
        draft.options.temperature = typeof t === "number" ? Math.min(t, 0.2) : 0.2
      }
    } catch (e) {
      ctx.journaler.journal({ type: "error", error: `generate hook: ${e}` })
    }
  }

  /**
   * Compaction-hook body: appends the preserve-verbatim instruction, then
   * the concrete gate state from the live ledger alongside it. The bucket
   * is keyed off the parent (child compaction maps to its parent, matching
   * the read-counter keying rule); the lenient payload type means a host
   * that omits `sessionID` falls back to the most-recently-admitted parent,
   * and both paths that yield no bucket degrade to instruction-only
   * (fail-open, no mint, no journal spam). The snapshot is de-tokenized, so
   * it never re-parses.
   * @param draft The host compaction-hook draft (mutated in place).
   */
  function compaction(draft: CompactionDraft): void {
    try {
      if (!Array.isArray(draft?.system)) return
      draft.system.push({
        type: "text",
        text: "Preserve verbatim: open findings, AC status table, last GATE/VERDICT markers, current worktree/branch paths.",
      })
      // Inject the concrete gate state from the live ledger alongside the
      // instruction: key off the parent bucket (child compaction maps to
      // its parent, matching the read-counter keying rule). The compaction
      // payload is typed leniently, so a host that omits `sessionID` falls
      // back to the most-recently-admitted parent; both paths that yield no
      // bucket degrade to instruction-only (fail-open, no mint, no journal
      // spam). The snapshot is de-tokenized, so it never re-parses.
      const id = asSessionID(draft.sessionID)
      const s = ctx.ledger.peek(ctx.ledger.parentOf(id) || ctx.ledger.lastParent())
      if (s) draft.system.push({ type: "text", text: formatGateSnapshot(s) })
    } catch (e) {
      ctx.journaler.journal({ type: "error", error: `compaction hook: ${e}` })
    }
  }

  return { prompt, generate, compaction }
}
