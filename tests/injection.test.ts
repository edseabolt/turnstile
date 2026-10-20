/**
 * @fileoverview Orchestrator-policy injection tests: the
 * `tool.execute.after` handler classifies each `task`/`subagent` result
 * delivery into its host shape — v1 string (child-keyed event, text in
 * `result.output`) or v2 structured (parent-keyed event, child via
 * `metadata.sessionID`, model-visible text in `result.content`) — attributes
 * it through the child→parent edge (`childToParent`), and prepends
 * `ORCHESTRATOR_POLICY` to the delivery's model-visible text once per task.
 * Cases: exact-once prepend + repeat no-op + journal (`injected:true`);
 * ordinary-tool exclusion and the journaled conservative skip (config-known
 * name with no resolvable edge); per-task reset re-injection; fail-open on a
 * prepend that throws (`injected:false`); an absent result stays silent
 * while an unrecognized shape journals loudly (`reason:"unknown-shape"` with
 * a shape descriptor); a marker-example audit of the injected policy
 * (placeholders never parse, substituted templates do); the subagent-tool
 * shape injecting on a registered edge; the task shape with `event.agent`
 * set; once-per-parent keying across sibling children; late-edge resolution
 * via `session.get`, with the unresolvable fallback journaled; structured
 * injection into the model-visible `result.content` (a block array gains a
 * prepended text block; a plain string is prefixed in place; absent or
 * other content falls back to the structured output string) with the
 * `result.output` object staying object-identical; the once-flag across
 * shapes; marker attribution through a structured delivery (reviewer
 * verdict credit and plan-reviewer plan entry, `raw` = the real child, no
 * forensic path — parsed from the canonical `output.output` string, not the
 * content block); spurious-violation regressions (a streamed verdict
 * suppresses; a marker-less delivery keys the violation on the real child);
 * the name guard inert on structured deliveries; child attribution through
 * the `output.sessionID` fallback; fail-open on a frozen structured prepend;
 * the background-ack parity violation; and string-shape child attribution
 * via `metadata.sessionID`. The per-delivery `PIPELINE:` status tail: it
 * lands on every pipeline-stage delivery (first delivery head+tail, later
 * deliveries tail-only while the head stays once-per-task); it names the
 * just-completed and successor stages by their configured (renamed) values;
 * a non-pipeline agent gets no tail (byte-identical head-only delivery);
 * an unclassifiable shape journals loudly on EVERY delivery (the once-flag
 * no longer gates it); a throwing append fails open (`pipeline-status:`
 * journal, the head still lands); and a live field that ceases to be a
 * string between classification and mutation re-reads the classified text.
 */

import * as path from "node:path"
import { test } from "node:test"
import assert from "node:assert/strict"

import { turnstile } from "../turnstile.ts"
import { ORCHESTRATOR_POLICY } from "../src/policy.ts"
import { GATE_RE, VERDICT_RE, parseGateMarkers } from "../src/markers.ts"
import { newState } from "../src/state.ts"
import { createLedger } from "../src/ledger.ts"
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

/**
 * Counts the policy block across a model-visible `content` value: the joined
 * text of a content block array, or the string itself.
 * @param content The delivery's `result.content` (string, block array, or absent).
 * @returns The number of policy blocks.
 */
