/**
 * @fileoverview Host-payload coercion and delivery classification: turns raw
 * host values into session IDs, classifies an `execute.after`
 * task/subagent delivery into its host shape (the single shape decision per
 * delivery), and rewrites a classified delivery's model-visible text across
 * every shape. Also owns the candidate-key tables (parent id, project
 * directory, agent name) and the ask-message prefixes the permission and
 * stream surfaces share, so every reader uses one extraction rule.
 */

import type { PromptHookProperties, ToolHookEvent, ToolResult } from "./types.ts"

/**
 * Coerces an unknown host value into a session-ID string, mirroring the
 * historical `String(value ?? "")` behavior at this boundary.
 * @param value Raw value from a host payload.
 * @returns The string form, or an empty string for nullish values.
 */
export function asSessionID(value: unknown): string {
  return String(value ?? "")
}

/**
 * One classified `execute.after` task/subagent delivery. The shape decision
 * is made exactly once per delivery by `classifyDelivery`, and every
 * consumer (marker parsing, the bare-output check, policy injection) reads
 * the classified child ID and text from here — never re-deriving the shape.
 */
export type Delivery =
  | { kind: "string"; child: string; text: string } // v1 task: string output, child-keyed event
  | { kind: "structured"; child: string; text: string } // v2 subagent: structured output, parent-keyed event
  | { kind: "unknown"; child: string; text: ""; shape: string } // present but unclassifiable — journaled loudly
  | { kind: "absent"; child: string; text: "" } // nothing to deliver — documented silent case

/**
 * Whether a value is a plain object (neither null nor array-like): the guard
 * both `describeResultShape` and `structuredPartsOf` need before touching
 * object fields, so a hostile or reshaped payload can never throw.
 * @param value The value to test.
 * @returns True for a plain object.
 */
export function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

/**
 * Child session ID read from a result's `metadata.sessionID`.
 * @param result The tool result whose metadata is read.
 * @returns The ID as a string, or "" when it is not a string.
 */
export function metadataChildOf(result: ToolResult): string {
  const sid = result.metadata?.sessionID
  return typeof sid === "string" ? sid : ""
}

/**
 * Short safe type label for the shape descriptor: `"null"`, `"array"`, or
 * the value's `typeof`. The array label is load-bearing: a real host
 * delivers structured subagent `content` as an array of content blocks, so
 * the descriptor must distinguish that from a plain object.
 * @param value Any value to label.
 * @returns The type label.
 */
export function shapeOf(value: unknown): string {
  if (value === null) return "null"
  if (Array.isArray(value)) return "array"
  return typeof value
}

/**
 * Safe bounded descriptor of an unrecognized tool result: per-field type
 * labels plus the sorted key names of a plain-object `output` (capped at 8).
 * Never serializes values, so a hostile getter or a huge payload cannot
 * escape through the journal.
 * @param result The present-but-unclassifiable tool result.
 * @returns A single-line `output=… content=… metadata=…` descriptor.
 */
export function describeResultShape(result: ToolResult): string {
  const output = result.output
  const record = isPlainRecord(output)
  const keys = record ? Object.keys(output).sort().slice(0, 8).join(",") : ""
  return (
    `output=${shapeOf(output)}${record ? `[${keys}]` : ""} ` +
    `content=${shapeOf(result.content)} metadata=${shapeOf(result.metadata)}`
  )
}

/**
 * The child session ID and canonical child text of a structured subagent
 * result, null when the result is not a structured delivery or carries no
 * child ID. The child resolves from the string `metadata.sessionID` first,
 * then the structured `output.sessionID`; the canonical text is the string
 * `output.output`. `content` is deliberately not part of the decision: a
 * real host delivers it as an array of content blocks (or a string), and
 * either form — or its absence — classifies as structured.
 * @param result The tool result to read.
 * @returns The child and canonical text, or null when unresolvable.
 */
export function structuredPartsOf(result: ToolResult): { child: string; text: string } | null {
  const output = result.output
  if (!isPlainRecord(output) || typeof output.output !== "string") return null
  const child =
    metadataChildOf(result) || (typeof output.sessionID === "string" ? output.sessionID : "")
  if (child === "") return null
  return { child, text: output.output }
}

