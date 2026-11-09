/**
 * @fileoverview Block-message snapshots: the user-visible contract text of
 * the gate refusals, pinned byte-for-byte — the cap-block composer (parent
 * vs edge-registered child recovery tails), the gate-unverified refusal with
 * its attribution summary (including the "none —" lead-in), the no-gate-pass
 * reviewer refusal, and the plan-gate block messages, driven through the
 * real plugin boot so the pinned bytes are what the host actually sees.
 */

import { test } from "node:test"
import assert from "node:assert/strict"
import * as fs from "node:fs"
import * as path from "node:path"

import { capBlockMessage, unverifiedBlockMessage } from "../src/gate-messages.ts"
import { defaultConfig } from "../src/config.ts"
import type { EvidenceSearch } from "../src/gate-messages.ts"
import { turnstile } from "../turnstile.ts"
import {
  callSession,
  callTool,
  isolatedEnv,
  makeFakeHost,
  tmpDir,
  type FakeHost,
} from "./helpers.ts"

/** The resolved default config the message builders render agent names from. */
const config = defaultConfig({})

/** Boots the plugin over a fake host in a temp project with one plan file,
 *  so the plan gate resolves exactly that plan (the repo's own plans dir
 *  must not leak into the pinned bytes). */
async function boot(): Promise<{ h: FakeHost; dispose: () => void }> {
  const metricsDir = tmpDir()
  const project = tmpDir()
  fs.mkdirSync(path.join(project, ".opencode", "plans"), { recursive: true })
  fs.writeFileSync(path.join(project, ".opencode", "plans", "plan.md"), "# P\n")
  const h = makeFakeHost()
  const prevCwd = process.cwd()
  process.chdir(project)
  const setup = turnstile(h.host, {
    env: isolatedEnv(metricsDir),
    config: { metricsDir, alwaysEnforce: true, maxReviewerRounds: 1 },
  })
  const dispose = (await setup(h.host)) as () => void
  return {
    h,
    dispose: () => {
      dispose()
      process.chdir(prevCwd)
    },
  }
}

/** The block message a reviewer dispatch produces, or "" when allowed. */
async function reviewerBlock(h: FakeHost): Promise<string> {
  try {
    await callTool(h, "execute.before", {
      tool: "task",
      sessionID: "p1",
      input: { agent: "reviewer", prompt: "review it" },
    })
    return ""
  } catch (e) {
    return (e as Error).message
  }
}

/** The block message an executor dispatch produces, or "" when allowed. */
async function executorBlock(h: FakeHost): Promise<string> {
  try {
    await callTool(h, "execute.before", {
      tool: "task",
      sessionID: "p1",
      input: { agent: "executor", prompt: "implement chunk-1" },
    })
    return ""
  } catch (e) {
    return (e as Error).message
  }
}

test("unverifiedBlockMessage renders the legacy bytes without a search context", () => {
  assert.equal(
    unverifiedBlockMessage(config, "p1"),
    "BLOCKED by turnstile: reviewer dispatch without gate evidence: a GATE: PASS " +
      "was recorded without a journaled successful test-command execution for this session. " +
      "Run the test-runner subagent first, or obtain an explicit user waiver " +
      "(a user prompt this task must contain the literal marker 'USER WAIVER:' followed by the user's words).",
  )
})

test("unverifiedBlockMessage renders the plain none summary with a search context", () => {
  const search: EvidenceSearch = { attributed: [], unresolved: [], direct: false }
  assert.equal(
    unverifiedBlockMessage(config, "p1", search),
    "BLOCKED by turnstile: reviewer dispatch without gate evidence: a GATE: PASS " +
      "was recorded without a journaled successful test-command execution for this session " +
      "(searched p1; journaled test executions: none). " +
      "Run the test-runner subagent first, or obtain an explicit user waiver " +
      "(a user prompt this task must contain the literal marker 'USER WAIVER:' followed by the user's words).",
  )
})

