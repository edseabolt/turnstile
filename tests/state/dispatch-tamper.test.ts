/**
 * @fileoverview Dispatch-prompt provenance tests: the dispatch journal entry
 * carries the sha256-16 of the dispatch prompt, and the delivery-time tamper
 * check journals a `dispatch-tamper` audit row when a structured delivery
 * echoes a prompt whose hash differs from the dispatch-time stamp — and
 * journals nothing when the echo matches, is absent, or the child is
 * unrecorded. The row is replay-inert.
 */

import { test } from "node:test"
import assert from "node:assert/strict"
import * as fs from "node:fs"
import * as path from "node:path"

import { turnstile } from "../turnstile.ts"
import { createLedger } from "../src/state/ledger.ts"
import { sha256Hex16 } from "../src/journal/chain.ts"
import {
  callTool,
  isolatedEnv,
  journalEntries,
  makeFakeHost,
  tmpDir,
  type FakeHost,
} from "./helpers.ts"

/** Boots the plugin over a fake host with a temp metrics dir and a session
 *  record resolving the child c1 to parent p1 (so the delivery's edge
 *  resolves and the tamper check finds the dispatch-time stamp). */
async function boot(): Promise<{ h: FakeHost; dispose: () => void; metricsDir: string }> {
  const metricsDir = tmpDir()
  const h = makeFakeHost({
    sessionRecords: new Map([
      ["c1", { parentID: "p1", agent: "test-runner" }],
      ["c2", { parentID: "p1", agent: "reviewer" }],
    ]),
  })
  const setup = turnstile(h.host, {
    env: isolatedEnv(metricsDir),
    config: { metricsDir },
  })
  const dispose = (await setup(h.host)) as () => void
  return { h, dispose, metricsDir }
}

/** Dispatches one dormant test-runner task and delivers its structured
 *  result with the given echoed prompt (undefined = no echo). The
 *  test-runner agent makes the delivery await the child→parent edge, so the
 *  tamper check reads the dispatch stamp through the resolved parent. */
async function dispatchAndDeliver(
  h: FakeHost,
  prompt: string,
  echoedPrompt?: string,
): Promise<void> {
  await callTool(h, "execute.before", {
    tool: "task",
    sessionID: "p1",
    input: { agent: "test-runner", prompt, description: "d" },
  }).catch(() => {})
  await callTool(h, "execute.after", {
    tool: "subagent",
    sessionID: "p1",
    input: { agent: "test-runner" },
    result: {
      output: { output: "ran, no marker", sessionID: "c1" },
      metadata: { sessionID: "c1" },
      ...(echoedPrompt === undefined ? {} : { input: { prompt: echoedPrompt } }),
    },
  })
}

/** Every admitted dispatch entry carries a 16-hex promptHash matching the
 *  sha256-16 of the dispatch prompt. */
test("dispatch entry carries the dispatch prompt hash", async () => {
  const { h, dispose, metricsDir } = await boot()
  try {
    await callTool(h, "execute.before", {
      tool: "task",
      sessionID: "p1",
      input: { agent: "test-runner", prompt: "review the diff", description: "d" },
    }).catch(() => {})
    const entry = journalEntries(metricsDir).find((l) => l.type === "dispatch")
    assert.ok(entry)
    assert.equal(entry.promptHash, sha256Hex16("review the diff"))
    assert.match(String(entry.promptHash), /^[0-9a-f]{16}$/)
  } finally {
    dispose()
  }
})

/** A structured delivery echoing the exact dispatch prompt journals no
 *  dispatch-tamper row. */
test("a matching echoed prompt journals no dispatch-tamper row", async () => {
  const { h, dispose, metricsDir } = await boot()
  try {
    await dispatchAndDeliver(h, "review the diff", "review the diff")
    assert.ok(!journalEntries(metricsDir).some((l) => l.type === "dispatch-tamper"))
  } finally {
    dispose()
  }
})

