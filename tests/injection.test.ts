/**
 * @fileoverview Orchestrator-policy injection tests: the
 * `tool.execute.after` handler prepends `ORCHESTRATOR_POLICY` to the model-
 * facing output text of the first per-parent per-task result delivery, once,
 * for the primary session only. Cases: exact-once prepend + repeat no-op +
 * journal (`injected:true`); child/subagent and ordinary-tool exclusions;
 * per-task reset re-injection; fail-open on a prepend that throws
 * (`injected:false`); silent skip on a missing/odd result; a marker-example
 * audit of the injected policy (placeholders never parse, substituted
 * templates do); and the config `planner` default.
 */

import { test } from "node:test"
import assert from "node:assert/strict"

import { turnstile } from "../turnstile.ts"
import { ORCHESTRATOR_POLICY } from "../src/policy.ts"
import { GATE_RE, VERDICT_RE, parseGateMarkers } from "../src/markers.ts"
import { newState } from "../src/state.ts"
import {
  callSession,
  callTool,
  isolatedEnv,
  journalEntries,
  makeFakeHost,
  tmpDir,
  type FakeHost,
} from "./helpers.ts"

const SUBAGENT_NAMES = [
  "planner",
  "reviewer",
  "plan-reviewer",
  "executor",
  "test-runner",
  "debugger",
]

/** Boots the plugin over a fake host with a temp metrics dir. */
async function boot(
  config: Record<string, any> = {},
): Promise<{ h: FakeHost; dispose: () => void; metricsDir: string }> {
  const metricsDir = tmpDir()
  const h = makeFakeHost()
  const setup = turnstile(h.host, {
    env: isolatedEnv(metricsDir),
    config: { metricsDir, ...config },
  })
  const dispose = (await setup(h.host)) as () => void
  return { h, dispose, metricsDir }
}

/** How many times the policy block appears in a (possibly prepended) string. */
function countPolicy(text: string): number {
  return text.split(ORCHESTRATOR_POLICY).length - 1
}

/** 1. Prepend happens once, a repeat within the same task adds nothing, and
 *  the event carries the policy. */
test("injection: parent task result prepended once; repeat adds nothing; journal injected:true", async () => {
  const { h, dispose, metricsDir } = await boot()
  try {
    const event = {
      tool: "task",
      sessionID: "p1",
      input: { agent: "reviewer", prompt: "run it" },
      result: { output: "GATE: PASS tests=1 passed=1 failed=0\n" },
    }
    await callTool(h, "execute.after", event)
    const once = String(event.result.output)
    assert.ok(once.startsWith(ORCHESTRATOR_POLICY), "the output is policy-prefixed")
    assert.equal(countPolicy(once), 1, "the policy appears exactly once")
    // Repeat within the same task: the flag makes it a no-op.
    await callTool(h, "execute.after", event)
    assert.equal(countPolicy(String(event.result.output)), 1, "a second call prepends nothing")
    const policies = journalEntries(metricsDir).filter((l) => l.type === "policy")
    assert.equal(policies.length, 1, "exactly one policy journal entry")
    assert.equal(policies[0]!.injected, true, "the entry reports injected:true")
    assert.equal(policies[0]!.sessionID, "p1")
  } finally {
    dispose()
  }
})

/** 2. Child/subagent results and ordinary-tool results are untouched. */
test("injection: ordinary tools and config-named subagents are excluded", async () => {
  const { h, dispose, metricsDir } = await boot()
  try {
    // Ordinary tools with any agent value: no policy, no journal entry.
    for (const tool of ["shell", "read"]) {
      for (const agent of [undefined, "planner", "custom-bot"]) {
        const event = { tool, sessionID: `t-${tool}`, agent, result: { output: "raw" } }
        await callTool(h, "execute.after", event)
        assert.equal(
          String((event as { result: { output: string } }).result.output),
          "raw",
          `${tool} result untouched`,
        )
      }
    }
    // task/subagent dispatched under a config-known subagent name: skipped.
    for (const name of SUBAGENT_NAMES) {
      const event = {
        tool: "task",
        sessionID: `sub-${name}`,
        agent: name,
        result: { output: "subagent-body" },
      }
      await callTool(h, "execute.after", event)
      assert.equal(
        String((event as { result: { output: string } }).result.output),
        "subagent-body",
        `task under ${name} untouched`,
      )
    }
    // And a subagent dispatched under a name NOT in config still receives the
    // policy (documented under-exclusion); here the guard relies on tool name
    // + the absence of a known subagent name on the primary.
    const untracked = {
      tool: "task",
      sessionID: "p-untracked",
      agent: "custom-bot",
      result: { output: "untracked-body" },
    }
    await callTool(h, "execute.after", untracked)
    assert.ok(
      String(untracked.result.output).startsWith(ORCHESTRATOR_POLICY),
      "a config-unknown subagent name is treated as primary-session prose",
    )
    const policies = journalEntries(metricsDir).filter((l) => l.type === "policy")
    assert.equal(policies.length, 1, "only the untracked delivery injected")
    assert.equal(policies[0]!.injected, true)
  } finally {
    dispose()
  }
})

