/**
 * @fileoverview Maintenance-dispatch classification tests: the pure rule
 * predicates (declaration, per-file and whole-diff eligibility) and the
 * enforcement flow — an eligible maintenance executor dispatch skips the
 * plan gates and journals the `{type:"maintenance"}` row, an out-of-scope
 * diff escalates to the ordinary plan gate, and the per-plan cap blocks and
 * escalates. The plan-keying side (progress-only edits keeping a bound
 * approval live) is covered through the gates/ledger API here too.
 */

import { test } from "node:test"
import assert from "node:assert/strict"
import * as fs from "node:fs"
import * as path from "node:path"
import { execFileSync } from "node:child_process"

import { turnstile } from "../turnstile.ts"
import { createGates } from "../src/gates.ts"
import {
  MAINTENANCE_MAX_PER_PLAN,
  maintenanceDeclared,
  maintenanceDiffEligible,
  maintenanceFileEligible,
  maintenanceMarkerSensitive,
} from "../src/maintenance.ts"
import {
  callTool,
  isolatedEnv,
  journalEntries,
  makeFakeHost,
  tmpDir,
  type FakeHost,
} from "./helpers.ts"

const APPROVE = "VERDICT: APPROVE crit=0 high=0 med=0 low=0"

test("maintenance rules: the declaration needs the plan in scope and the word", () => {
  assert.equal(maintenanceDeclared("do maintenance on plan.md", "plan.md", ["plan.md"]), true)
  assert.equal(maintenanceDeclared("update plan.md progress", "plan.md", ["plan.md"]), false)
  assert.equal(maintenanceDeclared("do maintenance", "plan.md", []), false)
  assert.equal(maintenanceDeclared("maintenance", "", ["plan.md"]), false)
})

test("maintenance rules: marker-sensitive surfaces", () => {
  assert.equal(maintenanceMarkerSensitive("README.md"), true)
  assert.equal(maintenanceMarkerSensitive("docs/usage.md"), true)
  assert.equal(maintenanceMarkerSensitive("agents/executor.md"), true)
  assert.equal(maintenanceMarkerSensitive("docs/architecture.md"), false)
  assert.equal(maintenanceMarkerSensitive("CONTRIBUTING.md"), false)
  assert.equal(maintenanceMarkerSensitive("src/policy.ts"), false)
})

test("maintenance rules: per-file eligibility matrix", () => {
  // Allowed non-src surfaces.
  assert.equal(maintenanceFileEligible("CONTRIBUTING.md", false), true)
  assert.equal(maintenanceFileEligible("docs/architecture.md", false), true)
  assert.equal(maintenanceFileEligible(".opencode/plans/plan.md", false), true)
  // Marker-validated surfaces need a passing guard.
  assert.equal(maintenanceFileEligible("README.md", false), false)
  assert.equal(maintenanceFileEligible("README.md", true), true)
  assert.equal(maintenanceFileEligible("docs/usage.md", true), true)
  assert.equal(maintenanceFileEligible("agents/executor.md", true), true)
  assert.equal(maintenanceFileEligible("agents/executor.md", false), false)
  // Forbidden trees and exact files.
  for (const f of [
    "src/gates-plan.ts",
    "src/config.ts",
    "src/types.ts",
    "tests/maintenance.test.ts",
    "bin/cli.mjs",
    "scripts/status.mjs",
    "examples/turnstile.example.json",
    "schemas/turnstile.schema.json",
    "opencode.json",
    "package.json",
  ]) {
    assert.equal(maintenanceFileEligible(f, true), false, f)
  }
  // Non-markdown plan-adjacent and doc paths fail closed.
  assert.equal(maintenanceFileEligible(".opencode/plans/plan.txt", true), false)
  assert.equal(maintenanceFileEligible("docs/notes.txt", true), false)
})

test("maintenance rules: whole-diff eligibility (null probe fails closed)", () => {
  assert.equal(maintenanceDiffEligible(null, true), false)
  assert.equal(maintenanceDiffEligible([], false), true)
  assert.equal(maintenanceDiffEligible(["docs/a.md"], false), true)
  assert.equal(maintenanceDiffEligible(["docs/a.md", "src/x.ts"], true), false)
})

test("maintenance rules: the cap constant is 4", () => {
  assert.equal(MAINTENANCE_MAX_PER_PLAN, 4)
})

