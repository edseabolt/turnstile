/**
 * @fileoverview Prompt-channel admission across BOTH host transports: the
 * session prompt hook and the correlated `session.inbox.enqueued` stream.
 *
 * Capture happens in the single `admitPrompt()` body, entered through whichever
 * transport delivers first and deduped on the shared host message id, so one
 * prompt is admitted exactly once. These tests pin both adopted payload shapes
 * (hook `{sessionID, messageID, prompt:{text}}` and inbox `{sessionID,
 * inboxID, item:{type:"user", payload:{text}}}`), the same-id co-fire dedupe,
 * the split "hook never fired" vs. "unresolvable text" telemetry, the inbox
 * provenance/shape guards, and the reset parity (an inbox admission drops a live
 * waiver and clears a latched plan-ask just like a hook prompt).
 */

import { test } from "node:test"
import assert from "node:assert/strict"
import * as fs from "node:fs"
import * as path from "node:path"

import { turnstile } from "../turnstile.ts"
import {
  callPermission,
  callSession,
  callTool,
  isolatedEnv,
  journalEntries,
  makeFakeHost,
  tmpDir,
  waitUntil,
  type FakeHost,
} from "./helpers.ts"

/** The literal approval marker (default `approvalMarker`). */
const APPROVAL = "PLAN APPROVED:"

/** The exact reviewer gate no-gate-pass block message. */
const NO_GATE_MESSAGE =
  "BLOCKED by turnstile: no reviewer dispatch before the test gate is green. " +
  "Run the test-runner subagent first; dispatch reviewer only after its first line is " +
  "`GATE: PASS tests=<n> passed=<n> failed=<n>`, or obtain an explicit user waiver " +
  "(a user prompt this task must contain the literal marker 'USER WAIVER:' followed by the user's words)."

/** A `session.inbox.enqueued` admission envelope. */
type InboxEnvelope = {
  sessionID: string
  inboxID: string
  item: { type: string; payload: { text: string; delivery?: string } }
}

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

/** Boots in a temp project dir containing a plan file so dispatches are gated. */
async function bootWithPlan(): Promise<{
  h: FakeHost
  dispose: () => void
  metricsDir: string
  project: string
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
    config: { metricsDir },
  })
  const dispose = (await setup(h.host)) as () => void
  return {
    h,
    dispose,
    metricsDir,
    project,
    restore: (): void => {
      dispose()
      process.chdir(prev)
    },
  }
}

/**
 * Pushes a `session.inbox.enqueued` admission and a canary stream event, then
 * waits for the canary verdict — which confirms the async event-consumer has
 * drained the queue up to and including the admission (FIFO).
 * @param h The fake host tables.
 * @param data The inbox admission envelope.
 * @param metricsDir The metrics dir to poll the journal in.
 */
async function pushAdmission(h: FakeHost, data: InboxEnvelope, metricsDir: string): Promise<void> {
  h.pushEvent({ type: "session.inbox.enqueued", data })
  h.pushEvent({
    type: "session.text.ended",
    data: {
      sessionID: `drain:${data.inboxID}`,
      text: "VERDICT: APPROVE crit=0 high=0 med=0 low=0",
    },
  })
  // The canary's verdict is journaled (as `verdict` when the drain session is
  // authoritative, or `suppressed` when it is not); either way its raw carries
  // the drain id once the async consumer has drained the queue up to it.
  await waitUntil(() =>
    journalEntries(metricsDir).some((l) => typeof l.raw === "string" && l.raw.startsWith("drain:")),
  )
}

/** True when a journal carries a plan APPROVE from the prompt channel. */
function promptApproval(metricsDir: string, sessionID: string): boolean {
  return journalEntries(metricsDir).some(
    (l) =>
      l.type === "plan" &&
      l.result === "APPROVE" &&
      l.source === "session-prompt" &&
      l.sessionID === sessionID,
  )
}

/** Drain the async event-consumer to a quiescent point using a canary stream
 *  event: the wait resolves once the canary's verdict is journaled, which
 *  happens only after every earlier queued event has been processed (FIFO). */
let drainSeq = 0
async function drain(h: FakeHost, metricsDir: string): Promise<void> {
  const id = `drn${++drainSeq}`
  h.pushEvent({
    type: "session.text.ended",
    data: { sessionID: id, text: "VERDICT: APPROVE crit=0 high=0 med=0 low=0" },
  })
  await waitUntil(() => journalEntries(metricsDir).some((l) => l.raw === id))
}

/** The one-time "prompt hook never fired" dead-channel error, if journaled. */
function deadChannelError(metricsDir: string): { sessionID?: unknown } | undefined {
  return journalEntries(metricsDir).find(
    (l) => l.type === "error" && /prompt channel:.*never fired/.test(l.error),
  )
}

