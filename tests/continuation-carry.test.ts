/**
 * @fileoverview Fingerprint-boundary tests: the pure continuation-carry
 * predicate (`shouldCarryGate`) and the total worktree/branch identity
 * (`worktreeFingerprint`), plus integration coverage of the opt-in
 * `continuationCarry` enforcement wired into prompt admission. The unit cases
 * exercise `src/fingerprint.ts` directly; the integration cases boot the
 * plugin over a fake host to confirm a same-worktree continuation carries an
 * earned gate across the reset while any other prompt reset wipes it.
 */

import { test } from "node:test"
import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import * as fs from "node:fs"
import * as path from "node:path"

import { BlockError } from "../src/gates.ts"
import { turnstile } from "../turnstile.ts"
import { newState } from "../src/state.ts"
import { worktreeFingerprint, shouldCarryGate } from "../src/fingerprint.ts"
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
import type { GateState } from "../src/types.ts"

/** The exact reviewer gate no-gate-pass block message. */
const NO_GATE_MESSAGE =
  "BLOCKED by turnstile: no reviewer dispatch before the test gate is green. " +
  "Run the test-runner subagent first; dispatch reviewer only after its first line is " +
  "`GATE: PASS tests=<n> passed=<n> failed=<n>`, or obtain an explicit user waiver " +
  "(a user prompt this task must contain the literal marker 'USER WAIVER:' followed by the user's words)."

/** The exact plan-approval gate block message for the boot's single plan file. */
const NO_PLAN_MESSAGE =
  `BLOCKED by turnstile: no plan approval for "plan.md". Dispatch the plan-reviewer subagent first; proceed with executor only after the plan-reviewer's first line is ` +
  "`VERDICT: APPROVE crit=<n> high=<n> med=<n> low=<n>`, or obtain an explicit user waiver " +
  "(a user prompt this task must contain the literal marker 'USER WAIVER:' followed by the user's words)."

/** The out-of-scope clause the plan-gate block appends when the live waiver
 *  is scoped to a stage outside its group (the planner stage here). */
const PLAN_OUT_OF_SCOPE_PLANNER_CLAUSE =
  " A user waiver is live this task but is scoped to: planner — it does not cover this gate; name executor or plan-reviewer in a new waiver or escalate."

/** True when a git binary is available, so the worktree test can run. */
const hasGit = spawnSync("git", ["--version"]).error === undefined

/** Builds a valid gate state from a fresh bucket with the given overrides. */
function gate(overrides: Partial<GateState> = {}): GateState {
  return { ...newState(), ...overrides }
}

/**
 * `shouldCarryGate` is a pure, GATE-SCOPED predicate: one case per branch of
 * the short-circuit chain.
 */
test("shouldCarryGate", async (t) => {
  await t.test("disabled carry short-circuits to false", () => {
    const prior = gate({ hasGatePass: true, taskFingerprint: "abc" })
    assert.equal(shouldCarryGate(prior, "abc", false), false)
  })

  await t.test("an undefined prior returns false", () => {
    assert.equal(shouldCarryGate(undefined, "abc", true), false)
  })

  await t.test("a missing gate pass returns false", () => {
    const prior = gate({ hasGatePass: false, taskFingerprint: "abc" })
    assert.equal(shouldCarryGate(prior, "abc", true), false)
  })

  await t.test("a pre-stamp (empty) fingerprint returns false", () => {
    const prior = gate({ hasGatePass: true, taskFingerprint: "" })
    assert.equal(shouldCarryGate(prior, "abc", true), false)
  })

  await t.test("a fingerprint mismatch returns false", () => {
    const prior = gate({ hasGatePass: true, taskFingerprint: "abc" })
    assert.equal(shouldCarryGate(prior, "xyz", true), false)
  })

  await t.test("the same branch after an earned pass carries", () => {
    const prior = gate({ hasGatePass: true, taskFingerprint: "abc" })
    assert.equal(shouldCarryGate(prior, "abc", true), true)
  })
})

/** `worktreeFingerprint` fingerprints a non-git directory as its resolution. */
test("worktreeFingerprint returns path.resolve for a non-git directory", () => {
  const dir = tmpDir("turnstile-notgit-")
  const fp = worktreeFingerprint(dir)
  assert.equal(fp, path.resolve(dir))
  assert.equal(fp.includes("\u0000"), false)
})

