/**
 * @fileoverview Installer mode resolution, ledger-normalization, and
 * `--repair` semantics tests. The mode/ledger section imports the pure,
 * side-effect-free helpers exported by scripts/install.mjs
 * (detectMode, resolveMode, normalizeLedger) and exercises them directly, with
 * no CLI spawn. The `--repair` section spawns the installer script directly
 * (see DD-8) under a temp `HOME` so every link/copy/ledger write is confined
 * and no real home is touched.
 */

import { test } from "node:test"
import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

// @ts-expect-error TS7016: scripts/install.mjs is untyped JS; tests import its
// pure exports directly rather than spawning the CLI.
import { detectMode, resolveMode, normalizeLedger } from "../scripts/install.mjs"

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..")

/** Auto-detect keys off .git presence next to the module: link in a checkout, copy in a package. */
test("detectMode keys off .git presence", () => {
  assert.equal(detectMode(), existsSync(join(repoRoot, ".git")) ? "link" : "copy")
})

/** A CLI flag beats the manifest: explicit --link/--copy overrides the manifest mode. */
test("resolveMode: a CLI flag beats the manifest mode", () => {
  assert.equal(resolveMode("link", "copy"), "link")
  assert.equal(resolveMode("copy", "link"), "copy")
})

/** The manifest mode beats auto-detect when no flag is given. */
test("resolveMode: the manifest mode beats detection", () => {
  assert.equal(resolveMode(null, "copy"), "copy")
  assert.equal(resolveMode(undefined, "link"), "link")
})

/** With neither flag nor manifest mode, filesystem detection decides. */
test("resolveMode: falls back to detection with no flag and no manifest mode", () => {
  assert.equal(resolveMode(null, undefined), detectMode())
  assert.equal(resolveMode(undefined, undefined), detectMode())
})

/** An unknown manifest mode is warned about and ignored (never silently link). */
test("resolveMode: an unknown manifest mode warns and falls back to detection", () => {
  const original = console.warn
  let warned: string | undefined
  console.warn = (msg: unknown): void => {
    warned = String(msg)
  }
  try {
    assert.equal(resolveMode(null, "symlink"), detectMode())
    assert.ok(warned?.includes("unknown manifest mode"), `expected a warning, got: ${warned}`)
    assert.ok(warned?.includes("symlink"), `expected the bad mode in the warning, got: ${warned}`)
  } finally {
    console.warn = original
  }
})

/** An unknown manifest mode still yields to an explicit CLI flag. */
test("resolveMode: an explicit flag defeats an unknown manifest mode", () => {
  const original = console.warn
  console.warn = (): void => {}
  try {
    assert.equal(resolveMode("copy", "symlink"), "copy")
  } finally {
    console.warn = original
  }
})

/** A legacy ledger entry missing version and mode normalizes to null/copy. */
test("normalizeLedger: defaults missing version and mode", () => {
  assert.deepEqual(
    normalizeLedger({ "~/.config/opencode/x": { src: "turnstile.ts", hash: "abc123" } }),
    {
      "~/.config/opencode/x": {
        src: "turnstile.ts",
        hash: "abc123",
        version: null,
        mode: "copy",
      },
    },
  )
})

/** Present version and mode fields are preserved as-is. */
test("normalizeLedger: preserves present version and mode", () => {
  assert.deepEqual(
    normalizeLedger({ d: { src: "a.md", hash: "h", version: "0.1.0", mode: "link" } }),
    { d: { src: "a.md", hash: "h", version: "0.1.0", mode: "link" } },
  )
})

/** The old {src, hash} shape is accepted with no path transformation. */
test("normalizeLedger: accepts the old {src, hash} shape without rewriting src", () => {
  assert.deepEqual(normalizeLedger({ d: { src: "turnstile.ts", hash: "h" } }), {
    d: { src: "turnstile.ts", hash: "h", version: null, mode: "copy" },
  })
})

/** Only src/hash/version/mode survive; extra keys are dropped. */
test("normalizeLedger: keeps only src/hash/version/mode and drops extras", () => {
  assert.deepEqual(
    normalizeLedger({ d: { src: "a", hash: "h", version: "1", mode: "copy", extra: 1 } }),
    { d: { src: "a", hash: "h", version: "1", mode: "copy" } },
  )
})

// ---- --repair (DD-8, AC-10): spawn the installer under a temp HOME ----------

// Every spawned-script test is confined to a temp HOME: install.mjs resolves
// its dests and ledger from homedir(), so a temp HOME makes every write
// observable and keeps a real ~/.config/opencode untouched (DD-9).
function freshHome(): string {
  return mkdtempSync(join(tmpdir(), "install-repair-home-"))
}

/** env object with HOME pinned to a temp dir; spawn inherits the rest. */
function envForHome(home: string) {
  return { ...process.env, HOME: home }
}

// A single-entry link-mode manifest whose src is repo-relative (readManifest
// joins it onto repoRoot) and whose dest uses ~ (expanded under the temp HOME).
function writeLinkManifest(src: string, dest: string): string {
  const file = join(tmpdir(), `install-repair-${Math.random().toString(36).slice(2)}.json`)
  writeFileSync(file, JSON.stringify({ mode: "link", links: [{ src, dest }] }))
  return file
}

/** Spawn install.mjs with a temp HOME; the manifest path is passed verbatim. */
function runInstall(args: string[], home: string) {
  return spawnSync(process.execPath, [join(repoRoot, "scripts/install.mjs"), ...args], {
    encoding: "utf8",
    env: envForHome(home),
  })
}

/** A link elsewhere in the checkout, relative to the temp HOME's dest. */
const STALE_TARGET = join(repoRoot, "scripts/install.mjs")

