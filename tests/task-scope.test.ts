/**
 * @fileoverview Phase 3 task-scope tests: the plan-bound scope identity
 * (`activePlan`) and its reset predicates — a same-scope prompt keeps every
 * flag, waiver, counter, and latch; scope resets exactly on an approval
 * binding a different plan (reset at capture, before stamping), an explicit
 * retire (`GATE: PASS` flip, a `taskDoneMarker` prompt), or a worktree
 * fingerprint change while no plan is bound. Prompt mentions never establish
 * or flip scope. Also the ordered replay scope fold (`task-complete` clears
 * the sticky release and marks the retire; a later plan APPROVE restarts the
 * scope; a completed task restores to a fresh bucket) and the
 * `continuationCarry:false` per-prompt escape hatch.
 */

import { test } from "node:test"
import assert from "node:assert/strict"
import * as fs from "node:fs"
import * as path from "node:path"

import { approvalResetsScope, isInterruptedReview, keepsTaskScope } from "../src/task-scope.ts"
import { createLedger } from "../src/ledger.ts"
import { newState } from "../src/state.ts"
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
import { BlockError } from "../src/gates.ts"

const APPROVE = "VERDICT: APPROVE crit=0 high=0 med=0 low=0"

/**
 * Boots the plugin over a fake host with a temp metrics dir and a plans dir
 * holding the given plan files; the process cwd moves into the project so
 * the plans-dir scan resolves against it.
 * @param plans The plan files to seed (`name` → body).
 * @param config Extra config overrides.
 * @returns The host handle, journal reader, and a cwd-restore function.
 */
async function bootWithPlans(
  plans: Record<string, string>,
  config: Record<string, any> = {},
): Promise<{ h: FakeHost; metricsDir: string; project: string; restore: () => void }> {
  const project = tmpDir()
  fs.mkdirSync(path.join(project, ".opencode", "plans"), { recursive: true })
  for (const [name, body] of Object.entries(plans)) {
    fs.writeFileSync(path.join(project, ".opencode", "plans", name), body)
  }
  const metricsDir = tmpDir()
  const h = makeFakeHost()
  const prev = process.cwd()
  process.chdir(project)
  const setup = turnstile(h.host, {
    env: isolatedEnv(metricsDir),
    config: { metricsDir, ...config },
  })
  const dispose = (await setup(h.host)) as () => void
  return {
    h,
    metricsDir,
    project,
    restore: (): void => {
      dispose()
      process.chdir(prev)
    },
  }
}

/**
 * Runs one plan-review round: dispatches the plan-reviewer with `prompt` (the
 * binding candidates) and delivers `verdict` from a registered child.
 * @param h The fake host.
 * @param parent The parent session.
 * @param child The child session to register and deliver from.
 * @param prompt The dispatch prompt (its plan mentions are the candidates).
 * @param verdict The verdict first line.
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

/** Dispatches an executor task on `parent` with the given prompt. */
async function execDispatch(h: FakeHost, parent: string, prompt: string): Promise<void> {
  await callTool(h, "execute.before", {
    tool: "task",
    sessionID: parent,
    input: { agent: "executor", prompt },
  })
}

/**
 * Invokes the compaction hook and returns its injected `system` entries —
 * the only surface that renders the live bucket's waiver/plan state.
 * @param h The fake host.
 * @param sessionID The parent session.
 */
async function compact(
  h: FakeHost,
  sessionID: string,
): Promise<Array<{ type: string; text?: string }>> {
  const system: Array<{ type: string; text?: string }> = []
  await callSession(h, "compaction", { system, sessionID })
  return system
}

/** The second `draft.system` entry, or "" when absent. */
function snapshotOf(system: Array<{ type: string; text?: string }>): string {
  return system.length > 1 ? (system[1]!.text ?? "") : ""
}

test("keepsTaskScope: plan-bound and not retired keeps; everything else resets", () => {
  const bound = newState()
  bound.activePlan = "plan.md"
  assert.equal(keepsTaskScope(bound, true), true, "a plan-bound bucket keeps its scope")
  assert.equal(keepsTaskScope(bound, false), false, "continuationCarry:false resets per prompt")
  const retired = newState()
  retired.activePlan = "plan.md"
  retired.taskComplete = true
  assert.equal(keepsTaskScope(retired, true), false, "a retired task resets")
  assert.equal(keepsTaskScope(undefined, true), false, "no prior bucket resets")
  const planless = newState()
  assert.equal(keepsTaskScope(planless, true), false, "a planless bucket resets")
})

