/**
 * @fileoverview Prompt-channel user-waiver tests: the waiver
 * must provably originate from the user's PROMPT, captured in the setup
 * `prompt` hook and stored on `ledger.state().userWaiver`, then read by BOTH
 * the reviewer and plan gates. A dispatch-prompt `USER WAIVER:` is inert.
 * Covers candidate-key coercion (`text` vs `prompt`), misconfiguration
 * telemetry, trace redaction of the waiver quote, task-scoped expiry on reset,
 * and the reviewer gate's per-dispatch consumption.
 */

import { test } from "node:test"
import assert from "node:assert/strict"
import * as fs from "node:fs"
import * as path from "node:path"

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

/** The literal waiver marker (default `waiverMarker`). */
const WAIVER = "USER WAIVER:"

/** The exact reviewer gate no-gate-pass message (reworded waiver phrase). */
const NO_GATE_MESSAGE =
  "BLOCKED by turnstile: no reviewer dispatch before the test gate is green. " +
  "Run the test-runner subagent first; dispatch reviewer only after its first line is " +
  "`GATE: PASS tests=<n> passed=<n> failed=<n>`, or obtain an explicit user waiver " +
  "(a user prompt this task must contain the literal marker 'USER WAIVER:' followed by the user's words)."

/** The exact plan-approval message (reworded waiver phrase). */
const NO_PLAN_MESSAGE =
  `BLOCKED by turnstile: no plan approval for "plan.md". Dispatch the plan-reviewer subagent first; proceed with executor only after the plan-reviewer's first line is ` +
  "`VERDICT: APPROVE crit=<n> high=<n> med=<n> low=<n>`, or obtain an explicit user waiver " +
  "(a user prompt this task must contain the literal marker 'USER WAIVER:' followed by the user's words)."

/** The clause a block appends when the task's unscoped waiver was already
 *  consumed by the first dispatch it unlocked. */
const CONSUMED_CLAUSE =
  " The task's unscoped user waiver was consumed by the first dispatch it unlocked; a new waiver is needed for the next dispatch."

/** The clause a round-limit block appends when a scoped waiver's own
 *  allowance of waiver-unblocked dispatches is exhausted. */
const ALLOWANCE_CLAUSE =
  " The scoped waiver's allowance of 2 waiver-unblocked dispatches is exhausted; obtain a new waiver or escalate to the user."

/** The clause a plan-gate block appends when the live waiver is scoped to a
 *  stage outside the plan gate's stage group (the reviewer stage here). */
const PLAN_OUT_OF_SCOPE_REVIEWER_CLAUSE =
  " A user waiver is live this task but is scoped to: reviewer — it does not cover this gate; name executor or plan-reviewer in a new waiver or escalate."

/** Boots the plugin over a fake host with a temp metrics dir. */
async function boot(
  config: Record<string, any> = {},
): Promise<{ h: FakeHost; dispose: () => void; metricsDir: string }> {
  const metricsDir = tmpDir()
  const h = makeFakeHost()
  const setup = turnstile(h.host, {
    env: isolatedEnv(metricsDir),
    config: { metricsDir, alwaysEnforce: true, ...config },
  })
  const dispose = (await setup(h.host)) as () => void
  return { h, dispose, metricsDir }
}

/** Boots in a temp project dir containing a plan file. */
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
    config: { metricsDir, alwaysEnforce: true },
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

/** Fires the prompt hook as the user would (admits a new task). */
async function prompt(h: FakeHost, sessionID: string, text: string): Promise<void> {
  await callSession(h, "prompt", { sessionID, text })
}

/** The last journal entry of a given (type, result) pair, or undefined. */
function lastWaived(metricsDir: string, type: string): Record<string, any> | undefined {
  return journalEntries(metricsDir)
    .filter((l) => l.type === type && l.result === "WAIVED")
    .at(-1)
}

/** A single prompt-channel waiver waives BOTH the reviewer and plan gates —
 *  the executor (plan) dispatch proceeds without a plan APPROVE, and the
 *  reviewer dispatch proceeds without a gate PASS — and each gate journals a
 *  WAIVED entry with `channel: "prompt"` provenance.
 *
 *  Order matters by design: the plan gate is task-sticky (it leaves the
 *  waiver live) while the reviewer gate consumes it per dispatch, so the
 *  executor dispatch must run first for the reviewer to still see the waiver. */