/** A `PLAN APPROVED:` prompt admits via the inbox stream even though the prompt
 *  hook never fired on this surface: the plan verdict is set, one
 *  `{type:"plan", result:"APPROVE", source:"session-prompt"}` entry is journaled,
 *  and a subsequent executor dispatch is not blocked. */
test("inbox PLAN APPROVED admits when the prompt hook never fired", async () => {
  const { h, metricsDir, restore } = await bootWithPlan()
  try {
    await pushAdmission(
      h,
      {
        sessionID: "p1",
        inboxID: "msg_9",
        item: { type: "user", payload: { text: `${APPROVAL}: ok` } },
      },
      metricsDir,
    )
    assert.ok(
      promptApproval(metricsDir, "p1"),
      "the plan verdict is journaled from the inbox stream",
    )
    await assert.doesNotReject(() =>
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

/** A `USER WAIVER:` prompt admitted via the inbox stream waives BOTH gates: the
 *  executor and reviewer dispatches pass and each gate journals a WAIVED entry
 *  with `channel:"prompt"`. */
test("inbox USER WAIVER waives both gates and journals channel:prompt", async () => {
  const { h, metricsDir, restore } = await bootWithPlan()
  try {
    await pushAdmission(
      h,
      {
        sessionID: "p1",
        inboxID: "msg_10",
        item: { type: "user", payload: { text: "USER WAIVER: proceed" } },
      },
      metricsDir,
    )
    await assert.doesNotReject(() =>
      callTool(h, "execute.before", {
        tool: "task",
        sessionID: "p1",
        input: { agent: "executor", prompt: "do the work" },
      }),
    )
    await assert.doesNotReject(() =>
      callTool(h, "execute.before", {
        tool: "task",
        sessionID: "p1",
        input: { agent: "reviewer", prompt: "review it" },
      }),
    )
    const planWaived = journalEntries(metricsDir).find(
      (l) => l.type === "plan" && l.result === "WAIVED" && l.channel === "prompt",
    )
    const gateWaived = journalEntries(metricsDir).find(
      (l) => l.type === "gate" && l.result === "WAIVED" && l.channel === "prompt",
    )
    assert.ok(planWaived, "the plan gate journals a prompt-channel waiver")
    assert.ok(gateWaived, "the reviewer gate journals a prompt-channel waiver")
  } finally {
    restore()
  }
})

/** The telemetry split: the first inbox admission journals exactly one
 *  "hook never fired" error; a later admission on a different id journals
 *  nothing further. */
test("dead-channel telemetry is one-time per plugin load", async () => {
  const { h, metricsDir, dispose } = await boot()
  try {
    await pushAdmission(
      h,
      {
        sessionID: "p1",
        inboxID: "msg_a",
        item: { type: "user", payload: { text: `${APPROVAL}: ok` } },
      },
      metricsDir,
    )
    await pushAdmission(
      h,
      {
        sessionID: "p1",
        inboxID: "msg_b",
        item: { type: "user", payload: { text: "a plain prompt" } },
      },
      metricsDir,
    )
    const errors = journalEntries(metricsDir).filter((l) =>
      /prompt channel:.*never fired/.test(l.error),
    )
    assert.equal(errors.length, 1, "the dead-channel error is journaled exactly once")
  } finally {
    dispose()
  }
})

/** The normal host sequence (hook-then-inbox on the same id) admits exactly
 *  once: the hook captures and arms the dispatch counter, then the inbox event
 *  on the same id is deduped away (one APPROVE total, no dead-channel error). */
test("hook-then-inbox on the same id captures once and never surfaces dead-channel", async () => {
  const { h, metricsDir, restore } = await bootWithPlan()
  try {
    // Hook fires first with a shared message id: captures and arms the counter.
    await callSession(h, "prompt", {
      sessionID: "p1",
      messageID: "msg_1",
      text: `${APPROVAL}: ok`,
    })
    const approvesBefore = journalEntries(metricsDir).filter(
      (l) => l.type === "plan" && l.result === "APPROVE",
    ).length
    assert.equal(approvesBefore, 1, "the hook admits once")
    // The inbox event on the SAME id is the co-fire: deduped, journals nothing.
    await pushAdmission(
      h,
      {
        sessionID: "p1",
        inboxID: "msg_1",
        item: { type: "user", payload: { text: `${APPROVAL}: ok` } },
      },
      metricsDir,
    )
    const approvesAfter = journalEntries(metricsDir).filter(
      (l) => l.type === "plan" && l.result === "APPROVE",
    ).length
    assert.equal(approvesAfter, approvesBefore, "the same-id co-fire is deduped to one capture")
    assert.equal(
      deadChannelError(metricsDir),
      undefined,
      "the counter is non-zero, so no dead-channel error",
    )
  } finally {
    restore()
  }
})

/** Reverse order on a dual-surface sim: the inbox captures first and the later
 *  hook on the same id is deduped away (single capture). */
test("inbox-then-hook on the same id captures once", async () => {
  const { h, metricsDir, restore } = await bootWithPlan()
  try {
    await pushAdmission(
      h,
      {
        sessionID: "p1",
        inboxID: "msg_2",
        item: { type: "user", payload: { text: `${APPROVAL}: ok` } },
      },
      metricsDir,
    )
    const approvesAfterInbox = journalEntries(metricsDir).filter(
      (l) => l.type === "plan" && l.result === "APPROVE",
    ).length
    assert.equal(approvesAfterInbox, 1, "the inbox admits once")
    await callSession(h, "prompt", { sessionID: "p1", messageID: "msg_2", text: `${APPROVAL}: ok` })
    const approvesAfterHook = journalEntries(metricsDir).filter(
      (l) => l.type === "plan" && l.result === "APPROVE",
    ).length
    assert.equal(approvesAfterHook, approvesAfterInbox, "the same-id reverse capture is deduped")
  } finally {
    restore()
  }
})

/** A marker inside an agent-composed admission (synthetic / compaction) never
 *  sets waiver or approval state: provenance stays keyed to user text. */
test("non-user admissions carry the marker inert", async () => {
  for (const type of ["synthetic", "compaction"]) {
    const { h, metricsDir, dispose } = await boot()
    try {
      await pushAdmission(
        h,
        {
          sessionID: "p1",
          inboxID: `msg-${type}`,
          item: { type, payload: { text: `${APPROVAL}: should not count` } },
        },
        metricsDir,
      )
      await new Promise((resolve) => setTimeout(resolve, 20))
      assert.equal(promptApproval(metricsDir, "p1"), false, `a ${type} admission never approves`)
      const waived = journalEntries(metricsDir).some(
        (l) => l.type === "gate" && l.result === "WAIVED",
      )
      assert.equal(waived, false, `a ${type} admission never waives`)
    } finally {
      dispose()
    }
  }
})

/** The inbox admission is inert unless every guard condition holds: a missing
 *  session id, a missing inbox id, a non-string text, an empty text, a missing
 *  `item`, and an `item` with no `payload` each skip capture. */
test("inbox admission is inert unless every guard holds", async () => {
  const cases: Array<{
    label: string
    data: {
      sessionID?: unknown
      inboxID?: unknown
      item?: { type?: unknown; payload?: { text?: unknown } }
    }
  }> = [
    {
      label: "missing sessionID",
      data: { inboxID: "msg_1", item: { type: "user", payload: { text: `${APPROVAL}: ok` } } },
    },
    {
      label: "missing inboxID",
      data: { sessionID: "p1", item: { type: "user", payload: { text: `${APPROVAL}: ok` } } },
    },
    {
      label: "non-string payload.text",
      data: {
        sessionID: "p1",
        inboxID: "msg_3",
        item: { type: "user", payload: { text: 123 } },
      },
    },
    {
      label: "empty text",
      data: { sessionID: "p1", inboxID: "msg_4", item: { type: "user", payload: { text: "" } } },
    },
    { label: "item entirely missing", data: { sessionID: "p1", inboxID: "msg_5" } },
    {
      label: "item with payload missing",
      data: { sessionID: "p1", inboxID: "msg_6", item: { type: "user" } },
    },
  ]
  for (const { label, data } of cases) {
    const { h, metricsDir, dispose } = await boot()
    try {
      h.pushEvent({ type: "session.inbox.enqueued", data })
      h.pushEvent({
        type: "session.text.ended",
        data: {
          sessionID: `drain:${(data.inboxID ?? "none") as string}`,
          text: "VERDICT: APPROVE crit=0 high=0 med=0 low=0",
        },
      })
      await waitUntil(() =>
        journalEntries(metricsDir).some(
          (l) => typeof l.raw === "string" && l.raw.startsWith("drain:"),
        ),
      )
      assert.equal(promptApproval(metricsDir, "p1"), false, `${label} never approves`)
    } finally {
      dispose()
    }
  }
})

/** An inbox admission resets task state exactly like a hook prompt: it clears a
 *  latched plan ask (a post-reset empty ask is inert) and drops a live user
 *  waiver (the reviewer gate re-blocks). */
test("inbox admission resets a latched plan ask and a live user waiver", async () => {
  const { h, metricsDir, restore } = await bootWithPlan()
  try {
    // (latch) A red plan gate escalates and latches the plan ask for p1.
    await callPermission(h, "evaluate", { sessionID: "p1", action: "task" })
    // An inbox admission resets task scope — including the latch.
    await pushAdmission(
      h,
      {
        sessionID: "p1",
        inboxID: "msg_reset_latch",
        item: { type: "user", payload: { text: "a fresh task" } },
      },
      metricsDir,
    )
    // The post-reset empty ask is no longer recorded (latch cleared): its reply
    // is inert, so no single-dispatch grant journals.
    h.pushEvent({ type: "permission.asked", properties: { sessionID: "p1", id: "req-post" } })
    h.pushEvent({
      type: "permission.replied",
      properties: { sessionID: "p1", requestID: "req-post", reply: "once" },
    })
    await drain(h, metricsDir)
    assert.ok(
      !journalEntries(metricsDir).some((l) => l.type === "permission" && l.decision === "once"),
      "an inbox admission clears a latched plan ask (a post-reset ask is inert)",
    )

    // (waiver) A live user waiver makes the reviewer dispatch pass.
    await callSession(h, "prompt", { sessionID: "p1", text: "USER WAIVER: go" })
    await assert.doesNotReject(() =>
      callTool(h, "execute.before", {
        tool: "task",
        sessionID: "p1",
        input: { agent: "reviewer", prompt: "review it" },
      }),
    )
    // An inbox admission drops the live waiver.
    await pushAdmission(
      h,
      {
        sessionID: "p1",
        inboxID: "msg_reset_waiver",
        item: { type: "user", payload: { text: "a fresh task" } },
      },
      metricsDir,
    )
    // The reviewer gate re-blocks once the waiver is dropped.
    await assert.rejects(
      () =>
        callTool(h, "execute.before", {
          tool: "task",
          sessionID: "p1",
          input: { agent: "reviewer", prompt: "review it again" },
        }),
      (e: Error) => e.message === NO_GATE_MESSAGE,
      "an inbox admission drops a live user waiver",
    )
  } finally {
    restore()
  }
})

/** Capture is admission-time: a queued prompt (delivery:"queue") admits
 *  immediately rather than waiting for drain time. */
test("a queued prompt admits at admission time", async () => {
  const { h, metricsDir, dispose } = await boot()
  try {
    await pushAdmission(
      h,
      {
        sessionID: "p1",
        inboxID: "msg_queue",
        item: { type: "user", payload: { text: `${APPROVAL}: ok`, delivery: "queue" } },
      },
      metricsDir,
    )
    assert.ok(promptApproval(metricsDir, "p1"), "a queued prompt is admitted at enqueue time")
  } finally {
    dispose()
  }
})

/** The nested `prompt:{text}` hook shape captures a user waiver, exactly like
 *  the legacy string shapes. */
test("nested hook shape: prompt.text carries a user waiver", async () => {
  const { h, metricsDir, restore } = await bootWithPlan()
  try {
    await callSession(h, "prompt", {
      sessionID: "p1",
      messageID: "msg_nested",
      prompt: { text: "USER WAIVER: go via nested shape" },
    })
    await assert.doesNotReject(() =>
      callTool(h, "execute.before", {
        tool: "task",
        sessionID: "p1",
        input: { agent: "reviewer", prompt: "review it" },
      }),
    )
    const gateWaived = journalEntries(metricsDir).find(
      (l) => l.type === "gate" && l.result === "WAIVED" && l.channel === "prompt",
    )
    assert.ok(
      gateWaived?.waiver === "USER WAIVER: go via nested shape",
      "the nested shape is captured",
    )
  } finally {
    restore()
  }
})

/** The nested `prompt:{text}` hook shape journals a plan APPROVE of the exact
 *  prompt-channel shape, stamped with the current plans-dir signature (the
 *  chdir-scoped project keeps the stamp independent of the host repo's plans
 *  dir, which may or may not exist). */
test("nested hook shape: prompt.text journals the plan APPROVE shape", async () => {
  const { h, metricsDir, restore } = await bootWithPlan()
  try {
    await callSession(h, "prompt", {
      sessionID: "p1",
      messageID: "msg_nested2",
      prompt: { text: `${APPROVAL}: looks good via nested shape` },
    })
    const plan = journalEntries(metricsDir).find(
      (l) => l.type === "plan" && l.result === "APPROVE" && l.source === "session-prompt",
    )
    assert.deepEqual(
      { ...plan, ts: undefined },
      {
        ts: undefined,
        type: "plan",
        sessionID: "p1",
        result: "APPROVE",
        source: "session-prompt",
        marker: APPROVAL,
        plansSig: "plan.md:38d47cf1b3682cedc0c2220af95b1f31f44163315b773ddc5e1766b34ad761e5",
      },
    )
  } finally {
    restore()
  }
})
