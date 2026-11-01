/**
 * @fileoverview Plan-impact advisory tests: the hook-level wiring that
 * replaces the parent-hands-on block with a journaled classification while a
 * plan is bound — allow+advisory for overlapping write/edit and gate-tier
 * bash, silent allow for non-overlapping targets, strict-mode fall-through
 * to the hands-on block for structural overlap, the unengaged and no-plan
 * no-ops, the fail-open missing-plan case, and the replay-inert fold of the
 * `plan-impact` journal entry.
 */

import { test } from "node:test"
import assert from "node:assert/strict"
import * as fs from "node:fs"
import * as path from "node:path"

import { turnstile } from "../turnstile.ts"
import { BlockError } from "../src/gates.ts"
import { createHooksCore } from "../src/hooks-core.ts"
import { createLedger } from "../src/ledger.ts"
import {
  callTool,
  isolatedEnv,
  journalEntries,
  makeFakeHost,
  tmpDir,
  type FakeHost,
} from "./helpers.ts"

/** A plan whose spec region names an advisory file and a Decomposition file. */
const PLAN_BODY = [
  "# Progress",
  "",
  "- [x] planned",
  "",
  "# Objective",
  "",
  "Update `/repo/README.md` to describe the feature.",
  "",
  "## Decomposition",
  "",
  "- chunk-1: rewrite `/repo/src/ledger.ts`",
].join("\n")

/**
 * Boots a temp project with one plan file and the plugin over a fake host.
 * When `bindPlan` is set, the metrics journal is pre-seeded with a bound
 * plan approval for parent `p1` before setup, so replay restores
 * `activePlan: "plan.md"` (the same binding route the ledger tests use).
 * @param opts Boot options: `planBody` ("" seeds no plan file), `strict`
 *     sets `planImpactStrict: true`, `alwaysEnforce` arms from the first
 *     prompt (default true), `bindPlan` pre-seeds the bound approval.
 * @returns The host tables, metrics dir, project dir, and a restoring disposer.
 */
