/**
 * @fileoverview Pure hash-chain math for the JSONL journal's tamper evidence:
 * RFC 8785-style canonical JSON, the per-record SHA-256 hash, the Merkle
 * epoch root, and the chain fold that verifies a file family. No I/O and no
 * dependencies beyond `node:crypto`; every function is deterministic so the
 * CLI mirror in `scripts/chain-read.mjs` can be cross-checked against it.
 */

import { createHash } from "node:crypto"

/**
 * Serializes a JSON-compatible value canonically: object keys sorted,
 * no whitespace, arrays in order, `undefined` object fields dropped and
 * `undefined` array elements rendered as `null` (RFC 8785 §3.2.2.2).
 * Numbers serialize via `JSON.stringify` (V8's formatting is the
 * ECMAScript Number::toString RFC 8785 mandates). Non-finite numbers and
 * non-JSON `typeof` values (function, symbol, bigint) throw a `TypeError`:
 * journal payloads are JSON round-trips, so callers never hit it, but the
 * rejection keeps a silent mis-hash impossible.
 * @param value The value to serialize.
 * @returns The canonical JSON string.
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "number") {
    if (typeof value === "number" && !Number.isFinite(value)) {
      throw new TypeError(`canonicalJson: non-finite number ${String(value)}`)
    }
    return JSON.stringify(value)
  }
  if (typeof value === "string") return JSON.stringify(value)
  if (typeof value === "undefined") return "null"
  if (Array.isArray(value)) {
    return `[${value.map((v) => canonicalJson(v === undefined ? null : v)).join(",")}]`
  }
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      // Object keys are unique, so the comparator never sees equal keys and
      // needs only the two-way ordering arms.
      .sort(([a], [b]) => (a < b ? -1 : 1))
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`
  }
  throw new TypeError(`canonicalJson: non-JSON value of type ${typeof value}`)
}

/**
 * Computes one record's chain hash: SHA-256 over the canonical JSON of the
 * fixed-shape object `{ prevHash, ts, payload }`. Wrapping the three fields
 * in one canonical object (rather than string concatenation) removes the
 * concatenation ambiguity — canonical JSON of a fixed shape is injective.
 * @param prevHash The previous record's hex hash ("" at a chain start).
 * @param ts The record's ISO timestamp.
 * @param payload The record's data fields (everything except the chain
 *     fields themselves).
 * @returns The 64-character lowercase hex digest.
 */
export function recordHash(prevHash: string, ts: string, payload: Record<string, unknown>): string {
  return createHash("sha256").update(canonicalJson({ prevHash, ts, payload })).digest("hex")
}

/**
 * Computes the Merkle root over a list of hex hashes. Each level reduces
 * pairwise via `sha256(a + b)`; an odd trailing node is hashed with itself
 * (Bitcoin-style promotion), and the single surviving node is hashed with
 * itself one final time to produce the root — the same rule a one-element
 * input follows directly. The empty list hashes the empty string. The
 * concatenation input is the two hex strings joined directly (no
 * separator); the fixed 64-character width of the inputs keeps the join
 * unambiguous.
 * @param hashes The leaf hashes, in order.
 * @returns The root hash as 64-character lowercase hex.
 */
export function merkleRoot(hashes: readonly string[]): string {
  if (hashes.length === 0) return createHash("sha256").update("").digest("hex")
  let level = [...hashes]
  while (level.length > 1) {
    const next: string[] = []
    for (let i = 0; i < level.length; i += 2) {
      const a = level[i]!
      const b = i + 1 < level.length ? level[i + 1]! : a
      next.push(
        createHash("sha256")
          .update(a + b)
          .digest("hex"),
      )
    }
    level = next
  }
  return createHash("sha256")
    .update(level[0]! + level[0]!)
    .digest("hex")
}

/** One parsed journal row as the fold sees it: the payload fields plus the
 *  (possibly absent or hostile-typed) chain fields. */
export interface ParsedRow {
  /** The row's timestamp. */
  ts: string
  /** The row's data fields (everything the row carries besides `ts`). */
  payload: Record<string, unknown>
  /** The row's declared sequence number, when present. */
  seq: unknown
  /** The row's declared previous hash, when present. */
  prevHash: unknown
  /** The row's declared hash, when present. */
  hash: unknown
}

/** Summary of one committed epoch observed during the fold. */
export interface EpochSummary {
  /** The journal family the epoch belongs to (named by the caller). */
  source: string
  /** 0-based epoch index within the family. */
  epoch: number
  /** Number of data rows the epoch covers. */
  count: number
  /** The committed Merkle root over the epoch's data-row hashes. */
  root: string
  /** The last data-row hash of the epoch. */
  head: string
  /** The epoch commit row's timestamp (the ref's anchoring time). */
  ts: string
}

