/**
 * @fileoverview Tests for the scoped `turnstile prov --verify --session <id>`
 * surface (scripts/prov.mjs), driven by spawning the script the same way
 * bin/cli.mjs does. Journals are seeded through the real src/ chain helpers
 * (recordHash/merkleRoot), so the test cross-checks the CLI-side fold mirror
 * in scripts/chain-read.mjs against the src/ logic:
 *
 *  - an intact chained journal with matching anchors exits 0 and reports
 *    per-row inclusion facts (row hash, epoch, merkleOk, anchored status,
 *    weakest vouching domain) in both JSON and human form;
 *  - a mutated prov:* row exits 1, localized to the row and its epoch;
 *  - an anchored ref whose root differs from the journal's epoch commit
 *    yields anchored: false and merkleOk: false for that epoch's rows;
 *  - open-window prov rows report epoch: null with a reason and never flip
 *    the exit code;
 *  - usage errors (--session without --verify, --session plus a positional,
 *    a malformed session id, a missing value, an unknown flag) exit 2.
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
  return mkdtempSync(join(tmpdir(), "turnstile-prov-scoped-test-"))
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
 * Seeds one chained family file: prov data rows plus a `chain-epoch` commit
 * per requested epoch, all hashed through the real src/ recordHash.
 * @param dir The temp metrics directory.
 * @param name The family's file name ("turnstile.jsonl" or
 *     "sessions/<id>.jsonl").
 * @param counts The number of prov data rows before each epoch commit.
 * @param text The prompt text stamped into each prov:stated row.
 * @returns The epoch refs the commits carry (root/head), in epoch order.
 */
function seedProvFamily(
  dir: string,
  name: string,
  counts: number[],
  text: string,
): { root: string; head: string; epoch: number }[] {
  const file = join(dir, name)
  mkdirSync(dirname(file), { recursive: true })
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
      hashes.push(append({ type: "prov:stated", sessionID: "ses1", text }))
    }
    const root = merkleRoot(hashes)
    const head = prevHash
    append({ type: "chain-epoch", source: "ses1", epoch, count: counts[epoch], root, head })
    refs.push({ root, head, epoch })
  }
  writeFileSync(file, lines.join("\n") + "\n")
  return refs
}

/**
 * Seeds the shared journal and the ses1 sink with one prov epoch each.
 * @param dir The temp metrics directory.
 * @returns The refs per family, keyed by source.
 */
function seedProvEpochs(dir: string): { shared: Ref[]; ses1: Ref[] } {
  return {
    shared: seedProvFamily(dir, "turnstile.jsonl", [2], "shared prompt"),
    ses1: seedProvFamily(dir, join("sessions", "ses1.jsonl"), [2], "session prompt"),
  }
}

/** An epoch ref as seeded (root/head plus its epoch index). */
type Ref = { root: string; head: string; epoch: number }

/**
 * Appends one session-state anchor line to the anchors file.
 * @param dir The temp metrics directory.
 * @param source The family source the ref belongs to.
 * @param ref The epoch ref to anchor.
 * @param root Overrides the anchored root (for the root-mismatch fixture).
 */
function appendAnchor(dir: string, source: string, ref: Ref, root?: string): void {
  const file = join(dir, "anchors.jsonl")
  const lines = existsSync(file) ? readLines(file) : []
  lines.push(
    JSON.stringify({
      sink: "session-state",
      source,
      epoch: ref.epoch,
      root: root ?? ref.root,
      head: ref.head,
      ts: "2026-01-01T10:00:01.000Z",
    }),
  )
  writeFileSync(file, lines.join("\n") + "\n")
}

/**
 * Anchors every seeded ref of both families with their honest roots.
 * @param dir The temp metrics directory.
 * @param refs The refs per family, keyed by source.
 */
function seedAnchorsAll(dir: string, refs: { shared: Ref[]; ses1: Ref[] }): void {
  for (const [source, list] of Object.entries(refs)) {
    for (const ref of list) appendAnchor(dir, source, ref)
  }
}

