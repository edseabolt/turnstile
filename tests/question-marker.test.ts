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
