/**
 * @fileoverview Observe-mode tests: the pure `observe` entry builders, the
 * live ledger methods (phase stamping with the double-count guard,
 * would-block totals, the pending-summary probe), boot replay restoring the
 * period state exactly across a restart, and the hook-body enforcement half
 * — the admission stamping, the suppressed dispatch and read-budget blocks
 * (would-block journaling, metered admits, the cause fallback ladder), and
 * the fail-toward-enforce behavior when the observer itself fails.
 */

import { test } from "node:test"
import assert from "node:assert/strict"
import * as fs from "node:fs"
import * as path from "node:path"

import { BlockError } from "../src/gates.ts"
import { formatObserveSummary } from "../src/config.ts"
import { createHooksCore, type TurnstileContext } from "../src/hooks-core.ts"
import { createLedger } from "../src/ledger.ts"
import { observeEntry, observeSummaryEntry } from "../src/gates-common.ts"
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

/** An `observe` admission-stamp entry line for a session.
 *  @param sessionID The session ID to journal.
 *  @param phase The admission phase.
 *  @param observed The observed counter.
 *  @param wouldBlocks The would-blocks counter.
 *  @returns The raw JSONL line. */
function observeLine(
  sessionID: string,
  phase: "observe" | "enforce",
  observed: number,
  wouldBlocks: number,
): string {
  return JSON.stringify({ ts: "t", type: "observe", sessionID, phase, observed, wouldBlocks })
}

/** A `would-block` entry line for a session.
 *  @param sessionID The session ID to journal.
 *  @param observed The observed counter.
 *  @param wouldBlocks The would-blocks counter.
 *  @returns The raw JSONL line. */
function wouldBlockLine(sessionID: string, observed: number, wouldBlocks: number): string {
  return JSON.stringify({ ts: "t", type: "would-block", sessionID, observed, wouldBlocks })
}

/** The replay-drop telemetry entries appended to a metrics dir (the same
 *  replay-inert `suppressed`/`kind:"replay"` shape the replay chain writes).
 *  @param metricsDir The metrics dir to read.
 *  @returns The `suppressed` entries with `kind:"replay"`. */
function replayDrops(metricsDir: string): Array<Record<string, any>> {
  return journalEntries(metricsDir).filter((e) => e.type === "suppressed" && e.kind === "replay")
}

/** The `observe` builder returns the admission-stamp entry shape: the session,
 *  its phase, and both running totals (the totals are what make the last
 *  stamped line restore the whole period at replay). */
test("observeEntry builds the admission-stamp entry shape", () => {
  assert.deepEqual(observeEntry("p1", "observe", 2, 1), {
    type: "observe",
    sessionID: "p1",
    phase: "observe",
    observed: 2,
    wouldBlocks: 1,
  })
})

/** The `observeSummaryEntry` builder returns the end-of-period marker shape:
 *  no phase (replay folds it inert), the `kind:"summary"` and `injected`
 *  stamps, and both running totals. */
test("observeSummaryEntry builds the end-of-period marker shape", () => {
  assert.deepEqual(observeSummaryEntry("p3", 3, 1), {
    type: "observe",
    sessionID: "p3",
    kind: "summary",
    injected: true,
    observed: 3,
    wouldBlocks: 1,
  })
})

/** observePhase stamps a new session `observe` while the running total stays
 *  within the configured period, flips to `enforce` past it, marks the
 *  completing stamp, and returns the stored phase (no re-stamp) on repeat
 *  admission — the `observed` total increments exactly once per session. */
test("observePhase stamps observe then enforce and never re-counts a stamped session", () => {
  const metricsDir = tmpDir()
  const ledger = createLedger(path.join(metricsDir, "turnstile.jsonl"), 64, 2000, undefined, 2)
  assert.deepEqual(
    ledger.observePhase("s1"),
    { phase: "observe", isNew: true, completed: false },
    "the first session observes",
  )
  assert.deepEqual(
    ledger.observePhase("s2"),
    { phase: "observe", isNew: true, completed: false },
    "the second (last in-period) session observes",
  )
  assert.deepEqual(
    ledger.observePhase("s3"),
    { phase: "enforce", isNew: true, completed: true },
    "the session past the boundary enforces and completes the period",
  )
  assert.deepEqual(
    ledger.observePhase("s1"),
    { phase: "observe", isNew: false, completed: false },
    "a repeat admission reads the stored phase without re-stamping",
  )
  assert.deepEqual(
    ledger.observeCounts(),
    { observed: 3, wouldBlocks: 0, pendingSummary: true },
    "the total counts each session once and the completed period is pending",
  )
})

