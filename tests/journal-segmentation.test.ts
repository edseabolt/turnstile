/**
 * @fileoverview Per-parent-session journal segmentation tests: entries with a
 * resolvable parent sessionID land in `sessions/<parentID>.jsonl`, entries
 * without one (or with a hostile ID) stay in the shared `turnstile.jsonl`,
 * rotation bounds and stale-lock stealing hold per sink, and boot replay
 * merges both sinks across generations with a global timestamp-ordered tail.
 */

import { test } from "node:test"
import assert from "node:assert/strict"
import * as fs from "node:fs"
import * as path from "node:path"

import { createJournaler, sessionJournalPath } from "../src/journal.ts"
import { createLedger } from "../src/ledger.ts"
import { isolatedEnv, makeFakeHost, tmpDir, waitUntil } from "./helpers.ts"
import { turnstile } from "../turnstile.ts"

/**
 * Builds a journaler bound to a temp metrics dir with per-session routing.
 * @param opts Optional overrides: `perSession` (default true), `sinkFor`
 *     (default: identity for known parents), `rotateEveryEntries`
 *     (default 512), `maxBytes` (default 5 MB).
 * @returns The journaler and its metrics dir.
 */
function segmentedJournaler(opts?: {
  perSession?: boolean
  sinkFor?: (sessionID: string) => string
  rotateEveryEntries?: number
  maxBytes?: number
}): { j: ReturnType<typeof createJournaler>; metricsDir: string } {
  const metricsDir = tmpDir()
  const j = createJournaler({
    metricsDir,
    trace: false,
    maxBytes: opts?.maxBytes ?? 5 * 1024 * 1024,
    maxGenerations: 5,
    rotateEveryEntries: opts?.rotateEveryEntries ?? 512,
    perSession: opts?.perSession ?? true,
    sinkFor: opts?.sinkFor ?? ((sid) => (sid === "p1" ? "p1" : "")),
  })
  return { j, metricsDir }
}

test("plugin boot routes session entries to the session sink", async () => {
  const metricsDir = tmpDir()
  const h = makeFakeHost()
  const setup = turnstile(h.host, {
    env: isolatedEnv(metricsDir),
    config: { metricsDir, journalPerSession: true },
  })
  const dispose = (await setup(h.host)) as () => void
  try {
    h.pushEvent({
      type: "session.inbox.enqueued",
      data: { sessionID: "p1", inboxID: "msg_1", item: { type: "user", payload: { text: "hi" } } },
    })
    const sessionFile = sessionJournalPath(metricsDir, "p1")
    await waitUntil(() => fs.existsSync(sessionFile))
    const entries = fs
      .readFileSync(sessionFile, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l) as Record<string, unknown>)
    assert.equal(
      entries.some((e) => e.sessionID === "p1"),
      true,
      "the admission entry landed in the session sink",
    )
  } finally {
    dispose()
  }
})

test("journalPathFor resolves the session sink path", () => {
  const { j, metricsDir } = segmentedJournaler()
  assert.equal(
    j.journalPathFor("p1"),
    sessionJournalPath(metricsDir, "p1"),
    "the accessor derives the per-session file from sessionsDir",
  )
  assert.equal(j.sessionsDir, path.join(metricsDir, "sessions"), "sessionsDir is exposed")
})

test("journal lands in sessions/<parent>.jsonl for a known parent", () => {
  const { j, metricsDir } = segmentedJournaler()
  j.journal({ type: "gate", sessionID: "p1", result: "PASS" })
  const file = sessionJournalPath(metricsDir, "p1")
  assert.equal(fs.existsSync(file), true, "the session sink file exists")
  const entry = JSON.parse(fs.readFileSync(file, "utf8").trim())
  assert.equal(entry.result, "PASS", "the entry landed in the session sink")
  assert.equal(
    fs.existsSync(path.join(metricsDir, "turnstile.jsonl")),
    false,
    "the shared file stays untouched",
  )
})

test("perSession on without a resolver falls back to shared sink", () => {
  const metricsDir = tmpDir()
  const j = createJournaler({
    metricsDir,
    trace: false,
    maxBytes: 5 * 1024 * 1024,
    maxGenerations: 5,
    rotateEveryEntries: 512,
    perSession: true,
  })
  j.journal({ type: "gate", sessionID: "p1", result: "PASS" })
  const shared = JSON.parse(
    fs.readFileSync(path.join(metricsDir, "turnstile.jsonl"), "utf8").trim(),
  )
  assert.equal(shared.sessionID, "p1", "a missing resolver routes to the shared sink")
})

