/**
 * @fileoverview Cross-process file-lock tests: acquire/release on a free
 * file, the `onAcquired` seam ordering, the bounded retry degrading on a
 * fresh lock, the single stale steal (with its notification seam),
 * fail-open on every unexpected lock state (an unstealable stale lock, a
 * non-EEXIST mkdir error, a vanished lock), a swallowed release failure,
 * and the propagation of a throwing critical-section body after release.
 */

import { test } from "node:test"
import assert from "node:assert/strict"
import * as fs from "node:fs"
import * as path from "node:path"

import { withFileLock } from "../src/lockfile.ts"
import { tmpDir } from "./helpers.ts"

/**
 * Backdates a lock directory's mtime well past any staleness bound.
 * @param lock The lock directory path.
 */
function backdate(lock: string): void {
  const past = new Date(Date.now() - 120_000)
  fs.utimesSync(lock, past, past)
}

/**
 * The lock directory path guarding a file.
 * @param file The guarded file path.
 * @returns The `<file>.lock` path.
 */
function lockOf(file: string): string {
  return `${file}.lock`
}

test("withFileLock acquires on a free file, runs the body, and releases", () => {
  const dir = tmpDir()
  const file = path.join(dir, "j.jsonl")
  let ran = false
  const r = withFileLock(file, {}, () => {
    ran = true
    assert.equal(fs.existsSync(lockOf(file)), true, "the lock is held inside the body")
  })
  assert.deepEqual(r, { held: true, stoleStale: false })
  assert.equal(ran, true)
  assert.equal(fs.existsSync(lockOf(file)), false, "the lock is released after the body")
})

test("the onAcquired seam runs inside the lock before the body", () => {
  const dir = tmpDir()
  const file = path.join(dir, "j.jsonl")
  const events: string[] = []
  withFileLock(
    file,
    {
      onAcquired: () => {
        events.push("acquired")
        assert.equal(fs.existsSync(lockOf(file)), true)
      },
    },
    () => events.push("body"),
  )
  assert.deepEqual(events, ["acquired", "body"])
})

test("withFileLock degrades after the retry bound on a fresh lock", () => {
  const dir = tmpDir()
  const file = path.join(dir, "j.jsonl")
  fs.mkdirSync(lockOf(file)) // held by "another process"
  let ran = false
  const r = withFileLock(file, { timeoutMs: 40 }, () => {
    ran = true
  })
  assert.deepEqual(r, { held: false, stoleStale: false })
  assert.equal(ran, false, "the body never runs without the lock")
  assert.equal(fs.existsSync(lockOf(file)), true, "a fresh lock is never stolen")
})

test("withFileLock makes a single attempt when the timeout is zero", () => {
  const dir = tmpDir()
  const file = path.join(dir, "j.jsonl")
  fs.mkdirSync(lockOf(file))
  const r = withFileLock(file, { timeoutMs: 0 }, () => {})
  assert.deepEqual(r, { held: false, stoleStale: false })
})

test("withFileLock steals a stale lock once and acquires", () => {
  const dir = tmpDir()
  const file = path.join(dir, "j.jsonl")
  fs.mkdirSync(lockOf(file))
  backdate(lockOf(file))
  const events: string[] = []
  const r = withFileLock(
    file,
    {
      onStaleSteal: () => {
        events.push("stolen")
        assert.equal(fs.existsSync(lockOf(file)), false, "the steal removed the lock")
      },
    },
    () => events.push("body"),
  )
  assert.deepEqual(r, { held: true, stoleStale: true })
  assert.deepEqual(events, ["stolen", "body"])
})

test("withFileLock fails open when a stale lock cannot be stolen", () => {
  const dir = tmpDir()
  const file = path.join(dir, "j.jsonl")
  fs.mkdirSync(lockOf(file))
  fs.writeFileSync(path.join(lockOf(file), "held"), "") // non-empty: rmdir fails
  backdate(lockOf(file))
  let stole = false
  let ran = false
  const r = withFileLock(file, { onStaleSteal: () => (stole = true) }, () => (ran = true))
  assert.deepEqual(r, { held: false, stoleStale: false })
  assert.equal(stole, false, "the steal notification never fires for a failed steal")
  assert.equal(ran, false)
  assert.equal(fs.existsSync(lockOf(file)), true)
})

test("withFileLock fails open on a non-EEXIST mkdir error", () => {
  const dir = tmpDir()
  const file = path.join(dir, "guarded", "j.jsonl")
  fs.mkdirSync(path.dirname(lockOf(file)))
  fs.chmodSync(path.dirname(lockOf(file)), 0o555) // mkdir fails (EACCES)
  try {
    let ran = false
    const r = withFileLock(file, {}, () => (ran = true))
    assert.deepEqual(r, { held: false, stoleStale: false })
    assert.equal(ran, false)
  } finally {
    fs.chmodSync(path.dirname(lockOf(file)), 0o755)
  }
})

test("withFileLock fails open when the contended lock vanishes before the stat", () => {
  const dir = tmpDir()
  const file = path.join(dir, "j.jsonl")
  // A broken symlink: mkdir fails with EEXIST, the staleness stat fails
  // with ENOENT — an unexpected lock state that must degrade, not throw.
  fs.symlinkSync(path.join(dir, "missing"), lockOf(file))
  let ran = false
  const r = withFileLock(file, {}, () => (ran = true))
  assert.deepEqual(r, { held: false, stoleStale: false })
  assert.equal(ran, false)
})

test("withFileLock swallows a failed release and still reports held", () => {
  const dir = tmpDir()
  const file = path.join(dir, "j.jsonl")
  const r = withFileLock(file, {}, () => {
    // The body leaves a file inside the lock directory: the release rmdir
    // fails and must be swallowed.
    fs.writeFileSync(path.join(lockOf(file), "stray"), "")
  })
  assert.deepEqual(r, { held: true, stoleStale: false })
  assert.equal(fs.existsSync(lockOf(file)), true, "the unremovable lock stays for the stale steal")
})

test("a throwing body propagates after the lock is released", () => {
  const dir = tmpDir()
  const file = path.join(dir, "j.jsonl")
  assert.throws(() =>
    withFileLock(file, {}, () => {
      throw new Error("body exploded")
    }),
  )
  assert.equal(fs.existsSync(lockOf(file)), false, "the lock is released even on a throw")
})