/** With a configured period of 0, or for an empty session ID, observePhase
 *  reports `off` and stamps nothing (the default path stays byte-identical). */
test("observePhase reports off for a zero period and an empty session ID", () => {
  const metricsDir = tmpDir()
  const disabled = createLedger(path.join(metricsDir, "turnstile.jsonl"), 64, 2000, undefined, 0)
  assert.deepEqual(
    disabled.observePhase("s1"),
    { phase: "off", isNew: false, completed: false },
    "a zero period is off for any session",
  )
  assert.deepEqual(
    disabled.observeCounts(),
    { observed: 0, wouldBlocks: 0, pendingSummary: false },
    "an off period stamps no totals",
  )
  const enabled = createLedger(path.join(metricsDir, "turnstile.jsonl"), 64, 2000, undefined, 2)
  assert.deepEqual(
    enabled.observePhase(""),
    { phase: "off", isNew: false, completed: false },
    "an empty session ID is off even with a live period",
  )
})

/** noteWouldBlock increments the running would-block total, returns both
 *  totals, re-records the session in the admission dedup set, and skips the
 *  set for an empty session ID. */
test("noteWouldBlock increments the total and re-records the session", () => {
  const metricsDir = tmpDir()
  const ledger = createLedger(path.join(metricsDir, "turnstile.jsonl"), 64, 2000, undefined, 2)
  ledger.observePhase("s1")
  assert.deepEqual(
    ledger.noteWouldBlock("s1"),
    { observed: 1, wouldBlocks: 1 },
    "the first suppression returns both running totals",
  )
  assert.deepEqual(
    ledger.noteWouldBlock("s1"),
    { observed: 1, wouldBlocks: 2 },
    "a second suppression keeps counting without re-admitting the session",
  )
  assert.deepEqual(
    ledger.observeCounts(),
    { observed: 1, wouldBlocks: 2, pendingSummary: false },
    "the totals reflect the suppressions",
  )
  // An empty session ID still counts the block but must not pollute the set.
  assert.deepEqual(
    ledger.noteWouldBlock(""),
    { observed: 1, wouldBlocks: 3 },
    "an empty session ID still counts the block",
  )
})

/** pendingSummary is true only when the observed total passes the configured
 *  period and no summary marker is present: a fresh (in-period) ledger is
 *  false, and a completed ledger is true. */
test("observeCounts pendingSummary tracks the period boundary", () => {
  const metricsDir = tmpDir()
  const ledger = createLedger(path.join(metricsDir, "turnstile.jsonl"), 64, 2000, undefined, 2)
  assert.equal(
    ledger.observeCounts().pendingSummary,
    false,
    "a fresh in-period ledger is not pending",
  )
  ledger.observePhase("s1")
  ledger.observePhase("s2")
  assert.equal(
    ledger.observeCounts().pendingSummary,
    false,
    "an in-period ledger (at the boundary) is not pending",
  )
  ledger.observePhase("s3")
  assert.equal(ledger.observeCounts().pendingSummary, true, "a completed period is pending")
})

/** A restart boots over the journaled tail and restores the period state
 *  exactly: the per-session phases, the running totals, and the pending probe
 *  all match the first boot, and a second boot re-folds identically (replay
 *  is idempotent and journals no drop over a well-shaped tail). */
test("replay restores the observe period exactly across a restart", () => {
  const metricsDir = tmpDir()
  const journalPath = writeJournal(metricsDir, [
    observeLine("s1", "observe", 1, 0),
    wouldBlockLine("s1", 1, 1),
    observeLine("s2", "observe", 2, 1),
    observeLine("s3", "enforce", 3, 1),
  ])
  const first = createLedger(journalPath, 64, 2000, undefined, 2)
  const firstSnapshot = {
    counts: first.observeCounts(),
    s1: first.observePhase("s1"),
    s2: first.observePhase("s2"),
    s3: first.observePhase("s3"),
  }
  assert.deepEqual(
    firstSnapshot.counts,
    { observed: 3, wouldBlocks: 1, pendingSummary: true },
    "the first boot restores the totals and the pending probe",
  )
  assert.equal(replayDrops(metricsDir).length, 0, "a well-shaped tail journals no drop")
  const second = createLedger(journalPath, 64, 2000, undefined, 2)
  assert.deepEqual(
    {
      counts: second.observeCounts(),
      s1: second.observePhase("s1"),
      s2: second.observePhase("s2"),
      s3: second.observePhase("s3"),
    },
    firstSnapshot,
    "a second boot re-folds the same period state",
  )
  assert.equal(replayDrops(metricsDir).length, 0, "the second boot journals no drop either")
})

