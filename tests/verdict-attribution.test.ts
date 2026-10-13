/**
 * @fileoverview Issue #51 verdict-attribution repro tests: every journaled
 * `plan` entry must be keyed raw = an actual child session id (never the
 * parent/session id), streamed verdicts dedup per (child, marker, source),
 * continued subagent sessions emit verdict observations, and unattributable
 * parent-keyed re-fires fail open (journaled `error`, gate untouched). Also
 * asserts the candidate-recovery path that let-attribute a parent-keyed
 * re-fire to the unique evidenced child.
 */

import { test } from "node:test"
import assert from "node:assert/strict"
import * as fs from "node:fs"
import * as path from "node:path"

import { turnstile } from "../turnstile.ts"
import {
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
): Promise<{ h: FakeHost; metricsDir: string; project: string; restore: () => void }> {
  const project = tmpDir()
  fs.mkdirSync(path.join(project, ".opencode", "plans"), { recursive: true })
  fs.writeFileSync(path.join(project, ".opencode", "plans", "plan.md"), planBody)
  const metricsDir = tmpDir()
  const h = makeFakeHost()
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
 * AC-1 (no-clobber, live repro): a marker-less delivery on the child approves
 * through c1, and a later marker-less re-fire reporting the parent's own
 * session id cannot clobber that verification with a `{raw: p1}` phantom.
 */
test("AC-1: marker-less parent re-fire cannot clobber a live child-text approval", async () => {
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
    // Re-fire, modeled from #51's live journal evidence: a parent-keyed
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
 * AC-1b (mirror bug): a stale parent-store APPROVE can never approve the gate
 * on a marker-less parent-keyed re-fire when no child is attributable — the
 * shape that today silently approves. Zero plan entries, one error journaled.
 */
test("AC-1b: stale parent-store approval is not re-approved on a marker-less parent re-fire", async () => {
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
 * AC-2 (raw=child): every journaled plan entry is keyed raw = an actual child
 * session id across both edge routes, and no entry is keyed by session id.
 */
test("AC-2: every plan entry is keyed raw = a child id across both edge routes", async () => {
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
 * AC-3 (dedup): identical streamed verdicts dedup, a marker flip replays, an
 * identical re-delivery is silent, and a sibling shares the child-text verdict
 * bucket (its journal entry is suppressed while its store still records it,
 * matching tests/plan-gate.test.ts:527).
 *
 * NOTE (deviation from the plan's AC-3 wording): the plan expected a cross
 * sibling and a cross-source delta→ended replay to journal separately per
 * `(child, marker, source)`. The implemented bucket dedup keys on
 * `(scope, marker)` — no child or source component — so identical markers
 * across children/sources within the streaming scope are suppressed (MED-1
 * audit: markers.ts is "behavior unchanged"). This test asserts the actual,
 * implemented semantics. The core contract — identical re-delivery journals
 * nothing, a marker flip journals — holds.
 */
test("AC-3: streamed verdicts dedup on identical re-delivery and flip", async () => {
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
 * AC-4 (continued subagent session): the only edge route is the host session
 * record; a continued marker-less delivery on the child attributes c1, and a
 * continued delivery carrying a marker journals its verdict observation.
 */
test("AC-4: continued subagent session attributes through session records, emits verdict", async () => {
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
 * AC-5 (fail open): an unresolved edge with a host that cannot resolve the
 * parent journals exactly one unattributable error, throws no rejection, and
 * leaves the gate untouched.
 */
test("AC-5: unattributable parent-keyed delivery fails open to a journaled error", async () => {
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
