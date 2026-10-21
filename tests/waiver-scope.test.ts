/**
 * @fileoverview Waiver-scope tests: the deterministic scope parser
 * (`parseWaiverScope`) — literal configured agent names, longest-first
 * masking, case-insensitivity, dedupe — and the scope-aware enforcement it
 * drives: the plan gate's stage-group keying (either configured group name
 * covers it), the scoped waiver's own allowance metered apart from the
 * replayed round cap, the per-stage budget exemption, and the WAIVED journal
 * shape (scoped entries carry `scope`, unscoped ones omit it).
 */

import { test } from "node:test"
import assert from "node:assert/strict"
import * as fs from "node:fs"
import * as path from "node:path"

import { BlockError, createGates } from "../src/gates.ts"
import { defaultConfig } from "../src/config.ts"
import { createJournaler } from "../src/journal.ts"
import { createLedger } from "../src/ledger.ts"
import { parseWaiverScope } from "../src/markers.ts"
import { turnstile } from "../turnstile.ts"
import {
  callSession,
  callTool,
  isolatedEnv,
  journalEntries,
  makeFakeHost,
  tmpDir,
  type FakeHost,
} from "./helpers.ts"

/** The configured agent names of the default config (incl. the `bareOutput`
 *  array entry the parser must skip). */
const DEFAULT_AGENT_NAMES = Object.values(defaultConfig().agents)

/** The exact reviewer gate no-gate-pass message. */
const NO_GATE_MESSAGE =
  "BLOCKED by turnstile: no reviewer dispatch before the test gate is green. " +
  "Run the test-runner subagent first; dispatch reviewer only after its first line is " +
  "`GATE: PASS tests=<n> passed=<n> failed=<n>`, or obtain an explicit user waiver " +
  "(a user prompt this task must contain the literal marker 'USER WAIVER:' followed by the user's words)."

/** The exact plan-approval gate message. */
const NO_PLAN_MESSAGE =
  `BLOCKED by turnstile: no plan approval for "plan.md". Dispatch the plan-reviewer subagent first; proceed with executor only after the plan-reviewer's first line is ` +
  "`VERDICT: APPROVE crit=<n> high=<n> med=<n> low=<n>`, or obtain an explicit user waiver " +
  "(a user prompt this task must contain the literal marker 'USER WAIVER:' followed by the user's words)."

/** The base reviewer round-limit block message (before any appended clause). */
const ROUND_LIMIT_MESSAGE =
  "BLOCKED by turnstile: reviewer round limit (2) reached — the pipeline is looping. STOP: do not re-dispatch the reviewer. Escalate the open findings to the user and wait for new instructions (a new user prompt resets the cap)."

/** The clause a round-limit block appends when a scoped waiver's own
 *  allowance of waiver-unblocked dispatches is exhausted. */
const ALLOWANCE_CLAUSE =
  " The scoped waiver's allowance of 2 waiver-unblocked dispatches is exhausted; obtain a new waiver or escalate to the user."

/** The clause a plan-gate block appends when the live waiver is scoped to a
 *  stage outside the plan gate's stage group (the reviewer stage here). */
const PLAN_OUT_OF_SCOPE_REVIEWER_CLAUSE =
  " A user waiver is live this task but is scoped to: reviewer — it does not cover this gate; name executor or plan-reviewer in a new waiver or escalate."

/** The base planner loop-cap block message (before any appended clause). */
const PLANNER_LOOP_CAP_BASE =
  "BLOCKED by turnstile: planner dispatch limit (3) reached this task — the pipeline is looping. STOP: do not re-dispatch planner. Escalate to the user: report the repeated planner failures and wait for new instructions (a new user prompt resets the caps; raise maxPlannerRounds in your config to widen the cap)."

/** The clause a planner block appends when the live waiver is scoped to a
 *  stage outside the planner leg (the reviewer stage here). */
const PLANNER_OUT_OF_SCOPE_CLAUSE =
  " A user waiver is live this task but is scoped to: reviewer — it does not cover this gate; name the planner stage in a new waiver or escalate."

/** The base dispatch-budget block message (before any appended clause). */
const DISPATCH_BUDGET_MESSAGE =
  "BLOCKED by turnstile: task dispatch budget (16) exhausted — the pipeline is looping. STOP: do not dispatch further subagents. Escalate to the user: report the stuck pipeline and wait for new instructions (a new user prompt resets the counters; raise maxTotalDispatches in your config to widen the budget)."

/** Boots the plugin in a temp project dir containing a plan file, so the
 *  plan gate is live. */
