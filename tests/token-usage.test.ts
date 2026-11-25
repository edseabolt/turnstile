/**
 * @fileoverview Token-usage boundary tests: `extractUsage` accepts only
 * completed assistant snapshots (dual cache nesting, either completion
 * signal, zero defaults for absent fields), `extractStepUsage` reads the
 * 2.4.1 `session.step.ended` payload, `addTotals` sums componentwise, and
 * the `message.updated` / `session.step.ended` wiring journals deduped
 * per-message rows or one session-rollup row per session-end trigger
 * (`session.idle`, `session.execution.succeeded`, `session.execution.failed`),
 * including cross-contract no-double-count and the placement guarantee
 * that the rollup flushes even when `sessionSummary` is `"off"`.
 */

import { test } from "node:test"
import assert from "node:assert/strict"
import * as fs from "node:fs"
import * as path from "node:path"

import { turnstile } from "../turnstile.ts"
import { addTotals, extractStepUsage, extractUsage, zeroTotals } from "../src/token-usage.ts"
import { createHooksCore } from "../src/hooks-core.ts"
import { startEventStream } from "../src/hooks-events.ts"
import {
  isolatedEnv,
  journalEntries,
  makeFakeHost,
  tmpDir,
  waitUntil,
  type FakeHost,
} from "./helpers.ts"

/** A completed assistant snapshot with the issue-derived payload shape. */
const assistantInfo = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: "msg_1",
  role: "assistant",
  finish: "stop",
  modelID: "m",
  providerID: "p",
  tokens: { input: 10, output: 5, reasoning: 2, cache: { read: 7, write: 3 } },
  cost: 0.01,
  ...overrides,
})

/** The journal's token-usage entries. */
const usageEntries = (metricsDir: string): Array<Record<string, any>> =>
  journalEntries(metricsDir).filter((e) => e.type === "token-usage")

/**
 * Boots the plugin on a fake host with injected config overrides, returning
 * the disposer, the metrics dir, and the fake-host tables.
 * @param configOverrides Config overrides applied last (tests).
 */
async function boot(
  configOverrides: Record<string, unknown> = {},
): Promise<{ dispose: () => void; metricsDir: string; fake: FakeHost }> {
  const h = makeFakeHost()
  const metricsDir = tmpDir()
  const setup = turnstile(h.host, {
    env: isolatedEnv(metricsDir),
    config: { metricsDir, ...configOverrides },
  })
  const dispose = (await setup(h.host)) as () => void
  return { dispose, metricsDir, fake: h }
}

// ── pure layer: extractUsage / addTotals / zeroTotals ──

/** A completed assistant snapshot extracts with both cache nestings honored. */
test("extractUsage reads a completed assistant snapshot", () => {
  const usage = extractUsage(assistantInfo())
  assert.ok(usage)
  assert.equal(usage.messageID, "msg_1")
  assert.equal(usage.modelID, "m")
  assert.equal(usage.providerID, "p")
  assert.deepEqual(usage.totals, {
    input: 10,
    output: 5,
    reasoning: 2,
    cacheRead: 7,
    cacheWrite: 3,
    cost: 0.01,
  })
})

/** The flat `info.cache.{read,write}` nesting is accepted alongside the
 *  nested `tokens.cache` one. */
test("extractUsage accepts the flat info.cache nesting", () => {
  const usage = extractUsage(assistantInfo({ tokens: { input: 1 }, cache: { read: 9, write: 8 } }))
  assert.ok(usage)
  assert.equal(usage.totals.cacheRead, 9)
  assert.equal(usage.totals.cacheWrite, 8)
})

/** A `time.completed` number is a completion signal on its own. */
test("extractUsage accepts time.completed as the completion signal", () => {
  const info = assistantInfo()
  delete info.finish
  info.time = { completed: 1700000000000 }
  const usage = extractUsage(info)
  assert.ok(usage, "time.completed alone completes the snapshot")
})

/** Absent or non-numeric token/cost fields default to 0. */
test("extractUsage defaults absent fields to zero", () => {
  const usage = extractUsage({ id: "msg_2", role: "assistant", finish: "stop" })
  assert.ok(usage)
  assert.deepEqual(usage.totals, zeroTotals())
})