test("scoped verify reports per-row inclusion facts and exits 0", () => {
  const dir = metricsDir()
  try {
    const refs = seedProvEpochs(dir)
    seedAnchorsAll(dir, refs)
    const r = runProv(dir, ["--verify", "--session", "ses1", "--json"])
    assert.equal(code(r), 0, `stderr: ${r.stderr}`)
    const j = JSON.parse(r.stdout)
    assert.equal(j.session, "ses1")
    assert.equal(j.chain.status, "ok")
    assert.equal(j.broken, null)
    assert.equal(j.rows.length, 4)
    const sesRow = j.rows.find((x: Entry) => x.source === "ses1")
    assert.equal(sesRow.type, "prov:stated")
    assert.equal(sesRow.epoch, 0)
    assert.equal(sesRow.epochRoot, refs.ses1[0]!.root)
    assert.ok(Array.isArray(sesRow.merklePath) && sesRow.merklePath.length > 0)
    assert.equal(sesRow.merkleOk, true)
    assert.equal(sesRow.anchored, true)
    assert.equal(sesRow.weakestDomain, "host")
    assert.deepEqual(sesRow.sinks, ["session-state"])
    assert.equal(sesRow.reason, null)
    const epoch = j.epochs.find((e: Entry) => e.source === "ses1")
    assert.equal(epoch.anchored, true)
    assert.equal(epoch.weakestDomain, "host")
    assert.equal(epoch.count, 2)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("scoped verify human output renders the same facts", () => {
  const dir = metricsDir()
  try {
    const refs = seedProvEpochs(dir)
    seedAnchorsAll(dir, refs)
    const r = runProv(dir, ["--verify", "--session", "ses1"])
    assert.equal(code(r), 0, `stderr: ${r.stderr}`)
    assert.match(r.stdout, /chain ok \(6 rows, 2 epochs\) · anchored by host \[session-state\]/)
    assert.match(
      r.stdout,
      /stated {2}session prompt {2}row=[0-9a-f]{8} epoch=0 merkle=ok anchored=host/,
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("a mutated prov row is localized to row and epoch", () => {
  const dir = metricsDir()
  try {
    const refs = seedProvEpochs(dir)
    seedAnchorsAll(dir, refs)
    const file = join(dir, "sessions", "ses1.jsonl")
    const lines = readLines(file)
    const first = JSON.parse(lines[0]!) as Entry
    lines[0] = JSON.stringify({ ...first, text: "forged" })
    writeFileSync(file, lines.join("\n") + "\n")
    const r = runProv(dir, ["--verify", "--session", "ses1", "--json"])
    assert.equal(code(r), 1)
    const j = JSON.parse(r.stdout)
    assert.equal(j.chain.status, "broken")
    assert.equal(j.broken.prov.type, "prov:stated")
    assert.equal(j.broken.prov.index, 1)
    assert.match(String(j.broken.prov.epoch), /^\d+$/)
    assert.equal(j.broken.prov.committed, false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("a mutated prov row is localized in human output too", () => {
  const dir = metricsDir()
  try {
    const refs = seedProvEpochs(dir)
    seedAnchorsAll(dir, refs)
    const file = join(dir, "sessions", "ses1.jsonl")
    const lines = readLines(file)
    const first = JSON.parse(lines[0]!) as Entry
    lines[0] = JSON.stringify({ ...first, text: "forged" })
    writeFileSync(file, lines.join("\n") + "\n")
    const r = runProv(dir, ["--verify", "--session", "ses1"])
    assert.equal(code(r), 1)
    assert.match(r.stdout, /chain broken at ses1:1: hash mismatch/)
    assert.match(r.stdout, /mutated prov row: prov:stated at ses1:1 \(epoch \d+\)/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("an anchored ref whose root differs from the commit yields merkleOk false", () => {
  const dir = metricsDir()
  try {
    const refs = seedProvEpochs(dir)
    // Anchor ses1#0 against a forged root: the sink verdict is a mismatch,
    // so the epoch is unanchored and the anchored ref's root disagrees with
    // the journal's commit — merkleOk must be false, not vacuously true.
    appendAnchor(dir, "shared", refs.shared[0]!)
    appendAnchor(dir, "ses1", refs.ses1[0]!, "forged-root")
    const r = runProv(dir, ["--verify", "--session", "ses1", "--json"])
    assert.equal(code(r), 1)
    const j = JSON.parse(r.stdout)
    const sesRow = j.rows.find((x: Entry) => x.source === "ses1")
    assert.equal(sesRow.anchored, false)
    assert.equal(sesRow.merkleOk, false)
    assert.equal(sesRow.weakestDomain, null)
    const sharedRow = j.rows.find((x: Entry) => x.source === "shared")
    assert.equal(sharedRow.anchored, true)
    assert.equal(sharedRow.merkleOk, true)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("open-window prov rows report unanchored without flipping the exit code", () => {
  const dir = metricsDir()
  try {
    const refs = seedProvFamily(dir, "turnstile.jsonl", [1], "committed prompt")
    appendAnchor(dir, "shared", refs[0]!)
    // One trailing prov row after the last epoch commit: an open window.
    seedProvFamily(dir, join("sessions", "ses1.jsonl"), [], "ignored")
    const file = join(dir, "sessions", "ses1.jsonl")
    const ts = "2026-01-01T10:00:00.000Z"
    const payload = { ts, type: "prov:stated", sessionID: "ses1", text: "trailing prompt" }
    const hash = recordHash("", ts, payload)
    writeFileSync(file, `${JSON.stringify({ ...payload, seq: 0, prevHash: "", hash })}\n`)
    const r = runProv(dir, ["--verify", "--session", "ses1", "--json"])
    assert.equal(code(r), 0, `stderr: ${r.stderr}`)
    const j = JSON.parse(r.stdout)
    assert.equal(j.rows.length, 2)
    const open = j.rows.find((x: Entry) => x.source === "ses1")!
    assert.equal(open.epoch, null)
    assert.equal(open.epochRoot, null)
    assert.equal(open.merklePath, null)
    assert.equal(open.merkleOk, null)
    assert.equal(open.anchored, false)
    assert.equal(open.reason, "open epoch window (not yet committed)")
    assert.equal(j.rows.find((x: Entry) => x.source === "shared")!.merkleOk, true)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("open-window prov rows render the open-window line in human output", () => {
  const dir = metricsDir()
  try {
    const refs = seedProvFamily(dir, "turnstile.jsonl", [1], "committed prompt")
    appendAnchor(dir, "shared", refs[0]!)
    mkdirSync(join(dir, "sessions"), { recursive: true })
    const file = join(dir, "sessions", "ses1.jsonl")
    const ts = "2026-01-01T10:00:00.000Z"
    const payload = { ts, type: "prov:stated", sessionID: "ses1", text: "trailing prompt" }
    const hash = recordHash("", ts, payload)
    writeFileSync(file, `${JSON.stringify({ ...payload, seq: 0, prevHash: "", hash })}\n`)
    const r = runProv(dir, ["--verify", "--session", "ses1"])
    assert.equal(code(r), 0)
    assert.match(
      r.stdout,
      /stated {2}trailing prompt {2}row=[0-9a-f]{8} epoch=open anchored=no \(not yet committed\)/,
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("scoped verify exits 0 with empty rows for an unknown session", () => {
  const dir = metricsDir()
  try {
    const r = runProv(dir, ["--verify", "--session", "sesX", "--json"])
    assert.equal(code(r), 0, `stderr: ${r.stderr}`)
    const j = JSON.parse(r.stdout)
    assert.equal(j.session, "sesX")
    assert.deepEqual(j.rows, [])
    assert.equal(j.chain.status, "ok")
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("scoped verify rejects usage errors with exit 2", () => {
  const dir = metricsDir()
  try {
    const cases: [string[], RegExp][] = [
      [["--session", "ses1"], /--session requires --verify/],
      [["ses1", "--verify", "--session", "ses1"], /--session cannot be combined with a positional/],
      [["--verify", "--session", "ses1", "--wat"], /unknown argument "--wat"/],
      [["--verify", "--session"], /--session requires a session id value/],
      [["--verify", "--session", "../../foo"], /malformed session id/],
    ]
    for (const [args, pattern] of cases) {
      const r = runProv(dir, args)
      assert.equal(code(r), 2, `args: ${args.join(" ")}`)
      assert.match(r.stderr, pattern)
    }
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