/**
 * Classifies an `execute.after` task/subagent delivery into its host shape —
 * the single shape decision per delivery. The v1 `task` shape delivers a
 * string `result.output` with a child-keyed event (a string
 * `metadata.sessionID`, when present, names the real child); the v2
 * `subagent` shape delivers a structured `result.output` with a parent-keyed
 * event, the child on `metadata.sessionID` (or `output.sessionID`), the
 * canonical child text in `output.output`, and model-visible `content` as a
 * string or a block array (absent `content` is fine too: the host then
 * stringifies `output`). A present result matching neither shape is
 * `unknown` (the caller journals it loudly); an absent result is `absent`
 * (a documented silent case).
 * @param event The execute.after payload.
 * @returns The classified delivery.
 */
export function classifyDelivery(event: ToolHookEvent): Delivery {
  const result = event.result
  if (!result) return { kind: "absent", child: asSessionID(event.sessionID), text: "" }
  if (typeof result.output === "string") {
    return {
      kind: "string",
      child: metadataChildOf(result) || asSessionID(event.sessionID),
      text: result.output,
    }
  }
  const parts = structuredPartsOf(result)
  if (parts) return { kind: "structured", ...parts }
  return {
    kind: "unknown",
    child: asSessionID(event.sessionID),
    text: "",
    shape: describeResultShape(result),
  }
}

/**
 * Applies a text transformation to a classified delivery's model-visible
 * text across every host shape. String shape: `result.output` is rewritten
 * in place. Structured shape: a string `result.content` is rewritten in
 * place; a block-array `content` gains one new text block carrying
 * `mutate("")` — the transformation applied to empty text, which is exactly
 * the inserted head for "prepend" and the appended tail for "append" —
 * placed at the front for "prepend" and the end for "append" (the host
 * passes a content array through to the model unchanged); absent or other
 * `content` falls back to the structured output string (`output.output`,
 * which the host stringifies when `content` is absent). In that fallback
 * the `output` object keeps its shape and other keys, but its `output`
 * field is rewritten in place — the host stringifies `output`, so rewriting
 * the field is what makes the transformation visible to the model.
 *
 * Each shape re-reads the field's current value before mutating, so more
 * than one transformation on the same delivery (the per-delivery status
 * append and the once-per-task policy prepend) composes in call order.
 * Throws propagate to the caller's fail-open catch.
 * @param event The execute.after payload whose result is mutated.
 * @param delivery The classified delivery (string or structured only).
 * @param mutate The text transformation to apply to the model-visible text.
 * @param placement For a structured block-array `content`, whether the new
 *     block goes at the front ("prepend") or the end ("append").
 */
export function mutateDeliveryText(
  event: ToolHookEvent,
  delivery: Extract<Delivery, { kind: "string" | "structured" }>,
  mutate: (text: string) => string,
  placement: "prepend" | "append",
): void {
  const result = event.result as ToolResult
  if (delivery.kind !== "structured") {
    const current = typeof result.output === "string" ? result.output : delivery.text
    result.output = mutate(current)
    return
  }
  const content = result.content
  if (typeof content === "string") {
    result.content = mutate(content)
    return
  }
  if (Array.isArray(content)) {
    const block = { type: "text", text: mutate("") }
    result.content = placement === "prepend" ? [block, ...content] : [...content, block]
    return
  }
  const structuredOutput = result.output as Record<string, unknown>
  const current =
    typeof structuredOutput.output === "string" ? structuredOutput.output : delivery.text
  structuredOutput.output = mutate(current)
}

/**
 * Prepends the orchestrator policy head to the classified delivery's
 * model-visible text: a thin caller of `mutateDeliveryText` inserting the
 * caller-supplied policy text at the front (the caller builds it once per
 * plugin load from the resolved config, so the head always matches the
 * mechanical caps).
 * @param event The execute.after payload whose result is mutated.
 * @param delivery The classified delivery (string or structured only).
 * @param policy The policy head text to prepend.
 */
export function prependDeliveryText(
  event: ToolHookEvent,
  delivery: Extract<Delivery, { kind: "string" | "structured" }>,
  policy: string,
): void {
  mutateDeliveryText(event, delivery, (text) => policy + "\n" + text, "prepend")
}

