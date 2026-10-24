/**
 * @fileoverview Durable approved-plan sidecar tests: the bounded store records
 * project-scoped plan identities, looks them up by name and content key,
 * rewrites the file compacted when it evicts past the cap, sanitizes hostile
 * lines at boot (last-wins per project and name), and fails open — journaling
 * one `approval ledger:` error and rolling back an unpersisted record — when
 * the sidecar is unreadable or unwritable.
 */

import { test } from "node:test"
import assert from "node:assert/strict"
import * as fs from "node:fs"
import * as path from "node:path"

import { createLedger, type GateLedger } from "../src/ledger.ts"
import { journalEntries, tmpDir } from "./helpers.ts"

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
 * Boots a ledger over a fresh temp metrics dir (empty journal), optionally
 * with an explicit sidecar path.
 * @param metricsDir The temp metrics dir.
 * @param sidecar Optional explicit sidecar path (default: beside the journal).
 * @returns The booted ledger.
 */
function boot(metricsDir: string, sidecar?: string): GateLedger {
  return createLedger(path.join(metricsDir, "turnstile.jsonl"), 64, 2000, sidecar)
}

/**
 * Records `count` consecutive plan approvals named `${prefix}-${from}.md` …
 * sharing one content key, under a project.
 * @param ledger The ledger to record into.
 * @param prefix The plan-name prefix.
 * @param from The first index in the sequence.
 * @param count The number of records.
 * @param projectDir The project directory to scope under.
 */
function recordMany(
  ledger: GateLedger,
  prefix: string,
  from: number,
  count: number,
  projectDir: string,
): void {
  const key = keyOf("a")
  for (let i = from; i < from + count; i++) {
    ledger.recordPlanApprovalDurable(`${prefix}-${i}.md`, key, projectDir)
  }
}

/**
 * Learns the sidecar's project scope token for a project by recording a probe
 * through the public API and reading it back from the sidecar file (the tests
 * never re-implement the hash).
 * @param metricsDir The temp metrics dir the probe ledger boots in.
 * @param projectDir The project directory whose scope token is learned.
 * @returns The 16-hex-char scope token stored for the project.
 */
function scopeOf(metricsDir: string, projectDir: string): string {
  const ledger = boot(metricsDir)
  ledger.recordPlanApprovalDurable("probe.md", keyOf("a"), projectDir)
  const lines = fs.readFileSync(sidecarPath(metricsDir), "utf8").split("\n").filter(Boolean)
  return (JSON.parse(lines[lines.length - 1]!) as { project: string }).project
}

/**
 * The `approval ledger:` error entries a metrics dir's journal holds.
 * @param metricsDir The metrics dir to read.
 * @returns The journaled approval-ledger error entries.
 */
function approvalLedgerErrors(metricsDir: string): Array<Record<string, any>> {
  return journalEntries(metricsDir).filter(
    (e) =>
      e.type === "error" && typeof e.error === "string" && e.error.startsWith("approval ledger: "),
  )
}

/** A recorded approval persists as a project-scoped sidecar record and
 *  matches back by name, key, and project. */
test("a recorded approval persists as a project-scoped sidecar record", () => {
  const metricsDir = tmpDir()
  const project = tmpDir()
  // An explicit sidecar path under a not-yet-existing parent: the record must
  // create the parent and land the record there.
  const sidecar = path.join(metricsDir, "nested", "approved-plans.jsonl")
  const ledger = boot(metricsDir, sidecar)
  const name = "issue-plan.md"
  const key = keyOf("a")
  ledger.recordPlanApprovalDurable(name, key, project)
  assert.equal(ledger.isPlanApprovalDurable(name, key, project), true, "the record matches back")
  const lines = fs.readFileSync(sidecar, "utf8").split("\n").filter(Boolean)
  assert.equal(lines.length, 1, "one sidecar line per record")
  const record = JSON.parse(lines[0]!) as { name: string; key: string; project: string }
  assert.equal(record.name, name, "the record keeps the plan name")
  assert.equal(record.key, key, "the record keeps the content key")
  assert.match(record.project, /^[0-9a-f]{16}$/, "the record carries the 16-hex project scope")
  assert.equal(journalEntries(metricsDir).length, 0, "a successful record journals nothing")
})

