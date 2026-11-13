/**
 * @fileoverview Tests for the `turnstile prov --verify` surface
 * (scripts/prov.mjs), driven by spawning the script the same way
 * bin/cli.mjs does. Journals are seeded through the real src/ chain
 * helpers (recordHash/merkleRoot), so the test cross-checks the CLI-side
 * fold mirror in scripts/chain-read.mjs against the src/ logic:
 *
 *  - an intact chained journal with a matching anchors.jsonl exits 0 and
 *    reports the row/epoch counts and the weakest vouching domain;
 *  - a tampered row exits 1 with the first broken link;
 *  - an intact chain with unanchored epoch refs exits 1;
 *  - a journal truncated within retained history with a stale anchored
 *    epoch exits 1 with the absent-epoch detail;
 *  - an anchored epoch whose root matches no retained ref exits 1 with
 *    the root-mismatch detail;
 *  - an empty metrics directory exits 0 (vacuously ok);
 *  - usage errors (unknown flag) exit 2.
 *
 * All fixtures live in a temp dir under the OS temp dir, never the real
 * metrics directory, and the script is read-only.
 */

import { test } from "node:test"
import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

import { merkleRoot, recordHash } from "../src/chain.ts"

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..")
const provScript = join(repoRoot, "scripts", "prov.mjs")

/** A journaled entry; fields are deliberately loose (typed `any`). */
type Entry = Record<string, any>

/** Creates a fresh temp metrics dir, returned so the test can remove it. */
function metricsDir(): string {
  return mkdtempSync(join(tmpdir(), "turnstile-prov-verify-test-"))
}

/**
 * Runs prov.mjs against a temp metrics dir.
 * @param dir The temp metrics directory.
 * @param args Arguments after the subcommand.
 * @returns The spawn result with stdout coerced to string.
 */
