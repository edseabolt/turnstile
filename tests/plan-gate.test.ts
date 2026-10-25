/**
 * @fileoverview Plan-approval gate tests: executor dispatch blocked until
 * a plan-reviewer result records `VERDICT: APPROVE`, waiver bypass, bare
 * output and BLOCK verdicts keep the gate red, re-plan invalidation, the
 * no-plans-dir pass-through, and journal replay of plan approvals, via a
 * fake host with injected config. Also covers the durable approved-plan
 * sidecar: survival across replay-aging, a new-prompt reset, and a restart
 * (and its content wall), the all-landed pending-set exemption, and the
 * unbound human-approval scope boundary.
 */

import { test } from "node:test"
import assert from "node:assert/strict"
import * as fs from "node:fs"
import * as path from "node:path"
import { createHash } from "node:crypto"

import { turnstile } from "../turnstile.ts"
import { createGates, type Gates } from "../src/gates.ts"
import { defaultConfig } from "../src/config.ts"
import { createJournaler } from "../src/journal.ts"
import { createLedger, type GateLedger } from "../src/ledger.ts"
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
} from "./helpers.ts"

const APPROVE = "VERDICT: APPROVE crit=0 high=0 med=0 low=0"
const BLOCK = "VERDICT: BLOCK crit=1 high=0 med=0 low=0"

/**
 * Wall-clock buffer for waits with no bus drain boundary — here, the strict
 * timestamp ordering between a dispatch and the verdicts streamed after it.
 * Event-stream drains use the awaited push boundary instead.
 */
const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 30))

/**
 * Boots in a temp project dir containing a plan file.
 * @param planBody The plan file body to seed.
 * @param planName The plan file name to seed.
 * @param extra Overrides spread over the per-test metrics directory; an
 *     `approvalLedgerPath` key is lifted to the factory's top-level option.
 */
