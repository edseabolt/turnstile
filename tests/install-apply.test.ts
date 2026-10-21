/**
 * @fileoverview Integration tests for the installer's apply (install) core:
 * link vs copy installs, ledger decisions (record, prune, adopt,
 * idempotence), backup-on-conflict, stale/foreign symlink handling, retired
 * cleanup, and the --check report codes. Every test spawns
 * scripts/install.mjs under a temp HOME via the shared harness
 * (install-harness.ts), so every link/copy/ledger write is confined to a
 * scratch dir; no real ~/.config/opencode is ever touched.
 */

import { test } from "node:test"
import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from "node:fs"
import { dirname, join } from "node:path"
import type { TestContext } from "node:test"

import {
  DEST,
  SRC,
  destOf,
  freshScratch,
  homePath,
  ledgerOf,
  readLedger,
  repoRoot,
  singleEntryManifest,
  spawnInstaller,
  writeManifest,
} from "./install-harness.ts"

/** sha256 hex of a file's content, mirroring the installer's hashContent. */
function sha256(file: string): string {
  return createHash("sha256").update(readFileSync(file, "utf8")).digest("hex")
}

/**
 * Installs one entry as a copy, then edits the installed file so a later
 * run sees a post-install edit (a conflict). Returns the paths the
 * conflict tests need.
 * @param {TestContext} t The node:test context of the calling test.
 * @returns {{ home: string, manifest: string, dest: string, ledgerPath: string, edited: string }} Fixture paths.
 */
function seededCopyConflict(t: TestContext): {
  home: string
  manifest: string
  dest: string
  ledgerPath: string
  edited: string
} {
  const home = freshScratch(t)
  const manifest = singleEntryManifest(home, "copy", SRC, DEST)
  const first = spawnInstaller(["--manifest", manifest], { home })
  assert.equal(first.status, 0, first.stderr)
  const dest = destOf(home)
  const edited = "USER EDITED"
  writeFileSync(dest, edited)
  return { home, manifest, dest, ledgerPath: ledgerOf(home), edited }
}

/** A link install creates a symlink to the repo source and prints the restart note. */
test("apply link: creates a symlink to the repo source and exits 0", (t) => {
  const home = freshScratch(t)
  const manifest = singleEntryManifest(home, "link", SRC, DEST)
  const res = spawnInstaller(["--manifest", manifest], { home })
  assert.equal(res.status, 0, res.stderr)
  assert.match(res.stdout, /install: link .*agents\/x/)
  assert.match(res.stdout, /restart OpenCode sessions/)
  assert.equal(realpathSync(destOf(home)), join(repoRoot, SRC))
})

/** A second link install is a no-op: up to date, no restart note, exit 0. */
test("apply link: a second run is up to date and skips the restart note", (t) => {
  const home = freshScratch(t)
  const manifest = singleEntryManifest(home, "link", SRC, DEST)
  const first = spawnInstaller(["--manifest", manifest], { home })
  assert.equal(first.status, 0, first.stderr)
  const second = spawnInstaller(["--manifest", manifest], { home })
  assert.equal(second.status, 0, second.stderr)
  assert.match(second.stdout, /install: up to date .*agents\/x/)
  assert.doesNotMatch(second.stdout, /restart OpenCode sessions/)
})

/** A link install prunes a pre-seeded ledger record for its dest and persists the ledger. */
test("apply link: prunes a pre-seeded stale ledger record and persists it", (t) => {
  const home = freshScratch(t)
  const manifest = singleEntryManifest(home, "link", SRC, DEST)
  const dest = destOf(home)
  writeFileSync(
    ledgerOf(home),
    JSON.stringify({ [dest]: { src: SRC, hash: "abc", version: "9.9.9", mode: "copy" } }),
  )
  const res = spawnInstaller(["--manifest", manifest], { home })
  assert.equal(res.status, 0, res.stderr)
  assert.match(res.stdout, /install: link .*agents\/x/)
  assert.deepEqual(readLedger(ledgerOf(home)), {})
})

