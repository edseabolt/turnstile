/**
 * @fileoverview Dormant-until-engaged lifecycle: the pure engagement
 * helpers (`shouldEngage`, `engagementEntry`), the admission capture
 * (approval marker / plan-ref / dispatch prompts arm enforcement), the
 * planner-dispatch arm, the four dormant choke points (dispatch, bash,
 * write/edit, read budget), the disengagement paths (task retire, TURNSTILE
 * OFF:, no-credit new prompt), the continuation-carry interaction, journal
 * replay of `engagement` rows, the snapshot line, and the policy-injection
 * gating. The dormant default is exercised throughout; legacy-behavior
 * suites pin `alwaysEnforce: true` in their own boots.
 */

import * as fs from "node:fs"
import * as path from "node:path"
import { test } from "node:test"
import assert from "node:assert/strict"

import { turnstile } from "../turnstile.ts"
import { createHooksCore } from "../src/hooks-core.ts"
import { shouldEngage, engagementEntry } from "../src/engagement.ts"
import { classifyIntent } from "../src/intent.ts"
import { newState, formatGateSnapshot } from "../src/state.ts"
import {
  expectedPolicy,
  isolatedEnv,
  journalEntries,
  makeFakeHost,
  tmpDir,
  callSession,
  callTool,
  type FakeHost,
} from "./helpers.ts"

/** Boots the plugin over a fake host with a temp metrics dir (dormant by
 *  default; pass `alwaysEnforce: true` explicitly for legacy behavior). */
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

/** Boots the plugin in a temp project dir whose plans dir holds one plan
 *  file, so a `PLAN APPROVED: … plan.md` prompt binds an active plan. */
async function bootWithPlan(
  config: Record<string, any> = {},
): Promise<{ h: FakeHost; dispose: () => void; metricsDir: string; restore: () => void }> {
  const project = tmpDir()
  fs.mkdirSync(path.join(project, ".opencode", "plans"), { recursive: true })
  fs.writeFileSync(path.join(project, ".opencode", "plans", "plan.md"), "# P\n")
  const metricsDir = tmpDir()
  const h = makeFakeHost()
  const prev = process.cwd()
  process.chdir(project)
  const setup = turnstile(h.host, {
    env: isolatedEnv(metricsDir),
    config: { metricsDir, ...config },
  })
  const dispose = (await setup(h.host)) as () => void
  return {
    h,
    dispose,
    metricsDir,
    restore: (): void => {
      dispose()
      process.chdir(prev)
    },
  }
}

/** Every journal entry of the given type from a boot's metrics dir. */
function entriesOf(metricsDir: string, type: string): Array<Record<string, any>> {
  return journalEntries(metricsDir).filter((e) => e.type === type)
}

/** The journaled `engagement` rows for a session. */
function engagementRows(metricsDir: string, sessionID = "p1"): Array<Record<string, any>> {
  return entriesOf(metricsDir, "engagement").filter((e) => e.sessionID === sessionID)
}

/** Admits a prompt through the session hook. */
async function admit(h: FakeHost, sessionID: string, text: string): Promise<void> {
  await callSession(h, "prompt", { sessionID, text })
}

// ── pure helpers ─────────────────────────────────────────────────────────────

test("shouldEngage: dispatch and plan-ref engage; issue, work, and null do not", () => {
  assert.equal(shouldEngage(classifyIntent("run the pipeline on this")), true)
  assert.equal(shouldEngage(classifyIntent("start working from my-plan.md")), true)
  assert.equal(shouldEngage(classifyIntent("fix #123")), false)
  assert.equal(shouldEngage(classifyIntent("fix the login bug")), false)
  assert.equal(shouldEngage(null), false)
})

test("engagementEntry: builds the type/engaged/reason row", () => {
  assert.deepEqual(engagementEntry("p1", true, "plan-approved"), {
    type: "engagement",
    sessionID: "p1",
    engaged: true,
    reason: "plan-approved",
  })
  assert.deepEqual(engagementEntry("p1", false, "task-complete"), {
    type: "engagement",
    sessionID: "p1",
    engaged: false,
    reason: "task-complete",
  })
})

