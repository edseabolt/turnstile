/**
 * @fileoverview User plan-review tests (issue #259): the opt-in
 * `planUserReview` pause between the planner writing a plan and the
 * plan-reviewer dispatch. Covers the config surface (defaults, merge,
 * validation), the arming at planner-dispatch admit, the deliberate
 * plan-reviewer block, the accept/reject prompt captures across the
 * task-scope boundary, the last-wins rule for co-present markers, the
 * fail-open arms, the `plan-review` replay fold (pause/accept/reject
 * last-wins), restart survival, and the conditional policy line.
 */

import { test } from "node:test"
import assert from "node:assert/strict"
import * as fs from "node:fs"
import * as path from "node:path"

import { BlockError } from "../src/gates.ts"
import { createHooksCore, type TurnstileContext } from "../src/hooks-core.ts"
import { createLedger } from "../src/ledger.ts"
import { defaultConfig, mergeConfig } from "../src/config.ts"
import { orchestratorPolicyFor } from "../src/policy.ts"
import type { TurnstileConfig } from "../src/types.ts"
import { turnstile } from "../turnstile.ts"
import {
  callSession,
  callTool,
  expectedPolicy,
  isolatedEnv,
  journalEntries,
  makeFakeHost,
  tmpDir,
  type FakeHost,
} from "./helpers.ts"

/** The default accept literal. */
const ACCEPT = "PLAN REVIEWED:"
/** The default reject literal. */
const REJECT = "PLAN REJECTED:"

/**
 * Reads journal entries of one type with the volatile `ts` field stripped,
 * so deep-equal assertions stay deterministic.
 * @param metricsDir The metrics dir to read.
 * @param type The journal entry type.
 * @returns The entries without `ts`.
 */
function entriesOf(metricsDir: string, type: string): Array<Record<string, any>> {
  return journalEntries(metricsDir)
    .filter((e) => e.type === type)
    .map((e) => {
      const { ts: _ts, ...rest } = e
      return rest
    })
}

/**
 * Creates a fresh hooks-core context over an isolated env and a temp metrics
 * dir, so neither config resolution nor journaling touches the real home.
 * @param config Injected config overrides (applied last by loadConfig).
 * @returns The context plus the temp metrics dir (for journal assertions).
 */
function coreWith(config: Partial<TurnstileConfig>): { ctx: TurnstileContext; metricsDir: string } {
  const metricsDir = tmpDir()
  const ctx = createHooksCore({
    env: isolatedEnv(metricsDir),
    config: { metricsDir, alwaysEnforce: true, ...config },
  })
  return { ctx, metricsDir }
}

/** Default config with user plan review enabled (alwaysEnforce on). */
function reviewOn(): Partial<TurnstileConfig> {
  return { planUserReview: true }
}

/**
 * Dispatches one task dispatch through the guard, asserting whether it
 * throws a deliberate block.
 * @param ctx The hooks-core context.
 * @param sessionID The dispatching session.
 * @param agent The agent name to dispatch.
 * @param prompt The dispatch prompt.
 * @param blocked Whether the dispatch must throw a BlockError.
 */
async function dispatchExpect(
  ctx: TurnstileContext,
  sessionID: string,
  agent: string,
  prompt: string,
  blocked: boolean,
): Promise<void> {
  if (!blocked) {
    await ctx.guardedTaskDispatch(sessionID, agent, prompt, "")
    return
  }
  await assert.rejects(
    () => ctx.guardedTaskDispatch(sessionID, agent, prompt, ""),
    (e: unknown) => e instanceof BlockError,
  )
}

// ── Config surface ───────────────────────────────────────────────────────────

test("planUserReview config: defaults are off with the canonical literals", () => {
  const c = defaultConfig({})
  assert.equal(c.planUserReview, false)
  assert.equal(c.planReviewAcceptMarker, "PLAN REVIEWED:")
  assert.equal(c.planReviewRejectMarker, "PLAN REJECTED:")
})

