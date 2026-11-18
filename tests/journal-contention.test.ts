/**
 * @fileoverview Journal append-lock contention tests: two journalers on one
 * metrics dir never fork the hash chain or lose rows — the deterministic
 * regression for the chained-append read-tail → append race. The interleave
 * is fully synchronous: writer B's injected seam runs writer A's append
 * inline between B's lock acquisition and B's in-lock head re-read, so A's
 * row lands exactly where the unlocked race used to fork the chain. Also
 * pins the fail-open degradation rows (`journal-lock:`), the stale-steal
 * row, and the one-lock-at-a-time ordering.
 */

import { test } from "node:test"
import assert from "node:assert/strict"
import * as fs from "node:fs"
import * as path from "node:path"

import { foldChain } from "../src/chain.ts"
import type { ParsedRow } from "../src/chain.ts"
import { createJournaler } from "../src/journal.ts"
import type { Journaler } from "../src/journal.ts"
import { tmpDir } from "./helpers.ts"

/** Options shared by both contending journalers: same metrics dir, tamper
 *  evidence on (the chain fork only exists under tamper evidence). */
interface ContentionOpts {
  metricsDir: string
  trace: boolean
  maxBytes: number
  maxGenerations: number
  rotateEveryEntries: number
  tamper: { enabled: boolean; epochEntries: number }
}

/**
 * Builds the shared journaler options for a temp metrics dir.
 * @param metricsDir The shared metrics dir.
 * @returns The base options both writers boot with.
 */
function baseOpts(metricsDir: string): ContentionOpts {
  return {
    metricsDir,
    trace: false,
    maxBytes: 5 * 1024 * 1024,
    maxGenerations: 5,
    rotateEveryEntries: 512,
    tamper: { enabled: true, epochEntries: 8 },
  }
}

/**
 * Reads a JSONL file's parsed object lines, oldest-first.
 * @param file The file to read.
 * @returns The parsed entries ([] when the file is missing).
 */
function readRows(file: string): Array<Record<string, any>> {
  if (!fs.existsSync(file)) return []
  return fs
    .readFileSync(file, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line))
}

/**
 * The chained rows of a journal file (rows carrying a `hash`; unchained
 * error rows are inert to the fold and excluded).
 * @param file The journal file to read.
 * @returns The chained rows as fold input.
 */
function chainedRows(file: string): ParsedRow[] {
  return readRows(file)
    .filter((r) => typeof r.hash === "string")
    .map((r) => {
      const { seq, prevHash, hash, ...payload } = r
      return { ts: payload.ts, payload, seq, prevHash, hash }
    })
}

/**
 * The `.lock` entries present in a directory (the live lock set).
 * @param dir The directory to scan.
 * @returns The lock entry names.
 */
function lockNames(dir: string): string[] {
  return fs.readdirSync(dir).filter((name) => name.endsWith(".lock"))
}

test("two journalers on one metrics dir never fork the chain or lose rows", () => {
  const metricsDir = tmpDir()
  const file = path.join(metricsDir, "turnstile.jsonl")
  const events: string[] = []
  // Writer A degrades instantly (timeoutMs 0): inside B's critical section
  // it cannot take the lock B holds, so it appends unlocked — exactly the
  // interleaving the lock must tolerate.
  const a: Journaler = createJournaler({ ...baseOpts(metricsDir), lockTimeoutMs: 0 })
  const b: Journaler = createJournaler({
    ...baseOpts(metricsDir),
    lockSeam: () => {
      events.push("seam-enter")
      assert.equal(fs.existsSync(`${file}.lock`), true, "B holds the lock in the seam")
      assert.deepEqual(
        lockNames(metricsDir),
        ["turnstile.jsonl.lock"],
        "exactly one lock exists during the critical section",
      )
      a.journal({ kind: "a" }) // runs inline, to completion
      events.push("seam-exit")
    },
  })
  b.journal({ kind: "b" })
  assert.deepEqual(events, ["seam-enter", "seam-exit"])
  // A's row landed between B's lock acquisition and B's head re-read; B's
  // in-lock re-read must continue A's head: seq strictly increasing, no fork.
  const rows = chainedRows(file)
  assert.deepEqual(
    rows.map((r) => r.seq),
    [0, 1],
  )
  assert.equal(foldChain(rows, "shared", { chainRootAtStart: false }).status, "ok")
  // A appended unlocked: its degradation row is journaled (visible, inert).
  const errors = readRows(file).filter((r) => r.type === "error")
  assert.equal(errors.length, 1)
  assert.match(String(errors[0]!.error), /^journal-lock: append lock unavailable: /)
  assert.equal(fs.existsSync(`${file}.lock`), false, "the lock is released after the append")
})

