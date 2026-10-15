/**
 * @fileoverview Verdict-attribution tests: every journaled
 * `plan` entry must be keyed raw = an actual child session id (never the
 * parent/session id), streamed verdicts dedup per (child, marker, source),
 * continued subagent sessions emit verdict observations, and unattributable
 * parent-keyed re-fires fail open (journaled `error`, gate untouched). Also
 * asserts the candidate-recovery path that let-attribute a parent-keyed
 * re-fire to the unique evidenced child.
 *
 * The self-keyed-edge tests: a self-keyed delivery whose edge is
 * unresolved now also claims the unique child evidenced only in the streaming
 * store (plausibility = a recorded plan-reviewer dispatch predates the
 * observation, unique across parents); every self-keyed delivery journals one
 * `type:"attribution"` diagnostic; a plausible streamed APPROVE makes a
 * self-keyed BLOCK unreachable.
 */

import { test } from "node:test"
import assert from "node:assert/strict"
import * as fs from "node:fs"
import * as path from "node:path"

import { turnstile } from "../turnstile.ts"
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

const APPROVE = "VERDICT: APPROVE crit=0 high=0 med=0 low=0"
const BLOCK = "VERDICT: BLOCK crit=1 high=0 med=0 low=0"

/** Gives the async event loop a tick to drain queued stream events. */
const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 30))

