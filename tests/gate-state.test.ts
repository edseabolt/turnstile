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

import { BlockError } from "../src/gates.ts"
import { createLedger, newState } from "../src/state.ts"
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
  "(the dispatch prompt must contain the literal marker 'USER WAIVER:' followed by the user's words)."

/** (issue #33) The gate-unverified block message: a PASS was recorded without
 *  a correlating journaled test-command execution (enforce mode). */
const GATE_UNVERIFIED_MESSAGE =
  "BLOCKED by turnstile: reviewer dispatch without gate evidence: a GATE: PASS " +
  "was recorded without a journaled successful test-command execution for this " +
  "session. Run the test-runner subagent first, or obtain an explicit user waiver " +
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

/** The literal USER WAIVER: marker allows the dispatch and the quote is journaled. */
test("USER WAIVER: in the prompt waives the gate and is journaled", async () => {
  const { h, dispose, metricsDir } = await boot()
  await callTool(h, "execute.before", {
    tool: "task",
    sessionID: "p1",
    input: { agent: "reviewer", prompt: "USER WAIVER: user said ship it" },
  })
  const waived = journalEntries(metricsDir).find((l) => l.type === "gate" && l.result === "WAIVED")
  assert.ok(waived)
  assert.equal(waived.waiver, "USER WAIVER: user said ship it")
  dispose()
})

/** Waivers are per dispatch: the next marker-less prompt is blocked again. */
test("waiver is per dispatch: a later marker-less prompt is blocked again", async () => {
  const { h, dispose } = await boot()
  await callTool(h, "execute.before", {
    tool: "task",
    sessionID: "p1",
    input: { agent: "reviewer", prompt: "USER WAIVER: user said ship it" },
  })
  await assert.rejects(
    () =>
      callTool(h, "execute.before", {
        tool: "task",
        sessionID: "p1",
        input: { agent: "reviewer", prompt: "review it again" },
      }),
    (e: Error) => e.message === NO_GATE_MESSAGE,
  )
  dispose()
})

