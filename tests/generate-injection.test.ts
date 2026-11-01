/**
 * @fileoverview Generate-time policy injection tests: the `session.context`
 * primary-turn hook (pre-first-model-call) applies the decoding clamps,
 * journals one-per-boot draft telemetry, and injects the orchestrator policy
 * head plus any pending intent nudge into the draft's `system` array.
 * Cases: exact-once head injection with the `surface:"context"` journal row;
 * nudge consumption into the system array at context time (armed via the
 * prompt-hook admission path); head-failure keeps the nudge pending (the
 * `execute.after` fallback delivers it); the nudge-append failure arm (a
 * frozen system array journals, never throws); the parent-guard matrix
 * (pipeline agent name, registered child edge, unresolvable session id);
 * the unusable-shape error row journaled once per boot with no injection and
 * the fallback nudge still delivered; spike-once telemetry across surfaces;
 * the generate surface staying policy-free; the descriptor caps (agent 64
 * chars, 12 keys); the describe-throw arm (a throwing getter journals
 * `type:"error"`); and the clamps riding the context hook.
 */

import { test } from "node:test"
import assert from "node:assert/strict"

import { turnstile } from "../turnstile.ts"
import {
  callSession,
  callTool,
  expectedPolicy,
  isolatedEnv,
  journalEntries,
  makeFakeHost,
  tmpDir,
  waitUntil,
  type FakeHost,
} from "./helpers.ts"

/** Boots the plugin over a fake host with a temp metrics dir; `policy` is
 *  the text the boot's resolved config interpolates. */
async function boot(
  config: Record<string, any> = {},
): Promise<{ h: FakeHost; dispose: () => void; metricsDir: string; policy: string }> {
  const metricsDir = tmpDir()
  const h = makeFakeHost()
  const setup = turnstile(h.host, {
    env: isolatedEnv(metricsDir),
    config: { metricsDir, alwaysEnforce: true, ...config },
  })
  const dispose = (await setup(h.host)) as () => void
  return { h, dispose, metricsDir, policy: expectedPolicy({ metricsDir, ...config }) }
}

/** Every journal entry of the given type from a boot's metrics dir. */
function entriesOf(metricsDir: string, type: string): Array<Record<string, any>> {
  return journalEntries(metricsDir).filter((e) => e.type === type)
}

/** A minimal usable parent context draft. */
function draft(overrides: Record<string, any> = {}): Record<string, any> {
  return { sessionID: "p1", system: [{ type: "text", text: "base" }], ...overrides }
}

test("context hook injects the policy head exactly once with the context surface journal row", async () => {
  const { h, dispose, metricsDir, policy } = await boot()
  try {
    const d = draft()
    await callSession(h, "context", d)
    await callSession(h, "context", d)
    // Base block + one policy head; the second fire re-adds nothing.
    assert.equal(d.system.length, 2)
    assert.ok(d.system[1]!.text!.includes("Orchestrator policy"))
    const rows = entriesOf(metricsDir, "policy").filter((e) => e.injected === true)
    assert.equal(rows.length, 1)
    assert.equal(rows[0]!.sessionID, "p1")
    assert.equal(rows[0]!.surface, "context")
    // The head text is the configured orchestrator policy.
    assert.equal(d.system[1]!.text, policy)
  } finally {
    dispose()
  }
})

test("a pending nudge rides the prompt-admission path into the context draft", async () => {
  const { h, dispose, metricsDir } = await boot()
  try {
    // Arm the pending nudge through the prompt hook path (the same admission
    // the host performs on a real turn).
    await callSession(h, "prompt", { sessionID: "p1", text: "fix the login bug" })
    assert.equal(entriesOf(metricsDir, "intent").length, 1)
    const d = draft()
    await callSession(h, "context", d)
    // Block order: base, policy head, nudge (each its own block).
    assert.equal(d.system.length, 3)
    assert.ok(d.system[2]!.text!.startsWith("[turnstile] Advisory reminder"))
  } finally {
    dispose()
  }
})

test("a head append failure keeps the nudge pending for the fallback channel", async () => {
  const { h, dispose, metricsDir } = await boot()
  try {
    // Frozen system array: the head push throws (journal injected:false),
    // the nudge is never consumed, and the fallback read delivery lands it.
    const frozen = draft({
      system: Object.freeze([{ type: "text", text: "base" }]) as unknown as any[],
    })
    await callSession(h, "context", frozen)
    const failed = entriesOf(metricsDir, "policy").filter((e) => e.injected === false)
    assert.equal(failed.length, 1)
    assert.equal(failed[0]!.surface, "context")
    assert.ok(failed[0]!.error)
    // Fallback: the execute.after read delivery still carries the nudge.
    await callSession(h, "prompt", { sessionID: "p1", text: "fix the login bug" })
    const event = { tool: "read", sessionID: "p1", result: { output: "body" } }
    await callTool(h, "execute.after", event)
    assert.ok(String(event.result.output).startsWith("[turnstile] Advisory reminder"))
  } finally {
    dispose()
  }
})

