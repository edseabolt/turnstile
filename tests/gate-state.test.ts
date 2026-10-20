/**
 * @fileoverview Gate-state tests: reviewer dispatch gate, waivers, the
 * dispatch-based round cap, marker dedup, journal replay, read horizon
 * (parent-keyed), bare-output scoping, decoding clamps, the decomposition
 * gate, and the stream-event loop (child→parent resolution and child-text
 * marker parsing), all via a fake host with injected config.
 */

import { test } from "node:test"
import assert from "node:assert/strict"
import * as fs from "node:fs"
import * as path from "node:path"

import { BlockError, createGates } from "../src/gates.ts"
import { defaultConfig } from "../src/config.ts"
import type { GateState } from "../src/types.ts"
import { createJournaler } from "../src/journal.ts"
import { clearMeteringCounters, formatGateSnapshot, newState } from "../src/state.ts"
import { createLedger } from "../src/ledger.ts"
import { turnstile } from "../turnstile.ts"
import {
  callSession,
  callTool,
  isolatedEnv,
  journalEntries,
  makeFakeHost,
  tmpDir,
  traceText,
  waitUntil,
  type FakeHost,
} from "./helpers.ts"

const NO_GATE_MESSAGE =
  "BLOCKED by turnstile: no reviewer dispatch before the test gate is green. " +
  "Run the test-runner subagent first; dispatch reviewer only after its first line is " +
  "`GATE: PASS tests=<n> passed=<n> failed=<n>`, or obtain an explicit user waiver " +
  "(a user prompt this task must contain the literal marker 'USER WAIVER:' followed by the user's words)."

/** The clause a block appends when the task's unscoped waiver was already
 *  consumed by the first dispatch it unlocked. */
const CONSUMED_CLAUSE =
  " The task's unscoped user waiver was consumed by the first dispatch it unlocked; a new waiver is needed for the next dispatch."

/** The gate-unverified block message: a PASS was recorded without
 *  a correlating journaled test-command execution (enforce mode). Rendered
 *  by the two-argument guard call (no search context) — the legacy bytes. */
const GATE_UNVERIFIED_MESSAGE =
  "BLOCKED by turnstile: reviewer dispatch without gate evidence: a GATE: PASS " +
  "was recorded without a journaled successful test-command execution for this " +
  "session. Run the test-runner subagent first, or obtain an explicit user waiver " +
  "(a user prompt this task must contain the literal marker 'USER WAIVER:' followed by the user's words)."

/** The gate-unverified block message when the guard ran with a search
 *  context and no journaled test execution is on record anywhere for the
 *  searched scope (the setup-driven path always supplies the context). */
const GATE_UNVERIFIED_SEARCHED_NONE_MESSAGE =
  "BLOCKED by turnstile: reviewer dispatch without gate evidence: a GATE: PASS " +
  "was recorded without a journaled successful test-command execution for this " +
  "session (searched p1; journaled test executions: none). Run the test-runner subagent first, or obtain an explicit user waiver " +
  "(a user prompt this task must contain the literal marker 'USER WAIVER:' followed by the user's words)."

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

/** The exact enforcement message must be thrown (as BlockError) and journaled. */
test("reviewer dispatch is blocked before any GATE: PASS, with the exact message", async () => {
  const { h, dispose, metricsDir } = await boot()
  await assert.rejects(
    () =>
      callTool(h, "execute.before", {
        tool: "task",
        sessionID: "p1",
        input: { agent: "reviewer", prompt: "review it" },
      }),
    (e: Error) => e.message === NO_GATE_MESSAGE && e instanceof BlockError,
  )
  const entries = journalEntries(metricsDir)
  assert.ok(entries.some((l) => l.type === "dispatch" && l.agent === "reviewer"))
  assert.ok(entries.some((l) => l.type === "blocked" && l.reason === "no-gate-pass"))
  dispose()
})

/** The prompt-channel `USER WAIVER:` marker allows the dispatch and the quote
 *  is journaled with `channel: "prompt"` provenance. */
test("USER WAIVER: in the prompt waives the gate and is journaled", async () => {
  const { h, dispose, metricsDir } = await boot()
  await callSession(h, "prompt", { sessionID: "p1", text: "USER WAIVER: user said ship it" })
  await callTool(h, "execute.before", {
    tool: "task",
    sessionID: "p1",
    input: { agent: "reviewer", prompt: "review it" },
  })
  const waived = journalEntries(metricsDir).find((l) => l.type === "gate" && l.result === "WAIVED")
  assert.ok(waived)
  assert.equal(waived?.channel, "prompt")
  assert.equal(waived?.waiver, "USER WAIVER: user said ship it")
  dispose()
})

/** Waivers are per dispatch for the reviewer gate: after the prompt-channel
 *  waiver is consumed by the dispatch that unlocks it, a later marker-less
 *  dispatch is blocked again — and the block reports the consumed waiver. */
test("waiver is per dispatch: a later marker-less dispatch is blocked again", async () => {
  const { h, dispose } = await boot()
  await callSession(h, "prompt", { sessionID: "p1", text: "USER WAIVER: user said ship it" })
  await callTool(h, "execute.before", {
    tool: "task",
    sessionID: "p1",
    input: { agent: "reviewer", prompt: "review it" },
  })
  await assert.rejects(
    () =>
      callTool(h, "execute.before", {
        tool: "task",
        sessionID: "p1",
        input: { agent: "reviewer", prompt: "review it again" },
      }),
    (e: Error) => e.message === NO_GATE_MESSAGE + CONSUMED_CLAUSE,
  )
  dispose()
})

/** With trace:false the waiver quote is redacted to "<present>" in the journal. */
test("trace:false redacts the waiver quote in the journal", async () => {
  const { h, dispose, metricsDir } = await boot({ trace: false })
  await callSession(h, "prompt", {
    sessionID: "p1",
    text: "USER WAIVER: sensitive user words here",
  })
  await callTool(h, "execute.before", {
    tool: "task",
    sessionID: "p1",
    input: { agent: "reviewer", prompt: "review it" },
  })
  const waived = journalEntries(metricsDir).find((l) => l.type === "gate" && l.result === "WAIVED")
  assert.ok(waived)
  assert.equal(waived?.channel, "prompt")
  assert.equal(waived?.waiver, "<present>")
  dispose()
})

/** A test-runner GATE: PASS keys the gate to the parent, unblocking the reviewer. */
test("a test-runner GATE: PASS flips the gate and the reviewer is allowed", async () => {
  // gateEvidence:"flag" keeps today's flip semantics (the flip switch is not
  // passed under enforce); the gate still goes green.
  const { h, dispose, metricsDir } = await boot({ gateEvidence: "flag" })
  await callTool(h, "execute.after", {
    tool: "task",
    sessionID: "p1",
    input: { agent: "test-runner" },
    result: { output: "GATE: PASS tests=3 passed=3 failed=0\nrest" },
  })
  await callTool(h, "execute.before", {
    tool: "task",
    sessionID: "p1",
    input: { agent: "reviewer", prompt: "review it" },
  })
  const gate = journalEntries(metricsDir).find((l) => l.type === "gate" && l.result === "PASS")
  assert.ok(gate)
  assert.equal(gate.sessionID, "p1")
  assert.equal(gate.raw, "p1")
  dispose()
})

/** A later GATE: FAIL un-greens the gate: the reviewer is blocked again. */
test("a GATE: FAIL after a PASS re-blocks reviewer dispatch", async () => {
  // flag keeps the flip-on-PASS semantics; the trailing/leading FAIL still
  // un-greens. The follow-up PASS re-greens under flag.
  const { h, dispose } = await boot({ gateEvidence: "flag" })
  const pass = async (output: string): Promise<void> =>
    callTool(h, "execute.after", {
      tool: "task",
      sessionID: "p1",
      input: { agent: "test-runner" },
      result: { output },
    })
  await pass("GATE: PASS tests=3 passed=3 failed=0\n")
  await pass("GATE: FAIL tests=3 passed=1 failed=2\n")
  await assert.rejects(
    () =>
      callTool(h, "execute.before", {
        tool: "task",
        sessionID: "p1",
        input: { agent: "reviewer", prompt: "review it" },
      }),
    (e: Error) => e.message === NO_GATE_MESSAGE,
  )
  // A follow-up PASS re-greens it.
  await pass("GATE: PASS tests=3 passed=3 failed=0\n")
  await callTool(h, "execute.before", {
    tool: "task",
    sessionID: "p1",
    input: { agent: "reviewer", prompt: "review it" },
  })
  dispose()
})

/** Byte-identical re-delivered markers still journal: dedup is per delivery, not global. */
test("task-result re-runs with identical markers are journaled per delivery", async () => {
  const { h, dispose, metricsDir } = await boot({ maxReviewerRounds: 2 })
  const result = { output: "VERDICT: BLOCK crit=1 high=0 med=0 low=0\nmore text" }
  for (let i = 0; i < 3; i++) {
    await callTool(h, "execute.after", {
      tool: "task",
      sessionID: "p1",
      input: { agent: "reviewer" },
      result,
    })
  }
  // Each execute.after is a distinct delivery: byte-identical markers from
  // a re-run must still leave journal evidence.
  const verdicts = journalEntries(metricsDir).filter((l) => l.type === "verdict")
  assert.equal(verdicts.length, 3)
  // Rounds count reviewer dispatches (none happened here), not verdicts.
  assert.ok(verdicts[0])
  assert.equal(verdicts[0].rounds, 0)
  dispose()
})

/** Repeated streaming of the same text dedups to a single verdict entry. */
test("streaming re-delivery of the same text dedups to one journal entry", async () => {
  const { h, dispose, metricsDir } = await boot()
  h.pushEvent({
    type: "session.created",
    data: { sessionID: "c1", parentID: "p1", agent: "reviewer" },
  })
  h.pushEvent({ type: "session.error", data: { sessionID: "c1", error: "warmup" } })
  await waitUntil(() =>
    journalEntries(metricsDir).some((l) => l.type === "error" && l.error === "warmup"),
  )
  const text = "VERDICT: BLOCK crit=1 high=0 med=0 low=0\nmore text"
  for (let i = 0; i < 3; i++) {
    h.pushEvent({ type: "session.text.ended", data: { sessionID: "c1", text } })
  }
  await waitUntil(() => journalEntries(metricsDir).filter((l) => l.type === "verdict").length >= 1)
  // settle: give the loop a beat to (not) journal duplicates
  await new Promise((resolve) => setTimeout(resolve, 25))
  const verdicts = journalEntries(metricsDir).filter((l) => l.type === "verdict")
  assert.equal(verdicts.length, 1)
  dispose()
})

/** Only the last marker in one text is journaled; earlier matches count as suppressed. */
test("only the last marker per text is journaled; earlier matches counted as suppressed", async () => {
  const { h, dispose, metricsDir } = await boot()
  await callTool(h, "execute.after", {
    tool: "task",
    sessionID: "p1",
    input: { agent: "test-runner" },
    result: {
      output: "GATE: FAIL tests=2 passed=0 failed=2\nretry\nGATE: PASS tests=2 passed=2 failed=0",
    },
  })
  const gates = journalEntries(metricsDir).filter((l) => l.type === "gate" && l.source)
  assert.equal(gates.length, 1)
  assert.ok(gates[0])
  assert.equal(gates[0].result, "PASS")
  assert.equal(gates[0].suppressed, 1)
  dispose()
})

/** A second same-parent child delivering a byte-identical GATE: PASS is a
 *  cross-child dedup hit: it is silent, and the pending suppression surfaces
 *  on the parent's next emitted marker event (suppressed >= 1). The first
 *  same-child event is not suppressed. */
test("a cross-child dedup hit surfaces as suppressed on the parent's next marker event", async () => {
  const { h, dispose, metricsDir } = await boot()
  // Two children share parent p1; both stream byte-identical GATE: PASS.
  h.pushEvent({
    type: "session.created",
    data: { sessionID: "c1", parentID: "p1", agent: "test-runner" },
  })
  h.pushEvent({
    type: "session.created",
    data: { sessionID: "c2", parentID: "p1", agent: "test-runner" },
  })
  h.pushEvent({ type: "session.error", data: { sessionID: "c1", error: "warmup" } })
  h.pushEvent({ type: "session.error", data: { sessionID: "c2", error: "warmup" } })
  await waitUntil(
    () =>
      journalEntries(metricsDir).filter((l) => l.type === "error" && l.error === "warmup").length >=
      2,
  )
  const text = "GATE: PASS tests=2 passed=2 failed=0"
  // c1 first-sight (suppressed 0); c2 byte-identical dedup hit (different raw).
  h.pushEvent({ type: "session.text.ended", data: { sessionID: "c1", text } })
  h.pushEvent({ type: "session.text.ended", data: { sessionID: "c2", text } })
  // c1 emits a genuinely new marker: the parent's next marker event.
  h.pushEvent({
    type: "session.text.ended",
    data: { sessionID: "c1", text: "GATE: PASS tests=3 passed=3 failed=0" },
  })
  await waitUntil(() =>
    journalEntries(metricsDir).some((l) => l.type === "gate" && (l.suppressed ?? 0) >= 1),
  )
  const gates = journalEntries(metricsDir).filter((l) => l.type === "gate")
  assert.ok(gates[0], "expected the first-sight gate to be journaled")
  // The first-sight event carries no suppression...
  assert.equal(gates[0].suppressed ?? 0, 0)
  // ...but the next marker event after c2's cross-child hit accounts for it.
  assert.ok(gates.some((l) => (l.suppressed ?? 0) >= 1))
  dispose()
})

/** Repeated re-delivery of the same text by one child is a same-child dedup
 *  hit: the pending counter is never incremented, so a later new marker from
 *  that child journals suppressed 0. */
test("same-child re-delivery never counts as suppression", async () => {
  const { h, dispose, metricsDir } = await boot()
  h.pushEvent({
    type: "session.created",
    data: { sessionID: "c1", parentID: "p1", agent: "test-runner" },
  })
  h.pushEvent({ type: "session.error", data: { sessionID: "c1", error: "warmup" } })
  await waitUntil(() =>
    journalEntries(metricsDir).some((l) => l.type === "error" && l.error === "warmup"),
  )
  const text = "GATE: PASS tests=2 passed=2 failed=0"
  // Repeated streaming of the same text from the same child.
  for (let i = 0; i < 3; i++) {
    h.pushEvent({ type: "session.text.ended", data: { sessionID: "c1", text } })
  }
  // A genuinely new marker from the same child journals no cross-child loss.
  h.pushEvent({
    type: "session.text.ended",
    data: { sessionID: "c1", text: "GATE: PASS tests=4 passed=4 failed=0" },
  })
  await waitUntil(() =>
    journalEntries(metricsDir).some((l) => l.type === "gate" && l.result === "PASS"),
  )
  // Settle: give the loop a beat to process the re-deliveries before asserting.
  await new Promise((resolve) => setTimeout(resolve, 25))
  const gates = journalEntries(metricsDir).filter((l) => l.type === "gate")
  const newGate = gates.find((l) => l.marker === "GATE: PASS tests=4 passed=4 failed=0")
  assert.ok(newGate, "expected the new marker to be journaled")
  assert.equal(newGate.suppressed ?? 0, 0)
  dispose()
})

/** A verdict-kind cross-child dedup hit must not count as a gate suppression
 *  (the pending counter charges only gate-kind hits, so a
 *  subsequent gate event journals suppressed 0. The sibling test above pins
 *  the gate-kind direction; this one pins that a VERDICT cross-child hit stays
 *  out of the next gate event's suppressed field instead of bleeding into it.
 */
test("a verdict cross-child dedup hit stays out of the next gate event's suppressed", async () => {
  const { h, dispose, metricsDir } = await boot()
  // c1, c2 are reviewer children; their byte-identical APPROVE form a verdict
  // cross-child dedup hit (silent, never charged to the pending counter).
  h.pushEvent({
    type: "session.created",
    data: { sessionID: "c1", parentID: "p1", agent: "reviewer" },
  })
  h.pushEvent({
    type: "session.created",
    data: { sessionID: "c2", parentID: "p1", agent: "reviewer" },
  })
  // c1 first-sight (a verdict event); c2 a cross-child verdict hit (silent,
  // never charged to the pending counter — verdict-kind hits don't feed the
  // gate-event suppressed field).
  const APPROVE = "VERDICT: APPROVE crit=0 high=0 med=0 low=0"
  h.pushEvent({ type: "session.text.ended", data: { sessionID: "c1", text: `${APPROVE}\n` } })
  h.pushEvent({ type: "session.text.ended", data: { sessionID: "c2", text: `${APPROVE}\n` } })
  await waitUntil(() => journalEntries(metricsDir).some((l) => l.type === "verdict"))
  // A test-runner child (c3) emits a genuinely new GATE: PASS: the parent's
  // next marker event.
  h.pushEvent({
    type: "session.created",
    data: { sessionID: "c3", parentID: "p1", agent: "test-runner" },
  })
  h.pushEvent({
    type: "session.text.ended",
    data: {
      sessionID: "c3",
      parentID: "p1",
      agent: "test-runner",
      text: "GATE: PASS tests=2 passed=2 failed=0",
    },
  })
  await waitUntil(() =>
    journalEntries(metricsDir).some((l) => l.type === "gate" && l.result === "PASS"),
  )
  const gates = journalEntries(metricsDir).filter((l) => l.type === "gate")
  const newGate = gates[gates.length - 1]
  assert.ok(newGate, "expected the new gate to be journaled")
  // The verdict cross-child hit above must NOT surface as a gate suppression.
  assert.equal(newGate.suppressed ?? 0, 0)
  dispose()
})

/** Task-result deliveries use a unique dedup scope per delivery, so two
 *  concurrent task-result deliveries of byte-identical markers are both journaled
 *  with suppressed 0 (the unique-scope guard must not regress to cross-charging). */
test("two concurrent task-result deliveries with identical markers journal suppressed 0", async () => {
  const { h, dispose, metricsDir } = await boot({ maxReviewerRounds: 2 })
  const result = { output: "VERDICT: BLOCK crit=1 high=0 med=0 low=0\nmore text" }
  await callTool(h, "execute.after", {
    tool: "task",
    sessionID: "p1",
    input: { agent: "reviewer" },
    result,
  })
  await callTool(h, "execute.after", {
    tool: "task",
    sessionID: "p1",
    input: { agent: "reviewer" },
    result,
  })
  const verdicts = journalEntries(metricsDir).filter((l) => l.type === "verdict")
  // Each execute.after is a distinct delivery: byte-identical markers still
  // leave independent journal evidence (unique per-delivery scope).
  assert.equal(verdicts.length, 2)
  assert.ok(verdicts.every((l) => (l.suppressed ?? 0) === 0))
  dispose()
})

