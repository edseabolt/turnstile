/**
 * @fileoverview Tests for the `turnstile log` surface (scripts/log.mjs),
 * driven by spawning the script the same way bin/cli.mjs does. It covers:
 *
 *  - the rendered timeline rows (dispatch with round ordinal and blocked
 *    outcome, gate PASS/FAIL/WAIVED with tests/verified/mode, blocks with
 *    tool/agent/plan subjects, plan, verdict, and the audit rows);
 *  - the summary line (blocks grouped by reason, dispatch/waiver counts
 *    including plan-gate waivers, credited approval folded the way replay
 *    does — task-result verdicts only, last-wins ensemble refusal stamp —
 *    and the final gate state with the replay flip rule);
 *  - session resolution (explicit positional, newest per-session sink,
 *    shared-file fallback, no journal anywhere);
 *  - the shared-file sessionID filter (pre-segmentation rows and
 *    child-keyed rows admitted via child-edge);
 *  - rotation (a `.jsonl.1` generation is included, ts-ordered);
 *  - the CLI surface (--json, --tail valid/invalid, --help, unknown flag,
 *    malformed session ID, malformed lines skipped).
 *
 * All fixtures live in a temp dir under the OS temp dir, never the real
 * metrics directory, and the script is read-only.
 */

import { test } from "node:test"
import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..")
const logScript = join(repoRoot, "scripts", "log.mjs")

/** A journaled entry; fields are deliberately loose (typed `any`). */
type Entry = Record<string, any>

/** Creates a fresh temp metrics dir, returned so the test can remove it. */
function metricsDir(): string {
  return mkdtempSync(join(tmpdir(), "turnstile-log-test-"))
}

/**
 * Runs log.mjs against a temp metrics dir.
 * @param dir The temp metrics directory.
 * @param args Arguments after the subcommand (e.g. `["--json"]`).
 * @returns The spawn result with stdout coerced to string.
 */
