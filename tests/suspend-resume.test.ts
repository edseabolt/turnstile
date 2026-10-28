/**
 * @fileoverview Gate suspend/resume tests: the prompt-channel
 * `TURNSTILE OFF:` / `TURNSTILE ON:` markers (capture, last-wins, the
 * allowSuspend refusal, the approval-interaction clear order), the
 * suppression of deliberate blocks at the dispatch, read-budget, and
 * catch-all bash choke points, the fresh-start resume contract (no stale
 * credit, child counters released), the replay of the suspension map across
 * a restart, and the inert permission-evaluate arms (including the landing
 * latch deletion).
 */

import { test } from "node:test"
import assert from "node:assert/strict"
import * as fs from "node:fs"
import * as path from "node:path"

import { BlockError, createGates } from "../src/gates.ts"
import { createHooksCore, type TurnstileContext } from "../src/hooks-core.ts"
import { createPermissionHooks } from "../src/hooks-permission.ts"
import { createLedger } from "../src/ledger.ts"
import { defaultConfig, mergeConfig } from "../src/config.ts"
import type { TurnstileConfig } from "../src/types.ts"
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

/** The default suspend marker literal. */
const OFF = "TURNSTILE OFF:"
/** The default resume marker literal. */
const ON = "TURNSTILE ON:"

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
    config: { metricsDir, ...config },
  })
  return { ctx, metricsDir }
}

/**
 * Boots the plugin in a temp project dir containing a plan file (so the plan
 * gate is live) with injected config overrides, for plugin-driven hook-body
 * tests. The project cwd is restored by the returned `restore`.
 * @param config Injected config overrides (applied last by loadConfig).
 * @returns The host tables, the journal's metrics dir, the dispose, and the
 *     restore (dispose + chdir back).
 */
async function bootWithPlan(
  config: Partial<TurnstileConfig> = {},
): Promise<{ h: FakeHost; metricsDir: string; restore: () => void }> {
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
    metricsDir,
    restore: (): void => {
      dispose()
      process.chdir(prev)
    },
  }
}

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

/** A `suspended` entry line for a session.
 *  @param sessionID The session ID to journal.
 *  @param extra Extra entry fields (e.g. the action or the audit event).
 *  @returns The raw JSONL line. */
function suspendedLine(sessionID: string, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({ ts: "t", type: "suspended", sessionID, ...extra })
}

/** The replay-drop telemetry entries appended to a metrics dir (the same
 *  replay-inert `suppressed`/`kind:"replay"` shape the replay chain writes).
 *  @param metricsDir The metrics dir to read.
 *  @returns The `suppressed` entries with `kind:"replay"`. */
function replayDrops(metricsDir: string): Array<Record<string, any>> {
  return journalEntries(metricsDir).filter((e) => e.type === "suppressed" && e.kind === "replay")
}

/** An allowed OFF prompt suspends the session: the `action:"off"` entry is
 *  journaled, and an executor dispatch that would throw the plan-gate block
 *  is allowed and journaled as a `suspended` would-block audit entry (the
 *  dispatch still metered and recorded as an admit). */
test("suspend: TURNSTILE OFF journals action:off and suppresses a dispatch block", async () => {
  const { h, metricsDir, restore } = await bootWithPlan()
  try {
    await callSession(h, "prompt", { sessionID: "p1", text: `${OFF} let me work` })
    await callTool(h, "execute.before", {
      tool: "task",
      sessionID: "p1",
      input: { agent: "executor", prompt: "do the work" },
    })
    assert.deepEqual(entriesOf(metricsDir, "suspended").slice(0, 1), [
      { type: "suspended", sessionID: "p1", action: "off" },
    ])
    assert.deepEqual(entriesOf(metricsDir, "suspended")[1], {
      type: "suspended",
      sessionID: "p1",
      event: "would-block",
      cause: "plan-gate",
    })
    assert.deepEqual(entriesOf(metricsDir, "dispatch"), [
      { type: "dispatch", sessionID: "p1", agent: "executor", description: "" },
    ])
  } finally {
    restore()
  }
})

/** The same dispatch without the OFF marker is enforced: the plan-gate block
 *  throws and no suspended entry exists — the control arm for the
 *  suppression predicate. */
