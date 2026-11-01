/**
 * @fileoverview Reviewer-ensemble tests: every unwaived `task -> reviewer`
 * dispatch is counted and journaled as a `type:"ensemble"` entry;
 * under `reviewEnsemble: enforce` a reviewer `VERDICT: APPROVE` credits the
 * landing gate only at count >= 2 (otherwise it journals `blocked
 * /ensemble-incomplete` plus a `refusedApprove:true` stamp and leaves the gate
 * red); the count and a human-grant clear survive journal replay and one grace
 * prompt; advise mode tracks without gating; a reviewer APPROVE delivered
 * without a dispatch-input agent (a v2 structured or background result)
 * resolves through the child→parent edge + host session record and credits
 * the parent, while an unresolvable child's verdict is suppressed, uncredited,
 * and error-free. All via a fake host with injected config.
 */

import { test } from "node:test"
import assert from "node:assert/strict"
import * as fs from "node:fs"
import * as path from "node:path"

import { createLedger } from "../src/ledger.ts"
import { LANDING_REQUIREMENT } from "../src/tool-policy.ts"
import { turnstile } from "../turnstile.ts"
import {
  callPermission,
  callSession,
  callTool,
  isolatedEnv,
  journalEntries,
  makeFakeHost,
  tmpDir,
  traceText as helpersTraceText,
  waitUntil,
  type FakeHost,
} from "./helpers.ts"

const APPROVE = "VERDICT: APPROVE crit=0 high=0 med=0 low=0"
const BLOCK = "VERDICT: BLOCK crit=1 high=0 med=0 low=0"

/**
 * Boots the plugin over a fake host with a temp metrics dir and config.
 * @param config Config overrides merged over the injected `metricsDir`.
 * @param hostOpts Optional fake-host behavior (e.g. `sessionRecords` backing
 *     the `session.get` API), forwarded to `makeFakeHost`.
 */
async function boot(
  config: Record<string, any> = {},
  hostOpts?: Parameters<typeof makeFakeHost>[0],
): Promise<{ h: FakeHost; dispose: () => void; metricsDir: string }> {
  const metricsDir = tmpDir()
  const h = makeFakeHost(hostOpts)
  const setup = turnstile(h.host, {
    env: isolatedEnv(metricsDir),
    // emptyDiffExempt is pinned false here: these tests assert a push BLOCKS,
    // and with the default-on exemption the probe would consult the live
    // repo's git state at process.cwd() (nondeterministic). The dedicated
    // empty-diff tests opt back in explicitly.
    config: {
      metricsDir,
      alwaysEnforce: true,
      // Ask mode: these suites exercise the interactive ask ladder (see
      // permission-approval bootWithPlan); the block-mode default has
      // dedicated guard-level tests.
      escalation: "ask" as const,
      ...config,
      gitGates: { emptyDiffExempt: false, ...config.gitGates },
    },
  })
  const dispose = (await setup(h.host)) as () => void
  return { h, dispose, metricsDir }
}

/** Flips the test gate green for a parent so the reviewer is allowed to run. */
async function greenGate(h: FakeHost, sessionID: string): Promise<void> {
  // gateEvidence:"flag" flips on a plain PASS; the flip switch is orthogonal to
  // the ensemble count, which still needs two reviewer dispatches to credit.
  await callTool(h, "execute.after", {
    tool: "task",
    sessionID,
    input: { agent: "test-runner" },
    result: { output: "GATE: PASS tests=1 passed=1 failed=0\n" },
  })
}

/** Counts the ensemble entries journaled for a session. */
function ensembleEntries(metricsDir: string): Array<Record<string, any>> {
  return journalEntries(metricsDir).filter((e) => e.type === "ensemble")
}

/** two unwaived reviewer dispatches journal ensemble counts 1 and 2. */
test("two unwaived reviewer dispatches journal ensemble counts 1 and 2", async () => {
  const { h, dispose, metricsDir } = await boot({ gateEvidence: "flag" })
  await greenGate(h, "p1")
  await callTool(h, "execute.before", {
    tool: "task",
    sessionID: "p1",
    input: { agent: "reviewer", prompt: "first review" },
  })
  await callTool(h, "execute.before", {
    tool: "task",
    sessionID: "p1",
    input: { agent: "reviewer", prompt: "second review" },
  })
  const ens = ensembleEntries(metricsDir)
  assert.equal(ens.length, 2, "one ensemble entry per unwaived reviewer dispatch")
  assert.deepEqual(
    ens.map((e) => e.count),
    [1, 2],
  )
  assert.ok(ens.every((e) => e.agent === "reviewer" && e.sessionID === "p1"))
  dispose()
})

/** a prompt-channel waiver exempts the reviewer dispatch from counting; no
 *  ensemble entry is journaled and the count stays 0. */
test("a waived reviewer dispatch never counts toward the ensemble", async () => {
  const { h, dispose, metricsDir } = await boot({ gateEvidence: "flag" })
  await callSession(h, "prompt", { sessionID: "p1", text: "USER WAIVER: ship it" })
  await greenGate(h, "p1")
  await callTool(h, "execute.before", {
    tool: "task",
    sessionID: "p1",
    input: { agent: "reviewer", prompt: "review it" },
  })
  const ens = ensembleEntries(metricsDir)
  assert.equal(ens.length, 0, "a waived dispatch advances no ensemble count")
  dispose()
})

/**
 * A dispatched-but-never-counted task that still gets an APPROVE
 * under enforce is refused: the review is not credited (no ensemble-incomplete
 * is suppressed — instead it is journaled) and the landing gate stays red, so a
 * push escalates to a human ask. Waived dispatches never satisfy the ensemble;
 * the human permission ask is the designed release.
 */
