/**
 * @fileoverview Marker-retry tests: the bounded compliance re-prompt for
 * bare-output deliveries — prompted, exhausted, disabled, skipped-no-api,
 * prompt-throws, uncontracted agents, and plan-reviewer streamed-verdict
 * suppression — via a fake host with injected config.
 */

import { test } from "node:test"
import assert from "node:assert/strict"

import { turnstile } from "../turnstile.ts"
import { markerRetryPrompt } from "../src/markers/markers.ts"
import {
  callTool,
  isolatedEnv,
  journalEntries,
  makeFakeHost,
  tmpDir,
  waitUntil,
  type FakeHost,
} from "./helpers.ts"

/** Boots the plugin over a fake host with a temp metrics dir and optional
 *  config/host overrides for the retry scenarios. */
async function boot(
  config: Record<string, any> = {},
  hostOpts: Parameters<typeof makeFakeHost>[0] = {},
): Promise<{ h: FakeHost; dispose: () => void; metricsDir: string }> {
  const metricsDir = tmpDir()
  const h = makeFakeHost(hostOpts)
  const setup = turnstile(h.host, {
    env: isolatedEnv(metricsDir),
    config: { metricsDir, ...config },
  })
  const dispose = (await setup(h.host)) as () => void
  return { h, dispose, metricsDir }
}

/** Delivers one marker-less task result from the given agent; the event's
 *  sessionID doubles as the child session ID (string delivery shape). */
async function deliverBare(h: FakeHost, agent: string, child: string): Promise<void> {
  await callTool(h, "execute.after", {
    tool: "task",
    sessionID: child,
    input: { agent },
    result: { output: "ran, no marker" },
  })
}

/** A marker-less delivery from a bareOutput agent with retries remaining
 *  journals one prompted marker-retry row, sends the reminder to the same
 *  child via session.prompt, and journals no violation. */
test("retry fires once and prompts the child", async () => {
  const { h, dispose, metricsDir } = await boot()
  try {
    await deliverBare(h, "test-runner", "c1")
    const retries = journalEntries(metricsDir).filter((l) => l.type === "marker-retry")
    assert.equal(retries.length, 1)
    assert.equal(retries[0]!.outcome, "prompted")
    assert.equal(retries[0]!.attempt, 0)
    assert.equal(retries[0]!.sessionID, "c1")
    assert.equal(h.sessionPrompts.length, 1)
    assert.equal(h.sessionPrompts[0]!.sessionID, "c1")
    assert.match(h.sessionPrompts[0]!.text, /GATE: PASS tests=3 passed=3 failed=0/)
    assert.doesNotMatch(h.sessionPrompts[0]!.text, /VERDICT:/)
    assert.match(h.sessionPrompts[0]!.text, /received and parsed/)
    assert.match(h.sessionPrompts[0]!.text, /Do not start new work/)
    assert.doesNotMatch(h.sessionPrompts[0]!.text, /Do not run any tools/)
    assert.match(h.sessionPrompts[0]!.text, /never invent or estimate counts/)
    assert.ok(journalEntries(metricsDir).every((l) => l.type !== "violation"))
  } finally {
    dispose()
  }
})

/** A reviewer's bare delivery gets the VERDICT example only, plus the
 *  "received and parsed" guidance and the quoted tail of its own output. */
test("retry prompt tells the reviewer its analysis is complete and quotes the tail", async () => {
  const { h, dispose } = await boot()
  try {
    await callTool(h, "execute.after", {
      tool: "task",
      sessionID: "c1",
      input: { agent: "reviewer" },
      result: { output: "review done. verdict: approve" },
    })
    const p = h.sessionPrompts[0]!
    assert.match(p.text, /VERDICT: APPROVE crit=0 high=0 med=0 low=0/)
    assert.doesNotMatch(p.text, /GATE:/)
    assert.match(p.text, /Do not start new work/)
    assert.match(p.text, /verdict: approve/)
  } finally {
    dispose()
  }
})

/** A bareOutput agent outside the known roles gets both marker examples
 *  in the retry prompt. */