/** Durable lookups miss on a different content key, an unrecorded name, and
 *  bad-shaped arguments. */
test("durable lookups miss on a different key, an unrecorded name, or a bad shape", () => {
  const metricsDir = tmpDir()
  const project = tmpDir()
  const ledger = boot(metricsDir)
  const name = "plan.md"
  const key = keyOf("a")
  ledger.recordPlanApprovalDurable(name, key, project)
  assert.equal(
    ledger.isPlanApprovalDurable(name, keyOf("b"), project),
    false,
    "a different content key does not match",
  )
  assert.equal(
    ledger.isPlanApprovalDurable("other.md", key, project),
    false,
    "an unrecorded name does not match",
  )
  assert.equal(
    ledger.isPlanApprovalDurable("a/b.md", key, project),
    false,
    "a bad-shaped name does not match",
  )
  assert.equal(
    ledger.isPlanApprovalDurable(name, "zz", project),
    false,
    "a bad-shaped key does not match",
  )
})

/** Bad-shaped record arguments are dropped before any file access: no
 *  sidecar file appears and nothing is journaled. */
test("bad-shaped record arguments are dropped without any file write", () => {
  const metricsDir = tmpDir()
  const project = tmpDir()
  const ledger = boot(metricsDir)
  ledger.recordPlanApprovalDurable("a/b.md", keyOf("a"), project)
  ledger.recordPlanApprovalDurable("plan.md", "zz", project)
  assert.equal(fs.existsSync(sidecarPath(metricsDir)), false, "no sidecar file is created")
  assert.equal(journalEntries(metricsDir).length, 0, "a dropped record journals nothing")
})

/** A durable approval is scoped to the project it was recorded under: the
 *  same name and content under another project do not match. */
test("a durable approval is scoped to the project it was recorded under", () => {
  const metricsDir = tmpDir()
  const projectA = tmpDir()
  const projectB = tmpDir()
  const ledger = boot(metricsDir)
  const name = "plan.md"
  const key = keyOf("a")
  ledger.recordPlanApprovalDurable(name, key, projectA)
  assert.equal(
    ledger.isPlanApprovalDurable(name, key, projectA),
    true,
    "the recording project matches",
  )
  assert.equal(
    ledger.isPlanApprovalDurable(name, key, projectB),
    false,
    "the same bytes under another project do not match",
  )
})

/** A re-record refreshes the entry's recency, and the first over-cap record
 *  evicts the true oldest entry and rewrites the sidecar compacted to the
 *  cap. */
test("a re-record refreshes recency and eviction rewrites the sidecar compacted", () => {
  const metricsDir = tmpDir()
  const project = tmpDir()
  const ledger = boot(metricsDir)
  const key = keyOf("a")
  ledger.recordPlanApprovalDurable("n-0.md", key, project)
  recordMany(ledger, "n", 1, 255, project) // n-1..n-255: the store holds 256 records
  ledger.recordPlanApprovalDurable("n-0.md", key, project) // re-record: n-0 becomes most recent
  ledger.recordPlanApprovalDurable("n-256.md", key, project) // 257th record: evict + rewrite
  assert.equal(
    ledger.isPlanApprovalDurable("n-0.md", key, project),
    true,
    "the re-recorded entry stays most recent",
  )
  assert.equal(
    ledger.isPlanApprovalDurable("n-1.md", key, project),
    false,
    "the true oldest entry is evicted",
  )
  assert.equal(
    ledger.isPlanApprovalDurable("n-256.md", key, project),
    true,
    "the new record matches",
  )
  const lines = fs.readFileSync(sidecarPath(metricsDir), "utf8").split("\n").filter(Boolean)
  assert.equal(lines.length, 256, "the sidecar is rewritten compacted to the cap")
})

