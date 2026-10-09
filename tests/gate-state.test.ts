/**
 * @fileoverview Gate-state tests: reviewer dispatch gate, waivers, the
 * dispatch-based round cap, marker dedup, journal replay, read horizon
 * (parent-keyed), bare-output scoping, decoding clamps, the decomposition
 * gate, and the stream-event loop (child→parent resolution and child-text
 * marker parsing) — all via a fake host with injected config.
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
  waitUntil,
  type FakeHost,
} from "./helpers.ts"

const NO_GATE_MESSAGE =
  "BLOCKED by turnstile: no reviewer dispatch before the test gate is green. " +
  "Run the test-runner subagent first; dispatch reviewer only after its first line is " +
  "`GATE: PASS tests=<n> passed=<n> failed=<n>`, or obtain an explicit user waiver " +
  "(the dispatch prompt must contain the literal marker 'USER WAIVER:' followed by the user's words)."

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

/** The exact enforcement message must be thrown (as BlockError) and journaled. */
test("reviewer dispatch is blocked before any GATE: PASS, with the exact message", async () => {
  const { h, dispose, metricsDir } = await boot()
  await assert.rejects(
    () =>
      callTool(h, "execute.before", {
        tool: "task",
        sessionID: "p1",
        input: { agent: "reviewer", prompt: "review it" },
      }),
    (e: Error) => e.message === NO_GATE_MESSAGE && e instanceof BlockError,
  )
  const entries = journalEntries(metricsDir)
  assert.ok(entries.some((l) => l.type === "dispatch" && l.agent === "reviewer"))
  assert.ok(entries.some((l) => l.type === "blocked" && l.reason === "no-gate-pass"))
  dispose()
})

/** The literal USER WAIVER: marker allows the dispatch and the quote is journaled. */
test("USER WAIVER: in the prompt waives the gate and is journaled", async () => {
  const { h, dispose, metricsDir } = await boot()
  await callTool(h, "execute.before", {
    tool: "task",
    sessionID: "p1",
    input: { agent: "reviewer", prompt: "USER WAIVER: user said ship it" },
  })
  const waived = journalEntries(metricsDir).find((l) => l.type === "gate" && l.result === "WAIVED")
  assert.ok(waived)
  assert.equal(waived.waiver, "USER WAIVER: user said ship it")
  dispose()
})

/** Waivers are per dispatch: the next marker-less prompt is blocked again. */
test("waiver is per dispatch: a later marker-less prompt is blocked again", async () => {
  const { h, dispose } = await boot()
  await callTool(h, "execute.before", {
    tool: "task",
    sessionID: "p1",
    input: { agent: "reviewer", prompt: "USER WAIVER: user said ship it" },
  })
  await assert.rejects(
    () =>
      callTool(h, "execute.before", {
        tool: "task",
        sessionID: "p1",
        input: { agent: "reviewer", prompt: "review it again" },
      }),
    (e: Error) => e.message === NO_GATE_MESSAGE,
  )
  dispose()
})

/** With trace:false the waiver quote is redacted to "<present>" in the journal. */
test("trace:false redacts the waiver quote in the journal", async () => {
  const { h, dispose, metricsDir } = await boot({ trace: false })
  await callTool(h, "execute.before", {
    tool: "task",
    sessionID: "p1",
    input: { agent: "reviewer", prompt: "USER WAIVER: sensitive user words here" },
  })
  const waived = journalEntries(metricsDir).find((l) => l.type === "gate" && l.result === "WAIVED")
  assert.ok(waived)
  assert.equal(waived.waiver, "<present>")
  dispose()
})

/** A test-runner GATE: PASS keys the gate to the parent, unblocking the reviewer. */
test("a test-runner GATE: PASS flips the gate and the reviewer is allowed", async () => {
  const { h, dispose, metricsDir } = await boot()
  await callTool(h, "execute.after", {
    tool: "task",
    sessionID: "p1",
    input: { agent: "test-runner" },
    result: { output: "GATE: PASS tests=3 passed=3 failed=0\nrest" },
  })
  await callTool(h, "execute.before", {
    tool: "task",
    sessionID: "p1",
    input: { agent: "reviewer", prompt: "review it" },
  })
  const gate = journalEntries(metricsDir).find((l) => l.type === "gate" && l.result === "PASS")
  assert.ok(gate)
  assert.equal(gate.sessionID, "p1")
  assert.equal(gate.raw, "p1")
  dispose()
})