async function bootWithPlan(): Promise<{
  h: FakeHost
  dispose: () => void
  metricsDir: string
  restore: () => void
}> {
  const project = tmpDir()
  fs.mkdirSync(path.join(project, ".opencode", "plans"), { recursive: true })
  fs.writeFileSync(path.join(project, ".opencode", "plans", "plan.md"), "# P\n")
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
    restore: (): void => {
      dispose()
      process.chdir(prev)
    },
  }
}

/** Fires the prompt hook as the user would (admits a new task). */
async function prompt(h: FakeHost, sessionID: string, text: string): Promise<void> {
  await callSession(h, "prompt", { sessionID, text })
}

/** Boots a gate ledger + gates pair over a temp metrics dir (default config,
 *  trace off) for direct guard assertions against a crafted ledger bucket. */
function bootGates(): {
  gates: ReturnType<typeof createGates>
  ledger: ReturnType<typeof createLedger>
  metricsDir: string
} {
  const metricsDir = tmpDir()
  const ledger = createLedger(path.join(metricsDir, "turnstile.jsonl"), 64, 2000)
  const journaler = createJournaler({
    metricsDir,
    trace: false,
    maxBytes: 1e6,
    maxGenerations: 1,
    rotateEveryEntries: 512,
  })
  return { gates: createGates(defaultConfig(), journaler), ledger, metricsDir }
}

/** No configured name occurs in the text: the waiver is deterministically
 *  unscoped (the empty result, never a guess). */
test("parseWaiverScope returns [] when no configured name occurs", () => {
  assert.deepEqual(parseWaiverScope("USER WAIVER: just go ahead", DEFAULT_AGENT_NAMES), [])
})

/** An empty window parses to the unscoped result. */
test("parseWaiverScope returns [] for an empty window", () => {
  assert.deepEqual(parseWaiverScope("", DEFAULT_AGENT_NAMES), [])
})

/** Matching is case-insensitive and containment counts: a plural "reviewers"
 *  names the reviewer stage. */
test("parseWaiverScope matches case-insensitively, including plural containment", () => {
  assert.deepEqual(parseWaiverScope("USER WAIVER: proceed to the REVIEWERS", DEFAULT_AGENT_NAMES), [
    "reviewer",
  ])
})

/** A compound name consumes its span longest-first: "plan-reviewer" matches
 *  as a unit and its masked span never re-matches the shorter "reviewer". */
test("parseWaiverScope masks the compound span so reviewer does not re-match inside plan-reviewer", () => {
  assert.deepEqual(parseWaiverScope("USER WAIVER: skip the plan-reviewer", DEFAULT_AGENT_NAMES), [
    "plan-reviewer",
  ])
})

/** Multiple names come back in longest-first (stable) scan order, not text
 *  order: both eight-letter names keep their configured relative order. */
test("parseWaiverScope returns multiple names in longest-first stable order", () => {
  assert.deepEqual(
    parseWaiverScope("USER WAIVER: waive the executor and the reviewer", DEFAULT_AGENT_NAMES),
    ["reviewer", "executor"],
  )
})

/** Blank and non-string names are skipped (the configured agents value
 *  carries the `bareOutput` array), and a name repeated across configured
 *  keys is deduped to a single scope entry. */
test("parseWaiverScope skips blank and non-string names and dedupes repeated names", () => {
  assert.deepEqual(
    parseWaiverScope("USER WAIVER: the reviewer and the reviewer again", [
      "reviewer",
      "reviewer",
      "",
      "   ",
      42,
    ]),
    ["reviewer"],
  )
})

/** A renamed install scopes by its own configured names. */
test("parseWaiverScope scopes by renamed configured agent names", () => {
  assert.deepEqual(
    parseWaiverScope("USER WAIVER: proceed to the qa-reviewer", ["qa-reviewer", "executor"]),
    ["qa-reviewer"],
  )
})

/** The plan gate is covered by a waiver naming its plan-reviewer stage: the
 *  executor dispatch proceeds and the plan gate journals a prompt-channel
 *  WAIVED entry. */
test("a plan-reviewer-scoped waiver admits the executor dispatch past the plan gate", async () => {
  const { h, metricsDir, restore } = await bootWithPlan()
  try {
    await prompt(h, "p1", "USER WAIVER: approve the plan; skip the plan-reviewer")
    await callTool(h, "execute.before", {
      tool: "task",
      sessionID: "p1",
      input: { agent: "executor", prompt: "do the work" },
    })
    const waived = journalEntries(metricsDir).find(
      (l) => l.type === "plan" && l.result === "WAIVED" && l.channel === "prompt",
    )
    assert.ok(waived, "the plan gate journals a prompt-channel WAIVED entry")
  } finally {
    restore()
  }
})

/** The plan gate is likewise covered by a waiver naming its executor stage
 *  (the stage group is a pair: either configured name covers the gate). */