/** With the gate green, two reviewer dispatches pass; the third hits the round cap. */
test("round cap with default 2: third reviewer dispatch blocked at the limit", async () => {
  // flag keeps today's flip semantics so the gate goes green after the PASS.
  const { h, dispose } = await boot({ gateEvidence: "flag" })
  // The cap counts reviewer dispatches, so the gate must be green for the
  // first two dispatches to pass the no-gate-pass check.
  await callTool(h, "execute.after", {
    tool: "task",
    sessionID: "p1",
    input: { agent: "test-runner" },
    result: { output: "GATE: PASS tests=1 passed=1 failed=0\n" },
  })
  for (let i = 0; i < 2; i++) {
    await callTool(h, "execute.before", {
      tool: "task",
      sessionID: "p1",
      input: { agent: "reviewer", prompt: "review it" },
    })
  }
  await assert.rejects(
    () =>
      callTool(h, "execute.before", {
        tool: "task",
        sessionID: "p1",
        input: { agent: "reviewer", prompt: "again" },
      }),
    (e: Error) =>
      e.message ===
      "BLOCKED by turnstile: reviewer round limit (2) reached — the pipeline is looping. STOP: do not re-dispatch the reviewer. Escalate the open findings to the user and wait for new instructions (a new user prompt resets the cap).",
  )
  dispose()
})

/** Waived dispatches do not consume the round cap: after a prompt-channel
 *  waiver the next unwaived dispatch still proceeds. */
test("round cap: waived dispatches do not consume the cap; an unwaived dispatch proceeds", async () => {
  // flag keeps today's flip semantics so the unwaived dispatch clears the
  // no-gate-pass check after the green gate.
  const { h, dispose } = await boot({ gateEvidence: "flag" })
  // Prompt-channel waiver captured first (a prompt resets state, so the green
  // gate must follow); it waives the first reviewer dispatch without counting
  // toward the cap.
  await callSession(h, "prompt", { sessionID: "p1", text: "USER WAIVER: user said ship it" })
  // Green gate so the unwaived dispatches can clear the no-gate-pass check.
  await callTool(h, "execute.after", {
    tool: "task",
    sessionID: "p1",
    input: { agent: "test-runner" },
    result: { output: "GATE: PASS tests=1 passed=1 failed=0\n" },
  })
  // A waiver dispatch consumes the prompt-channel waiver; the green gate
  // carries the unwaived dispatches.
  await callTool(h, "execute.before", {
    tool: "task",
    sessionID: "p1",
    input: { agent: "reviewer", prompt: "review it" },
  })
  await callTool(h, "execute.before", {
    tool: "task",
    sessionID: "p1",
    input: { agent: "reviewer", prompt: "review it" },
  })
  // The unwaived dispatch still resolves.
  await callTool(h, "execute.before", {
    tool: "task",
    sessionID: "p1",
    input: { agent: "reviewer", prompt: "review it" },
  })
  dispose()
})

/** Waivers neither count toward nor reset the cap: after a prompt-channel
 *  waiver exactly `maxReviewerRounds` unwaived dispatches succeed and the
 *  next rejects with the golden round-limit message — plus the consumed
 *  clause, since the waived dispatch consumed the unscoped waiver. */
test("round cap: waivers neither count nor reset; the Nth unwaived dispatch is blocked", async () => {
  // flag keeps today's flip semantics so the gate goes green after the PASS.
  const { h, dispose } = await boot({ gateEvidence: "flag" })
  // Prompt-channel waiver captured first (a prompt resets state, so the green
  // gate must follow).
  await callSession(h, "prompt", { sessionID: "p1", text: "USER WAIVER: user said ship it" })
  await callTool(h, "execute.after", {
    tool: "task",
    sessionID: "p1",
    input: { agent: "test-runner" },
    result: { output: "GATE: PASS tests=1 passed=1 failed=0\n" },
  })
  // A single prompt-channel waiver precedes the unwaived budget: it consumes
  // the waiver without consuming or resetting the cap.
  await callTool(h, "execute.before", {
    tool: "task",
    sessionID: "p1",
    input: { agent: "reviewer", prompt: "review it" },
  })
  // Two unwaived dispatches still succeed (default cap of 2).
  for (let i = 0; i < 2; i++) {
    await callTool(h, "execute.before", {
      tool: "task",
      sessionID: "p1",
      input: { agent: "reviewer", prompt: "review it" },
    })
  }
  // The third unwaived dispatch rejects with the golden message plus the
  // consumed clause (the waiver was spent by the first dispatch).
  await assert.rejects(
    () =>
      callTool(h, "execute.before", {
        tool: "task",
        sessionID: "p1",
        input: { agent: "reviewer", prompt: "again" },
      }),
    (e: Error) =>
      e.message ===
      "BLOCKED by turnstile: reviewer round limit (2) reached — the pipeline is looping. STOP: do not re-dispatch the reviewer. Escalate the open findings to the user and wait for new instructions (a new user prompt resets the cap)." +
        CONSUMED_CLAUSE,
  )
  dispose()
})

/** Replay of a parent-keyed PASS entry restores the gate across restarts. */
test("journal replay restores a parent-keyed GATE: PASS across restarts", async () => {
  const metricsDir = tmpDir()
  fs.writeFileSync(
    path.join(metricsDir, "turnstile.jsonl"),
    `${JSON.stringify({ ts: "t", type: "gate", sessionID: "p1", raw: "c1", result: "PASS" })}\n`,
  )
  const h = makeFakeHost()
  const setup = turnstile(h.host, { env: isolatedEnv(metricsDir), config: { metricsDir } })
  const dispose = (await setup(h.host)) as () => void
  await callTool(h, "execute.before", {
    tool: "task",
    sessionID: "p1",
    input: { agent: "reviewer", prompt: "review it" },
  })
  dispose()
})

/** Replay honors latest-wins: a trailing GATE: FAIL after a PASS keeps the
 *  gate red across restarts, matching the runtime un-greening rule. */
test("journal replay keeps a trailing GATE: FAIL red after an earlier PASS", async () => {
  const metricsDir = tmpDir()
  fs.writeFileSync(
    path.join(metricsDir, "turnstile.jsonl"),
    `${JSON.stringify({ ts: "t", type: "gate", sessionID: "p1", raw: "c1", result: "PASS" })}\n` +
      `${JSON.stringify({ ts: "t", type: "gate", sessionID: "p1", raw: "c2", result: "FAIL" })}\n`,
  )
  const h = makeFakeHost()
  const setup = turnstile(h.host, { env: isolatedEnv(metricsDir), config: { metricsDir } })
  const dispose = (await setup(h.host)) as () => void
  await assert.rejects(
    () =>
      callTool(h, "execute.before", {
        tool: "task",
        sessionID: "p1",
        input: { agent: "reviewer", prompt: "review it" },
      }),
    (e: Error) => e.message === NO_GATE_MESSAGE,
  )
  dispose()
})

/** Legacy raw-keyed entries (no parent mapping) must not open the parent's gate. */
test("legacy raw-keyed replay entries do not gate the parent session", async () => {
  const metricsDir = tmpDir()
  fs.writeFileSync(
    path.join(metricsDir, "turnstile.jsonl"),
    `${JSON.stringify({ ts: "t", type: "gate", sessionID: "c-old", result: "PASS" })}\n`,
  )
  const h = makeFakeHost()
  const setup = turnstile(h.host, { env: isolatedEnv(metricsDir), config: { metricsDir } })
  const dispose = (await setup(h.host)) as () => void
  await assert.rejects(
    () =>
      callTool(h, "execute.before", {
        tool: "task",
        sessionID: "p1",
        input: { agent: "reviewer", prompt: "review it" },
      }),
    (e: Error) => e.message === NO_GATE_MESSAGE,
  )
  dispose()
})

/** Read counter: one warning at readWarn, a hard block at readBlock. The
 *  increment happens in the before-hook, so each read is a before/after pair;
 *  the warn fires on the readWarn-th pair and the readBlock-th before-read
 *  blocks. */
test("read horizon: warns at readWarn, blocks at readBlock", async () => {
  const { h, dispose } = await boot({ readWarn: 2, readBlock: 3 })
  const r1 = { output: "one" }
  const r2 = { output: "two" }
  const r3 = { output: "three" }
  // Before-hook increments; after-hook journals the running count and warns.
  await callTool(h, "execute.before", { tool: "read", sessionID: "p1" })
  await callTool(h, "execute.after", { tool: "read", sessionID: "p1", result: r1 })
  await callTool(h, "execute.before", { tool: "read", sessionID: "p1" })
  await callTool(h, "execute.after", { tool: "read", sessionID: "p1", result: r2 })
  assert.match(String(r2.output), /^\[turnstile\] Warning: 2 whole-file reads/)
  await callTool(h, "execute.before", { tool: "read", sessionID: "p1" })
  await callTool(h, "execute.after", { tool: "read", sessionID: "p1", result: r3 })
  // The next before-read is the readBlock-th: the atomic increment reached it.
  await assert.rejects(
    () => callTool(h, "execute.before", { tool: "read", sessionID: "p1" }),
    (e: Error) =>
      e.message ===
      "BLOCKED by turnstile: 3 whole-file reads this session. Switch to grep/glob for targeted retrieval, or report being stuck and escalate to the user.",
  )
  dispose()
})

/** An in-flight child whose edge has not landed yet keys the
 *  parent's budget (via host session.get), not its own — the before-hook
 *  resolves the edge before the guard. */
test("read horizon: an unresolved child's first read keys the parent's budget", async () => {
  const metricsDir = tmpDir()
  const h = makeFakeHost({ sessionRecords: new Map([["c1", { parentID: "p1" }]]) })
  const setup = turnstile(h.host, {
    env: isolatedEnv(metricsDir),
    config: { readWarn: 2, readBlock: 3, metricsDir },
  })
  const dispose = (await setup(h.host)) as () => void
  // Three before/after read pairs on the parent p1 (self-keyed, no edge yet)
  // drain its budget to the block; the before-hook increments, keyed off p1.
  for (let i = 0; i < 3; i++) {
    await callTool(h, "execute.before", { tool: "read", sessionID: "p1" })
    await callTool(h, "execute.after", {
      tool: "read",
      sessionID: "p1",
      result: { output: `body ${i}` },
    })
  }
  // The first before-read on the (still unresolved) child resolves the edge,
  // keys p1's budget, and blocks — the exact message as the parent drain.
  await assert.rejects(
    () => callTool(h, "execute.before", { tool: "read", sessionID: "c1" }),
    (e: Error) =>
      e.message ===
      "BLOCKED by turnstile: 3 whole-file reads this session. Switch to grep/glob for targeted retrieval, or report being stuck and escalate to the user.",
  )
  // The edge was cached by the before-read: a follow-up child read keys the
  // parent (count-vs-budget invariant still holds).
  await callTool(h, "execute.after", { tool: "read", sessionID: "c1", result: { output: "child" } })
  const reads = journalEntries(metricsDir).filter((l) => l.type === "tool" && l.tool === "read")
  assert.equal(reads.length, 4)
  assert.ok(reads.every((l) => l.sessionID === "p1"))
  dispose()
})

/** A child whose record is not yet visible to session.get
 *  self-keys and stays fail-open, journaling a bounded fallback signal at
 *  most maxLookupAttempts-1 times (attempts saturate, then it stays silent). */
test("read horizon: an unresolvable child self-keys and journals a bounded signal", async () => {
  const metricsDir = tmpDir()
  const h = makeFakeHost({ throwingGet: true })
  const setup = turnstile(h.host, { env: isolatedEnv(metricsDir), config: { metricsDir } })
  const dispose = (await setup(h.host)) as () => void
  // Four+ unresolved before-reads: each resolves, self-keys, and fires the
  // bounded signal — but never rejects (fail-open).
  for (let i = 0; i < 5; i++) {
    await callTool(h, "execute.before", { tool: "read", sessionID: "c1" })
  }
  const signals = journalEntries(metricsDir).filter(
    (l) =>
      l.type === "error" &&
      l.sessionID === "c1" &&
      /read budget keyed by session; parent unresolved/.test(l.error),
  )
  // Bounded to maxLookupAttempts-1 (3-1) signals per stuck session.
  assert.equal(signals.length, 2)
  dispose()
})

/** A confirmed parent-less root self-keys silently: no fallback
 *  signal on every root read (the attempts===cap sentinel stays quiet). */
test("read horizon: a parent-less root read self-keys without journaling", async () => {
  const metricsDir = tmpDir()
  const h = makeFakeHost({ sessionRecords: new Map([["p1", {}]]) })
  const setup = turnstile(h.host, { env: isolatedEnv(metricsDir), config: { metricsDir } })
  const dispose = (await setup(h.host)) as () => void
  for (let i = 0; i < 5; i++) {
    await callTool(h, "execute.before", { tool: "read", sessionID: "p1" })
  }
  const signals = journalEntries(metricsDir).filter(
    (l) => l.type === "error" && /read budget keyed by session/.test(l.error),
  )
  assert.equal(signals.length, 0)
  dispose()
})

/** The read horizon increments atomically in the before-hook: `readBlock`
 *  before-reads succeed and the next one blocks, proving the check-then-increment
 *  cannot let reads queued at count-1 all pass (the old two-hook split could). */
test("read horizon: readBlock before-reads then block, atomically", async () => {
  const { h, dispose } = await boot({ readBlock: 3 })
  // Three before-reads at count 0/1/2 concurrently: the synchronous
  // check-then-increment lets only them through; a later one blocks.
  await Promise.all([
    callTool(h, "execute.before", { tool: "read", sessionID: "p1" }),
    callTool(h, "execute.before", { tool: "read", sessionID: "p1" }),
    callTool(h, "execute.before", { tool: "read", sessionID: "p1" }),
  ])
  await assert.rejects(
    () => callTool(h, "execute.before", { tool: "read", sessionID: "p1" }),
    (e: Error) =>
      e.message ===
      "BLOCKED by turnstile: 3 whole-file reads this session. Switch to grep/glob for targeted retrieval, or report being stuck and escalate to the user.",
  )
  dispose()
})

/** A read whose after-result is not a string never consumed budget, so the
 *  after-hook corrects the charge down (floor 0): a subsequent before-read is
 *  not hostage to the failed read, and the corrected count is journaled. */
test("read horizon: a failed read corrects the budget charge down", async () => {
  const { h, dispose, metricsDir } = await boot({ readBlock: 3 })
  await callTool(h, "execute.before", { tool: "read", sessionID: "p1" })
  // A non-string after-result never consumed budget — the charge corrects down.
  await callTool(h, "execute.after", { tool: "read", sessionID: "p1", result: {} })
  const reads = journalEntries(metricsDir).filter((l) => l.type === "tool" && l.tool === "read")
  assert.equal(reads.length, 1)
  assert.equal(reads[0]!.reads, 0)
  // The freed budget lets a genuine read proceed before reaching the block.
  await callTool(h, "execute.before", { tool: "read", sessionID: "p1" })
  await callTool(h, "execute.after", { tool: "read", sessionID: "p1", result: { output: "x" } })
  const after = journalEntries(metricsDir).filter((l) => l.type === "tool" && l.tool === "read")
  assert.equal(after[after.length - 1]!.reads, 1)
  dispose()
})

/** An after-read with no matching before-read and a non-string result must not
 *  push the count below zero: the floor guard keeps reads at 0. */
test("read horizon: an after-hook read without a before-hook never goes negative", async () => {
  const { h, dispose, metricsDir } = await boot({ readBlock: 1 })
  await callTool(h, "execute.after", { tool: "read", sessionID: "p1", result: {} })
  const reads = journalEntries(metricsDir).filter((l) => l.type === "tool" && l.tool === "read")
  assert.equal(reads.length, 1)
  assert.equal(reads[0]!.reads, 0)
  dispose()
})

/** The read-budget warn prefix is once per task: after a corrected
 *  re-climb back to readWarn (a failed read's charge corrected the counter
 *  down first), the prefix must not inject a second time — the old
 *  counter-equality predicate re-fired it on the re-climb. */
test("read horizon: warn prefix fires once even after a corrected re-climb", async () => {
  const { h, dispose, metricsDir } = await boot({ readWarn: 2, readBlock: 8 })
  const r1 = { output: "one" }
  const r2 = { output: "two" }
  const r3 = { output: "three" }
  // Pair 1: below the threshold — no prefix.
  await callTool(h, "execute.before", { tool: "read", sessionID: "p1" })
  await callTool(h, "execute.after", { tool: "read", sessionID: "p1", result: r1 })
  // Pair 2: the readWarn-th string output — warn #1, sets the once flag.
  await callTool(h, "execute.before", { tool: "read", sessionID: "p1" })
  await callTool(h, "execute.after", { tool: "read", sessionID: "p1", result: r2 })
  assert.match(String(r2.output), /^\[turnstile\] Warning: 2 whole-file reads/)
  // A failed read whose after arrives without its before's charge corrects
  // the counter down: the re-climb below reaches readWarn again.
  await callTool(h, "execute.after", { tool: "read", sessionID: "p1", result: {} })
  // Pair 3: the counter re-climbs to readWarn — the once flag suppresses the
  // prefix (the old counter-equality predicate injected it again here).
  await callTool(h, "execute.before", { tool: "read", sessionID: "p1" })
  await callTool(h, "execute.after", { tool: "read", sessionID: "p1", result: r3 })
  assert.doesNotMatch(String(r3.output), /^\[turnstile\]/)
  const reads = journalEntries(metricsDir).filter((l) => l.type === "tool" && l.tool === "read")
  assert.deepEqual(
    reads.map((l) => l.reads),
    [1, 2, 1, 2],
  )
  dispose()
})

/** A counter carried past readWarn by concurrent before-reads (no
 *  string-output after-read yet) still receives the warn on the first string
 *  output — counter equality would skip it forever — and the once flag
 *  suppresses any later repeat. */
test("read horizon: the warn fires on the first string output at or past the threshold", async () => {
  const { h, dispose } = await boot({ readWarn: 2, readBlock: 8 })
  // Three concurrent before-reads carry the counter to 3 before any
  // after-read (the atomic increment pattern).
  await Promise.all([
    callTool(h, "execute.before", { tool: "read", sessionID: "p1" }),
    callTool(h, "execute.before", { tool: "read", sessionID: "p1" }),
    callTool(h, "execute.before", { tool: "read", sessionID: "p1" }),
  ])
  const r = { output: "first string output" }
  await callTool(h, "execute.after", { tool: "read", sessionID: "p1", result: r })
  assert.match(String(r.output), /^\[turnstile\] Warning: 2 whole-file reads/)
  // The once flag suppresses the prefix on the next string output.
  const r2 = { output: "second string output" }
  await callTool(h, "execute.after", { tool: "read", sessionID: "p1", result: r2 })
  assert.doesNotMatch(String(r2.output), /^\[turnstile\]/)
  dispose()
})