// ── dormant default (AC-1) ───────────────────────────────────────────────────

test("dormant: a fresh session's parent write neither blocks nor journals a hands-on row", async () => {
  const { h, dispose, metricsDir } = await boot()
  try {
    await admit(h, "p1", "fix the flaky retry in src/x.ts")
    await callTool(h, "execute.before", {
      tool: "write",
      sessionID: "p1",
      input: { filePath: "/repo/a.ts" },
    })
    assert.equal(
      journalEntries(metricsDir).some((e) => e.reason === "parent-hands-on"),
      false,
      "no hands-on block fired while dormant",
    )
  } finally {
    dispose()
  }
})

test("dormant: a write-shaped bash command runs the write gate's telemetry but never blocks", async () => {
  const { h, dispose, metricsDir } = await boot()
  try {
    await callTool(h, "execute.before", {
      tool: "bash",
      sessionID: "p1",
      input: { command: "echo hi > out.txt" },
    })
    assert.ok(
      journalEntries(metricsDir).some((e) => e.type === "tool" && e.handsOn === true),
      "the bash-write telemetry still journals while dormant",
    )
  } finally {
    dispose()
  }
})

test("dormant: the read horizon never blocks at the block threshold", async () => {
  const { h, dispose } = await boot({ readWarn: 1, readBlock: 2 })
  try {
    for (let i = 0; i < 5; i++) {
      await callTool(h, "execute.before", { tool: "read", sessionID: "p1" })
      await callTool(h, "execute.after", {
        tool: "read",
        sessionID: "p1",
        result: { output: `body ${i}` },
      })
    }
  } finally {
    dispose()
  }
})

test("dormant: a work-intent prompt nudges once and journals no engagement row", async () => {
  const { h, dispose, metricsDir } = await boot()
  try {
    await admit(h, "p1", "fix the login bug")
    assert.equal(engagementRows(metricsDir).length, 0)
    const event = { tool: "read", sessionID: "p1", result: { output: "body" } }
    await callTool(h, "execute.after", event)
    assert.ok(String(event.result.output).includes("Advisory reminder"))
  } finally {
    dispose()
  }
})

test("alwaysEnforce:true restores the legacy always-armed write block", async () => {
  const { h, dispose } = await boot({ alwaysEnforce: true })
  try {
    await assert.rejects(() =>
      callTool(h, "execute.before", {
        tool: "write",
        sessionID: "p1",
        input: { filePath: "/repo/a.ts" },
      }),
    )
  } finally {
    dispose()
  }
})

// ── engagement triggers (AC-2) ───────────────────────────────────────────────

test("a dispatch-intent prompt engages; the next parent write blocks", async () => {
  const { h, dispose, metricsDir } = await boot()
  try {
    await admit(h, "p1", "run the pipeline for the retry fix")
    const rows = engagementRows(metricsDir)
    assert.equal(rows.length, 1)
    assert.equal(rows[0]?.engaged, true)
    assert.equal(rows[0]?.reason, "dispatch-request")
    await assert.rejects(() =>
      callTool(h, "execute.before", {
        tool: "write",
        sessionID: "p1",
        input: { filePath: "/repo/a.ts" },
      }),
    )
  } finally {
    dispose()
  }
})

test("a plan-reference prompt engages with reason plan-reference", async () => {
  const { h, dispose, metricsDir } = await boot()
  try {
    await admit(h, "p1", "start working from my-plan.md")
    const rows = engagementRows(metricsDir)
    assert.equal(rows.length, 1)
    assert.equal(rows[0]?.reason, "plan-reference")
  } finally {
    dispose()
  }
})

test("a PLAN APPROVED prompt engages with reason plan-approved", async () => {
  const { h, dispose, metricsDir } = await boot()
  try {
    await admit(h, "p1", "PLAN APPROVED: go ahead")
    const rows = engagementRows(metricsDir)
    assert.equal(rows.length, 1)
    assert.equal(rows[0]?.reason, "plan-approved")
  } finally {
    dispose()
  }
})

