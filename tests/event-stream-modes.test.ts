/**
 * @fileoverview Event-stream death modes and mid-await dispose safety: a
 * dispose landing inside a stream handler's parent lookup is silent (no
 * death entry, no restart-budget spend, no unhandled rejection); a host
 * without the session, tool, or permission surfaces admits user prompts
 * through the `session.inbox.enqueued` stream and stays inert on unrelated
 * event types; a clean host stream close racing a dispose never burns the
 * restart budget; and a dispose landing inside an execute.after delivery's
 * session.get await lets the delivery settle after release without
 * rejecting, journaling an error, or recording a durable sidecar.
 */

import { test } from "node:test"
import assert from "node:assert/strict"
import * as fs from "node:fs"
import * as path from "node:path"

import { turnstile } from "../turnstile.ts"
import type { Host } from "../src/types.ts"
import {
  callTool,
  createDeferred,
  isolatedEnv,
  journalEntries,
  makeFakeHost,
  tmpDir,
} from "./helpers.ts"

/** The literal human approval marker (default `approvalMarker`). */
const APPROVAL = "PLAN APPROVED:"

/** A canonical verdict marker matching the default verdict regex. */
const VERDICT = "VERDICT: APPROVE crit=0 high=0 med=0 low=0"

/** The spent-budget disablement line that surfaces a permanently dead stream. */
const BUDGET_LINE =
  "event stream restart budget exhausted; session.text.* marker ingestion is disabled"

/**
 * One event-loop turn: a single `setImmediate` after which every pending
 * microtask has settled. A complete barrier for pure-microtask chains (a
 * released lookup's continuation, the stream's post-abort exit), where a
 * wall-clock wait would be guessing.
 */
const tick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve))

/**
 * Wall-clock buffer for a wait with no bus drain boundary: stream-death
 * timing, where the supervision loop may still be on a macrotask yield when
 * the test asserts.
 */
const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 30))

/**
 * Boots the plugin on a host in a temp metrics dir, returning the disposer
 * and the metrics dir for journal assertions.
 * @param host The host to boot on (a default full fake host when omitted).
 */
async function boot(
  host: Host = makeFakeHost().host,
): Promise<{ dispose: () => void; metricsDir: string }> {
  const metricsDir = tmpDir()
  const setup = turnstile(host, { env: isolatedEnv(metricsDir), config: { metricsDir } })
  const dispose = (await setup(host)) as () => void
  return { dispose, metricsDir }
}

/**
 * The error-typed entries of a metrics dir's journal.
 * @param metricsDir The metrics directory to read.
 * @returns The journal's error entries (empty when there are none).
 */
function errorEntries(metricsDir: string): Array<Record<string, any>> {
  return journalEntries(metricsDir).filter((e) => e.type === "error")
}

/**
 * A dispose landing inside a stream handler's parent lookup (the
 * `session.get` await) is a silent abort: the parked handler settles when
 * the lookup is released after the abort, the stream exits without a death
 * journal line or a budget spend, and the release produces no unhandled
 * rejection.
 */
test("mid-handler abort during parent resolution never burns the budget", async () => {
  let unhandled = 0
  const onUnhandled = (): void => {
    unhandled += 1
  }
  process.on("unhandledRejection", onUnhandled)
  let drained = false
  try {
    const deferred = createDeferred()
    const h = makeFakeHost({ sessionGet: () => deferred.promise })
    const { dispose, metricsDir } = await boot(h.host)
    h.pushEvent({
      type: "message.part.updated",
      data: {
        sessionID: "c9",
        part: { type: "text", sessionID: "c9", text: "no markers in this part" },
      },
    }).then(
      (): void => {
        drained = true
      },
      (): void => {
        drained = true
      },
    )
    // The handler is parked on the controllable session.get: the push's
    // drain boundary is still pending, so the park window is observable.
    await tick()
    assert.equal(drained, false, "the handler must still be parked before the dispose")
    dispose()
    // Release the parked lookup only after the abort: an undefined record
    // takes the negative-cache path (no throw, no journal).
    deferred.resolve(undefined)
    await tick()
    assert.equal(drained, true, "the parked push boundary must settle after the abort")
    assert.equal(errorEntries(metricsDir).length, 0, "the abort must be silent in the journal")
    assert.equal(unhandled, 0, "the post-abort release must not reject unhandled")
  } finally {
    process.off("unhandledRejection", onUnhandled)
  }
})

/**
 * A host without the session, tool, or permission surfaces still admits
 * user prompts through the `session.inbox.enqueued` stream: an approval
 * marker in an inbox user item is captured like a hook prompt (with the
 * dead prompt channel surfaced exactly once), and an unrelated event type
 * is inert — it journals nothing.
 */
