/**
 * @fileoverview Requirements-phase tests: the optional, config-gated,
 * ungated pre-planner requirements leg. Covers the config surface (defaults
 * off, merge validation for the boolean arming key, the numeric cap, and the
 * agents key), the conditional policy text (absent by default — the default
 * policy stays byte-identical — present with the cap interpolated when on),
 * the budget leg (cap blocks with the loop-cap message, waiver exemption,
 * counters advance), the metering-counter clearing, the pipeline-status
 * requirements→planner edge, and the agent-name registration.
 */

import { test } from "node:test"
import assert from "node:assert/strict"

import { BlockError } from "../src/gates.ts"
import { turnstile } from "../turnstile.ts"
import { defaultConfig, mergeConfig } from "../src/config.ts"
import { orchestratorPolicyFor } from "../src/policy.ts"
import { clearMeteringCounters, formatPipelineStatus, newState } from "../src/state.ts"
import { isPipelineChildDispatch } from "../src/child-registration.ts"
import {
  callSession,
  callTool,
  expectedPolicy,
  isolatedEnv,
  journalEntries,
  makeFakeHost,
  tmpDir,
  type FakeHost,
} from "./helpers.ts"

/** Boots the plugin over a fake host with a temp metrics dir and the given
 *  config override. */
async function boot(
  config: Record<string, any> = {},
): Promise<{ h: FakeHost; dispose: () => void; metricsDir: string }> {
  const metricsDir = tmpDir()
  const h = makeFakeHost()
  const setup = turnstile(h.host, {
    env: isolatedEnv(metricsDir),
    config: { metricsDir, alwaysEnforce: true, ...config },
  })
  const dispose = (await setup(h.host)) as () => void
  return { h, dispose, metricsDir }
}

/** Invokes a dispatch of the named agent; resolves when it passes, rejects on
 *  a `BlockError`. */
async function dispatch(
  h: FakeHost,
  sessionID: string,
  agent: string,
  prompt = "go",
): Promise<void> {
  await callTool(h, "execute.before", {
    tool: "task",
    sessionID,
    input: { agent, prompt },
  })
}

/** Requirements loop-cap block message at cap 2. */
const REQUIREMENTS_LOOP_CAP_MESSAGE =
  "BLOCKED by turnstile: requirements dispatch limit (2) reached this task — the pipeline is looping. " +
  "STOP: do not re-dispatch requirements. Escalate to the user: report the repeated requirements " +
  "failures and wait for new instructions (a new task resets the caps; raise maxRequirementsRounds in your config to widen the cap)."

/** The default config keeps the phase off with the cap and agent name set. */
test("requirements phase config: defaults are off", () => {
  const config = defaultConfig({})
  assert.equal(config.requirementsPhase, false)
  assert.equal(config.maxRequirementsRounds, 2)
  assert.equal(config.agents.requirements, "requirements")
})

/** The default policy text stays byte-identical: no requirements section and
 *  the original five-stage pipeline order line. */
test("policy: the requirements section is absent when the phase is off", () => {
  const policy = expectedPolicy()
  assert.ok(!policy.includes("Requirements phase:"), "no requirements section by default")
  assert.ok(
    policy.includes("Pipeline order: planner → plan-reviewer → executor → test-runner → reviewer."),
    "the default pipeline order line is unchanged",
  )
  assert.ok(
    !policy.includes("requirements → planner"),
    "the requirements leg is not named in the default order line",
  )
})

/** With the phase on, the policy carries the requirements section with the
 *  cap interpolated and the six-stage order line with the skip criterion. */
test("policy: the requirements section and order line appear when the phase is on", () => {
  const policy = expectedPolicy({ requirementsPhase: true })
  assert.ok(policy.includes("Requirements phase:"), "the section is present")
  assert.ok(policy.includes("capped at 2 dispatches per task"), "the leg cap is interpolated")
  assert.ok(
    policy.includes(
      "Pipeline order: requirements → planner → plan-reviewer → executor → test-runner → reviewer",
    ),
    "the order line names the requirements leg first",
  )
  assert.ok(
    policy.includes("Trivial tasks (small fixes, renames, doc/config changes) skip the leg"),
    "the trivial-task skip criterion is stated",
  )
  assert.ok(
    policy.includes(
      "passing the finalized spec VERBATIM at the top of the planner dispatch prompt",
    ),
    "the verbatim spec hand-off is stated",
  )
  assert.ok(
    policy.includes("present them to the user and stop"),
    "the Open Questions relay is stated",
  )
})

/** A boolean requirementsPhase merges; a non-boolean is rejected with the
 *  generic keeping-default warning. */
test("merge: requirementsPhase validates as a boolean", () => {
  const base = defaultConfig({})
  const ok = mergeConfig(base, { requirementsPhase: true })
  assert.equal(ok.config.requirementsPhase, true)
  assert.deepEqual(ok.warnings, [])
  const bad = mergeConfig(base, { requirementsPhase: 1 })
  assert.equal(bad.config.requirementsPhase, false)
  assert.deepEqual(bad.warnings, ['config: invalid value for "requirementsPhase"; keeping default'])
})

/** maxRequirementsRounds is a positive-integer cap: valid overrides merge,
 *  zero and non-numbers are rejected with the generic warning. */