/** Bare-output violations fire only for agents in bareOutput (test-runner here, not planner). */
test("bare-output violation fires only for marker-contracted agents", async () => {
  const { h, dispose, metricsDir } = await boot()
  await callTool(h, "execute.after", {
    tool: "task",
    sessionID: "p1",
    input: { agent: "planner" },
    result: { output: "a plan with no marker" },
  })
  await callTool(h, "execute.after", {
    tool: "task",
    sessionID: "p1",
    input: { agent: "test-runner" },
    result: { output: "ran tests, no marker" },
  })
  const blocked = journalEntries(metricsDir).filter(
    (l) => l.reason === "task output contained no GATE/VERDICT marker",
  )
  assert.equal(blocked.length, 1)
  assert.ok(blocked[0])
  assert.equal(blocked[0].type, "violation")
  assert.equal(blocked[0].agent, "test-runner")
  dispose()
})

/** reviewer temperature is forced to 0; executor is clamped to ≤ 0.2; others untouched. */
test("clamps: reviewer forced to 0 (even without options), executors clamped to 0.2", async () => {
  const { h, dispose } = await boot()
  const gen = (draft: unknown): Promise<void> => callSession(h, "generate", draft)
  const reviewer: any = { agent: "reviewer" }
  await gen(reviewer)
  assert.deepEqual(reviewer.options, { temperature: 0 })
  const reviewerWarm: any = { agent: "reviewer", options: { temperature: 0.5 } }
  await gen(reviewerWarm)
  assert.equal(reviewerWarm.options.temperature, 0)
  const executor: any = { agent: "executor", options: { temperature: 0.5 } }
  await gen(executor)
  assert.equal(executor.options.temperature, 0.2)
  const executorCold: any = { agent: "executor", options: {} }
  await gen(executorCold)
  // An unset temperature is clamped to the ≤ 0.2 bound too.
  assert.deepEqual(executorCold.options, { temperature: 0.2 })
  const executorBare: any = { agent: "executor" }
  await gen(executorBare)
  assert.deepEqual(executorBare.options, { temperature: 0.2 })
  const orchestrator: any = { agent: "orchestrator", options: { temperature: 0.9 } }
  await gen(orchestrator)
  assert.equal(orchestrator.options.temperature, 0.9)
  dispose()
})

/** Plan approval must come first: an unreviewed plan blocks before the
 * decomposition citation check, even when the prompt cites no chunk. */
test("decomposition gate: executor must cite chunk-N when a plan has Decomposition", async () => {
  const project = tmpDir()
  fs.mkdirSync(path.join(project, ".opencode", "plans"), { recursive: true })
  fs.writeFileSync(
    path.join(project, ".opencode", "plans", "plan.md"),
    "# P\n## Decomposition\n- chunk-1\n",
  )
  const prev = process.cwd()
  process.chdir(project)
  try {
    const { h, dispose, metricsDir } = await boot()
    await assert.rejects(
      () =>
        callTool(h, "execute.before", {
          tool: "task",
          sessionID: "p1",
          input: { agent: "executor", prompt: "do the work" },
        }),
      (e: Error) => e.message.includes('no plan approval for "plan.md"'),
    )
    // Plan approved: the decomposition gate takes over and demands a chunk.
    // Delivered on the child so the approval keys raw=c1.
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
    await assert.rejects(
      () =>
        callTool(h, "execute.before", {
          tool: "task",
          sessionID: "p1",
          input: { agent: "executor", prompt: "do the work" },
        }),
      (e: Error) =>
        e.message ===
        'BLOCKED by turnstile: plan "plan.md" has a ## Decomposition block — executor dispatches must cite the chunk-N / AC-n they implement.',
    )
    await callTool(h, "execute.before", {
      tool: "task",
      sessionID: "p1",
      input: { agent: "executor", prompt: "implements chunk-1 / AC-1" },
    })
    dispose()
  } finally {
    process.chdir(prev)
  }
})

/** A new user prompt clears gate state and the round cap for the session. */
test("a new user prompt resets gate state", async () => {
  const { h, dispose } = await boot()
  await callTool(h, "execute.after", {
    tool: "task",
    sessionID: "p1",
    input: { agent: "test-runner" },
    result: { output: "GATE: PASS tests=1 passed=1 failed=0\n" },
  })
  await callSession(h, "prompt", { sessionID: "p1" })
  await assert.rejects(
    () =>
      callTool(h, "execute.before", {
        tool: "task",
        sessionID: "p1",
        input: { agent: "reviewer", prompt: "review it" },
      }),
    (e: Error) => e.message === NO_GATE_MESSAGE,
  )
  dispose()
})

/** Replay-recovered GATE: PASS survives the first post-restart prompt: the
 *  resume prompt preserves the restored flag rather than wiping it.
 *  Red on HEAD — HEAD wipes on the prompt, so this dispatch goes red. */
test("replayed GATE: PASS survives the first post-restart prompt", async () => {
  const metricsDir = tmpDir()
  fs.writeFileSync(
    path.join(metricsDir, "turnstile.jsonl"),
    `${JSON.stringify({ ts: "t", type: "gate", sessionID: "p1", raw: "c1", result: "PASS" })}\n`,
  )
  const h = makeFakeHost()
  const setup = turnstile(h.host, { env: isolatedEnv(metricsDir), config: { metricsDir } })
  const dispose = (await setup(h.host)) as () => void
  // The resume prompt fires resetState before the first enforcing dispatch.
  await callSession(h, "prompt", { sessionID: "p1" })
  await callTool(h, "execute.before", {
    tool: "task",
    sessionID: "p1",
    input: { agent: "reviewer", prompt: "review it" },
  })
  const entries = journalEntries(metricsDir)
  assert.ok(entries.some((l) => l.type === "dispatch" && l.agent === "reviewer"))
  dispose()
})

/** The recovery is bounded to exactly one prompt: the second post-restart
 *  prompt full-resets, so a subsequent reviewer dispatch goes red again. */
test("replayed PASS survives exactly one prompt", async () => {
  const metricsDir = tmpDir()
  fs.writeFileSync(
    path.join(metricsDir, "turnstile.jsonl"),
    `${JSON.stringify({ ts: "t", type: "gate", sessionID: "p1", raw: "c1", result: "PASS" })}\n`,
  )
  const h = makeFakeHost()
  const setup = turnstile(h.host, { env: isolatedEnv(metricsDir), config: { metricsDir } })
  const dispose = (await setup(h.host)) as () => void
  // Two prompts after replay: the grace covers only the first, so the gate is
  // red again on the second prompt. Guards against surviving every prompt.
  await callSession(h, "prompt", { sessionID: "p1" })
  await callSession(h, "prompt", { sessionID: "p1" })
  await assert.rejects(
    () =>
      callTool(h, "execute.before", {
        tool: "task",
        sessionID: "p1",
        input: { agent: "reviewer", prompt: "review it" },
      }),
    (e: Error) => e.message === NO_GATE_MESSAGE,
  )
  dispose()
})

/** A live GATE: FAIL after replay is not resurrected: the grace prompt carries
 *  the current (false) flag, never the replayed provenance. */
test("live GATE: FAIL after replay is not resurrected by the grace prompt", async () => {
  const metricsDir = tmpDir()
  fs.writeFileSync(
    path.join(metricsDir, "turnstile.jsonl"),
    `${JSON.stringify({ ts: "t", type: "gate", sessionID: "p1", raw: "c1", result: "PASS" })}\n`,
  )
  const h = makeFakeHost()
  const setup = turnstile(h.host, { env: isolatedEnv(metricsDir), config: { metricsDir } })
  const dispose = (await setup(h.host)) as () => void
  // A live FAIL (latest-wins) un-greens the replayed gate before the prompt.
  await callTool(h, "execute.after", {
    tool: "task",
    sessionID: "p1",
    input: { agent: "test-runner" },
    result: { output: "GATE: FAIL tests=3 passed=1 failed=2\n" },
  })
  await callSession(h, "prompt", { sessionID: "p1" })
  await assert.rejects(
    () =>
      callTool(h, "execute.before", {
        tool: "task",
        sessionID: "p1",
        input: { agent: "reviewer", prompt: "review it" },
      }),
    (e: Error) => e.message === NO_GATE_MESSAGE,
  )
  dispose()
})

/** A journaled plan APPROVE survives the grace prompt: the empty stamp is
 *  accepted once and stamped, so executor dispatches resolve (the
 *  plan-gate half). Red on HEAD — HEAD wipes hasPlanVerdict on the prompt. */
test("replayed APPROVE survives the grace prompt and stamps", async () => {
  const project = tmpDir()
  fs.mkdirSync(path.join(project, ".opencode", "plans"), { recursive: true })
  fs.writeFileSync(path.join(project, ".opencode", "plans", "plan.md"), "# P\n")
  const metricsDir = tmpDir()
  const journalPath = path.join(metricsDir, "turnstile.jsonl")
  fs.writeFileSync(
    journalPath,
    `${JSON.stringify({
      ts: "t",
      type: "plan",
      sessionID: "p1",
      result: "APPROVE",
      marker: "VERDICT: APPROVE crit=0 high=0 med=0 low=0",
    })}\n`,
  )
  const h = makeFakeHost()
  const prev = process.cwd()
  process.chdir(project)
  try {
    const setup = turnstile(h.host, { env: isolatedEnv(metricsDir), config: { metricsDir } })
    const dispose = (await setup(h.host)) as () => void
    await callSession(h, "prompt", { sessionID: "p1" })
    // Accept-once stamp path: the replay-restored "" is validated + stamped.
    await callTool(h, "execute.before", {
      tool: "task",
      sessionID: "p1",
      input: { agent: "executor", prompt: "do the work" },
    })
    // Stamped: the session stays approved on the next dispatch too.
    await callTool(h, "execute.before", {
      tool: "task",
      sessionID: "p1",
      input: { agent: "executor", prompt: "more work" },
    })
    // Explicit evidence: attribution journaled the replayed approval as APPROVE.
    assert.ok(
      journalEntries(metricsDir).some(
        (l) => l.type === "plan" && l.sessionID === "p1" && l.result === "APPROVE",
      ),
    )
    dispose()
  } finally {
    process.chdir(prev)
  }
})

/** A prompt for an untracked session is an ordinary reset: replayed-bucket
 *  exemptions never apply, so an unknown session resets plainly (guards the
 *  nullish-prior path in resetState). */
test("prompt for an untracked session stays a plain reset", async () => {
  const { h, dispose } = await boot()
  // Two prompts for a session with no bucket: both are plain resets.
  await callSession(h, "prompt", { sessionID: "p9" })
  await callSession(h, "prompt", { sessionID: "p9" })
  await assert.rejects(
    () =>
      callTool(h, "execute.before", {
        tool: "task",
        sessionID: "p9",
        input: { agent: "reviewer", prompt: "review it" },
      }),
    (e: Error) => e.message === NO_GATE_MESSAGE,
  )
  dispose()
})

/** Child-session markers from the created-edge stream resolve to the parent's gate. */
test("event loop: session.created edge maps child markers to the parent session", async () => {
  // flag keeps today's flip semantics so the child PASS greens the parent gate.
  const { h, dispose, metricsDir } = await boot({ gateEvidence: "flag" })
  h.pushEvent({
    type: "session.created",
    data: { sessionID: "c1", parentID: "p1", agent: "test-runner" },
  })
  // In-order consumption: when the warmup error lands, the created event
  // has been processed and the child→parent edge is set.
  h.pushEvent({ type: "session.error", data: { sessionID: "c1", error: "warmup" } })
  await waitUntil(() =>
    journalEntries(metricsDir).some((l) => l.type === "error" && l.error === "warmup"),
  )
  h.pushEvent({
    type: "session.text.ended",
    data: { sessionID: "c1", text: "GATE: PASS tests=2 passed=2 failed=0" },
  })
  await waitUntil(() =>
    journalEntries(metricsDir).some((l) => l.type === "gate" && l.result === "PASS"),
  )
  // The gate for the PARENT session is green; the reviewer is allowed.
  await callTool(h, "execute.before", {
    tool: "task",
    sessionID: "p1",
    input: { agent: "reviewer", prompt: "review it" },
  })
  const gate = journalEntries(metricsDir).find((l) => l.type === "gate" && l.result === "PASS")
  assert.ok(gate)
  assert.equal(gate.sessionID, "p1")
  assert.equal(gate.raw, "c1")
  dispose()
})

/** message.part.updated markers resolve the parent via the host session.get API. */
test("event loop: message.part.updated markers resolve the parent via session.get", async () => {
  const metricsDir = tmpDir()
  const h = makeFakeHost({
    sessionRecords: new Map([["c1", { parentID: "p1", agent: "reviewer" }]]),
  })
  const setup = turnstile(h.host, { env: isolatedEnv(metricsDir), config: { metricsDir } })
  const dispose = (await setup(h.host)) as () => void
  h.pushEvent({
    type: "message.part.updated",
    data: {
      sessionID: "c1",
      part: { type: "text", text: "VERDICT: APPROVE crit=0 high=0 med=1 low=2" },
    },
  })
  await waitUntil(() => journalEntries(metricsDir).some((l) => l.type === "verdict"))
  const verdict = journalEntries(metricsDir).find((l) => l.type === "verdict")
  assert.ok(verdict)
  assert.equal(verdict.sessionID, "p1")
  assert.equal(verdict.raw, "c1")
  dispose()
})

/** Child-session reads draw down the parent's read budget and journal under the parent ID. */
test("event loop: read horizon counts child reads against the parent session", async () => {
  const { h, dispose, metricsDir } = await boot({ readWarn: 2, readBlock: 3 })
  h.pushEvent({ type: "session.created", data: { sessionID: "c1", parentID: "p1" } })
  h.pushEvent({ type: "session.error", data: { sessionID: "c1", error: "warmup" } })
  await waitUntil(() =>
    journalEntries(metricsDir).some((l) => l.type === "error" && l.error === "warmup"),
  )
  // Child-session reads draw down the parent's budget. The increment happens in
  // the before-hook, keyed off the parent, so each read is a before/after pair.
  for (let i = 0; i < 3; i++) {
    await callTool(h, "execute.before", { tool: "read", sessionID: "c1" })
    await callTool(h, "execute.after", {
      tool: "read",
      sessionID: "c1",
      result: { output: `body ${i}` },
    })
  }
  // The before-hook increments the parent's budget to the block.
  await assert.rejects(
    () => callTool(h, "execute.before", { tool: "read", sessionID: "c1" }),
    (e: Error) =>
      e.message ===
      "BLOCKED by turnstile: 3 whole-file reads this session. Switch to grep/glob for targeted retrieval, or report being stuck and escalate to the user.",
  )
  const reads = journalEntries(metricsDir).filter((l) => l.type === "tool" && l.tool === "read")
  assert.equal(reads.length, 3)
  assert.ok(reads.every((l) => l.sessionID === "p1"))
  dispose()
})

/** session.error events are journaled and the event loop keeps consuming afterwards. */
test("event loop: session.error events are journaled and stream survives them", async () => {
  const { h, dispose, metricsDir } = await boot()
  h.pushEvent({ type: "session.error", data: { sessionID: "p1", error: "boom" } })
  h.pushEvent({ type: "session.error", data: { sessionID: "p1", error: "boom again" } })
  await waitUntil(() =>
    journalEntries(metricsDir).some((l) => l.type === "error" && l.error === "boom again"),
  )
  const errors = journalEntries(metricsDir).filter((l) => l.type === "error")
  assert.equal(errors.length, 2)
  dispose()
})

/** Child session.created events carrying a foreign directory must not change the project dir. */
test("event loop: child session.created events do not move the project dir", async () => {
  const project = tmpDir()
  fs.mkdirSync(path.join(project, ".opencode", "plans"), { recursive: true })
  fs.writeFileSync(
    path.join(project, ".opencode", "plans", "plan.md"),
    "# P\n## Decomposition\n- chunk-1\n",
  )
  const prev = process.cwd()
  process.chdir(project)
  try {
    const { h, dispose, metricsDir } = await boot()
    // A child session carries a foreign directory; it must not win.
    h.pushEvent({
      type: "session.created",
      data: { sessionID: "c1", parentID: "p1", location: { directory: "/nonexistent-dir" } },
    })
    h.pushEvent({ type: "session.error", data: { sessionID: "c1", error: "warmup" } })
    await waitUntil(() =>
      journalEntries(metricsDir).some((l) => l.type === "error" && l.error === "warmup"),
    )
    // Deliver on the child so the approval keys raw=c1 and the decomposition
    // gate (not the plan gate) is what blocks the executor.
    await callTool(h, "execute.after", {
      tool: "task",
      sessionID: "c1",
      input: { agent: "plan-reviewer" },
      result: { output: "VERDICT: APPROVE crit=0 high=0 med=0 low=0\n" },
    })
    await assert.rejects(
      () =>
        callTool(h, "execute.before", {
          tool: "task",
          sessionID: "p1",
          input: { agent: "executor", prompt: "do the work" },
        }),
      (e: Error) => e.message.includes("## Decomposition block"),
    )
    dispose()
  } finally {
    process.chdir(prev)
  }
})

/** Replay state is LRU-capped at maxSessions: the most recent survives, the oldest is evicted. */
test("journal replay is LRU-capped: sessions beyond maxSessions are evicted", async () => {
  const metricsDir = tmpDir()
  fs.writeFileSync(
    path.join(metricsDir, "turnstile.jsonl"),
    ["s1", "s2", "s3"]
      .map(
        (sid) => `${JSON.stringify({ ts: "t", type: "gate", sessionID: sid, result: "PASS" })}\n`,
      )
      .join(""),
  )
  const h = makeFakeHost()
  const setup = turnstile(h.host, {
    env: isolatedEnv(metricsDir),
    config: { metricsDir, maxSessions: 2 },
  })
  const dispose = (await setup(h.host)) as () => void
  // s3 survived the cap (most recent) and gates its dispatch.
  await callTool(h, "execute.before", {
    tool: "task",
    sessionID: "s3",
    input: { agent: "reviewer", prompt: "review it" },
  })
  // s1 was evicted (oldest): its PASS is gone, dispatch is blocked.
  await assert.rejects(
    () =>
      callTool(h, "execute.before", {
        tool: "task",
        sessionID: "s1",
        input: { agent: "reviewer", prompt: "review it" },
      }),
    (e: Error) => e.message === NO_GATE_MESSAGE,
  )
  dispose()
})

/** Failed session.get lookups are negatively cached so repeated events hit the host once. */
test("event loop: failed parent lookups are negatively cached", async () => {
  const metricsDir = tmpDir()
  const h = makeFakeHost()
  const setup = turnstile(h.host, { env: isolatedEnv(metricsDir), config: { metricsDir } })
  const dispose = (await setup(h.host)) as () => void
  let calls = 0
  const session = h.host.session
  assert.ok(session)
  session.get = async () => {
    calls++
    return {} // record without a parent edge
  }
  const part = { type: "text", text: "just talking, no markers" }
  for (let i = 0; i < 3; i++) {
    h.pushEvent({ type: "message.part.updated", data: { sessionID: "c1", part } })
  }
  await waitUntil(() => calls >= 1)
  await new Promise((resolve) => setTimeout(resolve, 25))
  assert.equal(calls, 1)
  dispose()
})

