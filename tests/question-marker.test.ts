/**
 * @fileoverview Executor `QUESTION:` marker tests (issue #420): the marker
 * regex and parse arm, the config surface (defaults, merge, validation), the
 * gate-state fields and snapshot line, the delivery-side open-row journaling
 * with executor authority, the deliberate dispatch pause, the answer and
 * cancel resume paths, the timeout decision (hold/resume), the `question`
 * replay fold, restart survival, and the policy/agent text.
 */

import { test } from "node:test"
import assert from "node:assert/strict"
import * as fs from "node:fs"
import * as path from "node:path"

import { BlockError } from "../src/gates.ts"
import { createHooksCore, type TurnstileContext } from "../src/hooks-core.ts"
import { createLedger } from "../src/ledger.ts"
import { defaultConfig, mergeConfig } from "../src/config.ts"
import { QUESTION_RE, deTokenizeMarker, parseQuestionMarker } from "../src/markers.ts"
import { formatGateSnapshot } from "../src/state.ts"
import { orchestratorPolicyFor } from "../src/policy.ts"
import { newState } from "../src/state-carry.ts"
import type { TurnstileConfig } from "../src/types.ts"
import { turnstile } from "../turnstile.ts"
import {
  callSession,
  callTool,
  expectedPolicy,
  isolatedEnv,
  journalEntries,
  makeFakeHost,
  tmpDir,
  type FakeHost,
} from "./helpers.ts"

/** The default cancel literal. */
const CANCEL = "QUESTION CANCELLED:"

/**
 * Reads journal entries of one type with the volatile `ts` field stripped,
 * so deep-equal assertions stay deterministic.
 * @param metricsDir The metrics dir to read.
 * @param type The journal entry type.
 * @returns The entries without `ts`.
 */
function entriesOf(metricsDir: string, type: string): Array<Record<string, any>> {
  return journalEntries(metricsDir)
    .filter((e) => e.type === type)
    .map((e) => {
      const { ts: _ts, ...rest } = e
      return rest
    })
}

/**
 * Creates a fresh hooks-core context over an isolated env and a temp metrics
 * dir, so neither config resolution nor journaling touches the real home.
 * @param config Injected config overrides (applied last by loadConfig).
 * @returns The context plus the temp metrics dir (for journal assertions).
 */
function coreWith(config: Partial<TurnstileConfig>): { ctx: TurnstileContext; metricsDir: string } {
  const metricsDir = tmpDir()
  const ctx = createHooksCore({
    env: isolatedEnv(metricsDir),
    config: { metricsDir, alwaysEnforce: true, ...config },
  })
  return { ctx, metricsDir }
}

/**
 * Dispatches one task dispatch through the guard, asserting whether it
 * throws a deliberate block.
 * @param ctx The hooks-core context.
 * @param sessionID The dispatching session.
 * @param agent The agent name to dispatch.
 * @param prompt The dispatch prompt.
 * @param blocked Whether the dispatch must throw a BlockError.
 */
async function dispatchExpect(
  ctx: TurnstileContext,
  sessionID: string,
  agent: string,
  prompt: string,
  blocked: boolean,
): Promise<void> {
  if (!blocked) {
    await ctx.guardedTaskDispatch(sessionID, agent, prompt, "")
    return
  }
  await assert.rejects(
    () => ctx.guardedTaskDispatch(sessionID, agent, prompt, ""),
    (e: unknown) => e instanceof BlockError,
  )
}

// ── Marker regex + parse arm ─────────────────────────────────────────────────

test("QUESTION_RE matches the canonical form and tolerates markdown decoration", () => {
  const re = new RegExp(QUESTION_RE.source, QUESTION_RE.flags.replace("g", ""))
  assert.ok(re.test("QUESTION: which queue?"))
  assert.ok(re.test("`QUESTION: which queue?`"))
  assert.ok(re.test("> QUESTION: which queue?"))
})

test("QUESTION_RE rejects a bare QUESTION: and a lowercase question:", () => {
  const re = new RegExp(QUESTION_RE.source, QUESTION_RE.flags.replace("g", ""))
  assert.ok(!re.test("QUESTION:"))
  assert.ok(!re.test("QUESTION: "))
  assert.ok(!re.test("question: which queue?"))
})

test("deTokenizeMarker lowercases a leading QUESTION: token", () => {
  assert.equal(deTokenizeMarker("QUESTION: which queue?"), "question: which queue?")
  assert.equal(
    deTokenizeMarker("GATE: PASS tests=1 passed=1 failed=0"),
    "gate: PASS tests=1 passed=1 failed=0",
  )
})

