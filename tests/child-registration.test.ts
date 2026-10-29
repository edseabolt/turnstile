/**
 * @fileoverview Pipeline-child registration tests: the `resolveChildStatus`
 * matrix over (edge, agent name) combinations, and the full-hook exemption
 * flows it enables — agent-name precedence exempts an edge-less pipeline
 * child on the write/edit and bash-write arms, while an unknown agent on an
 * edge-present child and a plain parent dispatch still fail closed.
 */

import { test } from "node:test"
import assert from "node:assert/strict"

import { turnstile } from "../turnstile.ts"
import {
  agentFromDispatchEvent,
  isPipelineChildDispatch,
  resolveChildStatus,
} from "../src/child-registration.ts"
import { BlockError } from "../src/gates.ts"
import type { GateLedger } from "../src/ledger.ts"
import type { ToolHookEvent } from "../src/types.ts"
import {
  callTool,
  isolatedEnv,
  journalEntries,
  makeFakeHost,
  tmpDir,
  waitUntil,
  type FakeHost,
} from "./helpers.ts"

const NAMES = new Set(["executor", "reviewer"])

/** A minimal ledger stub carrying only the edge map the boundary reads. */
function stubLedger(edges: Array<[string, string]>): GateLedger {
  return { childToParent: new Map(edges) } as unknown as GateLedger
}

/** Boots the plugin on a fake host in a temp metrics dir. */
async function boot(): Promise<{
  h: FakeHost
  dispose: () => void
  metricsDir: string
}> {
  const h = makeFakeHost()
  const metricsDir = tmpDir()
  const setup = turnstile(h.host, { env: isolatedEnv(metricsDir), config: { metricsDir } })
  const dispose = (await setup(h.host)) as () => void
  return { h, dispose, metricsDir }
}

/**
 * Seeds a child→parent edge via the created-edge stream and waits for
 * in-order consumption: the warmup `session.error` proves (FIFO stream
 * order) the `session.created` event has been processed.
 */
async function seedEdge(
  h: FakeHost,
  metricsDir: string,
  child: string,
  parent: string,
): Promise<void> {
  h.pushEvent({ type: "session.created", data: { sessionID: child, parentID: parent } })
  h.pushEvent({ type: "session.error", data: { sessionID: child, error: "warmup" } })
  await waitUntil(() =>
    journalEntries(metricsDir).some((l) => l.type === "error" && l.error === "warmup"),
  )
}

/** Asserts `fn` throws the deliberate hands-on `BlockError`. */
async function blocksHandsOn(fn: () => Promise<void>): Promise<void> {
  await assert.rejects(fn, (e: unknown) => e instanceof BlockError && e.cause === "hands-on")
}

test("isPipelineChildDispatch: configured names are children; empty and unknown names are not", () => {
  assert.equal(isPipelineChildDispatch("executor", NAMES), true)
  assert.equal(isPipelineChildDispatch("reviewer", NAMES), true)
  assert.equal(isPipelineChildDispatch("general", NAMES), false)
  assert.equal(isPipelineChildDispatch("", NAMES), false)
})

test("resolveChildStatus matrix: agent-name precedence, edge + fallback, fail-closed unknowns", () => {
  const withEdge = stubLedger([["c1", "p1"]])
  const noEdge = stubLedger([])
  const configuredFallback = () => "reviewer"
  const unconfiguredFallback = () => "general"
  const emptyFallback = () => ""

  // Non-empty agent name wins outright, regardless of edge or resolver.
  for (const ledger of [withEdge, noEdge]) {
    for (const res of [undefined, configuredFallback, unconfiguredFallback, emptyFallback]) {
      assert.equal(resolveChildStatus("c1", "executor", ledger, NAMES, res), "child")
      assert.equal(resolveChildStatus("c1", "general", ledger, NAMES, res), "parent")
    }
  }

  // Empty agent name: the edge gates the fallback consultation.
  assert.equal(
    resolveChildStatus("c1", "", withEdge, NAMES, configuredFallback),
    "child",
    "edge + configured emitter fallback is a child",
  )
  assert.equal(
    resolveChildStatus("c1", "", withEdge, NAMES, unconfiguredFallback),
    "parent",
    "edge + unconfigured emitter fallback gates like a parent",
  )
  assert.equal(
    resolveChildStatus("c1", "", withEdge, NAMES, emptyFallback),
    "unknown",
    "edge + unresolved emitter fallback is unknown (fail closed)",
  )
  assert.equal(
    resolveChildStatus("c1", "", withEdge, NAMES),
    "unknown",
    "edge with no resolver available is unknown (fail closed)",
  )
  assert.equal(
    resolveChildStatus("c9", "", noEdge, NAMES, configuredFallback),
    "unknown",
    "no edge is unknown even with a resolver",
  )
})