/** A later GATE: FAIL un-greens the gate: the reviewer is blocked again. */
test("a GATE: FAIL after a PASS re-blocks reviewer dispatch", async () => {
  const { h, dispose } = await boot()
  const pass = async (output: string): Promise<void> =>
    callTool(h, "execute.after", {
      tool: "task",
      sessionID: "p1",
      input: { agent: "test-runner" },
      result: { output },
    })
  await pass("GATE: PASS tests=3 passed=3 failed=0\n")
  await pass("GATE: FAIL tests=3 passed=1 failed=2\n")
  await assert.rejects(
    () =>
      callTool(h, "execute.before", {
        tool: "task",
        sessionID: "p1",
        input: { agent: "reviewer", prompt: "review it" },
      }),
    (e: Error) => e.message === NO_GATE_MESSAGE,
  )
  // A follow-up PASS re-greens it.
  await pass("GATE: PASS tests=3 passed=3 failed=0\n")
  await callTool(h, "execute.before", {
    tool: "task",
    sessionID: "p1",
    input: { agent: "reviewer", prompt: "review it" },
  })
  dispose()
})

/** Byte-identical re-delivered markers still journal: dedup is per delivery, not global. */
test("task-result re-runs with identical markers are journaled per delivery", async () => {
  const { h, dispose, metricsDir } = await boot({ maxReviewerRounds: 2 })
  const result = { output: "VERDICT: BLOCK crit=1 high=0 med=0 low=0\nmore text" }
  for (let i = 0; i < 3; i++) {
    await callTool(h, "execute.after", {
      tool: "task",
      sessionID: "p1",
      input: { agent: "test-runner" },
      result,
    })
  }
  // Each execute.after is a distinct delivery: byte-identical markers from
  // a re-run must still leave journal evidence.
  const verdicts = journalEntries(metricsDir).filter((l) => l.type === "verdict")
  assert.equal(verdicts.length, 3)
  // Rounds count reviewer dispatches (none happened here), not verdicts.
  assert.ok(verdicts[0])
  assert.equal(verdicts[0].rounds, 0)
  dispose()
})

/** Repeated streaming of the same text dedups to a single verdict entry. */
test("streaming re-delivery of the same text dedups to one journal entry", async () => {
  const { h, dispose, metricsDir } = await boot()
  h.pushEvent({ type: "session.created", data: { sessionID: "c1", parentID: "p1" } })
  h.pushEvent({ type: "session.error", data: { sessionID: "c1", error: "warmup" } })
  await waitUntil(() =>
    journalEntries(metricsDir).some((l) => l.type === "error" && l.error === "warmup"),
  )
  const text = "VERDICT: BLOCK crit=1 high=0 med=0 low=0\nmore text"
  for (let i = 0; i < 3; i++) {
    h.pushEvent({ type: "session.text.ended", data: { sessionID: "c1", text } })
  }
  await waitUntil(() => journalEntries(metricsDir).filter((l) => l.type === "verdict").length >= 1)
  // settle: give the loop a beat to (not) journal duplicates
  await new Promise((resolve) => setTimeout(resolve, 25))
  const verdicts = journalEntries(metricsDir).filter((l) => l.type === "verdict")
  assert.equal(verdicts.length, 1)
  dispose()
})

/** Only the last marker in one text is journaled; earlier matches count as suppressed. */
test("only the last marker per text is journaled; earlier matches counted as suppressed", async () => {
  const { h, dispose, metricsDir } = await boot()
  await callTool(h, "execute.after", {
    tool: "task",
    sessionID: "p1",
    input: { agent: "test-runner" },
    result: {
      output: "GATE: FAIL tests=2 passed=0 failed=2\nretry\nGATE: PASS tests=2 passed=2 failed=0",
    },
  })
  const gates = journalEntries(metricsDir).filter((l) => l.type === "gate" && l.source)
  assert.equal(gates.length, 1)
  assert.ok(gates[0])
  assert.equal(gates[0].result, "PASS")
  assert.equal(gates[0].suppressed, 1)
  dispose()
})