test("a credited APPROVE at ensemble count 0 is refused and arms the landing ask", async () => {
  const { h, metricsDir, dispose } = await boot({
    gateEvidence: "flag",
  })
  try {
    await greenGate(h, "p1")
    // A waived dispatch leaves the ensemble at zero.
    await callSession(h, "prompt", { sessionID: "p1", text: "USER WAIVER: ship it" })
    await callTool(h, "execute.before", {
      tool: "task",
      sessionID: "p1",
      input: { agent: "reviewer", prompt: "review it" },
    })
    // The reviewer still delivers an APPROVE; enforce refuses it (count < 2).
    await callTool(h, "execute.after", {
      tool: "task",
      sessionID: "p1",
      input: { agent: "reviewer", prompt: "review it" },
      result: { output: `${APPROVE}\n` },
    })
    const entries = journalEntries(metricsDir)
    assert.ok(
      entries.some((e) => e.type === "ensemble" && e.refusedApprove === true && e.count === 0),
      "a refused credit is stamped refusedApprove:true",
    )
    // First push blocks for no landing approval a second time, then escalates.
    await assert.rejects(() =>
      callTool(h, "execute.before", {
        tool: "bash",
        sessionID: "p1",
        input: { command: "git push origin main" },
      }),
    )
    await callTool(h, "execute.before", {
      tool: "bash",
      sessionID: "p1",
      input: { command: "git push origin main" },
    })
    h.pushEvent({ type: "permission.asked", properties: { sessionID: "p1", id: "land-w" } })
    const event: Record<string, any> = { sessionID: "p1", action: "bash" }
    await callPermission(h, "evaluate", event)
    assert.equal(event.effect, "ask", "an incomplete ensemble arms the landing ask")
  } finally {
    dispose()
  }
})

/** enforce credits only at count >= 2. A count-1 APPROVE is refused with a
 *  byte-exact refusedApprove stamp; a second dispatch + APPROVE credits. */
test("enforce credits a reviewer APPROVE only at ensemble count 2", async () => {
  const { h, dispose, metricsDir } = await boot({
    gateEvidence: "flag",
  })
  try {
    await greenGate(h, "p1")
    await callTool(h, "execute.before", {
      tool: "task",
      sessionID: "p1",
      input: { agent: "reviewer", prompt: "review it" },
    })
    // One dispatch: the APPROVE is refused and stamped.
    await callTool(h, "execute.after", {
      tool: "task",
      sessionID: "p1",
      input: { agent: "reviewer", prompt: "review it" },
      result: { output: `${APPROVE}\n` },
    })
    assert.equal(ledgerState(metricsDir, "p1").hasReviewApprove, false)
    const refused = ensembleEntries(metricsDir).find(
      (e) => e.type === "ensemble" && e.refusedApprove === true,
    )
    assert.deepEqual(
      { ...refused, ts: undefined },
      {
        ts: undefined,
        type: "ensemble",
        sessionID: "p1",
        agent: "reviewer",
        count: 1,
        refusedApprove: true,
      },
      "the refused APPROVE journals a refusedApprove:true ensemble entry byte-exact",
    )
    const blocked = journalEntries(metricsDir).find(
      (e) => e.type === "blocked" && e.reason === "ensemble-incomplete",
    )
    assert.ok(blocked && blocked.count === 1 && blocked.need === 2)
    const traceText = helpersTraceText(metricsDir)
    assert.ok(
      traceText.includes("1 of 2 dispatches; not credited"),
      "the trace interpolates the actual dispatch count instead of a hardcoded string",
    )
    // Second dispatch completes the ensemble; a re-delivered identical APPROVE
    // (unique task-deliverySeq) credits again.
    await callTool(h, "execute.before", {
      tool: "task",
      sessionID: "p1",
      input: { agent: "reviewer", prompt: "review it again" },
    })
    await callTool(h, "execute.after", {
      tool: "task",
      sessionID: "p1",
      input: { agent: "reviewer", prompt: "review it" },
      result: { output: `${APPROVE}\n` },
    })
    assert.equal(ledgerState(metricsDir, "p1").hasReviewApprove, true)
    // The gate is now green: every push is allowed after the first block.
    assert.doesNotThrow(() =>
      callTool(h, "execute.before", {
        tool: "bash",
        sessionID: "p1",
        input: { command: "git push origin main" },
      }),
    )
  } finally {
    dispose()
  }
})

/** advise mode tracks and journals the ensemble but credits unconditionally. */
test("advise mode credits a single-reviewer APPROVE yet journals the count", async () => {
  const { h, dispose, metricsDir } = await boot({ gateEvidence: "flag", reviewEnsemble: "advise" })
  await greenGate(h, "p1")
  await callTool(h, "execute.before", {
    tool: "task",
    sessionID: "p1",
    input: { agent: "reviewer", prompt: "review it" },
  })
  await callTool(h, "execute.after", {
    tool: "task",
    sessionID: "p1",
    input: { agent: "reviewer", prompt: "review it" },
    result: { output: `${APPROVE}\n` },
  })
  assert.equal(
    ledgerState(metricsDir, "p1").hasReviewApprove,
    true,
    "advise credits a single-reviewer APPROVE unconditionally",
  )
  assert.ok(
    ensembleEntries(metricsDir).some((e) => e.count === 1),
    "advise still journals the ensemble count unconditionally",
  )
  assert.ok(
    !journalEntries(metricsDir).some(
      (e) => e.type === "blocked" && e.reason === "ensemble-incomplete",
    ),
    "advise journals no ensemble-incomplete block",
  )
  dispose()
})

/** a human always-grant outranks the ensemble — no incomplete journal, a
 *  clearing refusedApprove:false entry is journaled, and the gate releases. */
test("a human always-grant releases the gate and journals a clearing entry", async () => {
  const { h, metricsDir, dispose } = await boot()
  try {
    await assert.rejects(() =>
      callTool(h, "execute.before", {
        tool: "bash",
        sessionID: "p1",
        input: { command: "git push origin main" },
      }),
    )
    await callTool(h, "execute.before", {
      tool: "bash",
      sessionID: "p1",
      input: { command: "git push origin main" },
    })
    h.pushEvent({ type: "permission.asked", properties: { sessionID: "p1", id: "land-5" } })
    h.pushEvent({
      type: "permission.replied",
      properties: { sessionID: "p1", requestID: "land-5", reply: "always" },
    })
    await waitUntil(() =>
      journalEntries(metricsDir).some((e) => e.type === "permission" && e.decision === "always"),
    )
    const entries = journalEntries(metricsDir)
    assert.ok(
      !entries.some((e) => e.type === "blocked" && e.reason === "ensemble-incomplete"),
      "a human grant journals no ensemble-incomplete",
    )
    const clearing = entries.find(
      (e) => e.type === "ensemble" && e.refusedApprove === false && e.count === 0,
    )
    assert.ok(clearing, "a cleared ensemble entry is journaled")
    // The standing approval releases the landing gate.
    assert.doesNotThrow(() =>
      callTool(h, "execute.before", {
        tool: "bash",
        sessionID: "p1",
        input: { command: "git push origin main" },
      }),
    )
  } finally {
    dispose()
  }
})

