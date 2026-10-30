/**
 * @fileoverview Chunk-2 re-seed tests: the child→parent edge is journaled as
 * a `child-edge` row at setParent time (new-or-changed edges only, emitter
 * agent carried in the same row), the boot replay folds those rows last-wins
 * per child into the re-seed store (hostile parents drop, bad agents
 * degrade), the setup re-seed re-applies the restored edges without
 * re-journaling them, seeds the emitter-authority cache, journals one
 * `reseed` row, and stamps the setup heartbeat with the restored count.
 */

import assert from "node:assert/strict"
import { test } from "node:test"
import * as fs from "node:fs"
import * as path from "node:path"

import { createLedger } from "../src/ledger.ts"
import { createHooksCore } from "../src/hooks-core.ts"
import { createTurnstile } from "../src/setup.ts"
import type { TurnstileOptions } from "../src/types.ts"
import { journalEntries, makeFakeHost, tmpDir, isolatedEnv } from "./helpers.ts"

/**
 * Builds isolated options whose journal and config land in `dir`.
 * @param dir Temp metrics directory.
 * @returns The options for createHooksCore / createTurnstile.
 */
function optsFor(dir: string): TurnstileOptions {
  return { env: { ...isolatedEnv(dir), TURNSTILE_METRICS_DIR: dir } }
}

/**
 * Writes the given raw lines as the journal of a fresh temp metrics dir.
 * @param dir The temp metrics dir.
 * @param lines Raw journal lines.
 * @returns The journal path.
 */
function writeJournal(dir: string, lines: string[]): string {
  const journalPath = path.join(dir, "turnstile.jsonl")
  fs.writeFileSync(journalPath, lines.join("\n") + "\n")
  return journalPath
}

/**
 * A well-shaped `child-edge` entry line.
 * @param child The child session ID.
 * @param parent The parent session ID.
 * @param agent The emitter agent (omitted when undefined).
 * @returns The raw JSONL line.
 */
function edgeLine(child: string, parent: string, agent?: unknown): string {
  return JSON.stringify({
    ts: "t",
    type: "child-edge",
    sessionID: child,
    parent,
    ...(agent !== undefined ? { agent } : {}),
  })
}

// ── live journaling at setParent ─────────────────────────────────────────────

test("setParent journals a child-edge row carrying the emitter agent", () => {
  const dir = tmpDir()
  const ledger = createLedger(path.join(dir, "turnstile.jsonl"), 64, 200)
  ledger.setParent("c1", "p1", "test-runner")
  const entries = journalEntries(dir)
  const rows = entries.filter((e) => e.type === "child-edge")
  assert.equal(rows.length, 1)
  assert.deepEqual(rows[0], {
    ts: rows[0]!.ts,
    type: "child-edge",
    sessionID: "c1",
    parent: "p1",
    agent: "test-runner",
  })
})

test("setParent omits the agent field when unresolved", () => {
  const dir = tmpDir()
  const ledger = createLedger(path.join(dir, "turnstile.jsonl"), 64, 200)
  ledger.setParent("c1", "p1")
  const rows = journalEntries(dir).filter((e) => e.type === "child-edge")
  assert.equal(rows.length, 1)
  assert.equal(rows[0]!.agent, undefined)
})

test("setParent journals once for an unchanged re-set and again on change", () => {
  const dir = tmpDir()
  const ledger = createLedger(path.join(dir, "turnstile.jsonl"), 64, 200)
  ledger.setParent("c1", "p1", "reviewer")
  ledger.setParent("c1", "p1", "reviewer")
  ledger.setParent("c1", "p2")
  const rows = journalEntries(dir).filter((e) => e.type === "child-edge")
  assert.equal(rows.length, 2)
  assert.equal(rows[0]!.parent, "p1")
  assert.equal(rows[1]!.parent, "p2")
})

test("setParent re-journals when an agent-less row gains its resolved agent", () => {
  const dir = tmpDir()
  const ledger = createLedger(path.join(dir, "turnstile.jsonl"), 64, 200)
  // session.created fired with no agent; resolveParent resolves it later.
  ledger.setParent("c1", "p1")
  ledger.setParent("c1", "p1", "test-runner")
  // Identical re-sets stay silent; an empty agent never downgrades.
  ledger.setParent("c1", "p1", "test-runner")
  ledger.setParent("c1", "p1")
  // A genuine agent change re-journals.
  ledger.setParent("c1", "p1", "reviewer")
  const rows = journalEntries(dir).filter((e) => e.type === "child-edge")
  assert.equal(rows.length, 3)
  assert.equal(rows[0]!.agent, undefined)
  assert.equal(rows[1]!.agent, "test-runner")
  assert.equal(rows[2]!.agent, "reviewer")
})

// ── replay fold ──────────────────────────────────────────────────────────────

test("replay folds child-edge rows and the re-seed re-applies them", () => {
  const dir = tmpDir()
  writeJournal(dir, [
    edgeLine("c1", "p1", "test-runner"),
    edgeLine("c2", "p2"),
    JSON.stringify({ ts: "t", type: "gate", sessionID: "p1", raw: "x", result: "PASS" }),
  ])
  const ledger = createLedger(path.join(dir, "turnstile.jsonl"), 64, 200)
  const edges = ledger.reseedEdges()
  assert.equal(edges.length, 2)
  assert.deepEqual(edges[0], { child: "c1", parent: "p1", agent: "test-runner" })
  assert.deepEqual(edges[1], { child: "c2", parent: "p2", agent: "" })
  assert.equal(ledger.parentOf("c1"), "p1")
  assert.equal(ledger.parentOf("c2"), "p2")
  // markParent ran: the restored parent's bucket is registered as live.
  assert.equal(ledger.isParent("p1"), true)
  // A re-seed must not re-append the rows it just folded.
  assert.equal(journalEntries(dir).filter((e) => e.type === "child-edge").length, 2)
})