test("a nudge append failure after a landed head journals and never throws", async () => {
  const { h, dispose, metricsDir } = await boot()
  try {
    // A system proxy that lets the first push (the policy head) land and
    // throws on any further push: the head succeeds, the nudge append fails.
    const base: any[] = [{ type: "text", text: "base" }]
    const system = new Proxy(base, {
      set(target, prop, val): boolean {
        if (prop === "length" || prop === "1") {
          ;(target as any)[prop] = val
          return true
        }
        throw new Error("tail is frozen")
      },
    })
    await callSession(h, "prompt", { sessionID: "p1", text: "fix the login bug" })
    const d = draft({ system })
    await callSession(h, "context", d)
    // Head landed; the nudge push threw and journaled.
    const ok = entriesOf(metricsDir, "policy").filter((e) => e.injected === true)
    assert.equal(ok.length, 1)
    const nudgeErrors = entriesOf(metricsDir, "error").filter((e) =>
      String(e.error).includes("intent nudge"),
    )
    assert.equal(nudgeErrors.length, 1)
    assert.equal(nudgeErrors[0]!.sessionID, "p1")
  } finally {
    dispose()
  }
})

test("a pipeline agent name on the draft skips injection with a journaled reason", async () => {
  const { h, dispose, metricsDir } = await boot()
  try {
    const d = draft({ agent: "reviewer" })
    await callSession(h, "context", d)
    assert.equal(d.system.length, 1)
    const skips = entriesOf(metricsDir, "policy").filter((e) => e.skipped === true)
    assert.equal(skips.length, 1)
    assert.equal(skips[0]!.reason, "context-agent")
  } finally {
    dispose()
  }
})

test("a registered child edge skips injection with a journaled reason", async () => {
  const { h, dispose, metricsDir } = await boot()
  try {
    h.pushEvent({ type: "session.created", data: { sessionID: "c1", parentID: "p1" } })
    h.pushEvent({ type: "session.error", data: { sessionID: "c1", error: "warmup" } })
    await waitUntil(() =>
      journalEntries(metricsDir).some((l) => l.type === "error" && l.error === "warmup"),
    )
    const d = draft({ sessionID: "c1" })
    await callSession(h, "context", d)
    assert.equal(d.system.length, 1)
    const skips = entriesOf(metricsDir, "policy").filter((e) => e.skipped === true)
    assert.equal(skips.length, 1)
    assert.equal(skips[0]!.reason, "context-child")
  } finally {
    dispose()
  }
})

test("an unresolvable session id skips injection with a journaled reason", async () => {
  const { h, dispose, metricsDir } = await boot()
  try {
    const d = draft({ sessionID: undefined })
    await callSession(h, "context", d)
    assert.equal(d.system.length, 1)
    const skips = entriesOf(metricsDir, "policy").filter((e) => e.skipped === true)
    assert.equal(skips.length, 1)
    assert.equal(skips[0]!.reason, "context-no-id")
  } finally {
    dispose()
  }
})

test("an unusable draft shape journals one error row per boot and degrades to the fallback", async () => {
  const { h, dispose, metricsDir } = await boot()
  try {
    await callSession(h, "prompt", { sessionID: "p1", text: "fix the login bug" })
    // system missing entirely — shape guard fails.
    await callSession(h, "context", { sessionID: "p1" })
    await callSession(h, "context", { sessionID: "p1" })
    const shapeErrors = entriesOf(metricsDir, "error").filter((e) =>
      String(e.error).includes("unusable draft shape"),
    )
    assert.equal(shapeErrors.length, 1)
    assert.equal(shapeErrors[0]!.shape.surface, "context")
    assert.equal(shapeErrors[0]!.shape.systemKind, "undefined")
    // No policy row, no nudge consumption.
    assert.equal(entriesOf(metricsDir, "policy").length, 0)
    // The fallback channel still delivers the pending nudge.
    const event = { tool: "read", sessionID: "p1", result: { output: "body" } }
    await callTool(h, "execute.after", event)
    assert.ok(String(event.result.output).startsWith("[turnstile] Advisory reminder"))
  } finally {
    dispose()
  }
})

test("non-array and non-object-element system shapes are unusable", async () => {
  const { h, dispose, metricsDir } = await boot()
  try {
    await callSession(h, "context", draft({ system: "not-an-array" }))
    await callSession(h, "context", draft({ system: [null] }))
    await callSession(h, "context", null)
    const shapeErrors = entriesOf(metricsDir, "error").filter((e) =>
      String(e.error).includes("unusable draft shape"),
    )
    assert.equal(shapeErrors.length, 1)
    assert.equal(entriesOf(metricsDir, "policy").length, 0)
  } finally {
    dispose()
  }
})