test("planUserReview config: valid overrides merge; invalid values are rejected", () => {
  const { config, warnings } = mergeConfig(defaultConfig({}), {
    planUserReview: true,
    planReviewAcceptMarker: "OK PLAN:",
    planReviewRejectMarker: "NO PLAN:",
  })
  assert.equal(config.planUserReview, true)
  assert.equal(config.planReviewAcceptMarker, "OK PLAN:")
  assert.equal(config.planReviewRejectMarker, "NO PLAN:")
  assert.equal(warnings.length, 0)
  const bad = mergeConfig(defaultConfig({}), {
    planUserReview: 1,
    planReviewAcceptMarker: "",
    planReviewRejectMarker: 42,
  })
  assert.equal(bad.config.planUserReview, false, "a boolean key never falls through")
  assert.equal(bad.config.planReviewAcceptMarker, "PLAN REVIEWED:")
  assert.equal(bad.config.planReviewRejectMarker, "PLAN REJECTED:")
  assert.equal(bad.warnings.length, 3, "each invalid key warns")
})

// ── Arming at planner admit ──────────────────────────────────────────────────

test("planUserReview: a planner dispatch arms the pause (flag + pause row)", async () => {
  const { ctx, metricsDir } = coreWith(reviewOn())
  ctx.admitPrompt("p1", { text: "plan it" }, "")
  await dispatchExpect(ctx, "p1", "planner", "plan it", false)
  assert.equal(ctx.ledger.state("p1").planReviewPending, true)
  assert.deepEqual(entriesOf(metricsDir, "plan-review"), [
    { type: "plan-review", sessionID: "p1", action: "pause" },
  ])
})

test("planUserReview off: a planner dispatch arms nothing and the markers are inert", async () => {
  const { ctx, metricsDir } = coreWith({})
  await dispatchExpect(ctx, "p1", "planner", "plan it", false)
  assert.equal(ctx.ledger.state("p1").planReviewPending, false)
  ctx.admitPrompt("p1", { text: `${ACCEPT} fine ${REJECT} no` }, "")
  assert.deepEqual(entriesOf(metricsDir, "plan-review"), [], "no rows while off")
  assert.equal(ctx.ledger.state("p1").taskComplete, false, "the reject literal is inert")
  await dispatchExpect(ctx, "p1", "plan-reviewer", "review it", false)
})

test("planUserReview: a re-plan re-arms the pause after an accept", async () => {
  const { ctx, metricsDir } = coreWith(reviewOn())
  ctx.admitPrompt("p1", { text: "plan it" }, "")
  await dispatchExpect(ctx, "p1", "planner", "plan it", false)
  ctx.admitPrompt("p1", { text: `${ACCEPT} ship it` }, "")
  assert.equal(ctx.ledger.state("p1").planReviewPending, false)
  await dispatchExpect(ctx, "p1", "planner", "re-plan it", false)
  assert.equal(ctx.ledger.state("p1").planReviewPending, true, "the second planner re-arms")
  const rows = entriesOf(metricsDir, "plan-review")
  assert.deepEqual(
    rows.map((r) => r.action),
    ["pause", "accept", "pause"],
  )
})

// ── The pause ────────────────────────────────────────────────────────────────

test("planUserReview: a pending plan-reviewer dispatch blocks naming dir and literals", async () => {
  const { ctx, metricsDir } = coreWith(reviewOn())
  await dispatchExpect(ctx, "p1", "planner", "plan it", false)
  await assert.rejects(
    () => ctx.guardedTaskDispatch("p1", "plan-reviewer", "review it", ""),
    (e: unknown) => {
      assert.ok(e instanceof BlockError)
      assert.match(e.message, /BLOCKED by turnstile: user plan review is enabled/)
      assert.match(e.message, new RegExp(ctx.config.plansDir.replace(/\./g, "\\.")))
      assert.match(e.message, /PLAN REVIEWED:/)
      assert.match(e.message, /PLAN REJECTED:/)
      return true
    },
  )
  assert.deepEqual(
    entriesOf(metricsDir, "blocked").map((r) => [r.agent, r.reason]),
    [["plan-reviewer", "plan-review-pending"]],
  )
})

test("planUserReview: the accept literal across the boundary unblocks the dispatch", async () => {
  const { ctx } = coreWith(reviewOn())
  ctx.admitPrompt("p1", { text: "plan it" }, "")
  await dispatchExpect(ctx, "p1", "planner", "plan it", false)
  ctx.admitPrompt("p1", { text: "looks good, maybe tweak section 2" }, "")
  assert.equal(
    ctx.ledger.state("p1").planReviewPending,
    true,
    "the pause survived the task-scope boundary",
  )
  ctx.admitPrompt("p1", { text: `${ACCEPT} go ahead` }, "")
  assert.equal(ctx.ledger.state("p1").planReviewPending, false)
  await dispatchExpect(ctx, "p1", "plan-reviewer", "review it", false)
})

