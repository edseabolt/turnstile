// CLI-side mirror of the journal hash-chain fold (`src/chain.ts` + the
// family walk of `src/verify.ts`). scripts/*.mjs spawn under plain node and
// cannot import src/*.ts, so the fold is re-implemented here; the sync
// obligation is cross-checked by tests/prov-verify-cli.test.ts, which seeds
// journals through the real src/ path and verifies through this mirror.
// This is the repo's one deliberate DRY exception (the journal-read.mjs
// precedent).
//
// Zero dependencies beyond node:crypto/node:fs/node:path.

import * as fs from "node:fs"
import * as path from "node:path"
import * as childProcess from "node:child_process"
import { createHash } from "node:crypto"

/**
 * Serializes a JSON-compatible value canonically: object keys sorted, no
 * whitespace, arrays in order, `undefined` object fields dropped and
 * `undefined` array elements rendered as `null`. Must stay byte-identical
 * to `canonicalJson` in src/chain.ts.
 * @param {unknown} value The value to serialize.
 * @returns {string} The canonical JSON string.
 */
export function canonicalJson(value) {
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
    const entries = Object.entries(value)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : 1))
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`
  }
  throw new TypeError(`canonicalJson: non-JSON value of type ${typeof value}`)
}

/**
 * Computes one record's chain hash: SHA-256 over the canonical JSON of
 * `{ prevHash, ts, payload }`. Must stay identical to `recordHash` in
 * src/chain.ts.
 * @param {string} prevHash The previous record's hex hash.
 * @param {string} ts The record's ISO timestamp.
 * @param {Record<string, unknown>} payload The record's data fields.
 * @returns {string} The 64-character lowercase hex digest.
 */
export function recordHash(prevHash, ts, payload) {
  return createHash("sha256").update(canonicalJson({ prevHash, ts, payload })).digest("hex")
}

/**
 * Computes the Merkle root over a list of hex hashes: pairwise
 * `sha256(a + b)` per level, odd trailing node hashed with itself, the
 * single survivor hashed with itself once more, empty list hashing the
 * empty string. Must stay identical to `merkleRoot` in src/chain.ts.
 * @param {string[]} hashes The leaf hashes, in order.
 * @returns {string} The root hash.
 */
export function merkleRoot(hashes) {
  if (hashes.length === 0) return createHash("sha256").update("").digest("hex")
  let level = [...hashes]
  while (level.length > 1) level = reduceLevel(level)
  return createHash("sha256")
    .update(level[0] + level[0])
    .digest("hex")
}

/**
 * Reduces one Merkle level by one pairwise step: each adjacent pair hashes
 * via `sha256(a + b)`, and an odd trailing node is hashed with itself.
 * Shared by `merkleRoot` and `merklePath`. Must stay identical to
 * `reduceLevel` in src/chain.ts.
 * @param {string[]} level The current level's hashes, in order.
 * @returns {string[]} The next level's hashes.
 */
function reduceLevel(level) {
  const next = []
  for (let i = 0; i < level.length; i += 2) {
    const a = level[i]
    const b = i + 1 < level.length ? level[i + 1] : a
    next.push(
      createHash("sha256")
        .update(a + b)
        .digest("hex"),
    )
  }
  return next
}

/**
 * Derives one leaf's audit path to the root `merkleRoot(hashes)` computes:
 * at each level the sibling index is `index ^ 1`; a sibling past the
 * level's end is the odd-promotion case (the node's own hash, side
 * "right"). The final survivor self-hash is applied by `merklePathRoot`,
 * not recorded in the path. Must stay identical to `merklePath` in
 * src/chain.ts.
 * @param {string[]} hashes The epoch's leaf hashes, in order.
 * @param {number} index The target leaf's 0-based position.
 * @returns {{ side: "left" | "right", hash: string }[]} The audit path,
 *     leaf-to-root order; [] for an empty list.
 * @throws {RangeError} When `index` is not an in-range integer.
 */
export function merklePath(hashes, index) {
  if (hashes.length === 0) return []
  if (!Number.isInteger(index) || index < 0 || index >= hashes.length) {
    throw new RangeError(`merklePath: index ${index} out of range for ${hashes.length} hashes`)
  }
  const path = []
  let level = [...hashes]
  let i = index
  while (level.length > 1) {
    const sib = i ^ 1
    const sibHash = sib < level.length ? level[sib] : level[i]
    path.push({ side: (i & 1) === 0 ? "right" : "left", hash: sibHash })
    level = reduceLevel(level)
    i >>= 1
  }
  return path
}

/**
 * Recomputes the root from a leaf and its `merklePath` audit path: folds
 * `sha256(node + sibling)` per step (sibling on the right per `side`), then
 * applies the final survivor self-hash. Must stay identical to
 * `merklePathRoot` in src/chain.ts.
 * @param {string} leaf The target leaf's hash.
 * @param {{ side: "left" | "right", hash: string }[]} path The audit path,
 *     leaf-to-root order.
 * @returns {string} The recomputed root hash.
 */
export function merklePathRoot(leaf, path) {
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

/**
 * Folds one file family's rows oldest-first, verifying the per-record
 * chain and every committed epoch root. Mirrors `foldChain` in
 * src/chain.ts: rows without a `hash` field are inert; the first mismatch
 * (prevHash, seq, or recomputed hash) wins; `chain-epoch` rows are
 * consumed as epoch commits checked against the accumulated data-row
 * hashes.
 * @param {{ ts: string, payload: Record<string, unknown>, seq: unknown,
 *     prevHash: unknown, hash: unknown }[]} rows The family's rows,
 *     oldest-first.
 * @param {string} source The family label (for detail and summaries).
 * @returns {{ status: "ok", epochs: object[] } | { status: "broken",
 *     detail: string, index: number }} The fold verdict.
 */
export function foldChain(rows, source, options = {}) {
  const ctx = {
    prevHash: "",
    expectedSeq: 0,
    epochHashes: [],
    epochs: [],
    atRoot: options.chainRootAtStart ?? false,
    // The window in progress at the trust root is incomplete (its earliest
    // data rows were pruned); it completes at the next committed epoch.
    windowIncomplete: options.chainRootAtStart ?? false,
    windowEpoch: 0,
    collected: options.collectRows === true ? [] : undefined,
  }
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]
    if (typeof row.hash !== "string") continue
    const at = `${source}:${i + 1}`
    if (ctx.atRoot) {
      // Trust root: the generation this row continued from was pruned, so
      // its prevHash points outside the surviving files. Its own hash is
      // still verified and its seq must be a non-negative integer.
      if (typeof row.seq !== "number" || !Number.isInteger(row.seq) || row.seq < 0) {
        return withProvContext(
          { status: "broken", detail: `${at}: seq mismatch`, index: i + 1 },
          row,
          ctx.windowEpoch,
        )
      }
    } else {
      if (row.prevHash !== ctx.prevHash) {
        return withProvContext(
          { status: "broken", detail: `${at}: prevHash mismatch`, index: i + 1 },
          row,
          ctx.windowEpoch,
        )
      }
      if (typeof row.seq !== "number" || row.seq !== ctx.expectedSeq) {
        return withProvContext(
          { status: "broken", detail: `${at}: seq mismatch`, index: i + 1 },
          row,
          ctx.windowEpoch,
        )
      }
    }
    // A trust-root row is hashed over its own (out-of-family) prevHash, not
    // the running "" seed; a non-string prevHash there folds to a hash
    // mismatch rather than a throw.
    const seed = ctx.atRoot && typeof row.prevHash === "string" ? row.prevHash : ctx.prevHash
    if (recordHash(seed, row.ts, row.payload) !== row.hash) {
      return withProvContext(
        { status: "broken", detail: `${at}: hash mismatch`, index: i + 1 },
        row,
        ctx.windowEpoch,
      )
    }
    ctx.atRoot = false
    ctx.prevHash = row.hash
    ctx.expectedSeq = row.seq + 1
    const verdict = consumeRow(row, ctx, source)
    if (verdict) return verdict
  }
  const ok = { status: "ok", epochs: ctx.epochs }
  if (ctx.collected !== undefined) ok.rows = ctx.collected
  return ok
}

/**
 * Attaches `provContext` to a broken verdict when the rejected row is a
 * `prov:*` row, localizing the mutation to the row and its epoch window.
 * Must stay identical to `withProvContext` in src/chain.ts.
 * @param {{ status: "broken", detail: string, index: number }} broken The
 *     broken verdict.
 * @param {{ payload: Record<string, unknown>, seq: unknown }} row The row
 *     the fold rejected.
 * @param {number} windowEpoch The epoch window index the row folded into.
 * @returns {object} The verdict, with `provContext` attached when
 *     applicable.
 */
function withProvContext(broken, row, windowEpoch) {
  const type = row.payload.type
  if (typeof type !== "string" || !type.startsWith("prov:")) return broken
  return {
    ...broken,
    provContext: {
      type,
      seq: row.seq,
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
 * Must stay identical to `consumeRow` in src/chain.ts.
 * @param {{ ts: string, payload: Record<string, unknown>, seq: number,
 *     hash: string }} row The verified row.
 * @param {{ epochHashes: string[], epochs: object[], windowIncomplete:
 *     boolean, windowEpoch: number, collected: object[] | undefined }} ctx
 *     The fold's running state.
 * @param {string} source The family label.
 * @returns {object | undefined} A broken verdict on an epoch root/head
 *     mismatch, undefined otherwise.
 */
function consumeRow(row, ctx, source) {
  if (row.payload.type === "chain-epoch") {
    const root = row.payload.root
    const head = row.payload.head
    if (!ctx.windowIncomplete) {
      const computedRoot = merkleRoot(ctx.epochHashes)
      const computedHead = ctx.epochHashes[ctx.epochHashes.length - 1] ?? ""
      if (
        typeof root !== "string" ||
        typeof head !== "string" ||
        root !== computedRoot ||
        head !== computedHead
      ) {
        return { status: "broken", detail: `${source}: epoch root/head mismatch`, index: 0 }
      }
    } else if (typeof root !== "string" || typeof head !== "string") {
      // An incomplete window with non-string root/head is still malformed.
      return { status: "broken", detail: `${source}: epoch root/head mismatch`, index: 0 }
    }
    ctx.epochs.push({
      source,
      epoch: typeof row.payload.epoch === "number" ? row.payload.epoch : -1,
      count: ctx.epochHashes.length,
      root,
      head,
      ts: row.ts,
    })
    ctx.epochHashes = []
    ctx.windowIncomplete = false
    ctx.windowEpoch =
      typeof row.payload.epoch === "number" ? row.payload.epoch + 1 : ctx.windowEpoch + 1
    return undefined
  }
  if (ctx.collected !== undefined) {
    ctx.collected.push({
      seq: row.seq,
      hash: row.hash,
      epoch: ctx.windowEpoch,
      position: ctx.epochHashes.length,
      ts: row.ts,
      payload: row.payload,
    })
  }
  ctx.epochHashes.push(row.hash)
  return undefined
}

/**
 * Lists one file family's generations oldest-first (numbered generations
 * that exist, then the current file), plus whether the family folds with a
 * trust root: the oldest surviving file is a numbered generation other than
 * `.1` only when the journaler pruned. Mirrors `familyFiles` in
 * src/verify.ts.
 * @param {string} file Absolute path of the current journal file.
 * @param {number} maxGenerations The generation count convention.
 * @returns {{ files: string[], chainRootAtStart: boolean }} The existing
 *     file paths oldest-first plus the trust-root flag.
 */
export function familyFiles(file, maxGenerations) {
  const files = []
  for (let gen = maxGenerations; gen >= 1; gen--) {
    if (fs.existsSync(`${file}.${gen}`)) files.push(`${file}.${gen}`)
  }
  if (fs.existsSync(file)) files.push(file)
  const oldest = files[0]
  const chainRootAtStart = oldest !== undefined && oldest !== file && oldest !== `${file}.1`
  return { files, chainRootAtStart }
}

/**
 * Reads one journal file into the fold's row shape, skipping malformed
 * lines and non-object rows. Mirrors `readFamilyRows` in src/verify.ts.
 * @param {string} file The file to read.
 * @returns {{ ts: string, payload: Record<string, unknown>, seq: unknown,
 *     prevHash: unknown, hash: unknown }[]} The parsed rows, oldest-first.
 */
export function readFamilyRows(file) {
  let text
  try {
    text = fs.readFileSync(file, "utf8")
  } catch {
    return []
  }
  const rows = []
  for (const line of text.split("\n")) {
    if (line.trim() === "") continue
    try {
      const parsed = JSON.parse(line)
      if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) continue
      const { seq, prevHash, hash, ...payload } = parsed
      rows.push({
        ts: typeof payload.ts === "string" ? payload.ts : "",
        payload,
        seq,
        prevHash,
        hash,
      })
    } catch {
      // malformed line: skip, keep the rest
    }
  }
  return rows
}

/**
 * Folds one family across its generations and collects the epoch refs its
 * committed `chain-epoch` rows carry. Mirrors `foldFamily` in src/verify.ts.
 * @param {string} source The family label.
 * @param {{ files: string[], chainRootAtStart: boolean }} family The
 *     family's files oldest-first plus the trust-root flag.
 * @returns {{ verdict: object, refs: object[] }} The verdict plus refs.
 */
export function foldFamily(source, family, options = {}) {
  const rows = family.files.flatMap((file) => readFamilyRows(file))
  const verdict = foldChain(rows, source, { chainRootAtStart: family.chainRootAtStart, ...options })
  const refs = []
  if (verdict.status === "ok") {
    for (const epoch of verdict.epochs) {
      refs.push({
        sink: "",
        source: epoch.source,
        epoch: epoch.epoch,
        root: epoch.root,
        head: epoch.head,
        ts: epoch.ts,
      })
    }
  }
  return { verdict, refs, rows: rows.length, collected: verdict.rows ?? [] }
}

/**
 * Lists the per-session sink families (current files only; generations are
 * walked per family). Mirrors `sessionSinkPaths` in scripts/journal-read.mjs.
 * @param {string} metricsDir The metrics directory.
 * @returns {string[]} Absolute paths of the current per-session files.
 */
export function sessionSinkPathsLocal(metricsDir) {
  try {
    return fs
      .readdirSync(path.join(metricsDir, "sessions"))
      .filter((name) => /\.jsonl$/.test(name) && !/\.jsonl\.\d+$/.test(name))
      .sort()
      .map((name) => path.join(metricsDir, "sessions", name))
  } catch {
    return []
  }
}

/**
 * Runs the full verify over a metrics directory: every journal family
 * folds across its generations and the committed epoch refs are collected.
 * Mirrors `verifyJournalChain` in src/verify.ts (anchor verification is
 * performed by the caller, which resolves sinks).
 * @param {string} metricsDir The metrics directory.
 * @param {number} [maxGenerations=5] The rotation generation count convention
 *     (`journalMaxGenerations`); defaults to 5 like the src/ mirror.
 * @returns {{ families: { source: string, verdict: object }[], refs: object[] }}
 *     The per-family verdicts and the collected epoch refs.
 */
export function verifyFamilies(metricsDir, maxGenerations = 5) {
  const journalPath = path.join(metricsDir, "turnstile.jsonl")
  const families = []
  const refs = []
  let rows = 0
  const shared = foldFamily("shared", familyFiles(journalPath, maxGenerations))
  families.push({ source: "shared", verdict: shared.verdict })
  refs.push(...shared.refs)
  rows += shared.rows
  for (const sink of sessionSinkPathsLocal(metricsDir)) {
    const source = path.basename(sink).replace(/\.jsonl$/, "")
    const folded = foldFamily(source, familyFiles(sink, maxGenerations))
    families.push({ source, verdict: folded.verdict })
    refs.push(...folded.refs)
    rows += folded.rows
  }
  return { families, refs, rows }
}

/**
 * Runs the scoped verify over a metrics directory for one session: folds
 * only the shared family and that session's sink family (across their
 * rotation generations), collecting per-row epoch attribution for the
 * per-row inclusion proofs. Epoch refs are collected the same way the
 * global walk collects them, but only from the two folded families.
 * @param {string} metricsDir The metrics directory.
 * @param {string} sessionID The target session's ID (shape-validated by
 *     the caller).
 * @param {number} [maxGenerations=5] The rotation generation count convention
 *     (`journalMaxGenerations`); defaults to 5 like the src/ mirror.
 * @returns {{ families: { source: string, verdict: object }[], refs:
 *     object[], rows: number, collected: object[] }} The per-family
 *     verdicts, the collected epoch refs, the total folded row count, and
 *     every collected data row attributed to its epoch (each carrying
 *     `{ source, seq, hash, epoch, position, ts, payload }`).
 */
export function verifySessionFamilies(metricsDir, sessionID, maxGenerations = 5) {
  const journalPath = path.join(metricsDir, "turnstile.jsonl")
  const sinkFile = path.join(metricsDir, "sessions", `${sessionID}.jsonl`)
  const families = []
  const refs = []
  const collected = []
  let rows = 0
  for (const [source, file] of [
    ["shared", journalPath],
    [sessionID, sinkFile],
  ]) {
    const folded = foldFamily(source, familyFiles(file, maxGenerations), { collectRows: true })
    families.push({ source, verdict: folded.verdict })
    refs.push(...folded.refs)
    rows += folded.rows
    for (const r of folded.collected) {
      collected.push({
        source,
        seq: r.seq,
        hash: r.hash,
        epoch: r.epoch,
        position: r.position,
        ts: r.ts,
        payload: r.payload,
      })
    }
  }
  return { families, refs, rows, collected }
}

/**
 * Reads the session-state anchor store (`<metricsDir>/anchors.jsonl`) and
 * returns the refs it names. Fail-open: a missing or malformed file yields
 * no anchored refs. Mirrors `readAnchoredRefs` in src/verify.ts.
 * @param {string} metricsDir The metrics directory hosting the anchor store.
 * @returns {object[]} The anchored refs, oldest-first.
 */
export function readAnchoredRefs(metricsDir) {
  try {
    return fs
      .readFileSync(path.join(metricsDir, "anchors.jsonl"), "utf8")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line))
  } catch {
    return []
  }
}

/**
 * Names the anchored refs the surviving journal positively fails to vouch
 * for. The committed root is the identity that survives rotation: an
 * anchored ref is satisfied when a retained epoch carries its root, or when
 * its epoch index lies below the family's lowest retained index (that
 * generation was pruned, so absence is undetectable). It is reported absent
 * only when the root matches nothing AND the index is at or above the
 * lowest retained index — a gap within, or truncation of, retained history.
 * Mirrors `absentAnchoredRefs` in src/verify.ts.
 * @param {string} metricsDir The metrics directory hosting the anchor store.
 * @param {object[]} refs The epoch refs collected from the journal.
 * @returns {string[]} One detail string per absent anchored epoch.
 */
export function absentAnchoredRefs(metricsDir, refs) {
  const roots = new Set(refs.map((r) => r.root))
  const retained = new Set(refs.map((r) => `${r.source}#${r.epoch}`))
  const lowest = new Map()
  for (const r of refs) {
    const cur = lowest.get(r.source)
    if (cur === undefined || r.epoch < cur) lowest.set(r.source, r.epoch)
  }
  return readAnchoredRefs(metricsDir)
    .filter((a) => {
      if (roots.has(a.root)) return false
      // No retained epoch for the source at all: any anchored index is a
      // positive mismatch (the same signal as whole-journal deletion).
      return a.epoch >= (lowest.get(a.source) ?? 0)
    })
    .map((a) =>
      retained.has(`${a.source}#${a.epoch}`)
        ? `anchored epoch ${a.source}#${a.epoch} root mismatch (reforged commit?)`
        : `anchored epoch ${a.source}#${a.epoch} absent from journal`,
    )
}

