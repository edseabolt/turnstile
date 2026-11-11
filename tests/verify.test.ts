/**
 * @fileoverview Full-chain verify tests: `verifyJournalChain` driven
 * directly over seeded journal families (shared + one session sink),
 * covering the ok path, a broken family, an epoch root mismatch, and
 * missing anchors, plus the session-end wiring (verifyOnSessionEnd on/off)
 * and the fail-open task-completion anchor publish.
 */

import { test } from "node:test"
import assert from "node:assert/strict"
import * as fs from "node:fs"
import * as path from "node:path"
import { pathToFileURL } from "node:url"

import { merkleRoot, recordHash } from "../src/chain.ts"
import { appendLine } from "../src/journal-sinks.ts"
import { createJournaler } from "../src/journal.ts"
import { createHooksCore, type TurnstileContext } from "../src/hooks-core.ts"
import { createEventHandlers } from "../src/event-stream-handlers.ts"
import { verifyJournalChain } from "../src/verify.ts"
import type { AnchorRef, AnchorSink, TurnstileConfig } from "../src/types.ts"
import {
  callSession,
  isolatedEnv,
  journalEntries,
  makeFakeHost,
  tmpDir,
  waitUntil,
} from "./helpers.ts"
import { turnstile } from "../turnstile.ts"

/** Builds the plugin setup bound to a fake host with injected config.
 *  @param host The fake host.
 *  @param opts The turnstile options.
 *  @returns The setup function. */
function turnstileSetup(
  host: Parameters<typeof turnstile>[0],
  opts: Parameters<typeof turnstile>[1],
) {
  return turnstile(host, opts)
}

/** A session-state-shaped sink over a chosen file, recording publishes.
 *  @param file The anchors file.
 *  @param fail Whether publish throws.
 *  @returns The sink plus its recorded refs. */
function fileSink(file: string, fail = false): { sink: AnchorSink; refs: AnchorRef[] } {
  const refs: AnchorRef[] = []
  return {
    refs,
    sink: {
      id: "test-sink",
      trustDomain: "host",
      publish(r: AnchorRef): void {
        if (fail) throw new Error("sink down")
        refs.push(r)
        fs.mkdirSync(path.dirname(file), { recursive: true })
        fs.appendFileSync(file, JSON.stringify(r) + "\n")
      },
      verify(r: AnchorRef) {
        try {
          const hit = fs
            .readFileSync(file, "utf8")
            .trim()
            .split("\n")
            .filter(Boolean)
            .map((l) => JSON.parse(l) as AnchorRef)
            .find((x) => x.source === r.source && x.epoch === r.epoch)
          return hit
            ? { status: "ok" as const, anchoredAt: hit.ts }
            : { status: "missing" as const, detail: "absent" }
        } catch {
          return { status: "missing" as const, detail: "absent" }
        }
      },
    },
  }
}

/** Builds a hooks-core context with tamper evidence configured.
 *  @param tamper The tamperEvidence override.
 *  @param extra Additional config overrides (e.g. sessionSummary).
 *  @returns The context and metrics dir. */
function coreWith(
  tamper: Partial<TurnstileConfig["tamperEvidence"]>,
  extra: Partial<TurnstileConfig> = {},
): {
  ctx: TurnstileContext
  metricsDir: string
} {
  const metricsDir = tmpDir()
  const ctx = createHooksCore({
    env: isolatedEnv(metricsDir),
    config: {
      metricsDir,
      alwaysEnforce: true,
      ...extra,
      tamperEvidence: {
        enabled: true,
        anchor: "session-state",
        epochEntries: 2,
        verifyOnSessionEnd: false,
        ...tamper,
      },
    },
  })
  return { ctx, metricsDir }
}

/** Appends one chained row to a journal file, returning the rows so far.
 *  @param file The journal file.
 *  @param state The chain state (mutated).
 *  @param entry The entry fields.
 *  @returns The appended row. */
function appendRow(
  file: string,
  state: { seq: number; prevHash: string },
  entry: Record<string, unknown>,
): Record<string, unknown> {
  const ts = "2026-01-01T00:00:00.000Z"
  const payload = { ts, ...entry }
  const hash = recordHash(state.prevHash, ts, payload)
  const row = { ...payload, seq: state.seq, prevHash: state.prevHash, hash }
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.appendFileSync(file, JSON.stringify(row) + "\n")
  state.seq++
  state.prevHash = hash
  return row
}

test("verifyJournalChain reports ok across families with anchored refs", async () => {
  const metricsDir = tmpDir()
  const shared = path.join(metricsDir, "turnstile.jsonl")
  const session = path.join(metricsDir, "sessions", "p1.jsonl")
  const s1 = { seq: 0, prevHash: "" }
  const s2 = { seq: 0, prevHash: "" }
  const r1 = appendRow(shared, s1, { type: "a" })
  const epochShared = appendRow(shared, s1, {
    type: "chain-epoch",
    source: "shared",
    epoch: 0,
    count: 1,
    root: merkleRoot([r1.hash as string]),
    head: r1.hash,
    ts: "2026-01-01T00:00:00.000Z",
  })
  const r2 = appendRow(session, s2, { type: "b", sessionID: "p1" })
  appendRow(session, s2, {
    type: "chain-epoch",
    source: "p1",
    epoch: 0,
    count: 1,
    root: merkleRoot([r2.hash as string]),
    head: r2.hash,
    ts: "2026-01-01T00:00:00.000Z",
  })
  const anchors = path.join(metricsDir, "anchors.jsonl")
  const { sink } = fileSink(anchors)
  sink.publish({
    sink: "test-sink",
    source: "shared",
    epoch: 0,
    root: epochShared.root as string,
    head: epochShared.head as string,
    ts: "2026-01-01T00:00:01.000Z",
  })
  // The p1 family's epoch is unanchored: report not-ok, shared anchored.
  const report = await verifyJournalChain({ metricsDir, sinks: [sink] })
  assert.equal(report.families.length, 2)
  assert.ok(report.families.every((f) => f.verdict.status === "ok"))
  assert.equal(report.refs.length, 2)
  assert.equal(report.ok, false)
  assert.equal(report.weakest[0]!.domain, "host")
  assert.equal(report.weakest[1]!.domain, null)
})

