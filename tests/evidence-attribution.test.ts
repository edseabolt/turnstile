/**
 * @fileoverview Evidence-attribution integration tests: a background
 * test-runner's late-resolving child→parent edge back-fills a pending
 * unverified PASS (edge-resolution and decision-time re-checks), the
 * task-window bound keeps a stale prior-task execution from verifying a new
 * task's claim, and a gate-unverified refusal names the sessions it searched
 * (attributed-but-stale, no-parent-edge, other-parent) in the message and
 * the `searched` journal field. Delivery shapes covered: parent-keyed,
 * child-keyed, and streamed child text.
 */

import { test } from "node:test"
import assert from "node:assert/strict"

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

const PASS = "GATE: PASS tests=3 passed=3 failed=0"

/** Boots the plugin over a fake host with a temp metrics dir. */
async function boot(opts?: {
  gateEvidence?: "enforce" | "flag" | "off"
  sessionRecords?: Map<string, any>
}): Promise<{ h: FakeHost; dispose: () => void; metricsDir: string }> {
  const metricsDir = tmpDir()
  const h = makeFakeHost({ sessionRecords: opts?.sessionRecords })
  const setup = turnstile(h.host, {
    env: isolatedEnv(metricsDir),
    config: {
      metricsDir,
      alwaysEnforce: true,
      ...(opts?.gateEvidence ? { gateEvidence: opts.gateEvidence } : {}),
    },
  })
  const dispose = (await setup(h.host)) as () => void
  return { h, dispose, metricsDir }
}

/**
 * Pushes a `session.created` edge event, then a warmup error event that
 * confirms (FIFO stream order) the created event was already processed.
 * @param h The fake host.
 * @param child The child session ID.
 * @param parent The parent session ID.
 * @param metricsDir The metrics dir to poll for the warmup signal.
 */
async function resolveEdgeViaCreated(
  h: FakeHost,
  child: string,
  parent: string,
  metricsDir: string,
): Promise<void> {
  h.pushEvent({ type: "session.created", data: { sessionID: child, parentID: parent } })
  h.pushEvent({ type: "session.error", data: { sessionID: child, error: "warmup" } })
  await waitUntil(() =>
    journalEntries(metricsDir).some((l) => l.type === "error" && l.error === "warmup"),
  )
}

/** A distinct-millisecond gap so a later hit strictly postdates an earlier one. */
const gap = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 10))

/** Primary shape: a background child runs the tests before its edge is
 *  known; the parent-keyed delivery records the PASS unverified; the late
 *  session.created edge back-fills the promotion and the first reviewer
 *  dispatch is allowed — no waiver, no re-dispatch. */
test("a late session.created edge back-fills a pending unverified PASS from a background child", async () => {
  const { h, dispose, metricsDir } = await boot()
  await callSession(h, "prompt", { sessionID: "p1", text: "run the pipeline" })
  await callTool(h, "execute.after", {
    tool: "bash",
    sessionID: "c1",
    input: { command: "npm test" },
    result: { metadata: { exit: 0 } },
  })
  // Parent-keyed delivery: the edge is still unresolved at parse time.
  await callTool(h, "execute.after", {
    tool: "task",
    sessionID: "p1",
    input: { agent: "test-runner" },
    result: { output: `${PASS}\nrest` },
  })
  assert.equal(
    journalEntries(metricsDir).find((l) => l.type === "gate" && l.result === "PASS")?.verified,
    false,
    "the PASS is recorded unverified while the edge is unresolved",
  )
  await resolveEdgeViaCreated(h, "c1", "p1", metricsDir)
  const promos = journalEntries(metricsDir).filter(
    (l) => l.type === "gate" && l.event === "promoted",
  )
  assert.equal(promos.length, 1, "the edge resolution back-fills exactly one promotion")
  assert.equal(promos[0]!.verified, true)
  assert.equal(promos[0]!.mode, "enforce")
  // The first reviewer dispatch is allowed; the unwaived dispatch is counted.
  await callTool(h, "execute.before", {
    tool: "task",
    sessionID: "p1",
    input: { agent: "reviewer", prompt: "review it" },
  })
  const ensemble = journalEntries(metricsDir).find((l) => l.type === "ensemble")
  assert.equal(ensemble?.count, 1)
  dispose()
})

/** A child-keyed test-runner delivery awaits the child→parent edge (host
 *  session.get) before the marker parses, so the PASS verifies in one step
 *  at delivery — no promotion needed. */
