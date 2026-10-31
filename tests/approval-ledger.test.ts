/**
 * @fileoverview Durable approved-plan sidecar tests: the bounded store records
 * project-scoped, scheme-tagged plan identities, looks them up by name and
 * content key under either key scheme (spec-region or legacy whole-file),
 * transparently re-keys a content-verified legacy record to the current
 * scheme (journaled `plan-rekey`), rewrites the file compacted when it evicts
 * past the cap, sanitizes hostile lines at boot (last-wins per project and
 * name), and fails open — journaling one `approval ledger:` error and rolling
 * back an unpersisted record — when the sidecar is unreadable or unwritable.
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

/** A recorded approval persists as a project-scoped, scheme-tagged sidecar
 *  record and matches back by name, key, and project. */
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
  assert.equal(
    ledger.planApprovalState(name, key, keyOf("b"), project),
    "live",
    "the record matches back",
  )
  const lines = fs.readFileSync(sidecar, "utf8").split("\n").filter(Boolean)
  assert.equal(lines.length, 1, "one sidecar line per record")
  const record = JSON.parse(lines[0]!) as {
    name: string
    key: string
    project: string
    scheme?: string
  }
  assert.equal(record.name, name, "the record keeps the plan name")
  assert.equal(record.key, key, "the record keeps the content key")
  assert.match(record.project, /^[0-9a-f]{16}$/, "the record carries the 16-hex project scope")
  assert.equal(record.scheme, "spec", "the record carries the current key-scheme tag")
  assert.equal(journalEntries(metricsDir).length, 0, "a successful record journals nothing")
})

/** Durable lookups classify on a different content key, an unrecorded name,
 *  and bad-shaped arguments. */