/** Both journalers acquire the append lock in turn (neither degrades) and
 *  the second writer's chained row continues the first writer's head — the
 *  production serialized path, where each writer holds the lock to
 *  completion instead of degrading around it. */
test("two journalers acquire the append lock in turn without degradation", () => {
  const metricsDir = tmpDir()
  const file = path.join(metricsDir, "turnstile.jsonl")
  const seams: string[] = []
  /**
   * Builds a seam observing one writer's critical section: the writer must
   * hold the metrics dir's only lock while inside it.
   * @param writer The writer name for the seam trace.
   * @returns The seam callback.
   */
  const observe = (writer: string) => () => {
    seams.push(writer)
    assert.deepEqual(
      lockNames(metricsDir),
      ["turnstile.jsonl.lock"],
      `${writer} holds the only lock in its critical section`,
    )
  }
  const a: Journaler = createJournaler({ ...baseOpts(metricsDir), lockSeam: observe("a") })
  const b: Journaler = createJournaler({ ...baseOpts(metricsDir), lockSeam: observe("b") })
  a.journal({ kind: "a" })
  b.journal({ kind: "b" })
  assert.deepEqual(seams, ["a", "b"], "both writers ran inside the lock, in turn")
  const rows = chainedRows(file)
  assert.deepEqual(
    rows.map((r) => r.seq),
    [0, 1],
    "the second writer's row continues the first writer's head",
  )
  assert.equal(foldChain(rows, "shared", { chainRootAtStart: false }).status, "ok")
  assert.equal(
    readRows(file).filter((r) => r.type === "error").length,
    0,
    "neither writer degraded to an unlocked append",
  )
  assert.equal(fs.existsSync(`${file}.lock`), false, "the lock is released after each append")
})

test("an unavailable append lock degrades to an unlocked append with a journaled warning", () => {
  const metricsDir = tmpDir()
  const file = path.join(metricsDir, "turnstile.jsonl")
  const j = createJournaler({ ...baseOpts(metricsDir), lockTimeoutMs: 0 })
  fs.mkdirSync(`${file}.lock`) // held fresh by "another process"
  assert.doesNotThrow(() => j.journal({ kind: "gate" }))
  const rows = readRows(file)
  const errors = rows.filter((r) => r.type === "error")
  assert.equal(errors.length, 1)
  assert.match(String(errors[0]!.error), /^journal-lock: append lock unavailable: /)
  assert.equal(chainedRows(file).length, 1, "the entry still appends (never blocked or dropped)")
  assert.equal(fs.existsSync(`${file}.lock`), true, "a fresh lock is left for its holder")
})

test("a stale append lock is stolen and the steal is journaled", () => {
  const metricsDir = tmpDir()
  const file = path.join(metricsDir, "turnstile.jsonl")
  const j = createJournaler(baseOpts(metricsDir))
  const lock = `${file}.lock`
  fs.mkdirSync(lock)
  const past = new Date(Date.now() - 120_000)
  fs.utimesSync(lock, past, past)
  assert.doesNotThrow(() => j.journal({ kind: "gate" }))
  const rows = readRows(file)
  const errors = rows.filter((r) => r.type === "error")
  assert.equal(errors.length, 1)
  assert.match(String(errors[0]!.error), /^journal-lock: stale lock stolen: /)
  assert.equal(chainedRows(file).length, 1, "the entry appends after the steal")
  assert.equal(fs.existsSync(lock), false, "the stolen lock is released")
})

test("an unwritable metrics dir never escapes journal() under tamper evidence", () => {
  const metricsDir = tmpDir()
  const j = createJournaler(baseOpts(metricsDir))
  fs.chmodSync(metricsDir, 0o500) // the parent mkdir and the lock mkdir fail
  try {
    assert.doesNotThrow(() => j.journal({ kind: "gate" }))
  } finally {
    fs.chmodSync(metricsDir, 0o700)
  }
})

test("a file blocking the sink's parent path never escapes journal()", () => {
  const metricsDir = tmpDir()
  const j = createJournaler({ ...baseOpts(metricsDir), perSession: true, sinkFor: () => "p1" })
  fs.writeFileSync(path.join(metricsDir, "sessions"), "") // blocks mkdir (EEXIST)
  assert.doesNotThrow(() => j.journal({ kind: "gate", sessionID: "p1" }))
})
