/**
 * @fileoverview Phase 2 sticky-release tests: the extended decision-row
 * family (scope/kind on `always` grants and `waiver` captures), the boot
 * replay's sticky-decision fold + restore (last-wins per session, legacy
 * rows inert, hostile rows dropped), the restart-sticky carry through
 * `mergeAfterReplay`, and the fast-reply provenance suspicion (journal-only).
 */

import { test } from "node:test"
import assert from "node:assert/strict"
import * as fs from "node:fs"
import * as path from "node:path"

import { createLedger } from "../src/ledger.ts"
import { decisionEntry } from "../src/gates-common.ts"
import { mergeAfterReplay as carryAfterReplay, newState } from "../src/state.ts"
import { turnstile } from "../turnstile.ts"
import {
  callPermission,
  callSession,
  callTool,
  isolatedEnv,
  journalEntries,
  makeFakeHost,
  tmpDir,
  waitUntil,
  type FakeHost,
  frozenClock,
} from "./helpers.ts"
import { BlockError } from "../src/gates.ts"

/**
 * Writes the given raw lines as the journal of a fresh temp metrics dir.
 * @param metricsDir The temp metrics dir.
 * @param lines Raw journal lines.
 * @returns The journal path.
 */
function writeJournal(metricsDir: string, lines: string[]): string {
  const journalPath = path.join(metricsDir, "turnstile.jsonl")
  fs.writeFileSync(journalPath, lines.join("\n") + "\n")
  return journalPath
}

/**
 * A sticky decision row line for a session.
 * @param sessionID The session ID to journal.
 * @param fields The row's decision fields (decision/scope/kind/stages).
 * @returns The raw JSONL line.
 */
function stickyLine(sessionID: string, fields: Record<string, unknown>): string {
  return JSON.stringify({ ts: "t", type: "permission", sessionID, ...fields })
}

/** The replay-drop telemetry entries a boot replay journaled. */
function replayDrops(metricsDir: string): Record<string, any>[] {
  return journalEntries(metricsDir).filter(
    (e): e is Record<string, any> => e !== null && e.type === "suppressed" && e.kind === "replay",
  )
}

test("decisionEntry: non-sticky rows keep the legacy shape", () => {
  assert.deepEqual(decisionEntry("p1", "once"), {
    type: "permission",
    sessionID: "p1",
    decision: "once",
  })
  assert.deepEqual(decisionEntry("p1", "reject"), {
    type: "permission",
    sessionID: "p1",
    decision: "reject",
  })
})

test("decisionEntry: sticky rows carry scope, kind, and optional stages", () => {
  assert.deepEqual(decisionEntry("p1", "always", { kind: "plan" }), {
    type: "permission",
    sessionID: "p1",
    decision: "always",
    scope: "task",
    kind: "plan",
  })
  assert.deepEqual(decisionEntry("p1", "waiver", { kind: "waiver", stages: ["executor"] }), {
    type: "permission",
    sessionID: "p1",
    decision: "waiver",
    scope: "task",
    kind: "waiver",
    stages: ["executor"],
  })
})

test("replay restores a sticky always grant per released surface", () => {
  const metricsDir = tmpDir()
  const journalPath = writeJournal(metricsDir, [
    stickyLine("p1", { decision: "always", scope: "task", kind: "plan" }),
    stickyLine("p2", { decision: "always", scope: "task", kind: "landing" }),
    stickyLine("p3", { decision: "always", scope: "task", kind: "hands-on" }),
  ])
  const ledger = createLedger(journalPath, 64, 2000)
  assert.equal(ledger.peek("p1")?.hasPlanVerdict, true, "a plan grant restores the verdict")
  assert.equal(ledger.peek("p1")?.humanApproval, true, "a plan grant restores the provenance")
  assert.equal(ledger.peek("p2")?.hasReviewApprove, true, "a landing grant restores the release")
  assert.equal(ledger.peek("p3")?.handsOnRelease, true, "a hands-on grant restores the release")
  assert.equal(ledger.peek("p3")?.replayGrace, true, "restores ride the replay-grace window")
  assert.equal(replayDrops(metricsDir).length, 0, "clean sticky rows journal no drop")
})

test("replay restores a waiver capture through the same fold", () => {
  const metricsDir = tmpDir()
  const journalPath = writeJournal(metricsDir, [
    stickyLine("p1", { decision: "waiver", scope: "task", kind: "waiver", stages: ["executor"] }),
  ])
  const ledger = createLedger(journalPath, 64, 2000)
  const s = ledger.peek("p1")
  assert.equal(s?.userWaiver, "<present>", "the waiver presence marker restores")
  assert.deepEqual(s?.userWaiverScope, ["executor"], "the stage scope restores")
  assert.equal(s?.stickyRelease, true, "the sticky-release provenance restores")
})

