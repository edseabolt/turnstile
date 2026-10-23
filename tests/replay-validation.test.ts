/**
 * @fileoverview Boot-replay validation tests: a journal line must pass shape
 * validation (host session-ID alphabet, replay-typed entry, marker and
 * plan-identity bounds, integer ensemble counts) before replay folds it,
 * each dropped line journals a bounded replay-inert telemetry entry, and the
 * tail window walks all retained generations newest-first with an early stop.
 */

import { test } from "node:test"
import assert from "node:assert/strict"
import * as fs from "node:fs"
import * as path from "node:path"

import { createLedger } from "../src/ledger.ts"
import { REVIEW_ENSEMBLE_SIZE } from "../src/state.ts"
import { journalEntries, tmpDir } from "./helpers.ts"

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
 * A well-shaped replay-typed gate entry line.
 * @param sessionID The session ID to journal.
 * @param result The gate result (default PASS).
 * @returns The raw JSONL line.
 */
function gateLine(sessionID: string, result = "PASS"): string {
  return JSON.stringify({ ts: "t", type: "gate", sessionID, raw: "c1", result })
}

/**
 * An ensemble entry line for a session.
 * @param sessionID The session ID to journal.
 * @param count The reviewer-ensemble count to journal.
 * @returns The raw JSONL line.
 */
function ensembleLine(sessionID: string, count: number): string {
  return JSON.stringify({ ts: "t", type: "ensemble", sessionID, agent: "reviewer", count })
}

/**
 * A task-result verdict entry line for a session.
 * @param sessionID The session ID to journal.
 * @param marker The VERDICT marker (or non-string) to journal.
 * @returns The raw JSONL line.
 */
function verdictLine(sessionID: string, marker: unknown): string {
  return JSON.stringify({
    ts: "t",
    type: "verdict",
    sessionID,
    raw: "c1",
    marker,
    source: "task-result",
  })
}

/**
 * A plan APPROVE entry line carrying the given identity fields.
 * @param sessionID The session ID to journal.
 * @param fields The identity fields (plan/planKey/plansSig) to journal.
 * @returns The raw JSONL line.
 */
function planLine(sessionID: string, fields: Record<string, unknown>): string {
  return JSON.stringify({ ts: "t", type: "plan", sessionID, result: "APPROVE", ...fields })
}

/**
 * The replay-drop telemetry entries appended by a boot to a metrics dir.
 * Tolerates the deliberately malformed lines these tests pre-write (the
 * shared journal reader parses every line and would throw on them).
 * @param metricsDir The metrics dir to read.
 * @returns The `suppressed` entries with `kind:"replay"`.
 */
function replayDrops(metricsDir: string): Array<Record<string, any>> {
  const p = path.join(metricsDir, "turnstile.jsonl")
  if (!fs.existsSync(p)) return []
  return fs
    .readFileSync(p, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line) as Record<string, any>
      } catch {
        return null
      }
    })
    .filter(
      (e): e is Record<string, any> => e !== null && e.type === "suppressed" && e.kind === "replay",
    )
}

/** Replay restores well-shaped replay-typed entries (including an inert
 *  line) without journaling any drop. */
test("replay restores well-shaped replay-typed entries without telemetry", () => {
  const metricsDir = tmpDir()
  const journalPath = writeJournal(metricsDir, [
    gateLine("p1"),
    gateLine("ses_x1"),
    verdictLine("p1", "VERDICT: APPROVE crit=0 high=0 med=0 low=0"),
    JSON.stringify({ ts: "t", type: "error", error: "unrelated note" }),
  ])
  const ledger = createLedger(journalPath, 64, 2000)
  const s1 = ledger.peek("p1")
  assert.equal(s1?.hasGatePass, true, "a field-less legacy PASS restores the gate")
  assert.equal(s1?.hasReviewApprove, true, "a task-result APPROVE restores the review flag")
  assert.equal(s1?.replayGrace, true, "a restored flag tags replay grace")
  assert.equal(ledger.peek("ses_x1")?.hasGatePass, true, "a host-shaped ID restores")
  assert.equal(replayDrops(metricsDir).length, 0, "a clean tail journals no drop")
})

/** Lines whose sessionID fails the host shape are dropped one-for-one with
 *  telemetry, mint no bucket, and never echo the hostile bytes. */
