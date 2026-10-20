/**
 * @fileoverview Reviewer-ensemble tests: every unwaived `task -> reviewer`
 * dispatch is counted and journaled as a `type:"ensemble"` entry;
 * under `reviewEnsemble: enforce` a reviewer `VERDICT: APPROVE` credits the
 * landing gate only at count >= 2 (otherwise it journals `blocked
 * /ensemble-incomplete` plus a `refusedApprove:true` stamp and leaves the gate
 * red); the count and a human-grant clear survive journal replay and one grace
 * prompt; advise mode tracks without gating. All via a fake host with injected
 * config.
 */

import { test } from "node:test"
import assert from "node:assert/strict"
import * as fs from "node:fs"
import * as path from "node:path"

import { createLedger } from "../src/ledger.ts"
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

/** Boots the plugin over a fake host with a temp metrics dir and config. */
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

/** T1: two unwaived reviewer dispatches journal ensemble counts 1 and 2. */
test("T1: two unwaived reviewer dispatches journal ensemble counts 1 and 2", async () => {
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

/** T2: a prompt-channel waiver exempts the reviewer dispatch from counting; no
 *  ensemble entry is journaled and the count stays 0. */
test("T2: a waived reviewer dispatch never counts toward the ensemble", async () => {
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
 * T2 (cont.): a dispatched-but-never-counted task that still gets an APPROVE
 * under enforce is refused: the review is not credited (no ensemble-incomplete
 * is suppressed — instead it is journaled) and the landing gate stays red, so a
 * push escalates to a human ask. Waived dispatches never satisfy the ensemble;
 * the human permission ask is the designed release.
 */
test("T2: a credited APPROVE at ensemble count 0 is refused and arms the landing ask", async () => {
  const { h, metricsDir, dispose } = await boot({
    gateEvidence: "flag",
    gitGates: { mode: "enforce" },
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

/** T3: enforce credits only at count >= 2. A count-1 APPROVE is refused with a
 *  byte-exact refusedApprove stamp; a second dispatch + APPROVE credits. */
test("T3: enforce credits a reviewer APPROVE only at ensemble count 2", async () => {
  const { h, dispose, metricsDir } = await boot({
    gateEvidence: "flag",
    gitGates: { mode: "enforce" },
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

/** T4: advise mode tracks and journals the ensemble but credits unconditionally. */
test("T4: advise mode credits a single-reviewer APPROVE yet journals the count", async () => {
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

/** T5: a human always-grant outranks the ensemble — no incomplete journal, a
 *  clearing refusedApprove:false entry is journaled, and the gate releases. */
test("T5: a human always-grant releases the gate and journals a clearing entry", async () => {
  const { h, metricsDir, dispose } = await boot({ gitGates: { mode: "enforce" } })
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

/** T5b: the human grant survives restart — replay restores hasReviewApprove
 *  from the clearing (refusedApprove:false) entry. */
test("T5b: a human always-grant survives restart via the clearing entry", async () => {
  const { h, dispose, metricsDir } = await boot({ gitGates: { mode: "enforce" } })
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
    const ledger = createLedger(path.join(metricsDir, "turnstile.jsonl"))
    assert.equal(
      ledger.state("p1").hasReviewApprove,
      true,
      "replay restores the human grant via the clearing entry",
    )
  } finally {
    dispose()
  }
})

/** T5c: a reviewer APPROVE delivered after a human always-grant must not
 *  journal a refusal: the short-circuit keeps the release intact, so a fresh
 *  replay still restores hasReviewApprove. */
test("T5c: a post-grant APPROVE delivery at a smaller count keeps the human release", async () => {
  const { h, metricsDir, dispose } = await boot({
    gateEvidence: "flag",
    gitGates: { mode: "enforce" },
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
    const ledger = createLedger(path.join(metricsDir, "turnstile.jsonl"))
    assert.equal(
      ledger.state("p1").hasReviewApprove,
      true,
      "replay restores the human grant despite the later count-1 APPROVE delivery",
    )
  } finally {
    dispose()
  }
})

/** T6: a restored flag entry plus a count-1 ensemble restores the count with
 *  grace; the grace prompt carries it once, then a full reset clears it. */
test("T6: replay restores the ensemble count with grace, carried one prompt", () => {
  const metricsDir = tmpDir()
  fs.writeFileSync(
    path.join(metricsDir, "turnstile.jsonl"),
    [
      JSON.stringify({ ts: "t", type: "gate", sessionID: "p1", result: "PASS" }),
      JSON.stringify({ ts: "t", type: "ensemble", sessionID: "p1", agent: "reviewer", count: 1 }),
    ].join("\n") + "\n",
  )
  const ledger = createLedger(path.join(metricsDir, "turnstile.jsonl"))
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

/** T7: malformed ensemble entries are skipped and the last valid count wins;
 *  a stale-generation tail still replays. */
test("T7: replay skips malformed ensemble entries and honors latest-wins", () => {
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
  const ledger = createLedger(path.join(metricsDir, "turnstile.jsonl"))
  const s = ledger.state("p1")
  assert.equal(s.reviewerDispatches, 2, "the last valid count wins over malformed entries")
  assert.equal(s.replayGrace, true, "a restored gate still tags grace")
})

/** T7 (gen): an ensemble line in the rotated `.1` generation replays. */
test("T7: an ensemble entry in the .1 generation tail replays", () => {
  const metricsDir = tmpDir()
  fs.writeFileSync(
    path.join(metricsDir, "turnstile.jsonl.1"),
    `${JSON.stringify({ ts: "t", type: "ensemble", sessionID: "p1", agent: "reviewer", count: 3 })}\n`,
  )
  const ledger = createLedger(path.join(metricsDir, "turnstile.jsonl"))
  assert.equal(ledger.state("p1").reviewerDispatches, 3, "the .1 generation replays the count")
})

/** T7b: a refused credit is not re-credited on restart; a count-2 APPROVE
 *  restores, and a clearing entry un-suppresses a later verdict. */
test("T7b: replay suppresses a refused APPROVE and restores a credited one", () => {
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
    const ledger = createLedger(path.join(metricsDir, "turnstile.jsonl"))
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
          marker: APPROVE,
          source: "task-result",
        }),
        JSON.stringify({ ts: "t", type: "ensemble", sessionID: "p1", agent: "reviewer", count: 2 }),
      ].join("\n") + "\n",
    )
    const ledger = createLedger(path.join(metricsDir, "turnstile.jsonl"))
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
    const ledger = createLedger(path.join(metricsDir, "turnstile.jsonl"))
    assert.equal(
      ledger.state("p1").hasReviewApprove,
      true,
      "a clearing entry un-suppresses the verdict",
    )
  }
})

/** T7c: an ensemble-only journal line restores the count with no grace and no
 *  grace carry. */
test("T7c: an ensemble-only entry restores the count without grace", () => {
  const metricsDir = tmpDir()
  fs.writeFileSync(
    path.join(metricsDir, "turnstile.jsonl"),
    `${JSON.stringify({ ts: "t", type: "ensemble", sessionID: "p1", agent: "reviewer", count: 1 })}\n`,
  )
  const ledger = createLedger(path.join(metricsDir, "turnstile.jsonl"))
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

/** T8: an incomplete ensemble on the push ladder arms the human ask exactly as
 *  an unreviewed task does — no new block surface. */
test("T8: an incomplete ensemble arms the landing ask like an unreviewed task", async () => {
  const { h, dispose, metricsDir } = await boot({
    gateEvidence: "flag",
    gitGates: { mode: "enforce" },
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

/** Reads a parent bucket's replayed state via a private ledger replay of the
 *  metrics dir, so hook-flow tests can assert on the landing gate flag. */
function ledgerState(
  metricsDir: string,
  sessionID: string,
): {
  hasReviewApprove: boolean
} {
  const ledger = createLedger(path.join(metricsDir, "turnstile.jsonl"))
  return { hasReviewApprove: ledger.state(sessionID).hasReviewApprove }
}