test("verifyJournalChain reports the first broken link of a tampered family", async () => {
  const metricsDir = tmpDir()
  const shared = path.join(metricsDir, "turnstile.jsonl")
  const s1 = { seq: 0, prevHash: "" }
  appendRow(shared, s1, { type: "a" })
  appendRow(shared, s1, { type: "b" })
  // Tamper: rewrite the first row's payload in place.
  const lines = fs.readFileSync(shared, "utf8").trim().split("\n")
  const first = JSON.parse(lines[0]!) as Record<string, unknown>
  lines[0] = JSON.stringify({ ...first, type: "edited" })
  fs.writeFileSync(shared, lines.join("\n") + "\n")
  const report = await verifyJournalChain({ metricsDir, sinks: [] })
  assert.equal(report.ok, false)
  const sharedVerdict = report.families.find((f) => f.source === "shared")!
  assert.equal(sharedVerdict.verdict.status, "broken")
  assert.match((sharedVerdict.verdict as { detail: string }).detail, /hash mismatch/)
})

test("verifyJournalChain reports an epoch root mismatch", async () => {
  const metricsDir = tmpDir()
  const shared = path.join(metricsDir, "turnstile.jsonl")
  const s1 = { seq: 0, prevHash: "" }
  const r1 = appendRow(shared, s1, { type: "a" })
  appendRow(shared, s1, {
    type: "chain-epoch",
    source: "shared",
    epoch: 0,
    count: 1,
    root: "not-the-root",
    head: r1.hash,
    ts: "2026-01-01T00:00:00.000Z",
  })
  const report = await verifyJournalChain({ metricsDir, sinks: [] })
  assert.equal(report.ok, false)
  const sharedVerdict = report.families.find((f) => f.source === "shared")!
  assert.equal(sharedVerdict.verdict.status, "broken")
  assert.match((sharedVerdict.verdict as { detail: string }).detail, /epoch root\/head mismatch/)
})

test("verifyJournalChain tolerates missing files, malformed lines, and non-object rows", async () => {
  const metricsDir = tmpDir()
  const shared = path.join(metricsDir, "turnstile.jsonl")
  fs.mkdirSync(metricsDir, { recursive: true })
  fs.writeFileSync(
    shared,
    ["not json", JSON.stringify([1, 2]), JSON.stringify({ ts: 5, type: "x" }), ""].join("\n"),
  )
  const report = await verifyJournalChain({ metricsDir, sinks: [] })
  // The malformed lines are inert; the row without a hash starts the window.
  assert.equal(report.families[0]!.verdict.status, "ok")
  assert.equal(report.refs.length, 0)
  // A family whose generation files are absent folds to an empty ok: nothing
  // to verify is vacuously ok.
  const empty = await verifyJournalChain({ metricsDir: tmpDir(), sinks: [] })
  assert.equal(empty.ok, true)
  assert.equal(empty.families[0]!.verdict.status, "ok")
})

test("verifyJournalChain tolerates an unreadable family file", async () => {
  const metricsDir = tmpDir()
  // A directory at the family path makes readFileSync throw (EISDIR), the
  // only portable way to hit the read-failure arm (chmod is ineffective for
  // root on macOS).
  fs.mkdirSync(path.join(metricsDir, "turnstile.jsonl"), { recursive: true })
  const report = await verifyJournalChain({ metricsDir, sinks: [] })
  assert.equal(report.families[0]!.verdict.status, "ok")
  assert.equal(report.refs.length, 0)
})

test("verifyJournalChain folds across rotation generations oldest-first", async () => {
  const metricsDir = tmpDir()
  const shared = path.join(metricsDir, "turnstile.jsonl")
  const s1 = { seq: 0, prevHash: "" }
  // Two rows rotate into .1 (small maxBytes is irrelevant here — seed the
  // generation file directly), then two more in the current file.
  const g1a = appendRow(shared, s1, { type: "a" })
  const g1b = appendRow(shared, s1, { type: "b" })
  fs.renameSync(shared, `${shared}.1`)
  appendRow(shared, s1, { type: "c" })
  appendRow(shared, s1, {
    type: "chain-epoch",
    source: "shared",
    epoch: 0,
    count: 3,
    root: merkleRoot([g1a.hash as string, g1b.hash as string, s1.prevHash]),
    head: s1.prevHash,
    ts: "2026-01-01T00:00:00.000Z",
  })
  const report = await verifyJournalChain({ metricsDir, sinks: [] })
  assert.equal(report.families[0]!.verdict.status, "ok")
  assert.equal(report.refs.length, 1)
})

