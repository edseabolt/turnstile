/**
 * @fileoverview Observe-mode storage tests: the pure `observe` entry builders,
 * the live ledger methods (phase stamping with the double-count guard,
 * would-block totals, the pending-summary probe), and boot replay restoring
 * the period state exactly across a restart. The hook-body suppression that
 * produces these entries is a later concern; this file exercises the storage
 * and replay half directly against `createLedger` and the builders.
 */

import { test } from "node:test"
import assert from "node:assert/strict"
import * as fs from "node:fs"
import * as path from "node:path"

import { createLedger } from "../src/ledger.ts"
import { observeEntry, observeSummaryEntry } from "../src/gates-common.ts"
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

/** An `observe` admission-stamp entry line for a session.
 *  @param sessionID The session ID to journal.
 *  @param phase The admission phase.
 *  @param observed The observed counter.
 *  @param wouldBlocks The would-blocks counter.
 *  @returns The raw JSONL line. */
function observeLine(
  sessionID: string,
  phase: "observe" | "enforce",
  observed: number,
  wouldBlocks: number,
): string {
  return JSON.stringify({ ts: "t", type: "observe", sessionID, phase, observed, wouldBlocks })
}

/** A `would-block` entry line for a session.
 *  @param sessionID The session ID to journal.
 *  @param observed The observed counter.
 *  @param wouldBlocks The would-blocks counter.
 *  @returns The raw JSONL line. */
function wouldBlockLine(sessionID: string, observed: number, wouldBlocks: number): string {
  return JSON.stringify({ ts: "t", type: "would-block", sessionID, observed, wouldBlocks })
}

/** The replay-drop telemetry entries appended to a metrics dir (the same
 *  replay-inert `suppressed`/`kind:"replay"` shape the replay chain writes).
 *  @param metricsDir The metrics dir to read.
 *  @returns The `suppressed` entries with `kind:"replay"`. */
function replayDrops(metricsDir: string): Array<Record<string, any>> {
  return journalEntries(metricsDir).filter((e) => e.type === "suppressed" && e.kind === "replay")
}

/** The `observe` builder returns the admission-stamp entry shape: the session,
 *  its phase, and both running totals (the totals are what make the last
 *  stamped line restore the whole period at replay). */
test("observeEntry builds the admission-stamp entry shape", () => {
  assert.deepEqual(observeEntry("p1", "observe", 2, 1), {
    type: "observe",
    sessionID: "p1",
    phase: "observe",
    observed: 2,
    wouldBlocks: 1,
  })
})

/** The `observeSummaryEntry` builder returns the end-of-period marker shape:
 *  no phase (replay folds it inert), the `kind:"summary"` and `injected`
 *  stamps, and both running totals. */
test("observeSummaryEntry builds the end-of-period marker shape", () => {
  assert.deepEqual(observeSummaryEntry("p3", 3, 1), {
    type: "observe",
    sessionID: "p3",
    kind: "summary",
    injected: true,
    observed: 3,
    wouldBlocks: 1,
  })
})

/** observePhase stamps a new session `observe` while the running total stays
 *  within the configured period, flips to `enforce` past it, marks the
 *  completing stamp, and returns the stored phase (no re-stamp) on repeat
 *  admission — the `observed` total increments exactly once per session. */
test("observePhase stamps observe then enforce and never re-counts a stamped session", () => {
  const metricsDir = tmpDir()
  const ledger = createLedger(path.join(metricsDir, "turnstile.jsonl"), 64, 2000, undefined, 2)
  assert.deepEqual(
    ledger.observePhase("s1"),
    { phase: "observe", isNew: true, completed: false },
    "the first session observes",
  )
  assert.deepEqual(
    ledger.observePhase("s2"),
    { phase: "observe", isNew: true, completed: false },
    "the second (last in-period) session observes",
  )
  assert.deepEqual(
    ledger.observePhase("s3"),
    { phase: "enforce", isNew: true, completed: true },
    "the session past the boundary enforces and completes the period",
  )
  assert.deepEqual(
    ledger.observePhase("s1"),
    { phase: "observe", isNew: false, completed: false },
    "a repeat admission reads the stored phase without re-stamping",
  )
  assert.deepEqual(
    ledger.observeCounts(),
    { observed: 3, wouldBlocks: 0, pendingSummary: true },
    "the total counts each session once and the completed period is pending",
  )
})