test("planUserReview: the reject literal across the boundary retires the task", async () => {
  const { ctx, metricsDir } = coreWith(reviewOn())
  ctx.admitPrompt("p1", { text: "plan it" }, "")
  await dispatchExpect(ctx, "p1", "planner", "plan it", false)
  ctx.admitPrompt("p1", { text: "chat" }, "")
  // Arm the intent-nudge latch with a same-kind intent prompt (the
  // task-scope retire test's pattern): the first read delivery carries the
  // advisory nudge and latches the kind.
  ctx.admitPrompt("p1", { text: "fix the bug #123" }, "")
  const read1 = { sessionID: "p1", result: { output: "file contents" } }
  ctx.prependIntentNudgeRead(read1)
  assert.match(
    String(read1.result?.output),
    /\[turnstile\] Advisory reminder/,
    "the first same-kind intent nudged",
  )
  ctx.admitPrompt("p1", { text: `${REJECT} start over` }, "")
  assert.equal(ctx.ledger.state("p1").planReviewPending, false)
  assert.equal(ctx.ledger.state("p1").taskComplete, true, "the reject retires the task")
  assert.deepEqual(
    entriesOf(metricsDir, "plan-review").map((r) => r.action),
    ["pause", "reject"],
  )
  assert.equal(entriesOf(metricsDir, "task-complete").length, 1, "the retire is journaled")
  // The reject retire cleared the intent-nudge latch: the successor task's
  // same-kind intent re-nudges instead of being deduped away.
  ctx.admitPrompt("p1", { text: "fix the bug #123 again" }, "")
  const read2 = { sessionID: "p1", result: { output: "more contents" } }
  ctx.prependIntentNudgeRead(read2)
  assert.match(
    String(read2.result?.output),
    /\[turnstile\] Advisory reminder/,
    "the successor task's same-kind intent re-nudged after the reject retire",
  )
  // No counted plan-reviewer dispatch happened: the next prompt starts fresh.
  ctx.admitPrompt("p1", { text: "new task" }, "")
  assert.equal(ctx.ledger.state("p1").taskComplete, false, "the next prompt starts fresh")
})

test("planUserReview: accept/reject with nothing pending is a no-op", () => {
  const { ctx, metricsDir } = coreWith(reviewOn())
  ctx.admitPrompt("p1", { text: `${ACCEPT} yes` }, "")
  ctx.admitPrompt("p2", { text: `${REJECT} no` }, "")
  assert.deepEqual(entriesOf(metricsDir, "plan-review"), [], "no rows without a pending pause")
  assert.equal(ctx.ledger.state("p1").taskComplete, false)
})

test("planUserReview: REJECT then ACCEPT in one prompt ends accepted", async () => {
  const { ctx, metricsDir } = coreWith(reviewOn())
  ctx.admitPrompt("p1", { text: "plan it" }, "")
  await dispatchExpect(ctx, "p1", "planner", "plan it", false)
  ctx.admitPrompt("p1", { text: `${REJECT} no wait ${ACCEPT} yes` }, "")
  assert.equal(ctx.ledger.state("p1").planReviewPending, false, "the later ACCEPT wins")
  assert.equal(ctx.ledger.state("p1").taskComplete, false, "no retire on an accept win")
  assert.deepEqual(
    entriesOf(metricsDir, "plan-review").map((r) => r.action),
    ["pause", "accept"],
  )
})

test("planUserReview: ACCEPT then REJECT in one prompt ends rejected", async () => {
  const { ctx, metricsDir } = coreWith(reviewOn())
  ctx.admitPrompt("p1", { text: "plan it" }, "")
  await dispatchExpect(ctx, "p1", "planner", "plan it", false)
  ctx.admitPrompt("p1", { text: `${ACCEPT} hmm ${REJECT} actually no` }, "")
  assert.equal(ctx.ledger.state("p1").planReviewPending, false)
  assert.equal(ctx.ledger.state("p1").taskComplete, true, "the later REJECT retires")
  assert.deepEqual(
    entriesOf(metricsDir, "plan-review").map((r) => r.action),
    ["pause", "reject"],
  )
})