test("approvalResetsScope: a different binding resets; unbound is a no-op", () => {
  assert.equal(approvalResetsScope("", "plan.md", false), true, "the first binding resets")
  assert.equal(approvalResetsScope("plan.md", "other.md", false), true, "a different plan resets")
  assert.equal(approvalResetsScope("plan.md", "plan.md", false), false, "the same plan is a no-op")
  assert.equal(approvalResetsScope("plan.md", "", false), false, "an unbound approval is a no-op")
  assert.equal(approvalResetsScope("", "", false), false, "unbound over unbound is a no-op")
  assert.equal(
    approvalResetsScope("plan.md", "plan.md", true),
    true,
    "a re-approval after a completion restarts the scope (live, matching the fold)",
  )
})

test("same-scope prompts keep gate flags, waiver, counters, and plan approval", async () => {
  const { h, metricsDir, restore } = await bootWithPlans({ "plan.md": "# P\n" })
  try {
    await reviewRound(h, "p1", "c1", "review plan.md", APPROVE)
    await execDispatch(h, "p1", "work chunk-1")
    await callSession(h, "prompt", { sessionID: "p1", text: "USER WAIVER: everything" })
    // Side chatter, a follow-up, and an unapproved mention of another plan
    // (the plan does not exist, so nothing binds): no-ops for state.
    await callSession(h, "prompt", { sessionID: "p1", text: "how is it going?" })
    await callSession(h, "prompt", { sessionID: "p1", text: "also write other.md someday" })
    await callSession(h, "prompt", { sessionID: "p1", text: "follow-up question" })
    const snapshot = snapshotOf(await compact(h, "p1"))
    assert.match(snapshot, /plan: APPROVED plan=plan\.md/, "the plan approval survived")
    assert.match(snapshot, /waiver: ACTIVE/, "the waiver survived the prompts")
    // The dispatch counter survives: the two later prompts drew down nothing.
    assert.match(snapshot, /total=1/, "the dispatch counter was not reset by the prompts")
    assert.ok(
      !journalEntries(metricsDir).some((l) => l.type === "child-reset" && l.sessionID === "p1"),
      "no child-reset was journaled by the same-scope prompts",
    )
  } finally {
    restore()
  }
})

test("isInterruptedReview: green gate plus counted reviewer activity, no credited approval", () => {
  const base = { hasGatePass: true, taskComplete: true }
  assert.equal(
    isInterruptedReview({ ...newState(), ...base, reviewerDispatches: 1 }),
    true,
    "a counted dispatch marks the review interrupted",
  )
  assert.equal(
    isInterruptedReview({ ...newState(), ...base, reviewWaiverRounds: 1 }),
    true,
    "a waived reviewer round marks the review interrupted (waived dispatches are not counted)",
  )
  assert.equal(
    isInterruptedReview({ ...newState(), ...base }),
    false,
    "no reviewer activity is a fresh task, not an interrupted review",
  )
  assert.equal(
    isInterruptedReview({ ...newState(), ...base, hasReviewApprove: true, reviewerDispatches: 1 }),
    false,
    "a credited approval is a completed review, not an interrupted one",
  )
  assert.equal(
    isInterruptedReview({ ...newState(), reviewerDispatches: 1 }),
    false,
    "a red gate is not an interrupted review",
  )
})

test("a GATE: PASS on a plan-bound task retires it; the next prompt resets", async () => {
  const { h, metricsDir, restore } = await bootWithPlans(
    { "plan.md": "# P\n" },
    { gateEvidence: "flag" },
  )
  try {
    await reviewRound(h, "p1", "c1", "review plan.md", APPROVE)
    await execDispatch(h, "p1", "work chunk-1")
    await callTool(h, "execute.after", {
      tool: "task",
      sessionID: "p1",
      input: { agent: "test-runner" },
      result: { output: "GATE: PASS tests=1 passed=1 failed=0\n" },
    })
    assert.ok(
      journalEntries(metricsDir).some(
        (l) => l.type === "task-complete" && l.sessionID === "p1" && l.plan === "plan.md",
      ),
      "the PASS journaled its task-complete row with the bound plan",
    )
    // The next prompt starts a fresh scope: the retire resets the bucket.
    await callSession(h, "prompt", { sessionID: "p1", text: "next thing" })
    const snapshot = snapshotOf(await compact(h, "p1"))
    assert.match(snapshot, /plan: PENDING/, "the fresh bucket has no plan approval")
    assert.match(snapshot, /gate: RED/, "the fresh bucket has no earned gate")
  } finally {
    restore()
  }
})

/** Dispatches a one-shot reviewer task on `parent`. */
async function reviewerDispatch(h: FakeHost, parent: string): Promise<void> {
  await callTool(h, "execute.before", {
    tool: "task",
    sessionID: parent,
    input: { agent: "reviewer", prompt: "review it" },
  })
}