/** A copy install writes the source content and records src/hash/version/mode in the ledger. */
test("apply copy: records repo-relative src, sha256 hash, package version, and mode", (t) => {
  const home = freshScratch(t)
  const manifest = singleEntryManifest(home, "copy", SRC, DEST)
  const res = spawnInstaller(["--manifest", manifest], { home })
  assert.equal(res.status, 0, res.stderr)
  assert.match(res.stdout, /install: copy .*agents\/x/)
  const src = join(repoRoot, SRC)
  assert.equal(readFileSync(destOf(home), "utf8"), readFileSync(src, "utf8"))
  const pkg = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8")) as {
    version: string
  }
  assert.deepEqual(readLedger(ledgerOf(home)), {
    [destOf(home)]: { src: SRC, hash: sha256(src), version: pkg.version, mode: "copy" },
  })
})

/** A second copy install is a no-op and leaves the ledger semantically identical. */
test("apply copy: a second run is up to date and the ledger is unchanged", (t) => {
  const home = freshScratch(t)
  const manifest = singleEntryManifest(home, "copy", SRC, DEST)
  const first = spawnInstaller(["--manifest", manifest], { home })
  assert.equal(first.status, 0, first.stderr)
  const before = readLedger(ledgerOf(home))
  assert.ok(before, "the first run must have recorded the entry")
  const second = spawnInstaller(["--manifest", manifest], { home })
  assert.equal(second.status, 0, second.stderr)
  assert.match(second.stdout, /install: up to date .*agents\/x/)
  assert.deepEqual(readLedger(ledgerOf(home)), before)
})

/** A dest whose bytes match the source and has no ledger record is adopted and recorded. */
test("apply copy: adopts an identical unrecorded dest and records it", (t) => {
  const home = freshScratch(t)
  const manifest = singleEntryManifest(home, "copy", SRC, DEST)
  const dest = destOf(home)
  mkdirSync(dirname(dest), { recursive: true })
  writeFileSync(dest, readFileSync(join(repoRoot, SRC), "utf8"))
  const res = spawnInstaller(["--manifest", manifest], { home })
  assert.equal(res.status, 0, res.stderr)
  assert.match(res.stdout, /install: copy .*agents\/x/)
  const record = readLedger(ledgerOf(home))?.[dest]
  assert.ok(record, "the adopted entry must be recorded")
  assert.equal(record.mode, "copy")
  assert.equal(record.hash, sha256(join(repoRoot, SRC)))
})

/** A post-install edit is a conflict without --force: exit 1, nothing re-copied, ledger content unchanged. */
test("apply copy: a post-install edit conflicts without --force and touches nothing", (t) => {
  const { home, manifest, dest, ledgerPath, edited } = seededCopyConflict(t)
  const before = readLedger(ledgerPath)
  assert.ok(before, "the seed install must have recorded the entry")
  const res = spawnInstaller(["--manifest", manifest], { home })
  assert.equal(res.status, 1)
  assert.match(res.stderr, /agents\/x/)
  assert.match(res.stderr, /--force/)
  assert.equal(readFileSync(dest, "utf8"), edited)
  // apply re-saves the ledger even when a run fails, so compare parsed content
  assert.deepEqual(readLedger(ledgerPath), before)
})

/** With --force the edited copy is backed up to <dest>.bak.<stamp> and the repo source re-copied. */
test("apply copy: --force backs up the edited copy and re-copies the repo source", (t) => {
  const { home, manifest, dest, ledgerPath, edited } = seededCopyConflict(t)
  const res = spawnInstaller(["--manifest", manifest, "--force"], { home })
  assert.equal(res.status, 0, res.stderr)
  const backup = res.stdout.match(/backed up to (\S+\.bak\.\d{14})/)?.[1]
  assert.ok(backup, `expected a backup note, got: ${res.stdout}`)
  assert.match(backup, /\.bak\.\d{14}$/)
  assert.ok(existsSync(backup), "the backup file must exist")
  assert.equal(readFileSync(backup, "utf8"), edited)
  assert.equal(readFileSync(dest, "utf8"), readFileSync(join(repoRoot, SRC), "utf8"))
  const record = readLedger(ledgerPath)?.[dest]
  assert.equal(record?.hash, sha256(join(repoRoot, SRC)))
})