test("an already-engaged session journals no second arm row", async () => {
  const { h, dispose, metricsDir } = await boot()
  try {
    await admit(h, "p1", "run the pipeline for the retry fix")
    // The second engaging prompt arrives with no earned credit, so the
    // admission reset drops the engagement (continuation-drop) and the
    // prompt's own dispatch intent re-arms it — but there is never a
    // double-arm within one admission.
    await admit(h, "p1", "run the pipeline again please")
    const rows = engagementRows(metricsDir)
    assert.deepEqual(
      rows.map((r) => [r.engaged, r.reason]),
      [
        [true, "dispatch-request"],
        [false, "continuation-drop"],
        [true, "dispatch-request"],
      ],
    )
  } finally {
    dispose()
  }
})

test("a hostile prompt payload journals the engagement-capture error and never throws", async () => {
  const { h, dispose, metricsDir } = await boot()
  try {
    await callSession(h, "prompt", {
      sessionID: "p1",
      get text(): string {
        throw new Error("hostile prompt")
      },
    })
    const errors = entriesOf(metricsDir, "error")
    assert.ok(
      errors.some((e) => typeof e.error === "string" && e.error.startsWith("engagement capture:")),
      "the capture failure is journaled",
    )
  } finally {
    dispose()
  }
})

test("a failing engagement read journals the error row and fails toward the configured mode", async () => {
  const metricsDir = tmpDir()
  const ctx = createHooksCore({ env: isolatedEnv(metricsDir), config: { metricsDir } })
  const ledger = ctx.ledger as unknown as Record<string, unknown>
  ledger.state = (): unknown => {
    throw new Error("bucket broken")
  }
  // The read-budget choke point consults engagement before any other ledger
  // interaction, so the throw surfaces at the armed probe and is swallowed.
  ctx.handleReadBudget("p1")
  const errors = entriesOf(metricsDir, "error")
  assert.ok(
    errors.some((e) => typeof e.error === "string" && e.error.startsWith("engagement read:")),
    "the engagement-read failure is journaled",
  )
})

// ── planner dispatch arms (AC-2) ─────────────────────────────────────────────

test("a dormant planner dispatch arms enforcement and is itself governed", async () => {
  const { h, dispose, metricsDir } = await boot()
  try {
    // No engaging prompt: the planner dispatch itself engages.
    await callTool(h, "execute.before", {
      tool: "task",
      sessionID: "p1",
      input: { agent: "planner", prompt: "plan the work" },
    })
    const rows = engagementRows(metricsDir)
    assert.equal(rows.length, 1)
    assert.equal(rows[0]?.engaged, true)
    assert.equal(rows[0]?.reason, "dispatch-request")
    // Armed: the executor dispatch now hits the plan gate and blocks.
    await assert.rejects(() =>
      callTool(h, "execute.before", {
        tool: "task",
        sessionID: "p1",
        input: { agent: "executor", prompt: "do the work" },
      }),
    )
  } finally {
    dispose()
  }
})

test("a dormant non-planner dispatch is allowed without arming", async () => {
  const { h, dispose, metricsDir } = await boot()
  try {
    await callTool(h, "execute.before", {
      tool: "task",
      sessionID: "p1",
      input: { agent: "test-runner", prompt: "run the tests" },
    })
    assert.equal(engagementRows(metricsDir).length, 0)
    // Still dormant: a parent write proceeds.
    await callTool(h, "execute.before", {
      tool: "write",
      sessionID: "p1",
      input: { filePath: "/repo/a.ts" },
    })
  } finally {
    dispose()
  }
})

// ── disengagement (AC-3) ─────────────────────────────────────────────────────

test("task completion disengages: a TASK DONE prompt journals the sleep row", async () => {
  const { h, metricsDir, restore } = await bootWithPlan()
  try {
    await admit(h, "p1", "PLAN APPROVED: use plan.md for the retry fix")
    assert.equal(engagementRows(metricsDir).length, 1)
    await admit(h, "p1", "TASK DONE: wrapped up")
    const rows = engagementRows(metricsDir)
    assert.equal(rows.length, 2)
    assert.equal(rows[1]?.engaged, false)
    assert.equal(rows[1]?.reason, "task-complete")
    // Dormant again: a parent write proceeds.
    await callTool(h, "execute.before", {
      tool: "write",
      sessionID: "p1",
      input: { filePath: "/repo/a.ts" },
    })
  } finally {
    restore()
  }
})

