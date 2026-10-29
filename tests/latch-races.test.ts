/**
 * @fileoverview Multi-session latch-race tests: with the plan-gate and
 * landing-gate ask latches armed on two parents at once, a human reply must
 * apply only to the recorded ask matching its host request id — never to a
 * different parent's gate — an unknown request id must journal only an
 * unrecorded reply, and per-session outcomes must not depend on the order in
 * which the replies arrive. All boots run over a fake host in a temp project
 * dir holding one plan file, with the landing gate in enforce mode.
 */

import { test } from "node:test"
import assert from "node:assert/strict"
import * as fs from "node:fs"
import * as path from "node:path"

import { defaultConfig } from "../src/config.ts"
import { turnstile } from "../turnstile.ts"
import {
  callPermission,
  callTool,
  isolatedEnv,
  journalEntries,
  makeFakeHost,
  tmpDir,
  type FakeHost,
} from "./helpers.ts"

/**
 * Boots a temp project dir whose `.opencode/plans` holds one plan file and
 * the plugin over a fake host with a temp metrics dir and the landing gate in
 * enforce mode (repeat push attempts escalate instead of only journaling).
 * @param config Injected turnstile config overrides.
 * @returns The host, metrics dir, project dir, and a cwd-restoring disposer.
 */
async function boot(
  config: Record<string, any> = {},
): Promise<{ h: FakeHost; metricsDir: string; project: string; restore: () => void }> {
  const project = tmpDir()
  fs.mkdirSync(path.join(project, ".opencode", "plans"), { recursive: true })
  fs.writeFileSync(
    path.join(project, ".opencode", "plans", "plan.md"),
    "# Plan\n\nSome plan body text.\n",
  )
  const metricsDir = tmpDir()
  const h = makeFakeHost()
  const prev = process.cwd()
  process.chdir(project)
  const setup = turnstile(h.host, {
    env: isolatedEnv(metricsDir),
    config: {
      metricsDir,
      gitGates: {
        ...defaultConfig({}).gitGates,
        // Pinned false: these tests exercise the landing ladder's BLOCKED
        // path and must not depend on the fixture project's git state.
        emptyDiffExempt: false,
      },
      ...config,
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

/**
 * Drives a `git push origin main` bash dispatch for a session: the landing
 * gate's candidate set (first attempt blocks under enforce, a repeat
 * escalates, an approval releases).
 * @param h The fake host tables.
 * @param sessionID The session pushing.
 */
async function push(h: FakeHost, sessionID: string): Promise<void> {
  await callTool(h, "execute.before", {
    tool: "bash",
    sessionID,
    input: { command: "git push origin main" },
  })
}

/**
 * Drives an executor task dispatch for a parent session.
 * @param h The fake host tables.
 * @param sessionID The parent session dispatching.
 */
async function dispatchExecutor(h: FakeHost, sessionID: string): Promise<void> {
  await callTool(h, "execute.before", {
    tool: "task",
    sessionID,
    input: { agent: "executor", prompt: "do the work" },
  })
}

/**
 * Records a child→parent edge via a session.created stream event; the edge
 * keeps the parent's ledger bucket protected from LRU eviction and models
 * the dispatch context the latches are armed in.
 * @param h The fake host tables.
 * @param child The child session id.
 * @param parent The parent session id.
 */
async function registerChild(h: FakeHost, child: string, parent: string): Promise<void> {
  await h.pushEvent({ type: "session.created", properties: { sessionID: child, parentID: parent } })
}

/**
 * Arms a parent's plan latch through the task-escalation evaluate handler.
 * @param h The fake host tables.
 * @param parent The parent session arming its plan gate.
 */
async function armPlanLatch(h: FakeHost, parent: string): Promise<void> {
  await callPermission(h, "evaluate", { sessionID: parent, action: "task" })
}

/**
 * Records a plan-gate ask whose host echo carries the evaluate handler's
 * prefix: recognition by message prefix alone (the latch is consumed, no
 * latch-steal is journaled).
 * @param h The fake host tables.
 * @param parent The parent session the ask belongs to.
 * @param askId The host request id the ask is recorded under.
 * @param message The echoed plan-ask message (the evaluate handler's).
 */
async function recordPrefixedPlanAsk(
  h: FakeHost,
  parent: string,
  askId: string,
  message: string,
): Promise<void> {
  await h.pushEvent({
    type: "permission.asked",
    properties: { sessionID: parent, id: askId, message },
  })
}

/**
 * Arms a parent's landing latch (first push blocks under enforce, the repeat
 * escalates and arms it), then records the landing ask from the evaluate
 * handler's echo message: the landing prefix routes the record before any
 * plan-latch branch.
 * @param h The fake host tables.
 * @param parent The parent session arming its landing gate.
 * @param askId The host request id the ask is recorded under.
 */
async function armAndRecordLandingAsk(h: FakeHost, parent: string, askId: string): Promise<void> {
  await assert.rejects(() => push(h, parent))
  await push(h, parent)
  const event: Record<string, any> = { sessionID: parent, action: "bash" }
  await callPermission(h, "evaluate", event)
  assert.ok(
    typeof event.message === "string" &&
      event.message.startsWith("turnstile: pushing requires a reviewer"),
    "the landing evaluate must compose the landing-ask echo",
  )
  await h.pushEvent({
    type: "permission.asked",
    properties: { sessionID: parent, id: askId, message: event.message },
  })
}

/**
 * Delivers a human reply for a recorded ask via the permission.replied stream
 * event.
 * @param h The fake host tables.
 * @param sessionID The session the reply arrives in.
 * @param requestID The host request id the reply matches.
 * @param reply The human reply (`"once"`, `"always"`, or `"reject"`).
 */
async function reply(
  h: FakeHost,
  sessionID: string,
  requestID: string,
  replyValue: string,
): Promise<void> {
  await h.pushEvent({
    type: "permission.replied",
    properties: { sessionID, requestID, reply: replyValue },
  })
}

/**
 * Collects the human decision rows of a journal as sorted [session, decision]
 * pairs — the multiset a reply delivery should have produced.
 * @param metricsDir The metrics directory to read.
 * @returns Sorted [sessionID, decision] pairs.
 */
function decisionMultiset(metricsDir: string): Array<[string, string]> {
  return journalEntries(metricsDir)
    .filter((l) => l.type === "permission" && typeof l.decision === "string")
    .map((l): [string, string] => [String(l.sessionID), String(l.decision)])
    .sort()
}

/**
 * Probes each parent's per-session outcome after reply delivery: the sorted
 * decision rows, one allowed then one blocked executor dispatch (the single
 * plan grant consumed by the first), and an allowed push (the standing
 * landing release).
 * @param h The fake host tables.
 * @param metricsDir The metrics directory to read decisions from.
 * @returns The per-parent outcome record.
 */
async function probeOutcomes(h: FakeHost, metricsDir: string): Promise<Record<string, unknown>> {
  const outcomes: Record<string, unknown> = {}
  for (const parent of ["p1", "p2"]) {
    const decisions = decisionMultiset(metricsDir)
      .filter(([sid]) => sid === parent)
      .map(([, decision]) => decision)
      .sort()
    await dispatchExecutor(h, parent)
    await assert.rejects(
      () => dispatchExecutor(h, parent),
      (e: Error) => /no plan approval for "plan\.md"/.test(e.message),
    )
    await push(h, parent)
    outcomes[parent] = { decisions, dispatch: "once-then-blocked", push: "allowed" }
  }
  return outcomes
}

/**
 * Sequential cross-delivery: two parents' latches are armed (p1's landing
 * latch via push escalation, p2's plan latch via task escalation), each ask
 * is recorded with an empty-message echo (p1 takes the clean landing branch,
 * p2 wins its live plan latch as a latch-steal), and each reply is delivered
 * bearing the OTHER parent's session id. The grants must land on the
 * recorded asks' parents only; a reply for an unknown id journals an
 * unrecorded reply and flips no gate.
 */
test("replies: a cross-session reply applies to the recorded ask's parent, not the reply's session", async () => {
  const { h, restore, metricsDir } = await boot()
  try {
    await registerChild(h, "c1", "p1")
    await registerChild(h, "c2", "p2")
    // p1: arm the landing latch (first push blocks, the repeat escalates).
    await assert.rejects(() => push(h, "p1"))
    await push(h, "p1")
    // p2: arm the plan latch via the task-escalation evaluate.
    await armPlanLatch(h, "p2")
    // Record the asks with empty-message echoes: p1 has no plan latch (the
    // clean landing branch), p2's live plan latch is won by the echo (the
    // latch-steal branch).
    await h.pushEvent({
      type: "permission.asked",
      properties: { sessionID: "p1", id: "ask-p1-landing" },
    })
    await h.pushEvent({
      type: "permission.asked",
      properties: { sessionID: "p2", id: "ask-p2-plan" },
    })
    // Cross-deliver: each reply carries the OTHER parent's session id.
    await reply(h, "p1", "ask-p2-plan", "once")
    await reply(h, "p2", "ask-p1-landing", "always")
    // A reply for a request id that was never recorded.
    await reply(h, "p2", "ghost", "always")
    // The decisions land on the recorded asks' parents, not the reply
    // sessions: p2 took the once plan grant, p1 the standing landing release.
    assert.deepEqual(decisionMultiset(metricsDir), [
      ["p1", "always"],
      ["p2", "once"],
    ])
    // p2: exactly one executor dispatch (the consumed once grant); the
    // second re-blocks on the plan gate.
    await dispatchExecutor(h, "p2")
    await assert.rejects(
      () => dispatchExecutor(h, "p2"),
      (e: Error) => /no plan approval for "plan\.md"/.test(e.message),
    )
    // p1's plan gate is still red: the landing release never crossed over.
    await assert.rejects(
      () => dispatchExecutor(h, "p1"),
      (e: Error) => /no plan approval for "plan\.md"/.test(e.message),
    )
    // p1's standing landing release allows its push; the ghost reply left
    // p2's landing gate red (its first block re-throws).
    await push(h, "p1")
    await assert.rejects(() => push(h, "p2"))
    // The steal and the ghost are journaled as diagnostics.
    const entries = journalEntries(metricsDir)
    assert.ok(
      entries.some(
        (l) => l.type === "permission" && l.event === "latch-steal" && l.sessionID === "p2",
      ),
      "the empty-message echo winning p2's live plan latch journals a latch-steal",
    )
    assert.ok(
      entries.some(
        (l) => l.type === "permission" && l.event === "unrecorded-reply" && l.requestID === "ghost",
      ),
      "the reply for the unknown id journals an unrecorded reply",
    )
  } finally {
    restore()
  }
})

/**
 * Boots, arms both parents' plan and landing latches with prefix-echoed asks
 * (the same arming sequence in every run), delivers the four replies (plan
 * once, landing always, per parent) in the given order, probes the
 * per-session outcomes, and disposes.
 * @param order `"canonical"` delivers per parent (p1 then p2);
 *     `"interleaved"` alternates across the parents mid-sequence.
 * @returns The per-parent outcome record the probes observed.
 */
async function runBoot(order: "canonical" | "interleaved"): Promise<Record<string, unknown>> {
  const { h, restore, metricsDir } = await boot()
  try {
    await armAndRecordLandingAsk(h, "p1", "ask-p1-landing")
    const task1: Record<string, any> = { sessionID: "p1", action: "task" }
    await callPermission(h, "evaluate", task1)
    await recordPrefixedPlanAsk(h, "p1", "ask-p1-plan", task1.message)
    const task2: Record<string, any> = { sessionID: "p2", action: "task" }
    await callPermission(h, "evaluate", task2)
    await recordPrefixedPlanAsk(h, "p2", "ask-p2-plan", task2.message)
    await armAndRecordLandingAsk(h, "p2", "ask-p2-landing")
    const canonical: Array<[string, string, string]> = [
      ["p1", "ask-p1-plan", "once"],
      ["p1", "ask-p1-landing", "always"],
      ["p2", "ask-p2-plan", "once"],
      ["p2", "ask-p2-landing", "always"],
    ]
    const interleaved: Array<[string, string, string]> = [
      ["p1", "ask-p1-plan", "once"],
      ["p2", "ask-p2-landing", "always"],
      ["p2", "ask-p2-plan", "once"],
      ["p1", "ask-p1-landing", "always"],
    ]
    for (const [sessionID, requestID, replyValue] of order === "canonical"
      ? canonical
      : interleaved) {
      await reply(h, sessionID, requestID, replyValue)
    }
    return await probeOutcomes(h, metricsDir)
  } finally {
    restore()
  }
}

/**
 * Order-independence: both parents' plan and landing latches are armed with
 * prefix-echoed asks in every boot, and the four replies (plan once, landing
 * always, per parent) are delivered once in canonical per-parent order and
 * once interleaved across the parents. The keyed records make the per-session
 * outcomes identical either way.
 */
test("replies: interleaved and sequential reply delivery yield identical per-session outcomes", async () => {
  const outcomesA = await runBoot("canonical")
  const outcomesB = await runBoot("interleaved")
  assert.deepEqual(outcomesB, outcomesA)
})