test("parseQuestionMarker: first sight returns the question; re-delivery is deduped", () => {
  const s = newState()
  const first = parseQuestionMarker(
    s,
    "work done\nQUESTION: which queue?",
    QUESTION_RE,
    "scope",
    "c1",
  )
  assert.ok(first)
  assert.equal(first!.question, "which queue?")
  assert.equal(first!.authority, "ok")
  assert.equal(parseQuestionMarker(s, "QUESTION: which queue?", QUESTION_RE, "scope", "c1"), null)
})

test("parseQuestionMarker: the last match wins and a denied authority is suppressed", () => {
  const s = newState()
  const event = parseQuestionMarker(
    s,
    "QUESTION: first?\nQUESTION: second?",
    QUESTION_RE,
    "scope",
    "c1",
    false,
  )
  assert.ok(event)
  assert.equal(event!.question, "second?")
  assert.equal(event!.authority, "suppressed")
})

test("parseQuestionMarker: no marker or empty text returns null", () => {
  const s = newState()
  assert.equal(parseQuestionMarker(s, "no marker here"), null)
  assert.equal(parseQuestionMarker(s, ""), null)
})

// ── Snapshot line ────────────────────────────────────────────────────────────

test("snapshot: the question line renders PENDING only while a question is open", () => {
  const s = newState()
  assert.ok(formatGateSnapshot(s).includes("- question: none"))
  s.questionPending = "which queue?"
  s.questionOpenedAt = 1
  assert.ok(formatGateSnapshot(s).includes("- question: PENDING"))
  assert.ok(!formatGateSnapshot(s).includes("which queue?"), "raw text never rides the snapshot")
})

// ── Replay fold ──────────────────────────────────────────────────────────────

/**
 * Writes the given raw lines as the journal of a fresh temp metrics dir.
 * @param metricsDir The temp metrics dir.
 * @param lines Raw journal lines.
 * @returns The journal path.
 */
function writeJournal(metricsDir: string, lines: string[]): string {
  const journalPath = path.join(metricsDir, "turnstile.jsonl")
  fs.writeFileSync(journalPath, lines.join("\n") + "\n")
  return journalPath
}

/**
 * A `question` journal line for a session.
 * @param sessionID The session ID.
 * @param action The lifecycle action (`open`/`answer`/`cancel`/`timeout`).
 * @param extra Extra fields (e.g. `question`, `authority`).
 * @returns The raw JSONL line.
 */
function questionLine(
  sessionID: string,
  action: string,
  extra: Record<string, unknown> = {},
): string {
  return JSON.stringify({
    ts: "2026-01-01T00:00:00.000Z",
    type: "question",
    sessionID,
    action,
    ...extra,
  })
}

test("replay: the question fold restores pending last-wins and the open clock", () => {
  const metricsDir = tmpDir()
  const journalPath = writeJournal(metricsDir, [
    questionLine("p1", "open", { question: "which queue?" }),
    questionLine("p2", "open", { question: "a" }),
    questionLine("p2", "answer", { answer: "in-process" }),
    questionLine("p3", "open", { question: "a", authority: "suppressed" }),
    questionLine("p4", "open", { question: "b" }),
    questionLine("p4", "cancel"),
    questionLine("p5", "open", { question: "c" }),
    questionLine("p5", "timeout"),
    questionLine("p6", "open", { question: 42 }),
    questionLine("p7", "hostile"),
  ])
  const ledger = createLedger(journalPath, 64, 2000)
  const p1 = ledger.peek("p1")
  assert.equal(p1?.questionPending, "which queue?", "an open restores pending")
  assert.equal(
    p1?.questionOpenedAt,
    Date.parse("2026-01-01T00:00:00.000Z"),
    "the clock is the row ts",
  )
  assert.equal(ledger.peek("p2")?.questionPending, "", "a later answer clears")
  assert.equal(ledger.peek("p3"), undefined, "a suppressed open mints no bucket")
  assert.equal(ledger.peek("p4")?.questionPending, "", "a cancel clears")
  assert.equal(ledger.peek("p5")?.questionPending, "", "a timeout clears")
  assert.equal(ledger.peek("p6")?.questionPending, "", "a hostile question degrades to empty")
  assert.equal(ledger.peek("p7"), undefined, "a hostile action mints no bucket")
})

// ── Pause, answer, cancel, timeout (end-to-end) ──────────────────────────────

/**
 * Boots the full plugin over a temp metrics dir with the given config.
 * @param config Injected config overrides.
 * @returns The fake host, dispose, and metrics dir.
 */
async function bootWith(config: Partial<TurnstileConfig>): Promise<{
  h: FakeHost
  dispose: () => void
  metricsDir: string
}> {
  const metricsDir = tmpDir()
  const h = makeFakeHost()
  const setup = turnstile(h.host, {
    env: isolatedEnv(metricsDir),
    config: { metricsDir, alwaysEnforce: true, ...config },
  })
  const dispose = (await setup(h.host)) as () => void
  return { h, dispose, metricsDir }
}

