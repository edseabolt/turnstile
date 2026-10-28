/**
 * @fileoverview Tool-surface hook bodies: the execute.before gate (task/
 * subagent dispatch, the parent-keyed read budget, the bash/shell and
 * write/edit denylist guards, session_move) and the execute.after surfacing
 * (config block + near-miss diagnostics first, then per tool: task/subagent
 * delivery classification, emitter seeding, marker parsing, verdict
 * capture + attribution, bare-output violation, policy injection; read
 * count correction + once-per-task warn; bash trace + evidence
 * correlation). `before` may throw the deliberate BlockError from the gate
 * layer (the src/setup.ts wrapper rethrows it and journals everything
 * else); `after` never gates — every failure journals fail-open.
 */

import { agentFromTaskInput } from "./markers.ts"
import { asSessionID, classifyDelivery } from "./delivery.ts"
import type { TurnstileContext } from "./hooks-core.ts"
import type { MarkerEvent, TaskInput, ToolHookEvent, ToolResult } from "./types.ts"

/**
 * Tool-surface hook bodies bound to one shared per-setup context. The
 * registration, tracking, and the before wrapper's BlockError rethrow
 * stay in src/setup.ts; these bodies carry only the per-event behavior.
 * @param ctx The shared per-setup context (config, journaler, ledger,
 *     gates, tool policy, evidence tracker, and the dispatch/verdict
 *     services).
 * @returns The execute.before and execute.after hook bodies.
 */