/** the human grant survives restart — replay restores hasReviewApprove
 *  from the clearing (refusedApprove:false) entry. */
test("a human always-grant survives restart via the clearing entry", async () => {
  const { h, dispose, metricsDir } = await boot()
  try {
    await assert.rejects(() =>
      callTool(h, "execute.before", {
        tool: "bash",
        sessionID: "p1",
        input: { command: "git push origin main" },
      }),
    )
    await callTool(h, "execute.before", {
      tool: "bash",
      sessionID: "p1",
      input: { command: "git push origin main" },
    })
    h.pushEvent({ type: "permission.asked", properties: { sessionID: "p1", id: "land-5b" } })
    h.pushEvent({
      type: "permission.replied",
      properties: { sessionID: "p1", requestID: "land-5b", reply: "always" },
    })
    await waitUntil(() =>
      journalEntries(metricsDir).some((e) => e.type === "permission" && e.decision === "always"),
    )
    const ledger = createLedger(path.join(metricsDir, "turnstile.jsonl"), 64, 2000)
    assert.equal(
      ledger.state("p1").hasReviewApprove,
      true,
      "replay restores the human grant via the clearing entry",
    )
  } finally {
    dispose()
  }
})

/** a reviewer APPROVE delivered after a human always-grant must not
 *  journal a refusal: the short-circuit keeps the release intact, so a fresh
 *  replay still restores hasReviewApprove. */
test("a post-grant APPROVE delivery at a smaller count keeps the human release", async () => {
  const { h, metricsDir, dispose } = await boot({
    gateEvidence: "flag",
  })
  try {
    // The human releases the landing gate via an always-grant.
    await assert.rejects(() =>
      callTool(h, "execute.before", {
        tool: "bash",
        sessionID: "p1",
        input: { command: "git push origin main" },
      }),
    )
    await callTool(h, "execute.before", {
      tool: "bash",
      sessionID: "p1",
      input: { command: "git push origin main" },
    })
    h.pushEvent({ type: "permission.asked", properties: { sessionID: "p1", id: "land-5c" } })
    h.pushEvent({
      type: "permission.replied",
      properties: { sessionID: "p1", requestID: "land-5c", reply: "always" },
    })
    await waitUntil(() =>
      journalEntries(metricsDir).some((e) => e.type === "permission" && e.decision === "always"),
    )
    // One unwaived reviewer dispatch (count 1), then an APPROVE delivery below
    // the ensemble threshold: the already-approved short-circuit must credit
    // without journaling any refusal or block.
    await greenGate(h, "p1")
    await callTool(h, "execute.before", {
      tool: "task",
      sessionID: "p1",
      input: { agent: "reviewer", prompt: "review it" },
    })
    await callTool(h, "execute.after", {
      tool: "task",
      sessionID: "p1",
      input: { agent: "reviewer", prompt: "review it" },
      result: { output: `${APPROVE}\n` },
    })
    const entries = journalEntries(metricsDir)
    assert.ok(
      !entries.some((e) => e.type === "ensemble" && e.refusedApprove === true),
      "no refusal stamp is journaled after the human grant",
    )
    assert.ok(
      !entries.some((e) => e.type === "blocked" && e.reason === "ensemble-incomplete"),
      "no ensemble-incomplete block is journaled after the human grant",
    )
    // Fresh replay: the human's clearing entry still wins, so the release
    // survives the post-grant delivery.
    const ledger = createLedger(path.join(metricsDir, "turnstile.jsonl"), 64, 2000)
    assert.equal(
      ledger.state("p1").hasReviewApprove,
      true,
      "replay restores the human grant despite the later count-1 APPROVE delivery",
    )
  } finally {
    dispose()
  }
})

/** a restored flag entry plus a count-1 ensemble restores the count with
 *  grace; the grace prompt carries it once, then a full reset clears it. */
test("replay restores the ensemble count with grace, carried one prompt", () => {
  const metricsDir = tmpDir()
  fs.writeFileSync(
    path.join(metricsDir, "turnstile.jsonl"),
    [
      JSON.stringify({ ts: "t", type: "gate", sessionID: "p1", result: "PASS" }),
      JSON.stringify({ ts: "t", type: "ensemble", sessionID: "p1", agent: "reviewer", count: 1 }),
    ].join("\n") + "\n",
  )
  const ledger = createLedger(path.join(metricsDir, "turnstile.jsonl"), 64, 2000)
  const s = ledger.state("p1")
  assert.equal(s.reviewerDispatches, 1, "replay restores the ensemble count")
  assert.equal(s.replayGrace, true, "a restored flag tags grace alongside the count")
  // Grace prompt: mergeAfterReplay carries the restart-sticky count forward once.
  ledger.resetState("p1")
  assert.equal(ledger.state("p1").reviewerDispatches, 1, "grace carries reviewerDispatches once")
  // Second prompt: a full reset clears the count.
  ledger.resetState("p1")
  assert.equal(ledger.state("p1").reviewerDispatches, 0, "the count clears on a full reset")
})

/** malformed ensemble entries are skipped and the last valid count wins;
 *  a stale-generation tail still replays. */