// ---------------------------------------------------------------------------
// Anchor-sink mirror (src/anchor.ts). Same sync obligation as the fold above.
// ---------------------------------------------------------------------------

/**
 * Builds the builtin `session-state` sink mirror: refs are read from
 * `<metricsDir>/anchors.jsonl`. Must stay identical to `sessionStateSink`
 * in src/anchor.ts.
 * @param {{ metricsDir: string }} options The anchor options.
 * @returns {object} The sink.
 */
export function sessionStateSink(options) {
  const file = path.join(options.metricsDir, "anchors.jsonl")
  const readRefs = () => {
    try {
      return fs
        .readFileSync(file, "utf8")
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line))
    } catch {
      return []
    }
  }
  return {
    id: "session-state",
    trustDomain: "host",
    publish() {},
    verify(ref) {
      const hit = readRefs().find((r) => r.source === ref.source && r.epoch === ref.epoch)
      if (!hit) return { status: "missing", detail: `${ref.source}#${ref.epoch} not anchored` }
      if (hit.root !== ref.root || hit.head !== ref.head) {
        return { status: "mismatch", detail: `${ref.source}#${ref.epoch} root/head differ` }
      }
      return { status: "ok", anchoredAt: hit.ts }
    },
  }
}

/**
 * The default execution seam for the git-backed sink mirrors.
 * @param {string} command The command to run.
 * @param {ReadonlyArray<string>} args The argv array.
 * @param {{ cwd?: string } | undefined} options The child options.
 * @returns {string} The command's stdout as a string.
 */
