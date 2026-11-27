/**
 * @fileoverview Archive-on-rotate tests: the outgoing final generation is
 * gzip-archived into the sibling `archive/` directory by default
 * (`journalArchiveGenerations: 5`), with `0` as the explicit opt-out.
 * Covers the default-on and opt-out rotation paths, the retention bound,
 * same-millisecond name collisions, archive-write failure (fail-open), the
 * verify fold across archives (trust root at the archive boundary, tampered
 * archived rows fail), and the config validation arms.
 */

import { test } from "node:test"
import assert from "node:assert/strict"
import * as fs from "node:fs"
import * as path from "node:path"
import * as zlib from "node:zlib"

import { createJournaler } from "../src/journal/journal.ts"
import { verifyJournalChain } from "../src/journal/verify.ts"
import { defaultConfig, mergeConfig } from "../src/config/config.ts"
import { tmpDir } from "./helpers.ts"

/** Builds a journaler bound to a fresh temp metrics dir.
 *  @param opts Rotation and archive bounds plus the tamper-evidence cadence.
 *  @returns The journaler and its metrics dir. */
function journalerWith(opts: {
  maxBytes: number
  archiveGenerations: number
  rotateEveryEntries?: number
  maxGenerations?: number
  epochEntries?: number
}): { j: ReturnType<typeof createJournaler>; metricsDir: string } {
  const metricsDir = tmpDir()
  const j = createJournaler({
    metricsDir,
    trace: false,
    maxBytes: opts.maxBytes,
    maxGenerations: opts.maxGenerations ?? 5,
    archiveGenerations: opts.archiveGenerations,
    rotateEveryEntries: opts.rotateEveryEntries ?? 1,
    tamper: { enabled: true, epochEntries: opts.epochEntries ?? 512 },
  })
  return { j, metricsDir }
}

/** Reads a family's archive directory (fail-open for the opt-out case).
 *  @param metricsDir The metrics dir hosting the shared family.
 *  @returns The archive file names, sorted. */
function archiveNames(metricsDir: string): string[] {
  try {
    return fs.readdirSync(path.join(metricsDir, "archive")).sort()
  } catch {
    return []
  }
}

/** Gunzips one archive file into text.
 *  @param metricsDir The metrics dir hosting the shared family.
 *  @param name The archive file name.
 *  @returns The decompressed text. */
function archiveText(metricsDir: string, name: string): string {
  return zlib.gunzipSync(fs.readFileSync(path.join(metricsDir, "archive", name))).toString("utf8")
}

test("rotation archives the pruned generation by default", () => {
  const { j, metricsDir } = journalerWith({ maxBytes: 1, archiveGenerations: 5 })
  // Two rotations: the first prunes nothing (no `.5` yet) but the second
  // shifts `.1` up, so a later prune archives real generation content once
  // the cap is reached. Drive enough rotations to pass the cap.
  for (let i = 0; i < 6; i++) j.journal({ type: "tool", tool: "read", n: i })
  const archives = archiveNames(metricsDir)
  assert.ok(archives.length >= 1, "expected at least one archived generation")
  for (const name of archives) {
    assert.match(name, /\.jsonl\.\d+\.\d{15}-\d{3}\.gz$/, `archive name shape: ${name}`)
    const text = archiveText(metricsDir, name)
    assert.match(text, /"type":"tool"/, "archive holds journal rows")
  }
})

test("journalArchiveGenerations 0 restores prune-only behavior", () => {
  const { j, metricsDir } = journalerWith({ maxBytes: 1, archiveGenerations: 0 })
  for (let i = 0; i < 6; i++) j.journal({ type: "tool", tool: "read", n: i })
  assert.equal(fs.existsSync(path.join(metricsDir, "archive")), false)
  assert.ok(fs.existsSync(path.join(metricsDir, "turnstile.jsonl.1")), "rotation still ran")
})

test("the retention bound keeps exactly the newest archives", () => {
  const { j, metricsDir } = journalerWith({
    maxBytes: 1,
    archiveGenerations: 2,
    maxGenerations: 2,
  })
  for (let i = 0; i < 8; i++) j.journal({ type: "tool", tool: "read", n: i })
  const archives = archiveNames(metricsDir)
  assert.equal(archives.length, 2, `expected exactly 2 archives, got: ${archives.join(",")}`)
  // Lexicographic order is chronological: the kept pair are the two newest.
  const first = JSON.parse(archiveText(metricsDir, archives[0]!).trim().split("\n")[0]!) as {
    n?: number
  }
  assert.ok(typeof first.n === "number", "archived rows carry the journaled payload")
})

