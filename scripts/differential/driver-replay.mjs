/**
 * @fileoverview Differential scenario `replay`: synthetic journal line
 * sequences (valid entries, unknown kinds, malformed lines, out-of-order ts
 * across sinks, `refusedApprove` last-wins pairs, `recovery:true` rows,
 * interleaved `prov:*` rows incl. a malformed payload, rotation boundaries)
 * fed through each tree's boot replay (`createLedger`), diffing the restored
 * gate state field-by-field plus the replay-drop telemetry count.
 *
 * Stateful (file reads, journalers) — runs one subprocess per tree.
 */

import * as fs from "node:fs"
import * as path from "node:path"
import { emit, normalize, tmpMetricsDir, withModules } from "./driver-lib.mjs"

/**
 * A journal fixture: files to seed (relative to the metrics dir) and the
 * replay tail bound to replay with.
 * @param {string} name The fixture name.
 * @param {Record<string, string[]>} files Relative path → raw lines.
 * @param {number} tailLines The `replayTailLines` bound.
 * @returns {{name: string, files: Record<string, string[]>, tailLines: number}} The fixture.
 */
function fixture(name, files, tailLines) {
  return { name, files, tailLines }
}

/** The `ts` values used to exercise cross-sink and out-of-order ordering. */
const T1 = "2026-01-01T00:00:00.000Z"
const T2 = "2026-01-02T00:00:00.000Z"
const T3 = "2026-01-03T00:00:00.000Z"
const T4 = "2026-01-04T00:00:00.000Z"

/** The replay fixtures, in run order. */
const FIXTURES = [
  fixture(
    "mixed-both-sinks",
    {
      "sessions/p1.jsonl": [
        JSON.stringify({ ts: T1, type: "gate", sessionID: "p1", raw: "c1", result: "FAIL" }),
      ],
      "turnstile.jsonl": [
        JSON.stringify({ ts: T2, type: "gate", sessionID: "p1", raw: "c2", result: "PASS" }),
        JSON.stringify({
          ts: T3,
          type: "verdict",
          sessionID: "p1",
          raw: "c1",
          marker: "VERDICT: APPROVE crit=0 high=0 med=0 low=0",
          source: "task-result",
          agent: "reviewer",
        }),
        JSON.stringify({ ts: T4, type: "ensemble", sessionID: "p1", agent: "reviewer", count: 2 }),
      ],
    },
    2000,
  ),
  fixture(
    "refused-approve",
    {
      "turnstile.jsonl": [
        JSON.stringify({ ts: T1, type: "ensemble", sessionID: "p1", agent: "reviewer", count: 1 }),
        JSON.stringify({
          ts: T2,
          type: "ensemble",
          sessionID: "p1",
          agent: "reviewer",
          count: 1,
          refusedApprove: true,
        }),
        JSON.stringify({
          ts: T3,
          type: "verdict",
          sessionID: "p1",
          raw: "c1",
          marker: "VERDICT: APPROVE crit=0 high=0 med=0 low=0",
          source: "task-result",
          agent: "reviewer",
        }),
      ],
    },
    2000,
  ),
  fixture(
    "refused-cleared",
    {
      "turnstile.jsonl": [
        JSON.stringify({
          ts: T1,
          type: "ensemble",
          sessionID: "p1",
          agent: "reviewer",
          count: 1,
          refusedApprove: true,
        }),
        JSON.stringify({
          ts: T2,
          type: "ensemble",
          sessionID: "p1",
          agent: "reviewer",
          count: 2,
          refusedApprove: false,
        }),
        JSON.stringify({
          ts: T3,
          type: "verdict",
          sessionID: "p1",
          raw: "c1",
          marker: "VERDICT: APPROVE crit=0 high=0 med=0 low=0",
          source: "task-result",
          agent: "reviewer",
        }),
      ],
    },
    2000,
  ),
  fixture(
    "recovery-row",
    {
      "turnstile.jsonl": [
        JSON.stringify({ ts: T1, type: "gate", sessionID: "p1", raw: "c1", result: "PASS" }),
        JSON.stringify({ ts: T2, type: "continuation", sessionID: "p1", recovery: true }),
      ],
    },
    2000,
  ),
  fixture(
    "malformed-and-unknown",
    {
      "turnstile.jsonl": [
        '{"ts":"t","type":"gate","sessionID":"p1","result":"PAS',
        "null",
        JSON.stringify({ ts: T1, type: "totally-unknown-kind", sessionID: "p1" }),
        JSON.stringify({ ts: T2, type: "gate", sessionID: "p1", raw: "c1", result: "PASS" }),
        JSON.stringify({ ts: T3, type: "prov:stated", sessionID: "p1", text: "hello" }),
        JSON.stringify({
          ts: T4,
          type: "prov:stated",
          sessionID: "p1",
          text: 42,
          future: { a: 1 },
        }),
      ],
    },
    2000,
  ),
  fixture(
    "rotation-prov-generation",
    {
      "sessions/p1.jsonl.1": [
        JSON.stringify({ ts: T1, type: "prov:stated", sessionID: "p1", text: "older prompt" }),
        JSON.stringify({ ts: T2, type: "gate", sessionID: "p1", raw: "c1", result: "PASS" }),
        JSON.stringify({ ts: T3, type: "tool", sessionID: "p1" }),
      ],
      "sessions/p1.jsonl": [JSON.stringify({ ts: T4, type: "tool", sessionID: "p1" })],
    },
    5,
  ),
  fixture(
    "tail-bound",
    {
      "turnstile.jsonl": [
        JSON.stringify({ ts: T1, type: "gate", sessionID: "p1", raw: "c1", result: "PASS" }),
        JSON.stringify({ ts: T2, type: "tool", sessionID: "p1" }),
        JSON.stringify({ ts: T3, type: "tool", sessionID: "p1" }),
        JSON.stringify({ ts: T4, type: "gate", sessionID: "p1", raw: "c2", result: "FAIL" }),
      ],
    },
    3,
  ),
]

