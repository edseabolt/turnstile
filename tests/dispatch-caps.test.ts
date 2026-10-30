/**
 * @fileoverview Dispatch-loop-cap tests: the per-leg loop caps
 * (planner / plan-reviewer / test-runner) and the per-task total-dispatch
 * budget, plus the per-task total budget as a global backstop. Every dispatch
 * leg is now a mechanical loop backstop; exhausting any cap journals a
 * `blocked` (`loop-cap`/`dispatch-budget`) plus a paired `escalation` entry and
 * throws a STOP-and-escalate `BlockError`. Waivers exempt the whole task; a new
 * prompt resets every counter. All via a fake host with injected config.
 */

import { test } from "node:test"
import assert from "node:assert/strict"
import * as fs from "node:fs"
import * as path from "node:path"

import { BlockError } from "../src/gates.ts"
import { turnstile } from "../turnstile.ts"
import {
  callSession,
  callTool,
  isolatedEnv,
  journalEntries,
  makeFakeHost,
  tmpDir,
  type FakeHost,
} from "./helpers.ts"

/** Planner loop-cap block message at cap 2. */
const PLANNER_LOOP_CAP_MESSAGE =
  "BLOCKED by turnstile: planner dispatch limit (2) reached this task — the pipeline is looping. " +
  "STOP: do not re-dispatch planner. Escalate to the user: report the repeated planner failures " +
  "and wait for new instructions (a new task resets the caps; raise maxPlannerRounds in your config to widen the cap)."

/** Plan-reviewer loop-cap block message at cap 2. */
const PLAN_REVIEWER_LOOP_CAP_MESSAGE =
  "BLOCKED by turnstile: plan-reviewer dispatch limit (2) reached this task — the pipeline is looping. " +
  "STOP: do not re-dispatch plan-reviewer. Escalate to the user: report the repeated plan-reviewer " +
  "failures and wait for new instructions (a new task resets the caps; raise maxPlanReviewerRounds in your config to widen the cap)."

/** Test-runner loop-cap block message at cap 2. */
const TEST_RUNNER_LOOP_CAP_MESSAGE =
  "BLOCKED by turnstile: test-runner dispatch limit (2) reached this task — the pipeline is looping. " +
  "STOP: do not re-dispatch test-runner. Escalate to the user: report the repeated test-runner failures " +
  "and wait for new instructions (a new task resets the caps; raise maxTestRunnerRounds in your config to widen the cap)."

/** Total-dispatch-budget block message at cap 2. */
const BUDGET_MESSAGE =
  "BLOCKED by turnstile: task dispatch budget (2) exhausted — the pipeline is looping. " +
  "STOP: do not dispatch further subagents. Escalate to the user: report the stuck pipeline and wait " +
  "for new instructions (a new task resets the counters; raise maxTotalDispatches in your config to widen the budget)."

/** Reviewer round-limit block message (kept STOP-and-escalate). */
const ROUND_LIMIT_MESSAGE =
  "BLOCKED by turnstile: reviewer round limit (2) reached — the pipeline is looping. " +
  "STOP: do not re-dispatch the reviewer. Escalate the open findings to the user and wait for new " +
  "instructions (a new task resets the cap)."

/** Boots the plugin over a fake host with a temp metrics dir. */
async function boot(
  config: Record<string, any> = {},
): Promise<{ h: FakeHost; dispose: () => void; metricsDir: string }> {
  const metricsDir = tmpDir()
  const h = makeFakeHost()
  const setup = turnstile(h.host, {
    env: isolatedEnv(metricsDir),
    config: { metricsDir, ...config },
  })
  const dispose = (await setup(h.host)) as () => void
  return { h, dispose, metricsDir }
}

/** Invokes a dispatch of the named agent; resolves when it passes, rejects on
 *  a `BlockError`. */
async function dispatch(
  h: FakeHost,
  sessionID: string,
  agent: string,
  prompt = "go",
): Promise<void> {
  await callTool(h, "execute.before", {
    tool: "task",
    sessionID,
    input: { agent, prompt },
  })
}

/** Delivers a green test-runner gate under the injected evidence mode. */
async function greenGate(h: FakeHost, sessionID: string): Promise<void> {
  await callTool(h, "execute.after", {
    tool: "task",
    sessionID,
    input: { agent: "test-runner" },
    result: { output: "GATE: PASS tests=1 passed=1 failed=0\n" },
  })
}

/** The index of the first journal entry whose type matches, or -1. */
function firstIndex(entries: Array<Record<string, any>>, type: string): number {
  return entries.findIndex((l) => l.type === type)
}

