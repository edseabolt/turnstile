/**
 * @fileoverview Permission-approval tests (Phase 1, issues #34/#35): the
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
import * as fs from "node:fs"
import * as path from "node:path"

import { turnstile } from "../turnstile.ts"
import { createGates } from "../src/gates.ts"
import { defaultConfig } from "../src/config.ts"
import { createJournaler } from "../src/journal.ts"
import { createLedger } from "../src/state.ts"
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
  })
  const ledger = createLedger(journaler.journalPath)
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
