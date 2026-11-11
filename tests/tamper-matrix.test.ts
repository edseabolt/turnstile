/**
 * @fileoverview Differential characterization harness for the journal
 * tamper-evidence mechanism. An honest journal is built through the real
 * write path (`createJournaler` with tamper evidence on, real rotation
 * generations, a real task-completion anchor), each characterized mutation
 * of that journal is applied, and the observed `prov --verify` verdict must
 * equal the characterized verdict — so a detector regression (false
 * negative or false positive) fails loudly. Also covers the anchor-sink
 * surface: git-note and commit-trailer at the interface level against real
 * throwaway git repos, and a negative-control plugin sink that
 * participates in (and can fail) verification.
 *
 * All fixtures live in temp dirs under the OS temp dir; the spawned CLI is
 * read-only.
 */

import { test } from "node:test"
import assert from "node:assert/strict"
import { spawnSync, execFileSync } from "node:child_process"
import type { StdioOptions } from "node:child_process"
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

import { merkleRoot, recordHash } from "../src/chain.ts"
import { createJournaler } from "../src/journal.ts"
import {
  commitTrailerSink,
  gitNoteSink,
  publishRefs,
  resolveAnchorSinks,
  sessionStateSink,
  verifyAnchors,
} from "../src/anchor.ts"
import type { AnchorRef } from "../src/types.ts"
import { verifyJournalChain } from "../src/verify.ts"

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..")
const provScript = join(repoRoot, "scripts", "prov.mjs")

/** One raw journal row (chain fields inline; deliberately loose). */
type RowObj = Record<string, any>

/** One rotation-generation file of the shared family with its rows. */
interface FamilyFile {
  /** Absolute file path. */
  path: string
  /** The file's parsed rows, oldest-first. */
  rows: RowObj[]
}

/** One characterization row: a mutation and the verdict it must produce. */
interface Row {
  /** Row number in the published table. */
  id: number
  /** Human-readable mutation name. */
  name: string
  /** Applies the mutation to the metrics dir in place. */
  mutate: (dir: string) => void | Promise<void>
  /** The characterized `prov --verify` verdict. */
  expect: { exit: 0 | 1; match: RegExp }
}

/**
 * Runs `prov --verify` against a temp metrics dir.
 * @param dir The metrics directory to verify.
 * @returns The spawn result with stdout coerced to string.
 */
function runProvVerify(dir: string) {
  return spawnSync(process.execPath, [provScript, "--verify"], {
    env: { ...process.env, TURNSTILE_METRICS_DIR: dir },
    encoding: "utf8",
  })
}

/**
 * Normalizes the spawn exit code across Node builds.
 * @param res The spawnSync result.
 * @returns The numeric exit code, or -1 when the process did not exit cleanly.
 */
function code(res: { status: number | null; exitCode?: number | null }): number {
  return res.status ?? res.exitCode ?? -1
}

/**
 * Builds the honest journal every row starts from: ten chained gate rows
 * through the real journaler (rotation on every append via `maxBytes: 1` +
 * `rotateEveryEntries: 1`, an epoch commit every 4 data rows), then a real
 * task-completion anchor that closes the partial epoch and publishes the
 * refs to the session-state store.
 * @returns The temp metrics directory (caller removes it).
 */
async function buildHonestJournal(): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), "turnstile-tamper-matrix-"))
  const journaler = createJournaler({
    metricsDir: dir,
    trace: false,
    maxBytes: 1,
    maxGenerations: 5,
    rotateEveryEntries: 1,
    tamper: { enabled: true, epochEntries: 4 },
  })
  journaler.bindAnchorSinks([sessionStateSink({ metricsDir: dir, projectDir: dir })])
  for (let i = 0; i < 10; i++) {
    journaler.journal({ type: "gate", sessionID: "p1", result: "PASS", i })
  }
  await journaler.anchorAsync("task-complete")
  return dir
}

/**
 * Lists the shared family's files oldest-first (numbered generations that
 * exist, then the current file).
 * @param dir The metrics directory.
 * @returns The existing file paths, oldest-first.
 */