/** With the gate green, two reviewer dispatches pass; the third hits the round cap. */
test("round cap with default 2: third reviewer dispatch blocked at the limit", async () => {
  const { h, dispose } = await boot()
  // The cap counts reviewer dispatches, so the gate must be green for the
  // first two dispatches to pass the no-gate-pass check.
  await callTool(h, "execute.after", {
    tool: "task",
    sessionID: "p1",
    input: { agent: "test-runner" },
    result: { output: "GATE: PASS tests=1 passed=1 failed=0\n" },
  })
  for (let i = 0; i < 2; i++) {
    await callTool(h, "execute.before", {
      tool: "task",
      sessionID: "p1",
      input: { agent: "reviewer", prompt: "review it" },
    })
  }
  await assert.rejects(
    () =>
      callTool(h, "execute.before", {
        tool: "task",
        sessionID: "p1",
        input: { agent: "reviewer", prompt: "again" },
      }),
    (e: Error) =>
      e.message ===
      "BLOCKED by turnstile: reviewer round limit (2) reached. Escalate the open findings to the user, or start a new task (a new user prompt resets the cap).",
  )
  dispose()
})

/** Replay of a parent-keyed PASS entry restores the gate across restarts. */
test("journal replay restores a parent-keyed GATE: PASS across restarts", async () => {
  const metricsDir = tmpDir()
  fs.writeFileSync(
    path.join(metricsDir, "turnstile.jsonl"),
    `${JSON.stringify({ ts: "t", type: "gate", sessionID: "p1", raw: "c1", result: "PASS" })}\n`,
  )
  const h = makeFakeHost()
  const setup = turnstile(h.host, { env: isolatedEnv(metricsDir), config: { metricsDir } })
  const dispose = (await setup(h.host)) as () => void
  await callTool(h, "execute.before", {
    tool: "task",
    sessionID: "p1",
    input: { agent: "reviewer", prompt: "review it" },
  })
  dispose()
})

/** Replay honors latest-wins: a trailing GATE: FAIL after a PASS keeps the
 *  gate red across restarts, matching the runtime un-greening rule. */
test("journal replay keeps a trailing GATE: FAIL red after an earlier PASS", async () => {
  const metricsDir = tmpDir()
  fs.writeFileSync(
    path.join(metricsDir, "turnstile.jsonl"),
    `${JSON.stringify({ ts: "t", type: "gate", sessionID: "p1", raw: "c1", result: "PASS" })}\n` +
      `${JSON.stringify({ ts: "t", type: "gate", sessionID: "p1", raw: "c2", result: "FAIL" })}\n`,
  )
  const h = makeFakeHost()
  const setup = turnstile(h.host, { env: isolatedEnv(metricsDir), config: { metricsDir } })
  const dispose = (await setup(h.host)) as () => void
  await assert.rejects(
    () =>
      callTool(h, "execute.before", {
        tool: "task",
        sessionID: "p1",
        input: { agent: "reviewer", prompt: "review it" },
      }),
    (e: Error) => e.message === NO_GATE_MESSAGE,
  )
  dispose()
})

/** Legacy raw-keyed entries (no parent mapping) must not open the parent's gate. */
test("legacy raw-keyed replay entries do not gate the parent session", async () => {
  const metricsDir = tmpDir()
  fs.writeFileSync(
    path.join(metricsDir, "turnstile.jsonl"),
    `${JSON.stringify({ ts: "t", type: "gate", sessionID: "c-old", result: "PASS" })}\n`,
  )
  const h = makeFakeHost()
  const setup = turnstile(h.host, { env: isolatedEnv(metricsDir), config: { metricsDir } })
  const dispose = (await setup(h.host)) as () => void
  await assert.rejects(
    () =>
      callTool(h, "execute.before", {
        tool: "task",
        sessionID: "p1",
        input: { agent: "reviewer", prompt: "review it" },
      }),
    (e: Error) => e.message === NO_GATE_MESSAGE,
  )
  dispose()
})

