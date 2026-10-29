/**
 * @fileoverview Intent detection: the stateless classifier matrix in
 * `src/intent.ts`, and the advisory nudge wiring at prompt admission (journal
 * row, one nudge per detected intent, disabled-key no-op, fail-open on a
 * throwing classification, and delivery on both the task and read channels).
 * The advisory nudge changes no gate behavior; these tests run alongside the
 * untouched gate suites.
 */

import { test } from "node:test"
import assert from "node:assert/strict"

import { classifyIntent } from "../src/intent.ts"
import { turnstile } from "../turnstile.ts"
import {
  callSession,
  callTool,
  isolatedEnv,
  journalEntries,
  makeFakeHost,
  tmpDir,
  type FakeHost,
} from "./helpers.ts"

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

/** Every journal entry of the given type from a boot's metrics dir. */
function entriesOf(metricsDir: string, type: string): Array<Record<string, any>> {
  return journalEntries(metricsDir).filter((e) => e.type === type)
}

// ── classifier matrix ────────────────────────────────────────────────────────

test("classifyIntent: imperative work verbs addressed at code classify as work", () => {
  assert.equal(classifyIntent("fix the login bug"), "work")
  assert.equal(classifyIntent("please implement retry logic"), "work")
  assert.equal(classifyIntent("refactor the gate module"), "work")
  assert.equal(classifyIntent("ship the release today"), "work")
  assert.equal(classifyIntent("land the branch"), "work")
})

test("classifyIntent: a gh issue reference classifies as issue", () => {
  assert.equal(classifyIntent("fix #123"), "issue")
  assert.equal(
    classifyIntent("see https://github.com/edseabolt/turnstile/issues/223 then close it"),
    "issue",
  )
  assert.equal(classifyIntent("gh issue 228 needs a fix"), "issue")
})

test("classifyIntent: a plan-file reference classifies as plan-ref", () => {
  assert.equal(classifyIntent("update governance-redesign.md with the outcome"), "plan-ref")
  assert.equal(classifyIntent("start working from my-plan.md"), "plan-ref")
})

test("classifyIntent: plan-dispatch phrasing classifies as dispatch", () => {
  assert.equal(classifyIntent("dispatch the planner for the new task"), "dispatch")
  assert.equal(classifyIntent("kick off the planner"), "dispatch")
  assert.equal(classifyIntent("start the pipeline on this"), "dispatch")
})

test("classifyIntent: questions, explanations, status requests, and chat never classify", () => {
  assert.equal(classifyIntent("can you explain how the gate works?"), null)
  assert.equal(classifyIntent("what is the status?"), null)
  assert.equal(classifyIntent("how does the waiver work"), null)
  assert.equal(classifyIntent("summarize the changes so far"), null)
  assert.equal(classifyIntent("thanks, that helps"), null)
  assert.equal(classifyIntent("who wrote this module"), null)
  // A question framing wins over a work signal in the same prompt.
  assert.equal(classifyIntent("can you fix #123 for me?"), null)
})

test("classifyIntent: an empty or non-string prompt never classifies", () => {
  assert.equal(classifyIntent(""), null)
  assert.equal(classifyIntent(undefined as unknown as string), null)
  assert.equal(classifyIntent(42 as unknown as string), null)
})

// ── admission wiring ─────────────────────────────────────────────────────────

test('an intent prompt journals {type:"intent"} and the nudge rides the first read delivery', async () => {
  const { h, dispose, metricsDir } = await boot()
  try {
    await callSession(h, "prompt", { sessionID: "p1", text: "fix the login bug" })
    const intents = entriesOf(metricsDir, "intent")
    assert.equal(intents.length, 1)
    assert.equal(intents[0]?.sessionID, "p1")
    assert.equal(intents[0]?.kind, "work")
    const event = { tool: "read", sessionID: "p1", result: { output: "body" } }
    await callTool(h, "execute.after", event)
    const out = String(event.result.output)
    assert.ok(out.startsWith("[turnstile] Advisory reminder"), out)
    assert.ok(out.endsWith("body"), out)
    // No marker syntax ever appears in the nudge prose.
    assert.ok(!out.includes("USER WAIVER:"))
    assert.ok(!out.includes("GATE: PASS"))
    assert.ok(!out.includes("PLAN APPROVED:"))
  } finally {
    dispose()
  }
})

test("a second same-kind intent prompt journals but does not re-nudge", async () => {
  const { h, dispose, metricsDir } = await boot()
  try {
    await callSession(h, "prompt", { sessionID: "p1", text: "fix the login bug" })
    const first = { tool: "read", sessionID: "p1", result: { output: "one" } }
    await callTool(h, "execute.after", first)
    assert.ok(String(first.result.output).includes("Advisory reminder"))
    // A second intent prompt of the same signal kind within the same session
    // journals its detection but arms no second nudge.
    await callSession(h, "prompt", { sessionID: "p1", text: "fix another bug" })
    assert.ok(entriesOf(metricsDir, "intent").length >= 2)
    const second = { tool: "read", sessionID: "p1", result: { output: "two" } }
    await callTool(h, "execute.after", second)
    assert.equal(String(second.result.output), "two")
  } finally {
    dispose()
  }
})

