/**
 * @fileoverview Landing-gate tests: the three-mode decision matrix for
 * `ToolPolicy.guardLanding` (off/shadow/enforce), first-block vs.
 * repeat-attempt escalation, approval release, `landingGate:false` no-op,
 * empty-command misconfiguration telemetry, `gh pr` (not this guard's target —
 * that is `observeLanding`/`guardBash` territory), the fail-open internal-error
 * path, the landing block entry stamping `gitGates.mode` (the chunk-8 mode-
 * stamping fix), plus `isPushLanding` and `observeLanding` telemetry coverage.
 */

import { test } from "node:test"
import assert from "node:assert/strict"

import {
  createToolPolicy,
  isPushLanding,
  type LandingGateCapability,
  type ToolPolicy,
} from "../src/tool-policy.ts"
import { defaultConfig } from "../src/config.ts"
import { BlockError } from "../src/gates.ts"
import type { Journaler } from "../src/journal.ts"
import type { TurnstileConfig, TurnstileGitGates } from "../src/types.ts"

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
 * Builds a policy over the default config with one-level-deep `gitGates`
 * override, with a capturing journaler.
 * @param overrides `gitGates` fields to merge over the defaults.
 * @returns The policy, its journaled entries, and its trace lines.
 */
function makePolicy(overrides: { gitGates?: Partial<TurnstileGitGates> } = {}): {
  policy: ToolPolicy
  entries: any[]
  traces: string[]
} {
  const { journaler, entries, traces } = captureJournaler()
  const cfg: TurnstileConfig = {
    ...defaultConfig({}),
    gitGates: { ...defaultConfig({}).gitGates, ...(overrides.gitGates ?? {}) },
  }
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
 * Builds a `LandingGateCapability` fake that records call counts and can be
 * armed to throw from one method (to exercise the guard's fail-open path).
 * `prior` seeds `priorBlocks()`; `approval` seeds `hasApproval()`.
 * @param opts Capability configuration.
 * @returns The capability and its observable call log.
 */
function recordingCapability(opts?: {
  prior?: number
  approval?: boolean
  throwIn?: keyof LandingGateCapability
}): { gate: LandingGateCapability; log: Record<string, number | boolean> } {
  const log: Record<string, number | boolean> = {
    recordBlock: 0,
    escalate: 0,
    escalated: false,
    blockCount: opts?.prior ?? 0,
  }
  const throwAt = opts?.throwIn
  const gate: LandingGateCapability = {
    hasApproval: () => {
      if (throwAt === "hasApproval") throw new Error("hasApproval boom")
      return opts?.approval ?? false
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
    escalate: () => {
      if (throwAt === "escalate") throw new Error("escalate boom")
      log.escalate = (log.escalate as number) + 1
      log.escalated = true
    },
  }
  return { gate, log }
}

/** The block entries of reason `no-landing-approval`. */
function landingBlocks(entries: any[]): any[] {
  return entries.filter((e) => e.type === "blocked" && e.reason === "no-landing-approval")
}

/**
 * First block this task: three-mode matrix. `off` is a silent no-op; `shadow`
 * journals a `no-landing-approval` block (stamping `gitGates.mode`, never the
 * toolPolicy mode) without throwing; `enforce` journals it and throws. Each of
 * shadow/enforce records exactly one capability block.
 */
test("guardLanding: first-block x off/shadow/enforce decision matrix", () => {
  const push = "git push origin main"
  for (const mode of ["off", "shadow", "enforce"] as const) {
    const { policy, entries } = makePolicy({ gitGates: { mode } })
    const { gate, log } = recordingCapability()
    const invoke = () => policy.guardLanding("bash", push, "s1", gate)
    if (mode === "off") {
      allows(invoke)
      assert.deepEqual(entries, [], "off is a silent no-op")
      continue
    }
    if (mode === "enforce") blocks(invoke)
    else allows(invoke)
    const blocked = landingBlocks(entries)
    assert.equal(blocked.length, 1, `one block under ${mode}`)
    // The block stamps gitGates.mode (chunk-8 mode-stamping fix): toolPolicy
    // mode still defaults to "enforce" while gitGates.mode is "shadow" here.
    assert.equal(blocked[0].mode, mode)
    assert.equal(log.recordBlock, 1, "recordBlock called once on the first block")
    assert.equal(log.escalate, 0, "no escalate on the first block")
  }
})

/**
 * Repeat attempt without approval. Under `enforce` it journals a
 * `{type:"permission", action:"ask", reason:"landing"}` and calls
 * `gate.escalate()` (allowing execute.before to pass so the setup-side evaluate
 * handler forces the human ask); the escalation is a documented no-op on the
 * real capability, so the guard itself allows. Under `shadow` it re-blocks.
 */
test("guardLanding: repeat attempt under enforce escalates and allows", () => {
  const { policy, entries } = makePolicy({ gitGates: { mode: "enforce" } })
  const { gate, log } = recordingCapability({ prior: 1 })
  allows(() => policy.guardLanding("bash", "git push origin main", "s1", gate))
  assert.equal(log.escalate, 1, "escalate called on the repeat attempt")
  assert.equal(log.escalated, true)
  const perm = entries.find((e) => e.type === "permission" && e.reason === "landing")
  assert.ok(perm, "a permission ask is journaled on the repeat attempt")
  assert.equal(perm.action, "ask")
  assert.equal(perm.mode, "enforce")
})

/** Under `shadow`, a repeat attempt re-blocks (no throw, no escalate). */
test("guardLanding: repeat attempt under shadow re-blocks and records", () => {
  const { policy, entries } = makePolicy({ gitGates: { mode: "shadow" } })
  const { gate, log } = recordingCapability({ prior: 1 })
  allows(() => policy.guardLanding("bash", "git push origin main", "s1", gate))
  assert.equal(log.recordBlock, 1, "recordBlock called once on the repeat attempt")
  assert.equal(log.escalate, 0, "no escalate under shadow")
  const blocked = landingBlocks(entries)
  assert.equal(blocked.length, 1)
  assert.equal(blocked[0].mode, "shadow")
})

/** Approval releases the gate: no block, no capability call, nothing journaled. */
test("guardLanding: approval releases the gate", () => {
  const { policy, entries } = makePolicy({ gitGates: { mode: "enforce" } })
  const { gate, log } = recordingCapability({ approval: true })
  allows(() => policy.guardLanding("bash", "git push origin main", "s1", gate))
  assert.deepEqual(landingBlocks(entries), [], "approval emits no block")
  assert.equal(log.recordBlock, 0)
})

/** `landingGate:false` is a no-op even under enforce. */
test("guardLanding: landingGate:false is a no-op under enforce", () => {
  const { policy, entries } = makePolicy({ gitGates: { mode: "enforce", landingGate: false } })
  const { gate } = recordingCapability()
  allows(() => policy.guardLanding("bash", "git push origin main", "s1", gate))
  assert.deepEqual(entries, [], "landingGate:false journals nothing")
})

/** An empty or absent command fails open with misconfiguration telemetry. */
test("guardLanding: empty or absent command fails open", () => {
  const { policy, entries } = makePolicy({ gitGates: { mode: "enforce" } })
  const { gate } = recordingCapability()
  allows(() => policy.guardLanding("bash", "", "s1", gate))
  allows(() => policy.guardLanding("bash", undefined, "s1", gate))
  const errs = entries.filter(
    (e) => e.type === "error" && /landing gate carried no command/.test(String(e.error)),
  )
  assert.equal(errs.length, 2)
})

/**
 * `gh pr create|merge` is not this guard's target: `guardLanding` keys off the
 * `git push` candidate set only. A `gh pr` deny comes from `guardBash` (the
 * bashDeny rule) and its telemetry from `observeLanding`; the landing gate
 * itself journals nothing for `gh pr`.
 */
test("guardLanding: gh pr is not the landing gate's target", () => {
  const { policy, entries } = makePolicy({ gitGates: { mode: "enforce" } })
  const { gate } = recordingCapability()
  allows(() => policy.guardLanding("bash", "gh pr create", "s1", gate))
  allows(() => policy.guardLanding("bash", "gh pr merge --squash", "s1", gate))
  assert.deepEqual(entries, [], "the landing gate is push-only")
})

/**
 * An internal capability error fails open: the guard journals `type:"error"`
 * and never throws, so a misbehaving ledger cannot block tool calls (fail-open
 * contract).
 */
test("guardLanding: an internal capability error fails open", () => {
  const { policy, entries } = makePolicy({ gitGates: { mode: "enforce" } })
  const { gate } = recordingCapability({ throwIn: "hasApproval" })
  allows(() => policy.guardLanding("bash", "git push origin main", "s1", gate))
  const errs = entries.filter(
    (e) => e.type === "error" && /tool policy guard/.test(String(e.error)),
  )
  assert.equal(errs.length, 1)
})

/**
 * The first-block `BlockError` names the landing requirement and the landing
 * trace line is written (enforce).
 */
test("guardLanding: the enforce error names the landing requirement", () => {
  const { policy } = makePolicy({ gitGates: { mode: "enforce" } })
  const { gate } = recordingCapability()
  assert.throws(
    () => policy.guardLanding("bash", "git push origin main", "s1", gate),
    (e: Error) => e instanceof BlockError && e.message.includes("push/PR requires a reviewer"),
  )
})

/** `isPushLanding` matches a `git push` (with global options) and rejects the
 * non-landing forms, so the evaluate-handler arm (chunk-9) can share the exact
 * candidate set this guard enforces. */
test("isPushLanding: matches git push, rejects non-landing forms", () => {
  assert.ok(isPushLanding("git push origin main"))
  assert.ok(isPushLanding("git -C ./repo push --follow-tags"))
  assert.ok(isPushLanding("git push && git status"))
  assert.ok(!isPushLanding("git status"))
  assert.ok(!isPushLanding("git log"))
  assert.ok(!isPushLanding("git pushgraph show"))
})

/**
 * `observeLanding` journals `{type:"tool", tool:"bash", landing:true}` for a
 * `git push` and a `gh pr` candidate in every mode (telemetry is
 * mode-independent and non-blocking); an empty or non-landing command journals
 * nothing.
 */
test("observeLanding: journals landing telemetry for push and gh pr in every mode", () => {
  for (const mode of ["off", "shadow", "enforce"] as const) {
    const { policy, entries } = makePolicy({ gitGates: { mode } })
    allows(() => policy.observeLanding("s1", "git push origin main"))
    allows(() => policy.observeLanding("s2", "gh pr create"))
    const lands = entries.filter((e) => e.type === "tool" && e.landing === true)
    assert.equal(lands.length, 2, `two landing telemetry entries under ${mode}`)
  }
})

/** observeLanding is silent for an empty command, a non-string, or a non-landing command. */
test("observeLanding: empty, non-string and non-landing commands journal nothing", () => {
  const { policy, entries } = makePolicy({ gitGates: { mode: "enforce" } })
  allows(() => policy.observeLanding("s1", ""))
  allows(() => policy.observeLanding("s1", undefined))
  allows(() => policy.observeLanding("s1", 42))
  allows(() => policy.observeLanding("s1", "npm test"))
  assert.deepEqual(entries, [])
})
