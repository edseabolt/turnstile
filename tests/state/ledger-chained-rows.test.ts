/**
 * @fileoverview Journaler-backed ledger telemetry tests: when `createLedger`
 * receives a journaler, its telemetry rows — the `replay` error row for an
 * unreadable generation, the `approval ledger:` error rows (boot read
 * failure and persist failure), the `journal-lock:` approval-lock row, and
 * the `plan-rekey` row — append through the chained journal path (carrying
 * `seq`/`prevHash`/`hash` under tamper evidence) and participate in the
 * rotation tick, so a strict every-row-chained walk of a fresh journal finds
 * no hash-less rows. A ledger created without a journaler keeps the legacy
 * unchained shape (pinned by the existing suites).
 */

import { test } from "node:test"
import assert from "node:assert/strict"
import * as fs from "node:fs"
import * as path from "node:path"

import { createLedger, type GateLedger } from "../../src/state/ledger.ts"
import { createJournaler, type Journaler } from "../../src/journal/journal.ts"
import { tmpDir } from "../support/helpers.ts"

/**
 * A well-shaped sha256-hex content key with a stable, readable character.
 * @param c The single character to repeat to the 64-hex-char length.
 * @returns A 64-char hex string.
 */
function keyOf(c: string): string {
  return c.repeat(64)
}

/**
 * The default sidecar path: beside the journal in the metrics dir.
 * @param metricsDir The temp metrics dir.
 * @returns The sidecar file path.
 */
function sidecarPath(metricsDir: string): string {
  return path.join(metricsDir, "approved-plans.jsonl")
}

/**
 * Boots a journaler-backed ledger over a fresh temp metrics dir: a journaler
 * with tamper evidence enabled and a small epoch cadence, threaded into
 * `createLedger` as the trailing parameter (the production wiring shape).
 * @param metricsDir The temp metrics dir (journal + sidecar live here).
 * @param opts Optional overrides: the rotation tick and the explicit sidecar
 *     path.
 * @returns The journaler (for sink-path assertions) and the booted ledger.
 */
function bootChained(
  metricsDir: string,
  opts?: {
    rotateEveryEntries?: number
    maxBytes?: number
    lockTimeoutMs?: number
    sidecar?: string
    seed?: (journaler: Journaler) => void
  },
): { journaler: Journaler; ledger: GateLedger } {
  const journaler = createJournaler({
    metricsDir,
    trace: false,
    maxBytes: opts?.maxBytes ?? 1024 * 1024,
    maxGenerations: 5,
    archiveGenerations: 0,
    rotateEveryEntries: opts?.rotateEveryEntries ?? 512,
    lockTimeoutMs: opts?.lockTimeoutMs,
    tamper: { enabled: true, epochEntries: 8 },
  })
  opts?.seed?.(journaler)
  const ledger = createLedger(
    journaler.journalPath,
    64,
    2000,
    opts?.sidecar,
    0,
    "reviewer",
    journaler.sessionsDir,
    journaler,
  )
  return { journaler, ledger }
}

/**
 * Reads every row of the shared journal file.
 * @param metricsDir The metrics dir holding `turnstile.jsonl`.
 * @returns The parsed rows, in file order.
 */
function sharedRows(metricsDir: string): Array<Record<string, any>> {
  const p = path.join(metricsDir, "turnstile.jsonl")
  return fs
    .readFileSync(p, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line))
}

/**
 * Asserts one row is chained: a numeric `seq` plus string `prevHash`/`hash`.
 * @param row The parsed journal row.
 * @param label The assertion message prefix.
 */
function assertChained(row: Record<string, any>, label: string): void {
  assert.equal(typeof row.seq, "number", `${label}: numeric seq`)
  assert.equal(typeof row.prevHash, "string", `${label}: string prevHash`)
  assert.equal(typeof row.hash, "string", `${label}: string hash`)
}

/** A replay-error row for an unreadable journal generation is chained when
 *  the ledger is journaler-backed: the row lands on the shared journal with
 *  the chain fields instead of the legacy unchained append. */
test("replay-error rows are chained when the ledger is journaler-backed", () => {
  const metricsDir = tmpDir()
  const journalPath = path.join(metricsDir, "turnstile.jsonl")
  // The replay walk only reaches generation 1 when the current file exists;
  // a directory in its place makes the generation read fail (EISDIR).
  fs.writeFileSync(journalPath, `${JSON.stringify({ ts: "t", type: "gate" })}\n`)
  fs.mkdirSync(`${journalPath}.1`)
  const { ledger } = bootChained(metricsDir)
  assert.ok(ledger, "the boot replay survives the unreadable generation")
  const errors = sharedRows(metricsDir).filter((e) => e.type === "replay" && e.error === true)
  assert.equal(errors.length, 1, "one replay-error row")
  assertChained(errors[0]!, "replay-error row")
})

/** A sidecar read failure at boot journals its `approval ledger:` error row
 *  through the journaler (the boot route: `createLedgerMaps` →
 *  `loadApprovedPlans`), so the row is chained. */
test("the boot-route approval-ledger read-failed row is chained", () => {
  const metricsDir = tmpDir()
  const sidecar = path.join(metricsDir, "sidecar.jsonl")
  fs.mkdirSync(sidecar) // a directory in the sidecar's place: EISDIR, not ENOENT
  const { ledger } = bootChained(metricsDir, { sidecar })
  assert.ok(ledger, "the boot survives the unreadable sidecar")
  const errors = sharedRows(metricsDir).filter(
    (e) => e.type === "error" && String(e.error).startsWith("approval ledger: read failed"),
  )
  assert.equal(errors.length, 1, "one read-failed row")
  assertChained(errors[0]!, "boot-route read-failed row")
})