test("inbox-only host admits prompts via the stream and is inert on other events", async () => {
  const project = tmpDir()
  const prev = process.cwd()
  process.chdir(project)
  try {
    const h = makeFakeHost({ session: false, tool: false, permission: false })
    const { dispose, metricsDir } = await boot(h.host)
    await h.pushEvent({
      type: "session.inbox.enqueued",
      data: {
        sessionID: "p1",
        inboxID: "msg_1",
        item: { type: "user", payload: { text: `${APPROVAL} ok` } },
      },
    })
    const entries = journalEntries(metricsDir)
    const setupEntry = entries.find((e) => e.type === "setup")
    assert.ok(setupEntry, "the setup heartbeat must be journaled")
    assert.equal(setupEntry.hooks, 1, "only the event subscriber registers on an inbox-only host")
    assert.ok(
      entries.some(
        (e) =>
          e.type === "plan" &&
          e.sessionID === "p1" &&
          e.result === "APPROVE" &&
          e.source === "session-prompt",
      ),
      "the inbox stream must admit the approval",
    )
    const errors = entries.filter((e) => e.type === "error")
    assert.equal(errors.length, 1, "the dead prompt channel is surfaced exactly once")
    assert.ok(
      String(errors[0]?.error).includes("prompt channel:"),
      "the dead-channel entry must name the prompt channel",
    )
    // An unrelated event type has no handler and journals nothing.
    const before = journalEntries(metricsDir)
    await h.pushEvent({ type: "pty.updated", data: { sessionID: "p1" } })
    assert.deepEqual(journalEntries(metricsDir), before, "unrelated events must journal nothing")
    dispose()
  } finally {
    process.chdir(prev)
  }
})

/**
 * A host stream that closes cleanly (done, never throws) racing a dispose
 * never spends the restart budget regardless of which wins: a clean close
 * re-subscribes for free and an abort stays silent, so neither a death
 * entry nor the spent-budget line can appear, and the stream-ended
 * telemetry journals at most once.
 */
test("clean close racing a dispose never burns the budget", async () => {
  const h = makeFakeHost()
  // A 0-event stream that completes immediately on every subscription.
  const dead: AsyncIterable<any> = {
    [Symbol.asyncIterator](): AsyncIterator<any> {
      return {
        next: async (): Promise<IteratorResult<any>> => ({ done: true, value: undefined }),
      }
    },
  }
  ;(h.host as { event?: unknown }).event = { subscribe: (): AsyncIterable<any> => dead }
  const { dispose, metricsDir } = await boot(h.host)
  dispose()
  await settle() // stream-death timing: the supervision loop must observe the abort
  const errors = errorEntries(metricsDir)
  assert.ok(
    !errors.some((e) => String(e.error).includes("event subscription:")),
    "a racing clean close must not journal a thrown death",
  )
  assert.ok(
    !errors.some((e) => String(e.error).includes(BUDGET_LINE)),
    "a racing clean close must never spend the restart budget",
  )
  assert.ok(
    errors.filter((e) => e.error === "event stream ended").length <= 1,
    "the stream-ended telemetry journals at most once across the race",
  )
})

/**
 * A dispose landing inside an execute.after delivery's parent lookup (the
 * `session.get` await) is a silent abort: the parked delivery settles when
 * the lookup is released after the abort — attributing the plan verdict
 * and recording no durable sidecar (the approval binds no plan identity) —
 * without an error journal line, a budget spend, or an unhandled
 * rejection.
 */
test("dispose mid execute.after await never rejects and never burns the budget", async () => {
  let unhandled = 0
  const onUnhandled = (): void => {
    unhandled += 1
  }
  process.on("unhandledRejection", onUnhandled)
  let settled = false
  let dispose: (() => void) | undefined
  const project = tmpDir()
  const prev = process.cwd()
  process.chdir(project)
  try {
    const deferred = createDeferred<{ parentID: string; agent: string }>()
    const h = makeFakeHost({ sessionGet: () => deferred.promise })
    const booted = await boot(h.host)
    dispose = booted.dispose
    const metricsDir = booted.metricsDir
    callTool(h, "execute.after", {
      tool: "task",
      sessionID: "c1",
      input: { agent: "plan-reviewer", prompt: "review the plan" },
      result: { output: VERDICT, metadata: { sessionID: "c1" } },
    }).then(
      (): void => {
        settled = true
      },
      (): void => {
        settled = true
      },
    )
    // The delivery is parked on the controllable session.get: the call
    // promise is still pending, so the park window is observable.
    await tick()
    assert.equal(settled, false, "the delivery must still be parked before the dispose")
    dispose()
    // Release the parked lookup only after the abort: the record carries
    // the parent edge but no directory, so the project dir falls back to
    // the chdir'd temp project and the approval binds no plan identity.
    deferred.resolve({ parentID: "p1", agent: "plan-reviewer" })
    await tick()
    assert.equal(settled, true, "the parked delivery must settle after the abort")
    const entries = journalEntries(metricsDir)
    assert.ok(
      entries.some(
        (e) =>
          e.type === "plan" &&
          e.sessionID === "p1" &&
          e.raw === "c1" &&
          e.result === "APPROVE" &&
          e.source === "task-result",
      ),
      "the edge-resolved delivery must attribute the plan verdict",
    )
    const errors = entries.filter((e) => e.type === "error")
    for (const needle of ["tool.execute.after:", "event subscription:", BUDGET_LINE]) {
      assert.ok(!errors.some((e) => String(e.error).includes(needle)), `no "${needle}" error entry`)
    }
    assert.ok(
      !fs.existsSync(path.join(metricsDir, "approved-plans.jsonl")),
      "an unbound approval must record no durable sidecar",
    )
    assert.equal(unhandled, 0, "the post-dispose release must not reject unhandled")
  } finally {
    // Idempotent second dispose: the abort is one-shot and the bus drain
    // listener is once-only, so the retry is inert.
    dispose?.()
    process.off("unhandledRejection", onUnhandled)
    process.chdir(prev)
  }
})
