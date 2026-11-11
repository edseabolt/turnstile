/**
 * @fileoverview Journal hash-chain tests: chained row shape, Merkle epoch
 * cadence, chain continuity across rotation generations, per-family chain
 * independence, partial-epoch close on `anchor()`, the legacy unchained row
 * shape when tamper evidence is disabled, and the fail-open anchor publish
 * (a throwing sink journals an error row and never breaks the journaler).
 */

import { test } from "node:test"
import assert from "node:assert/strict"
import * as fs from "node:fs"
import * as path from "node:path"

import { foldChain, merkleRoot, recordHash } from "../src/chain.ts"
import type { ParsedRow } from "../src/chain.ts"
import { createJournaler, sessionJournalPath } from "../src/journal.ts"
import type { AnchorRef, AnchorSink, AnchorVerdict } from "../src/types.ts"
import { tmpDir } from "./helpers.ts"

/** Builds a journaler bound to a temp metrics dir with per-session routing.
 *  @param opts Optional overrides: `epochEntries` (default 512),
 *     `maxBytes` (default 5 MB), `sinkFor` (identity for known parents).
 *  @returns The journaler and its metrics dir. */
function chainedJournaler(opts?: {
  epochEntries?: number
  maxBytes?: number
  rotateEveryEntries?: number
  sinkFor?: (sessionID: string) => string
}): { j: ReturnType<typeof createJournaler>; metricsDir: string } {
  const metricsDir = tmpDir()
  const j = createJournaler({
    metricsDir,
    trace: false,
    maxBytes: opts?.maxBytes ?? 5 * 1024 * 1024,
    maxGenerations: 5,
    rotateEveryEntries: opts?.rotateEveryEntries ?? 512,
    perSession: true,
    sinkFor: opts?.sinkFor ?? ((sid) => (sid === "p1" ? "p1" : "")),
    tamper: { enabled: true, epochEntries: opts?.epochEntries ?? 512 },
  })
  return { j, metricsDir }
}

/** Reads a JSONL file's parsed object lines, oldest-first.
 *  @param file The file to read.
 *  @returns The parsed entries ([] when the file is missing). */
function readRows(file: string): Array<Record<string, any>> {
  if (!fs.existsSync(file)) return []
  return fs
    .readFileSync(file, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line))
}

/** Converts raw journal rows into the fold's ParsedRow shape.
 *  @param rows The raw rows.
 *  @returns The rows with payload separated from the chain fields. */
function toParsed(rows: Array<Record<string, any>>): ParsedRow[] {
  return rows.map((r) => {
    const { seq, prevHash, hash, ...payload } = r
    return { ts: payload.ts, payload, seq, prevHash, hash }
  })
}

/** A recording anchor sink that can be made to throw on publish.
 *  @param fail Whether publish throws.
 *  @returns The sink plus its recorded refs. */
function recordingSink(fail: boolean): { sink: AnchorSink; refs: AnchorRef[] } {
  const refs: AnchorRef[] = []
  return {
    refs,
    sink: {
      id: "recording",
      trustDomain: "host",
      publish(ref: AnchorRef): void {
        if (fail) throw new Error("sink exploded")
        refs.push(ref)
      },
      verify(ref: AnchorRef): AnchorVerdict {
        const hit = refs.find((r) => r.source === ref.source && r.epoch === ref.epoch)
        return hit
          ? { status: "ok", anchoredAt: hit.ts }
          : { status: "missing", detail: "not published" }
      },
    },
  }
}

test("chained rows carry seq, prevHash, and a verifiable hash", () => {
  const { j, metricsDir } = chainedJournaler()
  j.journal({ type: "gate", sessionID: "p1" })
  j.journal({ type: "verdict", sessionID: "p1" })
  const rows = readRows(path.join(metricsDir, "sessions", "p1.jsonl"))
  assert.equal(rows.length, 2)
  assert.equal(rows[0]!.seq, 0)
  assert.equal(rows[0]!.prevHash, "")
  assert.equal(
    rows[0]!.hash,
    recordHash("", rows[0]!.ts, {
      ts: rows[0]!.ts,
      type: "gate",
      sessionID: "p1",
    }),
  )
  assert.equal(rows[1]!.prevHash, rows[0]!.hash)
  assert.equal(foldChain(toParsed(rows), "p1").status, "ok")
})

