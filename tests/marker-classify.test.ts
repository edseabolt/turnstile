/**
 * @fileoverview Unit pins for the marker-result classification helpers
 * (`gateResultOf`/`verdictResultOf`): classification comes from the marker
 * regex's capture group 1, with the legacy substring classification only as
 * a fallback when the group is absent — including the disagreement case
 * under a custom broad marker source that motivated the helpers.
 */

import { test } from "node:test"
import assert from "node:assert/strict"

import {
  gateResultOf,
  verdictResultOf,
  parseGateMarkers,
  GATE_RE,
  VERDICT_RE,
} from "../src/markers.ts"
import { newState } from "../src/state.ts"

/** verdictResultOf classifies from the capture group, not substrings. */
test("verdictResultOf classifies from the capture group, not substrings", () => {
  const broad = /VERDICT: (BLOCK|APPROVE)[\s\S]*/g // custom-source stand-in
  assert.equal(verdictResultOf("VERDICT: BLOCK prose APPROVE", broad), "BLOCK")
})

/** gateResultOf classifies from the capture group, not substrings. */
test("gateResultOf classifies from the capture group, not substrings", () => {
  const broad = /GATE: (FAIL|PASS)[\s\S]*/g
  assert.equal(gateResultOf("GATE: FAIL rerun PASS tests=1 passed=1 failed=0", broad), "FAIL")
})

/** A capture group matching neither keyword falls back to substring search. */
test("classify falls back to substring when the group matches neither keyword", () => {
  const weird = /VERDICT: (WEIRD) crit=\d+ high=\d+ med=\d+ low=\d+/g
  assert.equal(
    verdictResultOf("VERDICT: WEIRD crit=0 high=0 med=0 low=0 APPROVE", weird),
    "APPROVE",
  )
  assert.equal(verdictResultOf("VERDICT: WEIRD crit=0 high=0 med=0 low=0", weird), "BLOCK")
})

/** verdictResultOf falls back to substring when the group is absent. */
test("verdictResultOf falls back to substring when the group is absent", () => {
  assert.equal(verdictResultOf("looks APPROVE to me"), "APPROVE") // canonical re won't match
  assert.equal(verdictResultOf("nothing here"), "BLOCK")
})

/** gateResultOf defaults to the canonical GATE_RE. */
test("gateResultOf defaults to the canonical GATE_RE", () => {
  assert.equal(gateResultOf("GATE: PASS tests=1 passed=1 failed=0"), "PASS")
  assert.equal(gateResultOf("GATE: FAIL tests=1 passed=0 failed=1"), "FAIL")
})

/** verdictResultOf defaults to the canonical VERDICT_RE. */
test("verdictResultOf defaults to the canonical VERDICT_RE", () => {
  assert.equal(verdictResultOf("VERDICT: APPROVE crit=0 high=0 med=0 low=0"), "APPROVE")
  assert.equal(verdictResultOf("VERDICT: BLOCK crit=1 high=0 med=0 low=0"), "BLOCK")
})

/** parseGateMarkers classifies a custom gate source by its capture group. */
test("parseGateMarkers classifies a custom gate source by its capture group", () => {
  const broadGateRe = /GATE: (FAIL|PASS)[\s\S]*/g
  const events = parseGateMarkers(
    newState(),
    "GATE: FAIL ... PASS ... tests=1 passed=1 failed=0",
    broadGateRe,
    VERDICT_RE,
  )
  assert.equal(events.find((e) => e.kind === "gate")?.result, "FAIL")
})

/** The canonical regexes still classify every shipped marker correctly. */
test("canonical regexes classify shipped markers via the capture group", () => {
  assert.equal(gateResultOf("GATE: PASS tests=3 passed=3 failed=0", GATE_RE), "PASS")
  assert.equal(verdictResultOf("VERDICT: BLOCK crit=1 high=2 med=3 low=4", VERDICT_RE), "BLOCK")
})
