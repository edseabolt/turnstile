/**
 * @fileoverview Token-usage boundary: pure extraction, merge, and rollup
 * helpers for per-session token/cost journaling fed from the host's
 * `message.updated` event (hosts ≤ 2.3.x) or `session.step.ended` event
 * (hosts ≥ 2.4.x). No host, no journaler, no state: the caller
 * (`handleMessageUpdated` / `handleStepEnded` in
 * `src/event-stream-handlers.ts`) reads the event payload, dedups by message
 * ID against the bounded context sets, and journals; this module only decides
 * what a completed assistant-turn usage snapshot looks like and how totals
 * combine. Pure and throw-free throughout.
 *
 * The host payload shape (`properties.info`, `info.id`,
 * `tokens.cache.read` vs `info.cache.read`, `time.completed` vs `finish`)
 * is issue-derived, not verified against the running host contract; the
 * dual-nesting/completion-signal tolerance below lives only here, the single
 * place to reconcile once the host's shape is confirmed.
 */

/** Componentwise token/cost totals for one turn or one session. */
export interface TokenUsageTotals {
  /** Prompt tokens (excluding cache reads). */
  input: number
  /** Completion tokens. */
  output: number
  /** Reasoning tokens. */
  reasoning: number
  /** Cached prompt tokens read. */
  cacheRead: number
  /** Prompt tokens written to the cache. */
  cacheWrite: number
  /** Host-precomputed cost in USD; 0 when absent or non-numeric. */
  cost: number
}

/** A completed assistant-turn usage snapshot extracted from `message.updated`. */
export interface ExtractedUsage {
  /** The host message ID (dedup key across snapshot updates). */
  messageID: string
  /** The owning session ID, read from the snapshot (`info.sessionID`). */
  sessionID: string
  /** Model identifier stamped on the row. */
  modelID: string
  /** Provider identifier stamped on the row. */
  providerID: string
  /** The turn's token/cost totals. */
  totals: TokenUsageTotals
}

/**
 * Zero totals — the accumulator seed and the non-numeric-field fallback.
 * @returns A fresh all-zero totals object.
 */
export function zeroTotals(): TokenUsageTotals {
  return { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, cost: 0 }
}

/**
 * Reads a numeric field, falling back to 0 for absent or non-number values
 * (partial data is still useful; a non-number cost journals 0 rather than
 * dropping the row).
 * @param value The raw field value.
 * @returns The value when a finite number, else 0.
 */
function num(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0
}

/**
 * Reads a string field, falling back to "" for absent or non-string values.
 * @param value The raw field value.
 * @returns The value when a string, else "".
 */
function str(value: unknown): string {
  return typeof value === "string" ? value : ""
}

/**
 * Reads a nested object field, returning undefined for absent or non-object
 * values (arrays excluded — a host never sends token maps as arrays).
 * @param value The raw field value.
 * @returns The value when a plain object, else undefined.
 */
function obj(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

/**
 * Reads the cache-read/write pair, accepting both observed nestings:
 * `tokens.cache.{read,write}` and a top-level `info.cache.{read,write}`.
 * @param tokens The snapshot's `tokens` object, when present.
 * @param info The full snapshot object.
 * @returns The cache totals with 0 defaults.
 */
function cacheTotals(
  tokens: Record<string, unknown> | undefined,
  info: Record<string, unknown>,
): { cacheRead: number; cacheWrite: number } {
  const nested = obj(tokens?.cache)
  const flat = obj(info.cache)
  return {
    cacheRead: num(nested?.read) || num(flat?.read),
    cacheWrite: num(nested?.write) || num(flat?.write),
  }
}

/**
 * Extracts a completed assistant-turn usage snapshot from a
 * `message.updated` `info` payload. Guards: non-null object, assistant role,
 * a completion signal (`time.completed` number or a truthy `finish` — either
 * indicates a final snapshot), and a non-empty string message ID. Token and
 * cost fields default to 0 when absent or non-numeric.
 * @param info The raw `properties.info` value from the host event.
 * @returns The extracted usage, or null when the snapshot is not a completed
 *     assistant turn.
 */
export function extractUsage(info: unknown): ExtractedUsage | null {
  const snapshot = obj(info)
  if (!snapshot || snapshot.role !== "assistant") return null
  const time = obj(snapshot.time)
  const completed = typeof time?.completed === "number" || Boolean(snapshot.finish)
  if (!completed) return null
  const messageID = str(snapshot.id)
  if (messageID === "") return null
  const tokens = obj(snapshot.tokens)
  return {
    messageID,
    sessionID: str(snapshot.sessionID),
    modelID: str(snapshot.modelID),
    providerID: str(snapshot.providerID),
    totals: {
      ...zeroTotals(),
      input: num(tokens?.input),
      output: num(tokens?.output),
      reasoning: num(tokens?.reasoning),
      ...cacheTotals(tokens, snapshot),
      cost: num(snapshot.cost),
    },
  }
}

/**
 * A completed assistant step extracted from `session.step.ended`.
 */
export interface ExtractedStepUsage {
  /** The assistant message ID (`assistantMessageID`); dedup key. */
  messageID: string
  /** The owning session ID (top-level `properties.sessionID`). */
  sessionID: string
  /** The step's token/cost totals. */
  totals: TokenUsageTotals
}

/**
 * Extracts a completed assistant step's usage from a `session.step.ended`
 * properties payload (hosts ≥ 2.4.1). Guards: non-null object, a non-empty
 * string `sessionID`, and a non-empty string `assistantMessageID`. No role or
 * completion guard: the event itself signals step end. Token and cost fields
 * default to 0 when absent or non-numeric; the `tokens` sub-shape is
 * inference beyond the probe's top-level confirmation, so an unexpected shape
 * degrades to zeros, never a crash.
 * @param properties The raw event properties from the host event.
 * @returns The extracted step usage, or null when the payload lacks a
 *     usable session or message ID.
 */
export function extractStepUsage(properties: unknown): ExtractedStepUsage | null {
  const bag = obj(properties)
  if (!bag) return null
  const sessionID = str(bag.sessionID)
  const messageID = str(bag.assistantMessageID)
  if (sessionID === "" || messageID === "") return null
  const tokens = obj(bag.tokens)
  return {
    messageID,
    sessionID,
    totals: {
      ...zeroTotals(),
      input: num(tokens?.input),
      output: num(tokens?.output),
      reasoning: num(tokens?.reasoning),
      ...cacheTotals(tokens, bag),
      cost: num(bag.cost),
    },
  }
}

/**
 * Componentwise sum of two totals objects (the accumulator merge for the
 * summary-mode session rollup).
 * @param a The running totals.
 * @param b The incoming totals.
 * @returns A fresh totals object with each component summed.
 */
export function addTotals(a: TokenUsageTotals, b: TokenUsageTotals): TokenUsageTotals {
  return {
    input: a.input + b.input,
    output: a.output + b.output,
    reasoning: a.reasoning + b.reasoning,
    cacheRead: a.cacheRead + b.cacheRead,
    cacheWrite: a.cacheWrite + b.cacheWrite,
    cost: a.cost + b.cost,
  }
}
