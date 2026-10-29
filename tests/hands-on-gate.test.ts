/**
 * @fileoverview Hands-on-gate tests: the always-on `guardHandsOn` ladder —
 * first-block throw vs. repeat-attempt escalation, release/waiver
 * short-circuits, empty-path misconfiguration telemetry, the fail-open
 * internal-error path, and the block error's `hands-on` cause stamp.
 */

import { test } from "node:test"
import assert from "node:assert/strict"

import {
  createToolPolicy,
  HANDSON_REQUIREMENT,
  type HandsOnGateCapability,
  type BashWriteGateCapability,
  type ToolPolicy,
} from "../src/tool-policy.ts"
import { defaultConfig } from "../src/config.ts"
import { BlockError } from "../src/gates.ts"
import type { Journaler } from "../src/journal.ts"
import type { TurnstileConfig } from "../src/types.ts"

/**
 * Builds a capturing Journaler: every journal entry is deep-copied into
 * `entries`, every trace line is appended to `traces`.
 * @returns The journaler, its entries, and its trace lines.
 */
function captureJournaler(): { journaler: Journaler; entries: any[]; traces: string[] } {
  const entries: any[] = []
  const traces: string[] = []
  const journaler: Journaler = {
    journalPath: "",
    tracePath: "",
    journal(entry) {
      entries.push({ ...entry })
    },
    traceEvent(agent, event, detail, sessionID) {
      traces.push(`${agent} | ${event} | ${detail}${sessionID ? ` | ${sessionID}` : ""}`)
    },
  }
  return { journaler, entries, traces }
}

/**
 * Builds a policy over the default config (the hands-on gate is always on),
 * with a capturing journaler.
 * @param overrides Top-level config overrides over the defaults (e.g.
 *     `escalation: "ask"` to exercise the interactive ask ladder).
 * @returns The policy, its journaled entries, and its trace lines.
 */
function makePolicy(overrides: Partial<TurnstileConfig> = {}): {
  policy: ToolPolicy
  entries: any[]
  traces: string[]
} {
  const { journaler, entries, traces } = captureJournaler()
  const cfg: TurnstileConfig = { ...defaultConfig({}), ...overrides }
  return { policy: createToolPolicy(cfg, journaler), entries, traces }
}

/** Asserts `fn` throws the deliberate `BlockError`. */
function blocks(fn: () => void): void {
  assert.throws(fn, (e: unknown) => e instanceof BlockError)
}

/** Asserts `fn` does not throw (allow path). */
function allows(fn: () => void): void {
  assert.doesNotThrow(fn)
}

/**
 * Builds a `HandsOnGateCapability` fake that records call counts and can be
 * armed to throw from one method (to exercise the guard's fail-open path).
 * `prior` seeds `priorBlocks()`; `release` seeds `hasRelease()`; `waiver`
 * seeds `hasWaiver()`.
 * @param opts Capability configuration.
 * @returns The capability and its observable call log.
 */
function recordingCapability(opts?: {
  prior?: number
  release?: boolean
  waiver?: boolean
  throwIn?: keyof HandsOnGateCapability
}): { gate: HandsOnGateCapability; log: Record<string, number | boolean> } {
  const log: Record<string, number | boolean> = {
    recordBlock: 0,
    escalate: 0,
    blockCount: opts?.prior ?? 0,
  }
  const throwAt = opts?.throwIn
  const gate: HandsOnGateCapability = {
    hasRelease: () => {
      if (throwAt === "hasRelease") throw new Error("hasRelease boom")
      return opts?.release ?? false
    },
    hasWaiver: () => {
      if (throwAt === "hasWaiver") throw new Error("hasWaiver boom")
      return opts?.waiver ?? false
    },
    priorBlocks: () => {
      if (throwAt === "priorBlocks") throw new Error("priorBlocks boom")
      return log.blockCount as number
    },
    recordBlock: () => {
      if (throwAt === "recordBlock") throw new Error("recordBlock boom")
      log.blockCount = (log.blockCount as number) + 1
      log.recordBlock = (log.recordBlock as number) + 1
    },
    escalate: (): boolean => {
      if (throwAt === "escalate") throw new Error("escalate boom")
      log.escalate = (log.escalate as number) + 1
      return true
    },
  }
  return { gate, log }
}

