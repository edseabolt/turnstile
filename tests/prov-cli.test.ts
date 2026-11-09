/**
 * @fileoverview Tests for the `turnstile prov` surface (scripts/prov.mjs),
 * driven by spawning the script the same way bin/cli.mjs does. It covers:
 *
 *  - the prov-row filter (a sink seeded with prov:* and gate rows renders
 *    only prov rows, each kind rendered correctly — stated text, denied
 *    kind, waiver stages);
 *  - `--json` printing the raw rows (parseable, types preserved);
 *  - `--tail` bounding the output and the default tail;
 *  - session filtering (an explicit sessionID covers its per-session sink
 *    and the shared journal's rows for that session);
 *  - the no-sessionID walk across every session's sink plus the shared
 *    journal;
 *  - rotation (a `.jsonl.1` generation is included, ts-ordered);
 *  - the CLI surface (--help, unknown flag, malformed session ID, empty
 *    journal exits 0 with no output, malformed lines skipped).
 *
 * All fixtures live in a temp dir under the OS temp dir, never the real
 * metrics directory, and the script is read-only.
 */

import { test } from "node:test"
import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..")
const provScript = join(repoRoot, "scripts", "prov.mjs")

/** A journaled entry; fields are deliberately loose (typed `any`). */
type Entry = Record<string, any>

/** Creates a fresh temp metrics dir, returned so the test can remove it. */
function metricsDir(): string {
  return mkdtempSync(join(tmpdir(), "turnstile-prov-test-"))
}

/**
 * Runs prov.mjs against a temp metrics dir.
 * @param dir The temp metrics directory.
 * @param args Arguments after the subcommand (e.g. `["--json"]`).
 * @returns The spawn result with stdout coerced to string.
 */
function runProv(dir: string, args: string[] = []) {
  return spawnSync(process.execPath, [provScript, ...args], {
    env: { ...process.env, TURNSTILE_METRICS_DIR: dir },
    encoding: "utf8",
  })
}

/**
 * Normalizes the spawn exit code across Node builds: this build exposes it on
 * `status`; older builds expose `exitCode`.
 * @param res The spawnSync result.
 * @returns The numeric exit code, or -1 when the process did not exit cleanly.
 */
function code(res: { status: number | null; exitCode?: number | null }): number {
  return res.status ?? res.exitCode ?? -1
}

/**
 * Writes a per-session journal file (current or a rotated generation).
 * @param dir The temp metrics directory.
 * @param sessionID The parent session ID.
 * @param lines The journal entries, oldest-first.
 * @param generation Omit for the current file; a number writes `.jsonl.<n>`.
 */
function writeSessionJournal(dir: string, sessionID: string, lines: Entry[], generation?: number) {
  mkdirSync(join(dir, "sessions"), { recursive: true })
  const name = generation === undefined ? `${sessionID}.jsonl` : `${sessionID}.jsonl.${generation}`
  writeFileSync(join(dir, "sessions", name), lines.map((l) => JSON.stringify(l)).join("\n") + "\n")
}

/**
 * Writes the shared journal file (current or a rotated generation).
 * @param dir The temp metrics directory.
 * @param lines The journal entries, oldest-first.
 */
function writeSharedJournal(dir: string, lines: Entry[]) {
  writeFileSync(join(dir, "turnstile.jsonl"), lines.map((l) => JSON.stringify(l)).join("\n") + "\n")
}