/** A thrown lookup is retried so a record that becomes visible later still resolves. */
test("event loop: thrown parent lookups retry and resolve once the record appears", async () => {
  const metricsDir = tmpDir()
  const h = makeFakeHost()
  const setup = turnstile(h.host, { env: isolatedEnv(metricsDir), config: { metricsDir } })
  const dispose = (await setup(h.host)) as () => void
  let calls = 0
  const session = h.host.session
  assert.ok(session)
  session.get = async () => {
    calls++
    if (calls === 1) throw new Error("record not yet visible")
    return { parentID: "p1", agent: "test-runner" }
  }
  const part = { type: "text", text: "just talking, no markers" }
  for (let i = 0; i < 3; i++) {
    h.pushEvent({ type: "message.part.updated", data: { sessionID: "c1", part } })
  }
  await waitUntil(() => calls >= 2)
  await new Promise((resolve) => setTimeout(resolve, 25))
  assert.equal(calls, 2) // resolved on the retry; no further host hits
  // The resolved edge now keys child markers to the parent.
  h.pushEvent({
    type: "session.text.ended",
    data: { sessionID: "c1", text: "GATE: PASS tests=1 passed=1 failed=0" },
  })
  await waitUntil(() =>
    journalEntries(metricsDir).some((l) => l.type === "gate" && l.sessionID === "p1"),
  )
  dispose()
})

/** The trace file rotates on a tick with the same bytes/generations bound as
 *  the journal: rotation runs once per rotateEveryEntries (default 512) writes
 *  under the lock, so feeding more than a tick's worth of trace lines produces
 *  a rotated generation under the configured generation bound. */
test("trace file rotates with the same bound as the journal", async () => {
  const { h, dispose, metricsDir } = await boot({
    journalMaxBytes: 200,
    journalMaxGenerations: 2,
  })
  // Trace writes are rotation-ticked (once per rotateEveryEntries), so a tick's
  // worth of dispatches is needed to observe the byte-bound rotation.
  for (let i = 0; i < 600; i++) {
    await callTool(h, "execute.before", {
      tool: "task",
      sessionID: "p1",
      input: { agent: "test-runner", prompt: `run tests ${i}` },
    }).catch(() => {})
  }
  const tracePath = path.join(metricsDir, "gate-events.jsonl")
  const gens = [1, 2].filter((g) => fs.existsSync(`${tracePath}.${g}`))
  assert.ok(gens.length >= 1, "expected at least one rotated trace generation")
  dispose()
})

/** Setup journals exactly one load heartbeat with version, digest, and hook count. */
test("setup journals one load heartbeat with version, digest, and hook count", async () => {
  const { dispose, metricsDir } = await boot()
  const setups = journalEntries(metricsDir).filter((l) => l.type === "setup")
  assert.equal(setups.length, 1)
  const entry = setups[0]!
  // version is a non-empty string or null (the review finding dropped the
  // strict semver regex so prerelease versions cannot fail this).
  assert.ok(entry.version === null || (typeof entry.version === "string" && entry.version !== ""))
  assert.match(entry.digest, /^[0-9a-f]{12}$/)
  assert.equal(entry.hooks, 7)
  // trace:true (boot default) carries the human-readable trace fields.
  assert.equal(entry.trace, true)
  assert.equal(typeof entry.agents, "object")
  assert.equal(typeof entry.metricsDir, "string")
  dispose()
})

/** (o) a renamed testRunner (no explicit bareOutput) shows derived bareOutput in the heartbeat. */
test("heartbeat trace-mode agents derive bareOutput from a renamed testRunner", async () => {
  const { dispose, metricsDir } = await boot({ agents: { testRunner: "ci-bot" } })
  const setups = journalEntries(metricsDir).filter((l) => l.type === "setup")
  assert.equal(setups.length, 1)
  assert.deepEqual(setups[0]?.agents.bareOutput, ["ci-bot", "reviewer", "plan-reviewer"])
  dispose()
})

/** Without trace, only the digest represents the config in the heartbeat. */
test("setup heartbeat redacts trace fields when trace is false", async () => {
  const { dispose, metricsDir } = await boot({ trace: false })
  const setups = journalEntries(metricsDir).filter((l) => l.type === "setup")
  assert.equal(setups.length, 1)
  assert.equal(setups[0]?.trace, undefined)
  assert.equal(setups[0]?.agents, undefined)
  assert.equal(setups[0]?.metricsDir, undefined)
  assert.match(setups[0]?.digest, /^[0-9a-f]{12}$/)
  dispose()
})

/** A degraded host without event.subscribe registers 6 hooks (permission stays). */
test("setup journals hooks === 6 when event.subscribe is absent", async () => {
  const metricsDir = tmpDir()
  const h = makeFakeHost()
  // A degraded host never exposes the event stream.
  delete (h.host as { event?: unknown }).event
  const setup = turnstile(h.host, { env: isolatedEnv(metricsDir), config: { metricsDir } })
  const dispose = (await setup(h.host)) as () => void
  const setups = journalEntries(metricsDir).filter((l) => l.type === "setup")
  assert.equal(setups.length, 1)
  assert.equal(setups[0]?.hooks, 6)
  dispose()
})

/** A degraded host without the permission surface registers 6 hooks. */
test("setup journals hooks === 6 when the permission surface is absent", async () => {
  const metricsDir = tmpDir()
  // A host without the permission surface (older host) still registers the
  // event stream, so it lands one below the full host's 7.
  const h = makeFakeHost({ permission: false })
  const setup = turnstile(h.host, { env: isolatedEnv(metricsDir), config: { metricsDir } })
  const dispose = (await setup(h.host)) as () => void
  const setups = journalEntries(metricsDir).filter((l) => l.type === "setup")
  assert.equal(setups.length, 1)
  assert.equal(setups[0]?.hooks, 6)
  dispose()
})

/**
 * A host without the `session` and `tool` surfaces degrades cleanly: setup
 * registers only the hooks that exist (heartbeat journals the reduced count),
 * skips the session/tool hook wiring entirely, and never throws. This pins
 * the `g_session`/`g_tool` degradation guards in `setup.ts` — a host shape
 * missing those surfaces is observable via the heartbeat, not silent.
 */
test("setup degrades cleanly when the session and tool surfaces are absent", async () => {
  const metricsDir = tmpDir()
  const h = makeFakeHost({ session: false, tool: false })
  assert.equal(h.host.session, undefined)
  assert.equal(h.host.tool, undefined)
  const setup = turnstile(h.host, { env: isolatedEnv(metricsDir), config: { metricsDir } })
  // Registration must not throw despite the missing surfaces.
  const dispose = (await setup(h.host)) as () => void
  const setups = journalEntries(metricsDir).filter((l) => l.type === "setup")
  assert.equal(setups.length, 1)
  // Only the permission-evaluate hook and the event-stream subscription
  // register on this host shape (no session hooks, no tool hooks).
  assert.equal(setups[0]?.hooks, 2)
  dispose()
})

// ---- Streamed child text: delta chunk reassembly and the restart budget ----

/**
 * A GATE: PASS marker split across two session.text.delta chunks is reassembled
 * by the per-session sliding window, so the flip is still observed exactly once
 * (a fragment-only parse would lose it, since the split marker never completes).
 */
test("a GATE: PASS split across two session.text.delta chunks still flips the gate once", async () => {
  const { h, dispose, metricsDir } = await boot({ gateEvidence: "flag" })
  h.pushEvent({
    type: "session.created",
    data: { sessionID: "c1", parentID: "p1", agent: "test-runner" },
  })
  h.pushEvent({ type: "session.error", data: { sessionID: "c1", error: "warmup" } })
  await waitUntil(() =>
    journalEntries(metricsDir).some((l) => l.type === "error" && l.error === "warmup"),
  )
  // First chunk carries only the marker head — an incomplete parse, no first-sight.
  h.pushEvent({
    type: "session.text.delta",
    data: { sessionID: "c1", delta: "GATE: PASS tests=1 passed=1 fail" },
  })
  // Second chunk completes the marker when folded into the window.
  h.pushEvent({ type: "session.text.delta", data: { sessionID: "c1", delta: "ed=1" } })
  await waitUntil(() =>
    journalEntries(metricsDir).some((l) => l.type === "gate" && l.result === "PASS"),
  )
  const gates = journalEntries(metricsDir).filter((l) => l.type === "gate" && l.result === "PASS")
  assert.equal(gates.length, 1)
  assert.equal(gates[0]?.marker, "GATE: PASS tests=1 passed=1 failed=1")
  dispose()
})

/**
 * Re-folding the same window with trailing deltas must not re-fire a marker
 * that a prior delta already first-sighted: the shared-empty dedup scope
 * suppresses every re-fire, so only a newly completed marker is first-sighted.
 */
test("re-folding a delta window with a complete marker never re-fires it", async () => {
  const { h, dispose, metricsDir } = await boot({ gateEvidence: "flag" })
  h.pushEvent({
    type: "session.created",
    data: { sessionID: "c1", parentID: "p1", agent: "test-runner" },
  })
  h.pushEvent({ type: "session.error", data: { sessionID: "c1", error: "warmup" } })
  await waitUntil(() =>
    journalEntries(metricsDir).some((l) => l.type === "error" && l.error === "warmup"),
  )
  // First chunk completes and first-sights the marker.
  h.pushEvent({
    type: "session.text.delta",
    data: { sessionID: "c1", delta: "GATE: PASS tests=1 passed=1 failed=1\r\n" },
  })
  await waitUntil(() =>
    journalEntries(metricsDir).some((l) => l.type === "gate" && l.result === "PASS"),
  )
  // Subsequent deltas fold into the same window; dedup keeps it to one entry.
  h.pushEvent({ type: "session.text.delta", data: { sessionID: "c1", delta: " extra output" } })
  h.pushEvent({ type: "session.text.delta", data: { sessionID: "c1", delta: " and more" } })
  await new Promise((resolve) => setTimeout(resolve, 25))
  const gates = journalEntries(metricsDir).filter((l) => l.type === "gate" && l.result === "PASS")
  assert.equal(gates.length, 1)
  dispose()
})

/**
 * The next task dispatch clears the delta window (the next dispatch is the task
 * boundary, so stale fragments of the previous task must not leak into the new
 * scope), so a marker split across deltas around a dispatch is never completed.
 */
test("a task dispatch clears the delta window so a stale split marker does not complete", async () => {
  // The executor guard must actually run: create the plans dir the gate scans
  // (an absent dir silently disables plan enforcement) and chdir to it, so the
  // expected block does not depend on the developer's checkout state.
  const project = tmpDir()
  fs.mkdirSync(path.join(project, ".opencode", "plans"), { recursive: true })
  fs.writeFileSync(path.join(project, ".opencode", "plans", "plan.md"), "# P\n")
  const prev = process.cwd()
  process.chdir(project)
  let bootState: { h: FakeHost; dispose: () => void; metricsDir: string } | undefined
  try {
    bootState = await boot({ gateEvidence: "flag" })
    const { h, dispose, metricsDir } = bootState
    h.pushEvent({
      type: "session.created",
      data: { sessionID: "c1", parentID: "p1", agent: "reviewer" },
    })
    h.pushEvent({ type: "session.error", data: { sessionID: "c1", error: "warmup" } })
    await waitUntil(() =>
      journalEntries(metricsDir).some((l) => l.type === "error" && l.error === "warmup"),
    )
    // First chunk: a verdict (so its processing is observable via waitUntil) plus
    // the incomplete head of a GATE: PASS marker. waitUntil(verdict) pins that
    // delta1's window was fully set before the dispatch runs.
    h.pushEvent({
      type: "session.text.delta",
      data: {
        sessionID: "c1",
        delta: "VERDICT: APPROVE crit=0 high=0 med=0 low=0\nGATE: PASS tests=1 passed=1 fail",
      },
    })
    await waitUntil(() => journalEntries(metricsDir).some((l) => l.type === "verdict"))
    // The dispatch is the task boundary; it clears the window before the guards
    // run (the block is expected), so the clear still takes effect.
    await assert.rejects(
      () =>
        callTool(h, "execute.before", {
          tool: "task",
          sessionID: "p1",
          input: { agent: "executor", prompt: "run the build" },
        }),
      (e: Error) => e instanceof BlockError,
    )
    // Completing chunk arrives after the window was cleared: never reassembled.
    h.pushEvent({ type: "session.text.delta", data: { sessionID: "c1", delta: "ed=1" } })
    await new Promise((resolve) => setTimeout(resolve, 25))
    const gates = journalEntries(metricsDir).filter((l) => l.type === "gate" && l.result === "PASS")
    assert.equal(gates.length, 0)
    dispose()
  } finally {
    process.chdir(prev)
  }
})

/**
 * Delta windows are bounded (50 sessions): once more than 50 hold a window, the
 * oldest is evicted. The evicted session's partial marker can then never be
 * reassembled, while a non-evicted marker still completes — proving the bound,
 * not a parsing gap, drops the split.
 */
test("delta windows are bounded past 50 sessions, evicting the oldest", async () => {
  const { h, dispose, metricsDir } = await boot({ gateEvidence: "flag" })
  h.pushEvent({
    type: "session.created",
    data: { sessionID: "c1", parentID: "p1", agent: "test-runner" },
  })
  h.pushEvent({ type: "session.error", data: { sessionID: "c1", error: "warmup" } })
  await waitUntil(() =>
    journalEntries(metricsDir).some((l) => l.type === "error" && l.error === "warmup"),
  )
  // c1's split marker head, held only in c1's window (evicted below).
  h.pushEvent({
    type: "session.text.delta",
    data: { sessionID: "c1", delta: "GATE: PASS tests=100 passed=100 fail" },
  })
  // A full marker in a second session is the control (still completes).
  h.pushEvent({
    type: "session.created",
    data: { sessionID: "c2", parentID: "p1", agent: "test-runner" },
  })
  h.pushEvent({
    type: "session.text.delta",
    data: { sessionID: "c2", delta: "GATE: PASS tests=200 passed=200 failed=200" },
  })
  // 50 more sessions push windows; the map grows past 50 and evicts c1.
  for (let i = 3; i <= 52; i++) {
    h.pushEvent({ type: "session.text.delta", data: { sessionID: `c${i}`, delta: "filler" } })
  }
  // Complete c1's marker head: c1's window was evicted, so folding the tail
  // never reassembles the GATE marker.
  h.pushEvent({ type: "session.text.delta", data: { sessionID: "c1", delta: "ed=100" } })
  await waitUntil(() =>
    journalEntries(metricsDir).some(
      (l) => l.type === "gate" && l.result === "PASS" && String(l.marker).includes("tests=200"),
    ),
  )
  const gates = journalEntries(metricsDir).filter((l) => l.type === "gate" && l.result === "PASS")
  // Control: a full marker in a retained window still flips.
  assert.ok(gates.some((l) => String(l.marker).includes("tests=200")))
  // The evicted oldest window never reassembles its split marker.
  assert.ok(!gates.some((l) => String(l.marker).includes("tests=100")))
  dispose()
})

/**
 * A session.text.delta with a non-string sessionID or delta is inert: the
 * window update and the parse are skipped entirely (both guard operands fail),
 * so no marker is journaled and the loop stays alive.
 */
test("a malformed session.text.delta (non-string sid or delta) is inert", async () => {
  const { h, dispose, metricsDir } = await boot()
  // Non-string sessionID: the guard's first operand short-circuits.
  h.pushEvent({
    type: "session.text.delta",
    data: { sessionID: 42, delta: "GATE: PASS tests=1 passed=1 failed=1" },
  })
  // Non-string delta: the guard's second operand fails.
  h.pushEvent({ type: "session.text.delta", data: { sessionID: "c1", delta: 99 } })
  await new Promise((resolve) => setTimeout(resolve, 25))
  const gates = journalEntries(metricsDir).filter((l) => l.type === "gate")
  const verdicts = journalEntries(metricsDir).filter((l) => l.type === "verdict")
  assert.equal(gates.length, 0)
  assert.equal(verdicts.length, 0)
  dispose()
})

/**
 * A dead (finite) event stream is not a silent death: the consumer
 * re-subscribes within the restart budget, and a marker pushed after the death
 * is ingested on the live re-subscription (a dead stream would otherwise stop
 * marker ingestion forever).
 */
test("a dead event stream resumes ingestion on re-subscribe within the restart budget", async () => {
  const metricsDir = tmpDir()
  const h = makeFakeHost()
  const realSubscribe = (h.host as { event: { subscribe: any } }).event.subscribe
  let subscribeCalls = 0
  ;(h.host as { event?: unknown }).event = {
    subscribe: (options?: { signal?: AbortSignal }) => {
      subscribeCalls++
      // The first subscription is a dead stream: it completes without events.
      if (subscribeCalls === 1) {
        return {
          [Symbol.asyncIterator](): AsyncIterator<any> {
            return {
              next: async (): Promise<IteratorResult<any>> => ({ done: true, value: undefined }),
            }
          },
        }
      }
      // Every re-subscription is the live bus (delivers pushed events).
      return realSubscribe(options)
    },
  }
  const setup = turnstile(h.host, {
    env: isolatedEnv(metricsDir),
    config: { metricsDir, gateEvidence: "flag" },
  })
  const dispose = (await setup(h.host)) as () => void
  // The first (dead) consume has finished and the supervisor re-subscribed.
  await waitUntil(() => subscribeCalls >= 2)
  h.pushEvent({
    type: "session.created",
    data: { sessionID: "c1", parentID: "p1", agent: "test-runner" },
  })
  h.pushEvent({ type: "session.error", data: { sessionID: "c1", error: "warmup" } })
  await waitUntil(() =>
    journalEntries(metricsDir).some((l) => l.type === "error" && l.error === "warmup"),
  )
  h.pushEvent({
    type: "session.text.ended",
    data: { sessionID: "c1", text: "GATE: PASS tests=1 passed=1 failed=1" },
  })
  await waitUntil(() =>
    journalEntries(metricsDir).some((l) => l.type === "gate" && l.result === "PASS"),
  )
  const gates = journalEntries(metricsDir).filter((l) => l.type === "gate" && l.result === "PASS")
  assert.equal(gates.length, 1)
  dispose()
})

/** A stream that completes without abort is journaled as a stream-ended error. */
test("consume journals a stream-ended error when the stream completes without abort", async () => {
  const metricsDir = tmpDir()
  const h = makeFakeHost()
  // A finite stream: emits one session.error-shaped event then ends WITHOUT
  // an abort, so consume() completes normally.
  let emitted = false
  const subscribe = (_options?: { signal?: AbortSignal }): AsyncIterable<any> => ({
    [Symbol.asyncIterator](): AsyncIterator<any> {
      return {
        next: async (): Promise<IteratorResult<any>> => {
          if (emitted) return { done: true, value: undefined }
          emitted = true
          return {
            done: false,
            value: { type: "session.error", data: { sessionID: "p1", error: "x" } },
          }
        },
      }
    },
  })
  ;(h.host as { event?: unknown }).event = { subscribe }
  const setup = turnstile(h.host, { env: isolatedEnv(metricsDir), config: { metricsDir } })
  const dispose = (await setup(h.host)) as () => void
  await waitUntil(() => journalEntries(metricsDir).some((l) => l.error === "event stream ended"))
  dispose()
})