test("an executor-scoped waiver admits the executor dispatch past the plan gate", async () => {
  const { h, metricsDir, restore } = await bootWithPlan()
  try {
    await prompt(h, "p1", "USER WAIVER: approve the plan; run the executor")
    await callTool(h, "execute.before", {
      tool: "task",
      sessionID: "p1",
      input: { agent: "executor", prompt: "do the work" },
    })
    const waived = journalEntries(metricsDir).find(
      (l) => l.type === "plan" && l.result === "WAIVED" && l.channel === "prompt",
    )
    assert.ok(waived, "the plan gate journals a prompt-channel WAIVED entry")
  } finally {
    restore()
  }
})

/** A plan-reviewer-scoped waiver does not cover the reviewer gate: the
 *  reviewer dispatch blocks, and the block names the live scope and the
 *  stage a new waiver would need to name. */
test("a plan-reviewer-scoped waiver leaves the reviewer gate blocked with the out-of-scope report", async () => {
  const { h, restore } = await bootWithPlan()
  try {
    await prompt(h, "p1", "USER WAIVER: approve the plan; skip the plan-reviewer")
    await assert.rejects(
      () =>
        callTool(h, "execute.before", {
          tool: "task",
          sessionID: "p1",
          input: { agent: "reviewer", prompt: "review it" },
        }),
      (e: Error) =>
        e.message ===
        NO_GATE_MESSAGE +
          " A user waiver is live this task but is scoped to: plan-reviewer — it does not cover this gate; name reviewer in a new waiver or escalate.",
    )
  } finally {
    restore()
  }
})

/** The mirror pinning: a reviewer-scoped waiver does not cover the plan
 *  gate (the parser's longest-first masking keeps plan vocabulary off the
 *  reviewer gate and vice versa), so the executor dispatch blocks with the
 *  out-of-scope report. */
test("a reviewer-scoped waiver leaves the plan gate blocked with the out-of-scope report", async () => {
  const { h, restore } = await bootWithPlan()
  try {
    await prompt(h, "p1", "USER WAIVER: I approve proceeding to the reviewer agents")
    await assert.rejects(
      () =>
        callTool(h, "execute.before", {
          tool: "task",
          sessionID: "p1",
          input: { agent: "executor", prompt: "do the work" },
        }),
      (e: Error) => e.message === NO_PLAN_MESSAGE + PLAN_OUT_OF_SCOPE_REVIEWER_CLAUSE,
    )
  } finally {
    restore()
  }
})

/** The scoped-waiver allowance is metered on its own counter, never on the
 *  journal-replayed round cap: a bucket whose ordinary cap already carries
 *  one spent round (a replayed pre-waiver dispatch) still admits the full
 *  allowance of waiver-unblocked dispatches, each leaving the ordinary
 *  counters untouched; the next dispatch blocks with the allowance clause;
 *  a prompt reset clears the allowance (task-scoped). */
test("the waiver allowance is metered apart from the replayed round cap", () => {
  const { gates, ledger, metricsDir } = bootGates()
  const s = ledger.state("p1")
  // A journal-replayed pre-waiver dispatch: one ordinary round spent.
  s.reviewRounds = 1
  // A live reviewer-scoped waiver (the capture path sets these from the prompt).
  s.userWaiver = "USER WAIVER: I approve the reviewer"
  s.userWaiverScope = ["reviewer"]
  // The full allowance (maxReviewerRounds = 2) is admitted — not
  // allowance minus the replayed round.
  for (let i = 0; i < 2; i++) {
    gates.guardReviewerDispatch("p1", ledger)
    const cur = ledger.state("p1")
    assert.equal(cur.reviewWaiverRounds, i + 1, "each waived dispatch spends one allowance slot")
    assert.equal(cur.reviewRounds, 1, "waived dispatches never advance the ordinary cap")
    assert.equal(cur.reviewerDispatches, 0, "waived dispatches never count the ensemble")
  }
  assert.throws(
    () => gates.guardReviewerDispatch("p1", ledger),
    (e: Error) => e instanceof BlockError && e.message === ROUND_LIMIT_MESSAGE + ALLOWANCE_CLAUSE,
  )
  // The refused dispatch journals no WAIVED entry: the count still reflects
  // only the two admitted dispatches.
  assert.equal(
    journalEntries(metricsDir).filter((l) => l.type === "gate" && l.result === "WAIVED").length,
    2,
    "the refused dispatch journals no WAIVED entry",
  )
  // A prompt reset clears the allowance counter (task-scoped).
  ledger.resetState("p1")
  assert.equal(ledger.state("p1").reviewWaiverRounds, 0, "the allowance is task-scoped")
})

/** A reviewer-scoped waiver exempts the reviewer dispatch from the total
 *  budget without counting it (a waived dispatch draws down nothing). */