test("a dormant task retire journals no engagement row (idempotence)", async () => {
  const { h, metricsDir, restore } = await bootWithPlan()
  try {
    await admit(h, "p1", "PLAN APPROVED: use plan.md")
    await admit(h, "p1", "TASK DONE: wrapped up")
    await admit(h, "p1", "PLAN APPROVED: use plan.md again")
    await admit(h, "p1", "TASK DONE: finished again")
    const rows = engagementRows(metricsDir)
    assert.equal(rows.length, 4)
    assert.deepEqual(
      rows.map((r) => r.engaged),
      [true, false, true, false],
    )
  } finally {
    restore()
  }
})

test("TURNSTILE OFF: disengages with reason abort", async () => {
  const { h, dispose, metricsDir } = await boot()
  try {
    await admit(h, "p1", "run the pipeline for the retry fix")
    await admit(h, "p1", "TURNSTILE OFF: pause the gates")
    const rows = engagementRows(metricsDir)
    // The OFF prompt's admission reset drops the engagement first (no
    // credit), then the suspend capture journals the abort row.
    assert.equal(rows.length, 3)
    assert.equal(rows[2]?.engaged, false)
    assert.equal(rows[2]?.reason, "abort")
  } finally {
    dispose()
  }
})

test("a no-credit new prompt disengages with reason continuation-drop", async () => {
  const { h, dispose, metricsDir } = await boot()
  try {
    await admit(h, "p1", "run the pipeline for the retry fix")
    // A chat prompt (no engaging intent, no earned credit) resets the scope
    // and drops the engagement.
    await admit(h, "p1", "thanks, that helps")
    const rows = engagementRows(metricsDir)
    assert.equal(rows.length, 2)
    assert.equal(rows[1]?.engaged, false)
    assert.equal(rows[1]?.reason, "continuation-drop")
  } finally {
    dispose()
  }
})

test("continuationCarry:false drops the engagement on every new prompt", async () => {
  const { h, dispose, metricsDir } = await boot({ continuationCarry: false, gateEvidence: "flag" })
  try {
    await admit(h, "p1", "run the pipeline for the retry fix")
    await callTool(h, "execute.after", {
      tool: "task",
      sessionID: "p1",
      input: { agent: "test-runner" },
      result: { output: "GATE: PASS tests=1 passed=1 failed=0\n" },
    })
    // Even with earned credit, the carry-off config resets per prompt and
    // drops the engagement.
    await admit(h, "p1", "continue with the next chunk")
    const rows = engagementRows(metricsDir)
    assert.equal(rows.length, 2)
    assert.equal(rows[1]?.engaged, false)
    assert.equal(rows[1]?.reason, "continuation-drop")
  } finally {
    dispose()
  }
})

test("a continuation carry keeps the engagement armed with no drop row", async () => {
  const { h, dispose, metricsDir } = await boot({ gateEvidence: "flag" })
  try {
    await admit(h, "p1", "run the pipeline for the retry fix")
    // Earn the carry credit: a test-runner GATE: PASS flips the gate.
    await callTool(h, "execute.after", {
      tool: "task",
      sessionID: "p1",
      input: { agent: "test-runner" },
      result: { output: "GATE: PASS tests=1 passed=1 failed=0\n" },
    })
    // A same-worktree continuation carries the earned credit — and with it
    // the engagement — across the reset.
    await admit(h, "p1", "continue with the next chunk")
    assert.equal(engagementRows(metricsDir).length, 1)
    // Still armed: a parent write blocks.
    await assert.rejects(() =>
      callTool(h, "execute.before", {
        tool: "write",
        sessionID: "p1",
        input: { filePath: "/repo/a.ts" },
      }),
    )
  } finally {
    dispose()
  }
})

// ── replay (AC-4) ────────────────────────────────────────────────────────────