/** Non-assistant roles are inert. */
test("extractUsage rejects a non-assistant role", () => {
  assert.equal(extractUsage(assistantInfo({ role: "user" })), null)
})

/** An incomplete snapshot (no completion signal) is inert. */
test("extractUsage rejects an incomplete snapshot", () => {
  const info = assistantInfo()
  delete info.finish
  assert.equal(extractUsage(info), null)
})

/** Missing or non-object info payloads are inert. */
test("extractUsage rejects missing and malformed payloads", () => {
  assert.equal(extractUsage(undefined), null)
  assert.equal(extractUsage(null), null)
  assert.equal(extractUsage("assistant"), null)
  assert.equal(extractUsage(assistantInfo({ id: "" })), null)
})

/** addTotals sums componentwise without mutating its inputs. */
test("addTotals sums componentwise", () => {
  const a = { ...zeroTotals(), input: 1, cost: 0.5 }
  const b = { ...zeroTotals(), input: 2, cacheRead: 4, cost: 0.25 }
  assert.deepEqual(addTotals(a, b), {
    input: 3,
    output: 0,
    reasoning: 0,
    cacheRead: 4,
    cacheWrite: 0,
    cost: 0.75,
  })
  assert.equal(a.input, 1, "the running totals are not mutated")
})

// ── pure layer: extractStepUsage (the 2.4.1 step carrier) ──

/** A full `session.step.ended` payload extracts message, session, totals. */
test("extractStepUsage reads a full step payload", () => {
  const usage = extractStepUsage({
    sessionID: "p1",
    assistantMessageID: "msg_1",
    finish: "stop",
    tokens: { input: 10, output: 5, reasoning: 2, cache: { read: 7, write: 3 } },
    cost: 0.01,
  })
  assert.ok(usage)
  assert.equal(usage.messageID, "msg_1")
  assert.equal(usage.sessionID, "p1")
  assert.deepEqual(usage.totals, {
    input: 10,
    output: 5,
    reasoning: 2,
    cacheRead: 7,
    cacheWrite: 3,
    cost: 0.01,
  })
})

/** Missing or empty session/assistant message IDs are inert. */
test("extractStepUsage rejects a missing sessionID or assistantMessageID", () => {
  assert.equal(extractStepUsage({ assistantMessageID: "msg_1" }), null)
  assert.equal(extractStepUsage({ sessionID: "p1", assistantMessageID: "" }), null)
  assert.equal(extractStepUsage({ sessionID: "", assistantMessageID: "msg_1" }), null)
})

/** Non-object payloads are inert. */
test("extractStepUsage rejects non-object payloads", () => {
  assert.equal(extractStepUsage(undefined), null)
  assert.equal(extractStepUsage(null), null)
  assert.equal(extractStepUsage("p1"), null)
})

/** Absent tokens/cost degrade to zero totals; both cache nestings honored. */
test("extractStepUsage defaults absent fields to zero and reads both cache nestings", () => {
  const usage = extractStepUsage({ sessionID: "p1", assistantMessageID: "msg_1" })
  assert.ok(usage)
  assert.deepEqual(usage.totals, zeroTotals())
  const flat = extractStepUsage({
    sessionID: "p1",
    assistantMessageID: "msg_1",
    tokens: { input: 1 },
    cache: { read: 9, write: 8 },
  })
  assert.ok(flat)
  assert.equal(flat.totals.cacheRead, 9)
  assert.equal(flat.totals.cacheWrite, 8)
})

// ── wiring: message.updated + session.idle ──

/** `off` journals no rows and accumulates nothing. */
test("tokenUsage off journals nothing on message.updated", async () => {
  const { dispose, metricsDir, fake } = await boot({ tokenUsage: "off" })
  await pushUpdated(fake, "p1", assistantInfo())
  assert.equal(usageEntries(metricsDir).length, 0)
  dispose()
})

/**
 * Pushes a message.updated event through the fake host's event stream in the
 * real host's shape: the session ID lives only inside the snapshot
 * (`info.sessionID`); no top-level `sessionID` is sent.
 * @param fake The fake-host wrapper.
 * @param sid The session the message belongs to.
 * @param info The message snapshot payload.
 */
async function pushUpdated(fake: FakeHost, sid: string, info: unknown): Promise<void> {
  await fake.pushEvent({
    type: "message.updated",
    data: { info: { ...(info as Record<string, unknown>), sessionID: sid } },
  })
}