test("a child-keyed test-runner delivery resolves its late edge before the marker parses", async () => {
  const records = new Map<string, any>([["c1", { parentID: "p1", agent: "test-runner" }]])
  const { h, dispose, metricsDir } = await boot({ sessionRecords: records })
  await callSession(h, "prompt", { sessionID: "p1", text: "run the pipeline" })
  await callTool(h, "execute.after", {
    tool: "bash",
    sessionID: "c1",
    input: { command: "npm test" },
    result: { metadata: { exit: 0 } },
  })
  await callTool(h, "execute.after", {
    tool: "task",
    sessionID: "c1",
    input: { agent: "test-runner" },
    result: { output: `${PASS}\nrest` },
  })
  const gate = journalEntries(metricsDir).find((l) => l.type === "gate" && l.result === "PASS")
  assert.equal(gate?.verified, true, "the edge is awaited, so the PASS verifies at delivery")
  assert.equal(gate?.raw, "c1")
  assert.equal(
    journalEntries(metricsDir).some((l) => l.type === "gate" && l.event === "promoted"),
    false,
    "no promotion: the claim never sat unverified",
  )
  await callTool(h, "execute.before", {
    tool: "task",
    sessionID: "p1",
    input: { agent: "reviewer", prompt: "review it" },
  })
  dispose()
})

/** A streamed PASS attributes through a session.get-only edge with no
 *  session.created event on this host; the first reviewer dispatch succeeds
 *  (no block-then-allow shape needed). */
test("a streamed PASS attributes through a session.get-only edge with no session.created event", async () => {
  const records = new Map<string, any>([["c1", { parentID: "p1", agent: "test-runner" }]])
  const { h, dispose, metricsDir } = await boot({ sessionRecords: records })
  await callSession(h, "prompt", { sessionID: "p1", text: "run the pipeline" })
  await callTool(h, "execute.after", {
    tool: "bash",
    sessionID: "c1",
    input: { command: "npm test" },
    result: { metadata: { exit: 0 } },
  })
  h.pushEvent({
    type: "session.text.ended",
    data: { sessionID: "c1", text: `tests done\n${PASS}` },
  })
  await waitUntil(() =>
    journalEntries(metricsDir).some((l) => l.type === "gate" && l.result === "PASS"),
  )
  assert.equal(
    journalEntries(metricsDir).find((l) => l.type === "gate" && l.result === "PASS")?.verified,
    true,
  )
  await callTool(h, "execute.before", {
    tool: "task",
    sessionID: "p1",
    input: { agent: "reviewer", prompt: "review it" },
  })
  dispose()
})

/** Task window: a prior-task execution (its edge still unresolved) cannot
 *  verify the new task's PASS once a prompt stamps the window; the refusal
 *  names the child as an attributed-but-stale miss; an in-window re-run
 *  verifies without a waiver or a re-dispatch. */
test("a stale prior-task execution cannot verify a new task's PASS; an in-window re-run does", async () => {
  const { h, dispose, metricsDir } = await boot()
  // Prior task: the child ran the tests, edge still unresolved.
  await callTool(h, "execute.after", {
    tool: "bash",
    sessionID: "c1",
    input: { command: "npm test" },
    result: { metadata: { exit: 0 } },
  })
  await gap()
  // A new task is admitted: the window stamp strictly postdates the stale hit.
  await callSession(h, "prompt", { sessionID: "p1", text: "next task" })
  await callTool(h, "execute.after", {
    tool: "task",
    sessionID: "p1",
    input: { agent: "test-runner" },
    result: { output: `${PASS}\nrest` },
  })
  assert.equal(
    journalEntries(metricsDir).find((l) => l.type === "gate" && l.result === "PASS")?.verified,
    false,
  )
  // The late edge back-fills nothing: the execution predates the window.
  await resolveEdgeViaCreated(h, "c1", "p1", metricsDir)
  assert.equal(
    journalEntries(metricsDir).some((l) => l.type === "gate" && l.event === "promoted"),
    false,
    "the stale execution is outside the task window",
  )
  await assert.rejects(
    () =>
      callTool(h, "execute.before", {
        tool: "task",
        sessionID: "p1",
        input: { agent: "reviewer", prompt: "review it" },
      }),
    (e: Error) =>
      e.message ===
      "BLOCKED by turnstile: reviewer dispatch without gate evidence: a GATE: PASS " +
        "was recorded without a journaled successful test-command execution for this " +
        "session (searched p1; journaled test executions: c1 (executions predate the current task window)). " +
        "Run the test-runner subagent first, or obtain an explicit user waiver " +
        "(a user prompt this task must contain the literal marker 'USER WAIVER:' followed by the user's words).",
  )
  const blocked = journalEntries(metricsDir).find(
    (l) => l.type === "blocked" && l.reason === "gate-unverified",
  )
  assert.deepEqual(blocked?.searched, ["p1", "c1"])
  // An in-window re-run verifies without a waiver or a re-dispatch.
  await callTool(h, "execute.after", {
    tool: "bash",
    sessionID: "c1",
    input: { command: "npm test" },
    result: { metadata: { exit: 0 } },
  })
  assert.equal(
    journalEntries(metricsDir).filter((l) => l.type === "gate" && l.event === "promoted").length,
    1,
  )
  await callTool(h, "execute.before", {
    tool: "task",
    sessionID: "p1",
    input: { agent: "reviewer", prompt: "review it" },
  })
  dispose()
})