test("replay: a journaled engagement:true row restores the armed state", async () => {
  const metricsDir = tmpDir()
  fs.writeFileSync(
    path.join(metricsDir, "turnstile.jsonl"),
    `${JSON.stringify({ ts: "t", type: "engagement", sessionID: "p1", engaged: true, reason: "dispatch-request" })}\n`,
  )
  const { h, dispose } = await boot({ metricsDir })
  try {
    await assert.rejects(() =>
      callTool(h, "execute.before", {
        tool: "write",
        sessionID: "p1",
        input: { filePath: "/repo/a.ts" },
      }),
    )
  } finally {
    dispose()
  }
})

test("replay: a journaled engagement:false row restores dormancy", async () => {
  const metricsDir = tmpDir()
  fs.writeFileSync(
    path.join(metricsDir, "turnstile.jsonl"),
    [
      JSON.stringify({ ts: "t1", type: "engagement", sessionID: "p1", engaged: true }),
      JSON.stringify({ ts: "t2", type: "engagement", sessionID: "p1", engaged: false }),
    ].join("\n") + "\n",
  )
  const { h, dispose } = await boot({ metricsDir })
  try {
    await callTool(h, "execute.before", {
      tool: "write",
      sessionID: "p1",
      input: { filePath: "/repo/a.ts" },
    })
  } finally {
    dispose()
  }
})

test("replay: a hostile non-boolean engaged field is sanitized to dormant", async () => {
  const metricsDir = tmpDir()
  fs.writeFileSync(
    path.join(metricsDir, "turnstile.jsonl"),
    `${JSON.stringify({ ts: "t", type: "engagement", sessionID: "p1", engaged: "yes" })}\n`,
  )
  const { h, dispose } = await boot({ metricsDir })
  try {
    await callTool(h, "execute.before", {
      tool: "write",
      sessionID: "p1",
      input: { filePath: "/repo/a.ts" },
    })
  } finally {
    dispose()
  }
})

// ── snapshot + policy gating (AC-4/AC-5) ─────────────────────────────────────

test("formatGateSnapshot renders the engaged line for both states", () => {
  const dormant = formatGateSnapshot(newState()).split("\n")
  assert.equal(dormant[2], "- engaged: no")
  const engaged = formatGateSnapshot({ ...newState(), engaged: true }).split("\n")
  assert.equal(engaged[2], "- engaged: yes")
})

test("a dormant session's context draft receives no policy head; an engaged one does", async () => {
  const { h, dispose, metricsDir } = await boot()
  try {
    const dormantDraft = { sessionID: "p1", system: [{ type: "text", text: "base" }] }
    await callSession(h, "context", dormantDraft)
    assert.equal(dormantDraft.system!.length, 1, "no policy head while dormant")
    assert.equal(entriesOf(metricsDir, "policy").length, 0)
    await admit(h, "p1", "run the pipeline for the retry fix")
    const engagedDraft = { sessionID: "p1", system: [{ type: "text", text: "base" }] }
    await callSession(h, "context", engagedDraft)
    assert.equal(engagedDraft.system!.length, 2)
    assert.ok(engagedDraft.system![1]!.text!.includes("Orchestrator policy"))
  } finally {
    dispose()
  }
})

test("a dormant session's task delivery receives no policy head", async () => {
  const { h, dispose, metricsDir } = await boot()
  try {
    const event = {
      tool: "task",
      sessionID: "p1",
      input: { agent: "test-runner" },
      result: { output: "all green" },
    }
    await callTool(h, "execute.after", event)
    // The pipeline status tail may append (test-runner is a stage), but the
    // policy head never lands while dormant.
    assert.ok(!String(event.result.output).includes("Orchestrator policy"))
    assert.equal(entriesOf(metricsDir, "policy").length, 0)
  } finally {
    dispose()
  }
})

test("the policy text matches the boot's resolved config for an engaged session", async () => {
  const { h, dispose, metricsDir } = await boot()
  try {
    await admit(h, "p1", "run the pipeline for the retry fix")
    const draft = { sessionID: "p1", system: [{ type: "text", text: "base" }] }
    await callSession(h, "context", draft)
    assert.equal(draft.system![1]!.text, expectedPolicy({ metricsDir }))
  } finally {
    dispose()
  }
})
