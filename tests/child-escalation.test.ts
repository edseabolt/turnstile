/**
 * @fileoverview Child-session escalation tests: a subagent that exhausts a
 * dispatch cap (reviewer round limit, per-leg loop cap, total dispatch budget)
 * is dead-ended by gate state alone under the host architecture — a child
 * never admits a user prompt, so a block that tells it to "wait for new
 * instructions" points at a reset that never arrives. The fix routes the
 * escalation back through the child's delivery to the prompt-reachable parent:
 * the block on an edge-registered child swaps the wait-for-a-new-prompt tail
 * for an end-the-turn-and-report clause (so the message carries no "wait for
 * new instructions" promise and no config-widening hint), stamps the parent
 * on the `blocked` + `escalation` journal entries, and the parent's next prompt
 * releases the child's metering counters (journaled as a `child-reset`). The
 * parent-path (no-edge) messages stay byte-identical to the legacy strings.
 * All via a fake host with injected config; child edges are seeded through the
 * created-edge stream and confirmed in-order by a warmup `session.error`.
 */

import { test } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"

import { BlockError } from "../src/gates.ts"
import { turnstile } from "../turnstile.ts"
import {
  callSession,
  callTool,
  isolatedEnv,
  journalEntries,
  makeFakeHost,
  tmpDir,
  waitUntil,
  type FakeHost,
} from "./helpers.ts"

/** The round-limit body through its escalation payload (shared by the parent
 *  and child arms; the recovery tail is what differs). */
const ROUND_LIMIT_BODY =
  "BLOCKED by turnstile: reviewer round limit (2) reached — the pipeline is looping. " +
  "STOP: do not re-dispatch the reviewer. Escalate the open findings to the user"

/** The planner loop-cap body at cap 2. */
const PLANNER_LOOP_CAP_BODY =
  "BLOCKED by turnstile: planner dispatch limit (2) reached this task — the pipeline is looping. " +
  "STOP: do not re-dispatch planner. Escalate to the user: report the repeated planner failures"

/** The total-dispatch-budget body at cap 2. */
const BUDGET_BODY =
  "BLOCKED by turnstile: task dispatch budget (2) exhausted — the pipeline is looping. " +
  "STOP: do not dispatch further subagents. Escalate to the user: report the stuck pipeline"

/** The clause a round-limit block appends when a scoped waiver's own
 *  allowance of waiver-unblocked dispatches is exhausted. */
const ALLOWANCE_CLAUSE =
  " The scoped waiver's allowance of 2 waiver-unblocked dispatches is exhausted; obtain a new waiver or escalate to the user."

/** The child recovery tail: the end-the-turn-and-report clause an
 *  edge-registered child gets instead of the parent's wait-for-a-new-prompt
 *  clause. `what` names the site's escalation payload. */
function childTail(what: string): string {
  return ` now: finish your turn and put ${what} in your final output — your delivery reaches the parent orchestrator, and the parent's next user prompt releases your counters; this session never receives user prompts.`
}

/** The reviewer round-limit child block message (body + child tail, no clause). */
const ROUND_LIMIT_CHILD_MESSAGE = ROUND_LIMIT_BODY + childTail("the open findings")

/** The planner loop-cap child block message (body + child tail, no clause). */
const PLANNER_LOOP_CAP_CHILD_MESSAGE =
  PLANNER_LOOP_CAP_BODY + childTail("the repeated planner failures")

/** The total-dispatch-budget child block message (body + child tail, no clause). */
const BUDGET_CHILD_MESSAGE = BUDGET_BODY + childTail("the stuck pipeline")

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

/**
 * Boots the plugin in an isolated temp project dir that carries a
 * `.opencode/plans` file and switches the working directory there, returning
 * the host, metrics dir, project path, and a `restore` that disposes and
 * returns to the previous directory. The project dir is a fresh temp dir
 * (not a git worktree), so the continuation fingerprint is its resolved path.
 */