test("prompt-channel waiver waives both gates and journals channel:prompt", async () => {
  const { h, metricsDir, restore } = await bootWithPlan()
  try {
    // The waiver comes from the user prompt only; no dispatch carries the marker.
    await prompt(h, "p1", `${WAIVER} user said go now`)
    // Plan gate first: task-sticky, leaves the waiver live for the task.
    await callTool(h, "execute.before", {
      tool: "task",
      sessionID: "p1",
      input: { agent: "executor", prompt: "do the work" },
    })
    // Reviewer gate next: still sees the live waiver, then consumes it.
    await callTool(h, "execute.before", {
      tool: "task",
      sessionID: "p1",
      input: { agent: "reviewer", prompt: "review it" },
    })
    const gateWaived = journalEntries(metricsDir).find(
      (l) => l.type === "gate" && l.result === "WAIVED" && l.channel === "prompt",
    )
    const planWaived = journalEntries(metricsDir).find(
      (l) => l.type === "plan" && l.result === "WAIVED" && l.channel === "prompt",
    )
    assert.ok(gateWaived, "the reviewer gate journals a prompt-channel waiver")
    assert.ok(planWaived, "the plan gate journals a prompt-channel waiver")
    assert.equal(gateWaived?.waiver, `${WAIVER} user said go now`)
    assert.equal(planWaived?.waiver, `${WAIVER} user said go now`)
  } finally {
    restore()
  }
})

/**
 * Regression: a `USER WAIVER:` in the DISPATCH prompt is
 * inert. Both gates still block with their golden messages, and nothing is
 * journaled as waived — proving provenance is the prompt, not the dispatch.
 */
test("a USER WAIVER: in the dispatch prompt is inert; both gates block", async () => {
  const { h, metricsDir, restore } = await bootWithPlan()
  try {
    await assert.rejects(
      () =>
        callTool(h, "execute.before", {
          tool: "task",
          sessionID: "p1",
          input: { agent: "reviewer", prompt: "USER WAIVER: go" },
        }),
      (e: Error) => e.message === NO_GATE_MESSAGE,
    )
    await assert.rejects(
      () =>
        callTool(h, "execute.before", {
          tool: "task",
          sessionID: "p1",
          input: { agent: "executor", prompt: "USER WAIVER: go" },
        }),
      (e: Error) => e.message === NO_PLAN_MESSAGE,
    )
    assert.equal(
      journalEntries(metricsDir).filter((l) => l.result === "WAIVED").length,
      0,
      "no dispatch-prompt waiver is ever journaled",
    )
  } finally {
    restore()
  }
})

/** The waiver uses `text` when present and falls back to `prompt` otherwise. */
test("waiver capture coerces text, then prompt (candidate-key fallback)", async () => {
  // `text` wins when present.
  {
    const { h, metricsDir, dispose } = await boot()
    await callSession(h, "prompt", { sessionID: "p1", text: `${WAIVER} via text` })
    await callTool(h, "execute.before", {
      tool: "task",
      sessionID: "p1",
      input: { agent: "reviewer", prompt: "review it" },
    })
    const waived = lastWaived(metricsDir, "gate")
    assert.ok(waived)
    assert.equal(waived?.channel, "prompt")
    assert.equal(waiverQuote(waived), `${WAIVER} via text`)
    dispose()
  }
  // `prompt` is used when `text` is absent.
  {
    const { h, metricsDir, dispose } = await boot()
    await callSession(h, "prompt", { sessionID: "p2", prompt: `${WAIVER} via prompt` })
    await callTool(h, "execute.before", {
      tool: "task",
      sessionID: "p2",
      input: { agent: "reviewer", prompt: "review it" },
    })
    const waived = lastWaived(metricsDir, "gate")
    assert.ok(waived)
    assert.equal(waiverQuote(waived), `${WAIVER} via prompt`)
    dispose()
  }
})