test("a chat prompt journals no intent row and nudges nothing", async () => {
  const { h, dispose, metricsDir } = await boot()
  try {
    await callSession(h, "prompt", { sessionID: "p1", text: "can you explain the gate?" })
    assert.equal(entriesOf(metricsDir, "intent").length, 0)
    const event = { tool: "read", sessionID: "p1", result: { output: "body" } }
    await callTool(h, "execute.after", event)
    assert.equal(String(event.result.output), "body")
  } finally {
    dispose()
  }
})

test("intentNudge:false is a full no-op: no intent row and no nudge", async () => {
  const { h, dispose, metricsDir } = await boot({ intentNudge: false })
  try {
    await callSession(h, "prompt", { sessionID: "p1", text: "fix the login bug" })
    assert.equal(entriesOf(metricsDir, "intent").length, 0)
    const event = { tool: "read", sessionID: "p1", result: { output: "body" } }
    await callTool(h, "execute.after", event)
    assert.equal(String(event.result.output), "body")
  } finally {
    dispose()
  }
})

test("a parent with a plan approval gets no intent nudge", async () => {
  const { h, dispose, metricsDir } = await boot()
  try {
    await callSession(h, "prompt", {
      sessionID: "p1",
      text: "PLAN APPROVED: go ahead, fix the login bug",
    })
    // The plan approval is captured earlier in the same admission, so the
    // intent classification sees an active plan and skips the row entirely.
    assert.equal(entriesOf(metricsDir, "intent").length, 0)
    const event = { tool: "read", sessionID: "p1", result: { output: "body" } }
    await callTool(h, "execute.after", event)
    assert.equal(String(event.result.output), "body")
  } finally {
    dispose()
  }
})

test("a plan approval clears the latch so a later task's same-kind intent nudges again", async () => {
  const { h, dispose, metricsDir } = await boot()
  try {
    await callSession(h, "prompt", { sessionID: "p1", text: "fix the login bug" })
    const first = { tool: "read", sessionID: "p1", result: { output: "one" } }
    await callTool(h, "execute.after", first)
    assert.ok(String(first.result.output).includes("Advisory reminder"))
    // The approval lands (clearing the per-kind latch), then a new task's
    // intent of the SAME kind nudges once more.
    await callSession(h, "prompt", { sessionID: "p1", text: "PLAN APPROVED: ok" })
    await callSession(h, "prompt", { sessionID: "p1", text: "fix another bug" })
    assert.equal(entriesOf(metricsDir, "intent").length, 2)
    const second = { tool: "read", sessionID: "p1", result: { output: "two" } }
    await callTool(h, "execute.after", second)
    assert.ok(String(second.result.output).includes("Advisory reminder"))
    // The reviewer-attribution arm clears the latch too: a plan-reviewer
    // child's APPROVE verdict delivery attributes to the parent, and a later
    // intent prompt nudges once more without another approval.
    await h.pushEvent({
      type: "session.created",
      data: { sessionID: "pr1", parentID: "p1", agent: "plan-reviewer" },
    })
    await callTool(h, "execute.after", {
      tool: "task",
      sessionID: "pr1",
      input: { agent: "plan-reviewer" },
      result: { output: "Verdict below.\nVERDICT: APPROVE crit=0 high=0 med=0 low=0\n" },
    })
    const plans = entriesOf(metricsDir, "plan")
    assert.equal(plans[plans.length - 1]?.result, "APPROVE")
    await callSession(h, "prompt", { sessionID: "p1", text: "fix yet another bug" })
    const third = { tool: "read", sessionID: "p1", result: { output: "three" } }
    await callTool(h, "execute.after", third)
    assert.ok(String(third.result.output).includes("Advisory reminder"))
  } finally {
    dispose()
  }
})

// ── delivery channels ────────────────────────────────────────────────────────

test("the nudge rides a string task delivery and composes with the policy head", async () => {
  const { h, dispose } = await boot()
  try {
    await callSession(h, "prompt", { sessionID: "p1", text: "fix the login bug" })
    const event = { tool: "task", sessionID: "p1", result: { output: "stage output" } }
    await callTool(h, "execute.after", event)
    const out = String(event.result.output)
    // The nudge lands inside the delivery text (the once-per-task policy
    // head, injected after it, sits on top).
    assert.ok(out.includes("[turnstile] Advisory reminder"), out)
    assert.ok(out.includes("stage output"), out)
  } finally {
    dispose()
  }
})