function familyPaths(dir: string): string[] {
  const file = join(dir, "turnstile.jsonl")
  const paths: string[] = []
  for (let gen = 5; gen >= 1; gen--) {
    if (existsSync(`${file}.${gen}`)) paths.push(`${file}.${gen}`)
  }
  if (existsSync(file)) paths.push(file)
  return paths
}

/**
 * Reads the shared family into per-file row lists, oldest-first.
 * @param dir The metrics directory.
 * @returns The family files with their parsed rows.
 */
function readFamily(dir: string): FamilyFile[] {
  return familyPaths(dir).map((path) => ({
    path,
    rows: readFileSync(path, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as RowObj),
  }))
}

/**
 * Writes the family files back, one JSON row per line.
 * @param files The family files to write.
 */
function writeFamily(files: FamilyFile[]): void {
  for (const f of files) {
    writeFileSync(f.path, f.rows.map((r) => JSON.stringify(r)).join("\n") + "\n")
  }
}

/**
 * Applies a mutation to the family's flattened rows (oldest-first across
 * all generations) and writes them back. Per-file row counts are preserved
 * except in the last file, which absorbs growth or shrinkage — the fold
 * only cares about global row order, never the file boundaries.
 * @param dir The metrics directory.
 * @param mutate The in-place mutation over the flattened rows.
 */
function mutateFamily(dir: string, mutate: (rows: RowObj[]) => void): void {
  const files = readFamily(dir)
  const rows = files.flatMap((f) => f.rows)
  mutate(rows)
  let i = 0
  files.forEach((f, fi) => {
    f.rows = fi === files.length - 1 ? rows.slice(i) : rows.slice(i, i + f.rows.length)
    i += f.rows.length
  })
  writeFamily(files)
}

/**
 * Flips one interior data row's payload without re-hashing: the row's own
 * hash no longer matches its payload.
 * @param dir The metrics directory.
 */
function editRowPayload(dir: string): void {
  mutateFamily(dir, (rows) => {
    rows[1]!.type = "edited"
  })
}

/**
 * Deletes one interior row: the following row's prevHash then points at a
 * row that no longer exists.
 * @param dir The metrics directory.
 */
function deleteRow(dir: string): void {
  mutateFamily(dir, (rows) => {
    rows.splice(1, 1)
  })
}

/**
 * Inserts a fabricated row that claims the original's place in the chain
 * (continuous seq and prevHash) but carries a modified payload, so its
 * declared hash cannot match.
 * @param dir The metrics directory.
 */
function insertFabricatedRow(dir: string): void {
  mutateFamily(dir, (rows) => {
    const orig = rows[1]!
    rows.splice(2, 0, { ...orig, type: "fabricated", seq: orig.seq + 1, prevHash: orig.hash })
  })
}

/**
 * Swaps two adjacent rows: the moved rows' prevHash/seq no longer line up
 * with the running chain state.
 * @param dir The metrics directory.
 */
function reorderRows(dir: string): void {
  mutateFamily(dir, (rows) => {
    const tmp = rows[1]!
    rows[1] = rows[2]!
    rows[2] = tmp
  })
}

/**
 * Forks the chain at an interior row: a verbatim duplicate (same seq and
 * prevHash) with a modified payload is inserted directly after the
 * original, so two rows claim the same chain position.
 * @param dir The metrics directory.
 */
function forkInteriorRow(dir: string): void {
  mutateFamily(dir, (rows) => {
    const orig = rows[1]!
    rows.splice(2, 0, { ...orig, type: "forked" })
  })
}

/**
 * Rewrites the whole surviving journal with one payload field changed and
 * the full chain honestly recomputed — per-record hashes, seq/prevHash
 * continuity, and every epoch commit's root/head. The chain folds clean;
 * only the anchor comparison can see the forgery.
 * @param dir The metrics directory.
 */