/** With trace:false the waiver quote is redacted to "<present>" in the journal. */
test("trace:false redacts the waiver quote in the journal", async () => {
  const { h, dispose, metricsDir } = await boot({ trace: false })
  await callTool(h, "execute.before", {
    tool: "task",
    sessionID: "p1",
    input: { agent: "reviewer", prompt: "USER WAIVER: sensitive user words here" },
  })
  const waived = journalEntries(metricsDir).find((l) => l.type === "gate" && l.result === "WAIVED")
  assert.ok(waived)
  assert.equal(waived.waiver, "<present>")
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
      input: { agent: "test-runner" },
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
  h.pushEvent({ type: "session.created", data: { sessionID: "c1", parentID: "p1" } })
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
  h.pushEvent({ type: "session.created", data: { sessionID: "c1", parentID: "p1" } })
  h.pushEvent({ type: "session.created", data: { sessionID: "c2", parentID: "p1" } })
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
  h.pushEvent({ type: "session.created", data: { sessionID: "c1", parentID: "p1" } })
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
 *  (issue #51, MED): the pending counter charges only gate-kind hits, so a
 *  subsequent gate event journals suppressed 0. The sibling test above pins
 *  the gate-kind direction; this one pins that a VERDICT cross-child hit stays
 *  out of the next gate event's suppressed field instead of bleeding into it.
 */
test("a verdict cross-child dedup hit stays out of the next gate event's suppressed", async () => {
  const { h, dispose, metricsDir } = await boot()
  // Two children share parent p1; both stream byte-identical APPROVE.
  h.pushEvent({ type: "session.created", data: { sessionID: "c1", parentID: "p1" } })
  h.pushEvent({ type: "session.created", data: { sessionID: "c2", parentID: "p1" } })
  // c1 first-sight (a verdict event); c2 a cross-child verdict hit (silent,
  // never charged to the pending counter — verdict-kind hits don't feed the
  // gate-event suppressed field).
  const APPROVE = "VERDICT: APPROVE crit=0 high=0 med=0 low=0"
  h.pushEvent({ type: "session.text.ended", data: { sessionID: "c1", text: `${APPROVE}\n` } })
  h.pushEvent({ type: "session.text.ended", data: { sessionID: "c2", text: `${APPROVE}\n` } })
  await waitUntil(() => journalEntries(metricsDir).some((l) => l.type === "verdict"))
  // c1 then emits a genuinely new GATE: PASS: the parent's next marker event.
  h.pushEvent({
    type: "session.text.ended",
    data: { sessionID: "c1", text: "GATE: PASS tests=2 passed=2 failed=0" },
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
    input: { agent: "test-runner" },
    result,
  })
  await callTool(h, "execute.after", {
    tool: "task",
    sessionID: "p1",
    input: { agent: "test-runner" },
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
      "BLOCKED by turnstile: reviewer round limit (2) reached. Escalate the open findings to the user, or start a new task (a new user prompt resets the cap).",
  )
  dispose()
})

/** Waived dispatches do not consume the round cap: after any number of
 *  waivers, the next unwaived dispatch still proceeds (issue #19). */
test("round cap: waived dispatches do not consume the cap; an unwaived dispatch proceeds", async () => {
  // flag keeps today's flip semantics so the unwaived dispatch clears the
  // no-gate-pass check after the green gate.
  const { h, dispose } = await boot({ gateEvidence: "flag" })
  // Green gate so the unwaived dispatch can clear the no-gate-pass check.
  await callTool(h, "execute.after", {
    tool: "task",
    sessionID: "p1",
    input: { agent: "test-runner" },
    result: { output: "GATE: PASS tests=1 passed=1 failed=0\n" },
  })
  // Two waived dispatches must not drain the unwaived budget.
  for (let i = 0; i < 2; i++) {
    await callTool(h, "execute.before", {
      tool: "task",
      sessionID: "p1",
      input: { agent: "reviewer", prompt: "USER WAIVER: user said ship it" },
    })
  }
  // The unwaived dispatch still resolves — HEAD throws the round-limit message.
  await callTool(h, "execute.before", {
    tool: "task",
    sessionID: "p1",
    input: { agent: "reviewer", prompt: "review it" },
  })
  dispose()
})

/** Waivers neither count toward nor reset the cap: after any number of
 *  waivers exactly `maxReviewerRounds` unwaived dispatches succeed and the
 *  next rejects with the golden round-limit message (issue #19). */
test("round cap: waivers neither count nor reset; the Nth unwaived dispatch is blocked", async () => {
  // flag keeps today's flip semantics so the gate goes green after the PASS.
  const { h, dispose } = await boot({ gateEvidence: "flag" })
  await callTool(h, "execute.after", {
    tool: "task",
    sessionID: "p1",
    input: { agent: "test-runner" },
    result: { output: "GATE: PASS tests=1 passed=1 failed=0\n" },
  })
  // A single waiver precedes the unwaived budget: it must neither consume nor
  // reset it.
  await callTool(h, "execute.before", {
    tool: "task",
    sessionID: "p1",
    input: { agent: "reviewer", prompt: "USER WAIVER: user said ship it" },
  })
  // Two unwaived dispatches still succeed (default cap of 2).
  for (let i = 0; i < 2; i++) {
    await callTool(h, "execute.before", {
      tool: "task",
      sessionID: "p1",
      input: { agent: "reviewer", prompt: "review it" },
    })
  }
  // The third unwaived dispatch rejects with the byte-identical golden message.
  await assert.rejects(
    () =>
      callTool(h, "execute.before", {
        tool: "task",
        sessionID: "p1",
        input: { agent: "reviewer", prompt: "again" },
      }),
    (e: Error) =>
      e.message ===
      "BLOCKED by turnstile: reviewer round limit (2) reached. Escalate the open findings to the user, or start a new task (a new user prompt resets the cap).",
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

/** Read counter: one warning at readWarn, a hard block at readBlock. */
test("read horizon: warns at readWarn, blocks at readBlock", async () => {
  const { h, dispose } = await boot({ readWarn: 2, readBlock: 3 })
  const r2 = { output: "two" }
  const r3 = { output: "three" }
  await callTool(h, "execute.after", { tool: "read", sessionID: "p1", result: { output: "one" } })
  await callTool(h, "execute.after", { tool: "read", sessionID: "p1", result: r2 })
  assert.match(String(r2.output), /^\[turnstile\] Warning: 2 whole-file reads/)
  await callTool(h, "execute.after", { tool: "read", sessionID: "p1", result: r3 })
  await assert.rejects(
    () => callTool(h, "execute.before", { tool: "read", sessionID: "p1" }),
    (e: Error) =>
      e.message ===
      "BLOCKED by turnstile: 3 whole-file reads this session. Switch to grep/glob for targeted retrieval, or report being stuck and escalate to the user.",
  )
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
    // Delivered on the child so the approval keys raw=c1 (issue #51).
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
 *  resume prompt preserves the restored flag rather than wiping it (issue #15).
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
 *  accepted once and stamped, so executor dispatches resolve (issue #15's
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
  h.pushEvent({ type: "session.created", data: { sessionID: "c1", parentID: "p1" } })
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
  const h = makeFakeHost({ sessionRecords: new Map([["c1", { parentID: "p1" }]]) })
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
  // Child-session reads draw down the parent's budget.
  for (let i = 0; i < 3; i++) {
    await callTool(h, "execute.after", {
      tool: "read",
      sessionID: "c1",
      result: { output: `body ${i}` },
    })
  }
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
    // gate (not the plan gate) is what blocks the executor (issue #51).
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
    return { parentID: "p1" }
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

/** The trace file rotates with the same bytes/generations bounds as the journal. */
test("trace file rotates with the same bound as the journal", async () => {
  const { h, dispose, metricsDir } = await boot({
    journalMaxBytes: 200,
    journalMaxGenerations: 2,
  })
  for (let i = 0; i < 10; i++) {
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
  assert.equal(entry.hooks, 6)
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

/** A degraded host without event.subscribe registers 5 hooks. */
test("setup journals hooks === 5 when event.subscribe is absent", async () => {
  const metricsDir = tmpDir()
  const h = makeFakeHost()
  // A degraded host never exposes the event stream.
  delete (h.host as { event?: unknown }).event
  const setup = turnstile(h.host, { env: isolatedEnv(metricsDir), config: { metricsDir } })
  const dispose = (await setup(h.host)) as () => void
  const setups = journalEntries(metricsDir).filter((l) => l.type === "setup")
  assert.equal(setups.length, 1)
  assert.equal(setups[0]?.hooks, 5)
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
        "(the dispatch prompt must contain the literal marker 'OVERRIDE:' followed by the user's words).",
  )
  // The customized waiver marker bypasses the gate and is journaled; the
  // dispatch entry still records the customized agent name.
  await callTool(h, "execute.before", {
    tool: "task",
    sessionID: "p1",
    input: { agent: "qa-reviewer", prompt: "OVERRIDE: user said ship it" },
  })
  const dispatched = journalEntries(metricsDir).find(
    (l) => l.type === "dispatch" && l.agent === "qa-reviewer",
  )
  assert.ok(dispatched)
  const waived = journalEntries(metricsDir).find((l) => l.type === "gate" && l.result === "WAIVED")
  assert.ok(waived)
  assert.equal(waived.waiver, "OVERRIDE: user said ship it")
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
          "(the dispatch prompt must contain the literal marker 'OVERRIDE:' followed by the user's words).",
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
  // waiver: a USER WAIVER prompt on a reviewer dispatch fires the gate waiver
  // trace (guardReviewerDispatch handles the waiver before plan approval).
  await callTool(h, "execute.before", {
    tool: "task",
    sessionID: "p1",
    input: { agent: "reviewer", prompt: "USER WAIVER: the user shipped it" },
  })
  // plan-waiver: the same marker on an executor dispatch fires the
  // plan-approval waiver trace (enforcePlanApproval). The chunk-3 ref lets
  // it clear the decomposition gate so the waiver trace is the only outcome.
  await callTool(h, "execute.before", {
    tool: "task",
    sessionID: "p1",
    input: { agent: "executor", prompt: "USER WAIVER: please proceed, chunk-3" },
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
  const h = makeFakeHost({ sessionRecords: new Map([["c1", { parentID: "p1" }]]) })
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
    // Delivered on the child so the approval keys raw=c1 (issue #51).
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
// Issue #33 — evidence correlation (verified verdicts, gate-unverified gating)
// ---------------------------------------------------------------------------

/** (AC-1) enforce mode: an unverified PASS (no correlating evidence) does not
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
    (e: Error) => e.message === GATE_UNVERIFIED_MESSAGE,
  )
  const blocked = journalEntries(metricsDir).find(
    (l) => l.type === "blocked" && l.reason === "gate-unverified",
  )
  assert.ok(blocked)
  dispose()
})

/** (AC-2) enforce mode: a PASS observed while a matching exit-0 bash test
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

/** (AC-3) a PASS rejected for lack of evidence is promoted to green the moment
 *  matching exit-0 evidence arrives: a `promoted` gate entry (verified:true,
 *  no marker field) plus a `type:"evidence"` observation with no command text;
 *  the reviewer unlocks and a re-delivered deduped PASS emits no new promotion. */
test("enforce mode: promotes an earlier unverified PASS on arriving evidence (AC-3)", async () => {
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

/** (AC-7) a GATE: FAIL after an unverified PASS clears the pending unverified
 *  claim: reviewer dispatch is blocked with the legacy NO_GATE_MESSAGE (reason
 *  no-gate-pass), not gate-unverified — proving the FAIL branch cleared
 *  `state.unverifiedPass`. */
test("enforce mode: a GATE: FAIL after an unverified PASS clears the unverified claim (AC-7)", async () => {
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

/** (AC-6) replay: a FAIL entry followed by an enforce-mode unverified PASS
 *  entry leaves the gate red after restart — the unverified PASS is skipped by
 *  the flipping-entry filter, so FAIL is the last deciding result and the
 *  (never-restored) unverified claim is absent → legacy no-gate-pass block. */
test("replay: FAIL wins over a later unverified enforce PASS (AC-6)", async () => {
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

/** (AC-6, runtime mirror) a FAIL followed by a fresh unverified enforce PASS at
 *  runtime leaves the gate red (FAIL un-greened it and an unverified PASS never
 *  flips); the new pending unverified claim is recorded, so the block names the
 *  evidence contract. */
test("runtime: FAIL then a later unverified enforce PASS keeps the gate red (AC-6)", async () => {
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
    (e: Error) => e.message === GATE_UNVERIFIED_MESSAGE,
  )
  dispose()
})

/** (AC-4) exit-code 1 and pattern-mismatching commands never count as
 *  evidence: both leave the enforce gate red. */
test("enforce mode: non-zero exit and non-matching command are not evidence (AC-4)", async () => {
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
      (e: Error) => e.message === GATE_UNVERIFIED_MESSAGE,
    )
    dispose()
  }
})

/** (AC-4) evidence is attributed to the parent via a lazy re-key once a child's
 *  session.created edge resolves: a child's exit-0 `npm test` verifies the
 *  parent's PASS. */
test("enforce mode: attributes a child's bash evidence to the parent via lazy re-key (AC-4)", async () => {
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

/** (AC-4) a new user prompt clears the in-memory evidence correlation, so a
 *  later PASS is again unverified. */
test("enforce mode: a new prompt clears evidence so a later PASS is unverified (AC-4)", async () => {
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

/** (AC-5) flag mode keeps today's flip-on-PASS semantics and stamps verified:false
 *  + mode:"flag" on an unverified PASS; the reviewer is still allowed. */
test("flag mode: an unverified PASS flips green and stamps verified:false/mode flag (AC-5)", async () => {
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

/** (AC-5) off mode: gate events are byte-identical to legacy (no verified/mode
 *  fields) and no type:"evidence" entries are ever journaled. */
test("off mode: gate entries carry no verified/mode and no evidence entries are journaled (AC-5)", async () => {
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
// Issue #33 — replay follows the flipping-entry rule (AC-6)
// ---------------------------------------------------------------------------

/** Writes a journal file whose replayed gate entries restore state on boot. */
function writeJournal(metricsDir: string, entries: Record<string, unknown>[]): void {
  fs.writeFileSync(
    path.join(metricsDir, "turnstile.jsonl"),
    entries.map((e) => JSON.stringify({ ts: "t", ...e })).join("\n") + "\n",
  )
}

/** (AC-6) replaying an enforce-mode verified:true PASS restores the gate green. */
test("replay restores a verified:true PASS (AC-6)", async () => {
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

/** (AC-6) replaying an enforce-mode verified:false PASS (mode stated) does NOT
 *  restore the gate. */
test("replay skips an enforce-mode verified:false PASS (AC-6)", async () => {
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

/** (AC-6) a verified:false PASS with no mode field is still skipped (enforce
 *  non-flipping semantics even when the mode field is absent). */
test("replay skips a verified:false PASS with no mode field (AC-6)", async () => {
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

/** (AC-6) replaying a flag-mode verified:false PASS restores the gate green,
 *  matching its runtime flip. */
test("replay restores a flag-mode verified:false PASS green (AC-6)", async () => {
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

/** (AC-6) a field-less legacy PASS restores (fail-open). */
test("replay restores a field-less legacy PASS (fail-open, AC-6)", async () => {
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

/** (AC-6) trailing flipping-entry rule: a verified:false enforce PASS after a
 *  verified:true one keeps the gate green (skipped at lastGateResult.set). */
test("replay keeps the gate green when a verified:true PASS trails past an unverified enforce PASS (AC-6)", async () => {
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

/** (AC-6) replay never restores unverifiedPass: a skipped enforce verified:false
 *  entry leaves the legacy no-gate-pass message (not the gate-unverified one). */
test("replay does not restore unverifiedPass (AC-6)", async () => {
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
  assert.deepEqual(ledger.childVerdict("c1"), {
    marker: VERDICT_APPROVE,
    source: "child-text",
  })
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

/** resetState (issue #51, MED) drops a reset parent's registered children's
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
  assert.deepEqual(ledger.childVerdict("c1"), { marker: "", source: "" })
  assert.equal(ledger.childVerdict("c2").marker, VERDICT_APPROVE)
  // p2's gate state is untouched by the p1 reset.
  assert.equal(ledger.state("p2").hasPlanVerdict, false)
})
