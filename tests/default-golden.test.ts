/**
 * @fileoverview Byte-identity goldens: with default config, journal entry
 * shapes, trace format, and block messages must match the historical
 * behavior exactly. The bare-output blocked entry is deliberately excluded
 * (chunk-4 adds an `agent` key there by design — see the plan's AC-15
 * scope note).
 */

import { test } from "node:test"
import assert from "node:assert/strict"

import { turnstile } from "../turnstile.ts"
import {
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

/** Golden: gate PASS entry is parent-keyed with raw, source, and the marker text. */
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
    /^\d{4}-\d{2}-\d{2} \d{2}:\d{2} \| test-runner \| gate \| GATE: PASS tests=1 passed=1 failed=0$/,
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
        "(the dispatch prompt must contain the literal marker 'USER WAIVER:' followed by the user's words).",
  )
  // Round limit: gate green first, then the cap counts reviewer dispatches
  // (two allowed, third blocked).
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