/** The compacted file reloads after a restart: the evicted record stays gone
 *  and the boot does not rewrite an already-compacted file. */
test("an evicted store reloads compacted after a restart", () => {
  const metricsDir = tmpDir()
  const project = tmpDir()
  const ledger = boot(metricsDir)
  const key = keyOf("a")
  recordMany(ledger, "p", 0, 257, project) // p-0..p-256: evicts p-0 and rewrites
  const restarted = boot(metricsDir)
  assert.equal(
    restarted.isPlanApprovalDurable("p-0.md", key, project),
    false,
    "the evicted record does not reload",
  )
  assert.equal(
    restarted.isPlanApprovalDurable("p-1.md", key, project),
    true,
    "older survivors reload",
  )
  assert.equal(
    restarted.isPlanApprovalDurable("p-256.md", key, project),
    true,
    "the newest record reloads",
  )
  const lines = fs.readFileSync(sidecarPath(metricsDir), "utf8").split("\n").filter(Boolean)
  assert.equal(lines.length, 256, "the boot does not rewrite an already-compacted file")
})

/** The boot load is last-wins per project and plan name: a later line for
 *  the same identity replaces the earlier one, and other names keep. */
test("the boot load is last-wins per project and plan name", () => {
  const metricsDir = tmpDir()
  const project = tmpDir()
  const scope = scopeOf(metricsDir, project)
  const lines = [
    JSON.stringify({ name: "a.md", key: keyOf("a"), project: scope }),
    JSON.stringify({ name: "a.md", key: keyOf("b"), project: scope }),
    JSON.stringify({ name: "b.md", key: keyOf("c"), project: scope }),
  ]
  fs.writeFileSync(sidecarPath(metricsDir), `${lines.join("\n")}\n`)
  const ledger = boot(metricsDir)
  assert.equal(
    ledger.isPlanApprovalDurable("a.md", keyOf("a"), project),
    false,
    "the earlier line loses",
  )
  assert.equal(
    ledger.isPlanApprovalDurable("a.md", keyOf("b"), project),
    true,
    "the later line wins",
  )
  assert.equal(ledger.isPlanApprovalDurable("b.md", keyOf("c"), project), true, "other names keep")
})

/** Every malformation the sidecar can hold (bad JSON, non-objects, bad
 *  field shapes, empty lines) sanitizes away; well-shaped lines still load,
 *  and line sanitization journals nothing. */
test("malformed sidecar lines sanitize away while well-shaped lines load", () => {
  const metricsDir = tmpDir()
  const project = tmpDir()
  const scope = scopeOf(metricsDir, project)
  const key = keyOf("a")
  const lines = [
    "{not json",
    "[1,2]",
    '"str"',
    "42",
    "null",
    JSON.stringify({ name: "a/b.md", key, project: scope }), // a path in the name
    JSON.stringify({ name: "ok.md", key: "zz", project: scope }), // a non-hex key
    JSON.stringify({ name: "ok.md", key, project: "zz" }), // a bad scope token
    JSON.stringify({ name: "ok.md", key }), // a missing scope field
    "", // an empty line
    JSON.stringify({ name: "good.md", key, project: scope }), // the one good record
  ]
  fs.writeFileSync(sidecarPath(metricsDir), `${lines.join("\n")}\n`)
  const ledger = boot(metricsDir)
  assert.equal(
    ledger.isPlanApprovalDurable("good.md", key, project),
    true,
    "a well-shaped line loads",
  )
  assert.equal(
    ledger.isPlanApprovalDurable("ok.md", key, project),
    false,
    "a bad field shape sanitizes away",
  )
  assert.equal(
    ledger.isPlanApprovalDurable("a/b.md", key, project),
    false,
    "a bad name sanitizes away",
  )
  assert.equal(approvalLedgerErrors(metricsDir).length, 0, "line sanitization journals nothing")
})