test("replay skips malformed ensemble entries and honors latest-wins", () => {
  const metricsDir = tmpDir()
  fs.writeFileSync(
    path.join(metricsDir, "turnstile.jsonl"),
    [
      JSON.stringify({ ts: "t", type: "gate", sessionID: "p1", result: "PASS" }),
      JSON.stringify({ ts: "t", type: "ensemble", sessionID: "p1", agent: "reviewer", count: 1 }),
      JSON.stringify({ ts: "t", type: "ensemble", sessionID: "p1", agent: "reviewer", count: -1 }),
      JSON.stringify({ ts: "t", type: "ensemble", sessionID: "p1", agent: "reviewer", count: 1.5 }),
      JSON.stringify({ ts: "t", type: "ensemble", agent: "reviewer", count: 9 }),
      JSON.stringify({ ts: "t", type: "ensemble", sessionID: "p1", agent: "reviewer", count: 2 }),
    ].join("\n") + "\n",
  )
  const ledger = createLedger(path.join(metricsDir, "turnstile.jsonl"), 64, 2000)
  const s = ledger.state("p1")
  assert.equal(s.reviewerDispatches, 2, "the last valid count wins over malformed entries")
  assert.equal(s.replayGrace, true, "a restored gate still tags grace")
})

/** an ensemble line in the rotated `.1` generation replays, and a
 *  count above the ensemble size clamps to it on restore. */
test("an ensemble entry in the .1 generation tail replays, clamped to the ensemble size", () => {
  const metricsDir = tmpDir()
  fs.writeFileSync(
    path.join(metricsDir, "turnstile.jsonl.1"),
    `${JSON.stringify({ ts: "t", type: "ensemble", sessionID: "p1", agent: "reviewer", count: 3 })}\n`,
  )
  const ledger = createLedger(path.join(metricsDir, "turnstile.jsonl"), 64, 2000)
  assert.equal(
    ledger.state("p1").reviewerDispatches,
    2,
    "the .1 generation replays the count, clamped to the ensemble size",
  )
})

/** a refused credit is not re-credited on restart; a count-2 APPROVE
 *  restores, and a clearing entry un-suppresses a later verdict. */
test("replay suppresses a refused APPROVE and restores a credited one", () => {
  // Refused: a verdict APPROVE with a refusedApprove:true ensemble entry.
  {
    const metricsDir = tmpDir()
    fs.writeFileSync(
      path.join(metricsDir, "turnstile.jsonl"),
      [
        JSON.stringify({
          ts: "t",
          type: "verdict",
          sessionID: "p1",
          raw: "c1",
          agent: "reviewer",
          marker: APPROVE,
          source: "task-result",
        }),
        JSON.stringify({
          ts: "t",
          type: "ensemble",
          sessionID: "p1",
          agent: "reviewer",
          count: 1,
          refusedApprove: true,
        }),
      ].join("\n") + "\n",
    )
    const ledger = createLedger(path.join(metricsDir, "turnstile.jsonl"), 64, 2000)
    const s = ledger.state("p1")
    assert.equal(s.hasReviewApprove, false, "a refused APPROVE is not restored")
    assert.equal(s.reviewerDispatches, 1, "the count is still restored")
  }
  // Credited: a verdict APPROVE with a plain count-2 ensemble entry.
  {
    const metricsDir = tmpDir()
    fs.writeFileSync(
      path.join(metricsDir, "turnstile.jsonl"),
      [
        JSON.stringify({
          ts: "t",
          type: "verdict",
          sessionID: "p1",
          raw: "c1",
          agent: "reviewer",
          marker: APPROVE,
          source: "task-result",
        }),
        JSON.stringify({ ts: "t", type: "ensemble", sessionID: "p1", agent: "reviewer", count: 2 }),
      ].join("\n") + "\n",
    )
    const ledger = createLedger(path.join(metricsDir, "turnstile.jsonl"), 64, 2000)
    assert.equal(ledger.state("p1").hasReviewApprove, true, "a count-2 APPROVE restores")
  }
  // Refused then cleared: the last entry clears, so the verdict restores.
  {
    const metricsDir = tmpDir()
    fs.writeFileSync(
      path.join(metricsDir, "turnstile.jsonl"),
      [
        JSON.stringify({
          ts: "t",
          type: "verdict",
          sessionID: "p1",
          raw: "c1",
          agent: "reviewer",
          marker: APPROVE,
          source: "task-result",
        }),
        JSON.stringify({
          ts: "t",
          type: "ensemble",
          sessionID: "p1",
          agent: "reviewer",
          count: 1,
          refusedApprove: true,
        }),
        JSON.stringify({
          ts: "t",
          type: "ensemble",
          sessionID: "p1",
          agent: "reviewer",
          count: 2,
          refusedApprove: false,
        }),
      ].join("\n") + "\n",
    )
    const ledger = createLedger(path.join(metricsDir, "turnstile.jsonl"), 64, 2000)
    assert.equal(
      ledger.state("p1").hasReviewApprove,
      true,
      "a clearing entry un-suppresses the verdict",
    )
  }
})

/** the last-wins fold's hostile-journal boundary at the credited count
 *  — a verdict APPROVE whose last ensemble entry stamps
 *  `refusedApprove:true` at count-2 is still suppressed on replay, and the
 *  count itself still restores. */
test("a refusedApprove stamp at the credited count still suppresses the verdict", () => {
  const metricsDir = tmpDir()
  fs.writeFileSync(
    path.join(metricsDir, "turnstile.jsonl"),
    [
      JSON.stringify({
        ts: "t",
        type: "verdict",
        sessionID: "p1",
        raw: "c1",
        agent: "reviewer",
        marker: APPROVE,
        source: "task-result",
      }),
      JSON.stringify({
        ts: "t",
        type: "ensemble",
        sessionID: "p1",
        agent: "reviewer",
        count: 2,
        refusedApprove: true,
      }),
    ].join("\n") + "\n",
  )
  const ledger = createLedger(path.join(metricsDir, "turnstile.jsonl"), 64, 2000)
  const s = ledger.state("p1")
  assert.equal(s.hasReviewApprove, false, "a refused APPROVE at the credited count is not restored")
  assert.equal(s.reviewerDispatches, 2, "the count is still restored")
})

/** an ensemble-only journal line restores the count with no grace and no
 *  grace carry. */
