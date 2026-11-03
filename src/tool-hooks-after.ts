/**
 * @fileoverview Tool-surface execute.after body: the once-per-scope surface
 * blocks (observe summary, config block, near-miss diagnostics) followed by
 * the per-tool delivery bodies — task/subagent delivery classification,
 * emitter seeding, marker parsing, verdict capture + attribution, bare-output
 * violation, policy injection; read count correction + once-per-task warn;
 * bash trace + evidence correlation. Extracted from `src/hooks-tool.ts` (the
 * factory holds no state; everything delegates to the shared context).
 * `after` never gates — every failure journals fail-open.
 */

import { agentFromDeliveryEvent } from "./child-registration.ts"
import { asSessionID, classifyDelivery } from "./delivery.ts"
import type { TurnstileContext } from "./hooks-core.ts"
import type { MarkerEvent, ToolHookEvent, ToolResult } from "./types.ts"

/**
 * The ordering invariant for the once-per-scope surface blocks: every block
 * is PREPENDED, and each call prepends above everything the earlier calls
 * already landed, so the call order is bottom-up in the final render — the
 * first surface called lands closest to the child output. On a task delivery
 * carrying every surface the output reads the policy head (prepended last,
 * by the per-tool body), then `[turnstile] marker:` (once-per-prompt
 * near-miss diagnostics), then `[turnstile] config:` (once-per-plugin-load
 * block), then `[turnstile] observe:` (once-per-load end-of-period summary),
 * then the child's own output, then the appended PIPELINE: status line
 * (per-delivery, so it lands even on a delivery whose policy head already
 * landed). All fail-open; the head, marker, config, and observe blocks are
 * once-per-scope, the status tail is per-delivery.
 */

/**
 * Awaits the child→parent edge for the deliveries that need it before
 * marker parsing and attribution: plan-reviewer, test-runner, and
 * empty-agent deliveries only — a background dispatch whose edge
 * resolves late (or only via session.get) still attributes. The
 * empty-agent arm is the v2 structured / background result that omits
 * input.agent: without the edge + emitter resolved first, the child's
 * verdict is denied authority and the credit would attribute to the
 * unregistered child. Every other agent keeps today's byte-identical
 * sync ordering.
 * @param ctx The shared per-setup context.
 * @param agent The dispatch-input agent name ("" when unnamed).
 * @param child The delivery's child session ID.
 */
async function awaitEdgeFor(ctx: TurnstileContext, agent: string, child: string): Promise<void> {
  if (
    agent === ctx.config.agents.planReviewer ||
    agent === ctx.config.agents.testRunner ||
    agent === ""
  ) {
    await ctx.resolveParent(child)
  }
}

/**
 * Handles a bare-output delivery: a marker-less, non-empty delivery
 * from an agent in the bare-output list. The suppression — a streamed
 * verdict in the child's own text hiding a summarized, marker-less
 * delivery — is scoped to the plan-reviewer only. reviewer/test-runner
 * keep their pre-suppression behavior: a marker-less delivery violates
 * even when the child's streamed text quoted a VERDICT. Before the
 * violation fires, one bounded compliance re-prompt is attempted; the
 * violation is journaled only when the retry is unavailable or
 * exhausted. Not gate-moving: nothing releases because of it.
 * @param ctx The shared per-setup context.
 * @param agent The dispatch-input agent name.
 * @param child The delivery's child session ID.
 * @param output The classified delivery text ("" when unclassifiable).
 */
async function handleBareOutput(
  ctx: TurnstileContext,
  agent: string,
  child: string,
  output: string,
): Promise<void> {
  const bare =
    ctx.config.agents.bareOutput.includes(agent) &&
    output !== "" &&
    !ctx.hasMarker(output) &&
    (agent !== ctx.config.agents.planReviewer || ctx.ledger.childVerdict(child).marker === "")
  if (!bare) return
  const recovered = await ctx.retryMarker(child, agent)
  if (recovered) return
  ctx.journaler.journal({
    type: "violation",
    sessionID: child,
    agent,
    reason: "task output contained no GATE/VERDICT marker",
  })
}

