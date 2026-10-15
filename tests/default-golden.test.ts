/**
 * @fileoverview Byte-identity goldens: with default config, journal entry
 * shapes, trace format, and block messages must match the historical
 * behavior exactly. The bare-output blocked entry is deliberately excluded
 * (it gains an `agent` key by design, unlike the other block messages).
 */

import * as fs from "node:fs"
import * as path from "node:path"

import { test } from "node:test"
import assert from "node:assert/strict"

import { turnstile } from "../turnstile.ts"
import {
  callPermission,
  callSession,
  callTool,
  isolatedEnv,
  journalEntries,
  makeFakeHost,
  tmpDir,
  traceText,
  type FakeHost,
} from "./helpers.ts"

/** Boots with default config over a temp metrics dir. */
async function bootDefault(): Promise<{ h: FakeHost; dispose: () => void; metricsDir: string }> {
  const metricsDir = tmpDir()
  const h = makeFakeHost()
  const setup = turnstile(h.host, {
    env: isolatedEnv(metricsDir),
    config: { metricsDir },
  })
  const dispose = (await setup(h.host)) as () => void
  return { h, dispose, metricsDir }
}

/** Golden: a blocked reviewer dispatch still journals the dispatch entry with its fields. */
test("golden: dispatch entry shape", async () => {
  const { h, dispose, metricsDir } = await bootDefault()
  await callTool(h, "execute.before", {
    tool: "task",
    sessionID: "p1",
    input: { agent: "reviewer", prompt: "p", description: "d" },
  }).catch(() => {})
  const entry = journalEntries(metricsDir).find((l) => l.type === "dispatch")
  assert.ok(entry)
  assert.equal(entry.sessionID, "p1")
  assert.equal(entry.agent, "reviewer")
  assert.equal(entry.description, "d")
  dispose()
})

/** Golden: gate PASS entry is parent-keyed with raw, source, and the marker text.
 *  Under the default enforce mode a PASS with no correlated bash execution is
 *  journaled verified:false, mode:enforce. */
test("golden: gate entry shape (parent-keyed with raw)", async () => {
  const { h, dispose, metricsDir } = await bootDefault()
  await callTool(h, "execute.after", {
    tool: "task",
    sessionID: "p1",
    input: { agent: "test-runner" },
    result: { output: "GATE: PASS tests=1 passed=1 failed=0\n" },
  })
  const gate = journalEntries(metricsDir).find((l) => l.type === "gate" && l.result === "PASS")
  assert.ok(gate)
  assert.deepEqual(
    { ...gate, ts: undefined },
    {
      ts: undefined,
      type: "gate",
      sessionID: "p1",
      raw: "p1",
      result: "PASS",
      source: "task-result",
      marker: "GATE: PASS tests=1 passed=1 failed=0",
      verified: false,
      mode: "enforce",
    },
  )
  dispose()
})

/** Golden: a PASS correlated with a journaled exit-0 `npm test` flips green and
 *  is journaled verified:true, mode:enforce. */
test("golden: gate entry shape with correlated bash evidence", async () => {
  const { h, dispose, metricsDir } = await bootDefault()
  await callTool(h, "execute.after", {
    tool: "bash",
    sessionID: "p1",
    input: { command: "npm test" },
    result: { metadata: { exit: 0 } },
  })
  await callTool(h, "execute.after", {
    tool: "task",
    sessionID: "p1",
    input: { agent: "test-runner" },
    result: { output: "GATE: PASS tests=1 passed=1 failed=0\n" },
  })
  const gate = journalEntries(metricsDir).find((l) => l.type === "gate" && l.result === "PASS")
  assert.ok(gate)
  assert.deepEqual(
    { ...gate, ts: undefined },
    {
      ts: undefined,
      type: "gate",
      sessionID: "p1",
      raw: "p1",
      result: "PASS",
      source: "task-result",
      marker: "GATE: PASS tests=1 passed=1 failed=0",
      verified: true,
      mode: "enforce",
    },
  )
  dispose()
})

/** Golden: a PASS under gateEvidence:"flag" flips (today's semantics) yet still
 *  stamps verified:false, mode:flag. */
test("golden: gate entry shape stamping flag under gateEvidence:flag", async () => {
  const metricsDir = tmpDir()
  const h = makeFakeHost()
  const setup = turnstile(h.host, {
    env: isolatedEnv(metricsDir),
    config: { metricsDir, gateEvidence: "flag" },
  })
  const dispose = (await setup(h.host)) as () => void
  await callTool(h, "execute.after", {
    tool: "task",
    sessionID: "p1",
    input: { agent: "test-runner" },
    result: { output: "GATE: PASS tests=1 passed=1 failed=0\n" },
  })
  const gate = journalEntries(metricsDir).find((l) => l.type === "gate" && l.result === "PASS")
  assert.ok(gate)
  assert.deepEqual(
    { ...gate, ts: undefined },
    {
      ts: undefined,
      type: "gate",
      sessionID: "p1",
      raw: "p1",
      result: "PASS",
      source: "task-result",
      marker: "GATE: PASS tests=1 passed=1 failed=0",
      verified: false,
      mode: "flag",
    },
  )
  dispose()
})

