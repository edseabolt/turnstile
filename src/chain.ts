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
  while (level.length > 1) level = reduceLevel(level)
  return createHash("sha256")
    .update(level[0]! + level[0]!)
    .digest("hex")
}

/**
 * Reduces one Merkle level by one pairwise step: each adjacent pair hashes
 * via `sha256(a + b)`, and an odd trailing node is hashed with itself
 * (Bitcoin-style promotion). Shared by `merkleRoot` and `merklePath` so the
 * promotion rule has exactly one home.
 * @param level The current level's hashes, in order.
 * @returns The next level's hashes (a single-element list is a no-op caller
 *     concern; the caller stops before calling on one).
 */
function reduceLevel(level: readonly string[]): string[] {
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
  return next
}

/** One audit-path step: which side the sibling sits on relative to the
 *  node being folded ("right" = sibling joins from the right, so the fold
 *  is `sha256(node + sibling)`). */
export interface MerklePathStep {
  /** The side the sibling joins from. */
  side: "left" | "right"
  /** The sibling's hash (the node's own hash in the odd-promotion case). */
  hash: string
}

/**
 * Derives one leaf's audit path to the root `merkleRoot(hashes)` computes.
 * At each level the sibling index is `index ^ 1`; a sibling past the level's
 * end is the odd-promotion case — the node is hashed with itself, and the
 * path records the node's own hash with side "right". Stops at the single
 * survivor; the final self-hash that produces the root is applied by
 * `merklePathRoot`, not recorded in the path. Returns [] when the list has
 * exactly one hash (the path is the implicit final self-hash) and [] for an
 * empty list (nothing to prove inclusion of).
 * @param hashes The epoch's leaf hashes, in order.
 * @param index The target leaf's 0-based position.
 * @returns The audit path, leaf-to-root order.
 * @throws RangeError When `index` is not an in-range integer for `hashes`.
 */
export function merklePath(hashes: readonly string[], index: number): MerklePathStep[] {
  if (hashes.length === 0) return []
  if (!Number.isInteger(index) || index < 0 || index >= hashes.length) {
    throw new RangeError(`merklePath: index ${index} out of range for ${hashes.length} hashes`)
  }
  const path: MerklePathStep[] = []
  let level = [...hashes]
  let i = index
  while (level.length > 1) {
    const sib = i ^ 1
    const sibHash = sib < level.length ? level[sib]! : level[i]!
    path.push({ side: (i & 1) === 0 ? "right" : "left", hash: sibHash })
    level = reduceLevel(level)
    i >>= 1
  }
  return path
}

/**
 * Recomputes the root from a leaf and its `merklePath` audit path: folds
 * `sha256(node + sibling)` per step (sibling on the right per `side`),
 * then applies the final survivor self-hash. Equals `merkleRoot` of the
 * original leaf list for an honest path; any tampered leaf, sibling, or
 * reordered step folds to a different root.
 * @param leaf The target leaf's hash.
 * @param path The audit path from `merklePath`, in leaf-to-root order.
 * @returns The recomputed root hash as 64-character lowercase hex.
 */
export function merklePathRoot(leaf: string, path: readonly MerklePathStep[]): string {
  let h = leaf
  for (const { side, hash } of path) {
    h = createHash("sha256")
      .update(side === "right" ? h + hash : hash + h)
      .digest("hex")
  }
  return createHash("sha256")
    .update(h + h)
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
  /** The epoch commit row's declared data-row count — for a window whose
   *  earliest rows were pruned this is the committed count, larger than the
   *  surviving leaf list; when the commit row's count is not a number, the
   *  surviving data-row count. */
  count: number
  /** The committed Merkle root over the epoch's data-row hashes. */
  root: string
  /** The last data-row hash of the epoch. */
  head: string
  /** The epoch commit row's timestamp (the ref's anchoring time). */
  ts: string
}

/** A successful fold: the chain held and every epoch root checked out. */
export type ChainOk = {
  status: "ok"
  epochs: EpochSummary[]
  /** Present only when the fold ran with `collectRows`: every data row
   *  attributed to its epoch window and position, in fold order. */
  rows?: CollectedRow[]
}

/** A failed fold: the first broken link, 1-based within the family. */
export type ChainBroken = {
  status: "broken"
  detail: string
  index: number
  /** Present only when the broken row is a `prov:*` row: localizes the
   *  mutation to the row and the epoch window it was folding into. */
  provContext?: ProvRowContext
}

/** Localization of a broken `prov:*` row to its epoch window. */
export interface ProvRowContext {
  /** The row's payload `type` (e.g. `"prov:stated"`). */
  type: string
  /** The row's sequence number. */
  seq: number
  /** The row's 1-based position within the family. */
  index: number
  /** The epoch window index the row was folding into. */
  epoch: number
  /** Whether that epoch window was already committed (always false for a
   *  row the fold rejected — it had not reached a commit yet). */
  committed: boolean
}

/** One data row attributed to its epoch window, collected when the fold
 *  runs with `collectRows`. */