function policyCountOf(content: unknown): number {
  const text = Array.isArray(content)
    ? content.map((block: { text?: unknown }) => String(block?.text ?? "")).join("")
    : String(content)
  return countPolicy(text)
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

/** 5. The silent cases are exactly two: an absent result and the
 *  once-flag. A present-but-unrecognized result shape journals loudly
 *  (reason:"unknown-shape") without injecting, and — not setting the
 *  once-flag — a following string delivery on the same session injects. */
test("injection: an absent result stays silent; an unrecognized result shape journals loudly", async () => {
  const { h, dispose, metricsDir } = await boot()
  try {
    await callTool(h, "execute.after", { tool: "task", sessionID: "p9", result: undefined })
    assert.equal(
      journalEntries(metricsDir).filter((l) => l.type === "policy").length,
      0,
      "an absent result journals nothing",
    )
    await callTool(h, "execute.after", { tool: "task", sessionID: "p9b", result: { output: 42 } })
    const loud = journalEntries(metricsDir).filter((l) => l.type === "policy")
    assert.equal(loud.length, 1, "an unrecognized shape journals exactly one entry")
    assert.equal(loud[0]!.injected, false, "the entry reports injected:false")
    assert.equal(loud[0]!.reason, "unknown-shape", "the entry names the reason")
    assert.ok(
      String(loud[0]!.shape).startsWith("output=number "),
      "the descriptor names the output type",
    )
    // The loud journal does not set the once-flag: a following string
    // delivery on the same session still injects.
    await callTool(h, "execute.after", {
      tool: "task",
      sessionID: "p9b",
      result: { output: "real" },
    })
    const policies = journalEntries(metricsDir).filter((l) => l.type === "policy")
    assert.equal(policies.length, 2, "the follow-up string delivery still injects")
    assert.equal(policies[1]!.injected, true)
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

/**
 * Builds a v2 host delivery event: structured `result.output`
 * (`{ sessionID, status, output }`), a parent-keyed `sessionID` ("p1"), the
 * child on `metadata.sessionID`, and the model-visible `result.content` —
 * a content block array by default (the real host shape: one text block
 * carrying the `<subagent …>`-wrapped child text), or a plain string when
 * `contentShape` is "string". The dispatch agent defaults to a
 * config-UNKNOWN name so the bare-output check and reviewer capture stay
 * quiet in pure-injection cases; override it to exercise them.
 * @param child The child session ID.
 * @param text The child's result text (the canonical `output.output`).
 * @param agent The dispatch agent (event.agent and input.agent).
 * @param contentShape Block-array (default) or plain-string `content`.
 */
function structured(
  child: string,
  text: string,
  agent: string = "build",
  contentShape: "array" | "string" = "array",
): Record<string, any> {
  const wrapped = `<subagent sessionID="${child}" state="completed">\n${text}\n</subagent>`
  return {
    tool: "subagent",
    sessionID: "p1",
    agent,
    input: { agent, prompt: "run it" },
    result: {
      output: { sessionID: child, status: "completed", output: text },
      content: contentShape === "string" ? wrapped : [{ type: "text", text: wrapped }],
      metadata: { sessionID: child, status: "completed" },
    },
  }
}

/** 11. The structured (v2) shape: the policy head AND the per-delivery
 *  status tail land in `result.content` (the tail appended after the
 *  original block, the head prepended before it), the `result.output`
 *  object stays object-identical, the journal keys on the resolved parent,
 *  and a repeat delivery re-appends the tail but prepends nothing. */
test("injection: a structured delivery injects into result.content, leaving result.output untouched", async () => {
  const { h, dispose, metricsDir } = await boot()
  try {
    const status =
      "PIPELINE: planner=done plan=PENDING tests=RED reviewer=0/2 next=plan-reviewer — dispatch the next agent in this same turn"
    await resolveEdgeViaCreated(h, "c1", "p1", metricsDir)
    const outRef = { sessionID: "c1", status: "completed", output: "planner body" }
    const ev = structured("c1", "planner body", "planner")
    ev.result.output = outRef
    const blockBefore = ev.result.content[0]
    await callTool(h, "execute.after", ev)
    const content = ev.result.content
    assert.equal(
      Array.isArray(content) && content.length,
      3,
      "the content array gains the policy head and the status tail",
    )
    assert.equal(content[0].type, "text", "the prepended head is a text block")
    assert.equal(
      content[0].text,
      ORCHESTRATOR_POLICY + "\n",
      "the prepended block carries the policy",
    )
    assert.equal(content[1], blockBefore, "the original block sits between head and tail")
    assert.equal(
      content[1].text,
      `<subagent sessionID="c1" state="completed">\nplanner body\n</subagent>`,
      "the wrapper text is unmutated",
    )
    assert.equal(content[2].type, "text", "the appended tail is a text block")
    assert.equal(
      content[2].text,
      "\n" + status,
      "the appended block carries the per-delivery status line",
    )
    assert.equal(ev.result.output, outRef, "the structured output object is object-identical")
    assert.equal(ev.result.output.output, "planner body", "its inner text is unmutated")
    const policies = journalEntries(metricsDir).filter((l) => l.type === "policy")
    assert.equal(policies.length, 1, "exactly one policy journal entry")
    assert.equal(policies[0]!.injected, true, "the entry reports injected:true")
    assert.equal(policies[0]!.sessionID, "p1", "keyed under the resolved parent")
    await callTool(h, "execute.after", ev)
    assert.equal(policyCountOf(ev.result.content), 1, "a repeat delivery prepends nothing")
    assert.equal(
      journalEntries(metricsDir).filter((l) => l.type === "policy").length,
      1,
      "the repeat journals nothing",
    )
  } finally {
    dispose()
  }
})

/** 12. The once-flag keys on the resolved parent across shapes: a string
 *  delivery that injects makes a following structured delivery for a
 *  sibling child of the same parent a silent no-op. */
test("injection: the once-flag holds across delivery shapes within one task", async () => {
  const { h, dispose, metricsDir } = await boot()
  try {
    await resolveEdgeViaCreated(h, "c1", "p1", metricsDir)
    const v1 = { tool: "task", sessionID: "p1", result: { output: "v1 body" } }
    await callTool(h, "execute.after", v1)
    assert.ok(String(v1.result.output).startsWith(ORCHESTRATOR_POLICY), "the v1 delivery injects")
    const ev = structured("c1", "structured body")
    await callTool(h, "execute.after", ev)
    assert.equal(policyCountOf(ev.result.content), 0, "the structured delivery is silent")
    const policies = journalEntries(metricsDir).filter((l) => l.type === "policy")
    assert.equal(policies.length, 1, "still exactly one policy entry")
    assert.equal(policies[0]!.injected, true)
    assert.equal(policies[0]!.sessionID, "p1")
  } finally {
    dispose()
  }
})

/** 13. A structured reviewer delivery whose content carries a VERDICT
 *  APPROVE credits the landing gate through the registered edge; the
 *  journaled verdict keys on the parent with raw = the real child, and a
 *  restart replay restores the credit from that entry. */
test("injection: a structured reviewer verdict credits the landing gate through the registered edge", async () => {
  const { h, dispose, metricsDir } = await boot({ reviewEnsemble: "advise" })
  try {
    await resolveEdgeViaCreated(h, "c1", "p1", metricsDir)
    const ev = structured("c1", "VERDICT: APPROVE crit=0 high=0 med=0 low=0\nbody", "reviewer")
    await callTool(h, "execute.after", ev)
    const verdicts = journalEntries(metricsDir).filter((l) => l.type === "verdict")
    assert.equal(verdicts.length, 1, "the verdict is journaled once")
    assert.equal(verdicts[0]!.sessionID, "p1", "keyed under the resolved parent")
    assert.equal(verdicts[0]!.raw, "c1", "raw is the real child")
    assert.equal(verdicts[0]!.source, "task-result", "the source names the delivery")
    const ledger = createLedger(path.join(metricsDir, "turnstile.jsonl"))
    assert.equal(
      ledger.state("p1").hasReviewApprove,
      true,
      "a restart replay restores the landing credit",
    )
  } finally {
    dispose()
  }
})

/** 14. A structured plan-reviewer delivery with a verdict moves the plan
 *  gate through the edge-resolved path: the plan entry's raw is the real
 *  child and the self-keyed forensic attribution path does not fire. */
test("injection: a structured plan-reviewer verdict journals the plan entry under the real child", async () => {
  const { h, dispose, metricsDir } = await boot()
  try {
    await resolveEdgeViaCreated(h, "c2", "p1", metricsDir)
    const ev = structured("c2", "VERDICT: APPROVE crit=0 high=0 med=0 low=0\nbody", "plan-reviewer")
    await callTool(h, "execute.after", ev)
    const plans = journalEntries(metricsDir).filter((l) => l.type === "plan")
    assert.equal(plans.length, 1, "the plan gate move is journaled once")
    assert.equal(plans[0]!.sessionID, "p1", "keyed under the resolved parent")
    assert.equal(plans[0]!.raw, "c2", "raw is the real child, never the parent")
    assert.equal(
      journalEntries(metricsDir).some((l) => l.type === "attribution"),
      false,
      "the self-keyed forensic path does not fire",
    )
  } finally {
    dispose()
  }
})

/** 15. Spurious-violation regression, suppression case: a marker-less
 *  structured delivery for a bareOutput agent whose child verdict was
 *  already streamed journals no violation (the plan-reviewer's stored
 *  child-text verdict suppresses it). */
test("injection: a streamed verdict suppresses the bare check on a marker-less structured delivery", async () => {
  const { h, dispose, metricsDir } = await boot()
  try {
    // Seed the edge and the emitter agent (created-event agent), then stream
    // the child's verdict before the delivery arrives.
    h.pushEvent({
      type: "session.created",
      data: { sessionID: "c1", parentID: "p1", agent: "plan-reviewer" },
    })
    h.pushEvent({
      type: "session.text.ended",
      data: { sessionID: "c1", text: "VERDICT: APPROVE crit=0 high=0 med=0 low=0" },
    })
    h.pushEvent({ type: "session.error", data: { sessionID: "c1", error: "warmup" } })
    await waitUntil(() =>
      journalEntries(metricsDir).some((l) => l.type === "error" && l.error === "warmup"),
    )
    const ev = structured("c1", "summarized, marker-less", "plan-reviewer")
    await callTool(h, "execute.after", ev)
    assert.equal(
      journalEntries(metricsDir).filter((l) => l.type === "violation").length,
      0,
      "the streamed verdict suppresses the bare check",
    )
  } finally {
    dispose()
  }
})

/** 16. Spurious-violation regression, firing case: a marker-less
 *  structured delivery with no verdict anywhere journals exactly one
 *  violation keyed on the real child — never on the parent ID. */
test("injection: a marker-less structured delivery journals a violation keyed on the real child", async () => {
  const { h, dispose, metricsDir } = await boot()
  try {
    await resolveEdgeViaCreated(h, "c1", "p1", metricsDir)
    const ev = structured("c1", "summarized, marker-less", "plan-reviewer")
    await callTool(h, "execute.after", ev)
    const violations = journalEntries(metricsDir).filter((l) => l.type === "violation")
    assert.equal(violations.length, 1, "exactly one violation")
    assert.equal(violations[0]!.sessionID, "c1", "keyed on the real child, never the parent")
  } finally {
    dispose()
  }
})

/** 17. Present-but-unclassifiable results fail loud: each shape journals
 *  the unknown-shape entry with its exact safe descriptor, injects
 *  nothing, and journals no violation. event.agent is left undefined on
 *  purpose: a config-known name would journal an agent-name skip instead. */
test("injection: three unclassifiable result shapes each journal loudly with their descriptor", async () => {
  const { h, dispose, metricsDir } = await boot()
  try {
    const cases = [
      {
        result: { output: 42 },
        shape: "output=number content=undefined metadata=undefined",
      },
      {
        result: { output: { nope: true } },
        shape: "output=object[nope] content=undefined metadata=undefined",
      },
      {
        result: { output: { output: "text" }, content: "text block" },
        shape: "output=object[output] content=string metadata=undefined",
      },
    ]
    for (let i = 0; i < cases.length; i++) {
      const event = {
        tool: "subagent",
        sessionID: `pu${i}`,
        input: { agent: "test-runner", prompt: "run it" },
        result: cases[i]!.result,
      }
      await callTool(h, "execute.after", event)
    }
    const policies = journalEntries(metricsDir).filter((l) => l.type === "policy")
    assert.equal(policies.length, 3, "each unclassifiable shape journals one entry")
    for (let i = 0; i < cases.length; i++) {
      const entry = policies.find((p) => p.sessionID === `pu${i}`)
      assert.ok(entry, `an entry exists for pu${i}`)
      assert.equal(entry!.injected, false, "the entry reports injected:false")
      assert.equal(entry!.reason, "unknown-shape", "the entry names the reason")
      assert.equal(entry!.shape, cases[i]!.shape, "the descriptor is exact and bounded")
    }
    // No violation entries: the unknown shape's empty text no-ops the
    // bare-output check instead of firing on a shape artifact.
    assert.equal(
      journalEntries(metricsDir).filter((l) => l.type === "violation").length,
      0,
      "no violation fires on a shape artifact",
    )
  } finally {
    dispose()
  }
})

/** 18. The shape descriptor branches: undefined/null/array/object
 *  (key-cap truncation) outputs, a record output with a string inner
 *  output but no resolvable child ID (unknown, not structured), a
 *  non-string content, and an absent (null) result that stays silent. */
test("injection: the unknown-shape descriptor covers every result branch", async () => {
  const { h, dispose, metricsDir } = await boot()
  try {
    const cases = [
      { result: {}, shape: "output=undefined content=undefined metadata=undefined" },
      { result: { output: null }, shape: "output=null content=undefined metadata=undefined" },
      { result: { output: [1, 2, 3] }, shape: "output=array content=undefined metadata=undefined" },
      {
        result: { output: { a: 1, b: 2, c: 3, d: 4, e: 5, f: 6, g: 7, h: 8, i: 9, j: 10 } },
        shape: "output=object[a,b,c,d,e,f,g,h] content=undefined metadata=undefined",
      },
      {
        result: { output: { output: "x" }, content: "y" },
        shape: "output=object[output] content=string metadata=undefined",
      },
      {
        result: {
          output: { sessionID: 42, output: "x" },
          content: 42,
          metadata: { sessionID: 42 },
        },
        shape: "output=object[output,sessionID] content=number metadata=object",
      },
    ]
    for (let i = 0; i < cases.length; i++) {
      await callTool(h, "execute.after", {
        tool: "task",
        sessionID: `pf${i}`,
        result: cases[i]!.result,
      })
    }
    // An absent (null) result stays silent: the documented silent case.
    await callTool(h, "execute.after", { tool: "task", sessionID: "pf7", result: null })
    const policies = journalEntries(metricsDir).filter((l) => l.type === "policy")
    assert.equal(policies.length, cases.length, "every unclassifiable shape journals one entry")
    for (let i = 0; i < cases.length; i++) {
      const entry = policies.find((p) => p.sessionID === `pf${i}`)
      assert.ok(entry, `an entry exists for pf${i}`)
      assert.equal(entry!.reason, "unknown-shape")
      assert.equal(entry!.shape, cases[i]!.shape, "the descriptor is exact per branch")
    }
    assert.equal(
      policies.some((p) => p.sessionID === "pf7"),
      false,
      "an absent result journals nothing",
    )
  } finally {
    dispose()
  }
})

/** 19. The name guard is inert on structured deliveries: an unresolvable
 *  edge plus a config-known event.agent still injects (the host built that
 *  result on the parent's own tool call, so event.agent is the parent's
 *  name), with no agent-name skip journaled. */
test("injection: the name guard is inert on a structured delivery with an unresolvable edge", async () => {
  const { h, dispose, metricsDir } = await boot()
  try {
    const ev = structured("cX", "body", "planner")
    await callTool(h, "execute.after", ev)
    assert.ok(
      ev.result.content[0].text.startsWith(ORCHESTRATOR_POLICY),
      "injected despite the config-known name",
    )
    const policies = journalEntries(metricsDir).filter((l) => l.type === "policy")
    assert.equal(policies.length, 1, "no agent-name skip is journaled")
    assert.equal(policies[0]!.injected, true)
    assert.equal(
      policies[0]!.sessionID,
      "cX",
      "the unresolvable edge self-keys the entry (documented residual)",
    )
  } finally {
    dispose()
  }
})

/** 20. Child attribution through the `output.sessionID` fallback: with no
 *  `metadata` block the structured result still resolves its child (and
 *  thus its real parent) from the structured output object; the bare
 *  check evaluates the child's actual text and keys the violation there. */
test("injection: a structured delivery without metadata resolves the child from the output object", async () => {
  const { h, dispose, metricsDir } = await boot()
  try {
    // The edge deliberately points at p9, not the event's sessionID p1, so
    // the assertions prove the child came from the result, not the event.
    await resolveEdgeViaCreated(h, "c8", "p9", metricsDir)
    const ev = structured("c8", "marker-less body", "reviewer")
    delete ev.result.metadata
    await callTool(h, "execute.after", ev)
    const policies = journalEntries(metricsDir).filter((l) => l.type === "policy")
    assert.equal(policies.length, 1)
    assert.equal(policies[0]!.injected, true)
    assert.equal(
      policies[0]!.sessionID,
      "p9",
      "keyed under the real parent from the edge, not the event",
    )
    const violations = journalEntries(metricsDir).filter((l) => l.type === "violation")
    assert.equal(violations.length, 1, "the bare check sees the child's actual text")
    assert.equal(violations[0]!.sessionID, "c8", "the violation keys on the real child")
  } finally {
    dispose()
  }
})

/** 21. Fail-open on the structured prepend: a frozen result makes the
 *  content assignment throw; the hook completes, journals
 *  injected:false with the error, and lands no policy text. */
test("injection: a frozen structured result fails open with injected:false and no throw", async () => {
  const { h, dispose, metricsDir } = await boot()
  try {
    const ev = structured("cF2", "frozen body")
    Object.freeze(ev.result)
    let threw = false
    try {
      await callTool(h, "execute.after", ev)
    } catch {
      threw = true
    }
    assert.equal(threw, false, "the hook completes even when the prepend throws")
    assert.equal(
      ev.result.content[0].text,
      `<subagent sessionID="cF2" state="completed">\nfrozen body\n</subagent>`,
      "no policy block landed",
    )
    const policies = journalEntries(metricsDir).filter((l) => l.type === "policy")
    assert.equal(policies.length, 1, "the failure is journaled")
    assert.equal(policies[0]!.injected, false, "the entry reports injected:false")
    assert.match(String(policies[0]!.error ?? ""), /.+/, "an error string is recorded")
  } finally {
    dispose()
  }
})

/** 22. Background-ack parity: a structured `status:"running"` delivery
 *  carries marker-less ack text, and the bare-output check fires on it for
 *  a bareOutput agent exactly as the v1 ack string would — one violation,
 *  keyed on the real child. */
test("injection: a structured background ack fires the bare check like the v1 ack string", async () => {
  const { h, dispose, metricsDir } = await boot()
  try {
    await resolveEdgeViaCreated(h, "cR", "p1", metricsDir)
    const ev = structured("cR", "task started in background", "test-runner")
    ev.result.output.status = "running"
    ev.result.metadata.status = "running"
    await callTool(h, "execute.after", ev)
    const violations = journalEntries(metricsDir).filter((l) => l.type === "violation")
    assert.equal(violations.length, 1, "the marker-less ack violates exactly once")
    assert.equal(violations[0]!.sessionID, "cR", "keyed on the real child")
  } finally {
    dispose()
  }
})

/** 23. String-shape child attribution via `metadata.sessionID`: a v1
 *  string delivery whose metadata names a real child attributes the
 *  violation to that child and keys the policy on the edge-resolved
 *  parent, not the event's session ID. */
test("injection: a string delivery with a metadata child keys the violation on the real child", async () => {
  const { h, dispose, metricsDir } = await boot()
  try {
    await resolveEdgeViaCreated(h, "c5", "p1", metricsDir)
    const event = {
      tool: "task",
      sessionID: "p1",
      input: { agent: "test-runner", prompt: "run it" },
      result: { output: "marker-less body", metadata: { sessionID: "c5" } },
    }
    await callTool(h, "execute.after", event)
    const violations = journalEntries(metricsDir).filter((l) => l.type === "violation")
    assert.equal(violations.length, 1, "the bare check sees the real child's text")
    assert.equal(
      violations[0]!.sessionID,
      "c5",
      "keyed on the metadata child, not the event session",
    )
    const policies = journalEntries(metricsDir).filter((l) => l.type === "policy")
    assert.equal(policies.length, 1)
    assert.equal(policies[0]!.injected, true)
    assert.equal(policies[0]!.sessionID, "p1", "the policy keys on the edge-resolved parent")
  } finally {
    dispose()
  }
})

/** 24. The structured shape with a plain-string `content`: the policy is
 *  prefixed into the string in place, the wrapper is preserved below it,
 *  the per-delivery status tail is appended after the wrapper, and the
 *  `result.output` object stays object-identical. */
test("injection: a structured delivery with string content prefixes the policy into the string", async () => {
  const { h, dispose, metricsDir } = await boot()
  try {
    const status =
      "PIPELINE: planner=done plan=PENDING tests=RED reviewer=0/2 next=plan-reviewer — dispatch the next agent in this same turn"
    await resolveEdgeViaCreated(h, "cS", "p1", metricsDir)
    const ev = structured("cS", "string content body", "planner", "string")
    const outRef = ev.result.output
    const contentBefore = ev.result.content
    await callTool(h, "execute.after", ev)
    const content = ev.result.content
    assert.equal(typeof content, "string", "content stays a string")
    assert.ok(content.startsWith(ORCHESTRATOR_POLICY), "the string is policy-prefixed")
    assert.ok(
      content.includes(String(contentBefore)),
      "the wrapper text is preserved between head and tail",
    )
    assert.ok(content.endsWith("\n" + status), "the per-delivery status tail is appended last")
    assert.equal(policyCountOf(content), 1, "the policy appears exactly once")
    assert.equal(ev.result.output, outRef, "the structured output object is object-identical")
    assert.equal(ev.result.output.output, "string content body", "its inner text is unmutated")
    const policies = journalEntries(metricsDir).filter((l) => l.type === "policy")
    assert.equal(policies.length, 1, "exactly one policy journal entry")
    assert.equal(policies[0]!.injected, true, "the entry reports injected:true")
    assert.equal(policies[0]!.sessionID, "p1", "keyed under the resolved parent")
  } finally {
    dispose()
  }
})

/** 25. Structured deliveries whose `content` is absent (or present but
 *  neither a string nor a block array) fall back to the structured output
 *  string: the host stringifies `output` into the transcript when
 *  `content` is absent, so the mutation there is model-visible; the policy
 *  still lands exactly once per delivery. */
test("injection: a structured delivery without block content mutates the output string instead", async () => {
  const { h, dispose, metricsDir } = await boot()
  try {
    // Absent content: the policy lands on the structured output string.
    const ev = structured("cA", "absent content body")
    delete ev.result.content
    await callTool(h, "execute.after", ev)
    assert.equal(
      ev.result.output.output,
      ORCHESTRATOR_POLICY + "\nabsent content body",
      "the output string is policy-prefixed",
    )
    assert.equal(ev.result.content, undefined, "content stays absent")
    // Repeat: the once-flag holds, so the fallback prepends exactly once.
    await callTool(h, "execute.after", ev)
    assert.equal(policyCountOf(ev.result.output.output), 1, "the fallback prepends exactly once")
    // Present-but-odd content: the same fallback, content left untouched.
    const ev2 = structured("cB", "odd content body")
    ev2.result.content = 42
    await callTool(h, "execute.after", ev2)
    assert.equal(
      ev2.result.output.output,
      ORCHESTRATOR_POLICY + "\nodd content body",
      "a non-block content falls back to the output string",
    )
    assert.equal(ev2.result.content, 42, "the odd content is left untouched")
    const policies = journalEntries(metricsDir).filter((l) => l.type === "policy")
    assert.equal(policies.length, 2, "one injected:true entry per delivery")
    assert.ok(
      policies.every((p) => p.injected === true),
      "both entries report injected:true",
    )
    assert.equal(
      policies[0]!.sessionID,
      "cA",
      "the unresolvable edge self-keys the entry (documented residual)",
    )
  } finally {
    dispose()
  }
})

/** 26. A marker-carrying structured delivery parses through the structured
 *  shape from the canonical `output.output` string: a verdict there credits
 *  the landing gate through the registered edge even when the content block
 *  the model reads carries a different, marker-less wrapper. */
test("injection: a structured marker parses from the canonical output string, not the content block", async () => {
  const { h, dispose, metricsDir } = await boot({ reviewEnsemble: "advise" })
  try {
    await resolveEdgeViaCreated(h, "cM", "p1", metricsDir)
    const ev = structured("cM", "VERDICT: APPROVE crit=0 high=0 med=0 low=0\nbody", "reviewer")
    // Decouple the content block from the canonical text: the block carries
    // no marker, only the canonical output string does.
    ev.result.content = [
      {
        type: "text",
        text: `<subagent sessionID="cM" state="completed">\nsummarized, marker-less\n</subagent>`,
      },
    ]
    await callTool(h, "execute.after", ev)
    const verdicts = journalEntries(metricsDir).filter((l) => l.type === "verdict")
    assert.equal(verdicts.length, 1, "the verdict in the canonical text is journaled")
    assert.equal(verdicts[0]!.sessionID, "p1", "keyed under the resolved parent")
    assert.equal(verdicts[0]!.raw, "cM", "raw is the real child")
    const ledger = createLedger(path.join(metricsDir, "turnstile.jsonl"))
    assert.equal(
      ledger.state("p1").hasReviewApprove,
      true,
      "the landing credit lands through the registered edge",
    )
    assert.equal(
      journalEntries(metricsDir).filter((l) => l.type === "violation").length,
      0,
      "the marker in the canonical text satisfies the bare check",
    )
  } finally {
    dispose()
  }
})

/** 27. The status tail is per-delivery, not once-per-task: a second delivery
 *  for the same parent re-appends the tail (naming the same successor) even
 *  though the policy head is not re-prepended (the once-flag holds). */
test("injection: the status tail lands on every delivery while the head is once-per-task", async () => {
  const { h, dispose, metricsDir } = await boot()
  try {
    const line =
      "PIPELINE: planner=done plan=PENDING tests=RED reviewer=0/2 next=plan-reviewer — dispatch the next agent in this same turn"
    const first = {
      tool: "task",
      sessionID: "p1",
      input: { agent: "planner", prompt: "run" },
      result: { output: "planner body" },
    }
    await callTool(h, "execute.after", first)
    assert.ok(
      String(first.result.output).startsWith(ORCHESTRATOR_POLICY),
      "the first delivery carries the head",
    )
    assert.ok(
      String(first.result.output).endsWith("\n" + line),
      "the first delivery carries the tail",
    )
    const second = {
      tool: "task",
      sessionID: "p1",
      input: { agent: "planner", prompt: "run" },
      result: { output: "planner body 2" },
    }
    await callTool(h, "execute.after", second)
    assert.equal(
      countPolicy(String(second.result.output)),
      0,
      "the once-flag holds: no head re-prepended on the second delivery",
    )
    assert.ok(
      String(second.result.output).endsWith("\n" + line),
      "but the per-delivery tail still lands",
    )
    assert.equal(
      journalEntries(metricsDir).filter((l) => l.type === "policy").length,
      1,
      "one policy journal entry for the once-per-task head",
    )
  } finally {
    dispose()
  }
})

/** 28. The status line routes successor and just-completed names through the
 *  configured agent values: a renamed executor stage is named by its
 *  configured value in both positions — as the successor of a red test-runner
 *  round and as the just-completed stage. */
test("injection: the status line names stages by their configured (renamed) values", async () => {
  const { h, dispose } = await boot({ agents: { executor: "implementer" } })
  try {
    const red = {
      tool: "task",
      sessionID: "p1",
      input: { agent: "test-runner", prompt: "test" },
      result: { output: "GATE: FAIL tests=3 passed=1 failed=2" },
    }
    await callTool(h, "execute.after", red)
    const redLine =
      "PIPELINE: test-runner=done plan=PENDING tests=RED reviewer=0/2 next=implementer — dispatch the next agent in this same turn"
    assert.ok(
      String(red.result.output).endsWith("\n" + redLine),
      "the renamed executor is the successor after a red round",
    )
    const build = {
      tool: "task",
      sessionID: "p1",
      input: { agent: "implementer", prompt: "build" },
      result: { output: "built it" },
    }
    await callTool(h, "execute.after", build)
    const buildLine =
      "PIPELINE: implementer=done plan=PENDING tests=RED reviewer=0/2 next=test-runner — dispatch the next agent in this same turn"
    assert.ok(
      String(build.result.output).endsWith("\n" + buildLine),
      "the renamed executor is named when it just completed",
    )
  } finally {
    dispose()
  }
})

/** 29. A non-pipeline stage agent (the debugger) renders an empty status line
 *  and gets no tail: the delivery is byte-identical to the head-only path. */
test("injection: a non-pipeline stage agent gets no status tail (byte-identical head-only)", async () => {
  const { h, dispose } = await boot()
  try {
    const ev = {
      tool: "task",
      sessionID: "p1",
      input: { agent: "debugger", prompt: "debug" },
      result: { output: "debugged" },
    }
    await callTool(h, "execute.after", ev)
    // The byte-identical expectation (head only, no status tail) is the
    // assertion: a tail would extend the string past the head + body.
    assert.equal(
      String(ev.result.output),
      ORCHESTRATOR_POLICY + "\n" + "debugged",
      "the head lands and no tail follows a non-pipeline agent",
    )
  } finally {
    dispose()
  }
})

/** 30. An unclassifiable result journals loudly on EVERY delivery, even once
 *  the policy head has landed and set the once-flag: the unknown-shape journal
 *  is per-delivery, not gated by the once-flag. */
test("injection: unknown-shape deliveries journal loudly even after the once-flag is set", async () => {
  const { h, dispose, metricsDir } = await boot()
  try {
    // A successful delivery lands the head and sets the once-flag for p1.
    const ok = {
      tool: "task",
      sessionID: "p1",
      input: { agent: "planner", prompt: "run" },
      result: { output: "planner body" },
    }
    await callTool(h, "execute.after", ok)
    // Two following unclassifiable deliveries for the same parent each journal.
    const unknown = () => ({
      tool: "task",
      sessionID: "p1",
      input: { agent: "planner", prompt: "run" },
      result: { output: 42 },
    })
    await callTool(h, "execute.after", unknown())
    await callTool(h, "execute.after", unknown())
    const unknownEntries = journalEntries(metricsDir).filter(
      (l) => l.type === "policy" && l.reason === "unknown-shape",
    )
    assert.equal(
      unknownEntries.length,
      2,
      "each unclassifiable delivery journals, even after the once-flag is set",
    )
  } finally {
    dispose()
  }
})

/** 31. A throwing status-tail mutation fails open: the append journals a
 *  pipeline-status error and never rethrows, and the independent policy-head
 *  prepend still lands. */
test("injection: a hostile append mutation journals a pipeline-status error and the head still lands", async () => {
  const { h, dispose, metricsDir } = await boot()
  try {
    const ev = {
      tool: "task",
      sessionID: "p1",
      input: { agent: "planner", prompt: "run" },
      result: { output: "planner body" },
    }
    let backing = "planner body"
    Object.defineProperty(ev.result, "output", {
      configurable: true,
      get: () => backing,
      set: (v: unknown) => {
        // Throw only on the appended tail (a newline before the PIPELINE:
        // label): the prepended head embeds the word in-prose, not on its own
        // line, so the head still lands.
        if (typeof v === "string" && v.includes("\nPIPELINE: ")) throw new Error("hostile tail")
        backing = String(v)
      },
    })
    await callTool(h, "execute.after", ev)
    assert.equal(
      String(ev.result.output),
      ORCHESTRATOR_POLICY + "\n" + "planner body",
      "the head landed; the hostile tail did not",
    )
    const statusErr = journalEntries(metricsDir).filter(
      (l) => l.type === "error" && String(l.error).startsWith("pipeline-status:"),
    )
    assert.equal(statusErr.length, 1, "the append failure journaled a pipeline-status error")
    const policies = journalEntries(metricsDir).filter((l) => l.type === "policy")
    assert.equal(policies.length, 1, "the head still journaled exactly one policy entry")
    assert.equal(policies[0]!.injected, true, "the policy head is recorded as landed")
  } finally {
    dispose()
  }
})

/** 32. A hostile string-shape output that ceases to be a string between
 *  classification and mutation: the mutation's re-read falls back to the text
 *  captured at classification time, and the head and tail still compose onto
 *  it — fail-open, no throw, no pipeline-status error. */
test("injection: a string-shape output that ceases to be a string re-reads the classified text", async () => {
  const { h, dispose } = await boot()
  try {
    const tail =
      "PIPELINE: planner=done plan=PENDING tests=RED reviewer=0/2 next=plan-reviewer — dispatch the next agent in this same turn"
    const ev = {
      tool: "task",
      sessionID: "p1",
      input: { agent: "planner", prompt: "run" },
      result: { output: "planner body" },
    }
    let reads = 0
    let backing = "planner body"
    Object.defineProperty(ev.result, "output", {
      configurable: true,
      get: () => {
        reads++
        // Classification reads the field twice (the typeof check, then the
        // captured text); the append's re-read (the third) sees a non-string
        // and takes the classified-text fallback; later reads see the
        // mutated backing.
        if (reads <= 2) return "planner body"
        if (reads === 3) return 42
        return backing
      },
      set: (v: unknown) => {
        backing = v as string
      },
    })
    await callTool(h, "execute.after", ev)
    assert.equal(
      String(ev.result.output),
      ORCHESTRATOR_POLICY + "\n" + "planner body\n" + tail,
      "the head and tail compose on the classified text, not the garbage re-read",
    )
  } finally {
    dispose()
  }
})

/** 33. A hostile structured output (absent `content`) whose canonical
 *  `output.output` ceases to be a string between classification and mutation:
 *  the mutation's re-read falls back to the classified text, and the head and
 *  tail still compose onto it — fail-open, no throw, no pipeline-status error. */
test("injection: a structured output that ceases to be a string re-reads the classified text", async () => {
  const { h, dispose } = await boot()
  try {
    const tail =
      "PIPELINE: planner=done plan=PENDING tests=RED reviewer=0/2 next=plan-reviewer — dispatch the next agent in this same turn"
    const ev = {
      tool: "subagent",
      sessionID: "p1",
      input: { agent: "planner", prompt: "run" },
      result: {
        output: { sessionID: "c1", status: "completed", output: "planner body" },
        metadata: { sessionID: "c1", status: "completed" },
      },
    }
    let reads = 0
    let backing = "planner body"
    Object.defineProperty(ev.result.output, "output", {
      configurable: true,
      get: () => {
        reads++
        // Classification reads the field twice (the typeof check, then the
        // captured text); the append's re-read (the third) sees a non-string
        // and takes the classified-text fallback; later reads see the
        // mutated backing.
        if (reads <= 2) return "planner body"
        if (reads === 3) return 42
        return backing
      },
      set: (v: unknown) => {
        backing = v as string
      },
    })
    await callTool(h, "execute.after", ev)
    assert.equal(
      String(ev.result.output.output),
      ORCHESTRATOR_POLICY + "\n" + "planner body\n" + tail,
      "the head and tail compose on the classified text, not the garbage re-read",
    )
  } finally {
    dispose()
  }
})