/** Read counter: one warning at readWarn, a hard block at readBlock. */
test("read horizon: warns at readWarn, blocks at readBlock", async () => {
  const { h, dispose } = await boot({ readWarn: 2, readBlock: 3 })
  const r2 = { output: "two" }
  const r3 = { output: "three" }
  await callTool(h, "execute.after", { tool: "read", sessionID: "p1", result: { output: "one" } })
  await callTool(h, "execute.after", { tool: "read", sessionID: "p1", result: r2 })
  assert.match(String(r2.output), /^\[turnstile\] Warning: 2 whole-file reads/)
  await callTool(h, "execute.after", { tool: "read", sessionID: "p1", result: r3 })
  await assert.rejects(
    () => callTool(h, "execute.before", { tool: "read", sessionID: "p1" }),
    (e: Error) =>
      e.message ===
      "BLOCKED by turnstile: 3 whole-file reads this session. Switch to grep/glob for targeted retrieval, or report being stuck and escalate to the user.",
  )
  dispose()
})

/** Bare-output violations fire only for agents in bareOutput (test-runner here, not planner). */
test("bare-output violation fires only for marker-contracted agents", async () => {
  const { h, dispose, metricsDir } = await boot()
  await callTool(h, "execute.after", {
    tool: "task",
    sessionID: "p1",
    input: { agent: "planner" },
    result: { output: "a plan with no marker" },
  })
  await callTool(h, "execute.after", {
    tool: "task",
    sessionID: "p1",
    input: { agent: "test-runner" },
    result: { output: "ran tests, no marker" },
  })
  const blocked = journalEntries(metricsDir).filter(
    (l) => l.reason === "task output contained no GATE/VERDICT marker",
  )
  assert.equal(blocked.length, 1)
  assert.ok(blocked[0])
  assert.equal(blocked[0].type, "violation")
  assert.equal(blocked[0].agent, "test-runner")
  dispose()
})

/** reviewer temperature is forced to 0; executor is clamped to ≤ 0.2; others untouched. */
test("clamps: reviewer forced to 0 (even without options), executors clamped to 0.2", async () => {
  const { h, dispose } = await boot()
  const gen = (draft: unknown): Promise<void> => callSession(h, "generate", draft)
  const reviewer: any = { agent: "reviewer" }
  await gen(reviewer)
  assert.deepEqual(reviewer.options, { temperature: 0 })
  const reviewerWarm: any = { agent: "reviewer", options: { temperature: 0.5 } }
  await gen(reviewerWarm)
  assert.equal(reviewerWarm.options.temperature, 0)
  const executor: any = { agent: "executor", options: { temperature: 0.5 } }
  await gen(executor)
  assert.equal(executor.options.temperature, 0.2)
  const executorCold: any = { agent: "executor", options: {} }
  await gen(executorCold)
  // An unset temperature is clamped to the ≤ 0.2 bound too.
  assert.deepEqual(executorCold.options, { temperature: 0.2 })
  const executorBare: any = { agent: "executor" }
  await gen(executorBare)
  assert.deepEqual(executorBare.options, { temperature: 0.2 })
  const orchestrator: any = { agent: "orchestrator", options: { temperature: 0.9 } }
  await gen(orchestrator)
  assert.equal(orchestrator.options.temperature, 0.9)
  dispose()
})

/** Plan approval must come first: an unreviewed plan blocks before the
 * decomposition citation check, even when the prompt cites no chunk. */