test("suspend: without the OFF marker the dispatch block still throws", async () => {
  const { h, metricsDir, restore } = await bootWithPlan()
  try {
    await callSession(h, "prompt", { sessionID: "p1", text: "build it" })
    await assert.rejects(
      () =>
        callTool(h, "execute.before", {
          tool: "task",
          sessionID: "p1",
          input: { agent: "executor", prompt: "do the work" },
        }),
      (e: Error) => e instanceof BlockError,
    )
    assert.equal(entriesOf(metricsDir, "suspended").length, 0)
  } finally {
    restore()
  }
})

/** `allowSuspend:false` refuses the OFF marker: the refusal is journaled
 *  (`refused:true`), a marker-style diagnostic naming the literal is parked
 *  and surfaces as a `[turnstile] marker:` block, and enforcement still
 *  blocks (no state change). */
test("suspend: allowSuspend:false refuses the OFF marker with a surfaced diagnostic", async () => {
  const { h, metricsDir, restore } = await bootWithPlan({ allowSuspend: false })
  try {
    await callSession(h, "prompt", { sessionID: "p1", text: `${OFF} try anyway` })
    assert.deepEqual(entriesOf(metricsDir, "suspended"), [
      { type: "suspended", sessionID: "p1", action: "off", refused: true },
    ])
    await assert.rejects(
      () =>
        callTool(h, "execute.before", {
          tool: "task",
          sessionID: "p1",
          input: { agent: "executor", prompt: "do the work" },
        }),
      (e: Error) => e instanceof BlockError,
    )
    const event = { tool: "read", sessionID: "p1", result: { output: "body" } }
    await callTool(h, "execute.after", event)
    assert.match(String(event.result.output), /^\[turnstile\] marker:/)
    assert.match(String(event.result.output), /suspend/)
    assert.match(String(event.result.output), /TURNSTILE OFF:/)
  } finally {
    restore()
  }
})

/** A `PLAN APPROVED:` sharing the prompt with an allowed OFF is captured and
 *  then wiped by the fresh-start clear: the journal carries the approval row,
 *  the `action:"off"` entry, and the skip notice, and no credit survives on
 *  the bucket. */
test("suspend: PLAN APPROVED + OFF in one prompt clears last, no credit survives", () => {
  const { ctx } = coreWith({})
  ctx.admitPrompt("p1", { text: `PLAN APPROVED: ok\n${OFF} go manual` }, "")
  const dir = path.dirname(ctx.journaler.journalPath)
  const plan = journalEntries(dir).filter((e) => e.type === "plan")
  const stripped = journalEntries(dir)
    .filter((e) => e.type === "suspended")
    .map((e) => {
      const { ts: _ts, ...rest } = e
      return rest
    })
  const errors = journalEntries(dir).filter((e) => e.type === "error")
  assert.equal(plan.length, 1, "the approval was captured before the clear")
  assert.deepEqual(stripped, [{ type: "suspended", sessionID: "p1", action: "off" }])
  assert.ok(
    errors.some((e) => e.error === "approval capture skipped: prompt also suspended the gate"),
    "the skip notice is journaled",
  )
  const s = ctx.ledger.peek("p1")
  assert.ok(s, "the cleared bucket is rebuilt")
  assert.equal(s!.hasPlanVerdict, false, "no approval credit survives the clear")
  assert.equal(ctx.ledger.isSuspended("p1"), true, "the OFF still suspends")
})

/** When both markers appear in one prompt, the later one wins: OFF…ON ends
 *  enabled (dispatch blocks again) and ON…OFF ends suspended. */
test("suspend: with both markers in one prompt, the later one wins", () => {
  const { ctx } = coreWith({})
  ctx.admitPrompt("p1", { text: `${OFF} pause then ${ON} resume` }, "")
  assert.equal(ctx.ledger.isSuspended("p1"), false, "OFF then ON ends enabled")
  const { ctx: ctx2 } = coreWith({})
  ctx2.admitPrompt("p2", { text: `${ON} no ${OFF} stop` }, "")
  assert.equal(ctx2.ledger.isSuspended("p2"), true, "ON then OFF ends suspended")
})

/** A prompt with no suspend marker captures nothing: no suspended entry and
 *  no suspension flag. */
test("suspend: a prompt without the markers captures nothing", () => {
  const { ctx } = coreWith({})
  ctx.admitPrompt("p1", { text: "just build it" }, "")
  assert.equal(ctx.ledger.isSuspended("p1"), false)
})

