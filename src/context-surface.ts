/**
 * @fileoverview Context-surface concern: the once-per-load model-facing
 * injections — config warnings, the end-of-period observe summary, the
 * generation-draft telemetry, and the primary-turn context policy head with
 * its pending intent nudge. Extracted from `src/hooks-core.ts`; the shared
 * per-setup state is threaded as one typed state object (the mutable
 * once-per-load latches live on the flags object the factory owns). Every
 * path is fail-open: a throwing mutation journals and never blocks the tool.
 */

import type { Journaler } from "./journal.ts"
import type { GateLedger } from "./ledger.ts"
import type { GenerateDraft, ToolHookEvent } from "./types.ts"
import {
  appendSystemText,
  describeRequestDraft,
  usableRequestDraft,
  type UsableRequestDraft,
} from "./generate-injection.ts"
import { formatConfigWarnings, formatObserveSummary } from "./config.ts"
import { observeSummaryEntry } from "./gates-common.ts"
import { intentNudge } from "./policy.ts"
import { asSessionID } from "./delivery.ts"

/**
 * The mutable once-per-load latches the context surfaces consume. Owned by
 * the factory (which arms `observeSummaryPending` at boot replay and from
 * the admission stamp) and shared with this concern by reference.
 */
export interface ContextSurfaceFlags {
  /** True while the config-warning block still deserves a context slot. */
  configWarningsPending: boolean
  /** True while the observe-summary block still deserves a context slot. */
  observeSummaryPending: boolean
  /** True once the one-per-boot generation-draft row has been journaled. */
  draftDiagnosticDone: boolean
  /** True once the unusable-draft-shape error row has been journaled. */
  draftShapeErrorJournaled: boolean
}

/**
 * The state the context-surface concern reads and mutates: the shared deps,
 * the owned latches, and the cross-concern helpers it delegates to.
 */
export interface ContextSurfaceState {
  /** The telemetry journal writer. */
  journaler: Journaler
  /** The gate-state ledger (observe totals + child-edge + bucket reads). */
  ledger: GateLedger
  /** Dispatchable agent names (the context parent-guard's exclusion set). */
  subagentNames: Set<string>
  /** The orchestrator policy head, built once per plugin load. */
  policyText: string
  /** The config warnings surfaced by the first string-output delivery. */
  configWarnings: string[]
  /** The once-per-load latches (see {@link ContextSurfaceFlags}). */
  flags: ContextSurfaceFlags
  /** The pending intent nudges, consumed one-shot into the context draft. */
  intentNudgePending: Map<string, import("./intent.ts").IntentKind>
  /** Journals a policy-injection outcome for a session. */
  journalPolicy(sessionID: string, injected: boolean, extra?: Record<string, unknown>): void
  /** Whether reactive enforcement is armed for the session's parent. */
  enforcementArmed(sessionID: string): boolean
}

/**
 * Surfaces unresolved config-validation warnings once per plugin load by
 * prepending a `[turnstile] config:` block to the first tool result with
 * string output — from any session, primary or child — the model-facing
 * channel proven by the policy injection and the read-budget prefix.
 * Fail-open: a throwing mutation journals
 * `{type:"config", surfaced:false}` and never blocks the tool; the journal
 * already carries every warning (loadConfig journaled them), so this entry
 * is a surface audit (surfaced/count), not a second copy of the warnings.
 * @param st The context-surface state.
 * @param event The host execute.after tool-hook payload (mutated in place).
 */
function surfaceConfigWarningsBody(st: ContextSurfaceState, event: ToolHookEvent): void {
  if (!st.flags.configWarningsPending) return
  if (!event?.result || typeof event.result.output !== "string") return
  const sessionID = asSessionID(event.sessionID)
  try {
    event.result.output =
      formatConfigWarnings(st.configWarnings, st.journaler.journalPath) + "\n" + event.result.output
    st.flags.configWarningsPending = false
    st.journaler.journal({
      type: "config",
      sessionID,
      surfaced: true,
      count: st.configWarnings.length,
    })
  } catch (e) {
    st.journaler.journal({
      type: "config",
      sessionID,
      surfaced: false,
      error: String(e),
    })
  }
}