test("same-millisecond rotations get collision-bumped archive names", () => {
  const { j, metricsDir } = journalerWith({
    maxBytes: 1,
    archiveGenerations: 5,
    maxGenerations: 1,
  })
  // Every append rotates within the same millisecond: names must stay unique.
  for (let i = 0; i < 4; i++) j.journal({ type: "tool", tool: "read", n: i })
  const archives = archiveNames(metricsDir)
  assert.equal(new Set(archives).size, archives.length, "archive names are unique")
})

test("an archive-write failure never breaks rotation", () => {
  const { j, metricsDir } = journalerWith({ maxBytes: 1, archiveGenerations: 5 })
  // A file where the archive directory belongs blocks mkdir and the write.
  fs.writeFileSync(path.join(metricsDir, "archive"), "not a directory")
  assert.doesNotThrow(() => j.journal({ type: "tool", tool: "read" }))
  assert.ok(fs.existsSync(path.join(metricsDir, "turnstile.jsonl.1")), "rotation completed")
})

test("verify folds across archives with the trust root at the archive boundary", async () => {
  const { j, metricsDir } = journalerWith({
    maxBytes: 1,
    archiveGenerations: 5,
    maxGenerations: 2,
    epochEntries: 3,
  })
  for (let i = 0; i < 10; i++) j.journal({ type: "gate", n: i })
  j.anchor("task-complete")
  await new Promise((resolve) => setTimeout(resolve, 20))
  assert.ok(archiveNames(metricsDir).length >= 1, "rotations produced archives")
  const report = await verifyJournalChain({ metricsDir, sinks: [] })
  assert.equal(report.families[0]!.verdict.status, "ok")
})

test("a tampered archived row fails verify", async () => {
  const { j, metricsDir } = journalerWith({
    maxBytes: 1,
    archiveGenerations: 5,
    maxGenerations: 2,
    epochEntries: 3,
  })
  for (let i = 0; i < 10; i++) j.journal({ type: "gate", n: i })
  j.anchor("task-complete")
  await new Promise((resolve) => setTimeout(resolve, 20))
  const archives = archiveNames(metricsDir)
  assert.ok(archives.length >= 1, "rotations produced archives")
  // Flip one archived row's payload without re-hashing: the fold must see it.
  const target = path.join(metricsDir, "archive", archives[0]!)
  const rows = zlib.gunzipSync(fs.readFileSync(target)).toString("utf8").trim().split("\n")
  const first = JSON.parse(rows[0]!) as Record<string, unknown>
  rows[0] = JSON.stringify({ ...first, type: "edited" })
  fs.writeFileSync(target, zlib.gzipSync(rows.join("\n") + "\n"))
  const report = await verifyJournalChain({ metricsDir, sinks: [] })
  assert.equal(report.families[0]!.verdict.status, "broken")
})

test("a stale archive that cannot be deleted never breaks rotation", () => {
  const { j, metricsDir } = journalerWith({
    maxBytes: 1,
    archiveGenerations: 1,
    maxGenerations: 2,
  })
  // A directory in the archive slot sorts oldest, so the prune's unlink of
  // the surplus oldest archive fails (EISDIR/EPERM) — silently.
  const archiveDir = path.join(metricsDir, "archive")
  fs.mkdirSync(archiveDir, { recursive: true })
  fs.mkdirSync(path.join(archiveDir, "turnstile.jsonl.2.000000000000000-000.gz"))
  assert.doesNotThrow(() => {
    for (let i = 0; i < 3; i++) j.journal({ type: "tool", tool: "read", n: i })
  })
  assert.ok(fs.existsSync(path.join(metricsDir, "turnstile.jsonl.1")), "rotation completed")
  assert.ok(
    fs.existsSync(path.join(archiveDir, "turnstile.jsonl.2.000000000000000-000.gz")),
    "the undeletable archive stays",
  )
})

test("journalArchiveGenerations validates as a non-negative integer", () => {
  const base = defaultConfig({})
  assert.equal(base.journalArchiveGenerations, 5)
  const zero = mergeConfig(base, { journalArchiveGenerations: 0 })
  assert.deepEqual(zero.warnings, [])
  assert.equal(zero.config.journalArchiveGenerations, 0)
  const three = mergeConfig(base, { journalArchiveGenerations: 3 })
  assert.deepEqual(three.warnings, [])
  assert.equal(three.config.journalArchiveGenerations, 3)
  for (const bad of [-1, 1.5, "2", true]) {
    const { config, warnings } = mergeConfig(base, { journalArchiveGenerations: bad } as never)
    assert.deepEqual(warnings, [
      `config: invalid value for "journalArchiveGenerations"; keeping default`,
    ])
    assert.equal(config.journalArchiveGenerations, 5)
  }
})