test("verifyJournalChain honors a raised maxGenerations across seven generations", async () => {
  const metricsDir = tmpDir()
  const shared = path.join(metricsDir, "turnstile.jsonl")
  const s1 = { seq: 0, prevHash: "" }
  // One data row per generation file .7..1, then the epoch commit in the
  // current file spanning all seven rows: only a verify threaded the same
  // generation count (7) reads every row of this chain.
  const hashes: string[] = []
  for (const gen of [7, 6, 5, 4, 3, 2, 1]) {
    hashes.push(appendRow(shared, s1, { type: `g${gen}` }).hash as string)
    fs.renameSync(shared, `${shared}.${gen}`)
  }
  appendRow(shared, s1, {
    type: "chain-epoch",
    source: "shared",
    epoch: 0,
    count: 7,
    root: merkleRoot(hashes),
    head: s1.prevHash,
    ts: "2026-01-01T00:00:00.000Z",
  })
  // Tamper the row in generation .6: only a verify that reads .7 and .6
  // (maxGenerations 7) can detect it; the default 5 never sees that file.
  const tampered = fs.readFileSync(`${shared}.6`, "utf8").trim().split("\n")
  const first = JSON.parse(tampered[0]!) as Record<string, unknown>
  tampered[0] = JSON.stringify({ ...first, type: "edited" })
  fs.writeFileSync(`${shared}.6`, tampered.join("\n") + "\n")
  const raised = await verifyJournalChain({ metricsDir, sinks: [], maxGenerations: 7 })
  assert.equal(raised.families[0]!.verdict.status, "broken")
  assert.match((raised.families[0]!.verdict as { detail: string }).detail, /hash mismatch/)
  // The default (5) folds only .5..current: the pruned-window trust root
  // makes that partial fold pass, but the tampered row is never read.
  const deflt = await verifyJournalChain({ metricsDir, sinks: [] })
  assert.equal(deflt.families[0]!.verdict.status, "ok")
})

test("verify stays ok after rotation prunes the oldest generation", async () => {
  const { ctx, metricsDir } = coreWith({ epochEntries: 3 }, {
    journalMaxBytes: 300,
    journalMaxGenerations: 3,
    journalRotateEveryEntries: 1,
  } as Partial<TurnstileConfig>)
  const anchors = path.join(metricsDir, "anchors.jsonl")
  const { sink } = fileSink(anchors)
  ctx.journaler.bindAnchorSinks([sink])
  // Enough padded entries to rotate several times: with maxGenerations 3
  // the fourth rotation prunes the generation holding the chain start, so
  // the oldest surviving generation's first row continues a pruned chain.
  // Anchors publish across the pruning boundary (mid-stream and at the
  // end), so the store retains refs whose commit rows later rotate out.
  for (let i = 0; i < 12; i++) {
    ctx.journaler.journal({ type: "gate", n: i, pad: "x".repeat(80) })
    if (i === 5) ctx.journaler.anchor("task-complete")
  }
  ctx.journaler.anchor("task-complete")
  await new Promise((resolve) => setTimeout(resolve, 20))
  const shared = path.join(metricsDir, "turnstile.jsonl")
  assert.ok(fs.existsSync(`${shared}.3`), "rotations produced generation files")
  assert.ok(fs.existsSync(anchors), "anchors published across the pruning boundary")
  const report = await verifyJournalChain({ metricsDir, sinks: [sink], maxGenerations: 3 })
  assert.equal(report.families[0]!.verdict.status, "ok")
  assert.equal(report.ok, true)
})

test("a torn final line is repaired by separation and verify stays ok", async () => {
  const { ctx, metricsDir } = coreWith({ epochEntries: 512 })
  const shared = path.join(metricsDir, "turnstile.jsonl")
  fs.mkdirSync(metricsDir, { recursive: true })
  // A crash mid-append: the last line has no trailing newline.
  fs.writeFileSync(shared, '{"ts":"2026-01-01T00:00:00.000Z","type":"gate","sessionID":"p')
  ctx.journaler.journal({ type: "gate" })
  const lines = fs.readFileSync(shared, "utf8").split("\n").filter(Boolean)
  assert.equal(lines.length, 2)
  const appended = JSON.parse(lines[1]!) as Record<string, unknown>
  assert.equal(typeof appended["hash"], "string")
  // A second append re-validates the head against the tail; the separated
  // torn line makes the cheap scan unusable, so it falls back to a full
  // reseed and the chain continues intact.
  ctx.journaler.journal({ type: "gate" })
  const lines2 = fs.readFileSync(shared, "utf8").split("\n").filter(Boolean)
  assert.equal(lines2.length, 3)
  assert.equal(typeof (JSON.parse(lines2[2]!) as Record<string, unknown>)["hash"], "string")
  const report = await verifyJournalChain({ metricsDir, sinks: [] })
  assert.equal(report.ok, true)
  // A chained-looking row without a seq also makes the tail scan unusable;
  // the next append falls back to the full reseed and still lands (the
  // hostile row itself is a broken link, so no verify is asserted here).
  fs.appendFileSync(shared, JSON.stringify({ ts: "t", type: "x", hash: "abc" }) + "\n")
  ctx.journaler.journal({ type: "gate" })
  const lines3 = fs.readFileSync(shared, "utf8").split("\n").filter(Boolean)
  assert.equal(
    typeof (JSON.parse(lines3[lines3.length - 1]!) as Record<string, unknown>)["hash"],
    "string",
  )
  // The repair also fires on an empty file (nothing to separate) and the
  // append still lands cleanly.
  const empty = path.join(metricsDir, "empty.jsonl")
  fs.writeFileSync(empty, "")
  appendLine(empty, "x")
  assert.equal(fs.readFileSync(empty, "utf8"), "x\n")
})

