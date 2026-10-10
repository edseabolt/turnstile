/**
 * @fileoverview Installer mode resolution and ledger-normalization tests.
 * These import the pure, side-effect-free helpers exported by
 * scripts/install.mjs (detectMode, resolveMode, normalizeLedger) and exercise
 * them directly, with no CLI spawn, no filesystem writes, and no touching a
 * real home.
 */

import { test } from "node:test"
import assert from "node:assert/strict"
import { existsSync } from "node:fs"
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
