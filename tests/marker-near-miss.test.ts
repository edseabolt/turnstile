/**
 * @fileoverview Near-miss marker diagnostics: a user prompt that mistypes the
 * exact waiver/approval literals (separator, case, or colon variant) admits
 * nothing — the strict `indexOf` capture is byte-identical — but is journaled
 * as a `marker`/`near-miss` entry and surfaced once as a `[turnstile]
 * marker:` block on the session's next string tool output, naming the exact
 * expected literal. The unit tests pin the pure scan/format boundary; the
 * integration tests pin the prompt-hook and inbox transports, the once-per-
 * prompt-batch surface, the reset-latch drop, the bounded pending map, and
 * the fail-open paths (hostile text getter, hostile frozen result). The
 * redaction test pins that the journal carries only the matched token and
 * the configured literal, never the prompt text, under both trace settings.
 */

import { test } from "node:test"
import assert from "node:assert/strict"
import * as fs from "node:fs"
import * as path from "node:path"

import { turnstile } from "../turnstile.ts"
import { findMarkerNearMisses, formatNearMissDiagnostics } from "../src/markers.ts"
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

/** The default waiver/approval literals (from the config defaults). */
const WAIVER = "USER WAIVER:"
const APPROVAL = "PLAN APPROVED:"

/** The exact reviewer gate no-gate-pass block message. */
const NO_GATE_MESSAGE =
  "BLOCKED by turnstile: no reviewer dispatch before the test gate is green. " +
  "Run the test-runner subagent first; dispatch reviewer only after its first line is " +
  "`GATE: PASS tests=<n> passed=<n> failed=<n>`, or obtain an explicit user waiver " +
  "(a user prompt this task must contain the literal marker 'USER WAIVER:' followed by the user's words)."

/** The exact plan gate no-approval block message for a plan named plan.md. */
const PLAN_GATE_MESSAGE =
  `BLOCKED by turnstile: no plan approval for "plan.md". Dispatch the plan-reviewer subagent first; proceed with executor only after the plan-reviewer's first line is ` +
  "`VERDICT: APPROVE crit=<n> high=<n> med=<n> low=<n>`, or obtain an explicit user waiver " +
  "(a user prompt this task must contain the literal marker 'USER WAIVER:' followed by the user's words)."

/** A `session.inbox.enqueued` admission envelope. */
type InboxEnvelope = {
  sessionID: string
  inboxID: string
  item: { type: string; payload: { text: string; delivery?: string } }
}

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

/** Boots in a temp project dir containing a plan file so dispatches are gated. */
async function bootWithPlan(): Promise<{
  h: FakeHost
  dispose: () => void
  metricsDir: string
  project: string
  restore: () => void
}> {
  const project = tmpDir()
  fs.mkdirSync(path.join(project, ".opencode", "plans"), { recursive: true })
  fs.writeFileSync(path.join(project, ".opencode", "plans", "plan.md"), "# P\n")
  const metricsDir = tmpDir()
  const h = makeFakeHost()
  const prev = process.cwd()
  process.chdir(project)
  const setup = turnstile(h.host, {
    env: isolatedEnv(metricsDir),
    config: { metricsDir },
  })
  const dispose = (await setup(h.host)) as () => void
  return {
    h,
    dispose,
    metricsDir,
    project,
    restore: (): void => {
      dispose()
      process.chdir(prev)
    },
  }
}

/**
 * Pushes a `session.inbox.enqueued` admission and a canary stream event, then
 * waits for the canary verdict — which confirms the async event-consumer has
 * drained the queue up to and including the admission (FIFO).
 * @param h The fake host tables.
 * @param data The inbox admission envelope.
 * @param metricsDir The metrics dir to poll the journal in.
 */