/** per-message journals one deduped row per completed assistant turn. */
test("per-message journals one deduped row with the parent stamp", async () => {
  const { dispose, metricsDir, fake } = await boot({ tokenUsage: "per-message" })
  await fake.pushEvent({
    type: "session.created",
    data: { sessionID: "c1", parentID: "p1", agent: "executor" },
  })
  await pushUpdated(fake, "c1", assistantInfo())
  await pushUpdated(fake, "c1", assistantInfo())
  const rows = usageEntries(metricsDir)
  assert.equal(rows.length, 1, "the duplicate messageID is suppressed")
  assert.equal(rows[0]!.sessionID, "c1")
  assert.equal(rows[0]!.parentID, "p1")
  assert.equal(rows[0]!.messageID, "msg_1")
  assert.equal(rows[0]!.modelID, "m")
  assert.equal(rows[0]!.providerID, "p")
  assert.equal(rows[0]!.tokens.cacheRead, 7)
  assert.equal(rows[0]!.cost, 0.01)
  dispose()
})

/** summary mode journals no per-turn rows; idle emits one merged rollup. */
test("summary mode rolls up merged totals once at idle", async () => {
  const { dispose, metricsDir, fake } = await boot({ tokenUsage: "summary" })
  await pushUpdated(fake, "p1", assistantInfo())
  await pushUpdated(fake, "p1", assistantInfo({ id: "msg_2", cost: 0.02 }))
  assert.equal(usageEntries(metricsDir).length, 0, "no per-turn rows in summary mode")
  await fake.pushEvent({ type: "session.idle", data: { sessionID: "p1" } })
  const rows = usageEntries(metricsDir)
  assert.equal(rows.length, 1)
  assert.equal(rows[0]!.event, "session-rollup")
  assert.equal(rows[0]!.sessionID, "p1")
  assert.equal(rows[0]!.parentID, "p1", "a parent session resolves to its own ID")
  assert.equal(rows[0]!.tokens.input, 20)
  assert.equal(rows[0]!.tokens.output, 10)
  assert.equal(rows[0]!.tokens.reasoning, 4)
  assert.equal(rows[0]!.tokens.cacheRead, 14)
  assert.equal(rows[0]!.tokens.cacheWrite, 6)
  assert.ok(Math.abs(rows[0]!.cost - 0.03) < 1e-9)
  assert.equal(rows[0]!.messageID, undefined, "rollups carry no messageID")
  await fake.pushEvent({ type: "session.idle", data: { sessionID: "p1" } })
  assert.equal(usageEntries(metricsDir).length, 1, "the accumulator is cleared after the rollup")
  dispose()
})

/** Idle with an empty accumulator journals no rollup row. */
test("idle with no token traffic journals no rollup", async () => {
  const { dispose, metricsDir, fake } = await boot()
  await fake.pushEvent({ type: "session.idle", data: { sessionID: "p1" } })
  assert.equal(usageEntries(metricsDir).length, 0)
  dispose()
})

/** The rollup flush sits before the sessionSummary early returns: it emits
 *  even when sessionSummary is "off". */
test("idle flushes the rollup even with sessionSummary off", async () => {
  const { dispose, metricsDir, fake } = await boot({
    sessionSummary: "off",
    tokenUsage: "summary",
  })
  await pushUpdated(fake, "p1", assistantInfo())
  await fake.pushEvent({ type: "session.idle", data: { sessionID: "p1" } })
  const rows = usageEntries(metricsDir)
  assert.equal(rows.length, 1, "the rollup emits despite sessionSummary off")
  assert.equal(rows[0]!.event, "session-rollup")
  assert.equal(rows[0]!.tokens.input, 10)
  dispose()
})

/** A message.updated without a string sessionID is inert (no row, no
 *  accumulation under a synthetic key). */
test("message.updated without a sessionID is inert", async () => {
  const { dispose, metricsDir, fake } = await boot({ tokenUsage: "per-message" })
  await fake.pushEvent({ type: "message.updated", data: { info: assistantInfo() } })
  assert.equal(usageEntries(metricsDir).length, 0)
  await fake.pushEvent({ type: "session.idle", data: { sessionID: "p1" } })
  assert.equal(usageEntries(metricsDir).length, 0, "nothing accumulated either")
  dispose()
})

