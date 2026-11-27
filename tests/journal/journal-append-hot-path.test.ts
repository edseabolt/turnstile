/**
 * @fileoverview Hot-path amortization tests for `appendLine`: the parent
 * directory is ensured once per process, the torn-tail repair runs once per
 * file per process, a vanished directory is re-ensured via the retry-once
 * path, and unwritable paths stay silent (fail-open).
 */

import { test } from "node:test"
import assert from "node:assert/strict"
import * as fs from "node:fs"
import * as path from "node:path"

import { appendLine } from "../src/journal/journal-sinks.ts"
import { tmpDir } from "./helpers.ts"

test("appendLine repairs the torn tail on the first write and not again", () => {
  const file = path.join(tmpDir(), "torn.jsonl")
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, '{"ts":"t"') // torn tail, no newline
  appendLine(file, "first")
  assert.equal(fs.readFileSync(file, "utf8"), '{"ts":"t"\nfirst\n') // repaired once
  fs.appendFileSync(file, '{"torn":') // simulate a new torn tail mid-session
  appendLine(file, "second")
  // NOT repaired again: the new torn tail merges onto the appended line.
  assert.match(fs.readFileSync(file, "utf8"), /\{"torn":second\n/)
})

test("appendLine re-ensures the directory when it disappears mid-session", () => {
  const dir = path.join(tmpDir(), "vanish")
  const file = path.join(dir, "j.jsonl")
  appendLine(file, "one")
  fs.rmSync(dir, { recursive: true })
  appendLine(file, "two")
  // rmSync removed the file with the directory; the retry recreates both.
  assert.equal(fs.readFileSync(file, "utf8"), "two\n")
})

test("appendLine still swallows an unwritable path (fail-open)", () => {
  const blocker = path.join(tmpDir(), "notadir")
  fs.writeFileSync(blocker, "x")
  appendLine(path.join(blocker, "child.jsonl"), "hello")
  assert.equal(fs.existsSync(path.join(blocker, "child.jsonl")), false)
})
