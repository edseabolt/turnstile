/**
 * @fileoverview Journal entry shape pins: one test per journal entry type
 * written by the gate/admission surfaces ({type:"ensemble"}, dispatch rows,
 * blocked rows, gate/verdict rows, the waiver gate row, the continuation row
 * incl. its `recovery:true` form, and the suspended rows), asserting the
 * exact key set and value domains written — only `ts` (journaler-stamped)
 * and `sessionID` values are environment-varying and ignored.
 */

import { test } from "node:test"
import assert from "node:assert/strict"

import { createHooksCore, type TurnstileContext } from "../src/hooks-core.ts"
import {
  decisionEntry,
  observeEntry,
  reviewerEnsembleEntry,
  wouldBlockEntry,
} from "../src/gates-common.ts"
import type { TurnstileConfig } from "../src/types.ts"
import { callTool, isolatedEnv, journalEntries, tmpDir } from "./helpers.ts"

void callTool

/** Creates a hooks-core context over an isolated env and temp metrics dir.
 *  @param config Injected config overrides.
 *  @returns The context plus the temp metrics dir. */
function coreWith(config: Partial<TurnstileConfig>): {
  ctx: TurnstileContext
  metricsDir: string
} {
  const metricsDir = tmpDir()
  const ctx = createHooksCore({
    env: isolatedEnv(metricsDir),
    config: { metricsDir, alwaysEnforce: true, ...config },
  })
  return { ctx, metricsDir }
}

/** The journal entries of one type with `ts` stripped.
 *  @param metricsDir The metrics dir to read.
 *  @param type The entry type to filter.
 *  @returns The matching entries without their `ts` stamps. */
function entriesOfType(metricsDir: string, type: string): Array<Record<string, any>> {
  return journalEntries(metricsDir)
    .filter((e) => e.type === type)
    .map((e) => {
      const { ts: _ts, ...rest } = e
      return rest
    })
}

test("the ensemble entry pins its exact key set, with and without the refusal stamp", () => {
  assert.deepEqual(Object.keys(reviewerEnsembleEntry("p1", "reviewer", 2)), [
    "type",
    "sessionID",
    "agent",
    "count",
  ])
  assert.deepEqual(reviewerEnsembleEntry("p1", "reviewer", 2), {
    type: "ensemble",
    sessionID: "p1",
    agent: "reviewer",
    count: 2,
  })
  assert.deepEqual(reviewerEnsembleEntry("p1", "reviewer", 1, true), {
    type: "ensemble",
    sessionID: "p1",
    agent: "reviewer",
    count: 1,
    refusedApprove: true,
  })
  assert.deepEqual(reviewerEnsembleEntry("p1", "reviewer", 1, false), {
    type: "ensemble",
    sessionID: "p1",
    agent: "reviewer",
    count: 1,
    refusedApprove: false,
  })
})

test("the permission decision entry pins its legacy and sticky shapes", () => {
  assert.deepEqual(decisionEntry("p1", "reject"), {
    type: "permission",
    sessionID: "p1",
    decision: "reject",
  })
  assert.deepEqual(decisionEntry("p1", "always", { kind: "plan" }), {
    type: "permission",
    sessionID: "p1",
    decision: "always",
    scope: "task",
    kind: "plan",
  })
  assert.deepEqual(decisionEntry("p1", "waiver", { kind: "waiver", stages: ["plan"] }), {
    type: "permission",
    sessionID: "p1",
    decision: "waiver",
    scope: "task",
    kind: "waiver",
    stages: ["plan"],
  })
})

test("the observe and would-block entries pin their exact key sets", () => {
  assert.deepEqual(observeEntry("p1", "observe", 1, 0), {
    type: "observe",
    sessionID: "p1",
    phase: "observe",
    observed: 1,
    wouldBlocks: 0,
  })
  assert.deepEqual(wouldBlockEntry("p1", "cause", 1, 2), {
    type: "would-block",
    sessionID: "p1",
    cause: "cause",
    observed: 1,
    wouldBlocks: 2,
  })
})

test("a blocked reviewer dispatch journals dispatch and blocked rows with exact key sets", async () => {
  const { ctx, metricsDir } = coreWith({})
  await assert.rejects(() =>
    ctx.handleTaskDispatch({
      tool: "task",
      sessionID: "p1",
      input: { agent: "reviewer", prompt: "r" },
    } as any),
  )
  const dispatch = entriesOfType(metricsDir, "dispatch")
  assert.deepEqual(dispatch, [
    { type: "dispatch", sessionID: "p1", agent: "reviewer", description: "", blocked: true },
  ])
  assert.deepEqual(entriesOfType(metricsDir, "blocked"), [
    {
      type: "blocked",
      sessionID: "p1",
      agent: "reviewer",
      reason: "no-gate-pass",
    },
  ])
})