test("replay child-edge fold is last-wins per child", () => {
  const dir = tmpDir()
  writeJournal(dir, [edgeLine("c1", "p1"), edgeLine("c1", "p9")])
  const ledger = createLedger(path.join(dir, "turnstile.jsonl"), 64, 200)
  const edges = ledger.reseedEdges()
  assert.equal(edges.length, 1)
  assert.deepEqual(edges[0], { child: "c1", parent: "p9", agent: "" })
})

test("replay drops a child-edge row whose parent fails the session shape", () => {
  const dir = tmpDir()
  writeJournal(dir, [edgeLine("c1", "BAD PARENT!"), edgeLine("c2", "p2")])
  const ledger = createLedger(path.join(dir, "turnstile.jsonl"), 64, 200)
  const edges = ledger.reseedEdges()
  assert.equal(edges.length, 1)
  assert.equal(edges[0]!.child, "c2")
  const drops = journalEntries(dir).filter((e) => e.type === "suppressed" && e.kind === "replay")
  assert.ok(drops.some((e) => e.reason === "session-id"))
})

test("replay degrades a non-string or over-length agent to empty without dropping the edge", () => {
  const dir = tmpDir()
  writeJournal(dir, [edgeLine("c1", "p1", 42), edgeLine("c2", "p2", "a".repeat(129))])
  const ledger = createLedger(path.join(dir, "turnstile.jsonl"), 64, 200)
  const edges = ledger.reseedEdges()
  assert.equal(edges.length, 2)
  for (const edge of edges) assert.equal(edge.agent, "")
  assert.equal(
    journalEntries(dir).filter((e) => e.type === "suppressed" && e.kind === "replay").length,
    0,
  )
})

test("reseedEdges with an edge-free tail returns empty", () => {
  const dir = tmpDir()
  writeJournal(dir, [
    JSON.stringify({ ts: "t", type: "gate", sessionID: "s1", raw: "x", result: "PASS" }),
  ])
  const ledger = createLedger(path.join(dir, "turnstile.jsonl"), 64, 200)
  assert.deepEqual(ledger.reseedEdges(), [])
})

// ── hooks-core re-seed service ───────────────────────────────────────────────

test("reseedChildEdges restores edges, seeds emitters, and journals the reseed row", () => {
  const dir = tmpDir()
  writeJournal(dir, [edgeLine("c1", "p1", "test-runner"), edgeLine("c2", "p2")])
  const ctx = createHooksCore(optsFor(dir))
  assert.equal(ctx.reseedChildEdges(), 2)
  assert.equal(ctx.ledger.parentOf("c1"), "p1")
  assert.equal(ctx.emitterAgent("c1"), "test-runner")
  // An edge without an agent leaves the emitter cache untouched for c2.
  assert.equal(ctx.emitterAgent("c2"), "")
  const reseeds = journalEntries(dir).filter((e) => e.type === "reseed")
  assert.equal(reseeds.length, 1)
  assert.equal(reseeds[0]!.edges, 2)
})

test("reseedChildEdges with no restored edges journals an empty reseed row", () => {
  const dir = tmpDir()
  const ctx = createHooksCore(optsFor(dir))
  assert.equal(ctx.reseedChildEdges(), 0)
  const reseeds = journalEntries(dir).filter((e) => e.type === "reseed")
  assert.equal(reseeds.length, 1)
  assert.equal(reseeds[0]!.edges, 0)
})

test("reseedChildEdges fail-open: a throwing ledger journals the error and reports 0", () => {
  const dir = tmpDir()
  const ctx = createHooksCore(optsFor(dir))
  ctx.ledger.reseedEdges = () => {
    throw new Error("simulated ledger failure")
  }
  assert.equal(ctx.reseedChildEdges(), 0)
  const entries = journalEntries(dir)
  const reseeds = entries.filter((e) => e.type === "reseed")
  assert.equal(reseeds.length, 0)
  assert.ok(entries.some((e) => e.type === "error" && String(e.error).startsWith("reseed:")))
})

// ── setup wiring ─────────────────────────────────────────────────────────────

test("setup re-seeds before hooks register and stamps the heartbeat", async () => {
  const dir = tmpDir()
  writeJournal(dir, [edgeLine("c1", "p1", "test-runner"), edgeLine("c2", "p2")])
  const { host } = makeFakeHost({})
  const setup = createTurnstile(undefined, optsFor(dir))
  const dispose = await setup(host)
  const entries = journalEntries(dir)
  const heartbeat = entries.find((e) => e.type === "setup")
  assert.ok(heartbeat)
  assert.equal(heartbeat.edgesRestored, 2)
  const reseeds = entries.filter((e) => e.type === "reseed")
  assert.equal(reseeds.length, 1)
  // The reseed row precedes the heartbeat: re-seed runs before registration.
  assert.ok(entries.indexOf(reseeds[0]!) < entries.indexOf(heartbeat))
  dispose?.()
})

test("setup without journaled edges stamps no edgesRestored field", async () => {
  const dir = tmpDir()
  const { host } = makeFakeHost({})
  const setup = createTurnstile(undefined, optsFor(dir))
  const dispose = await setup(host)
  const heartbeat = journalEntries(dir).find((e) => e.type === "setup")
  assert.ok(heartbeat)
  assert.equal(heartbeat.edgesRestored, undefined)
  dispose?.()
})
