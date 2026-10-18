/**
 * @fileoverview Orchestrator-policy injection tests: the
 * `tool.execute.after` handler attributes each `task`/`subagent` result
 * delivery through the child→parent edge (`childToParent`) and prepends
 * `ORCHESTRATOR_POLICY` to the delivery's parent-side output once per task.
 * Cases: exact-once prepend + repeat no-op + journal (`injected:true`);
 * ordinary-tool exclusion and the journaled conservative skip (config-known
 * name with no resolvable edge); per-task reset re-injection; fail-open on a
 * prepend that throws (`injected:false`); silent skip on a missing/odd
 * result; a marker-example audit of the injected policy (placeholders never
 * parse, substituted templates do); the subagent-tool shape injecting on a
 * registered edge; the task shape with `event.agent` set; once-per-parent
 * keying across sibling children; and late-edge resolution via
 * `session.get`, with the unresolvable fallback journaled.
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
  waitUntil,
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
  sessionRecords?: Map<string, any>,
): Promise<{ h: FakeHost; dispose: () => void; metricsDir: string }> {
  const metricsDir = tmpDir()
  const h = makeFakeHost({ sessionRecords })
  const setup = turnstile(h.host, {
    env: isolatedEnv(metricsDir),
    config: { metricsDir, ...config },
  })
  const dispose = (await setup(h.host)) as () => void
  return { h, dispose, metricsDir }
}

/**
 * Pushes a `session.created` edge event, then a warmup error event that
 * confirms (FIFO stream order) the created event was already processed.
 * @param h The fake host.
 * @param child The child session ID.
 * @param parent The parent session ID.
 * @param metricsDir The metrics dir to poll for the warmup signal.
 */