/** Disposing (aborting) the stream journals no stream-ended error. */
test("dispose (abort) exits journal no stream-ended error", async () => {
  const { dispose, metricsDir } = await boot()
  dispose()
  // Poll rather than assume: the fake stream only ends on abort, which the
  // consumer must treat as silent.
  for (
    let i = 0;
    i < 30 && journalEntries(metricsDir).some((l) => l.error === "event stream ended");
    i++
  ) {
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  assert.ok(!journalEntries(metricsDir).some((l) => l.error === "event stream ended"))
})

/** An unresolvable agent name journals both the dispatch and an error, never throws. */
test("unresolvable agent task dispatch journals dispatch + an error and never throws", async () => {
  const { h, dispose, metricsDir } = await boot()
  await callTool(h, "execute.before", { tool: "task", sessionID: "p1", input: {} })
  const dispatch = journalEntries(metricsDir).find((l) => l.type === "dispatch")
  assert.ok(dispatch, "expected a dispatch entry")
  assert.equal(dispatch?.agent, "")
  assert.ok(
    journalEntries(metricsDir).some(
      (l) =>
        l.type === "error" &&
        l.error ===
          "task dispatch: could not resolve the agent name; does the host input shape still use subagent_type/agent/subagent?",
    ),
  )
  dispose()
})

/** A mixed journal: non-gate entries are ignored, gate state still restores. */
test("replay ignores non-gate entries and restores gate state from a mixed journal", async () => {
  const metricsDir = tmpDir()
  // A hand-written journal: a GATE: PASS that must restore state, plus a setup
  // and an error entry the replay filter must ignore.
  fs.writeFileSync(
    path.join(metricsDir, "turnstile.jsonl"),
    [
      JSON.stringify({ ts: "t0", type: "gate", sessionID: "p1", raw: "c1", result: "PASS" }),
      JSON.stringify({
        ts: "t1",
        type: "setup",
        version: "0.2.1",
        digest: "abcdef012345",
        hooks: 6,
      }),
      JSON.stringify({ ts: "t2", type: "error", error: "unrelated startup note" }),
    ].join("\n") + "\n",
  )
  const h = makeFakeHost()
  const setup = turnstile(h.host, { env: isolatedEnv(metricsDir), config: { metricsDir } })
  const dispose = (await setup(h.host)) as () => void
  // Gate restored: the reviewer dispatches (no BlockError); the setup/error
  // replay entries were ignored, so they do not gate on anything.
  await callTool(h, "execute.before", {
    tool: "task",
    sessionID: "p1",
    input: { agent: "reviewer", prompt: "review it" },
  })
  dispose()
})

/** With custom agent names and waiver marker, the no-gate-pass message interpolates all three. */
test("block messages: custom config interpolates into the no-gate-pass message", async () => {
  const { h, dispose, metricsDir } = await boot({
    waiverMarker: "OVERRIDE:",
    agents: { testRunner: "qa-runner", reviewer: "qa-reviewer" },
  })
  // Dispatch the customized reviewer name without the waiver marker to trigger the gate.
  await assert.rejects(
    () =>
      callTool(h, "execute.before", {
        tool: "task",
        sessionID: "p1",
        input: { agent: "qa-reviewer", prompt: "review it" },
      }),
    (e: Error) =>
      e.message ===
      "BLOCKED by turnstile: no reviewer dispatch before the test gate is green. " +
        "Run the qa-runner subagent first; dispatch qa-reviewer only after its first line is " +
        "`GATE: PASS tests=<n> passed=<n> failed=<n>`, or obtain an explicit user waiver " +
        "(a user prompt this task must contain the literal marker 'OVERRIDE:' followed by the user's words).",
  )
  // The customized waiver marker is captured from the user prompt (never the
  // dispatch prompt) and bypasses the gate and is journaled; the dispatch
  // entry still records the customized agent name.
  await callSession(h, "prompt", { sessionID: "p1", text: "OVERRIDE: user said ship it" })
  await callTool(h, "execute.before", {
    tool: "task",
    sessionID: "p1",
    input: { agent: "qa-reviewer", prompt: "review it" },
  })
  const dispatched = journalEntries(metricsDir).find(
    (l) => l.type === "dispatch" && l.agent === "qa-reviewer",
  )
  assert.ok(dispatched)
  const waived = journalEntries(metricsDir).find((l) => l.type === "gate" && l.result === "WAIVED")
  assert.ok(waived)
  assert.equal(waived?.channel, "prompt")
  assert.equal(waived?.waiver, "OVERRIDE: user said ship it")
  dispose()
})

/** With custom agent names and waiver marker, the plan-approval message interpolates all three. */
test("block messages: custom config interpolates into the plan-approval message", async () => {
  const project = tmpDir()
  fs.mkdirSync(path.join(project, ".opencode", "plans"), { recursive: true })
  fs.writeFileSync(path.join(project, ".opencode", "plans", "plan.md"), "# P\n")
  const prev = process.cwd()
  process.chdir(project)
  try {
    const { h, dispose } = await boot({
      waiverMarker: "OVERRIDE:",
      agents: { planReviewer: "plan-check", executor: "qa-executor" },
    })
    // Dispatch the customized executor name without the waiver marker to trigger the gate.
    await assert.rejects(
      () =>
        callTool(h, "execute.before", {
          tool: "task",
          sessionID: "p1",
          input: { agent: "qa-executor", prompt: "do the work" },
        }),
      (e: Error) =>
        e.message ===
        `BLOCKED by turnstile: no plan approval for "plan.md". Dispatch the plan-check subagent first; proceed with qa-executor only after the plan-check's first line is ` +
          "`VERDICT: APPROVE crit=<n> high=<n> med=<n> low=<n>`, or obtain an explicit user waiver " +
          "(a user prompt this task must contain the literal marker 'OVERRIDE:' followed by the user's words).",
    )
    dispose()
  } finally {
    process.chdir(prev)
  }
})

/** A fresh GateState initializes the dedup-provenance map and the pending
 *  cross-child suppression counter, and no longer carries the removed
 *  verdicts list. */
test("newState initializes seenFrom and suppressedPending and omits verdicts", () => {
  const s = newState()
  assert.ok(s.seenFrom instanceof Map)
  assert.equal(s.seenFrom.size, 0)
  assert.equal(s.suppressedPending, 0)
  assert.equal("verdicts" in s, false)
  assert.equal(s.policyInjected, false)
})

/** A fresh bucket initializes the waiver family to its defaults (empty
 *  waiver, unscoped, unconsumed, zero allowance), the per-reason once-grants
 *  ({ plan, landing }), and the false human-provenance flag. */
test("newState initializes userWaiver, humanApproval, and pendingOnceGrant defaults", () => {
  const s = newState()
  assert.equal(s.userWaiver, "")
  assert.deepEqual(s.userWaiverScope, [], "a fresh waiver is unscoped")
  assert.equal(s.userWaiverConsumed, false, "a fresh waiver is not consumed")
  assert.equal(s.reviewWaiverRounds, 0, "a fresh task has spent no waiver allowance")
  assert.equal(s.humanApproval, false)
  assert.deepEqual(s.pendingOnceGrant, { plan: "", landing: "" })
})

/** The landing-gate primitives start at their task-scoped defaults: no
 *  reviewer approval yet, and a zero landing-block counter. */
test("newState initializes hasReviewApprove and landingBlocks defaults", () => {
  const s = newState()
  assert.equal(s.hasReviewApprove, false)
  assert.equal(s.landingBlocks, 0)
})

/** The dispatch loop caps start fresh: every per-leg round counter and the
 *  total-dispatch counter begin at 0 so a fresh task counts from zero. */
test("newState initializes the loop-cap counters", () => {
  const s = newState()
  assert.equal(s.plannerRounds, 0)
  assert.equal(s.planReviewerRounds, 0)
  assert.equal(s.testRunnerRounds, 0)
  assert.equal(s.totalDispatches, 0)
  assert.equal(s.reviewerDispatches, 0)
})

/**
 * Landing-gate flag lifecycle: only a delivery-attributed reviewer
 * `VERDICT: APPROVE` (task-result) sets `hasReviewApprove`; a streamed verdict
 * in child text does not; a `GATE: FAIL` never clears it; and replay restores
 * it across a restart with the same one-prompt grace as a plan verdict. Under
 * `reviewEnsemble: enforce` the review is credited only once two unwaived
 * reviewer dispatches were counted this task.
 */

/** A compliant reviewer task-result delivery credits the task: after a green
 *  gate and two unwaived reviewer dispatches, the verdict becomes
 *  `hasReviewApprove`, and the task-result capture round-trips through the
 *  journal into the next boot's replay. */
test("a reviewer task-result verdict restores hasReviewApprove across a restart", async () => {
  // flag flips the gate on a plain PASS (the flip switch is orthogonal to the
  // ensemble count, which still needs two reviewer dispatches to credit).
  const { h, dispose, metricsDir } = await boot({ gateEvidence: "flag" })
  await callTool(h, "execute.after", {
    tool: "task",
    sessionID: "p1",
    input: { agent: "test-runner" },
    result: { output: "GATE: PASS tests=3 passed=3 failed=0\nrest" },
  })
  // Two unwaived reviewer dispatches count the ensemble up to two, which is
  // what enforce requires before the verdict is credited.
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
    result: { output: "VERDICT: APPROVE crit=0 high=0 med=0 low=0\n" },
  })
  // The reviewer verdict is journaled against the parent with the task-result
  // source (the discriminator replay credits).
  const verdict = journalEntries(metricsDir).find(
    (l) => l.type === "verdict" && typeof l.marker === "string" && l.marker.includes("APPROVE"),
  )
  assert.ok(verdict, "the verdict was journaled")
  assert.equal(verdict.source, "task-result")
  // The next boot restores the landing-gate approval from that verdict.
  const ledger = createLedger(path.join(metricsDir, "turnstile.jsonl"))
  assert.equal(ledger.state("p1").hasReviewApprove, true, "replay restored hasReviewApprove")
  dispose()
})

/** A reviewer `VERDICT: BLOCK` never releases the landing gate. */
test("a reviewer task-result verdict BLOCK does not restore hasReviewApprove", async () => {
  const { h, dispose, metricsDir } = await boot()
  await callTool(h, "execute.after", {
    tool: "task",
    sessionID: "p1",
    input: { agent: "reviewer", prompt: "review it" },
    result: { output: "VERDICT: BLOCK crit=0 high=0 med=0 low=0\n" },
  })
  const ledger = createLedger(path.join(metricsDir, "turnstile.jsonl"))
  assert.equal(ledger.state("p1").hasReviewApprove, false, "a BLOCK verdict sets nothing")
  dispose()
})

/** A `VERDICT: APPROVE` seen only in streamed child text never restores
 *  hasReviewApprove: landing release requires a delivery-attributed reviewer
 *  verdict, and the streamed verdict is journaled with a non-task-result
 *  source that replay never credits. */
test("a streamed verdict does not restore hasReviewApprove", async () => {
  const { h, dispose, metricsDir } = await boot()
  h.pushEvent({
    type: "session.created",
    data: { sessionID: "c1", parentID: "p1", agent: "reviewer" },
  })
  h.pushEvent({
    type: "session.text.ended",
    data: {
      sessionID: "c1",
      text: "VERDICT: APPROVE crit=0 high=0 med=0 low=0\n",
    },
  })
  await waitUntil(() => journalEntries(metricsDir).some((l) => l.type === "verdict"))
  const verdict = journalEntries(metricsDir).find((l) => l.type === "verdict")
  assert.ok(verdict)
  assert.notEqual(verdict.source, "task-result", "the streamed verdict is not a task-result")
  const ledger = createLedger(path.join(metricsDir, "turnstile.jsonl"))
  assert.equal(
    ledger.state("p1").hasReviewApprove,
    false,
    "streamed verdict never releases the gate",
  )
  dispose()
})

/** Replay restores hasReviewApprove from a journaled reviewer verdict; the
 *  first post-restart prompt carries it (grace), and a later prompt clears it. */
test("replay restores hasReviewApprove and the grace prompt carries it once, then clears", () => {
  const metricsDir = tmpDir()
  fs.writeFileSync(
    path.join(metricsDir, "turnstile.jsonl"),
    `${JSON.stringify({
      ts: "t",
      type: "verdict",
      sessionID: "p1",
      raw: "c1",
      marker: "VERDICT: APPROVE crit=0 high=0 med=0 low=0",
      source: "task-result",
    })}\n`,
  )
  const ledger = createLedger(path.join(metricsDir, "turnstile.jsonl"))
  assert.equal(ledger.state("p1").hasReviewApprove, true, "replay restored hasReviewApprove")
  // Grace prompt: mergeAfterReplay carries the restart-sticky flag forward once.
  ledger.resetState("p1")
  assert.equal(ledger.state("p1").hasReviewApprove, true, "grace carries hasReviewApprove forward")
  // Second prompt: a full reset clears it (task-scoped again).
  ledger.resetState("p1")
  assert.equal(ledger.state("p1").hasReviewApprove, false, "hasReviewApprove clears on full reset")
})

/** A trailing `GATE: FAIL` does not clear a restored reviewer approval — the
 *  recency boundary for hasReviewApprove is the last verdict, not the last
 *  gate result. */
test("a trailing GATE: FAIL does not clear a restored hasReviewApprove", () => {
  const metricsDir = tmpDir()
  fs.writeFileSync(
    path.join(metricsDir, "turnstile.jsonl"),
    [
      JSON.stringify({
        ts: "t0",
        type: "verdict",
        sessionID: "p1",
        raw: "c1",
        marker: "VERDICT: APPROVE crit=0 high=0 med=0 low=0",
        source: "task-result",
      }),
      JSON.stringify({ ts: "t1", type: "gate", sessionID: "p1", raw: "c1", result: "FAIL" }),
    ].join("\n") + "\n",
  )
  const ledger = createLedger(path.join(metricsDir, "turnstile.jsonl"))
  assert.equal(ledger.state("p1").hasReviewApprove, true, "GATE: FAIL never clears the approval")
})

/** resetState drops the task-scoped waiver (and its scope, consumed flag, and
 *  allowance counter), the per-reason once-grants, and resets humanApproval to
 *  false on an ordinary (non-grace) prompt reset. */
test("resetState clears userWaiver, pendingOnceGrant, and humanApproval", () => {
  const ledger = createLedger(path.join(tmpDir(), "turnstile.jsonl"))
  const s = ledger.state("p1")
  s.userWaiver = "USER WAIVER: proceed"
  s.userWaiverScope = ["reviewer"]
  s.userWaiverConsumed = true
  s.reviewWaiverRounds = 1
  s.humanApproval = true
  s.pendingOnceGrant = { plan: "req-42", landing: "req-9" }
  ledger.resetState("p1")
  const cur = ledger.state("p1")
  assert.equal(cur.userWaiver, "", "userWaiver clears on reset")
  assert.deepEqual(cur.userWaiverScope, [], "userWaiverScope clears on reset")
  assert.equal(cur.userWaiverConsumed, false, "userWaiverConsumed clears on reset")
  assert.equal(cur.reviewWaiverRounds, 0, "reviewWaiverRounds clears on reset")
  assert.deepEqual(
    cur.pendingOnceGrant,
    { plan: "", landing: "" },
    "pendingOnceGrant clears on reset",
  )
  assert.equal(cur.humanApproval, false, "humanApproval resets on prompt")
})

/** humanApproval is restart-sticky exactly like hasPlanVerdict: a
 *  journal-restored flag survives the first post-restart (grace) prompt via
 *  mergeAfterReplay, then clears on the next full reset. The whole waiver
 *  family (quote, scope, consumed flag, allowance counter) and the once-grant
 *  strings stay task-scoped and never carry through the merge. */
test("grace prompt carries restored humanApproval forward then clears it", () => {
  const metricsDir = tmpDir()
  // A journaled plan APPROVE restores hasPlanVerdict + the one-prompt grace.
  fs.writeFileSync(
    path.join(metricsDir, "turnstile.jsonl"),
    `${JSON.stringify({ ts: "t", type: "plan", sessionID: "p1", result: "APPROVE" })}\n`,
  )
  const ledger = createLedger(path.join(metricsDir, "turnstile.jsonl"))
  // Seed the journal-restored provenance value: the journal owns the
  // source; mergeAfterReplay must carry it across the grace prompt.
  const s = ledger.state("p1")
  assert.equal(s.hasPlanVerdict, true, "replay restored hasPlanVerdict")
  s.humanApproval = true
  s.userWaiver = "USER WAIVER: keep"
  s.userWaiverScope = ["reviewer"]
  s.userWaiverConsumed = true
  s.reviewWaiverRounds = 1
  s.pendingOnceGrant = { plan: "req-keep", landing: "" }
  // Grace prompt: mergeAfterReplay carries the restart-sticky flag forward,
  // never wipes it; the task-scoped waiver family and once-grants drop as
  // usual.
  ledger.resetState("p1")
  const afterGrace = ledger.state("p1")
  assert.equal(afterGrace.hasPlanVerdict, true, "hasPlanVerdict carried by grace")
  assert.equal(afterGrace.humanApproval, true, "humanApproval carried by grace")
  assert.equal(afterGrace.userWaiver, "", "userWaiver never carried through merge")
  assert.deepEqual(afterGrace.userWaiverScope, [], "userWaiverScope never carried through merge")
  assert.equal(
    afterGrace.userWaiverConsumed,
    false,
    "userWaiverConsumed never carried through merge",
  )
  assert.equal(afterGrace.reviewWaiverRounds, 0, "reviewWaiverRounds never carried through merge")
  assert.deepEqual(
    afterGrace.pendingOnceGrant,
    { plan: "", landing: "" },
    "pendingOnceGrant never carried through merge",
  )
  // Second prompt: a full reset clears everything.
  ledger.resetState("p1")
  const afterReset = ledger.state("p1")
  assert.equal(afterReset.hasPlanVerdict, false, "hasPlanVerdict cleared on full reset")
  assert.equal(afterReset.humanApproval, false, "humanApproval cleared on full reset")
  assert.deepEqual(afterReset.userWaiverScope, [], "userWaiverScope cleared on full reset")
  assert.equal(afterReset.userWaiverConsumed, false, "userWaiverConsumed cleared on full reset")
  assert.equal(afterReset.reviewWaiverRounds, 0, "reviewWaiverRounds cleared on full reset")
})

/** Replay restores the bound plan identity from a fielded plan APPROVE; a
 *  field-less (legacy) line restores unbound; a trailing BLOCK restores
 *  nothing. */
