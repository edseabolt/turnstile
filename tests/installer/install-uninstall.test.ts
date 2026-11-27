/**
 * @fileoverview Integration tests for the installer's --uninstall flow and
 * the corrupted/absent ledger guard. Every test spawns
 * scripts/install.mjs under a temp HOME via the shared harness
 * (install-harness.ts), so every removal and ledger write is confined to a
 * scratch dir; no real ~/.config/opencode is ever touched.
 */

import { test } from "node:test"
import assert from "node:assert/strict"
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  symlinkSync,
  writeFileSync,
} from "node:fs"
import { dirname, join } from "node:path"

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

/** Uninstall after a link install removes the repo-owned symlink and exits 0. */
test("uninstall: removes repo-owned symlinks from a link install and exits 0", (t) => {
  const home = freshScratch(t)
  const manifest = singleEntryManifest(home, "link", SRC, DEST)
  const first = spawnInstaller(["--manifest", manifest], { home })
  assert.equal(first.status, 0, first.stderr)
  const dest = destOf(home)
  assert.ok(existsSync(dest), "the install must have created the symlink")
  const res = spawnInstaller(["--manifest", manifest, "--uninstall"], { home })
  assert.equal(res.status, 0, res.stderr)
  assert.match(res.stdout, /install: removed .*agents\/x/)
  assert.equal(existsSync(dest), false)
})

/** Uninstall after a copy install removes the ledger-owned file and persists the pruned ledger. */
test("uninstall: removes ledger-owned copies and persists the pruned ledger", (t) => {
  const home = freshScratch(t)
  const manifest = singleEntryManifest(home, "copy", SRC, DEST)
  const first = spawnInstaller(["--manifest", manifest], { home })
  assert.equal(first.status, 0, first.stderr)
  assert.ok(readLedger(ledgerOf(home)), "the copy install must have recorded the entry")
  const res = spawnInstaller(["--manifest", manifest, "--uninstall"], { home })
  assert.equal(res.status, 0, res.stderr)
  assert.match(res.stdout, /install: removed .*agents\/x/)
  assert.equal(existsSync(destOf(home)), false)
  assert.deepEqual(readLedger(ledgerOf(home)), {})
})

/** Uninstall leaves a foreign symlink and an untracked file alone and exits 1. */
test("uninstall: leaves a foreign symlink and an untracked file alone and exits 1", (t) => {
  const home = freshScratch(t)
  const foreign = homePath(home, "foreign.txt")
  writeFileSync(foreign, "mine")
  const destA = homePath(home, ".config/opencode/agents/a")
  const destB = homePath(home, ".config/opencode/agents/b")
  mkdirSync(dirname(destA), { recursive: true })
  symlinkSync(foreign, destA)
  writeFileSync(destB, "untracked")
  const manifest = writeManifest(home, {
    mode: "link",
    ledger: "~/ledger.json",
    links: [
      { src: "bin/cli.mjs", dest: "~/.config/opencode/agents/a" },
      { src: "agents/planner.md", dest: "~/.config/opencode/agents/b" },
    ],
  })
  const res = spawnInstaller(["--manifest", manifest, "--uninstall"], { home })
  assert.equal(res.status, 1)
  assert.match(res.stdout, /install: could not remove .*agents\/a — symlink not repo-owned/)
  assert.match(res.stdout, /install: could not remove .*agents\/b — untracked file left alone/)
  assert.equal(readlinkSync(destA), foreign)
  assert.equal(readFileSync(destB, "utf8"), "untracked")
})

/** A second uninstall is a no-op: every dest is up to date and the exit stays 0. */
test("uninstall: is idempotent — a second run is up to date and exits 0", (t) => {
  const home = freshScratch(t)
  const manifest = singleEntryManifest(home, "link", SRC, DEST)
  const install = spawnInstaller(["--manifest", manifest], { home })
  assert.equal(install.status, 0, install.stderr)
  const first = spawnInstaller(["--manifest", manifest, "--uninstall"], { home })
  assert.equal(first.status, 0, first.stderr)
  const second = spawnInstaller(["--manifest", manifest, "--uninstall"], { home })
  assert.equal(second.status, 0, second.stderr)
  assert.match(second.stdout, /install: up to date .*agents\/x/)
})

/** Uninstall removes a retired leftover when it is repo-owned. */
test("uninstall: removes a repo-owned retired leftover", (t) => {
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
  const res = spawnInstaller(["--manifest", manifest, "--uninstall"], { home })
  assert.equal(res.status, 0, res.stderr)
  assert.match(res.stdout, /install: removed retired .*plugin\/old\.ts/)
  assert.equal(existsSync(retired), false)
})

/** A corrupt ledger makes uninstall, check, and install all exit 1 with delete-or-repair instructions. */
test("corrupt ledger: uninstall, check, and install each exit 1 with the fix instructions", (t) => {
  const home = freshScratch(t)
  const manifest = singleEntryManifest(home, "link", SRC, DEST)
  const ledgerPath = ledgerOf(home)
  writeFileSync(ledgerPath, "{not json")
  const cases = [
    ["--manifest", manifest, "--uninstall"],
    ["--manifest", manifest, "--check"],
    ["--manifest", manifest],
  ]
  for (const args of cases) {
    const res = spawnInstaller(args, { home })
    assert.equal(res.status, 1, `args ${args.join(" ")}: ${res.stderr}`)
    assert.match(res.stderr, /delete or repair/i)
    assert.ok(res.stderr.includes(ledgerPath), `stderr must name the ledger: ${res.stderr}`)
  }
})

/** An absent ledger is not an error: a fresh install with no ledger file exits 0. */
test("absent ledger: a fresh install with no ledger file exits 0", (t) => {
  const home = freshScratch(t)
  const manifest = singleEntryManifest(home, "link", SRC, DEST)
  assert.ok(!existsSync(ledgerOf(home)), "the fixture must start with no ledger")
  const res = spawnInstaller(["--manifest", manifest], { home })
  assert.equal(res.status, 0, res.stderr)
  assert.doesNotMatch(res.stderr ?? "", /delete or repair/i)
  assert.deepEqual(readLedger(ledgerOf(home)), {})
})