/** Golden: verdict entry carries marker, rounds, and source alongside the key fields. */
test("golden: verdict entry shape with rounds", async () => {
  const { h, dispose, metricsDir } = await bootDefault()
  await callTool(h, "execute.after", {
    tool: "task",
    sessionID: "p1",
    input: { agent: "test-runner" },
    result: { output: "VERDICT: APPROVE crit=0 high=0 med=1 low=2\n" },
  })
  const verdict = journalEntries(metricsDir).find((l) => l.type === "verdict")
  assert.ok(verdict)
  assert.deepEqual(
    { ...verdict, ts: undefined },
    {
      ts: undefined,
      type: "verdict",
      sessionID: "p1",
      raw: "p1",
      marker: "VERDICT: APPROVE crit=0 high=0 med=1 low=2",
      rounds: 0,
      source: "task-result",
    },
  )
  dispose()
})

/** Golden: the 8th whole-file read gets the exact warn prefix and journals reads: 8. */
test("golden: read tool entry shape and warn prefix at 8 reads", async () => {
  const { h, dispose, metricsDir } = await bootDefault()
  let last: { output: string } = { output: "" }
  for (let i = 0; i < 8; i++) {
    last = { output: `body ${i}` }
    await callTool(h, "execute.after", { tool: "read", sessionID: "p1", result: last })
  }
  assert.match(
    last.output,
    /^\[turnstile\] Warning: 8 whole-file reads this session; prefer grep\/glob\. Blocks at 15\.\n/,
  )
  const reads = journalEntries(metricsDir).filter((l) => l.type === "tool" && l.tool === "read")
  const read = reads[reads.length - 1]
  assert.ok(read)
  assert.equal(read.reads, 8)
  assert.equal(read.sessionID, "p1")
  dispose()
})

/** Golden: bash tool entries capture the command and exit code. */
test("golden: bash tool entry with command slice and exit extraction", async () => {
  const { h, dispose, metricsDir } = await bootDefault()
  await callTool(h, "execute.after", {
    tool: "bash",
    sessionID: "p1",
    input: { command: "echo hi" },
    result: { metadata: { exitCode: 3 } },
  })
  const bash = journalEntries(metricsDir).find((l) => l.type === "tool" && l.tool === "bash")
  assert.ok(bash)
  assert.equal(bash.command, "echo hi")
  assert.equal(bash.exit, 3)
  dispose()
})

/** Golden: trace lines are `YYYY-MM-DD HH:MM | agent | gate | <marker>`. */
test("golden: trace line format", async () => {
  const { h, dispose, metricsDir } = await bootDefault()
  await callTool(h, "execute.after", {
    tool: "task",
    sessionID: "p1",
    input: { agent: "test-runner" },
    result: { output: "GATE: PASS tests=1 passed=1 failed=0\n" },
  })
  const line = traceText(metricsDir)
    .trim()
    .split("\n")
    .find((l) => l.includes("| test-runner | gate |"))
  assert.ok(line)
  assert.match(
    line,
    /^\d{4}-\d{2}-\d{2} \d{2}:\d{2} \| test-runner \| gate \| GATE: PASS tests=1 passed=1 failed=0 \| p1$/,
  )
  dispose()
})

/**
 * Golden: the three user-facing BLOCKED messages (no gate pass, round
 * limit, read horizon) must remain byte-identical to the historical text.
 */
test("golden: the three block messages are byte-identical", async () => {
  const { h, dispose } = await bootDefault()
  await assert.rejects(
    () =>
      callTool(h, "execute.before", {
        tool: "task",
        sessionID: "p1",
        input: { agent: "reviewer", prompt: "p" },
      }),
    (e: Error) =>
      e.message ===
      "BLOCKED by turnstile: no reviewer dispatch before the test gate is green. " +
        "Run the test-runner subagent first; dispatch reviewer only after its first line is " +
        "`GATE: PASS tests=<n> passed=<n> failed=<n>`, or obtain an explicit user waiver " +
        "(a user prompt this task must contain the literal marker 'USER WAIVER:' followed by the user's words).",
  )
  // Round limit: gate green first, then the cap counts reviewer dispatches
  // (two allowed, third blocked). Under enforce mode the gate
  // needs a journaled exit-0 bash test execution before a PASS verifies, so
  // give it evidence first.
  await callTool(h, "execute.after", {
    tool: "bash",
    sessionID: "p1",
    input: { command: "npm test" },
    result: { metadata: { exit: 0 } },
  })
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
      input: { agent: "reviewer", prompt: "p" },
    })
  }
  await assert.rejects(
    () =>
      callTool(h, "execute.before", {
        tool: "task",
        sessionID: "p1",
        input: { agent: "reviewer", prompt: "p" },
      }),
    (e: Error) =>
      e.message ===
      "BLOCKED by turnstile: reviewer round limit (2) reached. Escalate the open findings to the user, or start a new task (a new user prompt resets the cap).",
  )
  for (let i = 0; i < 15; i++) {
    await callTool(h, "execute.after", { tool: "read", sessionID: "p2", result: { output: "x" } })
  }
  await assert.rejects(
    () => callTool(h, "execute.before", { tool: "read", sessionID: "p2" }),
    (e: Error) =>
      e.message ===
      "BLOCKED by turnstile: 15 whole-file reads this session. Switch to grep/glob for targeted retrieval, or report being stuck and escalate to the user.",
  )
  dispose()
})