test("replay restores bound plan identity; legacy lines restore unbound; BLOCK restores nothing", () => {
  const metricsDir = tmpDir()
  const journalPath = path.join(metricsDir, "turnstile.jsonl")
  fs.writeFileSync(
    journalPath,
    [
      JSON.stringify({
        ts: "t1",
        type: "plan",
        sessionID: "p1",
        result: "APPROVE",
        plan: "z-work.md",
        planKey: "abc123",
      }),
      JSON.stringify({ ts: "t2", type: "plan", sessionID: "p2", result: "APPROVE" }),
      JSON.stringify({
        ts: "t3",
        type: "plan",
        sessionID: "p3",
        result: "APPROVE",
        plan: "other.md",
        planKey: "def456",
      }),
      JSON.stringify({ ts: "t4", type: "plan", sessionID: "p3", result: "BLOCK" }),
    ].join("\n") + "\n",
  )
  const ledger = createLedger(journalPath)
  const s1 = ledger.state("p1")
  assert.equal(s1.hasPlanVerdict, true)
  assert.equal(s1.approvedPlan, "z-work.md", "replay restores the bound plan name")
  assert.equal(s1.approvedPlanKey, "abc123", "replay restores the bound plan key")
  const s2 = ledger.state("p2")
  assert.equal(s2.hasPlanVerdict, true)
  assert.equal(s2.approvedPlan, "", "legacy field-less APPROVE restores unbound")
  assert.equal(s2.approvedPlanKey, "", "legacy field-less APPROVE restores an empty key")
  const s3 = ledger.state("p3")
  assert.equal(s3.hasPlanVerdict, false, "a trailing BLOCK never restores")
  assert.equal(s3.approvedPlan, "")
  assert.equal(s3.approvedPlanKey, "")
})

/** The bound plan identity is restart-sticky exactly like hasPlanVerdict: the
 *  grace prompt carries the pair forward and a full reset clears both. */
test("grace prompt carries the bound plan identity; a full reset clears it", () => {
  const metricsDir = tmpDir()
  fs.writeFileSync(
    path.join(metricsDir, "turnstile.jsonl"),
    `${JSON.stringify({
      ts: "t",
      type: "plan",
      sessionID: "p1",
      result: "APPROVE",
      plan: "z-work.md",
      planKey: "abc123",
    })}\n`,
  )
  const ledger = createLedger(path.join(metricsDir, "turnstile.jsonl"))
  const s = ledger.state("p1")
  assert.equal(s.hasPlanVerdict, true)
  assert.equal(s.approvedPlan, "z-work.md")
  // Grace prompt: the identity carries with the verdict.
  ledger.resetState("p1")
  const afterGrace = ledger.state("p1")
  assert.equal(afterGrace.hasPlanVerdict, true)
  assert.equal(afterGrace.approvedPlan, "z-work.md", "plan name carried by grace")
  assert.equal(afterGrace.approvedPlanKey, "abc123", "plan key carried by grace")
  // Second prompt: a full reset clears both fields.
  ledger.resetState("p1")
  const afterReset = ledger.state("p1")
  assert.equal(afterReset.hasPlanVerdict, false)
  assert.equal(afterReset.approvedPlan, "", "plan name cleared on full reset")
  assert.equal(afterReset.approvedPlanKey, "", "plan key cleared on full reset")
})

/** Replay restores a journaled `plansSig` verbatim on a string field; a
 *  field-less (legacy) line and a non-string field both restore the empty
 *  stamp, keeping the documented accept-once window. */
test("replay restores the journaled plan signature; legacy and non-string fields restore unstamped", () => {
  const metricsDir = tmpDir()
  const journalPath = path.join(metricsDir, "turnstile.jsonl")
  fs.writeFileSync(
    journalPath,
    [
      JSON.stringify({
        ts: "t1",
        type: "plan",
        sessionID: "p1",
        result: "APPROVE",
        plansSig: "plan.md:abc",
      }),
      JSON.stringify({ ts: "t2", type: "plan", sessionID: "p2", result: "APPROVE" }),
      JSON.stringify({ ts: "t3", type: "plan", sessionID: "p3", result: "APPROVE", plansSig: 42 }),
    ].join("\n") + "\n",
  )
  const ledger = createLedger(journalPath)
  const s1 = ledger.state("p1")
  assert.equal(s1.hasPlanVerdict, true)
  assert.equal(s1.plansSignature, "plan.md:abc", "a string plansSig restores the stamp verbatim")
  const s2 = ledger.state("p2")
  assert.equal(s2.hasPlanVerdict, true)
  assert.equal(s2.plansSignature, "", "a field-less legacy line restores the empty stamp")
  const s3 = ledger.state("p3")
  assert.equal(s3.hasPlanVerdict, true)
  assert.equal(s3.plansSignature, "", "a non-string plansSig restores the empty stamp")
})

/** The journaled plan dir signature is restart-sticky exactly like
 *  hasPlanVerdict: the grace prompt carries it forward and a full reset
 *  clears it. */
test("grace prompt carries the journaled plan signature; a full reset clears it", () => {
  const metricsDir = tmpDir()
  fs.writeFileSync(
    path.join(metricsDir, "turnstile.jsonl"),
    `${JSON.stringify({
      ts: "t",
      type: "plan",
      sessionID: "p1",
      result: "APPROVE",
      plansSig: "plan.md:abc",
    })}\n`,
  )
  const ledger = createLedger(path.join(metricsDir, "turnstile.jsonl"))
  const s = ledger.state("p1")
  assert.equal(s.hasPlanVerdict, true)
  assert.equal(s.plansSignature, "plan.md:abc")
  // Grace prompt: the stamp carries with the verdict.
  ledger.resetState("p1")
  const afterGrace = ledger.state("p1")
  assert.equal(afterGrace.hasPlanVerdict, true)
  assert.equal(afterGrace.plansSignature, "plan.md:abc", "the stamp is carried by grace")
  // Second prompt: a full reset clears the stamp.
  ledger.resetState("p1")
  const afterReset = ledger.state("p1")
  assert.equal(afterReset.hasPlanVerdict, false)
  assert.equal(afterReset.plansSignature, "", "the stamp is cleared on full reset")
})

/** formatGateSnapshot renders the plan=<name> suffix only when a bound plan
 *  identity is present; unbound buckets render the plan line unchanged. */
test("snapshot renders the bound plan suffix only when bound", () => {
  const unbound = formatGateSnapshot({
    ...newState(),
    hasPlanVerdict: true,
    plansSignature: "abc",
  }).split("\n")
  assert.match(unbound[2]!, /^- plan: APPROVED stamp=known$/)
  const bound = formatGateSnapshot({
    ...newState(),
    hasPlanVerdict: true,
    plansSignature: "abc",
    approvedPlan: "z-work.md",
    approvedPlanKey: "abc123",
  }).split("\n")
  assert.match(bound[2]!, /^- plan: APPROVED plan=z-work\.md stamp=known$/)
})

/** An invalid `gateMarker` config falls back to the canonical regex and journals
 * exactly one `type:"error"` naming the key; enforcement still matches canonical
 * GATE: PASS output. */
test("observability: invalid gateMarker journals one error naming the key and canonical markers still match", async () => {
  const { h, dispose, metricsDir } = await boot({ gateMarker: "([" })
  await callTool(h, "execute.after", {
    tool: "task",
    sessionID: "p1",
    input: { agent: "test-runner" },
    result: { output: "GATE: PASS tests=1 passed=1 failed=0\n" },
  })
  const errors = journalEntries(metricsDir).filter((l) => l.type === "error")
  assert.equal(errors.length, 1, "the compile fallback journals exactly one error")
  assert.match(errors[0]!.error, /gateMarker/, "the error names the offending key")
  // Enforcement continues with the canonical regex despite the bad config.
  const gate = journalEntries(metricsDir).find((l) => l.type === "gate" && l.result === "PASS")
  assert.ok(gate, "the canonical GATE: PASS marker still matches")
  dispose()
})

/** An invalid `verdictMarker` config falls back to the canonical regex and journals
 * exactly one `type:"error"` naming the key; enforcement still matches canonical
 * VERDICT: output. */
test("observability: invalid verdictMarker journals one error naming the key and canonical markers still match", async () => {
  const { h, dispose, metricsDir } = await boot({ verdictMarker: "(*" })
  await callTool(h, "execute.after", {
    tool: "task",
    sessionID: "p1",
    input: { agent: "reviewer" },
    result: { output: "VERDICT: APPROVE crit=0 high=0 med=0 low=0\n" },
  })
  const errors = journalEntries(metricsDir).filter((l) => l.type === "error")
  assert.equal(errors.length, 1, "the compile fallback journals exactly one error")
  assert.match(errors[0]!.error, /verdictMarker/, "the error names the offending key")
  const verdict = journalEntries(metricsDir).find(
    (l) => l.type === "verdict" && l.marker?.startsWith("VERDICT: APPROVE"),
  )
  assert.ok(verdict, "the canonical VERDICT marker still matches")
  dispose()
})

/** Every session-bound trace line ends with the wired session's ` | <id>`
 * tail; dispatch, gate, waiver and plan-waiver are reachable from callTool. */
test("trace lines carry a trailing ` | <sessionID>` when wired to a session", async () => {
  const { h, dispose, metricsDir } = await boot()
  // dispatch: a task execute.before fires the orchestrator dispatch trace.
  await callTool(h, "execute.before", {
    tool: "task",
    sessionID: "p1",
    input: { agent: "test-runner" },
  })
  // gate: a test-runner GATE: PASS execution fires the test-runner gate trace.
  await callTool(h, "execute.after", {
    tool: "task",
    sessionID: "p1",
    input: { agent: "test-runner" },
    result: { output: "GATE: PASS tests=1 passed=1 failed=0\n" },
  })
  // waiver: a prompt-channel USER WAIVER fires the gate waiver trace
  // (guardReviewerDispatch handles the waiver before plan approval).
  await callSession(h, "prompt", { sessionID: "p1", text: "USER WAIVER: the user shipped it" })
  await callTool(h, "execute.before", {
    tool: "task",
    sessionID: "p1",
    input: { agent: "reviewer", prompt: "review it" },
  })
  // plan-waiver: the same marker in the user prompt fires the plan-approval
  // waiver trace (enforcePlanApproval). The executor prompt also carries a
  // decomposition citation so the decomposition gate stays a no-op and the
  // plan-waiver trace is the only executor outcome.
  await callSession(h, "prompt", { sessionID: "p1", text: "USER WAIVER: please proceed" })
  await callTool(h, "execute.before", {
    tool: "task",
    sessionID: "p1",
    input: { agent: "executor", prompt: "do the work AC-1" },
  })
  const lines = traceText(metricsDir).trim().split("\n").filter(Boolean)
  const carriesTail = (needle: string): boolean =>
    lines.some((l) => l.includes(needle) && l.endsWith(" | p1"))
  assert.ok(
    carriesTail("| orchestrator | dispatch | task -> test-runner"),
    "the dispatch trace carries the sessionID tail",
  )
  assert.ok(
    carriesTail("| test-runner | gate | GATE: PASS"),
    "the gate trace carries the sessionID tail",
  )
  assert.ok(
    carriesTail("| user | waiver | USER WAIVER"),
    "the waiver trace carries the sessionID tail",
  )
  assert.ok(
    carriesTail("| user | plan-waiver | USER WAIVER"),
    "the plan-waiver trace carries the sessionID tail",
  )
  dispose()
})

/** A child-session verdict attributes to the parent and its trace line ends
 * with the parent session's ` | <id>` tail. */
test("trace lines carry a trailing ` | <sessionID>` for a child verdict", async () => {
  const metricsDir = tmpDir()
  const h = makeFakeHost({
    sessionRecords: new Map([["c1", { parentID: "p1", agent: "reviewer" }]]),
  })
  const setup = turnstile(h.host, { env: isolatedEnv(metricsDir), config: { metricsDir } })
  const dispose = (await setup(h.host)) as () => void
  h.pushEvent({
    type: "message.part.updated",
    data: {
      sessionID: "c1",
      part: { type: "text", text: "VERDICT: APPROVE crit=0 high=0 med=1 low=2" },
    },
  })
  await waitUntil(() => journalEntries(metricsDir).some((l) => l.type === "verdict"))
  const verdictLine = traceText(metricsDir)
    .trim()
    .split("\n")
    .find((l) => l.includes("| reviewer | verdict |"))
  assert.ok(verdictLine, "a reviewer verdict trace line is emitted")
  assert.ok(verdictLine?.endsWith(" | p1"), "the verdict trace carries the parent sessionID tail")
  dispose()
})

/** An unreadable plan file throws mid-scan: the fail-open catches in
 *  `enforcePlanApproval` + `enforceDecomposition` now journal a `type:"error"`
 *  (they were silent before) while the executor dispatch still passes through
 *  with no BlockError. The real Decomposition block path still propagates a
 *  BlockError when the plans dir is readable. Skipped as root, where the
 *  permission bits are bypassed. */
test("executor dispatch journals a fail-open error on an unreadable plan and does not block", async () => {
  if (process.getuid?.() === 0) return
  const project = tmpDir()
  const plansDir = path.join(project, ".opencode", "plans")
  fs.mkdirSync(plansDir, { recursive: true })
  const planPath = path.join(plansDir, "plan.md")
  fs.writeFileSync(planPath, "# P\n## Decomposition\n- chunk-1\n")
  const prev = process.cwd()
  process.chdir(project)
  try {
    const { h, dispose, metricsDir } = await boot()
    // Real block path: a readable Decomposition plan, approved → executor blocked.
    // Delivered on the child so the approval keys raw=c1.
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
    await assert.rejects(
      () =>
        callTool(h, "execute.before", {
          tool: "task",
          sessionID: "p1",
          input: { agent: "executor", prompt: "do the work" },
        }),
      (e: Error) =>
        e.message ===
        'BLOCKED by turnstile: plan "plan.md" has a ## Decomposition block — executor dispatches must cite the chunk-N / AC-n they implement.',
    )
    // Now the plan is unreadable: scanPlans throws EACCES, both enforce gates
    // journal a fail-open error and the executor dispatch passes through.
    const mode = fs.statSync(planPath).mode
    fs.chmodSync(planPath, 0o000)
    try {
      await callTool(h, "execute.before", {
        tool: "task",
        sessionID: "p1",
        input: { agent: "executor", prompt: "do the work" },
      })
      const errors = journalEntries(metricsDir).filter((l) => l.type === "error")
      assert.ok(
        errors.some((l) => l.error?.includes("plans dir unreadable")),
        "a fail-open plans-dir error is journaled (no silent suppression)",
      )
    } finally {
      fs.chmodSync(planPath, mode)
    }
    dispose()
  } finally {
    process.chdir(prev)
  }
})

/** Replay reads the rotated generation: a GATE: PASS buried in
 *  `turnstile.jsonl.1` alone (no current journal) restores the parent-keyed
 *  gate across a restart. */
test("journal replay restores a GATE: PASS from the previous generation alone", async () => {
  const metricsDir = tmpDir()
  fs.writeFileSync(
    path.join(metricsDir, "turnstile.jsonl.1"),
    `${JSON.stringify({ ts: "t", type: "gate", sessionID: "p1", raw: "c1", result: "PASS" })}\n`,
  )
  const h = makeFakeHost()
  const setup = turnstile(h.host, { env: isolatedEnv(metricsDir), config: { metricsDir } })
  const dispose = (await setup(h.host)) as () => void
  await callTool(h, "execute.before", {
    tool: "task",
    sessionID: "p1",
    input: { agent: "reviewer", prompt: "review it" },
  })
  dispose()
})

/** Replay latest-wins carries across files: a current-file GATE: FAIL for a
 *  session overrides the same session's PASS in the previous generation,
 *  keeping the gate red. */
test("journal replay: current-file entry wins over the previous generation for the same session", async () => {
  const metricsDir = tmpDir()
  fs.writeFileSync(
    path.join(metricsDir, "turnstile.jsonl.1"),
    `${JSON.stringify({ ts: "t1", type: "gate", sessionID: "p1", raw: "c1", result: "PASS" })}\n`,
  )
  fs.writeFileSync(
    path.join(metricsDir, "turnstile.jsonl"),
    `${JSON.stringify({ ts: "t2", type: "gate", sessionID: "p1", raw: "c2", result: "FAIL" })}\n`,
  )
  const h = makeFakeHost()
  const setup = turnstile(h.host, { env: isolatedEnv(metricsDir), config: { metricsDir } })
  const dispose = (await setup(h.host)) as () => void
  await assert.rejects(
    () =>
      callTool(h, "execute.before", {
        tool: "task",
        sessionID: "p1",
        input: { agent: "reviewer", prompt: "review it" },
      }),
    (e: Error) => e.message === NO_GATE_MESSAGE,
  )
  dispose()
})

/** Replay skips malformed lines in both generations and still restores a valid
 *  GATE: PASS alongside them. */
test("journal replay skips malformed lines in both generations and restores the valid PASS", async () => {
  const metricsDir = tmpDir()
  fs.writeFileSync(
    path.join(metricsDir, "turnstile.jsonl.1"),
    `not json\n${JSON.stringify({ ts: "t", type: "gate", sessionID: "p1", raw: "c1", result: "PASS" })}\n`,
  )
  fs.writeFileSync(
    path.join(metricsDir, "turnstile.jsonl"),
    `${JSON.stringify({ ts: "t", type: "gate", sessionID: "p1", raw: "c2", result: "PASS" })}\n`,
  )
  const h = makeFakeHost()
  const setup = turnstile(h.host, { env: isolatedEnv(metricsDir), config: { metricsDir } })
  const dispose = (await setup(h.host)) as () => void
  await callTool(h, "execute.before", {
    tool: "task",
    sessionID: "p1",
    input: { agent: "reviewer", prompt: "review it" },
  })
  dispose()
})

/** Replay's 2000-line tail is bound across both generations, not per file: a
 *  GATE: PASS whose only entry lands before the combined last 2000 lines (here
 *  1500 in `.1` + 600 current = 2100, dropping the first 100) is dropped, so
 *  the session's gate stays red. */
test("journal replay tail is bounded at 2000 lines across both generations", async () => {
  const metricsDir = tmpDir()
  // `.1`: 1500 lines; only the first (pDropped) is uniquely ours.
  const prior = new Array(1500)
    .fill(null)
    .map((_, i) =>
      JSON.stringify({
        ts: "t",
        type: "gate",
        sessionID: i === 0 ? "pDropped" : "pFiller",
        raw: `c${i}`,
        result: "PASS",
      }),
    )
    .join("\n")
  fs.writeFileSync(path.join(metricsDir, "turnstile.jsonl.1"), `${prior}\n`)
  // current: 600 PASS for the filler, so pDropped's sole entry is dropped.
  const current = new Array(600)
    .fill(null)
    .map((_, i) =>
      JSON.stringify({ ts: "t", type: "gate", sessionID: "pFiller", raw: `d${i}`, result: "PASS" }),
    )
    .join("\n")
  fs.writeFileSync(path.join(metricsDir, "turnstile.jsonl"), `${current}\n`)
  const h = makeFakeHost()
  const setup = turnstile(h.host, { env: isolatedEnv(metricsDir), config: { metricsDir } })
  const dispose = (await setup(h.host)) as () => void
  // pDropped's only entry (line 1 of `.1`) is beyond the last 2000 combined
  // lines, so it is not restored and the reviewer dispatch is blocked.
  await assert.rejects(
    () =>
      callTool(h, "execute.before", {
        tool: "task",
        sessionID: "pDropped",
        input: { agent: "reviewer", prompt: "review it" },
      }),
    (e: Error) => e.message === NO_GATE_MESSAGE,
  )
  dispose()
})