/** The block entries of reason `parent-hands-on`. */
function handsOnBlocks(entries: any[]): any[] {
  return entries.filter((e) => e.type === "blocked" && e.reason === "parent-hands-on")
}

/**
 * The first parent write/edit of a task always throws and journals exactly one
 * `parent-hands-on` block (the gate has no off or audit-only mode).
 */
test("guardHandsOn: the first write/edit of a task always throws and journals one block", () => {
  const { policy, entries } = makePolicy()
  const { gate, log } = recordingCapability()
  blocks(() => policy.guardHandsOn("write", "/repo/a.ts", "s1", gate))
  const blocked = handsOnBlocks(entries)
  assert.equal(blocked.length, 1, "one block on the first attempt")
  assert.equal(blocked[0].tool, "write")
  assert.equal(blocked[0].sessionID, "s1")
  assert.equal(log.recordBlock, 1, "recordBlock called once on the first block")
  assert.equal(log.escalate, 0, "no escalate on the first block")
})

/**
 * Repeat attempt under `escalation: "ask"` escalates and allows: journals a
 * `{type:"permission", action:"ask", reason:"hands-on"}`, calls
 * `gate.escalate()` once, does not throw, and journals no second blocked
 * entry (the evaluate handler forces the human ask off the armed latch).
 */
test("guardHandsOn: repeat attempt under escalation ask escalates and allows", () => {
  const { policy, entries } = makePolicy({ escalation: "ask" })
  const { gate, log } = recordingCapability({ prior: 1 })
  allows(() => policy.guardHandsOn("edit", "/repo/b.ts", "s1", gate))
  assert.equal(log.escalate, 1, "escalate called on the repeat attempt")
  assert.equal(log.recordBlock, 0, "no second block on the escalation")
  const perm = entries.find((e) => e.type === "permission" && e.reason === "hands-on")
  assert.ok(perm, "a permission ask is journaled on the repeat attempt")
  assert.equal(perm.action, "ask")
  assert.equal(handsOnBlocks(entries).length, 0, "no blocked entry on the escalation")
})

/**
 * Repeat attempt under the default `escalation: "block"` re-blocks: journals
 * a second `parent-hands-on` block row, records the block again, throws, and
 * journals no `permission` ask row and never calls `gate.escalate()` (the
 * ask tier cannot collapse to allow under an auto-accepting host).
 */
test("guardHandsOn: repeat attempt under the default block mode re-blocks", () => {
  const { policy, entries } = makePolicy()
  const { gate, log } = recordingCapability({ prior: 1 })
  blocks(() => policy.guardHandsOn("edit", "/repo/b2.ts", "s1", gate))
  assert.equal(log.escalate, 0, "block mode never escalates")
  assert.equal(log.recordBlock, 1, "the repeat block is recorded again")
  assert.equal(handsOnBlocks(entries).length, 1, "one block row on the repeat attempt")
  assert.equal(
    entries.some((e) => e.type === "permission"),
    false,
    "no permission ask row under block mode",
  )
})

/**
 * A live release (human `always`) or an executor-scoped waiver allows
 * silently: no entries, no recordBlock — and with both false again on the
 * next call (prior 0), the first block re-arms, so the release checks sit
 * before the ladder.
 */
test("guardHandsOn: a live release or executor waiver allows silently", () => {
  for (const seed of [{ release: true }, { waiver: true }] as const) {
    const { policy, entries } = makePolicy()
    const { gate, log } = recordingCapability(seed)
    allows(() => policy.guardHandsOn("write", "/repo/c.ts", "s1", gate))
    assert.deepEqual(entries, [], "a released edit journals nothing")
    assert.equal(log.recordBlock, 0, "a released edit records no block")
  }
  // Both false again: the gate is live and the first block re-arms.
  const { policy, entries } = makePolicy()
  const { gate, log } = recordingCapability()
  blocks(() => policy.guardHandsOn("write", "/repo/c.ts", "s1", gate))
  assert.equal(log.recordBlock, 1)
  assert.equal(handsOnBlocks(entries).length, 1)
})

