/**
 * @fileoverview Test-overlap gate integration tests: the tracker + marker
 * parse + journal row shape under `requireTestOverlap` — the skip arms, the
 * exemption arm, the zero-overlap violation under enforce and flag, the
 * off-switch and default byte-identity, the fail-open error row, and the
 * stdout-scan capture through the plugin harness.
 */

import { test } from "node:test"
import assert from "node:assert/strict"

import { GATE_RE, VERDICT_RE } from "../src/markers/markers.ts"
import { createVerdictCapture, type VerdictCaptureState } from "../src/dispatch/verdict-capture.ts"
import { createEvidenceTracker } from "../src/policy/evidence.ts"
import { defaultConfig } from "../src/config/config.ts"
import { newState } from "../src/state/state-carry.ts"
import type { GateState, MarkerEvent, TurnstileConfig } from "../src/util/types.ts"
import { turnstile } from "../turnstile.ts"
import { callTool, isolatedEnv, journalEntries, makeFakeHost, tmpDir } from "./helpers.ts"

/** A pass-through parent resolver: every raw session resolves to itself. */
const identityParent = (raw: string): string => raw

/** A fresh default config with the test-overlap keys overridden. */
function cfg(overrides: Record<string, unknown> = {}): TurnstileConfig {
  return { ...defaultConfig({}), ...overrides } as TurnstileConfig
}

/**
 * Builds a minimal verdict-capture state over a real evidence tracker and a
 * single-parent ledger stub, with the journal rows collected for asserts.
 * @param config The config to bind.
 * @param evidence The evidence tracker to bind.
 * @returns The state plus the journal-row collector.
 */
function makeState(
  config: TurnstileConfig,
  evidence: ReturnType<typeof createEvidenceTracker>,
): { st: VerdictCaptureState; rows: Array<Record<string, unknown>>; state: GateState } {
  const rows: Array<Record<string, unknown>> = []
  const state = newState()
  const st: VerdictCaptureState = {
    config,
    journaler: {
      journal: (entry: Record<string, unknown>): void => {
        rows.push(entry)
      },
      traceEvent: (): void => {},
    } as unknown as VerdictCaptureState["journaler"],
    ledger: {
      parentOf: identityParent,
      state: (): GateState => state,
    } as unknown as VerdictCaptureState["ledger"],
    gateRe: GATE_RE,
    verdictRe: VERDICT_RE,
    evidence,
    taskWindows: new Map([["p1", 0]]),
    markerKindAllowed: (): ((kind: "gate" | "verdict") => boolean) => (): boolean => true,
    emitterAgent: (): string => "test-runner",
    markTaskComplete: (): void => {},
  }
  return { st, rows, state }
}

/** Parses one gate marker text through the built state. */
function parse(st: VerdictCaptureState, text: string): MarkerEvent[] {
  return createVerdictCapture(st).parseMarkers(text, "p1", "task-result")
}

/** The journaled gate row for a PASS, when one exists. */
function gateRow(rows: Array<Record<string, unknown>>): Record<string, unknown> | undefined {
  return rows.find((r) => r.type === "gate" && r.result === "PASS")
}

/** Default config (requireTestOverlap false): no overlap field anywhere. */
test("default config keeps events and rows byte-identical (no overlap field)", () => {
  const evidence = createEvidenceTracker(cfg(), identityParent)
  evidence.observe("p1", "npm test", 0) // correlated execution so the flip arm is reachable
  const { st, rows, state } = makeState(cfg(), evidence)
  const events = parse(st, "GATE: PASS tests=1 passed=1 failed=0")
  assert.equal(events[0]!.overlap, undefined)
  assert.equal(state.hasGatePass, true)
  const row = gateRow(rows)
  assert.ok(row)
  assert.equal("overlap" in row, false)
})

/** requireTestOverlap with gateEvidence "off" is inert: no overlap computed. */
test("gateEvidence off wins: overlap not computed", () => {
  const evidence = createEvidenceTracker(cfg(), identityParent)
  const { st, rows } = makeState(cfg({ requireTestOverlap: true, gateEvidence: "off" }), evidence)
  const events = parse(st, "GATE: PASS tests=1 passed=1 failed=0")
  assert.equal(events[0]!.overlap, undefined)
  assert.equal("overlap" in (gateRow(rows) ?? {}), false)
})

