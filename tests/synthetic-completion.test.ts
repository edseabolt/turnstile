/**
 * @fileoverview Synthetic subagent-completion tests: a background child's
 * completion arrives on the `session.inbox.enqueued` stream (opencode ≥ 2.0.29)
 * as a synthetic item with `metadata.source === "subagent"` and never passes
 * the foreground task-result hook, so its `VERDICT:` markers must be parsed
 * child-keyed and credited through the child→parent edge — a plan-reviewer's
 * APPROVE credits the plan-approval gate (with a replay-restorable journal
 * entry), a reviewer's APPROVE credits the landing-gate signal only at a
 * complete ensemble, malformed or marker-free items are inert fail-open, and
 * a durable-event replay dedupes to a single credit.
 */

import { test } from "node:test"
import assert from "node:assert/strict"
import * as path from "node:path"

import { turnstile } from "../turnstile.ts"
import { createLedger } from "../src/ledger.ts"
import type { FakeHost } from "./helpers.ts"
import { isolatedEnv, journalEntries, makeFakeHost, tmpDir } from "./helpers.ts"

/** A canonical plan-reviewer verdict marker matching the default regex. */
const APPROVE = "VERDICT: APPROVE crit=0 high=0 med=0 low=0"

/** A synthetic subagent-completion inbox item for the given child and text. */
function syntheticItem(
  childID: string,
  text: string,
  agent = "plan-reviewer",
): Record<string, unknown> {
  return {
    type: "synthetic",
    payload: { text, metadata: { source: "subagent", childID, agent } },
  }
}

/**
 * Boots the plugin on a fake host in a temp metrics dir with the process
 * cwd moved to a temp project (the approval's project-dir resolution falls
 * back to cwd when the host carries no directory).
 */
async function boot(): Promise<{
  h: FakeHost
  dispose: () => void
  metricsDir: string
  restoreCwd: () => void
}> {
  const metricsDir = tmpDir()
  const project = tmpDir()
  const prev = process.cwd()
  process.chdir(project)
  const h = makeFakeHost()
  const setup = turnstile(h.host, { env: isolatedEnv(metricsDir), config: { metricsDir } })
  const dispose = (await setup(h.host)) as () => void
  return { h, dispose, metricsDir, restoreCwd: () => process.chdir(prev) }
}

/**
 * Seeds a child→parent edge and its emitter agent via the created event,
 * awaited so the edge lands before the completion event is pushed.
 */
async function seedChildEdge(
  h: FakeHost,
  child: string,
  parent: string,
  agent: string,
): Promise<void> {
  await h.pushEvent({
    type: "session.created",
    data: { sessionID: child, parentID: parent, agent },
  })
}

/** Pushes a synthetic subagent completion onto the inbox stream, awaited. */
async function pushSynthetic(
  h: FakeHost,
  parent: string,
  item: Record<string, unknown>,
  inboxID = "inb-1",
): Promise<void> {
  await h.pushEvent({
    type: "session.inbox.enqueued",
    data: { sessionID: parent, inboxID, item },
  })
}

/** The journal's entries of one type. */
function entriesOf(metricsDir: string, type: string): Array<Record<string, any>> {
  return journalEntries(metricsDir).filter((e) => e.type === type)
}

/** A background plan-reviewer completion credits the plan-approval gate. */
test("synthetic plan-reviewer completion credits the plan gate", async () => {
  const { h, dispose, metricsDir, restoreCwd } = await boot()
  try {
    await seedChildEdge(h, "c1", "p1", "plan-reviewer")
    await pushSynthetic(h, "p1", syntheticItem("c1", APPROVE))
    const plans = entriesOf(metricsDir, "plan")
    assert.equal(plans.length, 1, "exactly one plan entry is journaled")
    const plan = plans[0]!
    assert.equal(plan.sessionID, "p1", "the plan entry keys on the parent")
    assert.equal(plan.raw, "c1", "the plan entry attributes the child")
    assert.equal(plan.result, "APPROVE", "the approval is credited")
    assert.equal(plan.source, "task-result", "the journaled source is the replay-creditable one")
    const restored = createLedger(path.join(metricsDir, "turnstile.jsonl"), 64, 2000).state("p1")
    assert.equal(restored.hasPlanVerdict, true, "a restart's replay restores the plan gate")
  } finally {
    dispose()
    restoreCwd()
  }
})

/** A background reviewer completion credits the landing gate at a complete ensemble. */
test("synthetic reviewer completion credits the reviewer approval", async () => {
  const { h, dispose, metricsDir, restoreCwd } = await boot()
  try {
    // Two counted reviewer dispatches complete the ensemble.
    for (const prompt of ["first", "second"]) {
      await h.toolHooks["execute.before"]!({
        tool: "task",
        sessionID: "p1",
        input: { agent: "reviewer", prompt },
      })
    }
    await seedChildEdge(h, "c1", "p1", "reviewer")
    await pushSynthetic(h, "p1", syntheticItem("c1", APPROVE, "reviewer"))
    const restored = createLedger(path.join(metricsDir, "turnstile.jsonl"), 64, 2000).state("p1")
    assert.equal(restored.hasReviewApprove, true, "the reviewer approval is credited")
  } finally {
    dispose()
    restoreCwd()
  }
})