test("planUserReview: a second planner dispatch while pending journals no second pause row", async () => {
  const { ctx, metricsDir } = coreWith(reviewOn())
  ctx.admitPrompt("p1", { text: "plan it" }, "")
  await dispatchExpect(ctx, "p1", "planner", "plan it", false)
  await dispatchExpect(ctx, "p1", "planner", "plan it again", false)
  assert.equal(ctx.ledger.state("p1").planReviewPending, true)
  assert.deepEqual(
    entriesOf(metricsDir, "plan-review").map((r) => r.action),
    ["pause"],
    "an already-pending arm is a no-op",
  )
})

test("planUserReview: the reject retire sleeps an engaged pipeline", async () => {
  const { ctx, metricsDir } = coreWith(reviewOn())
  // A dispatch-classified prompt engages the pipeline before the pause arms.
  ctx.admitPrompt("p1", { text: "dispatch the planner subagent" }, "")
  assert.equal(ctx.ledger.state("p1").engaged, true, "the prompt engaged the pipeline")
  await dispatchExpect(ctx, "p1", "planner", "plan it", false)
  ctx.admitPrompt("p1", { text: "chat" }, "")
  ctx.admitPrompt("p1", { text: `${REJECT} start over` }, "")
  assert.equal(ctx.ledger.state("p1").taskComplete, true)
  assert.equal(ctx.ledger.state("p1").engaged, false, "the retire sleeps the pipeline")
  assert.ok(
    entriesOf(metricsDir, "engagement").some((r) => r.reason === "task-complete"),
    "the engagement abort row is journaled",
  )
})

test("planUserReview: a hostile prompt payload journals the capture error, never throws", () => {
  const { ctx, metricsDir } = coreWith(reviewOn())
  const hostile: Record<string, unknown> = {}
  Object.defineProperty(hostile, "text", {
    get(): string {
      throw new Error("hostile prompt")
    },
  })
  ctx.admitPrompt("p1", hostile, "")
  const errors = entriesOf(metricsDir, "error")
  assert.ok(
    errors.some((r) => String(r.error).includes("plan-review capture:")),
    "the capture error is journaled",
  )
})

// ── Fail-open arms ───────────────────────────────────────────────────────────

test("planUserReview: an internal arm error journals and the dispatch proceeds", async () => {
  const { ctx, metricsDir } = coreWith(reviewOn())
  const original = ctx.journaler.journal.bind(ctx.journaler)
  ctx.journaler.journal = (entry: Record<string, unknown>): void => {
    if (entry.type === "plan-review") throw new Error("journal down")
    original(entry)
  }
  await dispatchExpect(ctx, "p1", "planner", "plan it", false)
  const errors = entriesOf(metricsDir, "error")
  assert.ok(
    errors.some((r) => String(r.error).includes("plan-review arm:")),
    "the arm error is journaled",
  )
  assert.equal(entriesOf(metricsDir, "plan-review").length, 0)
})

test("planUserReview: an internal gate-read error journals and the dispatch proceeds", async () => {
  const { ctx, metricsDir } = coreWith(reviewOn())
  await dispatchExpect(ctx, "p1", "planner", "plan it", false)
  // A hostile bucket field: only the pause read fails, so the budget guard
  // and the admit exit stay healthy and the dispatch proceeds fail-open.
  const s = ctx.ledger.state("p1")
  Object.defineProperty(s, "planReviewPending", {
    get(): boolean {
      throw new Error("ledger down")
    },
    configurable: true,
  })
  await dispatchExpect(ctx, "p1", "plan-reviewer", "review it", false)
  const errors = entriesOf(metricsDir, "error")
  assert.ok(
    errors.some((r) => String(r.error).includes("plan-review gate:")),
    "the gate-read error is journaled",
  )
})

// ── Replay ───────────────────────────────────────────────────────────────────

/**
 * Writes the given raw lines as the journal of a fresh temp metrics dir.
 * @param metricsDir The temp metrics dir.
 * @param lines Raw journal lines.
 * @returns The journal path.
 */
function writeJournal(metricsDir: string, lines: string[]): string {
  const journalPath = path.join(metricsDir, "turnstile.jsonl")
  fs.writeFileSync(journalPath, lines.join("\n") + "\n")
  return journalPath
}

/**
 * A `plan-review` journal line for a session.
 * @param sessionID The session ID.
 * @param action The lifecycle action (`pause`/`accept`/`reject`).
 * @returns The raw JSONL line.
 */
function planReviewLine(sessionID: string, action: string): string {
  return JSON.stringify({ ts: "t", type: "plan-review", sessionID, action })
}