/** A snapshot-carried session ID (`info.sessionID`, the real host shape)
 *  resolves the session with no top-level `sessionID` present. */
test("message.updated resolves the session from info.sessionID", async () => {
  const { dispose, metricsDir, fake } = await boot({ tokenUsage: "summary" })
  await pushUpdated(fake, "p1", assistantInfo())
  await fake.pushEvent({ type: "session.idle", data: { sessionID: "p1" } })
  const rows = usageEntries(metricsDir)
  assert.equal(rows.length, 1)
  assert.equal(rows[0]!.sessionID, "p1", "the snapshot's session ID is used")
  dispose()
})

/** A top-level `properties.sessionID` (a legacy host shape) still journals. */
test("message.updated tolerates a top-level sessionID", async () => {
  const { dispose, metricsDir, fake } = await boot({ tokenUsage: "summary" })
  await fake.pushEvent({
    type: "message.updated",
    data: { sessionID: "p1", info: assistantInfo() },
  })
  await fake.pushEvent({ type: "session.idle", data: { sessionID: "p1" } })
  const rows = usageEntries(metricsDir)
  assert.equal(rows.length, 1)
  assert.equal(rows[0]!.sessionID, "p1")
  dispose()
})

/** The accumulator is bounded: sessions past maxSessions are evicted. */
test("the token-usage accumulator is bounded by maxSessions", async () => {
  const { dispose, metricsDir, fake } = await boot({ maxSessions: 2 })
  for (const sid of ["s1", "s2", "s3"]) {
    await pushUpdated(fake, sid, assistantInfo({ id: `msg_${sid}` }))
  }
  await fake.pushEvent({ type: "session.idle", data: { sessionID: "s3" } })
  const rows = usageEntries(metricsDir)
  assert.equal(rows.length, 1, "only the surviving session rolls up")
  assert.equal(rows[0]!.sessionID, "s3")
  dispose()
})

// ── wiring: session.step.ended + session.execution.* (the 2.4.1 contract) ──

/**
 * Pushes a `session.step.ended` event through the fake host's event stream
 * in the 2.4.1 shape: `sessionID`, `assistantMessageID`, `finish`, `tokens`,
 * and `cost` at the top level.
 * @param fake The fake-host wrapper.
 * @param sid The session the step belongs to.
 * @param overrides Field overrides (e.g. a distinct `assistantMessageID`).
 */
async function pushStepEnded(
  fake: FakeHost,
  sid: string,
  overrides: Record<string, unknown> = {},
): Promise<void> {
  await fake.pushEvent({
    type: "session.step.ended",
    data: {
      sessionID: sid,
      assistantMessageID: overrides.id ?? "msg_1",
      finish: "stop",
      tokens: { input: 10, output: 5 },
      cost: 0.01,
      ...overrides,
    },
  })
}

/** Steps accumulate and `session.execution.succeeded` flushes one rollup. */
test("session.step.ended accumulates and session.execution.succeeded flushes", async () => {
  const { dispose, metricsDir, fake } = await boot({ tokenUsage: "summary" })
  await pushStepEnded(fake, "p1")
  await pushStepEnded(fake, "p1", { id: "msg_2", cost: 0.02 })
  await fake.pushEvent({ type: "session.execution.succeeded", data: { sessionID: "p1" } })
  const rows = usageEntries(metricsDir)
  assert.equal(rows.length, 1)
  assert.equal(rows[0]!.event, "session-rollup")
  assert.equal(rows[0]!.sessionID, "p1")
  assert.equal(rows[0]!.tokens.input, 20)
  assert.ok(Math.abs(rows[0]!.cost - 0.03) < 1e-9)
  await fake.pushEvent({ type: "session.execution.succeeded", data: { sessionID: "p1" } })
  assert.equal(usageEntries(metricsDir).length, 1, "the second trigger is deduped")
  dispose()
})

/** `session.execution.failed` also flushes the rollup (failed runs still
 *  spent tokens). */
test("session.execution.failed flushes the rollup", async () => {
  const { dispose, metricsDir, fake } = await boot({ tokenUsage: "summary" })
  await pushStepEnded(fake, "p1")
  await fake.pushEvent({ type: "session.execution.failed", data: { sessionID: "p1" } })
  const rows = usageEntries(metricsDir)
  assert.equal(rows.length, 1)
  assert.equal(rows[0]!.event, "session-rollup")
  assert.equal(rows[0]!.tokens.input, 10)
  dispose()
})

