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
import * as os from "node:os"
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
  "Update `README.md` to describe the feature.",
  "",
  "## Decomposition",
  "",
  "- chunk-1: rewrite `src/ledger.ts`",
].join("\n")

/**
 * A temp project directory OUTSIDE `os.tmpdir()`: the scratch exemption
 * resolves any target under the platform temp dir to zero-governance scratch
 * before the plan-impact classifier runs, so a tmpdir-based project would
 * mask the advisory. The host reports absolute write/edit targets, and the
 * classifier relativizes them against this project dir.
 * @returns The absolute path of the created project directory.
 */
function projectDir(): string {
  return fs.mkdtempSync(path.join(os.homedir(), "turnstile-proj-"))
}

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
  const project = projectDir()
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
  const { h, metricsDir, project, restore } = await bootImpact({ bindPlan: true })
  try {
    await callTool(h, "execute.before", {
      tool: "write",
      sessionID: "p1",
      input: { filePath: path.join(project, "src/unrelated.ts") },
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
  const { h, metricsDir, project, restore } = await bootImpact({ bindPlan: true })
  try {
    await callTool(h, "execute.before", {
      tool: "write",
      sessionID: "p1",
      input: { filePath: path.join(project, "README.md") },
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
  const { h, metricsDir, project, restore } = await bootImpact({ bindPlan: true })
  try {
    await callTool(h, "execute.before", {
      tool: "edit",
      sessionID: "p1",
      input: { filePath: path.join(project, "src/ledger.ts") },
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
  const { h, metricsDir, project, restore } = await bootImpact({ bindPlan: true, strict: true })
  try {
    await assert.rejects(
      () =>
        callTool(h, "execute.before", {
          tool: "edit",
          sessionID: "p1",
          input: { filePath: path.join(project, "src/ledger.ts") },
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
 * An outside-project write target classifies `uninspectable` and falls
 * through to the hands-on ladder, which blocks — and no plan-impact row is
 * journaled (nothing was classified against the plan's scope).
 */
test("plan-impact: an outside-project write target falls through to the hands-on ladder", async () => {
  const { h, metricsDir, project, restore } = await bootImpact({
    bindPlan: true,
    alwaysEnforce: true,
  })
  try {
    await assert.rejects(
      () =>
        callTool(h, "execute.before", {
          tool: "write",
          sessionID: "p1",
          input: { filePath: path.join(project, "..", "elsewhere.ts") },
        }),
      (e: unknown) => e instanceof BlockError,
    )
    assert.equal(
      impactRows(metricsDir).length,
      0,
      "an uninspectable target never journals a plan-impact row",
    )
  } finally {
    restore()
  }
})

/**
 * B5 + AC-7 (dormant): with the session unengaged the classifier never runs
 * — no plan-impact row, and the hands-on ladder stays asleep per #246.
 */
test("plan-impact: unengaged session never classifies", async () => {
  const { h, metricsDir, project, restore } = await bootImpact({
    bindPlan: true,
    alwaysEnforce: false,
  })
  try {
    await callTool(h, "execute.before", {
      tool: "write",
      sessionID: "p1",
      input: { filePath: path.join(project, "src/ledger.ts") },
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
  const { h, metricsDir, project, restore } = await bootImpact({ planBody: "" })
  try {
    await assert.rejects(
      () =>
        callTool(h, "execute.before", {
          tool: "write",
          sessionID: "p1",
          input: { filePath: path.join(project, "src/ledger.ts") },
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
      input: { filePath: path.join(project, "src/ledger.ts") },
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
  const { h, metricsDir, project, restore } = await bootImpact({ bindPlan: true })
  try {
    // Gate-tier writer shape (`cp`) naming a Decomposition file: allowed.
    await callTool(h, "execute.before", {
      tool: "bash",
      sessionID: "p1",
      input: { command: `cp ${path.join(project, "src/ledger.ts")} /tmp/backup.ts` },
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
      input: { command: `npm test > ${path.join(project, "src/ledger.ts.log")}` },
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
  const project = projectDir()
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
        { sessionID: "p1", input: { filePath: path.join(project, "README.md") } } as never,
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
  const { h, metricsDir, project, restore } = await bootImpact({ bindPlan: true })
  try {
    await callTool(h, "execute.before", {
      tool: "write",
      sessionID: "p1",
      input: { filePath: path.join(project, "README.md") },
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
  const project = projectDir()
  const plansDir = path.join(project, ".opencode", "plans")
  fs.mkdirSync(plansDir, { recursive: true })
  fs.writeFileSync(path.join(plansDir, "plan.md"), PLAN_BODY)
  const ctx = createHooksCore({
    env: isolatedEnv(metricsDir),
    config: { metricsDir, alwaysEnforce: true },
  })
  const target = path.join(project, "a.ts")
  assert.equal(ctx.gates.planImpact(project, "", target, false), "none", "no plan bound")
  assert.equal(
    ctx.gates.planImpact(project, "other.md", target, false),
    "none",
    "the bound plan is absent from the dir",
  )
  // An unreadable "plan file": a directory where readFileSync expects bytes.
  fs.rmSync(path.join(plansDir, "plan.md"))
  fs.mkdirSync(path.join(plansDir, "plan.md"))
  assert.equal(
    ctx.gates.planImpact(project, "plan.md", target, false),
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

/**
 * The equality arm relativizes the host's absolute write/edit target against
 * the project dir before matching the repo-relative scope entries: an
 * absolute target under the project classifies, a target outside the
 * project dir classifies `uninspectable` (the hook layer maps it to the
 * hands-on ladder).
 */
test("plan-impact: absolute targets relativize against the project dir", () => {
  const metricsDir = tmpDir()
  const project = projectDir()
  const plansDir = path.join(project, ".opencode", "plans")
  fs.mkdirSync(plansDir, { recursive: true })
  fs.writeFileSync(path.join(plansDir, "plan.md"), PLAN_BODY)
  const ctx = createHooksCore({
    env: isolatedEnv(metricsDir),
    config: { metricsDir, alwaysEnforce: true },
  })
  assert.equal(
    ctx.gates.planImpact(project, "plan.md", path.join(project, "README.md"), false),
    "advisory",
    "an absolute target under the project relativizes to the scope entry",
  )
  assert.equal(
    ctx.gates.planImpact(project, "plan.md", path.join(project, "src", "ledger.ts"), false),
    "structural",
    "a Decomposition-section absolute target classifies structural",
  )
  assert.equal(
    ctx.gates.planImpact(project, "plan.md", path.join(project, "..", "elsewhere.ts"), false),
    "uninspectable",
    "a target outside the project dir classifies uninspectable",
  )
  assert.equal(
    ctx.gates.planImpact(project, "plan.md", "", false),
    "uninspectable",
    "an empty equality target classifies uninspectable",
  )
})

/**
 * The plan-file-self rule compares the plans-dir-relative path exactly: an
 * edit to the plan file itself classifies structural, while a same-named
 * file elsewhere in the repo does not (no bare-name trailing-segment
 * false positive).
 */
test("plan-impact: the plan-file-self rule matches the plans-dir-relative path only", () => {
  const metricsDir = tmpDir()
  const project = projectDir()
  const plansDir = path.join(project, ".opencode", "plans")
  fs.mkdirSync(plansDir, { recursive: true })
  fs.writeFileSync(path.join(plansDir, "plan.md"), PLAN_BODY)
  const ctx = createHooksCore({
    env: isolatedEnv(metricsDir),
    config: { metricsDir, alwaysEnforce: true },
  })
  assert.equal(
    ctx.gates.planImpact(
      project,
      "plan.md",
      path.join(project, ".opencode", "plans", "plan.md"),
      false,
    ),
    "structural",
    "an edit to the plan file itself classifies structural",
  )
  assert.equal(
    ctx.gates.planImpact(project, "plan.md", path.join(project, "docs", "plan.md"), false),
    "none",
    "a same-named file elsewhere in the repo does not",
  )
})

/**
 * The scope cache: an unchanged plan is classified from the cached scope
 * (the second call hits the per-file sha256 key), and a plan edit rebuilds
 * it — the reclassification reflects the new scope.
 */
test("plan-impact: the scope cache reuses an unchanged plan and rebuilds on edit", () => {
  const metricsDir = tmpDir()
  const project = projectDir()
  const plansDir = path.join(project, ".opencode", "plans")
  fs.mkdirSync(plansDir, { recursive: true })
  const planPath = path.join(plansDir, "plan.md")
  fs.writeFileSync(planPath, PLAN_BODY)
  const ctx = createHooksCore({
    env: isolatedEnv(metricsDir),
    config: { metricsDir, alwaysEnforce: true },
  })
  const target = path.join(project, "README.md")
  assert.equal(ctx.gates.planImpact(project, "plan.md", target, false), "advisory")
  // Second call: cache hit, same verdict.
  assert.equal(ctx.gates.planImpact(project, "plan.md", target, false), "advisory")
  // Edit the plan: the key changes, the scope rebuilds, README is gone.
  fs.writeFileSync(
    planPath,
    PLAN_BODY.replace("Update `README.md` to describe the feature.", "Nothing named here."),
  )
  assert.equal(
    ctx.gates.planImpact(project, "plan.md", target, false),
    "none",
    "an edited plan rebuilds the cached scope",
  )
})

/**
 * Fail-toward-strict: an empty/uninspectable write target never classifies —
 * the hands-on ladder runs and blocks, and no plan-impact row appears.
 */
test("plan-impact: an empty write target falls through to the hands-on ladder", async () => {
  const { h, metricsDir, restore } = await bootImpact({ bindPlan: true })
  try {
    // The ladder itself fails open on a targetless write (a journaled
    // error, no block) — the advisory's contract is only that it never
    // classifies an uninspectable target, so no plan-impact row appears
    // and the decision belongs to the ladder, not the classifier.
    await callTool(h, "execute.before", {
      tool: "write",
      sessionID: "p1",
      input: { filePath: "" },
    })
    assert.equal(impactRows(metricsDir).length, 0, "an uninspectable target never classifies")
    const ladderErrors = journalEntries(metricsDir).filter(
      (e) =>
        e.type === "error" &&
        String(e.error).startsWith("execute.before: hands-on gate carried no target path"),
    )
    assert.equal(ladderErrors.length, 1, "the ladder ran and journaled its targetless error")
  } finally {
    restore()
  }
})

/**
 * The landing gate is never bypassed by the advisory: a compound
 * write+push command naming a scope path is classified (plan-impact row)
 * and allowed past the bash-write block, but still BLOCKED by the landing
 * gate (no-landing-approval) — the advisory skips only the bash-write arm.
 */
test("plan-impact: a compound write+push command still hits the landing gate", async () => {
  const { h, metricsDir, project, restore } = await bootImpact({
    bindPlan: true,
    alwaysEnforce: true,
  })
  try {
    await assert.rejects(
      () =>
        callTool(h, "execute.before", {
          tool: "bash",
          sessionID: "p1",
          input: {
            command: `cp ${path.join(project, "src/ledger.ts")} /tmp/b.ts && git push origin main`,
          },
        }),
      (e: unknown) => e instanceof BlockError,
      "the landing gate blocks the push",
    )
    const landing = journalEntries(metricsDir).filter(
      (e) => e.type === "blocked" && e.reason === "no-landing-approval",
    )
    assert.equal(landing.length, 1, "the block reason is no-landing-approval")
    const rows = impactRows(metricsDir)
    assert.equal(rows.length, 1, "the scope-overlapping command journaled its classification")
    assert.equal(rows[0]!.impact, "structural")
    assert.equal(handsOnBlocks(metricsDir).length, 0, "the bash-write block was skipped")
  } finally {
    restore()
  }
})