test("entries without sessionID stay in turnstile.jsonl", () => {
  const { j, metricsDir } = segmentedJournaler()
  j.journal({ type: "error", error: "x" })
  const shared = JSON.parse(
    fs.readFileSync(path.join(metricsDir, "turnstile.jsonl"), "utf8").trim(),
  )
  assert.equal(shared.error, "x", "the sessionless entry landed in the shared sink")
  assert.equal(fs.existsSync(path.join(metricsDir, "sessions")), false, "no session dir created")
})

test("hostile session id routes to shared sink", () => {
  const { j, metricsDir } = segmentedJournaler()
  j.journal({ type: "tool", sessionID: "../evil" })
  const shared = JSON.parse(
    fs.readFileSync(path.join(metricsDir, "turnstile.jsonl"), "utf8").trim(),
  )
  assert.equal(shared.sessionID, "../evil", "the hostile-ID entry landed in the shared sink")
})

test("unresolved parent falls back to shared sink", () => {
  const { j, metricsDir } = segmentedJournaler()
  j.journal({ type: "gate", sessionID: "unknown", result: "PASS" })
  const shared = JSON.parse(
    fs.readFileSync(path.join(metricsDir, "turnstile.jsonl"), "utf8").trim(),
  )
  assert.equal(shared.sessionID, "unknown", "an unresolved parent routes to the shared sink")
})

test("perSession=false keeps the single-file layout", () => {
  const { j, metricsDir } = segmentedJournaler({ perSession: false })
  j.journal({ type: "gate", sessionID: "p1", result: "PASS" })
  const shared = JSON.parse(
    fs.readFileSync(path.join(metricsDir, "turnstile.jsonl"), "utf8").trim(),
  )
  assert.equal(shared.sessionID, "p1", "the entry landed in the shared sink")
  assert.equal(fs.existsSync(path.join(metricsDir, "sessions")), false, "no session dir created")
})

test("session file rotates independently", () => {
  const { j, metricsDir } = segmentedJournaler({ rotateEveryEntries: 4, maxBytes: 200 })
  for (let i = 0; i < 20; i++) j.journal({ type: "gate", sessionID: "p1", result: `r${i}` })
  const sessionFile = sessionJournalPath(metricsDir, "p1")
  assert.equal(fs.existsSync(`${sessionFile}.1`), true, "the session sink rotated")
  assert.equal(
    fs.existsSync(path.join(metricsDir, "turnstile.jsonl.1")),
    false,
    "the shared sink never rotated",
  )
})

test("stale lock steal on session sink", () => {
  const { j, metricsDir } = segmentedJournaler({ rotateEveryEntries: 2, maxBytes: 1 })
  const sessionFile = sessionJournalPath(metricsDir, "p1")
  fs.mkdirSync(path.dirname(sessionFile), { recursive: true })
  fs.mkdirSync(`${sessionFile}.lock`)
  const stale = new Date(Date.now() - 120_000)
  fs.utimesSync(`${sessionFile}.lock`, stale, stale)
  j.journal({ type: "gate", sessionID: "p1", result: "PASS" })
  j.journal({ type: "gate", sessionID: "p1", result: "PASS" })
  assert.equal(fs.existsSync(`${sessionFile}.lock`), false, "the stale lock was stolen and removed")
  const shared = fs.readFileSync(path.join(metricsDir, "turnstile.jsonl"), "utf8")
  assert.match(shared, /rotation-lock-stale:/, "the steal was journaled to the shared file")
})

test("replay reads both sinks across generations", () => {
  const metricsDir = tmpDir()
  const sessionsDir = path.join(metricsDir, "sessions")
  fs.mkdirSync(sessionsDir)
  // A rotated session sink holds the gate PASS; the shared file holds the verdict.
  fs.writeFileSync(
    sessionJournalPath(metricsDir, "p1"),
    `${JSON.stringify({ ts: "t", type: "gate", sessionID: "p1", raw: "c1", result: "PASS" })}\n`,
  )
  fs.renameSync(sessionJournalPath(metricsDir, "p1"), `${sessionJournalPath(metricsDir, "p1")}.1`)
  fs.writeFileSync(
    path.join(metricsDir, "turnstile.jsonl"),
    `${JSON.stringify({ ts: "t", type: "verdict", sessionID: "p1", raw: "c1", marker: "VERDICT: APPROVE", source: "task-result", agent: "reviewer" })}\n`,
  )
  const ledger = createLedger(
    path.join(metricsDir, "turnstile.jsonl"),
    64,
    2000,
    undefined,
    0,
    "reviewer",
    sessionsDir,
  )
  assert.equal(ledger.peek("p1")?.hasGatePass, true, "the rotated session-sink PASS restores")
  assert.equal(ledger.peek("p1")?.hasReviewApprove, true, "the shared-file verdict restores")
})

