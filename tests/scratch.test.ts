/**
 * @fileoverview Scratch-target exemption tests: the temp-dir predicate matrix
 * (inside/outside, not-yet-existing targets, symlink escapes, non-string and
 * empty inputs failing toward gating) and the `observeScratchWrite` audit
 * telemetry (row shape, bounded path, fail-open).
 */

import { test } from "node:test"
import assert from "node:assert/strict"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { fileURLToPath } from "node:url"

import { isScratchTarget } from "../src/scratch.ts"
import { defaultConfig } from "../src/config.ts"
import type { Journaler } from "../src/journal.ts"
import type { TurnstileConfig } from "../src/types.ts"
import { createToolPolicy, type ToolPolicy } from "../src/tool-policy.ts"

/** The repo root (never under the platform temp dir). */
const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), "..")

/**
 * Builds a capturing Journaler: every journal entry is deep-copied into
 * `entries`.
 * @returns The journaler and its entries.
 */
function captureJournaler(): { journaler: Journaler; entries: any[] } {
  const entries: any[] = []
  const journaler: Journaler = {
    journalPath: "",
    tracePath: "",
    journal(entry) {
      entries.push({ ...entry })
    },
    traceEvent() {},
  }
  return { journaler, entries }
}

/**
 * Builds a policy over the given config with a capturing journaler.
 * @param overrides Top-level config overrides over the defaults.
 * @returns The policy and its journaled entries.
 */
function makePolicy(overrides: Partial<TurnstileConfig> = {}): {
  policy: ToolPolicy
  entries: any[]
} {
  const { journaler, entries } = captureJournaler()
  const cfg: TurnstileConfig = { ...defaultConfig({}), ...overrides }
  return { policy: createToolPolicy(cfg, journaler), entries }
}

/** A fresh directory inside the platform temp dir. */
function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "turnstile-scratch-"))
}

test("isScratchTarget: an existing file inside the temp dir is scratch", () => {
  const dir = tempDir()
  const file = path.join(dir, "issue-body.md")
  fs.writeFileSync(file, "x")
  assert.equal(isScratchTarget(file), true)
})

test("isScratchTarget: a not-yet-existing file inside the temp dir is scratch", () => {
  const dir = tempDir()
  assert.equal(isScratchTarget(path.join(dir, "new-file.md")), true)
})

test("isScratchTarget: a relative path into the temp dir is scratch", () => {
  const dir = tempDir()
  const prev = process.cwd()
  process.chdir(dir)
  try {
    assert.equal(isScratchTarget("relative-scratch.md"), true)
  } finally {
    process.chdir(prev)
  }
})

test("isScratchTarget: paths outside the temp dir are not scratch", () => {
  assert.equal(isScratchTarget("/repo/src/a.ts"), false)
  assert.equal(isScratchTarget(os.homedir() + "/notes.md"), false)
  // The repo's own tests directory is never under the platform temp dir,
  // whatever the harness's current working directory is.
  assert.equal(isScratchTarget(path.join(repoRoot, "src", "scratch.ts")), false)
})

test("isScratchTarget: the temp dir itself is not a scratch target", () => {
  assert.equal(isScratchTarget(os.tmpdir()), false)
})

test("isScratchTarget: a symlink escaping the temp dir is not scratch", () => {
  const dir = tempDir()
  // The escape target lives in the repo's tests directory (never under the
  // platform temp dir, whatever the harness's cwd is).
  const outsideDir = fs.mkdtempSync(path.join(repoRoot, "tests", "scratch-escape-"))
  const outside = path.join(outsideDir, "target.md")
  fs.writeFileSync(outside, "x")
  const link = path.join(dir, "escape.md")
  fs.symlinkSync(outside, link)
  const dangling = path.join(dir, "dangling.md")
  fs.symlinkSync(path.join(outsideDir, "not-created-yet.md"), dangling)
  try {
    assert.equal(isScratchTarget(link), false)
    // A dangling symlink still escapes: the host would write through it.
    assert.equal(isScratchTarget(dangling), false)
  } finally {
    fs.rmSync(link)
    fs.rmSync(dangling)
    fs.rmSync(outsideDir, { recursive: true, force: true })
  }
})

test("isScratchTarget: a symlink inside the temp dir pointing at the temp dir is scratch", () => {
  const dir = tempDir()
  const nested = path.join(dir, "nested")
  fs.mkdirSync(nested)
  const link = path.join(dir, "link.md")
  fs.symlinkSync(path.join(nested, "file.md"), link)
  assert.equal(isScratchTarget(link), true)
})