test("merge: maxRequirementsRounds validates as a positive integer", () => {
  const base = defaultConfig({})
  const ok = mergeConfig(base, { maxRequirementsRounds: 5 })
  assert.equal(ok.config.maxRequirementsRounds, 5)
  assert.deepEqual(ok.warnings, [])
  for (const value of [0, -1, 1.5, "2", null]) {
    const bad = mergeConfig(base, { maxRequirementsRounds: value })
    assert.equal(bad.config.maxRequirementsRounds, 2)
    assert.deepEqual(bad.warnings, [
      'config: invalid value for "maxRequirementsRounds"; keeping default',
    ])
  }
})

/** agents.requirements merges as a non-empty string; a non-string keeps the
 *  default with the standard agents warning. */
test("merge: agents.requirements validates as a non-empty string", () => {
  const base = defaultConfig({})
  const ok = mergeConfig(base, { agents: { requirements: "req" } })
  assert.equal(ok.config.agents.requirements, "req")
  assert.deepEqual(ok.warnings, [])
  const bad = mergeConfig(base, { agents: { requirements: 42 } })
  assert.equal(bad.config.agents.requirements, "requirements")
  assert.ok(
    bad.warnings.includes(
      "config: agents.requirements must be a non-empty string; keeping default",
    ),
  )
})

/** With maxRequirementsRounds: 2 the first two requirements dispatches pass
 *  and count; the third is blocked with the exact loop-cap message and
 *  journals the paired blocked + escalation entries. */
test("requirements leg: cap blocks with the loop-cap message and escalates", async () => {
  const { h, dispose, metricsDir } = await boot({ maxRequirementsRounds: 2 })
  await dispatch(h, "p1", "requirements")
  await dispatch(h, "p1", "requirements")
  await assert.rejects(
    () => dispatch(h, "p1", "requirements", "loop again"),
    (e: Error) => e instanceof BlockError && e.message === REQUIREMENTS_LOOP_CAP_MESSAGE,
  )
  const entries = journalEntries(metricsDir)
  assert.ok(
    entries.some(
      (l) =>
        l.type === "blocked" &&
        l.reason === "loop-cap" &&
        l.leg === "requirements" &&
        l.count === 2 &&
        l.cap === 2,
    ),
    "the loop-cap block pins the requirements leg at count 2",
  )
  assert.ok(
    entries.some((l) => l.type === "escalation" && l.reason === "loop-cap" && l.count === 2),
    "the paired escalation entry is journaled",
  )
  dispose()
})

/** A live prompt-channel waiver exempts the requirements leg without
 *  counting: dispatches far past the cap all pass and journal no block. */
test("requirements leg: a waiver exempts the cap without counting", async () => {
  const { h, dispose, metricsDir } = await boot({ maxRequirementsRounds: 2 })
  await callSession(h, "prompt", { sessionID: "p1", text: "USER WAIVER: ship it" })
  for (let i = 0; i < 4; i++) await dispatch(h, "p1", "requirements")
  const entries = journalEntries(metricsDir)
  assert.ok(!entries.some((l) => l.type === "blocked"), "no blocked entry under the waiver")
  assert.ok(!entries.some((l) => l.type === "escalation"), "no escalation under the waiver")
  dispose()
})

/** clearMeteringCounters includes the requirements counter: a non-fresh
 *  requirementsRounds reports metering and resets to 0. */
test("clearMeteringCounters resets the requirements counter and reports metering", () => {
  const s = newState()
  assert.equal(clearMeteringCounters(s), false, "a fresh bucket is not metering")
  s.requirementsRounds = 1
  assert.equal(clearMeteringCounters(s), true, "a set requirements counter reports metering")
  assert.equal(s.requirementsRounds, 0, "the counter resets to 0")
})

/** The pipeline status names the planner as the successor when the optional
 *  requirements stage just completed; stages without the field are
 *  unaffected. */
test("pipeline-status: a completed requirements stage names the planner", () => {
  const line = formatPipelineStatus(
    newState(),
    {
      planner: "planner",
      planReviewer: "plan-reviewer",
      executor: "executor",
      testRunner: "test-runner",
      reviewer: "reviewer",
      requirements: "requirements",
    },
    "requirements",
  )
  assert.ok(line.includes("next=planner"), "the requirements leg hands off to the planner")
  assert.ok(line.startsWith("PIPELINE: requirements=done"), "the leg is named done")
  // Without the optional field the name is not a stage: no line.
  const stagesNoReq = {
    planner: "planner",
    planReviewer: "plan-reviewer",
    executor: "executor",
    testRunner: "test-runner",
    reviewer: "reviewer",
  }
  assert.equal(
    formatPipelineStatus(newState(), stagesNoReq, "requirements"),
    "",
    "without the optional field the name renders no line",
  )
})

/** The requirements agent name is a pipeline-child dispatch name once
 *  registered (the conservative-exclusion set includes it). */
test("child-registration: the requirements name is a pipeline child", () => {
  const names = new Set([
    "reviewer",
    "plan-reviewer",
    "executor",
    "test-runner",
    "debugger",
    "planner",
    "requirements",
  ])
  assert.equal(isPipelineChildDispatch("requirements", names), true)
  assert.equal(isPipelineChildDispatch("general", names), false)
})

/** The orchestrator policy builder over the raw default config slice keeps
 *  the phase off: the section is absent even when built directly (not via
 *  mergeConfig), pinning the byte-identity contract at the source. */
test("policy: building from the raw default config slice stays phase-free", () => {
  const config = defaultConfig({})
  const policy = orchestratorPolicyFor(config)
  assert.ok(!policy.includes("Requirements phase:"))
})
