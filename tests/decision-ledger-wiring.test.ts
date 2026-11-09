/**
 * @fileoverview Decision-ledger wiring tests: the `prov:stated` capture
 * inside the single deduped prompt-admission body (both transport paths,
 * dedupe, child exclusion, fail-open), the `prov:denied` capture at the
 * three human permission-deny sites (plan, landing, hands-on), and the
 * `prov:waiver` capture at the two human gate-waiver sites (plan gate,
 * reviewer gate).
 */

import { test } from "node:test"
import assert from "node:assert/strict"
import * as fs from "node:fs"
import * as path from "node:path"

import { createHooksCore, type TurnstileContext } from "../src/hooks-core.ts"
import { createEventHandlers } from "../src/event-stream-handlers.ts"
import { journalProvWaiver } from "../src/gates-common.ts"
import { defaultAgents } from "../src/config-merge.ts"
import { planGateStages } from "../src/plan-gate-status.ts"
import { turnstile } from "../turnstile.ts"
import type { TurnstileConfig } from "../src/types.ts"
import {
  callSession,
  callTool,
  isolatedEnv,
  journalEntries,
  makeFakeHost,
  tmpDir,
  type FakeHost,
} from "./helpers.ts"

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

/** The `prov:*` entries of a metrics dir with their `ts` stamps stripped,
 *  in journal order, for deepEqual against the expected shapes.
 *  @param metricsDir The metrics dir to read.
 *  @returns The matching entries with `ts: undefined`. */
function provEntriesOf(metricsDir: string): Array<Record<string, any>> {
  return journalEntries(metricsDir)
    .filter((e) => String(e.type).startsWith("prov:"))
    .map((e) => ({ ...e, ts: undefined }))
}

/** The `error` entries of a metrics dir with their `ts` stamps stripped.
 *  @param metricsDir The metrics dir to read.
 *  @returns The matching entries with `ts: undefined`. */
function provErrorEntriesOf(metricsDir: string): Array<Record<string, any>> {
  return journalEntries(metricsDir)
    .filter((e) => e.type === "error" && String(e.error).startsWith("prov:"))
    .map((e) => ({ ...e, ts: undefined }))
}

/** An admitted parent prompt journals exactly one `prov:stated` row with
 *  the prompt text mechanically redacted at write time. */
test("admitted parent prompt journals one redacted prov:stated row", () => {
  const { ctx, metricsDir } = coreWith({})
  ctx.admitPrompt("p1", { text: "deploy with AKIAIOSFODNN7EXAMPLE now" }, "")
  assert.deepEqual(provEntriesOf(metricsDir), [
    {
      ts: undefined,
      type: "prov:stated",
      sessionID: "p1",
      text: "deploy with [REDACTED] now",
      truncated: false,
    },
  ])
})

/** A "continue" prompt is captured like any other: capture applies no
 *  relevance filtering (capture is dumb, derivation is offline). */
test("a continue prompt is captured without relevance filtering", () => {
  const { ctx, metricsDir } = coreWith({})
  ctx.admitPrompt("p1", { text: "continue" }, "")
  assert.deepEqual(provEntriesOf(metricsDir), [
    { ts: undefined, type: "prov:stated", sessionID: "p1", text: "continue", truncated: false },
  ])
})

/** A prompt admitted for a session registered as a pipeline child (a
 *  dispatch prompt) journals no row. */
test("a pipeline-child dispatch prompt journals no prov row", () => {
  const { ctx, metricsDir } = coreWith({})
  ctx.ledger.childToParent.set("c1", "p1")
  ctx.admitPrompt("c1", { text: "do the dispatched work" }, "")
  assert.deepEqual(provEntriesOf(metricsDir), [])
})

/** The same prompt arriving on both transport paths (shared host message
 *  id) journals exactly one row — the capture rides the deduped admission
 *  body, not the raw hook site. */
test("a dual-transport prompt journals exactly one prov:stated row", () => {
  const { ctx, metricsDir } = coreWith({})
  ctx.admitPrompt("p1", { text: "once only", messageID: "m1" }, "m1")
  ctx.admitPrompt("p1", { sessionID: "p1", text: "once only" }, "m1")
  assert.equal(provEntriesOf(metricsDir).length, 1)
})

/** The inbox admission path is a human prompt and captures for free: the
 *  capture lives inside the admission body both paths funnel into. */
test("an inbox-path admission journals one prov:stated row", () => {
  const { ctx, metricsDir } = coreWith({})
  const handlers = createEventHandlers(ctx)
  handlers["session.inbox.enqueued"]!({
    sessionID: "p1",
    inboxID: "i1",
    item: { type: "user", payload: { text: "from the inbox" } },
  })
  assert.deepEqual(provEntriesOf(metricsDir), [
    {
      ts: undefined,
      type: "prov:stated",
      sessionID: "p1",
      text: "from the inbox",
      truncated: false,
    },
  ])
})