test("an interrupted post-PASS review is recovered by the next prompt", async () => {
  const { h, metricsDir, restore } = await bootWithPlans(
    { "plan.md": "# P\n" },
    { gateEvidence: "flag" },
  )
  try {
    // The opening prompt stamps the worktree fingerprint the recovery carry
    // matches against.
    await callSession(h, "prompt", { sessionID: "p1", text: "start the task" })
    await reviewRound(h, "p1", "c1", "review plan.md", APPROVE)
    await execDispatch(h, "p1", "work chunk-1")
    await callTool(h, "execute.after", {
      tool: "task",
      sessionID: "p1",
      input: { agent: "test-runner" },
      result: { output: "GATE: PASS tests=1 passed=1 failed=0\n" },
    })
    // The review was started before the abort: one counted dispatch.
    await reviewerDispatch(h, "p1")
    // The interrupted turn's next prompt recovers the retired task's state.
    await callSession(h, "prompt", { sessionID: "p1", text: "re-dispatch the reviewer" })
    assert.ok(
      journalEntries(metricsDir).some(
        (l) => l.type === "continuation" && l.sessionID === "p1" && l.recovery === true,
      ),
      "the recovery carry journaled a recovery continuation row",
    )
    const snapshot = snapshotOf(await compact(h, "p1"))
    assert.match(snapshot, /plan: APPROVED plan=plan\.md/, "the plan approval was recovered")
    assert.match(snapshot, /gate: GREEN/, "the green gate was recovered")
    // The recovered gate unblocks the reviewer re-dispatch.
    await reviewerDispatch(h, "p1")
    // The recovered scope is plan-bound and no longer retired, so it persists
    // like any live plan-bound green task — not for one prompt only.
    await callSession(h, "prompt", { sessionID: "p1", text: "carry on" })
    const snapshot2 = snapshotOf(await compact(h, "p1"))
    assert.match(snapshot2, /plan: APPROVED plan=plan\.md/, "the scope persisted")
    assert.match(snapshot2, /gate: GREEN/, "the gate persisted with the scope")
  } finally {
    restore()
  }
})

test("a new-task prompt after a credited post-PASS review still resets", async () => {
  const { h, metricsDir, restore } = await bootWithPlans(
    { "plan.md": "# P\n" },
    { gateEvidence: "flag" },
  )
  try {
    // The opening prompt stamps the worktree fingerprint.
    await callSession(h, "prompt", { sessionID: "p1", text: "start the task" })
    await reviewRound(h, "p1", "c1", "review plan.md", APPROVE)
    await execDispatch(h, "p1", "work chunk-1")
    await callTool(h, "execute.after", {
      tool: "task",
      sessionID: "p1",
      input: { agent: "test-runner" },
      result: { output: "GATE: PASS tests=1 passed=1 failed=0\n" },
    })
    // The review completed before the prompt: dispatches counted, approval
    // credited — nothing was interrupted.
    await reviewerDispatch(h, "p1")
    await reviewerDispatch(h, "p1")
    await callTool(h, "execute.after", {
      tool: "task",
      sessionID: "p1",
      input: { agent: "reviewer", prompt: "review it" },
      result: { output: "VERDICT: APPROVE crit=0 high=0 med=0 low=0\n" },
    })
    await callSession(h, "prompt", { sessionID: "p1", text: "next task" })
    assert.ok(
      !journalEntries(metricsDir).some((l) => l.type === "continuation"),
      "a completed review journals no continuation row",
    )
    const snapshot = snapshotOf(await compact(h, "p1"))
    assert.match(snapshot, /plan: PENDING/, "the completed task reset to a fresh scope")
    assert.match(snapshot, /gate: RED/, "the fresh scope has no earned gate")
  } finally {
    restore()
  }
})

test("a restart-replayed interrupted review recovers on the first prompt", async () => {
  const metricsDir = tmpDir()
  const journalPath = path.join(metricsDir, "turnstile.jsonl")
  // A journaled interrupted review: bound plan approval, green gate, one
  // counted dispatch, then the retire — exactly the abort state at rest.
  fs.writeFileSync(
    journalPath,
    [
      JSON.stringify({
        ts: "t",
        type: "plan",
        sessionID: "p1",
        result: "APPROVE",
        plan: "plan.md",
      }),
      JSON.stringify({ ts: "t", type: "gate", sessionID: "p1", result: "PASS", verified: true }),
      JSON.stringify({ ts: "t", type: "ensemble", sessionID: "p1", count: 1 }),
      JSON.stringify({ ts: "t", type: "task-complete", sessionID: "p1", plan: "plan.md" }),
    ].join("\n") + "\n",
  )
  const ledger = createLedger(journalPath, 64, 2000)
  const restored = ledger.peek("p1")!
  assert.equal(restored.hasGatePass, true, "the green gate replayed")
  assert.equal(restored.reviewerDispatches, 1, "the dispatch count replayed")
  assert.equal(restored.taskComplete, true, "the retire replayed")
  // The first post-restart prompt resets through the armed grace window: the
  // interrupted review carries instead of wiping.
  assert.equal(ledger.state("p1").replayGrace, true, "the restore armed the grace window")
  ledger.resetState("p1")
  const carried = ledger.peek("p1")!
  assert.equal(carried.hasGatePass, true, "the green gate carried")
  assert.equal(carried.reviewerDispatches, 1, "the dispatch count carried")
  assert.equal(carried.hasPlanVerdict, true, "the plan approval carried")
  assert.equal(carried.activePlan, "plan.md", "the bound plan identity carried")
  assert.equal(carried.taskComplete, false, "the retire was lifted by the recovery")
})