test("session idle fires the session-end anchor and publishes the pending ref", async () => {
  const { ctx, metricsDir } = coreWith({ epochEntries: 512, verifyOnSessionEnd: false })
  const { sink, refs } = fileSink(path.join(metricsDir, "anchors.jsonl"))
  ctx.journaler.bindAnchorSinks([sink])
  // One journaled row leaves a partial epoch; the session-end anchor closes
  // it and publishes the ref even with verifyOnSessionEnd off.
  ctx.journaler.journal({ type: "a" })
  const handlers = createEventHandlers(ctx)
  await handlers["session.idle"]!({ sessionID: "p1" })
  await waitUntil(() => refs.length > 0)
  assert.equal(refs.length, 1)
  assert.equal(refs[0]!.source, "shared")
})

test("a throwing sink at session end journals the publish error and never throws", async () => {
  const { ctx, metricsDir } = coreWith({ epochEntries: 1, verifyOnSessionEnd: true })
  ctx.journaler.bindAnchorSinks([fileSink(path.join(metricsDir, "anchors.jsonl"), true).sink])
  // The awaited session-end publish fails; the error is journaled
  // fail-open and the idle handler completes (the verify then reports the
  // ref unanchored, since nothing was published).
  ctx.journaler.journal({ type: "a" })
  const handlers = createEventHandlers(ctx)
  await handlers["session.idle"]!({ sessionID: "p1" })
  const errors = journalEntries(metricsDir).filter((r) => r.type === "error")
  assert.ok(errors.some((r) => String(r.error).startsWith("anchor-publish:")))
  const row = journalEntries(metricsDir).find((r) => r.type === "chain-verify")!
  assert.equal(row.ok, false)
})

test("session-end verify counts refs the awaited session-end anchor published", async () => {
  const { ctx, metricsDir } = coreWith({ epochEntries: 1, verifyOnSessionEnd: true })
  const anchors = path.join(metricsDir, "anchors.jsonl")
  const { sink } = fileSink(anchors)
  ctx.journaler.bindAnchorSinks([sink])
  // The verify reads the sinks resolved at setup; point it at the same store
  // the journaler publishes to (full-plugin setups wire these together).
  ctx.anchorSinks = [sink]
  // epochEntries 1 closes an epoch on the first row, leaving a pending ref;
  // the session-end anchor publishes it before the verify runs, so the
  // verdict is ok instead of a false "unanchored epoch refs".
  ctx.journaler.journal({ type: "a" })
  const handlers = createEventHandlers(ctx)
  await handlers["session.idle"]!({ sessionID: "p1" })
  const row = journalEntries(metricsDir).find((r) => r.type === "chain-verify")!
  assert.equal(row.ok, true)
  assert.ok(fs.readFileSync(anchors, "utf8").includes('"source":"shared"'))
})

test("interleaved journaler instances on a shared directory keep one chain", async () => {
  const metricsDir = tmpDir()
  const opts = (): Parameters<typeof createJournaler>[0] => ({
    metricsDir,
    trace: false,
    maxBytes: 5 * 1024 * 1024,
    maxGenerations: 5,
    rotateEveryEntries: 512,
    tamper: { enabled: true, epochEntries: 2 },
  })
  const a = createJournaler(opts())
  const b = createJournaler(opts())
  // a,a match the tail; b seeds fresh; the later writes drift and must
  // resync from the file's tail instead of forking the chain.
  a.journal({ type: "a" })
  a.journal({ type: "b" })
  b.journal({ type: "c" })
  b.journal({ type: "d" })
  a.journal({ type: "e" })
  a.journal({ type: "f" })
  // The chain folds as one continuous sequence with all three epochs intact
  // (refs are unanchored by design here — no sinks are bound).
  const report = await verifyJournalChain({ metricsDir, sinks: [] })
  assert.equal(report.families[0]!.verdict.status, "ok")
  assert.equal(report.refs.length, 3)
  // The resynced writer continues the family's monotonic epoch numbering.
  assert.deepEqual(
    report.refs.map((r) => r.epoch),
    [0, 1, 2],
  )
})

test("verify stays ok when an epoch window straddles a pruned generation", async () => {
  const { ctx, metricsDir } = coreWith({ epochEntries: 3 }, {
    journalMaxBytes: 1,
    journalMaxGenerations: 3,
    journalRotateEveryEntries: 1,
  } as Partial<TurnstileConfig>)
  // Every append rotates (maxBytes 1), so epoch windows straddle generation
  // boundaries and the earliest windows lose data rows to pruning.
  for (let i = 0; i < 10; i++) {
    ctx.journaler.journal({ type: "gate", n: i })
  }
  const report = await verifyJournalChain({ metricsDir, sinks: [], maxGenerations: 3 })
  assert.equal(report.families[0]!.verdict.status, "ok")
  assert.ok(report.refs.length >= 1)
})

test("verify reports an anchored epoch absent from the journal", async () => {
  const metricsDir = tmpDir()
  fs.mkdirSync(metricsDir, { recursive: true })
  // A malformed anchor store fails open: nothing absent, verify ok.
  fs.writeFileSync(path.join(metricsDir, "anchors.jsonl"), "not json\n")
  const clean = await verifyJournalChain({ metricsDir, sinks: [] })
  assert.equal(clean.ok, true)
  assert.equal(clean.absentAnchored.length, 0)
  // A retained anchor naming an epoch the surviving journal no longer
  // contains (its generation was pruned or deleted) must not verify ok.
  fs.writeFileSync(
    path.join(metricsDir, "anchors.jsonl"),
    JSON.stringify({
      sink: "session-state",
      source: "shared",
      epoch: 5,
      root: "r",
      head: "h",
      ts: "t",
    }) + "\n",
  )
  const report = await verifyJournalChain({ metricsDir, sinks: [] })
  assert.equal(report.ok, false)
  assert.deepEqual(report.absentAnchored, ["anchored epoch shared#5 absent from journal"])
})

