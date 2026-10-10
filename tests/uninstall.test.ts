/**
 * @fileoverview Uninstall / removal-gating tests for the exported `removeEntry`
 * helper from scripts/install.mjs. It removes a path only when that path is
 * repo-owned (a symlink resolving into this checkout, or a ledger-recorded
 * copy) and otherwise leaves the target untouched (reporting it as left
 * alone). Each test builds its own temp directory and removes it on
 * completion; nothing is written outside the temp dir, and the only repo path
 * ever referenced is a symlink that merely points at a real file in the
 * checkout.
 */

import { test } from "node:test"
import assert from "node:assert/strict"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { fileURLToPath } from "node:url"

// @ts-expect-error TS7016: scripts/install.mjs is untyped JS; tests import
// removeEntry directly rather than spawning the CLI.
import { removeEntry } from "../scripts/install.mjs"

// Derive the repo root the same way install.mjs does, so a symlink created in
// this test resolves back into the same checkout that removeEntry/ownedByRepo
// keys off.
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")

/** Creates a fresh temp directory, registers its removal, and returns its path. */
function scratch(testCtx: { after: (fn: () => void) => void }): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "turnstile-uninstall-"))
  testCtx.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  return dir
}

/** Writes content at dest (creating parent dirs) and returns dest. */
function write(dest: string, content: string): string {
  fs.mkdirSync(path.dirname(dest), { recursive: true })
  fs.writeFileSync(dest, content)
  return dest
}

/** A ledger record shaped like a copy-mode install entry. */
function copyRecord(
  src: string,
  hash: string,
  version: string,
): {
  src: string
  hash: string
  version: string
  mode: "copy"
} {
  return { src, hash, version, mode: "copy" }
}

/** A repo-owned symlink: its target is a real file inside the checkout. */
function repoOwnedSymlink(dir: string): string {
  const target = path.join(repoRoot, "scripts/install.mjs")
  const link = path.join(dir, "plugins-link")
  fs.symlinkSync(target, link)
  return link
}

/** A symlink whose target resolves outside the checkout (foreign). */
function foreignSymlink(dir: string): string {
  const target = write(path.join(dir, "foreign-target"), "x")
  const link = path.join(dir, "foreign-link")
  fs.symlinkSync(target, link)
  return link
}

/** A repo-owned symlink is removed. */
test("removeEntry removes a repo-owned symlink", async (t) => {
  const dir = scratch(t)
  const link = repoOwnedSymlink(dir)
  assert.ok(fs.existsSync(link))
  const result = await removeEntry(link, { write: true }, {})
  assert.equal(result.acted, true)
  assert.equal(result.note, undefined)
  assert.equal(fs.existsSync(link), false)
})

/** A symlink pointing outside the repo is left alone. */
test("removeEntry leaves a foreign symlink alone", async (t) => {
  const dir = scratch(t)
  const link = foreignSymlink(dir)
  const result = await removeEntry(link, { write: true }, {})
  assert.equal(result.acted, false)
  assert.ok(result.note?.includes("not repo-owned"), `unexpected note: ${result.note}`)
  assert.equal(fs.existsSync(link), true)
})

/** A copy recorded in the ledger is removed, and the ledger entry is dropped. */
test("removeEntry removes a ledger-owned copy and deletes its ledger entry", async (t) => {
  const dir = scratch(t)
  const dest = write(path.join(dir, "plugins/turnstile.ts"), "content-v1")
  const ledger = { [dest]: copyRecord("turnstile.ts", "h", "0.1.0") }
  const result = await removeEntry(dest, { write: true }, ledger)
  assert.equal(result.acted, true)
  assert.equal(fs.existsSync(dest), false)
  assert.equal(ledger[dest], undefined)
})

/** An untracked file is left alone and its contents are preserved. */
test("removeEntry leaves an untracked file alone", async (t) => {
  const dir = scratch(t)
  const dest = write(path.join(dir, "untracked.txt"), "mine")
  const result = await removeEntry(dest, { write: true }, {})
  assert.equal(result.acted, false)
  assert.ok(result.note?.includes("left alone"), `unexpected note: ${result.note}`)
  assert.equal(fs.existsSync(dest), true)
  assert.equal(fs.readFileSync(dest, "utf8"), "mine")
})

/** A missing destination is a no-op with no note. */
test("removeEntry reports a no-op with no note for a missing destination", async (t) => {
  const dir = scratch(t)
  const dest = path.join(dir, "does-not-exist")
  const result = await removeEntry(dest, { write: true }, {})
  assert.equal(result.acted, false)
  assert.equal(result.note, undefined)
})

/** In report-only mode (write:false) a ledger-owned copy is reported but kept. */
test("removeEntry reports a ledger-owned copy as still present without removing it", async (t) => {
  const dir = scratch(t)
  const dest = write(path.join(dir, "plugins/turnstile.ts"), "content-v1")
  const ledger = { [dest]: copyRecord("turnstile.ts", "h", "0.1.0") }
  const result = await removeEntry(dest, { write: false }, ledger)
  assert.equal(result.acted, true)
  assert.ok(result.note?.includes("copy still present"), `unexpected note: ${result.note}`)
  assert.equal(fs.existsSync(dest), true)
  assert.deepEqual(ledger[dest], copyRecord("turnstile.ts", "h", "0.1.0")) // ledger entry retained in report-only mode
})

/** Removing twice is idempotent: the second call is a no-op. */
test("removeEntry is idempotent — a second removal is a no-op", async (t) => {
  const dir = scratch(t)
  const dest = write(path.join(dir, "plugins/turnstile.ts"), "content-v1")
  const ledger = { [dest]: copyRecord("turnstile.ts", "h", "0.1.0") }
  const first = await removeEntry(dest, { write: true }, ledger)
  assert.equal(first.acted, true)
  assert.equal(fs.existsSync(dest), false)
  const second = await removeEntry(dest, { write: true }, ledger)
  assert.equal(second.acted, false)
  assert.equal(second.note, undefined)
})