function runLog(dir: string, args: string[] = []) {
  return spawnSync(process.execPath, [logScript, ...args], {
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

test("renders dispatch/gate/blocked timeline rows for a fixture journal", () => {
  const dir = metricsDir()
  try {
    mkdirSync(join(dir, "sessions"))
    writeSessionJournal(dir, "ses1", [
      {
        ts: "2026-01-01T10:00:00Z",
        type: "dispatch",
        sessionID: "ses1",
        agent: "planner",
        description: "draft the plan",
      },
      {
        ts: "2026-01-01T10:00:05Z",
        type: "gate",
        sessionID: "ses1",
        result: "PASS",
        tests: 14,
        verified: true,
      },
      {
        ts: "2026-01-01T10:00:10Z",
        type: "blocked",
        sessionID: "ses1",
        tool: "task",
        reason: "no-plan-verdict",
      },
    ])
    const r = runLog(dir, ["ses1"])
    assert.equal(code(r), 0)
    assert.match(r.stdout, /turnstile log — ses1/)
    assert.match(r.stdout, /10:00:00 {2}dispatch {2}planner {2}#1 {2}draft the plan/)
    assert.match(r.stdout, /gate {2}PASS\s+tests=14 verified/)
    assert.match(r.stdout, /block {2}task {2}reason=no-plan-verdict/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("renders a blocked dispatch with its outcome and a second round ordinal", () => {
  const dir = metricsDir()
  try {
    mkdirSync(join(dir, "sessions"))
    writeSessionJournal(dir, "ses1", [
      {
        ts: "2026-01-01T10:00:00Z",
        type: "dispatch",
        sessionID: "ses1",
        agent: "executor",
        description: "first",
      },
      {
        ts: "2026-01-01T10:00:05Z",
        type: "dispatch",
        sessionID: "ses1",
        agent: "executor",
        description: "second",
        blocked: true,
      },
    ])
    const r = runLog(dir, ["ses1"])
    assert.match(r.stdout, /dispatch {2}executor {2}#1 {2}first/)
    assert.match(r.stdout, /dispatch-blocked {2}executor {2}#2 {2}second \(blocked\)/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("renders gate FAIL, unverified PASS, flag-mode PASS, and WAIVED rows", () => {
  const dir = metricsDir()
  try {
    mkdirSync(join(dir, "sessions"))
    writeSessionJournal(dir, "ses1", [
      {
        ts: "2026-01-01T10:00:00Z",
        type: "gate",
        sessionID: "ses1",
        result: "FAIL",
        tests: 3,
        verified: true,
      },
      {
        ts: "2026-01-01T10:00:05Z",
        type: "gate",
        sessionID: "ses1",
        result: "PASS",
        verified: false,
      },
      {
        ts: "2026-01-01T10:00:10Z",
        type: "gate",
        sessionID: "ses1",
        result: "PASS",
        verified: false,
        mode: "flag",
      },
      {
        ts: "2026-01-01T10:00:15Z",
        type: "gate",
        sessionID: "ses1",
        result: "WAIVED",
        channel: "reviewer-dispatch",
        waiver: "user said so",
      },
    ])
    const r = runLog(dir, ["ses1"])
    assert.match(r.stdout, /gate {2}FAIL\s+tests=3 verified/)
    assert.match(r.stdout, /gate {2}PASS\s+unverified/)
    assert.match(r.stdout, /gate {2}PASS\s+unverified mode=flag/)
    assert.match(r.stdout, /gate {2}WAIVED {2}reviewer-dispatch \(user said so\)/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("renders blocked rows with agent subject and plan field", () => {
  const dir = metricsDir()
  try {
    mkdirSync(join(dir, "sessions"))
    writeSessionJournal(dir, "ses1", [
      {
        ts: "2026-01-01T10:00:00Z",
        type: "blocked",
        sessionID: "ses1",
        agent: "reviewer",
        reason: "gate-not-green",
      },
      {
        ts: "2026-01-01T10:00:05Z",
        type: "blocked",
        sessionID: "ses1",
        tool: "write",
        reason: "denylist",
        plan: "feat.md",
      },
    ])
    const r = runLog(dir, ["ses1"])
    assert.match(r.stdout, /block {2}reviewer {2}reason=gate-not-green/)
    assert.match(r.stdout, /block {2}write {2}reason=denylist \(plan feat\.md\)/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("renders plan, verdict, and audit rows each on their own line", () => {
  const dir = metricsDir()
  try {
    mkdirSync(join(dir, "sessions"))
    writeSessionJournal(dir, "ses1", [
      {
        ts: "2026-01-01T10:00:00Z",
        type: "plan",
        sessionID: "ses1",
        result: "APPROVE",
        plan: "feat.md",
        source: "plan-reviewer",
      },
      {
        ts: "2026-01-01T10:00:05Z",
        type: "plan",
        sessionID: "ses1",
        result: "STALE",
        plan: "feat.md",
        reason: "spec-edited",
      },
      {
        ts: "2026-01-01T10:00:10Z",
        type: "verdict",
        sessionID: "ses1",
        marker: "VERDICT: APPROVE crit=0",
        source: "plan-reviewer",
        agent: "plan-reviewer",
      },
      {
        ts: "2026-01-01T10:00:15Z",
        type: "suppressed",
        sessionID: "ses1",
        kind: "echo",
        marker: "GATE: PASS",
      },
      {
        ts: "2026-01-01T10:00:20Z",
        type: "marker-retry",
        sessionID: "ses1",
        agent: "executor",
        attempt: 2,
        outcome: "exhausted",
      },
      { ts: "2026-01-01T10:00:25Z", type: "intent", sessionID: "ses1", kind: "landing" },
      {
        ts: "2026-01-01T10:00:30Z",
        type: "continuation",
        sessionID: "ses1",
        kind: "same-worktree",
      },
      { ts: "2026-01-01T10:00:35Z", type: "violation", sessionID: "ses1", reason: "denylist hit" },
    ])
    const r = runLog(dir, ["ses1"])
    assert.match(r.stdout, /plan {2}APPROVE {2}feat\.md \(source plan-reviewer\)/)
    assert.match(r.stdout, /plan {2}STALE {2}feat\.md reason=spec-edited/)
    assert.match(
      r.stdout,
      /verdict {2}VERDICT: APPROVE crit=0 \(source plan-reviewer, agent plan-reviewer\)/,
    )
    assert.match(r.stdout, /suppressed {2}kind=echo {2}marker=GATE: PASS/)
    assert.match(r.stdout, /marker-retry\s+attempt=2\s+outcome=exhausted\s+agent=executor/)
    assert.match(r.stdout, /intent {2}kind=landing/)
    assert.match(r.stdout, /continuation {2}kind=same-worktree/)
    assert.match(r.stdout, /violation {2}reason=denylist hit/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("renders an unknown entry type as unrecognized without crashing", () => {
  const dir = metricsDir()
  try {
    mkdirSync(join(dir, "sessions"))
    writeSessionJournal(dir, "ses1", [
      { ts: "2026-01-01T10:00:00Z", type: "hologram", sessionID: "ses1", x: 1 },
    ])
    const r = runLog(dir, ["ses1"])
    assert.equal(code(r), 0)
    assert.match(r.stdout, /hologram {2}\(unrecognized\)/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("summary line groups blocks by reason and applies the gate flip rule", () => {
  const dir = metricsDir()
  try {
    mkdirSync(join(dir, "sessions"))
    writeSessionJournal(dir, "ses1", [
      {
        ts: "2026-01-01T10:00:00Z",
        type: "blocked",
        sessionID: "ses1",
        tool: "task",
        reason: "no-plan-verdict",
      },
      {
        ts: "2026-01-01T10:00:05Z",
        type: "blocked",
        sessionID: "ses1",
        tool: "task",
        reason: "no-plan-verdict",
      },
      {
        ts: "2026-01-01T10:00:10Z",
        type: "blocked",
        sessionID: "ses1",
        tool: "bash",
        reason: "denylist",
      },
      {
        ts: "2026-01-01T10:00:15Z",
        type: "gate",
        sessionID: "ses1",
        result: "FAIL",
        tests: 3,
        verified: true,
      },
      {
        ts: "2026-01-01T10:00:20Z",
        type: "gate",
        sessionID: "ses1",
        result: "PASS",
        verified: false,
      },
      {
        ts: "2026-01-01T10:00:25Z",
        type: "gate",
        sessionID: "ses1",
        result: "WAIVED",
        channel: "reviewer-dispatch",
      },
    ])
    const r = runLog(dir, ["ses1"])
    assert.match(
      r.stdout,
      /summary: 3 blocks \(no-plan-verdict×2, denylist×1\), 0 dispatches, 1 waivers, credited approval: no, final gate FAIL/,
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("summary reports credited approval yes unless a later ensemble refused it", () => {
  const dir = metricsDir()
  try {
    mkdirSync(join(dir, "sessions"))
    writeSessionJournal(dir, "ses1", [
      {
        ts: "2026-01-01T10:00:00Z",
        type: "verdict",
        sessionID: "ses1",
        marker: "VERDICT: APPROVE crit=0",
        source: "task-result",
      },
    ])
    const yes = runLog(dir, ["ses1"])
    assert.match(yes.stdout, /credited approval: yes/)

    writeSessionJournal(dir, "ses1", [
      {
        ts: "2026-01-01T10:00:00Z",
        type: "verdict",
        sessionID: "ses1",
        marker: "VERDICT: APPROVE crit=0",
        source: "task-result",
      },
      {
        ts: "2026-01-01T10:00:05Z",
        type: "ensemble",
        sessionID: "ses1",
        count: 1,
        refusedApprove: true,
      },
    ])
    const no = runLog(dir, ["ses1"])
    assert.match(no.stdout, /credited approval: no/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("summary credits only task-result verdicts and honors the refusal stamp fold", () => {
  const dir = metricsDir()
  try {
    mkdirSync(join(dir, "sessions"))
    // A verdict not attributed to a task result is never credited.
    writeSessionJournal(dir, "ses1", [
      {
        ts: "2026-01-01T10:00:00Z",
        type: "verdict",
        sessionID: "ses1",
        marker: "VERDICT: APPROVE crit=0",
        source: "child-text",
      },
    ])
    const nonTask = runLog(dir, ["ses1"])
    assert.match(nonTask.stdout, /credited approval: no/)

    // A refusal cleared by a later human-grant ensemble entry is credited.
    writeSessionJournal(dir, "ses1", [
      {
        ts: "2026-01-01T10:00:00Z",
        type: "verdict",
        sessionID: "ses1",
        marker: "VERDICT: APPROVE crit=0",
        source: "task-result",
      },
      {
        ts: "2026-01-01T10:00:05Z",
        type: "ensemble",
        sessionID: "ses1",
        count: 1,
        refusedApprove: true,
      },
      {
        ts: "2026-01-01T10:00:10Z",
        type: "ensemble",
        sessionID: "ses1",
        count: 2,
        refusedApprove: false,
      },
    ])
    const cleared = runLog(dir, ["ses1"])
    assert.match(cleared.stdout, /credited approval: yes/)

    // A verdict arriving after a refusal does not re-credit itself.
    writeSessionJournal(dir, "ses1", [
      {
        ts: "2026-01-01T10:00:00Z",
        type: "ensemble",
        sessionID: "ses1",
        count: 1,
        refusedApprove: true,
      },
      {
        ts: "2026-01-01T10:00:05Z",
        type: "verdict",
        sessionID: "ses1",
        marker: "VERDICT: APPROVE crit=0",
        source: "task-result",
      },
    ])
    const afterRefusal = runLog(dir, ["ses1"])
    assert.match(afterRefusal.stdout, /credited approval: no/)

    // A trailing task-result BLOCK clears an earlier APPROVE.
    writeSessionJournal(dir, "ses1", [
      {
        ts: "2026-01-01T10:00:00Z",
        type: "verdict",
        sessionID: "ses1",
        marker: "VERDICT: APPROVE crit=0",
        source: "task-result",
      },
      {
        ts: "2026-01-01T10:00:05Z",
        type: "verdict",
        sessionID: "ses1",
        marker: "VERDICT: BLOCK gate-not-green",
        source: "task-result",
      },
    ])
    const blocked = runLog(dir, ["ses1"])
    assert.match(blocked.stdout, /credited approval: no/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("counts plan-gate waiver rows and renders their channel and waiver text", () => {
  const dir = metricsDir()
  try {
    mkdirSync(join(dir, "sessions"))
    writeSessionJournal(dir, "ses1", [
      {
        ts: "2026-01-01T10:00:00Z",
        type: "plan",
        sessionID: "ses1",
        result: "WAIVED",
        channel: "prompt",
        waiver: "user said so",
      },
    ])
    const r = runLog(dir, ["ses1"])
    assert.match(r.stdout, /plan {2}WAIVED {2}prompt \(user said so\)/)
    assert.match(r.stdout, /1 waivers/)
    const j = runLog(dir, ["ses1", "--json"])
    assert.equal(JSON.parse(j.stdout).summary.waivers, 1)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("defaults to the newest per-session sink by mtime", () => {
  const dir = metricsDir()
  try {
    mkdirSync(join(dir, "sessions"))
    writeSessionJournal(dir, "old", [
      { ts: "2026-01-01T10:00:00Z", type: "intent", sessionID: "old", kind: "x" },
    ])
    writeSessionJournal(dir, "new", [
      { ts: "2026-01-01T10:00:00Z", type: "intent", sessionID: "new", kind: "y" },
    ])
    const past = new Date(Date.now() - 60_000)
    utimesSync(join(dir, "sessions", "old.jsonl"), past, past)
    const r = runLog(dir, [])
    assert.match(r.stdout, /turnstile log — new\b/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("falls back to the last sessionID in the shared journal when no sinks exist", () => {
  const dir = metricsDir()
  try {
    writeSharedJournal(dir, [
      { ts: "2026-01-01T10:00:00Z", type: "intent", sessionID: "legacy1", kind: "x" },
      { ts: "2026-01-01T10:00:05Z", type: "intent", sessionID: "legacy2", kind: "y" },
    ])
    const r = runLog(dir, [])
    assert.match(r.stdout, /turnstile log — legacy2/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("prints the no-journal note and exits 0 when nothing is recorded", () => {
  const dir = metricsDir()
  try {
    const r = runLog(dir, [])
    assert.equal(code(r), 0)
    assert.match(r.stdout, /No turnstile journal yet at .* — nothing to report\./)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("filters the shared journal by sessionID and admits child-keyed rows via child-edge", () => {
  const dir = metricsDir()
  try {
    mkdirSync(join(dir, "sessions"))
    writeSharedJournal(dir, [
      {
        ts: "2026-01-01T10:00:00Z",
        type: "gate",
        sessionID: "ses1",
        result: "PASS",
        tests: 1,
        verified: true,
      },
      {
        ts: "2026-01-01T10:00:05Z",
        type: "gate",
        sessionID: "other",
        result: "PASS",
        tests: 2,
        verified: true,
      },
      {
        ts: "2026-01-01T10:00:10Z",
        type: "child-edge",
        sessionID: "child9",
        parent: "ses1",
        agent: "executor",
      },
      {
        ts: "2026-01-01T10:00:15Z",
        type: "marker-retry",
        sessionID: "child9",
        agent: "executor",
        attempt: 1,
        outcome: "exhausted",
      },
    ])
    const r = runLog(dir, ["ses1"])
    assert.match(r.stdout, /gate {2}PASS\s+tests=1 verified/)
    assert.doesNotMatch(r.stdout, /tests=2/)
    assert.match(r.stdout, /marker-retry\s+attempt=1\s+outcome=exhausted\s+agent=executor/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("includes rotated generations ts-ordered with the current file", () => {
  const dir = metricsDir()
  try {
    mkdirSync(join(dir, "sessions"))
    writeSessionJournal(dir, "ses1", [
      { ts: "2026-01-01T10:00:10Z", type: "intent", sessionID: "ses1", kind: "newer" },
    ])
    writeSessionJournal(
      dir,
      "ses1",
      [{ ts: "2026-01-01T10:00:00Z", type: "intent", sessionID: "ses1", kind: "older" }],
      1,
    )
    const r = runLog(dir, ["ses1"])
    const older = r.stdout.indexOf("older")
    const newer = r.stdout.indexOf("newer")
    assert.ok(older !== -1 && newer !== -1 && older < newer, "older generation renders first")
    assert.match(r.stdout, /files: ses1\.jsonl\.1, ses1\.jsonl/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("skips malformed journal lines silently", () => {
  const dir = metricsDir()
  try {
    mkdirSync(join(dir, "sessions"))
    writeFileSync(
      join(dir, "sessions", "ses1.jsonl"),
      "{not json\n" +
        JSON.stringify({
          ts: "2026-01-01T10:00:00Z",
          type: "intent",
          sessionID: "ses1",
          kind: "ok",
        }) +
        "\n",
    )
    const r = runLog(dir, ["ses1"])
    assert.equal(code(r), 0)
    assert.match(r.stdout, /intent {2}kind=ok/)
    assert.equal(r.stderr, "")
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("--json emits machine-readable entries and summary for the same fixture", () => {
  const dir = metricsDir()
  try {
    mkdirSync(join(dir, "sessions"))
    writeSessionJournal(dir, "ses1", [
      {
        ts: "2026-01-01T10:00:00Z",
        type: "dispatch",
        sessionID: "ses1",
        agent: "planner",
        description: "d",
      },
      {
        ts: "2026-01-01T10:00:05Z",
        type: "blocked",
        sessionID: "ses1",
        tool: "task",
        reason: "no-plan-verdict",
      },
      {
        ts: "2026-01-01T10:00:10Z",
        type: "gate",
        sessionID: "ses1",
        result: "PASS",
        tests: 4,
        verified: true,
      },
    ])
    const r = runLog(dir, ["ses1", "--json"])
    assert.equal(code(r), 0)
    const doc = JSON.parse(r.stdout)
    assert.equal(doc.session, "ses1")
    assert.equal(doc.entries.length, 3)
    assert.equal(doc.summary.blocks["no-plan-verdict"], 1)
    assert.equal(doc.summary.dispatches, 1)
    assert.equal(doc.summary.finalGate, "PASS")
    assert.equal(doc.summary.creditedApproval, "no")
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("--tail bounds the rendered window", () => {
  const dir = metricsDir()
  try {
    mkdirSync(join(dir, "sessions"))
    writeSessionJournal(dir, "ses1", [
      { ts: "2026-01-01T10:00:00Z", type: "intent", sessionID: "ses1", kind: "first" },
      { ts: "2026-01-01T10:00:05Z", type: "intent", sessionID: "ses1", kind: "second" },
    ])
    const r = runLog(dir, ["ses1", "--tail", "1"])
    assert.match(r.stdout, /1 entries/)
    assert.doesNotMatch(r.stdout, /kind=first/)
    assert.match(r.stdout, /kind=second/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("--tail rejects zero and non-numeric values with exit 2", () => {
  const dir = metricsDir()
  try {
    for (const bad of ["0", "abc"]) {
      const r = runLog(dir, ["ses1", "--tail", bad])
      assert.equal(code(r), 2, `--tail ${bad} must exit 2`)
      assert.match(r.stderr, /--tail expects a positive integer/)
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("a malformed session id exits 2 with a message", () => {
  const dir = metricsDir()
  try {
    const r = runLog(dir, ["bad id!"])
    assert.equal(code(r), 2)
    assert.match(r.stderr, /unknown or malformed session id "bad id!"/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("an unknown flag exits 2", () => {
  const dir = metricsDir()
  try {
    const r = runLog(dir, ["--wat"])
    assert.equal(code(r), 2)
    assert.match(r.stderr, /unknown argument "--wat"/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("--help prints usage and exits 0", () => {
  const dir = metricsDir()
  try {
    const r = runLog(dir, ["--help"])
    assert.equal(code(r), 0)
    assert.match(r.stdout, /Usage: opencode-turnstile log/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