// ---------------------------------------------------------------------------
// Evidence correlation (verified verdicts, gate-unverified gating)
// ---------------------------------------------------------------------------

/** enforce mode: an unverified PASS (no correlating evidence) does not
 *  green the gate; the gate entry is journaled verified:false and reviewer
 *  dispatch is blocked with the gate-unverified message (reason gate-unverified). */
test("enforce mode: an unverified PASS blocks reviewer dispatch with reason gate-unverified", async () => {
  const { h, dispose, metricsDir } = await boot() // default gateEvidence:"enforce"
  await callTool(h, "execute.after", {
    tool: "task",
    sessionID: "p1",
    input: { agent: "test-runner" },
    result: { output: "GATE: PASS tests=1 passed=1 failed=0\n" },
  })
  const gate = journalEntries(metricsDir).find((l) => l.type === "gate" && l.result === "PASS")
  assert.ok(gate)
  assert.equal(gate.verified, false)
  assert.equal(gate.mode, "enforce")
  await assert.rejects(
    () =>
      callTool(h, "execute.before", {
        tool: "task",
        sessionID: "p1",
        input: { agent: "reviewer", prompt: "review it" },
      }),
    (e: Error) => e.message === GATE_UNVERIFIED_SEARCHED_NONE_MESSAGE,
  )
  const blocked = journalEntries(metricsDir).find(
    (l) => l.type === "blocked" && l.reason === "gate-unverified",
  )
  assert.ok(blocked)
  // The refusal names what it searched: the parent ID, no children on record.
  assert.deepEqual(blocked.searched, ["p1"])
  dispose()
})

/** Boots a gate ledger + gates pair over a temp metrics dir for direct
 *  (two-argument / crafted-search) guard assertions. */
function bootGates(): {
  gates: ReturnType<typeof createGates>
  ledger: ReturnType<typeof createLedger>
  metricsDir: string
} {
  const metricsDir = tmpDir()
  const ledger = createLedger(path.join(metricsDir, "turnstile.jsonl"))
  const journaler = createJournaler({ metricsDir, trace: false, maxBytes: 1e6, maxGenerations: 1 })
  return { gates: createGates(defaultConfig(), journaler), ledger, metricsDir }
}

/** A two-argument guardReviewerDispatch renders the byte-identical legacy
 *  gate-unverified message and journals the blocked entry without a searched
 *  field. */
test("guardReviewerDispatch without a search context keeps the legacy gate-unverified message", () => {
  const { gates, ledger, metricsDir } = bootGates()
  ledger.state("p1").unverifiedPass = "GATE: PASS tests=1 passed=1 failed=0"
  assert.throws(
    () => gates.guardReviewerDispatch("p1", ledger),
    (e: Error) => e instanceof BlockError && e.message === GATE_UNVERIFIED_MESSAGE,
  )
  const blocked = journalEntries(metricsDir).find(
    (l) => l.type === "blocked" && l.reason === "gate-unverified",
  )
  assert.ok(blocked)
  assert.equal(blocked.searched, undefined, "no search context: no searched field")
})

/** With a search context the refusal lists the unattributable child
 *  (singular lead-in) and journals the searched IDs (parent first). */
test("guardReviewerDispatch with a search context lists an unattributable child", () => {
  const { gates, ledger, metricsDir } = bootGates()
  ledger.state("p1").unverifiedPass = "GATE: PASS tests=1 passed=1 failed=0"
  assert.throws(
    () =>
      gates.guardReviewerDispatch("p1", ledger, {
        attributed: [],
        unresolved: [{ session: "c1", reason: "no parent edge" }],
        direct: false,
      }),
    (e: Error) =>
      e instanceof BlockError &&
      e.message ===
        "BLOCKED by turnstile: reviewer dispatch without gate evidence: a GATE: PASS " +
          "was recorded without a journaled successful test-command execution for this " +
          "session (searched p1; journaled test executions: none — 1 child session with executions was unattributable: c1 (no parent edge)). " +
          "Run the test-runner subagent first, or obtain an explicit user waiver " +
          "(a user prompt this task must contain the literal marker 'USER WAIVER:' followed by the user's words).",
  )
  const blocked = journalEntries(metricsDir).find(
    (l) => l.type === "blocked" && l.reason === "gate-unverified",
  )
  assert.ok(blocked)
  assert.deepEqual(blocked.searched, ["p1", "c1"])
})

/** With a search context, attributable (stale-window) children render first,
 *  then unattributable ones, as comma-joined id (reason) items. */
test("guardReviewerDispatch with a search context lists attributed children before unattributable ones", () => {
  const { gates, ledger, metricsDir } = bootGates()
  ledger.state("p1").unverifiedPass = "GATE: PASS tests=1 passed=1 failed=0"
  assert.throws(
    () =>
      gates.guardReviewerDispatch("p1", ledger, {
        attributed: ["cA"],
        unresolved: [{ session: "cB", reason: "edge: p2" }],
        direct: false,
      }),
    (e: Error) =>
      e instanceof BlockError &&
      e.message.includes(
        "(searched p1; journaled test executions: cA (executions predate the current task window), cB (edge: p2))",
      ),
  )
  const blocked = journalEntries(metricsDir).find(
    (l) => l.type === "blocked" && l.reason === "gate-unverified",
  )
  assert.ok(blocked)
  assert.deepEqual(blocked.searched, ["p1", "cA", "cB"])
})

/** enforce mode: a PASS observed while a matching exit-0 bash test
 *  execution is journaled verifies green (verified:true) and unlocks the reviewer. */
test("enforce mode: a PASS with correlating bash evidence verifies and unlocks", async () => {
  const { h, dispose, metricsDir } = await boot()
  await callTool(h, "execute.after", {
    tool: "bash",
    sessionID: "p1",
    input: { command: "npm test" },
    result: { metadata: { exit: 0 } },
  })
  await callTool(h, "execute.after", {
    tool: "task",
    sessionID: "p1",
    input: { agent: "test-runner" },
    result: { output: "GATE: PASS tests=1 passed=1 failed=0\n" },
  })
  const gate = journalEntries(metricsDir).find((l) => l.type === "gate" && l.result === "PASS")
  assert.ok(gate)
  assert.equal(gate.verified, true)
  assert.equal(gate.mode, "enforce")
  await callTool(h, "execute.before", {
    tool: "task",
    sessionID: "p1",
    input: { agent: "reviewer", prompt: "review it" },
  })
  dispose()
})

/** a PASS rejected for lack of evidence is promoted to green the moment
 *  matching exit-0 evidence arrives: a `promoted` gate entry (verified:true,
 *  no marker field) plus a `type:"evidence"` observation with no command text;
 *  the reviewer unlocks and a re-delivered deduped PASS emits no new promotion. */
test("enforce mode: promotes an earlier unverified PASS on arriving evidence", async () => {
  const { h, dispose, metricsDir } = await boot()
  // PASS lands unverified first (no evidence yet).
  await callTool(h, "execute.after", {
    tool: "task",
    sessionID: "p1",
    input: { agent: "test-runner" },
    result: { output: "GATE: PASS tests=1 passed=1 failed=0\n" },
  })
  // Matching exit-0 evidence arrives.
  await callTool(h, "execute.after", {
    tool: "bash",
    sessionID: "p1",
    input: { command: "npm test" },
    result: { metadata: { exit: 0 } },
  })
  const promos = journalEntries(metricsDir).filter(
    (l) => l.type === "gate" && l.event === "promoted",
  )
  assert.equal(promos.length, 1)
  const promo: Record<string, unknown> | undefined = promos[0]
  assert.ok(promo)
  assert.equal(promo.result, "PASS")
  assert.equal(promo.verified, true)
  assert.equal(promo.mode, "enforce")
  // A promotion entry intentionally carries no `marker` field.
  assert.equal(promo.marker, undefined)
  const evid = journalEntries(metricsDir).find((l) => l.type === "evidence")
  assert.ok(evid)
  assert.equal(evid.event, "observed")
  assert.equal(evid.exit, 0)
  // Command text never leaves memory (redaction contract).
  assert.equal(evid.command, undefined)
  // Reviewer unlocked by the promotion.
  await callTool(h, "execute.before", {
    tool: "task",
    sessionID: "p1",
    input: { agent: "reviewer", prompt: "review it" },
  })
  // A re-delivered PASS cannot itself promote (promotions fire only on evidence).
  await callTool(h, "execute.after", {
    tool: "task",
    sessionID: "p1",
    input: { agent: "test-runner" },
    result: { output: "GATE: PASS tests=1 passed=1 failed=0\n" },
  })
  assert.equal(
    journalEntries(metricsDir).filter((l) => l.type === "gate" && l.event === "promoted").length,
    1,
  )
  dispose()
})

/** a GATE: FAIL after an unverified PASS clears the pending unverified
 *  claim: reviewer dispatch is blocked with the legacy NO_GATE_MESSAGE (reason
 *  no-gate-pass), not gate-unverified — proving the FAIL branch cleared
 *  `state.unverifiedPass`. */
test("enforce mode: a GATE: FAIL after an unverified PASS clears the unverified claim", async () => {
  const { h, dispose, metricsDir } = await boot()
  await callTool(h, "execute.after", {
    tool: "task",
    sessionID: "p1",
    input: { agent: "test-runner" },
    result: { output: "GATE: PASS tests=1 passed=1 failed=0\n" },
  })
  await callTool(h, "execute.after", {
    tool: "task",
    sessionID: "p1",
    input: { agent: "test-runner" },
    result: { output: "GATE: FAIL tests=1 passed=0 failed=1\n" },
  })
  await assert.rejects(
    () =>
      callTool(h, "execute.before", {
        tool: "task",
        sessionID: "p1",
        input: { agent: "reviewer", prompt: "review it" },
      }),
    (e: Error) => e.message === NO_GATE_MESSAGE,
  )
  const blocked = journalEntries(metricsDir).find(
    (l) => l.type === "blocked" && l.reason === "no-gate-pass",
  )
  assert.ok(blocked, "expected a no-gate-pass block (unverified claim cleared by FAIL)")
  dispose()
})

/** replay: a FAIL entry followed by an enforce-mode unverified PASS
 *  entry leaves the gate red after restart — the unverified PASS is skipped by
 *  the flipping-entry filter, so FAIL is the last deciding result and the
 *  (never-restored) unverified claim is absent → legacy no-gate-pass block. */
test("replay: FAIL wins over a later unverified enforce PASS", async () => {
  const metricsDir = tmpDir()
  fs.writeFileSync(
    path.join(metricsDir, "turnstile.jsonl"),
    `${JSON.stringify({ ts: "t", type: "gate", sessionID: "p1", result: "FAIL" })}\n` +
      `${JSON.stringify({
        ts: "t",
        type: "gate",
        sessionID: "p1",
        result: "PASS",
        verified: false,
        mode: "enforce",
      })}\n`,
  )
  const h = makeFakeHost()
  const setup = turnstile(h.host, { env: isolatedEnv(metricsDir), config: { metricsDir } })
  const dispose = (await setup(h.host)) as () => void
  await assert.rejects(
    () =>
      callTool(h, "execute.before", {
        tool: "task",
        sessionID: "p1",
        input: { agent: "reviewer", prompt: "review it" },
      }),
    (e: Error) => e.message === NO_GATE_MESSAGE,
  )
  dispose()
})

/** a FAIL followed by a fresh unverified enforce PASS at
 *  runtime leaves the gate red (FAIL un-greened it and an unverified PASS never
 *  flips); the new pending unverified claim is recorded, so the block names the
 *  evidence contract. */
test("runtime: FAIL then a later unverified enforce PASS keeps the gate red", async () => {
  const { h, dispose } = await boot()
  await callTool(h, "execute.after", {
    tool: "task",
    sessionID: "p1",
    input: { agent: "test-runner" },
    result: { output: "GATE: FAIL tests=1 passed=0 failed=1\n" },
  })
  await callTool(h, "execute.after", {
    tool: "task",
    sessionID: "p1",
    input: { agent: "test-runner" },
    result: { output: "GATE: PASS tests=1 passed=1 failed=0\n" },
  })
  await assert.rejects(
    () =>
      callTool(h, "execute.before", {
        tool: "task",
        sessionID: "p1",
        input: { agent: "reviewer", prompt: "review it" },
      }),
    (e: Error) => e.message === GATE_UNVERIFIED_SEARCHED_NONE_MESSAGE,
  )
  dispose()
})

/** exit-code 1 and pattern-mismatching commands never count as
 *  evidence: both leave the enforce gate red. */
test("enforce mode: non-zero exit and non-matching command are not evidence", async () => {
  const cases: Array<[string, string, number]> = [
    ["exit-1", "npm test", 1],
    ["pattern-mismatch", "ls -la", 0],
  ]
  for (const [label, command, exit] of cases) {
    const { h, dispose, metricsDir } = await boot()
    await callTool(h, "execute.after", {
      tool: "bash",
      sessionID: "p1",
      input: { command },
      result: { metadata: { exit } },
    })
    await callTool(h, "execute.after", {
      tool: "task",
      sessionID: "p1",
      input: { agent: "test-runner" },
      result: { output: "GATE: PASS tests=1 passed=1 failed=0\n" },
    })
    const gate = journalEntries(metricsDir).find((l) => l.type === "gate" && l.result === "PASS")
    assert.equal(gate?.verified, false, `${label}: PASS must be unverified`)
    assert.ok(
      !journalEntries(metricsDir).some((l) => l.type === "evidence"),
      `${label}: no evidence entry`,
    )
    await assert.rejects(
      () =>
        callTool(h, "execute.before", {
          tool: "task",
          sessionID: "p1",
          input: { agent: "reviewer", prompt: "review it" },
        }),
      (e: Error) => e.message === GATE_UNVERIFIED_SEARCHED_NONE_MESSAGE,
    )
    dispose()
  }
})

/** evidence is attributed to the parent via a lazy re-key once a child's
 *  session.created edge resolves: a child's exit-0 `npm test` verifies the
 *  parent's PASS. */
test("enforce mode: attributes a child's bash evidence to the parent via lazy re-key", async () => {
  const { h, dispose, metricsDir } = await boot()
  h.pushEvent({ type: "session.created", data: { sessionID: "c1", parentID: "p1" } })
  // Warmup signal confirms the created event was processed (edge set).
  h.pushEvent({ type: "session.error", data: { sessionID: "c1", error: "warmup" } })
  await waitUntil(() =>
    journalEntries(metricsDir).some((l) => l.type === "error" && l.error === "warmup"),
  )
  // The child runs the test command; the parent later emits the PASS.
  await callTool(h, "execute.after", {
    tool: "bash",
    sessionID: "c1",
    input: { command: "npm test" },
    result: { metadata: { exit: 0 } },
  })
  await callTool(h, "execute.after", {
    tool: "task",
    sessionID: "p1",
    input: { agent: "test-runner" },
    result: { output: "GATE: PASS tests=1 passed=1 failed=0\n" },
  })
  const gate = journalEntries(metricsDir).find((l) => l.type === "gate" && l.result === "PASS")
  assert.equal(gate?.verified, true)
  await callTool(h, "execute.before", {
    tool: "task",
    sessionID: "p1",
    input: { agent: "reviewer", prompt: "review it" },
  })
  dispose()
})

/** the repo's canonical verification chain counts as evidence: a child's
 *  exit-0 `npm run ci` in the task window verifies the test-runner's enforce
 *  PASS (journaled `verified:true` plus an evidence entry), and the reviewer
 *  dispatch is no longer blocked. */
test("enforce mode: a child's exit-0 npm run ci verifies the PASS and unblocks the reviewer", async () => {
  const { h, dispose, metricsDir } = await boot()
  h.pushEvent({ type: "session.created", data: { sessionID: "c1", parentID: "p1" } })
  // Warmup signal confirms the created event was processed (edge set).
  h.pushEvent({ type: "session.error", data: { sessionID: "c1", error: "warmup" } })
  await waitUntil(() =>
    journalEntries(metricsDir).some((l) => l.type === "error" && l.error === "warmup"),
  )
  // The child runs the combined CI chain; the parent later emits the PASS.
  await callTool(h, "execute.after", {
    tool: "bash",
    sessionID: "c1",
    input: { command: "npm run ci" },
    result: { metadata: { exit: 0 } },
  })
  await callTool(h, "execute.after", {
    tool: "task",
    sessionID: "p1",
    input: { agent: "test-runner" },
    result: { output: "GATE: PASS tests=1 passed=1 failed=0\n" },
  })
  const gate = journalEntries(metricsDir).find((l) => l.type === "gate" && l.result === "PASS")
  assert.equal(gate?.verified, true)
  assert.ok(journalEntries(metricsDir).some((l) => l.type === "evidence"))
  await callTool(h, "execute.before", {
    tool: "task",
    sessionID: "p1",
    input: { agent: "reviewer", prompt: "review it" },
  })
  dispose()
})

/** a new user prompt clears the in-memory evidence correlation, so a
 *  later PASS is again unverified. */
test("enforce mode: a new prompt clears evidence so a later PASS is unverified", async () => {
  const { h, dispose, metricsDir } = await boot()
  await callTool(h, "execute.after", {
    tool: "bash",
    sessionID: "p1",
    input: { command: "npm test" },
    result: { metadata: { exit: 0 } },
  })
  // New user prompt: evidence + gate state are dropped.
  await callSession(h, "prompt", { sessionID: "p1" })
  await callTool(h, "execute.after", {
    tool: "task",
    sessionID: "p1",
    input: { agent: "test-runner" },
    result: { output: "GATE: PASS tests=1 passed=1 failed=0\n" },
  })
  const gate = journalEntries(metricsDir).find((l) => l.type === "gate" && l.result === "PASS")
  assert.equal(gate?.verified, false)
  dispose()
})

/** flag mode keeps today's flip-on-PASS semantics and stamps verified:false
 *  + mode:"flag" on an unverified PASS; the reviewer is still allowed. */
test("flag mode: an unverified PASS flips green and stamps verified:false/mode flag", async () => {
  const { h, dispose, metricsDir } = await boot({ gateEvidence: "flag" })
  await callTool(h, "execute.after", {
    tool: "task",
    sessionID: "p1",
    input: { agent: "test-runner" },
    result: { output: "GATE: PASS tests=1 passed=1 failed=0\n" },
  })
  const gate = journalEntries(metricsDir).find((l) => l.type === "gate" && l.result === "PASS")
  assert.ok(gate)
  assert.equal(gate.verified, false)
  assert.equal(gate.mode, "flag")
  // flag keeps flip-on-PASS semantics: the reviewer is allowed.
  await callTool(h, "execute.before", {
    tool: "task",
    sessionID: "p1",
    input: { agent: "reviewer", prompt: "review it" },
  })
  dispose()
})

