/**
 * @fileoverview Replay round-trip tests: a mixed journal history seeded
 * across both sinks (the shared `turnstile.jsonl` and the per-session
 * `sessions/<parentID>.jsonl` files) restores gate state field-by-field
 * through the public `createLedger` composition path — including ts-ordering
 * across sinks, a generation-rotation boundary (seeded `.1` files, no 5 MB
 * generation), a rotate-then-restore second boot, refusal-suppressed
 * approval restore, and `prov:*` rows (including a malformed/future-shaped
 * payload and rows in a rotated `.1` generation) tolerated as replay-inert.
 */

import { test } from "node:test"
import assert from "node:assert/strict"
import * as fs from "node:fs"
import * as path from "node:path"

import { createLedger } from "../src/ledger.ts"
import { REVIEW_ENSEMBLE_SIZE } from "../src/state.ts"
import { tmpDir } from "./helpers.ts"

/** The shared journal file name inside a metrics dir. */
const JOURNAL = "turnstile.jsonl"

/**
 * Writes lines to a file inside the metrics dir, creating parents.
 * @param metricsDir The temp metrics dir.
 * @param name The file name relative to the metrics dir.
 * @param lines Raw JSONL lines (joined with newlines).
 */
function writeLines(metricsDir: string, name: string, lines: string[]): void {
  const p = path.join(metricsDir, name)
  fs.mkdirSync(path.dirname(p), { recursive: true })
  fs.writeFileSync(p, lines.join("\n") + "\n")
}

/**
 * A well-shaped replay-typed gate PASS line.
 * @param sessionID The session ID to journal.
 * @param fp The optional task fingerprint to journal.
 * @returns The raw JSONL line.
 */
function gateLine(sessionID: string, fp?: string): string {
  return JSON.stringify({
    ts: "t",
    type: "gate",
    sessionID,
    raw: "c1",
    result: "PASS",
    ...(fp === undefined ? {} : { fp }),
  })
}

/**
 * A reviewer-attributed task-result verdict APPROVE line.
 * @param sessionID The session ID to journal.
 * @returns The raw JSONL line.
 */
function verdictLine(sessionID: string): string {
  return JSON.stringify({
    ts: "t",
    type: "verdict",
    sessionID,
    raw: "c1",
    agent: "reviewer",
    marker: "VERDICT: APPROVE crit=0 high=0 med=0 low=0",
    source: "task-result",
  })
}

/**
 * A reviewer-ensemble count line with an optional refusal stamp.
 * @param sessionID The session ID to journal.
 * @param count The ensemble count.
 * @param refusedApprove The optional refusal stamp.
 * @returns The raw JSONL line.
 */
function ensembleLine(sessionID: string, count: number, refusedApprove?: boolean): string {
  return JSON.stringify({
    ts: "t",
    type: "ensemble",
    sessionID,
    agent: "reviewer",
    count,
    ...(refusedApprove === undefined ? {} : { refusedApprove }),
  })
}

/**
 * An observe-mode stamp line with an explicit timestamp.
 * @param ts The ISO timestamp controlling cross-sink fold order.
 * @param sessionID The session ID to journal.
 * @param observed The observed counter.
 * @returns The raw JSONL line.
 */
function observeLine(ts: string, sessionID: string, observed: number): string {
  return JSON.stringify({
    ts,
    type: "observe",
    sessionID,
    phase: "observe",
    observed,
    wouldBlocks: 0,
  })
}

/**
 * A `prov:stated` decision-ledger row (replay-inert by design).
 * @param sessionID The parent session the prompt was admitted in.
 * @returns The raw JSONL line.
 */
function provStatedLine(sessionID: string): string {
  return JSON.stringify({
    ts: "t",
    type: "prov:stated",
    sessionID,
    text: "ship it",
    truncated: false,
  })
}

/**
 * Asserts the full restored bucket for the mixed-history session.
 * @param ledger The freshly-replayed ledger.
 * @param sessionID The session whose bucket to assert.
 */
function assertMixedBucket(ledger: ReturnType<typeof createLedger>, sessionID: string): void {
  const s = ledger.peek(sessionID)
  assert.ok(s, "the mixed-history session restores a bucket")
  assert.equal(s.hasGatePass, true, "the gate PASS restores")
  assert.equal(s.hasReviewApprove, true, "the reviewer-attributed APPROVE restores")
  assert.equal(
    s.reviewerDispatches,
    REVIEW_ENSEMBLE_SIZE,
    "the ensemble count restores clamped to the size",
  )
  assert.equal(s.replayGrace, true, "a restored flag tags replay grace")
  assert.equal(s.taskFingerprint, "wt\u0000dev", "the stamped fingerprint restores")
}

