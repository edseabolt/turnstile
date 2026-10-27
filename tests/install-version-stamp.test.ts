/**
 * @fileoverview Integration tests for the installer's ledger version-stamp
 * refresh: a content-identical destination whose ledger record carries a
 * stale (or legacy unset) version gets the stamp refreshed in place by
 * `init` and `--repair` (printed as `install: version stamp updated`),
 * while version-identical runs keep printing `install: up to date` and
 * `--check` (dry-run) still writes nothing. Every test spawns
 * scripts/install.mjs under a temp HOME via the shared harness
 * (install-harness.ts), so every ledger write is confined to a scratch
 * dir; no real ~/.config/opencode is ever touched.
 */

import { test } from "node:test"
import assert from "node:assert/strict"
import { readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"

import {
  DEST,
  SRC,
  destOf,
  freshScratch,
  ledgerOf,
  readLedger,
  repoRoot,
  singleEntryManifest,
  spawnInstaller,
} from "./install-harness.ts"

/** Current package version, read the same way install.mjs derives pkgVersion. */
const pkgVersion = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8"))
  .version as string

/**
 * Seeds a copy install by running the installer once, then rewriting the
 * ledger record's version to the given value (the same seeding pattern the
 * existing --check outdated test uses).
 * @param {string} home The temp HOME the installer writes under.
 * @param {string} manifest Path of the single-entry manifest.
 * @param {string | null} version The ledger version to seed.
 * @returns {void}
 */
function seedLedgerVersion(home: string, manifest: string, version: string | null): void {
  const first = spawnInstaller(["--manifest", manifest], { home })
  assert.equal(first.status, 0, first.stderr)
  const dest = destOf(home)
  const record = readLedger(ledgerOf(home))?.[dest]
  assert.ok(record, "the copy install must have recorded the entry")
  writeFileSync(ledgerOf(home), JSON.stringify({ [dest]: { ...record, version } }))
}

/** Apply: a content-identical file with a stale ledger version refreshes the stamp and clears the check warning. */
test("apply copy: a content-identical file with a stale ledger version refreshes the stamp and prints it", (t) => {
  const home = freshScratch(t)
  const manifest = singleEntryManifest(home, "copy", SRC, DEST)
  seedLedgerVersion(home, manifest, "0.0.1")
  const second = spawnInstaller(["--manifest", manifest], { home })
  assert.equal(second.status, 0, second.stderr)
  assert.match(second.stdout, /install: version stamp updated .*agents\/x \(was 0\.0\.1, now /)
  assert.equal(readLedger(ledgerOf(home))?.[destOf(home)]?.version, pkgVersion)
  const chk = spawnInstaller(["--manifest", manifest, "--check"], { home })
  assert.equal(chk.status, 0, chk.stderr)
  assert.doesNotMatch(chk.stdout, /outdated/)
})

/** Apply: version-identical content-identical runs keep `up to date` and never print a stamp line. */
test("apply copy: a version-identical second run keeps printing up to date with no stamp line", (t) => {
  const home = freshScratch(t)
  const manifest = singleEntryManifest(home, "copy", SRC, DEST)
  const first = spawnInstaller(["--manifest", manifest], { home })
  assert.equal(first.status, 0, first.stderr)
  const second = spawnInstaller(["--manifest", manifest], { home })
  assert.equal(second.status, 0, second.stderr)
  assert.match(second.stdout, /install: up to date .*agents\/x/)
  assert.doesNotMatch(second.stdout, /version stamp updated/)
})

/** Apply: a first install (no ledger record) installs normally with no stamp line. */
test("apply copy: a first install with no ledger record prints no version stamp line", (t) => {
  const home = freshScratch(t)
  const manifest = singleEntryManifest(home, "copy", SRC, DEST)
  const res = spawnInstaller(["--manifest", manifest], { home })
  assert.equal(res.status, 0, res.stderr)
  assert.match(res.stdout, /install: copy .*agents\/x/)
  assert.doesNotMatch(res.stdout, /version stamp updated/)
})

/** Apply: a legacy record with a null version is stamped with `was unset` wording. */
test("apply copy: a legacy null-version record is refreshed with was-unset wording", (t) => {
  const home = freshScratch(t)
  const manifest = singleEntryManifest(home, "copy", SRC, DEST)
  seedLedgerVersion(home, manifest, null)
  const second = spawnInstaller(["--manifest", manifest], { home })
  assert.equal(second.status, 0, second.stderr)
  assert.match(second.stdout, /install: version stamp updated .*agents\/x \(was unset, now /)
  assert.equal(readLedger(ledgerOf(home))?.[destOf(home)]?.version, pkgVersion)
})

/** Repair: an ok-continue with a stale stamp refreshes it, prints the line, and does not claim a change. */
test("repair copy: an up-to-date entry with a stale stamp is refreshed without a restart note", (t) => {
  const home = freshScratch(t)
  const manifest = singleEntryManifest(home, "copy", SRC, DEST)
  seedLedgerVersion(home, manifest, "0.0.1")
  const res = spawnInstaller(["--manifest", manifest, "--repair"], { home })
  assert.equal(res.status, 0, res.stderr)
  assert.match(res.stdout, /install: version stamp updated .*agents\/x \(was 0\.0\.1, now /)
  assert.equal(readLedger(ledgerOf(home))?.[destOf(home)]?.version, pkgVersion)
  assert.doesNotMatch(res.stdout, /restart OpenCode sessions/)
})

/** Check dry run: `--check --repair` still warns outdated and writes nothing to the ledger. */
test("check dry run: a stale stamp still warns outdated and the ledger is byte-identical", (t) => {
  const home = freshScratch(t)
  const manifest = singleEntryManifest(home, "copy", SRC, DEST)
  seedLedgerVersion(home, manifest, "0.0.1")
  const before = readFileSync(ledgerOf(home), "utf8")
  const res = spawnInstaller(["--manifest", manifest, "--check", "--repair"], { home })
  assert.equal(res.status, 0, res.stderr)
  assert.match(res.stdout, /check: outdated .*agents\/x/)
  assert.doesNotMatch(res.stdout, /version stamp updated/)
  assert.equal(readFileSync(ledgerOf(home), "utf8"), before)
})

/** Link mode: a second link run still prints `up to date` and never a stamp line. */
test("apply link: a second link-mode run prints up to date with no version stamp line", (t) => {
  const home = freshScratch(t)
  const manifest = singleEntryManifest(home, "link", SRC, DEST)
  const first = spawnInstaller(["--manifest", manifest], { home })
  assert.equal(first.status, 0, first.stderr)
  const second = spawnInstaller(["--manifest", manifest], { home })
  assert.equal(second.status, 0, second.stderr)
  assert.match(second.stdout, /install: up to date .*agents\/x/)
  assert.doesNotMatch(second.stdout, /version stamp updated/)
})