/** With maxPlannerRounds: 2 the first two planner dispatches
 *  pass; the third is blocked with the exact planner loop-cap message and
 *  journals a paired `loop-cap` blocked + `escalation` entry. A blocked
 *  attempt draws down nothing: a fourth attempt blocks on the same pinned
 *  count — the leg counter moves only when a dispatch is admitted. */
test("planner leg cap: third planner dispatch is blocked and escalates", async () => {
  const { h, dispose, metricsDir } = await boot({ maxPlannerRounds: 2 })
  await dispatch(h, "p1", "planner")
  await dispatch(h, "p1", "planner")
  await assert.rejects(
    () => dispatch(h, "p1", "planner", "loop again"),
    (e: Error) => e instanceof BlockError && e.message === PLANNER_LOOP_CAP_MESSAGE,
  )
  await assert.rejects(
    () => dispatch(h, "p1", "planner", "and again"),
    (e: Error) => e instanceof BlockError && e.message === PLANNER_LOOP_CAP_MESSAGE,
  )
  const entries = journalEntries(metricsDir)
  const legBlocks = entries.filter((l) => l.type === "blocked" && l.reason === "loop-cap")
  assert.equal(legBlocks.length, 2, "each blocked attempt journaled a loop-cap block")
  assert.ok(
    legBlocks.every(
      (l) => l.leg === "planner" && l.agent === "planner" && l.count === 2 && l.cap === 2,
    ),
    "every loop-cap block pins the count at 2 — a refusal never advances it",
  )
  const legEscalations = entries.filter((l) => l.type === "escalation" && l.reason === "loop-cap")
  assert.ok(
    legEscalations.every((l) => l.count === 2 && l.cap === 2),
    "every loop-cap escalation pins the count at 2",
  )
  dispose()
})

/** With maxPlanReviewerRounds: 2 the third plan-reviewer
 *  dispatch is blocked and escalates. The plan-reviewer dispatch timestamp
 *  (set just before the guard) is still recorded, so the blocked entry comes
 *  after the dispatch entry in journal order. */
test("plan-reviewer leg cap: third dispatch is blocked, escalates, timestamp preserved", async () => {
  const { h, dispose, metricsDir } = await boot({ maxPlanReviewerRounds: 2 })
  await dispatch(h, "p1", "plan-reviewer")
  await dispatch(h, "p1", "plan-reviewer")
  await assert.rejects(
    () => dispatch(h, "p1", "plan-reviewer", "loop again"),
    (e: Error) => e instanceof BlockError && e.message === PLAN_REVIEWER_LOOP_CAP_MESSAGE,
  )
  const entries = journalEntries(metricsDir)
  const dispatchIdx = firstIndex(entries, "dispatch")
  const blockedIdx = entries.findIndex((l) => l.type === "blocked" && l.reason === "loop-cap")
  const escalationIdx = entries.findIndex((l) => l.type === "escalation" && l.reason === "loop-cap")
  assert.ok(dispatchIdx !== -1, "dispatch entry recorded")
  assert.ok(blockedIdx !== -1, "loop-cap blocked entry recorded")
  assert.ok(escalationIdx !== -1, "loop-cap escalation entry recorded")
  // Ordering: dispatchIdx is the first ALLOWED dispatch (recorded before the
  // guards), so it precedes the blocked dispatch's guard-blocked entry. The
  // blocked dispatch's own entry now comes AFTER its blocked+escalation
  // entries (stamped blocked:true) — the per-dispatch order inverts under
  // guards-then-journal, so this assertion survives only via the earlier allow.
  assert.ok(dispatchIdx < blockedIdx, "an allowed dispatch precedes the block")
  assert.ok(blockedIdx < escalationIdx, "block precedes its escalation")
  dispose()
})

/** With maxTestRunnerRounds: 2 the first dispatch succeeds even before
 *  any gate is green — the cap never blocks the healthy path — and the third
 *  dispatch is blocked and escalates. */
test("test-runner leg cap: first dispatch succeeds pre-gate, third is blocked", async () => {
  const { h, dispose, metricsDir } = await boot({ maxTestRunnerRounds: 2 })
  await dispatch(h, "p1", "test-runner")
  await dispatch(h, "p1", "test-runner")
  await assert.rejects(
    () => dispatch(h, "p1", "test-runner", "loop again"),
    (e: Error) => e instanceof BlockError && e.message === TEST_RUNNER_LOOP_CAP_MESSAGE,
  )
  const entries = journalEntries(metricsDir)
  assert.ok(
    entries.some(
      (l) =>
        l.type === "blocked" &&
        l.reason === "loop-cap" &&
        l.leg === "testRunner" &&
        l.count === 2 &&
        l.cap === 2,
    ),
  )
  assert.ok(
    entries.some((l) => l.type === "escalation" && l.reason === "loop-cap" && l.count === 2),
  )
  dispose()
})