function reforgeAll(dir: string): void {
  mutateFamily(dir, (rows) => {
    rows[0]!.type = "edited"
    let prevHash = ""
    let seq = 0
    const window: string[] = []
    for (const row of rows) {
      if (row.type === "chain-epoch") {
        row.root = merkleRoot(window)
        row.head = window[window.length - 1] ?? ""
        window.length = 0
      }
      const { seq: _s, prevHash: _p, hash: _h, ...payload } = row
      const hash = recordHash(prevHash, row.ts, payload)
      if (row.type !== "chain-epoch") window.push(hash)
      row.seq = seq
      row.prevHash = prevHash
      row.hash = hash
      prevHash = hash
      seq++
    }
  })
}

/**
 * Appends two honest chained rows after the anchor (a second journaler on
 * the same dir, continuing the chain from disk) — the un-anchored tail the
 * row-7 mutation then edits.
 * @param dir The metrics directory.
 */
async function appendTailRows(dir: string): Promise<void> {
  const journaler = createJournaler({
    metricsDir: dir,
    trace: false,
    maxBytes: 1,
    maxGenerations: 5,
    rotateEveryEntries: 1,
    tamper: { enabled: true, epochEntries: 4 },
  })
  journaler.journal({ type: "gate", sessionID: "p1", result: "PASS", i: 10 })
  journaler.journal({ type: "gate", sessionID: "p1", result: "PASS", i: 11 })
}

/**
 * Edits a row inside the un-anchored tail and re-hashes the tail honestly.
 * The whole file folds clean and no anchored ref is affected — the
 * documented residual hole, bounded by the anchor cadence (epochEntries: 4
 * in the builder + the task-completion anchor closing the partial epoch):
 * anything written after the last anchor is unverifiable until the next
 * one, so if the cadence or anchoring trigger changes, this row's
 * expectation changes too.
 * @param dir The metrics directory.
 */
async function editUnanchoredTail(dir: string): Promise<void> {
  await appendTailRows(dir)
  mutateFamily(dir, (rows) => {
    const idx = rows.length - 2
    rows[idx]!.type = "edited"
    let prevHash = rows[idx]!.prevHash as string
    for (let k = idx; k < rows.length; k++) {
      const { seq: _s, prevHash: _p, hash: _h, ...payload } = rows[k]!
      const hash = recordHash(prevHash, rows[k]!.ts, payload)
      rows[k]!.prevHash = prevHash
      rows[k]!.hash = hash
      prevHash = hash
    }
  })
}

/**
 * Hand-builds the fresh genesis a truncate-and-continue attacker writes:
 * two honest data rows plus a chain-epoch commit for epoch 0, continuous
 * seq from 0, prevHash "" at the start, all hashed through the real chain
 * helpers with the rows' own timestamps.
 * @returns The JSONL lines of the fresh genesis.
 */
function buildGenesisLines(): string[] {
  const lines: string[] = []
  let prevHash = ""
  let seq = 0
  const hashes: string[] = []
  for (const i of [0, 1]) {
    const ts = "2026-01-01T10:00:00.000Z"
    const payload = { ts, type: "gate", sessionID: "p1", result: "PASS", i }
    const hash = recordHash(prevHash, ts, payload)
    lines.push(JSON.stringify({ ...payload, seq, prevHash, hash }))
    hashes.push(hash)
    prevHash = hash
    seq++
  }
  const ts = "2026-01-01T10:00:01.000Z"
  const epochPayload = {
    ts,
    type: "chain-epoch",
    source: "shared",
    epoch: 0,
    count: 2,
    root: merkleRoot(hashes),
    head: prevHash,
  }
  const epochHash = recordHash(prevHash, ts, epochPayload)
  lines.push(JSON.stringify({ ...epochPayload, seq, prevHash, hash: epochHash }))
  return lines
}

/**
 * Truncates the journal completely — the current file and every rotation
 * generation — then continues logging into a fresh chain: a hand-built
 * genesis, then a second real journaler on the same dir that journals a
 * new data row and re-anchors the fresh epoch 1. The surviving file folds
 * clean from the new genesis; the previously published roots no longer
 * derive from it, and the retained anchor store's stale refs shadow the
 * fresh epochs at the same indices.
 * @param dir The metrics directory.
 */