/** `TURNSTILE ON:` resumes enforcement with fresh state: no credit minted
 *  while suspended survives, registered children's metering counters are
 *  released (journaled `child-reset`), and a dispatch that was suppressed
 *  during the suspension blocks again. */
test("suspend: TURNSTILE ON resumes with fresh state (no stale credit)", async () => {
  const project = tmpDir()
  fs.mkdirSync(path.join(project, ".opencode", "plans"), { recursive: true })
  fs.writeFileSync(path.join(project, ".opencode", "plans", "plan.md"), "# P\n")
  const metricsDir = tmpDir()
  const prev = process.cwd()
  process.chdir(project)
  try {
    const ctx = createHooksCore({
      env: isolatedEnv(metricsDir),
      config: { metricsDir },
    })
    ctx.admitPrompt("p1", { text: `${OFF} iterate` }, "")
    await ctx.guardedTaskDispatch("p1", "executor", "do the work", "go")
    assert.equal(ctx.ledger.isSuspended("p1"), true, "suspended before the ON")
    // Mint credit while suspended (a fresh-start ON must wipe it) and arm a
    // registered child with non-fresh counters (the child-reset journal).
    ctx.ledger.state("p1").hasGatePass = true
    ctx.ledger.setParent("c1", "p1")
    ctx.ledger.state("c1").totalDispatches = 2
    ctx.admitPrompt("p1", { text: `${ON} back to work` }, "")
    assert.equal(ctx.ledger.isSuspended("p1"), false, "the ON resumes enforcement")
    const s = ctx.ledger.peek("p1")
    assert.ok(s, "the resumed bucket is rebuilt")
    assert.equal(s!.hasGatePass, false, "no credit earned while suspended rehydrates")
    const childResets = entriesOf(metricsDir, "child-reset")
    assert.deepEqual(childResets, [{ type: "child-reset", sessionID: "p1", children: 1 }])
    await assert.rejects(
      () => ctx.guardedTaskDispatch("p1", "executor", "do the work", "go"),
      (e: Error) => e instanceof BlockError,
      "the plan gate blocks again after resume",
    )
  } finally {
    process.chdir(prev)
  }
})

/** Replay restores the suspension across a fresh ledger boot: `action:"off"`
 *  re-suspends, `action:"on"` clears (both last-wins), the
 *  `event:"would-block"` audit flavor folds inert, and a bad action is a
 *  shape drop (telemetried, never folded). */
test("suspend: replay restores suspension across a fresh ledger boot", () => {
  const metricsDir = tmpDir()
  const journalPath = writeJournal(metricsDir, [
    suspendedLine("s1", { action: "off" }),
    suspendedLine("s1", { event: "would-block", cause: "plan-gate" }),
    suspendedLine("s2", { action: "off" }),
    suspendedLine("s2", { action: "on" }),
    suspendedLine("s3", { action: "explode" }),
  ])
  const ledger = createLedger(journalPath, 64, 2000)
  assert.equal(ledger.isSuspended("s1"), true, "the OFF re-suspends across a restart")
  assert.equal(ledger.isSuspended("s2"), false, "the ON clears the suspension")
  assert.equal(ledger.isSuspended("s3"), false, "a bad action never toggles the flag")
  const drops = replayDrops(metricsDir)
  assert.equal(drops.length, 1, "the bad action is the only drop")
  assert.equal(drops[0]!.reason, "entry-shape")
  // Last-wins in the other direction: a later OFF after an ON suspends.
  const metricsDir2 = tmpDir()
  const ledger2 = createLedger(
    writeJournal(metricsDir2, [
      suspendedLine("s1", { action: "on" }),
      suspendedLine("s1", { action: "off" }),
    ]),
    64,
    2000,
  )
  assert.equal(ledger2.isSuspended("s1"), true, "the later action wins")
})

/** Both permission-evaluate arms are inert while suspended: the task arm
 *  returns before the ask and its latch, and the landing arm deletes the
 *  armed latch (no mislabeled landing ask after a resume). */
