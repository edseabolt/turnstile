/**
 * @fileoverview Planner write-target guard tests: a planner child's
 * write/edit is mechanically confined to the configured plans directory —
 * inside allowed (relative, absolute, and the plans-dir path itself),
 * outside blocked with the configured directory named and a `blocked`
 * journal row, scratch/empty targets and non-planner children exempt,
 * unresolved-agent children fail open, custom and absolute `plansDir`
 * honored, and an internal error journals `type:"error"` without throwing.
 */

import { test } from "node:test"
import assert from "node:assert/strict"
import * as os from "node:os"
import * as path from "node:path"

import { createHooksCore, type TurnstileContext } from "../src/hooks-core.ts"
import { toolHooksAfter } from "../src/tool-hooks-after.ts"
import type { TurnstileConfig } from "../src/types.ts"
import { isolatedEnv, journalEntries, tmpDir } from "./helpers.ts"

/** Creates a fresh hooks-core context over an isolated env and a temp
 *  metrics dir, so neither config resolution nor journaling touches the
 *  real home.
 *  @param config Injected config overrides (applied last by loadConfig).
 *  @returns The context plus the temp metrics dir (for journal assertions). */
function coreWith(config: Partial<TurnstileConfig>): {
  ctx: TurnstileContext
  metricsDir: string
} {
  const metricsDir = tmpDir()
  const ctx = createHooksCore({
    env: isolatedEnv(metricsDir),
    config: { metricsDir, alwaysEnforce: true, ...config },
  })
  return { ctx, metricsDir }
}

/** The `blocked` rows of a metrics dir with `ts` stripped.
 *  @param metricsDir The metrics dir to read.
 *  @returns The matching entries with `ts: undefined`. */
function blockRowsOf(metricsDir: string): Array<Record<string, any>> {
  return journalEntries(metricsDir)
    .filter((e) => e.type === "blocked")
    .map((e) => ({ ...e, ts: undefined }))
}

/** The `error` rows of a metrics dir with `ts` stripped.
 *  @param metricsDir The metrics dir to read.
 *  @returns The matching entries with `ts: undefined`. */
function errorRowsOf(metricsDir: string): Array<Record<string, any>> {
  return journalEntries(metricsDir)
    .filter((e) => e.type === "error")
    .map((e) => ({ ...e, ts: undefined }))
}

/** The `childWrite` telemetry rows of a metrics dir with `ts` stripped.
 *  @param metricsDir The metrics dir to read.
 *  @returns The matching entries with `ts: undefined`. */
function childWriteRowsOf(metricsDir: string): Array<Record<string, any>> {
  return journalEntries(metricsDir)
    .filter((e) => e.type === "tool" && e.childWrite === true)
    .map((e) => ({ ...e, ts: undefined }))
}

/** Drives a write/edit through the before-guard and the after-surface.
 *  @param ctx The hooks-core context.
 *  @param tool The tool name (`write` or `edit`).
 *  @param sessionID The acting session.
 *  @param filePath The target path.
 *  @param agent Optional event agent name. */
async function driveWriteEdit(
  ctx: TurnstileContext,
  tool: "write" | "edit",
  sessionID: string,
  filePath: string,
  agent?: string,
): Promise<void> {
  const event = {
    tool,
    sessionID,
    ...(agent !== undefined ? { agent } : {}),
    input: { filePath },
  }
  ctx.handleWriteEditDispatch(event as any, tool)
  await toolHooksAfter(ctx, event as any)
}

/** Drives a write/edit whose payload omits the target path entirely.
 *  @param ctx The hooks-core context.
 *  @param sessionID The acting session.
 *  @param agent Optional event agent name. */
async function driveWriteEditNoPath(
  ctx: TurnstileContext,
  sessionID: string,
  agent?: string,
): Promise<void> {
  const event = {
    tool: "write",
    sessionID,
    ...(agent !== undefined ? { agent } : {}),
    input: {},
  }
  ctx.handleWriteEditDispatch(event as any, "write")
  await toolHooksAfter(ctx, event as any)
}