function execOut(command, args, options) {
  return String(
    childProcess.execFileSync(command, args, {
      timeout: 2000,
      stdio: ["ignore", "pipe", "ignore"],
      ...options,
    }),
  )
}

/**
 * Builds the builtin `git-note` sink mirror. Must stay identical to
 * `gitNoteSink` in src/anchor.ts.
 * @param {{ projectDir: string }} options The anchor options.
 * @returns {object} The sink.
 */
export function gitNoteSink(options) {
  const noteArgs = ["notes", "--ref=refs/notes/turnstile"]
  const git = (args) => execOut("git", args, { cwd: options.projectDir })
  return {
    id: "git-note",
    trustDomain: "repo",
    publish() {},
    verify(ref) {
      let notes
      try {
        notes = git([...noteArgs, "list"])
      } catch (e) {
        return { status: "missing", detail: `git notes list failed: ${String(e)}` }
      }
      for (const line of notes.split("\n")) {
        const noteRef = line.trim().split(/\s+/)[1]
        if (!noteRef) continue
        let body
        try {
          body = git([...noteArgs, "show", noteRef])
        } catch {
          continue
        }
        let parsed
        try {
          parsed = JSON.parse(body.trim())
        } catch {
          continue
        }
        if (parsed.source === ref.source && parsed.epoch === ref.epoch) {
          if (parsed.root !== ref.root || parsed.head !== ref.head) {
            return { status: "mismatch", detail: `${ref.source}#${ref.epoch} root/head differ` }
          }
          return { status: "ok", anchoredAt: parsed.ts }
        }
      }
      return { status: "missing", detail: `${ref.source}#${ref.epoch} not anchored` }
    },
  }
}