/** A reviewer approval under an incomplete ensemble is refusal-suppressed. */
test("synthetic reviewer approval is suppressed at an incomplete ensemble", async () => {
  const { h, dispose, metricsDir, restoreCwd } = await boot()
  try {
    // One dispatch counts, but the ensemble needs two: the credit refuses.
    await h.toolHooks["execute.before"]!({
      tool: "task",
      sessionID: "p1",
      input: { agent: "reviewer", prompt: "only review" },
    })
    await seedChildEdge(h, "c1", "p1", "reviewer")
    await pushSynthetic(h, "p1", syntheticItem("c1", APPROVE, "reviewer"))
    const restored = createLedger(path.join(metricsDir, "turnstile.jsonl"), 64, 2000).state("p1")
    assert.equal(restored.hasReviewApprove, false, "the incomplete ensemble suppresses the credit")
  } finally {
    dispose()
    restoreCwd()
  }
})

/** A non-plan-reviewer synthetic completion never moves the plan gate. */
test("synthetic non-pipeline-agent completion is parsed but credits nothing", async () => {
  const { h, dispose, metricsDir, restoreCwd } = await boot()
  try {
    await seedChildEdge(h, "c1", "p1", "executor")
    await pushSynthetic(h, "p1", syntheticItem("c1", APPROVE, "executor"))
    assert.equal(entriesOf(metricsDir, "plan").length, 0, "no plan entry for a non-plan-reviewer")
    const restored = createLedger(path.join(metricsDir, "turnstile.jsonl"), 64, 2000).state("p1")
    assert.equal(restored.hasPlanVerdict, false, "the plan gate stays red")
  } finally {
    dispose()
    restoreCwd()
  }
})

/** A replayed durable event dedupes: the same text twice credits once. */
test("synthetic completion replay dedupes to a single credit", async () => {
  const { h, dispose, metricsDir, restoreCwd } = await boot()
  try {
    await seedChildEdge(h, "c1", "p1", "plan-reviewer")
    const item = syntheticItem("c1", APPROVE)
    await pushSynthetic(h, "p1", item)
    await pushSynthetic(h, "p1", item)
    assert.equal(entriesOf(metricsDir, "plan").length, 1, "the replay is a dedup no-op")
  } finally {
    dispose()
    restoreCwd()
  }
})

/** Malformed synthetic items are inert fail-open: no parse, no credit, no throw. */
test("non-subagent, childless, and marker-free synthetic items are inert", async () => {
  const { h, dispose, metricsDir, restoreCwd } = await boot()
  try {
    await seedChildEdge(h, "c1", "p1", "plan-reviewer")
    // A synthetic item without the subagent source.
    await pushSynthetic(h, "p1", {
      type: "synthetic",
      payload: { text: APPROVE, metadata: { source: "compaction" } },
    })
    // A subagent synthetic without a child ID.
    await pushSynthetic(h, "p1", {
      type: "synthetic",
      payload: { text: APPROVE, metadata: { source: "subagent" } },
    })
    // A subagent synthetic with a child but marker-free text.
    await pushSynthetic(h, "p1", syntheticItem("c1", "all checks look fine"))
    // A subagent synthetic with a non-string text.
    await pushSynthetic(h, "p1", {
      type: "synthetic",
      payload: { text: 42, metadata: { source: "subagent", childID: "c1" } },
    })
    assert.equal(entriesOf(metricsDir, "plan").length, 0, "no credit from any malformed item")
    const errors = entriesOf(metricsDir, "error")
    assert.equal(errors.length, 0, "no internal error is journaled")
  } finally {
    dispose()
    restoreCwd()
  }
})

/** An item without a metadata agent falls back to the edge-seeded emitter. */
test("synthetic completion without a metadata agent uses the edge-seeded emitter", async () => {
  const { h, dispose, metricsDir, restoreCwd } = await boot()
  try {
    await seedChildEdge(h, "c1", "p1", "plan-reviewer")
    await pushSynthetic(h, "p1", {
      type: "synthetic",
      payload: { text: APPROVE, metadata: { source: "subagent", childID: "c1" } },
    })
    const plans = entriesOf(metricsDir, "plan")
    assert.equal(plans.length, 1, "the edge-seeded emitter authorizes the credit")
    assert.equal(plans[0]!.result, "APPROVE", "the approval is credited")
  } finally {
    dispose()
    restoreCwd()
  }
})

/** An inbox event without a session or inbox id returns before the synthetic arm. */
test("synthetic completion without inbox ids is inert", async () => {
  const { h, dispose, metricsDir, restoreCwd } = await boot()
  try {
    await seedChildEdge(h, "c1", "p1", "plan-reviewer")
    await h.pushEvent({
      type: "session.inbox.enqueued",
      data: { sessionID: "p1", item: syntheticItem("c1", APPROVE) },
    })
    assert.equal(entriesOf(metricsDir, "plan").length, 0, "no credit without an inbox id")
  } finally {
    dispose()
    restoreCwd()
  }
})
