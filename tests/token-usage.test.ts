/**
 * @fileoverview Token-usage boundary tests: `extractUsage` accepts only
 * completed assistant snapshots (dual cache nesting, either completion
 * signal, zero defaults for absent fields), `addTotals` sums componentwise,
 * and the `message.updated` / `session.idle` wiring journals deduped
 * per-message rows or one session-rollup row per idle — including the
 * placement guarantee that the rollup flushes even when `sessionSummary` is
 * `"off"`.
 */

import { test } from "node:test"
import assert from "node:assert/strict"

import { turnstile } from "../turnstile.ts"
import { addTotals, extractUsage, zeroTotals } from "../src/token-usage.ts"
import { isolatedEnv, journalEntries, makeFakeHost, tmpDir, type FakeHost } from "./helpers.ts"

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