test("an ensemble-only entry restores the count without grace", () => {
  const metricsDir = tmpDir()
  fs.writeFileSync(
    path.join(metricsDir, "turnstile.jsonl"),
    `${JSON.stringify({ ts: "t", type: "ensemble", sessionID: "p1", agent: "reviewer", count: 1 })}\n`,
  )
  const ledger = createLedger(path.join(metricsDir, "turnstile.jsonl"), 64, 2000)
  const s = ledger.state("p1")
  assert.equal(s.reviewerDispatches, 1, "the bare count is restored")
  assert.equal(s.replayGrace, false, "no flag restored means no grace tagged")
  ledger.resetState("p1")
  assert.equal(
    ledger.state("p1").reviewerDispatches,
    0,
    "no grace carry: the count clears on the next prompt",
  )
})

/** an incomplete ensemble on the push ladder arms the human ask exactly as
 *  an unreviewed task does — no new block surface. */
test("an incomplete ensemble arms the landing ask like an unreviewed task", async () => {
  const { h, dispose, metricsDir } = await boot({
    gateEvidence: "flag",
  })
  try {
    await greenGate(h, "p1")
    await callTool(h, "execute.before", {
      tool: "task",
      sessionID: "p1",
      input: { agent: "reviewer", prompt: "review it" },
    })
    // One APPROVE at count 1 is refused: the landing gate stays red.
    await callTool(h, "execute.after", {
      tool: "task",
      sessionID: "p1",
      input: { agent: "reviewer", prompt: "review it" },
      result: { output: `${APPROVE}\n` },
    })
    assert.equal(ledgerState(metricsDir, "p1").hasReviewApprove, false)
    // First push blocks for no landing approval (same surface as unreviewed).
    await assert.rejects(() =>
      callTool(h, "execute.before", {
        tool: "bash",
        sessionID: "p1",
        input: { command: "git push origin main" },
      }),
    )
    // Repeat push escalates and arms the human ask.
    await callTool(h, "execute.before", {
      tool: "bash",
      sessionID: "p1",
      input: { command: "git push origin main" },
    })
    h.pushEvent({ type: "permission.asked", properties: { sessionID: "p1", id: "land-8" } })
    const event: Record<string, any> = { sessionID: "p1", action: "bash" }
    await callPermission(h, "evaluate", event)
    assert.equal(event.effect, "ask", "the incomplete ensemble arms the landing ask")
    assert.ok(
      journalEntries(metricsDir)
        .filter((e) => e.type === "blocked")
        .every((e) => e.reason === "no-landing-approval" || e.reason === "ensemble-incomplete"),
      "only the landing ask and the ensemble-incomplete refusal surface as blocks",
    )
  } finally {
    dispose()
  }
})

/**
 * Delivery-agent resolution: these cases cover a reviewer
 * or plan-reviewer result delivered without a dispatch-input agent — the v2
 * structured / background shape — which must resolve the delivery agent
 * through the child→parent edge + host session record and credit the parent.
 * The earlier cases in this file keep their own configs unchanged; every case below shares
 * DELIVER_ENFORCE — flag-mode evidence (greenGate flips on a plain PASS) and the
 * enforced ensemble default — so the landing assertions never depend on config
 * defaults and the ensemble default (enforce) is stated for legibility.
 */
const DELIVER_ENFORCE: Record<string, any> = {
  gateEvidence: "flag",
  reviewEnsemble: "enforce",
}

/** Dispatches the two unwaived reviewer dispatches that complete the ensemble. */
async function dispatchReviewers(h: FakeHost, sessionID: string): Promise<void> {
  await callTool(h, "execute.before", {
    tool: "task",
    sessionID,
    input: { agent: "reviewer", prompt: "first review" },
  })
  await callTool(h, "execute.before", {
    tool: "task",
    sessionID,
    input: { agent: "reviewer", prompt: "second review" },
  })
}

/**
 * Delivers a structured task result naming the child; `input` is present only
 * when the case dispatches with an agent (the no-agent shape omits it).
 */
async function deliverStructured(
  h: FakeHost,
  sessionID: string,
  child: string,
  text: string,
  input?: Record<string, any>,
): Promise<void> {
  await callTool(h, "execute.after", {
    tool: "task",
    sessionID,
    ...(input ? { input } : {}),
    result: { output: { sessionID: child, output: text } },
  })
}

/**
 * a structured reviewer APPROVE with no dispatch-input agent credits the
 * parent through the session.created edge — the child's verdict stays
 * authoritative, the credit lands on the parent bucket (replay-restored), and
 * the landing gate releases.
 */
test("a no-input structured APPROVE credits through the created edge", async () => {
  const { h, dispose, metricsDir } = await boot(DELIVER_ENFORCE)
  try {
    await greenGate(h, "p1")
    await dispatchReviewers(h, "p1")
    await h.pushEvent({
      type: "session.created",
      data: { sessionID: "c1", parentID: "p1", agent: "reviewer" },
    })
    await deliverStructured(h, "p1", "c1", `${APPROVE}\n`)
    const entries = journalEntries(metricsDir)
    const verdict = entries.find((e) => e.type === "verdict")
    assert.ok(verdict, "the first-sight verdict is journaled")
    assert.equal(verdict.sessionID, "p1", "the verdict keys on the resolved parent")
    assert.equal(verdict.raw, "c1", "the verdict keeps the raw child ID")
    assert.equal(verdict.source, "task-result")
    assert.ok(
      !entries.some((e) => e.type === "blocked" && e.reason === "ensemble-incomplete"),
      "a complete ensemble credits without a refusal",
    )
    assert.equal(
      ledgerState(metricsDir, "p1").hasReviewApprove,
      true,
      "replay restores the edge-resolved credit",
    )
    // The released landing gate allows a push.
    assert.doesNotThrow(() =>
      callTool(h, "execute.before", {
        tool: "bash",
        sessionID: "p1",
        input: { command: "git push origin main" },
      }),
    )
  } finally {
    dispose()
  }
})

/**
 * with no session.created event, the host session record is the only
 * edge route — the delivery's awaited session.get resolves parent and agent,
 * the credit lands on the record's parent (never the unregistered child), and
 * nothing is suppressed (the record's agent is authoritative).
 */