test("a taskDoneMarker prompt retires the active task for the next prompt", async () => {
  const { h, metricsDir, restore } = await bootWithPlans({ "plan.md": "# P\n" })
  try {
    await reviewRound(h, "p1", "c1", "review plan.md", APPROVE)
    await execDispatch(h, "p1", "work chunk-1")
    // The retire prompt itself does not reset (the marker marks; the NEXT
    // prompt starts fresh), and child/dispatch prompts never retire.
    await callSession(h, "prompt", { sessionID: "p1", text: "TASK DONE: ship it" })
    const rows = journalEntries(metricsDir).filter((l) => l.type === "task-complete")
    assert.equal(rows.length, 1, "the user prompt journaled exactly one task-complete row")
    assert.equal(rows[0]!.plan, "plan.md", "the row names the bound plan")
    const snapshot = snapshotOf(await compact(h, "p1"))
    assert.match(snapshot, /plan: APPROVED/, "the retiring prompt kept the bucket")
    // A dispatch prompt never retires.
    await execDispatch(h, "p1", "TASK DONE: fake retire")
    assert.equal(
      journalEntries(metricsDir).filter((l) => l.type === "task-complete").length,
      1,
      "a dispatch prompt never journals a retire",
    )
    // The next prompt resets for a fresh task.
    await callSession(h, "prompt", { sessionID: "p1", text: "new task" })
    assert.match(snapshotOf(await compact(h, "p1")), /plan: PENDING/, "the retire reset")
  } finally {
    restore()
  }
})

test("a plan approval binding a different plan resets scope at capture", async () => {
  const { h, restore } = await bootWithPlans({
    "plan-a.md": "# A\n",
    "plan-b.md": "# B\n",
  })
  try {
    await reviewRound(h, "p1", "c1", "review plan-a.md", APPROVE)
    await execDispatch(h, "p1", "work chunk-1")
    await callSession(h, "prompt", { sessionID: "p1", text: "USER WAIVER: everything" })
    // Re-approving the SAME plan binds nothing new: a no-op for scope (the
    // captured waiver survives, the counter survives).
    await callSession(h, "prompt", { sessionID: "p1", text: "PLAN APPROVED: plan-a.md is fine" })
    let snapshot = snapshotOf(await compact(h, "p1"))
    assert.match(snapshot, /waiver: ACTIVE/, "the same-plan re-approval kept the waiver")
    // Approving a DIFFERENT plan resets the scope before stamping: the
    // waiver family and the counters are cleared with the old scope.
    await reviewRound(h, "p1", "c2", "review plan-b.md", APPROVE)
    snapshot = snapshotOf(await compact(h, "p1"))
    assert.match(snapshot, /plan: APPROVED plan=plan-b\.md/, "the new plan is bound")
    assert.match(snapshot, /waiver: none/, "the old scope's waiver was cleared")
    assert.match(snapshot, /total=0/, "the old scope's counters were cleared")
  } finally {
    restore()
  }
})

test("an unbound approval over an existing activePlan is a no-op for scope", async () => {
  const { h, metricsDir, restore } = await bootWithPlans({ "plan.md": "# P\n" })
  try {
    await reviewRound(h, "p1", "c1", "review plan.md", APPROVE)
    await execDispatch(h, "p1", "work chunk-1")
    await callSession(h, "prompt", { sessionID: "p1", text: "USER WAIVER: everything" })
    // A human PLAN APPROVED with no plan candidates binds nothing: no reset,
    // no flip, scope kept.
    await callSession(h, "prompt", { sessionID: "p1", text: "PLAN APPROVED: go ahead" })
    const snapshot = snapshotOf(await compact(h, "p1"))
    // Pre-existing stamp semantics: a human approval with no plan candidates
    // is unbound, so the displayed identity clears — but the SCOPE identity
    // (activePlan) is untouched and nothing reset.
    assert.match(snapshot, /- plan: APPROVED stamp=known/, "the approval stayed live")
    assert.match(snapshot, /total=1/, "the counter survived the unbound approval")
    // The unbound stamp must not have wiped the active plan: the NEXT prompt
    // is still same-scope, so the waiver and the counter survive it too.
    await callSession(h, "prompt", { sessionID: "p1", text: "carry on" })
    const snapshot2 = snapshotOf(await compact(h, "p1"))
    assert.match(snapshot2, /waiver: ACTIVE/, "the waiver survived the post-approval prompt")
    assert.match(snapshot2, /total=1/, "the counter survived the post-approval prompt")
    assert.ok(
      !journalEntries(metricsDir).some((l) => l.type === "child-reset" && l.sessionID === "p1"),
      "no reset was journaled by the unbound approval",
    )
  } finally {
    restore()
  }
})