test("disabled tamper evidence reproduces the legacy unchained row shape", () => {
  const metricsDir = tmpDir()
  const j = createJournaler({
    metricsDir,
    trace: false,
    maxBytes: 5 * 1024 * 1024,
    maxGenerations: 5,
    rotateEveryEntries: 512,
    tamper: { enabled: false, epochEntries: 512 },
  })
  j.journal({ type: "gate", sessionID: "p1" })
  const row = readRows(path.join(metricsDir, "turnstile.jsonl"))[0]!
  assert.deepEqual(Object.keys(row).sort(), ["sessionID", "ts", "type"])
  // anchor() is a no-op when disabled: no rows, no throw.
  j.anchor("task-complete", "p1")
  assert.equal(readRows(path.join(metricsDir, "turnstile.jsonl")).length, 1)
})

test("an epoch closes every epochEntries data rows with a chained chain-epoch row", () => {
  const { j, metricsDir } = chainedJournaler({ epochEntries: 2 })
  const file = path.join(metricsDir, "turnstile.jsonl")
  j.journal({ type: "a" })
  j.journal({ type: "b" })
  j.journal({ type: "c" })
  const rows = readRows(file)
  assert.equal(rows.length, 4)
  const epoch = rows[2]!
  assert.equal(epoch.type, "chain-epoch")
  assert.equal(epoch.source, "shared")
  assert.equal(epoch.epoch, 0)
  assert.equal(epoch.count, 2)
  assert.equal(epoch.root, merkleRoot([rows[0]!.hash, rows[1]!.hash]))
  assert.equal(epoch.head, rows[1]!.hash)
  assert.equal(epoch.prevHash, rows[1]!.hash)
  assert.equal(rows[3]!.prevHash, epoch.hash)
  assert.equal(foldChain(toParsed(rows), "shared").status, "ok")
})

test("the chain continues across rotation generations", () => {
  const { j, metricsDir } = chainedJournaler({ maxBytes: 400, rotateEveryEntries: 2 })
  const file = path.join(metricsDir, "turnstile.jsonl")
  for (let i = 0; i < 5; i++) j.journal({ type: "tick", i })
  // Walk the family oldest-first: numbered generations .5..\.1, then current.
  const parts: Array<Record<string, any>[]> = []
  for (let gen = 5; gen >= 1; gen--) {
    if (fs.existsSync(`${file}.${gen}`)) parts.push(readRows(`${file}.${gen}`))
  }
  if (fs.existsSync(file)) parts.push(readRows(file))
  const gen1 = parts[0]!
  const current = parts[parts.length - 1]!
  assert.ok(parts.length >= 2, "rotation produced generation files")
  assert.equal(current[0]!.prevHash, gen1[gen1.length - 1]!.hash)
  const all = parts.flat()
  assert.equal(all.length, 5)
  assert.equal(foldChain(toParsed(all), "shared").status, "ok")
})

test("per-family chains are independent", () => {
  const { j, metricsDir } = chainedJournaler({ epochEntries: 1 })
  j.journal({ type: "shared-row" })
  j.journal({ type: "session-row", sessionID: "p1" })
  const shared = readRows(path.join(metricsDir, "turnstile.jsonl"))
  const session = readRows(sessionJournalPath(metricsDir, "p1"))
  assert.equal(shared[0]!.seq, 0)
  assert.equal(session[0]!.seq, 0)
  assert.equal(shared[0]!.prevHash, "")
  assert.equal(session[0]!.prevHash, "")
  const epochShared = shared[1]!
  assert.equal(epochShared.type, "chain-epoch")
  assert.equal(epochShared.source, "shared")
  const epochSession = session[1]!
  assert.equal(epochSession.type, "chain-epoch")
  assert.equal(epochSession.source, "p1")
})

