/**
 * @fileoverview Request-draft surface primitives for the generation hooks:
 * the shape guard deciding whether a draft's `system` array is appendable,
 * the in-place text-block append, and the bounded, content-free draft
 * descriptor the one-per-boot telemetry row carries. Fully pure — the hook
 * orchestration (latches, journals, ledger state) lives in src/hooks-core.ts.
 */

import type { GenerateDraft } from "./types.ts"

/** A system block as carried by the context/generate drafts (lenient shape). */
export type SystemBlock = { type?: string; text?: string }

/** A draft whose `system` is a verified-appendable block array. */
export type UsableRequestDraft = GenerateDraft & { system: SystemBlock[] }

/**
 * Type predicate: the draft's `system` is an appendable text-block array.
 * The push target must be an array of non-null objects; element shapes stay
 * lenient (same contract as `CompactionDraft.system`). A falsy draft or a
 * missing/non-array `system` is unusable — the caller degrades to the
 * `execute.after` fallback channel.
 * @param draft The hook draft (or null/undefined on a hostile host).
 * @returns True when `draft.system` can be pushed to in place.
 */
export function usableRequestDraft(
  draft: GenerateDraft | undefined | null,
): draft is UsableRequestDraft {
  if (!draft || !Array.isArray(draft.system)) return false
  return draft.system.every((block) => typeof block === "object" && block !== null)
}

/**
 * In-place push of one text block onto a usable system array. The mutation
 * reaches the model request because the host builds the LLM call from the
 * same draft object it handed the hook (compaction-hook precedent).
 * @param system The appendable block array (guarded by usableRequestDraft).
 * @param text The text to append as a `text` block.
 */
export function appendSystemText(system: SystemBlock[], text: string): void {
  system.push({ type: "text", text })
}

/**
 * Builds the bounded one-per-boot draft descriptor: kinds and counts only —
 * never any block or message text content (the journal carries no prompts).
 * @param surface Which generation hook fired ("context" or "generate").
 * @param draft The hook draft (or null/undefined on a hostile host).
 * @returns The descriptor: agent name capped at 64 chars, key list capped
 *     at 12, kinds/lengths for `system` and `messages`, presence flags.
 */
export function describeRequestDraft(
  surface: "context" | "generate",
  draft: GenerateDraft | undefined | null,
): {
  surface: string
  agent: string
  hasSessionID: boolean
  systemKind: string
  systemLen: number
  messagesKind: string
  messagesLen: number
  hasOptions: boolean
  keys: string[]
} {
  const agent = typeof draft?.agent === "string" ? draft.agent : ""
  const system = draft?.system
  const messages = draft?.messages
  return {
    surface,
    // Cap the agent name so a hostile host cannot flood the journal with it.
    agent: agent.slice(0, 64),
    hasSessionID: draft?.sessionID !== undefined && draft?.sessionID !== null,
    systemKind: typeof system,
    systemLen: Array.isArray(system) ? system.length : 0,
    messagesKind: typeof messages,
    messagesLen: Array.isArray(messages) ? messages.length : 0,
    hasOptions: draft?.options !== undefined && draft?.options !== null,
    // Cap the key list: the descriptor is bounded telemetry, not a dump.
    keys: Object.keys(draft ?? {}).slice(0, 12),
  }
}