/** `worktreeFingerprint` fingerprints a git worktree as root<NUL>branch. */
test("worktreeFingerprint fingerprints a git worktree", { skip: !hasGit }, () => {
  const dir = tmpDir("turnstile-git-")
  assert.ok(spawnSync("git", ["init", "-b", "main", dir]).error === undefined)
  // An unborn HEAD has no branch, so make an initial commit for abbrev-ref HEAD
  // to resolve to "main" (git init alone leaves HEAD pointing at nothing).
  const commit = spawnSync("git", [
    "-C",
    dir,
    "-c",
    "user.email=test@example.com",
    "-c",
    "user.name=Test",
    "commit",
    "--allow-empty",
    "-m",
    "init",
  ])
  assert.equal(commit.error, undefined)
  const fp = worktreeFingerprint(dir)
  // git rev-parse --show-toplevel returns the canonical (symlink-resolved)
  // worktree root, so match it via realpathSync rather than path.resolve.
  const expected = `${fs.realpathSync(dir)}\u0000main`
  assert.equal(fp, expected)
  assert.equal(fp.includes("\u0000"), true)
  assert.equal(fp.includes("main"), true)
})

/** `worktreeFingerprint` falls back on a throw from the injected exec seam. */
test("worktreeFingerprint falls back on a throwing exec seam", () => {
  const dir = tmpDir("turnstile-throw-")
  const fp = worktreeFingerprint(dir, () => {
    throw new Error("exec failed")
  })
  assert.equal(fp, path.resolve(dir))
  assert.equal(fp.includes("\u0000"), false)
})

/**
 * Boots the plugin in an isolated temp project dir that carries a
 * `.opencode/plans` file (so dispatches are gated) and switches the working
 * directory there, returning the host, metrics dir, project path, and a
 * `restore` that disposes and returns to the previous directory. The project
 * dir is a fresh temp dir (not a git worktree), so the continuation fingerprint
 * is its resolved path.
 */