/** A non-string (empty) path journals the misconfiguration error and allows. */
test("guardHandsOn: empty path journals the misconfiguration error", () => {
  for (const badPath of [undefined, 42, ""] as const) {
    const { policy, entries } = makePolicy()
    const { gate } = recordingCapability()
    allows(() => policy.guardHandsOn("write", badPath as unknown, "s1", gate))
    const errs = entries.filter(
      (e) => e.type === "error" && /hands-on gate carried no target path/.test(String(e.error)),
    )
    assert.equal(errs.length, 1, `one error for ${String(badPath)}`)
    assert.equal(handsOnBlocks(entries).length, 0, "no block for an empty path")
  }
})

/** An internal capability error fails open: journaled, never thrown. The
 *  per-throwIn configurations avoid the legitimate first-block throw (prior 1
 *  only escalates under `escalation: "ask"`), so any throw the guard lets
 *  escape is a real fail-open gap. */
test("guardHandsOn: an internal capability error fails open", () => {
  const cases: Array<{ throwIn: keyof HandsOnGateCapability; prior: number }> = [
    { throwIn: "hasRelease", prior: 1 },
    { throwIn: "hasWaiver", prior: 1 },
    { throwIn: "priorBlocks", prior: 1 },
    // recordBlock only runs on the first block (prior 0); at prior 1 the
    // ladder escalates instead.
    { throwIn: "recordBlock", prior: 0 },
    { throwIn: "escalate", prior: 1 },
  ]
  for (const { throwIn, prior } of cases) {
    const { policy, entries } = makePolicy({ escalation: "ask" })
    const { gate } = recordingCapability({ throwIn, prior })
    allows(() => policy.guardHandsOn("write", "/repo/d.ts", "s1", gate))
    const errs = entries.filter(
      (e) => e.type === "error" && /tool policy guard/.test(String(e.error)),
    )
    assert.equal(errs.length, 1, `throwIn=${throwIn} journals one error`)
  }
})

/** The block error names the hands-on requirement and stamps the
 *  `hands-on` cause (the observe-mode fallback ladder and suspendBlock name
 *  the gate off the cause, never the message). */
test("guardHandsOn: the block error names the requirement and stamps cause hands-on", () => {
  const { policy } = makePolicy()
  const { gate } = recordingCapability()
  assert.throws(
    () => policy.guardHandsOn("write", "/repo/e.ts", "s1", gate),
    (e: unknown) =>
      e instanceof BlockError &&
      e.message.includes("parent-session write/edit requires the pipeline") &&
      e.cause === "hands-on",
  )
  assert.equal(HANDSON_REQUIREMENT.length > 0, true)
})

/** A gate-shaped bash capability with a recorded consumeGrant. */
function bashCap(
  gate: HandsOnGateCapability,
  grant = false,
  throwIn?: "consumeGrant",
): BashWriteGateCapability & { grantConsumed: boolean; consumeCalls: number } {
  let consumed = false
  let consumeCalls = 0
  return {
    ...gate,
    consumeGrant: () => {
      consumeCalls++
      if (throwIn === "consumeGrant") throw new Error("consumeGrant boom")
      consumed = grant
      return grant
    },
    get grantConsumed() {
      return consumed
    },
    get consumeCalls() {
      return consumeCalls
    },
  }
}

/**
 * The first gate-tier bash write of a task throws and journals one
 * `parent-hands-on` block stamped `tool:"bash"`; nothing is journaled for
 * telemetry- or none-tier commands and no telemetry row is written for the
 * gate call itself.
 */