/** A successful fold: the chain held and every epoch root checked out. */
export type ChainOk = { status: "ok"; epochs: EpochSummary[] }

/** A failed fold: the first broken link, 1-based within the family. */
export type ChainBroken = { status: "broken"; detail: string; index: number }

/** The fold verdict for one file family. */
export type ChainVerdict = ChainOk | ChainBroken

/**
 * Folds one file family's rows oldest-first, verifying the per-record chain
 * and every committed epoch root. Rows without a `hash` field (legacy
 * pre-chain rows) are inert and start the window; the chain begins at the
 * first row carrying `hash`. A `chain-epoch` row is consumed as an epoch
 * commit: its `root` must equal the Merkle root of the epoch's data-row
 * hashes and its `head` the last data-row hash. The first mismatch wins.
 * @param rows The family's rows, oldest-first.
 * @param source The family label (for epoch summaries and error detail).
 * @returns The fold verdict.
 */
export function foldChain(rows: readonly ParsedRow[], source: string): ChainVerdict {
  let prevHash = ""
  let expectedSeq = 0
  let epochHashes: string[] = []
  const epochs: EpochSummary[] = []
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]!
    if (typeof row.hash !== "string") continue
    const broken = checkRow(row, prevHash, expectedSeq, i, source)
    if (broken) return broken
    prevHash = row.hash
    // checkRow verified seq is the expected number, so the increment is safe.
    expectedSeq = (row.seq as number) + 1
    if (row.payload.type === "chain-epoch") {
      const verdict = closeEpoch(row, epochHashes, epochs, source)
      if (verdict) return verdict
      epochHashes = []
    } else {
      epochHashes.push(row.hash)
    }
  }
  return { status: "ok", epochs }
}

/**
 * Verifies one chained row against the running chain state.
 * @param row The row to check.
 * @param prevHash The previous verified row's hash ("" at chain start).
 * @param expectedSeq The expected sequence number.
 * @param index The row's 1-based position (for error detail).
 * @param source The family label (for error detail).
 * @returns A broken verdict on the first mismatch, undefined otherwise.
 */
function checkRow(
  row: ParsedRow,
  prevHash: string,
  expectedSeq: number,
  index: number,
  source: string,
): ChainBroken | undefined {
  const at = `${source}:${index + 1}`
  if (row.prevHash !== prevHash) {
    return { status: "broken", detail: `${at}: prevHash mismatch`, index: index + 1 }
  }
  if (typeof row.seq !== "number" || row.seq !== expectedSeq) {
    return { status: "broken", detail: `${at}: seq mismatch`, index: index + 1 }
  }
  const computed = recordHash(prevHash, row.ts, row.payload)
  if (computed !== row.hash) {
    return { status: "broken", detail: `${at}: hash mismatch`, index: index + 1 }
  }
  return undefined
}

/**
 * Consumes a `chain-epoch` row: checks its root against the Merkle root of
 * the epoch's data-row hashes and its head against the last data-row hash,
 * then records the epoch summary.
 * @param row The `chain-epoch` row (already chain-verified).
 * @param epochHashes The epoch's data-row hashes accumulated so far.
 * @param epochs The epoch summaries accumulated so far (appended to).
 * @param source The family label (for error detail and the summary).
 * @returns A broken verdict on a root/head mismatch, undefined otherwise.
 */
function closeEpoch(
  row: ParsedRow,
  epochHashes: readonly string[],
  epochs: EpochSummary[],
  source: string,
): ChainBroken | undefined {
  const root = row.payload.root
  const head = row.payload.head
  const computedRoot = merkleRoot(epochHashes)
  // The journaler only closes non-empty epochs, but a hostile or hand-built
  // journal can carry an epoch row with no data rows: the empty-window root
  // is the empty-string hash and the head is "".
  const computedHead = epochHashes[epochHashes.length - 1] ?? ""
  if (
    typeof root !== "string" ||
    typeof head !== "string" ||
    root !== computedRoot ||
    head !== computedHead
  ) {
    return {
      status: "broken",
      detail: `${source}: epoch root/head mismatch`,
      index: 0,
    }
  }
  epochs.push({
    source,
    epoch: typeof row.payload.epoch === "number" ? row.payload.epoch : -1,
    count: epochHashes.length,
    root,
    head,
    ts: row.ts,
  })
  return undefined
}