/** off mode: gate events are byte-identical to legacy (no verified/mode
 *  fields) and no type:"evidence" entries are ever journaled. */
test("off mode: gate entries carry no verified/mode and no evidence entries are journaled", async () => {
  const { h, dispose, metricsDir } = await boot({ gateEvidence: "off" })
  await callTool(h, "execute.after", {
    tool: "bash",
    sessionID: "p1",
    input: { command: "npm test" },
    result: { metadata: { exit: 0 } },
  })
  await callTool(h, "execute.after", {
    tool: "task",
    sessionID: "p1",
    input: { agent: "test-runner" },
    result: { output: "GATE: PASS tests=1 passed=1 failed=0\n" },
  })
  const gate = journalEntries(metricsDir).find((l) => l.type === "gate" && l.result === "PASS")
  assert.ok(gate)
  assert.equal(gate.verified, undefined)
  assert.equal(gate.mode, undefined)
  assert.ok(
    !journalEntries(metricsDir).some((l) => l.type === "evidence"),
    "off modes never journal evidence",
  )
  // off keeps today's flip-on-PASS semantics.
  await callTool(h, "execute.before", {
    tool: "task",
    sessionID: "p1",
    input: { agent: "reviewer", prompt: "review it" },
  })
  dispose()
})

// ---------------------------------------------------------------------------
// Replay follows the flipping-entry rule
// ---------------------------------------------------------------------------

/** Writes a journal file whose replayed gate entries restore state on boot. */
function writeJournal(metricsDir: string, entries: Record<string, unknown>[]): void {
  fs.writeFileSync(
    path.join(metricsDir, "turnstile.jsonl"),
    entries.map((e) => JSON.stringify({ ts: "t", ...e })).join("\n") + "\n",
  )
}

/** replaying an enforce-mode verified:true PASS restores the gate green. */
test("replay restores a verified:true PASS", async () => {
  const metricsDir = tmpDir()
  writeJournal(metricsDir, [
    { type: "gate", sessionID: "p1", raw: "c1", result: "PASS", verified: true, mode: "enforce" },
  ])
  const h = makeFakeHost()
  const dispose = (await turnstile(h.host, {
    env: isolatedEnv(metricsDir),
    config: { metricsDir },
  })(h.host)) as () => void
  await callTool(h, "execute.before", {
    tool: "task",
    sessionID: "p1",
    input: { agent: "reviewer", prompt: "review it" },
  })
  dispose()
})

/** replaying an enforce-mode verified:false PASS (mode stated) does NOT
 *  restore the gate. */
test("replay skips an enforce-mode verified:false PASS", async () => {
  const metricsDir = tmpDir()
  writeJournal(metricsDir, [
    { type: "gate", sessionID: "p1", raw: "c1", result: "PASS", verified: false, mode: "enforce" },
  ])
  const h = makeFakeHost()
  const dispose = (await turnstile(h.host, {
    env: isolatedEnv(metricsDir),
    config: { metricsDir },
  })(h.host)) as () => void
  await assert.rejects(
    () =>
      callTool(h, "execute.before", {
        tool: "task",
        sessionID: "p1",
        input: { agent: "reviewer", prompt: "review it" },
      }),
    (e: Error) => e.message === NO_GATE_MESSAGE,
  )
  dispose()
})

/** a verified:false PASS with no mode field is still skipped (enforce
 *  non-flipping semantics even when the mode field is absent). */
test("replay skips a verified:false PASS with no mode field", async () => {
  const metricsDir = tmpDir()
  writeJournal(metricsDir, [
    { type: "gate", sessionID: "p1", raw: "c1", result: "PASS", verified: false },
  ])
  const h = makeFakeHost()
  const dispose = (await turnstile(h.host, {
    env: isolatedEnv(metricsDir),
    config: { metricsDir },
  })(h.host)) as () => void
  await assert.rejects(
    () =>
      callTool(h, "execute.before", {
        tool: "task",
        sessionID: "p1",
        input: { agent: "reviewer", prompt: "review it" },
      }),
    (e: Error) => e.message === NO_GATE_MESSAGE,
  )
  dispose()
})

/** replaying a flag-mode verified:false PASS restores the gate green,
 *  matching its runtime flip. */
test("replay restores a flag-mode verified:false PASS green", async () => {
  const metricsDir = tmpDir()
  writeJournal(metricsDir, [
    { type: "gate", sessionID: "p1", raw: "c1", result: "PASS", verified: false, mode: "flag" },
  ])
  const h = makeFakeHost()
  const dispose = (await turnstile(h.host, {
    env: isolatedEnv(metricsDir),
    config: { metricsDir },
  })(h.host)) as () => void
  await callTool(h, "execute.before", {
    tool: "task",
    sessionID: "p1",
    input: { agent: "reviewer", prompt: "review it" },
  })
  dispose()
})

/** a field-less legacy PASS restores (fail-open). */
test("replay restores a field-less legacy PASS (fail-open)", async () => {
  const metricsDir = tmpDir()
  writeJournal(metricsDir, [{ type: "gate", sessionID: "p1", raw: "c1", result: "PASS" }])
  const h = makeFakeHost()
  const dispose = (await turnstile(h.host, {
    env: isolatedEnv(metricsDir),
    config: { metricsDir },
  })(h.host)) as () => void
  await callTool(h, "execute.before", {
    tool: "task",
    sessionID: "p1",
    input: { agent: "reviewer", prompt: "review it" },
  })
  dispose()
})

/** trailing flipping-entry rule: a verified:false enforce PASS after a
 *  verified:true one keeps the gate green (skipped at lastGateResult.set). */
test("replay keeps the gate green when a verified:true PASS trails past an unverified enforce PASS", async () => {
  const metricsDir = tmpDir()
  writeJournal(metricsDir, [
    { type: "gate", sessionID: "p1", raw: "c1", result: "PASS", verified: true, mode: "enforce" },
    { type: "gate", sessionID: "p1", raw: "c2", result: "PASS", verified: false, mode: "enforce" },
  ])
  const h = makeFakeHost()
  const dispose = (await turnstile(h.host, {
    env: isolatedEnv(metricsDir),
    config: { metricsDir },
  })(h.host)) as () => void
  await callTool(h, "execute.before", {
    tool: "task",
    sessionID: "p1",
    input: { agent: "reviewer", prompt: "review it" },
  })
  dispose()
})

/** replay never restores unverifiedPass: a skipped enforce verified:false
 *  entry leaves the legacy no-gate-pass message (not the gate-unverified one). */
test("replay does not restore unverifiedPass", async () => {
  const metricsDir = tmpDir()
  writeJournal(metricsDir, [
    { type: "gate", sessionID: "p1", raw: "c1", result: "PASS", verified: false, mode: "enforce" },
  ])
  const h = makeFakeHost()
  const dispose = (await turnstile(h.host, {
    env: isolatedEnv(metricsDir),
    config: { metricsDir },
  })(h.host)) as () => void
  await assert.rejects(
    () =>
      callTool(h, "execute.before", {
        tool: "task",
        sessionID: "p1",
        input: { agent: "reviewer", prompt: "review it" },
      }),
    (e: Error) => e.message === NO_GATE_MESSAGE,
  )
  dispose()
})

/** The VERDICT marker reused for recordChildVerdict unit tests. */
const VERDICT_APPROVE = "VERDICT: APPROVE crit=0 high=0 med=0 low=0"
const VERDICT_BLOCK = "VERDICT: BLOCK crit=1 high=0 med=0 low=0"

/** recordChildVerdict is a pure store-diff ledger: it flags first-record and
 *  marker/source changes true (the setup layer journals a streamed verdict iff
 *  so) and identical re-records false (a per-(child, marker, source) hit). */
test("recordChildVerdict flags first-record and marker/source change true, identical re-record false", () => {
  const ledger = createLedger(path.join(tmpDir(), "turnstile.jsonl"))
  // First record: empty → (marker, source) changes, so true.
  assert.equal(ledger.recordChildVerdict("c1", VERDICT_APPROVE, "child-text"), true)
  const v = ledger.childVerdict("c1")
  assert.equal(v.marker, VERDICT_APPROVE)
  assert.equal(v.source, "child-text")
  // The stored verdict also carries a non-zero recordedAt stamp.
  assert.equal(typeof v.recordedAt, "number")
  assert.ok(v.recordedAt > 0)
  // Identical re-record: no change, so false (a dedup hit).
  assert.equal(ledger.recordChildVerdict("c1", VERDICT_APPROVE, "child-text"), false)
  // Marker flip changes: true; the stored marker updates.
  assert.equal(ledger.recordChildVerdict("c1", VERDICT_BLOCK, "child-text"), true)
  assert.equal(ledger.childVerdict("c1").marker, VERDICT_BLOCK)
  // Source flip with the same marker also changes: true; the source updates.
  assert.equal(ledger.recordChildVerdict("c1", VERDICT_BLOCK, "task-result"), true)
  assert.equal(ledger.childVerdict("c1").source, "task-result")
  // Identical again: false.
  assert.equal(ledger.recordChildVerdict("c1", VERDICT_BLOCK, "task-result"), false)
})

/** resetState drops a reset parents registered childrens
 *  verdict evidence so a marker-less re-fire cannot re-attribute a stale
 *  streamed APPROVE, but leaves a concurrent task on another parent's child
 *  evidence intact (scoped clear, not a global wipe). */
test("resetState clears childVerdicts scoped to the reset parent, preserving other parents' children", () => {
  const ledger = createLedger(path.join(tmpDir(), "turnstile.jsonl"))
  // Two concurrent tasks: c1→p1 and c2→p2, each with a streamed verdict.
  ledger.setParent("c1", "p1")
  ledger.recordChildVerdict("c1", VERDICT_APPROVE, "child-text")
  ledger.setParent("c2", "p2")
  ledger.recordChildVerdict("c2", VERDICT_APPROVE, "child-text")
  // Reset p1: c1's evidence is dropped, c2's (a different parent) survives.
  ledger.resetState("p1")
  assert.deepEqual(ledger.childVerdict("c1"), { marker: "", source: "", recordedAt: 0 })
  assert.equal(ledger.childVerdict("c2").marker, VERDICT_APPROVE)
  // p2's gate state is untouched by the p1 reset.
  assert.equal(ledger.state("p2").hasPlanVerdict, false)
})

/** The metering-counter fields of a gate state bucket: the eight numbers
 *  `clearMeteringCounters` zeroes (and the only fields that count toward its
 *  release return value). */
type MeteringCounterKey =
  | "reviewRounds"
  | "reviewWaiverRounds"
  | "plannerRounds"
  | "planReviewerRounds"
  | "testRunnerRounds"
  | "totalDispatches"
  | "landingBlocks"
  | "reads"

/** A freshly-built bucket with every metering counter at its fresh value, for
 *  asserting a full clear. */
function freshCounters(s: GateState): Record<MeteringCounterKey, number> {
  return {
    reviewRounds: s.reviewRounds,
    reviewWaiverRounds: s.reviewWaiverRounds,
    plannerRounds: s.plannerRounds,
    planReviewerRounds: s.planReviewerRounds,
    testRunnerRounds: s.testRunnerRounds,
    totalDispatches: s.totalDispatches,
    landingBlocks: s.landingBlocks,
    reads: s.reads,
  }
}

/** clearMeteringCounters zeroes exactly the eight metering counters and
 *  returns true iff one was non-fresh. Table-driven: each single non-zero
 *  position yields a release and a fully-zeroed counter set, while an
 *  all-fresh bucket yields no release. The read-warning flag and the pending
 *  unverified-claim are reset (fail-open) but never count toward the return,
 *  so a bucket holding only those is a no-op release. */
test("clearMeteringCounters returns true iff a metering counter was non-fresh", () => {
  const counterKeys: Array<MeteringCounterKey> = [
    "reviewRounds",
    "reviewWaiverRounds",
    "plannerRounds",
    "planReviewerRounds",
    "testRunnerRounds",
    "totalDispatches",
    "landingBlocks",
    "reads",
  ]
  for (const key of counterKeys) {
    const s = newState()
    s[key] = 1
    assert.equal(clearMeteringCounters(s), true, `${key}: a non-zero counter is a release`)
    for (const k of counterKeys) assert.equal(s[k], 0, `${key}: ${k} zeroes`)
    assert.equal(s.readWarned, false, `${key}: readWarned clears`)
    assert.equal(s.unverifiedPass, "", `${key}: unverifiedPass clears`)
  }
  const fresh = newState()
  assert.equal(clearMeteringCounters(fresh), false, "an all-fresh bucket is not a release")
})

/** A bucket whose only non-fresh fields are the read-warning flag and the
 *  pending unverified-claim is still a no-op release for the return value
 *  (those are reset, but they are not metering counters). */
test("clearMeteringCounters ignores the read flag and unverified claim in its return", () => {
  const s = newState()
  s.readWarned = true
  s.unverifiedPass = "GATE: PASS tests=1 passed=1 failed=0"
  assert.equal(clearMeteringCounters(s), false, "flags alone are not a release")
  assert.equal(s.readWarned, false, "readWarned still clears")
  assert.equal(s.unverifiedPass, "", "unverifiedPass still clears")
  assert.deepEqual(freshCounters(s), freshCounters(newState()), "counters untouched")
})

/** resetState returns the number of registered child buckets whose metering
 *  counters it clears: one for a single non-fresh child, none for a child with
 *  no minted bucket, none for an all-fresh child, and the per-child sum when
 *  several are non-fresh. */
test("resetState returns the number of child buckets it frees", () => {
  const ledger = createLedger(path.join(tmpDir(), "turnstile.jsonl"))
  // One non-fresh child: freed 1, counter cleared.
  ledger.setParent("c1", "p1")
  const c1 = ledger.state("c1")
  c1.plannerRounds = 2
  assert.equal(ledger.resetState("p1"), 1, "one non-fresh child is freed")
  assert.equal(c1.plannerRounds, 0, "the child's counter is cleared")
  // A registered child with no minted bucket is not freed.
  ledger.setParent("c2", "p2")
  assert.equal(ledger.resetState("p2"), 0, "a child with no bucket is not freed")
  // A minted but all-fresh child is not freed.
  ledger.setParent("c3", "p3")
  ledger.state("c3")
  assert.equal(ledger.resetState("p3"), 0, "an all-fresh child is not freed")
  // Two non-fresh children: the freed count sums per child.
  ledger.setParent("c4", "p4")
  ledger.setParent("c5", "p4")
  ledger.state("c4").plannerRounds = 1
  ledger.state("c5").totalDispatches = 3
  assert.equal(ledger.resetState("p4"), 2, "both non-fresh children are freed")
})

/** The child release preserves earned credit (the gate/plan/review flags and
 *  the ensemble dispatch count) while clearing exactly the metering counters,
 *  the read flag, and the pending unverified-claim on each released child. */
test("child release preserves earned credit while clearing the metering counters", () => {
  const ledger = createLedger(path.join(tmpDir(), "turnstile.jsonl"))
  ledger.setParent("c1", "p1")
  const c1 = ledger.state("c1")
  c1.hasGatePass = true
  c1.hasPlanVerdict = true
  c1.hasReviewApprove = true
  c1.humanApproval = true
  c1.reviewerDispatches = 2
  c1.reviewRounds = 1
  c1.reviewWaiverRounds = 1
  c1.plannerRounds = 1
  c1.planReviewerRounds = 1
  c1.testRunnerRounds = 1
  c1.totalDispatches = 1
  c1.landingBlocks = 1
  c1.reads = 1
  c1.readWarned = true
  c1.unverifiedPass = "GATE: PASS tests=1 passed=1 failed=0"
  ledger.resetState("p1")
  assert.equal(c1.hasGatePass, true, "hasGatePass survives")
  assert.equal(c1.hasPlanVerdict, true, "hasPlanVerdict survives")
  assert.equal(c1.hasReviewApprove, true, "hasReviewApprove survives")
  assert.equal(c1.humanApproval, true, "humanApproval survives")
  assert.equal(c1.reviewerDispatches, 2, "reviewerDispatches survives")
  assert.equal(c1.reviewRounds, 0, "reviewRounds clears")
  assert.equal(c1.reviewWaiverRounds, 0, "reviewWaiverRounds clears")
  assert.equal(c1.plannerRounds, 0, "plannerRounds clears")
  assert.equal(c1.planReviewerRounds, 0, "planReviewerRounds clears")
  assert.equal(c1.testRunnerRounds, 0, "testRunnerRounds clears")
  assert.equal(c1.totalDispatches, 0, "totalDispatches clears")
  assert.equal(c1.landingBlocks, 0, "landingBlocks clears")
  assert.equal(c1.reads, 0, "reads clears")
  assert.equal(c1.readWarned, false, "readWarned clears")
  assert.equal(c1.unverifiedPass, "", "unverifiedPass clears")
})

/** The child release is scoped to the reset parent: a concurrent task on
 *  another parent keeps its own children's counters and verdict evidence
 *  intact (a scoped clear, not a global wipe). */
test("child release is scoped to the reset parent, leaving other parents' children intact", () => {
  const ledger = createLedger(path.join(tmpDir(), "turnstile.jsonl"))
  ledger.setParent("c1", "p1")
  ledger.setParent("c2", "p2")
  ledger.state("c1").plannerRounds = 1
  ledger.state("c2").plannerRounds = 1
  ledger.recordChildVerdict("c2", VERDICT_APPROVE, "child-text")
  ledger.resetState("p1")
  assert.equal(ledger.state("c1").plannerRounds, 0, "p1's child counter clears")
  assert.equal(ledger.childVerdict("c1").marker, "", "p1's child verdict drops")
  assert.equal(ledger.state("c2").plannerRounds, 1, "p2's child counter is untouched")
  assert.equal(ledger.childVerdict("c2").marker, VERDICT_APPROVE, "p2's child verdict survives")
})

/** A child-reset journal entry is replay-inert: booting a ledger over a
 *  journal whose only line is a child-reset restores no flag, no plan
 *  verdict, and no replay grace on any bucket. */
test("replay ignores child-reset entries", () => {
  const metricsDir = tmpDir()
  fs.writeFileSync(
    path.join(metricsDir, "turnstile.jsonl"),
    `${JSON.stringify({ ts: "t", type: "child-reset", sessionID: "p1", children: 1 })}\n`,
  )
  const ledger = createLedger(path.join(metricsDir, "turnstile.jsonl"))
  const s = ledger.state("p1")
  assert.equal(s.hasGatePass, false, "child-reset restores no gate")
  assert.equal(s.hasPlanVerdict, false, "child-reset restores no plan verdict")
  assert.equal(s.replayGrace, false, "child-reset grants no replay grace")
})