test("replay drops hostile session IDs without minting buckets or echoing them", () => {
  const metricsDir = tmpDir()
  const hostile: unknown[] = ["p1\ninjected", "p 1", "p1\x00x", "a".repeat(129), 123, {}, ""]
  const lines = hostile.map((id) =>
    JSON.stringify({ ts: "t", type: "gate", sessionID: id, raw: "c1", result: "PASS" }),
  )
  const journalPath = writeJournal(metricsDir, lines)
  const ledger = createLedger(journalPath, 64, 2000)
  for (const id of hostile.filter((v): v is string => typeof v === "string")) {
    assert.equal(ledger.peek(id), undefined, `no bucket is minted for ${JSON.stringify(id)}`)
  }
  const drops = replayDrops(metricsDir)
  assert.equal(drops.length, hostile.length, "one telemetry entry per dropped line")
  for (const d of drops) {
    assert.equal(d.reason, "session-id")
    assert.ok(!("sessionID" in d), "hostile bytes are never echoed into the journal")
  }
})

/** A truncated line and non-object JSON lines each journal a malformed
 *  entry; the valid lines around them still restore. */
test("replay journals malformed telemetry and still restores the valid lines", () => {
  const metricsDir = tmpDir()
  const journalPath = writeJournal(metricsDir, [
    gateLine("p1"),
    '{"ts":"t","type":"gate","sessionID":"p2","result":"PAS',
    "null",
    '"str"',
    "[1,2]",
    "42",
    gateLine("p3"),
  ])
  const ledger = createLedger(journalPath, 64, 2000)
  assert.equal(ledger.peek("p1")?.hasGatePass, true, "a valid line before the drops restores")
  assert.equal(ledger.peek("p3")?.hasGatePass, true, "a valid line after the drops restores")
  assert.equal(ledger.peek("p2"), undefined, "a truncated line never mints a bucket")
  const drops = replayDrops(metricsDir)
  assert.equal(drops.length, 5, "each malformed line journals one entry")
  for (const d of drops) assert.equal(d.reason, "malformed")
})

/** An integer count above the ensemble size clamps to it on restore; a
 *  negative or non-integer count is dropped with telemetry that keeps the
 *  validated session ID. */
test("replay clamps oversized ensemble counts and drops invalid ones", () => {
  const metricsDir = tmpDir()
  const journalPath = writeJournal(metricsDir, [
    ensembleLine("p1", 1e9),
    ensembleLine("p1", -1),
    ensembleLine("p1", 2.5),
    ensembleLine("p2", 3),
  ])
  const ledger = createLedger(journalPath, 64, 2000)
  assert.equal(
    ledger.peek("p1")?.reviewerDispatches,
    REVIEW_ENSEMBLE_SIZE,
    "an oversized count clamps to the ensemble size",
  )
  assert.equal(
    ledger.peek("p2")?.reviewerDispatches,
    REVIEW_ENSEMBLE_SIZE,
    "an integer above the size clamps to it",
  )
  const drops = replayDrops(metricsDir)
  assert.equal(drops.length, 2, "a negative and a fractional count each journal one entry")
  for (const d of drops) {
    assert.equal(d.reason, "count-invalid")
    assert.equal(d.sessionID, "p1", "a drop keeps its validated session ID")
  }
})

/** A task-result verdict whose marker is not a string within the marker
 *  bound is dropped; a marker at the bound and a well-shaped one restore. */
test("replay drops a task-result verdict whose marker fails its shape", () => {
  const metricsDir = tmpDir()
  const boundary = "VERDICT: APPROVE" + "A".repeat(512 - "VERDICT: APPROVE".length)
  const journalPath = writeJournal(metricsDir, [
    verdictLine("p1", "A".repeat(513)),
    verdictLine("p2", 42),
    verdictLine("p3", "VERDICT: APPROVE crit=0 high=0 med=0 low=0"),
    verdictLine("p4", boundary),
  ])
  const ledger = createLedger(journalPath, 64, 2000)
  assert.equal(ledger.peek("p1"), undefined, "an oversized marker never mints a bucket")
  assert.equal(ledger.peek("p2"), undefined, "a non-string marker never mints a bucket")
  assert.equal(ledger.peek("p3")?.hasReviewApprove, true, "a well-shaped marker restores the flag")
  assert.equal(ledger.peek("p4")?.hasReviewApprove, true, "a marker at the length bound restores")
  const drops = replayDrops(metricsDir)
  assert.deepEqual(
    drops.map((d) => d.reason),
    ["entry-shape", "entry-shape"],
  )
  assert.deepEqual(
    drops.map((d) => d.sessionID),
    ["p1", "p2"],
  )
})