test("session-end verify reports an anchored epoch absent from the journal", async () => {
  const { ctx, metricsDir } = coreWith({ epochEntries: 512, verifyOnSessionEnd: true })
  fs.mkdirSync(metricsDir, { recursive: true })
  // An anchor retains an epoch the (empty) journal no longer contains: the
  // session-end verdict carries the absent-epoch detail, not "unanchored".
  fs.writeFileSync(
    path.join(metricsDir, "anchors.jsonl"),
    JSON.stringify({
      sink: "session-state",
      source: "shared",
      epoch: 5,
      root: "r",
      head: "h",
      ts: "t",
    }) + "\n",
  )
  const handlers = createEventHandlers(ctx)
  await handlers["session.idle"]!({ sessionID: "p1" })
  const row = journalEntries(metricsDir).find((r) => r.type === "chain-verify")!
  assert.equal(row.ok, false)
  assert.match(String(row.detail), /anchored epoch shared#5 absent from journal/)
})

test("the append-time head resync falls back to a full reseed on hostile tails", async () => {
  const metricsDir = tmpDir()
  const shared = path.join(metricsDir, "turnstile.jsonl")
  fs.mkdirSync(metricsDir, { recursive: true })
  const opts = (): Parameters<typeof createJournaler>[0] => ({
    metricsDir,
    trace: false,
    maxBytes: 5 * 1024 * 1024,
    maxGenerations: 5,
    rotateEveryEntries: 512,
    tamper: { enabled: true, epochEntries: 512 },
  })
  // A legacy unchained row only: the tail scan finds no chained row, and a
  // later resync scan steps over it (inert) to the chained head.
  fs.writeFileSync(shared, JSON.stringify({ ts: "t", type: "old" }) + "\n")
  const j = createJournaler(opts())
  j.journal({ type: "a" })
  j.journal({ type: "b" })
  // An empty current file (the state right after a rotation) gives the scan
  // nothing chained: the resync reseeds from the generations and continues.
  fs.renameSync(shared, `${shared}.1`)
  fs.writeFileSync(shared, "")
  j.journal({ type: "c" })
  // A chain-epoch row with a non-number epoch: the scan still yields a head
  // (epoch index falls back to 0), and the drifted head continues from it.
  fs.appendFileSync(
    shared,
    JSON.stringify({ ts: "t", type: "chain-epoch", epoch: "x", seq: 3, prevHash: "p", hash: "z" }) +
      "\n",
  )
  j.journal({ type: "d" })
  const rows = fs.readFileSync(shared, "utf8").split("\n").filter(Boolean)
  const last = JSON.parse(rows[rows.length - 1]!) as Record<string, unknown>
  assert.equal(last["seq"], 4)
  // A second writer's append drifts the head with no epoch row in the tail:
  // the resync falls back to the full generation reseed and stays continuous.
  const dir2 = tmpDir()
  const opts2 = (): Parameters<typeof createJournaler>[0] => ({
    metricsDir: dir2,
    trace: false,
    maxBytes: 5 * 1024 * 1024,
    maxGenerations: 5,
    rotateEveryEntries: 512,
    tamper: { enabled: true, epochEntries: 512 },
  })
  const a = createJournaler(opts2())
  const b = createJournaler(opts2())
  a.journal({ type: "a" })
  a.journal({ type: "b" })
  b.journal({ type: "c" })
  a.journal({ type: "d" })
  const report = await verifyJournalChain({ metricsDir: dir2, sinks: [] })
  assert.equal(report.families[0]!.verdict.status, "ok")
})

test("a restarted journaler continues the family epoch index after rotation", async () => {
  const metricsDir = tmpDir()
  const opts = (): Parameters<typeof createJournaler>[0] => ({
    metricsDir,
    trace: false,
    maxBytes: 200,
    maxGenerations: 3,
    rotateEveryEntries: 1,
    tamper: { enabled: true, epochEntries: 2 },
  })
  const maxEpoch = (): number => {
    let max = -1
    const files = [path.join(metricsDir, "turnstile.jsonl")]
    for (const gen of [1, 2, 3]) files.push(`${files[0]}.${gen}`)
    for (const f of files) {
      try {
        for (const line of fs.readFileSync(f, "utf8").split("\n")) {
          if (!line.trim()) continue
          const row = JSON.parse(line) as Record<string, unknown>
          if (row["type"] === "chain-epoch" && typeof row["epoch"] === "number") {
            max = Math.max(max, row["epoch"])
          }
        }
      } catch {
        // missing generation: nothing to scan
      }
    }
    return max
  }
  const a = createJournaler(opts())
  for (let i = 0; i < 10; i++) a.journal({ type: "gate", n: i })
  const before = maxEpoch()
  assert.ok(before >= 0, "epochs committed before the restart")
  // A fresh journaler seeds from the surviving generations: its next epoch
  // commit must continue the monotonic index, not restart it.
  const b = createJournaler(opts())
  b.journal({ type: "gate", n: 10 })
  b.journal({ type: "gate", n: 11 })
  assert.equal(maxEpoch(), before + 1)
})

test("epoch indices stay unique across rotation pruning with anchors", async () => {
  const { ctx, metricsDir } = coreWith({ epochEntries: 2 }, {
    journalMaxBytes: 1,
    journalMaxGenerations: 3,
    journalRotateEveryEntries: 1,
  } as Partial<TurnstileConfig>)
  const { sink } = fileSink(path.join(metricsDir, "anchors.jsonl"))
  ctx.journaler.bindAnchorSinks([sink])
  for (let i = 0; i < 30; i++) ctx.journaler.journal({ type: "gate", n: i })
  ctx.journaler.anchor("task-complete")
  await new Promise((resolve) => setTimeout(resolve, 20))
  const report = await verifyJournalChain({ metricsDir, sinks: [sink], maxGenerations: 3 })
  const keys = report.refs.map((r) => `${r.source}#${r.epoch}`)
  assert.equal(new Set(keys).size, keys.length, "no duplicate source#epoch in the fold")
  assert.equal(report.ok, true)
})

test("a corrupt epoch tail reseeds from the max committed index", async () => {
  const metricsDir = tmpDir()
  const shared = path.join(metricsDir, "turnstile.jsonl")
  const opts = (): Parameters<typeof createJournaler>[0] => ({
    metricsDir,
    trace: false,
    maxBytes: 5 * 1024 * 1024,
    maxGenerations: 5,
    rotateEveryEntries: 512,
    tamper: { enabled: true, epochEntries: 2 },
  })
  const a = createJournaler(opts())
  for (let i = 0; i < 4; i++) a.journal({ type: "gate", n: i })
  // A hostile tail: a chained chain-epoch row whose epoch field is not a
  // number (its root is wrong, so the fold correctly breaks there).
  fs.appendFileSync(
    shared,
    JSON.stringify({
      ts: "2026-01-01T00:00:00.000Z",
      type: "chain-epoch",
      source: "shared",
      epoch: "bogus",
      count: 0,
      root: "bogus-root",
      head: "",
      seq: 5,
      prevHash: "bogus-prev",
      hash: "bogus-hash",
    }) + "\n",
  )
  // The resync treats the tail as unusable and reseeds fully; the next
  // commit continues from the seeded max (epoch 1 → 2), never a duplicate.
  const b = createJournaler(opts())
  b.journal({ type: "gate", n: 4 })
  b.journal({ type: "gate", n: 5 })
  const epochs = fs
    .readFileSync(shared, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Record<string, unknown>)
    .filter((r) => r["type"] === "chain-epoch" && typeof r["epoch"] === "number")
    .map((r) => r["epoch"] as number)
  assert.deepEqual(epochs, [0, 1, 2])
  // The fold correctly breaks at the corrupt row itself.
  const report = await verifyJournalChain({ metricsDir, sinks: [] })
  assert.equal(report.families[0]!.verdict.status, "broken")
})

test("a retained anchored epoch with a foreign root reports a root mismatch", async () => {
  const metricsDir = tmpDir()
  const shared = path.join(metricsDir, "turnstile.jsonl")
  const s1 = { seq: 0, prevHash: "" }
  const r1 = appendRow(shared, s1, { type: "a" })
  appendRow(shared, s1, {
    type: "chain-epoch",
    source: "shared",
    epoch: 0,
    count: 1,
    root: merkleRoot([r1.hash as string]),
    head: r1.hash,
    ts: "2026-01-01T00:00:00.000Z",
  })
  fs.mkdirSync(metricsDir, { recursive: true })
  // The anchor names the retained index but a root no retained commit
  // carries — the reforged-commit signature, distinct from absence.
  fs.writeFileSync(
    path.join(metricsDir, "anchors.jsonl"),
    JSON.stringify({
      sink: "session-state",
      source: "shared",
      epoch: 0,
      root: "forged-root",
      head: r1.hash,
      ts: "2026-01-01T00:00:01.000Z",
    }) + "\n",
  )
  const report = await verifyJournalChain({ metricsDir, sinks: [] })
  assert.equal(report.ok, false)
  assert.deepEqual(report.absentAnchored, [
    "anchored epoch shared#0 root mismatch (reforged commit?)",
  ])
})

test("hand-deletion of an anchored retained epoch still reports absent", async () => {
  const metricsDir = tmpDir()
  const shared = path.join(metricsDir, "turnstile.jsonl")
  const s1 = { seq: 0, prevHash: "" }
  const r1 = appendRow(shared, s1, { type: "a" })
  appendRow(shared, s1, {
    type: "chain-epoch",
    source: "shared",
    epoch: 0,
    count: 1,
    root: merkleRoot([r1.hash as string]),
    head: r1.hash,
    ts: "2026-01-01T00:00:00.000Z",
  })
  const r2 = appendRow(shared, s1, { type: "b" })
  appendRow(shared, s1, {
    type: "chain-epoch",
    source: "shared",
    epoch: 1,
    count: 1,
    root: merkleRoot([r2.hash as string]),
    head: r2.hash,
    ts: "2026-01-01T00:00:00.000Z",
  })
  fs.mkdirSync(metricsDir, { recursive: true })
  const anchors = path.join(metricsDir, "anchors.jsonl")
  for (const epoch of [0, 1]) {
    fs.appendFileSync(
      anchors,
      JSON.stringify({
        sink: "session-state",
        source: "shared",
        epoch,
        root: epoch === 0 ? merkleRoot([r1.hash as string]) : merkleRoot([r2.hash as string]),
        head: epoch === 0 ? r1.hash : r2.hash,
        ts: "2026-01-01T00:00:01.000Z",
      }) + "\n",
    )
  }
  // Hand-truncate within retained history: drop epoch 1's rows without any
  // rotation. The retained fold still vouches for epoch 0; epoch 1's root
  // matches nothing at or above the lowest retained index → absent.
  const kept = fs.readFileSync(shared, "utf8").split("\n").slice(0, 2)
  fs.writeFileSync(shared, kept.join("\n") + "\n")
  const report = await verifyJournalChain({ metricsDir, sinks: [] })
  assert.equal(report.ok, false)
  assert.deepEqual(report.absentAnchored, ["anchored epoch shared#1 absent from journal"])
})

test("a task retire under tamper evidence journals the epoch and publishes fail-open", async () => {
  const { ctx, metricsDir } = coreWith({ epochEntries: 512 })
  const anchors = path.join(metricsDir, "anchors.jsonl")
  const { sink, refs } = fileSink(anchors)
  ctx.journaler.bindAnchorSinks([sink])
  ctx.journaler.journal({ type: "gate", sessionID: "p1" })
  ctx.journaler.anchor("task-complete", "p1")
  await new Promise((resolve) => setTimeout(resolve, 10))
  const rows = journalEntries(metricsDir)
  assert.ok(rows.some((r) => r.type === "chain-epoch"))
  assert.equal(refs.length, 1)
  assert.ok(fs.existsSync(anchors))
})

test("a throwing sink at task retire journals anchor-publish and the pipeline continues", async () => {
  const { ctx, metricsDir } = coreWith({ epochEntries: 1 })
  const { sink } = fileSink(path.join(metricsDir, "anchors.jsonl"), true)
  ctx.journaler.bindAnchorSinks([sink])
  ctx.journaler.journal({ type: "gate", sessionID: "p1" })
  assert.doesNotThrow(() => ctx.journaler.anchor("task-complete", "p1"))
  await new Promise((resolve) => setTimeout(resolve, 10))
  const errors = journalEntries(metricsDir).filter((r) => r.type === "error")
  assert.ok(errors.some((r) => String(r.error).startsWith("anchor-publish:")))
})

test("session-end verify journals chain-verify when enabled and nothing when off", async () => {
  const metricsDir = tmpDir()
  const h = makeFakeHost({ tui: true })
  const setup = turnstileSetup(h.host, {
    env: isolatedEnv(metricsDir),
    config: {
      metricsDir,
      tamperEvidence: {
        enabled: true,
        anchor: "session-state",
        epochEntries: 512,
        verifyOnSessionEnd: true,
      },
    },
  })
  const dispose = (await setup(h.host)) as () => void
  try {
    await callSession(h, "prompt", { sessionID: "p1" })
    h.pushEvent({ type: "session.idle", properties: { sessionID: "p1" } })
    await waitUntil(() => journalEntries(metricsDir).some((r) => r.type === "chain-verify"))
    const row = journalEntries(metricsDir).find((r) => r.type === "chain-verify")!
    assert.equal(row.ok, true)
  } finally {
    dispose()
  }
})

test("session-end verify journals a failing verdict and toasts on a broken chain", async () => {
  const metricsDir = tmpDir()
  // Seed a tampered shared journal: two chained rows with the first edited.
  const shared = path.join(metricsDir, "turnstile.jsonl")
  const s1 = { seq: 0, prevHash: "" }
  const append = (entry: Record<string, unknown>): void => {
    const ts = "2026-01-01T00:00:00.000Z"
    const payload = { ts, ...entry }
    const hash = recordHash(s1.prevHash, ts, payload)
    fs.mkdirSync(metricsDir, { recursive: true })
    fs.appendFileSync(
      shared,
      JSON.stringify({ ...payload, seq: s1.seq, prevHash: s1.prevHash, hash }) + "\n",
    )
    s1.seq++
    s1.prevHash = hash
  }
  append({ type: "a" })
  append({ type: "b" })
  const lines = fs.readFileSync(shared, "utf8").trim().split("\n")
  const first = JSON.parse(lines[0]!) as Record<string, unknown>
  lines[0] = JSON.stringify({ ...first, type: "edited" })
  fs.writeFileSync(shared, lines.join("\n") + "\n")
  const h = makeFakeHost({ tui: true })
  const setup = turnstile(h.host, {
    env: isolatedEnv(metricsDir),
    config: {
      metricsDir,
      tamperEvidence: {
        enabled: true,
        anchor: "session-state",
        epochEntries: 512,
        verifyOnSessionEnd: true,
      },
    },
  })
  const dispose = (await setup(h.host)) as () => void
  try {
    await callSession(h, "prompt", { sessionID: "p1" })
    h.pushEvent({ type: "session.idle", properties: { sessionID: "p1" } })
    await waitUntil(() => journalEntries(metricsDir).some((r) => r.type === "chain-verify"))
    const row = journalEntries(metricsDir).find((r) => r.type === "chain-verify")!
    assert.equal(row.ok, false)
    assert.match(String(row.detail), /hash mismatch/)
    await waitUntil(() => h.toasts.length > 0)
    assert.match(h.toasts[0]!.message, /chain verify failed/)
  } finally {
    dispose()
  }
})

test("session-end verify journals a chain-verify error when verification throws", async () => {
  const metricsDir = tmpDir()
  // A plugin sink whose id getter passes the shape check once but throws
  // on the verify fan-out's second access makes verification throw
  // synchronously; the handler must journal the failure and never break
  // the idle event.
  const mod = path.join(metricsDir, "hostile-sink.mjs")
  fs.writeFileSync(
    mod,
    `let reads = 0
export default () => ({
  get id() {
    reads++
    if (reads > 1) throw new Error("hostile sink")
    return "hostile"
  },
  trustDomain: "external",
  publish() {},
  verify() { return { status: "missing", detail: "d" } },
})\n`,
  )
  const h = makeFakeHost({ tui: true })
  const setup = turnstile(h.host, {
    env: isolatedEnv(metricsDir),
    config: {
      metricsDir,
      tamperEvidence: {
        enabled: true,
        anchor: { plugin: pathToFileURL(mod).href },
        epochEntries: 512,
        verifyOnSessionEnd: true,
      },
    },
  })
  const dispose = (await setup(h.host)) as () => void
  try {
    await callSession(h, "prompt", { sessionID: "p1" })
    h.pushEvent({ type: "session.idle", properties: { sessionID: "p1" } })
    await waitUntil(() =>
      journalEntries(metricsDir).some((r) => String(r.error ?? "").startsWith("chain-verify:")),
    )
  } finally {
    dispose()
  }
})

test("session-end verify reports unanchored refs on a clean chain", async () => {
  const { ctx, metricsDir } = coreWith({ epochEntries: 1, verifyOnSessionEnd: true })
  // One journaled row closes an epoch on cadence (epochEntries 1); with no
  // sinks bound the ref stays pending, so the chain folds ok but the ref is
  // unanchored.
  ctx.journaler.journal({ type: "a" })
  const handlers = createEventHandlers(ctx)
  await handlers["session.idle"]!({ sessionID: "p1" })
  const row = journalEntries(metricsDir).find((r) => r.type === "chain-verify")!
  assert.equal(row.ok, false)
  assert.equal(row.detail, "unanchored epoch refs")
})

test("setup journals anchor-sink warnings and resolution failures fail-open", async () => {
  const metricsDir = tmpDir()
  // (1) An unknown builtin degrades to a journaled anchor-sink warning.
  const h1 = makeFakeHost()
  const setup1 = turnstile(h1.host, {
    env: isolatedEnv(metricsDir),
    config: {
      metricsDir,
      tamperEvidence: {
        enabled: true,
        anchor: "no-such-sink",
        epochEntries: 512,
        verifyOnSessionEnd: false,
      },
    },
  })
  const dispose1 = (await setup1(h1.host)) as () => void
  dispose1()
  assert.ok(
    journalEntries(metricsDir).some((r) =>
      String(r.error ?? "").includes('anchor-sink: unknown builtin sink "no-such-sink"'),
    ),
  )
  // (2) A plugin sink whose id getter throws during the shape check makes
  // resolution itself throw; setup journals the failure and still registers
  // hooks.
  const mod = path.join(metricsDir, "hostile2.mjs")
  fs.writeFileSync(
    mod,
    `export default () => ({
  get id() {
    throw new Error("hostile bind")
  },
  trustDomain: "external",
  publish() {},
  verify() { return { status: "missing", detail: "d" } },
})\n`,
  )
  const metricsDir2 = tmpDir()
  const h2 = makeFakeHost()
  const setup2 = turnstile(h2.host, {
    env: isolatedEnv(metricsDir2),
    config: {
      metricsDir: metricsDir2,
      tamperEvidence: {
        enabled: true,
        anchor: { plugin: pathToFileURL(mod).href },
        epochEntries: 512,
        verifyOnSessionEnd: false,
      },
    },
  })
  const dispose2 = (await setup2(h2.host)) as () => void
  dispose2()
  assert.ok(
    journalEntries(metricsDir2).some((r) =>
      String(r.error ?? "").startsWith("anchor-sink: resolution failed:"),
    ),
  )
  assert.ok(Object.keys(h2.toolHooks).length > 0, "hooks still registered")
})

test("session-end verify runs even when sessionSummary is off", async () => {
  const { ctx, metricsDir } = coreWith(
    { epochEntries: 1, verifyOnSessionEnd: true },
    { sessionSummary: "off" },
  )
  ctx.journaler.journal({ type: "a" })
  const handlers = createEventHandlers(ctx)
  await handlers["session.idle"]!({ sessionID: "p1" })
  const rows = journalEntries(metricsDir)
  assert.ok(
    rows.some((r) => r.type === "chain-verify"),
    "chain-verify journaled",
  )
  assert.equal(
    rows.some((r) => r.type === "session-summary"),
    false,
  )
})

test("session-end verify stays silent when verifyOnSessionEnd is off", async () => {
  const metricsDir = tmpDir()
  const h = makeFakeHost({ tui: true })
  const setup = turnstileSetup(h.host, {
    env: isolatedEnv(metricsDir),
    config: {
      metricsDir,
      tamperEvidence: {
        enabled: true,
        anchor: "session-state",
        epochEntries: 512,
        verifyOnSessionEnd: false,
      },
    },
  })
  const dispose = (await setup(h.host)) as () => void
  try {
    await callSession(h, "prompt", { sessionID: "p1" })
    h.pushEvent({ type: "session.idle", properties: { sessionID: "p1" } })
    await new Promise((resolve) => setTimeout(resolve, 50))
    assert.equal(journalEntries(metricsDir).filter((r) => r.type === "chain-verify").length, 0)
  } finally {
    dispose()
  }
})