/**
 * Picks the user prompt text from the host's candidate keys: the FIRST
 * candidate that is a NON-EMPTY string wins. An empty `text` no longer
 * shadows a marker-bearing `prompt` (and vice versa); when neither key holds a
 * non-empty string the prompt text is unresolvable and "" is returned (the
 * keyless-misconfiguration telemetry keys off exactly this). The THIRD candidate,
 * `prompt.text`, reads the object's text only when `prompt` is a non-null object
 * (a hostile getter on it throws and keeps the capture journal keys).
 * @param properties The `session.prompt` hook payload.
 * @returns The resolved prompt text, or "" when unresolvable.
 */
export function promptTextOf(properties: PromptHookProperties | undefined): string {
  for (const candidate of [
    properties?.text,
    properties?.prompt,
    (properties?.prompt as { text?: unknown } | null)?.text,
  ]) {
    if (typeof candidate === "string" && candidate !== "") return candidate
  }
  return ""
}

/**
 * Message prefix the evaluate handler stamps on every plan-gate ask, so the
 * stream consumer can recognize a plan ask even when the host omits the
 * session id on the `permission.asked` event.
 */
export const PLAN_ASK_MESSAGE_PREFIX = "turnstile: plan approval required"

/**
 * Message prefix the evaluate handler stamps on every landing-gate ask, so the
 * stream consumer can recognize a landing ask (even when the host omits the
 * session id) and route its reply to the landing gate.
 */
export const LANDING_ASK_MESSAGE_PREFIX = "turnstile: pushing requires a reviewer"

/**
 * Message prefix the evaluate handler stamps on every hands-on-gate ask, so
 * the stream consumer can recognize a hands-on ask (even when the host omits
 * the session id) and route its reply to the hands-on gate. It is the opening
 * of HANDSON_REQUIREMENT (the ask message is `turnstile: ${HANDSON_REQUIREMENT}`),
 * and it is disjoint from the plan and landing prefixes, so an approval of one
 * never releases another.
 */
export const HANDSON_ASK_MESSAGE_PREFIX =
  "turnstile: parent-session write/edit requires the pipeline"

/**
 * Candidate keys for the parent id on a session record, in priority order,
 * dotted paths supported. The single source for the parent-id read so
 * `resolveParent` and `readRecordString` share one extraction rule.
 */
export const PARENT_KEYS = ["parentID", "data.parentID"] as const

/**
 * Candidate keys for the project directory on a session record, in priority
 * order, dotted paths supported. The single source for the directory read so
 * `resolveProjectDir` and `readRecordString` share one extraction rule.
 */
export const DIRECTORY_KEYS = [
  "directory",
  "location.directory",
  "data.directory",
  "data.location.directory",
] as const

/**
 * Candidate keys for the agent name on a session record, in priority order,
 * dotted paths supported. The single source for the agent-name read so
 * `resolveParent` and `readRecordString` share one extraction rule; an
 * unresolved read ("") fails the emitter-authority check (fail-closed for
 * text observation).
 */
export const AGENT_KEYS = ["agent", "data.agent"] as const

/**
 * Returns the first non-empty string found at any key of `keys` on `rec`,
 * supporting dotted nested paths (e.g. `data.location.directory`). "" when
 * none holds a non-empty string or `rec` is absent. Shared candidate
 * extraction for `resolveParent` (parent id) and `resolveProjectDir` (project
 * directory): one field-extraction rule in one place.
 * @param rec The record to read from (may be undefined or non-object).
 * @param keys The candidate keys in priority order (dotted paths supported).
 * @returns The first non-empty string, or "" when none resolves.
 */
export function readRecordString(rec: unknown, keys: readonly string[]): string {
  if (!rec || typeof rec !== "object") return ""
  const obj = rec as Record<string, unknown>
  for (const key of keys) {
    let cur: unknown = obj
    for (const part of key.split(".")) {
      if (cur && typeof cur === "object") cur = (cur as Record<string, unknown>)[part]
      else {
        cur = undefined
        break
      }
    }
    if (typeof cur === "string" && cur !== "") return cur
  }
  return ""
}