/** Boot shape for the dispatch-flow tests: a project with a plan + a git repo. */
async function bootMaint(opts: {
  planBody?: string
  markerScript?: string
  git?: boolean
}): Promise<{
  h: FakeHost
  project: string
  planName: string
  restore: () => void
  metricsDir: string
}> {
  const project = tmpDir()
  fs.mkdirSync(path.join(project, ".opencode", "plans"), { recursive: true })
  const planName = "plan.md"
  fs.writeFileSync(
    path.join(project, ".opencode", "plans", planName),
    opts.planBody ?? "# Progress\n\n# Objective\n\nSpec.\n",
  )
  fs.mkdirSync(path.join(project, "docs"), { recursive: true })
  if (opts.git !== false) {
    execFileSync("git", ["init", "-q"], { cwd: project })
    execFileSync("git", ["config", "user.email", "t@t"], { cwd: project })
    execFileSync("git", ["config", "user.name", "t"], { cwd: project })
    fs.writeFileSync(path.join(project, ".gitignore"), ".opencode/\n")
    if (opts.markerScript !== undefined) {
      fs.mkdirSync(path.join(project, "scripts"), { recursive: true })
      fs.writeFileSync(path.join(project, "scripts", "check-markers.mjs"), opts.markerScript)
    }
    execFileSync("git", ["add", "-A"], { cwd: project })
    execFileSync("git", ["commit", "-qm", "chore: init"], { cwd: project })
  }
  const metricsDir = tmpDir()
  const h = makeFakeHost()
  const prev = process.cwd()
  process.chdir(project)
  const setup = turnstile(h.host, { env: isolatedEnv(metricsDir), config: { metricsDir } })
  const dispose = (await setup(h.host)) as () => void
  return {
    h,
    project,
    planName,
    metricsDir,
    restore: (): void => {
      dispose()
      process.chdir(prev)
    },
  }
}

/** Approves the plan for the session via a plan-reviewer verdict delivery. */
async function approvePlan(h: FakeHost, planName: string): Promise<void> {
  // Dispatch the plan-reviewer so the verdict binds to the named plan.
  await callTool(h, "execute.before", {
    sessionID: "p1",
    tool: "task",
    input: { agent: "plan-reviewer", prompt: `review ${planName}` },
  })
  await h.pushEvent({
    type: "session.created",
    data: { sessionID: "c1", parentID: "p1", agent: "plan-reviewer" },
  })
  await callTool(h, "execute.after", {
    sessionID: "c1",
    tool: "task",
    input: { agent: "plan-reviewer" },
    result: { output: `${APPROVE}\nok\n` },
  })
}

test("maintenance flow: an eligible maintenance dispatch skips the plan gate and journals the row", async () => {
  const { h, restore, metricsDir } = await bootMaint({})
  try {
    await approvePlan(h, "plan.md")
    // Progress-only plan edit + docs edit on an otherwise clean tree.
    const planPath = path.join(process.cwd(), ".opencode", "plans", "plan.md")
    fs.writeFileSync(planPath, "# Progress\n\n- DONE\n\n# Objective\n\nSpec.\n")
    fs.writeFileSync(path.join(process.cwd(), "docs", "note.md"), "new\n")
    await callTool(h, "execute.before", {
      sessionID: "p1",
      tool: "task",
      input: {
        agent: "executor",
        prompt: "plan.md maintenance: refresh the Progress bullets",
      },
    })
    const rows = journalEntries(metricsDir).filter((r) => r.type === "maintenance")
    assert.equal(rows.length, 1)
    assert.equal(rows[0]!.plan, "plan.md")
    assert.equal(rows[0]!.capped, false)
  } finally {
    restore()
  }
})

test("maintenance flow: no live approval keeps the maintenance prompt on the ordinary gate", async () => {
  const { h, restore, metricsDir } = await bootMaint({})
  try {
    fs.writeFileSync(path.join(process.cwd(), "docs", "note.md"), "new\n")
    await assert.rejects(
      callTool(h, "execute.before", {
        sessionID: "p1",
        tool: "task",
        input: { agent: "executor", prompt: "plan.md maintenance: refresh bullets" },
      }),
      /BLOCKED by turnstile/,
    )
    const rows = journalEntries(metricsDir).filter((r) => r.type === "maintenance")
    assert.equal(rows.length, 0)
  } finally {
    restore()
  }
})