test("durable lookups classify a different key, an unrecorded name, or a bad shape", () => {
  const metricsDir = tmpDir()
  const project = tmpDir()
  const ledger = boot(metricsDir)
  const name = "plan.md"
  const key = keyOf("a")
  ledger.recordPlanApprovalDurable(name, key, project)
  assert.equal(
    ledger.planApprovalState(name, keyOf("b"), keyOf("c"), project),
    "stale-key",
    "a different content key leaves the record stale",
  )
  assert.equal(
    ledger.planApprovalState("other.md", key, keyOf("b"), project),
    "absent",
    "an unrecorded name is absent",
  )
  assert.equal(
    ledger.planApprovalState("a/b.md", key, keyOf("b"), project),
    "absent",
    "a bad-shaped name is absent",
  )
  assert.equal(
    ledger.planApprovalState(name, "zz", keyOf("b"), project),
    "absent",
    "a bad-shaped key is absent",
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
    ledger.planApprovalState(name, key, keyOf("b"), projectA),
    "live",
    "the recording project matches",
  )
  assert.equal(
    ledger.planApprovalState(name, key, keyOf("b"), projectB),
    "absent",
    "the same bytes under another project are absent",
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
    ledger.planApprovalState("n-0.md", key, keyOf("b"), project),
    "live",
    "the re-recorded entry stays most recent",
  )
  assert.equal(
    ledger.planApprovalState("n-1.md", key, keyOf("b"), project),
    "absent",
    "the true oldest entry is evicted",
  )
  assert.equal(
    ledger.planApprovalState("n-256.md", key, keyOf("b"), project),
    "live",
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
    restarted.planApprovalState("p-0.md", key, keyOf("b"), project),
    "absent",
    "the evicted record does not reload",
  )
  assert.equal(
    restarted.planApprovalState("p-1.md", key, keyOf("b"), project),
    "live",
    "older survivors reload",
  )
  assert.equal(
    restarted.planApprovalState("p-256.md", key, keyOf("b"), project),
    "live",
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
    JSON.stringify({ name: "a.md", key: keyOf("a"), project: scope, scheme: "spec" }),
    JSON.stringify({ name: "a.md", key: keyOf("b"), project: scope, scheme: "spec" }),
    JSON.stringify({ name: "b.md", key: keyOf("c"), project: scope, scheme: "spec" }),
  ]
  fs.writeFileSync(sidecarPath(metricsDir), `${lines.join("\n")}\n`)
  const ledger = boot(metricsDir)
  assert.equal(
    ledger.planApprovalState("a.md", keyOf("a"), keyOf("d"), project),
    "stale-key",
    "the earlier line loses",
  )
  assert.equal(
    ledger.planApprovalState("a.md", keyOf("b"), keyOf("d"), project),
    "live",
    "the later line wins",
  )
  assert.equal(
    ledger.planApprovalState("b.md", keyOf("c"), keyOf("d"), project),
    "live",
    "other names keep",
  )
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
    JSON.stringify({ name: "good.md", key, project: scope, scheme: "spec" }), // the one good record
  ]
  fs.writeFileSync(sidecarPath(metricsDir), `${lines.join("\n")}\n`)
  const ledger = boot(metricsDir)
  assert.equal(
    ledger.planApprovalState("good.md", key, keyOf("b"), project),
    "live",
    "a well-shaped line loads",
  )
  assert.equal(
    ledger.planApprovalState("ok.md", key, keyOf("b"), project),
    "absent",
    "a bad field shape sanitizes away",
  )
  assert.equal(
    ledger.planApprovalState("a/b.md", key, keyOf("b"), project),
    "absent",
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
    ledger.planApprovalState("plan.md", keyOf("a"), keyOf("b"), project),
    "absent",
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
    ledger.planApprovalState("plan.md", keyOf("a"), keyOf("b"), project),
    "absent",
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
 *  the in-memory store on boot: the oldest records do not load, the boot
 *  rewrites nothing (tagged records re-key nothing on probe). */
test("an over-cap sidecar file bounds the in-memory store on boot", () => {
  const metricsDir = tmpDir()
  const project = tmpDir()
  const scope = scopeOf(metricsDir, project)
  const key = keyOf("a")
  const lines = Array.from({ length: 300 }, (_, i) =>
    JSON.stringify({ name: `p-${i}.md`, key, project: scope, scheme: "spec" }),
  )
  fs.writeFileSync(sidecarPath(metricsDir), `${lines.join("\n")}\n`)
  const ledger = boot(metricsDir)
  assert.equal(
    ledger.planApprovalState("p-0.md", key, keyOf("b"), project),
    "absent",
    "the oldest records evict",
  )
  assert.equal(
    ledger.planApprovalState("p-43.md", key, keyOf("b"), project),
    "absent",
    "the 44th-oldest evicts",
  )
  assert.equal(
    ledger.planApprovalState("p-44.md", key, keyOf("b"), project),
    "live",
    "the newest 256 records load",
  )
  assert.equal(
    ledger.planApprovalState("p-299.md", key, keyOf("b"), project),
    "live",
    "the newest record loads",
  )
  const after = fs.readFileSync(sidecarPath(metricsDir), "utf8").split("\n").filter(Boolean)
  assert.equal(after.length, 300, "the boot and the probes rewrite nothing")
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
    ledger.planApprovalState("plan.md", keyOf("a"), keyOf("b"), project),
    "absent",
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

/**
 * The `plan-rekey` journal rows a metrics dir's journal holds.
 * @param metricsDir The metrics dir to read.
 * @returns The journaled plan-rekey entries.
 */
function rekeyRows(metricsDir: string): Array<Record<string, any>> {
  return journalEntries(metricsDir).filter((e) => e.type === "plan-rekey")
}

/**
 * Seeds a raw sidecar line (untrusted-input shape, as a pre-3.5 or deployed
 * writer would have left it) and boots a ledger over it.
 * @param metricsDir The temp metrics dir (the sidecar sits at its default
 *     path).
 * @param entry The record object to serialize as the single sidecar line.
 * @returns The booted ledger.
 */
function bootSeeded(metricsDir: string, entry: Record<string, unknown>): GateLedger {
  fs.writeFileSync(sidecarPath(metricsDir), `${JSON.stringify(entry)}\n`)
  return boot(metricsDir)
}

/** A legacy whole-file-keyed record (untagged) whose plan bytes are unchanged
 *  is honored live and transparently re-keyed: the sidecar gains the tagged
 *  spec record and the journal gains one plan-rekey row naming the plan, the
 *  reason, and both keys. */
test("a legacy whole-file record matching unchanged bytes is honored and re-keyed", () => {
  const metricsDir = tmpDir()
  const project = tmpDir()
  const scope = scopeOf(metricsDir, project)
  const specKey = keyOf("a")
  const wholeKey = keyOf("b")
  const ledger = bootSeeded(metricsDir, { name: "plan.md", key: wholeKey, project: scope })
  assert.equal(
    ledger.planApprovalState("plan.md", specKey, wholeKey, project, "p1"),
    "live",
    "the whole-file match proves the bytes unchanged",
  )
  const lines = fs.readFileSync(sidecarPath(metricsDir), "utf8").split("\n").filter(Boolean)
  assert.equal(lines.length, 2, "the re-key appends the tagged record")
  assert.deepEqual(
    JSON.parse(lines[1]!),
    { name: "plan.md", key: specKey, project: scope, scheme: "spec" },
    "the appended record carries the spec key and scheme tag",
  )
  const rekeys = rekeyRows(metricsDir)
  assert.equal(rekeys.length, 1, "one plan-rekey row")
  assert.equal(rekeys[0]!.sessionID, "p1", "the row carries the probing session")
  assert.equal(rekeys[0]!.plan, "plan.md")
  assert.equal(rekeys[0]!.reason, "durable-key-scheme")
  assert.equal(rekeys[0]!.from, wholeKey)
  assert.equal(rekeys[0]!.to, specKey)
})

/** A post-3.5 untagged spec-key record (the deployed shape) is live via the
 *  spec arm and normalized to the tagged shape on first touch. */
test("an untagged spec-key record is live and re-keyed to the tagged shape", () => {
  const metricsDir = tmpDir()
  const project = tmpDir()
  const scope = scopeOf(metricsDir, project)
  const specKey = keyOf("a")
  const ledger = bootSeeded(metricsDir, { name: "plan.md", key: specKey, project: scope })
  assert.equal(
    ledger.planApprovalState("plan.md", specKey, keyOf("b"), project, "p1"),
    "live",
    "the untagged spec key still matches",
  )
  const lines = fs.readFileSync(sidecarPath(metricsDir), "utf8").split("\n").filter(Boolean)
  assert.equal(lines.length, 2, "the re-key appends the tagged record")
  assert.deepEqual(JSON.parse(lines[1]!), {
    name: "plan.md",
    key: specKey,
    project: scope,
    scheme: "spec",
  })
  const rekeys = rekeyRows(metricsDir)
  assert.equal(rekeys.length, 1, "one plan-rekey row")
  assert.equal(rekeys[0]!.from, specKey, "the row records the unchanged key")
  assert.equal(rekeys[0]!.to, specKey)
})

/** An already-tagged spec match is a no-op: the sidecar bytes are unchanged
 *  and no journal row lands. */
test("an already-tagged spec match re-keys nothing", () => {
  const metricsDir = tmpDir()
  const project = tmpDir()
  const scope = scopeOf(metricsDir, project)
  const specKey = keyOf("a")
  const seeded = `${JSON.stringify({ name: "plan.md", key: specKey, project: scope, scheme: "spec" })}\n`
  fs.writeFileSync(sidecarPath(metricsDir), seeded)
  const ledger = boot(metricsDir)
  assert.equal(ledger.planApprovalState("plan.md", specKey, keyOf("b"), project, "p1"), "live")
  assert.equal(
    fs.readFileSync(sidecarPath(metricsDir), "utf8"),
    seeded,
    "the sidecar bytes are unchanged",
  )
  assert.equal(rekeyRows(metricsDir).length, 0, "no plan-rekey row")
  assert.equal(journalEntries(metricsDir).length, 0, "nothing journaled at all")
})

/** A legacy record whose plan was edited (neither key matches) is stale-key:
 *  no sidecar write and no journal row. */
test("a legacy record matching neither key is stale-key without writes", () => {
  const metricsDir = tmpDir()
  const project = tmpDir()
  const scope = scopeOf(metricsDir, project)
  const seeded = `${JSON.stringify({ name: "plan.md", key: keyOf("b"), project: scope })}\n`
  fs.writeFileSync(sidecarPath(metricsDir), seeded)
  const ledger = boot(metricsDir)
  assert.equal(
    ledger.planApprovalState("plan.md", keyOf("a"), keyOf("c"), project, "p1"),
    "stale-key",
    "neither scheme proves the spec region unchanged",
  )
  assert.equal(
    fs.readFileSync(sidecarPath(metricsDir), "utf8"),
    seeded,
    "a stale probe writes nothing",
  )
  assert.equal(rekeyRows(metricsDir).length, 0, "no plan-rekey row")
})

/** A bad-shaped whole key skips the legacy arm: a legacy record is stale-key
 *  even though its key would have matched a sanitized whole key. */
test("a bad-shaped whole key skips the legacy arm", () => {
  const metricsDir = tmpDir()
  const project = tmpDir()
  const scope = scopeOf(metricsDir, project)
  const ledger = bootSeeded(metricsDir, { name: "plan.md", key: keyOf("b"), project: scope })
  assert.equal(
    ledger.planApprovalState("plan.md", keyOf("a"), "zz", project),
    "stale-key",
    "the legacy arm never sees the bad shape",
  )
})

/** An unknown scheme value in a sidecar line degrades to the legacy shape:
 *  the dual-key match still applies, so the record is honored and re-keyed. */
test("an unknown scheme value is treated as legacy", () => {
  const metricsDir = tmpDir()
  const project = tmpDir()
  const scope = scopeOf(metricsDir, project)
  const specKey = keyOf("a")
  const wholeKey = keyOf("b")
  const ledger = bootSeeded(metricsDir, {
    name: "plan.md",
    key: wholeKey,
    project: scope,
    scheme: "whole",
  })
  assert.equal(
    ledger.planApprovalState("plan.md", specKey, wholeKey, project, "p1"),
    "live",
    "the unknown scheme behaves as legacy",
  )
  const lines = fs.readFileSync(sidecarPath(metricsDir), "utf8").split("\n").filter(Boolean)
  assert.deepEqual(JSON.parse(lines[lines.length - 1]!), {
    name: "plan.md",
    key: specKey,
    project: scope,
    scheme: "spec",
  })
})

/** A re-key persist failure fails open: the verdict keeps the content match
 *  (live), the in-memory record rolls back to the legacy shape (the next
 *  probe retries), exactly one persist error is journaled per attempt, and no
 *  plan-rekey row lands. */
test("a re-key persist failure rolls back and stays live", () => {
  const metricsDir = tmpDir()
  const project = tmpDir()
  const scope = scopeOf(metricsDir, project)
  const specKey = keyOf("a")
  const wholeKey = keyOf("b")
  const legacyLine = JSON.stringify({ name: "plan.md", key: wholeKey, project: scope })
  fs.writeFileSync(sidecarPath(metricsDir), `${legacyLine}\n`)
  const ledger = boot(metricsDir)
  // The sidecar becomes unwritable (a directory in its place) after boot.
  fs.rmSync(sidecarPath(metricsDir))
  fs.mkdirSync(sidecarPath(metricsDir))
  assert.equal(
    ledger.planApprovalState("plan.md", specKey, wholeKey, project, "p1"),
    "live",
    "the content match survives the failed persist",
  )
  assert.equal(rekeyRows(metricsDir).length, 0, "no plan-rekey row on failure")
  assert.equal(
    ledger.planApprovalState("plan.md", specKey, wholeKey, project, "p1"),
    "live",
    "the in-memory record rolled back to legacy (the re-key retries)",
  )
  const errors = approvalLedgerErrors(metricsDir)
  assert.equal(errors.length, 2, "one persist error per attempt")
  assert.match(errors[0]!.error, /^approval ledger: persist failed: /)
  assert.match(errors[1]!.error, /^approval ledger: persist failed: /)
  // Restore a readable sidecar holding the original legacy line: a fresh
  // ledger's store still holds the legacy record (nothing was persisted).
  fs.rmSync(sidecarPath(metricsDir), { recursive: true })
  fs.writeFileSync(sidecarPath(metricsDir), `${legacyLine}\n`)
  const fresh = boot(metricsDir)
  assert.equal(
    fresh.planApprovalState("plan.md", specKey, "", project),
    "stale-key",
    "the persisted record is still the legacy whole-file key",
  )
})

/** A session-less (or replay-invalid) re-key row omits the sessionID field:
 *  the row stays replay-inert either way. */
test("a session-less re-key row omits the sessionID", () => {
  const metricsDir = tmpDir()
  const project = tmpDir()
  const scope = scopeOf(metricsDir, project)
  const specKey = keyOf("a")
  const wholeKey = keyOf("b")
  fs.writeFileSync(
    sidecarPath(metricsDir),
    `${JSON.stringify({ name: "a.md", key: wholeKey, project: scope })}\n` +
      `${JSON.stringify({ name: "b.md", key: wholeKey, project: scope })}\n`,
  )
  const ledger = boot(metricsDir)
  assert.equal(ledger.planApprovalState("a.md", specKey, wholeKey, project), "live")
  assert.equal(ledger.planApprovalState("b.md", specKey, wholeKey, project, "bad sid!"), "live")
  const rekeys = rekeyRows(metricsDir)
  assert.equal(rekeys.length, 2, "one row per re-keyed record")
  assert.ok(!("sessionID" in rekeys[0]!), "the session-less row omits sessionID")
  assert.ok(!("sessionID" in rekeys[1]!), "the replay-invalid row omits sessionID")
})
