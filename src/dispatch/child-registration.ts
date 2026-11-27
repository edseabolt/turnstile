/**
 * @fileoverview Pipeline-child registration boundary: decides whether a
 * tool dispatch or tool event belongs to a pipeline child, using agent-name
 * precedence first and the in-memory child→parent edge second. Stateless —
 * every input crosses the boundary as a parameter, so the module has no
 * dependency on the ledger implementation beyond the edge map's read shape
 * (one-way dependencies, no cycles).
 *
 * The registration contract: a non-empty agent name in the configured
 * pipeline set is authoritative evidence of a pipeline child (parents never
 * carry a subagent agent name); the child→parent edge alone is no longer
 * required, so a generic-subagent dispatch or a child whose edge was lost
 * to a plugin reload still registers from its name. Fail closed: any
 * session whose status cannot be resolved this way is `"unknown"` and every
 * consumer gates it like a parent.
 */

import { agentFromTaskInput } from "./markers.ts"
import type { TaskInput } from "./types.ts"
import type { GateLedger } from "./ledger.ts"
import type { ToolHookEvent } from "./types.ts"

/** The ledger shape this boundary reads: only the child→parent edge map. */
export type ChildEdgeLedger = Pick<GateLedger, "childToParent">

/** Registration verdict for a session at a tool boundary. */
export type ChildStatus = "child" | "parent" | "unknown"

/**
 * Answers whether an agent name is authoritative evidence of a pipeline
 * child: a non-empty name present in the configured pipeline set.
 * @param agent The resolved agent name ("" when the event named none).
 * @param subagentNames The configured pipeline agent-name set.
 * @returns True when the name alone proves a pipeline child.
 */
export function isPipelineChildDispatch(
  agent: string,
  subagentNames: ReadonlySet<string>,
): boolean {
  return agent !== "" && subagentNames.has(agent)
}

/**
 * Resolves a session's registration status at a tool boundary, in
 * precedence order: (1) a non-empty event agent name wins outright — a
 * configured pipeline name is `"child"`, any other non-empty name is
 * `"parent"`; (2) with no event name, a session carrying a child→parent
 * edge falls back to the caller's emitter-authority resolver — a
 * configured fallback name is `"child"`, an unconfigured one `"parent"`;
 * (3) anything else is `"unknown"` (fail closed — consumers gate it like a
 * parent). The edge check itself never grants `"child"`: an edge with no
 * resolvable agent name stays unknown, exactly the fail-closed posture the
 * exemption contract requires.
 * @param sid The session ID at the tool boundary.
 * @param agent The agent name carried by the event ("" when none).
 * @param ledger The ledger whose edge map is consulted when the event
 *     names no agent.
 * @param subagentNames The configured pipeline agent-name set.
 * @param resolveFallbackAgent Optional emitter-authority resolver used for
 *     the edge-present, event-name-empty arm ("" when unresolved).
 * @returns The registration status for the session.
 */
export function resolveChildStatus(
  sid: string,
  agent: string,
  ledger: ChildEdgeLedger,
  subagentNames: ReadonlySet<string>,
  resolveFallbackAgent?: (sessionID: string) => string,
): ChildStatus {
  if (agent !== "") {
    return isPipelineChildDispatch(agent, subagentNames) ? "child" : "parent"
  }
  if (!ledger.childToParent.has(sid)) return "unknown"
  const fallback = resolveFallbackAgent ? resolveFallbackAgent(sid) : ""
  if (fallback === "") return "unknown"
  return isPipelineChildDispatch(fallback, subagentNames) ? "child" : "parent"
}

/**
 * Resolves the agent name from a dispatch-shaped tool event, trying the
 * task-tool input shape (via the shared task-input resolver) first and the
 * host's generic subagent shape (`event.agent` on the payload itself)
 * second, so both dispatch spellings register identically.
 * @param event The tool event (task or generic-subagent shape).
 * @returns The agent name, or "" when neither shape names one.
 */
export function agentFromDispatchEvent(event: ToolHookEvent): string {
  return agentFromTaskInput(event.input) || (typeof event.agent === "string" ? event.agent : "")
}

/**
 * Resolves the agent name from a delivery-shaped tool event (the
 * execute.after payload). Order matters: the dispatch input and the
 * structured result's input echo name the CHILD, while the payload's
 * generic `event.agent` field can carry the PARENT's agent name on
 * structured/background deliveries — so the name-bearing inputs are
 * tried first and the `event.agent` fallback only wins when no input
 * shape names one. Using agentFromDispatchEvent's order here would
 * misattribute gate-moving credit to the parent.
 * @param event The host execute.after tool-hook payload.
 * @returns The agent name, or "" when no shape names one.
 */
export function agentFromDeliveryEvent(event: ToolHookEvent): string {
  return (
    agentFromTaskInput(event.input) ||
    agentFromTaskInput(event.result?.input as TaskInput | undefined) ||
    agentFromDispatchEvent(event)
  )
}