/**
 * Misconfiguration telemetry: when NEITHER candidate text key is a string,
 * the prompt text is unresolvable. The first such prompt journals one
 * `type:"error"`; a second keyless prompt journals nothing (one-time).
 */
test("misconfiguration: one error after N keyless prompts (neither text nor prompt is a string)", async () => {
  const { h, metricsDir, dispose } = await boot()
  await callSession(h, "prompt", { sessionID: "p1" })
  await callSession(h, "prompt", { sessionID: "p1" })
  const misconfigs = journalEntries(metricsDir).filter(
    (l) => l.type === "error" && /waiver capture: neither prompt text key/.test(l.error),
  )
  assert.equal(
    misconfigs.length,
    1,
    "misconfiguration telemetry is emitted exactly once, after the first keyless prompt",
  )
  dispose()
})

/**
 * Fail-open: a malformed prompt value whose read throws (a hostile getter on
 * the payload) is journaled and swallowed; the prompt hook completes and never
 * throws at the host. A merely non-string candidate (e.g. an object `text`)
 * is skipped, not thrown on — only a genuinely unreadable payload journals.
 */
test("fail-open: a malformed prompt value is journaled, never thrown", async () => {
  const { h, metricsDir, dispose } = await boot()
  // A payload whose `text` read throws: the capture must journal, not throw.
  const bad: Record<string, unknown> = { sessionID: "p1" }
  Object.defineProperty(bad, "text", {
    get: () => {
      throw new Error("boom")
    },
  })
  // A plain non-string candidate is skipped silently (no throw, no journal).
  await callSession(h, "prompt", { sessionID: "p0", text: { toString: () => "x" } })
  let threw = false
  try {
    await callSession(h, "prompt", bad)
  } catch {
    threw = true
  }
  assert.equal(threw, false, "the prompt hook completes even when capture throws")
  const errs = journalEntries(metricsDir).filter(
    (l) => l.type === "error" && /waiver capture: Error: boom/.test(l.error),
  )
  assert.ok(errs.length >= 1, "the capture failure is journaled")
  dispose()
})

/** With trace:false the waiver quote is redacted to "<present>" in the journal. */
test("trace:false redacts the waiver quote to <present>", async () => {
  const { h, metricsDir, dispose } = await boot({ trace: false })
  await callSession(h, "prompt", { sessionID: "p1", text: `${WAIVER} sensitive words` })
  await callTool(h, "execute.before", {
    tool: "task",
    sessionID: "p1",
    input: { agent: "reviewer", prompt: "review it" },
  })
  const waived = lastWaived(metricsDir, "gate")
  assert.ok(waived)
  assert.equal(waiverQuote(waived), "<present>")
  dispose()
})

/**
 * A fresh prompt without the marker resets the task-scoped waiver, so a later
 * executor dispatch blocks again — the waiver does not outlive the task.
 */
test("waiver is task-scoped: a fresh prompt without the marker re-blocks", async () => {
  const { h, metricsDir, restore } = await bootWithPlan()
  try {
    await prompt(h, "p1", `${WAIVER} go`)
    await callTool(h, "execute.before", {
      tool: "task",
      sessionID: "p1",
      input: { agent: "executor", prompt: "do the work" },
    })
    assert.ok(lastWaived(metricsDir, "plan"), "the plan gate journal shows a waiver")
    // A new user prompt resets the task; the next dispatch is blocked again.
    await prompt(h, "p1", "new task with no waiver")
    await assert.rejects(
      () =>
        callTool(h, "execute.before", {
          tool: "task",
          sessionID: "p1",
          input: { agent: "executor", prompt: "do the work" },
        }),
      (e: Error) => e.message === NO_PLAN_MESSAGE,
    )
  } finally {
    restore()
  }
})

/**
 * The reviewer gate consumes an unscoped waiver on the first dispatch it
 * unlocks, and the re-block says so: the second reviewer dispatch re-blocks
 * with the no-gate-pass message plus the consumed-waiver clause (the task
 * waiver is not sticky for the reviewer gate).
 */