test("a no-input structured APPROVE credits through the host session record", async () => {
  const { h, dispose, metricsDir } = await boot(DELIVER_ENFORCE, {
    sessionRecords: new Map([["c1", { parentID: "p1", agent: "reviewer" }]]),
  })
  try {
    await greenGate(h, "p1")
    await dispatchReviewers(h, "p1")
    await deliverStructured(h, "p1", "c1", `${APPROVE}\n`)
    assert.equal(
      ledgerState(metricsDir, "p1").hasReviewApprove,
      true,
      "the credit lands on the record-resolved parent",
    )
    assert.equal(
      ledgerState(metricsDir, "c1").hasReviewApprove,
      false,
      "the unregistered child is never credited",
    )
    assert.ok(
      !journalEntries(metricsDir).some((e) => e.type === "suppressed"),
      "the record's agent is authoritative: no verdict is suppressed",
    )
  } finally {
    dispose()
  }
})

/**
 * the no-input shape is still ensemble-gated — a count-1 delivery is
 * refused (blocked + refusedApprove stamp, gate red), and the identical
 * re-delivery after the second dispatch first-sights again (fresh
 * task-deliverySeq dedup scope) and credits.
 */
test("a no-input APPROVE is refused at count 1 and credits at count 2", async () => {
  const { h, dispose, metricsDir } = await boot(DELIVER_ENFORCE, {
    sessionRecords: new Map([["c1", { parentID: "p1", agent: "reviewer" }]]),
  })
  try {
    await greenGate(h, "p1")
    await callTool(h, "execute.before", {
      tool: "task",
      sessionID: "p1",
      input: { agent: "reviewer", prompt: "review it" },
    })
    await deliverStructured(h, "p1", "c1", `${APPROVE}\n`)
    assert.equal(
      ledgerState(metricsDir, "p1").hasReviewApprove,
      false,
      "count 1 is below the ensemble threshold",
    )
    const blocked = journalEntries(metricsDir).find(
      (e) => e.type === "blocked" && e.reason === "ensemble-incomplete",
    )
    assert.ok(blocked && blocked.count === 1 && blocked.need === 2)
    assert.ok(
      ensembleEntries(metricsDir).some((e) => e.refusedApprove === true && e.count === 1),
      "the refused credit is stamped",
    )
    // The second dispatch completes the ensemble; the identical re-delivery
    // (fresh dedup scope) first-sights the APPROVE again and credits.
    await callTool(h, "execute.before", {
      tool: "task",
      sessionID: "p1",
      input: { agent: "reviewer", prompt: "review it again" },
    })
    await deliverStructured(h, "p1", "c1", `${APPROVE}\n`)
    assert.equal(
      ledgerState(metricsDir, "p1").hasReviewApprove,
      true,
      "the re-delivered APPROVE credits at count 2",
    )
  } finally {
    dispose()
  }
})

/**
 * a no-input delivery credit survives a journal replay and exactly one
 * grace prompt (the restored flag is restart-sticky, like the human grant),
 * then clears on a full reset.
 */
test("a no-input delivery credit survives replay and one grace prompt", async () => {
  const { h, metricsDir, dispose } = await boot(DELIVER_ENFORCE, {
    sessionRecords: new Map([["c1", { parentID: "p1", agent: "reviewer" }]]),
  })
  try {
    await greenGate(h, "p1")
    await dispatchReviewers(h, "p1")
    await deliverStructured(h, "p1", "c1", `${APPROVE}\n`)
    const ledger = createLedger(path.join(metricsDir, "turnstile.jsonl"), 64, 2000)
    assert.equal(ledger.state("p1").hasReviewApprove, true, "replay restores the credit")
    // Grace prompt: the restored flag carries exactly one reset.
    ledger.resetState("p1")
    assert.equal(ledger.state("p1").hasReviewApprove, true, "grace carries the credit once")
    // Second prompt: a full reset clears the flag.
    ledger.resetState("p1")
    assert.equal(ledger.state("p1").hasReviewApprove, false, "the flag clears on a full reset")
  } finally {
    dispose()
  }
})

/**
 * the credit is delivery-attributed, not prompt-mediated: no user prompt
 * is admitted at any point, so the journal carries no prompt-admission
 * artifacts (child-reset / continuation) and the release is purely the
 * delivered verdict.
 */
test("a no-input delivery credit journals no prompt-admission entries", async () => {
  const { h, dispose, metricsDir } = await boot(DELIVER_ENFORCE)
  try {
    await greenGate(h, "p1")
    await dispatchReviewers(h, "p1")
    await h.pushEvent({
      type: "session.created",
      data: { sessionID: "c1", parentID: "p1", agent: "reviewer" },
    })
    await deliverStructured(h, "p1", "c1", `${APPROVE}\n`)
    assert.equal(ledgerState(metricsDir, "p1").hasReviewApprove, true)
    // The released landing gate allows a push.
    assert.doesNotThrow(() =>
      callTool(h, "execute.before", {
        tool: "bash",
        sessionID: "p1",
        input: { command: "git push origin main" },
      }),
    )
    const entries = journalEntries(metricsDir)
    assert.ok(
      !entries.some((e) => e.type === "child-reset"),
      "no prompt was admitted: no child-reset audit",
    )
    assert.ok(
      !entries.some((e) => e.type === "continuation"),
      "no prompt was admitted: no continuation carry",
    )
  } finally {
    dispose()
  }
})

/**
 * when the dispatch input names the reviewer, it outranks the agent the
 * created edge recorded for the child (a test-runner seed never clobbers the
 * delivery's own attribution).
 */
test("a dispatch-input agent outranks the created edge's agent", async () => {
  const { h, dispose, metricsDir } = await boot(DELIVER_ENFORCE)
  try {
    await greenGate(h, "p1")
    await dispatchReviewers(h, "p1")
    await h.pushEvent({
      type: "session.created",
      data: { sessionID: "c1", parentID: "p1", agent: "test-runner" },
    })
    await deliverStructured(h, "p1", "c1", `${APPROVE}\n`, { agent: "reviewer" })
    assert.equal(
      ledgerState(metricsDir, "p1").hasReviewApprove,
      true,
      "the dispatch input names the reviewer; the edge's agent does not override it",
    )
  } finally {
    dispose()
  }
})