/** Bare --repair relinks a missing link-mode entry and exits 0 (AC-10). */
test("repair: relinks a missing link-mode entry and exits 0 (AC-10)", () => {
  const home = freshHome()
  const manifest = writeLinkManifest("bin/cli.mjs", "~/.config/opencode/agents/x")
  try {
    const res = runInstall(["--manifest", manifest, "--repair"], home)
    assert.equal(res.status, 0, res.stderr)
    assert.match(res.stdout, /install: repair .*agents\/x \(missing\)/)
    const dest = join(home, ".config/opencode/agents/x")
    assert.ok(existsSync(dest), "the repaired symlink should now exist")
    assert.equal(realpathSync(dest), join(repoRoot, "bin/cli.mjs"))
  } finally {
    rmSync(home, { recursive: true, force: true })
    rmSync(manifest, { force: true })
  }
})

/** --repair relinks a stale link-mode entry and exits 0 (AC-10). */
test("repair: relinks a stale link-mode entry and exits 0 (AC-10)", () => {
  const home = freshHome()
  const manifest = writeLinkManifest("bin/cli.mjs", "~/.config/opencode/agents/x")
  const dest = join(home, ".config/opencode/agents/x")
  mkdirSync(dirname(dest), { recursive: true })
  symlinkSync(STALE_TARGET, dest) // points into the repo, but at the wrong file
  try {
    const res = runInstall(["--manifest", manifest, "--repair"], home)
    assert.equal(res.status, 0, res.stderr)
    assert.match(res.stdout, /install: repair .*agents\/x \(stale\)/)
    assert.equal(realpathSync(dest), join(repoRoot, "bin/cli.mjs"))
  } finally {
    rmSync(home, { recursive: true, force: true })
    rmSync(manifest, { force: true })
  }
})

/** --check --repair is a write-free dry run: prints `would repair`, exits 0 (AC-10). */
test("--check --repair: dry run writes nothing and prints would repair (AC-10)", () => {
  const home = freshHome()
  const manifest = writeLinkManifest("bin/cli.mjs", "~/.config/opencode/agents/x")
  try {
    const res = runInstall(["--manifest", manifest, "--check", "--repair"], home)
    assert.equal(res.status, 0, res.stderr)
    assert.match(res.stdout, /install: would repair .*agents\/x \(missing\)/)
    assert.ok(
      !existsSync(join(home, ".config/opencode/agents/x")),
      "a dry run must not create the target",
    )
  } finally {
    rmSync(home, { recursive: true, force: true })
    rmSync(manifest, { force: true })
  }
})

/** A conflict is never backed up by --repair without --force; it stays untouched (AC-10). */
test("repair: conflict is left untouched without --force and exits non-zero (AC-10)", () => {
  const home = freshHome()
  const manifest = writeLinkManifest("bin/cli.mjs", "~/.config/opencode/agents/x")
  const dest = join(home, ".config/opencode/agents/x")
  mkdirSync(dirname(dest), { recursive: true })
  const before = "USER EDITED"
  writeFileSync(dest, before)
  try {
    const res = runInstall(["--manifest", manifest, "--repair"], home)
    assert.notEqual(res.status, 0, "unrepairable conflict must fail")
    assert.match(res.stderr, /conflict/)
    assert.equal(readFileSync(dest, "utf8"), before, "the conflict file must be untouched")
  } finally {
    rmSync(home, { recursive: true, force: true })
    rmSync(manifest, { force: true })
  }
})

/** --check --repair exits non-zero when a conflict is unrepairable (AC-10). */
test("--check --repair: exits non-zero when a conflict is unrepairable (AC-10)", () => {
  const home = freshHome()
  const manifest = writeLinkManifest("bin/cli.mjs", "~/.config/opencode/agents/x")
  const dest = join(home, ".config/opencode/agents/x")
  mkdirSync(dirname(dest), { recursive: true })
  writeFileSync(dest, "USER EDITED")
  try {
    const res = runInstall(["--manifest", manifest, "--check", "--repair"], home)
    assert.notEqual(res.status, 0, "unrepairable conflict must fail the dry run")
    assert.match(res.stderr, /check: conflict/)
  } finally {
    rmSync(home, { recursive: true, force: true })
    rmSync(manifest, { force: true })
  }
})

/** `check` alone stays byte-for-byte unchanged: a missing entry is still an error (AC-10). */
test("check alone (unchanged): a missing entry is still reported and exits 1 (AC-10)", () => {
  const home = freshHome()
  const manifest = writeLinkManifest("bin/cli.mjs", "~/.config/opencode/agents/x")
  try {
    const res = runInstall(["--manifest", manifest, "--check"], home)
    assert.equal(res.status, 1)
    assert.match(res.stderr, /check: missing/)
    assert.doesNotMatch(res.stdout, /would repair/)
  } finally {
    rmSync(home, { recursive: true, force: true })
    rmSync(manifest, { force: true })
  }
})

/** The router passes `check --repair` through as `install.mjs --check --repair` (AC-10). */
test("router check --repair: routes to install.mjs --check --repair (AC-10)", () => {
  const home = freshHome()
  const manifest = writeLinkManifest("bin/cli.mjs", "~/.config/opencode/agents/router-x")
  try {
    const res = spawnSync(
      process.execPath,
      [join(repoRoot, "bin/cli.mjs"), "check", "--repair", "--manifest", manifest],
      { encoding: "utf8", env: envForHome(home) },
    )
    assert.equal(res.status, 0, res.stderr)
    assert.match(res.stdout, /install: would repair .*agents\/router-x \(missing\)/)
    assert.ok(
      !existsSync(join(home, ".config/opencode/agents/router-x")),
      "the routed dry run must not write",
    )
  } finally {
    rmSync(home, { recursive: true, force: true })
    rmSync(manifest, { force: true })
  }
})