/**
 * Builds the builtin `commit-trailer` sink mirror. Must stay identical to
 * `commitTrailerSink` in src/anchor.ts.
 * @param {{ projectDir: string }} options The anchor options.
 * @returns {object} The sink.
 */
export function commitTrailerSink(options) {
  return {
    id: "commit-trailer",
    trustDomain: "repo",
    publish() {},
    verify(ref) {
      let bodies
      try {
        bodies = execOut("git", ["log", "--format=%B", "-n", "50"], { cwd: options.projectDir })
      } catch (e) {
        return { status: "missing", detail: `git log failed: ${String(e)}` }
      }
      const prefix = `Turnstile-Anchor: source=${ref.source} epoch=${ref.epoch} `
      for (const line of bodies.split("\n")) {
        const trimmed = line.trim()
        if (!trimmed.startsWith(prefix)) continue
        const fields = new URLSearchParams(trimmed.slice(prefix.length).replace(/ /g, "&"))
        if (fields.get("root") !== ref.root || fields.get("head") !== ref.head) {
          return { status: "mismatch", detail: `${ref.source}#${ref.epoch} root/head differ` }
        }
        return { status: "ok", anchoredAt: ref.ts }
      }
      return { status: "missing", detail: `${ref.source}#${ref.epoch} trailer not found` }
    },
  }
}