/**
 * a reviewer delivery carrying only a BLOCK exits the credit guard
 * before the ensemble check — no credit, no refusal stamp, no block entry;
 * the landing gate stays red.
 */
test("a reviewer BLOCK delivery stamps no refusal and credits nothing", async () => {
  const { h, dispose, metricsDir } = await boot(DELIVER_ENFORCE)
  try {
    // Self-keyed v1 string delivery: the delivery seed makes the session's own
    // text authoritative, so the BLOCK is journaled as a verdict — but it
    // carries no APPROVE to credit.
    await callTool(h, "execute.after", {
      tool: "task",
      sessionID: "p1",
      input: { agent: "reviewer" },
      result: { output: `${BLOCK}\n` },
    })
    const entries = journalEntries(metricsDir)
    assert.ok(
      !entries.some((e) => e.type === "verdict" && e.marker.includes("APPROVE")),
      "a BLOCK never journals an APPROVE verdict",
    )
    assert.ok(
      !entries.some((e) => e.type === "ensemble" && e.refusedApprove === true),
      "no refusal is stamped: the credit guard exits before the ensemble check",
    )
    assert.ok(
      !entries.some((e) => e.type === "blocked" && e.reason === "ensemble-incomplete"),
      "no ensemble-incomplete block is journaled",
    )
    assert.equal(ledgerState(metricsDir, "p1").hasReviewApprove, false)
  } finally {
    dispose()
  }
})

/**
 * a child with no edge route at all (absent session record) resolves no
 * agent: its APPROVE is denied authority and journaled as a suppressed audit
 * entry with the empty emitter, never credited, and the absent record is not
 * an error.
 */
test("an unresolvable child's APPROVE is suppressed, uncredited, and error-free", async () => {
  const { h, dispose, metricsDir } = await boot(DELIVER_ENFORCE, {
    sessionRecords: new Map<string, any>(),
  })
  try {
    await deliverStructured(h, "p1", "c1", `${APPROVE}\n`)
    const entries = journalEntries(metricsDir)
    assert.ok(
      !entries.some((e) => e.type === "verdict"),
      "an unseeded child's verdict is denied authority: nothing is journaled as a verdict",
    )
    const suppressed = entries.find((e) => e.type === "suppressed")
    assert.ok(suppressed, "the denial is journaled as a suppressed audit entry")
    assert.equal(suppressed.agent, "", "the suppression audit names the unresolved (empty) emitter")
    assert.ok(!entries.some((e) => e.type === "error"), "an absent record is not an error")
    assert.equal(ledgerState(metricsDir, "c1").hasReviewApprove, false)
    assert.equal(ledgerState(metricsDir, "p1").hasReviewApprove, false)
  } finally {
    dispose()
  }
})

/**
 * the plan-verdict attribution is symmetric — a no-input plan-reviewer
 * APPROVE resolves through the host session record, attributes the plan entry
 * through the child (raw = child, never the parent), and the approval
 * survives a journal replay.
 */
test("a no-input plan-reviewer APPROVE attributes through the session record", async () => {
  const project = tmpDir()
  fs.mkdirSync(path.join(project, ".opencode", "plans"), { recursive: true })
  fs.writeFileSync(path.join(project, ".opencode", "plans", "plan.md"), "# P\n")
  const metricsDir = tmpDir()
  const h = makeFakeHost({
    sessionRecords: new Map([["c1", { parentID: "p1", agent: "plan-reviewer" }]]),
  })
  const prev = process.cwd()
  process.chdir(project)
  try {
    const setup = turnstile(h.host, {
      env: isolatedEnv(metricsDir),
      config: { metricsDir, ...DELIVER_ENFORCE },
    })
    const dispose = (await setup(h.host)) as () => void
    await deliverStructured(h, "p1", "c1", `${APPROVE}\n`)
    const plan = journalEntries(metricsDir)
      .filter((e) => e.type === "plan")
      .find((e) => e.raw === "c1")
    assert.ok(plan, "the plan entry attributes through the child")
    assert.equal(plan.sessionID, "p1", "the plan entry keys on the resolved parent")
    assert.equal(plan.result, "APPROVE")
    assert.equal(plan.source, "task-result")
    const ledger = createLedger(path.join(metricsDir, "turnstile.jsonl"), 64, 2000)
    assert.equal(
      ledger.state("p1").hasPlanVerdict,
      true,
      "replay restores the record-attributed approval",
    )
    dispose()
  } finally {
    process.chdir(prev)
  }
})

/**
 * a mechanical credit outlives its own task bucket — the landing prompt
 * resets `hasReviewApprove`, but the credit trace survives, so the first push
 * of the landing turn is the human decision point: no `BlockError`, exactly
 * one landing ask journaled, no `no-landing-approval` block, and
 * the evaluate handler forces the ask with the landing requirement message.
 */
test("a credited APPROVE arms the landing ask on the first push of the landing prompt", async () => {
  const { h, dispose, metricsDir } = await boot({
    gateEvidence: "flag",
  })
  try {
    await greenGate(h, "p1")
    await callTool(h, "execute.before", {
      tool: "task",
      sessionID: "p1",
      input: { agent: "reviewer", prompt: "review it" },
    })
    await callTool(h, "execute.before", {
      tool: "task",
      sessionID: "p1",
      input: { agent: "reviewer", prompt: "review it again" },
    })
    await callTool(h, "execute.after", {
      tool: "task",
      sessionID: "p1",
      input: { agent: "reviewer", prompt: "review it" },
      result: { output: `${APPROVE}\n` },
    })
    assert.equal(
      ledgerState(metricsDir, "p1").hasReviewApprove,
      true,
      "the complete-ensemble APPROVE credits before the reset",
    )
    // The orchestrator's landing prompt: the bucket reset clears the flag;
    // the credit trace (bucket-free) survives.
    await callSession(h, "prompt", { sessionID: "p1", text: "create branch, push, open PR" })
    // The landing turn's first push: the prior block count is 0, so the
    // credit trace is the only branch that can reach the escalation — it
    // must not throw the first block.
    await callTool(h, "execute.before", {
      tool: "bash",
      sessionID: "p1",
      input: { command: "git push origin main" },
    })
    h.pushEvent({ type: "permission.asked", properties: { sessionID: "p1", id: "land-10" } })
    const event: Record<string, any> = { sessionID: "p1", action: "bash" }
    await callPermission(h, "evaluate", event)
    assert.equal(event.effect, "ask", "the escalated first push forces the landing ask")
    assert.equal(event.message, `turnstile: ${LANDING_REQUIREMENT}`)
    const entries = journalEntries(metricsDir)
    const asks = entries.filter(
      (e) => e.type === "permission" && e.action === "ask" && e.reason === "landing",
    )
    assert.equal(asks.length, 1, "the escalated first push is the single ask record")
    assert.ok(
      !entries.some((e) => e.type === "blocked" && e.reason === "no-landing-approval"),
      "a credited session's first push journals no no-landing-approval block",
    )
  } finally {
    dispose()
  }
})