/**
 * Seeds a temp metrics dir with a fixture's files.
 * @param {{name: string, files: Record<string, string[]>, tailLines: number}} fx The fixture.
 * @returns {string} The metrics dir.
 */
function seedFixture(fx) {
  const metricsDir = tmpMetricsDir()
  for (const [rel, lines] of Object.entries(fx.files)) {
    const file = path.join(metricsDir, rel)
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, lines.join("\n") + "\n")
  }
  return metricsDir
}

/**
 * Projects a restored gate state onto the decision-relevant fields. The
 * projection is fixed (not "everything except"): every field listed exists
 * in both the pre-decomposition and current trees, so the comparison is
 * meaningful across the whole ref range; display-only or later-added fields
 * (e.g. `planReviewPending`, `lastGateMarker`) are deliberately outside the
 * characterization surface.
 * @param {Object} state The restored GateState (or undefined).
 * @returns {unknown} The projected state, or "<<absent>>".
 */
function projectState(state) {
  if (state === undefined) return "<<absent>>"
  const fields = [
    "hasGatePass",
    "unverifiedPass",
    "hasPlanVerdict",
    "hasReviewApprove",
    "userWaiver",
    "userWaiverScope",
    "userWaiverConsumed",
    "reviewWaiverRounds",
    "humanApproval",
    "reviewerDispatches",
    "engaged",
    "stickyRelease",
    "handsOnRelease",
    "taskComplete",
    "activePlan",
    "approvedPlan",
    "approvedPlanKey",
    "plansSignature",
    "taskFingerprint",
    "replayGrace",
  ]
  const out = {}
  for (const f of fields) out[f] = normalize(state[f])
  return out
}

/**
 * Replays one fixture through a tree's ledger and renders the cell value.
 * @param {Object} ledger The tree's GateLedger.
 * @param {string} metricsDir The seeded metrics dir.
 * @returns {{sessions: Object, drops: number}} The restored state + drop count.
 */
function replayCell(ledger, metricsDir) {
  const sessions = {}
  for (const sid of ["p1", "p2"]) {
    sessions[sid] = projectState(ledger.peek(sid))
  }
  const journalPath = path.join(metricsDir, "turnstile.jsonl")
  const journal = fs.existsSync(journalPath)
    ? fs.readFileSync(journalPath, "utf8").split("\n").filter(Boolean)
    : []
  const drops = journal.filter((line) => {
    try {
      const e = JSON.parse(line)
      return e.type === "suppressed" && e.kind === "replay"
    } catch {
      return false
    }
  }).length
  return { sessions, drops }
}

/**
 * Runs the replay fixtures against one tree.
 * @param {string} treeRoot The tree root directory.
 * @returns {Promise<{ok: boolean, cells?: Object, code?: string, module?: string}>}
 *     The scenario result.
 */
export async function scenario(treeRoot) {
  return withModules(treeRoot, ["src/ledger.ts"], async (modules) => {
    const { createLedger } = modules["src/ledger.ts"]
    const cells = {}
    for (const fx of FIXTURES) {
      const metricsDir = seedFixture(fx)
      const ledger = createLedger(
        path.join(metricsDir, "turnstile.jsonl"),
        64,
        fx.tailLines,
        undefined,
        0,
        "reviewer",
        path.join(metricsDir, "sessions"),
      )
      cells[`replay.${fx.name}`] = replayCell(ledger, metricsDir)
    }
    return cells
  })
}

// Direct execution: `node driver-replay.mjs <treeRoot>` (subprocess mode).
if (process.argv[1] && import.meta.url === import.meta.resolve(process.argv[1])) {
  emit(await scenario(process.argv[2]))
}
