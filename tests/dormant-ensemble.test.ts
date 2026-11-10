/**
 * @fileoverview Dormant-arm ensemble counting: a reviewer `task` dispatch
 * admitted on the dormant arm (a session never engaged, or disengaged by a
 * no-credit prompt) increments `reviewerDispatches` and journals the plain
 * `{type:"ensemble"}` count entry exactly as the engaged unwaived path does,
 * so the landing gate's credit check stays symmetric with dispatch-time
 * admission; a dormant non-reviewer dispatch touches nothing; a pre-fix
 * `refusedApprove:true` wedge is released on replay by post-fix plain count
 * entries; and the engaged unwaived path still advances the reviewer round
 * cap after the counting extraction. All via a fake host with injected
 * config.
 */

import * as fs from "node:fs"
import * as path from "node:path"
import { test } from "node:test"
import assert from "node:assert/strict"

import { createLedger } from "../src/ledger.ts"
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

/**
 * Boots the plugin over a fake host with a temp metrics dir. Dormant by
 * default (no `alwaysEnforce`), so reviewer dispatches ride the dormant arm
 * unless a config override engages the session.
 * @param config Config overrides merged over the injected `metricsDir`.
 */
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

/** Dispatches the reviewer through the dormant arm (no engaging prompt). */
async function dormantReviewerDispatch(h: FakeHost, prompt: string): Promise<void> {
  await callTool(h, "execute.before", {
    tool: "task",
    sessionID: "p1",
    input: { agent: "reviewer", prompt },
  })
}

/** Every journal entry of the given type from a boot's metrics dir. */
function entriesOf(metricsDir: string, type: string): Array<Record<string, any>> {
  return journalEntries(metricsDir).filter((e) => e.type === type)
}

/** Reads a session's replayed ledger state from a boot's metrics dir. */
function replayState(metricsDir: string, sessionID: string) {
  return createLedger(path.join(metricsDir, "turnstile.jsonl"), 64, 2000).state(sessionID)
}

/** a dormant reviewer dispatch counts toward the ensemble and credits the
 *  APPROVE without an ensemble-incomplete refusal. */
test("a dormant reviewer dispatch counts toward the ensemble", async () => {
  const { h, dispose, metricsDir } = await boot()
  try {
    // No engaging prompt: both reviewer dispatches ride the dormant arm.
    await dormantReviewerDispatch(h, "first review")
    await dormantReviewerDispatch(h, "second review")
    await callTool(h, "execute.after", {
      tool: "task",
      sessionID: "p1",
      input: { agent: "reviewer", prompt: "second review" },
      result: { output: `${APPROVE}\n` },
    })
    const s = replayState(metricsDir, "p1")
    assert.equal(s.reviewerDispatches, 2, "both dormant dispatches counted")
    assert.equal(s.hasReviewApprove, true, "the APPROVE is credited at the complete ensemble")
    const entries = journalEntries(metricsDir)
    assert.ok(
      !entries.some((e) => e.type === "blocked" && e.reason === "ensemble-incomplete"),
      "no ensemble-incomplete refusal is journaled",
    )
    const ens = entriesOf(metricsDir, "ensemble")
    assert.deepEqual(
      ens.map((e) => [e.count, "refusedApprove" in e]),
      [
        [1, false],
        [2, false],
      ],
      "plain count entries (no refusal stamp) are journaled per dispatch",
    )
  } finally {
    dispose()
  }
})

/** a dormant non-reviewer dispatch neither counts nor journals the ensemble. */
test("a dormant non-reviewer dispatch does not touch the ensemble", async () => {
  const { h, dispose, metricsDir } = await boot()
  try {
    await callTool(h, "execute.before", {
      tool: "task",
      sessionID: "p1",
      input: { agent: "test-runner", prompt: "run the tests" },
    })
    await callTool(h, "execute.before", {
      tool: "task",
      sessionID: "p1",
      input: { agent: "executor", prompt: "do the work" },
    })
    assert.equal(
      replayState(metricsDir, "p1").reviewerDispatches,
      0,
      "no dormant non-reviewer dispatch counted",
    )
    assert.equal(entriesOf(metricsDir, "ensemble").length, 0, "no ensemble entry journaled")
  } finally {
    dispose()
  }
})

/** replay: a pre-fix refusal stamp is cleared by post-fix dormant count
 *  entries — the count restores and the verdict re-credits. */
test("replay: a pre-fix refusal stamp is cleared by post-fix dormant counts", () => {
  const metricsDir = tmpDir()
  fs.writeFileSync(
    path.join(metricsDir, "turnstile.jsonl"),
    [
      // Pre-fix wedged state: refusal stamp at count 0, then the APPROVE
      // verdict that was refused.
      JSON.stringify({
        ts: "t",
        type: "ensemble",
        sessionID: "p1",
        agent: "reviewer",
        count: 0,
        refusedApprove: true,
      }),
      JSON.stringify({
        ts: "t",
        type: "verdict",
        sessionID: "p1",
        raw: "c1",
        agent: "reviewer",
        marker: APPROVE,
        source: "task-result",
      }),
      // Post-fix: two plain dormant-arm count entries.
      JSON.stringify({ ts: "t", type: "ensemble", sessionID: "p1", agent: "reviewer", count: 1 }),
      JSON.stringify({ ts: "t", type: "ensemble", sessionID: "p1", agent: "reviewer", count: 2 }),
    ].join("\n") + "\n",
  )
  const s = replayState(metricsDir, "p1")
  assert.equal(s.reviewerDispatches, 2, "the count is restored from the plain entries")
  assert.equal(s.hasReviewApprove, true, "the refusal is cleared and the verdict re-credited")
})

/** the engaged unwaived path still advances the reviewer round cap after the
 *  counting extraction: two dispatches consume the cap, a third blocks. */
test("the engaged unwaived path still advances reviewRounds to the cap", async () => {
  const { h, dispose, metricsDir } = await boot({ alwaysEnforce: true, gateEvidence: "flag" })
  try {
    // Flip the test gate green so the reviewer gate admits on evidence.
    await callTool(h, "execute.after", {
      tool: "task",
      sessionID: "p1",
      input: { agent: "test-runner" },
      result: { output: "GATE: PASS tests=1 passed=1 failed=0\n" },
    })
    for (const prompt of ["first review", "second review"]) {
      await callTool(h, "execute.before", {
        tool: "task",
        sessionID: "p1",
        input: { agent: "reviewer", prompt },
      })
    }
    await assert.rejects(() =>
      callTool(h, "execute.before", {
        tool: "task",
        sessionID: "p1",
        input: { agent: "reviewer", prompt: "third review" },
      }),
    )
    const escalation = entriesOf(metricsDir, "escalation").find(
      (e) => e.reason === "round-limit" && e.agent === "reviewer",
    )
    assert.ok(escalation, "the third dispatch hits the round cap")
    assert.equal(
      escalation.count,
      2,
      "the cap advanced to the max across the two unwaived dispatches",
    )
    assert.equal(escalation.cap, 2, "the cap is the configured max reviewer rounds")
  } finally {
    dispose()
  }
})