async function bootProject(
  config: Record<string, any> = {},
): Promise<{ h: FakeHost; metricsDir: string; project: string; restore: () => void }> {
  const project = tmpDir()
  fs.mkdirSync(path.join(project, ".opencode", "plans"), { recursive: true })
  fs.writeFileSync(path.join(project, ".opencode", "plans", "plan.md"), "# P\n")
  const metricsDir = tmpDir()
  const h = makeFakeHost()
  const prev = process.cwd()
  process.chdir(project)
  const setup = turnstile(h.host, {
    env: isolatedEnv(metricsDir),
    config: { metricsDir, ...config },
  })
  const dispose = (await setup(h.host)) as () => void
  return {
    h,
    metricsDir,
    project,
    restore: (): void => {
      dispose()
      process.chdir(prev)
    },
  }
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

/** Seeds a child→parent edge via the created-edge stream and waits for
 *  in-order consumption: when the warmup `session.error` lands, the preceding
 * `session.created` event has been processed and the edge is set. */
async function seedEdge(
  h: FakeHost,
  metricsDir: string,
  childID: string,
  parentID: string,
  agent: string,
): Promise<void> {
  h.pushEvent({
    type: "session.created",
    properties: { sessionID: childID, parentID, agent },
  })
  h.pushEvent({ type: "session.error", properties: { sessionID: childID, error: "warmup" } })
  await waitUntil(() =>
    journalEntries(metricsDir).some((l) => l.type === "error" && l.error === "warmup"),
  )
}

/** Asserts a child block carried the recovery tail (not the legacy
 *  wait-for-a-new-prompt promise or a config-widening hint). */
function assertChildTail(message: string): void {
  assert.ok(message.includes("finish your turn and put"), "child block names the end-turn action")
  assert.ok(
    !message.includes("wait for new instructions"),
    "child block carries no wait-for-a-new-prompt promise",
  )
  assert.ok(
    !message.includes("in your config to widen"),
    "child block carries no config-widening hint",
  )
}

/** A blocked edge-registered child at the reviewer round limit gets the child
 *  recovery tail (body + end-the-turn-and-report clause), never the
 *  wait-for-a-new-prompt promise, and the `blocked` + `escalation` entries are
 *  stamped with the parent. */
test("round-limit block on an edge-registered child carries the child tail and parent stamp", async () => {
  // flag mode: a bare GATE: PASS flips the gate, so the child's own bucket
  // goes green without a real test execution.
  const { h, dispose, metricsDir } = await boot({ gateEvidence: "flag" })
  try {
    // Green the child's OWN bucket before the edge exists: with no registered
    // edge the delivery self-keys, so hasGatePass lands on c1, not p1.
    await greenGate(h, "c1")
    await seedEdge(h, metricsDir, "c1", "p1", "reviewer")
    // Two reviewer dispatches pass (the round cap is 2); the third blocks.
    await dispatch(h, "c1", "reviewer")
    await dispatch(h, "c1", "reviewer")
    await assert.rejects(
      () => dispatch(h, "c1", "reviewer", "round limit"),
      (e: Error) => e instanceof BlockError && e.message === ROUND_LIMIT_CHILD_MESSAGE,
    )
    assertChildTail(ROUND_LIMIT_CHILD_MESSAGE)
    const entries = journalEntries(metricsDir)
    assert.ok(
      entries.some(
        (l) =>
          l.type === "blocked" &&
          l.reason === "round-limit" &&
          l.sessionID === "c1" &&
          l.parent === "p1",
      ),
      "round-limit blocked entry stamps the parent",
    )
    assert.ok(
      entries.some(
        (l) =>
          l.type === "escalation" &&
          l.reason === "round-limit" &&
          l.sessionID === "c1" &&
          l.parent === "p1" &&
          l.count === 2 &&
          l.cap === 2,
      ),
      "round-limit escalation entry stamps the parent",
    )
  } finally {
    dispose()
  }
})

/** A blocked edge-registered child at the planner leg loop cap gets the child
 *  recovery tail, never the wait-for-a-new-prompt promise or the
 *  config-widening hint, and the journal entries stamp the parent. */
test("loop-cap block on an edge-registered child carries the child tail and parent stamp", async () => {
  const { h, dispose, metricsDir } = await boot({ maxPlannerRounds: 2 })
  try {
    await seedEdge(h, metricsDir, "c1", "p1", "planner")
    // Two planner dispatches pass (the leg cap is 2); the third blocks.
    await dispatch(h, "c1", "planner")
    await dispatch(h, "c1", "planner")
    await assert.rejects(
      () => dispatch(h, "c1", "planner", "loop again"),
      (e: Error) => e instanceof BlockError && e.message === PLANNER_LOOP_CAP_CHILD_MESSAGE,
    )
    assertChildTail(PLANNER_LOOP_CAP_CHILD_MESSAGE)
    const entries = journalEntries(metricsDir)
    assert.ok(
      entries.some(
        (l) =>
          l.type === "blocked" &&
          l.reason === "loop-cap" &&
          l.leg === "planner" &&
          l.sessionID === "c1" &&
          l.parent === "p1",
      ),
      "loop-cap blocked entry stamps the parent",
    )
    assert.ok(
      entries.some(
        (l) =>
          l.type === "escalation" &&
          l.reason === "loop-cap" &&
          l.sessionID === "c1" &&
          l.parent === "p1",
      ),
      "loop-cap escalation entry stamps the parent",
    )
  } finally {
    dispose()
  }
})

/** A blocked edge-registered child that exhausts the total dispatch budget
 *  gets the child recovery tail, never the wait-for-a-new-prompt promise or
 *  the config-widening hint, and the journal entries stamp the parent. */
test("dispatch-budget block on an edge-registered child carries the child tail and parent stamp", async () => {
  const { h, dispose, metricsDir } = await boot({ maxTotalDispatches: 2 })
  try {
    await seedEdge(h, metricsDir, "c1", "p1", "debugger")
    // Two debugger dispatches pass (budget-only drawdown: no leg, no plan
    // gate); the third blocks on the budget.
    await dispatch(h, "c1", "debugger")
    await dispatch(h, "c1", "debugger")
    await assert.rejects(
      () => dispatch(h, "c1", "debugger", "stuck"),
      (e: Error) => e instanceof BlockError && e.message === BUDGET_CHILD_MESSAGE,
    )
    assertChildTail(BUDGET_CHILD_MESSAGE)
    const entries = journalEntries(metricsDir)
    assert.ok(
      entries.some(
        (l) =>
          l.type === "blocked" &&
          l.reason === "dispatch-budget" &&
          l.sessionID === "c1" &&
          l.parent === "p1",
      ),
      "dispatch-budget blocked entry stamps the parent",
    )
    assert.ok(
      entries.some(
        (l) =>
          l.type === "escalation" &&
          l.reason === "dispatch-budget" &&
          l.sessionID === "c1" &&
          l.parent === "p1",
      ),
      "dispatch-budget escalation entry stamps the parent",
    )
  } finally {
    dispose()
  }
})

/** The scoped-waiver allowance clause stays last on a child round-limit block,
 *  exactly as it does on the parent path: body + child recovery tail + clause. */
test("scoped-waiver child round-limit block keeps the allowance clause last", async () => {
  const { h, dispose, metricsDir } = await boot()
  try {
    await seedEdge(h, metricsDir, "c1", "p1", "reviewer")
    // A reviewer-scoped waiver captured on the child's bucket from a user
    // prompt: it exempts the reviewer from the gate and the budget, so the
    // only backstop is the scoped-waiver allowance (metered on its own counter).
    await callSession(h, "prompt", {
      sessionID: "c1",
      text: "USER WAIVER: I approve the reviewer",
    })
    // Two waiver-unblocked reviewer dispatches pass; the third exhausts the
    // allowance and blocks with the child tail and the clause appended last.
    await dispatch(h, "c1", "reviewer")
    await dispatch(h, "c1", "reviewer")
    const expected = ROUND_LIMIT_BODY + childTail("the open findings") + ALLOWANCE_CLAUSE
    await assert.rejects(
      () => dispatch(h, "c1", "reviewer", "allowance exhausted"),
      (e: Error) => e instanceof BlockError && e.message === expected,
    )
    assertChildTail(expected)
    assert.ok(
      expected.endsWith(ALLOWANCE_CLAUSE),
      "the allowance clause is the last segment of the child block",
    )
    const entries = journalEntries(metricsDir)
    assert.ok(
      entries.some(
        (l) =>
          l.type === "escalation" &&
          l.reason === "round-limit" &&
          l.sessionID === "c1" &&
          l.parent === "p1",
      ),
      "scoped-waiver child round-limit escalation stamps the parent",
    )
  } finally {
    dispose()
  }
})

/**
 * The parent's next prompt releases a cap-blocked child's metering counters:
 * a child blocked at the reviewer round limit is unblocked by one parent
 * prompt (a `child-reset` entry journaled with the freed count), a
 * consecutive second prompt with no intervening dispatch frees nothing (no
 * further entry), and the previously blocked reviewer dispatch then passes —
 * the reset zeroes the metering counters but leaves the earned gate green.
 */
test("a parent prompt releases a cap-blocked child's counters exactly once", async () => {
  const { h, dispose, metricsDir } = await boot({ gateEvidence: "flag" })
  try {
    await greenGate(h, "c1")
    await seedEdge(h, metricsDir, "c1", "p1", "reviewer")
    // Two reviewer dispatches pass (the round cap is 2); the third blocks.
    await dispatch(h, "c1", "reviewer")
    await dispatch(h, "c1", "reviewer")
    await assert.rejects(
      () => dispatch(h, "c1", "reviewer", "round limit"),
      (e: Error) => e instanceof BlockError && e.message === ROUND_LIMIT_CHILD_MESSAGE,
    )
    assert.ok(
      !journalEntries(metricsDir).some((l) => l.type === "child-reset"),
      "a blocked child is not released until the parent prompts",
    )
    // The parent's next prompt releases the child's counters.
    await callSession(h, "prompt", { sessionID: "p1", text: "a fresh task" })
    const freed = journalEntries(metricsDir).filter((l) => l.type === "child-reset")
    assert.equal(freed.length, 1, "one child-reset entry per prompt that frees")
    assert.equal(freed[0]!.sessionID, "p1", "the child-reset entry names the parent")
    assert.equal(freed[0]!.children, 1, "the child-reset entry counts the freed child")
    // A consecutive prompt with no intervening dispatch frees nothing.
    await callSession(h, "prompt", { sessionID: "p1", text: "carry on" })
    assert.equal(
      journalEntries(metricsDir).filter((l) => l.type === "child-reset").length,
      1,
      "a prompt that frees no child journals no child-reset",
    )
    // The previously blocked reviewer dispatch now passes: the round counter
    // is zero and the earned gate survived the release.
    await dispatch(h, "c1", "reviewer")
  } finally {
    dispose()
  }
})

/**
 * The release is cap-agnostic: a child blocked at the total dispatch budget is
 * unblocked by one parent prompt exactly as a round- or leg-capped child is —
 * one `child-reset` entry, and the previously blocked dispatch passes.
 */
test("a parent prompt releases a budget-capped child's counters", async () => {
  const { h, dispose, metricsDir } = await boot({ maxTotalDispatches: 2 })
  try {
    await seedEdge(h, metricsDir, "c1", "p1", "debugger")
    // Two debugger dispatches pass (budget-only drawdown: no leg, no plan
    // gate); the third blocks on the budget.
    await dispatch(h, "c1", "debugger")
    await dispatch(h, "c1", "debugger")
    await assert.rejects(
      () => dispatch(h, "c1", "debugger", "stuck"),
      (e: Error) => e instanceof BlockError && e.message === BUDGET_CHILD_MESSAGE,
    )
    await callSession(h, "prompt", { sessionID: "p1", text: "a fresh task" })
    const freed = journalEntries(metricsDir).filter((l) => l.type === "child-reset")
    assert.equal(freed.length, 1, "one child-reset entry for the budget-capped child")
    assert.equal(freed[0]!.children, 1, "the child-reset entry counts the freed child")
    // The previously blocked dispatch now passes: the budget counter is zero.
    await dispatch(h, "c1", "debugger")
  } finally {
    dispose()
  }
})

/**
 * A prompt with an edge-registered child that has no state bucket (it never
 * dispatched) releases nothing: the pending child verdict is cleared, but no
 * `child-reset` entry is journaled because no counter was nonzero.
 */
test("a prompt with an unminted child bucket journals no child-reset", async () => {
  const { h, dispose, metricsDir } = await boot()
  try {
    await seedEdge(h, metricsDir, "c1", "p1", "reviewer")
    await callSession(h, "prompt", { sessionID: "p1", text: "a fresh task" })
    assert.ok(
      !journalEntries(metricsDir).some((l) => l.type === "child-reset"),
      "no child-reset when the child bucket is unminted",
    )
  } finally {
    dispose()
  }
})

/**
 * The release also runs on the continuation-carry prompt path: with carry on
 * and a planner leg cap of 2, a child blocked at the cap is unblocked by the
 * parent's next prompt (a `child-reset` entry journaled even though there is
 * no earned gate to carry), and the previously blocked planner dispatch
 * passes.
 */
test("a parent prompt under continuation carry releases a cap-blocked child's counters", async () => {
  const { h, metricsDir, restore } = await bootProject({
    continuationCarry: true,
    maxPlannerRounds: 2,
  })
  try {
    await seedEdge(h, metricsDir, "c1", "p1", "planner")
    // Two planner dispatches pass (the leg cap is 2); the third blocks.
    await dispatch(h, "c1", "planner")
    await dispatch(h, "c1", "planner")
    await assert.rejects(
      () => dispatch(h, "c1", "planner", "loop again"),
      (e: Error) => e instanceof BlockError && e.message === PLANNER_LOOP_CAP_CHILD_MESSAGE,
    )
    // The parent's first prompt takes the carry path; it releases the
    // child's counters even though nothing is carried.
    await callSession(h, "prompt", { sessionID: "p1", text: "a fresh task" })
    const freed = journalEntries(metricsDir).filter((l) => l.type === "child-reset")
    assert.equal(freed.length, 1, "the carry path journals child-reset when it frees")
    assert.equal(freed[0]!.sessionID, "p1", "the child-reset entry names the parent")
    assert.equal(freed[0]!.children, 1, "the child-reset entry counts the freed child")
    // The previously blocked planner dispatch now passes: the leg counter is
    // zero again.
    await dispatch(h, "c1", "planner")
  } finally {
    restore()
  }
})