test("decomposition gate: executor must cite chunk-N when a plan has Decomposition", async () => {
  const project = tmpDir()
  fs.mkdirSync(path.join(project, ".opencode", "plans"), { recursive: true })
  fs.writeFileSync(
    path.join(project, ".opencode", "plans", "plan.md"),
    "# P\n## Decomposition\n- chunk-1\n",
  )
  const prev = process.cwd()
  process.chdir(project)
  try {
    const { h, dispose } = await boot()
    await assert.rejects(
      () =>
        callTool(h, "execute.before", {
          tool: "task",
          sessionID: "p1",
          input: { agent: "executor", prompt: "do the work" },
        }),
      (e: Error) => e.message.includes('no plan approval for "plan.md"'),
    )
    // Plan approved: the decomposition gate takes over and demands a chunk.
    await callTool(h, "execute.after", {
      tool: "task",
      sessionID: "p1",
      input: { agent: "plan-reviewer" },
      result: { output: "VERDICT: APPROVE crit=0 high=0 med=0 low=0\n" },
    })
    await assert.rejects(
      () =>
        callTool(h, "execute.before", {
          tool: "task",
          sessionID: "p1",
          input: { agent: "executor", prompt: "do the work" },
        }),
      (e: Error) =>
        e.message ===
        'BLOCKED by turnstile: plan "plan.md" has a ## Decomposition block — executor dispatches must cite the chunk-N / AC-n they implement.',
    )
    await callTool(h, "execute.before", {
      tool: "task",
      sessionID: "p1",
      input: { agent: "executor", prompt: "implements chunk-1 / AC-1" },
    })
    dispose()
  } finally {
    process.chdir(prev)
  }
})

/** A new user prompt clears gate state and the round cap for the session. */
test("a new user prompt resets gate state", async () => {
  const { h, dispose } = await boot()
  await callTool(h, "execute.after", {
    tool: "task",
    sessionID: "p1",
    input: { agent: "test-runner" },
    result: { output: "GATE: PASS tests=1 passed=1 failed=0\n" },
  })
  await callSession(h, "prompt", { sessionID: "p1" })
  await assert.rejects(
    () =>
      callTool(h, "execute.before", {
        tool: "task",
        sessionID: "p1",
        input: { agent: "reviewer", prompt: "review it" },
      }),
    (e: Error) => e.message === NO_GATE_MESSAGE,
  )
  dispose()
})

/** Child-session markers from the created-edge stream resolve to the parent's gate. */
test("event loop: session.created edge maps child markers to the parent session", async () => {
  const { h, dispose, metricsDir } = await boot()
  h.pushEvent({ type: "session.created", data: { sessionID: "c1", parentID: "p1" } })
  // In-order consumption: when the warmup error lands, the created event
  // has been processed and the child→parent edge is set.
  h.pushEvent({ type: "session.error", data: { sessionID: "c1", error: "warmup" } })
  await waitUntil(() =>
    journalEntries(metricsDir).some((l) => l.type === "error" && l.error === "warmup"),
  )
  h.pushEvent({
    type: "session.text.ended",
    data: { sessionID: "c1", text: "GATE: PASS tests=2 passed=2 failed=0" },
  })
  await waitUntil(() =>
    journalEntries(metricsDir).some((l) => l.type === "gate" && l.result === "PASS"),
  )
  // The gate for the PARENT session is green; the reviewer is allowed.
  await callTool(h, "execute.before", {
    tool: "task",
    sessionID: "p1",
    input: { agent: "reviewer", prompt: "review it" },
  })
  const gate = journalEntries(metricsDir).find((l) => l.type === "gate" && l.result === "PASS")
  assert.ok(gate)
  assert.equal(gate.sessionID, "p1")
  assert.equal(gate.raw, "c1")
  dispose()
})

/** message.part.updated markers resolve the parent via the host session.get API. */
test("event loop: message.part.updated markers resolve the parent via session.get", async () => {
  const metricsDir = tmpDir()
  const h = makeFakeHost({ sessionRecords: new Map([["c1", { parentID: "p1" }]]) })
  const setup = turnstile(h.host, { env: isolatedEnv(metricsDir), config: { metricsDir } })
  const dispose = (await setup(h.host)) as () => void
  h.pushEvent({
    type: "message.part.updated",
    data: {
      sessionID: "c1",
      part: { type: "text", text: "VERDICT: APPROVE crit=0 high=0 med=1 low=2" },
    },
  })
  await waitUntil(() => journalEntries(metricsDir).some((l) => l.type === "verdict"))
  const verdict = journalEntries(metricsDir).find((l) => l.type === "verdict")
  assert.ok(verdict)
  assert.equal(verdict.sessionID, "p1")
  assert.equal(verdict.raw, "c1")
  dispose()
})