/** A structured delivery echoing a mutated prompt journals one
 *  dispatch-tamper row with the expected/actual hashes; gate state is
 *  untouched (the row is audit-only). */
test("a mismatched echoed prompt journals dispatch-tamper", async () => {
  const { h, dispose, metricsDir } = await boot()
  try {
    await dispatchAndDeliver(h, "review the diff", "TAMPERED review the diff")
    const rows = journalEntries(metricsDir).filter((l) => l.type === "dispatch-tamper")
    assert.equal(rows.length, 1)
    assert.equal(rows[0]!.sessionID, "c1")
    assert.equal(rows[0]!.expected, sha256Hex16("review the diff"))
    assert.equal(rows[0]!.actual, sha256Hex16("TAMPERED review the diff"))
  } finally {
    dispose()
  }
})

/** A delivery with no echoed prompt (and a delivery for an unrecorded child)
 *  journals nothing: the check is silent-inert, never a false positive. */
test("a missing echo or unrecorded child journals no dispatch-tamper row", async () => {
  const { h, dispose, metricsDir } = await boot()
  try {
    await dispatchAndDeliver(h, "review the diff")
    assert.ok(!journalEntries(metricsDir).some((l) => l.type === "dispatch-tamper"))
    await callTool(h, "execute.after", {
      tool: "subagent",
      sessionID: "p1",
      input: { agent: "test-runner" },
      result: {
        output: { output: "other child", sessionID: "c9" },
        metadata: { sessionID: "c9" },
        input: { prompt: "unrecorded" },
      },
    })
    assert.ok(!journalEntries(metricsDir).some((l) => l.type === "dispatch-tamper"))
  } finally {
    dispose()
  }
})

/** Two concurrent dispatches from one parent (different agents, different
 *  prompts) keep distinct stamps: each child's delivery is matched against
 *  its own dispatch prompt and neither journals a tamper row — the second
 *  dispatch must not overwrite the first's stamp. */
test("concurrent dispatches match each delivery against its own prompt", async () => {
  const { h, dispose, metricsDir } = await boot()
  try {
    await Promise.all([
      callTool(h, "execute.before", {
        tool: "task",
        sessionID: "p1",
        input: { agent: "test-runner", prompt: "first prompt", description: "d1" },
      }).catch(() => {}),
      callTool(h, "execute.before", {
        tool: "task",
        sessionID: "p1",
        input: { agent: "reviewer", prompt: "second prompt", description: "d2" },
      }).catch(() => {}),
    ])
    for (const [child, agent, prompt] of [
      ["c1", "test-runner", "first prompt"],
      ["c2", "reviewer", "second prompt"],
    ] as const) {
      await callTool(h, "execute.after", {
        tool: "subagent",
        sessionID: "p1",
        input: { agent },
        result: {
          output: { output: "ran, no marker", sessionID: child },
          metadata: { sessionID: child },
          input: { prompt },
        },
      })
    }
    assert.ok(!journalEntries(metricsDir).some((l) => l.type === "dispatch-tamper"))
  } finally {
    dispose()
  }
})

/** A journaled dispatch-tamper row replays inert: the boot replay folds it
 *  without a drop, a crash, or any gate-state change. */
test("dispatch-tamper is replay-tolerant", () => {
  const metricsDir = tmpDir()
  const journalPath = path.join(metricsDir, "turnstile.jsonl")
  fs.writeFileSync(
    journalPath,
    JSON.stringify({
      ts: "t",
      type: "dispatch-tamper",
      sessionID: "c1",
      expected: "a".repeat(16),
      actual: "b".repeat(16),
    }) + "\n",
  )
  const ledger = createLedger(journalPath, 64, 2000)
  assert.equal(ledger.peek("c1"), undefined, "the audit row mints no gate bucket")
  const drops = journalEntries(metricsDir).filter((l) => l.type === "suppressed")
  assert.equal(drops.length, 0, "the inert row journals no replay drop")
})