test("maintenance flow: a diff touching src/ escalates to the ordinary gate", async () => {
  const { h, restore, metricsDir } = await bootMaint({})
  try {
    await approvePlan(h, "plan.md")
    // Drop the approval via a spec-region edit: reconcile then treats the
    // dispatch as ordinary regardless of the maintenance declaration.
    const planPath = path.join(process.cwd(), ".opencode", "plans", "plan.md")
    fs.writeFileSync(planPath, "# Progress\n\n# Objective\n\nSpec 2.\n")
    fs.mkdirSync(path.join(process.cwd(), "src"), { recursive: true })
    fs.writeFileSync(path.join(process.cwd(), "src", "new.ts"), "export {}\n")
    await assert.rejects(
      callTool(h, "execute.before", {
        sessionID: "p1",
        tool: "task",
        input: { agent: "executor", prompt: "plan.md maintenance: ship it" },
      }),
      /BLOCKED by turnstile/,
    )
    const rows = journalEntries(metricsDir).filter((r) => r.type === "maintenance")
    assert.equal(rows.length, 0)
  } finally {
    restore()
  }
})

test("maintenance flow: the cap (4/plan) blocks and escalates", async () => {
  const { h, restore, metricsDir } = await bootMaint({})
  try {
    await approvePlan(h, "plan.md")
    const prompt = "plan.md maintenance: refresh bullets"
    for (let i = 0; i < MAINTENANCE_MAX_PER_PLAN; i++) {
      await callTool(h, "execute.before", {
        sessionID: "p1",
        tool: "task",
        input: { agent: "executor", prompt },
      })
    }
    await assert.rejects(
      callTool(h, "execute.before", {
        sessionID: "p1",
        tool: "task",
        input: { agent: "executor", prompt },
      }),
      /maintenance dispatch cap \(4\)/,
    )
    const rows = journalEntries(metricsDir).filter((r) => r.type === "maintenance")
    assert.equal(rows.filter((r) => r.capped === false).length, MAINTENANCE_MAX_PER_PLAN)
    assert.equal(rows.filter((r) => r.capped === true).length, 1)
  } finally {
    restore()
  }
})

test("maintenance flow: a spec edit invalidates even before reconcile (clean tree, fail closed)", async () => {
  const { h, restore, metricsDir } = await bootMaint({})
  try {
    await approvePlan(h, "plan.md")
    const planPath = path.join(process.cwd(), ".opencode", "plans", "plan.md")
    // Spec-region edit only; gitignored, so the working-tree diff stays clean.
    fs.writeFileSync(planPath, "# Progress\n\n# Objective\n\nSpec 2.\n")
    await assert.rejects(
      callTool(h, "execute.before", {
        sessionID: "p1",
        tool: "task",
        input: { agent: "executor", prompt: "plan.md maintenance: refresh bullets" },
      }),
      /BLOCKED by turnstile/,
    )
    const rows = journalEntries(metricsDir).filter((r) => r.type === "maintenance")
    assert.equal(rows.length, 0)
  } finally {
    restore()
  }
})

test("maintenance flow: an ineligible diff under a live approval rides the ordinary path", async () => {
  const { h, restore, metricsDir } = await bootMaint({})
  try {
    await approvePlan(h, "plan.md")
    fs.mkdirSync(path.join(process.cwd(), "src"), { recursive: true })
    fs.writeFileSync(path.join(process.cwd(), "src", "new.ts"), "export {}\n")
    // Approval live + declared + ineligible diff: ordinary gates run, they
    // are green, so the dispatch is allowed — but no maintenance row lands
    // and no cap slot is consumed.
    await callTool(h, "execute.before", {
      sessionID: "p1",
      tool: "task",
      input: { agent: "executor", prompt: "plan.md maintenance: ship it" },
    })
    const rows = journalEntries(metricsDir).filter((r) => r.type === "maintenance")
    assert.equal(rows.length, 0)
  } finally {
    restore()
  }
})

test("maintenance flow: a README edit qualifies only when the marker guard passes", async () => {
  // Passing guard: admitted.
  {
    const { h, restore, metricsDir } = await bootMaint({
      markerScript: "console.log('ok');\n",
    })
    try {
      await approvePlan(h, "plan.md")
      fs.writeFileSync(path.join(process.cwd(), "README.md"), "# t\n")
      await callTool(h, "execute.before", {
        sessionID: "p1",
        tool: "task",
        input: { agent: "executor", prompt: "plan.md maintenance: docs touch-up" },
      })
      const rows = journalEntries(metricsDir).filter((r) => r.type === "maintenance")
      assert.equal(rows.length, 1)
      assert.equal(rows[0]!.capped, false)
    } finally {
      restore()
    }
  }
  // Failing guard: ordinary (gate green, dispatch allowed, no row).
  {
    const { h, restore, metricsDir } = await bootMaint({
      markerScript: "process.exit(1)\n",
    })
    try {
      await approvePlan(h, "plan.md")
      fs.writeFileSync(path.join(process.cwd(), "README.md"), "# t\n")
      await callTool(h, "execute.before", {
        sessionID: "p1",
        tool: "task",
        input: { agent: "executor", prompt: "plan.md maintenance: docs touch-up" },
      })
      const rows = journalEntries(metricsDir).filter((r) => r.type === "maintenance")
      assert.equal(rows.length, 0)
    } finally {
      restore()
    }
  }
  // Missing guard: fail closed.
  {
    const { h, restore, metricsDir } = await bootMaint({})
    try {
      await approvePlan(h, "plan.md")
      fs.writeFileSync(path.join(process.cwd(), "README.md"), "# t\n")
      await callTool(h, "execute.before", {
        sessionID: "p1",
        tool: "task",
        input: { agent: "executor", prompt: "plan.md maintenance: docs touch-up" },
      })
      const rows = journalEntries(metricsDir).filter((r) => r.type === "maintenance")
      assert.equal(rows.length, 0)
    } finally {
      restore()
    }
  }
})