/** per-message mode journals one row per step with empty model/provider. */
test("per-message journals step rows with empty modelID and providerID", async () => {
  const { dispose, metricsDir, fake } = await boot({ tokenUsage: "per-message" })
  await pushStepEnded(fake, "p1")
  const rows = usageEntries(metricsDir)
  assert.equal(rows.length, 1)
  assert.equal(rows[0]!.messageID, "msg_1")
  assert.equal(rows[0]!.modelID, "")
  assert.equal(rows[0]!.providerID, "")
  assert.equal(rows[0]!.tokens.input, 10)
  dispose()
})

/** A duplicate `session.step.ended` for the same assistant message ID is
 *  suppressed. */
test("duplicate session.step.ended for the same message ID counts once", async () => {
  const { dispose, metricsDir, fake } = await boot({ tokenUsage: "per-message" })
  await pushStepEnded(fake, "p1")
  await pushStepEnded(fake, "p1")
  assert.equal(usageEntries(metricsDir).length, 1)
  dispose()
})

/** A turn emitted through both contracts counts once (shared dedup key). */
test("a turn emitted through both contracts counts once", async () => {
  const { dispose, metricsDir, fake } = await boot({ tokenUsage: "per-message" })
  await pushUpdated(fake, "p1", assistantInfo({ id: "msg_x" }))
  await pushStepEnded(fake, "p1", { id: "msg_x" })
  assert.equal(usageEntries(metricsDir).length, 1)
  dispose()
})

/** `tokenUsage: "off"` keeps the step path fully inert. */
test("tokenUsage off journals nothing on session.step.ended", async () => {
  const { dispose, metricsDir, fake } = await boot({ tokenUsage: "off" })
  await pushStepEnded(fake, "p1")
  await fake.pushEvent({ type: "session.execution.succeeded", data: { sessionID: "p1" } })
  assert.equal(usageEntries(metricsDir).length, 0)
  dispose()
})

/** An execution trigger with no token traffic journals no rollup row. */
test("session.execution.succeeded with no token traffic journals no rollup", async () => {
  const { dispose, metricsDir, fake } = await boot()
  await fake.pushEvent({ type: "session.execution.succeeded", data: { sessionID: "p1" } })
  assert.equal(usageEntries(metricsDir).length, 0)
  dispose()
})

/** A step event without a usable session or message ID is inert. */
test("session.step.ended without sessionID or assistantMessageID is inert", async () => {
  const { dispose, metricsDir, fake } = await boot({ tokenUsage: "per-message" })
  await fake.pushEvent({ type: "session.step.ended", data: { finish: "stop" } })
  await fake.pushEvent({ type: "session.step.ended", data: { sessionID: "p1" } })
  assert.equal(usageEntries(metricsDir).length, 0)
  dispose()
})

/** An execution trigger without a sessionID is inert (tolerated payload). */
test("session.execution.succeeded without a sessionID is inert", async () => {
  const { dispose, metricsDir, fake } = await boot({ tokenUsage: "summary" })
  await pushStepEnded(fake, "p1")
  await fake.pushEvent({ type: "session.execution.succeeded", data: {} })
  assert.equal(usageEntries(metricsDir).length, 0, "no flush happened")
  await fake.pushEvent({ type: "session.execution.succeeded", data: { sessionID: "p1" } })
  assert.equal(usageEntries(metricsDir).length, 1, "the later valid trigger still flushes")
  dispose()
})

/** A throwing dependency inside the awaited execution handler is journaled
 *  by the consume loop, never an unhandled rejection: `handleExecutionEnded`
 *  awaits `runSessionEnd`, so the loop's per-event catch sees the throw. */
