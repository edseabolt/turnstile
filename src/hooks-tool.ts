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
import type { TaskInput, ToolHookEvent } from "./types.ts"

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
   * landing guard; write/edit the path denylist; session_move the
   * worktree-move guard. A blocked call throws the deliberate BlockError;
   * shadow mode journals only; off is a no-op.
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
      ctx.gates.guardReadLimit(await ctx.readBudgetKey(asSessionID(event?.sessionID)), ctx.ledger)
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
      ctx.toolPolicy.guardPath(
        event.tool,
        event.input?.filePath ?? event.input?.path,
        asSessionID(event?.sessionID),
      )
      return
    }
    if (event?.tool === "session_move") {
      ctx.handleSessionMove(event)
      return
    }
  }

  /**
   * execute.after body: surfaces the once-per-plugin-load config block and
   * the once-per-prompt near-miss diagnostics FIRST (the ordering
   * invariant: policy head → config block → marker block → child output →
   * PIPELINE: status tail), then per tool: a task/subagent delivery is
   * classified once (marker parsing, bare-output check, and policy
   * injection all read the same classified child + text), seeds the
   * emitter-authority source, awaits the child→parent edge for
   * plan-reviewer/test-runner deliveries, parses the markers, captures the
   * reviewer APPROVE (landing-gate release signal, credit-gated by the
   * ensemble) and the plan verdict, journals the bare-output violation
   * (plan-reviewer-scoped suppression), and injects the orchestrator
   * policy; a read delivery journals the corrected parent count and injects
   * the once-per-task warn prefix; a bash/shell delivery journals the
   * trace-gated command and correlates evidence (promoting an earlier
   * unverified PASS the moment its evidence arrives). Never throws: every
   * failure journals `tool.execute.after:` and the call proceeds.
   * @param event The host execute.after tool-hook payload (mutated in place).
   */
  async function after(event: ToolHookEvent): Promise<void> {
    try {
      // Invariant: this runs BEFORE the injection below, so on a task
      // delivery carrying every surface the output reads
      // ORCHESTRATOR_POLICY (prepended head), then `[turnstile]
      // config:` (once-per-plugin-load block), then `[turnstile]
      // marker:` (once-per-prompt near-miss diagnostics), then the
      // child's own output, then the appended PIPELINE: status line
      // (last — per-delivery, so it lands even on a delivery whose
      // policy head already landed). All fail-open; the head, config
      // block, and marker block are once-per-scope, the status tail is
      // per-delivery.
      ctx.surfaceConfigWarnings(event)
      ctx.surfaceNearMissDiagnostics(event)
      if (event?.tool === "task" || event?.tool === "subagent") {
        // One shape decision per delivery: marker parsing, the
        // bare-output check, and policy injection all read the
        // classified child and text ("" for unknown/absent, so the
        // marker and bare paths no-op on an unclassifiable shape).
        const delivery = classifyDelivery(event)
        const output = delivery.text
        const child = delivery.child
        const agent =
          agentFromTaskInput(event.input) ||
          agentFromTaskInput(event.result?.input as TaskInput | undefined)
        // Delivery seed: the always-firing emitter-authority source. The
        // agent is resolved from dispatch input here, so a legitimate
        // child's markers land authoritatively even when every streaming
        // seed failed (fail-closed at streaming, authoritative at delivery).
        ctx.seedEmitter(child, agent)
        // Plan-reviewer and test-runner delivery paths only: await the
        // child→parent edge before marker parsing and attribution, so a
        // background dispatch whose edge resolves late (or only via
        // session.get) still attributes. Every other agent keeps today's
        // byte-identical sync ordering.
        if (agent === ctx.config.agents.planReviewer || agent === ctx.config.agents.testRunner) {
          await ctx.resolveParent(child)
        }
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
        // Reviewer-APPROVE capture (landing gate): a reviewer
        // task-result delivery whose first-sight verdict is APPROVE sets
        // hasReviewApprove — the landing gate's release signal. Mirrors
        // the plan-reviewer verdict lifecycle but for the landing gate.
        // Streaming child text does NOT set it: this branch runs only on
        // task-result delivery, keeping the stream attribution-neutral
        // (a streamed verdict in child text can't release the landing
        // gate).
        if (agent === ctx.config.agents.reviewer) {
          const approved = markerEvents.some(
            (e) => e.kind === "verdict" && e.marker.includes("APPROVE"),
          )
          if (approved) {
            // Under reviewEnsemble:enforce the review is credited only
            // once two unwaived reviewer dispatches were counted this
            // task; an incomplete ensemble journals the refusal (and a
            // suppressed-credit stamp) and leaves the landing gate red.
            const parent = ctx.ledger.parentOf(child)
            if (ctx.gates.reviewEnsembleComplete(parent, ctx.ledger))
              ctx.ledger.state(parent).hasReviewApprove = true
          }
        }
        // Plan-approval attribution: only a plan-reviewer result moves
        // the plan gate. See attributePlanVerdict — `raw` is always an
        // actual child session ID, never the parent; an unattributable,
        // marker-less parent-keyed re-fire journals type:"error" and
        // leaves the gate untouched (never clobbers a live approval).
        if (agent === ctx.config.agents.planReviewer) {
          await ctx.attributePlanVerdict(child, output)
        }
        // The bare-output suppression — a streamed verdict in the
        // child's own text hiding a summarized, marker-less delivery —
        // is scoped to the plan-reviewer only. reviewer/test-runner keep
        // their pre-suppression behavior: a marker-less delivery
        // violates even when the child's streamed text quoted a VERDICT.
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
        // Orchestrator policy injection: see injectOrchestratorPolicy.
        // Attribution is edge-first via childToParent (both host
        // delivery shapes inject when the edge resolves); the name
        // guard is a conservative fallback for unregistered children
        // only, and its skip is journaled. Runs after the bare-output
        // phase, so the config-surface ordering invariant above (policy
        // prepend lands on top) is preserved.
        await ctx.injectOrchestratorPolicy(event, child, delivery, agent)
        return
      }
      if (event?.tool === "read") {
        // Same parent keying as the guard: count and budget stay in
        // step regardless of which session ID the host reports. The
        // increment happens atomically in the before-hook (guardReadLimit);
        // this after-hook journals the running count and corrects it down
        // when the read did not produce a string output (a non-string
        // result never consumed budget).
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
        return
      }
      if (event?.tool === "bash" || event?.tool === "shell") {
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
        // Evidence correlation: record a plausible exit-0
        // test execution and promote an earlier unverified PASS the
        // moment its evidence arrives, within the same task lifetime.
        // No command text ever leaves memory (redaction contract).
        if (ctx.config.gateEvidence !== "off") {
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
          // Promote a pending unverified PASS the moment in-window
          // evidence correlates; the helper peeks (never mints) the
          // parent bucket, so unknown bash sessions stay out of the LRU.
          ctx.promoteOnEvidence(ctx.ledger.parentOf(obsSid))
        }
      }
    } catch (e) {
      // execute.after performs no gating, so nothing here can throw a
      // BlockError; every failure is journaled and the call proceeds.
      ctx.journaler.journal({ type: "error", error: `tool.execute.after: ${e}` })
    }
  }

  return { before, after }
}