test("suspend: permission evaluate arms are inert while suspended", async () => {
  const project = tmpDir()
  fs.mkdirSync(path.join(project, ".opencode", "plans"), { recursive: true })
  fs.writeFileSync(path.join(project, ".opencode", "plans", "plan.md"), "# P\n")
  const metricsDir = tmpDir()
  const prev = process.cwd()
  process.chdir(project)
  try {
    const ctx = createHooksCore({
      env: isolatedEnv(metricsDir),
      config: { metricsDir },
    })
    const { evaluate } = createPermissionHooks(ctx)
    // Control arm: with a live red plan gate the task arm forces the ask.
    const before: any = { action: "task", sessionID: "p1" }
    evaluate(before)
    assert.equal(before.effect, "ask", "the red plan gate forces the ask when enforcing")
    // Landing arm control: an armed latch forces the landing ask.
    const armedAt = Date.now()
    ctx.pendingLandingAsk.set("p1", armedAt)
    const landing: any = { action: "bash", sessionID: "p1" }
    evaluate(landing)
    assert.equal(landing.effect, "ask", "an armed landing latch forces the ask when enforcing")
    // Suspend and re-evaluate both arms: inert, and the landing latch is
    // consumed (deleted) rather than left to fire after a resume.
    ctx.admitPrompt("p1", { text: `${OFF} pause` }, "")
    ctx.pendingLandingAsk.set("p1", armedAt)
    const taskSuspended: any = { action: "task", sessionID: "p1" }
    evaluate(taskSuspended)
    assert.equal(taskSuspended.effect, undefined, "the task arm is inert while suspended")
    const landingSuspended: any = { action: "bash", sessionID: "p1" }
    evaluate(landingSuspended)
    assert.equal(landingSuspended.effect, undefined, "the landing arm is inert while suspended")
    assert.equal(
      ctx.pendingLandingAsk.has("p1"),
      false,
      "the armed landing latch is deleted while suspended",
    )
  } finally {
    process.chdir(prev)
  }
})

/** A bash denylist block is swallowed at the `guardedToolBefore` choke while
 *  suspended (journaled `suspended` / `event:"would-block"`, tool proceeds);
 *  the same command without the OFF marker throws. */
test("suspend: a bash denylist block is swallowed while suspended", async () => {
  const deny = { toolPolicy: { bashDeny: ["forbiddencmd"] } } as Partial<TurnstileConfig>
  const blocked = await (async () => {
    const { h, restore } = await bootWithPlan({ ...deny })
    try {
      await callSession(h, "prompt", { sessionID: "p1", text: "run it" })
      await assert.rejects(
        () =>
          callTool(h, "execute.before", {
            tool: "bash",
            sessionID: "p1",
            input: { command: "echo forbiddencmd" },
          }),
        (e: Error) => e instanceof BlockError,
      )
      return true
    } finally {
      restore()
    }
  })()
  assert.equal(blocked, true, "the control arm enforces the denylist")
  const { h, metricsDir, restore } = await bootWithPlan({ ...deny })
  try {
    await callSession(h, "prompt", { sessionID: "p1", text: `${OFF} run it anyway` })
    await callTool(h, "execute.before", {
      tool: "bash",
      sessionID: "p1",
      input: { command: "echo forbiddencmd" },
    })
    const audits = entriesOf(metricsDir, "suspended").filter((e) => e.event === "would-block")
    assert.equal(audits.length, 1, "the suppressed block is journaled once")
    // The denylist BlockError carries no stamped cause, so the audit falls
    // back to the "gate" name.
    assert.equal(audits[0]!.cause, "gate")
  } finally {
    restore()
  }
})

/** A read-budget block is suppressed while suspended (journaled
 *  `suspended` with the read-budget cause); the same 15th read without the
 *  OFF marker throws. */
test("suspend: a read-budget block is suppressed while suspended", async () => {
  const reads = async (h: FakeHost): Promise<void> => {
    // 16 reads: the 15th succeeds and the 16th crosses the block threshold
    // (check-then-increment), so the control arm throws on the last one.
    for (let i = 0; i < 16; i++) {
      await callTool(h, "execute.before", {
        tool: "read",
        sessionID: "p1",
        input: { filePath: `f${i}.txt` },
      })
    }
  }
  const blocked = await (async () => {
    const { h, restore } = await bootWithPlan({})
    try {
      await callSession(h, "prompt", { sessionID: "p1", text: "read it" })
      await assert.rejects(
        () => reads(h),
        (e: Error) => e instanceof BlockError,
      )
      return true
    } finally {
      restore()
    }
  })()
  assert.equal(blocked, true, "the control arm enforces the read horizon")
  const { h, metricsDir, restore } = await bootWithPlan({})
  try {
    await callSession(h, "prompt", { sessionID: "p1", text: `${OFF} read it` })
    await reads(h)
    const audits = entriesOf(metricsDir, "suspended").filter((e) => e.event === "would-block")
    assert.deepEqual(audits, [
      { type: "suspended", sessionID: "p1", event: "would-block", cause: "read-budget" },
    ])
  } finally {
    restore()
  }
})