/**
 * Surfaces the end-of-period observe summary once per plugin load by
 * prepending a `[turnstile] observe:` block to the first tool result with
 * string output — the same model-facing channel as the config-warning and
 * read-budget blocks. Armed by the period-completing admission stamp and by
 * boot replay of a completed period lacking its journaled summary marker
 * (never armed by a default, off period). Fail-open: a throwing mutation
 * journals `type:"error"` and never blocks the tool, and the block stays
 * pending for a later delivery — the `kind:"summary"` marker is journaled
 * only after a successful prepend, so a restart re-surfaces exactly once.
 * @param st The context-surface state.
 * @param event The host execute.after tool-hook payload (mutated in place).
 */
function surfaceObserveSummaryBody(st: ContextSurfaceState, event: ToolHookEvent): void {
  if (!st.flags.observeSummaryPending) return
  if (!event?.result || typeof event.result.output !== "string") return
  const sessionID = asSessionID(event.sessionID)
  try {
    const counts = st.ledger.observeCounts()
    event.result.output =
      formatObserveSummary(counts, st.journaler.journalPath) + "\n" + event.result.output
    st.flags.observeSummaryPending = false
    st.journaler.journal(observeSummaryEntry(sessionID, counts.observed, counts.wouldBlocks))
  } catch (e) {
    st.journaler.journal({
      type: "error",
      sessionID,
      error: `observe summary injection: ${e}`,
    })
  }
}

/**
 * Journals the one-per-boot generation-draft telemetry row: a single
 * bounded, content-free descriptor (`{type:"generate-draft", …}`) for the
 * first context or generate fire, whichever comes first. Fail-open: a
 * descriptor build that throws (a hostile draft with a throwing getter)
 * journals `type:"error"` instead and never retries.
 * @param st The context-surface state.
 * @param surface Which generation hook fired ("context" or "generate").
 * @param draft The host hook draft.
 */
function observeRequestDraftBody(
  st: ContextSurfaceState,
  surface: "context" | "generate",
  draft: GenerateDraft,
): void {
  if (st.flags.draftDiagnosticDone) return
  st.flags.draftDiagnosticDone = true
  try {
    st.journaler.journal({ type: "generate-draft", ...describeRequestDraft(surface, draft) })
  } catch (e) {
    st.journaler.journal({ type: "error", error: `generate-draft describe: ${e}` })
  }
}

/**
 * Shape guard arm of the context injection: an unusable draft shape
 * journals one error row per boot (with the shape descriptor) — the
 * `execute.after` delivery channel stays armed as the fallback.
 * @param st The context-surface state.
 * @param draft The host context-hook draft.
 * @returns True (narrowing the draft to the appendable shape) when the
 *     draft's system array is usable.
 */
function usableContextDraftBody(
  st: ContextSurfaceState,
  draft: GenerateDraft,
): draft is UsableRequestDraft {
  if (usableRequestDraft(draft)) return true
  if (!st.flags.draftShapeErrorJournaled) {
    st.flags.draftShapeErrorJournaled = true
    try {
      st.journaler.journal({
        type: "error",
        error: "context hook: unusable draft shape",
        shape: describeRequestDraft("context", draft),
      })
    } catch (e) {
      st.journaler.journal({ type: "error", error: `context hook shape describe: ${e}` })
    }
  }
  return false
}

/**
 * Resolves the context draft's skip verdict against the parent-guard
 * matrix: a config-known pipeline agent name on the draft (a pipeline
 * agent's own primary turn), a registered child→parent edge, or an
 * unresolvable session id each skips with a journaled, observable reason.
 * @param st The context-surface state.
 * @param draft The usable context-hook draft.
 * @param sid The draft's resolved session id ("" when unresolvable).
 * @returns The skip reason, or "" when injection may proceed.
 */