/** The double-count guard, common case: an observe-period session with zero
 *  would-blocks (only its admission stamp in the tail) is recognized by its
 *  surviving phase stamp after a restart and is not re-incremented. */
test("replay does not re-count a zero-would-block observe session after a restart", () => {
  const metricsDir = tmpDir()
  const journalPath = writeJournal(metricsDir, [
    observeLine("s1", "observe", 1, 0),
    observeLine("s2", "observe", 2, 0),
  ])
  const ledger = createLedger(journalPath, 64, 2000, undefined, 2)
  assert.deepEqual(
    ledger.observePhase("s1"),
    { phase: "observe", isNew: false, completed: false },
    "the surviving stamp restores the phase without a new stamp",
  )
  assert.deepEqual(
    ledger.observeCounts(),
    { observed: 2, wouldBlocks: 0, pendingSummary: false },
    "the observed total is unchanged by the re-admission",
  )
})

/** The double-count guard, aged-stamp case: a session whose admission stamp
 *  rolled out of the tail but whose would-block line survived is restored as
 *  `observe` (a suppression presupposes an observe-phase stamp) without
 *  re-incrementing the observed total. */
test("replay restores an admitted session lacking a phase stamp without re-counting", () => {
  const metricsDir = tmpDir()
  const journalPath = writeJournal(metricsDir, [
    wouldBlockLine("s1", 2, 1),
    observeLine("s2", "observe", 2, 1),
  ])
  const ledger = createLedger(journalPath, 64, 2000, undefined, 2)
  assert.deepEqual(
    ledger.observePhase("s1"),
    { phase: "observe", isNew: false, completed: false },
    "an admitted session without a phase stamp restores its observe phase",
  )
  assert.deepEqual(
    ledger.observeCounts(),
    { observed: 2, wouldBlocks: 1, pendingSummary: false },
    "the observed total is unchanged by the re-admission",
  )
})

/** A journaled end-of-period summary marker is exempt from the phase check
 *  (it carries no phase) and sets the summary probe, so a completed period
 *  whose summary already surfaced is not pending after a restart. */
test("replay marks a journaled summary marker and clears pendingSummary", () => {
  const metricsDir = tmpDir()
  const journalPath = writeJournal(metricsDir, [
    observeLine("s1", "observe", 1, 0),
    observeLine("s2", "observe", 2, 0),
    observeLine("s3", "enforce", 3, 1),
    JSON.stringify(observeSummaryEntry("s3", 3, 1)),
  ])
  const ledger = createLedger(journalPath, 64, 2000, undefined, 2)
  assert.deepEqual(
    ledger.observeCounts(),
    { observed: 3, wouldBlocks: 1, pendingSummary: false },
    "a journaled summary marker clears the pending probe",
  )
  assert.equal(replayDrops(metricsDir).length, 0, "a summary marker folds inert, not a drop")
})

/** The same completed period with no journaled summary marker stays pending
 *  after a restart: the probe is true until the summary is journaled. */
test("replay keeps pendingSummary true when no summary marker is journaled", () => {
  const metricsDir = tmpDir()
  const journalPath = writeJournal(metricsDir, [
    observeLine("s1", "observe", 1, 0),
    observeLine("s2", "observe", 2, 0),
    observeLine("s3", "enforce", 3, 1),
  ])
  const ledger = createLedger(journalPath, 64, 2000, undefined, 2)
  assert.deepEqual(
    ledger.observeCounts(),
    { observed: 3, wouldBlocks: 1, pendingSummary: true },
    "a completed period with no summary marker is pending",
  )
})

/** The exact plan-approval gate block message. */
const NO_PLAN_MESSAGE =
  `BLOCKED by turnstile: no plan approval for "plan.md". Dispatch the plan-reviewer subagent first; proceed with executor only after the plan-reviewer's first line is ` +
  "`VERDICT: APPROVE crit=<n> high=<n> med=<n> low=<n>`, or obtain an explicit user waiver " +
  `(a user prompt this task must contain the literal marker 'USER WAIVER:' followed by the user's words).`