/**
 * Applies reviewer-APPROVE capture (landing gate) when the delivery's
 * effective agent is the reviewer: a reviewer task-result delivery
 * whose first-sight verdict is APPROVE sets hasReviewApprove — the
 * landing gate's release signal. Mirrors the plan-reviewer verdict
 * lifecycle but for the landing gate. The effective agent is the
 * edge/emitter-resolved one: a v2 structured or background result may
 * omit input.agent, and the awaited resolveParent above has already
 * seeded the child's emitter from the host session record. Streaming
 * child text does NOT set it: this runs only on task-result delivery,
 * keeping the stream attribution-neutral (a streamed verdict in child
 * text can't release the landing gate).
 * @param ctx The shared per-setup context.
 * @param child The delivery's child session ID.
 * @param effectiveAgent The edge/emitter-resolved delivery agent.
 * @param markerEvents The parsed marker events of the delivery.
 */
function creditReviewerDelivery(
  ctx: TurnstileContext,
  child: string,
  effectiveAgent: string,
  markerEvents: MarkerEvent[],
): void {
  if (effectiveAgent === ctx.config.agents.reviewer) {
    ctx.creditReviewApproval(child, markerEvents)
  }
}

/**
 * Applies plan-approval attribution when the delivery's effective
 * agent is the plan-reviewer: only a plan-reviewer result moves the
 * plan gate (on the resolved effectiveAgent, same reason as the
 * reviewer credit). See attributePlanVerdict — `raw` is always an
 * actual child session ID, never the parent; an unattributable,
 * marker-less parent-keyed re-fire journals type:"error" and leaves
 * the gate untouched (never clobbers a live approval).
 * @param ctx The shared per-setup context.
 * @param child The delivery's child session ID.
 * @param effectiveAgent The edge/emitter-resolved delivery agent.
 * @param output The classified delivery text.
 */
async function attributePlanDelivery(
  ctx: TurnstileContext,
  child: string,
  effectiveAgent: string,
  output: string,
): Promise<void> {
  if (effectiveAgent === ctx.config.agents.planReviewer) {
    await ctx.attributePlanVerdict(child, output)
  }
}

/**
 * Classifies the delivery once and seeds the emitter-authority source:
 * marker parsing, the bare-output check, and policy injection all read
 * the same classified child + text ("" for unknown/absent, so the
 * marker and bare paths no-op on an unclassifiable shape).
 * @param ctx The shared per-setup context.
 * @param event The host execute.after tool-hook payload.
 * @returns The classified delivery pieces: the delivery record, its text,
 *     the child session ID, the dispatch-input agent, and the
 *     edge/emitter-resolved effective agent.
 */
async function classifyAndSeed(
  ctx: TurnstileContext,
  event: ToolHookEvent,
): Promise<{
  delivery: ReturnType<typeof classifyDelivery>
  output: string
  child: string
  agent: string
  effectiveAgent: string
}> {
  const delivery = classifyDelivery(event)
  const child = delivery.child
  // Delivery-agent resolution: the dispatch input and the structured
  // result's input echo name the CHILD and win first; the payload's
  // generic `event.agent` is the last fallback (it can carry the
  // parent's name on structured/background deliveries — see
  // agentFromDeliveryEvent).
  const agent = agentFromDeliveryEvent(event)
  // Delivery seed: the always-firing emitter-authority source. The
  // agent is resolved from dispatch input here, so a legitimate
  // child's markers land authoritatively even when every streaming
  // seed failed (fail-closed at streaming, authoritative at delivery).
  ctx.seedEmitter(child, agent)
  await awaitEdgeFor(ctx, agent, child)
  // Gate-moving attribution (reviewer credit, plan verdict) resolves
  // the delivery agent through the child→parent edge + host session
  // record when the dispatch input names none; the raw agent stays
  // the signal for the cosmetic status tail / policy injection and
  // the fail-closed emitter seed above (byte-identity + documented
  // seeding semantics), and for the bare-output check (not
  // gate-moving: nothing releases because of it).
  const effectiveAgent = agent || ctx.emitterAgent(child)
  markResolvedParent(ctx, child)
  return { delivery, output: delivery.text, child, agent, effectiveAgent }
}