/** Each human deny reply journals one `prov:denied` row carrying the ask
 *  kind of the site that recorded the ask. */
test("each deny site journals prov:denied with its kind", () => {
  const { ctx, metricsDir } = coreWith({})
  ctx.planGateAsks.set("r1", { sessionID: "p1", recordedAt: 0 })
  ctx.landingGateAsks.set("r2", { sessionID: "p1", recordedAt: 0 })
  ctx.handsOnGateAsks.set("r3", { sessionID: "p1", recordedAt: 0 })
  const handlers = createEventHandlers(ctx)
  handlers["permission.replied"]!({
    sessionID: "p1",
    requestID: "r1",
    reply: "reject",
  })
  handlers["permission.replied"]!({
    sessionID: "p1",
    requestID: "r2",
    reply: "reject",
  })
  handlers["permission.replied"]!({
    sessionID: "p1",
    requestID: "r3",
    reply: "reject",
  })
  assert.deepEqual(provEntriesOf(metricsDir), [
    { ts: undefined, type: "prov:denied", sessionID: "p1", kind: "plan" },
    { ts: undefined, type: "prov:denied", sessionID: "p1", kind: "landing" },
    { ts: undefined, type: "prov:denied", sessionID: "p1", kind: "hands-on" },
  ])
})

/** With `decisionLedger.enabled: false` every MVP capture surface is silent:
 *  admitted prompts journal no `prov:stated` row and deny replies journal no
 *  `prov:denied` row (the deny reply itself still applies). */
test("decisionLedger disabled silences all MVP capture surfaces", () => {
  const { ctx, metricsDir } = coreWith({ decisionLedger: { enabled: false } })
  ctx.admitPrompt("p1", { text: "not captured" }, "")
  ctx.planGateAsks.set("r1", { sessionID: "p1", recordedAt: 0 })
  const handlers = createEventHandlers(ctx)
  handlers["permission.replied"]!({ sessionID: "p1", requestID: "r1", reply: "reject" })
  assert.deepEqual(provEntriesOf(metricsDir), [])
  assert.deepEqual(provErrorEntriesOf(metricsDir), [])
  assert.ok(
    journalEntries(metricsDir).some((e) => e.type === "permission" && e.decision === "reject"),
    "the deny reply still journals its own decision row",
  )
})

/** A capture failure is fail-open: the error is journaled as an `error`
 *  row and the admission completes without throwing. The journaler is
 *  swapped for one that throws only on `prov:` rows, so the fail-open
 *  error row itself still lands. */
test("a decision-ledger capture failure journals an error row and never throws", () => {
  const { ctx, metricsDir } = coreWith({})
  const original = ctx.journaler.journal.bind(ctx.journaler)
  ;(ctx.journaler as { journal: (entry: Record<string, unknown>) => void }).journal = (entry) => {
    if (String(entry.type).startsWith("prov:")) throw new Error("disk full")
    original(entry)
  }
  ctx.admitPrompt("p1", { text: "still admitted" }, "")
  assert.deepEqual(provEntriesOf(metricsDir), [])
  assert.deepEqual(provErrorEntriesOf(metricsDir), [
    {
      ts: undefined,
      type: "error",
      sessionID: "p1",
      error: "prov: stated capture: Error: disk full",
    },
  ])
})

/** A denial-capture failure is fail-open the same way: the deny reply still
 *  applies, the error is journaled, and nothing throws. */
test("a denial-capture failure journals an error row and never throws", () => {
  const { ctx, metricsDir } = coreWith({})
  const original = ctx.journaler.journal.bind(ctx.journaler)
  ;(ctx.journaler as { journal: (entry: Record<string, unknown>) => void }).journal = (entry) => {
    if (String(entry.type).startsWith("prov:")) throw new Error("disk full")
    original(entry)
  }
  ctx.planGateAsks.set("r1", { sessionID: "p1", recordedAt: 0 })
  const handlers = createEventHandlers(ctx)
  handlers["permission.replied"]!({
    sessionID: "p1",
    requestID: "r1",
    reply: "reject",
  })
  assert.deepEqual(provEntriesOf(metricsDir), [])
  assert.deepEqual(provErrorEntriesOf(metricsDir), [
    {
      ts: undefined,
      type: "error",
      sessionID: "p1",
      error: "prov: denied capture: Error: disk full",
    },
  ])
})

/** Boots the plugin over a fake host in a temp project dir containing a plan
 *  file (the plan gate needs a resolvable plan to reach the waiver branch).
 *  @returns The fake host, the dispose callback, and the metrics dir. */