test("a throwing execution handler journals the failure via the consume loop", async () => {
  const metricsDir = tmpDir()
  const ctx = createHooksCore({ env: isolatedEnv(metricsDir), config: { metricsDir } })
  ctx.journaler.anchorAsync = async () => {
    throw new Error("boom")
  }
  const controller = new AbortController()
  async function* subscribe(): AsyncIterable<{ type: string; data?: unknown }> {
    yield { type: "session.execution.succeeded", data: { sessionID: "p1" } }
  }
  const stopped = startEventStream(
    ctx,
    subscribe as unknown as (options?: { signal?: AbortSignal }) => AsyncIterable<never>,
    controller.signal,
  )
  await waitUntil(() =>
    journalEntries(metricsDir).some(
      (l) => l.type === "error" && String(l.error).startsWith("event session.execution.succeeded:"),
    ),
  )
  controller.abort()
  await stopped
})

/**
 * Starts the event stream on a bare `createHooksCore` context with a
 * two-event 2.4.1 script (one token-bearing step, then the execution
 * trigger), the shared shape of the ordering tests below.
 * @param ctx The hooks core context (journaler stubbed by the caller).
 * @returns The abort controller and the supervision promise (never awaited
 *     by the pending-anchor test: the stream parks on the stubbed await).
 */
function startOrderingStream(ctx: ReturnType<typeof createHooksCore>): {
  controller: AbortController
  stopped: Promise<unknown>
} {
  const controller = new AbortController()
  async function* subscribe(): AsyncIterable<{ type: string; data?: unknown }> {
    yield {
      type: "session.step.ended",
      data: {
        sessionID: "p1",
        assistantMessageID: "msg_1",
        finish: "stop",
        tokens: { input: 10, output: 5 },
        cost: 0.01,
      },
    }
    yield { type: "session.execution.succeeded", data: { sessionID: "p1" } }
  }
  const stopped = startEventStream(
    ctx,
    subscribe as unknown as (options?: { signal?: AbortSignal }) => AsyncIterable<never>,
    controller.signal,
  )
  return { controller, stopped }
}

/** The rollup row is journaled before the session-end anchor await: a
 *  forever-pending `anchorAsync` (the headless teardown window) still
 *  leaves the rollup row in the journal. */
test("rollup row lands even when the session-end anchor never resolves", async () => {
  const metricsDir = tmpDir()
  const ctx = createHooksCore({
    env: isolatedEnv(metricsDir),
    config: { metricsDir, tokenUsage: "summary" },
  })
  ctx.journaler.anchorAsync = () => new Promise(() => {})
  const { controller } = startOrderingStream(ctx)
  await waitUntil(() => usageEntries(metricsDir).length === 1)
  controller.abort()
})

/** The rollup row also survives a session-end verify that throws after the
 *  anchor: the flush precedes the verify await, and the verify failure is
 *  journaled fail-open. */
test("rollup row lands when the session-end verify throws after the anchor", async () => {
  const metricsDir = tmpDir()
  const ctx = createHooksCore({
    env: isolatedEnv(metricsDir),
    config: {
      metricsDir,
      tokenUsage: "summary",
      tamperEvidence: {
        enabled: true,
        anchor: "session-state",
        epochEntries: 512,
        verifyOnSessionEnd: true,
      },
    },
  })
  Object.defineProperty(ctx, "anchorSinks", {
    get(): unknown {
      throw new Error("verify boom")
    },
  })
  const { controller, stopped } = startOrderingStream(ctx)
  await waitUntil(() =>
    journalEntries(metricsDir).some(
      (l) => l.type === "error" && String(l.error).startsWith("chain-verify:"),
    ),
  )
  assert.equal(usageEntries(metricsDir).length, 1, "the rollup row precedes the verify")
  controller.abort()
  await stopped
})

/** Summary-mode totals include the rollup: the flush is journaled before
 *  the summary's journal read, so the recap line carries the tokens. */
test("summary-mode totals include the rollup: flush precedes the summary journal read", async () => {
  const { dispose, metricsDir, fake } = await boot({
    tokenUsage: "summary",
    sessionSummary: "on",
  })
  fs.appendFileSync(
    path.join(metricsDir, "turnstile.jsonl"),
    JSON.stringify({ type: "gate", sessionID: "p1", result: "PASS" }) + "\n",
  )
  await pushStepEnded(fake, "p1")
  await fake.pushEvent({ type: "session.execution.succeeded", data: { sessionID: "p1" } })
  const summary = journalEntries(metricsDir).find((e) => e.type === "session-summary")
  assert.ok(summary, "the summary proof row is journaled")
  assert.match(String(summary!.text), /10 in\/5 out tok/)
  dispose()
})
