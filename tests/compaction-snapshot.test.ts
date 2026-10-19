/**
 * @fileoverview Compaction-snapshot tests: the pure snapshot renderer
 * (`formatGateSnapshot`), the marker de-tokenizer (`deTokenizeMarker`), and the
 * compaction hook's end-to-end behavior — injecting the concrete gate state
 * from the live ledger alongside the preserve-verbatim instruction. The hook
 * cases boot the plugin over a fake host so the delivered `GATE: PASS` and
 * `VERDICT: APPROVE` actually flip the ledger flags the assertions read.
 */

import { test } from "node:test"
import assert from "node:assert/strict"
import * as fs from "node:fs"
import * as path from "node:path"

import { turnstile } from "../turnstile.ts"
import { newState, formatGateSnapshot } from "../src/state.ts"
import { deTokenizeMarker } from "../src/markers.ts"
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

/**
 * Boots the plugin in an isolated temp project with a readable plans dir, so
 * the compaction hook hydrates a live ledger bucket from `process.cwd()`.
 * @param config Override config spread over the per-test metrics directory.
 * @returns The fake host, the dispose callback, the metrics directory, and a
 *     `restore` that disposes and returns the cwd.
 */
async function boot(config: Record<string, any> = {}): Promise<{
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
    config: { metricsDir, ...config },
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

/** Admits `sessionID` as a live parent (the establishing prompt). */
async function admit(h: FakeHost, sessionID: string): Promise<void> {
  await callSession(h, "prompt", { sessionID, text: "start the task" })
}

/** Earns a green test gate for `sessionID` via a `GATE: PASS` test-runner result. */
async function earnGate(h: FakeHost, sessionID: string): Promise<void> {
  await callTool(h, "execute.after", {
    tool: "task",
    sessionID,
    input: { agent: "test-runner" },
    result: { output: "GATE: PASS tests=2 passed=2 failed=0\nrest" },
  })
}

/** Delivers a reviewer `VERDICT: APPROVE` for `sessionID`. */
async function reviewerApprove(h: FakeHost, sessionID: string): Promise<void> {
  await callTool(h, "execute.after", {
    tool: "task",
    sessionID,
    input: { agent: "reviewer" },
    result: { output: "VERDICT: APPROVE crit=0 high=0 med=1 low=0\n" },
  })
}

/** Invokes the compaction hook with the given draft and returns its entries. */
async function compact(
  h: FakeHost,
  draft: unknown,
): Promise<Array<{ type: string; text?: string }>> {
  const system: Array<{ type: string; text?: string }> = []
  await callSession(h, "compaction", { system, ...(draft ?? {}) })
  return system
}

/** The snapshot is the second `draft.system` entry, or "" when absent. */
function snapshotOf(system: Array<{ type: string; text?: string }>): string {
  return system.length > 1 ? (system[1]!.text ?? "") : ""
}

/** `formatGateSnapshot` on a fresh bucket renders red/pending/none/unknown. */
test("formatGateSnapshot renders a fresh bucket", () => {
  const lines = formatGateSnapshot(newState()).split("\n")
  assert.match(lines[1]!, /^- gate: RED last=none$/)
  assert.match(lines[2]!, /^- plan: PENDING stamp=unknown$/)
  assert.match(lines[3]!, /^- reviewer: PENDING dispatches=0 last=none$/)
  assert.match(lines[4]!, /^- waiver: none human: none$/)
  assert.match(lines[5]!, /^- rounds: planner=0 plan-reviewer=0 test-runner=0 reviewer=0 total=0$/)
  assert.match(lines[6]!, /^- landing: blocks=0 reads=0$/)
  assert.match(lines[7]!, /^- task: unstamped$/)
})

/** `formatGateSnapshot` on a populated bucket renders every value (true side). */
test("formatGateSnapshot renders a populated bucket", () => {
  const lines = formatGateSnapshot({
    ...newState(),
    hasGatePass: true,
    unverifiedPass: "GATE: PASS tests=1 passed=1 failed=0",
    lastGateMarker: "gate: PASS tests=2 passed=2 failed=0",
    hasPlanVerdict: true,
    plansSignature: "abc123",
    approvedPlan: "z-work.md",
    approvedPlanKey: "abcdef",
    hasReviewApprove: true,
    reviewerDispatches: 3,
    lastVerdictMarker: "verdict: APPROVE crit=0 high=0 med=1 low=0",
    userWaiver: "USER WAIVER: go ahead",
    humanApproval: true,
    plannerRounds: 1,
    planReviewerRounds: 2,
    testRunnerRounds: 4,
    reviewRounds: 5,
    totalDispatches: 12,
    landingBlocks: 2,
    reads: 7,
    taskFingerprint: "wt:main",
  }).split("\n")
  assert.match(
    lines[1]!,
    /^- gate: GREEN last=gate: PASS tests=2 passed=2 failed=0 unverified=GATE: PASS tests=1 passed=1 failed=0$/,
  )
  // The bound plan identity renders a plan=<name> suffix on the plan line.
  assert.match(lines[2]!, /^- plan: APPROVED plan=z-work\.md stamp=known$/)
  assert.match(
    lines[3]!,
    /^- reviewer: APPROVED dispatches=3 last=verdict: APPROVE crit=0 high=0 med=1 low=0$/,
  )
  assert.match(lines[4]!, /^- waiver: ACTIVE human: APPROVED$/)
  assert.match(lines[5]!, /^- rounds: planner=1 plan-reviewer=2 test-runner=4 reviewer=5 total=12$/)
  assert.match(lines[6]!, /^- landing: blocks=2 reads=7$/)
  assert.match(lines[7]!, /^- task: wt:main$/)
})

/** A live scoped waiver renders ACTIVE with its parsed scope, comma-joined. */
test("formatGateSnapshot renders a live scoped waiver as ACTIVE(scope)", () => {
  const lines = formatGateSnapshot({
    ...newState(),
    userWaiver: "USER WAIVER: I approve the reviewer",
    userWaiverScope: ["reviewer"],
  }).split("\n")
  assert.match(lines[4]!, /^- waiver: ACTIVE\(reviewer\) human: none$/)
})

/** A consumed unscoped waiver renders none(consumed), not a bare none. */
test("formatGateSnapshot renders a consumed waiver as none(consumed)", () => {
  const lines = formatGateSnapshot({
    ...newState(),
    userWaiverConsumed: true,
  }).split("\n")
  assert.match(lines[4]!, /^- waiver: none\(consumed\) human: none$/)
})

/**
 * `formatGateSnapshot` on a restart-restored bucket (populated flags but empty
 * marker text, the post-replay shape) renders the flags with `last=none`.
 */
test("formatGateSnapshot renders a restart-restored bucket with last=none", () => {
  const lines = formatGateSnapshot({
    ...newState(),
    hasGatePass: true,
    hasPlanVerdict: true,
    hasReviewApprove: true,
    reviewerDispatches: 2,
    plansSignature: "abc",
    lastGateMarker: "",
    lastVerdictMarker: "",
    taskFingerprint: "wt:main",
  }).split("\n")
  assert.match(lines[1]!, /^- gate: GREEN last=none$/)
  assert.match(lines[2]!, /^- plan: APPROVED stamp=known$/)
  assert.match(lines[3]!, /^- reviewer: APPROVED dispatches=2 last=none$/)
})

/** `deTokenizeMarker` lowercases only the leading `GATE:`/`VERDICT:` token. */
test("deTokenizeMarker lowercases only the leading authority token", () => {
  assert.equal(
    deTokenizeMarker("GATE: PASS tests=2 passed=2 failed=0"),
    "gate: PASS tests=2 passed=2 failed=0",
  )
  assert.equal(
    deTokenizeMarker("VERDICT: APPROVE crit=0 high=0 med=1 low=0"),
    "verdict: APPROVE crit=0 high=0 med=1 low=0",
  )
  assert.equal(
    deTokenizeMarker("VERDICT: BLOCK crit=1 high=2 med=3 low=4"),
    "verdict: BLOCK crit=1 high=2 med=3 low=4",
  )
  // A non-matching prefix is returned unchanged.
  assert.equal(deTokenizeMarker("GATEX: nope"), "GATEX: nope")
  assert.equal(deTokenizeMarker("no token here"), "no token here")
})

/**
 * The compaction hook injects the gate snapshot after a green gate and a
 * reviewer approve: two entries, the instruction first, then a de-tokenized
 * snapshot with no parseable `GATE:`/`VERDICT:` token.
 */
test("compaction injects the gate snapshot after a green gate and reviewer approve", async () => {
  const { h, dispose } = await boot({ gateEvidence: "flag", reviewEnsemble: "advise" })
  try {
    await admit(h, "p1")
    await earnGate(h, "p1")
    await reviewerApprove(h, "p1")
    const system = await compact(h, { sessionID: "p1" })
    assert.equal(system.length, 2)
    assert.match(system[0]!.text ?? "", /Preserve verbatim/)
    const snap = snapshotOf(system)
    assert.match(snap, /turnstile gate snapshot \(live ledger; authoritative; do not re-derive\)/)
    assert.match(snap, /- gate: GREEN last=gate: PASS tests=2 passed=2 failed=0/)
    assert.match(
      snap,
      /- reviewer: APPROVED dispatches=\d+ last=verdict: APPROVE crit=0 high=0 med=1 low=0/,
    )
    // Echo-safety: scoped to the default case-sensitive regexes, so the
    // lowercased token can never re-parse as an authoritative marker.
    assert.doesNotMatch(snap, /GATE: (PASS|FAIL)/)
    assert.doesNotMatch(snap, /VERDICT: (APPROVE|BLOCK)/)
  } finally {
    dispose()
  }
})

/** Compaction with no `sessionID` is instruction-only when no parent was admitted. */
test("compaction with no sessionID is instruction-only when nothing was admitted", async () => {
  const { h, dispose } = await boot()
  try {
    const system = await compact(h, {})
    assert.equal(system.length, 1)
    assert.match(system[0]!.text ?? "", /Preserve verbatim/)
  } finally {
    dispose()
  }
})

/** Compaction with an unknown `sessionID` is instruction-only. */
test("compaction with an unknown sessionID is instruction-only", async () => {
  const { h, dispose } = await boot()
  try {
    await admit(h, "p1")
    const system = await compact(h, { sessionID: "does-not-exist" })
    assert.equal(system.length, 1)
    assert.match(system[0]!.text ?? "", /Preserve verbatim/)
  } finally {
    dispose()
  }
})

/**
 * Compaction falls back to the most-recently-admitted parent when the payload
 * carries no `sessionID`: the admitted `p1` bucket is still injected.
 */
test("compaction falls back to the last-admitted parent when sessionID is absent", async () => {
  const { h, dispose } = await boot({ gateEvidence: "flag" })
  try {
    await admit(h, "p1")
    await earnGate(h, "p1")
    const system = await compact(h, {})
    assert.equal(system.length, 2)
    assert.match(system[0]!.text ?? "", /Preserve verbatim/)
    assert.match(snapshotOf(system), /- gate: GREEN last=gate: PASS tests=2 passed=2 failed=0/)
  } finally {
    dispose()
  }
})

/** The compaction snapshot renders plan approval and the plan-reviewer verdict. */
test("compaction renders plan approval and the de-tokenized plan-reviewer verdict", async () => {
  const { h, dispose, metricsDir } = await boot()
  try {
    await admit(h, "p1")
    // A child edge so the plan-reviewer approval attributes to the parent.
    h.pushEvent({ type: "session.created", data: { sessionID: "c1", parentID: "p1" } })
    h.pushEvent({ type: "session.error", data: { sessionID: "c1", error: "warmup" } })
    await waitUntil(() =>
      journalEntries(metricsDir).some((l) => l.type === "error" && l.error === "warmup"),
    )
    await callTool(h, "execute.after", {
      tool: "task",
      sessionID: "c1",
      input: { agent: "plan-reviewer" },
      result: { output: "VERDICT: APPROVE crit=0 high=0 med=0 low=0\n" },
    })
    const system = await compact(h, { sessionID: "p1" })
    const snap = snapshotOf(system)
    assert.equal(system.length, 2)
    // A plan-reviewer APPROVE arms the plan gate (hasPlanVerdict) and stamps
    // the de-tokenized verdict marker; the landing reviewer gate is untouched.
    assert.match(snap, /- plan: APPROVED /)
    assert.match(
      snap,
      /- reviewer: PENDING dispatches=0 last=verdict: APPROVE crit=0 high=0 med=0 low=0/,
    )
    // Echo-safety: the de-tokenized verdict carries no parseable token.
    assert.doesNotMatch(snap, /VERDICT: (APPROVE|BLOCK)/)
  } finally {
    dispose()
  }
})