test("replay sticky fold is last-wins per session", () => {
  const metricsDir = tmpDir()
  const journalPath = writeJournal(metricsDir, [
    stickyLine("p1", { decision: "always", scope: "task", kind: "hands-on" }),
    stickyLine("p1", { decision: "waiver", scope: "task", kind: "waiver", stages: [] }),
  ])
  const ledger = createLedger(journalPath, 64, 2000)
  const s = ledger.peek("p1")
  assert.equal(s?.handsOnRelease, false, "the superseded grant does not restore")
  assert.equal(s?.userWaiver, "<present>", "the last sticky row decides")
})

test("replay treats legacy decision rows and audit flavors as inert without drops", () => {
  const metricsDir = tmpDir()
  const journalPath = writeJournal(metricsDir, [
    // Legacy pre-sticky always row (no scope): replay-inert as before.
    JSON.stringify({ ts: "t", type: "permission", sessionID: "p1", decision: "always" }),
    // Ask row, forced consume, suspicion, unrecorded reply: audit flavors.
    JSON.stringify({
      ts: "t",
      type: "permission",
      sessionID: "p1",
      action: "ask",
      reason: "landing",
    }),
    JSON.stringify({
      ts: "t",
      type: "permission",
      sessionID: "p1",
      reason: "landing",
      event: "forced",
    }),
    JSON.stringify({
      ts: "t",
      type: "permission",
      sessionID: "p1",
      event: "suspicion",
      reason: "no-interactive-human",
      reply: "always",
    }),
    JSON.stringify({
      ts: "t",
      type: "permission",
      sessionID: "p1",
      event: "unrecorded-reply",
      requestID: "r1",
    }),
  ])
  const ledger = createLedger(journalPath, 64, 2000)
  assert.equal(ledger.peek("p1"), undefined, "no bucket is minted from inert rows")
  assert.equal(replayDrops(metricsDir).length, 0, "inert rows journal no drop")
})

test("replay drops hostile sticky rows instead of folding them", () => {
  const metricsDir = tmpDir()
  const journalPath = writeJournal(metricsDir, [
    stickyLine("p1", { decision: "always", scope: "worktree", kind: "plan" }),
    stickyLine("p1", { decision: "sudo", scope: "task", kind: "plan" }),
    stickyLine("p1", { decision: "always", scope: "task", kind: "root" }),
    // A hostile stage element degrades the whole scope to unscoped (the
    // documented sanitizer contract) without dropping the row.
    stickyLine("p1", { decision: "waiver", scope: "task", kind: "waiver", stages: [42] }),
    // A non-array stages value degrades the scope to unscoped the same way.
    stickyLine("p1", { decision: "waiver", scope: "task", kind: "waiver", stages: "all" }),
  ])
  const ledger = createLedger(journalPath, 64, 2000)
  const s = ledger.peek("p1")
  assert.equal(s?.hasPlanVerdict, false, "the hostile rows fold no plan grant")
  assert.deepEqual(s?.userWaiverScope, [], "a hostile stage list degrades to unscoped")
  assert.equal(s?.userWaiver, "<present>", "the degraded waiver row still restores as unscoped")
  assert.equal(replayDrops(metricsDir).length, 3, "each dropped row journals one drop")
})

test("mergeAfterReplay carries the standing releases restart-sticky", () => {
  const prior = newState()
  prior.handsOnRelease = true
  prior.stickyRelease = true
  const carried = carryAfterReplay(prior)
  assert.equal(carried.handsOnRelease, true, "the hands-on release survives the grace prompt")
  assert.equal(carried.stickyRelease, true, "the sticky-release provenance survives")
  // An ordinary fresh bucket starts without either.
  assert.equal(newState().handsOnRelease, false)
  assert.equal(newState().stickyRelease, false)
})
/**
 * Boots the plugin on a fake host in a temp metrics dir (the shared
 * full-harness shape; default config, emptyDiffExempt pinned false so
 * landing-ladder assertions never depend on the live repo's git state).
 */
async function boot(): Promise<{ h: FakeHost; dispose: () => void; metricsDir: string }> {
  const h = makeFakeHost()
  const metricsDir = tmpDir()
  const setup = turnstile(h.host, { env: isolatedEnv(metricsDir), config: { metricsDir } })
  const dispose = (await setup(h.host)) as () => void
  return { h, dispose, metricsDir }
}