/** Child-session reads draw down the parent's read budget and journal under the parent ID. */
test("event loop: read horizon counts child reads against the parent session", async () => {
  const { h, dispose, metricsDir } = await boot({ readWarn: 2, readBlock: 3 })
  h.pushEvent({ type: "session.created", data: { sessionID: "c1", parentID: "p1" } })
  h.pushEvent({ type: "session.error", data: { sessionID: "c1", error: "warmup" } })
  await waitUntil(() =>
    journalEntries(metricsDir).some((l) => l.type === "error" && l.error === "warmup"),
  )
  // Child-session reads draw down the parent's budget.
  for (let i = 0; i < 3; i++) {
    await callTool(h, "execute.after", {
      tool: "read",
      sessionID: "c1",
      result: { output: `body ${i}` },
    })
  }
  await assert.rejects(
    () => callTool(h, "execute.before", { tool: "read", sessionID: "c1" }),
    (e: Error) =>
      e.message ===
      "BLOCKED by turnstile: 3 whole-file reads this session. Switch to grep/glob for targeted retrieval, or report being stuck and escalate to the user.",
  )
  const reads = journalEntries(metricsDir).filter((l) => l.type === "tool" && l.tool === "read")
  assert.equal(reads.length, 3)
  assert.ok(reads.every((l) => l.sessionID === "p1"))
  dispose()
})

/** session.error events are journaled and the event loop keeps consuming afterwards. */
test("event loop: session.error events are journaled and stream survives them", async () => {
  const { h, dispose, metricsDir } = await boot()
  h.pushEvent({ type: "session.error", data: { sessionID: "p1", error: "boom" } })
  h.pushEvent({ type: "session.error", data: { sessionID: "p1", error: "boom again" } })
  await waitUntil(() =>
    journalEntries(metricsDir).some((l) => l.type === "error" && l.error === "boom again"),
  )
  const errors = journalEntries(metricsDir).filter((l) => l.type === "error")
  assert.equal(errors.length, 2)
  dispose()
})

/** Child session.created events carrying a foreign directory must not change the project dir. */
test("event loop: child session.created events do not move the project dir", async () => {
  const project = tmpDir()
  fs.mkdirSync(path.join(project, ".opencode", "plans"), { recursive: true })
  fs.writeFileSync(
    path.join(project, ".opencode", "plans", "plan.md"),
    "# P\n## Decomposition\n- chunk-1\n",
  )
  const prev = process.cwd()
  process.chdir(project)
  try {
    const { h, dispose, metricsDir } = await boot()
    // A child session carries a foreign directory; it must not win.
    h.pushEvent({
      type: "session.created",
      data: { sessionID: "c1", parentID: "p1", location: { directory: "/nonexistent-dir" } },
    })
    h.pushEvent({ type: "session.error", data: { sessionID: "c1", error: "warmup" } })
    await waitUntil(() =>
      journalEntries(metricsDir).some((l) => l.type === "error" && l.error === "warmup"),
    )
    await callTool(h, "execute.after", {
      tool: "task",
      sessionID: "p1",
      input: { agent: "plan-reviewer" },
      result: { output: "VERDICT: APPROVE crit=0 high=0 med=0 low=0\n" },
    })
    await assert.rejects(
      () =>
        callTool(h, "execute.before", {
          tool: "task",
          sessionID: "p1",
          input: { agent: "executor", prompt: "do the work" },
        }),
      (e: Error) => e.message.includes("## Decomposition block"),
    )
    dispose()
  } finally {
    process.chdir(prev)
  }
})