/** Boots a temp project dir whose `.opencode/plans` holds one plan file, and
 *  the plugin over a fake host with a temp metrics dir (chdir-scoped), so the
 *  gate state keys off a private project rather than the repo root. */
async function bootDefaultPlan(): Promise<{
  h: FakeHost
  dispose: () => void
  metricsDir: string
}> {
  const project = tmpDir()
  fs.mkdirSync(path.join(project, ".opencode", "plans"), { recursive: true })
  fs.writeFileSync(path.join(project, ".opencode", "plans", "plan.md"), "# Plan\n\nBody text.\n")
  const metricsDir = tmpDir()
  const h = makeFakeHost()
  const prev = process.cwd()
  process.chdir(project)
  const setup = turnstile(h.host, {
    env: isolatedEnv(metricsDir),
    config: { metricsDir },
  })
  const dispose = (await setup(h.host)) as () => void
  return {
    h,
    dispose: (): void => {
      dispose()
      process.chdir(prev)
    },
    metricsDir,
  }
}

/** Golden: a `PLAN APPROVED:` marker in the user prompt journals a plan
 *  APPROVE entry from the prompt channel (`source:"session-prompt"`). */
test("golden: prompt-channel PLAN APPROVED plan entry shape", async () => {
  const { h, dispose, metricsDir } = await bootDefaultPlan()
  await callSession(h, "prompt", { sessionID: "p1", text: "PLAN APPROVED: looks good" })
  const plan = journalEntries(metricsDir).find(
    (l) => l.type === "plan" && l.result === "APPROVE" && l.source === "session-prompt",
  )
  assert.ok(plan)
  assert.deepEqual(
    { ...plan, ts: undefined },
    {
      ts: undefined,
      type: "plan",
      sessionID: "p1",
      result: "APPROVE",
      source: "session-prompt",
      marker: "PLAN APPROVED:",
    },
  )
  dispose()
})

/** Golden: a prompt-channel `USER WAIVER:` journals a WAIVED entry
 *  (`channel:"prompt"`) from BOTH the plan gate (type "plan") and the reviewer
 *  gate (type "gate"). */
test("golden: prompt-channel waiver journals channel:prompt WAIVED entries", async () => {
  const { h, dispose, metricsDir } = await bootDefaultPlan()
  await callSession(h, "prompt", { sessionID: "p1", text: "USER WAIVER: proceed" })
  // Plan gate first: task-sticky, leaves the waiver live for the task.
  await callTool(h, "execute.before", {
    tool: "task",
    sessionID: "p1",
    input: { agent: "executor", prompt: "do the work" },
  })
  // Reviewer gate next: still sees the live waiver, then consumes it.
  await callTool(h, "execute.before", {
    tool: "task",
    sessionID: "p1",
    input: { agent: "reviewer", prompt: "review it" },
  })
  const planWaived = journalEntries(metricsDir).find(
    (l) => l.type === "plan" && l.result === "WAIVED" && l.channel === "prompt",
  )
  assert.deepEqual(
    { ...planWaived, ts: undefined },
    {
      ts: undefined,
      type: "plan",
      sessionID: "p1",
      result: "WAIVED",
      channel: "prompt",
      waiver: "USER WAIVER: proceed",
    },
  )
  const gateWaived = journalEntries(metricsDir).find(
    (l) => l.type === "gate" && l.result === "WAIVED" && l.channel === "prompt",
  )
  assert.deepEqual(
    { ...gateWaived, ts: undefined },
    {
      ts: undefined,
      type: "gate",
      sessionID: "p1",
      result: "WAIVED",
      channel: "prompt",
      waiver: "USER WAIVER: proceed",
    },
  )
  dispose()
})

/** Golden: a red plan gate escalates to the human via a journaled
 *  `type:"permission"` ask (reason plan-gate, naming the plan file). */
test("golden: permission plan-gate ask entry shape", async () => {
  const { h, dispose, metricsDir } = await bootDefaultPlan()
  const event: Record<string, any> = { sessionID: "p1", action: "task" }
  await callPermission(h, "evaluate", event)
  const ask = journalEntries(metricsDir).find((l) => l.type === "permission" && l.action === "ask")
  assert.ok(ask)
  assert.deepEqual(
    { ...ask, ts: undefined },
    {
      ts: undefined,
      type: "permission",
      sessionID: "p1",
      action: "ask",
      reason: "plan-gate",
      plan: "plan.md",
    },
  )
  dispose()
})