function contextSkipReasonBody(
  st: ContextSurfaceState,
  draft: UsableRequestDraft,
  sid: string,
): string {
  const agent = typeof draft.agent === "string" ? draft.agent : ""
  if (agent !== "" && st.subagentNames.has(agent)) return "context-agent"
  if (st.ledger.childToParent.has(sid)) return "context-child"
  if (sid === "") return "context-no-id"
  return ""
}

/**
 * Consumes the parent's pending intent nudge into a context draft's system
 * array (one-shot, after a successful head-or-already-injected pass). The
 * pending entry is consumed before the append, mirroring the read-channel
 * delivery: a throwing append journals `type:"error"` and never throws or
 * retries.
 * @param st The context-surface state.
 * @param sid The draft's resolved parent session id.
 * @param draft The usable context-hook draft.
 */
function appendContextNudgeBody(
  st: ContextSurfaceState,
  sid: string,
  draft: UsableRequestDraft,
): void {
  const kind = st.intentNudgePending.get(sid)
  if (kind === undefined) return
  st.intentNudgePending.delete(sid)
  try {
    appendSystemText(draft.system, intentNudge(kind))
  } catch (e) {
    st.journaler.journal({ type: "error", sessionID: sid, error: `intent nudge: ${e}` })
  }
}

/**
 * Injects the policy head and any pending intent nudge into a primary-turn
 * context draft's `system` array — the pre-first-model-call channel, so the
 * model carries the governance prose before it can reason or act. The
 * shared `policyInjected` latch dedupes against the `execute.after`
 * prepend (whichever channel fires first wins), and the nudge is consumed
 * one-shot from the same pending map the fallback channel reads. The head
 * and the nudge are independent fail-open paths: a head failure keeps the
 * nudge pending (its own fallback delivery), and a nudge append failure
 * journals and leaves the head landed. Never throws.
 * @param st The context-surface state.
 * @param draft The host context-hook draft (mutated in place).
 */
function injectContextPolicyBody(st: ContextSurfaceState, draft: GenerateDraft): void {
  if (!usableContextDraftBody(st, draft)) return
  const sid = asSessionID(draft.sessionID)
  const skip = contextSkipReasonBody(st, draft, sid)
  if (skip !== "") {
    st.journalPolicy(sid, false, { skipped: true, reason: skip })
    return
  }
  // Dormant-until-engaged: a dormant session's context stays clean — the
  // intent nudge remains the only turnstile prose. The `policyInjected`
  // latch semantics are unchanged for engaged sessions.
  if (!st.enforcementArmed(sid)) return
  const s = st.ledger.state(sid)
  if (!s.policyInjected) {
    try {
      appendSystemText(draft.system, st.policyText)
      s.policyInjected = true
      st.journalPolicy(sid, true, { surface: "context" })
    } catch (e) {
      st.journalPolicy(sid, false, { error: String(e), surface: "context" })
      return
    }
  }
  appendContextNudgeBody(st, sid, draft)
}

/**
 * Creates the context-surface concern bound to the factory's shared state.
 * The bodies live at module level; the factory only builds the state object.
 * @param st The context-surface state (see {@link ContextSurfaceState}).
 * @returns The four context-surface methods the shared context exposes.
 */
export function createContextSurface(st: ContextSurfaceState): {
  surfaceConfigWarnings(event: ToolHookEvent): void
  surfaceObserveSummary(event: ToolHookEvent): void
  observeRequestDraft(surface: "context" | "generate", draft: GenerateDraft): void
  injectContextPolicy(draft: GenerateDraft): void
} {
  return {
    surfaceConfigWarnings: (event) => surfaceConfigWarningsBody(st, event),
    surfaceObserveSummary: (event) => surfaceObserveSummaryBody(st, event),
    observeRequestDraft: (surface, draft) => observeRequestDraftBody(st, surface, draft),
    injectContextPolicy: (draft) => injectContextPolicyBody(st, draft),
  }
}
