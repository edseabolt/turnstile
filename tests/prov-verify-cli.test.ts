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
 *  - an empty metrics directory exits 0 (vacuously ok);
 *  - usage errors (unknown flag) exit 2.
 *
 * All fixtures live in a temp dir under the OS temp dir, never the real
 * metrics directory, and the script is read-only.
 */

import { test } from "node:test"
import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
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
 * Seeds a chained shared journal: `count` data rows followed by a
 * `chain-epoch` commit, all hashed through the real src/ recordHash.
 * @param dir The temp metrics directory.
 * @param count The number of data rows before the epoch commit.
 * @returns The epoch ref the commit carries (root/head).
 */
function seedChainedJournal(dir: string, count: number): { root: string; head: string } {
  mkdirSync(dir, { recursive: true })
  const file = join(dir, "turnstile.jsonl")
  const lines: string[] = []
  let prevHash = ""
  let seq = 0
  const hashes: string[] = []
  const append = (payload: Entry): string => {
    const ts = "2026-01-01T10:00:00.000Z"
    const full = { ts, ...payload }
    const hash = recordHash(prevHash, ts, full)
    lines.push(JSON.stringify({ ...full, seq, prevHash, hash }))
    prevHash = hash
    seq++
    return hash
  }
  for (let i = 0; i < count; i++) {
    hashes.push(append({ type: "gate", sessionID: "ses1", result: "PASS", tests: i }))
  }
  const root = merkleRoot(hashes)
  const head = prevHash
  append({
    type: "chain-epoch",
    source: "shared",
    epoch: 0,
    count,
    root,
    head,
  })
  writeFileSync(file, lines.join("\n") + "\n")
  return { root, head }
}

/**
 * Writes the session-state anchors file with one ref.
 * @param dir The temp metrics directory.
 * @param ref The epoch ref to anchor.
 */
function seedAnchors(dir: string, ref: { root: string; head: string }): void {
  writeFileSync(
    join(dir, "anchors.jsonl"),
    JSON.stringify({
      sink: "session-state",
      source: "shared",
      epoch: 0,
      root: ref.root,
      head: ref.head,
      ts: "2026-01-01T10:00:01.000Z",
    }) + "\n",
  )
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

/**
 * Reads a file into non-empty lines.
 * @param file The file path.
 * @returns The lines.
 */
function readLines(file: string): string[] {
  return readFileSync(file, "utf8").split("\n").filter(Boolean)
}