test("anchor() closes a partial epoch and publishes the pending refs", async () => {
  const { j, metricsDir } = chainedJournaler({ epochEntries: 512 })
  const { sink, refs } = recordingSink(false)
  j.bindAnchorSinks([sink])
  j.journal({ type: "a" })
  j.journal({ type: "b" })
  j.anchor("task-complete", "p1")
  const rows = readRows(path.join(metricsDir, "turnstile.jsonl"))
  const epoch = rows[2]!
  assert.equal(epoch.type, "chain-epoch")
  assert.equal(epoch.count, 2)
  assert.equal(foldChain(toParsed(rows), "shared").status, "ok")
  await new Promise((resolve) => setTimeout(resolve, 10))
  assert.equal(refs.length, 1)
  assert.equal(refs[0]!.source, "shared")
  assert.equal(refs[0]!.epoch, 0)
  assert.equal(refs[0]!.sink, "recording")
  assert.equal(refs[0]!.root, epoch.root)
  assert.equal(refs[0]!.head, epoch.head)
})

test("a throwing anchor sink journals an anchor-publish error and never throws", async () => {
  const { j, metricsDir } = chainedJournaler({ epochEntries: 1 })
  const { sink } = recordingSink(true)
  j.bindAnchorSinks([sink])
  j.journal({ type: "a" })
  j.anchor("task-complete")
  await new Promise((resolve) => setTimeout(resolve, 10))
  const rows = readRows(path.join(metricsDir, "turnstile.jsonl"))
  const errors = rows.filter((r) => r.type === "error")
  assert.equal(errors.length, 1)
  assert.match(String(errors[0]!.error), /^anchor-publish: recording: Error: sink exploded/)
})

test("anchor() with no bound sinks keeps the refs pending without error", () => {
  const { j, metricsDir } = chainedJournaler({ epochEntries: 1 })
  j.journal({ type: "a" })
  j.anchor("task-complete")
  const rows = readRows(path.join(metricsDir, "turnstile.jsonl"))
  assert.equal(rows.filter((r) => r.type === "error").length, 0)
  assert.equal(rows.filter((r) => r.type === "chain-epoch").length, 1)
})

test("anchor() with no unanchored rows closes nothing new", () => {
  const { j, metricsDir } = chainedJournaler({ epochEntries: 2 })
  j.journal({ type: "a" })
  j.journal({ type: "b" }) // epoch closes on cadence; window empty
  const before = readRows(path.join(metricsDir, "turnstile.jsonl")).length
  j.anchor("session-end")
  const after = readRows(path.join(metricsDir, "turnstile.jsonl")).length
  assert.equal(after, before)
})

/** Creates a second journaler over an existing metrics dir (the restart
 *  scenario: chain state must be recovered from disk, not restarted).
 *  @param metricsDir The existing metrics dir.
 *  @param epochEntries Data rows per Merkle epoch.
 *  @returns The new journaler. */
function restartedJournaler(metricsDir: string, epochEntries: number) {
  return createJournaler({
    metricsDir,
    trace: false,
    maxBytes: 5 * 1024 * 1024,
    maxGenerations: 5,
    rotateEveryEntries: 512,
    perSession: true,
    sinkFor: (sid) => (sid === "p1" ? "p1" : ""),
    tamper: { enabled: true, epochEntries },
  })
}

/** Reads one family's rows across all rotation generations, oldest-first.
 *  Malformed lines are skipped (the seeding path tolerates them too).
 *  @param file The family's current file path.
 *  @returns The rows, oldest-first. */
function readFamily(file: string): Array<Record<string, any>> {
  const parts: Array<Record<string, any>[]> = []
  const parseAll = (f: string): Array<Record<string, any>> => {
    if (!fs.existsSync(f)) return []
    return fs
      .readFileSync(f, "utf8")
      .split("\n")
      .filter(Boolean)
      .flatMap((line) => {
        try {
          return [JSON.parse(line) as Record<string, any>]
        } catch {
          return []
        }
      })
  }
  for (let gen = 5; gen >= 1; gen--) {
    if (fs.existsSync(`${file}.${gen}`)) parts.push(parseAll(`${file}.${gen}`))
  }
  if (fs.existsSync(file)) parts.push(parseAll(file))
  return parts.flat()
}