/**
 * Reads a parent's replayed gate state from the journal (the host harness
 * does not expose the live context).
 * @param metricsDir The metrics dir.
 * @param sessionID The parent session.
 * @returns The replayed gate state bucket, or undefined.
 */
function replayedState(metricsDir: string, sessionID: string): Record<string, unknown> | undefined {
  return createLedger(path.join(metricsDir, "turnstile.jsonl"), 64, 2000).peek(sessionID) as
    Record<string, unknown> | undefined
}

test("executor QUESTION pauses the pipeline; the answer dispatch resumes it", async () => {
  const { h, dispose, metricsDir } = await bootWith({})
  try {
    await callTool(h, "execute.after", {
      tool: "task",
      sessionID: "p1",
      input: { agent: "executor" },
      result: { output: "work so far\nQUESTION: which queue?" },
    })
    const open = entriesOf(metricsDir, "question").find((e) => e.action === "open")
    assert.ok(open)
    assert.equal(open.question, "which queue?")
    assert.equal(replayedState(metricsDir, "p1")?.questionPending, "which queue?")
    await assert.rejects(
      () =>
        callTool(h, "execute.before", {
          tool: "task",
          sessionID: "p1",
          input: { agent: "test-runner", prompt: "run tests" },
        }),
      (e: unknown) => {
        assert.ok(e instanceof BlockError)
        assert.match(e.message, /BLOCKED by turnstile:/)
        assert.match(e.message, /which queue\?/)
        return true
      },
    )
    assert.deepEqual(
      entriesOf(metricsDir, "blocked").map((r) => [r.agent, r.reason]),
      [["test-runner", "question-pending"]],
    )
    await callTool(h, "execute.before", {
      tool: "task",
      sessionID: "p1",
      input: { agent: "test-runner", prompt: "use the in-process queue" },
    })
    assert.equal(replayedState(metricsDir, "p1")?.questionPending, "")
    const answer = entriesOf(metricsDir, "question").find((e) => e.action === "answer")
    assert.ok(answer)
    assert.equal(answer.answer, "use the in-process queue")
  } finally {
    dispose()
  }
})

test("a non-executor QUESTION is journaled suppressed and pauses nothing", async () => {
  const { h, dispose, metricsDir } = await bootWith({})
  try {
    await callTool(h, "execute.after", {
      tool: "task",
      sessionID: "p1",
      input: { agent: "reviewer" },
      result: { output: "QUESTION: should I approve?" },
    })
    const open = entriesOf(metricsDir, "question").find((e) => e.action === "open")
    assert.ok(open)
    assert.equal(open.authority, "suppressed")
    assert.ok(!replayedState(metricsDir, "p1")?.questionPending, "a suppressed open pauses nothing")
    await callTool(h, "execute.before", {
      tool: "task",
      sessionID: "p1",
      input: { agent: "test-runner", prompt: "run tests" },
    })
  } finally {
    dispose()
  }
})

test("QUESTION CANCELLED: in the user's prompt cancels a pending question", async () => {
  const { h, dispose, metricsDir } = await bootWith({})
  try {
    // A priming prompt stamps the task fingerprint so the cancel prompt (a
    // later prompt than the delivery that opened the question) carries the
    // pause across the planless per-prompt scope boundary instead of
    // resetting it before the capture runs.
    await callSession(h, "prompt", { sessionID: "p1", text: "do work" })
    await callTool(h, "execute.after", {
      tool: "task",
      sessionID: "p1",
      input: { agent: "executor" },
      result: { output: "QUESTION: which queue?" },
    })
    await callSession(h, "prompt", { sessionID: "p1", text: `${CANCEL} do the simple thing` })
    assert.equal(replayedState(metricsDir, "p1")?.questionPending, "")
    assert.ok(
      entriesOf(metricsDir, "question").some((e) => e.action === "cancel"),
      "the cancel row is journaled",
    )
    await callTool(h, "execute.before", {
      tool: "task",
      sessionID: "p1",
      input: { agent: "test-runner", prompt: "run tests" },
    })
  } finally {
    dispose()
  }
})

test("a cancel literal with nothing pending is a no-op", async () => {
  const { h, dispose, metricsDir } = await bootWith({})
  try {
    await callSession(h, "prompt", { sessionID: "p1", text: `${CANCEL} nothing open` })
    assert.deepEqual(entriesOf(metricsDir, "question"), [])
  } finally {
    dispose()
  }
})

// ── Timeout decision (guard-level) ───────────────────────────────────────────