test("guardBashWrite: the first gate-tier write throws and journals parent-hands-on", () => {
  const { policy, entries } = makePolicy()
  const { gate, log } = recordingCapability()
  const cap = bashCap(gate)
  blocks(() => policy.guardBashWrite("bash", "cat > f.txt", "gate", "s1", cap))
  const blocked = handsOnBlocks(entries)
  assert.equal(blocked.length, 1)
  assert.equal(blocked[0].tool, "bash")
  assert.equal(blocked[0].sessionID, "s1")
  assert.equal(log.recordBlock, 1)
  assert.equal(cap.consumeCalls, 1, "the guard consults the once-grant on the gate path")
})

/**
 * Non-gate verdicts never gate and never consume the pending once-grant.
 */
test("guardBashWrite: telemetry and none verdicts never gate or burn the grant", () => {
  for (const verdict of ["telemetry", "none"] as const) {
    const { policy, entries } = makePolicy()
    const { gate, log } = recordingCapability()
    const cap = bashCap(gate, true)
    allows(() => policy.guardBashWrite("bash", "npm test > log", verdict, "s1", cap))
    assert.equal(cap.consumeCalls, 0, `verdict ${verdict} never consults the grant`)
    assert.equal(log.recordBlock, 0)
    assert.equal(handsOnBlocks(entries).length, 0)
    assert.deepEqual(entries, [])
  }
})

/**
 * With `bashWriteGate: false` a gate-shaped command neither gates nor burns
 * the grant (flag check precedes consumeGrant), while telemetry continues
 * to journal.
 */
test("guardBashWrite: disabled gate never consumes the pending once-grant", () => {
  const { policy, entries } = makePolicy({
    toolPolicy: { ...defaultConfig({}).toolPolicy, bashWriteGate: false },
  })
  const { gate, log } = recordingCapability()
  const cap = bashCap(gate, true)
  allows(() => policy.guardBashWrite("bash", "cat > f", "gate", "s1", cap))
  assert.equal(cap.consumeCalls, 0, "the disabled flag short-circuits before the grant")
  assert.equal(log.recordBlock, 0)
  assert.deepEqual(entries, [])
  policy.observeBashWrite("s1", "cat > f", "gate")
  assert.equal(
    entries.filter((e) => (e as any).type === "tool" && (e as any).handsOn === true).length,
    1,
    "telemetry still journals with the gate off",
  )
})

/**
 * Release / waiver / once-grant short-circuits allow a gate-tier write
 * silently; a pending grant is consumed only on the gate path.
 */
test("guardBashWrite: release, waiver, and once-grant allow silently", () => {
  for (const seed of [{ release: true }, { waiver: true }] as const) {
    const { policy, entries } = makePolicy()
    const { gate, log } = recordingCapability(seed)
    const cap = bashCap(gate, true)
    allows(() => policy.guardBashWrite("bash", "mv a b", "gate", "s1", cap))
    assert.deepEqual(entries, [])
    assert.equal(log.recordBlock, 0)
  }
  const { policy, entries } = makePolicy()
  const { gate } = recordingCapability()
  const cap = bashCap(gate, true)
  allows(() => policy.guardBashWrite("bash", "cp a b", "gate", "s1", cap))
  assert.deepEqual(entries, [], "a once-granted write journals nothing")
  assert.equal(cap.grantConsumed, true)
  // A second gate-tier write with no grant re-arms the first block.
  blocks(() => policy.guardBashWrite("bash", "cp a b", "gate", "s1", bashCap(gate)))
  assert.equal(handsOnBlocks(entries).length, 1)
})

/**
 * Repeat gate-tier bash writes follow the shared ladder: under
 * `escalation: "ask"` they journal the permission ask, call escalate, and
 * allow; under the default `"block"` they re-block without escalating.
 */
test("guardBashWrite: repeat attempts follow the escalation ladder", () => {
  const { policy, entries } = makePolicy({ escalation: "ask" })
  const { gate, log } = recordingCapability({ prior: 1 })
  const cap = bashCap(gate)
  allows(() => policy.guardBashWrite("shell", "touch f", "gate", "s1", cap))
  assert.equal(log.escalate, 1)
  assert.equal(
    entries.some((e) => e.type === "permission" && e.reason === "hands-on"),
    true,
  )
  const { policy: p2, entries: e2 } = makePolicy()
  const { gate: g2 } = recordingCapability({ prior: 1 })
  blocks(() => p2.guardBashWrite("shell", "touch f", "gate", "s1", bashCap(g2)))
  assert.equal(handsOnBlocks(e2).length, 1)
})