test("isScratchTarget: a relative symlink target resolves before the comparison", () => {
  const dir = tempDir()
  const outsideDir = fs.mkdtempSync(path.join(repoRoot, "tests", "scratch-rel-"))
  fs.writeFileSync(path.join(outsideDir, "target.md"), "x")
  // Relative link escaping the temp dir: the host would write outside.
  const escaping = path.join(dir, "rel-escape.md")
  fs.symlinkSync(path.join(outsideDir, "target.md"), escaping)
  // Relative link staying inside the temp dir (target relative to the link's
  // directory): scratch.
  const nested = path.join(dir, "nested")
  fs.mkdirSync(nested)
  const inside = path.join(nested, "rel-inside.md")
  fs.symlinkSync(path.join("..", "inside-target.md"), inside)
  try {
    assert.equal(isScratchTarget(escaping), false)
    assert.equal(isScratchTarget(inside), true)
  } finally {
    fs.rmSync(escaping)
    fs.rmSync(inside)
    fs.rmSync(outsideDir, { recursive: true, force: true })
  }
})

test("isScratchTarget: a symlink chain deeper than the resolution cap fails toward gating", () => {
  const dir = tempDir()
  // An 11-hop dangling chain whose final hop points outside the temp dir:
  // the host would write through it to the outside path, so depth
  // exhaustion must fail toward gating, never fall back to the
  // un-resolved (still temp-dir-prefixed) path.
  const outsideDir = fs.mkdtempSync(path.join(repoRoot, "tests", "scratch-deep-"))
  const finalHop = path.join(outsideDir, "escaped.md")
  let current = finalHop
  for (let i = 0; i < 11; i++) {
    const hop = path.join(dir, `hop-${i}.md`)
    fs.symlinkSync(current, hop)
    current = hop
  }
  try {
    assert.equal(isScratchTarget(current), false)
  } finally {
    for (let i = 0; i < 11; i++) fs.rmSync(path.join(dir, `hop-${i}.md`), { force: true })
    fs.rmSync(outsideDir, { recursive: true, force: true })
  }
})

test("isScratchTarget: a symlinked intermediate directory escaping the temp dir is not scratch", () => {
  const dir = tempDir()
  const outsideDir = fs.mkdtempSync(path.join(repoRoot, "tests", "scratch-mid-"))
  // linkdir → outsideDir; the final component does not exist yet, so the
  // classification must come from the canonicalized existing ancestor.
  const target = path.join(dir, "linkdir", "new.md")
  fs.symlinkSync(outsideDir, path.join(dir, "linkdir"))
  try {
    assert.equal(isScratchTarget(target), false)
  } finally {
    fs.rmSync(path.join(dir, "linkdir"), { force: true })
    fs.rmSync(outsideDir, { recursive: true, force: true })
  }
})

test("isScratchTarget: non-string and empty inputs fail toward gating", () => {
  assert.equal(isScratchTarget(undefined), false)
  assert.equal(isScratchTarget(42), false)
  assert.equal(isScratchTarget(null), false)
  assert.equal(isScratchTarget(""), false)
})

test("isScratchTarget: an unresolvable drive-root-shaped path fails toward gating", () => {
  // A path whose every ancestor is missing cannot be canonicalized even by
  // walking to the root on a sane filesystem; the predicate must return
  // false (gate), never throw.
  assert.equal(isScratchTarget("/nonexistent-root-probe/deeply/nested/file.md"), false)
})

test("observeScratchWrite: journals the audit row with the target path", () => {
  const { policy, entries } = makePolicy()
  policy.observeScratchWrite("write", "/tmp/scratch/a.md", "p1")
  assert.deepEqual(entries, [
    { type: "tool", sessionID: "p1", tool: "write", scratch: true, path: "/tmp/scratch/a.md" },
  ])
})

test("observeScratchWrite: bounds the recorded path and redacts non-strings", () => {
  const { policy, entries } = makePolicy()
  policy.observeScratchWrite("edit", "/" + "x".repeat(500), "p1")
  policy.observeScratchWrite("edit", 42, "p1")
  assert.equal(entries[0]!.path.length, 200)
  assert.equal(entries[1]!.path, "<redacted>")
})

test("observeScratchWrite: a journal failure fails open", () => {
  const entries: any[] = []
  const journaler: Journaler = {
    journalPath: "",
    tracePath: "",
    journal(entry) {
      entries.push({ ...entry })
      if (entry.type === "tool") throw new Error("disk full")
    },
    traceEvent() {},
  }
  const policy = createToolPolicy(defaultConfig({}), journaler)
  assert.doesNotThrow(() => policy.observeScratchWrite("write", "/tmp/a.md", "p1"))
  assert.equal(
    entries.some((e) => e.type === "error" && /tool policy guard/.test(String(e.error))),
    true,
  )
})
