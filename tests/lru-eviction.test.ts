/**
 * @fileoverview LRU eviction protection for live-parent gate buckets:
 * the `states` map caps the least-recently-used entry past `maxSessions`
 * and, without protection, a live parent's bucket (holding `hasGatePass`,
 * `hasPlanVerdict`, the read counter, or `policyInjected`) can be evicted mid
 * session by churn from dozens of unrelated child sessions, so a later
 * reviewer/executor dispatch re-mints an empty bucket and blocks despite green
 * evidence. These tests cover the ledger-level protection and the two
 * regression cases: a gate flag and a plan approval surviving past
 * 64 noisy unregistered children.
 */

import { test } from "node:test"
import assert from "node:assert/strict"
import * as fs from "node:fs"
import * as path from "node:path"

import { createLedger } from "../src/ledger.ts"
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
const GATE_PASS = "GATE: PASS tests=1 passed=1 failed=0"

/**
 * The GATE_PASS marker split at character 21: streaming the head, losing the
 * session's window to churn, then streaming the tail leaves a window holding
 * only the tail, so the marker never completes and nothing is journaled.
 */
const GATE_HEAD = GATE_PASS.slice(0, 21)
const GATE_TAIL = GATE_PASS.slice(21)

/** The exact reviewer gate block message (used to confirm the control blocks). */
const NO_GATE_MESSAGE =
  "BLOCKED by turnstile: no reviewer dispatch before the test gate is green. " +
  "Run the test-runner subagent first; dispatch reviewer only after its first line is " +
  "`GATE: PASS tests=<n> passed=<n> failed=<n>`, or obtain an explicit user waiver " +
  "(a user prompt this task must contain the literal marker 'USER WAIVER:' followed by the user's words)."

/** Boots the plugin over a fake host with a temp metrics dir. */
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