/**
 * Write-shaped commands journal exactly one `handsOn` telemetry row;
 * none-shaped commands journal none.
 */
test("observeBashWrite: journals handsOn telemetry for write-shaped commands", () => {
  const { policy, entries } = makePolicy()
  policy.observeBashWrite("s1", "npm test > log", "telemetry")
  policy.observeBashWrite("s1", "cat > f", "gate")
  policy.observeBashWrite("s1", "ls", "none")
  const rows = entries.filter((e) => e.type === "tool" && e.handsOn === true)
  assert.equal(rows.length, 2)
  for (const r of rows) {
    assert.equal(r.tool, "bash")
    assert.equal(r.sessionID, "s1")
  }
})

/** A journaler error inside observeBashWrite fails open. */
test("observeBashWrite: an internal error fails open", () => {
  const { policy, entries } = makePolicy()
  policy.observeBashWrite("s1", 42, "telemetry")
  assert.equal(entries.filter((e) => e.type === "tool").length, 1)
  assert.equal(handsOnBlocks(entries).length, 0)
})

/** A journaler error inside observeBashWrite's journal call fails open and
 *  journals the error through the same (recursively guarded) seam. */
test("observeBashWrite: a journal failure fails open", () => {
  const entries: any[] = []
  const journaler: Journaler = {
    journalPath: "",
    tracePath: "",
    journal(entry) {
      entries.push({ ...entry })
      if (entry.type === "tool") throw new Error("disk full")
    },
    traceEvent() {},
  }
  const cfg: TurnstileConfig = { ...defaultConfig({}) }
  const policy = createToolPolicy(cfg, journaler)
  assert.doesNotThrow(() => policy.observeBashWrite("s1", "cat > f", "gate"))
  assert.equal(
    entries.some((e) => e.type === "error" && /tool policy guard/.test(String(e.error))),
    true,
  )
})

/** Capability throws inside guardBashWrite fail open, except the block. */
test("guardBashWrite: an internal capability error fails open", () => {
  const cases: Array<{ throwIn: keyof HandsOnGateCapability; prior: number }> = [
    { throwIn: "hasRelease", prior: 1 },
    { throwIn: "hasWaiver", prior: 1 },
    { throwIn: "priorBlocks", prior: 1 },
    { throwIn: "recordBlock", prior: 0 },
    { throwIn: "escalate", prior: 1 },
  ]
  for (const { throwIn, prior } of cases) {
    const { policy, entries } = makePolicy({ escalation: "ask" })
    const { gate } = recordingCapability({ throwIn, prior })
    const cap = bashCap(gate)
    allows(() => policy.guardBashWrite("bash", "sed -i s/a/b/ f", "gate", "s1", cap))
    const errs = entries.filter(
      (e) => e.type === "error" && /tool policy guard/.test(String(e.error)),
    )
    assert.equal(errs.length, 1, `throwIn=${throwIn} journals one error`)
  }
  const { policy, entries } = makePolicy()
  const { gate } = recordingCapability()
  allows(() =>
    policy.guardBashWrite("bash", "touch f", "gate", "s1", bashCap(gate, false, "consumeGrant")),
  )
  assert.equal(
    entries.some((e) => e.type === "error" && /tool policy guard/.test(String(e.error))),
    true,
    "a consumeGrant throw fails open",
  )
  assert.equal(handsOnBlocks(entries).length, 0)
})

/** The bash block error stamps the `hands-on` cause like write/edit. */
test("guardBashWrite: the block error stamps cause hands-on", () => {
  const { policy } = makePolicy()
  const { gate } = recordingCapability()
  assert.throws(
    () => policy.guardBashWrite("bash", "cat > f", "gate", "s1", bashCap(gate)),
    (e: unknown) => e instanceof BlockError && e.cause === "hands-on",
  )
})