test("a reviewer-scoped waiver exempts the reviewer dispatch from the budget", () => {
  const { gates, ledger } = bootGates()
  const s = ledger.state("p1")
  s.userWaiver = "USER WAIVER: I approve the reviewer"
  s.userWaiverScope = ["reviewer"]
  gates.guardDispatchBudget("p1", ledger, "reviewer")
  assert.equal(ledger.state("p1").totalDispatches, 0, "a waived dispatch draws down no budget")
})

/** The same waiver does not exempt a capped leg it does not name: the
 *  planner leg still blocks with its loop-cap refusal and escalation. */
test("a reviewer-scoped waiver does not exempt the capped planner leg", () => {
  const { gates, ledger, metricsDir } = bootGates()
  const s = ledger.state("p1")
  s.userWaiver = "USER WAIVER: I approve the reviewer"
  s.userWaiverScope = ["reviewer"]
  s.plannerRounds = 3 // the default maxPlannerRounds
  assert.throws(
    () => gates.guardDispatchBudget("p1", ledger, "planner"),
    (e: Error) =>
      e instanceof BlockError && e.message === PLANNER_LOOP_CAP_BASE + PLANNER_OUT_OF_SCOPE_CLAUSE,
  )
  const entries = journalEntries(metricsDir)
  assert.ok(
    entries.some((l) => l.type === "blocked" && l.reason === "loop-cap"),
    "the leg block is journaled",
  )
  assert.ok(
    entries.some((l) => l.type === "escalation" && l.reason === "loop-cap"),
    "the leg escalation is journaled",
  )
})

/** An unscoped waiver keeps the legacy whole-task exemption: even a capped
 *  leg it names nothing is exempt, and the dispatch draws down no budget. */
test("an unscoped waiver keeps the whole-task budget exemption", () => {
  const { gates, ledger } = bootGates()
  const s = ledger.state("p1")
  s.userWaiver = "USER WAIVER: just go"
  s.plannerRounds = 3 // the default maxPlannerRounds
  gates.guardDispatchBudget("p1", ledger, "planner")
  assert.equal(
    ledger.state("p1").totalDispatches,
    0,
    "the unscoped waiver exempts without counting",
  )
})

/** A reviewer-scoped waiver does not exempt the total budget: an exhausted
 *  task still blocks on the dispatch budget, and the block reports the live
 *  waiver's scope and names the stage a new waiver would need to cover. */
test("a reviewer-scoped waiver does not exempt the exhausted dispatch budget", () => {
  const { gates, ledger, metricsDir } = bootGates()
  const s = ledger.state("p1")
  s.userWaiver = "USER WAIVER: I approve the reviewer"
  s.userWaiverScope = ["reviewer"]
  s.totalDispatches = 16 // the default maxTotalDispatches
  assert.throws(
    () => gates.guardDispatchBudget("p1", ledger, "planner"),
    (e: Error) =>
      e instanceof BlockError &&
      e.message === DISPATCH_BUDGET_MESSAGE + PLANNER_OUT_OF_SCOPE_CLAUSE,
  )
  const entries = journalEntries(metricsDir)
  assert.ok(
    entries.some((l) => l.type === "blocked" && l.reason === "dispatch-budget"),
    "the budget block is journaled",
  )
  assert.ok(
    entries.some((l) => l.type === "escalation" && l.reason === "dispatch-budget"),
    "the budget escalation is journaled",
  )
})

/** A scoped WAIVED journal entry carries the parsed scope; an unscoped one
 *  omits the field entirely (the legacy entry shape, pinned by the default
 *  goldens). */
test("the WAIVED journal entry carries scope only when the waiver is scoped", () => {
  const { gates, ledger, metricsDir } = bootGates()
  const s = ledger.state("p1")
  s.userWaiver = "USER WAIVER: I approve the reviewer"
  s.userWaiverScope = ["reviewer"]
  gates.guardReviewerDispatch("p1", ledger)
  const scopedEntry = journalEntries(metricsDir).find(
    (l) => l.type === "gate" && l.result === "WAIVED" && l.sessionID === "p1",
  )
  assert.ok(scopedEntry, "the scoped waiver journals a WAIVED entry")
  assert.equal(scopedEntry?.scope, "reviewer", "the scoped entry carries the parsed scope")

  const s2 = ledger.state("p2")
  s2.userWaiver = "USER WAIVER: just go"
  gates.guardReviewerDispatch("p2", ledger)
  const unscopedEntry = journalEntries(metricsDir).find(
    (l) => l.type === "gate" && l.result === "WAIVED" && l.sessionID === "p2",
  )
  assert.ok(unscopedEntry, "the unscoped waiver journals a WAIVED entry")
  assert.equal(unscopedEntry?.scope, undefined, "the unscoped entry has no scope field")
})