async function resolveEdgeViaCreated(
  h: FakeHost,
  child: string,
  parent: string,
  metricsDir: string,
): Promise<void> {
  h.pushEvent({ type: "session.created", data: { sessionID: child, parentID: parent } })
  h.pushEvent({ type: "session.error", data: { sessionID: child, error: "warmup" } })
  await waitUntil(() =>
    journalEntries(metricsDir).some((l) => l.type === "error" && l.error === "warmup"),
  )
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

/** 2. Ordinary tools journal nothing; a config-known name with no
 *  resolvable edge journals the conservative skip; a config-unknown name
 *  still injects (the documented self-keyed residual). */
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
    // task/subagent dispatched under a config-known subagent name with no
    // resolvable edge: skipped, and the skip is journaled so the decision
    // is observable.
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
    // And a subagent dispatched under a name NOT in config with no edge still
    // receives the policy: on a host without a session API there is no way
    // to tell a parent-facing delivery from a child-own one, so the
    // self-keyed injection is the documented, accepted residual.
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
    const skips = policies.filter((p) => String(p.sessionID).startsWith("sub-"))
    assert.equal(skips.length, SUBAGENT_NAMES.length, "every config-known skip is journaled")
    for (const s of skips) {
      assert.equal(s.injected, false, "the skip reports injected:false")
      assert.equal(s.skipped, true, "the skip is flagged skipped:true")
      assert.equal(s.reason, "agent-name", "the skip names the reason")
    }
    assert.equal(
      policies.filter((p) => String(p.sessionID).startsWith("t-")).length,
      0,
      "ordinary tools journal no policy entries",
    )
    const injected = policies.filter((p) => p.injected === true)
    assert.equal(injected.length, 1, "only the untracked delivery injected")
    assert.equal(injected[0]!.sessionID, "p-untracked")
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

/** 7. The subagent-tool shape (child-keyed, event.agent set) injects on a
 *  registered edge and journals under the resolved parent — the
 *  name heuristic no longer excludes edge-resolved deliveries. */
test("injection: subagent-tool delivery with a registered edge injects, journaled under the parent", async () => {
  const { h, dispose, metricsDir } = await boot()
  try {
    await resolveEdgeViaCreated(h, "c1", "p1", metricsDir)
    const event = {
      tool: "subagent",
      sessionID: "c1",
      agent: "reviewer",
      result: { output: "VERDICT: APPROVE crit=0 high=0 med=0 low=0\nbody" },
    }
    await callTool(h, "execute.after", event)
    const out = String(event.result.output)
    assert.ok(out.startsWith(ORCHESTRATOR_POLICY), "the parent-facing delivery is policy-prefixed")
    assert.equal(countPolicy(out), 1, "the policy appears exactly once")
    const policies = journalEntries(metricsDir).filter((l) => l.type === "policy")
    assert.equal(policies.length, 1, "exactly one policy journal entry")
    assert.equal(policies[0]!.injected, true, "the entry reports injected:true")
    assert.equal(policies[0]!.sessionID, "p1", "the entry is keyed under the resolved parent")
  } finally {
    dispose()
  }
})

/** 8. The task-tool shape with event.agent set injects once; a repeat
 *  delivery within the same task is silent (once-flag). */
test("injection: task-tool delivery with event.agent set injects once; repeat is silent", async () => {
  const { h, dispose, metricsDir } = await boot()
  try {
    await resolveEdgeViaCreated(h, "c1", "p1", metricsDir)
    const event = {
      tool: "task",
      sessionID: "c1",
      agent: "planner",
      result: { output: "plan body" },
    }
    await callTool(h, "execute.after", event)
    assert.ok(
      String(event.result.output).startsWith(ORCHESTRATOR_POLICY),
      "prepended on first delivery",
    )
    await callTool(h, "execute.after", event)
    assert.equal(countPolicy(String(event.result.output)), 1, "a second call prepends nothing")
    const policies = journalEntries(metricsDir).filter((l) => l.type === "policy")
    assert.equal(policies.length, 1, "one policy journal entry")
    assert.equal(policies[0]!.injected, true)
    assert.equal(policies[0]!.sessionID, "p1")
  } finally {
    dispose()
  }
})

/** 9. The once-flag keys on the resolved parent: a sibling child's delivery
 *  in the same task is not re-prepended, and a fresh parent prompt re-arms
 *  both children's deliveries. */
test("injection: the once-flag keys on the resolved parent across sibling children", async () => {
  const { h, dispose, metricsDir } = await boot()
  try {
    await resolveEdgeViaCreated(h, "c1", "p1", metricsDir)
    const first = {
      tool: "subagent",
      sessionID: "c1",
      agent: "reviewer",
      result: { output: "VERDICT: APPROVE crit=0 high=0 med=0 low=0" },
    }
    await callTool(h, "execute.after", first)
    assert.ok(
      String(first.result.output).startsWith(ORCHESTRATOR_POLICY),
      "the first child's delivery is prepended",
    )
    await resolveEdgeViaCreated(h, "c2", "p1", metricsDir)
    const second = {
      tool: "subagent",
      sessionID: "c2",
      agent: "reviewer",
      result: { output: "VERDICT: APPROVE crit=0 high=0 med=0 low=0" },
    }
    await callTool(h, "execute.after", second)
    assert.equal(
      countPolicy(String(second.result.output)),
      0,
      "the sibling child's delivery is not prepended (parent flag set)",
    )
    const policies = journalEntries(metricsDir).filter((l) => l.type === "policy")
    assert.equal(policies.length, 1, "still exactly one policy entry")
    assert.equal(policies[0]!.sessionID, "p1")
    // A new user prompt on the parent resets the task state and re-arms
    // every child's delivery for the next task.
    await callSession(h, "prompt", { sessionID: "p1" })
    const third = {
      tool: "subagent",
      sessionID: "c2",
      agent: "reviewer",
      result: { output: "VERDICT: APPROVE crit=0 high=0 med=0 low=0" },
    }
    await callTool(h, "execute.after", third)
    assert.ok(
      String(third.result.output).startsWith(ORCHESTRATOR_POLICY),
      "re-armed after the parent's prompt reset",
    )
    const policies2 = journalEntries(metricsDir).filter((l) => l.type === "policy")
    assert.equal(policies2.length, 2, "one entry per task")
    assert.equal(policies2[1]!.sessionID, "p1")
  } finally {
    dispose()
  }
})

/** 10. Late-edge resolution: with no session.created event the
 *  session.get record still resolves the edge and the delivery injects;
 *  the same shape with no host record at all falls to the journaled
 *  conservative skip. */
test("injection: a late session.get edge injects; an unresolvable known name journals the skip", async () => {
  const records = new Map([["c9", { parentID: "p1", agent: "reviewer" }]])
  const { h, dispose, metricsDir } = await boot({}, records)
  try {
    const event = {
      tool: "subagent",
      sessionID: "c9",
      agent: "reviewer",
      result: { output: "late-edge body" },
    }
    await callTool(h, "execute.after", event)
    assert.ok(
      String(event.result.output).startsWith(ORCHESTRATOR_POLICY),
      "injected once the session.get edge resolves",
    )
    const policies = journalEntries(metricsDir).filter((l) => l.type === "policy")
    assert.equal(policies.length, 1)
    assert.equal(policies[0]!.injected, true)
    assert.equal(policies[0]!.sessionID, "p1")
  } finally {
    dispose()
  }
  const plain = await boot()
  try {
    const event = {
      tool: "subagent",
      sessionID: "cX",
      agent: "reviewer",
      result: { output: "body" },
    }
    await callTool(plain.h, "execute.after", event)
    assert.equal(String(event.result.output), "body", "not injected without a resolvable edge")
    const policies = journalEntries(plain.metricsDir).filter((l) => l.type === "policy")
    assert.equal(policies.length, 1, "the fallback skip is journaled")
    assert.equal(policies[0]!.injected, false)
    assert.equal(policies[0]!.skipped, true)
    assert.equal(policies[0]!.reason, "agent-name")
    assert.equal(policies[0]!.sessionID, "cX")
  } finally {
    plain.dispose()
  }
})
