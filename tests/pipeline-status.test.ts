/**
 * @fileoverview Pure-formatter tests for the per-delivery pipeline status line
 * (`formatPipelineStatus`): the successor table for every pipeline stage
 * (including the BLOCK→planner, FAIL→executor, ensemble→reviewer,
 * APPROVE→land, and cap→escalate branches), the config-renamed-stage case
 * (successor names route through `config.agents` values, never hardcoded),
 * the reviewer ensemble count rendering both `/REVIEW_ENSEMBLE_SIZE` sides,
 * the gate flags rendering from live `GateState`, the empty-string skip for
 * non-stage agents (debugger, unknown, and empty name), and the echo-safety
 * invariant that no rendered line ever parses as a `GATE:`/`VERDICT:` marker.
 * The formatter is a pure read of `GateState`, so no host, journal, or
 * filesystem is needed.
 */

import { test } from "node:test"
import assert from "node:assert/strict"

import {
  formatPipelineStatus,
  newState,
  REVIEW_ENSEMBLE_SIZE,
  type PipelineStages,
} from "../src/state.ts"
import type { GateState } from "../src/types.ts"
import { GATE_RE, VERDICT_RE } from "../src/markers.ts"

/** The default configured agent names (mirrors `defaultConfig().agents`). */
const DEFAULT_STAGES: PipelineStages = {
  planner: "planner",
  planReviewer: "plan-reviewer",
  executor: "executor",
  testRunner: "test-runner",
  reviewer: "reviewer",
}

/**
 * Builds a `PipelineStages` from the defaults with the given overrides, so a
 * renamed install can be modeled without restating every stage.
 * @param overrides Stage names to replace the defaults.
 * @returns The resulting stage-name table.
 */
function stagesOf(overrides: Partial<PipelineStages> = {}): PipelineStages {
  return { ...DEFAULT_STAGES, ...overrides }
}

/**
 * Builds a fresh gate state with the given flag overrides applied, so a
 * specific pipeline moment can be asserted in isolation.
 * @param overrides GateState fields to set on the fresh bucket.
 * @returns The constructed gate state.
 */
function stateOf(overrides: Partial<GateState> = {}): GateState {
  return { ...newState(), ...overrides }
}

/** (1) A fresh-state planner delivery names the plan-reviewer as next. */
test("pipeline-status: a fresh planner delivery names the plan-reviewer", () => {
  const line = formatPipelineStatus(stateOf(), DEFAULT_STAGES, "planner")
  assert.equal(
    line,
    "PIPELINE: planner=done plan=PENDING tests=RED reviewer=0/2 next=plan-reviewer — " +
      "dispatch the next agent in this same turn",
  )
})

/** (2) A plan-reviewer delivery with no verdict credited re-dispatches the
 *  planner (the BLOCK → re-plan branch). */
test("pipeline-status: a plan-reviewer without a credited verdict re-dispatches the planner", () => {
  const line = formatPipelineStatus(stateOf(), DEFAULT_STAGES, "plan-reviewer")
  assert.ok(line.includes("next=planner"), "a BLOCK re-dispatches the planner")
  assert.ok(line.startsWith("PIPELINE: plan-reviewer=done"), "the just-completed stage is named")
})

/** (3) A plan-reviewer delivery with a credited verdict names the executor
 *  (the APPROVE → implement branch). */
test("pipeline-status: a plan-reviewer with a credited verdict names the executor", () => {
  const line = formatPipelineStatus(
    stateOf({ hasPlanVerdict: true }),
    DEFAULT_STAGES,
    "plan-reviewer",
  )
  assert.ok(line.includes("next=executor"), "an APPROVE names the executor")
  assert.ok(line.includes("plan=APPROVED"), "the plan flag renders APPROVED from live state")
})

/** (4) An executor delivery names the test-runner. */
test("pipeline-status: an executor delivery names the test-runner", () => {
  const line = formatPipelineStatus(stateOf(), DEFAULT_STAGES, "executor")
  assert.ok(line.includes("next=test-runner"), "an executor names the test-runner")
  assert.ok(line.startsWith("PIPELINE: executor=done"), "the just-completed stage is named")
})

/** (5) A test-runner delivery with a red gate re-dispatches the executor
 *  (the FAIL → re-run branch). */
test("pipeline-status: a test-runner with a red gate re-dispatches the executor", () => {
  const line = formatPipelineStatus(stateOf(), DEFAULT_STAGES, "test-runner")
  assert.ok(line.includes("next=executor"), "a red gate re-dispatches the executor")
  assert.ok(line.includes("tests=RED"), "the test flag renders RED from live state")
})

/** (6) A test-runner delivery with a green gate names the reviewer. */
test("pipeline-status: a test-runner with a green gate names the reviewer", () => {
  const line = formatPipelineStatus(stateOf({ hasGatePass: true }), DEFAULT_STAGES, "test-runner")
  assert.ok(line.includes("next=reviewer"), "a green gate names the reviewer")
  assert.ok(line.includes("tests=GREEN"), "the test flag renders GREEN from live state")
})

/** (7) A reviewer delivery below the ensemble count re-dispatches the
 *  reviewer (the ensemble → second dispatch branch). */
test("pipeline-status: a reviewer below the ensemble count re-dispatches the reviewer", () => {
  const line = formatPipelineStatus(stateOf({ reviewerDispatches: 1 }), DEFAULT_STAGES, "reviewer")
  assert.ok(line.includes("next=reviewer"), "an incomplete ensemble re-dispatches the reviewer")
  assert.ok(line.includes(`reviewer=1/${REVIEW_ENSEMBLE_SIZE}`), "the ensemble count renders")
})