/** A blocked dispatch still journals its dispatch entry (stamped
 *  blocked:true) alongside the guard's blocked→escalation pair: audit sees the
 *  attempt even though the dispatch never proceeded. */
test("blocked dispatch journals its dispatch entry with blocked:true", async () => {
  const { h, dispose, metricsDir } = await boot({ maxPlannerRounds: 2 })
  await dispatch(h, "p1", "planner")
  await dispatch(h, "p1", "planner")
  await assert.rejects(
    () => dispatch(h, "p1", "planner", "loop again"),
    (e: Error) => e instanceof BlockError && e.message === PLANNER_LOOP_CAP_MESSAGE,
  )
  const entries = journalEntries(metricsDir)
  const dispatched = entries.filter((l) => l.type === "dispatch")
  // Two allowed + the blocked third: exactly three dispatch entries.
  assert.equal(dispatched.length, 3)
  assert.ok(dispatched.every((l) => l.agent === "planner"))
  // The third (the blocked attempt) carries the stamp; the first allowed does
  // not — the stamp is present only on a blocked attempt.
  assert.equal(dispatched[2]!.blocked, true)
  assert.ok(!("blocked" in dispatched[0]!))
  // The guard's blocked→escalation pair is still present. The guard stamps
  // `leg` on the blocked entry only; the escalation names the reason.
  assert.ok(
    entries.some((l) => l.type === "blocked" && l.reason === "loop-cap" && l.leg === "planner"),
  )
  assert.ok(entries.some((l) => l.type === "escalation" && l.reason === "loop-cap"))
  dispose()
})

/** An allowed (non-blocked) dispatch carries no `blocked` field: the stamp is
 *  added only on a blocked attempt, so an allowed dispatch is byte-identical to
 *  before. */
test("allowed dispatch carries no blocked field", async () => {
  const { h, dispose, metricsDir } = await boot({ maxTestRunnerRounds: 2 })
  await dispatch(h, "p1", "test-runner")
  await dispatch(h, "p1", "test-runner")
  const entries = journalEntries(metricsDir)
  const dispatched = entries.filter((l) => l.type === "dispatch")
  assert.ok(dispatched.length >= 2, "expected at least two allowed dispatches")
  assert.ok(
    dispatched.every((l) => l.agent === "test-runner" && !("blocked" in l)),
    "no allowed dispatch carries a blocked field",
  )
  dispose()
})

/** Non-capped agents (executor, debugger, unknown) only draw down the
 *  total budget; the (cap+1)th dispatch is blocked with the budget message. */
test("executor/debugger/unknown draw down only the budget, then block", async () => {
  const prev = process.cwd()
  const project = tmpDir("turnstile-caps-proj-")
  fs.mkdirSync(path.join(project, ".opencode", "plans"), { recursive: true })
  process.chdir(project)
  try {
    // Boot over an empty plans dir: the plan/decomposition gates are no-ops,
    // so only the total budget applies to executor/debugger/unknown names.
    const { h, dispose, metricsDir } = await boot({ maxTotalDispatches: 2 })
    try {
      // executor first: only the total budget applies.
      await dispatch(h, "p1", "executor")
      await dispatch(h, "p1", "debugger")
      await assert.rejects(
        () => dispatch(h, "p1", "", "unknown name"),
        (e: Error) => e instanceof BlockError && e.message === BUDGET_MESSAGE,
      )
      const entries = journalEntries(metricsDir)
      assert.ok(
        entries.some(
          (l) =>
            l.type === "blocked" && l.reason === "dispatch-budget" && l.count === 2 && l.cap === 2,
        ),
      )
      assert.ok(
        entries.some(
          (l) => l.type === "escalation" && l.reason === "dispatch-budget" && l.count === 2,
        ),
      )
    } finally {
      dispose()
    }
  } finally {
    process.chdir(prev)
  }
})

/** The reviewer is counted toward the total budget exactly once
 *  (in countDispatch, never in guardReviewerDispatch). With
 *  maxTotalDispatches: 2 and a high reviewer round cap, the third reviewer
 *  dispatch is blocked by the budget, not by the reviewer round cap. */