test("a restarted journaler continues the chain instead of forking it", () => {
  const { j, metricsDir } = chainedJournaler()
  j.journal({ type: "gate", sessionID: "p1" })
  j.journal({ type: "verdict", sessionID: "p1" })
  const j2 = restartedJournaler(metricsDir, 512)
  j2.journal({ type: "gate", sessionID: "p1" })
  const rows = readFamily(sessionJournalPath(metricsDir, "p1"))
  assert.equal(rows.length, 3)
  assert.equal(rows[2]!.seq, 2)
  assert.equal(rows[2]!.prevHash, rows[1]!.hash)
  assert.equal(foldChain(toParsed(rows), "p1").status, "ok")
})

test("a restarted journaler recovers the epoch window and index", () => {
  const { j, metricsDir } = chainedJournaler({ epochEntries: 3 })
  const file = path.join(metricsDir, "turnstile.jsonl")
  j.journal({ type: "a" })
  j.journal({ type: "b" }) // partial epoch 0: two data rows on disk
  const j2 = restartedJournaler(metricsDir, 3)
  j2.journal({ type: "c" }) // completes epoch 0, commits its chain-epoch row
  j2.journal({ type: "d" }) // starts epoch 1
  const rows = readFamily(file)
  const epochs = rows.filter((r) => r.type === "chain-epoch")
  assert.equal(epochs.length, 1)
  assert.equal(epochs[0]!.epoch, 0)
  assert.equal(epochs[0]!.count, 3)
  assert.equal(epochs[0]!.root, merkleRoot([rows[0]!.hash, rows[1]!.hash, rows[2]!.hash]))
  assert.equal(foldChain(toParsed(rows), "shared").status, "ok")
})

test("a restarted journaler seeds across a committed epoch and malformed lines", () => {
  const { j, metricsDir } = chainedJournaler({ epochEntries: 1 })
  const file = path.join(metricsDir, "turnstile.jsonl")
  j.journal({ type: "a" }) // closes epoch 0 on cadence
  // Corrupt the family with a malformed line and an unchained legacy row:
  // seeding must skip both and still continue from the last chained row.
  fs.appendFileSync(file, "not json\n")
  fs.appendFileSync(file, JSON.stringify({ ts: "2026-01-01T00:00:00.000Z", type: "legacy" }) + "\n")
  const j2 = restartedJournaler(metricsDir, 1)
  j2.journal({ type: "b" }) // closes epoch 1 on cadence
  const rows = readFamily(file)
  const epochs = rows.filter((r) => r.type === "chain-epoch")
  assert.equal(epochs.length, 2)
  assert.equal(epochs[1]!.epoch, 1)
  assert.equal(epochs[1]!.count, 1)
  assert.equal(foldChain(toParsed(rows), "shared").status, "ok")
})

test("a journaler over a fresh directory starts the chain at zero", () => {
  const { j, metricsDir } = chainedJournaler()
  j.journal({ type: "gate", sessionID: "p1" })
  const rows = readFamily(sessionJournalPath(metricsDir, "p1"))
  assert.equal(rows[0]!.seq, 0)
  assert.equal(rows[0]!.prevHash, "")
  assert.equal(foldChain(toParsed(rows), "p1").status, "ok")
})

test("an entry carrying its own ts hashes under the row's displayed ts", () => {
  const { j, metricsDir } = chainedJournaler()
  j.journal({ type: "gate", sessionID: "p1", ts: "1999-01-01T00:00:00.000Z" })
  const rows = readFamily(sessionJournalPath(metricsDir, "p1"))
  assert.equal(rows.length, 1)
  assert.notEqual(rows[0]!.ts, "1999-01-01T00:00:00.000Z")
  assert.equal(
    rows[0]!.hash,
    recordHash("", rows[0]!.ts, { type: "gate", sessionID: "p1", ts: rows[0]!.ts }),
  )
  assert.equal(foldChain(toParsed(rows), "p1").status, "ok")
})
