/**
 * @fileoverview Spawns the install-agents CLI in --check mode against tmpdir
 * files and asserts the exit code and printed message. This closes the
 * composition gap the pure-helper suite leaves untested — readBlock()
 * parsing real template sentinels, main() wiring flags, exit codes reaching
 * the process — without changing script behavior. Pure helpers stay in
 * tests/install-agents.test.ts (still "no CLI spawn, no filesystem writes");
 * this file spawns with process.execPath (no shell, Windows-safe). Every
 * test is tmpdir-scoped via --file: nothing under ~/.config is read or
 * written, and --check performs zero writes in every state.
 */

import { test } from "node:test"
import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const START = "<!-- turnstile:start"
const END = "<!-- turnstile:end -->"

const root = join(dirname(fileURLToPath(import.meta.url)), "..")
const scriptPath = join(root, "scripts", "install-agents.mjs")

// Build the managed block exactly the way readBlock() (and the pure suite)
// do: slice START..END from the shipped template, then the trailing newline
// the script appends. Byte-equality with the template is what --check keys
// off, so the exact slice plus the "\n" is required for the synced-copy case.
const template = readFileSync(join(root, "templates", "global-AGENTS.md"), "utf8")
const block = template.slice(template.indexOf(START), template.indexOf(END) + END.length) + "\n"

/** Creates a fresh tmpdir and returns { dir, file }, where file does not exist. */
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "install-agents-check-"))
  return { dir, file: join(dir, "AGENTS.md") }
}

/** Spawns `node scripts/install-agents.mjs --check --file <file>` and returns the result. */
function runCheck(file: string) {
  return spawnSync(process.execPath, [scriptPath, "--check", "--file", file], { encoding: "utf8" })
}

test("synced copy: --check exits 0 printing check-agents: OK (file)", () => {
  const { file } = fixture()
  writeFileSync(file, block)
  const { status, stdout, stderr } = runCheck(file)
  assert.equal(status, 0, stderr)
  assert.match(stdout, /^check-agents: OK \(/)
  assert.equal(stderr, "")
})

test("doctored copy: --check exits 1 with the drift line on stderr", () => {
  const stale = block.replace("plan-reviewer", "reviewer")
  const { file } = fixture()
  writeFileSync(file, stale)
  const { status, stderr } = runCheck(file)
  assert.equal(status, 1)
  assert.match(stderr, /drift: the managed block in/)
  assert.match(stderr, /differs from the template/)
})

test("unmanaged file: --check exits 1 with the 'no managed contract block' line", () => {
  // Plain content matching neither a "turnstile" heading nor the pipeline-chain
  // signature: analyze() finds no legacy section and decides "append".
  const { file } = fixture()
  writeFileSync(file, "just some notes\n")
  const { status, stderr } = runCheck(file)
  assert.equal(status, 1)
  assert.match(stderr, /no managed contract block/)
})

test("--check performs zero writes: the file is byte-identical after the run", () => {
  const { dir, file } = fixture()
  writeFileSync(file, block)
  const before = readFileSync(file)
  const { status, stderr } = runCheck(file)
  assert.equal(status, 0, stderr)
  assert.deepEqual(readFileSync(file), before)

  // Still-absent case: --check on a nonexistent --file must not create it.
  const absent = join(dir, "absent.txt")
  const result = runCheck(absent)
  assert.equal(result.status, 1)
  assert.equal(existsSync(absent), false)
})

test("unknown flag: parseArgs exits 2 with 'unknown argument' on stderr", () => {
  const { file } = fixture()
  writeFileSync(file, block)
  const result = spawnSync(process.execPath, [scriptPath, "--check", "--file", file, "--bogus"], {
    encoding: "utf8",
  })
  assert.equal(result.status, 2)
  assert.match(result.stderr, /unknown argument/)
})