test("retry prompt for an unknown bareOutput agent shows both examples", async () => {
  const { h, dispose } = await boot({ agents: { bareOutput: ["custom"] } })
  try {
    await deliverBare(h, "custom", "c1")
    const p = h.sessionPrompts[0]!
    assert.match(p.text, /GATE: PASS tests=3 passed=3 failed=0/)
    assert.match(p.text, /VERDICT: APPROVE crit=0 high=0 med=0 low=0/)
  } finally {
    dispose()
  }
})

/** A whitespace-only prior output trims to an empty tail, so the retry
 *  prompt omits the quoted-tail block (no code fence). The fixture relies
 *  on bare-output classification accepting any non-empty string. */
test("retry prompt omits the tail block when the prior output trims empty", async () => {
  const { h, dispose } = await boot()
  try {
    await callTool(h, "execute.after", {
      tool: "task",
      sessionID: "c1",
      input: { agent: "test-runner" },
      result: { output: "   " },
    })
    assert.doesNotMatch(h.sessionPrompts[0]!.text, /```/)
  } finally {
    dispose()
  }
})

/** A prior output longer than the tail cap quotes only its last 600
 *  characters in the retry prompt. */
test("retry prompt quotes only the tail of a long prior output", async () => {
  const { h, dispose } = await boot()
  try {
    const long = "x".repeat(700) + "final conclusion"
    await callTool(h, "execute.after", {
      tool: "task",
      sessionID: "c1",
      input: { agent: "test-runner" },
      result: { output: long },
    })
    const p = h.sessionPrompts[0]!
    assert.match(p.text, /final conclusion/)
    assert.ok(!p.text.includes("x".repeat(601)))
  } finally {
    dispose()
  }
})

/** A second marker-less delivery from the same child journals the exhausted
 *  outcome and the unchanged violation row with the unchanged reason. */
test("retry exhausted counts a violation", async () => {
  const { h, dispose, metricsDir } = await boot()
  try {
    await deliverBare(h, "reviewer", "c1")
    await deliverBare(h, "reviewer", "c1")
    const entries = journalEntries(metricsDir)
    assert.equal(
      entries.filter((l) => l.type === "marker-retry" && l.outcome === "prompted").length,
      1,
    )
    const exhausted = entries.filter((l) => l.type === "marker-retry" && l.outcome === "exhausted")
    assert.equal(exhausted.length, 1)
    assert.equal(exhausted[0]!.attempt, 1)
    const violations = entries.filter((l) => l.type === "violation")
    assert.equal(violations.length, 1)
    assert.equal(violations[0]!.reason, "task output contained no GATE/VERDICT marker")
    assert.equal(violations[0]!.sessionID, "c1")
  } finally {
    dispose()
  }
})

/** agentMarkerRetry: 0 disables the retry entirely: no marker-retry row,
 *  and the first bare delivery violates immediately. */
test("retry disabled by config", async () => {
  const { h, dispose, metricsDir } = await boot({ agentMarkerRetry: 0 })
  try {
    await deliverBare(h, "reviewer", "c1")
    const entries = journalEntries(metricsDir)
    assert.ok(!entries.some((l) => l.type === "marker-retry"))
    assert.equal(h.sessionPrompts.length, 0)
    assert.equal(entries.filter((l) => l.type === "violation").length, 1)
  } finally {
    dispose()
  }
})

/** A host without session.prompt journals skipped-no-api and the delivery
 *  still counts a violation (fail-open, degraded host). */
test("retry skips when the host lacks session.prompt", async () => {
  const { h, dispose, metricsDir } = await boot({}, { sessionPrompt: false })
  try {
    await deliverBare(h, "reviewer", "c1")
    const entries = journalEntries(metricsDir)
    const skipped = entries.filter((l) => l.type === "marker-retry")
    assert.equal(skipped.length, 1)
    assert.equal(skipped[0]!.outcome, "skipped-no-api")
    assert.equal(entries.filter((l) => l.type === "violation").length, 1)
  } finally {
    dispose()
  }
})

/** A rejecting session.prompt journals a type:"error" row and the delivery
 *  still counts a violation; nothing throws from the hook. */
test("a failed retry prompt fails open and counts a violation", async () => {
  const { h, dispose, metricsDir } = await boot({}, { sessionPromptReject: true })
  try {
    await deliverBare(h, "reviewer", "c1")
    const entries = journalEntries(metricsDir)
    assert.equal(
      entries.filter((l) => l.type === "marker-retry" && l.outcome === "prompted").length,
      1,
    )
    assert.ok(entries.some((l) => l.type === "error" && String(l.error).includes("marker-retry")))
    assert.equal(entries.filter((l) => l.type === "violation").length, 1)
  } finally {
    dispose()
  }
})

/** A prior output whose tail carries GATE/VERDICT marker lines has them
 *  stripped from the quoted tail: the prompt never repeats a marker line
 *  (or its counts), so it cannot read as a pre-supplied marker. Unit-level:
 *  the bare-output path never delivers a marker-bearing tail (a marker-bearing
 *  delivery is not bare), so the stripping arms are only reachable here. */
test("retry prompt never quotes a marker line from the prior output", () => {
  const agents = {
    testRunner: "test-runner",
    reviewer: "reviewer",
    planReviewer: "plan-reviewer",
  } as never
  const prompt = markerRetryPrompt(
    agents,
    "test-runner",
    /^\s*[`>#*\s]*GATE: (PASS|FAIL) tests=\d+ passed=\d+ failed=\d+/gm,
    /^\s*[`>#*\s]*VERDICT: (APPROVE|BLOCK) crit=\d+ high=\d+ med=\d+ low=\d+/gm,
    "GATE: PASS tests=9 passed=9 failed=0\nanalysis of the run\nVERDICT: APPROVE crit=1 high=0 med=0 low=0",
  )
  assert.match(prompt, /analysis of the run/)
  assert.doesNotMatch(prompt, /tests=9/)
  assert.doesNotMatch(prompt, /crit=1/)
})

/** A prior output that is ONLY marker lines strips to an empty tail, so the
 *  quoted-tail block is omitted entirely. */
test("retry prompt omits the tail block when only marker lines remain", () => {
  const agents = { testRunner: "test-runner" } as never
  const prompt = markerRetryPrompt(
    agents,
    "test-runner",
    /^\s*[`>#*\s]*GATE: (PASS|FAIL) tests=\d+ passed=\d+ failed=\d+/gm,
    /^\s*[`>#*\s]*VERDICT: (APPROVE|BLOCK) crit=\d+ high=\d+ med=\d+ low=\d+/gm,
    "GATE: PASS tests=9 passed=9 failed=0",
  )
  assert.doesNotMatch(prompt, /```/)
})

/** The prompted marker-retry row carries textHash: the sha256-16 of the
 *  exact retry prompt text sent to the child (injection provenance). */
test("prompted marker-retry row carries the injected text hash", async () => {
  const { h, dispose, metricsDir } = await boot()
  try {
    await deliverBare(h, "test-runner", "c1")
    const row = journalEntries(metricsDir).find((l) => l.type === "marker-retry")
    assert.equal(row!.outcome, "prompted")
    assert.match(String(row!.textHash), /^[0-9a-f]{16}$/)
  } finally {
    dispose()
  }
})

/** A marker-less delivery from an agent outside bareOutput journals neither
 *  a marker-retry row nor a violation. */
test("retry never fires for marker-uncontracted agents", async () => {
  const { h, dispose, metricsDir } = await boot()
  try {
    await deliverBare(h, "planner", "c1")
    const entries = journalEntries(metricsDir)
    assert.ok(!entries.some((l) => l.type === "marker-retry"))
    assert.ok(!entries.some((l) => l.type === "violation"))
    assert.equal(h.sessionPrompts.length, 0)
  } finally {
    dispose()
  }
})

/** The plan-reviewer streamed-verdict suppression survives the retry path:
 *  a streamed child verdict hides a summarized marker-less delivery, so no
 *  retry and no violation fire. */
test("plan-reviewer suppression survives the retry path", async () => {
  const { h, dispose, metricsDir } = await boot()
  try {
    // Seed the edge and the emitter agent, then stream the child's verdict
    // before the delivery arrives (same seeding pattern as the injection
    // suppression regression).
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
    await callTool(h, "execute.after", {
      tool: "task",
      sessionID: "p1",
      input: { agent: "plan-reviewer" },
      result: {
        output: { status: "completed", summary: "summarized, marker-less" },
        metadata: { sessionID: "c1", agent: "plan-reviewer" },
      },
    })
    const entries = journalEntries(metricsDir)
    assert.ok(!entries.some((l) => l.type === "marker-retry"))
    assert.ok(!entries.some((l) => l.type === "violation"))
    assert.equal(h.sessionPrompts.length, 0)
  } finally {
    dispose()
  }
})

/** The incident shape (issue #376): a parent-keyed string delivery whose
 *  metadata names the child — the parent-side background-subagent
 *  acknowledgment — is parent-authored, so no retry, no prompt, no violation. */
test("parent-keyed string delivery is never treated as child output", async () => {
  const { h, dispose, metricsDir } = await boot()
  try {
    await callTool(h, "execute.after", {
      tool: "task",
      sessionID: "p1",
      input: { agent: "test-runner" },
      result: {
        output:
          "The subagent is working in the background " +
          "(sessionID: ses_child123). You will receive a <subagent> message.",
        metadata: { sessionID: "ses_child123" },
      },
    })
    assert.equal(h.sessionPrompts.length, 0)
    assert.ok(!journalEntries(metricsDir).some((l) => l.type === "marker-retry"))
    assert.ok(!journalEntries(metricsDir).some((l) => l.type === "violation"))
  } finally {
    dispose()
  }
})

/** Any parent-keyed string delivery is parent-authored regardless of wording:
 *  the event origin, not the text, decides the classification. */
test("any parent-keyed string delivery is parent-authored regardless of wording", async () => {
  const { h, dispose, metricsDir } = await boot()
  try {
    await callTool(h, "execute.after", {
      tool: "task",
      sessionID: "p1",
      input: { agent: "test-runner" },
      result: {
        output: "accepted for background execution",
        metadata: { sessionID: "ses_child123" },
      },
    })
    assert.equal(h.sessionPrompts.length, 0)
    assert.ok(!journalEntries(metricsDir).some((l) => l.type === "marker-retry"))
  } finally {
    dispose()
  }
})

/** A child-keyed event whose metadata child matches the origin stays on the
 *  string path: the bare-output retry still fires. */
test("child-keyed delivery with matching metadata still classifies as child output", async () => {
  const { h, dispose } = await boot()
  try {
    await callTool(h, "execute.after", {
      tool: "task",
      sessionID: "c1",
      input: { agent: "test-runner" },
      result: { output: "ran, no marker", metadata: { sessionID: "c1" } },
    })
    assert.equal(h.sessionPrompts.length, 1)
  } finally {
    dispose()
  }
})

/** The `origin !== ""` guard: an event with no sessionID but a metadata child
 *  (the supported metadataChildOf fallback shape) stays on the string path
 *  and the retry still fires. */
test("empty-origin delivery with a metadata child still classifies as child output", async () => {
  const { h, dispose, metricsDir } = await boot()
  try {
    await callTool(h, "execute.after", {
      tool: "task",
      input: { agent: "test-runner" },
      result: { output: "ran, no marker", metadata: { sessionID: "c1" } },
    })
    assert.equal(h.sessionPrompts.length, 1)
    assert.ok(!journalEntries(metricsDir).some((l) => l.type === "violation"))
  } finally {
    dispose()
  }
})

/** Unit assertions on classifyDelivery's origin rule: the incident payload is
 *  parent-authored with empty text; child-keyed and empty-origin payloads
 *  stay on the string path. */
test("classifyDelivery applies the origin rule", async () => {
  const { classifyDelivery } = await import("../src/hooks/delivery.ts")
  const incident = classifyDelivery({
    tool: "task",
    sessionID: "p1",
    input: { agent: "test-runner" },
    result: {
      output: "The subagent is working in the background (sessionID: ses_child123).",
      metadata: { sessionID: "ses_child123" },
    },
  } as any)
  assert.equal(incident.kind, "parent-authored")
  assert.equal(incident.text, "")
  assert.equal(incident.child, "ses_child123")
  const childKeyed = classifyDelivery({
    tool: "task",
    sessionID: "c1",
    input: { agent: "test-runner" },
    result: { output: "ran, no marker" },
  } as any)
  assert.equal(childKeyed.kind, "string")
  const emptyOrigin = classifyDelivery({
    tool: "task",
    input: { agent: "test-runner" },
    result: { output: "ran, no marker", metadata: { sessionID: "c1" } },
  } as any)
  assert.equal(emptyOrigin.kind, "string")
  assert.equal(emptyOrigin.child, "c1")
})