/** A repo-owned link pointing at the wrong repo file is relinked without --force. */
test("apply link: a repo-owned stale link is relinked without --force", (t) => {
  const home = freshScratch(t)
  const manifest = singleEntryManifest(home, "link", SRC, DEST)
  const dest = destOf(home)
  mkdirSync(dirname(dest), { recursive: true })
  symlinkSync(join(repoRoot, "scripts/install.mjs"), dest)
  const res = spawnInstaller(["--manifest", manifest], { home })
  assert.equal(res.status, 0, res.stderr)
  assert.match(res.stdout, /install: link .*agents\/x/)
  assert.equal(realpathSync(dest), join(repoRoot, SRC))
})

/** A symlink pointing outside the repo is a conflict: untouched without --force, replaced with it. */
test("apply link: a foreign symlink is a conflict without --force, replaced with it", (t) => {
  const home = freshScratch(t)
  const manifest = singleEntryManifest(home, "link", SRC, DEST)
  const dest = destOf(home)
  const foreign = homePath(home, "foreign.txt")
  mkdirSync(dirname(dest), { recursive: true })
  writeFileSync(foreign, "not the repo")
  symlinkSync(foreign, dest)
  const plain = spawnInstaller(["--manifest", manifest], { home })
  assert.equal(plain.status, 1)
  assert.match(plain.stderr, /conflict/)
  assert.match(plain.stderr, /--force/)
  assert.equal(readlinkSync(dest), foreign, "the foreign symlink must be untouched")
  const forced = spawnInstaller(["--manifest", manifest, "--force"], { home })
  assert.equal(forced.status, 0, forced.stderr)
  const backup = forced.stdout.match(/backed up to (\S+\.bak\.\d{14})/)?.[1]
  assert.ok(backup, `expected a backup note, got: ${forced.stdout}`)
  assert.ok(lstatSync(backup).isSymbolicLink(), "the backup must be the displaced symlink")
  assert.equal(readlinkSync(backup), foreign)
  assert.equal(realpathSync(dest), join(repoRoot, SRC))
})

/** A manifest src missing from the repo is an invalid entry: exit 1, stderr names it. */
test("apply: a manifest src missing from the repo fails with source missing", (t) => {
  const home = freshScratch(t)
  const manifest = singleEntryManifest(home, "copy", "does/not/exist.mjs", DEST)
  const res = spawnInstaller(["--manifest", manifest], { home })
  assert.equal(res.status, 1)
  assert.match(res.stderr, /source missing/)
})

/** Retired cleanup: a repo-owned leftover is removed; a foreign one is left with a note. */
test("apply: removes a repo-owned retired leftover and leaves a foreign one", (t) => {
  const home = freshScratch(t)
  const foreign = homePath(home, "foreign.txt")
  writeFileSync(foreign, "not the repo")
  const retiredRepo = homePath(home, ".config/opencode/plugin/old.ts")
  const retiredForeign = homePath(home, ".config/opencode/plugin/stray.ts")
  mkdirSync(dirname(retiredRepo), { recursive: true })
  symlinkSync(join(repoRoot, "scripts/install.mjs"), retiredRepo)
  symlinkSync(foreign, retiredForeign)
  const manifest = writeManifest(home, {
    mode: "link",
    ledger: "~/ledger.json",
    retired: ["~/.config/opencode/plugin/old.ts", "~/.config/opencode/plugin/stray.ts"],
  })
  const res = spawnInstaller(["--manifest", manifest], { home })
  assert.equal(res.status, 0, res.stderr)
  assert.match(res.stdout, /install: removed retired .*plugin\/old\.ts/)
  assert.match(res.stdout, /install: retired .*plugin\/stray\.ts — symlink not repo-owned/)
  assert.equal(existsSync(retiredRepo), false)
  assert.equal(readlinkSync(retiredForeign), foreign)
})

