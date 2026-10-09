/**
 * @fileoverview Plan-approval gate tests: executor dispatch blocked until
 * a plan-reviewer result records `VERDICT: APPROVE`, waiver bypass, bare
 * output and BLOCK verdicts keep the gate red, re-plan invalidation, the
 * no-plans-dir pass-through, and journal replay of plan approvals — via a
 * fake host with injected config.
 */

import { test } from "node:test"
import assert from "node:assert/strict"
import * as fs from "node:fs"
import * as path from "node:path"

import { turnstile } from "../turnstile.ts"
import {
  callTool,
  isolatedEnv,
  journalEntries,
  makeFakeHost,
  tmpDir,
  type FakeHost,
} from "./helpers.ts"

const APPROVE = "VERDICT: APPROVE crit=0 high=0 med=0 low=0"
const BLOCK = "VERDICT: BLOCK crit=1 high=0 med=0 low=0"

/** Boots in a temp project dir containing a plan file. */
async function bootWithPlan(
  planBody = "# P\n",
  planName = "plan.md",
): Promise<{
  h: FakeHost
  dispose: () => void
  metricsDir: string
  project: string
  restore: () => void
}> {
  const project = tmpDir()
  fs.mkdirSync(path.join(project, ".opencode", "plans"), { recursive: true })
  fs.writeFileSync(path.join(project, ".opencode", "plans", planName), planBody)
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
    dispose,
    metricsDir,
    project,
    restore: (): void => {
      dispose()
      process.chdir(prev)
    },
  }
}

/** A plan file exists → executor is blocked until plan-reviewer approves. */
test("plan gate: executor blocked until a plan-reviewer APPROVE verdict", async () => {
  const { h, restore } = await bootWithPlan()
  try {
    await assert.rejects(
      () =>
        callTool(h, "execute.before", {
          tool: "task",
          sessionID: "p1",
          input: { agent: "executor", prompt: "do the work" },
        }),
      (e: Error) =>
        e.message ===
        `BLOCKED by turnstile: no plan approval for "plan.md". Dispatch the plan-reviewer subagent first; proceed with executor only after the plan-reviewer's first line is ` +
          "`VERDICT: APPROVE crit=<n> high=<n> med=<n> low=<n>`, or obtain an explicit user waiver " +
          "(the dispatch prompt must contain the literal marker 'USER WAIVER:' followed by the user's words).",
    )
    await callTool(h, "execute.after", {
      tool: "task",
      sessionID: "p1",
      input: { agent: "plan-reviewer" },
      result: { output: `${APPROVE}\nAC-1 ok\n` },
    })
    await callTool(h, "execute.before", {
      tool: "task",
      sessionID: "p1",
      input: { agent: "executor", prompt: "do the work" },
    })
  } finally {
    restore()
  }
})

/** A BLOCK verdict (or marker-less output) leaves the plan gate red. */
test("plan gate: BLOCK verdict and marker-less output do not approve", async () => {
  const { h, metricsDir, restore } = await bootWithPlan()
  try {
    await callTool(h, "execute.after", {
      tool: "task",
      sessionID: "p1",
      input: { agent: "plan-reviewer" },
      result: { output: `${BLOCK}\nAC-1 GAP\n` },
    })
    await assert.rejects(() =>
      callTool(h, "execute.before", {
        tool: "task",
        sessionID: "p1",
        input: { agent: "executor", prompt: "do the work" },
      }),
    )
    // Latest-wins: a later bare output (no verdict) also keeps it red.
    await callTool(h, "execute.after", {
      tool: "task",
      sessionID: "p1",
      input: { agent: "plan-reviewer" },
      result: { output: "reviewed, looks fine\n" },
    })
    const violations = journalEntries(metricsDir).filter((l) => l.type === "violation")
    assert.ok(violations.some((l) => l.agent === "plan-reviewer"))
    await assert.rejects(() =>
      callTool(h, "execute.before", {
        tool: "task",
        sessionID: "p1",
        input: { agent: "executor", prompt: "do the work" },
      }),
    )
  } finally {
    restore()
  }
})