test("maintenance flow: a failed git probe fails closed to the ordinary path", async () => {
  const { h, restore, metricsDir } = await bootMaint({ git: false })
  try {
    await approvePlan(h, "plan.md")
    // No git repo: the diff probe fails → ineligible → ordinary path (the
    // green plan gate allows the dispatch, but no maintenance row lands).
    await callTool(h, "execute.before", {
      sessionID: "p1",
      tool: "task",
      input: { agent: "executor", prompt: "plan.md maintenance: refresh bullets" },
    })
    const rows = journalEntries(metricsDir).filter((r) => r.type === "maintenance")
    assert.equal(rows.length, 0)
  } finally {
    restore()
  }
})

test("maintenance flow: a classification failure fails open to the ordinary path", async () => {
  const project = tmpDir()
  fs.mkdirSync(path.join(project, ".opencode", "plans"), { recursive: true })
  fs.writeFileSync(
    path.join(project, ".opencode", "plans", "plan.md"),
    "# Progress\n\n# Objective\n\nSpec.\n",
  )
  const metricsDir = tmpDir()
  const sessionRecords = new Map<string, unknown>()
  const h = makeFakeHost({ sessionRecords })
  const prev = process.cwd()
  process.chdir(project)
  const setup = turnstile(h.host, { env: isolatedEnv(metricsDir), config: { metricsDir } })
  const dispose = (await setup(h.host)) as () => void
  try {
    await approvePlan(h, "plan.md")
    // Swap in a hostile session record: the directory getter throws a plain
    // error during re-resolution, so classification fails internally.
    const hostile: Record<string, unknown> = {}
    Object.defineProperty(hostile, "directory", {
      get(): string {
        throw new Error("hostile record")
      },
    })
    sessionRecords.set("p1", hostile)
    await callTool(h, "execute.before", {
      sessionID: "p1",
      tool: "task",
      input: { agent: "executor", prompt: "plan.md maintenance: refresh bullets" },
    })
    const rows = journalEntries(metricsDir).filter((r) => r.type === "maintenance")
    assert.equal(rows.length, 0)
    const errors = journalEntries(metricsDir).filter((r) => r.type === "error")
    assert.ok(errors.some((r) => String(r.error).includes("maintenance classification")))
  } finally {
    dispose()
    process.chdir(prev)
  }
})

test("plan keying: a spec-region edit invalidates the bound approval (plan-edited)", async () => {
  const { defaultConfig } = await import("../src/config.ts")
  const { createJournaler } = await import("../src/journal.ts")
  const project = tmpDir()
  fs.mkdirSync(path.join(project, ".opencode", "plans"), { recursive: true })
  const body = "# Progress\n\n- x\n\n# Objective\n\nSpec.\n"
  fs.writeFileSync(path.join(project, ".opencode", "plans", "plan.md"), body)
  const metricsDir = tmpDir()
  const gates = createGates(
    defaultConfig(),
    createJournaler({
      metricsDir,
      trace: false,
      maxBytes: 1_000_000,
      maxGenerations: 1,
      rotateEveryEntries: 0,
    }),
  )
  const edited = body.replace("Spec.", "Spec 2.")
  fs.writeFileSync(path.join(project, ".opencode", "plans", "plan.md"), edited)
  const before = gates.planApprovalBinding(project, ["plan.md"])!.key
  fs.writeFileSync(path.join(project, ".opencode", "plans", "plan.md"), body)
  const after = gates.planApprovalBinding(project, ["plan.md"])!.key
  assert.notEqual(before, after)
  // A progress-only edit keeps the key.
  fs.writeFileSync(
    path.join(project, ".opencode", "plans", "plan.md"),
    body.replace("- x", "- x\n- y"),
  )
  assert.equal(gates.planApprovalBinding(project, ["plan.md"])!.key, after)
})
