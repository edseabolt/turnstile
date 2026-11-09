/**
 * @fileoverview Pure event-shape builders for the decision ledger:
 * the `prov:*` journal entry constructors for human decision surfaces. No
 * I/O, no journaling, no classification — the builders shape and redact,
 * period; origin/relevance classification is exclusively an offline
 * derived-view concern. Entries carry no `ts` field: the journaler prepends
 * it at write time. Payloads stay canonically serializable (stable key order
 * via literal construction, no non-JSON values, no `undefined` fields) so a
 * later RFC 8785 hash chain needs no migration of existing row shapes.
 */

import { redactSecrets } from "./decision-ledger-redact.ts"

/** Hard cap on `prov:stated` prompt text, keeping journal rows bounded. */
export const LEDGER_TEXT_CAP = 2000

/** One journaled human prompt, verbatim after redaction and capping. */
export interface ProvStatedEntry {
  /** Discriminator: a captured human prompt. */
  type: "prov:stated"
  /** The parent session the prompt was admitted in. */
  sessionID: string
  /** The prompt text, redacted first, then capped at `LEDGER_TEXT_CAP`. */
  text: string
  /** Whether the cap was applied to `text`. */
  truncated: boolean
}

/** Which human decision surface a denial came from. */
export type ProvDeniedKind = "plan" | "landing" | "hands-on"

/** One journaled human permission denial. */
export interface ProvDeniedEntry {
  /** Discriminator: a human permission denial. */
  type: "prov:denied"
  /** The parent session the denial occurred in. */
  sessionID: string
  /** The ask kind that was denied (mirrors the `decisionEntry` kind). */
  kind: ProvDeniedKind
}

/** One journaled human gate waiver (designed shape; wiring is post-MVP). */
export interface ProvWaiverEntry {
  /** Discriminator: a human gate waiver. */
  type: "prov:waiver"
  /** The parent session the waiver was granted in. */
  sessionID: string
  /** The gate stages the waiver's coverage opened. */
  stages: readonly string[]
}

/** Input for {@link provStatedEntry}. */
export interface ProvStatedInput {
  /** The parent session the prompt was admitted in. */
  sessionID: string
  /** The raw prompt text, redacted and capped by the builder. */
  text: string
}

/**
 * Build a `prov:stated` entry from a raw human prompt. Ordering is explicit:
 * redact-then-truncate — a secret straddling the cap boundary is masked
 * before truncation, never left half-visible in the prefix.
 *
 * @param input - The session ID and raw prompt text.
 * @returns The entry with redacted, capped text and the truncation marker.
 */
export function provStatedEntry(input: ProvStatedInput): ProvStatedEntry {
  const redacted = redactSecrets(input.text)
  const truncated = redacted.length > LEDGER_TEXT_CAP
  const text = truncated ? redacted.slice(0, LEDGER_TEXT_CAP) : redacted
  return { type: "prov:stated", sessionID: input.sessionID, text, truncated }
}

/** Input for {@link provDeniedEntry}. */
export interface ProvDeniedInput {
  /** The parent session the denial occurred in. */
  sessionID: string
  /** The ask kind that was denied. */
  kind: ProvDeniedKind
}

/**
 * Build a `prov:denied` entry for a human permission denial.
 *
 * @param input - The session ID and the ask kind that was denied.
 * @returns The entry with keys in construction order.
 */
export function provDeniedEntry(input: ProvDeniedInput): ProvDeniedEntry {
  return { type: "prov:denied", sessionID: input.sessionID, kind: input.kind }
}

/** Input for {@link provWaiverEntry}. */
export interface ProvWaiverInput {
  /** The parent session the waiver was granted in. */
  sessionID: string
  /** The gate stages the waiver's coverage opened. */
  stages: readonly string[]
}

/**
 * Build a `prov:waiver` entry for a human gate waiver. Shipped unwired:
 * the waiver quote text is already redacted upstream, so the entry carries
 * only the covered stages; wiring lands post-MVP.
 *
 * @param input - The session ID and the covered gate stages.
 * @returns The entry with keys in construction order.
 */
export function provWaiverEntry(input: ProvWaiverInput): ProvWaiverEntry {
  return { type: "prov:waiver", sessionID: input.sessionID, stages: input.stages }
}