function runProv(dir: string, args: string[] = []) {
  return spawnSync(process.execPath, [provScript, ...args], {
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
 * Seeds a chained shared journal: one data row plus a `chain-epoch`
 * commit per requested epoch, all hashed through the real src/
 * recordHash.
 * @param dir The temp metrics directory.
 * @param counts The number of data rows before each epoch commit.
 * @returns The epoch refs the commits carry (root/head), in epoch order.
 */
function seedChainedEpochs(
  dir: string,
  counts: number[],
): { root: string; head: string; epoch: number }[] {
  mkdirSync(dir, { recursive: true })
  const file = join(dir, "turnstile.jsonl")
  const lines: string[] = []
  let prevHash = ""
  let seq = 0
  const append = (payload: Entry): string => {
    const ts = "2026-01-01T10:00:00.000Z"
    const full = { ts, ...payload }
    const hash = recordHash(prevHash, ts, full)
    lines.push(JSON.stringify({ ...full, seq, prevHash, hash }))
    prevHash = hash
    seq++
    return hash
  }
  const refs: { root: string; head: string; epoch: number }[] = []
  for (let epoch = 0; epoch < counts.length; epoch++) {
    const hashes: string[] = []
    for (let i = 0; i < counts[epoch]!; i++) {
      hashes.push(append({ type: "gate", sessionID: "ses1", result: "PASS", tests: i }))
    }
    const root = merkleRoot(hashes)
    const head = prevHash
    append({ type: "chain-epoch", source: "shared", epoch, count: counts[epoch], root, head })
    refs.push({ root, head, epoch })
  }
  writeFileSync(file, lines.join("\n") + "\n")
  return refs
}

/**
 * Seeds a chained shared journal with a single epoch.
 * @param dir The temp metrics directory.
 * @param count The number of data rows before the epoch commit.
 * @returns The epoch ref the commit carries (root/head).
 */
function seedChainedJournal(
  dir: string,
  count: number,
): { root: string; head: string; epoch: number } {
  return seedChainedEpochs(dir, [count])[0]!
}

/**
 * Appends one session-state anchor line to the anchors file.
 * @param dir The temp metrics directory.
 * @param ref The epoch ref to anchor (root/head plus its epoch).
 */
function appendAnchor(dir: string, ref: { root: string; head: string; epoch: number }): void {
  const file = join(dir, "anchors.jsonl")
  const lines = existsSync(file) ? readLines(file) : []
  lines.push(
    JSON.stringify({
      sink: "session-state",
      source: "shared",
      epoch: ref.epoch,
      root: ref.root,
      head: ref.head,
      ts: "2026-01-01T10:00:01.000Z",
    }),
  )
  writeFileSync(file, lines.join("\n") + "\n")
}

/**
 * Writes the session-state anchors file with one ref.
 * @param dir The temp metrics directory.
 * @param ref The epoch ref to anchor (root/head plus its epoch).
 */
function seedAnchors(dir: string, ref: { root: string; head: string; epoch: number }): void {
  writeFileSync(join(dir, "anchors.jsonl"), "")
  appendAnchor(dir, ref)
}

test("prov --verify exits 0 on an intact anchored chain", () => {
  const dir = metricsDir()
  try {
    const ref = seedChainedJournal(dir, 1)
    seedAnchors(dir, ref)
    const r = runProv(dir, ["--verify"])
    assert.equal(code(r), 0, `stderr: ${r.stderr}`)
    assert.match(r.stdout, /chain ok \(2 rows, 1 epochs\) · anchored by host \[session-state\]/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("prov --verify exits 1 with the first broken link on a tampered journal", () => {
  const dir = metricsDir()
  try {
    seedChainedJournal(dir, 2)
    const file = join(dir, "turnstile.jsonl")
    const lines = readLines(file)
    const first = JSON.parse(lines[0]!) as Entry
    lines[0] = JSON.stringify({ ...first, type: "edited" })
    writeFileSync(file, lines.join("\n") + "\n")
    const r = runProv(dir, ["--verify"])
    assert.equal(code(r), 1)
    assert.match(r.stdout, /chain broken at shared:1: hash mismatch/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("prov --verify exits 1 when epoch refs are unanchored", () => {
  const dir = metricsDir()
  try {
    seedChainedJournal(dir, 1)
    const r = runProv(dir, ["--verify"])
    assert.equal(code(r), 1)
    assert.match(r.stdout, /unanchored: shared#0: shared#0 not anchored/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("prov --verify exits 1 when an anchored epoch is absent from the journal", () => {
  const dir = metricsDir()
  try {
    const refs = seedChainedEpochs(dir, [1, 1])
    seedAnchors(dir, refs[0]!)
    appendAnchor(dir, refs[1]!)
    // Hand-truncate within retained history: drop epoch 1's rows. The
    // retained fold still vouches for epoch 0, so the chain is ok and the
    // stale anchored epoch is reported as absent instead.
    const file = join(dir, "turnstile.jsonl")
    writeFileSync(file, readLines(file).slice(0, 2).join("\n") + "\n")
    const r = runProv(dir, ["--verify"])
    assert.equal(code(r), 1)
    assert.match(r.stdout, /^anchored epoch shared#1 absent from journal$/m)
    assert.doesNotMatch(r.stdout, /chain broken|unanchored:/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("prov --verify exits 1 when an anchored epoch root matches no retained ref", () => {
  const dir = metricsDir()
  try {
    const refs = seedChainedEpochs(dir, [1])
    seedAnchors(dir, refs[0]!)
    // A second, re-forged anchor line for the same epoch: the sink verifies
    // against the first matching line (ok), while the absent-anchored scan
    // sees the forged root matching no retained ref.
    appendAnchor(dir, { root: "forged-root", head: refs[0]!.head, epoch: 0 })
    const r = runProv(dir, ["--verify"])
    assert.equal(code(r), 1)
    assert.match(r.stdout, /^anchored epoch shared#0 root mismatch \(reforged commit\?\)$/m)
    assert.doesNotMatch(r.stdout, /chain broken|unanchored:/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("prov --verify exits 0 vacuously on an empty metrics directory", () => {
  const dir = metricsDir()
  try {
    const r = runProv(dir, ["--verify"])
    assert.equal(code(r), 0)
    assert.match(r.stdout, /chain ok \(0 rows, 0 epochs\) · nothing to anchor/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("prov --verify rejects unknown flags with exit 2", () => {
  const dir = metricsDir()
  try {
    const r = runProv(dir, ["--verify", "--wat"])
    assert.equal(code(r), 2)
    assert.match(r.stderr, /unknown argument "--wat"/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("prov --verify rejects a sessionID combination with exit 2", () => {
  const dir = metricsDir()
  try {
    const r = runProv(dir, ["ses1", "--verify"])
    assert.equal(code(r), 2)
    assert.match(r.stderr, /--verify checks every session/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

/**
 * Reads a file into non-empty lines.
 * @param file The file path.
 * @returns The lines.
 */
function readLines(file: string): string[] {
  return readFileSync(file, "utf8").split("\n").filter(Boolean)
}
