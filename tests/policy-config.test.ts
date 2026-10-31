/**
 * @fileoverview Orchestrator policy builder tests: the configured loop caps,
 * dispatch budget, prompt markers, and metrics directory interpolate verbatim
 * into the injected text (the default digits are absent once customized),
 * the default build keeps the documented two-paragraph / eleven-section
 * shape with the default digits, and the text stays echo-safe at custom
 * values (every backticked GATE/VERDICT template parses only after `<n>`
 * substitution; the raw text never parses into a marker).
 */

import { test } from "node:test"
import assert from "node:assert/strict"

import { GATE_RE, VERDICT_RE, parseGateMarkers } from "../src/markers.ts"
import { newState } from "../src/state.ts"
import { expectedPolicy } from "./helpers.ts"

/** 1. Customized caps and the dispatch budget appear verbatim in the text,
 *  and the default digits are absent from a customized build. */
test("policy config: custom caps and the dispatch budget interpolate verbatim", () => {
  const policy = expectedPolicy({
    maxReviewerRounds: 5,
    maxPlannerRounds: 7,
    maxPlanReviewerRounds: 1,
    maxTestRunnerRounds: 9,
    maxTotalDispatches: 40,
  })
  assert.ok(policy.includes("max 5 reviewer dispatches"), "the reviewer cap is interpolated")
  assert.ok(
    policy.includes("(5 waiver-unblocked dispatches)"),
    "the reviewer waiver allowance is interpolated",
  )
  assert.ok(policy.includes("(7/1/9)"), "the per-stage caps are interpolated")
  assert.ok(
    policy.includes("total dispatch budget (40)"),
    "the total dispatch budget is interpolated",
  )
  assert.ok(!policy.includes("max 2 reviewer dispatches"), "the default reviewer cap is absent")
  assert.ok(!policy.includes("(3/3/4)"), "the default per-stage caps are absent")
  assert.ok(!policy.includes("(16)"), "the default dispatch budget is absent")
})

/** 2. Custom waiver and approval markers replace the defaults everywhere the
 *  text names them (the waivers line and the plan-gate line). */
test("policy config: custom waiver and approval markers replace the defaults", () => {
  const policy = expectedPolicy({ waiverMarker: "WAIVE:", approvalMarker: "APPROVE PLAN:" })
  assert.ok(policy.includes("`WAIVE: <your words>`"), "the custom waiver marker is interpolated")
  assert.ok(
    policy.includes("`APPROVE PLAN: <your words>`"),
    "the custom approval marker is interpolated",
  )
  assert.ok(
    policy.includes("a `APPROVE PLAN:` in the user's prompt"),
    "the plan gate names the custom approval marker",
  )
  assert.ok(policy.includes("or a `WAIVE:` waiver"), "the plan gate names the custom waiver marker")
  assert.ok(!policy.includes("USER WAIVER:"), "the default waiver marker is absent")
  assert.ok(!policy.includes("PLAN APPROVED:"), "the default approval marker is absent")
})

/** 3. The configured metrics directory renders both journal paths (the
 *  human-readable trace and the JSONL journal); the stale tilde literal is
 *  gone from the text. */
test("policy config: the custom metrics dir renders both journal paths without the tilde literal", () => {
  const dir = "/srv/turnstile/metrics"
  const policy = expectedPolicy({ metricsDir: dir })
  assert.ok(policy.includes(`${dir}/gate-events.log`), "the trace path uses the configured dir")
  assert.ok(policy.includes(`${dir}/turnstile.jsonl`), "the journal path uses the configured dir")
  assert.ok(!policy.includes("~/.local/share"), "the tilde literal is gone")
})

/** 4. The default build keeps the documented shape: an opening paragraph, a
 *  blank line, then eleven section lines in pipeline order, and the default
 *  enforcement digits render. */
test("policy config: the default build keeps the two-paragraph, eleven-section shape", () => {
  const policy = expectedPolicy()
  const paragraphs = policy.split("\n\n")
  assert.equal(paragraphs.length, 2, "exactly one blank line separates the paragraphs")
  const [opening, body] = paragraphs
  assert.ok(opening, "the opening paragraph is present")
  assert.ok(body, "the section body is present")
  const lines = body!.split("\n")
  assert.equal(lines.length, 11, "one line per section")
  const labels = [
    "Pipeline order:",
    "Continuation (imperative):",
    "Waivers and approvals:",
    "Plan gate:",
    "Human-approval escalation:",
    "Dispatch gate:",
    "Marker parsing (orchestrator):",
    "Reviewer ensemble:",
    "Worktree/commit:",
    "Trace (works with the plugin off):",
    "Verification:",
  ]
  lines.forEach((line, i) => {
    assert.ok(line.startsWith(labels[i]!), `section ${i + 1} is ${labels[i]}`)
  })
  assert.ok(policy.includes("max 2 reviewer dispatches"), "the default reviewer cap renders")
  assert.ok(
    policy.includes("(2 waiver-unblocked dispatches)"),
    "the default reviewer allowance renders",
  )
  assert.ok(policy.includes("(3/3/4)"), "the default per-stage caps render")
  assert.ok(policy.includes("total dispatch budget (16)"), "the default budget renders")
})

/** 5. Echo-safety at custom values: every backticked GATE/VERDICT template
 *  still parses after `<n>` substitution, and the raw text — now carrying
 *  custom numeric caps — never parses into a marker. */
test("policy config: the text stays echo-safe with custom numeric values", () => {
  const policy = expectedPolicy({
    maxReviewerRounds: 7,
    maxPlannerRounds: 11,
    maxPlanReviewerRounds: 13,
    maxTestRunnerRounds: 17,
    maxTotalDispatches: 23,
  })
  // Mirror scripts/check-markers.mjs: strip the `g` flag for stateful .test,
  // extract each backticked GATE:/VERDICT: template, substitute <n>→1, and
  // assert it parses under its canonical regex.
  const gateRe = new RegExp(GATE_RE.source)
  const verdictRe = new RegExp(VERDICT_RE.source)
  const templates = [...policy.matchAll(/`((?:GATE|VERDICT): [^\n`]*)`/g)]
  assert.ok(templates.length >= 1, "the policy carries GATE/VERDICT templates")
  for (const m of templates) {
    const line = m[1]!.replaceAll("<n>", "1")
    const re = line.startsWith("GATE") ? gateRe : verdictRe
    assert.ok(re.test(line), `template parses after substitution: ${line.slice(0, 40)}`)
  }
  const echoed = parseGateMarkers(newState(), policy, GATE_RE, VERDICT_RE)
  assert.equal(echoed.length, 0, "the raw text never parses into a marker")
})