/** 3. A task reset via the prompt hook re-enables injection for the next task. */
test("injection: per-task prompt reset re-injects on the next task delivery", async () => {
  const { h, dispose, metricsDir } = await boot()
  try {
    const first = { tool: "task", sessionID: "p1", result: { output: "first" } }
    await callTool(h, "execute.after", first)
    assert.ok(String(first.result.output).startsWith(ORCHESTRATOR_POLICY))
    // A new user prompt resets the task state (flag cleared).
    await callSession(h, "prompt", { sessionID: "p1" })
    const second = { tool: "task", sessionID: "p1", result: { output: "second" } }
    await callTool(h, "execute.after", second)
    assert.ok(
      String(second.result.output).startsWith(ORCHESTRATOR_POLICY),
      "re-injected after reset",
    )
    assert.equal(countPolicy(String(second.result.output)), 1, "re-injected exactly once")
    const policies = journalEntries(metricsDir).filter((l) => l.type === "policy")
    assert.equal(policies.length, 2, "one entry per task delivery")
    assert.ok(policies.every((p) => p.injected === true))
  } finally {
    dispose()
  }
})

/** 4. Fail-open: a prepend that throws completes the hook and journals
 *  injected:false with an error, never re-throwing. */
test("injection: a result whose prepend throws fails open with injected:false", async () => {
  const { h, dispose, metricsDir } = await boot()
  try {
    let threw = false
    try {
      // A frozen result: assigning the prepended value throws in strict mode.
      await callTool(h, "execute.after", {
        tool: "task",
        sessionID: "p1",
        result: Object.freeze({ output: "frozen-body" }),
      })
    } catch {
      threw = true
    }
    assert.equal(threw, false, "the hook completes even when the prepend throws")
    const policies = journalEntries(metricsDir).filter((l) => l.type === "policy")
    assert.equal(policies.length, 1, "the failure is journaled")
    assert.equal(policies[0]!.injected, false, "the entry reports injected:false")
    assert.match(String(policies[0]!.error ?? ""), /.+/, "an error string is recorded")
  } finally {
    dispose()
  }
})

/** 5. A missing or oddly-shaped result skips silently: no policy journal
 *  entry and the flag stays false. */
test("injection: missing or non-string result skips silently with no policy entry", async () => {
  const { h, dispose, metricsDir } = await boot()
  try {
    await callTool(h, "execute.after", { tool: "task", sessionID: "p9", result: undefined })
    await callTool(h, "execute.after", { tool: "task", sessionID: "p9b", result: { output: 42 } })
    const policies = journalEntries(metricsDir).filter((l) => l.type === "policy")
    assert.equal(policies.length, 0, "no policy entry is journaled for a non-string result")
  } finally {
    dispose()
  }
})

/** 6. The injected policy is marker-safe: every <n>-substituted template
 *  parses under its canonical regex (mirroring check-markers.mjs), while the
 *  raw placeholder text never parses as a marker. */
test("injection: ORCHESTRATOR_POLICY templates parse only after <n>-substitution (echo-safe)", async () => {
  // Mirror scripts/check-markers.mjs: strip the `g` flag for stateful .test,
  // extract each backticked GATE:/VERDICT: template, substitute <n>→1, and
  // assert it parses under its canonical regex.
  const gateRe = new RegExp(GATE_RE.source)
  const verdictRe = new RegExp(VERDICT_RE.source)
  const templates = [...ORCHESTRATOR_POLICY.matchAll(/`((?:GATE|VERDICT): [^\n`]*)`/g)]
  assert.ok(templates.length >= 1, "the policy carries GATE/VERDICT templates")
  for (const m of templates) {
    const line = m[1]!.replaceAll("<n>", "1")
    const re = line.startsWith("GATE") ? gateRe : verdictRe
    assert.ok(re.test(line), `template parses after substitution: ${line.slice(0, 40)}`)
  }
  // Echo-safety: the raw placeholder text never parses into a marker on any
  // session text (the parse path uses the canonical regexes directly).
  const echoed = parseGateMarkers(newState(), ORCHESTRATOR_POLICY, GATE_RE, VERDICT_RE)
  assert.equal(echoed.length, 0, "the raw placeholder text never parses into a marker")
})