/** An empty touched set journals the skip and the PASS still flips. */
test("touched empty: skipped no-touched-files, PASS flips", () => {
  const evidence = createEvidenceTracker(cfg(), identityParent)
  evidence.observe("p1", "npm test", 0) // correlated execution so the flip arm is reachable
  const { st, rows, state } = makeState(cfg({ requireTestOverlap: true }), evidence)
  const events = parse(st, "GATE: PASS tests=1 passed=1 failed=0")
  assert.deepEqual(events[0]!.overlap, {
    executed: 0,
    touched: 0,
    matched: 0,
    skipped: "no-touched-files",
  })
  assert.equal(state.hasGatePass, true)
  assert.equal((gateRow(rows) as Record<string, unknown>).overlap, events[0]!.overlap)
})

/** No extractable test-file tokens from either source: skip, PASS flips. */
test("no test files: skipped no-test-files, PASS flips", () => {
  const evidence = createEvidenceTracker(cfg(), identityParent)
  evidence.touched("p1", "src/other.ts")
  evidence.observe("p1", "npm test", 0) // correlated execution so the flip arm is reachable
  const { st, state } = makeState(cfg({ requireTestOverlap: true }), evidence)
  const events = parse(st, "GATE: PASS tests=1 passed=1 failed=0")
  assert.equal(events[0]!.overlap!.skipped, "no-test-files")
  assert.equal(state.hasGatePass, true)
})

/** Every touched path matching an exempt glob satisfies the rule. */
test("all touched exempt: exempt true, PASS flips", () => {
  const evidence = createEvidenceTracker(cfg(), identityParent)
  evidence.observe("p1", "npm test", 0, "ok src/a.test.ts")
  evidence.touched("p1", "docs/guide.md")
  const { st, state } = makeState(
    cfg({ requireTestOverlap: true, testOverlapExempt: ["docs/**"] }),
    evidence,
  )
  const events = parse(st, "GATE: PASS tests=1 passed=1 failed=0")
  assert.equal(events[0]!.overlap!.exempt, true)
  assert.equal(state.hasGatePass, true)
})

/** Overlap present: the PASS flips and the row carries the evidence. */
test("matched > 0: overlap stamped, PASS flips", () => {
  const evidence = createEvidenceTracker(cfg(), identityParent)
  evidence.observe("p1", "npm test", 0, "ok src/a.test.ts")
  evidence.touched("p1", "/repo/src/a.test.ts")
  evidence.observe("p1", "npm test", 0) // correlated execution so the flip arm is reachable
  const { st, rows, state } = makeState(cfg({ requireTestOverlap: true }), evidence)
  const events = parse(st, "GATE: PASS tests=1 passed=1 failed=0")
  assert.equal(events[0]!.overlap!.matched, 1)
  assert.equal(state.hasGatePass, true)
  assert.equal((gateRow(rows) as Record<string, unknown>).verified, true)
})

/** Zero overlap under enforce: the gate stays red (unverifiedPass) and the
 *  row carries the overlap evidence beside verified:false. */
test("zero-overlap PASS does not flip under enforce", () => {
  const evidence = createEvidenceTracker(cfg(), identityParent)
  evidence.observe("p1", "npm test", 0, "ok tests/test_foo.py")
  evidence.touched("p1", "src/other.ts")
  const { st, rows, state } = makeState(cfg({ requireTestOverlap: true }), evidence)
  const events = parse(st, "GATE: PASS tests=1 passed=1 failed=0")
  assert.equal(events[0]!.overlap!.matched, 0)
  assert.equal(events[0]!.verified, false)
  assert.equal(state.hasGatePass, false)
  assert.notEqual(state.unverifiedPass, "")
  const row = gateRow(rows) as Record<string, unknown>
  assert.equal(row.verified, false)
  assert.equal((row.overlap as { matched: number }).matched, 0)
})

/** Zero overlap under flag: the event is stamped overlap but still flips. */
test("zero-overlap PASS flips under flag with the overlap stamp", () => {
  const evidence = createEvidenceTracker(cfg(), identityParent)
  evidence.observe("p1", "npm test", 0, "ok tests/test_foo.py")
  evidence.touched("p1", "src/other.ts")
  const { st, rows, state } = makeState(
    cfg({ requireTestOverlap: true, gateEvidence: "flag" }),
    evidence,
  )
  const events = parse(st, "GATE: PASS tests=1 passed=1 failed=0")
  assert.equal(events[0]!.overlap!.matched, 0)
  assert.equal(state.hasGatePass, true)
  assert.equal((gateRow(rows) as Record<string, unknown>).mode, "flag")
})