async function truncateAndContinue(dir: string): Promise<void> {
  const file = join(dir, "turnstile.jsonl")
  for (let gen = 1; gen <= 5; gen++) rmSync(`${file}.${gen}`, { force: true })
  rmSync(file, { force: true })
  const genesis = buildGenesisLines()
  writeFileSync(file, genesis.join("\n") + "\n")
  const journaler = createJournaler({
    metricsDir: dir,
    trace: false,
    maxBytes: 1,
    maxGenerations: 5,
    rotateEveryEntries: 1,
    tamper: { enabled: true, epochEntries: 4 },
  })
  journaler.bindAnchorSinks([sessionStateSink({ metricsDir: dir, projectDir: dir })])
  journaler.journal({ type: "gate", sessionID: "p1", result: "PASS", i: 100 })
  await journaler.anchorAsync("task-complete")
}

/** The characterization table: every mutation of a captured honest journal
 *  and the `prov --verify` verdict it must produce. */
const ROWS: Row[] = [
  { id: 0, name: "none (control)", mutate: () => {}, expect: { exit: 0, match: /chain ok \(/ } },
  {
    id: 1,
    name: "edit one row's payload",
    mutate: editRowPayload,
    expect: { exit: 1, match: /chain broken at shared:\d+: hash mismatch/ },
  },
  {
    id: 2,
    name: "delete a row",
    mutate: deleteRow,
    expect: { exit: 1, match: /chain broken at shared:\d+: (prevHash|seq) mismatch/ },
  },
  {
    id: 3,
    name: "insert a fabricated row",
    mutate: insertFabricatedRow,
    expect: { exit: 1, match: /chain broken at shared:\d+: (prevHash|hash) mismatch/ },
  },
  {
    id: 4,
    name: "reorder rows",
    mutate: reorderRows,
    expect: { exit: 1, match: /chain broken at shared:\d+: (prevHash|seq|hash) mismatch/ },
  },
  {
    id: 5,
    name: "fork (branch from an interior row)",
    mutate: forkInteriorRow,
    expect: { exit: 1, match: /chain broken at shared:\d+: (hash|prevHash) mismatch/ },
  },
  {
    id: 6,
    name: "rewrite-all with recomputed chain",
    mutate: reforgeAll,
    expect: { exit: 1, match: /root mismatch \(reforged commit\?\)|root\/head differ/ },
  },
  // Row 7 is the documented residual hole: edits confined to the un-anchored
  // tail, honestly re-hashed, are invisible until the next anchor. Bound to
  // the cadence: epochEntries: 4 in the builder + the task-completion anchor
  // closing the partial epoch; if the cadence or anchoring trigger changes,
  // this row's comment and expectation change too.
  {
    id: 7,
    name: "edit rows within the un-anchored tail",
    mutate: editUnanchoredTail,
    expect: { exit: 0, match: /chain ok \(/ },
  },
  {
    id: 8,
    name: "truncate-and-continue (recurring-cleaner)",
    mutate: truncateAndContinue,
    expect: { exit: 1, match: /unanchored: shared#0: .*root\/head differ/ },
  },
]

for (const row of ROWS) {
  test(`tamper matrix row ${row.id}: ${row.name}`, async () => {
    const dir = await buildHonestJournal()
    try {
      await row.mutate(dir)
      const r = runProvVerify(dir)
      assert.equal(code(r), row.expect.exit, r.stdout)
      assert.match(r.stdout, row.expect.match)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
}

test("tamper matrix row 0: the honest journal spans rotation generations and multiple epochs", async () => {
  const dir = await buildHonestJournal()
  try {
    assert.ok(existsSync(join(dir, "turnstile.jsonl.1")), "a rotation generation exists")
    const report = await verifyJournalChain({
      metricsDir: dir,
      sinks: [sessionStateSink({ metricsDir: dir, projectDir: dir })],
    })
    assert.equal(report.ok, true)
    assert.ok(report.refs.length >= 2, "at least two committed epochs")
    const r = runProvVerify(dir)
    assert.equal(code(r), 0, r.stdout)
    assert.match(r.stdout, /anchored by host \[session-state\]/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("tamper matrix row 6: the reforged chain folds ok and fails only via the anchor check", async () => {
  const dir = await buildHonestJournal()
  try {
    reforgeAll(dir)
    const report = await verifyJournalChain({
      metricsDir: dir,
      sinks: [sessionStateSink({ metricsDir: dir, projectDir: dir })],
    })
    assert.ok(
      report.families.every((f) => f.verdict.status === "ok"),
      "every family folds ok after the reforge",
    )
    assert.equal(report.ok, false, "the anchor check still fails the report")
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("tamper matrix row 8: the fresh chain folds clean and re-anchors without masking the failure", async () => {
  const dir = await buildHonestJournal()
  try {
    await truncateAndContinue(dir)
    const report = await verifyJournalChain({
      metricsDir: dir,
      sinks: [sessionStateSink({ metricsDir: dir, projectDir: dir })],
    })
    assert.ok(
      report.families.every((f) => f.verdict.status === "ok"),
      "the post-truncation chain folds clean",
    )
    const anchors = readFileSync(join(dir, "anchors.jsonl"), "utf8").split("\n").filter(Boolean)
    assert.equal(anchors.length, 4, "the original three refs plus the fresh epoch-1 ref")
    // All three previously anchored epochs (0, 1, 2) are positively flagged:
    // the fresh chain retains epochs 0 and 1 with different roots (root
    // mismatch) and no epoch 2 at all (absent from journal).
    assert.equal(report.absentAnchored.length, 3)
    assert.equal(report.ok, false)
    const r = runProvVerify(dir)
    assert.equal(code(r), 1, r.stdout)
    // The retained store's stale shared#0/shared#1 refs shadow the fresh
    // epochs at the same indices, so the CLI reports the anchor mismatch.
    assert.match(r.stdout, /unanchored: shared#0: .*root\/head differ/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

/** The git env that isolates the sink tests from the developer's global and
 *  system git config.
 *  @returns The hermetic env map. */
function hermeticGitEnv(): Record<string, string> {
  return { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" }
}

/**
 * The execution seam the git-backed sinks run under in this file: real
 * execFileSync with the hermetic git env, so no user git config leaks in.
 * @param command The command to run.
 * @param args The argv array.
 * @param options Optional child options (cwd, timeout, stdio).
 * @returns The command's stdout as a string.
 */
function hermeticExec(
  command: string,
  args: ReadonlyArray<string>,
  options?: { cwd?: string; timeout?: number; stdio?: StdioOptions },
): string {
  return String(execFileSync(command, args, { ...options, env: hermeticGitEnv() }))
}

/**
 * Creates a throwaway git repo with one commit, configured hermetically
 * (repo-local identity, global/system config pointed at /dev/null).
 * @returns The repo directory (caller removes it).
 */
function initHermeticRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "turnstile-tamper-git-"))
  const run = (args: string[]): void => {
    execFileSync("git", args, { cwd: dir, env: hermeticGitEnv() })
  }
  run(["init", "-q"])
  run(["config", "user.email", "t@t"])
  run(["config", "user.name", "t"])
  writeFileSync(join(dir, "f.txt"), "x")
  run(["add", "f.txt"])
  run(["commit", "-q", "-m", "init"])
  return dir
}

/**
 * Builds a test anchor ref.
 * @param overrides Field overrides.
 * @returns The ref.
 */
function testRef(overrides: Partial<AnchorRef> = {}): AnchorRef {
  return {
    sink: "",
    source: "shared",
    epoch: 0,
    root: "root-0",
    head: "head-0",
    ts: "2026-01-01T00:00:00.000Z",
    ...overrides,
  }
}

/**
 * Removes a temp dir and a repo dir, ignoring absence.
 * @param dirs The directories to remove.
 */
function cleanup(...dirs: string[]): void {
  for (const d of dirs) rmSync(d, { recursive: true, force: true })
}

test("git-note sink publishes a real note and verifies ok, then mismatch on a foreign head", async () => {
  const metricsDir = mkdtempSync(join(tmpdir(), "turnstile-tamper-metrics-"))
  const projectDir = initHermeticRepo()
  try {
    const sink = gitNoteSink({ metricsDir, projectDir }, hermeticExec)
    sink.publish(testRef())
    const notes = execFileSync("git", ["notes", "--ref=refs/notes/turnstile", "list"], {
      cwd: projectDir,
      env: hermeticGitEnv(),
    }).toString()
    assert.match(notes, /\S/, "the note exists in refs/notes/turnstile")
    assert.deepEqual(await sink.verify(testRef()), { status: "ok", anchoredAt: testRef().ts })
    assert.equal((await sink.verify(testRef({ head: "f".repeat(64) }))).status, "mismatch")
  } finally {
    cleanup(metricsDir, projectDir)
  }
})

test("commit-trailer sink: missing before the trailer, ok after, mismatch on a foreign head", async () => {
  const metricsDir = mkdtempSync(join(tmpdir(), "turnstile-tamper-metrics-"))
  const projectDir = initHermeticRepo()
  try {
    const sink = commitTrailerSink({ metricsDir, projectDir }, hermeticExec)
    sink.publish(testRef())
    assert.equal((await sink.verify(testRef())).status, "missing")
    const trailer = "Turnstile-Anchor: source=shared epoch=0 root=root-0 head=head-0"
    execFileSync("git", ["commit", "-q", "--allow-empty", "-m", `landing\n\n${trailer}`], {
      cwd: projectDir,
      env: hermeticGitEnv(),
    })
    assert.deepEqual(await sink.verify(testRef()), { status: "ok", anchoredAt: testRef().ts })
    assert.equal((await sink.verify(testRef({ head: "f".repeat(64) }))).status, "mismatch")
  } finally {
    cleanup(metricsDir, projectDir)
  }
})

test("a plugin anchor sink participates in verification and can fail it", async () => {
  const dir = await buildHonestJournal()
  try {
    // The negative control: a registered external sink whose verify rejects
    // any head it did not publish itself.
    const mod = join(dir, "negative-control-sink.mjs")
    writeFileSync(
      mod,
      `export default () => {
  const published = new Map()
  return {
    id: "negative-control",
    trustDomain: "external",
    publish(ref) { published.set(ref.source + "#" + ref.epoch, ref) },
    verify(ref) {
      const hit = published.get(ref.source + "#" + ref.epoch)
      if (!hit || hit.head !== ref.head) {
        return { status: "mismatch", detail: "head not published by this sink" }
      }
      return { status: "ok", anchoredAt: ref.ts }
    },
  }
}\n`,
    )
    const { sinks, warnings } = await resolveAnchorSinks(
      [{ plugin: pathToFileURL(mod).href, options: {} }],
      { metricsDir: dir, projectDir: dir },
    )
    assert.deepEqual(warnings, [])
    assert.equal(sinks.length, 1)
    const sink = sinks[0]!
    // Before the plugin publishes anything, its mismatch verdict fails the
    // full verify — the extension point participates in verification.
    const before = await verifyJournalChain({ metricsDir: dir, sinks: [sink] })
    assert.equal(before.ok, false)
    const errors = await publishRefs([sink], before.refs)
    assert.deepEqual(errors, [])
    const after = await verifyJournalChain({ metricsDir: dir, sinks: [sink] })
    assert.equal(after.ok, true, "the plugin vouches for the refs it published")
    const { weakest } = await verifyAnchors([sink], [{ ...before.refs[0]!, head: "f".repeat(64) }])
    assert.equal(weakest[0]!.domain, null, "a mismatched head is unanchored")
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