test("replay restores mixed history across both sinks field-by-field", () => {
  const metricsDir = tmpDir()
  writeLines(metricsDir, JOURNAL, [
    gateLine("p1", "wt\u0000dev"),
    verdictLine("p1"),
    observeLine("2026-01-01T00:00:00.000Z", "pObs", 1),
  ])
  writeLines(metricsDir, path.join("sessions", "p1.jsonl"), [
    ensembleLine("p1", REVIEW_ENSEMBLE_SIZE),
    observeLine("2026-01-01T00:00:01.000Z", "pObs", 2),
  ])
  const ledger = createLedger(
    path.join(metricsDir, JOURNAL),
    64,
    2000,
    undefined,
    2,
    "reviewer",
    path.join(metricsDir, "sessions"),
  )
  assertMixedBucket(ledger, "p1")
  assert.deepEqual(
    ledger.observeCounts(),
    { observed: 2, wouldBlocks: 0, pendingSummary: false },
    "the later-ts session-sink stamp wins the global totals (ts-ordering across sinks)",
  )
})

test("replay restores a refusal-stamped approval pair per the last-wins stamp", () => {
  const metricsDir = tmpDir()
  writeLines(metricsDir, JOURNAL, [
    verdictLine("pRefused"),
    ensembleLine("pRefused", 1, true),
    verdictLine("pCleared"),
    ensembleLine("pCleared", 1, false),
  ])
  const ledger = createLedger(path.join(metricsDir, JOURNAL), 64, 2000)
  assert.equal(
    ledger.peek("pRefused")?.hasReviewApprove,
    false,
    "a trailing refusedApprove:true suppresses the approval restore",
  )
  assert.equal(
    ledger.peek("pCleared")?.hasReviewApprove,
    true,
    "a trailing refusedApprove:false (human grant) restores the approval",
  )
})

test("replay tolerates recovery and prov rows interleaved with gate history", () => {
  const metricsDir = tmpDir()
  writeLines(metricsDir, JOURNAL, [
    gateLine("p1"),
    JSON.stringify({ ts: "t", type: "continuation", sessionID: "p1", recovery: true }),
    provStatedLine("p1"),
    '{"ts":"t","type":"prov:stated","sessionID":"p1"}',
    verdictLine("p1"),
  ])
  const ledger = createLedger(path.join(metricsDir, JOURNAL), 64, 2000)
  const s = ledger.peek("p1")
  assert.equal(s?.hasGatePass, true, "the gate PASS beside the inert rows restores")
  assert.equal(s?.hasReviewApprove, true, "the verdict beside the inert rows restores")
})

test("replay restores from a seeded rotated .1 generation containing prov rows", () => {
  const metricsDir = tmpDir()
  writeLines(metricsDir, `${JOURNAL}.1`, [gateLine("pRot"), provStatedLine("pRot")])
  writeLines(metricsDir, JOURNAL, [verdictLine("pRot")])
  const ledger = createLedger(path.join(metricsDir, JOURNAL), 64, 2000)
  const s = ledger.peek("pRot")
  assert.equal(s?.hasGatePass, true, "the PASS in the rotated generation restores")
  assert.equal(s?.hasReviewApprove, true, "the verdict in the current file restores")
})

test("rotate-then-restore replays identically from the renamed generation", () => {
  const metricsDir = tmpDir()
  const journalPath = path.join(metricsDir, JOURNAL)
  writeLines(metricsDir, JOURNAL, [
    gateLine("p1", "wt\u0000dev"),
    verdictLine("p1"),
    ensembleLine("p1", REVIEW_ENSEMBLE_SIZE),
    provStatedLine("p1"),
  ])
  const first = createLedger(journalPath, 64, 2000)
  const before = first.peek("p1")
  fs.renameSync(journalPath, `${journalPath}.1`)
  const second = createLedger(journalPath, 64, 2000)
  assert.deepEqual(second.peek("p1"), before, "the second boot restores the bucket identically")
  assertMixedBucket(second, "p1")
})
