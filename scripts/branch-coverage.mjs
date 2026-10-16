#!/usr/bin/env node
/**
 * @fileoverview Branch-level coverage diagnostic for the turnstile test suite.
 *
 * The gated suite (`npm test`) is the coverage authority: node:test's built-in
 * V8 thresholds enforce 100% line/branch/function over `src/` +
 * `turnstile.ts`. This script exists only mid-edit, to localize a gap that
 * `npm test` has already flagged, in `file:line:col` plus a snippet form. A
 * zero span is a *candidate* gap — a real never-taken decision arm or a V8
 * reporting artifact — so findings are never treated as a work queue (see the
 * note printed when any survive).
 *
 * Node's built-in coverage report prints percentages and uncovered *lines*
 * only; the raw V8 JSON (via `NODE_V8_COVERAGE`) carries per-function *block*
 * ranges whose zero counts pinpoint exactly which decision never executed —
 * coverage.py-style arc diagnosis, derived from V8 block data.
 *
 * Usage: `node scripts/branch-coverage.mjs [test-file ...]`
 * Runs one process over all test files — the same
 * `node --test --experimental-strip-types --experimental-test-isolation=none` the gate uses
 * — with `NODE_V8_COVERAGE` pointed at a temp dir, then prints every
 * never-executed block inside a function that DID run, as
 * `file:line:col-line` plus a snippet. Exit 0 always.
 *
 * Merge semantics (the non-obvious part):
 * - A function instance is identified by `(functionName, root range)`; records
 *   for the same closure merge into one entry.
 * - V8 may record different block granularity for the same function across
 *   records (optimization feedback differs per run), so ranges merge by exact
 *   `(startOffset, endOffset)` span with max count. Never spread a coarse count
 *   across a finer record's blocks: a parent range's count is the
 *   *function/block entry* count, not evidence that nested blocks ran.
 * - A merged zero block is reported as a candidate gap whenever the whole
 *   function ran at least once (its root range has a positive count); a
 *   function whose root never ran is skipped (it shows as an uncovered line in
 *   the standard report anyway).
 */

import { spawnSync } from "node:child_process"
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

/** Builds per-file line-offset tables for snippet and position rendering. */
function loadSources(files) {
  const sources = {}
  for (const file of files) {
    try {
      const text = readFileSync(file, "utf8")
      const offsets = []
      let off = 0
      for (const line of text.split("\n")) {
        offsets.push(off)
        off += line.length + 1
      }
      sources[file] = { text, offsets }
    } catch {
      /* covered file may be outside this checkout; leave unknown */
    }
  }
  return sources
}

/** Converts a character offset to a `line:col` string via the offsets table. */
function toPos(source, offset) {
  let lo = 0
  let hi = source.offsets.length - 1
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1
    if (source.offsets[mid] <= offset) lo = mid
    else hi = mid - 1
  }
  return `${lo + 1}:${offset - source.offsets[lo] + 1}`
}

/** Converts a character offset to a 1-based line number. */
function toLine(source, offset) {
  return Number(toPos(source, offset).split(":")[0])
}

const args = process.argv.slice(2)
const testFiles = args.filter((a) => !a.startsWith("--"))
const files = testFiles.length
  ? testFiles
  : readdirSync("tests")
      .filter((f) => f.endsWith(".test.ts"))
      .map((f) => `tests/${f}`)
const covDir = mkdtempSync(join(tmpdir(), "branch-cov-"))

// One process, exactly like `npm test` under `--experimental-test-isolation=none`, so the
// V8 block data matches the gate's own accounting and the per-child fabricated
// zeros the old per-file spawn produced are gone by construction.
const result = spawnSync(
  process.execPath,
  ["--test", "--experimental-strip-types", "--experimental-test-isolation=none", ...files],
  {
    env: { ...process.env, NODE_V8_COVERAGE: covDir },
    stdio: ["ignore", "pipe", "pipe"],
    encoding: "utf8",
  },
)
const failures = result.status === 0 ? 0 : 1

const records = readdirSync(covDir).map((f) => JSON.parse(readFileSync(join(covDir, f), "utf8")))
rmSync(covDir, { recursive: true, force: true })

/** Normalizes a V8 URL to a filesystem path. */
const toFile = (url) => url.replace(/^file:\/\//, "")

/**
 * Merges one record's ranges into the accumulated span→maxCount map by exact
 * span. Identical spans across records take the max count (a block executed in
 * any record is covered); spans unique to one record are that record's own
 * block structure and are kept.
 * @param acc The accumulated `Map<"start:end", { startOffset, endOffset, count }>` for a function.
 * @param incoming One record's range list for that function.
 */
function mergeRanges(acc, incoming) {
  for (const r of incoming) {
    const key = `${r.startOffset}:${r.endOffset}`
    const prior = acc.get(key)
    if (prior) prior.count = Math.max(prior.count, r.count)
    else acc.set(key, { ...r })
  }
}

/** Merges all records: url → (function key → span map). */
const scripts = new Map()
for (const record of records) {
  for (const entry of record.result) {
    if (!entry.functions) continue
    let script = scripts.get(entry.url)
    if (!script) {
      script = new Map()
      scripts.set(entry.url, script)
    }
    for (const fn of entry.functions) {
      if (!fn.ranges) continue
      const key = `${fn.functionName}@${fn.ranges[0].startOffset}`
      const prior = script.get(key)
      if (!prior) {
        const spans = new Map()
        for (const r of fn.ranges) {
          spans.set(`${r.startOffset}:${r.endOffset}`, { ...r })
        }
        script.set(key, { spans })
      } else {
        mergeRanges(prior.spans, fn.ranges)
      }
    }
  }
}

const sources = loadSources([...scripts.keys()].map(toFile))
const findings = []
for (const [url, fns] of scripts) {
  const file = toFile(url)
  if (!/\/src\//.test(file) && !file.endsWith("turnstile.ts")) continue
  const source = sources[file]
  if (!source) continue
  for (const [key, { spans }] of fns) {
    const spanList = [...spans.values()]
    const root = spanList.find(
      (s) => s.startOffset === Math.min(...spanList.map((v) => v.startOffset)),
    )
    if (!root || root.count === 0) continue // whole function never ran in any record
    for (const span of spanList) {
      if (span.count !== 0) continue
      // Candidate gap only: a zero span inside a function that DID run. It may be
      // a real never-taken arm or a V8 artifact — `npm test` is the authority.
      const start = toPos(source, span.startOffset)
      const endLine = toLine(source, span.endOffset)
      const snippet = source.text.slice(span.startOffset, span.startOffset + 80).split("\n")[0]
      findings.push({ file, key: key.split("@")[0], start, endLine, snippet })
    }
  }
}
findings.sort(
  (a, b) =>
    a.file.localeCompare(b.file) || a.start.localeCompare(b.start, undefined, { numeric: true }),
)

console.log(`tests: ${files.length} files, child failures=${failures}`)
if (findings.length === 0) {
  console.log("branch coverage: every executed function's blocks are covered")
} else {
  console.log(`uncovered blocks: ${findings.length}`)
  for (const f of findings) {
    console.log(
      `  ${f.file.replace(/^.*turnstile\//, "")}:${f.start}-${f.endLine}  [${f.key}]  ${f.snippet}`,
    )
  }
  console.log("note: npm test is the gate; these are candidates to investigate, not work items.")
}