test("legacy single-file replay unchanged without a sessions dir", () => {
  const metricsDir = tmpDir()
  fs.writeFileSync(
    path.join(metricsDir, "turnstile.jsonl"),
    `${JSON.stringify({ ts: "t", type: "gate", sessionID: "p1", raw: "c1", result: "PASS" })}\n`,
  )
  const ledger = createLedger(path.join(metricsDir, "turnstile.jsonl"), 64, 2000)
  assert.equal(ledger.peek("p1")?.hasGatePass, true, "the legacy single-file replay restores")
})

test("createLedger derives the sessions dir by default", () => {
  const metricsDir = tmpDir()
  const sessionsDir = path.join(metricsDir, "sessions")
  fs.mkdirSync(sessionsDir)
  fs.writeFileSync(
    sessionJournalPath(metricsDir, "p1"),
    `${JSON.stringify({ ts: "t", type: "gate", sessionID: "p1", raw: "c1", result: "PASS" })}\n`,
  )
  const ledger = createLedger(path.join(metricsDir, "turnstile.jsonl"), 64, 2000)
  assert.equal(
    ledger.peek("p1")?.hasGatePass,
    true,
    "the derived default sessions dir is read at replay",
  )
})

test("replay tolerates an unreadable sessions dir", () => {
  const metricsDir = tmpDir()
  fs.writeFileSync(
    path.join(metricsDir, "turnstile.jsonl"),
    `${JSON.stringify({ ts: "t", type: "gate", sessionID: "p1", raw: "c1", result: "PASS" })}\n`,
  )
  fs.writeFileSync(path.join(metricsDir, "sessions"), "not a directory")
  const ledger = createLedger(
    path.join(metricsDir, "turnstile.jsonl"),
    64,
    2000,
    undefined,
    0,
    "reviewer",
    path.join(metricsDir, "sessions"),
  )
  assert.equal(
    ledger.peek("p1")?.hasGatePass,
    true,
    "a readdir failure folds nothing from session sinks but keeps the shared replay",
  )
})

test("replay orders merged sinks by timestamp", () => {
  const metricsDir = tmpDir()
  const sessionsDir = path.join(metricsDir, "sessions")
  fs.mkdirSync(sessionsDir)
  // The session sink holds the OLDER row (FAIL), the shared file the newer
  // PASS: a ts-ordered merge must restore the newer last-wins result.
  fs.writeFileSync(
    sessionJournalPath(metricsDir, "p1"),
    `${JSON.stringify({ ts: "2026-01-01T00:00:00.000Z", type: "gate", sessionID: "p1", raw: "c1", result: "FAIL" })}\n`,
  )
  fs.writeFileSync(
    path.join(metricsDir, "turnstile.jsonl"),
    `${JSON.stringify({ ts: "2026-01-02T00:00:00.000Z", type: "gate", sessionID: "p1", raw: "c2", result: "PASS" })}\n`,
  )
  const ledger = createLedger(
    path.join(metricsDir, "turnstile.jsonl"),
    64,
    2000,
    undefined,
    0,
    "reviewer",
    sessionsDir,
  )
  assert.equal(ledger.peek("p1")?.hasGatePass, true, "the newer ts-ordered row wins the fold")
})

test("replay tolerates an unparseable ts in the merge sort", () => {
  const metricsDir = tmpDir()
  const sessionsDir = path.join(metricsDir, "sessions")
  fs.mkdirSync(sessionsDir)
  fs.writeFileSync(
    sessionJournalPath(metricsDir, "p1"),
    `${JSON.stringify({ ts: "not-a-date", type: "gate", sessionID: "p1", raw: "c1", result: "FAIL" })}\n` +
      `${JSON.stringify({ ts: "2026-01-02T00:00:00.000Z", type: "gate", sessionID: "p1", raw: "c2", result: "PASS" })}\n`,
  )
  const ledger = createLedger(
    path.join(metricsDir, "turnstile.jsonl"),
    64,
    2000,
    undefined,
    0,
    "reviewer",
    sessionsDir,
  )
  assert.equal(
    ledger.peek("p1")?.hasGatePass,
    true,
    "an unparseable ts sorts oldest and never wins the fold",
  )
})

