#!/usr/bin/env node
/**
 * @fileoverview Branch-level coverage reporter for the turnstile test suite.
 *
 * Node's built-in coverage report prints percentages and uncovered *lines*
 * only; the raw V8 JSON (via `NODE_V8_COVERAGE`) carries per-function *block*
 * ranges whose zero counts pinpoint exactly which decision never executed —
 * coverage.py-style arc diagnosis, derived from V8 block data.
 *
 * Usage: `node scripts/branch-coverage.mjs [test-file ...]`
 * Runs each test file in its own child process (the same per-file isolation
 * `node --test` uses) with `NODE_V8_COVERAGE` pointed at a shared temp dir,
 * merges the V8 JSON across children, and prints every never-executed block
 * inside a function that DID run, as `file:line:col-line` plus a snippet.
 * Exit 0 always — this is a diagnostic, not a gate.
 *
 * Merge semantics (the non-obvious part — learned the hard way):
 * - A function instance is identified by `(functionName, root range)`; the
 *   same closure re-recorded in several children merges into one entry.
 * - V8 may record DIFFERENT block granularity for the same function across
 *   children (optimization feedback differs per run), so ranges merge by
 *   exact `(startOffset, endOffset)` span with max count. Never spread a
 *   coarse count across a finer record's blocks: a parent range's count is
 *   the *function/block entry* count, not evidence that nested blocks ran.
 * - A merged zero block is only reported when no child has a POSITIVE range
 *   contained within it (code inside it demonstrably ran somewhere). Coarse
 *   zero spans that contain proven-covered sub-blocks are pruned — they are
 *   lumping artifacts, not branch evidence. This fails toward less noise.
 * - Functions whose root never ran in any child are skipped (they show as
 *   uncovered lines in the standard report anyway).
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

// One child per test file — exactly how `node --test` runs them — so module
// state isolation matches the real suite and the union over children is the
// same union the standard report computes. All children share one
// NODE_V8_COVERAGE dir; records are merged below.
let failures = 0
for (const file of files) {
  const result = spawnSync(
    process.execPath,
    ["--test", "--experimental-strip-types", "--experimental-test-coverage", file],
    {
      env: { ...process.env, NODE_V8_COVERAGE: covDir },
      stdio: ["ignore", "pipe", "pipe"],
      encoding: "utf8",
    },
  )
  if (result.status !== 0) {
    failures++
    console.error(`${file}: child exited ${result.status}`)
  }
}

const records = readdirSync(covDir).map((f) => JSON.parse(readFileSync(join(covDir, f), "utf8")))
rmSync(covDir, { recursive: true, force: true })

/** Normalizes a V8 URL to a filesystem path. */
const toFile = (url) => url.replace(/^file:\/\//, "")

/**
 * Merges one child's ranges into the accumulated span→maxCount map by exact
 * span. Identical spans across children take the max count (a block executed
 * in any child is covered); spans unique to one child are that child's own
 * block structure and are kept for the containment pruning pass.
 * @param acc The accumulated `Map<"start:end", { startOffset, endOffset, count }>` for a function.
 * @param incoming One child's range list for that function.
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
        const positives = []
        for (const r of fn.ranges) {
          const k = `${r.startOffset}:${r.endOffset}`
          spans.set(k, { ...r })
          if (r.count > 0 && r !== fn.ranges[0]) positives.push({ ...r })
        }
        script.set(key, { spans, positives })
      } else {
        mergeRanges(prior.spans, fn.ranges)
        for (const r of fn.ranges) {
          if (r.count > 0 && r !== fn.ranges[0]) prior.positives.push({ ...r })
        }
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
  for (const [key, { spans, positives }] of fns) {
    const root = [...spans.values()].find(
      (s) => s.startOffset === Math.min(...[...spans.values()].map((v) => v.startOffset)),
    )
    if (!root || root.count === 0) continue // whole function never ran in any child
    for (const span of spans.values()) {
      if (span.count !== 0) continue
      // Prune lumping artifacts: a zero span that CONTAINS a proven-covered
      // sub-range from another child is not branch evidence.
      const containedPositive = positives.some(
        (p) =>
          p.startOffset >= span.startOffset &&
          p.endOffset <= span.endOffset &&
          !(p.startOffset === span.startOffset && p.endOffset === span.endOffset),
      )
      if (containedPositive) continue
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
}