/** A missing sidecar is the fresh-install state: an empty store, no file
 *  created, and nothing journaled. */
test("a missing sidecar loads an empty store without journaling", () => {
  const metricsDir = tmpDir()
  const project = tmpDir()
  const ledger = boot(metricsDir)
  assert.equal(
    ledger.isPlanApprovalDurable("plan.md", keyOf("a"), project),
    false,
    "nothing is durable on a fresh install",
  )
  assert.equal(
    fs.existsSync(sidecarPath(metricsDir)),
    false,
    "the boot does not create the sidecar",
  )
  assert.equal(journalEntries(metricsDir).length, 0, "a missing sidecar journals nothing")
})

/** An unreadable sidecar (a directory in place of the file) fails open:
 *  the store stays empty and exactly one error is journaled. */
test("an unreadable sidecar fails open with one journaled error", () => {
  const metricsDir = tmpDir()
  const project = tmpDir()
  fs.mkdirSync(sidecarPath(metricsDir)) // a directory where the file belongs
  const ledger = boot(metricsDir)
  assert.equal(
    ledger.isPlanApprovalDurable("plan.md", keyOf("a"), project),
    false,
    "the store stays empty",
  )
  const errors = approvalLedgerErrors(metricsDir)
  assert.equal(errors.length, 1, "exactly one error entry")
  assert.match(
    errors[0]!.error,
    /^approval ledger: read failed: /,
    "the entry names the read failure",
  )
})

/** An over-cap sidecar file (more valid lines than the cap) still bounds
 *  the in-memory store on boot: the oldest records do not load. */
test("an over-cap sidecar file bounds the in-memory store on boot", () => {
  const metricsDir = tmpDir()
  const project = tmpDir()
  const scope = scopeOf(metricsDir, project)
  const key = keyOf("a")
  const lines = Array.from({ length: 300 }, (_, i) =>
    JSON.stringify({ name: `p-${i}.md`, key, project: scope }),
  )
  fs.writeFileSync(sidecarPath(metricsDir), `${lines.join("\n")}\n`)
  const ledger = boot(metricsDir)
  assert.equal(
    ledger.isPlanApprovalDurable("p-0.md", key, project),
    false,
    "the oldest records evict",
  )
  assert.equal(
    ledger.isPlanApprovalDurable("p-43.md", key, project),
    false,
    "the 44th-oldest evicts",
  )
  assert.equal(
    ledger.isPlanApprovalDurable("p-44.md", key, project),
    true,
    "the newest 256 records load",
  )
  assert.equal(
    ledger.isPlanApprovalDurable("p-299.md", key, project),
    true,
    "the newest record loads",
  )
})

/** An unwritable sidecar never throws: the failed persist journals one
 *  error and the record rolls back, so the approval does not exempt
 *  in-process. */
test("an unwritable sidecar rolls the record back and journals one error", () => {
  const metricsDir = tmpDir()
  const project = tmpDir()
  fs.mkdirSync(sidecarPath(metricsDir)) // a directory: the append must fail
  const ledger = boot(metricsDir)
  assert.equal(approvalLedgerErrors(metricsDir).length, 1, "the boot journals one read error")
  ledger.recordPlanApprovalDurable("plan.md", keyOf("a"), project) // must not throw
  assert.equal(
    ledger.isPlanApprovalDurable("plan.md", keyOf("a"), project),
    false,
    "an unpersisted record rolls back",
  )
  const errors = approvalLedgerErrors(metricsDir)
  assert.equal(errors.length, 2, "the failed persist journals one more error")
  assert.match(
    errors[1]!.error,
    /^approval ledger: persist failed: /,
    "the second entry names the persist failure",
  )
})