/**
 * Shape-checks a candidate sink. Must stay identical to `isAnchorSink` in
 * src/anchor.ts.
 * @param {unknown} value The candidate value.
 * @returns {boolean} True when the value is a well-formed sink.
 */
function isSink(value) {
  if (value === null || typeof value !== "object") return false
  const s = value
  return (
    typeof s.id === "string" &&
    (s.trustDomain === "host" || s.trustDomain === "repo" || s.trustDomain === "external") &&
    typeof s.publish === "function" &&
    typeof s.verify === "function"
  )
}

/**
 * Resolves one selection element to a sink, or a warning on failure. Must
 * stay identical to `resolveSinkElement` in src/anchor.ts (plugin sinks are
 * lazy-imported — the CLI is a separate process and may).
 * @param {string | { plugin: string, options?: Record<string, unknown> }} element
 *     The selection element.
 * @param {{ metricsDir: string, projectDir: string }} options The anchor options.
 * @param {string[]} warnings The warning list to append to.
 * @returns {Promise<object | undefined>} The sink, or undefined when malformed.
 */
async function resolveSinkElement(element, options, warnings) {
  if (typeof element === "string") {
    if (element === "session-state") return sessionStateSink(options)
    if (element === "git-note") return gitNoteSink(options)
    if (element === "commit-trailer") return commitTrailerSink(options)
    warnings.push(`anchor-sink: unknown builtin sink "${element}"`)
    return undefined
  }
  let mod
  try {
    mod = await import(element.plugin)
  } catch (e) {
    warnings.push(`anchor-sink: plugin "${element.plugin}" failed to import: ${String(e)}`)
    return undefined
  }
  const factory = mod?.default
  if (typeof factory !== "function") {
    warnings.push(`anchor-sink: plugin "${element.plugin}" default export is not a function`)
    return undefined
  }
  let sink
  try {
    sink = factory({ config: element.options ?? {} })
  } catch (e) {
    warnings.push(`anchor-sink: plugin "${element.plugin}" factory threw: ${String(e)}`)
    return undefined
  }
  if (!isSink(sink)) {
    warnings.push(`anchor-sink: plugin "${element.plugin}" factory returned a malformed sink`)
    return undefined
  }
  return sink
}