/** With a configured period of 0, or for an empty session ID, observePhase
 *  reports `off` and stamps nothing (the default path stays byte-identical). */
test("observePhase reports off for a zero period and an empty session ID", () => {
  const metricsDir = tmpDir()
  const disabled = createLedger(path.join(metricsDir, "turnstile.jsonl"), 64, 2000, undefined, 0)
  assert.deepEqual(
    disabled.observePhase("s1"),
    { phase: "off", isNew: false, completed: false },
    "a zero period is off for any session",
  )
  assert.deepEqual(
    disabled.observeCounts(),
    { observed: 0, wouldBlocks: 0, pendingSummary: false },
    "an off period stamps no totals",
  )
  const enabled = createLedger(path.join(metricsDir, "turnstile.jsonl"), 64, 2000, undefined, 2)
  assert.deepEqual(
    enabled.observePhase(""),
    { phase: "off", isNew: false, completed: false },
    "an empty session ID is off even with a live period",
  )
})

/** noteWouldBlock increments the running would-block total, returns both
 *  totals, re-records the session in the admission dedup set, and skips the
 *  set for an empty session ID. */
test("noteWouldBlock increments the total and re-records the session", () => {
  const metricsDir = tmpDir()
  const ledger = createLedger(path.join(metricsDir, "turnstile.jsonl"), 64, 2000, undefined, 2)
  ledger.observePhase("s1")
  assert.deepEqual(
    ledger.noteWouldBlock("s1"),
    { observed: 1, wouldBlocks: 1 },
    "the first suppression returns both running totals",
  )
  assert.deepEqual(
    ledger.noteWouldBlock("s1"),
    { observed: 1, wouldBlocks: 2 },
    "a second suppression keeps counting without re-admitting the session",
  )
  assert.deepEqual(
    ledger.observeCounts(),
    { observed: 1, wouldBlocks: 2, pendingSummary: false },
    "the totals reflect the suppressions",
  )
  // An empty session ID still counts the block but must not pollute the set.
  assert.deepEqual(
    ledger.noteWouldBlock(""),
    { observed: 1, wouldBlocks: 3 },
    "an empty session ID still counts the block",
  )
})

/** pendingSummary is true only when the observed total passes the configured
 *  period and no summary marker is present: a fresh (in-period) ledger is
 *  false, and a completed ledger is true. */
test("observeCounts pendingSummary tracks the period boundary", () => {
  const metricsDir = tmpDir()
  const ledger = createLedger(path.join(metricsDir, "turnstile.jsonl"), 64, 2000, undefined, 2)
  assert.equal(
    ledger.observeCounts().pendingSummary,
    false,
    "a fresh in-period ledger is not pending",
  )
  ledger.observePhase("s1")
  ledger.observePhase("s2")
  assert.equal(
    ledger.observeCounts().pendingSummary,
    false,
    "an in-period ledger (at the boundary) is not pending",
  )
  ledger.observePhase("s3")
  assert.equal(ledger.observeCounts().pendingSummary, true, "a completed period is pending")
})

/** A restart boots over the journaled tail and restores the period state
 *  exactly: the per-session phases, the running totals, and the pending probe
 *  all match the first boot, and a second boot re-folds identically (replay
 *  is idempotent and journals no drop over a well-shaped tail). */
test("replay restores the observe period exactly across a restart", () => {
  const metricsDir = tmpDir()
  const journalPath = writeJournal(metricsDir, [
    observeLine("s1", "observe", 1, 0),
    wouldBlockLine("s1", 1, 1),
    observeLine("s2", "observe", 2, 1),
    observeLine("s3", "enforce", 3, 1),
  ])
  const first = createLedger(journalPath, 64, 2000, undefined, 2)
  const firstSnapshot = {
    counts: first.observeCounts(),
    s1: first.observePhase("s1"),
    s2: first.observePhase("s2"),
    s3: first.observePhase("s3"),
  }
  assert.deepEqual(
    firstSnapshot.counts,
    { observed: 3, wouldBlocks: 1, pendingSummary: true },
    "the first boot restores the totals and the pending probe",
  )
  assert.equal(replayDrops(metricsDir).length, 0, "a well-shaped tail journals no drop")
  const second = createLedger(journalPath, 64, 2000, undefined, 2)
  assert.deepEqual(
    {
      counts: second.observeCounts(),
      s1: second.observePhase("s1"),
      s2: second.observePhase("s2"),
      s3: second.observePhase("s3"),
    },
    firstSnapshot,
    "a second boot re-folds the same period state",
  )
  assert.equal(replayDrops(metricsDir).length, 0, "the second boot journals no drop either")
})