/** Boots in a temp project dir containing a plan file so an executor dispatch is gated. */
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
  const setup = turnstile(h.host, {
    env: isolatedEnv(metricsDir),
    config: { metricsDir, alwaysEnforce: true },
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

/** Counts journal gate entries that flipped green across the whole run. */
const gateCount = (metricsDir: string): number =>
  journalEntries(metricsDir).filter((l) => l.type === "gate" && l.result === "PASS").length

/** Counts journal verdict entries journaled across the whole run. */
const verdictCount = (metricsDir: string): number =>
  journalEntries(metricsDir).filter((l) => l.type === "verdict").length

/** Pushes a `session.created` event carrying the given properties (awaited). */
const created = (h: FakeHost, properties: Record<string, unknown>): Promise<void> =>
  h.pushEvent({ type: "session.created", properties })

/** Pushes a `session.text.delta` event for a child (awaited drain). */
const delta = (h: FakeHost, sessionID: string, chunk: string): Promise<void> =>
  h.pushEvent({ type: "session.text.delta", properties: { sessionID, delta: chunk } })

/** Ledger unit: a registered parent bucket is never evicted while it
 *  stays registered; sibling churn still evicts unrelated buckets; once the
 *  registration ages out of the bounded registry, the bucket is evictable
 *  again. Establishes the cap's protect-predicate behavior in isolation. */
test("a registered parent bucket survives unrelated churn and un-registering restores eviction", async () => {
  // maxSessions=8 keeps the run tiny; maxTrackedParents = max(256, 8*4)=256.
  const ledger = createLedger(path.join(tmpDir(), "unused.jsonl"), 8, 2000)

  // Register p as a live parent, then mint + flag its bucket.
  ledger.markParent("p")
  const p = ledger.state("p")
  p.hasGatePass = true
  const pRef = ledger.peek("p")
  assert.equal(pRef, p, "state() mints the parent bucket")
  assert.equal(pRef?.hasGatePass, true, "the flag is set on the parent bucket")

  // Mint 100 unrelated buckets past the cap of 8: p is protected, siblings churn.
  for (let i = 0; i < 100; i++) ledger.state("c" + i)
  assert.equal(ledger.peek("p"), pRef, "the registered parent bucket survives churn")
  assert.equal(ledger.peek("p")?.hasGatePass, true, "the parent flag survives churn")
  const siblingSurvivors = Array.from({ length: 100 }, (_, i) => ledger.peek("c" + i)).filter(
    (s) => s !== undefined,
  ).length
  assert.ok(
    siblingSurvivors < 100,
    `100 buckets past the cap of 8 must evict siblings (survivors=${siblingSurvivors})`,
  )

  // Registry LRU churn: registering 500 distinct parents past 256 ages p out.
  for (let r = 0; r < 500; r++) ledger.markParent("r" + r)
  assert.equal(ledger.isParent("p"), false, "p aged out of the bounded registry")
  for (let i = 0; i < 500; i++) ledger.state("d" + i)
  assert.equal(ledger.peek("p"), undefined, "an unregistered parent is evictable again")
})

/** A registered parent's GATE: PASS survives past 64 noisy
 *  unregistered children streaming markers; the reviewer dispatch is not
 *  blocked. Unprotected, the 64th noise bucket evicts p1 and re-mints it
 *  empty. */
test("a registered parents GATE: PASS survives >64 noisy unregistered children", async () => {
  const { h, dispose, metricsDir } = await boot({ gateEvidence: "flag" })
  try {
    // Flip p1's gate via a test-runner task-result delivery. The execute.after
    // task branch marks p1 live before parseMarkers flips the gate.
    await callTool(h, "execute.after", {
      tool: "task",
      sessionID: "p1",
      input: { agent: "test-runner" },
      result: { output: GATE_PASS },
    })
    assert.equal(gateCount(metricsDir), 1, "p1's gate flipped green and is registered")

    // 100 unregistered children stream GATE: PASS, each self-keying a bucket.
    // Each seeds its emitter agent (test-runner) so its gate is honored and the
    // session-agents cache churns past its bound; a genuine delivery is what
    // would be required in production, but the stream seed is enough here.
    for (let i = 1; i <= 100; i++) {
      h.pushEvent({ type: "session.created", data: { sessionID: "n" + i, agent: "test-runner" } })
      h.pushEvent({ type: "session.text.ended", data: { sessionID: "n" + i, text: GATE_PASS } })
    }
    await waitUntil(() => gateCount(metricsDir) >= 100, 2000)

    // The reviewer dispatch on p1 must resolve: its gate survived eviction.
    await callTool(h, "execute.before", {
      tool: "task",
      sessionID: "p1",
      input: { agent: "reviewer", prompt: "review it" },
    })
    const blocked = journalEntries(metricsDir).filter(
      (l) => l.type === "blocked" && l.sessionID === "p1" && l.reason === "no-gate-pass",
    )
    assert.equal(blocked.length, 0, "p1's gate survived eviction; the reviewer is not blocked")
  } finally {
    dispose()
  }
})

/** A registered parent's plan approval (VERDICT: APPROVE) survives
 *  past 64 noisy unregistered children; the executor dispatch is not blocked
 *  with `no-plan-verdict`. Also asserts the gates still fire for an
 *  unregistered pressure session, so protection is selective, not "never evict". */
test("a registered parents plan approval survives >64 noisy children and protection is selective", async () => {
  const { h, metricsDir, restore } = await bootWithPlan()
  try {
    // Register the edge c1 -> p1 via a created event, then have c1 stream an
    // APPROVE so the edge is resolved before the delivery that attributes it.
    h.pushEvent({
      type: "session.created",
      data: { sessionID: "c1", parentID: "p1", agent: "plan-reviewer" },
    })
    h.pushEvent({
      type: "session.text.ended",
      data: { sessionID: "c1", text: `\nreview\n\n${APPROVE}\n` },
    })
    await waitUntil(() =>
      journalEntries(metricsDir).some((l) => l.type === "verdict" && l.raw === "c1"),
    )
    // The plan-reviewer delivery on c1 attributes the APPROVE to p1 (edge-
    // resolved) and stamps its plans-dir signature.
    await callTool(h, "execute.after", {
      tool: "task",
      sessionID: "c1",
      input: { agent: "plan-reviewer" },
      result: { output: `\nreviewed\n\n${APPROVE}\n` },
    })
    await waitUntil(() =>
      journalEntries(metricsDir).some(
        (l) => l.type === "plan" && l.sessionID === "p1" && l.result === "APPROVE",
      ),
    )

    // 100 unregistered children stream markers, each self-keying a bucket and
    // churning p1's bucket out past the cap on HEAD.
    for (let i = 1; i <= 100; i++) {
      h.pushEvent({ type: "session.created", data: { sessionID: "n" + i, agent: "plan-reviewer" } })
      h.pushEvent({ type: "session.text.ended", data: { sessionID: "n" + i, text: APPROVE } })
    }
    await waitUntil(() => verdictCount(metricsDir) >= 100, 2000)

    // The executor dispatch on p1 must resolve: the survived approval (and its
    // stamped signature, re-validated against the unchanged plan.md) clears it.
    await callTool(h, "execute.before", {
      tool: "task",
      sessionID: "p1",
      input: { agent: "executor", prompt: "do the work" },
    })
    const blocked = journalEntries(metricsDir).filter(
      (l) => l.type === "blocked" && l.sessionID === "p1" && l.reason === "no-plan-verdict",
    )
    assert.equal(
      blocked.length,
      0,
      "p1's plan approval survived eviction; the executor is not blocked",
    )

    // Control: the gates still fire for an unregistered pressure session
    // (n1 streamed only a verdict, so it has no gate and no plan approval).
    await assert.rejects(
      () =>
        callTool(h, "execute.before", {
          tool: "task",
          sessionID: "n1",
          input: { agent: "reviewer", prompt: "review it" },
        }),
      (e: Error) => e.message === NO_GATE_MESSAGE,
      "the reviewer gate still blocks an unregistered pressure session",
    )
    await assert.rejects(
      () =>
        callTool(h, "execute.before", {
          tool: "task",
          sessionID: "n1",
          input: { agent: "executor", prompt: "do the work" },
        }),
      /no plan approval/,
      "the plan gate still blocks an unregistered pressure session",
    )
  } finally {
    restore()
  }
})

/**
 * A bounded admitted-id dedupe registry: 65 distinct hook admits each
 * capture once, and once the set reaches its cap the oldest entries evict,
 * so re-admitting previously-seen ids captures again while the set stays
 * bounded (bounded-memory invariant) rather than growing with every prompt.
 * Only the lower bound on re-captures is asserted: eviction order is an
 * implementation detail, not a contract.
 */
test("admitted-id registry is bounded: evicted ids re-capture on re-admit", async () => {
  const { h, metricsDir, dispose } = await boot()
  try {
    // 65 distinct admits (distinct shared message ids) each capture once.
    for (let i = 0; i < 65; i++) {
      await callSession(h, "prompt", {
        sessionID: "p1",
        messageID: `msg_${i}`,
        text: "PLAN APPROVED: go",
      })
    }
    let approves = journalEntries(metricsDir).filter(
      (l) => l.type === "plan" && l.result === "APPROVE",
    ).length
    assert.equal(approves, 65, "65 distinct admits each capture once")
    // Re-admit every seen id: the set sits at its cap, so evicted keys
    // capture again and the total grows — but the growth is the eviction
    // mechanism at work, not a pinned order (lower bound only).
    for (let i = 0; i < 65; i++) {
      await callSession(h, "prompt", {
        sessionID: "p1",
        messageID: `msg_${i}`,
        text: "PLAN APPROVED: go",
      })
    }
    approves = journalEntries(metricsDir).filter(
      (l) => l.type === "plan" && l.result === "APPROVE",
    ).length
    assert.ok(
      approves >= 66,
      `evicted ids re-capture while the registry stays bounded (approves=${approves})`,
    )
  } finally {
    dispose()
  }
})

/**
 * Churning `deltaWindows` past its cap evicts a live child's window mid-
 * marker: the straddling marker is simply not delivered (no crash, no
 * wrong-session delivery) while a child whose window survives still
 * completes its marker and journals exactly one gate entry.
 */
test("delta-window churn evicts a live child mid-marker without mis-delivering", async () => {
  const { h, dispose, metricsDir } = await boot({ gateEvidence: "flag" })
  try {
    // Target T (a test-runner root) starts streaming the marker's head.
    await created(h, { sessionID: "T", agent: "test-runner" })
    await delta(h, "T", GATE_HEAD)
    // 60 delta-only noise children churn the window map past its cap of 50:
    // T's window is the oldest and evicts while the marker is straddled.
    for (let i = 0; i < 60; i++) await delta(h, `n${i}`, "noise")
    // The tail lands in a fresh window holding only the tail: the marker
    // never completes for T, so no gate entry is journaled for it.
    await delta(h, "T", GATE_TAIL)
    // Stream alive: a survivor whose whole marker fits one window still
    // journals its gate entry, attributed to itself (no parent edge).
    await created(h, { sessionID: "S", agent: "test-runner" })
    await delta(h, "S", GATE_PASS)
    const gates = journalEntries(metricsDir).filter((l) => l.type === "gate")
    assert.equal(gates.length, 1, "only the survivor's completed marker journals")
    const { ts: _stamp, ...shape } = gates[0]!
    assert.deepEqual(shape, {
      type: "gate",
      sessionID: "S",
      raw: "S",
      result: "PASS",
      source: "child-text-delta",
      marker: GATE_PASS,
      verified: false,
      mode: "flag",
    })
    const errors = journalEntries(metricsDir).filter((l) => l.type === "error")
    assert.equal(errors.length, 0, "the churn never crashes the stream")
  } finally {
    dispose()
  }
})

/**
 * Churning `sessionDirs` past its cap evicts a live root's directory mid-
 * stream: a later streamed verdict from its child is still attributed to
 * the right parent (the edge route, independent of the directory map), with
 * no crash and no mis-attribution — the root's project dir degrades to the
 * process cwd, the documented fallback.
 */
test("session-dir churn evicts a live root's directory without mis-attributing its child", async () => {
  const { h, metricsDir, restore } = await bootWithPlan()
  const churnDir = tmpDir()
  try {
    // Root R carries a directory (seeds its sessionDirs entry); child c is
    // registered under it as a plan-reviewer.
    await created(h, { sessionID: "R", directory: churnDir })
    await created(h, { sessionID: "c", parentID: "R", agent: "plan-reviewer" })
    // 51 root created-events each carry a directory: the churn evicts R's
    // entry past the cap of 50 (R is the oldest).
    for (let i = 0; i < 51; i++) await created(h, { sessionID: `r${i}`, directory: churnDir })
    // The child streams its APPROVE: attribution resolves through the
    // registered edge, so the verdict still keys on the right parent.
    await h.pushEvent({
      type: "message.part.updated",
      properties: { sessionID: "c", part: { type: "text", text: APPROVE } },
    })
    const verdicts = journalEntries(metricsDir).filter((l) => l.type === "verdict")
    assert.equal(verdicts.length, 1, "the child's streamed verdict journals exactly once")
    assert.equal(verdicts[0]!.sessionID, "R", "the verdict keys on the child's real parent")
    assert.equal(verdicts[0]!.raw, "c", "the raw field keeps the child id")
    assert.equal(verdicts[0]!.source, "child-message", "the streamed-text provenance is kept")
    const errors = journalEntries(metricsDir).filter((l) => l.type === "error")
    assert.equal(errors.length, 0, "the churn never crashes the stream")
  } finally {
    restore()
  }
})