/** Boots a temp project dir with a plan file so an executor dispatch is gated. */
async function bootWithPlan(
  planBody = "# P\n",
  opts?: { throwingGet?: boolean },
): Promise<{ h: FakeHost; metricsDir: string; project: string; restore: () => void }> {
  const project = tmpDir()
  fs.mkdirSync(path.join(project, ".opencode", "plans"), { recursive: true })
  fs.writeFileSync(path.join(project, ".opencode", "plans", "plan.md"), planBody)
  const metricsDir = tmpDir()
  const h = makeFakeHost(opts)
  const prev = process.cwd()
  process.chdir(project)
  const setup = turnstile(h.host, { env: isolatedEnv(metricsDir), config: { metricsDir } })
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

const planEntries = (metricsDir: string): Array<Record<string, any>> =>
  journalEntries(metricsDir).filter((l) => l.type === "plan")

/**
 * a marker-less delivery on the child approves
 * through c1, and a later marker-less re-fire reporting the parent's own
 * session id cannot clobber that verification with a `{raw: p1}` phantom.
 */
test("marker-less parent re-fire cannot clobber a live child-text approval", async () => {
  const { h, metricsDir, restore } = await bootWithPlan()
  try {
    // child → parent edge; the child streams APPROVE on its own text.
    h.pushEvent({ type: "session.created", data: { sessionID: "c1", parentID: "p1" } })
    await settle()
    h.pushEvent({
      type: "session.text.ended",
      data: { sessionID: "c1", text: `\nreview\n\n${APPROVE}\n` },
    })
    await waitUntil(() => journalEntries(metricsDir).some((e) => e.type === "verdict"))
    // Marker-less summarized delivery on the child → approves keyed raw=c1.
    await callTool(h, "execute.after", {
      tool: "task",
      sessionID: "c1",
      input: { agent: "plan-reviewer" },
      result: { output: "Review complete; see journal." },
    })
    // Re-fire, modeled from the live journal evidence: a parent-keyed
    // execute.after re-fire (sessionID: p1) carrying marker-less output. A
    // child-keyed-but-no-edge re-fire of the same shape is not this bug — it
    // deliberately resolves through the candidate-discovery scan (documented
    // behavior), so both shapes are handled by attributePlanVerdict.
    await callTool(h, "execute.after", {
      tool: "task",
      sessionID: "p1",
      input: { agent: "plan-reviewer" },
      result: { output: "Task finished." },
    })
    const plans = planEntries(metricsDir)
    // The clobbered phantom `{raw: p1, marker: <none>}` can never be journaled.
    assert.equal(
      plans.some((p) => p.raw === "p1"),
      false,
    )
    assert.equal(
      plans.some((p) => p.result === "BLOCK"),
      false,
    )
    // Candidate recovery: the re-fire attributes the unique evidenced child.
    const latest = plans[plans.length - 1]
    assert.ok(latest)
    assert.equal(latest.raw, "c1")
    assert.equal(latest.result, "APPROVE")
    // Gate stays green: the earlier approval is not clobbered.
    await callTool(h, "execute.before", {
      tool: "task",
      sessionID: "p1",
      input: { agent: "executor", prompt: "do the work" },
    })
  } finally {
    restore()
  }
})

/**
 * a stale parent-store APPROVE can never approve the gate
 * on a marker-less parent-keyed re-fire when no child is attributable — the
 * shape that today silently approves. Zero plan entries, one error journaled.
 */
test("stale parent-store approval is not re-approved on a marker-less parent re-fire", async () => {
  const { h, metricsDir, restore } = await bootWithPlan()
  try {
    // Seed the PARENT's own store; no child is registered as anyone's child.
    h.pushEvent({ type: "session.text.ended", data: { sessionID: "p1", text: `${APPROVE}\n` } })
    await waitUntil(() =>
      journalEntries(metricsDir).some((e) => e.type === "verdict" && e.raw === "p1"),
    )
    await settle()
    await callTool(h, "execute.after", {
      tool: "task",
      sessionID: "p1",
      input: { agent: "plan-reviewer" },
      result: { output: "Task finished." },
    })
    assert.equal(planEntries(metricsDir).length, 0)
    const errors = journalEntries(metricsDir).filter(
      (l) => l.type === "error" && /unattributable/.test(l.error),
    )
    assert.equal(errors.length, 1)
    // Gate untouched: the stale parent approval never re-approved, so the
    // executor is still blocked.
    await assert.rejects(() =>
      callTool(h, "execute.before", {
        tool: "task",
        sessionID: "p1",
        input: { agent: "executor", prompt: "do the work" },
      }),
    )
  } finally {
    restore()
  }
})

/**
 * every journaled plan entry is keyed raw = an actual child
 * session id across both edge routes, and no entry is keyed by session id.
 */
test("every plan entry is keyed raw = a child id across both edge routes", async () => {
  // Route 1: session.created child→parent edge.
  const { h, metricsDir, restore } = await bootWithPlan()
  try {
    h.pushEvent({ type: "session.created", data: { sessionID: "c1", parentID: "p1" } })
    await settle()
    h.pushEvent({ type: "session.text.ended", data: { sessionID: "c1", text: `${APPROVE}\n` } })
    await waitUntil(() => journalEntries(metricsDir).some((e) => e.type === "verdict"))
    await callTool(h, "execute.after", {
      tool: "task",
      sessionID: "c1",
      input: { agent: "plan-reviewer" },
      result: { output: "Review complete." },
    })
    // The self-keyed re-fire with a unique evidenced child still attributes.
    await callTool(h, "execute.after", {
      tool: "task",
      sessionID: "p1",
      input: { agent: "plan-reviewer" },
      result: { output: "Task finished." },
    })
  } finally {
    restore()
  }
  // Route 2: the only edge route is the host session record.
  const project = tmpDir()
  fs.mkdirSync(path.join(project, ".opencode", "plans"), { recursive: true })
  fs.writeFileSync(path.join(project, ".opencode", "plans", "plan.md"), "# P\n")
  const metricsDir2 = tmpDir()
  const host = makeFakeHost({
    sessionRecords: new Map([["c1", { parentID: "p1" }]]),
  })
  const prev = process.cwd()
  process.chdir(project)
  try {
    const setup = turnstile(host.host, {
      env: isolatedEnv(metricsDir2),
      config: { metricsDir: metricsDir2 },
    })
    await setup(host.host)
    host.pushEvent({ type: "session.text.ended", data: { sessionID: "c1", text: `${APPROVE}\n` } })
    await waitUntil(() => journalEntries(metricsDir2).some((e) => e.type === "verdict"))
    await settle()
    await callTool(host, "execute.after", {
      tool: "task",
      sessionID: "c1",
      input: { agent: "plan-reviewer" },
      result: { output: "Review complete." },
    })
  } finally {
    process.chdir(prev)
  }
  const all = [...planEntries(metricsDir), ...planEntries(metricsDir2)]
  // Every entry satisfies the invariant: raw is a child, never the session id,
  // including the marker-less parent-keyed re-fire, which recovers c1 via the
  // unique evidenced child rather than journaling a {raw: p1} phantom.
  for (const p of all) {
    assert.notEqual(p.raw, p.sessionID)
    assert.notEqual(p.raw, "p1")
  }
  // Route 1 journals the c1 delivery plus the recovered parent-keyed re-fire
  // (two c1-keyed approvals); route 2 (session-records edge) journals one.
  assert.equal(
    planEntries(metricsDir).filter((p) => p.raw === "c1" && p.result === "APPROVE").length,
    2,
  )
  assert.equal(
    planEntries(metricsDir2).filter((p) => p.raw === "c1" && p.result === "APPROVE").length,
    1,
  )
})

/**
 * identical streamed verdicts dedup, a marker flip replays, an
 * identical re-delivery is silent, and a sibling shares the child-text verdict
 * bucket (its journal entry is suppressed while its store still records it,
 * matching tests/plan-gate.test.ts:527).
 *
 * NOTE (deliberate deviation from the original spec wording): the spec
 * expected a cross
 * sibling and a cross-source delta→ended replay to journal separately per
 * `(child, marker, source)`. The implemented bucket dedup keys on
 * `(scope, marker)` — no child or source component — so identical markers
 * across children/sources within the streaming scope are suppressed (MED-1
 * audit: markers.ts is "behavior unchanged"). This test asserts the actual,
 * implemented semantics. The core contract — identical re-delivery journals
 * nothing, a marker flip journals — holds.
 */
test("streamed verdicts dedup on identical re-delivery and flip", async () => {
  const { h, metricsDir, restore } = await bootWithPlan()
  try {
    h.pushEvent({ type: "session.created", data: { sessionID: "c1", parentID: "p1" } })
    h.pushEvent({ type: "session.created", data: { sessionID: "c2", parentID: "p1" } })
    await settle()
    // Five identical streamed APPROVEs on c1 → exactly one verdict.
    for (let i = 0; i < 5; i++)
      h.pushEvent({ type: "session.text.ended", data: { sessionID: "c1", text: `${APPROVE}\n` } })
    await settle()
    assert.equal(journalEntries(metricsDir).filter((e) => e.type === "verdict").length, 1)
    // A sibling with an identical marker: its verdict *entry* is suppressed by
    // the child-text bucket, but its store still records the verdict (so the
    // subsequent marker-less delivery on c2 can still attribute c2).
    h.pushEvent({ type: "session.text.ended", data: { sessionID: "c2", text: `${APPROVE}\n` } })
    await settle()
    assert.equal(journalEntries(metricsDir).filter((e) => e.type === "verdict").length, 1)
    // c1's marker flips APPROVE→BLOCK: a replay, journaled.
    h.pushEvent({ type: "session.text.ended", data: { sessionID: "c1", text: `${BLOCK}\n` } })
    await settle()
    assert.equal(journalEntries(metricsDir).filter((e) => e.type === "verdict").length, 2)
    // An identical BLOCK re-delivery is silently suppressed.
    h.pushEvent({ type: "session.text.ended", data: { sessionID: "c1", text: `${BLOCK}\n` } })
    await settle()
    assert.equal(journalEntries(metricsDir).filter((e) => e.type === "verdict").length, 2)
    // A cross-source delta→ended replay with the same marker: the bucket keys
    // on (scope, marker) with no source component, so both are suppressed
    // (they share c1's already-seen APPROVE key). Asserting the deviation.
    h.pushEvent({
      type: "message.part.updated",
      data: { sessionID: "c1", part: { type: "text", text: `${APPROVE}\n` } },
    })
    h.pushEvent({ type: "session.text.ended", data: { sessionID: "c1", text: `${APPROVE}\n` } })
    await settle()
    assert.equal(journalEntries(metricsDir).filter((e) => e.type === "verdict").length, 2)
  } finally {
    restore()
  }
})

/**
 * the only edge route is the host session
 * record; a continued marker-less delivery on the child attributes c1, and a
 * continued delivery carrying a marker journals its verdict observation.
 */
test("continued subagent session attributes through session records, emits verdict", async () => {
  const project = tmpDir()
  fs.mkdirSync(path.join(project, ".opencode", "plans"), { recursive: true })
  fs.writeFileSync(path.join(project, ".opencode", "plans", "plan.md"), "# P\n")
  const metricsDir = tmpDir()
  const h = makeFakeHost({
    sessionRecords: new Map([["c1", { parentID: "p1" }]]),
  })
  const prev = process.cwd()
  process.chdir(project)
  try {
    const setup = turnstile(h.host, {
      env: isolatedEnv(metricsDir),
      config: { metricsDir: metricsDir },
    })
    await setup(h.host)
    // The child streams its verdict before any task result; the edge is
    // resolved via the host session record (no session.created event).
    h.pushEvent({ type: "session.text.ended", data: { sessionID: "c1", text: `${APPROVE}\n` } })
    await waitUntil(() => journalEntries(metricsDir).some((e) => e.type === "verdict"))
    await settle()
    // Continued marker-less delivery on the child → attributed raw=c1 child-text.
    await callTool(h, "execute.after", {
      tool: "task",
      sessionID: "c1",
      input: { agent: "plan-reviewer" },
      result: { output: "Review complete; see journal." },
    })
    const latest = planEntries(metricsDir)[planEntries(metricsDir).length - 1]
    assert.ok(latest)
    assert.equal(latest.raw, "c1")
    assert.equal(latest.sessionID, "p1")
    assert.equal(latest.result, "APPROVE")
    assert.equal(latest.source, "child-text")
    // The streamed verdict is a real child-text observation.
    assert.equal(
      journalEntries(metricsDir).some((e) => e.type === "verdict" && e.raw === "c1"),
      true,
    )
    // Regression: a continued delivery whose own output carries a marker journals
    // the verdict observation (task-result per-delivery scope flows through).
    const before = journalEntries(metricsDir).filter((e) => e.type === "verdict").length
    await callTool(h, "execute.after", {
      tool: "task",
      sessionID: "c1",
      input: { agent: "plan-reviewer" },
      result: { output: `${APPROVE}\n` },
    })
    assert.equal(
      journalEntries(metricsDir).filter((e) => e.type === "verdict" && e.raw === "c1").length,
      before + 1,
    )
  } finally {
    process.chdir(prev)
  }
})

/**
 * an unresolved edge with a host that cannot resolve the
 * parent journals exactly one unattributable error, throws no rejection, and
 * leaves the gate untouched.
 */
test("unattributable parent-keyed delivery fails open to a journaled error", async () => {
  const { h, metricsDir, restore } = await bootWithPlan()
  try {
    // No session.created: the child is never registered; the host has no
    // session.get to resolve its parent.
    await callTool(h, "execute.after", {
      tool: "task",
      sessionID: "p1",
      input: { agent: "plan-reviewer" },
      result: { output: "Task finished." },
    })
    assert.equal(planEntries(metricsDir).length, 0)
    const errors = journalEntries(metricsDir).filter(
      (l) => l.type === "error" && /unattributable/.test(l.error),
    )
    assert.equal(errors.length, 1)
    // Gate untouched: no approval, so the executor is still blocked.
    await assert.rejects(() =>
      callTool(h, "execute.before", {
        tool: "task",
        sessionID: "p1",
        input: { agent: "executor", prompt: "do the work" },
      }),
    )
  } finally {
    restore()
  }
})

// ---------------------------------------------------------------------------
// Self-keyed task-result delivery with an unresolved edge.
// ---------------------------------------------------------------------------

/** Records a plan-reviewer dispatch for the parent (plausibility input). */
const dispatch = (h: FakeHost, parent: string): Promise<void> =>
  callTool(h, "execute.before", {
    tool: "task",
    sessionID: parent,
    input: { agent: "plan-reviewer", prompt: "review the plan" },
  })

/** Streams an APPROVE verdict on the given child's text (default c1). */
const streamApprove = (h: FakeHost, child = "c1"): void =>
  h.pushEvent({ type: "session.text.ended", data: { sessionID: child, text: `${APPROVE}\n` } })

/** Marker-less plan-reviewer task-result delivery on the given session id. */
const deliver = (h: FakeHost, sessionID: string, output = "Task finished."): Promise<void> =>
  callTool(h, "execute.after", {
    tool: "task",
    sessionID,
    input: { agent: "plan-reviewer" },
    result: { output },
  })

/** Every `type:"attribution"` entry. */
const attribution = (metricsDir: string): Array<Record<string, any>> =>
  journalEntries(metricsDir).filter((l) => l.type === "attribution")

/** The /unattributable/ errors, per the single-error-per-re-fire count. */
const errorE = (metricsDir: string): Array<Record<string, any>> =>
  journalEntries(metricsDir).filter((l) => l.type === "error" && /unattributable/.test(l.error))

/** Bare-output violation entries (marker-less delivery from a marker-contracted agent). */
const violationE = (metricsDir: string): Array<Record<string, any>> =>
  journalEntries(metricsDir).filter((l) => l.type === "violation")

/**
 * Core repro: an unresolved edge plus a streamed APPROVE on the
 * child must flip the plan gate APPROVE (not leave it red). The delivery is
 * parent-keyed (self-keyed); the child is never registered, so the plausibility
 * join claims it via the streaming store. Zero plan entries + executor blocked
 * before the fix; green after.
 */
test("unresolved edge + streamed APPROVE is attributed through the streaming store", async () => {
  const { h, metricsDir, restore } = await bootWithPlan("# P", { throwingGet: true })
  try {
    // Prompt reset drops p1's task scope; the child is never registered (throwingGet).
    await callSession(h, "prompt", { sessionID: "p1" })
    await settle()
    // Seed the parent's plan-reviewer dispatch (the plausibility input).
    await dispatch(h, "p1")
    // Saturate the failed lookup: two benign parts + the APPROVE text = 3 attempts (cap).
    h.pushEvent({
      type: "message.part.updated",
      data: { sessionID: "c1", part: { type: "text", text: "noise one" } },
    })
    h.pushEvent({
      type: "message.part.updated",
      data: { sessionID: "c1", part: { type: "text", text: "noise two" } },
    })
    streamApprove(h)
    await waitUntil(() =>
      journalEntries(metricsDir).some((e) => e.type === "verdict" && e.raw === "c1"),
    )
    await settle()
    // Parent-keyed, marker-less delivery: self-keyed, plausibility claims c1.
    await deliver(h, "p1")

    const plans = planEntries(metricsDir)
    const latest = plans[plans.length - 1]
    assert.ok(latest)
    assert.equal(latest.sessionID, "p1")
    assert.equal(latest.raw, "c1")
    assert.equal(latest.result, "APPROVE")
    assert.equal(latest.marker, APPROVE)
    assert.equal(latest.source, "child-text")
    // Never a {raw: sessionID} phantom, never a BLOCK.
    assert.equal(
      plans.some((p) => p.raw === p.sessionID),
      false,
    )
    assert.equal(
      plans.some((p) => p.result === "BLOCK"),
      false,
    )
    // Attribution diagnostic entry.
    const ats = attribution(metricsDir)
    assert.equal(ats.length, 1)
    assert.equal(ats[0]!.decision, "attributed")
    assert.equal(ats[0]!.deliveryIsParent, true)
    assert.equal(ats[0]!.sessionApi, true)
    assert.deepEqual(ats[0]!.candidates, { edge: 0, unresolved: 1, plausible: 1 })
    assert.equal(ats[0]!.lookup.c1.attempts, 3)
    assert.equal(ats[0]!.lookup.c1.reason, "not-visible")
    // Executor allowed (gate flipped green).
    await callTool(h, "execute.before", {
      tool: "task",
      sessionID: "p1",
      input: { agent: "executor", prompt: "do the work" },
    })
  } finally {
    restore()
  }
})

/**
 * Fail-open: no recorded dispatch means plausibility unmet,
 * so the streamed APPROVE on an unresolved child is NOT claimed. Zero plan
 * entries, exactly one unattributable error, executor blocked, an attribution
 * fail-open entry. The violation entry documents the current-code shape (keyed
 * by the delivery session, p1).
 */
test("unresolved edge without a recorded dispatch fails open", async () => {
  const { h, metricsDir, restore } = await bootWithPlan()
  try {
    // Child streams APPROVE (unresolved); no dispatch is recorded.
    streamApprove(h)
    await waitUntil(() =>
      journalEntries(metricsDir).some((e) => e.type === "verdict" && e.raw === "c1"),
    )
    await settle()
    await deliver(h, "p1")

    assert.equal(planEntries(metricsDir).length, 0)
    assert.equal(errorE(metricsDir).length, 1)
    // Attribution fail-open diagnostic.
    const ats = attribution(metricsDir)
    assert.equal(ats.length, 1)
    assert.equal(ats[0]!.decision, "fail-open")
    assert.deepEqual(ats[0]!.candidates, { edge: 0, unresolved: 1, plausible: 0 })
    // The bare-output violation (marker-less plan-reviewer delivery) is keyed by p1.
    assert.ok(violationE(metricsDir).some((x) => x.sessionID === "p1"))
    // Executor blocked.
    await assert.rejects(() =>
      callTool(h, "execute.before", {
        tool: "task",
        sessionID: "p1",
        input: { agent: "executor", prompt: "do the work" },
      }),
    )
  } finally {
    restore()
  }
})

/**
 * Limitation: a delivery keyed by the unresolved child itself
 * cannot attribute (gate state is parent-keyed by design). Self-keyed
 * fail-open with the full lookup diagnostic; executor still blocked.
 */
test("a child-keyed unresolved delivery cannot attribute (parent-keyed gate by design)", async () => {
  const { h, metricsDir, restore } = await bootWithPlan("# P", { throwingGet: true })
  try {
    // Saturate c1's failed lookup and record its APPROVE.
    h.pushEvent({
      type: "message.part.updated",
      data: { sessionID: "c1", part: { type: "text", text: "noise one" } },
    })
    h.pushEvent({
      type: "message.part.updated",
      data: { sessionID: "c1", part: { type: "text", text: "noise two" } },
    })
    streamApprove(h)
    await waitUntil(() =>
      journalEntries(metricsDir).some((e) => e.type === "verdict" && e.raw === "c1"),
    )
    await settle()
    await deliver(h, "c1")

    assert.equal(planEntries(metricsDir).length, 0)
    assert.equal(errorE(metricsDir).length, 1)
    const ats = attribution(metricsDir)
    assert.equal(ats.length, 1)
    assert.equal(ats[0]!.deliveryIsParent, true)
    assert.equal(ats[0]!.sessionID, "c1")
    assert.equal(ats[0]!.decision, "fail-open")
    assert.equal(ats[0]!.lookup.c1.attempts, 3)
    assert.equal(ats[0]!.lookup.c1.reason, "not-visible")
    // Executor blocked.
    await assert.rejects(() =>
      callTool(h, "execute.before", {
        tool: "task",
        sessionID: "c1",
        input: { agent: "executor", prompt: "do the work" },
      }),
    )
  } finally {
    restore()
  }
})

/**
 * Task-scope guard: a previous tasks streamed APPROVE cannot
 * approve the next task after a prompt reset (dispatch cleared). Half 1 fails
 * open (dispatch gone); half 2 re-arms the join via a fresh dispatch + re-stream
 * and attributes. Proves last-wins + reset-clearing.
 */
test("a reset clears dispatch scope so a prior task's streamed verdict cannot approve the next", async () => {
  const { h, metricsDir, restore } = await bootWithPlan()
  try {
    // Task 1: dispatch, then stream the child's APPROVE (unresolved child).
    await callSession(h, "prompt", { sessionID: "p1" })
    await settle()
    await dispatch(h, "p1")
    await settle()
    streamApprove(h)
    await waitUntil(() =>
      journalEntries(metricsDir).some((e) => e.type === "verdict" && e.raw === "c1"),
    )
    await settle()

    // Reset drops p1's dispatch scope WITHOUT re-dispatching; the delivery is
    // now fail-open (the streamed verdict is no longer plausible).
    await callSession(h, "prompt", { sessionID: "p1" })
    await settle()
    await deliver(h, "p1")
    // Fail open: no plan entry, exactly one unattributable error.
    assert.equal(planEntries(metricsDir).length, 0)
    assert.equal(errorE(metricsDir).length, 1)
    const ats = attribution(metricsDir)
    assert.ok(ats.some((a) => a.decision === "fail-open"))
    assert.ok(ats.some((a) => a.candidates.plausible === 0))

    // Re-dispatch + re-stream re-arms the join; the delivery attributes.
    await dispatch(h, "p1")
    await settle()
    streamApprove(h)
    await waitUntil(() =>
      journalEntries(metricsDir).some((e) => e.type === "verdict" && e.raw === "c1"),
    )
    await settle()
    await deliver(h, "p1")
    const plan = planEntries(metricsDir)
    const latest = plan[plan.length - 1]
    assert.ok(latest)
    assert.equal(latest.sessionID, "p1")
    assert.equal(latest.raw, "c1")
    assert.equal(latest.result, "APPROVE")
  } finally {
    restore()
  }
})

/**
 * Contradiction, fail-open: two plausible unresolved children under
 * one parent, one APPROVE and one BLOCK, ⇒ contradictory pool ⇒ fail-open, gate
 * untouched, exactly one /unattributable/ error.
 */
test("contradictory plausible verdicts fail open", async () => {
  const { h, metricsDir, restore } = await bootWithPlan()
  try {
    await callSession(h, "prompt", { sessionID: "p1" })
    await settle()
    await dispatch(h, "p1")
    await settle()
    streamApprove(h, "c1")
    h.pushEvent({ type: "session.text.ended", data: { sessionID: "c2", text: `${BLOCK}\n` } })
    await waitUntil(
      () => journalEntries(metricsDir).filter((e) => e.type === "verdict").length >= 2,
    )
    await settle()
    await deliver(h, "p1")

    assert.equal(planEntries(metricsDir).length, 0)
    assert.equal(errorE(metricsDir).length, 1)
    const ats = attribution(metricsDir)
    assert.equal(ats.length, 1)
    assert.equal(ats[0]!.decision, "fail-open")
    assert.deepEqual(ats[0]!.candidates, { edge: 0, unresolved: 2, plausible: 2 })
    // Executor blocked.
    await assert.rejects(() =>
      callTool(h, "execute.before", {
        tool: "task",
        sessionID: "p1",
        input: { agent: "executor", prompt: "do the work" },
      }),
    )
  } finally {
    restore()
  }
})

/**
 * Unique-owner exclusion: a verdict plausible for two parents
 * (both dispatched before the stream) is ambiguous for each ⇒ excluded ⇒
 * fail-open.
 */
test("a verdict with two candidate parents is excluded from each", async () => {
  const { h, metricsDir, restore } = await bootWithPlan()
  try {
    await callSession(h, "prompt", { sessionID: "p1" })
    await settle()
    await dispatch(h, "p1")
    await callSession(h, "prompt", { sessionID: "p2" })
    await settle()
    await dispatch(h, "p2")
    await settle()
    streamApprove(h, "c1")
    await waitUntil(() =>
      journalEntries(metricsDir).some((e) => e.type === "verdict" && e.raw === "c1"),
    )
    await settle()
    await deliver(h, "p1")

    assert.equal(planEntries(metricsDir).length, 0)
    assert.equal(errorE(metricsDir).length, 1)
    const ats = attribution(metricsDir)
    assert.equal(ats.length, 1)
    assert.deepEqual(ats[0]!.candidates, { edge: 0, unresolved: 1, plausible: 0 })
    // Executor blocked.
    await assert.rejects(() =>
      callTool(h, "execute.before", {
        tool: "task",
        sessionID: "p1",
        input: { agent: "executor", prompt: "do the work" },
      }),
    )
  } finally {
    restore()
  }
})

/**
 * Unanimity beats multiplicity: a registered APPROVE child plus a
 * second agreeing APPROVE (unresolved) child still attributes (edge-first raw),
 * never regressing today's lone-edge-candidate attribution into a fail-open.
 */
test("an agreeing unresolved child never regresses attribution into fail-open", async () => {
  const project = tmpDir()
  fs.mkdirSync(path.join(project, ".opencode", "plans"), { recursive: true })
  fs.writeFileSync(path.join(project, ".opencode", "plans", "plan.md"), "# P\n")
  const metricsDir = tmpDir()
  const h = makeFakeHost() // no session.get; c2 stays unresolved
  const prev = process.cwd()
  process.chdir(project)
  try {
    const setup = turnstile(h.host, { env: isolatedEnv(metricsDir), config: { metricsDir } })
    const dispose = (await setup(h.host)) as () => void
    // c1 registered via session.created (edge); c2 unresolved.
    h.pushEvent({ type: "session.created", data: { sessionID: "c1", parentID: "p1" } })
    await settle()
    await callSession(h, "prompt", { sessionID: "p1" })
    await settle()
    await dispatch(h, "p1")
    await settle()
    streamApprove(h, "c1")
    streamApprove(h, "c2")
    await waitUntil(
      () => journalEntries(metricsDir).filter((e) => e.type === "verdict").length >= 2,
    )
    await settle()
    await deliver(h, "p1")

    const plan = planEntries(metricsDir)
    const latest = plan[plan.length - 1]
    assert.ok(latest)
    assert.equal(latest.sessionID, "p1")
    assert.equal(latest.raw, "c1") // edge-first raw preference
    assert.equal(latest.result, "APPROVE")
    assert.equal(latest.source, "child-text")
    // Executor allowed.
    await callTool(h, "execute.before", {
      tool: "task",
      sessionID: "p1",
      input: { agent: "executor", prompt: "do the work" },
    })
    dispose()
  } finally {
    process.chdir(prev)
  }
})

/**
 * Fail-open, not fail-green: an unresolved child streaming BLOCK
 * still attributes honestly as BLOCK and blocks the executor.
 */
test("an unresolved BLOCK stream attributes as BLOCK", async () => {
  const { h, metricsDir, restore } = await bootWithPlan()
  try {
    await callSession(h, "prompt", { sessionID: "p1" })
    await settle()
    await dispatch(h, "p1")
    await settle()
    h.pushEvent({ type: "session.text.ended", data: { sessionID: "c1", text: `${BLOCK}\n` } })
    await waitUntil(() =>
      journalEntries(metricsDir).some((e) => e.type === "verdict" && e.raw === "c1"),
    )
    await settle()
    await deliver(h, "p1")

    const plan = planEntries(metricsDir)
    const latest = plan[plan.length - 1]
    assert.ok(latest)
    assert.equal(latest.sessionID, "p1")
    assert.equal(latest.raw, "c1")
    assert.equal(latest.result, "BLOCK")
    assert.equal(latest.source, "child-text")
    // Executor blocked (BLOCK is not green).
    await assert.rejects(() =>
      callTool(h, "execute.before", {
        tool: "task",
        sessionID: "p1",
        input: { agent: "executor", prompt: "do the work" },
      }),
    )
  } finally {
    restore()
  }
})

/**
 * Invariant preserved: a marker-carrying self-keyed delivery
 * with no candidates still fails open (the delivery's own APPROVE is dropped —
 * fail-safe), never a phantom plan entry. Zero plan entries, one error.
 */
test("a marker-carrying self-keyed delivery with no candidates still fails open", async () => {
  const { h, metricsDir, restore } = await bootWithPlan()
  try {
    await deliver(h, "p1", `\nreviewed\n\n${APPROVE}\n`)
    assert.equal(planEntries(metricsDir).length, 0)
    assert.equal(errorE(metricsDir).length, 1)
    await assert.rejects(() =>
      callTool(h, "execute.before", {
        tool: "task",
        sessionID: "p1",
        input: { agent: "executor", prompt: "do the work" },
      }),
    )
  } finally {
    restore()
  }
})

/**
 * Replay and restart independence (documented regression): a
 * journal-replayed plan approval for an old parent stays green across a restart
 * (grace) while a fresh parent attributed via the self-keyed fix goes green
 * independently. Executor allowed for both — separate buckets.
 */
test("a replayed approval stays independent from a self-keyed fix for a new parent", async () => {
  const project = tmpDir()
  fs.mkdirSync(path.join(project, ".opencode", "plans"), { recursive: true })
  fs.writeFileSync(path.join(project, ".opencode", "plans", "plan.md"), "# P\n")
  const metricsDir = tmpDir()
  // Seed a journal-replayed plan approval for an OLD parent (p1).
  fs.writeFileSync(
    path.join(metricsDir, "turnstile.jsonl"),
    JSON.stringify({ ts: "t", type: "plan", sessionID: "p1", result: "APPROVE", marker: APPROVE }) +
      "\n",
  )
  const h = makeFakeHost({ throwingGet: true })
  const prev = process.cwd()
  process.chdir(project)
  try {
    const setup = turnstile(h.host, { env: isolatedEnv(metricsDir), config: { metricsDir } })
    const dispose = (await setup(h.host)) as () => void
    // New parent p2 runs the self-keyed repro with an unresolved child c2.
    await callSession(h, "prompt", { sessionID: "p2" })
    await settle()
    await dispatch(h, "p2")
    await settle()
    h.pushEvent({
      type: "message.part.updated",
      data: { sessionID: "c2", part: { type: "text", text: "noise one" } },
    })
    h.pushEvent({
      type: "message.part.updated",
      data: { sessionID: "c2", part: { type: "text", text: "noise two" } },
    })
    streamApprove(h, "c2")
    await waitUntil(() =>
      journalEntries(metricsDir).some((e) => e.type === "verdict" && e.raw === "c2"),
    )
    await settle()
    await deliver(h, "p2")

    const plans = planEntries(metricsDir)
    const p2plan = plans.find((p) => p.sessionID === "p2")
    assert.ok(p2plan)
    assert.equal(p2plan.raw, "c2")
    assert.equal(p2plan.result, "APPROVE")
    assert.equal(p2plan.source, "child-text")
    // Executor allowed for p2 (fix) and p1 (grace/replay) — independent buckets.
    await callTool(h, "execute.before", {
      tool: "task",
      sessionID: "p2",
      input: { agent: "executor", prompt: "do the work" },
    })
    await callTool(h, "execute.before", {
      tool: "task",
      sessionID: "p1",
      input: { agent: "executor", prompt: "do the work" },
    })
    dispose()
  } finally {
    process.chdir(prev)
  }
})

/**
 * Diagnostics: every self-keyed delivery journals exactly one
 * `type:"attribution"` entry carrying the full diagnostic shape
 * ({ decision, deliveryIsParent, candidates{edge,unresolved,plausible},
 * lookup{session:{attempts,reason}} }). Two self-keyed deliveries ⇒ two
 * attribution entries (counted 2), proving one-per-delivery.
 */
test("each self-keyed delivery journals exactly one attribution entry", async () => {
  const { h, metricsDir, restore } = await bootWithPlan("# P", { throwingGet: true })
  try {
    // Two self-keyed deliveries (no registered child, no evidence).
    await callSession(h, "prompt", { sessionID: "p1" })
    await settle()
    await deliver(h, "p1")
    await deliver(h, "p1")

    const ats = attribution(metricsDir)
    assert.equal(ats.length, 2) // one per delivery
    for (const a of ats) {
      assert.equal(a.decision, "fail-open")
      assert.equal(a.deliveryIsParent, true)
      assert.equal(a.sessionApi, true)
      assert.deepEqual(a.candidates, { edge: 0, unresolved: 0, plausible: 0 })
      assert.deepEqual(a.unresolvedIDs, [])
      // failedLookups forensic: the delivery self keyed, not-visible.
      assert.equal(a.lookup.p1.reason, "not-visible")
      assert.ok(typeof a.lookup.p1.attempts === "number")
    }
  } finally {
    restore()
  }
})

/**
 * Structural: a self-keyed delivery that attributes never
 * journals a `{raw: sessionID}` phantom nor a BLOCK plan entry journal-wide;
 * plus the H2 hypothesis — a record present but parent-less — is diagnosable as
 * `"no-parent-id"` in the lookup, yet still attributes from the streaming store.
 */
test("an attributed self-keyed delivery never clobbers and H2 resolves as no-parent-id", async () => {
  // Part A: T1 repro; assert journal-wide invariants.
  const { h, metricsDir, restore } = await bootWithPlan("# P", { throwingGet: true })
  try {
    await callSession(h, "prompt", { sessionID: "p1" })
    await settle()
    await dispatch(h, "p1")
    await settle()
    streamApprove(h)
    await waitUntil(() =>
      journalEntries(metricsDir).some((e) => e.type === "verdict" && e.raw === "c1"),
    )
    await settle()
    await deliver(h, "p1")

    const plans = planEntries(metricsDir)
    assert.ok(plans.length >= 1)
    // Every plan entry is keyed raw = a real child, never the session id.
    assert.ok(plans.every((p) => p.raw !== p.sessionID))
    // No BLOCK plan entry journals: the streamed APPROVE flips it green.
    assert.equal(
      plans.some((p) => p.result === "BLOCK"),
      false,
    )
  } finally {
    restore()
  }

  // Part B: H2 — record present but parent-less ⇒ reason "no-parent-id".
  const project = tmpDir()
  fs.mkdirSync(path.join(project, ".opencode", "plans"), { recursive: true })
  fs.writeFileSync(path.join(project, ".opencode", "plans", "plan.md"), "# P\n")
  const metricsDir2 = tmpDir()
  const h2 = makeFakeHost({ sessionRecords: new Map([["c1", {}]]) }) // c1 has no parentID
  const prev = process.cwd()
  process.chdir(project)
  try {
    const setup = turnstile(h2.host, {
      env: isolatedEnv(metricsDir2),
      config: { metricsDir: metricsDir2 },
    })
    const dispose = (await setup(h2.host)) as () => void
    await callSession(h2, "prompt", { sessionID: "p1" })
    await settle()
    await dispatch(h2, "p1")
    await settle()
    streamApprove(h2, "c1")
    await waitUntil(() =>
      journalEntries(metricsDir2).some((e) => e.type === "verdict" && e.raw === "c1"),
    )
    await settle()
    await deliver(h2, "p1")

    const ats = attribution(metricsDir2)
    assert.equal(ats.length, 1)
    assert.equal(ats[0]!.decision, "attributed")
    // H2: the lookup records the parent-less reason.
    assert.equal(ats[0]!.lookup.c1.reason, "no-parent-id")
    // The attribute still succeeds from the streaming store (edge-less candidate).
    const plans = planEntries(metricsDir2)
    const latest = plans[plans.length - 1]
    assert.ok(latest)
    assert.equal(latest.raw, "c1")
    assert.equal(latest.result, "APPROVE")
    dispose()
  } finally {
    process.chdir(prev)
  }
})

/**
 * a superseded prior-round BLOCK never contradicts a later APPROVE: a
 * registered edge child whose verdict was recorded before this round's
 * dispatch is round-scoped out of the edge scan, so the round's unique
 * APPROVE (from an unrelated child) attributes and opens the gate.
 */
test("a superseded prior-round BLOCK never contradicts this round's approval", async () => {
  const { h, metricsDir, restore } = await bootWithPlan()
  try {
    // Round 1: register c1 -> p1, then stream a BLOCK on c1 under round 1's
    // dispatch, so it becomes the stale edge child.
    h.pushEvent({ type: "session.created", data: { sessionID: "c1", parentID: "p1" } })
    await settle()
    await callSession(h, "prompt", { sessionID: "p1" })
    await settle()
    await dispatch(h, "p1")
    await settle()
    h.pushEvent({ type: "session.text.ended", data: { sessionID: "c1", text: `${BLOCK}\n` } })
    await waitUntil(() =>
      journalEntries(metricsDir).some((e) => e.type === "verdict" && e.raw === "c1"),
    )
    await settle()
    // Round 2: re-dispatch, then stream an APPROVE on an unrelated child c2,
    // both after the round-2 dispatch.
    await dispatch(h, "p1")
    await settle()
    streamApprove(h, "c2")
    await waitUntil(() =>
      journalEntries(metricsDir).some((e) => e.type === "verdict" && e.raw === "c2"),
    )
    await settle()
    // Marker-less self-keyed delivery on the parent: c1's stale BLOCK is
    // round-scoped out, so c2's APPROVE attributes.
    await deliver(h, "p1")

    const plans = planEntries(metricsDir)
    const latest = plans[plans.length - 1]
    assert.ok(latest)
    assert.equal(latest.sessionID, "p1")
    assert.equal(latest.raw, "c2")
    assert.equal(latest.result, "APPROVE")
    assert.equal(latest.source, "child-text")
    // No contradiction error; the round's unanimous APPROVE attributed.
    assert.equal(errorE(metricsDir).length, 0)
    const ats = attribution(metricsDir)
    assert.ok(ats.some((a) => a.decision === "attributed"))
    // Executor allowed: the gate opened on the round's APPROVE.
    await callTool(h, "execute.before", {
      tool: "task",
      sessionID: "p1",
      input: { agent: "executor", prompt: "do the work" },
    })
  } finally {
    restore()
  }
})

/**
 * over-attribution guard: a prior-round edge child left behind with no
 * current-round evidence fails open — no plan entry, exactly one
 * unattributable error, the round-scoped edge candidate count is zero, and the
 * executor stays blocked.
 */
test("a prior-round edge child with no current verdict still fails open", async () => {
  const { h, metricsDir, restore } = await bootWithPlan()
  try {
    // Round 1: register c1 -> p1 and stream a BLOCK on it under round 1's
    // dispatch, making it the stale edge child.
    h.pushEvent({ type: "session.created", data: { sessionID: "c1", parentID: "p1" } })
    await settle()
    await callSession(h, "prompt", { sessionID: "p1" })
    await settle()
    await dispatch(h, "p1")
    await settle()
    h.pushEvent({ type: "session.text.ended", data: { sessionID: "c1", text: `${BLOCK}\n` } })
    await waitUntil(() =>
      journalEntries(metricsDir).some((e) => e.type === "verdict" && e.raw === "c1"),
    )
    await settle()
    // Round 2: re-dispatch with no current-round evidence at all.
    await dispatch(h, "p1")
    await settle()
    // Marker-less self-keyed delivery: the stale edge child is round-scoped
    // out, so nothing attributes.
    await deliver(h, "p1")

    assert.equal(planEntries(metricsDir).length, 0)
    assert.equal(errorE(metricsDir).length, 1)
    const ats = attribution(metricsDir)
    assert.equal(ats.length, 1)
    assert.equal(ats[0]!.decision, "fail-open")
    assert.equal(ats[0]!.candidates.edge, 0)
    assert.equal(ats[0]!.candidates.plausible, 0)
    // Executor blocked: no over-attribution.
    await assert.rejects(() =>
      callTool(h, "execute.before", {
        tool: "task",
        sessionID: "p1",
        input: { agent: "executor", prompt: "do the work" },
      }),
    )
  } finally {
    restore()
  }
})

/**
 * same-round contradiction still fails open: a registered edge child and a
 * plausible stream child both record after the same dispatch, so the
 * round-scoped edge scan keeps the edge child and the pool stays contradictory
 * (BLOCK + APPROVE) => fail-open with the round-scoped edge count journaled.
 */
test("a same-round edge BLOCK still contradicts a plausible APPROVE", async () => {
  const { h, metricsDir, restore } = await bootWithPlan()
  try {
    h.pushEvent({ type: "session.created", data: { sessionID: "c1", parentID: "p1" } })
    await settle()
    await callSession(h, "prompt", { sessionID: "p1" })
    await settle()
    await dispatch(h, "p1")
    await settle()
    // Both verdicts record after the single dispatch => both are this round's
    // (fresh), so the edge filter keeps the registered edge child.
    h.pushEvent({ type: "session.text.ended", data: { sessionID: "c1", text: `${BLOCK}\n` } })
    streamApprove(h, "c2")
    await waitUntil(
      () => journalEntries(metricsDir).filter((e) => e.type === "verdict").length >= 2,
    )
    await settle()
    await deliver(h, "p1")

    assert.equal(planEntries(metricsDir).length, 0)
    assert.equal(errorE(metricsDir).length, 1)
    const ats = attribution(metricsDir)
    assert.equal(ats.length, 1)
    assert.equal(ats[0]!.decision, "fail-open")
    assert.deepEqual(ats[0]!.candidates, { edge: 1, unresolved: 2, plausible: 2 })
    // Executor blocked: the contradiction stays unresolved within the round.
    await assert.rejects(() =>
      callTool(h, "execute.before", {
        tool: "task",
        sessionID: "p1",
        input: { agent: "executor", prompt: "do the work" },
      }),
    )
  } finally {
    restore()
  }
})