async function bootWithPlan(config: Record<string, any> = {}): Promise<{
  h: FakeHost
  dispose: () => void
  metricsDir: string
  project: string
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
    config: { metricsDir, ...config },
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

/** Earns a green test gate for `sessionID` via a `GATE: PASS` test-runner
 *  result over `execute.after`; `gateEvidence:"flag"` keeps the flip-on-PASS
 *  semantics the flip switch does not provide under enforce. */
async function earnGate(h: FakeHost, sessionID: string): Promise<void> {
  await callTool(h, "execute.after", {
    tool: "task",
    sessionID,
    input: { agent: "test-runner" },
    result: { output: "GATE: PASS tests=3 passed=3 failed=0\nrest" },
  })
}

/** Dispatches a one-shot reviewer task for `sessionID`. */
async function reviewerDispatch(h: FakeHost, sessionID: string): Promise<void> {
  await callTool(h, "execute.before", {
    tool: "task",
    sessionID,
    input: { agent: "reviewer", prompt: "review it" },
  })
}

/** Dispatches a one-shot executor task for `sessionID`. */
async function executorDispatch(h: FakeHost, sessionID: string): Promise<void> {
  await callTool(h, "execute.before", {
    tool: "task",
    sessionID,
    input: { agent: "executor", prompt: "do the work" },
  })
}

/** Invokes the compaction hook and returns its injected `system` entries —
 *  the only surface that renders the live ledger bucket's waiver state, so
 *  a test can assert what the bucket holds without re-deriving it. */
async function compact(
  h: FakeHost,
  sessionID: string,
): Promise<Array<{ type: string; text?: string }>> {
  const system: Array<{ type: string; text?: string }> = []
  await callSession(h, "compaction", { system, sessionID })
  return system
}

/** The snapshot is the second `draft.system` entry, or "" when absent. */
function snapshotOf(system: Array<{ type: string; text?: string }>): string {
  return system.length > 1 ? (system[1]!.text ?? "") : ""
}

/**
 * A same-worktree continuation prompt carries an earned gate across the reset:
 * the worktree fingerprint stamped on the establishing prompt equals the
 * continuation's, an earned `hasGatePass` survives via the carried
 * `replayGrace`, the reviewer dispatch is not blocked, and a `continuation`
 * journal entry records the carry.
 */
test("a same-worktree continuation prompt carries an earned gate across the reset", async () => {
  const { h, metricsDir, restore } = await bootWithPlan({
    continuationCarry: true,
    gateEvidence: "flag",
  })
  try {
    // The establishing prompt stamps the worktree fingerprint for the parent.
    await callSession(h, "prompt", { sessionID: "p1", text: "please start the task" })
    // Earn the gate with a green test-runner result.
    await earnGate(h, "p1")
    // A continuation prompt re-admits the same worktree/branch.
    await callSession(h, "prompt", { sessionID: "p1", text: "please also run lint" })
    // The carry keeps the gate green: the reviewer dispatch is not blocked.
    await reviewerDispatch(h, "p1")
    assert.ok(
      journalEntries(metricsDir).some((l) => l.type === "continuation" && l.sessionID === "p1"),
    )
    // A second green run after the carried prompt also carries: the
    // fingerprint is re-stamped on every enabled prompt, so repeated
    // continuations keep the gate green.
    await earnGate(h, "p1")
    await callSession(h, "prompt", { sessionID: "p1", text: "one more follow-up" })
    await reviewerDispatch(h, "p1")
  } finally {
    restore()
  }
})

/**
 * With continuation carry off (the default), a prompt reset wipes an earned
 * gate exactly like any other prompt: the reviewer dispatch is blocked with
 * the exact no-gate-pass message and no `continuation` entry is journaled.
 */
test("a continuation prompt with continuation carry off resets the gate like any prompt", async () => {
  const { h, metricsDir, restore } = await bootWithPlan({ gateEvidence: "flag" })
  try {
    await callSession(h, "prompt", { sessionID: "p1", text: "please start the task" })
    await earnGate(h, "p1")
    await callSession(h, "prompt", { sessionID: "p1", text: "please also run lint" })
    await assert.rejects(
      reviewerDispatch(h, "p1"),
      (e: Error) => e.message === NO_GATE_MESSAGE && e instanceof BlockError,
    )
    assert.ok(!journalEntries(metricsDir).some((l) => l.type === "continuation"))
  } finally {
    restore()
  }
})

/**
 * A first prompt with no prior gate carries nothing even when continuation
 * carry is on: there is no earned gate to carry, so the reviewer dispatch stays
 * blocked and no `continuation` entry is journaled.
 */
test("a first prompt before any gate carries nothing even with continuation carry on", async () => {
  const { h, metricsDir, restore } = await bootWithPlan({
    continuationCarry: true,
    gateEvidence: "flag",
  })
  try {
    await callSession(h, "prompt", { sessionID: "p1", text: "please also run lint" })
    await assert.rejects(
      reviewerDispatch(h, "p1"),
      (e: Error) => e.message === NO_GATE_MESSAGE && e instanceof BlockError,
    )
    assert.ok(!journalEntries(metricsDir).some((l) => l.type === "continuation"))
  } finally {
    restore()
  }
})

/**
 * A continuation prompt that re-admits in a DIFFERENT worktree/branch does not
 * carry: the live fingerprint (the moved project directory) no longer matches
 * the one stamped on the establishing prompt, so the reset wipes the earned
 * gate exactly like a new task: the reviewer dispatch is blocked with the exact
 * no-gate-pass message and no `continuation` entry is journaled.
 */
test("a continuation prompt in a changed worktree resets the gate like any prompt", async () => {
  const { h, metricsDir, restore } = await bootWithPlan({
    continuationCarry: true,
    gateEvidence: "flag",
  })
  try {
    await callSession(h, "prompt", { sessionID: "p1", text: "please start the task" })
    await earnGate(h, "p1")
    // A root session.created carrying a foreign directory re-seeds the
    // session's cached directory to a different worktree (it maps from
    // location.directory on a parent-less created event); the companion error
    // is a deterministic signal that the event loop consumed the created
    // event first.
    const otherDir = tmpDir("turnstile-mismatch-")
    h.pushEvent({
      type: "session.created",
      data: { sessionID: "p1", location: { directory: otherDir } },
    })
    h.pushEvent({ type: "session.error", data: { sessionID: "p1", error: "dir-change" } })
    await waitUntil(() =>
      journalEntries(metricsDir).some((l) => l.type === "error" && l.error === "dir-change"),
    )
    await callSession(h, "prompt", { sessionID: "p1", text: "please also run lint" })
    await assert.rejects(
      reviewerDispatch(h, "p1"),
      (e: Error) => e.message === NO_GATE_MESSAGE && e instanceof BlockError,
    )
    assert.ok(!journalEntries(metricsDir).some((l) => l.type === "continuation"))
  } finally {
    restore()
  }
})

/**
 * A same-worktree continuation prompt carries a live scoped waiver across
 * the reset: the establishing prompt's waiver (scoped to a stage outside the
 * plan gate's group) survives the grace reset, so the compaction snapshot
 * still reports it live and an out-of-scope plan-gate block appends the
 * out-of-scope clause rather than the no-waiver message — the block message
 * agrees with what the carried bucket holds.
 */
test("a continuation prompt carries a live scoped waiver across the reset", async () => {
  const { h, metricsDir, restore } = await bootWithPlan({
    continuationCarry: true,
    gateEvidence: "flag",
  })
  try {
    // The establishing prompt mints a waiver scoped to the planner stage —
    // outside the plan gate's stage group (plan-reviewer / executor).
    await callSession(h, "prompt", {
      sessionID: "p1",
      text: "USER WAIVER: skip the planner; start",
    })
    // Earn the gate the carry predicate keys off.
    await earnGate(h, "p1")
    // The continuation prompt re-admits the same worktree without restating
    // the marker.
    await callSession(h, "prompt", { sessionID: "p1", text: "please also run lint" })
    assert.ok(
      journalEntries(metricsDir).some((l) => l.type === "continuation" && l.sessionID === "p1"),
    )
    // The carried bucket still holds the live waiver: the snapshot renders
    // it active with its carried scope.
    const system = await compact(h, "p1")
    assert.match(snapshotOf(system), /- waiver: ACTIVE\(planner\) human: none/)
    // And the out-of-scope plan-gate block reports the live waiver instead
    // of dropping the family.
    await assert.rejects(
      executorDispatch(h, "p1"),
      (e: Error) =>
        e instanceof BlockError && e.message === NO_PLAN_MESSAGE + PLAN_OUT_OF_SCOPE_PLANNER_CLAUSE,
    )
  } finally {
    restore()
  }
})

/**
 * A continuation prompt restating an unscoped waiver over a carried scoped
 * one resets the scope to unscoped: the establishing prompt mints a waiver
 * scoped to the planner stage, the continuation prompt restates the marker
 * without naming any configured agent, and the carried scope is overwritten
 * by the parse result (empty array = unscoped) — the snapshot renders the
 * waiver active with no scope, and an in-scope executor dispatch is
 * admitted because the unscoped waiver now covers every stage.
 */
test("a continuation prompt restating an unscoped waiver resets the carried scope", async () => {
  const { h, metricsDir, restore } = await bootWithPlan({
    continuationCarry: true,
    gateEvidence: "flag",
  })
  try {
    // The establishing prompt mints a waiver scoped to the planner stage.
    await callSession(h, "prompt", {
      sessionID: "p1",
      text: "USER WAIVER: skip the planner; start",
    })
    // Earn the gate the carry predicate keys off.
    await earnGate(h, "p1")
    // The continuation prompt restates the marker without naming any
    // configured agent — the parse yields an empty scope.
    await callSession(h, "prompt", {
      sessionID: "p1",
      text: "USER WAIVER: start now",
    })
    assert.ok(
      journalEntries(metricsDir).some((l) => l.type === "continuation" && l.sessionID === "p1"),
    )
    // The scope resets to unscoped: the snapshot renders the waiver active
    // with no scope in parentheses.
    const system = await compact(h, "p1")
    assert.match(snapshotOf(system), /waiver: ACTIVE human: none/)
    // The unscoped waiver now covers the plan gate's stages: the executor
    // dispatch is admitted rather than blocked.
    await executorDispatch(h, "p1")
  } finally {
    restore()
  }
})