/** A computation error journals type:"error" and leaves the gate behavior
 *  byte-identical to the no-overlap path (fail-open). */
test("computation error fails open", () => {
  const evidence = createEvidenceTracker(cfg(), identityParent)
  evidence.touched("p1", "src/other.ts")
  const throwing = new Proxy(evidence, {
    get(target, prop, receiver) {
      if (prop === "testFiles") throw new Error("boom")
      return Reflect.get(target, prop, receiver)
    },
  })
  evidence.observe("p1", "npm test", 0) // correlated execution so the flip arm is reachable
  const { st, rows, state } = makeState(cfg({ requireTestOverlap: true }), throwing)
  const events = parse(st, "GATE: PASS tests=1 passed=1 failed=0")
  assert.equal(events[0]!.overlap, undefined)
  assert.equal(state.hasGatePass, true)
  const error = rows.find((r) => r.type === "error")
  assert.ok(error)
  assert.match(String(error.error), /^test-overlap: Error: boom/)
  assert.equal("overlap" in (gateRow(rows) ?? {}), false)
})

/** End-to-end through the plugin harness: the exit-0 bash stdout scan and the
 *  write/edit touched capture join at the gate row. */
test("stdout scan and touched capture join end-to-end", async () => {
  const metricsDir = tmpDir()
  const h = makeFakeHost()
  const setup = turnstile(h.host, {
    env: isolatedEnv(metricsDir),
    config: { metricsDir, requireTestOverlap: true },
  })
  const dispose = (await setup(h.host)) as () => void
  await callTool(h, "execute.after", {
    tool: "bash",
    sessionID: "p1",
    input: { command: "pytest" },
    result: { output: "PASS tests/test_foo.py", metadata: { exit: 0 } },
  })
  await callTool(h, "execute.after", {
    tool: "write",
    sessionID: "p1",
    input: { filePath: "/repo/tests/test_foo.py" },
    result: { output: "ok" },
  })
  await callTool(h, "execute.after", {
    tool: "task",
    sessionID: "p1",
    input: { agent: "test-runner" },
    result: { output: "GATE: PASS tests=1 passed=1 failed=0\n" },
  })
  const gate = journalEntries(metricsDir).find((l) => l.type === "gate" && l.result === "PASS")
  assert.ok(gate)
  assert.equal((gate.overlap as { matched: number }).matched, 1)
  dispose()
})

/** End-to-end: an unrelated suite against an unrelated change set keeps the
 *  gate red under the default enforce mode. */
test("unrelated suite keeps the gate red end-to-end", async () => {
  const metricsDir = tmpDir()
  const h = makeFakeHost()
  const setup = turnstile(h.host, {
    env: isolatedEnv(metricsDir),
    config: { metricsDir, requireTestOverlap: true },
  })
  const dispose = (await setup(h.host)) as () => void
  await callTool(h, "execute.after", {
    tool: "bash",
    sessionID: "p1",
    input: { command: "pytest" },
    result: { output: "PASS tests/test_other.py", metadata: { exit: 0 } },
  })
  await callTool(h, "execute.after", {
    tool: "edit",
    sessionID: "p1",
    input: { filePath: "/repo/src/main.py" },
    result: { output: "ok" },
  })
  await callTool(h, "execute.after", {
    tool: "task",
    sessionID: "p1",
    input: { agent: "test-runner" },
    result: { output: "GATE: PASS tests=1 passed=1 failed=0\n" },
  })
  const gate = journalEntries(metricsDir).find((l) => l.type === "gate" && l.result === "PASS")
  assert.ok(gate)
  assert.equal(gate.verified, false)
  assert.equal((gate.overlap as { matched: number }).matched, 0)
  dispose()
})
/** A bash result without a string output scans an empty stdout window (the
 *  coalesce branch) and still records the hit. */
test("bash with a non-string output scans an empty stdout window", async () => {
  const metricsDir = tmpDir()
  const h = makeFakeHost()
  const setup = turnstile(h.host, {
    env: isolatedEnv(metricsDir),
    config: { metricsDir, requireTestOverlap: true },
  })
  const dispose = (await setup(h.host)) as () => void
  await callTool(h, "execute.after", {
    tool: "bash",
    sessionID: "p1",
    input: { command: "npm test" },
    result: { metadata: { exit: 0 } },
  })
  const evidence = journalEntries(metricsDir).find((l) => l.type === "evidence")
  assert.ok(evidence)
  dispose()
})