async function bootWithPlan(): Promise<{
  h: FakeHost
  dispose: () => void
  metricsDir: string
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
    dispose: (): void => {
      dispose()
      process.chdir(prev)
    },
    metricsDir,
  }
}

/** The `prov:waiver` rows of a metrics dir with `ts` stamps stripped.
 *  @param metricsDir The metrics dir to read.
 *  @returns The matching entries with `ts: undefined`. */
function provWaiversOf(metricsDir: string): Array<Record<string, any>> {
  return provEntriesOf(metricsDir).filter((e) => e.type === "prov:waiver")
}

/** A waiver-covered executor dispatch journals exactly one `prov:waiver`
 *  row whose stages are the plan gate's covered stage group. */
test("a waiver-covered executor dispatch journals prov:waiver with the plan-gate stages", async () => {
  const { h, dispose, metricsDir } = await bootWithPlan()
  try {
    await callSession(h, "prompt", { sessionID: "p1", text: "USER WAIVER: ship it" })
    await callTool(h, "execute.before", {
      tool: "task",
      sessionID: "p1",
      input: { agent: "executor", prompt: "do the work" },
    })
    assert.deepEqual(provWaiversOf(metricsDir), [
      {
        ts: undefined,
        type: "prov:waiver",
        sessionID: "p1",
        stages: planGateStages({ agents: defaultAgents() } as TurnstileConfig),
      },
    ])
  } finally {
    dispose()
  }
})

/** A waiver-covered reviewer dispatch journals exactly one `prov:waiver`
 *  row whose stages name the configured reviewer agent. */
test("a waiver-covered reviewer dispatch journals prov:waiver with the reviewer stage", async () => {
  const { h, dispose, metricsDir } = await bootWithPlan()
  try {
    await callSession(h, "prompt", { sessionID: "p1", text: "USER WAIVER: ship it" })
    await callTool(h, "execute.before", {
      tool: "task",
      sessionID: "p1",
      input: { agent: "reviewer", prompt: "review it" },
    })
    assert.deepEqual(provWaiversOf(metricsDir), [
      {
        ts: undefined,
        type: "prov:waiver",
        sessionID: "p1",
        stages: [defaultAgents().reviewer],
      },
    ])
  } finally {
    dispose()
  }
})

/** With `decisionLedger.enabled: false` a waiver-covered dispatch journals
 *  no `prov:waiver` row (the WAIVED gate entry itself still lands). */
test("decisionLedger disabled silences waiver capture too", async () => {
  const project = tmpDir()
  fs.mkdirSync(path.join(project, ".opencode", "plans"), { recursive: true })
  fs.writeFileSync(path.join(project, ".opencode", "plans", "plan.md"), "# P\n")
  const metricsDir = tmpDir()
  const h = makeFakeHost()
  const prev = process.cwd()
  process.chdir(project)
  const setup = turnstile(h.host, {
    env: isolatedEnv(metricsDir),
    config: { metricsDir, alwaysEnforce: true, decisionLedger: { enabled: false } },
  })
  const dispose = (await setup(h.host)) as () => void
  try {
    await callSession(h, "prompt", { sessionID: "p1", text: "USER WAIVER: ship it" })
    await callTool(h, "execute.before", {
      tool: "task",
      sessionID: "p1",
      input: { agent: "executor", prompt: "do the work" },
    })
    assert.deepEqual(provEntriesOf(metricsDir), [])
    assert.ok(
      journalEntries(metricsDir).some((e) => e.type === "plan" && e.result === "WAIVED"),
      "the plan gate still journals its own WAIVED entry",
    )
  } finally {
    dispose()
    process.chdir(prev)
  }
})

/** A waiver-capture failure is fail-open: the error is journaled as an
 *  `error` row and nothing throws. The journaler is swapped for one that
 *  throws only on `prov:` rows, so the fail-open error row itself still
 *  lands. */
test("a waiver-capture failure journals an error row and never throws", () => {
  const { ctx, metricsDir } = coreWith({})
  const original = ctx.journaler.journal.bind(ctx.journaler)
  ;(ctx.journaler as { journal: (entry: Record<string, unknown>) => void }).journal = (entry) => {
    if (String(entry.type).startsWith("prov:")) throw new Error("disk full")
    original(entry)
  }
  journalProvWaiver(ctx.journaler, ctx.config, "p1", ["executor"])
  assert.deepEqual(provWaiversOf(metricsDir), [])
  assert.deepEqual(provErrorEntriesOf(metricsDir), [
    {
      ts: undefined,
      type: "error",
      sessionID: "p1",
      error: "prov: waiver capture: Error: disk full",
    },
  ])
})
