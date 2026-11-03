/**
 * @fileoverview Tool-surface execute.before body: routes the tool call to its
 * guard — task/subagent dispatch, the parent-keyed read budget, the bash/shell
 * and write/edit denylist guards, and session_move. Extracted from
 * `src/hooks-tool.ts` (the factory holds no state; everything delegates to the
 * shared context). A blocked call throws the deliberate `BlockError` from the
 * gate layer (the src/setup.ts wrapper rethrows it and journals everything
 * else).
 */

import { asSessionID } from "./delivery.ts"
import type { TurnstileContext } from "./hooks-core.ts"
import type { ToolHookEvent } from "./types.ts"

/**
 * Routes the denylist-guarded tools: bash/shell runs the command denylist +
 * landing guard; write/edit the path denylist then the parent-only hands-on
 * gate. The extraction coerces the unconfirmed host payload (candidate keys
 * documented on each guard); an empty result fails open with
 * misconfiguration telemetry. A block throws BlockError (the setup wrapper
 * rethrows it).
 * @param ctx The shared per-setup context.
 * @param event The host execute.before tool-hook payload.
 */
function routeDenylistGuards(ctx: TurnstileContext, event: ToolHookEvent): void {
  if (event?.tool === "bash" || event?.tool === "shell") {
    ctx.handleBashDispatch(event, event.tool)
    return
  }
  if (event?.tool === "write" || event?.tool === "edit") {
    // Path denylist first, then the hands-on gate (see
    // handleWriteEditDispatch — only a registered pipeline child's own
    // write/edit is exempt; non-pipeline subagents gate like parents).
    ctx.handleWriteEditDispatch(event, event.tool)
  }
}

/**
 * execute.before body: routes the tool call to its guard. task/subagent
 * goes to handleTaskDispatch (plan gate, round cap, dispatch budget,
 * loop caps, waivers); read draws down the parent's read budget (keyed
 * off the parent session — a subagent's reads consume the parent's
 * budget, not a per-child one); bash/shell and write/edit run through
 * routeDenylistGuards; session_move the worktree-move guard. A blocked
 * call throws the deliberate BlockError.
 * @param ctx The shared per-setup context (config, journaler, ledger,
 *     gates, tool policy, evidence tracker, and the dispatch/verdict
 *     services).
 * @param event The host execute.before tool-hook payload.
 * @throws The deliberate gate block error when a guard rejects the call.
 */
export async function toolHooksBefore(ctx: TurnstileContext, event: ToolHookEvent): Promise<void> {
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
  routeDenylistGuards(ctx, event)
  if (event?.tool === "session_move") {
    ctx.handleSessionMove(event)
  }
}