/** (8) A reviewer delivery with a credited APPROVE names the landing
 *  (the APPROVE → land branch) with the land tail. */
test("pipeline-status: a reviewer with a credited APPROVE names the landing", () => {
  const line = formatPipelineStatus(
    stateOf({ hasReviewApprove: true, reviewerDispatches: 2 }),
    DEFAULT_STAGES,
    "reviewer",
  )
  assert.ok(line.includes("next=land"), "a credited APPROVE names the landing")
  assert.ok(line.endsWith("— task complete; land through the gated push"), "the land tail is used")
})

/** (9) A reviewer delivery with the ensemble exhausted and no APPROVE names
 *  the escalation (the cap → escalate branch) with the escalate tail. */
test("pipeline-status: an exhausted ensemble without an APPROVE names the escalation", () => {
  const line = formatPipelineStatus(stateOf({ reviewerDispatches: 2 }), DEFAULT_STAGES, "reviewer")
  assert.ok(line.includes("next=escalate"), "an exhausted ensemble escalates")
  assert.ok(line.endsWith("— escalate to the user"), "the escalate tail is used")
})

/** (10) Non-stage agents render no line: the debugger, an unknown name, and
 *  the empty name all skip the append entirely. */
test("pipeline-status: non-stage agents render no line", () => {
  assert.equal(formatPipelineStatus(stateOf(), DEFAULT_STAGES, "debugger"), "")
  assert.equal(formatPipelineStatus(stateOf(), DEFAULT_STAGES, "build"), "")
  assert.equal(formatPipelineStatus(stateOf(), DEFAULT_STAGES, ""), "")
})

/** (11) A config-renamed executor routes through its configured value: the
 *  line names the renamed stage as done and the test-runner's failed-gate
 *  successor resolves to the renamed executor, never a hardcoded "executor". */
test("pipeline-status: a renamed stage routes through its configured value", () => {
  const stages = stagesOf({ executor: "implementer" })
  const doneLine = formatPipelineStatus(stateOf(), stages, "implementer")
  assert.ok(doneLine.startsWith("PIPELINE: implementer=done"), "the renamed stage is named done")
  assert.ok(doneLine.includes("next=test-runner"), "its successor is the test-runner")
  const failedLine = formatPipelineStatus(stateOf(), stages, "test-runner")
  assert.ok(
    failedLine.includes("next=implementer"),
    "the test-runner's failed-gate successor is the renamed executor",
  )
})

/** (12) The reviewer ensemble count renders both `/REVIEW_ENSEMBLE_SIZE`
 *  sides for each live count. */
test("pipeline-status: the reviewer count renders both ensemble sides", () => {
  for (const count of [0, 1, 2]) {
    const line = formatPipelineStatus(
      stateOf({ reviewerDispatches: count }),
      DEFAULT_STAGES,
      "reviewer",
    )
    assert.ok(
      line.includes(`reviewer=${count}/${REVIEW_ENSEMBLE_SIZE}`),
      `count ${count} renders reviewer=${count}/${REVIEW_ENSEMBLE_SIZE}`,
    )
  }
})

/** (13) No rendered line ever parses as a `GATE:` or `VERDICT:` marker, even
 *  with the `g` flag stripped (the stateful-`.test` guard the production
 *  matcher does not need). Every stage and a spread of flag states is
 *  covered. */
test("pipeline-status: no rendered line parses as a GATE or VERDICT marker", () => {
  const gateRe = new RegExp(GATE_RE.source)
  const verdictRe = new RegExp(VERDICT_RE.source)
  const states = [
    stateOf(),
    stateOf({ hasPlanVerdict: true }),
    stateOf({ hasGatePass: true }),
    stateOf({ hasReviewApprove: true, reviewerDispatches: 2 }),
    stateOf({ reviewerDispatches: 1 }),
  ]
  const stagesList = ["planner", "plan-reviewer", "executor", "test-runner", "reviewer"]
  for (const s of states) {
    for (const stage of stagesList) {
      const line = formatPipelineStatus(s, DEFAULT_STAGES, stage)
      assert.ok(line !== "", "a pipeline stage always renders a line")
      assert.ok(!gateRe.test(line), `never a GATE marker: ${line}`)
      assert.ok(!verdictRe.test(line), `never a VERDICT marker: ${line}`)
    }
  }
})

/** (14) The formatter is a pure read: the same input renders the same line
 *  and never mutates the gate state it reads. */
test("pipeline-status: the formatter is a pure read of gate state", () => {
  const s = stateOf({ hasGatePass: true, reviewerDispatches: 1 })
  const before = JSON.stringify({
    hasGatePass: s.hasGatePass,
    hasPlanVerdict: s.hasPlanVerdict,
    hasReviewApprove: s.hasReviewApprove,
    reviewerDispatches: s.reviewerDispatches,
  })
  const a = formatPipelineStatus(s, DEFAULT_STAGES, "test-runner")
  const b = formatPipelineStatus(s, DEFAULT_STAGES, "test-runner")
  assert.equal(a, b, "the same input renders the same line")
  const after = JSON.stringify({
    hasGatePass: s.hasGatePass,
    hasPlanVerdict: s.hasPlanVerdict,
    hasReviewApprove: s.hasReviewApprove,
    reviewerDispatches: s.reviewerDispatches,
  })
  assert.equal(before, after, "the gate state is unmutated")
})
