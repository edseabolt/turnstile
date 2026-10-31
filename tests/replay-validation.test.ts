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

import { createLedger, sanitizeFingerprint } from "../src/ledger.ts"
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
 * @param fp The optional task fingerprint to journal (omitted when
 *     undefined, matching the legacy row shape).
 * @returns The raw JSONL line.
 */
function gateLine(sessionID: string, result = "PASS", fp?: unknown): string {
  return JSON.stringify({
    ts: "t",
    type: "gate",
    sessionID,
    raw: "c1",
    result,
    ...(fp === undefined ? {} : { fp }),
  })
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
 * @param agent The optional emitting agent to journal (omitted when not a
 *     non-empty string, matching the legacy row shape).
 * @returns The raw JSONL line.
 */
function verdictLine(sessionID: string, marker: unknown, agent?: unknown): string {
  return JSON.stringify({
    ts: "t",
    type: "verdict",
    sessionID,
    raw: "c1",
    marker,
    source: "task-result",
    ...(typeof agent === "string" && agent !== "" ? { agent } : {}),
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
 * An `observe` admission-stamp entry line for a session. Any field may be a
 * non-well-shaped value (the hostile-counter and hostile-phase tests pass
 * strings, fractions, negatives, and out-of-bound totals through).
 * @param sessionID The session ID to journal.
 * @param phase The admission phase (or a bad value for a shape-drop test).
 * @param observed The observed counter (or a bad value for a count-drop test).
 * @param wouldBlocks The would-blocks counter (or a bad value).
 * @returns The raw JSONL line.
 */
function observeLine(
  sessionID: string,
  phase: unknown,
  observed: unknown,
  wouldBlocks: unknown,
): string {
  return JSON.stringify({ ts: "t", type: "observe", sessionID, phase, observed, wouldBlocks })
}

/**
 * A `would-block` entry line for a session. The counters may be non-well-shaped
 * (the hostile-counter tests pass strings, fractions, negatives, and
 * out-of-bound totals through).
 * @param sessionID The session ID to journal.
 * @param observed The observed counter (or a bad value for a count-drop test).
 * @param wouldBlocks The would-blocks counter (or a bad value).
 * @returns The raw JSONL line.
 */
function wouldBlockLine(sessionID: string, observed: unknown, wouldBlocks: unknown): string {
  return JSON.stringify({ ts: "t", type: "would-block", sessionID, observed, wouldBlocks })
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
    verdictLine("p1", "VERDICT: APPROVE crit=0 high=0 med=0 low=0", "reviewer"),
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

/** The session-summary delivery-proof entry is replay-inert: an unknown
 *  replay type folds nothing, mints no bucket, and journals no drop. */
test("replay treats a session-summary entry as inert without telemetry", () => {
  const metricsDir = tmpDir()
  const journalPath = writeJournal(metricsDir, [
    JSON.stringify({
      ts: "t",
      type: "session-summary",
      sessionID: "p1",
      verified: 2,
      blockedDispatches: 1,
      waivers: 1,
      text: "turnstile: 2 test-claims verified · …",
    }),
    gateLine("p1"),
  ])
  const ledger = createLedger(journalPath, 64, 2000)
  assert.equal(ledger.peek("p1")?.hasGatePass, true, "the gate entry beside the summary restores")
  assert.equal(replayDrops(metricsDir).length, 0, "an inert entry journals no drop")
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
    verdictLine("p1", "A".repeat(513), "reviewer"),
    verdictLine("p2", 42, "reviewer"),
    verdictLine("p3", "VERDICT: APPROVE crit=0 high=0 med=0 low=0", "reviewer"),
    verdictLine("p4", boundary, "reviewer"),
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

/** An unreadable generation (a directory squatting on the `.1` path) is
 *  excluded from the fold without sinking the replay: the walk journals one
 *  message-free `replay` error entry, keeps walking, and still restores from
 *  the current file and the deeper `.2` generation. */
test("replay isolates an unreadable generation and journals one replay error", () => {
  const metricsDir = tmpDir()
  const journalPath = writeJournal(metricsDir, [gateLine("pCurrent")])
  fs.writeFileSync(path.join(metricsDir, "turnstile.jsonl.2"), `${gateLine("pDeep")}\n`)
  fs.mkdirSync(path.join(metricsDir, "turnstile.jsonl.1"))
  const ledger = createLedger(journalPath, 64, 2000)
  assert.equal(ledger.peek("pCurrent")?.hasGatePass, true, "the current file still restores")
  assert.equal(
    ledger.peek("pDeep")?.hasGatePass,
    true,
    "the walk continues past the unreadable generation",
  )
  assert.equal(replayDrops(metricsDir).length, 0, "a file-level error is not a line drop")
  const entries = fs
    .readFileSync(journalPath, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>)
  const errors = entries.filter((e) => e.type === "replay")
  assert.equal(errors.length, 1, "one replay error entry is journaled")
  const error = errors[0]!
  assert.equal(error.error, true, "the entry carries the error flag")
  assert.match(
    String(error.ts),
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/,
    "the entry is stamped",
  )
  assert.deepEqual(
    Object.keys(error).sort(),
    ["error", "ts", "type"],
    "the entry carries no message or other fields",
  )
})

/** An unreadable current file (a directory in its place) does not abort the
 *  walk: replay starts at the first generation and still restores from it,
 *  and the error-entry append fails open (the path is a directory). */
test("replay walks from the first generation when the current file is unreadable", () => {
  const metricsDir = tmpDir()
  const journalPath = path.join(metricsDir, "turnstile.jsonl")
  fs.mkdirSync(journalPath)
  fs.writeFileSync(path.join(metricsDir, "turnstile.jsonl.1"), `${gateLine("pGen1")}\n`)
  const ledger = createLedger(journalPath, 64, 2000)
  assert.equal(ledger.peek("pGen1")?.hasGatePass, true, "the .1 generation still restores")
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

/** Duplicate-keyed gate entries restore last-wins: a FAIL followed by a PASS
 *  restores green (the newest line decides), and a PASS followed by a FAIL
 *  mints no bucket at all (a trailing FAIL keeps the gate red). */
test("replay restores duplicate-keyed gate entries last-wins", () => {
  const greenDir = tmpDir()
  const greenPath = writeJournal(greenDir, [gateLine("p1", "FAIL"), gateLine("p1")])
  const green = createLedger(greenPath, 64, 2000)
  assert.equal(
    green.peek("p1")?.hasGatePass,
    true,
    "a FAIL followed by a PASS restores green (newest wins)",
  )
  assert.equal(replayDrops(greenDir).length, 0, "well-shaped duplicates journal no drop")
  const redDir = tmpDir()
  const redPath = writeJournal(redDir, [gateLine("p1"), gateLine("p1", "FAIL")])
  const red = createLedger(redPath, 64, 2000)
  assert.equal(red.peek("p1"), undefined, "a trailing FAIL keeps the gate red (no bucket)")
  assert.equal(replayDrops(redDir).length, 0, "a trailing FAIL is a fold, not a drop")
})

/** The fingerprint sanitizer is total: a string of length 1..1024 passes
 *  through (both bounds inclusive), and a non-string, an empty value, or an
 *  over-length one degrades to the empty fingerprint — never a throw. */
test("sanitizeFingerprint passes bounded strings and degrades everything else", () => {
  assert.equal(
    sanitizeFingerprint("wt\u0000dev"),
    "wt\u0000dev",
    "a valid fingerprint passes through",
  )
  assert.equal(
    sanitizeFingerprint("a".repeat(1024)),
    "a".repeat(1024),
    "the length bound is inclusive",
  )
  assert.equal(sanitizeFingerprint("a".repeat(1025)), "", "an over-length fingerprint degrades")
  assert.equal(sanitizeFingerprint(""), "", "an empty fingerprint degrades")
  assert.equal(sanitizeFingerprint(42), "", "a non-string fingerprint degrades")
  assert.equal(sanitizeFingerprint(undefined), "", "an absent fingerprint degrades")
})

/** A gate row's task fingerprint restores onto the PASS bucket: a stamped
 *  PASS stamps the worktree identity the recovery carry matches against,
 *  while a legacy row (no `fp`), an empty, an over-length, or a non-string
 *  value degrades to the empty fingerprint — inert, never a drop. */
test("replay restores a stamped gate fingerprint and degrades hostile ones", () => {
  const metricsDir = tmpDir()
  const journalPath = writeJournal(metricsDir, [
    gateLine("p1", "PASS", "wt\u0000dev"),
    gateLine("p2"), // legacy row: no fp field
    gateLine("p3", "PASS", ""), // empty value
    gateLine("p4", "PASS", "a".repeat(1025)), // over-length
    gateLine("p5", "PASS", 42), // non-string
  ])
  const ledger = createLedger(journalPath, 64, 2000)
  assert.equal(
    ledger.peek("p1")?.taskFingerprint,
    "wt\u0000dev",
    "a stamped PASS restores its fingerprint",
  )
  for (const id of ["p2", "p3", "p4", "p5"]) {
    assert.equal(
      ledger.peek(id)?.taskFingerprint,
      "",
      `a degraded fingerprint (${id}) restores the empty stamp`,
    )
  }
  assert.equal(replayDrops(metricsDir).length, 0, "a degraded fingerprint is inert, not a drop")
})

/** The gate fingerprint folds last-wins beside the result: a stamped FAIL's
 *  fingerprint wins over an earlier stamped PASS and stamps the trailing
 *  legacy PASS's restore (the legacy row leaves the standing fingerprint
 *  untouched), while the gate itself restores green per the result map. */
test("replay folds the gate fingerprint last-wins across PASS and FAIL rows", () => {
  const metricsDir = tmpDir()
  const journalPath = writeJournal(metricsDir, [
    gateLine("p1", "PASS", "fp-a"),
    gateLine("p1", "FAIL", "fp-b"),
    gateLine("p1"), // legacy PASS: no fp, leaves the FAIL's fingerprint standing
  ])
  const ledger = createLedger(journalPath, 64, 2000)
  const bucket = ledger.peek("p1")
  assert.equal(bucket?.hasGatePass, true, "the trailing PASS restores green")
  assert.equal(
    bucket?.taskFingerprint,
    "fp-b",
    "the FAIL's fingerprint won last-wins and stamped the restore",
  )
  assert.equal(replayDrops(metricsDir).length, 0, "fingerprint folding journals no drop")
})

/** A trailing FAIL whose fingerprint was folded mints no bucket at all: the
 *  FAIL keeps the gate red (the fingerprint is folded but unused by the
 *  restore), and the fold is not a drop. */
test("replay mints no bucket for a trailing FAIL with a folded fingerprint", () => {
  const metricsDir = tmpDir()
  const journalPath = writeJournal(metricsDir, [
    gateLine("p1", "PASS", "fp-a"),
    gateLine("p1", "FAIL", "fp-b"),
  ])
  const ledger = createLedger(journalPath, 64, 2000)
  assert.equal(ledger.peek("p1"), undefined, "a trailing FAIL keeps the gate red (no bucket)")
  assert.equal(replayDrops(metricsDir).length, 0, "a folding FAIL is not a drop")
})

/** A task-result verdict whose marker is full of regex metacharacters
 *  restores the flag per the existing fold (the derived APPROVE is credited)
 *  but stores no raw bytes: no bucket field echoes the marker, no drop is
 *  journaled, and a second boot re-folds identically. */
test("replay stores no raw bytes for a regex-metacharacter verdict marker", () => {
  const hostile = "VERDICT: APPROVE (.*+)["
  const metricsDir = tmpDir()
  const journalPath = writeJournal(metricsDir, [verdictLine("p1", hostile, "reviewer")])
  const ledger = createLedger(journalPath, 64, 2000)
  const bucket = ledger.peek("p1")
  assert.ok(bucket, "a within-bound marker restores a bucket")
  assert.equal(bucket.hasReviewApprove, true, "the derived APPROVE restores per the existing fold")
  assert.equal(replayDrops(metricsDir).length, 0, "a within-bound marker is folded, not dropped")
  const serialized = JSON.stringify(bucket)
  assert.ok(!serialized.includes(hostile), "no bucket field echoes the raw marker")
  assert.ok(!serialized.includes(".*+"), "no bucket field echoes the metacharacters")
  const secondBoot = createLedger(journalPath, 64, 2000)
  assert.deepEqual(secondBoot.peek("p1"), bucket, "a second boot re-folds identically")
})

/** Verdict replay is agent-attributed: only a verdict the configured reviewer
 *  agent emitted credits the landing gate. A plan-reviewer verdict, a legacy
 *  unattributed row, a hostile non-string agent, and an over-length agent all
 *  fold (degrading to an inert attribution) without restoring the flag — and
 *  none of them is a drop. */
test("replay credits only reviewer-attributed verdict approvals", () => {
  const metricsDir = tmpDir()
  const journalPath = writeJournal(metricsDir, [
    verdictLine("pReviewer", "VERDICT: APPROVE crit=0 high=0 med=0 low=0", "reviewer"),
    verdictLine("pPlanReviewer", "VERDICT: APPROVE crit=0 high=0 med=0 low=0", "plan-reviewer"),
    verdictLine("pLegacy", "VERDICT: APPROVE crit=0 high=0 med=0 low=0"),
    verdictLine("pHostile", "VERDICT: APPROVE crit=0 high=0 med=0 low=0", 42),
    verdictLine("pOverLength", "VERDICT: APPROVE crit=0 high=0 med=0 low=0", "a".repeat(129)),
  ])
  const ledger = createLedger(journalPath, 64, 2000)
  assert.equal(
    ledger.peek("pReviewer")?.hasReviewApprove,
    true,
    "a reviewer-attributed APPROVE restores the flag",
  )
  for (const id of ["pPlanReviewer", "pLegacy", "pHostile", "pOverLength"]) {
    assert.equal(
      ledger.state(id).hasReviewApprove,
      false,
      `a non-reviewer-attributed APPROVE (${id}) never restores the flag`,
    )
  }
  assert.equal(replayDrops(metricsDir).length, 0, "a degraded agent is inert, not a drop")
})

/** The configured reviewer name is honored: a ledger created with a renamed
 *  reviewer credits only verdicts attributed to that name, and the canonical
 *  default credits only the canonical one. */
test("replay honors the configured reviewer agent name for verdict credit", () => {
  const metricsDir = tmpDir()
  const journalPath = writeJournal(metricsDir, [
    verdictLine("pAuditor", "VERDICT: APPROVE crit=0 high=0 med=0 low=0", "auditor"),
    verdictLine("pCanonical", "VERDICT: APPROVE crit=0 high=0 med=0 low=0", "reviewer"),
  ])
  const renamed = createLedger(journalPath, 64, 2000, undefined, 0, "auditor")
  assert.equal(
    renamed.peek("pAuditor")?.hasReviewApprove,
    true,
    "a verdict attributed to the configured name restores the flag",
  )
  assert.equal(
    renamed.state("pCanonical").hasReviewApprove,
    false,
    "a verdict attributed to another agent never restores the flag",
  )
  const canonical = createLedger(journalPath, 64, 2000)
  assert.equal(
    canonical.peek("pCanonical")?.hasReviewApprove,
    true,
    "the default credits the canonical reviewer name",
  )
  assert.equal(
    canonical.state("pAuditor").hasReviewApprove,
    false,
    "the default does not credit a renamed agent's verdict",
  )
})

/** Well-shaped observe stamps and would-blocks fold last-wins into the period
 *  state: the per-session phases and the running totals restore exactly, no
 *  drop is journaled, and a summary marker is still absent (pendingSummary
 *  stays true once the period is complete). */
test("replay folds well-shaped observe stamps and would-blocks last-wins", () => {
  const metricsDir = tmpDir()
  const journalPath = writeJournal(metricsDir, [
    observeLine("p1", "observe", 1, 0),
    observeLine("p2", "observe", 2, 0),
    wouldBlockLine("p2", 2, 1),
    observeLine("p3", "enforce", 3, 1),
  ])
  const ledger = createLedger(journalPath, 64, 2000, undefined, 2)
  assert.deepEqual(
    ledger.observeCounts(),
    { observed: 3, wouldBlocks: 1, pendingSummary: true },
    "the last stamped line restores the totals and a completed period is pending",
  )
  assert.deepEqual(
    ledger.observePhase("p1"),
    { phase: "observe", isNew: false, completed: false },
    "a replayed observe stamp restores its phase without re-stamping",
  )
  assert.deepEqual(
    ledger.observePhase("p3"),
    { phase: "enforce", isNew: false, completed: false },
    "a replayed enforce stamp restores its phase",
  )
  assert.equal(replayDrops(metricsDir).length, 0, "well-shaped observe lines journal no drop")
})

/** An observe stamp whose phase is not exactly `observe`/`enforce` is a shape
 *  drop that keeps its validated session ID and folds nothing into the period
 *  state (the session is not admitted, so a later stamp re-counts it). */
test("replay drops an observe stamp with a bad phase", () => {
  const metricsDir = tmpDir()
  const journalPath = writeJournal(metricsDir, [observeLine("p1", "bogus", 1, 0)])
  const ledger = createLedger(journalPath, 64, 2000, undefined, 2)
  const drops = replayDrops(metricsDir)
  assert.equal(drops.length, 1, "one shape drop for the bad phase")
  assert.equal(drops[0]!.reason, "entry-shape")
  assert.equal(drops[0]!.sessionID, "p1", "a drop keeps its validated session ID")
  assert.deepEqual(
    ledger.observeCounts(),
    { observed: 0, wouldBlocks: 0, pendingSummary: false },
    "a dropped stamp folds nothing into the period",
  )
})

/** Every counter-shape violation on an observe or would-block line is a
 *  count-invalid drop: each of the eight sub-conditions (non-integer,
 *  negative, out-of-bound, non-number — on either counter) is exercised once,
 *  and none of them fold into the period state. */
test("replay drops observe and would-block lines with invalid counters", () => {
  const metricsDir = tmpDir()
  const journalPath = writeJournal(metricsDir, [
    observeLine("p1", "observe", -1, 0), // observed negative
    observeLine("p2", "observe", 1, 2.5), // wouldBlocks fractional
    observeLine("p3", "observe", 1e9, 0), // observed out of bound
    observeLine("p4", "observe", "x", 0), // observed non-number
    wouldBlockLine("p5", 1.5, 0), // observed fractional
    wouldBlockLine("p6", 1, -1), // wouldBlocks negative
    wouldBlockLine("p7", 1, "x"), // wouldBlocks non-number
    wouldBlockLine("p8", 1, 1e9), // wouldBlocks out of bound
  ])
  const ledger = createLedger(journalPath, 64, 2000, undefined, 2)
  const drops = replayDrops(metricsDir)
  assert.equal(drops.length, 8, "each invalid-counter line journals one entry")
  for (const d of drops) assert.equal(d.reason, "count-invalid")
  assert.deepEqual(
    drops.map((d) => d.sessionID),
    ["p1", "p2", "p3", "p4", "p5", "p6", "p7", "p8"],
    "each drop keeps its validated session ID",
  )
  assert.deepEqual(
    ledger.observeCounts(),
    { observed: 0, wouldBlocks: 0, pendingSummary: false },
    "no invalid-counter line folds into the period",
  )
})

/** An observe or would-block line whose sessionID fails the host shape is a
 *  session-id drop (never echoed into the journal), exactly like the other
 *  replay-typed kinds: the shape check runs before any per-kind fold. */
test("replay drops hostile observe and would-block session IDs", () => {
  const metricsDir = tmpDir()
  const journalPath = writeJournal(metricsDir, [
    observeLine("p 1", "observe", 1, 0),
    wouldBlockLine("p1\ninjected", 1, 0),
  ])
  createLedger(journalPath, 64, 2000, undefined, 2)
  const drops = replayDrops(metricsDir)
  assert.equal(drops.length, 2, "one telemetry entry per dropped line")
  for (const d of drops) {
    assert.equal(d.reason, "session-id")
    assert.ok(!("sessionID" in d), "hostile bytes are never echoed into the journal")
  }
})
