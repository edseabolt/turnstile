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
import { createHooksCore, type TurnstileContext } from "../src/hooks-core.ts"
import { createEventHandlers } from "../src/event-stream-handlers.ts"
import { verifyJournalChain } from "../src/verify.ts"
import type { AnchorRef, AnchorSink, TurnstileConfig } from "../src/types.ts"
import {
  callSession,
  callTool,
  isolatedEnv,
  journalEntries,
  makeFakeHost,
  tmpDir,
  waitUntil,
} from "./helpers.ts"
import { turnstile } from "../turnstile.ts"

void callTool

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