/**
 * the human always-release is credit — the next prompt's reset clears
 * the `hasReviewApprove` flag but not the credit trace, so the next turn's
 * first push escalates to the human ask instead of throwing the first block.
 */
test("a human always landing release arms the ask on the next turn's first push", async () => {
  const { h, dispose, metricsDir } = await boot({
    gateEvidence: "flag",
  })
  try {
    // Ladder to the human release: first block, repeat escalates, and the
    // always reply becomes the standing release (flag + credit trace).
    await assert.rejects(() =>
      callTool(h, "execute.before", {
        tool: "bash",
        sessionID: "p1",
        input: { command: "git push origin main" },
      }),
    )
    await callTool(h, "execute.before", {
      tool: "bash",
      sessionID: "p1",
      input: { command: "git push origin main" },
    })
    h.pushEvent({ type: "permission.asked", properties: { sessionID: "p1", id: "land-11" } })
    h.pushEvent({
      type: "permission.replied",
      properties: { sessionID: "p1", requestID: "land-11", reply: "always" },
    })
    await waitUntil(() =>
      journalEntries(metricsDir).some((e) => e.type === "permission" && e.decision === "always"),
    )
    // The next turn: the prompt reset clears the flag, but the human release
    // is credit the trace still carries.
    await callSession(h, "prompt", { sessionID: "p1", text: "fix the flake and push" })
    // The next turn's first push escalates (no BlockError): the release is
    // credit, so the human decides it again.
    await callTool(h, "execute.before", {
      tool: "bash",
      sessionID: "p1",
      input: { command: "git push origin main" },
    })
    h.pushEvent({ type: "permission.asked", properties: { sessionID: "p1", id: "land-11b" } })
    const event: Record<string, any> = { sessionID: "p1", action: "bash" }
    await callPermission(h, "evaluate", event)
    assert.equal(event.effect, "ask", "the next turn's first push forces the landing ask")
    assert.equal(event.message, `turnstile: ${LANDING_REQUIREMENT}`)
    const entries = journalEntries(metricsDir)
    assert.equal(
      entries.filter((e) => e.type === "permission" && e.action === "ask" && e.reason === "landing")
        .length,
      2,
      "one ask per escalated attempt (pre-reset repeat, post-reset first push)",
    )
    assert.equal(
      entries.filter((e) => e.type === "blocked" && e.reason === "no-landing-approval").length,
      1,
      "only the pre-reset first block carries no-landing-approval",
    )
  } finally {
    dispose()
  }
})

/**
 * Stale credit: the credit trace has no TTL, and prompt resets neither
 * consume nor clear it, so a release journaled several turns ago still
 * escalates the session's first push to the human ask instead of throwing a
 * `no-landing-approval` block — the human remains the decision point across
 * the stale window (documented as assumed-acceptable: the restart path
 * already trusts the same journal fact indefinitely).
 */
test("a stale journaled release still escalates the first push after later prompts", async () => {
  const { h, dispose, metricsDir } = await boot({
    gateEvidence: "flag",
  })
  try {
    // Ladder to the human release: first block, repeat escalates, always reply.
    await assert.rejects(() =>
      callTool(h, "execute.before", {
        tool: "bash",
        sessionID: "p1",
        input: { command: "git push origin main" },
      }),
    )
    await callTool(h, "execute.before", {
      tool: "bash",
      sessionID: "p1",
      input: { command: "git push origin main" },
    })
    h.pushEvent({ type: "permission.asked", properties: { sessionID: "p1", id: "land-stale" } })
    h.pushEvent({
      type: "permission.replied",
      properties: { sessionID: "p1", requestID: "land-stale", reply: "always" },
    })
    await waitUntil(() =>
      journalEntries(metricsDir).some((e) => e.type === "permission" && e.decision === "always"),
    )
    // Two later turns: each prompt reset clears the flag; none clears the trace.
    await callSession(h, "prompt", { sessionID: "p1", text: "task A" })
    await callSession(h, "prompt", { sessionID: "p1", text: "task B" })
    // The stale turn's first push escalates instead of throwing the first block.
    await callTool(h, "execute.before", {
      tool: "bash",
      sessionID: "p1",
      input: { command: "git push origin main" },
    })
    const entries = journalEntries(metricsDir)
    assert.equal(
      entries.filter((e) => e.type === "permission" && e.action === "ask" && e.reason === "landing")
        .length,
      2,
      "one ask per escalated attempt (pre-reset repeat, stale first push)",
    )
    assert.equal(
      entries.filter((e) => e.type === "blocked" && e.reason === "no-landing-approval").length,
      1,
      "only the pre-reset first block carries no-landing-approval",
    )
  } finally {
    dispose()
  }
})

/** Reads a parent bucket's replayed state via a private ledger replay of the
 *  metrics dir, so hook-flow tests can assert on the landing gate flag. */
function ledgerState(
  metricsDir: string,
  sessionID: string,
): {
  hasReviewApprove: boolean
} {
  const ledger = createLedger(path.join(metricsDir, "turnstile.jsonl"), 64, 2000)
  return { hasReviewApprove: ledger.state(sessionID).hasReviewApprove }
}