export function createToolHooks(ctx: TurnstileContext): {
  before(event: ToolHookEvent): Promise<void>
  after(event: ToolHookEvent): Promise<void>
} {
  /**
   * execute.before body: routes the tool call to its guard. task/subagent
   * goes to handleTaskDispatch (plan gate, round cap, dispatch budget,
   * loop caps, waivers); read draws down the parent's read budget (keyed
   * off the parent session — a subagent's reads consume the parent's
   * budget, not a per-child one); bash/shell runs the command denylist +
   * landing guard; write/edit the path denylist then the parent-only
   * hands-on gate; session_move the worktree-move guard. A blocked call
   * throws the deliberate BlockError; shadow mode journals only; off is a
   * no-op.
   * @param event The host execute.before tool-hook payload.
   * @throws The deliberate gate block error when a guard rejects the call.
   */
  async function before(event: ToolHookEvent): Promise<void> {
    if (event?.tool === "task" || event?.tool === "subagent") {
      await ctx.handleTaskDispatch(event)
      return
    }
    if (event?.tool === "read") {
      // Keyed off the parent session: a subagent's reads draw down the
      // parent's budget (AGENTS.md contract), not a per-child one.
      ctx.handleReadBudget(await ctx.readBudgetKey(asSessionID(event?.sessionID)))
      return
    }
    // Tool-call denylist: bash/shell commands and write/edit
    // target paths are matched against the configured denylist. The
    // extraction coerces the unconfirmed host payload (candidate keys
    // documented on each guard); an empty result fails open with
    // misconfiguration telemetry. A block throws BlockError (the setup
    // wrapper rethrows it); shadow journals only; off is a no-op.
    if (event?.tool === "bash" || event?.tool === "shell") {
      ctx.handleBashDispatch(event, event.tool)
      return
    }
    if (event?.tool === "write" || event?.tool === "edit") {
      // Path denylist first, then the parent-only hands-on gate (see
      // handleWriteEditDispatch — a registered pipeline child's own write/
      // edit is the executor's work and never gates).
      ctx.handleWriteEditDispatch(event, event.tool)
      return
    }
    if (event?.tool === "session_move") {
      ctx.handleSessionMove(event)
      return
    }
  }

  /**
   * Resolves the delivery agent from the dispatch input, falling back to
   * the structured result's input when the dispatch input names none.
   * @param event The host execute.after tool-hook payload.
   * @returns The agent name, or "" when neither shape names one.
   */
  const resolveDeliveryAgent = (event: ToolHookEvent): string =>
    agentFromTaskInput(event.input) ||
    agentFromTaskInput(event.result?.input as TaskInput | undefined)
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
   * @param agent The dispatch-input agent name ("" when unnamed).
   * @param child The delivery's child session ID.
   */
  const awaitEdgeFor = async (agent: string, child: string): Promise<void> => {
    if (
      agent === ctx.config.agents.planReviewer ||
      agent === ctx.config.agents.testRunner ||
      agent === ""
    ) {
      await ctx.resolveParent(child)
    }
  }
  /**
   * Journals the bare-output violation: a marker-less, non-empty delivery
   * from an agent in the bare-output list. The suppression — a streamed
   * verdict in the child's own text hiding a summarized, marker-less
   * delivery — is scoped to the plan-reviewer only. reviewer/test-runner
   * keep their pre-suppression behavior: a marker-less delivery violates
   * even when the child's streamed text quoted a VERDICT. Not
   * gate-moving: nothing releases because of it.
   * @param agent The dispatch-input agent name.
   * @param child The delivery's child session ID.
   * @param output The classified delivery text ("" when unclassifiable).
   */
  const flagBareOutput = (agent: string, child: string, output: string): void => {
    const bare =
      ctx.config.agents.bareOutput.includes(agent) &&
      output !== "" &&
      !ctx.hasMarker(output) &&
      (agent !== ctx.config.agents.planReviewer || ctx.ledger.childVerdict(child).marker === "")
    if (bare) {
      ctx.journaler.journal({
        type: "violation",
        sessionID: child,
        agent,
        reason: "task output contained no GATE/VERDICT marker",
      })
    }
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
   * @param child The delivery's child session ID.
   * @param effectiveAgent The edge/emitter-resolved delivery agent.
   * @param markerEvents The parsed marker events of the delivery.
   */
  const creditReviewerDelivery = (
    child: string,
    effectiveAgent: string,
    markerEvents: MarkerEvent[],
  ): void => {
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
   * @param child The delivery's child session ID.
   * @param effectiveAgent The edge/emitter-resolved delivery agent.
   * @param output The classified delivery text.
   */
  const attributePlanDelivery = async (
    child: string,
    effectiveAgent: string,
    output: string,
  ): Promise<void> => {
    if (effectiveAgent === ctx.config.agents.planReviewer) {
      await ctx.attributePlanVerdict(child, output)
    }
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
   * @param event The host execute.after tool-hook payload (mutated in place).
   */
  const afterTaskDelivery = async (event: ToolHookEvent): Promise<void> => {
    // One shape decision per delivery: marker parsing, the
    // bare-output check, and policy injection all read the
    // classified child and text ("" for unknown/absent, so the
    // marker and bare paths no-op on an unclassifiable shape).
    const delivery = classifyDelivery(event)
    const output = delivery.text
    const child = delivery.child
    const agent = resolveDeliveryAgent(event)
    // Delivery seed: the always-firing emitter-authority source. The
    // agent is resolved from dispatch input here, so a legitimate
    // child's markers land authoritatively even when every streaming
    // seed failed (fail-closed at streaming, authoritative at delivery).
    ctx.seedEmitter(child, agent)
    await awaitEdgeFor(agent, child)
    // Gate-moving attribution (reviewer credit, plan verdict) resolves
    // the delivery agent through the child→parent edge + host session
    // record when the dispatch input names none; the raw agent stays
    // the signal for the cosmetic status tail / policy injection and
    // the fail-closed emitter seed above (byte-identity + documented
    // seeding semantics), and for the bare-output check (not
    // gate-moving: nothing releases because of it).
    const effectiveAgent = agent || ctx.emitterAgent(child)
    // Mark the resolved parent live: covers both host
    // delivery shapes (parent-keyed and child-keyed). A genuinely
    // unresolved child delivery self-marks, protecting one extra
    // bucket until the registry LRU ages it out — bounded, documented.
    ctx.ledger.markParent(ctx.ledger.parentOf(child))
    const markerEvents = ctx.parseMarkers(
      output,
      child,
      "task-result",
      `task-result\u0000${ctx.nextTaskDeliverySeq()}`,
    )
    creditReviewerDelivery(child, effectiveAgent, markerEvents)
    await attributePlanDelivery(child, effectiveAgent, output)
    flagBareOutput(agent, child, output)
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
   * @param event The host execute.after tool-hook payload (mutated in place).
   */
  const afterRead = (event: ToolHookEvent): void => {
    const sessionID = ctx.ledger.parentOf(asSessionID(event?.sessionID))
    const s = ctx.ledger.state(sessionID)
    // The before-hook already incremented; a read that did not produce
    // a string output never consumed budget — correct the charge down
    // (floor 0).
    if (typeof event.result?.output !== "string" && s.reads > 0) s.reads--
    ctx.journaler.journal({ type: "tool", sessionID, tool: "read", reads: s.reads })
    // The warn prefix is once per task: the corrected `reads` counter
    // is not monotonic, so equality with readWarn could re-inject on
    // a later climb — the task-scoped flag (fresh on every prompt
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
   * @param event The host execute.after tool-hook payload.
   * @param meta The result metadata (empty object when absent).
   */
  const correlateBashEvidence = (
    event: ToolHookEvent,
    meta: NonNullable<ToolResult["metadata"]>,
  ): void => {
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
   * @param event The host execute.after tool-hook payload.
   */
  const afterBash = (event: ToolHookEvent): void => {
    const meta = event.result?.metadata ?? {}
    ctx.journaler.journal({
      type: "tool",
      sessionID: asSessionID(event?.sessionID),
      tool: "bash",
      // Shell commands can contain secrets; record them only when
      // the trace is enabled.
      command: ctx.config.trace
        ? String(event.input?.command ?? event.input?.cmd ?? event.result?.title ?? "").slice(
            0,
            500,
          )
        : "<redacted>",
      exit: meta.exit ?? meta.exitCode ?? meta.code,
    })
    if (ctx.config.gateEvidence !== "off") {
      correlateBashEvidence(event, meta)
    }
  }

  /**
   * execute.after body: surfaces the once-per-scope blocks FIRST — the
   * end-of-period observe summary, the once-per-plugin-load config block, and
   * the once-per-prompt near-miss diagnostics (the ordering invariant: policy
   * head → marker block → config block → observe block → child output →
   * PIPELINE: status tail) — then routes per tool: task/subagent to
   * afterTaskDelivery, read to afterRead, bash/shell to afterBash. The
   * per-tool bodies inherit this guard: they never throw — every
   * failure journals `tool.execute.after:` and the call proceeds.
   * @param event The host execute.after tool-hook payload (mutated in place).
   */
  async function after(event: ToolHookEvent): Promise<void> {
    try {
      // Invariant: every once-per-scope surface block is PREPENDED, and each
      // call prepends above everything the earlier calls already landed, so
      // the call order is bottom-up in the final render — the first surface
      // called lands closest to the child output. On a task delivery carrying
      // every surface the output reads the policy head (prepended last, by
      // the per-tool body), then `[turnstile] marker:` (once-per-prompt
      // near-miss diagnostics), then `[turnstile] config:` (once-per-plugin-
      // load block), then `[turnstile] observe:` (once-per-load end-of-period
      // summary), then the child's own output, then the appended PIPELINE:
      // status line (per-delivery, so it lands even on a delivery whose
      // policy head already landed). All fail-open; the head, marker, config,
      // and observe blocks are once-per-scope, the status tail is
      // per-delivery.
      ctx.surfaceObserveSummary(event)
      ctx.surfaceConfigWarnings(event)
      ctx.surfaceNearMissDiagnostics(event)
      if (event?.tool === "task" || event?.tool === "subagent") {
        await afterTaskDelivery(event)
        return
      }
      if (event?.tool === "read") {
        afterRead(event)
        return
      }
      if (event?.tool === "bash" || event?.tool === "shell") {
        afterBash(event)
        return
      }
    } catch (e) {
      // execute.after performs no gating, so nothing here can throw a
      // BlockError; every failure is journaled and the call proceeds.
      ctx.journaler.journal({ type: "error", error: `tool.execute.after: ${e}` })
    }
  }

  return { before, after }
}
