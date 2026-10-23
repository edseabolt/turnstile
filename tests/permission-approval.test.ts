/**
 * @fileoverview Permission-approval tests (Phase 1): the
 * `permission.evaluate` escalation handler (red plan gate only, action
 * matching, plan file + head message, trace redaction, fail-open), the
 * prompt-channel `PLAN APPROVED:` marker wiring, the `permission.asked`/
 * `permission.replied` stream replay consumption (once/always/reject), the
 * execute.before once-grant short-circuit (consumed by exactly one dispatch),
 * the optional permission surface (register-throw / absent), and the extracted
 * planSummary / planGateStatus gate predicates, all via a fake host.
 */

import { test } from "node:test"
import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import * as fs from "node:fs"
import * as path from "node:path"
import { fileURLToPath } from "node:url"

import { turnstile } from "../turnstile.ts"
import { BlockError, createGates } from "../src/gates.ts"
import { defaultConfig } from "../src/config.ts"
import { createJournaler } from "../src/journal.ts"
import { createLedger } from "../src/ledger.ts"
import { LANDING_REQUIREMENT } from "../src/tool-policy.ts"
import { PLAN_ASK_MESSAGE_PREFIX } from "../src/delivery.ts"
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

const APPROVAL = "PLAN APPROVED:"
/** Path to scripts/status.mjs, resolved relative to this test file. */
const statusScript = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "scripts",
  "status.mjs",
)
/**
 * Normalizes a spawnSync exit code across Node builds: `status` on modern
 * builds, `exitCode` on older ones. Null-free here (status.mjs always exits
 * normally, never errors out).
 * @param res The spawnSync result.
 * @returns The numeric exit code, or -1 when the process did not exit cleanly.
 */
function code(res: { status: number | null; exitCode?: number | null }): number {
  return res.status ?? res.exitCode ?? -1
}

/** Gives the async event-loop consumer a tick to drain queued stream events. */
const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 30))

/**
 * Boots a temp project dir whose `.opencode/plans` holds one plan file, and the
 * plugin over a fake host with a temp metrics dir.
 * @param config Injected turnstile config overrides.
 * @param planBody The plan file body (head = its non-heading lines).
 * @returns The host, metrics dir, project dir, and a cwd-restoring disposer.
 */