/** The repo root: a stable, non-temp project directory seeded into
 *  `ctx.sessionDirs` so the guard's `currentProjectDir` read never depends
 *  on the ambient cwd — the suite's shared process may be left chdir'd into
 *  a temp project by another file, and a cwd under the platform temp dir
 *  would classify relative targets as scratch before the guard runs.
 *  @returns The repo root absolute path. */
function repoRoot(): string {
  return path.resolve(import.meta.dirname, "..")
}

/** Registers the child edge and pins the child's project directory to the
 *  repo root, making the guard's plans-dir resolution deterministic.
 *  @param ctx The hooks-core context. */
function registerChild(ctx: TurnstileContext): void {
  ctx.ledger.childToParent.set("c1", "p1")
  ctx.sessionDirs.set("c1", repoRoot())
}

/** Runs `fn` with the process cwd pinned to the repo root, restoring the
 *  previous cwd afterwards. Needed for relative targets: the scratch
 *  predicate resolves them against the ambient cwd, which the suite's
 *  shared process may leave inside a temp project.
 *  @param fn The body to run.
 *  @returns The body's return value. */
function withRepoCwd<T>(fn: () => T): T {
  const prev = process.cwd()
  process.chdir(repoRoot())
  try {
    return fn()
  } finally {
    process.chdir(prev)
  }
}

/** A planner child write inside the default plans dir is exempt: allowed
 *  with exactly the child-write telemetry row and no block row. */
test("planner child write inside the default plans dir is exempt", async () => {
  const { ctx, metricsDir } = coreWith({})
  registerChild(ctx)
  await driveWriteEdit(
    ctx,
    "write",
    "c1",
    path.join(repoRoot(), ".opencode/plans/plan.md"),
    "planner",
  )
  assert.equal(childWriteRowsOf(metricsDir).length, 1)
  assert.deepEqual(blockRowsOf(metricsDir), [])
})

/** A planner child write targeting the plans dir path itself (the directory,
 *  not a file under it) hits the equality arm of the allow predicate and is
 *  allowed with its telemetry row. */
test("planner child write targeting the plans dir path itself is allowed", async () => {
  const { ctx, metricsDir } = coreWith({})
  registerChild(ctx)
  await driveWriteEdit(ctx, "write", "c1", path.join(repoRoot(), ".opencode/plans"), "planner")
  assert.equal(childWriteRowsOf(metricsDir).length, 1)
  assert.deepEqual(blockRowsOf(metricsDir), [])
})

/** A planner child write outside plansDir is blocked: the BlockError names
 *  the configured directory and one `blocked` row journals the reason. */
test("planner child write outside plansDir is blocked with the configured dir named", () => {
  const { ctx, metricsDir } = coreWith({})
  registerChild(ctx)
  withRepoCwd(() =>
    assert.throws(
      () =>
        ctx.handleWriteEditDispatch(
          {
            tool: "write",
            sessionID: "c1",
            agent: "planner",
            input: { filePath: "plans/plan.md" },
          } as any,
          "write",
        ),
      /BLOCKED by turnstile:.*\.opencode\/plans/,
    ),
  )
  assert.deepEqual(blockRowsOf(metricsDir), [
    {
      ts: undefined,
      type: "blocked",
      sessionID: "c1",
      agent: "planner",
      reason: "planner-write-outside-plans-dir",
    },
  ])
})

/** A non-planner pipeline child (executor) writing outside plansDir keeps
 *  the plain child exemption: allowed, no block row. */
test("executor child write outside plansDir stays exempt", async () => {
  const { ctx, metricsDir } = coreWith({})
  registerChild(ctx)
  await driveWriteEdit(ctx, "write", "c1", "/r/a.ts", "executor")
  assert.equal(childWriteRowsOf(metricsDir).length, 1)
  assert.deepEqual(blockRowsOf(metricsDir), [])
})

/** A planner identified only through the emitter-authority fallback (the
 *  event names no agent) is still enforced and blocked outside plansDir. */
test("planner identified via the emitterAgent fallback is blocked", () => {
  const { ctx, metricsDir } = coreWith({})
  registerChild(ctx)
  ctx.seedEmitter("c1", "planner")
  withRepoCwd(() =>
    assert.throws(
      () =>
        ctx.handleWriteEditDispatch(
          { tool: "write", sessionID: "c1", input: { filePath: "plans/plan.md" } } as any,
          "write",
        ),
      /BLOCKED by turnstile:/,
    ),
  )
  assert.equal(blockRowsOf(metricsDir).length, 1)
})

