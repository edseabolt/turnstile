/**
 * @fileoverview Differential scenario `markers`: a fixed corpus of task-result
 * texts (valid GATE/VERDICT markers, near-miss variants, code-fenced markers,
 * multiple markers, non-marker text) through `parseGateMarkers` +
 * `findMarkerNearMisses`, diffing the parsed events, the mutated gate-state
 * flags, and the near-miss hits.
 *
 * Pure functions only — runs in-process against both trees.
 */

import { emit, withModules } from "./driver-lib.mjs"

/** The fixed marker corpus: name → task-result text. */
const CORPUS = {
  "gate-pass": "GATE: PASS tests=3 passed=3 failed=0",
  "gate-fail": "GATE: FAIL tests=2 passed=1 failed=1",
  "verdict-approve": "VERDICT: APPROVE crit=0 high=0 med=0 low=0",
  "verdict-block": "VERDICT: BLOCK crit=1 high=2 med=3 low=4",
  "wrong-spacing": "GATE:  PASS tests=3 passed=3 failed=0",
  "missing-fields": "GATE: PASS tests=3",
  lowercase: "gate: PASS tests=3 passed=3 failed=0",
  "code-fence": "```\nGATE: PASS tests=3 passed=3 failed=0\n```",
  "multiple-markers":
    "GATE: PASS tests=3 passed=3 failed=0\nGATE: FAIL tests=3 passed=2 failed=1\nVERDICT: APPROVE crit=0 high=0 med=0 low=0",
  "non-marker": "all tests passed, nothing to see here",
  "leading-junk": "noise GATE: PASS tests=3 passed=3 failed=0",
  "trailing-noise": "GATE: PASS tests=3 passed=3 failed=0 trailing noise",
  "block-then-pass":
    "GATE: FAIL tests=1 passed=0 failed=1\nlater fixed\nGATE: PASS tests=1 passed=1 failed=0",
}

/** The waiver/approval literals the near-miss scan probes. */
const LITERALS = [
  { literal: "USER WAIVER:", label: "waiver" },
  { literal: "PLAN APPROVED:", label: "plan approval" },
]

/**
 * A fresh minimal gate state for `parseGateMarkers` (only the fields the
 * parser reads and writes).
 * @returns {{seen: Set<string>, seenFrom: Map<string, string>, suppressedPending: number, hasGatePass: boolean, unverifiedPass: string}}
 *     The fresh state.
 */
function freshState() {
  return {
    seen: new Set(),
    seenFrom: new Map(),
    suppressedPending: 0,
    hasGatePass: false,
    unverifiedPass: "",
  }
}

/**
 * Runs the marker corpus against one tree.
 * @param {string} treeRoot The tree root directory.
 * @returns {Promise<{ok: boolean, cells?: Object, code?: string, module?: string}>}
 *     The scenario result.
 */
export async function scenario(treeRoot) {
  return withModules(treeRoot, ["src/markers.ts"], async (modules) => {
    const markers = modules["src/markers.ts"]
    const cells = {}
    for (const [name, text] of Object.entries(CORPUS)) {
      const state = freshState()
      const events = markers.parseGateMarkers(state, text)
      const nearMisses = markers.findMarkerNearMisses(text, LITERALS)
      cells[`markers.${name}`] = {
        events,
        hasGatePass: state.hasGatePass,
        unverifiedPass: state.unverifiedPass,
        nearMisses,
      }
    }
    return cells
  })
}

// Direct execution: `node driver-markers.mjs <treeRoot>` (subprocess mode).
if (process.argv[1] && import.meta.url === import.meta.resolve(process.argv[1])) {
  emit(await scenario(process.argv[2]))
}