/** Replay state is LRU-capped at maxSessions: the most recent survives, the oldest is evicted. */
test("journal replay is LRU-capped: sessions beyond maxSessions are evicted", async () => {
  const metricsDir = tmpDir()
  fs.writeFileSync(
    path.join(metricsDir, "turnstile.jsonl"),
    ["s1", "s2", "s3"]
      .map(
        (sid) => `${JSON.stringify({ ts: "t", type: "gate", sessionID: sid, result: "PASS" })}\n`,
      )
      .join(""),
  )
  const h = makeFakeHost()
  const setup = turnstile(h.host, {
    env: isolatedEnv(metricsDir),
    config: { metricsDir, maxSessions: 2 },
  })
  const dispose = (await setup(h.host)) as () => void
  // s3 survived the cap (most recent) and gates its dispatch.
  await callTool(h, "execute.before", {
    tool: "task",
    sessionID: "s3",
    input: { agent: "reviewer", prompt: "review it" },
  })
  // s1 was evicted (oldest): its PASS is gone, dispatch is blocked.
  await assert.rejects(
    () =>
      callTool(h, "execute.before", {
        tool: "task",
        sessionID: "s1",
        input: { agent: "reviewer", prompt: "review it" },
      }),
    (e: Error) => e.message === NO_GATE_MESSAGE,
  )
  dispose()
})

/** Failed session.get lookups are negatively cached so repeated events hit the host once. */
test("event loop: failed parent lookups are negatively cached", async () => {
  const metricsDir = tmpDir()
  const h = makeFakeHost()
  const setup = turnstile(h.host, { env: isolatedEnv(metricsDir), config: { metricsDir } })
  const dispose = (await setup(h.host)) as () => void
  let calls = 0
  const session = h.host.session
  assert.ok(session)
  session.get = async () => {
    calls++
    return {} // record without a parent edge
  }
  const part = { type: "text", text: "just talking, no markers" }
  for (let i = 0; i < 3; i++) {
    h.pushEvent({ type: "message.part.updated", data: { sessionID: "c1", part } })
  }
  await waitUntil(() => calls >= 1)
  await new Promise((resolve) => setTimeout(resolve, 25))
  assert.equal(calls, 1)
  dispose()
})

/** A thrown lookup is retried so a record that becomes visible later still resolves. */
test("event loop: thrown parent lookups retry and resolve once the record appears", async () => {
  const metricsDir = tmpDir()
  const h = makeFakeHost()
  const setup = turnstile(h.host, { env: isolatedEnv(metricsDir), config: { metricsDir } })
  const dispose = (await setup(h.host)) as () => void
  let calls = 0
  const session = h.host.session
  assert.ok(session)
  session.get = async () => {
    calls++
    if (calls === 1) throw new Error("record not yet visible")
    return { parentID: "p1" }
  }
  const part = { type: "text", text: "just talking, no markers" }
  for (let i = 0; i < 3; i++) {
    h.pushEvent({ type: "message.part.updated", data: { sessionID: "c1", part } })
  }
  await waitUntil(() => calls >= 2)
  await new Promise((resolve) => setTimeout(resolve, 25))
  assert.equal(calls, 2) // resolved on the retry; no further host hits
  // The resolved edge now keys child markers to the parent.
  h.pushEvent({
    type: "session.text.ended",
    data: { sessionID: "c1", text: "GATE: PASS tests=1 passed=1 failed=0" },
  })
  await waitUntil(() =>
    journalEntries(metricsDir).some((l) => l.type === "gate" && l.sessionID === "p1"),
  )
  dispose()
})

/** The trace file rotates with the same bytes/generations bounds as the journal. */
test("trace file rotates with the same bound as the journal", async () => {
  const { h, dispose, metricsDir } = await boot({
    journalMaxBytes: 200,
    journalMaxGenerations: 2,
  })
  for (let i = 0; i < 10; i++) {
    await callTool(h, "execute.before", {
      tool: "task",
      sessionID: "p1",
      input: { agent: "test-runner", prompt: `run tests ${i}` },
    }).catch(() => {})
  }
  const tracePath = path.join(metricsDir, "gate-events.jsonl")
  const gens = [1, 2].filter((g) => fs.existsSync(`${tracePath}.${g}`))
  assert.ok(gens.length >= 1, "expected at least one rotated trace generation")
  dispose()
})