/**
 * Marks the resolved parent live: covers both host delivery shapes
 * (parent-keyed and child-keyed). A genuinely unresolved child delivery
 * self-marks, protecting one extra bucket until the registry LRU ages it
 * out — bounded, documented.
 * @param ctx The shared per-setup context.
 * @param child The delivery's child session ID.
 */
function markResolvedParent(ctx: TurnstileContext, child: string): void {
  ctx.ledger.markParent(ctx.ledger.parentOf(child))
}

/**
 * The task/subagent delivery body: classifies the delivery once
 * (marker parsing, the bare-output check, and policy injection all
 * read the same classified child + text), seeds the emitter-authority
 * source, awaits the edge where needed, parses the markers, captures
 * the reviewer APPROVE (landing-gate release signal) and the plan
 * verdict (both attributed on the effective agent), journals the
 * bare-output violation (plan-reviewer-scoped suppression), and
 * injects the orchestrator policy.
 * @param ctx The shared per-setup context.
 * @param event The host execute.after tool-hook payload (mutated in place).
 */
async function afterTaskDelivery(ctx: TurnstileContext, event: ToolHookEvent): Promise<void> {
  const { delivery, output, child, agent, effectiveAgent } = await classifyAndSeed(ctx, event)
  const markerEvents = ctx.parseMarkers(
    output,
    child,
    "task-result",
    `task-result\u0000${ctx.nextTaskDeliverySeq()}`,
  )
  creditReviewerDelivery(ctx, child, effectiveAgent, markerEvents)
  await attributePlanDelivery(ctx, child, effectiveAgent, output)
  await handleBareOutput(ctx, agent, child, output)
  // Orchestrator policy injection: see injectOrchestratorPolicy.
  // Attribution is edge-first via childToParent (both host
  // delivery shapes inject when the edge resolves); the name
  // guard is a conservative fallback for unregistered children
  // only, and its skip is journaled. Runs after the bare-output
  // phase, so the config-surface ordering invariant above (policy
  // prepend lands on top) is preserved.
  await ctx.injectOrchestratorPolicy(event, child, delivery, agent)
}

/**
 * The read delivery body: journals the corrected parent read count
 * and prepends the once-per-task warn. Same parent keying as the
 * guard: count and budget stay in step regardless of which session ID
 * the host reports. The increment happens atomically in the
 * before-hook (guardReadLimit); this body journals the running count
 * and corrects it down when the read did not produce a string output
 * (a non-string result never consumed budget).
 * @param ctx The shared per-setup context.
 * @param event The host execute.after tool-hook payload (mutated in place).
 */
function afterRead(ctx: TurnstileContext, event: ToolHookEvent): void {
  // Advisory intent nudge first: an armed nudge prepends to the parent's
  // own read delivery ahead of the read-budget telemetry below.
  ctx.prependIntentNudgeRead(event)
  const sessionID = ctx.ledger.parentOf(asSessionID(event?.sessionID))
  const s = ctx.ledger.state(sessionID)
  // The before-hook already incremented; a read that did not produce
  // a string output never consumed budget — correct the charge down
  // (floor 0).
  if (typeof event.result?.output !== "string" && s.reads > 0) s.reads--
  ctx.journaler.journal({ type: "tool", sessionID, tool: "read", reads: s.reads })
  // The warn prefix is once per task: the corrected `reads` counter
  // is not monotonic, so equality with readWarn could re-inject on
  // a later climb — the task-scoped flag (fresh on every task-scope
  // reset) suppresses the repeat. `>=` rather than `==`: a burst of
  // before-reads can carry the counter past the threshold before
  // any string-output after-read runs, so equality could skip the
  // warn entirely.
  if (
    !s.readWarned &&
    s.reads >= ctx.config.readWarn &&
    event.result &&
    typeof event.result.output === "string"
  ) {
    event.result.output =
      `[turnstile] Warning: ${ctx.config.readWarn} whole-file reads this session; prefer grep/glob. Blocks at ${ctx.config.readBlock}.\n` +
      event.result.output
    s.readWarned = true
  }
}

