/**
 * @fileoverview Installer mode resolution, ledger-normalization, and
 * `--repair` semantics tests. The mode/ledger section imports the pure,
 * side-effect-free helpers exported by scripts/install.mjs
 * (detectMode, resolveMode, normalizeLedger) and exercises them directly, with
 * no CLI spawn. The `--repair` section spawns the installer script directly
 * under a temp `HOME` (via the shared harness in install-harness.ts) so every
 * link/copy/ledger write is confined and no real home is touched.
 */

import { test } from "node:test"
import assert from "node:assert/strict"
import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from "node:fs"
import { dirname, join } from "node:path"

import {
  freshScratch,
  homePath,
  repoRoot,
  spawnInstaller,
  spawnNode,
  writeManifest,
} from "./install-harness.ts"

// @ts-expect-error TS7016: scripts/install.mjs is untyped JS; tests import its
// pure exports directly rather than spawning the CLI.
import { detectMode, resolveMode, normalizeLedger } from "../scripts/install.mjs"

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

// ---- --repair: spawn the installer under a temp HOME --------------------

// Every spawned-script test is confined to a temp HOME: install.mjs resolves
// its dests and ledger from homedir(), so a temp HOME makes every write
// observable and keeps a real ~/.config/opencode untouched.

/** A link elsewhere in the checkout, relative to the temp HOME's dest. */
const STALE_TARGET = join(repoRoot, "scripts/install.mjs")

/** Bare --repair relinks a missing link-mode entry and exits 0. */
test("repair: relinks a missing link-mode entry and exits 0", (t) => {
  const home = freshScratch(t)
  const manifest = writeManifest(home, {
    mode: "link",
    links: [{ src: "bin/cli.mjs", dest: "~/.config/opencode/agents/x" }],
  })
  const res = spawnInstaller(["--manifest", manifest, "--repair"], { home })
  assert.equal(res.status, 0, res.stderr)
  assert.match(res.stdout, /install: repair .*agents\/x \(missing\)/)
  const dest = homePath(home, ".config/opencode/agents/x")
  assert.ok(existsSync(dest), "the repaired symlink should now exist")
  assert.equal(realpathSync(dest), join(repoRoot, "bin/cli.mjs"))
})

/** --repair relinks a stale link-mode entry and exits 0. */
test("repair: relinks a stale link-mode entry and exits 0", (t) => {
  const home = freshScratch(t)
  const manifest = writeManifest(home, {
    mode: "link",
    links: [{ src: "bin/cli.mjs", dest: "~/.config/opencode/agents/x" }],
  })
  const dest = homePath(home, ".config/opencode/agents/x")
  mkdirSync(dirname(dest), { recursive: true })
  symlinkSync(STALE_TARGET, dest) // points into the repo, but at the wrong file
  const res = spawnInstaller(["--manifest", manifest, "--repair"], { home })
  assert.equal(res.status, 0, res.stderr)
  assert.match(res.stdout, /install: repair .*agents\/x \(stale\)/)
  assert.equal(realpathSync(dest), join(repoRoot, "bin/cli.mjs"))
})

/** --check --repair is a write-free dry run: prints `would repair`, exits 0. */
test("--check --repair: dry run writes nothing and prints would repair", (t) => {
  const home = freshScratch(t)
  const manifest = writeManifest(home, {
    mode: "link",
    links: [{ src: "bin/cli.mjs", dest: "~/.config/opencode/agents/x" }],
  })
  const res = spawnInstaller(["--manifest", manifest, "--check", "--repair"], { home })
  assert.equal(res.status, 0, res.stderr)
  assert.match(res.stdout, /install: would repair .*agents\/x \(missing\)/)
  assert.ok(
    !existsSync(homePath(home, ".config/opencode/agents/x")),
    "a dry run must not create the target",
  )
})

/** A conflict is never backed up by --repair without --force; it stays untouched. */
test("repair: conflict is left untouched without --force and exits non-zero", (t) => {
  const home = freshScratch(t)
  const manifest = writeManifest(home, {
    mode: "link",
    links: [{ src: "bin/cli.mjs", dest: "~/.config/opencode/agents/x" }],
  })
  const dest = homePath(home, ".config/opencode/agents/x")
  mkdirSync(dirname(dest), { recursive: true })
  const before = "USER EDITED"
  writeFileSync(dest, before)
  const res = spawnInstaller(["--manifest", manifest, "--repair"], { home })
  assert.notEqual(res.status, 0, "unrepairable conflict must fail")
  assert.match(res.stderr, /conflict/)
  assert.equal(readFileSync(dest, "utf8"), before, "the conflict file must be untouched")
})

/** --check --repair exits non-zero when a conflict is unrepairable. */
test("--check --repair: exits non-zero when a conflict is unrepairable", (t) => {
  const home = freshScratch(t)
  const manifest = writeManifest(home, {
    mode: "link",
    links: [{ src: "bin/cli.mjs", dest: "~/.config/opencode/agents/x" }],
  })
  const dest = homePath(home, ".config/opencode/agents/x")
  mkdirSync(dirname(dest), { recursive: true })
  writeFileSync(dest, "USER EDITED")
  const res = spawnInstaller(["--manifest", manifest, "--check", "--repair"], { home })
  assert.notEqual(res.status, 0, "unrepairable conflict must fail the dry run")
  assert.match(res.stderr, /check: conflict/)
})

/** `check` alone stays byte-for-byte unchanged: a missing entry is still an error. */
test("check alone (unchanged): a missing entry is still reported and exits 1", (t) => {
  const home = freshScratch(t)
  const manifest = writeManifest(home, {
    mode: "link",
    links: [{ src: "bin/cli.mjs", dest: "~/.config/opencode/agents/x" }],
  })
  const res = spawnInstaller(["--manifest", manifest, "--check"], { home })
  assert.equal(res.status, 1)
  assert.match(res.stderr, /check: missing/)
  assert.doesNotMatch(res.stdout, /would repair/)
})

/** The router passes `check --repair` through as `install.mjs --check --repair`. */
test("router check --repair: routes to install.mjs --check --repair", (t) => {
  const home = freshScratch(t)
  const manifest = writeManifest(home, {
    mode: "link",
    links: [{ src: "bin/cli.mjs", dest: "~/.config/opencode/agents/router-x" }],
  })
  const res = spawnNode("bin/cli.mjs", ["check", "--repair", "--manifest", manifest], {
    home,
  })
  assert.equal(res.status, 0, res.stderr)
  assert.match(res.stdout, /install: would repair .*agents\/router-x \(missing\)/)
  assert.ok(
    !existsSync(homePath(home, ".config/opencode/agents/router-x")),
    "the routed dry run must not write",
  )
})