test("replay: the plan-review fold restores pending last-wins per action", () => {
  const metricsDir = tmpDir()
  const journalPath = writeJournal(metricsDir, [
    planReviewLine("p1", "pause"),
    planReviewLine("p2", "pause"),
    planReviewLine("p2", "accept"),
    planReviewLine("p3", "accept"),
    planReviewLine("p3", "pause"),
    planReviewLine("p4", "pause"),
    planReviewLine("p4", "reject"),
    JSON.stringify({ ts: "t", type: "plan-review", sessionID: "p5", action: "hostile" }),
  ])
  const ledger = createLedger(journalPath, 64, 2000)
  assert.equal(ledger.peek("p1")?.planReviewPending, true, "a pause restores pending")
  assert.equal(ledger.peek("p2")?.planReviewPending, false, "a later accept clears")
  assert.equal(ledger.peek("p3")?.planReviewPending, true, "a later pause re-arms")
  assert.equal(ledger.peek("p4")?.planReviewPending, false, "a reject clears")
  assert.equal(ledger.peek("p5"), undefined, "a hostile action mints no bucket")
})

test("replay: a reject row plus task-complete restores a retired, unpaused bucket", () => {
  const metricsDir = tmpDir()
  const journalPath = writeJournal(metricsDir, [
    planReviewLine("p1", "pause"),
    planReviewLine("p1", "reject"),
    JSON.stringify({ ts: "t", type: "task-complete", sessionID: "p1" }),
  ])
  const ledger = createLedger(journalPath, 64, 2000)
  const s = ledger.peek("p1")
  assert.ok(s, "the bucket is restored")
  assert.equal(s!.planReviewPending, false, "the reject clears the pause")
  assert.equal(s!.taskComplete, true, "the retire restores")
})

// ── Restart survival end-to-end ──────────────────────────────────────────────

test("planUserReview: a pending pause survives a restart; the accept then unblocks", async () => {
  const project = tmpDir()
  fs.mkdirSync(path.join(project, ".opencode", "plans"), { recursive: true })
  fs.writeFileSync(path.join(project, ".opencode", "plans", "plan.md"), "# P\n")
  const metricsDir = tmpDir()
  const prev = process.cwd()
  process.chdir(project)
  try {
    const h: FakeHost = makeFakeHost()
    const setup = turnstile(h.host, {
      env: isolatedEnv(metricsDir),
      config: { metricsDir, alwaysEnforce: true, planUserReview: true },
    })
    const dispose1 = (await setup(h.host)) as () => void
    await callSession(h, "prompt", { sessionID: "p1", text: "plan it" })
    await callTool(h, "execute.before", {
      tool: "task",
      sessionID: "p1",
      input: { agent: "planner", prompt: "plan it" },
    })
    dispose1()
    // Simulated restart: a fresh plugin over the same journal.
    const dispose2 = (await setup(h.host)) as () => void
    try {
      await assert.rejects(
        () =>
          callTool(h, "execute.before", {
            tool: "task",
            sessionID: "p1",
            input: { agent: "plan-reviewer", prompt: "review it" },
          }),
        (e: unknown) => e instanceof BlockError,
        "the pause replays back to pending",
      )
      await callSession(h, "prompt", { sessionID: "p1", text: `${ACCEPT} looks good` })
      await callTool(h, "execute.before", {
        tool: "task",
        sessionID: "p1",
        input: { agent: "plan-reviewer", prompt: "review it" },
      })
    } finally {
      dispose2()
    }
  } finally {
    process.chdir(prev)
  }
})

// ── Policy line ──────────────────────────────────────────────────────────────

test("policy: the user plan-review line appears only when planUserReview is on", () => {
  const defaultText = expectedPolicy({})
  assert.ok(!defaultText.includes("User plan review:"), "absent under the default config")
  const enabled = expectedPolicy({ planUserReview: true })
  assert.ok(enabled.includes("User plan review:"))
  assert.ok(enabled.includes("PLAN REVIEWED:"))
  assert.ok(enabled.includes("PLAN REJECTED:"))
  assert.ok(enabled.includes("waivers do not bypass this pause"))
  // The builder is the real one: the enabled text is exactly what the plugin
  // would inject for that config.
  const { config } = mergeConfig(defaultConfig({}), { planUserReview: true })
  assert.equal(enabled, orchestratorPolicyFor(config))
})