async function bootWithPlan(
  planBody = "# P\n",
  planName = "plan.md",
  extra: Record<string, any> = {},
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
  const { approvalLedgerPath, ...configExtra } = extra
  const setup = turnstile(h.host, {
    env: isolatedEnv(metricsDir),
    config: { metricsDir, ...configExtra },
    approvalLedgerPath,
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
    await h.pushEvent({
      type: "session.created",
      data: { sessionID: "c1", parentID: "p1", agent: "plan-reviewer" },
    })
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
    await h.pushEvent({
      type: "session.created",
      data: { sessionID: "c1", parentID: "p1", agent: "plan-reviewer" },
    })
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
  const journaler = createJournaler({
    metricsDir,
    trace: false,
    maxBytes: 1e6,
    maxGenerations: 1,
    rotateEveryEntries: 512,
  })
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
    h.pushEvent({
      type: "session.created",
      data: { sessionID: "c1", parentID: "p1", agent: "plan-reviewer" },
    })
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
    await h.pushEvent({
      type: "session.created",
      data: { sessionID: "c1", parentID: "p1", agent: "plan-reviewer" },
    })
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
    h.pushEvent({
      type: "session.created",
      data: { sessionID: "c1", parentID: "p1", agent: "plan-reviewer" },
    })
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
    h.pushEvent({
      type: "session.created",
      data: { sessionID: "c1", parentID: "p1", agent: "plan-reviewer" },
    })
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
    await h.pushEvent({
      type: "session.created",
      data: { sessionID: "c1", parentID: "p1", agent: "plan-reviewer" },
    })
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
      h.pushEvent({
        type: "session.created",
        data: { sessionID: "c1", parentID: "p1", agent: "plan-reviewer" },
      })
      h.pushEvent({ type: "session.text.ended", data: { sessionID: "c1", text: `${BLOCK}\n` } })
      await h.pushEvent({
        type: "session.text.ended",
        data: { sessionID: "c1", text: `${APPROVE}\n` },
      })
      await waitUntil(
        () => journalEntries(metricsDir).filter((l) => l.type === "verdict").length >= 2,
      )
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
      h.pushEvent({
        type: "session.created",
        data: { sessionID: "c1", parentID: "p1", agent: "plan-reviewer" },
      })
      h.pushEvent({ type: "session.text.ended", data: { sessionID: "c1", text: `${APPROVE}\n` } })
      await h.pushEvent({
        type: "session.text.ended",
        data: { sessionID: "c1", text: `${BLOCK}\n` },
      })
      await waitUntil(
        () => journalEntries(metricsDir).filter((l) => l.type === "verdict").length >= 2,
      )
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
      h.pushEvent({
        type: "session.created",
        data: { sessionID: "c1", parentID: "p1", agent: "plan-reviewer" },
      })
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
    h.pushEvent({
      type: "session.created",
      data: { sessionID: "c1", parentID: "p1", agent: "plan-reviewer" },
    })
    h.pushEvent({
      type: "session.created",
      data: { sessionID: "c2", parentID: "p1", agent: "plan-reviewer" },
    })
    h.pushEvent({ type: "session.text.ended", data: { sessionID: "c1", text: APPROVE } })
    await waitUntil(() => journalEntries(metricsDir).some((l) => l.type === "verdict"))
    // Byte-identical marker for a second child: dedup suppresses its verdict
    // entry, but text-derived recording still stores it (independent of seen).
    await h.pushEvent({ type: "session.text.ended", data: { sessionID: "c2", text: APPROVE } })
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
    h.pushEvent({
      type: "session.created",
      data: { sessionID: "c1", parentID: "p1", agent: "plan-reviewer" },
    })
    h.pushEvent({ type: "session.text.ended", data: { sessionID: "c1", text: `${APPROVE}\n` } })
    await waitUntil(() => journalEntries(metricsDir).some((e) => e.type === "verdict"))
    // c2 is a distinct child of the same parent, but it is unrelated to c1's
    // verdict: register its edge so the marker-less delivery is attributable
    // rather than self-keyed.
    await h.pushEvent({
      type: "session.created",
      data: { sessionID: "c2", parentID: "p1", agent: "plan-reviewer" },
    })
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
    h.pushEvent({
      type: "session.created",
      data: { sessionID: "c1", parentID: "p1", agent: "plan-reviewer" },
    })
    await h.pushEvent({ type: "session.created", data: { sessionID: "c2", parentID: "p2" } })
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
    await h.pushEvent({
      type: "session.created",
      data: { sessionID: "c1", parentID: "p1", agent: "plan-reviewer" },
    })
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
    await h.pushEvent({
      type: "session.created",
      data: { sessionID: "c1", parentID: "p1", agent: "plan-reviewer" },
    })
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
    await h.pushEvent({
      type: "session.created",
      data: { sessionID: "c1", parentID: "p1", agent: "plan-reviewer" },
    })
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
 * Computes the plans-dir content signature the same way a live approval
 * stamps it, so fixtures can derive an expected stamp without hand-building
 * the key.
 * @param project The project directory whose plans dir is signed.
 * @returns The dir content signature, or "" when the dir is absent/unreadable.
 */
function dirSignature(project: string): string {
  const journaler = createJournaler({
    metricsDir: tmpDir(),
    trace: false,
    maxBytes: 1e6,
    maxGenerations: 1,
    rotateEveryEntries: 512,
  })
  const gates = createGates(defaultConfig(), journaler)
  return gates.plansSignature(project) ?? ""
}

/**
 * An unbound APPROVE delivered on the edge child journals the stamped
 * plans-dir signature with the plan entry (and no bound identity), so a
 * later restart can replay the stamp and re-validate the approval against
 * the dir.
 */
test("plan gate: an unbound APPROVE journals the stamped plans-dir signature", async () => {
  const { h, metricsDir, restore, project } = await bootWithPlan()
  try {
    await reviewRound(h, "p1", "c1", "review the plan", APPROVE)
    const entry = journalEntries(metricsDir).find(
      (l) => l.type === "plan" && l.result === "APPROVE" && l.raw === "c1",
    )
    assert.ok(entry, "the edge delivery journaled an unbound APPROVE")
    assert.equal(entry?.plansSig, dirSignature(project), "the journaled stamp is the dir signature")
    assert.equal(entry?.plan, undefined, "an unbound approval journals no plan identity")
  } finally {
    restore()
  }
})

/**
 * A replayed unbound approval whose journaled signature no longer matches
 * the current plans dir — the plan was edited while the process was down —
 * is dropped on the first enforcing dispatch: the executor is blocked
 * naming the plan and a signature-mismatch STALE entry is journaled.
 */
test("plan gate: an offline plan edit invalidates the replayed approval", async () => {
  const project = tmpDir()
  const plansDir = path.join(project, ".opencode", "plans")
  fs.mkdirSync(plansDir, { recursive: true })
  const planPath = path.join(plansDir, "plan.md")
  fs.writeFileSync(planPath, "# P\n")
  const preSig = dirSignature(project)
  assert.notEqual(preSig, "", "the pre-edit signature is a real dir key")
  const metricsDir = tmpDir()
  fs.writeFileSync(
    path.join(metricsDir, "turnstile.jsonl"),
    JSON.stringify({
      ts: "t",
      type: "plan",
      sessionID: "p1",
      result: "APPROVE",
      marker: APPROVE,
      plansSig: preSig,
    }) + "\n",
  )
  // The offline edit: the plan changes while the process is down.
  fs.writeFileSync(planPath, "# P revised\n")
  const h = makeFakeHost()
  const prev = process.cwd()
  process.chdir(project)
  try {
    const setup = turnstile(h.host, { env: isolatedEnv(metricsDir), config: { metricsDir } })
    const dispose = (await setup(h.host)) as () => void
    await assert.rejects(
      () => execDispatch(h, "p1", "do the work"),
      /no plan approval for "plan\.md"/,
    )
    const stale = journalEntries(metricsDir).filter((l) => l.result === "STALE")
    assert.equal(stale.length, 1, "exactly one signature-mismatch drop is journaled")
    assert.equal(stale[0]?.reason, "signature-mismatch")
    dispose()
  } finally {
    process.chdir(prev)
  }
})

/**
 * A replayed unbound approval whose journaled signature matches the current
 * plans dir passes the first enforcing dispatch, re-stamps idempotently
 * (a second dispatch still passes, no STALE entry), and the gate snapshot
 * renders the restored stamp as known.
 */
test("plan gate: a matching replayed signature passes and re-stamps idempotently", async () => {
  const project = tmpDir()
  const plansDir = path.join(project, ".opencode", "plans")
  fs.mkdirSync(plansDir, { recursive: true })
  fs.writeFileSync(path.join(plansDir, "plan.md"), "# P\n")
  const sig = dirSignature(project)
  assert.notEqual(sig, "", "the signature is a real dir key")
  const metricsDir = tmpDir()
  fs.writeFileSync(
    path.join(metricsDir, "turnstile.jsonl"),
    JSON.stringify({
      ts: "t",
      type: "plan",
      sessionID: "p1",
      result: "APPROVE",
      marker: APPROVE,
      plansSig: sig,
    }) + "\n",
  )
  const h = makeFakeHost()
  const prev = process.cwd()
  process.chdir(project)
  try {
    const setup = turnstile(h.host, { env: isolatedEnv(metricsDir), config: { metricsDir } })
    const dispose = (await setup(h.host)) as () => void
    await execDispatch(h, "p1", "do the work")
    await execDispatch(h, "p1", "do the work")
    assert.equal(
      journalEntries(metricsDir).filter((l) => l.result === "STALE").length,
      0,
      "a matching stamp re-stamps instead of dropping",
    )
    const system: Array<{ type: string; text?: string }> = []
    await callSession(h, "compaction", { system, sessionID: "p1" })
    assert.match(system[1]?.text ?? "", /- plan: APPROVED stamp=known/)
    dispose()
  } finally {
    process.chdir(prev)
  }
})

/**
 * A replayed stamp mismatches whenever the dir's shape changes after
 * approval: one stamped on an empty dir must not pass once a plan appears
 * (the "empty" sentinel mismatches the populated dir), and one stamped
 * before a plan was added is invalid by the add alone — the unbound rule is
 * dir-scoped, so the approved file's own bytes are irrelevant.
 */
test("plan gate: a replayed stamp mismatches when the dir changes shape", async () => {
  // Stamped on an empty dir; one plan exists by restart.
  const project = tmpDir()
  const plansDir = path.join(project, ".opencode", "plans")
  fs.mkdirSync(plansDir, { recursive: true })
  const metricsDir = tmpDir()
  fs.writeFileSync(
    path.join(metricsDir, "turnstile.jsonl"),
    JSON.stringify({
      ts: "t",
      type: "plan",
      sessionID: "p1",
      result: "APPROVE",
      marker: APPROVE,
      plansSig: "empty",
    }) + "\n",
  )
  fs.writeFileSync(path.join(plansDir, "plan.md"), "# P\n")
  const h = makeFakeHost()
  const prev = process.cwd()
  process.chdir(project)
  try {
    const setup = turnstile(h.host, { env: isolatedEnv(metricsDir), config: { metricsDir } })
    const dispose = (await setup(h.host)) as () => void
    await assert.rejects(
      () => execDispatch(h, "p1", "do the work"),
      /no plan approval for "plan\.md"/,
    )
    dispose()
  } finally {
    process.chdir(prev)
  }
  // Stamped on a plan.md-only dir; an added plan moves the dir key.
  const project2 = tmpDir()
  const plansDir2 = path.join(project2, ".opencode", "plans")
  fs.mkdirSync(plansDir2, { recursive: true })
  fs.writeFileSync(path.join(plansDir2, "plan.md"), "# P\n")
  const sig = dirSignature(project2)
  const metricsDir2 = tmpDir()
  fs.writeFileSync(
    path.join(metricsDir2, "turnstile.jsonl"),
    JSON.stringify({
      ts: "t",
      type: "plan",
      sessionID: "p1",
      result: "APPROVE",
      marker: APPROVE,
      plansSig: sig,
    }) + "\n",
  )
  fs.writeFileSync(path.join(plansDir2, "m-extra.md"), "# M\n")
  const h2 = makeFakeHost()
  process.chdir(project2)
  try {
    const setup2 = turnstile(h2.host, {
      env: isolatedEnv(metricsDir2),
      config: { metricsDir: metricsDir2 },
    })
    const dispose2 = (await setup2(h2.host)) as () => void
    await assert.rejects(() => execDispatch(h2, "p1", "do the work"), /no plan approval for/)
    dispose2()
  } finally {
    process.chdir(prev)
  }
})

/**
 * A `PLAN APPROVED:` prompt under a controlled plan project journals a
 * prompt-channel APPROVE stamped with the current plans-dir signature (and no
 * bound identity — the prompt carries no plan-name candidates), and the
 * subsequent executor dispatch passes (the stamp re-validates idempotently).
 */
test("plan gate: a human PLAN APPROVED prompt journals the stamped dir signature", async () => {
  const { h, metricsDir, restore, project } = await bootWithPlan()
  try {
    await callSession(h, "prompt", {
      sessionID: "p1",
      text: "PLAN APPROVED: looks good",
    })
    const entry = journalEntries(metricsDir).find(
      (l) => l.type === "plan" && l.result === "APPROVE" && l.source === "session-prompt",
    )
    assert.ok(entry, "the prompt channel journaled an APPROVE")
    assert.equal(entry?.plansSig, dirSignature(project), "the journaled stamp is the dir signature")
    assert.equal(entry?.plan, undefined, "a prompt approval journals no plan identity")
    await execDispatch(h, "p1", "do the work")
    assert.equal(
      journalEntries(metricsDir).filter((l) => l.result === "STALE").length,
      0,
      "the matching stamp re-stamps idempotently, no stale drop",
    )
  } finally {
    restore()
  }
})

/**
 * A prompt-channel approval survives a restart stamped: the plan edited while
 * the process was down no longer matches the journaled signature, so the first
 * enforcing dispatch after the restart is blocked and a signature-mismatch
 * STALE entry is journaled — the same staleness the reviewer channel gets.
 */
test("plan gate: an offline plan edit invalidates the replayed prompt approval", async () => {
  const { h, metricsDir, project, restore } = await bootWithPlan()
  await callSession(h, "prompt", {
    sessionID: "p1",
    text: "PLAN APPROVED: looks good",
  })
  const stamped = journalEntries(metricsDir).find(
    (l) => l.type === "plan" && l.result === "APPROVE" && l.source === "session-prompt",
  )
  assert.ok(stamped?.plansSig, "the live approval journaled a stamp")
  restore() // dispose + restore cwd
  // The offline edit: the plan changes while the process is down.
  fs.writeFileSync(path.join(project, ".opencode", "plans", "plan.md"), "# P revised\n")
  const h2 = makeFakeHost()
  const prev = process.cwd()
  process.chdir(project)
  try {
    const setup = turnstile(h2.host, { env: isolatedEnv(metricsDir), config: { metricsDir } })
    const dispose = (await setup(h2.host)) as () => void
    await assert.rejects(
      () => execDispatch(h2, "p1", "do the work"),
      /no plan approval for "plan\.md"/,
    )
    const stale = journalEntries(metricsDir).filter((l) => l.result === "STALE")
    assert.equal(stale.length, 1, "exactly one signature-mismatch drop is journaled")
    assert.equal(stale[0]?.reason, "signature-mismatch")
    dispose()
  } finally {
    process.chdir(prev)
  }
})

/**
 * A legacy prompt-channel APPROVE line with no journaled signature keeps the
 * accept-once boundary: an offline plan edit before the first post-restart
 * dispatch does not go STALE — the approval is accepted once and re-stamped on
 * the green dispatch (the second dispatch still passes).
 */
test("plan gate: a field-less replayed prompt approval stays accept-once after an offline edit", async () => {
  const project = tmpDir()
  fs.mkdirSync(path.join(project, ".opencode", "plans"), { recursive: true })
  const planPath = path.join(project, ".opencode", "plans", "plan.md")
  fs.writeFileSync(planPath, "# P\n")
  const metricsDir = tmpDir()
  fs.writeFileSync(
    path.join(metricsDir, "turnstile.jsonl"),
    JSON.stringify({
      ts: "t",
      type: "plan",
      sessionID: "p1",
      result: "APPROVE",
      source: "session-prompt",
      marker: "PLAN APPROVED:",
    }) + "\n",
  )
  // The offline edit: the plan changes while the process is down, before the
  // legacy approval is restored.
  fs.writeFileSync(planPath, "# P revised\n")
  const h = makeFakeHost()
  const prev = process.cwd()
  process.chdir(project)
  try {
    const setup = turnstile(h.host, { env: isolatedEnv(metricsDir), config: { metricsDir } })
    const dispose = (await setup(h.host)) as () => void
    await execDispatch(h, "p1", "do the work")
    await execDispatch(h, "p1", "do the work")
    assert.equal(
      journalEntries(metricsDir).filter((l) => l.result === "STALE").length,
      0,
      "the field-less legacy line rides the accept-once path, no stale drop",
    )
    dispose()
  } finally {
    process.chdir(prev)
  }
})

/**
 * A `PLAN APPROVED:` prompt with no plans dir fails open: the stamp stays
 * unknown (""), the journaled APPROVE keeps the legacy field-less shape (no
 * signature field), and the approval rides the accept-once path.
 */
test("plan gate: a prompt approval with no plans dir journals the field-less shape", async () => {
  const project = tmpDir() // no .opencode/plans
  const metricsDir = tmpDir()
  const h = makeFakeHost()
  const prev = process.cwd()
  process.chdir(project)
  try {
    const setup = turnstile(h.host, { env: isolatedEnv(metricsDir), config: { metricsDir } })
    const dispose = (await setup(h.host)) as () => void
    await callSession(h, "prompt", { sessionID: "p1", text: "PLAN APPROVED: looks good" })
    const entry = journalEntries(metricsDir).find(
      (l) => l.type === "plan" && l.result === "APPROVE" && l.source === "session-prompt",
    )
    assert.ok(entry, "the prompt channel journaled an APPROVE")
    assert.deepEqual(
      { ...entry, ts: undefined },
      {
        ts: undefined,
        type: "plan",
        sessionID: "p1",
        result: "APPROVE",
        source: "session-prompt",
        marker: "PLAN APPROVED:",
      },
      "the entry keeps the legacy field-less shape",
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
    await h.pushEvent({
      type: "session.created",
      data: { sessionID: "c1", parentID: "p1", agent: "plan-reviewer" },
    })
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
    await h.pushEvent({
      type: "session.created",
      data: { sessionID: "c1", parentID: "p1", agent: "plan-reviewer" },
    })
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
    rotateEveryEntries: 512,
  })
  const gates = createGates(config, journaler)
  const ledger = createLedger(path.join(metricsDir, "state.jsonl"), 64, 2000)
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
    await h.pushEvent({
      type: "session.created",
      data: { sessionID: "c1", parentID: "p1", agent: "plan-reviewer" },
    })
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
    await h.pushEvent({
      type: "session.created",
      data: { sessionID: "c1", parentID: "p1", agent: "plan-reviewer" },
    })
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
    await h.pushEvent({
      type: "session.created",
      data: { sessionID: "c1", parentID: "p1", agent: "plan-reviewer" },
    })
    await h.pushEvent({ type: "session.text.ended", data: { sessionID: "c1", text: `${BLOCK}\n` } })
    await waitUntil(() =>
      journalEntries(metricsDir).some((e) => e.type === "verdict" && e.raw === "c1"),
    )
    // Wall-clock gap, not event sync: the plausibility join keeps every
    // edge verdict with recordedAt >= the next plan-reviewer dispatch
    // timestamp, so the round-1 BLOCK above must be strictly older than
    // the round-2 dispatch below or it re-enters that round's pool and
    // contradicts the APPROVE (no attribution, gate stays red).
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
    // Wall-clock buffer: keep the verdicts streamed below strictly after
    // the dispatch timestamp above, so the round scoping the test documents
    // stays explicit rather than same-millisecond.
    await settle()
    h.pushEvent({
      type: "session.created",
      data: { sessionID: "c2", parentID: "p1", agent: "plan-reviewer" },
    })
    await h.pushEvent({
      type: "session.text.ended",
      data: { sessionID: "c2", text: `${APPROVE}\n` },
    })
    await waitUntil(() =>
      journalEntries(metricsDir).some((e) => e.type === "verdict" && e.raw === "c2"),
    )
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
    await h.pushEvent({
      type: "session.created",
      data: { sessionID: "c1", parentID: "p1", agent: "plan-reviewer" },
    })
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
    await h.pushEvent({
      type: "session.created",
      data: { sessionID: "c1", parentID: "p1", agent: "plan-reviewer" },
    })
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
    assert.equal(createLedger(replayJournal, 64, 2000).peek("p1"), undefined)
  } finally {
    restore()
  }
})

/**
 * Boots a unit-level gates + ledger pair over a temp project whose plans dir
 * holds the given `name → body` plan files, so the active-plan resolution,
 * binding, and staleness helpers are exercisable without a host.
 * @param planFiles The plan file names and bodies to seed.
 * @returns The project root, the absolute plans dir, the gates, the ledger,
 *     and the metrics dir (for journal assertions).
 */
function bootUnitPlans(planFiles: Record<string, string>): {
  project: string
  plansDir: string
  gates: Gates
  ledger: GateLedger
  metricsDir: string
} {
  const project = tmpDir()
  const plansDir = path.join(project, ".opencode", "plans")
  fs.mkdirSync(plansDir, { recursive: true })
  for (const [name, body] of Object.entries(planFiles)) {
    fs.writeFileSync(path.join(plansDir, name), body)
  }
  const metricsDir = tmpDir()
  const journaler = createJournaler({
    metricsDir,
    trace: false,
    maxBytes: 5 * 1024 * 1024,
    maxGenerations: 5,
    rotateEveryEntries: 512,
  })
  const gates = createGates({ ...defaultConfig(process.env), metricsDir }, journaler)
  const ledger = createLedger(path.join(metricsDir, "state.jsonl"), 64, 2000)
  return { project, plansDir, gates, ledger, metricsDir }
}

/** The two-plan seed used by the multi-plan unit tests (both decomposed). */
const DECOY_BODY = "# A\nalpha body\n## Decomposition\n\n- chunk-1\n"
const WORK_BODY = "# Z\nzeta body\n## Decomposition\n\n- chunk-1\n"

/**
 * promptPlanNames extracts the basenames of the *.md tokens a prompt mentions
 * (non-.md tokens ignored, a path yields its basename), and caps the result at
 * the last five mentions; planApprovalBinding binds exactly one distinct
 * existing candidate and fails open to undefined on zero, ambiguous, absent,
 * or unreadable dirs (the last journaling the error).
 */
test("promptPlanNames and planApprovalBinding resolve the dispatch's plan candidates", () => {
  const { project, plansDir, gates, metricsDir } = bootUnitPlans({
    "a-decoy.md": DECOY_BODY,
    "z-work.md": WORK_BODY,
  })
  // No .md token → none; a path yields its basename; non-.md tokens are inert.
  assert.deepEqual(gates.promptPlanNames("nothing to see here"), [])
  assert.deepEqual(
    gates.promptPlanNames(
      `review ${path.join(plansDir, "z-work.md")} then notes.md, skip plan.txt`,
    ),
    ["z-work.md", "notes.md"],
  )
  // A pathological prompt is capped at the last five mentions.
  const many = Array.from({ length: 7 }, (_, i) => `plan-${i}.md`).join(" ")
  assert.deepEqual(gates.promptPlanNames(many), [
    "plan-2.md",
    "plan-3.md",
    "plan-4.md",
    "plan-5.md",
    "plan-6.md",
  ])
  // A unique existing candidate binds with that file's content key.
  const bound = gates.planApprovalBinding(project, ["z-work.md"])
  assert.equal(bound?.name, "z-work.md")
  assert.match(bound?.key ?? "", /^[0-9a-f]{64}$/)
  // Duplicate mentions of one plan are still unique.
  assert.equal(gates.planApprovalBinding(project, ["z-work.md", "z-work.md"])?.name, "z-work.md")
  // Zero existing candidates → unbound.
  assert.equal(gates.planApprovalBinding(project, ["ghost.md"]), undefined)
  // Two distinct existing candidates → ambiguous → unbound.
  assert.equal(gates.planApprovalBinding(project, ["a-decoy.md", "z-work.md"]), undefined)
  // Absent dir → unbound, no journal entry.
  assert.equal(gates.planApprovalBinding(path.join(project, "elsewhere"), ["z-work.md"]), undefined)
  assert.equal(journalEntries(metricsDir).length, 0)
  // Unreadable dir → unbound + a journaled error (skipped as root).
  if (process.getuid?.() === 0) return
  fs.chmodSync(plansDir, 0o000)
  try {
    assert.equal(gates.planApprovalBinding(project, ["z-work.md"]), undefined)
  } finally {
    fs.chmodSync(plansDir, 0o755)
  }
  assert.ok(
    journalEntries(metricsDir).some(
      (e) => e.type === "error" && String(e.error).includes("plans dir unreadable"),
    ),
  )
})

/**
 * The red plan-gate summary names the first blocker: the prompt-referenced
 * existing plans in prompt order, else the session's bound plan when it still
 * exists, else the first sorted pending plan (the legacy fallback). A prompt
 * naming two pending plans blocks on both, previewing the first mentioned.
 */
test("plan preview names the bound or named plan, falling back to first sorted", () => {
  const { project, plansDir, gates, ledger } = bootUnitPlans({
    "a-decoy.md": "# A\nalpha body\n",
    "z-work.md": "# Z\nzeta body\n",
  })
  // No binding, no prompt → the first sorted plan (the legacy preview).
  assert.deepEqual(gates.planSummary(project), { file: "a-decoy.md", head: "alpha body" })
  const unbound = gates.planGateStatus(project, ledger, "p-unbound")
  assert.equal(unbound.red, true)
  assert.equal(unbound.summary?.file, "a-decoy.md")
  // An explicit active name previews that plan.
  assert.deepEqual(gates.planSummary(project, "z-work.md"), {
    file: "z-work.md",
    head: "zeta body",
  })
  // A session bound to z-work.md previews it even though a-decoy.md sorts first.
  ledger.state("p-bound").approvedPlan = "z-work.md"
  const bound = gates.planGateStatus(project, ledger, "p-bound")
  assert.equal(bound.red, true)
  assert.equal(bound.summary?.file, "z-work.md")
  // A prompt naming one existing plan beats the session binding.
  ledger.state("p-named").approvedPlan = "a-decoy.md"
  const named = gates.planGateStatus(
    project,
    ledger,
    "p-named",
    `implement ${path.join(plansDir, "z-work.md")}`,
  )
  assert.equal(named.red, true)
  assert.equal(named.summary?.file, "z-work.md")
  // A prompt naming two existing pending plans: both block, the preview
  // takes the first mentioned (prompt order).
  const ambiguous = gates.planGateStatus(
    project,
    ledger,
    "p-named",
    "compare a-decoy.md with z-work.md",
  )
  assert.equal(ambiguous.red, true)
  assert.equal(ambiguous.summary?.file, "a-decoy.md")
  // A bound plan that is missing from the dir resolves nothing → first sorted.
  ledger.state("p-ghost").approvedPlan = "ghost.md"
  const ghost = gates.planGateStatus(project, ledger, "p-ghost")
  assert.equal(ghost.red, true)
  assert.equal(ghost.summary?.file, "a-decoy.md")
})

/**
 * A bound approval is checked per plan: adding or editing OTHER plans keeps
 * it green (no STALE), editing the bound plan goes stale (plan-edited, and
 * the red preview still names it), removing it goes stale (plan-missing), and
 * a still-matching bound plan re-stamps idempotently. A bound name with an
 * empty key keeps the dir-signature rule verbatim.
 */
test("bound approval staleness is per-plan (plan-edited / plan-missing)", () => {
  const { project, plansDir, gates, ledger, metricsDir } = bootUnitPlans({
    "a-decoy.md": "# A\n",
    "z-work.md": "# Z\n",
  })
  const keyOf = (name: string): string => gates.planApprovalBinding(project, [name])!.key
  const workPath = path.join(plansDir, "z-work.md")
  const decoyPath = path.join(plansDir, "a-decoy.md")
  const staleCount = (): number =>
    journalEntries(metricsDir).filter((l) => l.result === "STALE").length
  // Changes to the other plan (and a new plan) keep the bound approval green.
  const s1 = ledger.state("b1")
  s1.hasPlanVerdict = true
  s1.approvedPlan = "z-work.md"
  s1.approvedPlanKey = keyOf("z-work.md")
  s1.plansSignature = gates.plansSignature(project) ?? ""
  fs.appendFileSync(decoyPath, "decoy edit\n")
  fs.writeFileSync(path.join(plansDir, "m-extra.md"), "# M\n")
  const g1 = gates.planGateStatus(project, ledger, "b1")
  assert.equal(g1.red, false)
  assert.equal(staleCount(), 0)
  // Editing the bound plan goes stale (plan-edited); the red preview names it.
  fs.appendFileSync(workPath, "edit\n")
  const g2 = gates.planGateStatus(project, ledger, "b1")
  assert.equal(g2.red, true)
  assert.equal(g2.summary?.file, "z-work.md")
  assert.equal(staleCount(), 1)
  assert.equal(
    journalEntries(metricsDir).filter((l) => l.result === "STALE")[0]!.reason,
    "plan-edited",
  )
  // Removing the bound plan goes stale (plan-missing).
  const s3 = ledger.state("b3")
  s3.hasPlanVerdict = true
  s3.approvedPlan = "z-work.md"
  s3.approvedPlanKey = keyOf("z-work.md")
  fs.rmSync(workPath)
  const g3 = gates.planGateStatus(project, ledger, "b3")
  assert.equal(g3.red, true)
  assert.equal(staleCount(), 2)
  assert.equal(
    journalEntries(metricsDir).filter((l) => l.result === "STALE")[1]!.reason,
    "plan-missing",
  )
  // A still-matching bound plan re-stamps idempotently (green, no STALE).
  fs.writeFileSync(workPath, "# Z restored\n")
  const s4 = ledger.state("b4")
  s4.hasPlanVerdict = true
  s4.approvedPlan = "z-work.md"
  s4.approvedPlanKey = keyOf("z-work.md")
  const g4 = gates.planGateStatus(project, ledger, "b4")
  assert.equal(g4.red, false)
  assert.equal(s4.plansSignature, gates.plansSignature(project))
  assert.equal(staleCount(), 2)
  // A bound name with an empty key keeps the dir-signature rule verbatim.
  const s5 = ledger.state("b5")
  s5.hasPlanVerdict = true
  s5.approvedPlan = "z-work.md"
  s5.approvedPlanKey = ""
  s5.plansSignature = gates.plansSignature(project) ?? ""
  fs.writeFileSync(workPath, "# Z v2\n")
  const g5 = gates.planGateStatus(project, ledger, "b5")
  assert.equal(g5.red, true)
  assert.equal(staleCount(), 3)
  assert.equal(
    journalEntries(metricsDir).filter((l) => l.result === "STALE")[2]!.reason,
    "signature-mismatch",
  )
})

/**
 * A dispatch naming a plan that holds a durable approval is exempt from the
 * plan gate even while an unrelated plan stays pending; naming nothing still
 * blocks, naming only the pending plan.
 */
test("plan gate: naming a durably-approved plan is exempt from an unrelated stale plan", () => {
  const { project, gates, ledger } = bootUnitPlans({
    "aaa-stale.md": "# A\n",
    "zzz-current.md": "# Z\n",
  })
  ledger.recordPlanApprovalDurable(
    "zzz-current.md",
    gates.planApprovalBinding(project, ["zzz-current.md"])!.key,
    project,
  )
  assert.deepEqual(gates.planGateStatus(project, ledger, "p1", "implement zzz-current.md"), {
    red: false,
  })
  const unnamed = gates.planGateStatus(project, ledger, "p1")
  assert.equal(unnamed.red, true)
  assert.deepEqual(unnamed.blockers, ["aaa-stale.md"])
  assert.equal(unnamed.summary.file, "aaa-stale.md")
})

/**
 * Nothing resolvable (no prompt, no binding) with two pending plans: the
 * status lists both in sorted scan order and the enforcing dispatch blocks
 * with the two-name phrase, journaling the first as the named plan.
 */
test("plan gate: nothing resolvable lists every pending plan and journals the first", () => {
  const { project, gates, ledger, metricsDir } = bootUnitPlans({
    "aaa-stale.md": "# A\n",
    "zzz-current.md": "# Z\n",
  })
  const status = gates.planGateStatus(project, ledger, "p1")
  assert.equal(status.red, true)
  assert.deepEqual(status.blockers, ["aaa-stale.md", "zzz-current.md"])
  assert.equal(status.summary.file, "aaa-stale.md")
  assert.throws(
    () => gates.enforcePlanApproval("p1", project, ledger),
    /no plan approval for "aaa-stale\.md" or "zzz-current\.md"/,
  )
  const blocked = journalEntries(metricsDir).filter((e) => e.type === "blocked")
  assert.equal(blocked.length, 1)
  assert.equal(blocked[0]!.plan, "aaa-stale.md")
})

/**
 * The session-bound fallback: a session bound to a durably-covered plan is
 * exempt from an unrelated pending plan; bound to a pending plan (no durable
 * record) it blocks naming the bound plan.
 */
test("plan gate: the session-bound plan resolves the gate when the prompt names nothing", () => {
  const { project, gates, ledger } = bootUnitPlans({
    "aaa-stale.md": "# A\n",
    "zzz-current.md": "# Z\n",
  })
  // Bound to a pending plan (no durable record): the bound plan is the blocker.
  ledger.state("p-bound").approvedPlan = "zzz-current.md"
  const pending = gates.planGateStatus(project, ledger, "p-bound")
  assert.equal(pending.red, true)
  assert.deepEqual(pending.blockers, ["zzz-current.md"])
  assert.equal(pending.summary.file, "zzz-current.md")
  // The same binding is exempt once the bound plan is durably covered.
  ledger.recordPlanApprovalDurable(
    "zzz-current.md",
    gates.planApprovalBinding(project, ["zzz-current.md"])!.key,
    project,
  )
  assert.deepEqual(gates.planGateStatus(project, ledger, "p-bound"), { red: false })
})

/**
 * A prompt naming both a pending plan and a durably-approved one blocks on
 * the pending one only: an approved referenced plan never blocks.
 */
test("plan gate: a mixed reference blocks only the pending referenced plan", () => {
  const { project, gates, ledger } = bootUnitPlans({
    "aaa-stale.md": "# A\n",
    "zzz-current.md": "# Z\n",
  })
  ledger.recordPlanApprovalDurable(
    "zzz-current.md",
    gates.planApprovalBinding(project, ["zzz-current.md"])!.key,
    project,
  )
  const mixed = gates.planGateStatus(
    project,
    ledger,
    "p1",
    "compare aaa-stale.md with zzz-current.md",
  )
  assert.equal(mixed.red, true)
  assert.deepEqual(mixed.blockers, ["aaa-stale.md"])
  assert.equal(mixed.summary.file, "aaa-stale.md")
})

/**
 * The permission-ask arm: a no-prompt status with one pending plan carries
 * the full red shape — the file + head preview paired with its single-blocker
 * list.
 */
test("plan gate: the no-prompt red shape pairs the preview with its single blocker", () => {
  const { project, gates, ledger } = bootUnitPlans({ "aaa-stale.md": "# A\nalpha body\n" })
  assert.deepEqual(gates.planGateStatus(project, ledger, "p1"), {
    red: true,
    summary: { file: "aaa-stale.md", head: "alpha body" },
    blockers: ["aaa-stale.md"],
  })
})

/**
 * Three pending plans with nothing resolvable: the block message enumerates
 * all three as an Oxford list.
 */
test("plan gate: three pending plans enumerate as an Oxford list", () => {
  const { project, gates, ledger } = bootUnitPlans({
    "aaa-stale.md": "# A\n",
    "m-mid.md": "# M\n",
    "zzz-current.md": "# Z\n",
  })
  assert.throws(
    () => gates.enforcePlanApproval("p1", project, ledger),
    /no plan approval for "aaa-stale\.md", "m-mid\.md", or "zzz-current\.md"/,
  )
})

/**
 * The decomposition gate keeps its resolved-plan semantics after the
 * plan-gate resolution change: an ambiguous prompt (two plans, one
 * decomposed) with no chunk cite blocks via the fallback naming the
 * decomposed plan, a session bound to a missing plan falls through to the
 * same fallback, and a uniquely named decomposed plan blocks until cited.
 */
test("decomposition: ambiguous and bound-missing prompts fall back to the pending decomposed plan", () => {
  const { project, gates, ledger } = bootUnitPlans({
    "a-decoy.md": DECOY_BODY,
    "z-work.md": "# Z\nplain body\n",
  })
  // Ambiguous: two plans named, one decomposed, no cite → the fallback names
  // the decomposed one.
  assert.throws(
    () => gates.enforceDecomposition("p1", "compare a-decoy.md with z-work.md", project, ledger),
    /plan "a-decoy\.md" has a ## Decomposition block/,
  )
  // Bound to a missing plan: the binding resolves nothing → the same fallback.
  ledger.state("p2").approvedPlan = "ghost.md"
  assert.throws(
    () => gates.enforceDecomposition("p2", "do the work", project, ledger),
    /plan "a-decoy\.md" has a ## Decomposition block/,
  )
  // Uniquely named decomposed plan: blocked until the prompt cites a chunk.
  assert.throws(
    () => gates.enforceDecomposition("p3", "work on a-decoy.md", project, ledger),
    /plan "a-decoy\.md" has a ## Decomposition block/,
  )
  gates.enforceDecomposition("p3", "work on a-decoy.md chunk-1", project, ledger)
})

/**
 * With a ledger, enforceDecomposition enforces the resolved plan: the session
 * bound plan or the prompt-named plan carries its own decomposition
 * requirement (a bound non-decomposed plan allows the dispatch even when
 * another decomposed plan sorts first); without a ledger the legacy
 * first-sorted decomposed rule applies, and a chunk citation always passes.
 */
test("enforceDecomposition enforces the resolved plan when a ledger is given", () => {
  const { project, plansDir, gates, ledger } = bootUnitPlans({
    "a-decoy.md": DECOY_BODY,
    "z-work.md": WORK_BODY,
  })
  // Session bound to z-work.md: the block names z-work.md, not a-decoy.md.
  ledger.state("d1").approvedPlan = "z-work.md"
  assert.throws(
    () => gates.enforceDecomposition("d1", "do the work", project, ledger),
    /plan "z-work\.md" has a ## Decomposition block/,
  )
  // A prompt naming a-decoy.md beats the session binding.
  assert.throws(
    () => gates.enforceDecomposition("d1", "work on a-decoy.md now", project, ledger),
    /plan "a-decoy\.md" has a ## Decomposition block/,
  )
  // A bound plan without a decomposition allows the dispatch (the decoy's
  // decomposition no longer binds this session).
  fs.writeFileSync(path.join(plansDir, "z-work.md"), "# Z\nno decomposition here\n")
  gates.enforceDecomposition("d1", "do the work", project, ledger)
  // A chunk citation passes regardless of the resolved plan.
  gates.enforceDecomposition("d1", "do the work in chunk-1", project, ledger)
  // Without a ledger: the legacy first-sorted decomposed rule.
  assert.throws(
    () => gates.enforceDecomposition("d2", "do the work", project),
    /plan "a-decoy\.md" has a ## Decomposition block/,
  )
})

/**
 * Boots in a temp project dir containing the given `name → body` plan files
 * (multi-plan variant of bootWithPlan).
 * @param plans The plan file names and bodies to seed.
 * @param config Overrides spread over the per-test metrics directory; an
 *     `approvalLedgerPath` key is lifted to the factory's top-level option.
 * @returns The fake host, the dispose callback, the metrics directory, the
 *     project root, and a `restore` that disposes and returns the cwd.
 */
async function bootWithPlans(
  plans: Record<string, string>,
  config: Record<string, any> = {},
): Promise<{
  h: FakeHost
  dispose: () => void
  metricsDir: string
  project: string
  restore: () => void
}> {
  const project = tmpDir()
  fs.mkdirSync(path.join(project, ".opencode", "plans"), { recursive: true })
  for (const [name, body] of Object.entries(plans)) {
    fs.writeFileSync(path.join(project, ".opencode", "plans", name), body)
  }
  const metricsDir = tmpDir()
  const h = makeFakeHost()
  const prev = process.cwd()
  process.chdir(project)
  const { approvalLedgerPath, ...configOverrides } = config
  const setup = turnstile(h.host, {
    env: isolatedEnv(metricsDir),
    config: { metricsDir, ...configOverrides },
    approvalLedgerPath,
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
 * Runs one plan-review round: dispatches the plan-reviewer (so the dispatch
 * prompt is the approval's binding candidates) and delivers the verdict on a
 * fresh edge-registered child.
 * @param h The fake host.
 * @param parent The parent session ID the approval attributes to.
 * @param child The child session ID the verdict is delivered on.
 * @param prompt The dispatch prompt (plan mentions become binding candidates).
 * @param verdict The verdict marker line to deliver.
 */
async function reviewRound(
  h: FakeHost,
  parent: string,
  child: string,
  prompt: string,
  verdict: string,
): Promise<void> {
  await callTool(h, "execute.before", {
    tool: "task",
    sessionID: parent,
    input: { agent: "plan-reviewer", prompt },
  })
  await h.pushEvent({
    type: "session.created",
    data: { sessionID: child, parentID: parent, agent: "plan-reviewer" },
  })
  await callTool(h, "execute.after", {
    tool: "task",
    sessionID: child,
    input: { agent: "plan-reviewer" },
    result: { output: `${verdict}\n` },
  })
}

/** Fires an executor dispatch on `parent` with the given prompt. */
async function execDispatch(h: FakeHost, parent: string, prompt: string): Promise<void> {
  await callTool(h, "execute.before", {
    tool: "task",
    sessionID: parent,
    input: { agent: "executor", prompt },
  })
}

/**
 * With two decomposed plans (a-decoy.md sorts first), a dispatch bound to
 * z-work.md enforces against z-work.md: a named dispatch without a chunk cite
 * is blocked naming z-work.md, the same dispatch with a chunk cite passes, an
 * unnamed dispatch enforces the session binding (never the first sorted
 * plan), and a dispatch naming the decoy is blocked naming the decoy.
 */
test("multi-plan: executor dispatch enforces the named or bound plan, never the first sorted", async () => {
  const { h, restore, project } = await bootWithPlans({
    "a-decoy.md": DECOY_BODY,
    "z-work.md": WORK_BODY,
  })
  try {
    const plansDir = path.join(project, ".opencode", "plans")
    await reviewRound(h, "p1", "c1", `review ${path.join(plansDir, "z-work.md")}`, APPROVE)
    // Named dispatch without a chunk cite → blocked naming z-work.md.
    await assert.rejects(
      () => execDispatch(h, "p1", `implement ${path.join(plansDir, "z-work.md")}`),
      /plan "z-work\.md" has a ## Decomposition block/,
    )
    // The same dispatch with a chunk cite passes.
    await execDispatch(h, "p1", `implement ${path.join(plansDir, "z-work.md")} chunk-1`)
    // Unnamed dispatch → the session binding, never the first sorted plan.
    await assert.rejects(
      () => execDispatch(h, "p1", "do the work"),
      (e: Error) =>
        e.message ===
        'BLOCKED by turnstile: plan "z-work.md" has a ## Decomposition block — executor dispatches must cite the chunk-N / AC-n they implement.',
    )
    // A dispatch naming the decoy → blocked naming a-decoy.md.
    await assert.rejects(
      () => execDispatch(h, "p1", "work on a-decoy.md"),
      /plan "a-decoy\.md" has a ## Decomposition block/,
    )
  } finally {
    restore()
  }
})

/**
 * A bound approval on z-work.md survives changes to OTHER plans (add, edit,
 * delete — no STALE journaled, dispatch stays green), but the bound plan's
 * own edit goes stale (plan-edited) and its rename goes stale (plan-missing),
 * each blocking the next dispatch.
 */
test("multi-plan: other-plan changes never invalidate a bound approval; the bound plan's own edit or rename does", async () => {
  const { h, restore, project, metricsDir } = await bootWithPlans({
    "a-decoy.md": "# A\n## Decomposition\n\n- chunk-1\n",
    "z-work.md": "# Z\nplain plan body\n",
  })
  try {
    const plansDir = path.join(project, ".opencode", "plans")
    const workPath = path.join(plansDir, "z-work.md")
    const decoyPath = path.join(plansDir, "a-decoy.md")
    await reviewRound(h, "p1", "c1", `review ${workPath}`, APPROVE)
    // Baseline: the dispatch is allowed (the bound plan is non-decomposed).
    await execDispatch(h, "p1", "do the work")
    // Add a plan, edit the decoy, delete the decoy → stays allowed, no STALE.
    fs.writeFileSync(path.join(plansDir, "m-extra.md"), "# M\n")
    fs.appendFileSync(decoyPath, "decoy edit\n")
    fs.rmSync(decoyPath)
    await execDispatch(h, "p1", "do the work")
    assert.equal(journalEntries(metricsDir).filter((l) => l.result === "STALE").length, 0)
    // Edit the bound plan → the next dispatch blocks + journals plan-edited.
    fs.appendFileSync(workPath, "edit\n")
    await assert.rejects(
      () => execDispatch(h, "p1", "do the work"),
      /no plan approval for "z-work\.md"/,
    )
    let stale = journalEntries(metricsDir).filter((l) => l.result === "STALE")
    assert.equal(stale.length, 1)
    assert.equal(stale[0]!.reason, "plan-edited")
    // Re-approve (a new round naming z-work.md), then rename the plan → the
    // next dispatch journals plan-missing.
    await reviewRound(h, "p1", "c2", `review ${workPath}`, APPROVE)
    fs.renameSync(workPath, path.join(plansDir, "z-renamed.md"))
    await assert.rejects(() => execDispatch(h, "p1", "do the work"), /no plan approval for/)
    stale = journalEntries(metricsDir).filter((l) => l.result === "STALE")
    assert.equal(stale.length, 2)
    assert.equal(stale[1]!.reason, "plan-missing")
  } finally {
    restore()
  }
})

/**
 * A later review round whose dispatch names a-decoy.md re-binds the session:
 * the z-work.md approval is gone, so the same unnamed dispatch that was
 * blocked on z-work.md's decomposition is now allowed (a-decoy.md is the
 * non-decomposed bound plan), and the two journaled APPROVE entries carry the
 * distinct plan identities.
 */
test("multi-plan: a later review round naming another plan rebinds the session", async () => {
  const { h, restore, project, metricsDir } = await bootWithPlans({
    "a-decoy.md": "# A\nplain decoy body\n",
    "z-work.md": "# Z\n## Decomposition\n\n- chunk-1\n",
  })
  try {
    const plansDir = path.join(project, ".opencode", "plans")
    // Round 1: bound to z-work.md → the unnamed dispatch blocks on it.
    await reviewRound(h, "p1", "c1", `review ${path.join(plansDir, "z-work.md")}`, APPROVE)
    await assert.rejects(
      () => execDispatch(h, "p1", "do the work"),
      /plan "z-work\.md" has a ## Decomposition block/,
    )
    // Round 2: a re-review naming a-decoy.md re-binds the session → the same
    // dispatch is now allowed.
    await reviewRound(h, "p1", "c2", `review ${path.join(plansDir, "a-decoy.md")}`, APPROVE)
    await execDispatch(h, "p1", "do the work")
    // The journal shows the rebind: the APPROVE entries carry distinct plans.
    const plans = journalEntries(metricsDir)
      .filter((l) => l.type === "plan" && l.result === "APPROVE")
      .map((l) => l.plan)
    assert.ok(plans.includes("z-work.md"), "the first approval bound z-work.md")
    assert.ok(plans.includes("a-decoy.md"), "the later approval re-bound a-decoy.md")
  } finally {
    restore()
  }
})

/**
 * A red plan gate with a bound-but-edited plan escalates to a human ask that
 * names the session's plan (z-work.md), not the alphabetically-first plan.
 */
test("multi-plan: the plan-gate ask names the session's bound plan, not the first sorted", async () => {
  const { h, restore, project, metricsDir } = await bootWithPlans({
    "a-decoy.md": "# A\ndecoy body line.\n",
    "z-work.md": "# Z\nwork body line.\n",
  })
  try {
    const workPath = path.join(project, ".opencode", "plans", "z-work.md")
    await reviewRound(h, "p1", "c1", `review ${workPath}`, APPROVE)
    // Edit the bound plan: the approval goes stale and the gate is red.
    fs.appendFileSync(workPath, "edit\n")
    const event: Record<string, any> = { sessionID: "p1", action: "task" }
    await callPermission(h, "evaluate", event)
    // The ask names z-work.md and its body, never a-decoy.md.
    assert.equal(event.effect, "ask")
    assert.match(event.message, /^turnstile: plan approval required — z-work\.md: work body line\./)
    assert.doesNotMatch(event.message, /a-decoy\.md/)
    const ask = journalEntries(metricsDir).find(
      (l) => l.type === "permission" && l.action === "ask",
    )
    assert.equal(ask?.plan, "z-work.md")
  } finally {
    restore()
  }
})

/**
 * A fielded plan APPROVE in the journal restores the bound identity across a
 * restart: the first executor dispatch naming z-work.md without a chunk cite
 * is blocked naming z-work.md. A field-less (legacy) APPROVE restores
 * unbound: the dir-signature rule applies, so adding a plan invalidates the
 * accepted-once approval.
 */
test("multi-plan: journal replay restores the bound identity; a legacy line restores unbound", async () => {
  // Fielded APPROVE: the bound identity is honored across the restart.
  const project = tmpDir()
  const plansDir = path.join(project, ".opencode", "plans")
  fs.mkdirSync(plansDir, { recursive: true })
  fs.writeFileSync(path.join(plansDir, "a-decoy.md"), "# A\nplain\n")
  const workPath = path.join(plansDir, "z-work.md")
  fs.writeFileSync(workPath, "# Z\n## Decomposition\n\n- chunk-1\n")
  const planKey = createHash("sha256").update(fs.readFileSync(workPath)).digest("hex")
  const metricsDir = tmpDir()
  fs.writeFileSync(
    path.join(metricsDir, "turnstile.jsonl"),
    JSON.stringify({
      ts: "t",
      type: "plan",
      sessionID: "p1",
      result: "APPROVE",
      plan: "z-work.md",
      planKey,
    }) + "\n",
  )
  const h = makeFakeHost()
  const prev = process.cwd()
  process.chdir(project)
  try {
    const setup = turnstile(h.host, { env: isolatedEnv(metricsDir), config: { metricsDir } })
    const dispose = (await setup(h.host)) as () => void
    await assert.rejects(
      () => execDispatch(h, "p1", `implement ${workPath}`),
      /plan "z-work\.md" has a ## Decomposition block/,
    )
    dispose()
  } finally {
    process.chdir(prev)
  }
  // Legacy field-less APPROVE: unbound, so the dir-signature rule applies.
  const project2 = tmpDir()
  const plansDir2 = path.join(project2, ".opencode", "plans")
  fs.mkdirSync(plansDir2, { recursive: true })
  fs.writeFileSync(path.join(plansDir2, "z-work.md"), "# Z\nplain\n")
  const metricsDir2 = tmpDir()
  fs.writeFileSync(
    path.join(metricsDir2, "turnstile.jsonl"),
    JSON.stringify({ ts: "t", type: "plan", sessionID: "p1", result: "APPROVE" }) + "\n",
  )
  const h2 = makeFakeHost()
  process.chdir(project2)
  try {
    const setup2 = turnstile(h2.host, {
      env: isolatedEnv(metricsDir2),
      config: { metricsDir: metricsDir2 },
    })
    const dispose2 = (await setup2(h2.host)) as () => void
    // The replayed unbound approval is accepted once and stamped…
    await execDispatch(h2, "p1", "do the work")
    // …and adding a plan (the dir signature changes) invalidates it.
    fs.writeFileSync(path.join(plansDir2, "m-extra.md"), "# M\n")
    await assert.rejects(() => execDispatch(h2, "p1", "do the work"), /no plan approval for/)
    dispose2()
  } finally {
    process.chdir(prev)
  }
})

/**
 * A self-keyed APPROVE delivery (the parent's own session id, marker-less
 * output) attributes through the round's edge child and binds the plan
 * identity from the round's dispatch prompt: the journaled plan entry carries
 * the plan name + content key, and the session's enforcement follows the
 * bound plan.
 */
test("multi-plan: a self-keyed round APPROVE binds the plan identity from the dispatch prompt", async () => {
  const { h, restore, project, metricsDir } = await bootWithPlans({
    "a-decoy.md": "# A\nplain decoy body\n",
    "z-work.md": "# Z\n## Decomposition\n\n- chunk-1\n",
  })
  try {
    const plansDir = path.join(project, ".opencode", "plans")
    // The round's dispatch names z-work.md (the binding candidates).
    await callTool(h, "execute.before", {
      tool: "task",
      sessionID: "p1",
      input: { agent: "plan-reviewer", prompt: `review ${path.join(plansDir, "z-work.md")}` },
    })
    // The edge child streams the APPROVE; the self-keyed delivery (the
    // parent's own session id, marker-less output) attributes through it.
    await h.pushEvent({
      type: "session.created",
      data: { sessionID: "c1", parentID: "p1", agent: "plan-reviewer" },
    })
    await h.pushEvent({
      type: "session.text.ended",
      data: { sessionID: "c1", text: `${APPROVE}\n` },
    })
    await waitUntil(() =>
      journalEntries(metricsDir).some((e) => e.type === "verdict" && e.raw === "c1"),
    )
    await callTool(h, "execute.after", {
      tool: "task",
      sessionID: "p1",
      input: { agent: "plan-reviewer" },
      result: { output: "Task finished." },
    })
    // The journaled plan entry carries the bound identity.
    const entry = journalEntries(metricsDir).find(
      (l) => l.type === "plan" && l.result === "APPROVE" && l.raw === "c1",
    )
    assert.ok(entry, "the self-keyed delivery journaled an APPROVE for the edge child")
    assert.equal(entry?.plan, "z-work.md")
    assert.match(String(entry?.planKey ?? ""), /^[0-9a-f]{64}$/)
    // The session is bound: the unnamed dispatch enforces z-work.md.
    await assert.rejects(
      () => execDispatch(h, "p1", "do the work"),
      /plan "z-work\.md" has a ## Decomposition block/,
    )
  } finally {
    restore()
  }
})

/**
 * A plan-gate-blocked executor dispatch draws down no budget: three blocked
 * attempts under a budget of 2 keep the budget at zero, so every refusal
 * names the missing plan approval (never the exhausted budget) and journals
 * its dispatch entry stamped blocked. The once-grant release is a real
 * admission: it passes the budget guard, is metered there like any other
 * dispatch, and leaves a fourth dispatch entry.
 */
test("plan-gate-blocked executor dispatches draw down no budget; the grant-released dispatch still passes", async () => {
  const { h, metricsDir, restore } = await bootWithPlan("# P\n", "plan.md", {
    maxTotalDispatches: 2,
  })
  try {
    for (let i = 0; i < 3; i++) {
      await assert.rejects(
        () => execDispatch(h, "p1", "do the work"),
        /no plan approval for "plan\.md"/,
      )
    }
    const execs = journalEntries(metricsDir).filter(
      (l) => l.type === "dispatch" && l.agent === "executor",
    )
    assert.equal(execs.length, 3, "each blocked attempt journaled its dispatch entry")
    assert.ok(
      execs.every((l) => l.blocked === true),
      "every blocked attempt carries the blocked stamp",
    )
    assert.ok(
      !journalEntries(metricsDir).some((l) => l.reason === "dispatch-budget"),
      "no budget entry: the blocked attempts drew down nothing",
    )
    // Escalate, then answer the ask with a single-dispatch grant.
    await callPermission(h, "evaluate", { sessionID: "p1", action: "task" })
    h.pushEvent({ type: "permission.asked", properties: { sessionID: "p1", id: "req-1" } })
    h.pushEvent({
      type: "permission.replied",
      properties: { sessionID: "p1", requestID: "req-1", reply: "once" },
    })
    await waitUntil(() =>
      journalEntries(metricsDir).some((l) => l.type === "permission" && l.decision === "once"),
    )
    // The grant-released dispatch is admitted — and metered — like any other.
    await execDispatch(h, "p1", "do the work")
    const after = journalEntries(metricsDir).filter(
      (l) => l.type === "dispatch" && l.agent === "executor",
    )
    assert.equal(after.length, 4, "the grant-released dispatch journaled its entry")
  } finally {
    restore()
  }
})

/**
 * Boots a second fake-host process over the same project and metrics dir
 * (a restart): chdirs to the project, sets up the plugin with the same
 * config, and disposes + restores the cwd when done.
 * @param metricsDir The shared metrics directory.
 * @param project The project directory to chdir into.
 * @param sidecar The injected approval-ledger path.
 * @returns A function that runs `fn` inside the restarted process.
 */
async function restartOver(
  metricsDir: string,
  project: string,
  sidecar: string,
  fn: (h: FakeHost) => Promise<void>,
): Promise<void> {
  const h = makeFakeHost()
  const prev = process.cwd()
  process.chdir(project)
  try {
    const setup = turnstile(h.host, {
      env: isolatedEnv(metricsDir),
      config: { metricsDir },
      approvalLedgerPath: sidecar,
    })
    const dispose = (await setup(h.host)) as () => void
    await fn(h)
    dispose()
  } finally {
    process.chdir(prev)
  }
}

/**
 * A durable approval outlives the journal replay window: a bound reviewer
 * APPROVE records the plan identity in the sidecar, the journal is then
 * dropped (the replay-aging extreme — no APPROVE line left to restore), and
 * a fresh process still admits an executor dispatch naming the unchanged
 * plan — the exemption is re-derived from the sidecar, not the session
 * bucket.
 */
test("plan gate: a durable approval survives replay aging with an empty journal", async () => {
  const metricsDir = tmpDir()
  const sidecar = path.join(tmpDir(), "approved-plans.jsonl")
  const { h, restore, project } = await bootWithPlan("# P\n", "plan.md", {
    metricsDir,
    approvalLedgerPath: sidecar,
  })
  try {
    await reviewRound(h, "p1", "c1", `review plan.md`, APPROVE)
    assert.ok(fs.existsSync(sidecar), "the bound approval recorded a durable sidecar record")
    assert.ok(
      fs.readFileSync(sidecar, "utf8").includes('"name":"plan.md"'),
      "the sidecar record carries the plan name",
    )
  } finally {
    restore()
  }
  // The journal no longer carries the APPROVE line: replay restores nothing.
  fs.rmSync(path.join(metricsDir, "turnstile.jsonl"), { force: true })
  await restartOver(metricsDir, project, sidecar, async (h2) => {
    await execDispatch(h2, "p1", "implement plan.md")
  })
})

/**
 * A durable approval survives a new-prompt reset: the bound reviewer APPROVE
 * credits the session bucket and records the sidecar, a fresh prompt wipes
 * the bucket (the old behavior left the gate red from there), and the next
 * executor dispatch naming the unchanged plan is still admitted — the
 * exemption is re-derived, not carried through the bucket.
 */
test("plan gate: a durable approval survives a new-prompt reset", async () => {
  const metricsDir = tmpDir()
  const sidecar = path.join(tmpDir(), "approved-plans.jsonl")
  const { h, restore } = await bootWithPlan("# P\n", "plan.md", {
    metricsDir,
    approvalLedgerPath: sidecar,
  })
  try {
    await reviewRound(h, "p1", "c1", `review plan.md`, APPROVE)
    // The fresh prompt wipes the bucket (verdict, binding, stamp).
    await callSession(h, "prompt", { sessionID: "p1", text: "start a new task" })
    // The dispatch names the unchanged plan: the sidecar still covers it.
    await execDispatch(h, "p1", "implement plan.md")
    assert.ok(fs.existsSync(sidecar), "the bound approval recorded a durable sidecar record")
  } finally {
    restore()
  }
})

/**
 * A dispatch whose referenced plan holds a durable approval is admitted even
 * while an unrelated plan stays pending (the end-to-end exemption): naming
 * the approved plan passes, naming the stale plan blocks with the referenced
 * name, naming only a missing plan falls through to the global rule, and
 * naming the stale plan twice emits the byte-identical single-name message.
 */
test("plan gate: a dispatch naming its durably-approved plan is exempt from unrelated stale plans", async () => {
  const metricsDir = tmpDir()
  const sidecar = path.join(tmpDir(), "approved-plans.jsonl")
  const { h, restore } = await bootWithPlans(
    { "aaa-stale.md": "# A\n", "zzz-current.md": "# Z\n" },
    { metricsDir, approvalLedgerPath: sidecar },
  )
  try {
    await reviewRound(h, "p1", "c1", "review zzz-current.md", APPROVE)
    // A fresh prompt wipes the bucket; the sidecar still covers zzz-current.
    await callSession(h, "prompt", { sessionID: "p1", text: "start a new task" })
    // Naming the approved plan: admitted even though aaa-stale stays pending.
    await execDispatch(h, "p1", "implement zzz-current.md")
    // Naming the stale plan: blocked, naming the referenced plan (never the
    // other plan in the dir).
    await assert.rejects(
      () => execDispatch(h, "p1", "implement aaa-stale.md"),
      (e: Error) =>
        /no plan approval for "aaa-stale\.md"/.test(e.message) &&
        !e.message.includes("zzz-current"),
    )
    // Naming only a missing plan resolves nothing: the global rule names the
    // one pending plan.
    await assert.rejects(
      () => execDispatch(h, "p1", "implement ghost.md"),
      /no plan approval for "aaa-stale\.md"/,
    )
    // Naming the stale plan twice dedupes to the byte-identical single-name
    // message.
    await assert.rejects(
      () => execDispatch(h, "p1", "implement aaa-stale.md for aaa-stale.md"),
      (e: Error) =>
        e.message ===
        `BLOCKED by turnstile: no plan approval for "aaa-stale.md". Dispatch the plan-reviewer subagent first; proceed with executor only after the plan-reviewer's first line is ` +
          "`VERDICT: APPROVE crit=<n> high=<n> med=<n> low=<n>`, or obtain an explicit user waiver " +
          "(a user prompt this task must contain the literal marker 'USER WAIVER:' followed by the user's words).",
    )
  } finally {
    restore()
  }
})

/**
 * Editing the plan invalidates its durable approval: the approval recorded
 * under the original bytes, the journal dropped (replay-aging), and the plan
 * bytes changed while "down" — the fresh process sees a pending plan and
 * blocks the dispatch naming it (the content wall survives durability).
 */
test("plan gate: an edited plan is pending despite its durable record", async () => {
  const metricsDir = tmpDir()
  const sidecar = path.join(tmpDir(), "approved-plans.jsonl")
  const { h, restore, project } = await bootWithPlan("# P\n", "plan.md", {
    metricsDir,
    approvalLedgerPath: sidecar,
  })
  try {
    await reviewRound(h, "p1", "c1", `review plan.md`, APPROVE)
  } finally {
    restore()
  }
  // The offline edit + the aged-out journal: only the stale record remains.
  fs.writeFileSync(path.join(project, ".opencode", "plans", "plan.md"), "# P revised\n")
  fs.rmSync(path.join(metricsDir, "turnstile.jsonl"), { force: true })
  await restartOver(metricsDir, project, sidecar, async (h2) => {
    await assert.rejects(
      () => execDispatch(h2, "p1", "implement plan.md"),
      /no plan approval for "plan\.md"/,
    )
  })
})

/**
 * A plans dir holding only durably-approved, unchanged plans is not red:
 * after a fresh prompt wipes the bucket, an unnamed executor dispatch is
 * admitted (the pending set is empty via the sidecar). Once a genuinely
 * unapproved plan joins the dir, the unnamed dispatch blocks naming the new
 * plan, a dispatch naming the new plan blocks naming it, and a dispatch
 * naming the landed plan is admitted — its approval is live, so the
 * unrelated stale plan no longer blocks it.
 */
test("plan gate: an all-landed plans dir is green; a new plan blocks naming itself, not the landed one", async () => {
  const metricsDir = tmpDir()
  const sidecar = path.join(tmpDir(), "approved-plans.jsonl")
  const { h, restore, project } = await bootWithPlans(
    { "a-landed.md": "# L\n" },
    {
      metricsDir,
      approvalLedgerPath: sidecar,
    },
  )
  try {
    await reviewRound(h, "p1", "c1", "review a-landed.md", APPROVE)
    // The fresh prompt wipes the bucket; only the sidecar remains.
    await callSession(h, "prompt", { sessionID: "p1", text: "start a new task" })
    // All plans landed: the unnamed dispatch is admitted.
    await execDispatch(h, "p1", "do the work")
    // A genuinely unapproved plan joins: the unnamed dispatch blocks naming it…
    fs.writeFileSync(path.join(project, ".opencode", "plans", "z-fresh.md"), "# F\n")
    await assert.rejects(
      () => execDispatch(h, "p1", "do the work"),
      /no plan approval for "z-fresh\.md"/,
    )
    // …and a dispatch naming the fresh plan blocks naming it…
    await assert.rejects(
      () => execDispatch(h, "p1", "implement z-fresh.md"),
      /no plan approval for "z-fresh\.md"/,
    )
    // …while naming the landed plan admits the dispatch (its approval is live).
    await execDispatch(h, "p1", "implement a-landed.md")
  } finally {
    restore()
  }
})

/**
 * Deleting the approved plan and replacing it with a new plan leaves the
 * new plan pending: the durable record covers a name that no longer exists
 * (it cannot exempt anything), the replacement file carries no approval,
 * and after a restart with the journal aged out the dispatch blocks naming
 * the new plan.
 */
test("plan gate: a deleted-and-replaced plan is pending under its replacement", async () => {
  const metricsDir = tmpDir()
  const sidecar = path.join(tmpDir(), "approved-plans.jsonl")
  const { h, restore, project } = await bootWithPlan("# P\n", "plan.md", {
    metricsDir,
    approvalLedgerPath: sidecar,
  })
  try {
    await reviewRound(h, "p1", "c1", `review plan.md`, APPROVE)
  } finally {
    restore()
  }
  // The offline replace: the approved file is gone, a new plan takes its place.
  const plansDir = path.join(project, ".opencode", "plans")
  fs.rmSync(path.join(plansDir, "plan.md"))
  fs.writeFileSync(path.join(plansDir, "new-plan.md"), "# N\nreplacement body\n")
  fs.rmSync(path.join(metricsDir, "turnstile.jsonl"), { force: true })
  await restartOver(metricsDir, project, sidecar, async (h2) => {
    await assert.rejects(
      () => execDispatch(h2, "p1", "do the work"),
      /no plan approval for "new-plan\.md"/,
    )
  })
})

/**
 * A human `PLAN APPROVED:` prompt approval is not durable: it binds no plan
 * identity, so nothing is recorded in the sidecar, and after a restart with
 * the approval aged out of the journal a plan-named executor dispatch is
 * still blocked — the durability scope is the bound reviewer channel only.
 */
test("plan gate: a human PLAN APPROVED approval is not durable across an aged-out restart", async () => {
  const metricsDir = tmpDir()
  const sidecar = path.join(tmpDir(), "approved-plans.jsonl")
  const { h, restore, project } = await bootWithPlan("# P\n", "plan.md", {
    metricsDir,
    approvalLedgerPath: sidecar,
  })
  try {
    await callSession(h, "prompt", { sessionID: "p1", text: "PLAN APPROVED: looks good" })
    // Admitted via the live stamped bucket (the sidecar plays no part).
    await execDispatch(h, "p1", "do the work")
    assert.ok(!fs.existsSync(sidecar), "the unbound human approval records nothing durable")
  } finally {
    restore()
  }
  // The approval ages out: the journal no longer carries the APPROVE line.
  fs.rmSync(path.join(metricsDir, "turnstile.jsonl"), { force: true })
  await restartOver(metricsDir, project, sidecar, async (h2) => {
    await assert.rejects(
      () => execDispatch(h2, "p1", "implement plan.md"),
      /no plan approval for "plan\.md"/,
    )
  })
})