test("a reset-at-capture plan approval releases a cap-blocked child's counters", async () => {
  const { h, metricsDir, restore } = await bootWithPlans(
    { "plan.md": "# P\n" },
    { gateEvidence: "flag" },
  )
  try {
    // A child earns a gate and exhausts the reviewer round cap on its own
    // bucket, then registers its edge to the parent.
    await callTool(h, "execute.after", {
      tool: "task",
      sessionID: "c1",
      input: { agent: "test-runner" },
      result: { output: "GATE: PASS tests=1 passed=1 failed=0\n" },
    })
    await h.pushEvent({
      type: "session.created",
      data: { sessionID: "c1", parentID: "p1", agent: "reviewer" },
    })
    await callTool(h, "execute.before", {
      tool: "task",
      sessionID: "c1",
      input: { agent: "reviewer", prompt: "go" },
    })
    await callTool(h, "execute.before", {
      tool: "task",
      sessionID: "c1",
      input: { agent: "reviewer", prompt: "go" },
    })
    await assert.rejects(
      () =>
        callTool(h, "execute.before", {
          tool: "task",
          sessionID: "c1",
          input: { agent: "reviewer", prompt: "blocked" },
        }),
      (e: Error) => e instanceof BlockError,
    )
    // The plan approval binding a different plan (the first binding) resets
    // the parent's scope and frees the registered child's counters.
    await reviewRound(h, "p1", "c2", "review plan.md", APPROVE)
    const freed = journalEntries(metricsDir).filter((l) => l.type === "child-reset")
    assert.equal(freed.length, 1, "the reset-at-capture journaled one child-reset")
    assert.equal(freed[0]!.children, 1, "the blocked child's counters were freed")
  } finally {
    restore()
  }
})

test("continuationCarry:false resets per prompt even within the same plan scope", async () => {
  const { h, restore } = await bootWithPlans({ "plan.md": "# P\n" }, { continuationCarry: false })
  try {
    await reviewRound(h, "p1", "c1", "review plan.md", APPROVE)
    await execDispatch(h, "p1", "work chunk-1")
    await callSession(h, "prompt", { sessionID: "p1", text: "follow-up" })
    const snapshot = snapshotOf(await compact(h, "p1"))
    assert.match(snapshot, /plan: PENDING/, "the escape hatch resets the bound scope")
    assert.match(snapshot, /total=0/, "the counters re-armed per prompt")
  } finally {
    restore()
  }
})

test("replay folds task-complete, sticky rows, and plan approvals in order", () => {
  const metricsDir = tmpDir()
  const journalPath = path.join(metricsDir, "turnstile.jsonl")
  const lines = [
    // Waiver captured within the first scope…
    JSON.stringify({
      ts: "t",
      type: "permission",
      sessionID: "p1",
      decision: "waiver",
      scope: "task",
      kind: "waiver",
      stages: [],
    }),
    // …the task completed…
    JSON.stringify({ ts: "t", type: "task-complete", sessionID: "p1", plan: "plan.md" }),
    // …a later approval restarted the scope…
    JSON.stringify({ ts: "t", type: "plan", sessionID: "p1", result: "APPROVE", plan: "plan.md" }),
    // …and a sticky grant landed within the restarted scope.
    JSON.stringify({
      ts: "t",
      type: "permission",
      sessionID: "p1",
      decision: "always",
      scope: "task",
      kind: "hands-on",
    }),
    // A session whose only scope row is a retire: the fold starts empty.
    JSON.stringify({ ts: "t", type: "task-complete", sessionID: "p3", plan: "plan.md" }),
    // A same-plan re-approval after a completion restarts the scope (the
    // retire clears; the sticky stays cleared until a later row). The bound
    // identity is re-established first so the re-approval arm is exercised.
    JSON.stringify({ ts: "t", type: "plan", sessionID: "p3", result: "APPROVE", plan: "plan.md" }),
    JSON.stringify({ ts: "t", type: "task-complete", sessionID: "p3", plan: "plan.md" }),
    JSON.stringify({ ts: "t", type: "plan", sessionID: "p3", result: "APPROVE", plan: "plan.md" }),
  ]
  fs.writeFileSync(journalPath, lines.join("\n") + "\n")
  const ledger = createLedger(journalPath, 64, 2000)
  const s = ledger.peek("p1")
  assert.equal(s?.activePlan, "plan.md", "the final approval established the active plan")
  assert.equal(s?.taskComplete, false, "the later approval cleared the retire")
  assert.equal(s?.handsOnRelease, true, "the post-approval grant restored")
  assert.equal(s?.userWaiver, "", "the pre-completion waiver was superseded")
  const s3 = ledger.peek("p3")
  assert.equal(s3?.activePlan, "plan.md", "the re-approval bound the same plan")
  assert.equal(s3?.taskComplete, false, "the re-approval cleared the completion")

  // A completion as the FINAL record restores the retire and no release.
  const journal2 = path.join(metricsDir, "t2.jsonl")
  fs.writeFileSync(
    journal2,
    [
      JSON.stringify({
        ts: "t",
        type: "permission",
        sessionID: "p2",
        decision: "always",
        scope: "task",
        kind: "plan",
      }),
      JSON.stringify({ ts: "t", type: "task-complete", sessionID: "p2", plan: "plan.md" }),
    ].join("\n") + "\n",
  )
  const ledger2 = createLedger(journal2, 64, 2000)
  const s2 = ledger2.peek("p2")
  assert.equal(s2?.taskComplete, true, "the final completion restores the retire")
  assert.equal(s2?.activePlan, "", "the completed scope carries no plan identity")
  assert.equal(s2?.hasPlanVerdict, false, "the completed release does not restore")

  // Restart-after-completion: the first prompt after the replay is a fresh
  // bucket (mergeAfterReplay carries nothing out of a taskComplete bucket).
  const s2b = ledger2.state("p2")
  assert.equal(s2b.replayGrace, true, "the restore rides the grace window")
  ledger2.resetState("p2")
  const s2c = ledger2.peek("p2")!
  assert.equal(s2c.hasGatePass, false, "a completed task contributes no flags")
  assert.equal(s2c.taskComplete, false, "the fresh bucket is not retired")
  assert.equal(s2c.replayGrace, false, "the grace was consumed")
})