/**
 * Resolves the configured anchor selection into sinks. Must stay identical
 * to `resolveAnchorSinks` in src/anchor.ts.
 * @param {string | object | Array<string | object>} anchor The selection.
 * @param {{ metricsDir: string, projectDir: string }} options The anchor options.
 * @returns {Promise<{ sinks: object[], warnings: string[] }>} The sinks and warnings.
 */
export async function resolveAnchorSinks(anchor, options) {
  const warnings = []
  const elements = Array.isArray(anchor) ? anchor : [anchor]
  const sinks = []
  for (const element of elements) {
    const sink = await resolveSinkElement(element, options, warnings)
    if (sink) sinks.push(sink)
  }
  return { sinks, warnings }
}

/** Trust-domain strength order: external (strongest) > repo > host. */
const DOMAIN_STRENGTH = { host: 0, repo: 1, external: 2 }

/**
 * Resolves the weakest trust domain among the sinks whose verdict for the
 * ref is `ok`; null when unanchored. Must stay identical to
 * `weakestTrustDomain` in src/anchor.ts.
 * @param {Array<{ ref: object, sink: string, verdict: object }>} verdicts
 *     The per-sink verdicts.
 * @param {Map<string, string>} domains The sink-id → trust-domain map.
 * @param {object} ref The ref to report on.
 * @returns {string | null} The weakest vouching domain, or null.
 */
