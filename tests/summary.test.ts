/**
 * @fileoverview Session-summary boundary tests: `countSessionActivity` derives
 * counts from this session's journal entries only (wrong-session entries and
 * the promoted-PASS duplicate are excluded), `formatSessionSummary`
 * singularizes 1-counts and names the journal, `formatAllGreenLine` renders
 * the zero-activity line, `isInactive` gates the quiet-silent condition, and
 * `readJournalEntries` fails open on a missing/unreadable file and skips
 * malformed lines. Pure layer — no host, no wiring.
 */

import { test } from "node:test"
import assert from "node:assert/strict"
import * as fs from "node:fs"
import * as path from "node:path"

import { turnstile } from "../turnstile.ts"
import { readJournalEntries } from "../src/journal.ts"
import type { Host } from "../src/types.ts"
import {
  countSessionActivity,
  formatAllGreenLine,
  formatSessionSummary,
  isInactive,
} from "../src/summary.ts"
import { isolatedEnv, journalEntries, makeFakeHost, tmpDir, type FakeHost } from "./helpers.ts"

/** A gate PASS marker first-sight entry for a parent. */
const pass = (sid: string): Record<string, unknown> => ({
  type: "gate",
  sessionID: sid,
  result: "PASS",
})

/** A promoted PASS entry (the promote-on-evidence duplicate). */
const promoted = (sid: string): Record<string, unknown> => ({
  type: "gate",
  sessionID: sid,
  result: "PASS",
  event: "promoted",
  verified: true,
})

/** A blocked dispatch entry. */
const blockedDispatch = (sid: string): Record<string, unknown> => ({
  type: "dispatch",
  sessionID: sid,
  agent: "executor",
  description: "",
  blocked: true,
})

/** A waived gate entry (prompt-channel waiver). */
const waived = (sid: string): Record<string, unknown> => ({
  type: "gate",
  sessionID: sid,
  result: "WAIVED",
  channel: "prompt",
})

/** Active-session fixture: two claims (one promoted), one block, one waiver. */
const activeEntries = (sid: string): Array<Record<string, unknown>> => [
  pass(sid),
  promoted(sid),
  blockedDispatch(sid),
  waived(sid),
]

/** `countSessionActivity` counts only entries whose sessionID matches. */
test("countSessionActivity derives counts from matching entries only", () => {
  const counts = countSessionActivity(
    [...activeEntries("p1"), pass("p2"), blockedDispatch("p2"), waived("other")],
    "p1",
  )
  assert.deepEqual(counts, { verified: 1, blockedDispatches: 1, waivers: 1 })
})

/** The `event:"promoted"` filter prevents a promoted claim double-counting. */
test("countSessionActivity does not double-count a promoted PASS", () => {
  const counts = countSessionActivity(
    [pass("p1"), pass("p1"), promoted("p1"), promoted("p1")],
    "p1",
  )
  assert.equal(counts.verified, 2)
})

/** A standalone promoted entry (no marker entry in the window — reachable
 *  only via a journal-rotation straddle) still counts zero, per the filter. */
test("countSessionActivity excludes a standalone promoted PASS entry", () => {
  const counts = countSessionActivity([promoted("p1")], "p1")
  assert.deepEqual(counts, { verified: 0, blockedDispatches: 0, waivers: 0 })
})

/** Mixed non-matching entries (other types, other results) are ignored. */
test("countSessionActivity ignores non-counted entry shapes", () => {
  const counts = countSessionActivity(
    [
      { type: "gate", sessionID: "p1", result: "FAIL" },
      { type: "verdict", sessionID: "p1", marker: "VERDICT: APPROVE" },
      { type: "dispatch", sessionID: "p1", agent: "reviewer" },
      { type: "setup", digest: "x" },
    ],
    "p1",
  )
  assert.deepEqual(counts, { verified: 0, blockedDispatches: 0, waivers: 0 })
})

/** Every count zero is the inactive condition; any activity is not. */
test("isInactive is true only when all counts are zero", () => {
  assert.equal(isInactive({ verified: 0, blockedDispatches: 0, waivers: 0 }), true)
  assert.equal(isInactive({ verified: 1, blockedDispatches: 0, waivers: 0 }), false)
  assert.equal(isInactive({ verified: 0, blockedDispatches: 2, waivers: 0 }), false)
  assert.equal(isInactive({ verified: 0, blockedDispatches: 0, waivers: 1 }), false)
})