/** A hostile plan identity (path separators, over-length, non-string,
 *  non-sha256 key, over-length signature) degrades to the unbound values
 *  while the verdict still restores; a well-shaped identity stays bound. */
test("replay degrades hostile plan identity fields to the unbound values", () => {
  const wellKey = "8ca9e20c4ddaf0c04dacd88a658c355434a2a575fc47adcfb636aa221cbda256"
  const metricsDir = tmpDir()
  const journalPath = writeJournal(metricsDir, [
    planLine("p1", { plan: "../../etc/passwd", planKey: "z", plansSig: "x".repeat(4097) }),
    planLine("p2", { plan: "a".repeat(200) }),
    planLine("p3", { plan: "" }),
    planLine("p4", { plan: 42 }),
    planLine("p5", { plan: "z-work.md", planKey: wellKey, plansSig: "plan.md:abc" }),
  ])
  const ledger = createLedger(journalPath, 64, 2000)
  for (const id of ["p1", "p2", "p3", "p4"]) {
    const s = ledger.peek(id)
    assert.equal(s?.hasPlanVerdict, true, `${id}: a shape-degraded APPROVE still restores`)
    assert.equal(s?.approvedPlan, "", `${id}: the plan name degrades to unbound`)
    assert.equal(s?.approvedPlanKey, "", `${id}: the plan key degrades to unbound`)
    assert.equal(s?.plansSignature, "", `${id}: the signature degrades to unstamped`)
  }
  const s5 = ledger.peek("p5")
  assert.equal(s5?.approvedPlan, "z-work.md", "a well-shaped name restores bound")
  assert.equal(s5?.approvedPlanKey, wellKey, "a sha256-hex key restores bound")
  assert.equal(s5?.plansSignature, "plan.md:abc", "a within-bound signature restores stamped")
  assert.equal(replayDrops(metricsDir).length, 0, "identity degradation is silent, not a drop")
})

/** A PASS that lives only in the `.2` generation restores: the scan walks
 *  every retained generation, not just the current file and `.1`. */
test("replay restores an entry from a deeper retained generation", () => {
  const metricsDir = tmpDir()
  const filler = [gateLine("pFiller"), gateLine("pFiller")]
  fs.writeFileSync(path.join(metricsDir, "turnstile.jsonl"), filler.join("\n") + "\n")
  fs.writeFileSync(path.join(metricsDir, "turnstile.jsonl.1"), filler.join("\n") + "\n")
  fs.writeFileSync(path.join(metricsDir, "turnstile.jsonl.2"), `${gateLine("pDeep")}\n`)
  const ledger = createLedger(path.join(metricsDir, "turnstile.jsonl"), 64, 2000)
  assert.equal(ledger.peek("pDeep")?.hasGatePass, true, "a PASS in the .2 generation restores")
  assert.equal(ledger.peek("pFiller")?.hasGatePass, true, "newer generations still restore")
})

/** The walk stops as soon as the collected lines satisfy the tail bound, so
 *  a decoy buried in an unread generation never restores. */
test("replay stops walking generations once the tail bound is satisfied", () => {
  const metricsDir = tmpDir()
  const filler = [
    gateLine("pFiller"),
    gateLine("pFiller"),
    gateLine("pFiller"),
    gateLine("pFiller"),
  ]
  fs.writeFileSync(path.join(metricsDir, "turnstile.jsonl"), filler.join("\n") + "\n")
  fs.writeFileSync(path.join(metricsDir, "turnstile.jsonl.1"), `${gateLine("pDecoy")}\n`)
  const ledger = createLedger(path.join(metricsDir, "turnstile.jsonl"), 64, 3)
  assert.equal(ledger.peek("pDecoy"), undefined, "a decoy in an unread generation never restores")
  assert.equal(ledger.peek("pFiller")?.hasGatePass, true, "the current generation still restores")
})

/** The tail bound applies to the combined generation tail, oldest-first: an
 *  entry that survives the generation walk but sits before the last
 *  `tailLines` lines does not restore. */