/**
 * Correlates bash/shell evidence: records a plausible exit-0 test
 * execution and promotes an earlier unverified PASS the moment its
 * evidence arrives, within the same task lifetime. No command text
 * ever leaves memory (redaction contract). The promote helper peeks
 * (never mints) the parent bucket, so unknown bash sessions stay out
 * of the LRU.
 * @param ctx The shared per-setup context.
 * @param event The host execute.after tool-hook payload.
 * @param meta The result metadata (empty object when absent).
 */
function correlateBashEvidence(
  ctx: TurnstileContext,
  event: ToolHookEvent,
  meta: NonNullable<ToolResult["metadata"]>,
): void {
  const obsSid = asSessionID(event?.sessionID)
  const exit = meta.exit ?? meta.exitCode ?? meta.code
  if (
    ctx.evidence.observe(
      obsSid,
      event.input?.command ?? event.input?.cmd ?? event.result?.title ?? "",
      exit,
    )
  ) {
    ctx.journaler.journal({
      type: "evidence",
      sessionID: obsSid,
      event: "observed",
      exit,
    })
  }
  ctx.promoteOnEvidence(ctx.ledger.parentOf(obsSid))
}

/**
 * The bash/shell delivery body: journals the trace-gated command
 * (shell commands can contain secrets; recorded only when the trace
 * is enabled) and correlates evidence when the evidence gate is not
 * off (promoting an earlier unverified PASS the moment its evidence
 * arrives).
 * @param ctx The shared per-setup context.
 * @param event The host execute.after tool-hook payload.
 */
function afterBash(ctx: TurnstileContext, event: ToolHookEvent): void {
  const meta = event.result?.metadata ?? {}
  ctx.journaler.journal({
    type: "tool",
    sessionID: asSessionID(event?.sessionID),
    tool: "bash",
    // Shell commands can contain secrets; record them only when
    // the trace is enabled.
    command: ctx.config.trace
      ? String(event.input?.command ?? event.input?.cmd ?? event.result?.title ?? "").slice(0, 500)
      : "<redacted>",
    exit: meta.exit ?? meta.exitCode ?? meta.code,
  })
  if (ctx.config.gateEvidence !== "off") {
    correlateBashEvidence(ctx, event, meta)
  }
}

/**
 * execute.after body: surfaces the once-per-scope blocks FIRST — the
 * end-of-period observe summary, the once-per-plugin-load config block, and
 * the once-per-prompt near-miss diagnostics (ordering invariant documented at
 * the module head) — then routes per tool: task/subagent to
 * afterTaskDelivery, read to afterRead, bash/shell to afterBash. The
 * per-tool bodies inherit this guard: they never throw — every
 * failure journals `tool.execute.after:` and the call proceeds.
 * @param ctx The shared per-setup context (config, journaler, ledger,
 *     gates, tool policy, evidence tracker, and the dispatch/verdict
 *     services).
 * @param event The host execute.after tool-hook payload (mutated in place).
 */
export async function toolHooksAfter(ctx: TurnstileContext, event: ToolHookEvent): Promise<void> {
  try {
    ctx.surfaceObserveSummary(event)
    ctx.surfaceConfigWarnings(event)
    ctx.surfaceNearMissDiagnostics(event)
    if (event?.tool === "task" || event?.tool === "subagent") {
      await afterTaskDelivery(ctx, event)
      return
    }
    if (event?.tool === "read") {
      afterRead(ctx, event)
      return
    }
    if (event?.tool === "bash" || event?.tool === "shell") {
      afterBash(ctx, event)
      return
    }
  } catch (e) {
    // execute.after performs no gating, so nothing here can throw a
    // BlockError; every failure is journaled and the call proceeds.
    ctx.journaler.journal({ type: "error", error: `tool.execute.after: ${e}` })
  }
}