test("renders only prov rows from a sink seeded with prov and gate rows", () => {
  const dir = metricsDir()
  try {
    writeSessionJournal(dir, "ses1", [
      { ts: "2026-01-01T10:00:00Z", type: "gate", sessionID: "ses1", result: "PASS", tests: 3 },
      {
        ts: "2026-01-01T10:00:05Z",
        type: "prov:stated",
        sessionID: "ses1",
        text: "add [REDACTED] to env",
        truncated: false,
      },
      { ts: "2026-01-01T10:00:10Z", type: "prov:denied", sessionID: "ses1", kind: "plan" },
      {
        ts: "2026-01-01T10:00:15Z",
        type: "prov:waiver",
        sessionID: "ses1",
        stages: ["plan", "review"],
      },
    ])
    const r = runProv(dir, ["ses1"])
    assert.equal(code(r), 0)
    const lines = r.stdout.trim().split("\n")
    assert.equal(lines.length, 3)
    assert.match(lines[0]!, /10:00:05 {2}stated {2}add \[REDACTED\] to env$/)
    assert.match(lines[1]!, /10:00:10 {2}denied {2}kind=plan/)
    assert.match(lines[2]!, /10:00:15 {2}waiver {2}stages=plan,review/)
    assert.doesNotMatch(r.stdout, /gate/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("--json prints the raw rows with types preserved", () => {
  const dir = metricsDir()
  try {
    writeSessionJournal(dir, "ses1", [
      {
        ts: "2026-01-01T10:00:05Z",
        type: "prov:stated",
        sessionID: "ses1",
        text: "ship it",
        truncated: false,
      },
      { ts: "2026-01-01T10:00:10Z", type: "prov:denied", sessionID: "ses1", kind: "landing" },
    ])
    const r = runProv(dir, ["ses1", "--json"])
    assert.equal(code(r), 0)
    const rows = JSON.parse(r.stdout) as Entry[]
    assert.equal(rows.length, 2)
    assert.equal(rows[0]!.type, "prov:stated")
    assert.equal(rows[0]!.text, "ship it")
    assert.equal(rows[0]!.truncated, false)
    assert.equal(rows[1]!.type, "prov:denied")
    assert.equal(rows[1]!.kind, "landing")
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("--tail bounds the output to the last N prov rows", () => {
  const dir = metricsDir()
  try {
    const rows: Entry[] = []
    for (let i = 0; i < 5; i++) {
      rows.push({
        ts: `2026-01-01T10:00:0${i}Z`,
        type: "prov:stated",
        sessionID: "ses1",
        text: `prompt ${i}`,
        truncated: false,
      })
    }
    writeSessionJournal(dir, "ses1", rows)
    const r = runProv(dir, ["ses1", "--tail", "2"])
    assert.equal(code(r), 0)
    const lines = r.stdout.trim().split("\n")
    assert.equal(lines.length, 2)
    assert.match(lines[0]!, /prompt 3/)
    assert.match(lines[1]!, /prompt 4/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("the default tail matches the replay default of 2000 rows", () => {
  const dir = metricsDir()
  try {
    const rows: Entry[] = []
    for (let i = 0; i < 2010; i++) {
      const mm = String(Math.floor(i / 60)).padStart(2, "0")
      const ss = String(i % 60).padStart(2, "0")
      rows.push({
        ts: `2026-01-01T10:${mm}:${ss}Z`,
        type: "prov:stated",
        sessionID: "ses1",
        text: `prompt ${String(i).padStart(4, "0")}`,
        truncated: false,
      })
    }
    writeSessionJournal(dir, "ses1", rows)
    const r = runProv(dir, ["ses1"])
    assert.equal(code(r), 0)
    const lines = r.stdout.trim().split("\n")
    assert.equal(lines.length, 2000)
    assert.match(lines[0]!, /prompt 0010/)
    assert.match(lines[1999]!, /prompt 2009/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("a sessionID argument filters both the per-session sink and the shared journal", () => {
  const dir = metricsDir()
  try {
    writeSessionJournal(dir, "ses1", [
      { ts: "2026-01-01T10:00:05Z", type: "prov:stated", sessionID: "ses1", text: "mine" },
    ])
    writeSharedJournal(dir, [
      { ts: "2026-01-01T10:00:10Z", type: "prov:stated", sessionID: "ses1", text: "shared mine" },
      { ts: "2026-01-01T10:00:15Z", type: "prov:stated", sessionID: "ses2", text: "theirs" },
      { ts: "2026-01-01T10:00:20Z", type: "gate", sessionID: "ses1", result: "FAIL" },
    ])
    const r = runProv(dir, ["ses1"])
    assert.equal(code(r), 0)
    const lines = r.stdout.trim().split("\n")
    assert.equal(lines.length, 2)
    assert.match(lines[0]!, /mine/)
    assert.match(lines[1]!, /shared mine/)
    assert.doesNotMatch(r.stdout, /theirs/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("without a sessionID, every session's prov rows are shown", () => {
  const dir = metricsDir()
  try {
    writeSessionJournal(dir, "ses1", [
      { ts: "2026-01-01T10:00:05Z", type: "prov:stated", sessionID: "ses1", text: "one" },
    ])
    writeSessionJournal(dir, "ses2", [
      { ts: "2026-01-01T10:00:10Z", type: "prov:denied", sessionID: "ses2", kind: "hands-on" },
    ])
    writeSharedJournal(dir, [
      { ts: "2026-01-01T10:00:15Z", type: "prov:stated", sessionID: "ses3", text: "three" },
    ])
    const r = runProv(dir, [])
    assert.equal(code(r), 0)
    const lines = r.stdout.trim().split("\n")
    assert.equal(lines.length, 3)
    assert.match(lines[0]!, /one/)
    assert.match(lines[1]!, /denied {2}kind=hands-on/)
    assert.match(lines[2]!, /three/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("a prov row present in both sinks renders once", () => {
  const dir = metricsDir()
  try {
    // A parent-keyed row also present in the shared journal (routing changed
    // mid-session, or a legacy journalPerSession:false layout) must not
    // double-count: journal writes are append-only, so the duplicate is a
    // byte-identical line in the other sink.
    const row = { ts: "2026-01-01T10:00:05Z", type: "prov:stated", sessionID: "ses1", text: "once" }
    writeSessionJournal(dir, "ses1", [row])
    writeSharedJournal(dir, [row])
    const r = runProv(dir, [])
    assert.equal(code(r), 0)
    const lines = r.stdout.trim().split("\n")
    assert.equal(lines.length, 1, `expected one rendered row, got: ${r.stdout}`)
    assert.match(lines[0]!, /once/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("rotated generations are read and ts-ordered", () => {
  const dir = metricsDir()
  try {
    writeSessionJournal(dir, "ses1", [
      { ts: "2026-01-01T10:00:20Z", type: "prov:stated", sessionID: "ses1", text: "newest" },
    ])
    writeSessionJournal(
      dir,
      "ses1",
      [{ ts: "2026-01-01T10:00:05Z", type: "prov:stated", sessionID: "ses1", text: "older" }],
      1,
    )
    const r = runProv(dir, ["ses1"])
    assert.equal(code(r), 0)
    const lines = r.stdout.trim().split("\n")
    assert.equal(lines.length, 2)
    assert.match(lines[0]!, /older/)
    assert.match(lines[1]!, /newest/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("an empty journal exits 0 with no output", () => {
  const dir = metricsDir()
  try {
    const r = runProv(dir, [])
    assert.equal(code(r), 0)
    assert.equal(r.stdout, "")
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("a journal with no prov rows exits 0 with no output", () => {
  const dir = metricsDir()
  try {
    writeSessionJournal(dir, "ses1", [
      { ts: "2026-01-01T10:00:00Z", type: "gate", sessionID: "ses1", result: "PASS", tests: 1 },
    ])
    const r = runProv(dir, ["ses1"])
    assert.equal(code(r), 0)
    assert.equal(r.stdout, "")
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("malformed lines are skipped", () => {
  const dir = metricsDir()
  try {
    mkdirSync(join(dir, "sessions"), { recursive: true })
    writeFileSync(
      join(dir, "sessions", "ses1.jsonl"),
      [
        "not json at all",
        JSON.stringify({
          ts: "2026-01-01T10:00:05Z",
          type: "prov:stated",
          sessionID: "ses1",
          text: "ok",
        }),
      ].join("\n") + "\n",
    )
    const r = runProv(dir, ["ses1"])
    assert.equal(code(r), 0)
    const lines = r.stdout.trim().split("\n")
    assert.equal(lines.length, 1)
    assert.match(lines[0]!, /ok/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("a malformed session id exits 2 with a message", () => {
  const dir = metricsDir()
  try {
    const r = runProv(dir, ["bad id!"])
    assert.equal(code(r), 2)
    assert.match(r.stderr, /unknown or malformed session id "bad id!"/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("an unknown flag exits 2", () => {
  const dir = metricsDir()
  try {
    const r = runProv(dir, ["--wat"])
    assert.equal(code(r), 2)
    assert.match(r.stderr, /unknown argument "--wat"/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("--help prints usage and exits 0", () => {
  const dir = metricsDir()
  try {
    const r = runProv(dir, ["--help"])
    assert.equal(code(r), 0)
    assert.match(r.stdout, /Usage: opencode-turnstile prov/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("the prov subcommand is routed from the CLI router", () => {
  // docstring: bin/cli.mjs routes `prov` onto scripts/prov.mjs, so a router
  // spawn against an empty temp dir exits 0 with no output, like the script.
  const dir = metricsDir()
  try {
    const cli = spawnSync(process.execPath, [join(repoRoot, "bin", "cli.mjs"), "prov"], {
      env: { ...process.env, TURNSTILE_METRICS_DIR: dir },
      encoding: "utf8",
    })
    assert.equal(code(cli), 0)
    assert.equal(cli.stdout, "")
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