test("replay reads a rotated session generation exactly once", () => {
  const metricsDir = tmpDir()
  const sessionsDir = path.join(metricsDir, "sessions")
  fs.mkdirSync(sessionsDir)
  // The rotated generation's rows must enter the merged window once: a
  // second copy would inflate the window and evict the shared-file PASS
  // that sits just inside the tail bound.
  fs.writeFileSync(
    `${sessionJournalPath(metricsDir, "p1")}.1`,
    `${JSON.stringify({ ts: "2026-01-02T00:00:00.000Z", type: "tool", sessionID: "p1" })}\n` +
      `${JSON.stringify({ ts: "2026-01-03T00:00:00.000Z", type: "tool", sessionID: "p1" })}\n`,
  )
  fs.writeFileSync(
    sessionJournalPath(metricsDir, "p1"),
    `${JSON.stringify({ ts: "2026-01-04T00:00:00.000Z", type: "tool", sessionID: "p1" })}\n` +
      `${JSON.stringify({ ts: "2026-01-05T00:00:00.000Z", type: "tool", sessionID: "p1" })}\n`,
  )
  fs.writeFileSync(
    path.join(metricsDir, "turnstile.jsonl"),
    `${JSON.stringify({ ts: "2026-01-01T00:00:00.000Z", type: "gate", sessionID: "p1", raw: "c1", result: "PASS" })}\n`,
  )
  const ledger = createLedger(
    path.join(metricsDir, "turnstile.jsonl"),
    64,
    5,
    undefined,
    0,
    "reviewer",
    sessionsDir,
  )
  assert.equal(
    ledger.peek("p1")?.hasGatePass,
    true,
    "the PASS survives the tail bound only when the generation is read once",
  )
})

test("replay restores a PASS from a fully rotated session generation", () => {
  const metricsDir = tmpDir()
  const sessionsDir = path.join(metricsDir, "sessions")
  fs.mkdirSync(sessionsDir)
  // The current session file is absent (post-rotation state) and the whole
  // tail window lives in the rotated generation: the generation walk must
  // visit it exactly once so every unique row fits the tail bound.
  fs.writeFileSync(
    `${sessionJournalPath(metricsDir, "p1")}.1`,
    `${JSON.stringify({ ts: "2026-01-01T00:00:00.000Z", type: "gate", sessionID: "p1", raw: "c1", result: "PASS" })}\n` +
      `${JSON.stringify({ ts: "2026-01-02T00:00:00.000Z", type: "tool", sessionID: "p1" })}\n` +
      `${JSON.stringify({ ts: "2026-01-03T00:00:00.000Z", type: "tool", sessionID: "p1" })}\n` +
      `${JSON.stringify({ ts: "2026-01-04T00:00:00.000Z", type: "tool", sessionID: "p1" })}\n` +
      `${JSON.stringify({ ts: "2026-01-05T00:00:00.000Z", type: "tool", sessionID: "p1" })}\n`,
  )
  const ledger = createLedger(
    path.join(metricsDir, "turnstile.jsonl"),
    64,
    5,
    undefined,
    0,
    "reviewer",
    sessionsDir,
  )
  assert.equal(
    ledger.peek("p1")?.hasGatePass,
    true,
    "the rotated-generation PASS restores within the tail bound",
  )
})

test("replay error rows land on the shared journal", () => {
  const metricsDir = tmpDir()
  const sessionsDir = path.join(metricsDir, "sessions")
  fs.mkdirSync(sessionsDir)
  // An unreadable session generation (a directory in its place) journals
  // the replay error row on the shared file — never on the session sink
  // being read, where the append would target the broken family itself.
  fs.mkdirSync(`${sessionJournalPath(metricsDir, "p1")}.1`)
  fs.writeFileSync(
    sessionJournalPath(metricsDir, "p1"),
    `${JSON.stringify({ ts: "2026-01-02T00:00:00.000Z", type: "gate", sessionID: "p1", raw: "c1", result: "PASS" })}\n`,
  )
  const ledger = createLedger(
    path.join(metricsDir, "turnstile.jsonl"),
    64,
    2000,
    undefined,
    0,
    "reviewer",
    sessionsDir,
  )
  assert.equal(ledger.peek("p1")?.hasGatePass, true, "the readable generation still restores")
  const shared = fs.readFileSync(path.join(metricsDir, "turnstile.jsonl"), "utf8")
  const sharedRows = shared
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Record<string, unknown>)
  assert.equal(
    sharedRows.some((r) => r.type === "replay" && r.error === true),
    true,
    "the replay error row landed on the shared journal",
  )
})