test("unverifiedBlockMessage renders the none-lead-in for unattributable-only searches", () => {
  const search: EvidenceSearch = {
    attributed: [],
    unresolved: [{ session: "c1", reason: "no parent edge" }],
    direct: false,
  }
  assert.equal(
    unverifiedBlockMessage(config, "p1", search),
    "BLOCKED by turnstile: reviewer dispatch without gate evidence: a GATE: PASS " +
      "was recorded without a journaled successful test-command execution for this session " +
      "(searched p1; journaled test executions: none — 1 child session with executions was " +
      "unattributable: c1 (no parent edge)). " +
      "Run the test-runner subagent first, or obtain an explicit user waiver " +
      "(a user prompt this task must contain the literal marker 'USER WAIVER:' followed by the user's words).",
  )
})

test("unverifiedBlockMessage lists attributed children first with timestamp-factual labels", () => {
  const search: EvidenceSearch = {
    attributed: ["c1", "c2"],
    unresolved: [{ session: "c3", reason: "edge: p2" }],
    direct: false,
  }
  assert.equal(
    unverifiedBlockMessage(config, "p1", search),
    "BLOCKED by turnstile: reviewer dispatch without gate evidence: a GATE: PASS " +
      "was recorded without a journaled successful test-command execution for this session " +
      "(searched p1; journaled test executions: c1 (executions predate the current task " +
      "window), c2 (executions predate the current task window), c3 (edge: p2)). " +
      "Run the test-runner subagent first, or obtain an explicit user waiver " +
      "(a user prompt this task must contain the literal marker 'USER WAIVER:' followed by the user's words).",
  )
})

test("capBlockMessage appends the parent wait-for-a-new-prompt tail when no edge", () => {
  assert.equal(
    capBlockMessage(
      "BODY",
      undefined,
      "the open findings",
      " and wait for new instructions (a new task resets the cap).",
      "",
    ),
    "BODY and wait for new instructions (a new task resets the cap).",
  )
})

test("capBlockMessage appends the child end-the-turn tail when an edge exists", () => {
  assert.equal(
    capBlockMessage(
      "BODY",
      "p1",
      "the open findings",
      " and wait for new instructions (a new task resets the cap).",
      " CLAUSE",
    ),
    "BODY now: finish your turn and put the open findings in your final output — " +
      "your delivery reaches the parent orchestrator, and the parent's next user prompt " +
      "releases your counters; this session never receives user prompts. CLAUSE",
  )
})

test("the no-gate-pass reviewer refusal pins its full text through the plugin", async () => {
  const { h, dispose } = await boot()
  try {
    assert.equal(
      await reviewerBlock(h),
      "BLOCKED by turnstile: no reviewer dispatch before the test gate is green. " +
        "Run the test-runner subagent first; dispatch reviewer only after its first line is " +
        "`GATE: PASS tests=<n> passed=<n> failed=<n>`, or obtain an explicit user waiver " +
        "(a user prompt this task must contain the literal marker 'USER WAIVER:' followed by the user's words).",
    )
  } finally {
    dispose()
  }
})

test("the plan-gate no-approval refusal pins its full text through the plugin", async () => {
  const { h, dispose } = await boot()
  try {
    assert.equal(
      await executorBlock(h),
      'BLOCKED by turnstile: no plan approval for "plan.md". Dispatch the plan-reviewer ' +
        "subagent first; proceed with executor only after the plan-reviewer's first line is " +
        "`VERDICT: APPROVE crit=<n> high=<n> med=<n> low=<n>`, or obtain an explicit user waiver " +
        "(a user prompt this task must contain the literal marker 'USER WAIVER:' followed by the user's words).",
    )
  } finally {
    dispose()
  }
})

test("the reviewer round-limit refusal pins its full text with the scoped-waiver clause", async () => {
  const { h, dispose } = await boot()
  try {
    await callSession(h, "prompt", { sessionID: "p1", text: "USER WAIVER: reviewer" })
    await callTool(h, "execute.before", {
      tool: "task",
      sessionID: "p1",
      input: { agent: "reviewer", prompt: "review it" },
    })
    assert.equal(
      await reviewerBlock(h),
      "BLOCKED by turnstile: reviewer round limit (1) reached — the pipeline is looping. " +
        "STOP: do not re-dispatch the reviewer. Escalate the open findings to the user " +
        "and wait for new instructions (a new task resets the cap). " +
        "The scoped waiver's allowance of 1 waiver-unblocked dispatches is exhausted; " +
        "obtain a new waiver or escalate to the user.",
    )
  } finally {
    dispose()
  }
})