/** A matching install checks OK; a ledger version older than the package is advisory and still OK. */
test("--check: OK for a matching install; an older ledger version stays exit 0", (t) => {
  const home = freshScratch(t)
  const manifest = singleEntryManifest(home, "copy", SRC, DEST)
  const first = spawnInstaller(["--manifest", manifest], { home })
  assert.equal(first.status, 0, first.stderr)
  const ok = spawnInstaller(["--manifest", manifest, "--check"], { home })
  assert.equal(ok.status, 0, ok.stderr)
  assert.match(ok.stdout, /check: OK .*agents\/x/)
  assert.doesNotMatch(ok.stdout, /outdated/)
  const dest = destOf(home)
  const record = readLedger(ledgerOf(home))?.[dest]
  assert.ok(record, "the copy install must have recorded the entry")
  writeFileSync(ledgerOf(home), JSON.stringify({ [dest]: { ...record, version: "0.0.1" } }))
  const outdated = spawnInstaller(["--manifest", manifest, "--check"], { home })
  assert.equal(outdated.status, 0, outdated.stderr)
  assert.match(outdated.stdout, /check: outdated .*agents\/x/)
  assert.match(outdated.stdout, /check: OK .*agents\/x/)
})

/** --check exits 1 when an installed copy was edited after install. */
test("--check: a post-install edit is reported as a conflict and exits 1", (t) => {
  const { home, manifest, dest, edited } = seededCopyConflict(t)
  const res = spawnInstaller(["--manifest", manifest, "--check"], { home })
  assert.equal(res.status, 1)
  assert.match(res.stderr, /check: conflict .*agents\/x/)
  assert.equal(readFileSync(dest, "utf8"), edited)
})

/** --check exits 1 when a retired dest is still present. */
test("--check: a still-present retired dest fails the check and exits 1", (t) => {
  const home = freshScratch(t)
  const retired = homePath(home, ".config/opencode/plugin/old.ts")
  mkdirSync(dirname(retired), { recursive: true })
  symlinkSync(join(repoRoot, "scripts/install.mjs"), retired)
  const manifest = writeManifest(home, {
    mode: "link",
    ledger: "~/ledger.json",
    links: [{ src: SRC, dest: DEST }],
    retired: ["~/.config/opencode/plugin/old.ts"],
  })
  const res = spawnInstaller(["--manifest", manifest, "--check"], { home })
  assert.equal(res.status, 1)
  assert.match(res.stderr, /check: retired link still present: .*plugin\/old\.ts/)
})

/** The default manifest installs, checks, uninstalls, and then checks missing — all under a temp HOME. */
test("real manifest smoke: install/check/uninstall/check exit 0/0/0/1 under a temp HOME", (t) => {
  const home = freshScratch(t)
  const install = spawnInstaller([], { home })
  assert.equal(install.status, 0, install.stderr)
  for (const line of install.stdout.split("\n")) {
    const m = line.match(/^install: (?:link|copy) (.+)$/)
    if (!m) continue
    assert.ok(m[1]?.startsWith(home), `dest escaped the temp HOME: ${m[1]}`)
  }
  const plugin = homePath(home, ".config/opencode/plugins/turnstile.ts")
  assert.equal(realpathSync(plugin), join(repoRoot, "turnstile.ts"))
  const check = spawnInstaller(["--check"], { home })
  assert.equal(check.status, 0, check.stderr)
  const uninstall = spawnInstaller(["--uninstall"], { home })
  assert.equal(uninstall.status, 0, uninstall.stderr)
  assert.match(uninstall.stdout, /install: removed .*plugins\/turnstile\.ts/)
  const after = spawnInstaller(["--check"], { home })
  assert.equal(after.status, 1)
  assert.match(after.stderr, /check: missing/)
})