export function weakestTrustDomain(verdicts, domains, ref) {
  const vouched = verdicts
    .filter(
      (v) => v.ref.source === ref.source && v.ref.epoch === ref.epoch && v.verdict.status === "ok",
    )
    .map((v) => domains.get(v.sink))
    .filter((d) => d !== undefined)
  if (vouched.length === 0) return null
  return vouched.reduce((a, b) => (DOMAIN_STRENGTH[a] <= DOMAIN_STRENGTH[b] ? a : b))
}

/**
 * Verifies refs across the sinks. Must stay identical to `verifyAnchors`
 * in src/anchor.ts.
 * @param {object[]} sinks The sinks to verify against.
 * @param {object[]} refs The refs to verify.
 * @returns {Promise<{ verdicts: object[], weakest: object[] }>} The verdicts.
 */
export async function verifyAnchors(sinks, refs) {
  const verdicts = []
  const settled = await Promise.allSettled(
    refs.flatMap((ref) =>
      sinks.map(async (sink) => {
        try {
          const verdict = await sink.verify(ref)
          return { ref, sink: sink.id, verdict }
        } catch (e) {
          // A throwing sink is a broken verifier, not a missing anchor:
          // record it as an error verdict so reports distinguish it from
          // "not anchored".
          return {
            ref,
            sink: sink.id,
            verdict: {
              status: "mismatch",
              detail: `sink ${sink.id} verify failed: ${String(e)}`,
            },
          }
        }
      }),
    ),
  )
  for (const result of settled) {
    if (result.status === "fulfilled") verdicts.push(result.value)
  }
  const domains = new Map(sinks.map((s) => [s.id, s.trustDomain]))
  const weakest = refs.map((ref) => ({ ref, domain: weakestTrustDomain(verdicts, domains, ref) }))
  return { verdicts, weakest }
}
