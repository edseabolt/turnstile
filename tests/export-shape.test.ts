/**
 * @fileoverview Export-shape tests: the module shape the OpenCode host
 * loads, the factory alias, and journal rotation mechanics.
 */

import { test } from "node:test"
import assert from "node:assert/strict"
import * as fs from "node:fs"
import * as path from "node:path"

import { rotateIfLarge } from "../src/journal.ts"
import turnstileModule, { turnstile } from "../turnstile.ts"
import { tmpDir } from "./helpers.ts"

/** The default export must have exactly the keys id, server, setup, with id "turnstile". */
test("default export has the frozen plugin shape", () => {
  assert.deepEqual(Object.keys(turnstileModule).sort(), ["id", "server", "setup"])
  assert.equal(turnstileModule.id, "turnstile")
  assert.equal(typeof turnstileModule.setup, "function")
})

/** The legacy v1 server shim must resolve to an empty object. */
test("server is a legacy shim returning an empty object", async () => {
  assert.deepEqual(await turnstileModule.server(), {})
})

/** The named factory export `turnstile` must remain a function. */
test("the named factory export is a function", () => {
  assert.equal(typeof turnstile, "function")
})

/** Under the size limit rotation must not fire and no generation file appears. */
test("rotateIfLarge no-ops when the file is within the size limit", () => {
  const dir = tmpDir()
  const file = path.join(dir, "j.jsonl")
  fs.writeFileSync(file, "line\n")
  rotateIfLarge(file, 1024, 5)
  assert.equal(fs.readFileSync(file, "utf8"), "line\n")
  assert.equal(fs.existsSync(`${file}.1`), false)
})

/** Oversize: the current file moves to .1 and the current path disappears. */
test("rotateIfLarge shifts the current file into generation .1", () => {
  const dir = tmpDir()
  const file = path.join(dir, "j.jsonl")
  fs.writeFileSync(file, "x".repeat(10))
  rotateIfLarge(file, 5, 5)
  assert.equal(fs.existsSync(file), false)
  assert.equal(fs.readFileSync(`${file}.1`, "utf8"), "x".repeat(10))
})

/** Generations beyond the cap shift down and the oldest is deleted. */
test("rotateIfLarge prunes the oldest generation beyond the cap", () => {
  const dir = tmpDir()
  const file = path.join(dir, "j.jsonl")
  fs.writeFileSync(file, "current")
  fs.writeFileSync(`${file}.1`, "gen1")
  fs.writeFileSync(`${file}.2`, "gen2")
  rotateIfLarge(file, 1, 2)
  assert.equal(fs.readFileSync(`${file}.1`, "utf8"), "current")
  assert.equal(fs.readFileSync(`${file}.2`, "utf8"), "gen1")
})