test("ledger replay restores activePlan from a bound plan approval", () => {
  const metricsDir = tmpDir()
  const journalPath = path.join(metricsDir, "turnstile.jsonl")
  fs.writeFileSync(
    journalPath,
    JSON.stringify({
      ts: "t",
      type: "plan",
      sessionID: "p1",
      result: "APPROVE",
      plan: "plan.md",
    }) + "\n",
  )
  const ledger = createLedger(journalPath, 64, 2000)
  const s = ledger.peek("p1")
  assert.equal(s?.activePlan, "plan.md", "the bound approval restores the active plan")
  assert.equal(s?.hasPlanVerdict, true, "the approval restores")
})

test("a planless task stays on the per-prompt fingerprint fallback", async () => {
  const { h, metricsDir, restore } = await bootWithPlans({}, { gateEvidence: "flag" })
  try {
    await callSession(h, "prompt", { sessionID: "p1", text: "fix the bug" })
    await execDispatch(h, "p1", "do the work")
    await callTool(h, "execute.after", {
      tool: "task",
      sessionID: "p1",
      input: { agent: "test-runner" },
      result: { output: "GATE: PASS tests=1 passed=1 failed=0\n" },
    })
    // A planless PASS journals no retire row (there is no plan to retire) and
    // the next prompt behaves like today (reset with the carry grace).
    assert.ok(
      !journalEntries(metricsDir).some((l) => l.type === "task-complete"),
      "a planless gate flip retires nothing",
    )
    await callSession(h, "prompt", { sessionID: "p1", text: "next" })
    await execDispatch(h, "p1", "reviewer work")
    const snapshot = snapshotOf(await compact(h, "p1"))
    assert.match(snapshot, /gate: GREEN/, "the earned gate carried via the planless carry")
  } finally {
    restore()
  }
})

test("an enforce claim cannot be verified by evidence predating the prompt", async () => {
  const { h, metricsDir, restore } = await bootWithPlans({ "plan.md": "# P\n" })
  try {
    await reviewRound(h, "p1", "c1", "review plan.md", APPROVE)
    // An exit-0 test execution lands inside the task (prompt 1's window).
    await callTool(h, "execute.after", {
      tool: "bash",
      sessionID: "p1",
      input: { command: "npm test" },
      result: { metadata: { exit: 0 } },
    })
    // A same-scope prompt (keep) re-stamps the per-prompt evidence window:
    // the prior hit predates it, so the claim registers unverified.
    await callSession(h, "prompt", { sessionID: "p1", text: "carry on" })
    await callTool(h, "execute.after", {
      tool: "task",
      sessionID: "p1",
      input: { agent: "test-runner" },
      result: { output: "GATE: PASS tests=1 passed=1 failed=0\n" },
    })
    const gate = journalEntries(metricsDir).find((l) => l.type === "gate" && l.result === "PASS")
    assert.equal(gate?.verified, false, "a pre-claim same-task hit verifies nothing")
    // The failed claim's residue is cleared by the next same-scope prompt,
    // and a fresh in-window execution verifies the re-claim: the gate flips
    // green and — plan-bound — the flip retires the task.
    await callSession(h, "prompt", { sessionID: "p1", text: "carry on again" })
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
    const gates = journalEntries(metricsDir).filter((l) => l.type === "gate" && l.result === "PASS")
    assert.equal(gates.length, 2, "the identical re-claim re-journaled (no dedupe wedge)")
    assert.equal(gates[1]!.verified, true, "the in-window re-claim verified and flipped")
    assert.ok(
      journalEntries(metricsDir).some((l) => l.type === "task-complete" && l.sessionID === "p1"),
      "the flipping PASS retired the plan-bound task",
    )
  } finally {
    restore()
  }
})

