/**
 * @fileoverview Plan-approval gate tests: executor dispatch blocked until
 * a plan-reviewer result records `VERDICT: APPROVE`, waiver bypass, bare
 * output and BLOCK verdicts keep the gate red, re-plan invalidation, the
 * no-plans-dir pass-through, and journal replay of plan approvals, via a
 * fake host with injected config.
 */

import { test } from "node:test"
import assert from "node:assert/strict"
import * as fs from "node:fs"
import * as path from "node:path"

import { turnstile } from "../turnstile.ts"
import { createGates } from "../src/gates.ts"
import { defaultConfig } from "../src/config.ts"
import { createJournaler } from "../src/journal.ts"
import { createLedger } from "../src/state.ts"
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

const APPROVE = "VERDICT: APPROVE crit=0 high=0 med=0 low=0"
const BLOCK = "VERDICT: BLOCK crit=1 high=0 med=0 low=0"

/** Gives the async event loop a tick to drain queued stream events. */
const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 30))

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

/**
 * Boots two temp project dirs (seed A with plan.md, sibling B) sharing a metrics
 * dir and a mutable session-record map; chdir A so process.cwd() is A. The
 * record map is shared with the fake host (session.get reads it at call time),
 * so a test can retarget a session from A to B to simulate a same-project move.
 */
