/**
 * @fileoverview Config warning-text pins: every validation warning family
 * asserts its full exact message and that the default survived in the
 * resolved config — not just "a warning occurred". Extends the boolean-key
 * matrix pattern (the regression the ad-hoc differential probe caught) to
 * every family: boolean, non-empty-string, literal, fall-through-literal,
 * numeric, marker-source, evidencePattern, and metricsDir.
 */

import { test } from "node:test"
import assert from "node:assert/strict"

import { defaultConfig, mergeConfig } from "../src/config.ts"
import type { TurnstileConfig } from "../src/types.ts"

/** The boolean-family keys (a non-boolean value is always rejected). */
const BOOLEAN_KEYS = [
  "trace",
  "journalPerSession",
  "continuationCarry",
  "allowSuspend",
  "intentNudge",
  "alwaysEnforce",
  "planImpactStrict",
  "planUserReview",
] as const

/** The non-empty-string-family keys. */
const NON_EMPTY_STRING_KEYS = [
  "waiverMarker",
  "approvalMarker",
  "suspendMarker",
  "resumeMarker",
  "taskDoneMarker",
  "planReviewAcceptMarker",
  "planReviewRejectMarker",
  "plansDir",
] as const

/** The definitive literal-set keys with their exact warning wording. */
const LITERAL_KEYS: Record<string, { bad: unknown; warning: string }> = {
  sessionSummary: {
    bad: "fast",
    warning: `config: sessionSummary must be "on", "quiet", or "off"; keeping default`,
  },
  escalation: {
    bad: "enforce",
    warning: `config: escalation must be "block" or "ask"; keeping default`,
  },
}

/** The fall-through literal keys with their exact warning wording. */
const FALL_THROUGH_KEYS: Record<string, { bad: unknown; warning: string }> = {
  gateEvidence: {
    bad: "quiet",
    warning: `config: gateEvidence must be "enforce", "flag", or "off"; keeping default`,
  },
  reviewEnsemble: {
    bad: "block",
    warning: `config: reviewEnsemble must be "enforce" or "advise"; keeping default`,
  },
}

/** The positive-integer numeric keys (0 and negatives rejected). */
const NUMERIC_KEYS = [
  "maxReviewerRounds",
  "maxPlannerRounds",
  "maxPlanReviewerRounds",
  "maxTestRunnerRounds",
  "maxTotalDispatches",
  "maxSessions",
  "readWarn",
  "readBlock",
  "journalMaxBytes",
  "journalMaxGenerations",
  "journalRotateEveryEntries",
  "replayTailLines",
] as const

/**
 * Asserts one merge cell: the exact warning list and the default kept.
 * @param key The config key under test.
 * @param value The invalid patch value.
 * @param warnings The exact expected warning strings.
 */
function assertCell(key: keyof TurnstileConfig, value: unknown, warnings: string[]): void {
  const base = defaultConfig({})
  const { config, warnings: got } = mergeConfig(base, { [key]: value } as never)
  assert.deepEqual(got, warnings, `warnings for ${key}=${JSON.stringify(value)}`)
  assert.deepEqual(config[key], base[key], `default kept for ${key}=${JSON.stringify(value)}`)
}

test("boolean keys reject every non-boolean with the exact keeping-default message", () => {
  for (const key of BOOLEAN_KEYS) {
    for (const value of [1, 2, 0, -1, 1.5, "yes", "", null, [], {}]) {
      assertCell(key, value, [`config: invalid value for "${key}"; keeping default`])
    }
  }
})

test("boolean keys still accept true and false without warnings", () => {
  const base = defaultConfig({})
  for (const key of BOOLEAN_KEYS) {
    for (const value of [true, false]) {
      const { config, warnings } = mergeConfig(base, { [key]: value } as never)
      assert.deepEqual(warnings, [])
      assert.equal(config[key], value)
    }
  }
})

test("non-empty-string keys reject non-strings and blanks with the exact message", () => {
  for (const key of NON_EMPTY_STRING_KEYS) {
    for (const value of [1, null, true, "", "   ", [], {}]) {
      assertCell(key, value, [`config: invalid value for "${key}"; keeping default`])
    }
  }
})

test("metricsDir rejects relative and blank values with the exact message", () => {
  for (const value of ["relative/path", "", "  ", ".", 1, null]) {
    assertCell("metricsDir", value, [`config: invalid value for "metricsDir"; keeping default`])
  }
})

test("definitive literal keys pin their custom must-be warning wording", () => {
  for (const [key, { bad, warning }] of Object.entries(LITERAL_KEYS)) {
    assertCell(key as keyof TurnstileConfig, bad, [warning])
  }
})

test("fall-through literal keys pin their custom must-be warning wording", () => {
  for (const [key, { bad, warning }] of Object.entries(FALL_THROUGH_KEYS)) {
    assertCell(key as keyof TurnstileConfig, bad, [warning])
  }
})

test("positive-integer keys reject zero, negatives, fractions, and non-numbers", () => {
  for (const key of NUMERIC_KEYS) {
    for (const value of [0, -1, 1.5, NaN, Infinity, "8", null, true]) {
      assertCell(key, value, [`config: invalid value for "${key}"; keeping default`])
    }
  }
})

test("non-negative integer keys reject negatives, fractions, and non-numbers", () => {
  for (const key of ["observeSessions", "agentMarkerRetry"] as const) {
    for (const value of [-1, 0.5, NaN, Infinity, "0", null, true]) {
      assertCell(key, value, [`config: invalid value for "${key}"; keeping default`])
    }
  }
})

test("a non-compiling evidencePattern is rejected with the exact message", () => {
  assertCell("evidencePattern", "([unclosed", [
    `config: invalid value for "evidencePattern"; keeping default`,
  ])
})

test("marker regex sources reject non-strings with the exact message", () => {
  for (const key of ["gateMarker", "verdictMarker"] as const) {
    for (const value of [1, null, true, [], {}]) {
      assertCell(key, value, [`config: invalid value for "${key}"; keeping default`])
    }
  }
})