async function bootWithPlan(
  config: Record<string, any> = {},
  planBody = "# Plan\n\nSome plan body text.\n",
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
    config: { metricsDir, ...config },
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

/**
 * Boots the plugin over a fake host with a temp metrics dir and the given
 * config overrides. The landing gate never scans a plan, so no project dir is
 * required (unlike {@link bootWithPlan}).
 * @param config Injected turnstile config overrides.
 * @returns The host, metrics dir, and a restoring disposer.
 */
async function bootLanding(
  config: Record<string, any> = {},
): Promise<{ h: FakeHost; metricsDir: string; restore: () => void }> {
  const metricsDir = tmpDir()
  const h = makeFakeHost()
  const setup = turnstile(h.host, {
    env: isolatedEnv(metricsDir),
    config: { metricsDir, ...config },
  })
  const dispose = (await setup(h.host)) as () => void
  return { h, metricsDir, restore: (): void => dispose() }
}

/**
 * Builds a real gate set + ledger sharing one metrics dir, for exercising the
 * extracted `planSummary` / `planGateStatus` predicates directly.
 * @param metricsDir The shared metrics directory.
 * @returns The gates and the ledger.
 */
function makeGates(metricsDir: string): {
  gates: ReturnType<typeof createGates>
  ledger: ReturnType<typeof createLedger>
} {
  const journaler = createJournaler({
    metricsDir,
    trace: false,
    maxBytes: 1_000_000,
    maxGenerations: 5,
    rotateEveryEntries: 512,
  })
  const ledger = createLedger(journaler.journalPath, 64, 2000)
  return { gates: createGates(defaultConfig(), journaler), ledger }
}

/** Writes an unreadable "plans dir" (a regular file) at the expected path. */
function writePlansDirAsFile(project: string): void {
  const opencode = path.join(project, ".opencode")
  fs.mkdirSync(opencode, { recursive: true })
  const plansPath = path.join(opencode, "plans")
  // plans may already be a directory (from the plan file); replace it with a
  // file so readdirSync on it throws ENOTDIR — the unreadable plans-dir case.
  fs.rmSync(plansPath, { recursive: true, force: true })
  fs.writeFileSync(plansPath, "not a dir")
}

/** Writes a plans dir that exists but holds no plan files. */
function writeEmptyPlansDir(project: string): void {
  const plansDir = path.join(project, ".opencode", "plans")
  fs.mkdirSync(plansDir, { recursive: true })
  // Remove any existing plan files so the dir holds no plans.
  for (const entry of fs.readdirSync(plansDir)) fs.rmSync(path.join(plansDir, entry))
}

/**
 * The evaluate handler is fail-open against a nullish event payload: a null or
 * undefined `event` short-circuits the `pe?.action` optional chains and returns
 * before mutating gate state or throwing. Placed first so it is unaffected by
 * any cwd/telemetry state later tests establish — it only needs a booted plugin.
 */
test("evaluate: a nullish event payload escalates nothing and never throws", async () => {
  const fs = await import("node:fs")
  const path = await import("node:path")
  const project = tmpDir()
  fs.mkdirSync(path.join(project, ".opencode", "plans"), { recursive: true })
  fs.writeFileSync(path.join(project, ".opencode", "plans", "plan.md"), "# Plan\n\nbody\n")
  const metricsDir = tmpDir()
  const h = makeFakeHost()
  await turnstile(h.host, { env: isolatedEnv(metricsDir), config: { metricsDir } })(h.host)
  for (const bad of [null, undefined] as const) {
    await callPermission(h, "evaluate", bad)
  }
  // Nothing was journaled: no ask, and the fail-open catch was not triggered.
  assert.ok(
    !journalEntries(metricsDir).some((l) => l.type === "permission" || l.type === "error"),
    "a nullish event records no ask and no error",
  )
})

/**
 * The extracted plan-approval predicates must agree with the enforcing
 * dispatch: waived, absent, empty, approved, and unreadable are never red; a
 * plan with no approval is red with the plan's file + head preview.
 */
test("planGateStatus / planSummary: the five red-gate outcomes", () => {
  // Present plan (red) — the summary names the file and its body head.
  const project = tmpDir()
  fs.mkdirSync(path.join(project, ".opencode", "plans"), { recursive: true })
  fs.writeFileSync(path.join(project, ".opencode", "plans", "plan.md"), "# Plan\n\nBody text.\n")
  const metricsDir = tmpDir()
  const { gates, ledger } = makeGates(metricsDir)

  const red = gates.planGateStatus(project, ledger, "p1")
  assert.deepEqual(red, { red: true, summary: { file: "plan.md", head: "Body text." } })
  assert.deepEqual(gates.planSummary(project), { file: "plan.md", head: "Body text." })

  // Waived — the prompt-channel waiver is never red (and short-circuits).
  ledger.state("waived").userWaiver = "user said ship"
  assert.deepEqual(gates.planGateStatus(project, ledger, "waived"), { red: false })

  // Approved — a current verdict is never red.
  ledger.state("approved").hasPlanVerdict = true
  assert.deepEqual(gates.planGateStatus(project, ledger, "approved"), { red: false })

  // Absent plans dir — not red, no summary.
  const noDir = tmpDir()
  assert.equal(gates.planSummary(noDir), undefined)
  assert.deepEqual(gates.planGateStatus(noDir, ledger, "p1"), { red: false })

  // Empty plans dir (no plans) — not red, no summary.
  writeEmptyPlansDir(project)
  assert.equal(gates.planSummary(project), undefined)
  assert.deepEqual(gates.planGateStatus(project, ledger, "p1"), { red: false })

  // Unreadable plans dir — fail open: not red, no summary, error journaled.
  writePlansDirAsFile(project)
  assert.equal(gates.planSummary(project), undefined)
  assert.deepEqual(gates.planGateStatus(project, ledger, "p1"), { red: false })
  assert.ok(
    journalEntries(metricsDir).some(
      (l) => l.type === "error" && /plans dir unreadable: Error: ENOTDIR/.test(l.error),
    ),
  )
})

/**
 * A red plan gate on an executor dispatch escalates to the human via a forced
 * `ask`, naming the plan file + head, and journals the ask (trace on shows the
 * body; trace redacts it). The handler mutates only `task` actions and a green
 * gate is left untouched.
 */
test("evaluate: red plan gate forces an ask naming the plan file + head", async () => {
  const { h, restore, metricsDir } = await bootWithPlan({}, "# Plan\n\nSensitive body line.\n")
  try {
    const event: Record<string, any> = { sessionID: "p1", action: "task" }
    await callPermission(h, "evaluate", event)
    // Effect + message are set in place; the message carries the file + head.
    assert.equal(event.effect, "ask")
    assert.equal(event.message, "turnstile: plan approval required — plan.md: Sensitive body line.")
    // The ask is journaled for later reply matching; it names the plan file.
    const ask = journalEntries(metricsDir).find(
      (l) => l.type === "permission" && l.action === "ask",
    )
    assert.ok(ask)
    assert.equal(ask?.sessionID, "p1")
    assert.equal(ask?.reason, "plan-gate")
    assert.equal(ask?.plan, "plan.md")
  } finally {
    restore()
  }
})

/** Under trace:false the ask still names the plan file but redacts the body. */
test("evaluate: trace:false redacts the plan body out of the ask message", async () => {
  const { h, restore } = await bootWithPlan({ trace: false }, "# Plan\n\nSensitive body line.\n")
  try {
    const event: Record<string, any> = { sessionID: "p1", action: "task" }
    await callPermission(h, "evaluate", event)
    assert.equal(event.effect, "ask")
    assert.equal(event.message, "turnstile: plan approval required — plan.md")
    assert.ok(!/Sensitive body line/.test(event.message ?? ""))
  } finally {
    restore()
  }
})

/** The handler escalates only `task` actions: a non-task action is untouched. */
test("evaluate: a non-task action is not escalated", async () => {
  const { h, restore } = await bootWithPlan()
  try {
    const event: Record<string, any> = { sessionID: "p1", action: "bash" }
    await callPermission(h, "evaluate", event)
    assert.equal(event.effect, undefined)
  } finally {
    restore()
  }
})

/** A green plan gate (approved) leaves the evaluate event untouched. */
test("evaluate: an approved plan gate is not escalated", async () => {
  const { h, restore, metricsDir } = await bootWithPlan()
  try {
    // A PLAN APPROVED: prompt in the user prompt releases the gate first.
    await callSession(h, "prompt", { sessionID: "p1", text: `${APPROVAL} done` })
    const event: Record<string, any> = { sessionID: "p1", action: "task" }
    await callPermission(h, "evaluate", event)
    assert.equal(event.effect, undefined)
    assert.ok(
      !journalEntries(metricsDir).some((l) => l.type === "permission" && l.action === "ask"),
    )
  } finally {
    restore()
  }
})

/** The evaluate handler never throws: an internal throw is journaled. */
test("evaluate: an internal throw fails open and never blocks the host", async () => {
  const { h, restore, metricsDir } = await bootWithPlan()
  try {
    // A frozen payload throws on the in-place `effect` assignment (strict mode),
    // exercising the handler's fail-open catch.
    const frozen = Object.freeze({ sessionID: "p1", action: "task" })
    let threw = false
    try {
      await callPermission(h, "evaluate", frozen)
    } catch {
      threw = true
    }
    assert.equal(threw, false, "the evaluate handler must never throw")
    assert.ok(
      journalEntries(metricsDir).some(
        (l) => l.type === "error" && /permission evaluate: TypeError/.test(l.error),
      ),
    )
  } finally {
    restore()
  }
})

/**
 * The evaluate handler is fail-open against a nullish event payload: a null or
 * undefined `event` short-circuits the `pe?.action` optional chains and returns
 * before mutating gate state or throwing. The red plan gate is left untouched —
 * a real task dispatch still escalates afterward.
 */
/** A `permission.evaluate` hook that throws at registration is journaled. */
test("setup: a throwing permission.hook journals the failure (fail-open)", async () => {
  const metricsDir = tmpDir()
  const h = makeFakeHost()
  // Replace the optional permission surface with one that throws on hook.
  ;(h.host as { permission?: unknown }).permission = {
    hook: async (): Promise<unknown> => {
      throw new Error("boom")
    },
  }
  let threw = false
  try {
    const setup = turnstile(h.host, { env: isolatedEnv(metricsDir), config: { metricsDir } })
    await setup(h.host)
  } catch {
    threw = true
  }
  assert.equal(threw, false, "setup must never throw because of the permission hook")
  assert.ok(
    journalEntries(metricsDir).some(
      (l) => l.type === "error" && l.error === "permission.evaluate hook registration: Error: boom",
    ),
  )
})

/** A host without the permission surface still registers (degraded, 6 hooks). */
test("setup: a host without the permission surface degrades without registering", async () => {
  const metricsDir = tmpDir()
  const h = makeFakeHost({ permission: false })
  const setup = turnstile(h.host, { env: isolatedEnv(metricsDir), config: { metricsDir } })
  await setup(h.host)
  assert.equal(h.permissionHooks.evaluate, undefined)
  const setups = journalEntries(metricsDir).filter((l) => l.type === "setup")
  assert.equal(setups[0]?.hooks, 6)
})

/**
 * A `PLAN APPROVED:` marker in the user prompt releases the plan gate: the
 * executor dispatches without a reviewer verdict, and the approval is journaled
 * as a session-prompt approve (replays identically to a reviewer verdict).
 */
test("prompt: PLAN APPROVED: releases the plan gate and is journaled", async () => {
  const { h, restore, metricsDir } = await bootWithPlan()
  try {
    await callSession(h, "prompt", { sessionID: "p1", text: `${APPROVAL} human signed off` })
    // Green: the executor dispatches with no block.
    await callTool(h, "execute.before", {
      tool: "task",
      sessionID: "p1",
      input: { agent: "executor", prompt: "do the work" },
    })
    const plan = journalEntries(metricsDir).find((l) => l.type === "plan" && l.result === "APPROVE")
    assert.ok(plan, "a plan APPROVE entry must be journaled")
    assert.equal(plan?.source, "session-prompt")
    assert.equal(plan?.marker, APPROVAL)
  } finally {
    restore()
  }
})

/**
 * A `once` reply grants exactly one executor dispatch past the red gate, then
 * is consumed: the next dispatch is blocked again (a stale grant cannot
 * outlive the single dispatch it was given for).
 */
test("reply: a once-grant passes one dispatch then is consumed", async () => {
  const { h, restore, metricsDir } = await bootWithPlan()
  try {
    // Escalate, then answer the ask with a single-dispatch grant.
    await callPermission(h, "evaluate", { sessionID: "p1", action: "task" })
    h.pushEvent({ type: "permission.asked", properties: { sessionID: "p1", id: "req-1" } })
    h.pushEvent({
      type: "permission.replied",
      properties: { sessionID: "p1", requestID: "req-1", reply: "once" },
    })
    await waitUntil(() =>
      journalEntries(metricsDir).some((l) => l.type === "permission" && l.decision === "once"),
    )
    // First dispatch: the grant short-circuits the plan-gate block.
    await callTool(h, "execute.before", {
      tool: "task",
      sessionID: "p1",
      input: { agent: "executor", prompt: "do the work" },
    })
    // Second dispatch: the single grant is spent, so the red gate re-blocks.
    await assert.rejects(
      () =>
        callTool(h, "execute.before", {
          tool: "task",
          sessionID: "p1",
          input: { agent: "executor", prompt: "more work" },
        }),
      (e: Error) => /no plan approval for "plan.md"/.test(e.message),
    )
  } finally {
    restore()
  }
})

/** An `always` reply releases the gate for the rest of the task. */
test("reply: an always-grant releases the plan gate", async () => {
  const { h, restore, metricsDir } = await bootWithPlan()
  try {
    await callPermission(h, "evaluate", { sessionID: "p1", action: "task" })
    h.pushEvent({ type: "permission.asked", properties: { sessionID: "p1", id: "req-a" } })
    h.pushEvent({
      type: "permission.replied",
      properties: { sessionID: "p1", requestID: "req-a", reply: "always" },
    })
    await waitUntil(() =>
      journalEntries(metricsDir).some((l) => l.type === "permission" && l.decision === "always"),
    )
    // Both dispatches proceed: the standing human approval holds the gate green.
    await callTool(h, "execute.before", {
      tool: "task",
      sessionID: "p1",
      input: { agent: "executor", prompt: "do the work" },
    })
    await callTool(h, "execute.before", {
      tool: "task",
      sessionID: "p1",
      input: { agent: "executor", prompt: "more work" },
    })
  } finally {
    restore()
  }
})

/** A `reject` reply leaves the gate red: the next dispatch is blocked. */
test("reply: a reject leaves the plan gate red", async () => {
  const { h, restore, metricsDir } = await bootWithPlan()
  try {
    await callPermission(h, "evaluate", { sessionID: "p1", action: "task" })
    h.pushEvent({ type: "permission.asked", properties: { sessionID: "p1", id: "req-r" } })
    h.pushEvent({
      type: "permission.replied",
      properties: { sessionID: "p1", requestID: "req-r", reply: "reject" },
    })
    await waitUntil(() =>
      journalEntries(metricsDir).some((l) => l.type === "permission" && l.decision === "reject"),
    )
    await assert.rejects(
      () =>
        callTool(h, "execute.before", {
          tool: "task",
          sessionID: "p1",
          input: { agent: "executor", prompt: "do the work" },
        }),
      (e: Error) => /no plan approval for "plan.md"/.test(e.message),
    )
  } finally {
    restore()
  }
})

/** A reply with no outstanding ask is inert — the gate stays red. */
test("reply: a reply with no matching pending ask is inert", async () => {
  const { h, restore, metricsDir } = await bootWithPlan()
  try {
    // No evaluate ask happened, so planAskRequestID is empty.
    h.pushEvent({
      type: "permission.replied",
      properties: { sessionID: "p1", requestID: "orphan", reply: "once" },
    })
    await settle()
    assert.ok(
      !journalEntries(metricsDir).some((l) => l.type === "permission" && l.decision === "once"),
    )
    // The gate is still red.
    await assert.rejects(() =>
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

/** A reply with a mismatched request id does not match the pending ask. */
test("reply: a requestID mismatch does not grant", async () => {
  const { h, restore, metricsDir } = await bootWithPlan()
  try {
    await callPermission(h, "evaluate", { sessionID: "p1", action: "task" })
    h.pushEvent({ type: "permission.asked", properties: { sessionID: "p1", id: "req-1" } })
    h.pushEvent({
      type: "permission.replied",
      properties: { sessionID: "p1", requestID: "WRONG", reply: "once" },
    })
    await settle()
    assert.ok(
      !journalEntries(metricsDir).some((l) => l.type === "permission" && l.decision === "once"),
    )
    await assert.rejects(() =>
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

/**
 * An `id` that is a non-string or empty string is not recorded as the pending
 * ask id, so the next reply cannot match — the stream parsing is inert.
 */
test("asked: a non-string and an empty request id are not recorded", async () => {
  const { h, restore, metricsDir } = await bootWithPlan()
  try {
    await callPermission(h, "evaluate", { sessionID: "p1", action: "task" })
    // Non-string id: not recorded.
    h.pushEvent({ type: "permission.asked", properties: { sessionID: "p1", id: 42 } })
    h.pushEvent({
      type: "permission.replied",
      properties: { sessionID: "p1", requestID: "42", reply: "once" },
    })
    await settle()
    // Empty id: not recorded either.
    h.pushEvent({ type: "permission.asked", properties: { sessionID: "p1", id: "" } })
    h.pushEvent({
      type: "permission.replied",
      properties: { sessionID: "p1", requestID: "", reply: "once" },
    })
    await settle()
    assert.ok(
      !journalEntries(metricsDir).some((l) => l.type === "permission" && l.decision === "once"),
    )
    await assert.rejects(() =>
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

/**
 * A `permission.asked` with no `id` falls back to its `requestID`, so the ask
 * is recorded (via the latched-ask echo path) and an `always` reply for that
 * requestID releases the plan gate — proving the fallback branch records asks.
 */
test("asked: a missing id falls back to requestID and the ask registers", async () => {
  const { h, restore, metricsDir } = await bootWithPlan()
  try {
    await callPermission(h, "evaluate", { sessionID: "p1", action: "task" })
    h.pushEvent({ type: "permission.asked", properties: { sessionID: "p1", requestID: "rid-1" } })
    h.pushEvent({
      type: "permission.replied",
      properties: { sessionID: "p1", requestID: "rid-1", reply: "always" },
    })
    await waitUntil(() =>
      journalEntries(metricsDir).some((l) => l.type === "permission" && l.decision === "always"),
    )
  } finally {
    restore()
  }
})

/** A `permission.replied` with no `requestID` resolves to an empty rid that
 *  matches neither map, so nothing is consumed, journaled, or released. */
test("replied: a requestID-less reply touches neither map", async () => {
  const { h, restore, metricsDir } = await bootWithPlan()
  try {
    h.pushEvent({ type: "permission.replied", properties: { sessionID: "p1" } })
    await settle()
    // No decision journal entry and the plan gate is still red.
    assert.ok(!journalEntries(metricsDir).some((l) => l.type === "permission"))
    await assert.rejects(() =>
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

/**
 * HIGH-1 scoping: a once-grant releases ONLY the executor dispatch class. A
 * reviewer dispatch with a pending grant still runs guardReviewerDispatch
 * (blocked on the red reviewer gate), and the grant survives to be consumed by
 * the next executor dispatch.
 */
test("reply: a once-grant does not release a reviewer dispatch and survives for the executor", async () => {
  const { h, restore, metricsDir } = await bootWithPlan()
  try {
    await callPermission(h, "evaluate", { sessionID: "p1", action: "task" })
    h.pushEvent({ type: "permission.asked", properties: { sessionID: "p1", id: "req-1" } })
    h.pushEvent({
      type: "permission.replied",
      properties: { sessionID: "p1", requestID: "req-1", reply: "once" },
    })
    await waitUntil(() =>
      journalEntries(metricsDir).some((l) => l.type === "permission" && l.decision === "once"),
    )
    // A reviewer dispatch with the grant pending is still guarded: the reviewer
    // gate is red (no GATE: PASS), so guardReviewerDispatch blocks.
    await assert.rejects(
      () =>
        callTool(h, "execute.before", {
          tool: "task",
          sessionID: "p1",
          input: { agent: "reviewer", prompt: "review it" },
        }),
      (e: Error) => /BLOCKED by turnstile: no reviewer dispatch/.test(e.message),
    )
    // The grant survived the reviewer dispatch and is now consumed by exactly
    // one executor dispatch.
    await callTool(h, "execute.before", {
      tool: "task",
      sessionID: "p1",
      input: { agent: "executor", prompt: "do the work" },
    })
    // Spent: the next executor dispatch re-blocks.
    await assert.rejects(
      () =>
        callTool(h, "execute.before", {
          tool: "task",
          sessionID: "p1",
          input: { agent: "executor", prompt: "more work" },
        }),
      (e: Error) => /no plan approval for "plan.md"/.test(e.message),
    )
  } finally {
    restore()
  }
})

/**
 * HIGH-2 scoping: an unrelated permission ask/reply (bash) interleaved between
 * the plan ask and its reply is fully inert — it neither clobbers the plan ask
 * record nor applies its own decision to the plan gate.
 */
test("reply: an unrelated ask/reply between the plan ask and its reply is inert", async () => {
  const { h, restore, metricsDir } = await bootWithPlan()
  try {
    await callPermission(h, "evaluate", { sessionID: "p1", action: "task" })
    h.pushEvent({ type: "permission.asked", properties: { sessionID: "p1", id: "req-1" } })
    // An unrelated bash ask (never escalated): its id must not be recorded.
    h.pushEvent({
      type: "permission.asked",
      properties: { sessionID: "p1", id: "bash-1", message: "run rm -rf / ?" },
    })
    // The human approves the bash ask — that approval must NOT release the
    // plan gate.
    h.pushEvent({
      type: "permission.replied",
      properties: { sessionID: "p1", requestID: "bash-1", reply: "always" },
    })
    await settle()
    assert.ok(
      !journalEntries(metricsDir).some((l) => l.type === "permission" && l.decision === "always"),
      "an unrelated ask approval must not be applied to the plan gate",
    )
    // The plan reply still matches its own ask despite the interleaved ask.
    h.pushEvent({
      type: "permission.replied",
      properties: { sessionID: "p1", requestID: "req-1", reply: "once" },
    })
    await waitUntil(() =>
      journalEntries(metricsDir).some((l) => l.type === "permission" && l.decision === "once"),
    )
    await callTool(h, "execute.before", {
      tool: "task",
      sessionID: "p1",
      input: { agent: "executor", prompt: "do the work" },
    })
  } finally {
    restore()
  }
})

/**
 * Latched-escalation tightening: a bash ask carrying a non-empty,
 * non-prefixed message while the parent's awaiting-plan-ask latch is live is
 * NOT recorded (its approval is inert), the latch survives the unrelated ask,
 * and a prefixed ask during the latch IS recorded.
 */
test("asked: a non-prefixed message under a live latch is not recorded; a prefixed one is", async () => {
  const { h, restore, metricsDir } = await bootWithPlan()
  try {
    await callPermission(h, "evaluate", { sessionID: "p1", action: "task" })
    // An unrelated bash ask under the live latch: its non-empty message lacks
    // the plan-ask prefix, so it must not be recorded.
    h.pushEvent({
      type: "permission.asked",
      properties: { sessionID: "p1", id: "bash-1", message: "run rm -rf / ?" },
    })
    h.pushEvent({
      type: "permission.replied",
      properties: { sessionID: "p1", requestID: "bash-1", reply: "always" },
    })
    await settle()
    assert.ok(
      !journalEntries(metricsDir).some((l) => l.type === "permission" && l.decision === "always"),
      "a bash-ask approval under the latch must not release the plan gate",
    )
    // A prefixed ask during the still-live latch IS the plan ask: recorded.
    h.pushEvent({
      type: "permission.asked",
      properties: {
        sessionID: "p1",
        id: "req-prefix",
        message: "turnstile: plan approval required — plan.md: Some plan body text.",
      },
    })
    h.pushEvent({
      type: "permission.replied",
      properties: { sessionID: "p1", requestID: "req-prefix", reply: "once" },
    })
    await waitUntil(() =>
      journalEntries(metricsDir).some((l) => l.type === "permission" && l.decision === "once"),
    )
    await callTool(h, "execute.before", {
      tool: "task",
      sessionID: "p1",
      input: { agent: "executor", prompt: "do the work" },
    })
  } finally {
    restore()
  }
})

/**
 * Latch expiry: an escalation marker older than the TTL is dropped, so a late
 * empty-message ask is not recorded and its reply is inert (fail-toward-strict:
 * the gate re-asks).
 */
test("asked: an expired awaiting latch does not record the ask", async () => {
  const { h, restore, metricsDir } = await bootWithPlan()
  const realNow = Date.now
  let now = realNow()
  ;(Date as unknown as { now: () => number }).now = () => now
  try {
    await callPermission(h, "evaluate", { sessionID: "p1", action: "task" })
    // Age the latch past the TTL, then send the ask the escalation awaited.
    now += 6001
    h.pushEvent({ type: "permission.asked", properties: { sessionID: "p1", id: "req-late" } })
    h.pushEvent({
      type: "permission.replied",
      properties: { sessionID: "p1", requestID: "req-late", reply: "once" },
    })
    // Drain the queued events while time is still frozen: the stream consumer
    // is asynchronous, so restoring the clock before it runs would make the
    // latch look live again.
    await settle()
    now = realNow()
    assert.ok(
      !journalEntries(metricsDir).some((l) => l.type === "permission" && l.decision === "once"),
      "an expired latch must not record the ask",
    )
    // The gate is still red.
    await assert.rejects(() =>
      callTool(h, "execute.before", {
        tool: "task",
        sessionID: "p1",
        input: { agent: "executor", prompt: "do the work" },
      }),
    )
  } finally {
    ;(Date as unknown as { now: () => number }).now = realNow
    restore()
  }
})

/**
 * Prompt reset clears the latch: an escalation followed by a new user prompt
 * drops the pending plan-ask marker, so a later empty-message ask is inert.
 */
test("asked: a prompt reset clears the awaiting latch", async () => {
  const { h, restore, metricsDir } = await bootWithPlan()
  try {
    await callPermission(h, "evaluate", { sessionID: "p1", action: "task" })
    // A new user prompt resets the parent's task scope — including the latch.
    await callSession(h, "prompt", { sessionID: "p1", text: "start something new" })
    h.pushEvent({ type: "permission.asked", properties: { sessionID: "p1", id: "req-post" } })
    h.pushEvent({
      type: "permission.replied",
      properties: { sessionID: "p1", requestID: "req-post", reply: "once" },
    })
    await settle()
    assert.ok(
      !journalEntries(metricsDir).some((l) => l.type === "permission" && l.decision === "once"),
      "a post-reset ask must not be recorded as the plan ask",
    )
    // The gate is still red.
    await assert.rejects(() =>
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

/**
 * HIGH-2 per-session scoping: two sessions escalate and reply concurrently;
 * each reply applies only to its own session's plan gate (no cross-apply).
 */
test("reply: concurrent sessions do not cross-apply plan-gate replies", async () => {
  const { h, restore, metricsDir } = await bootWithPlan()
  try {
    await callPermission(h, "evaluate", { sessionID: "p1", action: "task" })
    await callPermission(h, "evaluate", { sessionID: "p2", action: "task" })
    h.pushEvent({ type: "permission.asked", properties: { sessionID: "p1", id: "req-1" } })
    h.pushEvent({ type: "permission.asked", properties: { sessionID: "p2", id: "req-2" } })
    // p1's human grants once; p2's human rejects.
    h.pushEvent({
      type: "permission.replied",
      properties: { sessionID: "p1", requestID: "req-1", reply: "once" },
    })
    h.pushEvent({
      type: "permission.replied",
      properties: { sessionID: "p2", requestID: "req-2", reply: "reject" },
    })
    await waitUntil(() =>
      journalEntries(metricsDir).some((l) => l.type === "permission" && l.decision === "once"),
    )
    // p1: the grant releases exactly one dispatch.
    await callTool(h, "execute.before", {
      tool: "task",
      sessionID: "p1",
      input: { agent: "executor", prompt: "do the work" },
    })
    // p2: its own reject (not p1's grant) holds the gate red.
    await assert.rejects(
      () =>
        callTool(h, "execute.before", {
          tool: "task",
          sessionID: "p2",
          input: { agent: "executor", prompt: "do the work" },
        }),
      (e: Error) => /no plan approval for "plan.md"/.test(e.message),
    )
  } finally {
    restore()
  }
})

/**
 * HIGH-2 recognition: a plan ask whose host echoes the evaluate handler's
 * message (but whose session escalation was not seen) is still recorded via
 * the message prefix, and the ask map stays bounded — evicting the oldest
 * recorded asks never drops a live recent one.
 */
test("reply: a message-prefixed plan ask is recorded and the map stays bounded", async () => {
  const { h, restore, metricsDir } = await bootWithPlan()
  try {
    // 51 recorded plan asks via the message prefix alone (no session): the
    // oldest are evicted past the 50 cap.
    for (let i = 1; i <= 51; i++) {
      h.pushEvent({
        type: "permission.asked",
        properties: {
          id: `old-${i}`,
          message: "turnstile: plan approval required — plan.md",
        },
      })
    }
    // The most recent ask (old-51) is live: its reply still matches.
    h.pushEvent({
      type: "permission.replied",
      properties: { sessionID: "p1", requestID: "old-51", reply: "once" },
    })
    await waitUntil(() =>
      journalEntries(metricsDir).some((l) => l.type === "permission" && l.decision === "once"),
    )
    // A stale evicted id is inert.
    h.pushEvent({
      type: "permission.replied",
      properties: { sessionID: "p1", requestID: "old-1", reply: "always" },
    })
    await settle()
    assert.ok(
      !journalEntries(metricsDir).some((l) => l.type === "permission" && l.decision === "always"),
    )
  } finally {
    restore()
  }
})

/**
 * The landing-gate ask map is bounded symmetrically with the plan-gate map:
 * past 50 recorded landing asks the oldest are evicted, and a recent one still
 * matches its reply. Mirrors the plan-ask bounded test for the
 * `landingGateAsks` bounder (the reviewer's unbounded-growth finding).
 */
test("reply: landing-gate asks stay bounded and a recent ask still matches", async () => {
  const { h, restore, metricsDir } = await bootLanding({ gitGates: { mode: "enforce" } })
  try {
    // 51 landing-prefix asks (the evaluate echo message shape), no latch needed.
    for (let i = 1; i <= 51; i++) {
      h.pushEvent({
        type: "permission.asked",
        properties: {
          id: `land-old-${i}`,
          message: "turnstile: push/PR requires a reviewer — landing",
        },
      })
    }
    // The most recent ask (land-old-51) is live: its once reply still matches.
    h.pushEvent({
      type: "permission.replied",
      properties: { sessionID: "p1", requestID: "land-old-51", reply: "once" },
    })
    await waitUntil(() =>
      journalEntries(metricsDir).some((l) => l.type === "permission" && l.decision === "once"),
    )
    // A stale evicted id is inert.
    h.pushEvent({
      type: "permission.replied",
      properties: { sessionID: "p1", requestID: "land-old-1", reply: "always" },
    })
    await settle()
    assert.ok(
      !journalEntries(metricsDir).some((l) => l.type === "permission" && l.decision === "always"),
    )
  } finally {
    restore()
  }
})

/** The awaiting-ask map is bounded: past 50 escalated parents the oldest
 * escalation markers are evicted, and a recent escalation still records. */
test("evaluate: the awaiting-ask map stays bounded across 51 escalations", async () => {
  const { h, restore, metricsDir } = await bootWithPlan()
  try {
    for (let i = 1; i <= 51; i++) {
      await callPermission(h, "evaluate", { sessionID: `e${i}`, action: "task" })
    }
    // The most recent escalation (e51) still records its ask and matches.
    h.pushEvent({ type: "permission.asked", properties: { sessionID: "e51", id: "req-e51" } })
    h.pushEvent({
      type: "permission.replied",
      properties: { sessionID: "e51", requestID: "req-e51", reply: "once" },
    })
    await waitUntil(() =>
      journalEntries(metricsDir).some((l) => l.type === "permission" && l.decision === "once"),
    )
    await callTool(h, "execute.before", {
      tool: "task",
      sessionID: "e51",
      input: { agent: "executor", prompt: "do the work" },
    })
  } finally {
    restore()
  }
})

/**
 * A `type:"plan" APPROVE` written from the prompt channel replays exactly like
 * a plan-reviewer verdict: the approval restores after restart and survives the
 * one-prompt grace, so the executor stays free across a restart.
 */
test("replay: a session-prompt PLAN APPROVE restores across restart with grace", async () => {
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
      source: "session-prompt",
      marker: APPROVAL,
    })}\n`,
  )
  const h = makeFakeHost()
  const prev = process.cwd()
  process.chdir(project)
  try {
    const setup = turnstile(h.host, { env: isolatedEnv(metricsDir), config: { metricsDir } })
    const dispose = (await setup(h.host)) as () => void
    // The first post-restart prompt is the grace prompt: the restored approval
    // survives it (mergeAfterReplay), exactly like a VERDICT: APPROVE verdict.
    await callSession(h, "prompt", { sessionID: "p1" })
    await callTool(h, "execute.before", {
      tool: "task",
      sessionID: "p1",
      input: { agent: "executor", prompt: "do the work" },
    })
    await callTool(h, "execute.before", {
      tool: "task",
      sessionID: "p1",
      input: { agent: "executor", prompt: "more work" },
    })
    // The session-prompt provenance is preserved in the journaled entry.
    assert.ok(
      journalEntries(metricsDir).some(
        (l) =>
          l.type === "plan" &&
          l.sessionID === "p1" &&
          l.result === "APPROVE" &&
          l.source === "session-prompt",
      ),
    )
    dispose()
  } finally {
    process.chdir(prev)
  }
})

/**
 * A repeat `git push` under `enforce` arms the pending-landing-ask latch via the
 * capability's `escalate`; the next `permission.evaluate` for that bash action
 * forces a landing ask off that live latch, naming the reviewer
 * requirement. The ask is journaled exactly once (by guardLanding's escalate
 * path — the evaluate handler stamps the consume, not a second ask). The arm is
 * ONE-SHOT: the first evaluate consumes it, so a second bash evaluate in the
 * TTL window is untouched (the next push re-blocks and re-arms).
 */
test("evaluate: a live pending-landing-ask arm forces the landing ask", async () => {
  const { h, metricsDir, restore } = await bootLanding({ gitGates: { mode: "enforce" } })
  try {
    // First push: no approval, first block under enforce → throws, records a block.
    await assert.rejects(
      () =>
        callTool(h, "execute.before", {
          tool: "bash",
          sessionID: "p1",
          input: { command: "git push origin main" },
        }),
      (e: unknown) => e instanceof BlockError,
    )
    // Repeat push: enforce arms the pending-landing-ask latch (escalate).
    await callTool(h, "execute.before", {
      tool: "bash",
      sessionID: "p1",
      input: { command: "git push origin main" },
    })
    // The bash evaluate arm forces the ask off the live latch — and consumes
    // it (one-shot: the ask attaches to the repeat push the guard allowed
    // through for escalation, so a later unrelated command cannot be
    // mislabeled inside the TTL window).
    for (const action of ["bash"] as const) {
      const event: Record<string, any> = { sessionID: "p1", action }
      await callPermission(h, "evaluate", event)
      assert.equal(event.effect, "ask")
      assert.equal(event.message, `turnstile: ${LANDING_REQUIREMENT}`)
    }
    // The arm is one-shot: a second bash evaluate inside the TTL window is
    // untouched (no latch), fail-toward-strict — the next push re-blocks and
    // re-arms.
    const second: Record<string, any> = { sessionID: "p1", action: "bash" }
    await callPermission(h, "evaluate", second)
    assert.equal(second.effect, undefined)
    // Count the ask record (action:"ask") only: the evaluate handler's
    // consume-stamp (event:"forced", no action) is a separate entry, so the
    // guard's landing ask is still the single ask record.
    const asks = journalEntries(metricsDir).filter(
      (l) => l.type === "permission" && l.reason === "landing" && l.action === "ask",
    )
    assert.equal(asks.length, 1, "the landing ask is journaled exactly once")
  } finally {
    restore()
  }
})

/**
 * A compliant reviewer delivery (a green gate and two unwaived reviewer
 * dispatches) credits the task with a `VERDICT: APPROVE`, so the landing arm
 * releases early: a bash evaluate returns without forcing an ask, even though
 * no pending-landing-ask latch is live.
 */
test("evaluate: an approved landing gate releases without forcing the ask", async () => {
  // flag flips the gate on a plain PASS; the task still needs two reviewer
  // dispatches before the verdict is credited.
  const { h, restore } = await bootLanding({
    gitGates: { mode: "enforce" },
    gateEvidence: "flag",
  })
  try {
    // Flip the gate green so the reviewer dispatches are counted.
    await callTool(h, "execute.after", {
      tool: "task",
      sessionID: "p1",
      input: { agent: "test-runner" },
      result: { output: "GATE: PASS tests=3 passed=3 failed=0\nrest" },
    })
    // Two unwaived reviewer dispatches count the ensemble to two.
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
    // A reviewer task-result delivery marks the parent approved. Parent-keyed
    // delivery (sessionID === parent) needs no async edge registration — the
    // session.created push is consumed asynchronously and would race this
    // synchronous delivery.
    await callTool(h, "execute.after", {
      tool: "task",
      sessionID: "p1",
      input: { agent: "reviewer" },
      result: { output: "VERDICT: APPROVE crit=0 high=0 med=0 low=0\n" },
    })
    const event: Record<string, any> = { sessionID: "p1", action: "bash" }
    await callPermission(h, "evaluate", event)
    assert.equal(event.effect, undefined)
  } finally {
    restore()
  }
})

/**
 * Latch expiry: a pending-landing-ask arm older than the TTL is dropped, so a
 * late `permission.evaluate` does not force the ask (fail-toward-strict: the
 * gate re-blocks). Mirrors the awaiting-plan-ask expiry test, using a frozen
 * clock aged past the TTL.
 */
test("evaluate: an expired pending-landing-ask arm does not force the ask", async () => {
  const { h, restore } = await bootLanding({ gitGates: { mode: "enforce" } })
  const realNow = Date.now
  let now = realNow()
  ;(Date as unknown as { now: () => number }).now = () => now
  try {
    // First push: block (frozen time used for its journal ts).
    await assert.rejects(() =>
      callTool(h, "execute.before", {
        tool: "bash",
        sessionID: "p1",
        input: { command: "git push origin main" },
      }),
    )
    // Repeat push: escalate arms the latch at frozen time `now`.
    await callTool(h, "execute.before", {
      tool: "bash",
      sessionID: "p1",
      input: { command: "git push origin main" },
    })
    // Age the latch past the pending-landing-ask TTL.
    now += 6001
    const event: Record<string, any> = { sessionID: "p1", action: "bash" }
    await callPermission(h, "evaluate", event)
    assert.equal(event.effect, undefined, "an expired arm arms nothing")
  } finally {
    ;(Date as unknown as { now: () => number }).now = realNow
    restore()
  }
})

/**
 * A bash evaluate with NO landing latch at all (never armed) falls through the
 * landing arm untouched: `hasReviewApprove` false, `hasLiveLandingAsk` false
 * on the never-latched direction (`at === undefined`). No effect is forced.
 */
test("evaluate: a bash action with no landing latch is left untouched", async () => {
  const { h, restore } = await bootLanding({ gitGates: { mode: "enforce" } })
  try {
    const event: Record<string, any> = { sessionID: "p1", action: "bash" }
    await callPermission(h, "evaluate", event)
    assert.equal(event.effect, undefined, "no latch means no ask")
  } finally {
    restore()
  }
})

/**
 * The evaluate handler falls through to a no-op for an action neither `task`
 * (plan gate) nor `bash`/`shell` (landing gate): the landing arm never drives
 * it, so the event is left untouched and the fall-through return is reached.
 */
test("evaluate: an unrelated action is left untouched", async () => {
  const { h, restore } = await bootLanding()
  try {
    const event: Record<string, any> = { sessionID: "p1", action: "write" }
    await callPermission(h, "evaluate", event)
    assert.equal(event.effect, undefined)
  } finally {
    restore()
  }
})

/**
 * The pending-landing-ask map is bounded: past 50 armed parents the oldest arms
 * are evicted by `boundLandingAsks`, and the 51st arm still records (a recent
 * escalation stays live). Each armed parent is a repeat `git push` under
 * enforce — its first push records a block so the second escalates. The most
 * recent arm (p051) is still live and forces the ask.
 */
test("evaluate: the pending-landing-ask map stays bounded across 51 arms", async () => {
  const { h, restore } = await bootLanding({ gitGates: { mode: "enforce" } })
  try {
    for (let i = 1; i <= 51; i++) {
      const parent = `p${String(i).padStart(3, "0")}`
      // First push: first block → records a landing block (landingBlocks = 1).
      await assert.rejects(() =>
        callTool(h, "execute.before", {
          tool: "bash",
          sessionID: parent,
          input: { command: "git push origin main" },
        }),
      )
      // Second push: repeat → arms the pending-landing-ask latch.
      await callTool(h, "execute.before", {
        tool: "bash",
        sessionID: parent,
        input: { command: "git push origin main" },
      })
    }
    // The most recent arm (p051) survived eviction and forces the ask.
    const event: Record<string, any> = { sessionID: "p051", action: "bash" }
    await callPermission(h, "evaluate", event)
    assert.equal(event.effect, "ask")
  } finally {
    restore()
  }
})

/**
 * The landing escalation echo with an empty message (the evaluate handler's
 * escalate, whose ask rides the pending-landing-ask latch) is recorded for the
 * landing gate: its `once` reply grants exactly one push, and the next `git
 * push` is released by the `.landing` once-grant short-circuit before the gate
 * decides. The landing-ask recording is the empty-message sibling of the
 * plan-gate escalate echo (different prefix, disjoint map).
 */
test("asked: an empty-message landing escalate echo grants one push via the .landing short-circuit", async () => {
  const { h, metricsDir, restore } = await bootLanding({ gitGates: { mode: "enforce" } })
  try {
    // First push: first block under enforce throws, records one landing block.
    await assert.rejects(
      () =>
        callTool(h, "execute.before", {
          tool: "bash",
          sessionID: "p1",
          input: { command: "git push origin main" },
        }),
      (e: unknown) => e instanceof BlockError,
    )
    // Repeat push: enforce arms the pending-landing-ask latch (escalate).
    await callTool(h, "execute.before", {
      tool: "bash",
      sessionID: "p1",
      input: { command: "git push origin main" },
    })
    // An empty-message permission.asked (the escalate echo) with the latch live
    // is recorded for the landing gate; its once reply grants one push.
    h.pushEvent({ type: "permission.asked", properties: { sessionID: "p1", id: "land-1" } })
    h.pushEvent({
      type: "permission.replied",
      properties: { sessionID: "p1", requestID: "land-1", reply: "once" },
    })
    await waitUntil(() =>
      journalEntries(metricsDir).some((l) => l.type === "permission" && l.decision === "once"),
    )
    // The next push releases via the consumed .landing once-grant short-circuit:
    // no second block — a recording failure would re-block under enforce.
    assert.doesNotThrow(() =>
      callTool(h, "execute.before", {
        tool: "bash",
        sessionID: "p1",
        input: { command: "git push origin main" },
      }),
    )
    // The grant is scoped to landing candidates: a NON-push bash command does
    // not consume it. Re-arm (the repeat push after the granted one journals
    // the ask and allows — the escalation UX), re-grant, run a non-push
    // command first (does not burn the grant), then the push (released by the
    // still-pending grant — a grant burned on `git status` would make this
    // push re-block).
    await callTool(h, "execute.before", {
      tool: "bash",
      sessionID: "p1",
      input: { command: "git push origin main" },
    })
    h.pushEvent({ type: "permission.asked", properties: { sessionID: "p1", id: "land-2" } })
    h.pushEvent({
      type: "permission.replied",
      properties: { sessionID: "p1", requestID: "land-2", reply: "once" },
    })
    await waitUntil(
      () =>
        journalEntries(metricsDir).some(
          (l) => l.type === "permission" && l.decision === "once" && l.sessionID === "p1",
        ) &&
        journalEntries(metricsDir).filter((l) => l.type === "permission" && l.decision === "once")
          .length >= 2,
    )
    assert.doesNotThrow(() =>
      callTool(h, "execute.before", {
        tool: "bash",
        sessionID: "p1",
        input: { command: "git status --porcelain" },
      }),
    )
    assert.doesNotThrow(() =>
      callTool(h, "execute.before", {
        tool: "bash",
        sessionID: "p1",
        input: { command: "git push origin main" },
      }),
    )
    const blocked = journalEntries(metricsDir).filter(
      (e) => e.type === "blocked" && e.reason === "no-landing-approval",
    )
    assert.equal(
      blocked.length,
      1,
      "the first push is the only landing block; the once grant released the next push",
    )
  } finally {
    restore()
  }
})

/**
 * A landing ask echoed with the evaluate handler's landing-ask prefix is
 * recorded for the landing gate (the disjoint-from-plan prefix branch), so its
 * `once` reply grants exactly one push via the `.landing` short-circuit. This
 * is the primary (message-bearing) landing-ask recording path, paired with the
 * empty-message escalate echo tested above.
 */
test("asked: a landing-prefix ask echo records the ask and its once reply grants one push", async () => {
  const { h, metricsDir, restore } = await bootLanding({ gitGates: { mode: "enforce" } })
  try {
    // First push: block. Repeat push: arm the pending-landing-ask latch.
    await assert.rejects(
      () =>
        callTool(h, "execute.before", {
          tool: "bash",
          sessionID: "p1",
          input: { command: "git push origin main" },
        }),
      (e: unknown) => e instanceof BlockError,
    )
    await callTool(h, "execute.before", {
      tool: "bash",
      sessionID: "p1",
      input: { command: "git push origin main" },
    })
    // The evaluate handler forces the ask with the landing-ask prefix; the host
    // echoes it back with that prefix, so the ask is recorded for the landing gate.
    h.pushEvent({
      type: "permission.asked",
      properties: { sessionID: "p1", id: "land-pfx", message: `turnstile: ${LANDING_REQUIREMENT}` },
    })
    h.pushEvent({
      type: "permission.replied",
      properties: { sessionID: "p1", requestID: "land-pfx", reply: "once" },
    })
    await waitUntil(() =>
      journalEntries(metricsDir).some((l) => l.type === "permission" && l.decision === "once"),
    )
    assert.doesNotThrow(() =>
      callTool(h, "execute.before", {
        tool: "bash",
        sessionID: "p1",
        input: { command: "git push origin main" },
      }),
    )
  } finally {
    restore()
  }
})

/**
 * An `always` landing reply stands a human approval: it sets reviewer approval,
 * so the landing gate releases and every subsequent push is allowed (the bash
 * guard sees the approval). Contrasts with the `once` and `reject` replies.
 */
test("reply: a landing always-grant stands a reviewer approval and releases the gate", async () => {
  const { h, metricsDir, restore } = await bootLanding({ gitGates: { mode: "enforce" } })
  try {
    await assert.rejects(
      () =>
        callTool(h, "execute.before", {
          tool: "bash",
          sessionID: "p1",
          input: { command: "git push origin main" },
        }),
      (e: unknown) => e instanceof BlockError,
    )
    await callTool(h, "execute.before", {
      tool: "bash",
      sessionID: "p1",
      input: { command: "git push origin main" },
    })
    h.pushEvent({ type: "permission.asked", properties: { sessionID: "p1", id: "land-a" } })
    h.pushEvent({
      type: "permission.replied",
      properties: { sessionID: "p1", requestID: "land-a", reply: "always" },
    })
    await waitUntil(() =>
      journalEntries(metricsDir).some((l) => l.type === "permission" && l.decision === "always"),
    )
    // The standing approval releases the landing gate: every push is allowed.
    assert.doesNotThrow(() =>
      callTool(h, "execute.before", {
        tool: "bash",
        sessionID: "p1",
        input: { command: "git push origin main" },
      }),
    )
    const blocked = journalEntries(metricsDir).filter(
      (e) => e.type === "blocked" && e.reason === "no-landing-approval",
    )
    assert.equal(
      blocked.length,
      1,
      "the always-grant released the landing gate after the first block",
    )
  } finally {
    restore()
  }
})

/**
 * A `reject` landing reply leaves the gate red (no standing approval): the next
 * attempt re-arms the landing ask instead of being allowed. Contrasts with the
 * `always` reply and confirms a reject never releases the landing gate.
 */
test("reply: a landing reject leaves the gate red and re-arms the ask", async () => {
  const { h, metricsDir, restore } = await bootLanding({ gitGates: { mode: "enforce" } })
  try {
    await assert.rejects(
      () =>
        callTool(h, "execute.before", {
          tool: "bash",
          sessionID: "p1",
          input: { command: "git push origin main" },
        }),
      (e: unknown) => e instanceof BlockError,
    )
    await callTool(h, "execute.before", {
      tool: "bash",
      sessionID: "p1",
      input: { command: "git push origin main" },
    })
    h.pushEvent({ type: "permission.asked", properties: { sessionID: "p1", id: "land-r" } })
    h.pushEvent({
      type: "permission.replied",
      properties: { sessionID: "p1", requestID: "land-r", reply: "reject" },
    })
    await waitUntil(() =>
      journalEntries(metricsDir).some((l) => l.type === "permission" && l.decision === "reject"),
    )
    // The gate is still red: a repeat attempt escalates (no throw on execute),
    // and the evaluate handler then forces the landing ask again.
    assert.doesNotThrow(() =>
      callTool(h, "execute.before", {
        tool: "bash",
        sessionID: "p1",
        input: { command: "git push origin main" },
      }),
    )
    const event: Record<string, any> = { sessionID: "p1", action: "bash" }
    await callPermission(h, "evaluate", event)
    assert.equal(event.effect, "ask", "a reject keeps the landing gate red and re-forces the ask")
  } finally {
    restore()
  }
})

/**
 * Unrecorded reply: a `permission.replied` whose non-empty `requestID`
 * is in neither recorded ask map journals exactly one `event:"unrecorded-reply"`
 * row — no action/decision, so the status PERM counters are untouched — and
 * mutates no gate state: the plan gate stays red and the next executor dispatch
 * still blocks (the inert reply released nothing).
 */
test("replied: a non-empty unrecorded requestID journals an unrecorded reply and holds the gate", async () => {
  const { h, restore, metricsDir } = await bootWithPlan()
  try {
    h.pushEvent({
      type: "permission.replied",
      properties: { sessionID: "p1", requestID: "ghost-1", reply: "always" },
    })
    await waitUntil(() =>
      journalEntries(metricsDir).some(
        (l) => l.type === "permission" && l.event === "unrecorded-reply",
      ),
    )
    const rows = journalEntries(metricsDir).filter(
      (l) => l.type === "permission" && l.event === "unrecorded-reply",
    )
    assert.equal(rows.length, 1, "exactly one unrecorded-reply row")
    const row = rows[0]
    assert.ok(row, "the unrecorded-reply row is present")
    assert.equal(row.requestID, "ghost-1")
    assert.equal(row.sessionID, "p1")
    assert.equal(row.action, undefined, "carries no action (status-inert)")
    assert.equal(row.decision, undefined, "carries no decision (status-inert)")
    // The gate is still red: the inert reply released nothing, so the next
    // executor dispatch still blocks.
    await assert.rejects(() =>
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

/**
 * Empty-rid silence: a `permission.replied` with no `requestID` resolves
 * to an empty rid that takes the `rid !== ""` guard's false side, so it journals
 * no `unrecorded-reply` row — the distinct broken-host case stays silent.
 */
test("replied: a requestID-less reply journals no unrecorded-reply row", async () => {
  const { h, restore, metricsDir } = await bootWithPlan()
  try {
    h.pushEvent({ type: "permission.replied", properties: { sessionID: "p1" } })
    await settle()
    assert.ok(
      !journalEntries(metricsDir).some(
        (l) => l.type === "permission" && l.event === "unrecorded-reply",
      ),
      "a requestID-less reply must not journal an unrecorded-reply row",
    )
  } finally {
    restore()
  }
})

/**
 * Latch-steal: an empty-message `permission.asked` that wins a live
 * `awaitingPlanAsk` latch over the prefixed escalate echo journals an
 * `event:"latch-steal"` row (no action, so status-inert) alongside the guard's
 * `action:"ask"` plan-gate record.
 */
test("asked: an empty-message ask that wins a live plan latch journals a latch-steal", async () => {
  const { h, restore, metricsDir } = await bootWithPlan()
  try {
    // Escalate a red plan gate: arms the latch and journals the guard ask.
    await callPermission(h, "evaluate", { sessionID: "p1", action: "task" })
    // An empty-message ask wins the live latch (the steal-able window).
    h.pushEvent({ type: "permission.asked", properties: { sessionID: "p1", id: "steal-1" } })
    await waitUntil(() =>
      journalEntries(metricsDir).some((l) => l.type === "permission" && l.event === "latch-steal"),
    )
    const steals = journalEntries(metricsDir).filter(
      (l) => l.type === "permission" && l.event === "latch-steal",
    )
    assert.equal(steals.length, 1, "exactly one latch-steal row")
    const steal = steals[0]
    assert.ok(steal, "the latch-steal row is present")
    assert.equal(steal.sessionID, "p1")
    assert.equal(steal.reason, "plan-gate")
    assert.equal(steal.action, undefined, "carries no action (status-inert)")
    // The guard's own ask record (action:"ask") is the co-present PERM-ask row.
    assert.ok(
      journalEntries(metricsDir).some(
        (l) => l.type === "permission" && l.action === "ask" && l.reason === "plan-gate",
      ),
      "the guard's plan-gate ask record is present",
    )
  } finally {
    restore()
  }
})

/**
 * Prefixed-echo silence: a `permission.asked` whose message carries the
 * plan-ask prefix (the normal escalate echo) takes the `prefixed` owner branch,
 * so the `!prefixed` sub-branch is false and no `latch-steal` row journals.
 */
test("asked: a prefixed plan-ask echo journals no latch-steal", async () => {
  const { h, restore, metricsDir } = await bootWithPlan()
  try {
    await callPermission(h, "evaluate", { sessionID: "p1", action: "task" })
    // The prefixed echo (what the evaluate handler composes) is the normal
    // owner — no steal.
    h.pushEvent({
      type: "permission.asked",
      properties: {
        sessionID: "p1",
        id: "pfx-1",
        message: `${PLAN_ASK_MESSAGE_PREFIX} — plan.md: Some plan body text.`,
      },
    })
    await settle()
    assert.ok(
      !journalEntries(metricsDir).some((l) => l.type === "permission" && l.event === "latch-steal"),
      "a prefixed plan-ask echo must not journal a latch-steal row",
    )
  } finally {
    restore()
  }
})

/**
 * Forced-ask stamp: the `permission.evaluate` landing arm that consumes a
 * live `pendingLandingAsk` latch forces the ask and journals an `event:"forced"`
 * stamp — deliberately with no `action:"ask"` field, so the guard's landing-ask
 * record stays the single PERM-ask entry status.mjs counts.
 */
test("evaluate: the landing consume stamps event:forced with no action:ask", async () => {
  const { h, metricsDir, restore } = await bootLanding({ gitGates: { mode: "enforce" } })
  try {
    // First push: first block under enforce throws.
    await assert.rejects(
      () =>
        callTool(h, "execute.before", {
          tool: "bash",
          sessionID: "p1",
          input: { command: "git push origin main" },
        }),
      (e: unknown) => e instanceof BlockError,
    )
    // Repeat push: enforce arms the one-shot pending-landing-ask latch.
    await callTool(h, "execute.before", {
      tool: "bash",
      sessionID: "p1",
      input: { command: "git push origin main" },
    })
    // The bash evaluate arm forces the ask off the live latch.
    const event: Record<string, any> = { sessionID: "p1", action: "bash" }
    await callPermission(h, "evaluate", event)
    assert.equal(event.effect, "ask")
    assert.equal(event.message, `turnstile: ${LANDING_REQUIREMENT}`)
    const forced = journalEntries(metricsDir).filter(
      (l) => l.type === "permission" && l.event === "forced",
    )
    assert.equal(forced.length, 1, "exactly one forced-consume stamp")
    const stamp = forced[0]
    assert.ok(stamp, "the forced-consume stamp is present")
    assert.equal(stamp.sessionID, "p1")
    assert.equal(stamp.reason, "landing")
    assert.equal(stamp.action, undefined, "the forced stamp carries no action:ask")
  } finally {
    restore()
  }
})

/**
 * Status-inert regression: the three `permission` telemetry sub-kinds
 * carry neither `action:"ask"` nor a `decision`, so the scripts/status.mjs
 * PERM-ask and PERM-decision counters leave them untouched (the human PERM
 * table does not drift).
 */
test("status-inert: the three permission sub-kinds leave the PERM counters untouched", () => {
  const dir = tmpDir()
  try {
    fs.writeFileSync(
      path.join(dir, "turnstile.jsonl"),
      [
        JSON.stringify({
          ts: "t",
          type: "permission",
          sessionID: "s-inert",
          event: "latch-steal",
          reason: "plan-gate",
        }),
        JSON.stringify({
          ts: "t",
          type: "permission",
          sessionID: "s-inert",
          event: "forced",
          reason: "landing",
        }),
        JSON.stringify({
          ts: "t",
          type: "permission",
          sessionID: "s-inert",
          event: "unrecorded-reply",
          requestID: "ghost-1",
        }),
      ].join("\n") + "\n",
    )
    const res = spawnSync(process.execPath, [statusScript, "--json"], {
      env: { ...process.env, TURNSTILE_METRICS_DIR: dir },
      encoding: "utf8",
    })
    assert.equal(code(res), 0, "status.mjs exits 0")
    const obj = JSON.parse(res.stdout) as {
      sessions: Record<
        string,
        { permissionAsks: number; permissionDecisions: Record<string, number> }
      >
    }
    const s = obj.sessions["s-inert"]
    assert.ok(s, "the s-inert session is present in the status output")
    assert.equal(s.permissionAsks, 0, "no sub-kind counts as a PERM ask")
    assert.deepEqual(
      s.permissionDecisions,
      { once: 0, always: 0, reject: 0 },
      "no sub-kind counts as a PERM decision",
    )
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

/**
 * Fail-open unchanged: a malformed `permission.replied` payload (a
 * `requestID` that throws on access) is caught by the outer per-event handler
 * and journaled as an `event permission.replied:` error — the stream survives
 * and a subsequent normal reply still journals (here, an unrecorded reply).
 */
test("fail-open: a throwing permission.replied payload journals the event error and the stream survives", async () => {
  const { h, restore, metricsDir } = await bootWithPlan()
  try {
    // A requestID getter that throws trips the outer per-event catch.
    h.pushEvent({
      type: "permission.replied",
      properties: {
        get requestID() {
          throw new Error("boom")
        },
      },
    })
    await waitUntil(() =>
      journalEntries(metricsDir).some(
        (l) => l.type === "error" && /^event permission\.replied: /.test(String(l.error)),
      ),
    )
    // The stream survived the per-event failure: a later normal reply still
    // journals (its unrecorded requestID now records an unrecorded reply).
    h.pushEvent({
      type: "permission.replied",
      properties: { sessionID: "p1", requestID: "ghost-2", reply: "always" },
    })
    await waitUntil(() =>
      journalEntries(metricsDir).some(
        (l) =>
          l.type === "permission" && l.event === "unrecorded-reply" && l.requestID === "ghost-2",
      ),
    )
  } finally {
    restore()
  }
})