/** A clearState with no freed children journals no child-reset (the freed>0
 *  branch stays exclusive to real releases). */
test("suspend: an OFF without registered children journals no child-reset", () => {
  const { ctx } = coreWith({})
  ctx.admitPrompt("p1", { text: `${OFF} pause` }, "")
  const resets = journalEntries(ctx.journaler.journalPath).filter((e) => e.type === "child-reset")
  assert.equal(resets.length, 0)
})

/** The gates composition still builds with the config surface extended (a
 *  smoke check that nothing in the gate layer couples to the new keys). */
test("suspend: the gate layer builds untouched by the suspend config keys", () => {
  const { ctx } = coreWith({})
  const gates = createGates(ctx.config, ctx.journaler)
  assert.ok(typeof gates.guardReadLimit === "function")
})

/** An empty session ID is a no-op for the suspension store (no key, no
 *  flag). */
test("suspend: setSuspended is a no-op on an empty session ID", () => {
  const { ctx } = coreWith({})
  ctx.ledger.setSuspended("", true)
  assert.equal(ctx.ledger.isSuspended(""), false)
})

/** The three suspend/resume config keys validate and assign through the
 *  shared scalar helpers: booleans for allowSuspend, non-empty strings for
 *  the marker literals; invalid values warn and keep the defaults. */
test("suspend: config keys validate and assign through the scalar helpers", () => {
  const merged = mergeConfig(defaultConfig({}), {
    suspendMarker: "PAUSE NOW:",
    resumeMarker: "RESUME NOW:",
    allowSuspend: false,
  })
  assert.deepEqual(merged.warnings, [])
  assert.equal(merged.config.suspendMarker, "PAUSE NOW:")
  assert.equal(merged.config.resumeMarker, "RESUME NOW:")
  assert.equal(merged.config.allowSuspend, false)
  const rejected = mergeConfig(defaultConfig({}), {
    suspendMarker: "",
    resumeMarker: "   ",
    allowSuspend: "yes",
  })
  assert.equal(rejected.config.suspendMarker, "TURNSTILE OFF:", "an empty marker keeps the default")
  assert.equal(rejected.config.resumeMarker, "TURNSTILE ON:", "a blank marker keeps the default")
  assert.equal(rejected.config.allowSuspend, true, "a non-boolean keeps the default")
  assert.equal(rejected.warnings.length, 3, "each rejected key warns")
})

/** The suspension read fails open: a ledger throw at the suppression probe
 *  journals the `suspension read:` error and reports false, so the block
 *  proceeds normally (fail-toward-enforce). */
test("suspend: a failing suspension read journals and fails toward enforce", async () => {
  const project = tmpDir()
  fs.mkdirSync(path.join(project, ".opencode", "plans"), { recursive: true })
  fs.writeFileSync(path.join(project, ".opencode", "plans", "plan.md"), "# P\n")
  const metricsDir = tmpDir()
  const prev = process.cwd()
  process.chdir(project)
  try {
    const ctx = createHooksCore({
      env: isolatedEnv(metricsDir),
      config: { metricsDir },
    })
    const ledger = ctx.ledger as unknown as Record<string, unknown>
    ledger.isSuspended = (): boolean => {
      throw new Error("probe broken")
    }
    await assert.rejects(
      () => ctx.guardedTaskDispatch("p1", "executor", "do the work", ""),
      (e: Error) => e instanceof BlockError,
      "the block proceeds when the probe fails",
    )
    const errors = journalEntries(metricsDir).filter((e) => e.type === "error")
    assert.ok(
      errors.some((e) => typeof e.error === "string" && e.error.startsWith("suspension read:")),
      "the probe failure is journaled",
    )
  } finally {
    process.chdir(prev)
  }
})