test("reviewer counts toward the budget once; budget blocks before the round cap", async () => {
  const { h, dispose, metricsDir } = await boot({
    maxReviewerRounds: 5,
    maxTotalDispatches: 2,
    gateEvidence: "flag",
  })
  await greenGate(h, "p1")
  await dispatch(h, "p1", "reviewer")
  await dispatch(h, "p1", "reviewer")
  await assert.rejects(
    () => dispatch(h, "p1", "reviewer", "budget first"),
    (e: Error) => e instanceof BlockError && e.message === BUDGET_MESSAGE,
  )
  const entries = journalEntries(metricsDir)
  // Round-limit must never fire: all reviewer dispatches under the budget
  // cleared the round cap.
  assert.ok(!entries.some((l) => l.type === "blocked" && l.reason === "round-limit"))
  assert.ok(
    entries.some((l) => l.type === "escalation" && l.reason === "dispatch-budget" && l.count === 2),
  )
  dispose()
})

/** When both the reviewer round cap and the budget are exhausted, the
 *  budget reason wins: the blocking dispatch carries `dispatch-budget`, never
 *  `round-limit`. */
test("both caps exhausted: budget reason wins over the round cap", async () => {
  const { h, dispose, metricsDir } = await boot({
    maxReviewerRounds: 2,
    maxTotalDispatches: 2,
    gateEvidence: "flag",
  })
  await greenGate(h, "p1")
  await dispatch(h, "p1", "reviewer")
  await dispatch(h, "p1", "reviewer")
  // reviewRounds == 2 (round cap exhausted) AND total == 2 (budget exhausted)
  // at the next dispatch; guardDispatchBudget runs first and is the reviewer's
  // only loop backstop, so it blocks on the budget.
  await assert.rejects(
    () => dispatch(h, "p1", "reviewer", "both exhausted"),
    (e: Error) => e instanceof BlockError && e.message === BUDGET_MESSAGE,
  )
  const entries = journalEntries(metricsDir)
  assert.ok(entries.some((l) => l.type === "blocked" && l.reason === "dispatch-budget"))
  assert.ok(!entries.some((l) => l.type === "blocked" && l.reason === "round-limit"))
  dispose()
})

/** With the reviewer round cap at 2 and the total budget at 4, the two
 *  admitted reviewer dispatches fill the round cap and every later attempt
 *  blocks on the round limit — five in a row — and a blocked attempt draws
 *  down nothing: each refusal still names the round cap (never the budget),
 *  the journal carries exactly five paired round-limit blocks and
 *  escalations, and the planner dispatch that follows still passes with the
 *  budget (2) under its ceiling (4). */
test("blocked reviewer rounds draw down no budget: the escalation keeps naming the round cap", async () => {
  const { h, dispose, metricsDir } = await boot({
    maxReviewerRounds: 2,
    maxTotalDispatches: 4,
    gateEvidence: "flag",
  })
  await greenGate(h, "p1")
  await dispatch(h, "p1", "reviewer")
  await dispatch(h, "p1", "reviewer")
  for (let i = 0; i < 5; i++) {
    await assert.rejects(
      () => dispatch(h, "p1", "reviewer", "round limit again"),
      (e: Error) => e instanceof BlockError && e.message === ROUND_LIMIT_MESSAGE,
    )
  }
  const entries = journalEntries(metricsDir)
  const roundBlocks = entries.filter((l) => l.type === "blocked" && l.reason === "round-limit")
  assert.equal(roundBlocks.length, 5, "each blocked round journaled a round-limit block")
  const roundEscalations = entries.filter(
    (l) => l.type === "escalation" && l.reason === "round-limit",
  )
  assert.equal(roundEscalations.length, 5, "each blocked round journaled its escalation")
  assert.ok(
    !entries.some((l) => l.reason === "dispatch-budget"),
    "no budget entry: the blocked rounds drew down nothing",
  )
  // The budget (2) stayed under its ceiling (4): the planner dispatch passes.
  await dispatch(h, "p1", "planner")
  dispose()
})

/** A live prompt-channel waiver exempts the caps and the budget without
 *  counting: many dispatches past every cap all pass and the journal carries
 *  no `blocked` or `escalation` entry. */
test("waiver exempts the caps and budget entirely", async () => {
  const { h, dispose, metricsDir } = await boot()
  await callSession(h, "prompt", { sessionID: "p1", text: "USER WAIVER: ship it" })
  // Far beyond every default cap (planner 3, total 16) — all pass, none counted.
  for (let i = 0; i < 5; i++) await dispatch(h, "p1", "planner")
  const entries = journalEntries(metricsDir)
  assert.ok(!entries.some((l) => l.type === "blocked"))
  assert.ok(!entries.some((l) => l.type === "escalation"))
  dispose()
})

