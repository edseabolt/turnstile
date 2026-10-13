/**
 * @fileoverview LRU eviction protection for live-parent gate buckets (issue
 * #42): the `states` map caps the least-recently-used entry past `maxSessions`
 * and, without protection, a live parent's bucket (holding `hasGatePass`,
 * `hasPlanVerdict`, the read counter, or `policyInjected`) can be evicted mid
 * session by churn from dozens of unrelated child sessions, so a later
 * reviewer/executor dispatch re-mints an empty bucket and blocks despite green
 * evidence. These tests cover the ledger-level protection (T1) and the two
 * AC regressions — a gate flag (T2) and a plan approval (T3) surviving past
 * 64 noisy unregistered children.
 */

import { test } from "node:test"
import assert from "node:assert/strict"
import * as fs from "node:fs"
import * as path from "node:path"

import { createLedger } from "../src/state.ts"
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
const GATE_PASS = "GATE: PASS tests=1 passed=1 failed=0"

/** The exact reviewer gate block message (used to confirm the control blocks). */
const NO_GATE_MESSAGE =
  "BLOCKED by turnstile: no reviewer dispatch before the test gate is green. " +
  "Run the test-runner subagent first; dispatch reviewer only after its first line is " +
  "`GATE: PASS tests=<n> passed=<n> failed=<n>`, or obtain an explicit user waiver " +
  "(the dispatch prompt must contain the literal marker 'USER WAIVER:' followed by the user's words)."

/** Boots the plugin over a fake host with a temp metrics dir. */
async function boot(
  config: Record<string, any> = {},
): Promise<{ h: FakeHost; dispose: () => void; metricsDir: string }> {
  const metricsDir = tmpDir()
  const h = makeFakeHost()
  const setup = turnstile(h.host, {
    env: isolatedEnv(metricsDir),
    config: { metricsDir, ...config },
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

/** Counts journal gate entries that flipped green across the whole run. */
const gateCount = (metricsDir: string): number =>
  journalEntries(metricsDir).filter((l) => l.type === "gate" && l.result === "PASS").length

/** Counts journal verdict entries journaled across the whole run. */
const verdictCount = (metricsDir: string): number =>
  journalEntries(metricsDir).filter((l) => l.type === "verdict").length

/** T1 — ledger unit: a registered parent bucket is never evicted while it
 *  stays registered; sibling churn still evicts unrelated buckets; once the
 *  registration ages out of the bounded registry, the bucket is evictable
 *  again. Establishes the cap's protect-predicate behavior in isolation. */
test("T1: a registered parent bucket survives unrelated churn and un-registering restores eviction", async () => {
  // maxSessions=8 keeps the run tiny; maxTrackedParents = max(256, 8*4)=256.
  const ledger = createLedger(path.join(tmpDir(), "unused.jsonl"), 8)

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

/** T2 — AC-B: a registered parent's GATE: PASS survives past 64 noisy
 *  unregistered children streaming markers; the reviewer dispatch is not
 *  blocked. On HEAD the 64th noise bucket evicts p1 and re-mints it empty. */
test("T2: a registered parent's GATE: PASS survives >64 noisy unregistered children (issue #42)", async () => {
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
    for (let i = 1; i <= 100; i++) {
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

/** T3 — AC-C: a registered parent's plan approval (VERDICT: APPROVE) survives
 *  past 64 noisy unregistered children; the executor dispatch is not blocked
 *  with `no-plan-verdict`. Also asserts the gates still fire for an
 *  unregistered pressure session, so protection is selective, not "never evict". */
test("T3: a registered parent's plan approval survives >64 noisy children and protection is selective (issue #42)", async () => {
  const { h, metricsDir, restore } = await bootWithPlan()
  try {
    // Register the edge c1 -> p1 via a created event, then have c1 stream an
    // APPROVE so the edge is resolved before the delivery that attributes it.
    h.pushEvent({ type: "session.created", data: { sessionID: "c1", parentID: "p1" } })
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