async function bootImpact(
  opts: {
    planBody?: string
    strict?: boolean
    alwaysEnforce?: boolean
    bindPlan?: boolean
  } = {},
): Promise<{
  h: FakeHost
  metricsDir: string
  project: string
  restore: () => void
}> {
  const project = tmpDir()
  if (opts.planBody !== "") {
    fs.mkdirSync(path.join(project, ".opencode", "plans"), { recursive: true })
    fs.writeFileSync(
      path.join(project, ".opencode", "plans", "plan.md"),
      opts.planBody ?? PLAN_BODY,
    )
  }
  const metricsDir = tmpDir()
  if (opts.bindPlan) {
    fs.writeFileSync(
      path.join(metricsDir, "turnstile.jsonl"),
      JSON.stringify({
        ts: "t",
        type: "plan",
        sessionID: "p1",
        result: "APPROVE",
        plan: "plan.md",
      }) + "\n",
    )
  }
  const h = makeFakeHost()
  const prev = process.cwd()
  process.chdir(project)
  const setup = turnstile(h.host, {
    env: isolatedEnv(metricsDir),
    config: {
      metricsDir,
      alwaysEnforce: opts.alwaysEnforce ?? true,
      ...(opts.strict ? { planImpactStrict: true } : {}),
    },
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

/** The journaled `plan-impact` rows of a metrics dir. */
function impactRows(metricsDir: string): Array<Record<string, any>> {
  return journalEntries(metricsDir).filter((e) => e.type === "plan-impact")
}

/** The journaled `parent-hands-on` blocks of a metrics dir. */
function handsOnBlocks(metricsDir: string): Array<Record<string, any>> {
  return journalEntries(metricsDir).filter(
    (e) => e.type === "blocked" && e.reason === "parent-hands-on",
  )
}

/**
 * B1 + AC-2: with a plan bound and the session engaged, a write to a path
 * the plan never names is allowed with no plan-impact row and no hands-on
 * block (the advisory arms only on overlap).
 */
test("plan-impact: non-overlapping write allows with no row and no block", async () => {
  const { h, metricsDir, restore } = await bootImpact({ bindPlan: true })
  try {
    await callTool(h, "execute.before", {
      tool: "write",
      sessionID: "p1",
      input: { filePath: "/repo/src/unrelated.ts" },
    })
    assert.equal(impactRows(metricsDir).length, 0, "no plan-impact row for a non-overlap")
    assert.equal(handsOnBlocks(metricsDir).length, 0, "no hands-on block either")
  } finally {
    restore()
  }
})

/**
 * B2 + AC-1 + AC-3: an overlapping write is allowed, journals one
 * `plan-impact` row naming the plan with impact `advisory`, and the next
 * task delivery prepends the stale-steps advisory text.
 */
test("plan-impact: overlapping write allows, journals, and prepends the advisory", async () => {
  const { h, metricsDir, restore } = await bootImpact({ bindPlan: true })
  try {
    await callTool(h, "execute.before", {
      tool: "write",
      sessionID: "p1",
      input: { filePath: "/repo/README.md" },
    })
    const rows = impactRows(metricsDir)
    assert.equal(rows.length, 1, "one plan-impact row")
    assert.equal(rows[0]!.impact, "advisory")
    assert.equal(rows[0]!.plan, "plan.md")
    assert.equal(rows[0]!.tool, "write")
    assert.equal(handsOnBlocks(metricsDir).length, 0, "the hands-on block is replaced")
    // The advisory rides the parent's next task delivery.
    await h.pushEvent({
      type: "session.created",
      properties: { sessionID: "c1", parentID: "p1", agent: "executor" },
    })
    const event: any = {
      tool: "task",
      sessionID: "c1",
      input: { agent: "executor" },
      result: { output: "chunk done\n" },
    }
    await callTool(h, "execute.after", event)
    assert.ok(
      String(event.result.output).includes("[turnstile] plan-impact:"),
      "the advisory is prepended to the delivery",
    )
    assert.ok(
      String(event.result.output).indexOf("[turnstile] plan-impact:") <
        String(event.result.output).indexOf("chunk done"),
      "the advisory precedes the original delivery text",
    )
    assert.match(String(event.result.output), /plan "plan.md"/)
    // One-shot: a second delivery carries no advisory.
    const event2: any = {
      tool: "task",
      sessionID: "c1",
      input: { agent: "executor" },
      result: { output: "more\n" },
    }
    await callTool(h, "execute.after", event2)
    assert.ok(!String(event2.result.output).includes("plan-impact:"), "one-shot consumption")
  } finally {
    restore()
  }
})

/**
 * B3: a Decomposition-section target under the default (non-strict) config
 * is allowed with a `structural` row and the replan advisory text.
 */
test("plan-impact: structural overlap allows with the structural row and text", async () => {
  const { h, metricsDir, restore } = await bootImpact({ bindPlan: true })
  try {
    await callTool(h, "execute.before", {
      tool: "edit",
      sessionID: "p1",
      input: { filePath: "/repo/src/ledger.ts" },
    })
    const rows = impactRows(metricsDir)
    assert.equal(rows.length, 1)
    assert.equal(rows[0]!.impact, "structural")
    assert.equal(handsOnBlocks(metricsDir).length, 0)
    await h.pushEvent({
      type: "session.created",
      properties: { sessionID: "c1", parentID: "p1", agent: "executor" },
    })
    const event: any = {
      tool: "task",
      sessionID: "c1",
      input: { agent: "executor" },
      result: { output: "done\n" },
    }
    await callTool(h, "execute.after", event)
    assert.match(String(event.result.output), /replan is required/)
  } finally {
    restore()
  }
})

/**
 * B4 + AC-4: `planImpactStrict: true` restores the parent-hands-on block for
 * structural overlap, with the plan-impact row journaled before the throw.
 */
test("plan-impact: structural + strict falls through to the hands-on block", async () => {
  const { h, metricsDir, restore } = await bootImpact({ bindPlan: true, strict: true })
  try {
    await assert.rejects(
      () =>
        callTool(h, "execute.before", {
          tool: "edit",
          sessionID: "p1",
          input: { filePath: "/repo/src/ledger.ts" },
        }),
      (e: unknown) => e instanceof BlockError,
    )
    const rows = impactRows(metricsDir)
    assert.equal(rows.length, 1, "the classification row is journaled before the block")
    assert.equal(rows[0]!.impact, "structural")
    assert.equal(handsOnBlocks(metricsDir).length, 1, "the hands-on block is restored")
  } finally {
    restore()
  }
})

/**
 * B5 + AC-7 (dormant): with the session unengaged the classifier never runs
 * — no plan-impact row, and the hands-on ladder stays asleep per #246.
 */
test("plan-impact: unengaged session never classifies", async () => {
  const { h, metricsDir, restore } = await bootImpact({ bindPlan: true, alwaysEnforce: false })
  try {
    await callTool(h, "execute.before", {
      tool: "write",
      sessionID: "p1",
      input: { filePath: "/repo/src/ledger.ts" },
    })
    assert.equal(impactRows(metricsDir).length, 0)
    assert.equal(handsOnBlocks(metricsDir).length, 0)
  } finally {
    restore()
  }
})

/**
 * AC-7 (no plan bound): with no plan bound the hands-on behavior is
 * unchanged — the first parent write blocks exactly as before and no
 * plan-impact row appears.
 */
test("plan-impact: no plan bound keeps the hands-on block unchanged", async () => {
  const { h, metricsDir, restore } = await bootImpact({ planBody: "" })
  try {
    await assert.rejects(
      () =>
        callTool(h, "execute.before", {
          tool: "write",
          sessionID: "p1",
          input: { filePath: "/repo/src/ledger.ts" },
        }),
      (e: unknown) => e instanceof BlockError,
    )
    assert.equal(impactRows(metricsDir).length, 0)
    assert.equal(handsOnBlocks(metricsDir).length, 1)
  } finally {
    restore()
  }
})

/**
 * A3 (fail-open): a bound plan whose file has disappeared classifies "none"
 * — the write is allowed, no row, no block (the resolution error path).
 */
test("plan-impact: a missing bound plan file fails open to none", async () => {
  const { h, metricsDir, project, restore } = await bootImpact({ planBody: "", bindPlan: true })
  try {
    // planBody "" seeded no plan file; the bound approval still replays.
    assert.ok(!fs.existsSync(path.join(project, ".opencode", "plans")))
    await callTool(h, "execute.before", {
      tool: "write",
      sessionID: "p1",
      input: { filePath: "/repo/src/ledger.ts" },
    })
    assert.equal(impactRows(metricsDir).length, 0)
    assert.equal(handsOnBlocks(metricsDir).length, 0)
  } finally {
    restore()
  }
})

/**
 * B6: a gate-tier write-shaped bash command naming a scope path mirrors the
 * advisory arm (allowed, journaled, advisory stashed); a telemetry-tier
 * command never classifies.
 */
test("plan-impact: gate-tier bash classifies by command text, telemetry tier does not", async () => {
  const { h, metricsDir, restore } = await bootImpact({ bindPlan: true })
  try {
    // Gate-tier writer shape (`cp`) naming a Decomposition file: allowed.
    await callTool(h, "execute.before", {
      tool: "bash",
      sessionID: "p1",
      input: { command: "cp /repo/src/ledger.ts /tmp/backup.ts" },
    })
    const rows = impactRows(metricsDir)
    assert.equal(rows.length, 1)
    assert.equal(rows[0]!.impact, "structural")
    assert.equal(rows[0]!.tool, "bash")
    assert.equal(handsOnBlocks(metricsDir).length, 0)
    // Telemetry-tier shape (output capture): never classifies.
    await callTool(h, "execute.before", {
      tool: "bash",
      sessionID: "p1",
      input: { command: "npm test > /repo/src/ledger.ts.log" },
    })
    assert.equal(impactRows(metricsDir).length, 1, "the telemetry-tier command added no row")
  } finally {
    restore()
  }
})

/**
 * B7 + AC-5: a `plan-impact` journal line folds replay-inert — no
 * suppressed-drop telemetry and no gate-state mutation.
 */
test("plan-impact: replay folds the row inertly", () => {
  const metricsDir = tmpDir()
  const journalPath = path.join(metricsDir, "turnstile.jsonl")
  fs.writeFileSync(
    journalPath,
    JSON.stringify({
      ts: "t",
      type: "plan-impact",
      sessionID: "p1",
      tool: "write",
      plan: "plan.md",
      impact: "advisory",
      path: "README.md",
    }) + "\n",
  )
  const ledger = createLedger(journalPath, 64, 2000)
  // The inert fold must not create or mutate the session's gate state.
  assert.equal(ledger.peek("p1"), undefined, "the inert fold leaves no gate state")
  // No suppressed replay-drop telemetry was appended for the row.
  const lines = fs.readFileSync(journalPath, "utf8").trim().split("\n")
  assert.equal(lines.length, 1, "no suppressed row appended")
  assert.equal(impactRows(metricsDir).length, 1)
})

/**
 * Fail-open: a classification error (the gate service throwing) journals the
 * error row and falls through to the hands-on ladder — never a silent allow.
 */
test("plan-impact: a throwing classification journals and proceeds to the hands-on ladder", () => {
  const metricsDir = tmpDir()
  const project = tmpDir()
  fs.mkdirSync(path.join(project, ".opencode", "plans"), { recursive: true })
  fs.writeFileSync(path.join(project, ".opencode", "plans", "plan.md"), PLAN_BODY)
  fs.writeFileSync(
    path.join(metricsDir, "turnstile.jsonl"),
    JSON.stringify({ ts: "t", type: "plan", sessionID: "p1", result: "APPROVE", plan: "plan.md" }) +
      "\n",
  )
  const ctx = createHooksCore({
    env: isolatedEnv(metricsDir),
    config: { metricsDir, alwaysEnforce: true },
  })
  const prev = process.cwd()
  process.chdir(project)
  try {
    const original = ctx.gates.planImpact
    ctx.gates.planImpact = (): never => {
      throw new Error("gate boom")
    }
    let blocked: unknown
    try {
      ctx.handleWriteEditDispatch(
        { sessionID: "p1", input: { filePath: "/repo/README.md" } } as never,
        "write",
      )
    } catch (e) {
      blocked = e
    } finally {
      ctx.gates.planImpact = original
    }
    const errors = journalEntries(metricsDir).filter(
      (e) => e.type === "error" && String(e.error).startsWith("plan-impact: "),
    )
    assert.equal(errors.length, 1, "the classification error is journaled")
    assert.ok(blocked instanceof BlockError, "the hands-on ladder still runs after the error")
  } finally {
    process.chdir(prev)
  }
})

/**
 * Fail-open: a throwing advisory prepend (a delivery result that rejects
 * assignment) journals the error row and the delivery proceeds.
 */
test("plan-impact: a throwing advisory prepend journals and never throws", async () => {
  const { h, metricsDir, restore } = await bootImpact({ bindPlan: true })
  try {
    await callTool(h, "execute.before", {
      tool: "write",
      sessionID: "p1",
      input: { filePath: "/repo/README.md" },
    })
    assert.equal(impactRows(metricsDir).length, 1, "the classification row is journaled")
    // Register the child edge so the delivery resolves to the parent the
    // advisory is keyed by.
    await h.pushEvent({
      type: "session.created",
      properties: { sessionID: "c1", parentID: "p1", agent: "executor" },
    })
    // A result whose output reads as a string but rejects assignment
    // (getter-only property, strict mode) — the prepend throws fail-open.
    const result: Record<string, unknown> = {}
    Object.defineProperty(result, "output", { get: () => "body" })
    await callTool(h, "execute.after", {
      tool: "task",
      sessionID: "c1",
      input: { agent: "executor" },
      result,
    } as never)
    const errors = journalEntries(metricsDir).filter(
      (e) => e.type === "error" && String(e.error).startsWith("plan-impact advisory: "),
    )
    assert.equal(errors.length, 1, "the prepend error is journaled")
  } finally {
    restore()
  }
})

/**
 * The `planImpactFor` boundary's own fail-open arms, exercised directly: an
 * empty active plan, a plans dir without the bound plan, and an unreadable
 * plan file each classify "none" (the unreadable case journaling the fs
 * error).
 */
test("plan-impact: planImpactFor fails open on an empty plan, a missing plan, and an unreadable plan", () => {
  const metricsDir = tmpDir()
  const project = tmpDir()
  const plansDir = path.join(project, ".opencode", "plans")
  fs.mkdirSync(plansDir, { recursive: true })
  fs.writeFileSync(path.join(plansDir, "plan.md"), PLAN_BODY)
  const ctx = createHooksCore({
    env: isolatedEnv(metricsDir),
    config: { metricsDir, alwaysEnforce: true },
  })
  assert.equal(ctx.gates.planImpact(project, "", "/repo/a.ts", false), "none", "no plan bound")
  assert.equal(
    ctx.gates.planImpact(project, "other.md", "/repo/a.ts", false),
    "none",
    "the bound plan is absent from the dir",
  )
  // An unreadable "plan file": a directory where readFileSync expects bytes.
  fs.rmSync(path.join(plansDir, "plan.md"))
  fs.mkdirSync(path.join(plansDir, "plan.md"))
  assert.equal(
    ctx.gates.planImpact(project, "plan.md", "/repo/a.ts", false),
    "none",
    "an unreadable plan file fails open",
  )
  const errors = journalEntries(metricsDir).filter(
    (e) => e.type === "error" && String(e.error).startsWith("plans dir unreadable: "),
  )
  // Only the unreadable read fails loudly (the absent-name case returns
  // before any fs error).
  assert.equal(errors.length, 1, "the unreadable-plan fs error is journaled")
})