/** A waived reviewer dispatch still journals its gate `WAIVED` entry
 *  from guardReviewerDispatch, but that is not a block: no `blocked`/
 *  `escalation` entries appear. */
test("waived reviewer dispatch journals a gate WAIVED, not a block", async () => {
  const { h, dispose, metricsDir } = await boot({ gateEvidence: "flag" })
  await callSession(h, "prompt", { sessionID: "p1", text: "USER WAIVER: ship it" })
  await greenGate(h, "p1")
  await dispatch(h, "p1", "reviewer")
  const entries = journalEntries(metricsDir)
  assert.ok(entries.some((l) => l.type === "gate" && l.result === "WAIVED"))
  assert.ok(!entries.some((l) => l.type === "blocked"))
  assert.ok(!entries.some((l) => l.type === "escalation"))
  dispose()
})

/** A waived reviewer dispatch is exempt without counting: the budget
 *  counter still reads zero after the dispatch (the compaction snapshot
 *  renders the live counter), and the next reviewer dispatch still passes
 *  at a one-dispatch total budget — the waiver the first dispatch consumed
 *  drew down nothing, so the second, unwaived dispatch finds full headroom. */
test("a waived reviewer dispatch draws down no budget: the next dispatch still passes", async () => {
  const { h, dispose } = await boot({ maxTotalDispatches: 1, gateEvidence: "flag" })
  await callSession(h, "prompt", { sessionID: "p1", text: "USER WAIVER: ship it" })
  await greenGate(h, "p1")
  await dispatch(h, "p1", "reviewer")
  const system: Array<{ type: string; text?: string }> = []
  await callSession(h, "compaction", { system, sessionID: "p1" })
  const snapshot = system.length > 1 ? (system[1]?.text ?? "") : ""
  assert.match(
    snapshot,
    /- rounds: planner=0 plan-reviewer=0 test-runner=0 reviewer=0 total=0/,
    "the waived dispatch drew down no budget",
  )
  // The unscoped waiver was consumed by the first dispatch it unlocked, so
  // this second dispatch is not waived — it passes only because the budget
  // was never drawn down.
  await dispatch(h, "p1", "reviewer")
  dispose()
})

/** Exhausting a leg cap resets on a new prompt: the next planner
 *  dispatch of the fresh task passes. */
test("prompt resets the leg counters", async () => {
  const { h, dispose } = await boot({ maxPlannerRounds: 2 })
  await dispatch(h, "p1", "planner")
  await dispatch(h, "p1", "planner")
  await assert.rejects(
    () => dispatch(h, "p1", "planner", "exhausted"),
    (e: Error) => e instanceof BlockError && e.message === PLANNER_LOOP_CAP_MESSAGE,
  )
  await callSession(h, "prompt", { sessionID: "p1", text: "a fresh task" })
  // Fresh counters: this first planner dispatch of the new task passes.
  await dispatch(h, "p1", "planner", "new task")
  dispose()
})

/** The reviewer round-limit path still journals the paired escalation
 *  entry beside the round-limit block at the default round cap. */
test("reviewer round limit journals escalation beside the block", async () => {
  const { h, dispose, metricsDir } = await boot({ gateEvidence: "flag" })
  await greenGate(h, "p1")
  await dispatch(h, "p1", "reviewer")
  await dispatch(h, "p1", "reviewer")
  await assert.rejects(
    () => dispatch(h, "p1", "reviewer", "round limit"),
    (e: Error) => e instanceof BlockError && e.message === ROUND_LIMIT_MESSAGE,
  )
  const entries = journalEntries(metricsDir)
  // The blocked round-limit entry keeps its pre-existing shape (no count/cap);
  // the paired escalation entry carries count/cap.
  assert.ok(entries.some((l) => l.type === "blocked" && l.reason === "round-limit"))
  assert.ok(
    entries.some(
      (l) => l.type === "escalation" && l.reason === "round-limit" && l.count === 2 && l.cap === 2,
    ),
  )
  dispose()
})

/** Every loop-cap rejection is a BlockError with the
 *  `BLOCKED by turnstile:` prefix. */
test("every loop-cap rejection is a BLOCKED-by-turnstile BlockError", async () => {
  const { h, dispose } = await boot({ maxPlannerRounds: 2 })
  await dispatch(h, "p1", "planner")
  await dispatch(h, "p1", "planner")
  await assert.rejects(
    () => dispatch(h, "p1", "planner", "third"),
    (e: Error) =>
      e instanceof BlockError &&
      e.message.startsWith("BLOCKED by turnstile:") &&
      e.message === PLANNER_LOOP_CAP_MESSAGE,
  )
  dispose()
})