test("a verdict binding a different plan over an armed grace rebuilds clean", async () => {
  const project = tmpDir()
  fs.mkdirSync(path.join(project, ".opencode", "plans"), { recursive: true })
  fs.writeFileSync(path.join(project, ".opencode", "plans", "plan-a.md"), "# A\n")
  fs.writeFileSync(path.join(project, ".opencode", "plans", "plan-b.md"), "# B\n")
  const metricsDir = tmpDir()
  const prev = process.cwd()
  process.chdir(project)
  try {
    // Boot 1: bind plan-a and earn a gate flag (flag mode flips without
    // evidence), then tear down — the journal restores both with the grace
    // armed on boot 2.
    const h1 = makeFakeHost()
    const setup1 = turnstile(h1.host, {
      env: isolatedEnv(metricsDir),
      config: { metricsDir, gateEvidence: "flag" },
    })
    const dispose1 = (await setup1(h1.host)) as () => void
    await reviewRound(h1, "p1", "c1", "review plan-a.md", APPROVE)
    await callTool(h1, "execute.after", {
      tool: "task",
      sessionID: "p1",
      input: { agent: "test-runner" },
      result: { output: "GATE: PASS tests=1 passed=1 failed=0\n" },
    })
    dispose1()
    // Boot 2: the replayed bucket carries the old scope's flags with the
    // grace armed; the verdict binding plan-b resets CLEAN — no flag,
    // release, or waiver from the old scope rides into the new one.
    const h2 = makeFakeHost()
    const setup2 = turnstile(h2.host, {
      env: isolatedEnv(metricsDir),
      config: { metricsDir, gateEvidence: "flag" },
    })
    const dispose2 = (await setup2(h2.host)) as () => void
    const before = snapshotOf(await compact(h2, "p1"))
    assert.match(before, /gate: GREEN/, "the old gate flag restored with the grace armed")
    await reviewRound(h2, "p1", "c2", "review plan-b.md", APPROVE)
    const snapshot = snapshotOf(await compact(h2, "p1"))
    assert.match(snapshot, /plan: APPROVED plan=plan-b\.md/, "the new plan is bound")
    assert.match(snapshot, /gate: RED/, "the old scope's gate flag did not ride the reset")
    assert.match(snapshot, /total=0/, "the fresh bucket re-armed the counters")
    dispose2()
  } finally {
    process.chdir(prev)
  }
})

test("a human approval naming the plan binds the active plan; same scope keeps state", async () => {
  const { h, metricsDir, restore } = await bootWithPlans({ "plan.md": "# P\n" })
  try {
    // The human release channel binds exactly like a reviewer verdict when
    // the prompt names one existing plan (approval capture runs before the
    // waiver capture, so the shared-prompt waiver lands in the new scope).
    await callSession(h, "prompt", {
      sessionID: "p1",
      text: "PLAN APPROVED: plan.md\nUSER WAIVER: everything",
    })
    const row = journalEntries(metricsDir).find(
      (l) => l.type === "plan" && l.source === "session-prompt",
    )
    assert.equal(row?.plan, "plan.md", "the bound name is journaled with the approval")
    let snapshot = snapshotOf(await compact(h, "p1"))
    assert.match(snapshot, /plan: APPROVED plan=plan\.md/, "the human approval bound the plan")
    assert.match(snapshot, /waiver: ACTIVE/, "the shared-prompt waiver landed in the new scope")
    // A prompt naming no existing plan binds nothing: a no-op for scope (the
    // pre-existing unbound-stamp semantics clear the displayed identity, but
    // the scope identity and state are untouched).
    await callSession(h, "prompt", { sessionID: "p1", text: "PLAN APPROVED: ghost.md ok" })
    // Same-scope prompts keep the state; the unbound mention never flips it.
    await callSession(h, "prompt", { sessionID: "p1", text: "carry on" })
    snapshot = snapshotOf(await compact(h, "p1"))
    assert.match(snapshot, /- plan: APPROVED stamp=known/, "the approval stayed live")
    assert.match(snapshot, /waiver: ACTIVE/, "the waiver survived the prompts")
  } finally {
    restore()
  }
})