/** Creates a fresh hooks-core context over an isolated env and a temp
 *  metrics dir, so neither config resolution nor journaling touches the
 *  real home. An existing metrics dir (pre-seeded with a journal tail) can
 *  be supplied in place of a fresh one, for restart-over-tail tests: the
 *  journaler only appends, so the pre-seeded lines replay at boot.
 *  @param config Injected config overrides (applied last by loadConfig).
 *  @param existingMetricsDir Optional pre-seeded metrics dir (default: fresh).
 *  @returns The context plus the temp metrics dir (for journal assertions). */
function coreWith(
  config: Partial<TurnstileConfig>,
  existingMetricsDir?: string,
): { ctx: TurnstileContext; metricsDir: string } {
  const metricsDir = existingMetricsDir ?? tmpDir()
  const ctx = createHooksCore({
    env: isolatedEnv(metricsDir),
    config: { metricsDir, ...config },
  })
  return { ctx, metricsDir }
}

/** Boots the plugin in a temp project dir containing a plan file (so the
 *  plan gate is live) with injected config overrides, for plugin-driven
 *  hook-body tests.
 *  @param config Injected config overrides (applied last by loadConfig).
 *  @returns The host tables, the journal's metrics dir, the dispose, and
 *  the restore (dispose + chdir back). */