test("waiver capture journals the sticky decision row and sets stickyRelease", async () => {
  const { h, dispose, metricsDir } = await boot()
  try {
    await callSession(h, "prompt", { sessionID: "p1", text: "USER WAIVER: do the work" })
    await waitUntil(() =>
      journalEntries(metricsDir).some(
        (l) => l.type === "permission" && l.decision === "waiver" && l.sessionID === "p1",
      ),
    )
    const row = journalEntries(metricsDir).find(
      (l) => l.type === "permission" && l.decision === "waiver",
    )!
    assert.ok(row, "the sticky waiver row is journaled")
    assert.equal(row.scope, "task", "the waiver row is task-scoped")
    assert.equal(row.kind, "waiver", "the waiver row names its surface")
    assert.deepEqual(row.stages, [], "an unscoped waiver carries an empty stage list")
  } finally {
    dispose()
  }
})

test("a slow always reply journals no suspicion and still releases", async (t) => {
  const clock = frozenClock(t)
  clock.advance(0)
  const { h, dispose, metricsDir } = await boot()
  try {
    await assert.rejects(
      () =>
        callTool(h, "execute.before", {
          tool: "write",
          sessionID: "p1",
          input: { filePath: "/repo/slow.ts" },
        }),
      (e: unknown) => e instanceof BlockError,
    )
    await callTool(h, "execute.before", {
      tool: "write",
      sessionID: "p1",
      input: { filePath: "/repo/slow.ts" },
    })
    const event: Record<string, any> = { sessionID: "p1", action: "write" }
    await callPermission(h, "evaluate", event)
    h.pushEvent({
      type: "permission.asked",
      properties: {
        sessionID: "p1",
        id: "h-slow",
        message: "turnstile: parent-session write/edit requires the pipeline",
      },
    })
    // The ask must be RECORDED before the clock ages: a warmup error proves
    // FIFO stream order (the asked event was consumed) before advancing.
    h.pushEvent({ type: "session.error", properties: { sessionID: "warm-slow", error: "warm" } })
    await waitUntil(() =>
      journalEntries(metricsDir).some((l) => l.type === "error" && l.error === "warm"),
    )
    // Age past the fast-reply window before the human answers: no suspicion.
    clock.advance(2000)
    h.pushEvent({
      type: "permission.replied",
      properties: { sessionID: "p1", requestID: "h-slow", reply: "always" },
    })
    await waitUntil(() =>
      journalEntries(metricsDir).some(
        (l) => l.type === "permission" && l.decision === "always" && l.kind === "hands-on",
      ),
    )
    assert.ok(
      !journalEntries(metricsDir).some((l) => l.event === "suspicion"),
      "a plausibly human reply journals no suspicion",
    )
    assert.doesNotThrow(() =>
      callTool(h, "execute.before", {
        tool: "write",
        sessionID: "p1",
        input: { filePath: "/repo/slow.ts" },
      }),
    )
  } finally {
    dispose()
  }
})

test("a fast always reply journals the suspicion and still releases", async () => {
  const { h, dispose, metricsDir } = await boot()
  try {
    // First parent write blocks; the armed repeat escalates (ask-first).
    await assert.rejects(
      () =>
        callTool(h, "execute.before", {
          tool: "write",
          sessionID: "p1",
          input: { filePath: "/repo/a.ts" },
        }),
      (e: unknown) => e instanceof BlockError,
    )
    await callTool(h, "execute.before", {
      tool: "write",
      sessionID: "p1",
      input: { filePath: "/repo/a.ts" },
    })
    // The guard's arm forces the ask through the evaluate handler.
    const event: Record<string, any> = { sessionID: "p1", action: "write" }
    await callPermission(h, "evaluate", event)
    assert.equal(event.effect, "ask", "the armed evaluate forces the human ask")
    // A hands-on-prefixed ask records for the hands-on gate; an immediate
    // (faster than any human) always reply journals the suspicion row and
    // still applies the standing release.
    h.pushEvent({
      type: "permission.asked",
      properties: {
        sessionID: "p1",
        id: "h-fast",
        message: "turnstile: parent-session write/edit requires the pipeline",
      },
    })
    h.pushEvent({
      type: "permission.replied",
      properties: { sessionID: "p1", requestID: "h-fast", reply: "always" },
    })
    await waitUntil(() =>
      journalEntries(metricsDir).some((l) => l.type === "permission" && l.event === "suspicion"),
    )
    const suspicion = journalEntries(metricsDir).find((l) => l.event === "suspicion")!
    assert.ok(suspicion, "the suspicion row is journaled")
    assert.equal(suspicion.reason, "no-interactive-human", "the suspicion names the posture")
    assert.ok(!("decision" in suspicion), "the suspicion row stays outside the decision family")
    await waitUntil(() =>
      journalEntries(metricsDir).some(
        (l) => l.type === "permission" && l.decision === "always" && l.kind === "hands-on",
      ),
    )
    // The standing release allows the next write silently.
    assert.doesNotThrow(() =>
      callTool(h, "execute.before", {
        tool: "write",
        sessionID: "p1",
        input: { filePath: "/repo/a.ts" },
      }),
    )
  } finally {
    dispose()
  }
})