test("an admitted waiver prompt plus reviewer dispatch journals the WAIVED gate row", async () => {
  const { ctx, metricsDir } = coreWith({})
  ctx.admitPrompt("p1", { text: "USER WAIVER: reviewer" }, "")
  await ctx.handleTaskDispatch({
    tool: "task",
    sessionID: "p1",
    input: { agent: "reviewer", prompt: "r" },
  } as any)
  assert.deepEqual(entriesOfType(metricsDir, "gate"), [
    {
      type: "gate",
      sessionID: "p1",
      result: "WAIVED",
      channel: "prompt",
      scope: "reviewer",
      waiver: "USER WAIVER: reviewer",
    },
  ])
})

test("a first-sight marker observation journals gate and verdict rows with exact key sets", () => {
  const { ctx, metricsDir } = coreWith({})
  ctx.seedEmitter("c1", "test-runner")
  ctx.ledger.childToParent.set("c1", "p1")
  ctx.parseMarkers("GATE: PASS tests=1 passed=1 failed=0", "c1", "task-result", "scope-1")
  ctx.seedEmitter("c2", "reviewer")
  ctx.ledger.childToParent.set("c2", "p1")
  ctx.parseMarkers("VERDICT: APPROVE crit=0 high=0 med=0 low=0", "c2", "task-result", "scope-1")
  assert.deepEqual(entriesOfType(metricsDir, "gate"), [
    {
      type: "gate",
      sessionID: "p1",
      raw: "c1",
      result: "PASS",
      source: "task-result",
      marker: "GATE: PASS tests=1 passed=1 failed=0",
      verified: false,
      mode: "enforce",
    },
  ])
  assert.deepEqual(entriesOfType(metricsDir, "verdict"), [
    {
      type: "verdict",
      sessionID: "p1",
      raw: "c2",
      agent: "reviewer",
      marker: "VERDICT: APPROVE crit=0 high=0 med=0 low=0",
      rounds: 0,
      source: "task-result",
    },
  ])
})

test("a retired-task continuation with earned credit journals the recovery:true row", () => {
  const { ctx, metricsDir } = coreWith({})
  ctx.admitPrompt("p1", { text: "first prompt" }, "")
  const s = ctx.ledger.state("p1")
  const fingerprint = s.taskFingerprint
  s.hasGatePass = true
  s.hasReviewApprove = false
  s.reviewerDispatches = 1
  s.taskComplete = true
  ctx.admitPrompt("p1", { text: "continue" }, "")
  assert.deepEqual(entriesOfType(metricsDir, "continuation"), [
    { type: "continuation", sessionID: "p1", recovery: true },
  ])
  assert.equal(fingerprint !== "", true, "the first admission stamped a fingerprint to carry")
})

test("an ordinary same-scope continuation journals the continuation row without recovery", () => {
  const { ctx, metricsDir } = coreWith({})
  ctx.admitPrompt("p1", { text: "first prompt" }, "")
  const s = ctx.ledger.state("p1")
  s.hasGatePass = true
  s.hasReviewApprove = true
  ctx.admitPrompt("p1", { text: "continue" }, "")
  assert.deepEqual(entriesOfType(metricsDir, "continuation"), [
    { type: "continuation", sessionID: "p1" },
  ])
})

test("suspend and resume admissions journal the suspended rows with their exact key sets", () => {
  const { ctx, metricsDir } = coreWith({})
  ctx.admitPrompt("p1", { text: "TURNSTILE OFF: maintenance" }, "")
  ctx.admitPrompt("p1", { text: "TURNSTILE ON: back" }, "")
  assert.deepEqual(entriesOfType(metricsDir, "suspended"), [
    { type: "suspended", sessionID: "p1", action: "off" },
    { type: "suspended", sessionID: "p1", action: "on" },
  ])
})

test("the journaler prepends exactly one ts field ahead of the entry keys", () => {
  const { ctx, metricsDir } = coreWith({})
  ctx.journaler.journal(reviewerEnsembleEntry("p1", "reviewer", 1))
  const entry = journalEntries(metricsDir)[0] as Record<string, unknown>
  assert.deepEqual(Object.keys(entry), ["ts", "type", "sessionID", "agent", "count"])
  assert.equal(typeof entry.ts, "string")
  assert.ok(!Number.isNaN(Date.parse(entry.ts as string)), "ts is an ISO timestamp")
})

test("a task dispatch through the dispatch guard journals the allowed dispatch row shape", async () => {
  const { ctx, metricsDir } = coreWith({ alwaysEnforce: false })
  ctx.admitPrompt("p1", { text: "PLAN APPROVED: plan.md" }, "")
  ctx.ledger.state("p1").engaged = true
  await ctx.handleTaskDispatch({
    tool: "task",
    sessionID: "p1",
    input: { agent: "planner", prompt: "plan" },
  } as any)
  assert.deepEqual(entriesOfType(metricsDir, "dispatch"), [
    { type: "dispatch", sessionID: "p1", agent: "planner", description: "" },
  ])
})