/** A sidecar persist failure journals its `approval ledger:` error row
 *  through the journaler (the store route: `ApprovalStoreState`), so the row
 *  is chained. */
test("the store-route approval-ledger persist-failed row is chained", () => {
  const metricsDir = tmpDir()
  const blocker = path.join(metricsDir, "notadir")
  fs.writeFileSync(blocker, "x")
  const sidecar = path.join(blocker, "sidecar.jsonl")
  const { ledger } = bootChained(metricsDir, { sidecar })
  // The boot read of the sidecar fails too (ENOTDIR); the record's persist
  // fails afterwards and rolls back — both failures journal chained rows.
  ledger.recordPlanApprovalDurable("plan.md", keyOf("a"), tmpDir())
  const errors = sharedRows(metricsDir).filter(
    (e) => e.type === "error" && String(e.error).startsWith("approval ledger:"),
  )
  assert.ok(errors.length >= 2, "the read-failed and persist-failed rows both landed")
  for (const e of errors) assertChained(e, "store-route error row")
})

/** A degraded (unlocked) sidecar write journals its `journal-lock:` row
 *  through the journaler, so the row is chained — the `journal-lock:`
 *  payload prefix does not make it a sanctioned unchained row; it is written
 *  from the ledger, not from inside the chained path. */
test("the approval-lock error row is chained when the ledger is journaler-backed", () => {
  const metricsDir = tmpDir()
  const project = tmpDir()
  const { ledger } = bootChained(metricsDir)
  fs.mkdirSync(`${sidecarPath(metricsDir)}.lock`) // held by "another process"
  ledger.recordPlanApprovalDurable("plan.md", keyOf("a"), project)
  const errors = sharedRows(metricsDir).filter(
    (e) => e.type === "error" && String(e.error).startsWith("journal-lock:"),
  )
  assert.equal(errors.length, 1, "one journal-lock row")
  assertChained(errors[0]!, "approval-lock row")
})

/** A transparent re-key of a legacy durable approval journals its
 *  `plan-rekey` row through the journaler, so the row is chained. */
test("the plan-rekey row is chained when the ledger is journaler-backed", () => {
  const metricsDir = tmpDir()
  const project = tmpDir()
  // Learn the project scope by recording a probe with a legacy journaler-less
  // ledger, then read the scope back from the sidecar.
  const probe = createLedger(path.join(metricsDir, "turnstile.jsonl"), 64, 2000)
  probe.recordPlanApprovalDurable("probe.md", keyOf("a"), project)
  const lines = fs.readFileSync(sidecarPath(metricsDir), "utf8").split("\n").filter(Boolean)
  const scope = (JSON.parse(lines[lines.length - 1]!) as { project: string }).project
  // Seed a legacy whole-file-keyed record and boot journaler-backed over it.
  fs.writeFileSync(
    sidecarPath(metricsDir),
    `${JSON.stringify({ name: "plan.md", key: keyOf("b"), project: scope })}\n`,
  )
  const { ledger } = bootChained(metricsDir)
  assert.equal(
    ledger.planApprovalState("plan.md", keyOf("a"), keyOf("b"), project, "p1"),
    "live",
    "the whole-file match proves the bytes unchanged",
  )
  const rekeys = sharedRows(metricsDir).filter((e) => e.type === "plan-rekey")
  assert.equal(rekeys.length, 1, "one plan-rekey row")
  assertChained(rekeys[0]!, "plan-rekey row")
  assert.equal(rekeys[0]!.sessionID, "p1")
})

/** Journaler-backed telemetry rows advance the rotation tick: a burst of
 *  error rows rotates the shared journal instead of bypassing the tick. */
test("journaler-backed error rows still rotation-tick", () => {
  const metricsDir = tmpDir()
  const project = tmpDir()
  const { ledger } = bootChained(metricsDir, {
    rotateEveryEntries: 2,
    maxBytes: 200,
    lockTimeoutMs: 10,
  })
  fs.mkdirSync(`${sidecarPath(metricsDir)}.lock`) // every record journals one error row
  for (let i = 0; i < 3; i++) ledger.recordPlanApprovalDurable(`plan-${i}.md`, keyOf("a"), project)
  assert.equal(
    fs.existsSync(path.join(metricsDir, "turnstile.jsonl.1")),
    true,
    "the shared journal rotated under the error-row burst",
  )
})

/** The strict-verifier property: after a mix of journaler-backed telemetry
 *  rows, every row in the fresh chained journal carries a hash — no
 *  hash-less row short of the sanctioned unchained class (not triggered
 *  here). */
test("every row in a fresh journaler-backed journal carries a hash", () => {
  const metricsDir = tmpDir()
  const project = tmpDir()
  const journalPath = path.join(metricsDir, "turnstile.jsonl")
  fs.mkdirSync(`${sidecarPath(metricsDir)}.lock`)
  const { ledger } = bootChained(metricsDir, {
    lockTimeoutMs: 10,
    // The current file must exist for the replay walk to reach generation 1;
    // seed it with a chained row so the strict walk covers only chained rows.
    seed: (j) => {
      fs.mkdirSync(`${journalPath}.1`)
      // A replay-inert row (unknown type folds without a drop) so the strict
      // walk covers only chained rows — the out-of-scope `suppressed` row
      // stays untriggered.
      j.journal({ type: "heartbeat" })
    },
  })
  ledger.planApprovalState("plan.md", keyOf("a"), keyOf("b"), project, "p1")
  ledger.recordPlanApprovalDurable("plan.md", keyOf("a"), project)
  const rows = sharedRows(metricsDir)
  assert.ok(rows.length >= 3, "the scenario produced rows")
  for (const row of rows) assertChained(row, `row type ${row.type}`)
})