test("reviewer gate: the waiver is consumed per dispatch; a second reviewer dispatch re-blocks", async () => {
  const { h, metricsDir, dispose } = await boot()
  await prompt(h, "p1", `${WAIVER} go`)
  // First reviewer dispatch: waived and consumed.
  await callTool(h, "execute.before", {
    tool: "task",
    sessionID: "p1",
    input: { agent: "reviewer", prompt: "review it" },
  })
  const first = lastWaived(metricsDir, "gate")
  assert.ok(first)
  // Second reviewer dispatch: waiver consumed, gate not green -> no-gate-pass
  // block reporting the consumed waiver.
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

/**
 * The reviewer-scoped waiver completes the ensemble with one waiver: naming
 * the reviewer stage in the waiver text scopes it to that stage, so two
 * consecutive reviewer dispatches are admitted without a gate PASS (each
 * journalling a WAIVED entry carrying the parsed scope) without counting
 * toward the ensemble, and the third dispatch blocks on the waiver's own
 * allowance — not the ordinary round cap — and the refused dispatch journals
 * no WAIVED entry.
 */
test("reviewer-scoped waiver admits two ensemble dispatches, then blocks at its allowance", async () => {
  const { h, metricsDir, dispose } = await boot()
  await prompt(h, "p1", `${WAIVER} I approve proceeding to the reviewer agents`)
  // Both ensemble dispatches pass without a gate PASS.
  for (let i = 0; i < 2; i++) {
    await callTool(h, "execute.before", {
      tool: "task",
      sessionID: "p1",
      input: { agent: "reviewer", prompt: "review it" },
    })
  }
  const waived = journalEntries(metricsDir).filter(
    (l) => l.type === "gate" && l.result === "WAIVED",
  )
  assert.equal(waived.length, 2, "each scoped-waived dispatch journals a WAIVED entry")
  assert.ok(
    waived.every((l) => l.scope === "reviewer" && l.channel === "prompt"),
    "each WAIVED entry carries the parsed scope and the prompt channel",
  )
  assert.equal(
    journalEntries(metricsDir).filter((l) => l.type === "ensemble").length,
    0,
    "waived dispatches never count toward the ensemble",
  )
  // The third dispatch exhausts the scoped allowance (2 waiver-unblocked
  // dispatches) and blocks with the allowance clause.
  await assert.rejects(
    () =>
      callTool(h, "execute.before", {
        tool: "task",
        sessionID: "p1",
        input: { agent: "reviewer", prompt: "review it again" },
      }),
    (e: Error) =>
      e.message ===
      "BLOCKED by turnstile: reviewer round limit (2) reached — the pipeline is looping. STOP: do not re-dispatch the reviewer. Escalate the open findings to the user and wait for new instructions (a new task resets the cap)." +
        ALLOWANCE_CLAUSE,
  )
  // The refused dispatch journals no WAIVED entry: the count still reflects
  // only the two admitted dispatches.
  assert.equal(
    journalEntries(metricsDir).filter((l) => l.type === "gate" && l.result === "WAIVED").length,
    2,
    "the refused dispatch journals no WAIVED entry",
  )
  dispose()
})

/**
 * A waiver scoped to the reviewer stage does not open the plan gate: the
 * executor dispatch blocks, and the block reports the live waiver's scope and
 * names the stage group a new waiver would need to cover this gate.
 */
test("a reviewer-scoped waiver leaves the plan gate blocked with an out-of-scope report", async () => {
  const { h, restore } = await bootWithPlan()
  try {
    await prompt(h, "p1", `${WAIVER} I approve proceeding to the reviewer agents`)
    await assert.rejects(
      () =>
        callTool(h, "execute.before", {
          tool: "task",
          sessionID: "p1",
          input: { agent: "executor", prompt: "do the work" },
        }),
      (e: Error) => e.message === NO_PLAN_MESSAGE + PLAN_OUT_OF_SCOPE_REVIEWER_CLAUSE,
    )
  } finally {
    restore()
  }
})

/** The waiver quote carried by a WAIVED entry. */
function waiverQuote(entry: Record<string, any> | undefined): string {
  return entry?.waiver ?? ""
}