/** With evidence genuinely unattributable, the refusal and the
 *  journaled blocked entry name the searched parent and every child with
 *  journaled executions, each labeled with its attribution reason. */
test("a gate-unverified refusal names the searched parent and every unattributable child", async () => {
  const { h, dispose, metricsDir } = await boot()
  await callSession(h, "prompt", { sessionID: "p1", text: "run the pipeline" })
  // c1 ran the tests but has no registered edge; c2 belongs to a different
  // parent.
  await callTool(h, "execute.after", {
    tool: "bash",
    sessionID: "c1",
    input: { command: "npm test" },
    result: { metadata: { exit: 0 } },
  })
  await resolveEdgeViaCreated(h, "c2", "p2", metricsDir)
  await callTool(h, "execute.after", {
    tool: "bash",
    sessionID: "c2",
    input: { command: "npm test" },
    result: { metadata: { exit: 0 } },
  })
  await callTool(h, "execute.after", {
    tool: "task",
    sessionID: "p1",
    input: { agent: "test-runner" },
    result: { output: `${PASS}\nrest` },
  })
  assert.equal(
    journalEntries(metricsDir).find((l) => l.type === "gate" && l.result === "PASS")?.verified,
    false,
  )
  await assert.rejects(
    () =>
      callTool(h, "execute.before", {
        tool: "task",
        sessionID: "p1",
        input: { agent: "reviewer", prompt: "review it" },
      }),
    (e: Error) =>
      e.message ===
      "BLOCKED by turnstile: reviewer dispatch without gate evidence: a GATE: PASS " +
        "was recorded without a journaled successful test-command execution for this " +
        "session (searched p1; journaled test executions: none — 2 child sessions with executions were unattributable: c1 (no parent edge), c2 (edge: p2)). " +
        "Run the test-runner subagent first, or obtain an explicit user waiver " +
        "(a user prompt this task must contain the literal marker 'USER WAIVER:' followed by the user's words).",
  )
  const blocked = journalEntries(metricsDir).find(
    (l) => l.type === "blocked" && l.reason === "gate-unverified",
  )
  assert.deepEqual(blocked?.searched, ["p1", "c1", "c2"])
  dispose()
})

/** flag and off modes: the new re-check triggers never flip or mint state —
 *  the gate entry keeps its legacy stamping and no promoted entry appears,
 *  while the reviewer dispatch (which runs the decision-time path) is
 *  allowed. */
test("flag and off modes: the new re-check triggers never flip or mint state", async () => {
  for (const mode of ["flag", "off"] as const) {
    const { h, dispose, metricsDir } = await boot({ gateEvidence: mode })
    await callSession(h, "prompt", { sessionID: "p1", text: "run the pipeline" })
    await callTool(h, "execute.after", {
      tool: "bash",
      sessionID: "c1",
      input: { command: "npm test" },
      result: { metadata: { exit: 0 } },
    })
    await callTool(h, "execute.after", {
      tool: "task",
      sessionID: "p1",
      input: { agent: "test-runner" },
      result: { output: `${PASS}\nrest` },
    })
    await resolveEdgeViaCreated(h, "c1", "p1", metricsDir)
    const gate = journalEntries(metricsDir).find((l) => l.type === "gate" && l.result === "PASS")
    if (mode === "flag") {
      assert.equal(gate?.verified, false)
      assert.equal(gate?.mode, "flag")
    } else {
      assert.equal(gate?.verified, undefined)
      assert.equal(gate?.mode, undefined)
    }
    assert.equal(
      journalEntries(metricsDir).some((l) => l.type === "evidence" && mode === "off"),
      false,
      "off mode never journals evidence",
    )
    assert.equal(
      journalEntries(metricsDir).some((l) => l.type === "gate" && l.event === "promoted"),
      false,
      `${mode}: no promotion`,
    )
    // The reviewer dispatch runs the decision-time re-check and is allowed.
    await callTool(h, "execute.before", {
      tool: "task",
      sessionID: "p1",
      input: { agent: "reviewer", prompt: "review it" },
    })
    assert.equal(
      journalEntries(metricsDir).some((l) => l.type === "gate" && l.event === "promoted"),
      false,
      `${mode}: still no promotion after the dispatch`,
    )
    dispose()
  }
})