/** The recap line matches the issue's example wording with singular nouns. */
test("formatSessionSummary singularizes 1-counts and names the journal", () => {
  assert.equal(
    formatSessionSummary({ verified: 5, blockedDispatches: 1, waivers: 0 }, "/m/t.jsonl"),
    "turnstile: 5 test-claims verified · 1 premature dispatch blocked · 0 waivers · journal /m/t.jsonl",
  )
})

/** Zero and ≥2 counts use the plural noun forms. */
test("formatSessionSummary pluralizes 0 and multi-counts", () => {
  assert.equal(
    formatSessionSummary({ verified: 0, blockedDispatches: 2, waivers: 3 }, "/m/t.jsonl"),
    "turnstile: 0 test-claims verified · 2 premature dispatches blocked · 3 waivers · journal /m/t.jsonl",
  )
})

/** The all-green line for the "on" mode's zero-activity sessions. */
test("formatAllGreenLine names the journal and the green state", () => {
  assert.equal(
    formatAllGreenLine("/m/t.jsonl"),
    "turnstile: all gates green this session · journal /m/t.jsonl",
  )
})

/** Fail-open read: a missing file yields []. */
test("readJournalEntries returns [] for a missing file", () => {
  assert.deepEqual(readJournalEntries(path.join(tmpDir(), "no-such.jsonl")), [])
})

/** A directory in place of the file (unreadable) also fails open. */
test("readJournalEntries fails open when the path is a directory", () => {
  assert.deepEqual(readJournalEntries(tmpDir()), [])
})

/** Malformed lines are skipped; valid object lines around them still parse. */
test("readJournalEntries skips malformed lines and keeps the rest", () => {
  const dir = tmpDir()
  const p = path.join(dir, "turnstile.jsonl")
  fs.writeFileSync(
    p,
    [
      JSON.stringify({ type: "gate", sessionID: "p1", result: "PASS" }),
      "not json at all",
      JSON.stringify([1, 2]),
      "42",
      JSON.stringify({ type: "dispatch", sessionID: "p1", blocked: true }),
      "",
    ].join("\n"),
  )
  const entries = readJournalEntries(p)
  assert.equal(entries.length, 2)
  assert.equal(entries[0]!.type, "gate")
  assert.equal(entries[1]!.type, "dispatch")
})

// ── wiring: the session.idle event handler (fail-open, once per session) ──

/**
 * Boots the plugin on a fake host with injected config overrides, returning
 * the disposer, the metrics dir, and the fake-host tables.
 * @param host The fake host to boot on.
 * @param configOverrides Config overrides applied last (tests).
 */
async function bootIdle(
  host: Host,
  configOverrides: Record<string, unknown> = {},
): Promise<{ dispose: () => void; metricsDir: string; fake: FakeHost }> {
  const metricsDir = tmpDir()
  const setup = turnstile(host, {
    env: isolatedEnv(metricsDir),
    config: { metricsDir, ...configOverrides },
  })
  const dispose = (await setup(host)) as () => void
  return { dispose, metricsDir, fake: host as FakeHost }
}

/**
 * Appends raw journal lines to the booted metrics dir's journal.
 * @param metricsDir The metrics dir whose journal to seed.
 * @param entries Entry objects to append (one JSONL line each).
 */
function seedJournal(metricsDir: string, entries: Array<Record<string, unknown>>): void {
  fs.appendFileSync(
    path.join(metricsDir, "turnstile.jsonl"),
    entries.map((e) => JSON.stringify(e)).join("\n") + "\n",
  )
}

/** An active-session fixture seeded before the idle event. */
const seedActive = (metricsDir: string): void =>
  seedJournal(metricsDir, [...activeEntries("p1"), pass("p1")])

/** The journal's session-summary entries. */
const summaryEntries = (metricsDir: string): Array<Record<string, any>> =>
  journalEntries(metricsDir).filter((e) => e.type === "session-summary")