test("draft telemetry journals once across surfaces and caps its descriptor", async () => {
  const { h, dispose, metricsDir } = await boot()
  try {
    const longAgent = "x".repeat(80)
    const manyKeys: Record<string, any> = {
      sessionID: "p1",
      agent: longAgent,
      system: [],
      messages: [{ role: "user" }, { role: "assistant" }],
    }
    for (let i = 0; i < 13; i++) manyKeys[`k${i}`] = i
    await callSession(h, "generate", manyKeys)
    await callSession(h, "context", draft())
    const rows = entriesOf(metricsDir, "generate-draft")
    assert.equal(rows.length, 1)
    assert.equal(rows[0]!.surface, "generate")
    assert.equal(rows[0]!.agent.length, 64)
    assert.equal(rows[0]!.keys.length, 12)
    assert.equal(rows[0]!.messagesKind, "object")
    assert.equal(rows[0]!.messagesLen, 2)
  } finally {
    dispose()
  }
})

test("a descriptor build that throws journals type:error and never propagates", async () => {
  const { h, dispose, metricsDir } = await boot()
  try {
    // The clamps only touch agent/options, so a draft whose `system` getter
    // throws reaches the telemetry path and fails there.
    const hostile = {
      agent: "reviewer",
      options: { temperature: 1 },
      get system(): any {
        throw new Error("boom")
      },
    }
    await callSession(h, "generate", hostile)
    const errors = entriesOf(metricsDir, "error").filter((e) =>
      String(e.error).includes("generate-draft describe"),
    )
    assert.equal(errors.length, 1)
    assert.equal(entriesOf(metricsDir, "generate-draft").length, 0)
  } finally {
    dispose()
  }
})

test("the generate surface injects no policy and no nudge", async () => {
  const { h, dispose, metricsDir, policy } = await boot()
  try {
    await callSession(h, "prompt", { sessionID: "p1", text: "fix the login bug" })
    const d = draft({ agent: "goal-judge" })
    await callSession(h, "generate", d)
    assert.equal(d.system.length, 1)
    assert.ok(!JSON.stringify(d.system).includes("Orchestrator policy"))
    assert.ok(!JSON.stringify(d.system).includes("Advisory reminder"))
    assert.equal(entriesOf(metricsDir, "policy").length, 0)
    assert.ok(policy.length > 0)
  } finally {
    dispose()
  }
})

test("clamps apply through the context hook on primary turns", async () => {
  const { h, dispose, metricsDir } = await boot()
  try {
    const reviewer = draft({ agent: "reviewer", options: { temperature: 0.9 } })
    await callSession(h, "context", reviewer)
    assert.equal(reviewer.options!.temperature, 0)
    const executor = draft({ agent: "executor", options: { temperature: 1.5 } })
    await callSession(h, "context", executor)
    assert.equal(executor.options!.temperature, 0.2)
    const bare = draft({ agent: "test-runner", options: undefined })
    delete bare.options
    await callSession(h, "context", bare)
    assert.equal(bare.options!.temperature, 0.2)
    // Pipeline agent names are guarded: each fire skips injection observably.
    const skips = entriesOf(metricsDir, "policy").filter((e) => e.skipped === true)
    assert.equal(skips.length, 3)
    assert.ok(skips.every((e) => e.reason === "context-agent"))
  } finally {
    dispose()
  }
})

test("a hostile session id surfaces through the context body catch", async () => {
  const { h, dispose, metricsDir } = await boot()
  try {
    // A throwing sessionID getter: telemetry fails inside observe (journaled),
    // then injectContextPolicy throws at asSessionID — the body catch fails
    // open with a journaled `context hook:` error instead of propagating.
    const hostile = {
      get sessionID(): any {
        throw new Error("boom")
      },
      system: [{ type: "text", text: "base" }],
    }
    await callSession(h, "context", hostile)
    const errors = entriesOf(metricsDir, "error").filter((e) =>
      String(e.error).startsWith("context hook:"),
    )
    assert.equal(errors.length, 1)
    assert.equal(entriesOf(metricsDir, "policy").length, 0)
  } finally {
    dispose()
  }
})

test("a shape-describe throw in the unusable-draft arm journals instead of propagating", async () => {
  const { h, dispose, metricsDir } = await boot()
  try {
    // Non-array system (shape guard false) plus a throwing messages getter
    // (the clamps only touch agent/options, so the draft reaches the guard):
    // the guard arm's descriptor build throws — the nested catch journals
    // and the hook returns without injecting.
    const hostile = {
      system: "not-an-array",
      get messages(): any {
        throw new Error("boom")
      },
    }
    await callSession(h, "context", hostile)
    const errors = entriesOf(metricsDir, "error").filter((e) =>
      String(e.error).includes("context hook shape describe"),
    )
    assert.equal(errors.length, 1)
    // The telemetry observe arm also hit its describe catch (same draft).
    assert.equal(
      entriesOf(metricsDir, "error").filter((e) =>
        String(e.error).includes("generate-draft describe"),
      ).length,
      1,
    )
    assert.equal(entriesOf(metricsDir, "policy").length, 0)
  } finally {
    dispose()
  }
})

test("the context hook is registered alongside the other session hooks", async () => {
  const { h, dispose } = await boot()
  try {
    assert.ok(h.sessionHooks.context, "context hook registered")
    assert.ok(h.sessionHooks.prompt)
    assert.ok(h.sessionHooks.generate)
    assert.ok(h.sessionHooks.compaction)
  } finally {
    dispose()
  }
})