async function bootObserve(config: Partial<TurnstileConfig>): Promise<{
  h: FakeHost
  dispose: () => void
  metricsDir: string
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

/** The journal entries of the given type with their `ts` stamps stripped,
 *  in journal order, for deepEqual against the expected shapes.
 *  @param metricsDir The metrics dir to read.
 *  @param type The entry type to keep.
 *  @returns The matching entries with `ts: undefined`. */
function entriesOf(metricsDir: string, type: string): Array<Record<string, any>> {
  return journalEntries(metricsDir)
    .filter((e) => e.type === type)
    .map((e) => ({ ...e, ts: undefined }))
}

/** An executor dispatch inside its observe period is suppressed: the plan
 *  gate computes and journals its deliberate block as a would-block audit
 *  entry (the stamped plan-gate cause, the running period totals), the
 *  dispatch is still metered and journaled as an admit, and the hook
 *  resolves. */
test("an observe-period executor dispatch suppresses the plan-gate block and journals a would-block entry", async () => {
  const { h, metricsDir, restore } = await bootObserve({ observeSessions: 1 })
  try {
    await callSession(h, "prompt", { sessionID: "p1", text: "build it" })
    await callTool(h, "execute.before", {
      tool: "task",
      sessionID: "p1",
      input: { agent: "executor", prompt: "do the work" },
    })
    assert.deepEqual(entriesOf(metricsDir, "would-block"), [
      {
        ts: undefined,
        type: "would-block",
        sessionID: "p1",
        cause: "plan-gate",
        observed: 1,
        wouldBlocks: 1,
      },
    ])
    assert.deepEqual(entriesOf(metricsDir, "dispatch"), [
      { ts: undefined, type: "dispatch", sessionID: "p1", agent: "executor", description: "" },
    ])
  } finally {
    restore()
  }
})

/** The same dispatch outside the observe period is enforced: the plan gate
 *  block throws with its exact message, the dispatch journals blocked, and
 *  no observe-mode entry of any kind is journaled. */
test("an enforce-period executor dispatch enforces the plan-gate block and journals no observe entries", async () => {
  const { h, metricsDir, restore } = await bootObserve({})
  try {
    await callSession(h, "prompt", { sessionID: "p1", text: "a note for later" })
    await assert.rejects(
      () =>
        callTool(h, "execute.before", {
          tool: "task",
          sessionID: "p1",
          input: { agent: "executor", prompt: "do the work" },
        }),
      (e: Error) => e instanceof BlockError && e.message === NO_PLAN_MESSAGE,
    )
    assert.deepEqual(entriesOf(metricsDir, "dispatch"), [
      {
        ts: undefined,
        type: "dispatch",
        sessionID: "p1",
        agent: "executor",
        description: "",
        blocked: true,
      },
    ])
    assert.equal(entriesOf(metricsDir, "observe").length, 0)
    assert.equal(entriesOf(metricsDir, "would-block").length, 0)
    // An off period never arms the summary: a string-output delivery through
    // the real execute.after hook is untouched.
    const event = { tool: "read", sessionID: "p1", result: { output: "body" } }
    await callTool(h, "execute.after", event)
    assert.equal(String(event.result.output), "body", "no observe block for an off period")
  } finally {
    restore()
  }
})

/** A read-budget block inside the observe period is suppressed: the guard
 *  still computes its deliberate block, but the throw is swallowed into a
 *  would-block audit entry with the hardcoded read-budget cause, and the
 *  guard's meter is unchanged (the block fires before the
 *  check-then-increment's increment). */
test("an observe-period read-budget block is suppressed with its meter unchanged", () => {
  const { ctx, metricsDir } = coreWith({ observeSessions: 1, readBlock: 2 })
  ctx.admitPrompt("p1", { text: "read it" }, "")
  ctx.handleReadBudget("p1")
  ctx.handleReadBudget("p1")
  ctx.handleReadBudget("p1")
  assert.deepEqual(entriesOf(metricsDir, "would-block"), [
    {
      ts: undefined,
      type: "would-block",
      sessionID: "p1",
      cause: "read-budget",
      observed: 1,
      wouldBlocks: 1,
    },
  ])
  assert.equal(ctx.ledger.state("p1").reads, 2, "the suppressed block fires before the increment")
})

/** The same read-budget block outside the observe period enforces: the
 *  exact read-limit message throws and no observe-mode entry is journaled. */
test("an enforce-period read-budget block throws its exact message without observe entries", () => {
  const { ctx, metricsDir } = coreWith({ readBlock: 2 })
  ctx.handleReadBudget("p1")
  ctx.handleReadBudget("p1")
  assert.throws(
    () => ctx.handleReadBudget("p1"),
    (e: Error) =>
      e.message ===
      "BLOCKED by turnstile: 2 whole-file reads this session. Switch to grep/glob for targeted retrieval, or report being stuck and escalate to the user.",
  )
  assert.equal(entriesOf(metricsDir, "observe").length, 0)
  assert.equal(entriesOf(metricsDir, "would-block").length, 0)
})

/** Admission stamps the running period totals at each first admission: the
 *  configured two sessions take the observe phase and the third takes
 *  enforce, each entry carrying the totals at its stamp; a re-admission of
 *  an already-stamped session journals nothing new. */
test("admission stamps each first admission with the running period totals and dedupes repeats", () => {
  const { ctx, metricsDir } = coreWith({ observeSessions: 2 })
  ctx.admitPrompt("s1", { text: "one" }, "")
  ctx.admitPrompt("s2", { text: "two" }, "")
  ctx.admitPrompt("s3", { text: "three" }, "")
  ctx.admitPrompt("s1", { text: "one again" }, "")
  assert.deepEqual(entriesOf(metricsDir, "observe"), [
    {
      ts: undefined,
      type: "observe",
      sessionID: "s1",
      phase: "observe",
      observed: 1,
      wouldBlocks: 0,
    },
    {
      ts: undefined,
      type: "observe",
      sessionID: "s2",
      phase: "observe",
      observed: 2,
      wouldBlocks: 0,
    },
    {
      ts: undefined,
      type: "observe",
      sessionID: "s3",
      phase: "enforce",
      observed: 3,
      wouldBlocks: 0,
    },
  ])
})

/** With no observe period configured, admission journals no observe entry
 *  at all: the stamping point is a no-op for the default config. */
test("admission journals no observe entries when the period is unconfigured", () => {
  const { ctx, metricsDir } = coreWith({})
  ctx.admitPrompt("s1", { text: "one" }, "")
  ctx.admitPrompt("s2", { text: "two" }, "")
  assert.equal(entriesOf(metricsDir, "observe").length, 0)
})

/** A suppressed loop-cap block takes the cause fallback ladder's agent-name
 *  rung (the loop-cap throw stamps no gate cause): the would-block entry
 *  carries the dispatched agent, the dispatch is metered like an admit, and
 *  the call resolves. */
test("a suppressed loop-cap block falls back to the agent name as its would-block cause", async () => {
  const { ctx, metricsDir } = coreWith({ observeSessions: 1 })
  ctx.admitPrompt("p1", { text: "plan it" }, "")
  ctx.ledger.state("p1").plannerRounds = 3
  await ctx.guardedTaskDispatch("p1", "planner", "plan it", "")
  assert.deepEqual(entriesOf(metricsDir, "would-block"), [
    {
      ts: undefined,
      type: "would-block",
      sessionID: "p1",
      cause: "planner",
      observed: 1,
      wouldBlocks: 1,
    },
  ])
  assert.deepEqual(entriesOf(metricsDir, "dispatch"), [
    { ts: undefined, type: "dispatch", sessionID: "p1", agent: "planner", description: "" },
  ])
  assert.equal(
    ctx.ledger.state("p1").totalDispatches,
    1,
    "the suppressed dispatch is metered like an admit",
  )
})

/** The ladder's final rung: a suppressed block with no stamped cause and no
 *  dispatch agent name (the host named none) journals the `"gate"` fallback
 *  cause. */
test("a suppressed block with no cause and no agent name journals the gate fallback cause", async () => {
  const { ctx, metricsDir } = coreWith({ observeSessions: 1, maxTotalDispatches: 1 })
  ctx.admitPrompt("p1", { text: "plan it" }, "")
  await ctx.guardedTaskDispatch("p1", "planner", "plan it", "")
  await ctx.guardedTaskDispatch("p1", "", "work", "")
  assert.deepEqual(entriesOf(metricsDir, "would-block"), [
    {
      ts: undefined,
      type: "would-block",
      sessionID: "p1",
      cause: "gate",
      observed: 1,
      wouldBlocks: 1,
    },
  ])
})

/** A failing observer fails toward enforce on the dispatch path: the
 *  observer read throws, the error is journaled, and the original
 *  deliberate block propagates with its dispatch stamped blocked (the
 *  suppression never engages). */
test("a failing observer fails the dispatch path toward enforce", async () => {
  const { ctx, metricsDir } = coreWith({ observeSessions: 1 })
  ctx.admitPrompt("p1", { text: "plan it" }, "")
  ctx.ledger.state("p1").plannerRounds = 3
  const original = ctx.ledger.observePhase
  try {
    ctx.ledger.observePhase = (): never => {
      throw new Error("ledger down")
    }
    await assert.rejects(
      ctx.guardedTaskDispatch("p1", "planner", "plan it", ""),
      (e: Error) => e instanceof BlockError && /planner dispatch limit \(3\)/.test(e.message),
    )
  } finally {
    ctx.ledger.observePhase = original
  }
  const observerErrors = journalEntries(metricsDir).filter(
    (e) => e.type === "error" && String(e.error).startsWith("observe phase read:"),
  )
  assert.equal(observerErrors.length, 1, "the failed observer read is journaled")
  assert.deepEqual(entriesOf(metricsDir, "dispatch"), [
    {
      ts: undefined,
      type: "dispatch",
      sessionID: "p1",
      agent: "planner",
      description: "",
      blocked: true,
    },
  ])
  assert.equal(entriesOf(metricsDir, "would-block").length, 0)
})

/** A failing observer at the admission stamping point journals the error
 *  and the admission proceeds: the stamp is swallowed, and the unstamped
 *  session re-stamps on its next enforcement read, where it fails toward
 *  enforce. */
test("a failing observer at admission journals the error and the admission proceeds", () => {
  const { ctx, metricsDir } = coreWith({ observeSessions: 1 })
  const original = ctx.ledger.observePhase
  try {
    ctx.ledger.observePhase = (): never => {
      throw new Error("ledger down")
    }
    ctx.admitPrompt("p1", { text: "plan it" }, "")
  } finally {
    ctx.ledger.observePhase = original
  }
  const stampErrors = journalEntries(metricsDir).filter(
    (e) => e.type === "error" && String(e.error).startsWith("observe admission stamp:"),
  )
  assert.equal(stampErrors.length, 1, "the failed admission stamp is journaled")
  assert.equal(entriesOf(metricsDir, "observe").length, 0)
})

/** A non-BlockError guard failure is never suppressed: the observer is
 *  never consulted (it suppresses deliberate blocks only) and the internal
 *  error propagates to the fail-open handler. */
test("a non-BlockError read-guard failure propagates without consulting the observer", () => {
  const { ctx, metricsDir } = coreWith({ observeSessions: 1 })
  ctx.admitPrompt("p1", { text: "read it" }, "")
  const original = ctx.gates.guardReadLimit
  try {
    ctx.gates.guardReadLimit = (): never => {
      throw new Error("gate boom")
    }
    assert.throws(
      () => ctx.handleReadBudget("p1"),
      (e: Error) => e.message === "gate boom",
    )
  } finally {
    ctx.gates.guardReadLimit = original
  }
  const observerErrors = journalEntries(metricsDir).filter(
    (e) => e.type === "error" && String(e.error).startsWith("observe phase read:"),
  )
  assert.equal(observerErrors.length, 0, "the observer is never consulted for a non-BlockError")
  assert.equal(entriesOf(metricsDir, "would-block").length, 0)
})

/** The end-of-period summary renders its exact counts first line (suppressed
 *  attempt count, then observed session count, then the enforcement notice)
 *  followed by the single journal-path line; a zero-period renders the same
 *  shape with zero counts. */
test("formatObserveSummary renders the exact counts line and the journal path", () => {
  assert.equal(
    formatObserveSummary({ observed: 12, wouldBlocks: 7 }, "/m/turnstile.jsonl"),
    "[turnstile] observe: Observe period complete: 7 premature dispatch attempts would have been blocked, 12 sessions observed. Enforcing from now on.\n" +
      "[journal: /m/turnstile.jsonl]",
    "a non-zero period renders the exact two-line block",
  )
  assert.equal(
    formatObserveSummary({ observed: 0, wouldBlocks: 0 }, "/m/turnstile.jsonl"),
    "[turnstile] observe: Observe period complete: 0 premature dispatch attempts would have been blocked, 0 sessions observed. Enforcing from now on.\n" +
      "[journal: /m/turnstile.jsonl]",
    "a zero period renders the same shape with zero counts",
  )
})

/** The period transition end to end: in-period sessions suppress their
 *  plan-gate blocks as would-block audit entries, the session admitted past
 *  the boundary enforces and arms the summary, a result-less or non-string
 *  delivery keeps it pending, the first string-output delivery carries the
 *  exact counts line and journals the injected marker, and the block is
 *  once-per-load. */
test("the completing session enforces and the first string-output delivery surfaces the observe summary", async () => {
  const { h, metricsDir, restore } = await bootObserve({ observeSessions: 2 })
  try {
    await callSession(h, "prompt", { sessionID: "p1", text: "one" })
    await callTool(h, "execute.before", {
      tool: "task",
      sessionID: "p1",
      input: { agent: "executor", prompt: "p" },
    })
    await callSession(h, "prompt", { sessionID: "p2", text: "two" })
    await callTool(h, "execute.before", {
      tool: "task",
      sessionID: "p2",
      input: { agent: "executor", prompt: "p" },
    })
    await callSession(h, "prompt", { sessionID: "p3", text: "three" })
    await assert.rejects(
      () =>
        callTool(h, "execute.before", {
          tool: "task",
          sessionID: "p3",
          input: { agent: "executor", prompt: "p" },
        }),
      (e: Error) => e instanceof BlockError && e.message === NO_PLAN_MESSAGE,
    )
    const nonString = { tool: "read", sessionID: "p3", result: { output: 42 } }
    await callTool(h, "execute.after", nonString)
    assert.equal(
      String(nonString.result.output),
      "42",
      "a non-string delivery keeps the summary pending",
    )
    const event = { tool: "read", sessionID: "p3", result: { output: "body" } }
    await callTool(h, "execute.after", event)
    const out = String(event.result.output)
    assert.equal(
      out.split("\n")[0],
      "[turnstile] observe: Observe period complete: 2 premature dispatch attempts would have been blocked, 3 sessions observed. Enforcing from now on.",
      "the first line carries the exact period totals",
    )
    assert.ok(
      out.includes(path.join(metricsDir, "turnstile.jsonl")),
      "the journal-path line is present",
    )
    assert.ok(out.endsWith("body"), "the original output is preserved")
    assert.deepEqual(entriesOf(metricsDir, "observe").at(-1), {
      ts: undefined,
      type: "observe",
      sessionID: "p3",
      kind: "summary",
      injected: true,
      observed: 3,
      wouldBlocks: 2,
    })
    const second = { tool: "read", sessionID: "p3", result: { output: "body" } }
    await callTool(h, "execute.after", second)
    assert.equal(String(second.result.output), "body", "a second delivery is untouched")
  } finally {
    restore()
  }
})

/** A delivery whose output mutation throws fails open: the error is journaled,
 *  no marker lands, and the summary stays pending for a later delivery, which
 *  then surfaces it exactly once. */
test("a throwing observe-summary mutation fails open and keeps the summary pending", async () => {
  const { h, metricsDir, restore } = await bootObserve({ observeSessions: 1 })
  try {
    await callSession(h, "prompt", { sessionID: "p1", text: "one" })
    await callSession(h, "prompt", { sessionID: "p2", text: "two" })
    let threw = false
    try {
      // A frozen result: assigning the prefaced value throws in strict mode.
      await callTool(h, "execute.after", {
        tool: "read",
        sessionID: "p2",
        result: Object.freeze({ output: "frozen-body" }),
      })
    } catch {
      threw = true
    }
    assert.equal(threw, false, "the hook completes even when the mutation throws")
    const errors = journalEntries(metricsDir).filter(
      (e) => e.type === "error" && String(e.error).startsWith("observe summary injection:"),
    )
    assert.equal(errors.length, 1, "the failed injection is journaled")
    assert.equal(
      journalEntries(metricsDir).filter((e) => e.type === "observe" && e.kind === "summary").length,
      0,
      "no summary marker landed",
    )
    const later = { tool: "read", sessionID: "p2", result: { output: "body" } }
    await callTool(h, "execute.after", later)
    assert.equal(
      String(later.result.output).split("\n")[0],
      "[turnstile] observe: Observe period complete: 0 premature dispatch attempts would have been blocked, 2 sessions observed. Enforcing from now on.",
      "the later delivery surfaces the pending summary",
    )
    assert.equal(
      journalEntries(metricsDir).filter((e) => e.type === "observe" && e.kind === "summary").length,
      1,
      "the later delivery journals the marker",
    )
  } finally {
    restore()
  }
})

/** A restart over a completed period lacking its journaled summary marker
 *  re-arms the one-shot from replay: a result-less delivery consumes
 *  nothing, the first string-output delivery surfaces the replayed totals and
 *  journals the marker under the surfacing session, and a second delivery is
 *  untouched. */
test("a restart re-arms a completed period lacking its journaled summary marker", () => {
  const metricsDir = tmpDir()
  writeJournal(metricsDir, [
    observeLine("s1", "observe", 1, 0),
    observeLine("s2", "observe", 2, 0),
    observeLine("s3", "enforce", 3, 1),
  ])
  const { ctx } = coreWith({ observeSessions: 2 }, metricsDir)
  ctx.surfaceObserveSummary({ tool: "read", sessionID: "s4" })
  const event = { tool: "read", sessionID: "s4", result: { output: "body" } }
  ctx.surfaceObserveSummary(event)
  const out = String(event.result.output)
  assert.equal(
    out.split("\n")[0],
    "[turnstile] observe: Observe period complete: 1 premature dispatch attempts would have been blocked, 3 sessions observed. Enforcing from now on.",
    "the replayed totals surface after restart",
  )
  assert.ok(out.endsWith("body"), "the original output is preserved")
  assert.deepEqual(entriesOf(metricsDir, "observe").at(-1), {
    ts: undefined,
    type: "observe",
    sessionID: "s4",
    kind: "summary",
    injected: true,
    observed: 3,
    wouldBlocks: 1,
  })
  const second = { tool: "read", sessionID: "s4", result: { output: "body" } }
  ctx.surfaceObserveSummary(second)
  assert.equal(String(second.result.output), "body", "a second delivery is untouched")
})

/** A restart over a completed period whose summary already surfaced (the
 *  journaled marker in the tail) re-arms nothing: a string-output delivery is
 *  untouched and journals no second marker. */
test("a restart does not re-arm a completed period whose summary already surfaced", () => {
  const metricsDir = tmpDir()
  writeJournal(metricsDir, [
    observeLine("s1", "observe", 1, 0),
    observeLine("s2", "observe", 2, 0),
    observeLine("s3", "enforce", 3, 1),
    JSON.stringify(observeSummaryEntry("s3", 3, 1)),
  ])
  const { ctx } = coreWith({ observeSessions: 2 }, metricsDir)
  const event = { tool: "read", sessionID: "s4", result: { output: "body" } }
  ctx.surfaceObserveSummary(event)
  assert.equal(String(event.result.output), "body", "no re-surfacing after restart")
  assert.equal(
    journalEntries(metricsDir).filter((e) => e.type === "observe" && e.kind === "summary").length,
    1,
    "the pre-existing marker is the only one",
  )
})