test("a task retire clears the intent-nudge latch; the successor re-nudges", async () => {
  const { h, metricsDir, restore } = await bootWithPlans({ "plan.md": "# P\n" })
  try {
    // First task: the intent nudges once (read-delivery prefix) and latches.
    await callSession(h, "prompt", { sessionID: "p1", text: "fix the bug #123" })
    const read1 = { output: "file contents" }
    await callTool(h, "execute.after", { tool: "read", sessionID: "p1", result: read1 })
    assert.match(String(read1.output), /\[turnstile\] Advisory reminder/, "the first intent nudged")
    // Bind a plan, then retire the task explicitly: the latch must clear.
    await reviewRound(h, "p1", "c1", "review plan.md", APPROVE)
    await callSession(h, "prompt", { sessionID: "p1", text: "TASK DONE: shipped" })
    // The successor task's same-kind intent nudges again.
    await callSession(h, "prompt", { sessionID: "p1", text: "fix the bug #123 again" })
    const intents = journalEntries(metricsDir).filter((l) => l.type === "intent")
    assert.ok(intents.length >= 2, "the successor intent was journaled")
    const read2 = { output: "more contents" }
    await callTool(h, "execute.after", { tool: "read", sessionID: "p1", result: read2 })
    assert.match(
      String(read2.output),
      /\[turnstile\] Advisory reminder/,
      "the successor task's same-kind intent re-nudged",
    )
  } finally {
    restore()
  }
})

test("a restart mid-task keeps the plan-bound scope's state across a same-scope prompt", async () => {
  const project = tmpDir()
  fs.mkdirSync(path.join(project, ".opencode", "plans"), { recursive: true })
  fs.writeFileSync(path.join(project, ".opencode", "plans", "plan.md"), "# P\n")
  const metricsDir = tmpDir()
  const prev = process.cwd()
  process.chdir(project)
  try {
    const h1 = makeFakeHost()
    const setup1 = turnstile(h1.host, {
      env: isolatedEnv(metricsDir),
      config: { metricsDir, gateEvidence: "flag" },
    })
    const dispose1 = (await setup1(h1.host)) as () => void
    await reviewRound(h1, "p1", "c1", "review plan.md", APPROVE)
    await execDispatch(h1, "p1", "work chunk-1")
    await callSession(h1, "prompt", { sessionID: "p1", text: "USER WAIVER: everything" })
    dispose1()
    // Reboot over the same journal: the scope fold restores the bound plan,
    // the waiver presence, and the ensemble state; the same-scope prompt
    // keeps all of it.
    const h2 = makeFakeHost()
    const setup2 = turnstile(h2.host, {
      env: isolatedEnv(metricsDir),
      config: { metricsDir, gateEvidence: "flag" },
    })
    const dispose2 = (await setup2(h2.host)) as () => void
    await callSession(h2, "prompt", { sessionID: "p1", text: "carry on" })
    const snapshot = snapshotOf(await compact(h2, "p1"))
    assert.match(snapshot, /plan: APPROVED plan=plan\.md/, "the bound approval survived")
    assert.match(snapshot, /waiver: ACTIVE/, "the restored waiver survived the prompt")
    // The per-leg dispatch counters are not journaled (pre-existing replay
    // semantics), so the journaled counter that must survive is the ensemble
    // count — assert the state the journal actually carries.
    assert.match(snapshot, /dispatches=0 last=none/, "the replayed bucket rendered intact")
    dispose2()
  } finally {
    process.chdir(prev)
  }
})

test("a long-lived plan-bound parent survives LRU churn under the session cap", async () => {
  const { h, restore } = await bootWithPlans(
    { "plan.md": "# P\n" },
    { maxSessions: 4, gateEvidence: "flag" },
  )
  try {
    await reviewRound(h, "p1", "c1", "review plan.md", APPROVE)
    await execDispatch(h, "p1", "work chunk-1")
    await callSession(h, "prompt", { sessionID: "p1", text: "USER WAIVER: everything" })
    // Churn the session LRU past the cap with throwaway sessions.
    for (let i = 0; i < 8; i++) {
      await callTool(h, "execute.after", {
        tool: "task",
        sessionID: `churn-${i}`,
        input: { agent: "planner" },
        result: { output: "planned" },
      })
    }
    // The pinned parent's bucket is intact and still same-scope.
    await callSession(h, "prompt", { sessionID: "p1", text: "carry on" })
    const snapshot = snapshotOf(await compact(h, "p1"))
    assert.match(snapshot, /plan: APPROVED plan=plan\.md/, "the bound approval survived churn")
    assert.match(snapshot, /waiver: ACTIVE/, "the waiver survived churn")
    assert.match(snapshot, /total=1/, "the counter survived churn")
  } finally {
    restore()
  }
})