test("timeout resume: an aged question proceeds with the warning line appended", async () => {
  const { ctx, metricsDir } = coreWith({
    questionTimeoutMinutes: 1,
    questionTimeoutAction: "resume",
  })
  const s = ctx.ledger.state("p1")
  s.questionPending = "which queue?"
  s.questionOpenedAt = Date.now() - 2 * 60_000
  const prompt = await ctx.guardedTaskDispatch("p1", "test-runner", "run tests", "")
  assert.match(prompt, /question timed out unanswered/)
  assert.match(prompt, /which queue\?/)
  assert.equal(s.questionPending, "")
  assert.ok(entriesOf(metricsDir, "question").some((e) => e.action === "timeout"))
})

test("timeout hold: an aged question still blocks", async () => {
  const { ctx, metricsDir } = coreWith({ questionTimeoutMinutes: 1 })
  const s = ctx.ledger.state("p1")
  s.questionPending = "which queue?"
  s.questionOpenedAt = Date.now() - 2 * 60_000
  await dispatchExpect(ctx, "p1", "test-runner", "run tests", true)
  assert.equal(s.questionPending, "which queue?", "hold keeps the pause")
  assert.ok(entriesOf(metricsDir, "question").some((e) => e.action === "timeout") === false)
})

test("questionTimeoutMinutes 0 (default): the timeout branch never fires", async () => {
  const { ctx, metricsDir } = coreWith({})
  const s = ctx.ledger.state("p1")
  s.questionPending = "which queue?"
  s.questionOpenedAt = Date.now() - 1000 * 60 * 60 * 24 * 365
  await dispatchExpect(ctx, "p1", "test-runner", "run tests", true)
  assert.deepEqual(
    entriesOf(metricsDir, "question").map((e) => e.action),
    [],
    "no timeout row without an armed timeout",
  )
})

// ── Fail-open ────────────────────────────────────────────────────────────────

test("an internal question-pause error journals and the dispatch proceeds", async () => {
  const { ctx, metricsDir } = coreWith({})
  const s = ctx.ledger.state("p1")
  s.questionPending = "which queue?"
  s.questionOpenedAt = Date.now()
  Object.defineProperty(s, "questionOpenedAt", {
    get(): number {
      throw new Error("ledger down")
    },
    configurable: true,
  })
  await dispatchExpect(ctx, "p1", "test-runner", "run tests", false)
  const errors = entriesOf(metricsDir, "error")
  assert.ok(
    errors.some((r) => String(r.error).includes("question pause:")),
    "the pause error is journaled",
  )
})

// ── Policy + agent text ──────────────────────────────────────────────────────

test("policy: the question section is always present with the marker example", () => {
  const text = expectedPolicy({})
  assert.ok(text.includes("Questions (executor):"))
  assert.ok(text.includes("QUESTION: <text>"))
  assert.ok(text.includes("QUESTION CANCELLED:"))
  const { config } = mergeConfig(defaultConfig({}), {})
  assert.equal(orchestratorPolicyFor(config), text)
})

test("agents/executor.md carries the asking-instead-of-guessing section", () => {
  const text = fs.readFileSync(
    path.join(path.dirname(new URL(import.meta.url).pathname), "..", "agents", "executor.md"),
    "utf8",
  )
  assert.match(text, /## Asking instead of guessing/)
  assert.match(text, /QUESTION: <text>/)
  assert.match(text, /questionCancelMarker/)
})

// ── Config surface ───────────────────────────────────────────────────────────

test("question config: defaults are no-timeout hold with the canonical cancel literal", () => {
  const c = defaultConfig({})
  assert.equal(c.questionTimeoutMinutes, 0)
  assert.equal(c.questionTimeoutAction, "hold")
  assert.equal(c.questionCancelMarker, CANCEL)
})

test("question config: valid overrides merge; invalid values are rejected", () => {
  const { config, warnings } = mergeConfig(defaultConfig({}), {
    questionTimeoutMinutes: 30,
    questionTimeoutAction: "resume",
    questionCancelMarker: "NEVERMIND:",
  })
  assert.equal(config.questionTimeoutMinutes, 30)
  assert.equal(config.questionTimeoutAction, "resume")
  assert.equal(config.questionCancelMarker, "NEVERMIND:")
  assert.equal(warnings.length, 0)
  const bad = mergeConfig(defaultConfig({}), {
    questionTimeoutMinutes: -1,
    questionTimeoutAction: "give-up",
    questionCancelMarker: "",
  })
  assert.equal(bad.config.questionTimeoutMinutes, 0, "a negative timeout keeps the default")
  assert.equal(bad.config.questionTimeoutAction, "hold")
  assert.equal(bad.config.questionCancelMarker, CANCEL)
  assert.equal(bad.warnings.length, 3, "each invalid key warns")
  assert.ok(
    bad.warnings.includes(
      `config: questionTimeoutAction must be "hold" or "resume"; keeping default`,
    ),
  )
})