test("the nudge rides a structured subagent delivery's content", async () => {
  const { h, dispose } = await boot()
  try {
    await callSession(h, "prompt", { sessionID: "p1", text: "fix the login bug" })
    const event = {
      tool: "subagent",
      sessionID: "p1",
      result: { output: { output: "child text", sessionID: "p1" }, content: "child text" },
    }
    await callTool(h, "execute.after", event)
    assert.ok(String(event.result.content).includes("[turnstile] Advisory reminder"))
  } finally {
    dispose()
  }
})

test("an absent delivery keeps the nudge pending; a later read delivers it", async () => {
  const { h, dispose, metricsDir } = await boot()
  try {
    await callSession(h, "prompt", { sessionID: "p1", text: "fix the login bug" })
    await callTool(h, "execute.after", { tool: "task", sessionID: "p1" })
    assert.equal(entriesOf(metricsDir, "error").length, 0)
    const event = { tool: "read", sessionID: "p1", result: { output: "body" } }
    await callTool(h, "execute.after", event)
    assert.ok(String(event.result.output).includes("Advisory reminder"))
  } finally {
    dispose()
  }
})

test("a read with a non-string output keeps the nudge pending", async () => {
  const { h, dispose } = await boot()
  try {
    await callSession(h, "prompt", { sessionID: "p1", text: "fix the login bug" })
    await callTool(h, "execute.after", { tool: "read", sessionID: "p1", result: { output: 42 } })
    const event = { tool: "read", sessionID: "p1", result: { output: "body" } }
    await callTool(h, "execute.after", event)
    assert.ok(String(event.result.output).includes("Advisory reminder"))
  } finally {
    dispose()
  }
})

test("a child-keyed read delivery is left untouched (the nudge is parent-addressed)", async () => {
  const { h, dispose } = await boot()
  try {
    await callSession(h, "prompt", { sessionID: "p1", text: "fix the login bug" })
    // Seed the child→parent edge so the read resolves as child-keyed.
    await h.pushEvent({ type: "session.created", data: { sessionID: "c1", parentID: "p1" } })
    const event = { tool: "read", sessionID: "c1", result: { output: "child body" } }
    await callTool(h, "execute.after", event)
    assert.equal(String(event.result.output), "child body")
    // The parent's own next read still delivers the pending nudge.
    const parent = { tool: "read", sessionID: "p1", result: { output: "body" } }
    await callTool(h, "execute.after", parent)
    assert.ok(String(parent.result.output).includes("Advisory reminder"))
  } finally {
    dispose()
  }
})

// ── fail-open ────────────────────────────────────────────────────────────────

test("a throwing classification journals an error row, nudges nothing, and never throws", async () => {
  const { h, dispose, metricsDir } = await boot()
  try {
    // A hostile prompt payload whose candidate text keys throw on read.
    const hostile: Record<string, unknown> = { sessionID: "p1" }
    Object.defineProperty(hostile, "text", {
      get() {
        throw new Error("hostile prompt")
      },
      enumerable: true,
    })
    await callSession(h, "prompt", hostile as never)
    const errors = entriesOf(metricsDir, "error")
    assert.ok(errors.some((e) => String(e.error).includes("intent classification")))
    const event = { tool: "read", sessionID: "p1", result: { output: "body" } }
    await callTool(h, "execute.after", event)
    assert.equal(String(event.result.output), "body")
  } finally {
    dispose()
  }
})

test("a throwing nudge mutation journals an error row and the delivery proceeds", async () => {
  const { h, dispose, metricsDir } = await boot()
  try {
    await callSession(h, "prompt", { sessionID: "p1", text: "fix the login bug" })
    // A result whose output reads as a string but rejects assignment
    // (getter-only property, strict mode) — the prepend throws fail-open.
    const result: Record<string, unknown> = {}
    Object.defineProperty(result, "output", {
      get: () => "body",
    })
    await callTool(h, "execute.after", { tool: "read", sessionID: "p1", result })
    const errors = entriesOf(metricsDir, "error")
    assert.ok(errors.some((e) => String(e.error).includes("intent nudge")))
  } finally {
    dispose()
  }
})

test("a throwing nudge mutation on a task delivery journals the same error row", async () => {
  const { h, dispose, metricsDir } = await boot()
  try {
    await callSession(h, "prompt", { sessionID: "p1", text: "fix the login bug" })
    const result: Record<string, unknown> = {}
    Object.defineProperty(result, "output", {
      get: () => "stage output",
    })
    await callTool(h, "execute.after", { tool: "task", sessionID: "p1", result })
    const errors = entriesOf(metricsDir, "error")
    assert.ok(errors.some((e) => String(e.error).includes("intent nudge")))
  } finally {
    dispose()
  }
})