export interface CollectedRow {
  /** The row's sequence number. */
  seq: number
  /** The row's verified hash. */
  hash: string
  /** The epoch window index the row accumulated into. */
  epoch: number
  /** The row's 0-based position within that window's leaf list. */
  position: number
  /** The row's timestamp. */
  ts: string
  /** The row's payload (chain fields excluded). */
  payload: Record<string, unknown>
  /** True when the row accumulated into an epoch window whose earliest data
   *  rows were pruned (the fold started at a trust root and this window had
   *  not yet closed): the surviving leaf list is partial, so no per-row
   *  inclusion proof can be derived against it. */
  incompleteWindow: boolean
}

/** The fold verdict for one file family. */
export type ChainVerdict = ChainOk | ChainBroken

/** Options for the chain fold. */
export interface FoldOptions {
  /** When true, the first chained row folds as a trust root: the generation
   *  it continued from was pruned by rotation, so its `prevHash` points
   *  outside the surviving files. Its own hash is still verified and its
   *  `seq` must be a non-negative integer, but the prevHash continuity
   *  check and the expected-seq match are waived for that row only. */
  chainRootAtStart?: boolean
  /** When true, an `ok` verdict additionally carries `rows`: every data row
   *  attributed to its epoch window and position within that window's leaf
   *  list, so callers can derive per-row inclusion proofs from the same
   *  single fold. */
  collectRows?: boolean
}

/**
 * Verifies one chained row against the running chain state. A trust-root
 * row (first chained row of a pruned family) skips the prevHash continuity
 * check and the expected-seq match — its seq need only be a non-negative
 * integer — but its self-hash is still verified against its own declared
 * prevHash.
 * @param row The row to check.
 * @param prevHash The previous verified row's hash ("" at chain start).
 * @param expectedSeq The expected sequence number.
 * @param index The row's 1-based position (for error detail).
 * @param source The family label (for error detail).
 * @param atRoot True when the row is the family's trust root.
 * @returns A broken verdict on the first mismatch, undefined otherwise.
 */
function checkRow(
  row: ParsedRow,
  prevHash: string,
  expectedSeq: number,
  index: number,
  source: string,
  atRoot: boolean,
): ChainBroken | undefined {
  const at = `${source}:${index + 1}`
  if (atRoot) {
    if (typeof row.seq !== "number" || !Number.isInteger(row.seq) || row.seq < 0) {
      return { status: "broken", detail: `${at}: seq mismatch`, index: index + 1 }
    }
  } else {
    if (row.prevHash !== prevHash) {
      return { status: "broken", detail: `${at}: prevHash mismatch`, index: index + 1 }
    }
    if (typeof row.seq !== "number" || row.seq !== expectedSeq) {
      return { status: "broken", detail: `${at}: seq mismatch`, index: index + 1 }
    }
  }
  // A trust-root row is hashed over its own (out-of-family) prevHash, not
  // the running "" seed; a non-string prevHash there folds to a hash
  // mismatch rather than a throw.
  const seed = atRoot && typeof row.prevHash === "string" ? row.prevHash : prevHash
  const computed = recordHash(seed, row.ts, row.payload)
  if (computed !== row.hash) {
    return { status: "broken", detail: `${at}: hash mismatch`, index: index + 1 }
  }
  return undefined
}

/**
 * Folds one file family's rows oldest-first, verifying the per-record chain
 * and every committed epoch root. Rows without a `hash` field (legacy
 * pre-chain rows) are inert and start the window; the chain begins at the
 * first row carrying `hash`. A `chain-epoch` row is consumed as an epoch
 * commit: its `root` must equal the Merkle root of the epoch's data-row
 * hashes and its `head` the last data-row hash. The first mismatch wins.
 * When `chainRootAtStart` is set (the family's oldest surviving generation
 * was preceded by pruned generations), that first chained row folds as a
 * trust root instead of a broken link.
 * @param rows The family's rows, oldest-first.
 * @param source The family label (for epoch summaries and error detail).
 * @param options The fold options (trust-root handling).
 * @returns The fold verdict.
 */
export function foldChain(
  rows: readonly ParsedRow[],
  source: string,
  options: FoldOptions = {},
): ChainVerdict {
  const ctx = {
    prevHash: "",
    expectedSeq: 0,
    epochHashes: [] as string[],
    epochs: [] as EpochSummary[],
    atRoot: options.chainRootAtStart ?? false,
    // The window in progress at the trust root is incomplete (its earliest
    // data rows were pruned); it completes at the next committed epoch.
    windowIncomplete: options.chainRootAtStart ?? false,
    windowEpoch: 0,
    collected: options.collectRows === true ? ([] as CollectedRow[]) : undefined,
  }
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]!
    if (typeof row.hash !== "string") continue
    const broken = checkRow(row, ctx.prevHash, ctx.expectedSeq, i, source, ctx.atRoot)
    if (broken) return withProvContext(broken, row, ctx.windowEpoch)
    ctx.atRoot = false
    ctx.prevHash = row.hash
    // checkRow verified seq is the expected number (or a plausible integer
    // at the trust root), so the increment is safe.
    ctx.expectedSeq = (row.seq as number) + 1
    const verdict = consumeRow(row, ctx, source)
    if (verdict) return verdict
  }
  const ok: ChainOk = { status: "ok", epochs: ctx.epochs }
  if (ctx.collected !== undefined) ok.rows = ctx.collected
  return ok
}