async function bootWithMove(
  bodyA = "# P\n",
  bodyB = "# P\n",
): Promise<{
  h: FakeHost
  metricsDir: string
  projectA: string
  projectB: string
  sessionRecords: Map<string, unknown>
  restore: () => void
}> {
  const projectA = tmpDir()
  const projectB = tmpDir()
  fs.mkdirSync(path.join(projectA, ".opencode", "plans"), { recursive: true })
  fs.writeFileSync(path.join(projectA, ".opencode", "plans", "plan.md"), bodyA)
  fs.mkdirSync(path.join(projectB, ".opencode", "plans"), { recursive: true })
  fs.writeFileSync(path.join(projectB, ".opencode", "plans", "plan.md"), bodyB)
  const metricsDir = tmpDir()
  const sessionRecords = new Map<string, unknown>()
  const h = makeFakeHost({ sessionRecords })
  const prev = process.cwd()
  process.chdir(projectA)
  const setup = turnstile(h.host, {
    env: isolatedEnv(metricsDir),
    config: { metricsDir },
  })
  const dispose = (await setup(h.host)) as () => void
  return {
    h,
    metricsDir,
    projectA,
    projectB,
    sessionRecords,
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
          "(a user prompt this task must contain the literal marker 'USER WAIVER:' followed by the user's words).",
    )
    // The plan-reviewer runs as the child session id; attribute the APPROVE to
    // the parents gate via the child→parent edge.
    h.pushEvent({ type: "session.created", data: { sessionID: "c1", parentID: "p1" } })
    await settle()
    await callTool(h, "execute.after", {
      tool: "task",
      sessionID: "c1",
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

/**
 * The waiver provenance is the user prompt, never the dispatch prompt. A
 * prompt-channel `USER WAIVER:` waives the plan gate for the
 * whole task (task-sticky): the first executor dispatch passes, a second
 * unapproved dispatch without a new prompt still passes, and a fresh prompt
 * without the marker resets the task so the next dispatch blocks again.
 */
test("plan gate: prompt-channel USER WAIVER: waives the plan gate for the task, then resets", async () => {
  const { h, metricsDir, restore } = await bootWithPlan()
  try {
    // The waiver comes from the user prompt; the dispatch prompt is inert.
    await callSession(h, "prompt", { sessionID: "p1", text: "USER WAIVER: user said go" })
    await callTool(h, "execute.before", {
      tool: "task",
      sessionID: "p1",
      input: { agent: "executor", prompt: "do the work" },
    })
    const waived = journalEntries(metricsDir).find(
      (l) => l.type === "plan" && l.result === "WAIVED" && l.channel === "prompt",
    )
    assert.ok(waived, "the plan gate journals a prompt-channel waiver")
    // Task-sticky: a second unapproved dispatch (no new prompt) still passes.
    await callTool(h, "execute.before", {
      tool: "task",
      sessionID: "p1",
      input: { agent: "executor", prompt: "do the work again" },
    })
    // A fresh prompt without the marker resets the task; the next dispatch blocks.
    await callSession(h, "prompt", { sessionID: "p1", text: "start a new task" })
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
    // A plan-reviewer delivery attributed to the parent must arrive on the
    // child session id: register the child→parent edge first, so
    // the approval journals raw=c1 and actually greens the parent's gate.
    h.pushEvent({ type: "session.created", data: { sessionID: "c1", parentID: "p1" } })
    await settle()
    await callTool(h, "execute.after", {
      tool: "task",
      sessionID: "c1",
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

/** An absolute plansDir is honored (not silently dropped): a decomposed plan in
 *  that directory still blocks an executor that cites no chunk. An absolute
 *  path must be applied as-is rather than joined under projectDir (which nested
 *  it under project, left the dir absent, and made the gate return early —
 *  silently free). */
test("plan gate: an absolute plansDir blocks the executor decomposition check", () => {
  const absPlans = path.join(tmpDir(), "abs-plans")
  fs.mkdirSync(absPlans, { recursive: true })
  fs.writeFileSync(path.join(absPlans, "plan.md"), "# P\n## Decomposition\n- chunk-1\n")
  const metricsDir = tmpDir()
  const journaler = createJournaler({ metricsDir, trace: false, maxBytes: 1e6, maxGenerations: 1 })
  const config = defaultConfig()
  config.plansDir = absPlans
  const gates = createGates(config, journaler)
  assert.throws(
    () => gates.enforceDecomposition("p1", "do the work", "/any/project"),
    (e: Error) => String(e.message).includes("## Decomposition"),
  )
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

/** A plan-reviewer verdict streamed on the child's own text attributes through a
 *  marker-less summarized delivery on the child session id: the child→parent
 *  edge (session.created) resolves the child, and the journaled plan entry is
 *  keyed raw=c1, source=child-text (no parent-keyed
 *  plan entry is ever journaled — the pre-fix "green via parent" shape is gone). */
test("plan gate: child plan-reviewer result greens the parent's gate", async () => {
  const { h, metricsDir, restore } = await bootWithPlan()
  try {
    h.pushEvent({ type: "session.created", data: { sessionID: "c1", parentID: "p1" } })
    h.pushEvent({
      type: "session.text.ended",
      data: { sessionID: "c1", text: `\nreview\n\n${APPROVE}\n` },
    })
    await waitUntil(() =>
      journalEntries(metricsDir).some((e) => e.type === "verdict" && e.raw === "c1"),
    )
    // Summarized delivery: no marker anywhere in the output.
    await callTool(h, "execute.after", {
      tool: "task",
      sessionID: "c1",
      input: { agent: "plan-reviewer" },
      result: { output: "Review complete; see journal." },
    })
    const plan = journalEntries(metricsDir).find((l) => l.type === "plan")
    assert.ok(plan)
    assert.equal(plan.sessionID, "p1")
    assert.equal(plan.raw, "c1")
    assert.equal(plan.source, "child-text")
    // Executor dispatch proceeds (plan file present → requires the green gate).
    await callTool(h, "execute.before", {
      tool: "task",
      sessionID: "p1",
      input: { agent: "executor", prompt: "do the work" },
    })
  } finally {
    restore()
  }
})

/** a preamble (blank line + prose) before the marker still attributes APPROVE from the task-result pipeline. */
test("plan gate: preamble before APPROVE attributes with source task-result", async () => {
  const { h, metricsDir, restore } = await bootWithPlan()
  try {
    h.pushEvent({ type: "session.created", data: { sessionID: "c1", parentID: "p1" } })
    await settle()
    await callTool(h, "execute.after", {
      tool: "task",
      sessionID: "c1",
      input: { agent: "plan-reviewer" },
      result: {
        output: `\nreviewed the plan, structure is fine\n\n${APPROVE}\n## AC traceability\n`,
      },
    })
    const plan = journalEntries(metricsDir).find((l) => l.type === "plan")
    assert.ok(plan)
    assert.equal(plan.result, "APPROVE")
    assert.match(plan.marker, /VERDICT: APPROVE/)
    assert.equal(plan.source, "task-result")
    const violations = journalEntries(metricsDir).filter((l) => l.type === "violation")
    assert.ok(!violations.some((l) => l.agent === "plan-reviewer"))
    // Executor dispatch proceeds (plan file present → requires the green gate).
    await callTool(h, "execute.before", {
      tool: "task",
      sessionID: "p1",
      input: { agent: "executor", prompt: "do the work" },
    })
  } finally {
    restore()
  }
})

/** a verdict on the child's own text is attributed when the delivery output is marker-less (divergence). */
test("plan gate: child-text verdict attributes through a marker-less delivery", async () => {
  const { h, metricsDir, restore } = await bootWithPlan()
  try {
    h.pushEvent({ type: "session.created", data: { sessionID: "c1", parentID: "p1" } })
    h.pushEvent({
      type: "session.text.ended",
      data: { sessionID: "c1", text: `\nreview\n\n${APPROVE}\n` },
    })
    await waitUntil(() =>
      journalEntries(metricsDir).some((e) => e.type === "verdict" && e.raw === "c1"),
    )
    // Summarized delivery: no marker anywhere in the output.
    await callTool(h, "execute.after", {
      tool: "task",
      sessionID: "c1",
      input: { agent: "plan-reviewer" },
      result: { output: "Review complete; see journal." },
    })
    const plan = journalEntries(metricsDir).find((l) => l.type === "plan")
    assert.ok(plan)
    assert.equal(plan.result, "APPROVE")
    assert.equal(plan.sessionID, "p1")
    assert.equal(plan.raw, "c1")
    assert.equal(plan.source, "child-text")
    const violations = journalEntries(metricsDir).filter((l) => l.type === "violation")
    assert.ok(!violations.some((l) => l.agent === "plan-reviewer"))
    await callTool(h, "execute.before", {
      tool: "task",
      sessionID: "p1",
      input: { agent: "executor", prompt: "do the work" },
    })
  } finally {
    restore()
  }
})

/** Delta variant: a verdict on the child's streamed text-delta is
 * attributed through a marker-less delivery (divergence via the delta source). */
test("plan gate: child-text-delta verdict attributes through a marker-less delivery", async () => {
  const { h, metricsDir, restore } = await bootWithPlan()
  try {
    h.pushEvent({ type: "session.created", data: { sessionID: "c1", parentID: "p1" } })
    h.pushEvent({
      type: "session.text.delta",
      data: { sessionID: "c1", delta: `\nreview\n\n${APPROVE}\n` },
    })
    await waitUntil(() =>
      journalEntries(metricsDir).some((e) => e.type === "verdict" && e.raw === "c1"),
    )
    // Summarized delivery: no marker anywhere in the output.
    await callTool(h, "execute.after", {
      tool: "task",
      sessionID: "c1",
      input: { agent: "plan-reviewer" },
      result: { output: "Review complete; see journal." },
    })
    const plan = journalEntries(metricsDir).find((l) => l.type === "plan")
    assert.ok(plan)
    assert.equal(plan.result, "APPROVE")
    assert.equal(plan.sessionID, "p1")
    assert.equal(plan.raw, "c1")
    assert.equal(plan.source, "child-text-delta")
    const violations = journalEntries(metricsDir).filter((l) => l.type === "violation")
    assert.ok(!violations.some((l) => l.agent === "plan-reviewer"))
    await callTool(h, "execute.before", {
      tool: "task",
      sessionID: "p1",
      input: { agent: "executor", prompt: "do the work" },
    })
  } finally {
    restore()
  }
})

/** a task-result marker never enters the child store; a later marker-less delivery still blocks. */
test("plan gate: task-result marker is not stored; later marker-less still blocks", async () => {
  const { h, metricsDir, restore } = await bootWithPlan()
  try {
    // Deliver on the child: the edge makes the delivery attributable.
    h.pushEvent({ type: "session.created", data: { sessionID: "c1", parentID: "p1" } })
    await settle()
    await callTool(h, "execute.after", {
      tool: "task",
      sessionID: "c1",
      input: { agent: "plan-reviewer" },
      result: { output: `${BLOCK}\nAC-1 GAP\n` },
    })
    await callTool(h, "execute.after", {
      tool: "task",
      sessionID: "c1",
      input: { agent: "plan-reviewer" },
      result: { output: "reviewed, looks fine\n" },
    })
    const plan = journalEntries(metricsDir).filter((l) => l.type === "plan")
    const second = plan[plan.length - 1]
    assert.ok(second)
    assert.equal(second.result, "BLOCK")
    assert.equal(second.marker, "<none>")
    assert.equal(second.source, "task-result")
    const violations = journalEntries(metricsDir).filter((l) => l.type === "violation")
    assert.ok(violations.some((l) => l.agent === "plan-reviewer"))
  } finally {
    restore()
  }
})

/** latest child-text observation wins; the delivery's own output overrides a stored marker. */
test("plan gate: latest child-text wins and delivery text overrides stored marker", async () => {
  // (a) BLOCK then APPROVE child text → marker-less delivery approves.
  {
    const { h, metricsDir, restore } = await bootWithPlan()
    try {
      h.pushEvent({ type: "session.created", data: { sessionID: "c1", parentID: "p1" } })
      h.pushEvent({ type: "session.text.ended", data: { sessionID: "c1", text: `${BLOCK}\n` } })
      h.pushEvent({ type: "session.text.ended", data: { sessionID: "c1", text: `${APPROVE}\n` } })
      await waitUntil(
        () => journalEntries(metricsDir).filter((l) => l.type === "verdict").length >= 2,
      )
      await settle()
      await callTool(h, "execute.after", {
        tool: "task",
        sessionID: "c1",
        input: { agent: "plan-reviewer" },
        result: { output: "Review complete." },
      })
      const plan = journalEntries(metricsDir).filter((l) => l.type === "plan")
      const latest = plan[plan.length - 1]
      assert.ok(latest)
      assert.equal(latest.result, "APPROVE")
      await callTool(h, "execute.before", {
        tool: "task",
        sessionID: "p1",
        input: { agent: "executor", prompt: "do the work" },
      })
    } finally {
      restore()
    }
  }
  // (a, reverse) APPROVE then BLOCK child text → marker-less delivery blocks.
  {
    const { h, metricsDir, restore } = await bootWithPlan()
    try {
      h.pushEvent({ type: "session.created", data: { sessionID: "c1", parentID: "p1" } })
      h.pushEvent({ type: "session.text.ended", data: { sessionID: "c1", text: `${APPROVE}\n` } })
      h.pushEvent({ type: "session.text.ended", data: { sessionID: "c1", text: `${BLOCK}\n` } })
      await waitUntil(
        () => journalEntries(metricsDir).filter((l) => l.type === "verdict").length >= 2,
      )
      await settle()
      await callTool(h, "execute.after", {
        tool: "task",
        sessionID: "c1",
        input: { agent: "plan-reviewer" },
        result: { output: "Review complete." },
      })
      const plan = journalEntries(metricsDir).filter((l) => l.type === "plan")
      const latest = plan[plan.length - 1]
      assert.ok(latest)
      assert.equal(latest.result, "BLOCK")
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
  }
  // (b) delivery text BLOCK overrides a stored child-text APPROVE (delivery wins).
  {
    const { h, metricsDir, restore } = await bootWithPlan()
    try {
      h.pushEvent({ type: "session.created", data: { sessionID: "c1", parentID: "p1" } })
      h.pushEvent({ type: "session.text.ended", data: { sessionID: "c1", text: `${APPROVE}\n` } })
      await waitUntil(
        () => journalEntries(metricsDir).filter((l) => l.type === "verdict").length >= 1,
      )
      await callTool(h, "execute.after", {
        tool: "task",
        sessionID: "c1",
        input: { agent: "plan-reviewer" },
        result: { output: `${BLOCK}\nsome reasoning\n` },
      })
      const plan = journalEntries(metricsDir).filter((l) => l.type === "plan")
      const latest = plan[plan.length - 1]
      assert.ok(latest)
      assert.equal(latest.result, "BLOCK")
      assert.equal(latest.source, "task-result")
    } finally {
      restore()
    }
  }
})

/** per-child recording is independent of the dedup set; a sibling streaming an identical marker still attributes. */
test("plan gate: identical marker for a sibling child still attributes per child", async () => {
  const { h, metricsDir, restore } = await bootWithPlan()
  try {
    h.pushEvent({ type: "session.created", data: { sessionID: "c1", parentID: "p1" } })
    h.pushEvent({ type: "session.created", data: { sessionID: "c2", parentID: "p1" } })
    h.pushEvent({ type: "session.text.ended", data: { sessionID: "c1", text: APPROVE } })
    await waitUntil(() => journalEntries(metricsDir).some((l) => l.type === "verdict"))
    // Byte-identical marker for a second child: dedup suppresses its verdict
    // entry, but text-derived recording still stores it (independent of seen).
    h.pushEvent({ type: "session.text.ended", data: { sessionID: "c2", text: APPROVE } })
    await settle()
    await callTool(h, "execute.after", {
      tool: "task",
      sessionID: "c2",
      input: { agent: "plan-reviewer" },
      result: { output: "Review complete; see journal." },
    })
    const plan = journalEntries(metricsDir).filter((l) => l.type === "plan")
    const latest = plan[plan.length - 1]
    assert.ok(latest)
    assert.equal(latest.result, "APPROVE")
    assert.equal(latest.raw, "c2")
    assert.equal(latest.source, "child-text")
    // Dedup untouched: still exactly one verdict entry despite two children.
    assert.equal(journalEntries(metricsDir).filter((l) => l.type === "verdict").length, 1)
    await callTool(h, "execute.before", {
      tool: "task",
      sessionID: "p1",
      input: { agent: "executor", prompt: "do the work" },
    })
  } finally {
    restore()
  }
})

/** a stale verdict for one child does not attribute to an unrelated child. */
test("plan gate: stale verdict for one child does not attribute to another child", async () => {
  const { h, metricsDir, restore } = await bootWithPlan()
  try {
    h.pushEvent({ type: "session.created", data: { sessionID: "c1", parentID: "p1" } })
    h.pushEvent({ type: "session.text.ended", data: { sessionID: "c1", text: `${APPROVE}\n` } })
    await waitUntil(() => journalEntries(metricsDir).some((e) => e.type === "verdict"))
    // c2 is a distinct child of the same parent, but it is unrelated to c1's
    // verdict: register its edge so the marker-less delivery is attributable
    // rather than self-keyed.
    h.pushEvent({ type: "session.created", data: { sessionID: "c2", parentID: "p1" } })
    await settle()
    // c2 has no stream events → its store is empty.
    await callTool(h, "execute.after", {
      tool: "task",
      sessionID: "c2",
      input: { agent: "plan-reviewer" },
      result: { output: "Task finished." },
    })
    const plan = journalEntries(metricsDir).filter((l) => l.type === "plan")
    const latest = plan[plan.length - 1]
    assert.ok(latest)
    assert.equal(latest.result, "BLOCK")
    assert.equal(latest.marker, "<none>")
    const violations = journalEntries(metricsDir).filter((l) => l.type === "violation")
    assert.ok(violations.some((l) => l.agent === "plan-reviewer"))
    // Gate stays red for the parent.
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

/**
 * a plans-dir change invalidates every session holding a
 * live approval, not just the first to dispatch — the consumed-once global
 * `changed` flag left the second session's stale approval ungated.
 */
test("plan gate: plan-file change invalidates every approved session", async () => {
  const { h, restore, project } = await bootWithPlan()
  try {
    // Two independent sessions each approve and run a green dispatch. Each
    // approval is delivered on a child of its parent:
    // parent-keyed self-keyed deliveries can no longer journal a plan entry.
    h.pushEvent({ type: "session.created", data: { sessionID: "c1", parentID: "p1" } })
    h.pushEvent({ type: "session.created", data: { sessionID: "c2", parentID: "p2" } })
    await settle()
    await callTool(h, "execute.after", {
      tool: "task",
      sessionID: "c1",
      input: { agent: "plan-reviewer" },
      result: { output: `${APPROVE}\n` },
    })
    await callTool(h, "execute.before", {
      tool: "task",
      sessionID: "p1",
      input: { agent: "executor", prompt: "do the work" },
    })
    await callTool(h, "execute.after", {
      tool: "task",
      sessionID: "c2",
      input: { agent: "plan-reviewer" },
      result: { output: `${APPROVE}\n` },
    })
    await callTool(h, "execute.before", {
      tool: "task",
      sessionID: "p2",
      input: { agent: "executor", prompt: "do the work" },
    })
    // Re-plan invalidates BOTH sessions (future mtime bumps past timer tick).
    const planPath = path.join(project, ".opencode", "plans", "plan.md")
    fs.writeFileSync(planPath, "# P revised\n")
    const future = new Date(Date.now() + 5000)
    fs.utimesSync(planPath, future, future)
    await assert.rejects(
      () =>
        callTool(h, "execute.before", {
          tool: "task",
          sessionID: "p1",
          input: { agent: "executor", prompt: "do the work" },
        }),
      /no plan approval for "plan\.md"/,
    )
    await assert.rejects(
      () =>
        callTool(h, "execute.before", {
          tool: "task",
          sessionID: "p2",
          input: { agent: "executor", prompt: "do the work" },
        }),
      /no plan approval for "plan\.md"/,
    )
    // Re-approving both releases both.
    await callTool(h, "execute.after", {
      tool: "task",
      sessionID: "c1",
      input: { agent: "plan-reviewer" },
      result: { output: `${APPROVE}\n` },
    })
    await callTool(h, "execute.after", {
      tool: "task",
      sessionID: "c2",
      input: { agent: "plan-reviewer" },
      result: { output: `${APPROVE}\n` },
    })
    await callTool(h, "execute.before", {
      tool: "task",
      sessionID: "p1",
      input: { agent: "executor", prompt: "do the work" },
    })
    await callTool(h, "execute.before", {
      tool: "task",
      sessionID: "p2",
      input: { agent: "executor", prompt: "do the work" },
    })
  } finally {
    restore()
  }
})

/**
 * approving then editing the plan before
 * any executor dispatch blocks the session's very first dispatch — no prior
 * scan exists to (on the old code) suppress invalidation on the first scan.
 */
test("plan gate: approve then edit blocks the first dispatch", async () => {
  const { h, restore, project } = await bootWithPlan()
  try {
    // A plan-reviewer delivery attributed to the parent must arrive on the
    // child session id: register the child→parent edge first, so
    // the approval journals raw=c1 and actually greens the parent's gate.
    h.pushEvent({ type: "session.created", data: { sessionID: "c1", parentID: "p1" } })
    await settle()
    await callTool(h, "execute.after", {
      tool: "task",
      sessionID: "c1",
      input: { agent: "plan-reviewer" },
      result: { output: `${APPROVE}\n` },
    })
    // Edit the plan before ANY executor dispatch runs.
    const planPath = path.join(project, ".opencode", "plans", "plan.md")
    fs.writeFileSync(planPath, "# P revised\n")
    const future = new Date(Date.now() + 5000)
    fs.utimesSync(planPath, future, future)
    // First dispatch must be blocked — there is no prior scan to trust.
    await assert.rejects(
      () =>
        callTool(h, "execute.before", {
          tool: "task",
          sessionID: "p1",
          input: { agent: "executor", prompt: "do the work" },
        }),
      /no plan approval for "plan\.md"/,
    )
  } finally {
    restore()
  }
})

/**
 * a journal-replayed approval survives the
 * first dispatch (empty stamp is accepted once and stamped), then a later edit
 * invalidates it, and re-approving re-stamps so the session runs again.
 */
test("plan gate: replayed approval stamps then invalidates on edit", async () => {
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
    // Replay-restored approval survives the first dispatch (stamps the key).
    await callTool(h, "execute.before", {
      tool: "task",
      sessionID: "p1",
      input: { agent: "executor", prompt: "do the work" },
    })
    // An edit after restart invalidates the previously-approved plan.
    const planPath = path.join(project, ".opencode", "plans", "plan.md")
    fs.writeFileSync(planPath, "# P revised\n")
    const future = new Date(Date.now() + 5000)
    fs.utimesSync(planPath, future, future)
    await assert.rejects(
      () =>
        callTool(h, "execute.before", {
          tool: "task",
          sessionID: "p1",
          input: { agent: "executor", prompt: "do the work" },
        }),
      /no plan approval for "plan\.md"/,
    )
    // Re-approving re-stamps, so the session runs again (proves re-stamp).
    // Delivered on the child so the plan entry is keyed raw=c1.
    h.pushEvent({ type: "session.created", data: { sessionID: "c1", parentID: "p1" } })
    await settle()
    await callTool(h, "execute.after", {
      tool: "task",
      sessionID: "c1",
      input: { agent: "plan-reviewer" },
      result: { output: `${APPROVE}\n` },
    })
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

/**
 * an approval recorded while the plans dir is
 * absent stamps "" (unknown); it is accepted once when the dir later appears
 * and stamped, so a subsequent edit still invalidates it.
 */
test("plan gate: absent plans dir at APPROVE stamps empty; accept-once then stamp", async () => {
  const project = tmpDir()
  const metricsDir = tmpDir()
  const h = makeFakeHost()
  const prev = process.cwd()
  process.chdir(project)
  try {
    const setup = turnstile(h.host, { env: isolatedEnv(metricsDir), config: { metricsDir } })
    const dispose = (await setup(h.host)) as () => void
    // Approve while the plans dir is absent → stamp "" (unknown, fail-open).
    // Delivered on the child so the plan entry is keyed raw=c1.
    h.pushEvent({ type: "session.created", data: { sessionID: "c1", parentID: "p1" } })
    await settle()
    await callTool(h, "execute.after", {
      tool: "task",
      sessionID: "c1",
      input: { agent: "plan-reviewer" },
      result: { output: `${APPROVE}\n` },
    })
    // No plans dir at enforcement → executor needs no approval.
    await callTool(h, "execute.before", {
      tool: "task",
      sessionID: "p1",
      input: { agent: "executor", prompt: "do the work" },
    })
    // The plans dir + plan file appear; the empty stamp is validated here.
    fs.mkdirSync(path.join(project, ".opencode", "plans"), { recursive: true })
    fs.writeFileSync(path.join(project, ".opencode", "plans", "plan.md"), "# P\n")
    await callTool(h, "execute.before", {
      tool: "task",
      sessionID: "p1",
      input: { agent: "executor", prompt: "do the work" },
    })
    // A subsequent edit invalidates the freshly-stamped approval.
    const planPath = path.join(project, ".opencode", "plans", "plan.md")
    fs.writeFileSync(planPath, "# P revised\n")
    const future = new Date(Date.now() + 5000)
    fs.utimesSync(planPath, future, future)
    await assert.rejects(
      () =>
        callTool(h, "execute.before", {
          tool: "task",
          sessionID: "p1",
          input: { agent: "executor", prompt: "do the work" },
        }),
      /no plan approval for "plan\.md"/,
    )
    dispose()
  } finally {
    process.chdir(prev)
  }
})

/**
 * a content-preserving utimes-only touch (identical
 * bytes, only atime/mtime moved) must NOT invalidate a prior approval, so the
 * next executor dispatch stays green and no extra no-plan-verdict is journaled.
 */
test("plan gate: content-preserving utimes touch keeps approval green", async () => {
  const { h, metricsDir, restore, project } = await bootWithPlan("# P\n")
  try {
    // A plan-reviewer delivery attributed to the parent must arrive on the
    // child session id: register the child→parent edge first, so
    // the approval journals raw=c1 and actually greens the parent's gate.
    h.pushEvent({ type: "session.created", data: { sessionID: "c1", parentID: "p1" } })
    await settle()
    await callTool(h, "execute.after", {
      tool: "task",
      sessionID: "c1",
      input: { agent: "plan-reviewer" },
      result: { output: `${APPROVE}\n` },
    })
    await callTool(h, "execute.before", {
      tool: "task",
      sessionID: "p1",
      input: { agent: "executor", prompt: "do the work" },
    })
    // Content-preserving touch: move timestamps only, bytes identical.
    const planPath = path.join(project, ".opencode", "plans", "plan.md")
    const future = Date.now() + 5000
    fs.utimesSync(planPath, future, future)
    const blockedBefore = journalEntries(metricsDir).filter((l) => l.reason === "no-plan-verdict")
    // Still green — a touch with no content change does not demand re-review.
    await callTool(h, "execute.before", {
      tool: "task",
      sessionID: "p1",
      input: { agent: "executor", prompt: "do the work" },
    })
    // The touch did not inject a fresh no-plan-verdict block.
    const blockedAfter = journalEntries(metricsDir).filter((l) => l.reason === "no-plan-verdict")
    assert.equal(blockedAfter.length, blockedBefore.length)
  } finally {
    restore()
  }
})

/**
 * a same-byte-length rewrite whose atime/mtime are
 * restored to the exact prior floats must still invalidate, because the
 * content signature (sha256) differs. The number-seconds utimes form (not
 * Date) avoids moving the restored mtime onto a new APFS tick.
 */
test("plan gate: same-mtime same-size edit invalidates the approval", async () => {
  const { h, restore, project } = await bootWithPlan("# P\n")
  try {
    // A plan-reviewer delivery attributed to the parent must arrive on the
    // child session id: register the child→parent edge first, so
    // the approval journals raw=c1 and actually greens the parent's gate.
    h.pushEvent({ type: "session.created", data: { sessionID: "c1", parentID: "p1" } })
    await settle()
    await callTool(h, "execute.after", {
      tool: "task",
      sessionID: "c1",
      input: { agent: "plan-reviewer" },
      result: { output: `${APPROVE}\n` },
    })
    await callTool(h, "execute.before", {
      tool: "task",
      sessionID: "p1",
      input: { agent: "executor", prompt: "do the work" },
    })
    // Same-size rewrite (both 4 bytes), then restore the exact prior times.
    const planPath = path.join(project, ".opencode", "plans", "plan.md")
    const st = fs.statSync(planPath)
    fs.writeFileSync(planPath, "# Q\n")
    fs.utimesSync(planPath, st.atimeMs / 1000, st.mtimeMs / 1000)
    await assert.rejects(
      () =>
        callTool(h, "execute.before", {
          tool: "task",
          sessionID: "p1",
          input: { agent: "executor", prompt: "do the work" },
        }),
      /no plan approval for "plan\.md"/,
    )
  } finally {
    restore()
  }
})

/**
 * plansSignature is a stat-free, path-free content
 * signature `name:sha256hex(,…)`: empty dir ⇒ the literal sentinel `"empty"`
 * (never `""`, which would collide with the accept-once stamp), adding a plan
 * ⇒ `plan.md:[0-9a-f]{64}`, a name-only rename changes just the name, and
 * re-runs are identical. No mtime term. An approval stamped on the empty
 * sentinel is dropped loudly (STALE) once a plan file appears.
 */
test("plan gate: plansSignature is a content signature (name:sha256hex)", async () => {
  const project = tmpDir()
  fs.mkdirSync(path.join(project, ".opencode", "plans"), { recursive: true })
  const plansDir = path.join(project, ".opencode", "plans")
  const metricsDir = tmpDir()
  const config = { ...defaultConfig(process.env), metricsDir }
  const journaler = createJournaler({
    metricsDir,
    trace: false,
    maxBytes: 5 * 1024 * 1024,
    maxGenerations: 5,
  })
  const gates = createGates(config, journaler)
  const ledger = createLedger(path.join(metricsDir, "state.jsonl"), 64)
  // Empty dir ⇒ the path-free empty sentinel, never "": an approval stamped on
  // an empty dir must mismatch once a plan file appears. No stat/mtime term.
  assert.equal(gates.plansSignature(project), "empty")
  // An approval stamped on the empty sentinel is dropped loudly (STALE) once a
  // plan file appears: "empty" differs from the new non-empty key.
  const s = ledger.state("p1")
  s.hasPlanVerdict = true
  s.plansSignature = "empty"
  fs.writeFileSync(path.join(plansDir, "plan.md"), "# P\n")
  const red = gates.planGateStatus(project, ledger, "p1")
  assert.equal(red.red, true)
  const stale = journalEntries(metricsDir).filter((l) => l.result === "STALE")
  assert.equal(stale.length, 1)
  // Add a plan ⇒ name:64-hex; the format carries no directory or `mtime`.
  const sig = gates.plansSignature(project)
  assert.ok(sig, "plansSignature returned null for an existing plan")
  assert.match(sig, /^plan\.md:[0-9a-f]{64}$/)
  assert.doesNotMatch(sig, /mtime/)
  // Name-only rename (bytes identical) changes only the name ⇒ the key changes.
  fs.renameSync(path.join(plansDir, "plan.md"), path.join(plansDir, "renamed.md"))
  const renamed = gates.plansSignature(project)
  assert.ok(renamed, "plansSignature returned null for a renamed plan")
  assert.match(renamed, /^renamed\.md:[0-9a-f]{64}$/)
  assert.notEqual(sig, renamed)
  // Idempotent: a re-scan with unchanged content returns the same key.
  assert.equal(gates.plansSignature(project), renamed)
})

/**
 * deleting one of two plans changes the name
 * set, so the key changes even though the surviving plan's content bytes
 * never moved — the approval must invalidate (and still name the survivor).
 */
test("plan gate: deleting a plan invalidates via the name set", async () => {
  const { h, restore, project } = await bootWithPlan("# P\n")
  try {
    // A second plan joins the dir before approval so the key carries both.
    fs.writeFileSync(path.join(project, ".opencode", "plans", "extra.md"), "# E\n")
    // Deliver the approval on the child so the plan entry is keyed raw=c1.
    h.pushEvent({ type: "session.created", data: { sessionID: "c1", parentID: "p1" } })
    await settle()
    await callTool(h, "execute.after", {
      tool: "task",
      sessionID: "c1",
      input: { agent: "plan-reviewer" },
      result: { output: `${APPROVE}\n` },
    })
    await callTool(h, "execute.before", {
      tool: "task",
      sessionID: "p1",
      input: { agent: "executor", prompt: "do the work" },
    })
    // Remove the sibling: the name set shrinks, the key changes, survivor is
    // the same bytes → approval invalidates and names "plan.md".
    fs.rmSync(path.join(project, ".opencode", "plans", "extra.md"))
    await assert.rejects(
      () =>
        callTool(h, "execute.before", {
          tool: "task",
          sessionID: "p1",
          input: { agent: "executor", prompt: "do the work" },
        }),
      /no plan approval for "plan\.md"/,
    )
  } finally {
    restore()
  }
})

/**
 * an unreadable plan file throws mid-scan, and
 * enforcePlanApproval's fail-open catch lets the dispatch through (no
 * BlockError) while now journaling a `type:"error"` so the suppression is
 * observable rather than silent. Skipped as root, where permission bits are
 * bypassed.
 */
test("plan gate: unreadable plan file mid-scan fails open (executor allowed)", async () => {
  if (process.getuid?.() === 0) return
  const { h, restore, metricsDir, project } = await bootWithPlan("# P\n")
  try {
    // A plan-reviewer delivery attributed to the parent must arrive on the
    // child session id: register the child→parent edge first, so
    // the approval journals raw=c1 and actually greens the parent's gate.
    h.pushEvent({ type: "session.created", data: { sessionID: "c1", parentID: "p1" } })
    await settle()
    await callTool(h, "execute.after", {
      tool: "task",
      sessionID: "c1",
      input: { agent: "plan-reviewer" },
      result: { output: `${APPROVE}\n` },
    })
    await callTool(h, "execute.before", {
      tool: "task",
      sessionID: "p1",
      input: { agent: "executor", prompt: "do the work" },
    })
    // Make the plan unreadable; the read throws, the gate fails open.
    const planPath = path.join(project, ".opencode", "plans", "plan.md")
    const mode = fs.statSync(planPath).mode
    fs.chmodSync(planPath, 0o000)
    try {
      await callTool(h, "execute.before", {
        tool: "task",
        sessionID: "p1",
        input: { agent: "executor", prompt: "do the work" },
      })
      // The failed scan fails open (executor not blocked) and journals a
      // `type:"error"` so the silent suppression is observable.
      assert.equal(
        journalEntries(metricsDir).filter((l) => l.type === "blocked").length,
        0,
        "the executor is not blocked on an unreadable plan",
      )
      assert.ok(
        journalEntries(metricsDir).some((l) => l.type === "error"),
        "the fail-open catch journals the error",
      )
    } finally {
      fs.chmodSync(planPath, mode)
    }
  } finally {
    restore()
  }
})

/**
 * A BLOCK verdict followed by a re-dispatched plan-reviewer's APPROVE (in a
 * later round) clears the plan gate: the self-keyed delivery round-scopes out
 * the prior-round edge child and credits the round's APPROVE, so the first
 * executor dispatch is not blocked — the dead-end after a BLOCK verdict.
 */
test("plan gate: a re-review APPROVE after a prior BLOCK clears the gate", async () => {
  const { h, metricsDir, restore } = await bootWithPlan()
  try {
    // Round 1: register the child, stream a BLOCK on it, then deliver it on the
    // child (edge-resolved) so the gate journals a BLOCK and stays red.
    h.pushEvent({ type: "session.created", data: { sessionID: "c1", parentID: "p1" } })
    await settle()
    h.pushEvent({ type: "session.text.ended", data: { sessionID: "c1", text: `${BLOCK}\n` } })
    await waitUntil(() =>
      journalEntries(metricsDir).some((e) => e.type === "verdict" && e.raw === "c1"),
    )
    await settle()
    await callTool(h, "execute.after", {
      tool: "task",
      sessionID: "c1",
      input: { agent: "plan-reviewer" },
      result: { output: "Task finished." },
    })
    // The gate is red after the BLOCK: the first executor dispatch is blocked.
    await assert.rejects(
      () =>
        callTool(h, "execute.before", {
          tool: "task",
          sessionID: "p1",
          input: { agent: "executor", prompt: "do the work" },
        }),
      /no plan approval for "plan\.md"/,
    )
    // Round 2: re-dispatch the plan-reviewer, then stream an APPROVE on a fresh
    // unrelated child, then a marker-less self-keyed delivery on the parent
    // credits the round's APPROVE.
    await callTool(h, "execute.before", {
      tool: "task",
      sessionID: "p1",
      input: { agent: "plan-reviewer", prompt: "review the plan" },
    })
    await settle()
    h.pushEvent({ type: "session.text.ended", data: { sessionID: "c2", text: `${APPROVE}\n` } })
    await waitUntil(() =>
      journalEntries(metricsDir).some((e) => e.type === "verdict" && e.raw === "c2"),
    )
    await settle()
    await callTool(h, "execute.after", {
      tool: "task",
      sessionID: "p1",
      input: { agent: "plan-reviewer" },
      result: { output: "Task finished." },
    })
    // The gate is green: the first executor dispatch is not blocked.
    await callTool(h, "execute.before", {
      tool: "task",
      sessionID: "p1",
      input: { agent: "executor", prompt: "do the work" },
    })
  } finally {
    restore()
  }
})

/**
 * An approval survives a same-content move between directories: the path-free
 * signature is stamped at A and re-read at B with byte-identical plans, so the
 * next dispatch stays green and no STALE entry is journaled.
 */
test("plan gate: approval survives a same-content move between directories", async () => {
  const { h, metricsDir, restore, projectB, sessionRecords } = await bootWithMove("# P\n", "# P\n")
  try {
    // Approve while resolving to the seed (A): the path-free signature is
    // stamped from A's content.
    h.pushEvent({ type: "session.created", data: { sessionID: "c1", parentID: "p1" } })
    await settle()
    await callTool(h, "execute.after", {
      tool: "task",
      sessionID: "c1",
      input: { agent: "plan-reviewer" },
      result: { output: `${APPROVE}\n` },
    })
    // Move the record to a byte-identical checkout B.
    sessionRecords.set("p1", { location: { directory: projectB } })
    // The next dispatch resolves B; identical content keeps the approval green.
    await callTool(h, "execute.before", {
      tool: "task",
      sessionID: "p1",
      input: { agent: "executor", prompt: "do the work" },
    })
    assert.equal(journalEntries(metricsDir).filter((l) => l.result === "STALE").length, 0)
  } finally {
    restore()
  }
})

/**
 * A content change after a move invalidates loudly: the signature stamped at A
 * differs from B's, so the next dispatch blocks and journals exactly one
 * replay-inert STALE entry (and a journal carrying only it restores nothing).
 */
test("plan gate: a content change after a move invalidates loudly with STALE", async () => {
  const { h, metricsDir, restore, projectB, sessionRecords } = await bootWithMove(
    "# P\n",
    "# P revised\n",
  )
  try {
    // Approve while resolving to the seed (A): the path-free signature is
    // stamped from A's content.
    h.pushEvent({ type: "session.created", data: { sessionID: "c1", parentID: "p1" } })
    await settle()
    await callTool(h, "execute.after", {
      tool: "task",
      sessionID: "c1",
      input: { agent: "plan-reviewer" },
      result: { output: `${APPROVE}\n` },
    })
    // Move the record to a checkout B whose plan content differs from A's.
    sessionRecords.set("p1", { location: { directory: projectB } })
    await assert.rejects(
      () =>
        callTool(h, "execute.before", {
          tool: "task",
          sessionID: "p1",
          input: { agent: "executor", prompt: "do the work" },
        }),
      /no plan approval for "plan\.md"/,
    )
    const stale = journalEntries(metricsDir).filter((l) => l.result === "STALE")
    assert.equal(stale.length, 1)
    assert.equal(stale[0]!.reason, "signature-mismatch")
    // A STALE entry is replay-inert: a journal carrying only it must not restore
    // the plan-approval gate.
    const replayDir = tmpDir()
    const replayJournal = path.join(replayDir, "turnstile.jsonl")
    fs.writeFileSync(
      replayJournal,
      JSON.stringify({
        type: "plan",
        sessionID: "p1",
        result: "STALE",
        reason: "signature-mismatch",
      }) + "\n",
    )
    assert.equal(createLedger(replayJournal, 64).peek("p1"), undefined)
  } finally {
    restore()
  }
})