/** An edge child whose agent name resolves nowhere stays unenforced
 *  (fail-open): with enforcement disarmed the write passes and no planner
 *  block row journals. */
test("edge child with an unresolved agent stays exempt", async () => {
  const { ctx, metricsDir } = coreWith({ alwaysEnforce: false })
  registerChild(ctx)
  await driveWriteEdit(ctx, "write", "c1", "/r/elsewhere.md")
  assert.deepEqual(blockRowsOf(metricsDir), [])
})

/** A custom relative plansDir is honored both ways: a write inside it is
 *  allowed and a write outside it is blocked naming the custom directory. */
test("custom relative plansDir: inside allowed, outside blocked", async () => {
  const { ctx, metricsDir } = coreWith({ plansDir: "docs/plans" })
  registerChild(ctx)
  await driveWriteEdit(ctx, "write", "c1", path.join(repoRoot(), "docs/plans/plan.md"), "planner")
  assert.deepEqual(blockRowsOf(metricsDir), [])
  withRepoCwd(() =>
    assert.throws(
      () =>
        ctx.handleWriteEditDispatch(
          {
            tool: "write",
            sessionID: "c1",
            agent: "planner",
            input: { filePath: "docs/other.md" },
          } as any,
          "write",
        ),
      /BLOCKED by turnstile:.*docs\/plans/,
    ),
  )
  assert.equal(blockRowsOf(metricsDir).length, 1)
})

/** An absolute plansDir config is honored as-is: a write inside the
 *  absolute directory is allowed and one outside it is blocked. */
test("absolute plansDir config: inside allowed, outside blocked", async () => {
  const abs = tmpDir()
  const { ctx, metricsDir } = coreWith({ plansDir: abs })
  registerChild(ctx)
  await driveWriteEdit(ctx, "write", "c1", path.join(abs, "plan.md"), "planner")
  assert.deepEqual(blockRowsOf(metricsDir), [])
  assert.throws(
    () =>
      ctx.handleWriteEditDispatch(
        {
          tool: "write",
          sessionID: "c1",
          agent: "planner",
          input: { filePath: "/r/elsewhere.md" },
        } as any,
        "write",
      ),
    /BLOCKED by turnstile:/,
  )
  assert.equal(blockRowsOf(metricsDir).length, 1)
})

/** A planner write to a scratch target (under the platform temp dir) is
 *  zero-governance work: allowed before the plans-dir check runs. */
test("planner scratch-target write is allowed", async () => {
  const { ctx, metricsDir } = coreWith({})
  registerChild(ctx)
  await driveWriteEdit(ctx, "write", "c1", path.join(os.tmpdir(), "planner-scratch.md"), "planner")
  assert.deepEqual(blockRowsOf(metricsDir), [])
})

/** A planner write whose payload carries no target path is allowed: there
 *  is nothing to place inside or outside the plans directory. */
test("planner write with an absent path is allowed", async () => {
  const { ctx, metricsDir } = coreWith({})
  registerChild(ctx)
  await driveWriteEditNoPath(ctx, "c1", "planner")
  assert.deepEqual(blockRowsOf(metricsDir), [])
})

/** An internal error inside the guard (here: the configured planner name
 *  exploding on read) journals one `type:"error"` row and never throws —
 *  the fail-open contract. */
test("guard internal error journals type:error and never throws", async () => {
  const { ctx, metricsDir } = coreWith({})
  registerChild(ctx)
  Object.defineProperty(ctx.config.agents, "planner", {
    get() {
      throw new Error("boom")
    },
  })
  await driveWriteEdit(ctx, "write", "c1", "/r/plan.md", "planner")
  const errors = errorRowsOf(metricsDir).filter((e) =>
    String(e.error).startsWith("planner-write guard:"),
  )
  assert.equal(errors.length, 1)
  assert.deepEqual(blockRowsOf(metricsDir), [])
})