test("agentFromDispatchEvent: task input shape first, then the generic subagent event shape", () => {
  const taskShape: ToolHookEvent = { input: { subagent_type: "executor" } }
  const genericShape: ToolHookEvent = { agent: "executor", input: { prompt: "work" } }
  const inputAgentShape: ToolHookEvent = { input: { agent: "reviewer" }, agent: "executor" }
  const unnamed: ToolHookEvent = { input: { prompt: "work" } }
  assert.equal(agentFromDispatchEvent(taskShape), "executor")
  assert.equal(agentFromDispatchEvent(genericShape), "executor")
  assert.equal(agentFromDispatchEvent(inputAgentShape), "reviewer")
  assert.equal(agentFromDispatchEvent(unnamed), "")
  assert.equal(agentFromDispatchEvent({}), "")
})

test("agent-name precedence exempts an edge-less pipeline child's write/edit", async () => {
  const { h, dispose } = await boot()
  try {
    // No session.created edge was ever seeded: the name alone registers.
    await callTool(h, "execute.before", {
      tool: "write",
      sessionID: "c1",
      agent: "executor",
      input: { filePath: "/repo/notes.md" },
    })
    await callTool(h, "execute.before", {
      tool: "edit",
      sessionID: "c1",
      agent: "executor",
      input: { path: "/repo/notes.md" },
    })
  } finally {
    dispose()
  }
})

test("agent-name precedence exempts an edge-less pipeline child's write-shaped bash", async () => {
  const { h, dispose } = await boot()
  try {
    // The bash-write arm (and, behind it, the landing gate) exempts on the
    // event agent name alone: the child's own file-writing bash is its work.
    await callTool(h, "execute.before", {
      tool: "bash",
      sessionID: "c1",
      agent: "executor",
      input: { command: "cat > notes.md" },
    })
  } finally {
    dispose()
  }
})

test("an edge-present child with an unknown agent still fails closed on write/edit and bash", async () => {
  const { h, dispose, metricsDir } = await boot()
  try {
    await seedEdge(h, metricsDir, "c2", "p1")
    await blocksHandsOn(async () => {
      await callTool(h, "execute.before", {
        tool: "write",
        sessionID: "c2",
        agent: "general",
        input: { filePath: "/repo/notes.md" },
      })
    })
    await blocksHandsOn(async () => {
      await callTool(h, "execute.before", {
        tool: "bash",
        sessionID: "c2",
        agent: "general",
        input: { command: "cat > notes.md" },
      })
    })
    // Edge present but no agent name anywhere and no emitter seed: unknown.
    await blocksHandsOn(async () => {
      await callTool(h, "execute.before", {
        tool: "write",
        sessionID: "c2",
        input: { filePath: "/repo/notes.md" },
      })
    })
  } finally {
    dispose()
  }
})

test("a parent dispatch with no agent name still blocks (unaffected)", async () => {
  const { h, dispose } = await boot()
  try {
    await blocksHandsOn(async () => {
      await callTool(h, "execute.before", {
        tool: "edit",
        sessionID: "p1",
        input: { filePath: "/repo/README.md" },
      })
    })
    await blocksHandsOn(async () => {
      await callTool(h, "execute.before", {
        tool: "bash",
        sessionID: "p1",
        input: { command: "cat > notes.md" },
      })
    })
  } finally {
    dispose()
  }
})