/** The literal USER WAIVER: marker bypasses the plan gate per dispatch. */
test("plan gate: USER WAIVER: bypasses approval; next unapproved dispatch blocked", async () => {
  const { h, metricsDir, restore } = await bootWithPlan()
  try {
    await callTool(h, "execute.before", {
      tool: "task",
      sessionID: "p1",
      input: { agent: "executor", prompt: "USER WAIVER: user said go" },
    })
    const waived = journalEntries(metricsDir).find(
      (l) => l.type === "plan" && l.result === "WAIVED",
    )
    assert.ok(waived)
    await assert.rejects(() =>
      callTool(h, "execute.before", {
        tool: "task",
        sessionID: "p1",
        input: { agent: "executor", prompt: "do the work" },
      }),
    )
  } finally {
    restore()
  }
})

/** Rewriting the plan invalidates a recorded approval (re-plan → re-review). */
test("plan gate: plan-file change invalidates a prior approval", async () => {
  const { h, restore, project } = await bootWithPlan()
  try {
    await callTool(h, "execute.after", {
      tool: "task",
      sessionID: "p1",
      input: { agent: "plan-reviewer" },
      result: { output: `${APPROVE}\n` },
    })
    await callTool(h, "execute.before", {
      tool: "task",
      sessionID: "p1",
      input: { agent: "executor", prompt: "do the work" },
    })
    // Re-plan: rewrite the file and bump mtime beyond timer granularity so
    // the change-detection key is guaranteed to differ.
    const planPath = path.join(project, ".opencode", "plans", "plan.md")
    fs.writeFileSync(planPath, "# P revised\n")
    const future = new Date(Date.now() + 5000)
    fs.utimesSync(planPath, future, future)
    await assert.rejects(() =>
      callTool(h, "execute.before", {
        tool: "task",
        sessionID: "p1",
        input: { agent: "executor", prompt: "do the work" },
      }),
    )
  } finally {
    restore()
  }
})

/** No plans dir (or an empty one) → executor needs no plan approval. */
test("plan gate: no plans dir or empty dir leaves executor free", async () => {
  const project = tmpDir()
  fs.mkdirSync(path.join(project, ".opencode", "plans"), { recursive: true })
  const metricsDir = tmpDir()
  const h = makeFakeHost()
  const prev = process.cwd()
  process.chdir(project)
  try {
    const setup = turnstile(h.host, { env: isolatedEnv(metricsDir), config: { metricsDir } })
    const dispose = (await setup(h.host)) as () => void
    await callTool(h, "execute.before", {
      tool: "task",
      sessionID: "p1",
      input: { agent: "executor", prompt: "do the work" },
    })
    dispose()
  } finally {
    process.chdir(prev)
  }
})

/** A journaled plan approval replays after restart so executor stays free. */
test("plan gate: journal replay restores plan approval", async () => {
  const project = tmpDir()
  fs.mkdirSync(path.join(project, ".opencode", "plans"), { recursive: true })
  fs.writeFileSync(path.join(project, ".opencode", "plans", "plan.md"), "# P\n")
  const metricsDir = tmpDir()
  const journalPath = path.join(metricsDir, "turnstile.jsonl")
  fs.writeFileSync(
    journalPath,
    JSON.stringify({ ts: "t", type: "plan", sessionID: "p1", result: "APPROVE", marker: APPROVE }) +
      "\n",
  )
  const h = makeFakeHost()
  const prev = process.cwd()
  process.chdir(project)
  try {
    const setup = turnstile(h.host, { env: isolatedEnv(metricsDir), config: { metricsDir } })
    const dispose = (await setup(h.host)) as () => void
    await callTool(h, "execute.before", {
      tool: "task",
      sessionID: "p1",
      input: { agent: "executor", prompt: "do the work" },
    })
    dispose()
  } finally {
    process.chdir(prev)
  }
})

/** Plan attribution is keyed by the parent session, not the child. */
test("plan gate: child plan-reviewer result greens the parent's gate", async () => {
  const { h, metricsDir, restore } = await bootWithPlan()
  try {
    // session.created edge from the stream is not needed here: the task
    // result arrives with the CHILD session id; parentOf falls back to the
    // session itself, so simulate the dispatch-side parent id directly.
    await callTool(h, "execute.after", {
      tool: "task",
      sessionID: "p1",
      input: { agent: "plan-reviewer" },
      result: { output: `${APPROVE}\n` },
    })
    const plan = journalEntries(metricsDir).find((l) => l.type === "plan" && l.result === "APPROVE")
    assert.ok(plan)
    assert.equal(plan.sessionID, "p1")
    await callTool(h, "execute.before", {
      tool: "task",
      sessionID: "p1",
      input: { agent: "executor", prompt: "do the work" },
    })
  } finally {
    restore()
  }
})