/**
 * Attaches `provContext` to a broken verdict when the rejected row is a
 * `prov:*` row, localizing the mutation to the row and its epoch window.
 * @param broken The broken verdict from `checkRow`.
 * @param row The row the fold rejected.
 * @param windowEpoch The epoch window index the row was folding into.
 * @returns The verdict, with `provContext` attached when applicable.
 */
function withProvContext(broken: ChainBroken, row: ParsedRow, windowEpoch: number): ChainBroken {
  const type = row.payload.type
  if (typeof type !== "string" || !type.startsWith("prov:")) return broken
  return {
    ...broken,
    provContext: {
      type,
      seq: row.seq as number,
      index: broken.index,
      epoch: windowEpoch,
      committed: false,
    },
  }
}

/**
 * Consumes one chain-verified row into the fold state: a `chain-epoch` row
 * closes the current window (advancing the window index), any other row
 * accumulates into it — and into the collected-row list when collecting.
 * @param row The verified row.
 * @param ctx The fold's running state (epoch hashes, summaries, window
 *     index, optional collected rows).
 * @param source The family label (for error detail and summaries).
 * @returns A broken verdict on an epoch root/head mismatch, undefined
 *     otherwise.
 */
function consumeRow(
  row: ParsedRow,
  ctx: {
    epochHashes: string[]
    epochs: EpochSummary[]
    windowIncomplete: boolean
    windowEpoch: number
    collected: CollectedRow[] | undefined
  },
  source: string,
): ChainBroken | undefined {
  if (row.payload.type === "chain-epoch") {
    const verdict = closeEpoch(row, ctx.epochHashes, ctx.epochs, source, ctx.windowIncomplete)
    if (verdict) return verdict
    ctx.epochHashes = []
    ctx.windowIncomplete = false
    ctx.windowEpoch =
      typeof row.payload.epoch === "number" ? row.payload.epoch + 1 : ctx.windowEpoch + 1
    return undefined
  }
  if (ctx.collected !== undefined) {
    ctx.collected.push({
      seq: row.seq as number,
      hash: row.hash as string,
      epoch: ctx.windowEpoch,
      position: ctx.epochHashes.length,
      ts: row.ts,
      payload: row.payload,
      incompleteWindow: ctx.windowIncomplete,
    })
  }
  ctx.epochHashes.push(row.hash as string)
  return undefined
}

/**
 * Checks a `chain-epoch` row's declared root and head against the epoch's
 * data-row hashes: the root must equal the Merkle root and the head the
 * last data-row hash.
 * @param root The declared root (unvalidated payload field).
 * @param head The declared head (unvalidated payload field).
 * @param epochHashes The epoch's data-row hashes accumulated so far.
 * @param source The family label (for error detail).
 * @returns A broken verdict on a root/head mismatch, undefined otherwise.
 */
function epochRootHeadMismatch(
  root: unknown,
  head: unknown,
  epochHashes: readonly string[],
  source: string,
): ChainBroken | undefined {
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
  return undefined
}

/**
 * Consumes a `chain-epoch` row: checks its root against the Merkle root of
 * the epoch's data-row hashes and its head against the last data-row hash,
 * then records the epoch summary. A window that begins at or before the
 * trust root is incomplete (its earliest data rows were pruned), so the
 * recomputed root cannot match: the declared root/head — themselves
 * chain-hash-protected payload — are recorded as declared instead.
 * @param row The `chain-epoch` row (already chain-verified).
 * @param epochHashes The epoch's data-row hashes accumulated so far.
 * @param epochs The epoch summaries accumulated so far (appended to).
 * @param source The family label (for error detail and the summary).
 * @param windowIncomplete True when the window includes the trust-root row.
 * @returns A broken verdict on a root/head mismatch, undefined otherwise.
 */
function closeEpoch(
  row: ParsedRow,
  epochHashes: readonly string[],
  epochs: EpochSummary[],
  source: string,
  windowIncomplete: boolean,
): ChainBroken | undefined {
  const root = row.payload.root
  const head = row.payload.head
  if (!windowIncomplete) {
    const broken = epochRootHeadMismatch(root, head, epochHashes, source)
    if (broken) return broken
  } else if (typeof root !== "string" || typeof head !== "string") {
    // An incomplete window with non-string root/head is still malformed.
    return epochRootHeadMismatch(root, head, epochHashes, source)
  }
  epochs.push({
    source,
    epoch: typeof row.payload.epoch === "number" ? row.payload.epoch : -1,
    count: typeof row.payload.count === "number" ? row.payload.count : epochHashes.length,
    root: root as string,
    head: head as string,
    ts: row.ts,
  })
  return undefined
}