/** The double-count guard, common case: an observe-period session with zero
 *  would-blocks (only its admission stamp in the tail) is recognized by its
 *  surviving phase stamp after a restart and is not re-incremented. */
test("replay does not re-count a zero-would-block observe session after a restart", () => {
  const metricsDir = tmpDir()
  const journalPath = writeJournal(metricsDir, [
    observeLine("s1", "observe", 1, 0),
    observeLine("s2", "observe", 2, 0),
  ])
  const ledger = createLedger(journalPath, 64, 2000, undefined, 2)
  assert.deepEqual(
    ledger.observePhase("s1"),
    { phase: "observe", isNew: false, completed: false },
    "the surviving stamp restores the phase without a new stamp",
  )
  assert.deepEqual(
    ledger.observeCounts(),
    { observed: 2, wouldBlocks: 0, pendingSummary: false },
    "the observed total is unchanged by the re-admission",
  )
})

/** The double-count guard, aged-stamp case: a session whose admission stamp
 *  rolled out of the tail but whose would-block line survived is restored as
 *  `observe` (a suppression presupposes an observe-phase stamp) without
 *  re-incrementing the observed total. */
test("replay restores an admitted session lacking a phase stamp without re-counting", () => {
  const metricsDir = tmpDir()
  const journalPath = writeJournal(metricsDir, [
    wouldBlockLine("s1", 2, 1),
    observeLine("s2", "observe", 2, 1),
  ])
  const ledger = createLedger(journalPath, 64, 2000, undefined, 2)
  assert.deepEqual(
    ledger.observePhase("s1"),
    { phase: "observe", isNew: false, completed: false },
    "an admitted session without a phase stamp restores its observe phase",
  )
  assert.deepEqual(
    ledger.observeCounts(),
    { observed: 2, wouldBlocks: 1, pendingSummary: false },
    "the observed total is unchanged by the re-admission",
  )
})

/** A journaled end-of-period summary marker is exempt from the phase check
 *  (it carries no phase) and sets the summary probe, so a completed period
 *  whose summary already surfaced is not pending after a restart. */
test("replay marks a journaled summary marker and clears pendingSummary", () => {
  const metricsDir = tmpDir()
  const journalPath = writeJournal(metricsDir, [
    observeLine("s1", "observe", 1, 0),
    observeLine("s2", "observe", 2, 0),
    observeLine("s3", "enforce", 3, 1),
    JSON.stringify(observeSummaryEntry("s3", 3, 1)),
  ])
  const ledger = createLedger(journalPath, 64, 2000, undefined, 2)
  assert.deepEqual(
    ledger.observeCounts(),
    { observed: 3, wouldBlocks: 1, pendingSummary: false },
    "a journaled summary marker clears the pending probe",
  )
  assert.equal(replayDrops(metricsDir).length, 0, "a summary marker folds inert, not a drop")
})

/** The same completed period with no journaled summary marker stays pending
 *  after a restart: the probe is true until the summary is journaled. */
test("replay keeps pendingSummary true when no summary marker is journaled", () => {
  const metricsDir = tmpDir()
  const journalPath = writeJournal(metricsDir, [
    observeLine("s1", "observe", 1, 0),
    observeLine("s2", "observe", 2, 0),
    observeLine("s3", "enforce", 3, 1),
  ])
  const ledger = createLedger(journalPath, 64, 2000, undefined, 2)
  assert.deepEqual(
    ledger.observeCounts(),
    { observed: 3, wouldBlocks: 1, pendingSummary: true },
    "a completed period with no summary marker is pending",
  )
})