async function pushAdmission(h: FakeHost, data: InboxEnvelope, metricsDir: string): Promise<void> {
  h.pushEvent({ type: "session.inbox.enqueued", data })
  h.pushEvent({
    type: "session.text.ended",
    data: {
      sessionID: `drain:${data.inboxID}`,
      text: "VERDICT: APPROVE crit=0 high=0 med=0 low=0",
    },
  })
  // The canary's verdict is journaled (as `verdict` when the drain session is
  // authoritative, or `suppressed` when it is not); either way its raw carries
  // the drain id once the async consumer has drained the queue up to it.
  await waitUntil(() =>
    journalEntries(metricsDir).some((l) => typeof l.raw === "string" && l.raw.startsWith("drain:")),
  )
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

/** The `marker` near-miss entries in a journal, projected to the contract
 *  fields (the journaler stamps every entry with a timestamp too). */
function nearMissFields(metricsDir: string): Array<Record<string, any>> {
  return journalEntries(metricsDir)
    .filter((l) => l.type === "marker" && l.event === "near-miss")
    .map(({ event, sessionID, found, literal }) => ({ event, sessionID, found, literal }))
}

/** The `marker` surfaced entries in a journal. */
function surfacedEntries(metricsDir: string): Array<Record<string, any>> {
  return journalEntries(metricsDir).filter((l) => l.type === "marker" && l.event === "surfaced")
}

// ---------------------------------------------------------------------------
// Unit: the pure scan + format boundary
// ---------------------------------------------------------------------------

/** The scanner flags separator, case, and colon variants of the waiver
 *  literal — each with the exact `found` token, the gate label, and the
 *  configured literal, in first-seen order. A colon-suffixed form of the
 *  exact literal is NOT a near miss: it contains the literal verbatim and
 *  the exact-match capture admits it, so the scan stays silent. */
test("near-miss scan flags separator, case, and colon variants of the waiver literal", () => {
  const hits = findMarkerNearMisses("USER_WAIVER: user waiver: USER WAIVER", [
    { literal: WAIVER, label: "waiver" },
  ])
  assert.deepEqual(hits, [
    { found: "USER_WAIVER:", label: "waiver", literal: WAIVER },
    { found: "user waiver:", label: "waiver", literal: WAIVER },
    { found: "USER WAIVER", label: "waiver", literal: WAIVER },
  ])
})

/** The exact literal silences the scan for that marker: a verbatim literal
 *  (including a colon-suffixed form) admits on the strict path and is not
 *  flagged; a sibling literal's near miss in the same text is still found. */
test("near-miss scan is silenced for a literal present verbatim in the text", () => {
  assert.deepEqual(
    findMarkerNearMisses("USER WAIVER: proceed", [{ literal: WAIVER, label: "waiver" }]),
    [],
  )
  assert.deepEqual(
    findMarkerNearMisses("USER WAIVER:: proceed", [{ literal: WAIVER, label: "waiver" }]),
    [],
  )
  const mixed = findMarkerNearMisses("USER WAIVER: go, though PLAN_APPROVED: too", [
    { literal: WAIVER, label: "waiver" },
    { literal: APPROVAL, label: "plan approval" },
  ])
  assert.deepEqual(mixed, [{ found: "PLAN_APPROVED:", label: "plan approval", literal: APPROVAL }])
})

/** A near miss inside a longer sentence is still flagged; a substring inside
 *  a longer word is not (word-boundary guards); empty text and an empty
 *  (whitespace) literal are skipped defensively. */
test("near-miss scan flags sentence-embedded variants and rejects word substrings", () => {
  const flagged = findMarkerNearMisses("please issue USER_WAIVER: before we ship", [
    { literal: WAIVER, label: "waiver" },
  ])
  assert.deepEqual(flagged, [{ found: "USER_WAIVER:", label: "waiver", literal: WAIVER }])
  assert.deepEqual(
    findMarkerNearMisses("MYUSER_WAIVER: nothing here", [{ literal: WAIVER, label: "waiver" }]),
    [],
  )
  assert.deepEqual(findMarkerNearMisses("", [{ literal: WAIVER, label: "waiver" }]), [])
  assert.deepEqual(findMarkerNearMisses("USER_WAIVER:", [{ literal: "   ", label: "waiver" }]), [])
  // A colon-only literal has no word core: it is skipped defensively.
  assert.deepEqual(findMarkerNearMisses("USER_WAIVER:", [{ literal: "::", label: "waiver" }]), [])
})

/** Repeated identical variants dedupe to one hit; distinct variants beyond
 *  the per-literal cap are truncated (default cap 3, explicit cap honored). */
test("near-miss scan dedupes repeats and caps distinct variants per literal", () => {
  assert.deepEqual(
    findMarkerNearMisses("USER_WAIVER: again USER_WAIVER:", [{ literal: WAIVER, label: "waiver" }]),
    [{ found: "USER_WAIVER:", label: "waiver", literal: WAIVER }],
  )
  const five = "USER_WAIVER: user waiver: USER WAIVER user waiver USER  WAIVER:"
  assert.equal(
    findMarkerNearMisses(five, [{ literal: WAIVER, label: "waiver" }]).length,
    3,
    "the default per-literal cap is 3",
  )
  assert.equal(
    findMarkerNearMisses(five, [{ literal: WAIVER, label: "waiver" }], 5).length,
    5,
    "an explicit cap is honored",
  )
})

/** A custom configured literal scans identically to the defaults (separator
 *  and case variants), so a user-customized marker gets the same diagnostics
 *  without any per-literal code. */
test("near-miss scan covers custom configured literals", () => {
  const hits = findMarkerNearMisses("bypass_gate: now, and BYPASS GATE again", [
    { literal: "BYPASS GATE:", label: "waiver" },
  ])
  assert.deepEqual(hits, [
    { found: "bypass_gate:", label: "waiver", literal: "BYPASS GATE:" },
    { found: "BYPASS GATE", label: "waiver", literal: "BYPASS GATE:" },
  ])
})

/** The renderer emits the exact header (count + journal path), one `- ` line
 *  per hit naming the found token and the exact literal, and a truncation
 *  tail only when hits exceed maxLines. */
test("near-miss renderer pins the header, hit lines, and truncation tail", () => {
  const one = formatNearMissDiagnostics(
    [{ found: "USER_WAIVER:", label: "waiver", literal: WAIVER }],
    "/tmp/journal.jsonl",
  )
  assert.equal(
    one,
    `[turnstile] marker: 1 near-miss marker(s) — the strict literal is required (journal: /tmp/journal.jsonl):\n` +
      `- found "USER_WAIVER:" — the waiver marker is "USER WAIVER:" (exact string)`,
  )
  const four = Array.from({ length: 4 }, (_, i) => ({
    found: `FOUND${i}`,
    label: "waiver",
    literal: WAIVER,
  }))
  const truncated = formatNearMissDiagnostics(four, "/tmp/journal.jsonl")
  assert.ok(truncated.startsWith("[turnstile] marker: 4 near-miss marker(s)"))
  assert.ok(
    truncated.includes(`- found "FOUND0" — the waiver marker is "USER WAIVER:" (exact string)`),
  )
  assert.ok(!truncated.includes(`- found "FOUND3"`), "the fourth hit line is hidden")
  assert.ok(truncated.endsWith("\n(1 more; see the journal)"))
  const untruncated = formatNearMissDiagnostics(four, "/tmp/journal.jsonl", 10)
  assert.ok(untruncated.includes(`- found "FOUND3"`), "an explicit cap shows all hits")
  assert.ok(!untruncated.includes("more; see the journal"), "no tail under the cap")
})

// ---------------------------------------------------------------------------
// Integration: prompt transports, surfacing, bounds, fail-open, redaction
// ---------------------------------------------------------------------------

/** A separator-variant waiver prompt admits no waiver and journals exactly
 *  one near-miss entry; the reviewer dispatch still blocks with the
 *  byte-identical no-gate message (strict match preserved). */
test("a near-miss waiver prompt journals the hit, admits no waiver, and blocks identically", async () => {
  const { h, dispose, metricsDir } = await boot()
  try {
    await callSession(h, "prompt", {
      sessionID: "p1",
      text: "USER_WAIVER: allow the second reviewer. I approve",
    })
    assert.deepEqual(nearMissFields(metricsDir), [
      { event: "near-miss", sessionID: "p1", found: "USER_WAIVER:", literal: WAIVER },
    ])
    const entries = journalEntries(metricsDir)
    assert.ok(!entries.some((l) => l.type === "gate" && l.result === "PASS"), "no gate pass")
    assert.ok(!entries.some((l) => l.type === "plan"), "no plan approval")
    await assert.rejects(
      () =>
        callTool(h, "execute.before", {
          tool: "task",
          sessionID: "p1",
          input: { agent: "reviewer", prompt: "review it" },
        }),
      (e: Error) => e.message === NO_GATE_MESSAGE,
    )
  } finally {
    dispose()
  }
})

/** The diagnostic surfaces exactly once on the next STRING tool output: a
 *  non-string delivery leaves it pending, the block is prepended with the
 *  exact format, the original output is preserved, a second delivery is
 *  untouched, and one surfaced:true entry is journaled. */
test("the near-miss diagnostic surfaces once on the next string tool output", async () => {
  const { h, dispose, metricsDir } = await boot()
  try {
    await callSession(h, "prompt", { sessionID: "p1", text: "USER_WAIVER: allow everything" })
    // A non-string output cannot carry the block: it is left untouched and
    // the pending diagnostic retries on the next string output.
    const nonString = { tool: "read", sessionID: "p1", result: { output: 42 } }
    await callTool(h, "execute.after", nonString)
    assert.equal(nonString.result.output, 42, "a non-string result is untouched")
    assert.deepEqual(surfacedEntries(metricsDir), [], "nothing surfaces on a non-string output")
    const first = { tool: "read", sessionID: "p1", result: { output: "FILE" } }
    await callTool(h, "execute.after", first)
    const out = String(first.result.output)
    assert.ok(out.startsWith("[turnstile] marker: 1 near-miss marker(s)"))
    assert.ok(
      out.includes(`- found "USER_WAIVER:" — the waiver marker is "USER WAIVER:" (exact string)`),
    )
    assert.ok(out.endsWith("FILE"), "the original output is preserved")
    const surfaced = surfacedEntries(metricsDir)
    assert.equal(surfaced.length, 1, "one surfaced audit entry")
    assert.equal(surfaced[0]!.sessionID, "p1")
    assert.equal(surfaced[0]!.surfaced, true)
    assert.equal(surfaced[0]!.count, 1)
    const second = { tool: "read", sessionID: "p1", result: { output: "OTHER" } }
    await callTool(h, "execute.after", second)
    assert.equal(String(second.result.output), "OTHER", "the pending entry is consumed")
  } finally {
    dispose()
  }
})

/** A separator-variant approval prompt leaves the plan gate red: the
 *  executor dispatch blocks with the byte-identical plan message, the near
 *  miss names the approval literal, and the surfaced block says so. */
test("an approval near miss leaves the plan gate red and names the approval literal", async () => {
  const { h, metricsDir, restore } = await bootWithPlan()
  try {
    await callSession(h, "prompt", { sessionID: "p1", text: "PLAN_APPROVED: execute the plan" })
    assert.deepEqual(nearMissFields(metricsDir), [
      { event: "near-miss", sessionID: "p1", found: "PLAN_APPROVED:", literal: APPROVAL },
    ])
    await assert.rejects(
      () =>
        callTool(h, "execute.before", {
          tool: "task",
          sessionID: "p1",
          input: { agent: "executor", prompt: "do the work" },
        }),
      (e: Error) => e.message === PLAN_GATE_MESSAGE,
    )
    const first = { tool: "read", sessionID: "p1", result: { output: "FILE" } }
    await callTool(h, "execute.after", first)
    assert.ok(
      String(first.result.output).includes(
        `- found "PLAN_APPROVED:" — the plan approval marker is "PLAN APPROVED:" (exact string)`,
      ),
    )
  } finally {
    restore()
  }
})

/** A child delivery surfaces its parent's pending diagnostic: the child's
 *  string output gets the parent's block, and the parent's entry is consumed
 *  (a later parent-keyed delivery is untouched). */
test("a child delivery surfaces the parent's pending near-miss diagnostic", async () => {
  const { h, dispose, metricsDir } = await boot()
  try {
    await callSession(h, "prompt", { sessionID: "p1", text: "USER_WAIVER: go" })
    await resolveEdgeViaCreated(h, "c1", "p1", metricsDir)
    const child = { tool: "read", sessionID: "c1", result: { output: "child-out" } }
    await callTool(h, "execute.after", child)
    assert.ok(String(child.result.output).startsWith("[turnstile] marker: 1 near-miss marker(s)"))
    assert.ok(String(child.result.output).endsWith("child-out"))
    const surfaced = surfacedEntries(metricsDir)
    assert.equal(surfaced.length, 1)
    assert.equal(surfaced[0]!.sessionID, "p1", "the parent is the surfaced session")
    assert.equal(surfaced[0]!.surfaced, true)
    const parent = { tool: "read", sessionID: "p1", result: { output: "parent-out" } }
    await callTool(h, "execute.after", parent)
    assert.equal(String(parent.result.output), "parent-out", "the parent entry was consumed")
  } finally {
    dispose()
  }
})

/** The inbox transport runs the same near-miss scan: an admission delivered
 *  by `session.inbox.enqueued` journals the hit exactly like the prompt hook. */
test("the inbox transport scans near misses on admission", async () => {
  const { h, dispose, metricsDir } = await boot()
  try {
    await pushAdmission(
      h,
      {
        sessionID: "p1",
        inboxID: "msg_nm1",
        item: { type: "user", payload: { text: "USER_WAIVER: please" } },
      },
      metricsDir,
    )
    assert.deepEqual(nearMissFields(metricsDir), [
      { event: "near-miss", sessionID: "p1", found: "USER_WAIVER:", literal: WAIVER },
    ])
  } finally {
    dispose()
  }
})

/** The strict path is untouched: an exact waiver prompt journals no marker
 *  entry at all and waives the reviewer gate as before. */
test("an exact waiver prompt journals no marker entry and waives as before", async () => {
  const { h, dispose, metricsDir } = await boot()
  try {
    await callSession(h, "prompt", { sessionID: "p1", text: "USER WAIVER: go" })
    assert.deepEqual(nearMissFields(metricsDir), [], "no near-miss entry for an exact literal")
    await assert.doesNotReject(() =>
      callTool(h, "execute.before", {
        tool: "task",
        sessionID: "p1",
        input: { agent: "reviewer", prompt: "review it" },
      }),
    )
  } finally {
    dispose()
  }
})

/** A new user prompt drops undelivered near-miss diagnostics (same task-scope
 *  lifecycle as the other latches): the first prompt's hit is journaled but
 *  never surfaces once a second prompt resets the session. */
test("a new prompt drops undelivered near-miss diagnostics", async () => {
  const { h, dispose, metricsDir } = await boot()
  try {
    await callSession(h, "prompt", { sessionID: "p1", text: "USER_WAIVER: go" })
    await callSession(h, "prompt", { sessionID: "p1", text: "keep going" })
    const event = { tool: "read", sessionID: "p1", result: { output: "FILE" } }
    await callTool(h, "execute.after", event)
    assert.equal(String(event.result.output), "FILE", "no block after the reset")
    assert.equal(nearMissFields(metricsDir).length, 1, "the detection entry stays journaled")
    assert.deepEqual(surfacedEntries(metricsDir), [], "nothing was ever surfaced")
  } finally {
    dispose()
  }
})

/** A prompt payload whose text getter throws is swallowed fail-open: the
 *  hook never throws and the near-miss scan journals under its own
 *  `marker near-miss:` error key. */
test("a hostile prompt text getter journals a marker error and never throws", async () => {
  const { h, dispose, metricsDir } = await boot()
  try {
    const hostile = {
      sessionID: "p1",
      get text(): string {
        throw new Error("text boom")
      },
    }
    await assert.doesNotReject(() => callSession(h, "prompt", hostile))
    const errorEntries = journalEntries(metricsDir).filter((l) => l.type === "error")
    assert.ok(
      errorEntries.some(
        (l) => typeof l.error === "string" && l.error.startsWith("marker near-miss:"),
      ),
      "the near-miss scan error is journaled under its own key",
    )
  } finally {
    dispose()
  }
})

/** Surfacing into a hostile (frozen) result fails open: the hook completes,
 *  the surfaced entry reports surfaced:false with the error, and the pending
 *  diagnostic still surfaces on the next string output. */
test("surfacing a frozen result journals surfaced:false and keeps the diagnostic pending", async () => {
  const { h, dispose, metricsDir } = await boot()
  try {
    await callSession(h, "prompt", { sessionID: "p1", text: "USER_WAIVER: go" })
    let threw = false
    try {
      // A frozen result: assigning the prefaced value throws in strict mode.
      await callTool(h, "execute.after", {
        tool: "read",
        sessionID: "p1",
        result: Object.freeze({ output: "frozen-body" }),
      })
    } catch {
      threw = true
    }
    assert.equal(threw, false, "the hook completes even when the mutation throws")
    const surfaced = surfacedEntries(metricsDir)
    assert.equal(surfaced.length, 1, "the failure is journaled")
    assert.equal(surfaced[0]!.surfaced, false, "the entry reports surfaced:false")
    assert.equal(surfaced[0]!.count, 1)
    assert.match(String(surfaced[0]!.error ?? ""), /.+/, "an error string is recorded")
    // The entry stayed pending: a later string-output event still surfaces.
    const later = { tool: "read", sessionID: "p1", result: { output: "body" } }
    await callTool(h, "execute.after", later)
    assert.ok(String(later.result.output).startsWith("[turnstile] marker: 1 near-miss marker(s)"))
  } finally {
    dispose()
  }
})

/** The pending near-miss map stays bounded: past the tracked-session cap the
 *  oldest parent is evicted (its diagnostic can no longer surface) while a
 *  younger parent's diagnostic still does. */
test("the pending near-miss map evicts the oldest parent past the cap", async () => {
  const { h, dispose, metricsDir } = await boot()
  try {
    for (let i = 1; i <= 17; i++) {
      const id = `s${i}`
      await callSession(h, "prompt", { sessionID: id, text: "USER_WAIVER: go" })
    }
    assert.equal(nearMissFields(metricsDir).length, 17)
    const evicted = { tool: "read", sessionID: "s1", result: { output: "A" } }
    await callTool(h, "execute.after", evicted)
    assert.equal(String(evicted.result.output), "A", "the oldest parent's entry was evicted")
    const kept = { tool: "read", sessionID: "s2", result: { output: "B" } }
    await callTool(h, "execute.after", kept)
    assert.ok(
      String(kept.result.output).startsWith("[turnstile] marker: 1 near-miss marker(s)"),
      "a younger parent's diagnostic still surfaces",
    )
  } finally {
    dispose()
  }
})

/** Redaction contract: the near-miss journal entry carries only the matched
 *  token and the configured literal — never the surrounding prompt text —
 *  and is byte-identical under trace on and trace off. */
test("near-miss entries journal the token and literal, never the prompt text", async () => {
  const secret = "SECRET SENTINEL WORDS"
  const prompt = `USER_WAIVER: ${secret}`
  const { h, dispose, metricsDir } = await boot()
  try {
    await callSession(h, "prompt", { sessionID: "p1", text: prompt })
    const fields = nearMissFields(metricsDir)
    assert.equal(fields.length, 1)
    assert.equal(fields[0]!.found, "USER_WAIVER:")
    assert.equal(fields[0]!.literal, WAIVER)
    assert.ok(!JSON.stringify(fields[0]).includes(secret), "the prompt text is redacted")
  } finally {
    dispose()
  }
  const off = await boot({ trace: false })
  try {
    await callSession(off.h, "prompt", { sessionID: "p1", text: prompt })
    assert.deepEqual(
      nearMissFields(off.metricsDir),
      nearMissFields(metricsDir),
      "the marker entry is identical under both trace settings",
    )
  } finally {
    off.dispose()
  }
})