test("replay truncates the combined tail across generations", () => {
  const metricsDir = tmpDir()
  fs.writeFileSync(path.join(metricsDir, "turnstile.jsonl"), `${gateLine("pFiller")}\n`)
  fs.writeFileSync(
    path.join(metricsDir, "turnstile.jsonl.1"),
    [gateLine("pOld"), gateLine("pFiller")].join("\n") + "\n",
  )
  const ledger = createLedger(path.join(metricsDir, "turnstile.jsonl"), 64, 2)
  assert.equal(ledger.peek("pOld"), undefined, "an entry beyond the tail bound does not restore")
  assert.equal(ledger.peek("pFiller")?.hasGatePass, true, "entries within the tail bound restore")
})

/** Drops beyond the per-boot cap journal one summary entry naming the total
 *  instead of one line each. */
test("replay caps drop telemetry per boot with a summary overflow", () => {
  const metricsDir = tmpDir()
  const broken = '{"ts":"t","type":"gate","sessionID":"p1","result":"PAS'
  const journalPath = writeJournal(
    metricsDir,
    Array.from({ length: 18 }, () => broken),
  )
  createLedger(journalPath, 64, 2000)
  const drops = replayDrops(metricsDir)
  assert.equal(drops.length, 17, "16 per-line entries plus one summary")
  assert.equal(drops.filter((d) => d.reason === "malformed").length, 16)
  const summary = drops.find((d) => d.event === "summary")
  assert.equal(summary?.dropped, 18, "the summary names the total dropped count")
})

/** Telemetry entries are replay-inert: a second boot re-drops only the
 *  hostile lines (a stable per-boot count), never the telemetry itself, and
 *  never mints a bucket from either. */
test("replay telemetry is inert on the next boot", () => {
  const metricsDir = tmpDir()
  const hostile = JSON.stringify({
    ts: "t",
    type: "gate",
    sessionID: "p1\ninjected",
    raw: "c1",
    result: "PASS",
  })
  const journalPath = writeJournal(
    metricsDir,
    Array.from({ length: 18 }, () => hostile),
  )
  createLedger(journalPath, 64, 2000)
  assert.equal(journalEntries(metricsDir).length, 35, "18 hostile lines plus 17 telemetry entries")
  const secondBoot = createLedger(journalPath, 64, 2000)
  assert.equal(secondBoot.peek("p1"), undefined, "hostile and telemetry lines never mint a bucket")
  const entries = journalEntries(metricsDir)
  assert.equal(entries.length, 52, "the second boot re-drops the hostile lines, not the telemetry")
  const summaries = entries.filter(
    (e) => e.type === "suppressed" && e.kind === "replay" && e.event === "summary",
  )
  assert.equal(summaries.length, 2, "one summary per boot")
  assert.equal(summaries[1]!.dropped, 18, "the drop count does not compound across boots")
})

/** Replay stamps its own telemetry with the current ISO timestamp rather
 *  than reusing a journaled field. */
test("replay telemetry entries are stamped with an ISO timestamp", () => {
  const metricsDir = tmpDir()
  const journalPath = writeJournal(metricsDir, [
    JSON.stringify({ ts: "t", type: "gate", sessionID: "p 1", raw: "c1", result: "PASS" }),
  ])
  createLedger(journalPath, 64, 2000)
  const drops = replayDrops(metricsDir)
  assert.equal(drops.length, 1)
  assert.match(
    drops[0]!.ts,
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/,
    "the replay stamps its own timestamp",
  )
})

/** A journal path whose parent is a file is unreadable and uncreatable:
 *  replay fails open, restores nothing, and mints no telemetry file. */
test("replay fails open when the journal sits under an uncreatable parent", () => {
  const dir = tmpDir()
  const blocker = path.join(dir, "notadir")
  fs.writeFileSync(blocker, "x")
  const journalPath = path.join(blocker, "child.jsonl")
  const ledger = createLedger(journalPath, 64, 2000)
  assert.equal(ledger.peek("p1"), undefined, "nothing restores from a missing journal")
  assert.equal(fs.existsSync(journalPath), false, "no telemetry file is minted")
})

/** A non-positive tail bound reads nothing: even a well-shaped PASS does not
 *  restore. */
test("replay reads nothing for a non-positive tail bound", () => {
  const metricsDir = tmpDir()
  const journalPath = writeJournal(metricsDir, [gateLine("p1")])
  const ledger = createLedger(journalPath, 64, 0)
  assert.equal(ledger.peek("p1"), undefined, "a zero tail restores nothing")
})