/** An active session surfaces its recap line exactly once, toast included. */
test("session.idle surfaces once per session and toasts the recap", async () => {
  const h = makeFakeHost({ tui: true })
  const { dispose, metricsDir } = await bootIdle(h.host, { sessionSummary: "quiet" })
  seedActive(metricsDir)
  await h.pushEvent({ type: "session.idle", data: { sessionID: "p1" } })
  await h.pushEvent({ type: "session.idle", data: { sessionID: "p1" } })
  const entries = summaryEntries(metricsDir)
  assert.equal(entries.length, 1, "the second idle is deduped")
  assert.equal(entries[0]!.sessionID, "p1")
  assert.equal(entries[0]!.verified, 2)
  assert.equal(entries[0]!.blockedDispatches, 1)
  assert.equal(entries[0]!.waivers, 1)
  assert.match(String(entries[0]!.text), /^turnstile: 2 test-claims verified/)
  assert.equal(h.toasts.length, 1, "the toast fires once")
  assert.equal(h.toasts[0]!.variant, "success")
  assert.match(h.toasts[0]!.message, /1 premature dispatch blocked · 1 waiver/)
  dispose()
})

/** Zero-activity sessions stay silent under the quiet default. */
test("session.idle quiet-mode stays silent for a zero-activity session", async () => {
  const h = makeFakeHost({ tui: true })
  const { dispose, metricsDir } = await bootIdle(h.host)
  await h.pushEvent({ type: "session.idle", data: { sessionID: "p1" } })
  assert.equal(summaryEntries(metricsDir).length, 0, "no delivery proof is journaled")
  assert.equal(h.toasts.length, 0, "nothing is toasted")
  dispose()
})

/** The "on" mode prints the all-green line for a zero-activity session. */
test("session.idle on-mode prints the all-green line for zero activity", async () => {
  const h = makeFakeHost({ tui: true })
  const { dispose, metricsDir } = await bootIdle(h.host, { sessionSummary: "on" })
  await h.pushEvent({ type: "session.idle", data: { sessionID: "p1" } })
  const entries = summaryEntries(metricsDir)
  assert.equal(entries.length, 1)
  assert.match(String(entries[0]!.text), /all gates green this session/)
  assert.equal(h.toasts.length, 1)
  assert.match(h.toasts[0]!.message, /all gates green/)
  dispose()
})

/** The "off" mode journals nothing and toasts nothing. */
test("session.idle off-mode stays fully silent", async () => {
  const h = makeFakeHost({ tui: true })
  const { dispose, metricsDir } = await bootIdle(h.host, { sessionSummary: "off" })
  seedActive(metricsDir)
  await h.pushEvent({ type: "session.idle", data: { sessionID: "p1" } })
  assert.equal(summaryEntries(metricsDir).length, 0)
  assert.equal(h.toasts.length, 0)
  dispose()
})

/** A toast failure journals an error entry and never propagates. */
test("session.idle toast failure journals and never propagates", async () => {
  const h = makeFakeHost({ tui: true, toastReject: true })
  const { dispose, metricsDir } = await bootIdle(h.host)
  seedActive(metricsDir)
  await h.pushEvent({ type: "session.idle", data: { sessionID: "p1" } })
  const entries = summaryEntries(metricsDir)
  assert.equal(entries.length, 1, "the delivery proof is journaled despite the toast failure")
  const errors = journalEntries(metricsDir).filter(
    (e) => e.type === "error" && String(e.error).includes("session-summary toast"),
  )
  assert.equal(errors.length, 1, "the toast failure is journaled")
  dispose()
})

/** A host without the tui surface delivers journal-only (the headless path). */
test("session.idle on a host without tui journals the recap with no toast", async () => {
  const h = makeFakeHost()
  const { dispose, metricsDir } = await bootIdle(h.host)
  seedActive(metricsDir)
  await h.pushEvent({ type: "session.idle", data: { sessionID: "p1" } })
  assert.equal(summaryEntries(metricsDir).length, 1)
  assert.equal(h.toasts.length, 0)
  dispose()
})

/** An event without a sessionID is inert (no dedupe add, no delivery). */
test("session.idle without a sessionID is inert", async () => {
  const h = makeFakeHost({ tui: true })
  const { dispose, metricsDir } = await bootIdle(h.host, { sessionSummary: "on" })
  await h.pushEvent({ type: "session.idle", data: {} })
  assert.equal(summaryEntries(metricsDir).length, 0)
  assert.equal(h.toasts.length, 0)
  dispose()
})
