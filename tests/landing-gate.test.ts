/**
 * @fileoverview Landing-gate tests: the three-mode decision matrix for
 * `ToolPolicy.guardLanding` (off/shadow/enforce), first-block vs.
 * repeat-attempt escalation, approval release, `landingGate:false` no-op,
 * empty-command misconfiguration telemetry, `gh pr` (not this guard's target —
 * its telemetry is `observeLanding`'s, and a `gh pr` deny, when configured, is
 * `guardBash`'s territory), the fail-open internal-error path, the landing
 * block entry stamping `gitGates.mode`, plus `isPushLanding` and
 * `observeLanding` telemetry coverage.
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
 * `prior` seeds `priorBlocks()`; `approval` seeds `hasApproval()`; `credited`
 * seeds `hasCreditedApproval()`; `emptyDiff` seeds `isEmptyDiff()`.
 * @param opts Capability configuration.
 * @returns The capability and its observable call log.
 */
function recordingCapability(opts?: {
  prior?: number
  approval?: boolean
  credited?: boolean
  emptyDiff?: boolean
  throwIn?: keyof LandingGateCapability
}): { gate: LandingGateCapability; log: Record<string, number | boolean> } {
  const log: Record<string, number | boolean> = {
    recordBlock: 0,
    escalate: 0,
    escalated: false,
    blockCount: opts?.prior ?? 0,
    emptyDiff: 0,
  }
  const throwAt = opts?.throwIn
  const gate: LandingGateCapability = {
    hasApproval: () => {
      if (throwAt === "hasApproval") throw new Error("hasApproval boom")
      return opts?.approval ?? false
    },
    hasCreditedApproval: () => {
      if (throwAt === "hasCreditedApproval") throw new Error("hasCreditedApproval boom")
      return opts?.credited ?? false
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
    isEmptyDiff: () => {
      if (throwAt === "isEmptyDiff") throw new Error("isEmptyDiff boom")
      log.emptyDiff = (log.emptyDiff as number) + 1
      return opts?.emptyDiff ?? false
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
    // The block stamps gitGates.mode: toolPolicy
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

/**
 * A session journaled with a credited reviewer APPROVE whose `hasReviewApprove`
 * flag a prompt reset dropped escalates on the FIRST enforce attempt: no
 * first-block throw, no block recorded, one landing ask journaled, and
 * `gate.escalate()` armed so the evaluate handler can force the human ask.
 */
test("guardLanding: a credited session escalates on the first enforce attempt", () => {
  const { policy, entries } = makePolicy({ gitGates: { mode: "enforce" } })
  const { gate, log } = recordingCapability({ credited: true })
  allows(() => policy.guardLanding("bash", "git push origin main", "s1", gate))
  assert.equal(log.escalate, 1, "escalate is called on the credited first attempt")
  assert.equal(log.escalated, true)
  assert.equal(log.recordBlock, 0, "a credited first attempt records no block")
  const perm = entries.find((e) => e.type === "permission" && e.reason === "landing")
  assert.ok(perm, "the landing ask is journaled on the credited first attempt")
  assert.equal(perm.action, "ask")
  assert.equal(perm.mode, "enforce")
  assert.deepEqual(landingBlocks(entries), [], "a credited first attempt journals no block")
})

/**
 * A journaled credit under `shadow` journals the first block unchanged: shadow
 * never arms the escalation — one `no-landing-approval` block is recorded and
 * journaled, with no throw and no escalate.
 */
test("guardLanding: a credited session under shadow journals the first block", () => {
  const { policy, entries } = makePolicy({ gitGates: { mode: "shadow" } })
  const { gate, log } = recordingCapability({ credited: true })
  allows(() => policy.guardLanding("bash", "git push origin main", "s1", gate))
  assert.equal(log.escalate, 0, "shadow never escalates")
  assert.equal(log.recordBlock, 1, "a credited first attempt records one block under shadow")
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
  assert.equal(log.emptyDiff, 0, "the exemption clause sits after the approval release")
})

/**
 * With `gitGates.emptyDiffExempt` on and the probe proving the push empty,
 * the push is allowed: exactly one `exempt:"empty-diff"` tool entry is
 * journaled and no landing block is recorded.
 */
test("guardLanding: an exempted empty-diff push is journaled, not blocked", () => {
  const { policy, entries } = makePolicy({ gitGates: { mode: "enforce", emptyDiffExempt: true } })
  const { gate, log } = recordingCapability({ emptyDiff: true })
  allows(() => policy.guardLanding("bash", "git push origin main", "s1", gate))
  assert.equal(log.emptyDiff, 1, "the probe is consulted exactly once")
  const ex = entries.find((e) => e.exempt === "empty-diff")
  assert.ok(ex, "the exemption is journaled")
  assert.equal(ex.type, "tool")
  assert.equal(ex.tool, "bash")
  assert.equal(ex.landing, true)
  assert.equal(ex.sessionID, "s1")
  assert.deepEqual(landingBlocks(entries), [], "an exempted push records no block")
  assert.equal(log.recordBlock, 0)
})

/** With the exemption off (the default), the probe is never consulted. */
test("guardLanding: the probe is not consulted while the exemption is off", () => {
  const { policy, entries } = makePolicy({ gitGates: { mode: "enforce" } })
  const { gate, log } = recordingCapability({ emptyDiff: true })
  blocks(() => policy.guardLanding("bash", "git push origin main", "s1", gate))
  assert.equal(log.emptyDiff, 0, "the probe is never consulted while off")
  assert.equal(landingBlocks(entries).length, 1, "the first block still fires")
})

/** Exemption on but the probe proves the push non-empty: the ladder is unchanged. */
test("guardLanding: a non-empty probe under the exemption leaves the ladder unchanged", () => {
  const { policy, entries } = makePolicy({ gitGates: { mode: "enforce", emptyDiffExempt: true } })
  const { gate, log } = recordingCapability({ emptyDiff: false })
  blocks(() => policy.guardLanding("bash", "git push origin main", "s1", gate))
  assert.equal(log.emptyDiff, 1, "the probe is consulted while on")
  assert.equal(landingBlocks(entries).length, 1, "the first block still fires")
  assert.equal(
    entries.find((e) => e.exempt === "empty-diff"),
    undefined,
    "no exemption entry",
  )
})

/** A capability error from `isEmptyDiff` fails open: journaled, never thrown. */
test("guardLanding: an isEmptyDiff capability error fails open", () => {
  const { policy, entries } = makePolicy({ gitGates: { mode: "enforce", emptyDiffExempt: true } })
  const { gate } = recordingCapability({ throwIn: "isEmptyDiff" })
  allows(() => policy.guardLanding("bash", "git push origin main", "s1", gate))
  const errs = entries.filter(
    (e) => e.type === "error" && /tool policy guard/.test(String(e.error)),
  )
  assert.equal(errs.length, 1)
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
 * `git push` candidate set only. A `gh pr` deny comes from `guardBash` (a
 * configured `bashDeny` rule — the default list is empty) and its telemetry
 * from `observeLanding`; the landing gate itself journals nothing for `gh pr`.
 */
test("guardLanding: gh pr is not the landing gate's target", () => {
  const { policy, entries } = makePolicy({ gitGates: { mode: "enforce" } })
  const { gate, log } = recordingCapability()
  allows(() => policy.guardLanding("bash", "gh pr create", "s1", gate))
  allows(() => policy.guardLanding("bash", "gh pr merge --squash", "s1", gate))
  assert.deepEqual(entries, [], "the landing gate is push-only")
  assert.equal(log.emptyDiff, 0, "gh pr never consults the empty-diff probe")
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
 * non-landing forms, so the evaluate-handler arm can share the exact
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
 * The tokenizer's backslash-escape path is exercised through `isPushLanding`: a
 * bare backslash (outside quotes) must neither split the string nor
 * mis-detect the verb — the `echo a\b` element yields `null` while the trailing
 * `git push` is still detected, routing `\` through the escape branches of both
 * `splitCommands` and `tokenizeWords`. The documented negatives hold so the
 * candidate set stays false-positive-free.
 */
test("isPushLanding: a bare backslash tokenizes without splitting, negatives hold", () => {
  // `\` outside quotes routes the escape branches; `git push` still detected.
  assert.ok(isPushLanding("echo a\\b; git push"))
  // A globally-optioned push after the escaped element still detects.
  assert.ok(isPushLanding("echo a\\b; git -C ./repo push"))
  // A backslash INSIDE quotes (the `\"` escape path) also routes the escape
  // branches without splitting or mis-detecting the trailing git push.
  assert.ok(isPushLanding('echo "a\\"b"; git push'))
  // Documented negatives: each subcommand is echo/commit/log, never push.
  assert.ok(!isPushLanding("echo remember to git push"))
  assert.ok(!isPushLanding('git commit -m "docs: git push"'))
  assert.ok(!isPushLanding("git log --grep push"))
})

/**
 * The fail-open guard: a command with no content (empty or whitespace-only) is
 * never a landing candidate, so `isPushLanding` short-circuits before the
 * tokenizer and returns false.
 */
test("isPushLanding: empty or whitespace-only commands are not pushes", () => {
  assert.ok(!isPushLanding(""))
  assert.ok(!isPushLanding("   \t\n"))
})

/**
 * A bare `git` with no subcommand (the tokenizer yields no matching verb) and a
 * separator-only command (every segment tokenizes to no words) are not pushes:
 * the `gitInvocation` fallback returns null on both, so the `.some(...)` scan is false.
 */
test("isPushLanding: a bare git verb and separator-only input are not pushes", () => {
  assert.ok(!isPushLanding("git"))
  assert.ok(!isPushLanding(";;;"))
  assert.ok(!isPushLanding("   ;;;   "))
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
