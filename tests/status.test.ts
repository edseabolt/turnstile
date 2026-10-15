/**
 * @fileoverview Tests for the `turnstile status` surface (scripts/status.mjs),
 * driven by spawning the script the same way bin/cli.mjs does. It covers:
 *
 *  - gate/plan flag restoration parity with the real replay in
 *    src/state.ts (last PASS/FAIL wins; trailing FAIL keeps the gate red;
 *    enforce-mode `verified:false` never flips) via `createLedger().peek()`;
 *  - the `.1` generation + current file replay window;
 *  - per-session counts (dispatch/block/permission asks+decisions);
 *  - last markers (text + timestamp);
 *  - waiver events (with channel) and prompt-channel plan approvals;
 *  - the `--json` shape;
 *  - absent journal (exit 0 + note), malformed lines (skipped), and unknown
 *    flags (exit 2).
 *
 * All fixtures live in a temp dir under the OS temp dir, never the real
 * metrics directory, and the script is read-only.
 */

import { test } from "node:test"
import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

import { createLedger } from "../src/state.ts"

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..")
const statusScript = join(repoRoot, "scripts", "status.mjs")

/** A journaled entry; fields are deliberately loose (typed `any`). */
type Entry = Record<string, any>

/** The `--json` status document shape the tests key off. */
interface PlanApproval {
  effective: string | null
  verdict: string | null
  source: string | null
  promptApproval: boolean
}
interface StatusSession {
  hasGatePass: boolean
  hasPlanVerdict: boolean
  planApproval: PlanApproval
  lastGate: { marker: string; ts: string }
  lastVerdict: { marker: string; ts: string }
  waivers: Array<{ channel: string; waiver: string }>
  dispatches: number
  blocks: number
  permissionAsks: number
  permissionDecisions: { once: number; always: number; reject: number }
}
interface StatusJSON {
  journal: string
  files: string[]
  noJournal: boolean
  sessions: Record<string, StatusSession>
}

/** Creates a fresh temp metrics dir, returned so the test can remove it. */
function metricsDir(): string {
  return mkdtempSync(join(tmpdir(), "turnstile-status-test-"))
}

/**
 * Runs status.mjs against a temp metrics dir.
 * @param dir The temp metrics directory.
 * @param args Arguments after the subcommand (e.g. `["--json"]`).
 * @returns The spawn result with stdout coerced to string.
 */
function runStatus(dir: string, args: string[] = []) {
  return spawnSync(process.execPath, [statusScript, ...args], {
    env: { ...process.env, TURNSTILE_METRICS_DIR: dir },
    encoding: "utf8",
  })
}

/**
 * Normalizes the spawn exit code across Node builds: this build exposes it on
 * `status`; older builds expose `exitCode`. Both are `null`-free here because
 * every script under test exits normally (never errors out).
 * @param res The spawnSync result.
 * @returns The numeric exit code, or -1 when the process did not exit cleanly.
 */
function code(res: { status: number | null; exitCode?: number | null }): number {
  return res.status ?? res.exitCode ?? -1
}

/**
 * Reads one session from a status document, failing the test loudly if the
 * spawn produced none (guards `noUncheckedIndexedAccess`).
 * @param obj The parsed status document.
 * @param id The parent session ID.
 * @returns The session accumulator.
 */
function oSession(obj: StatusJSON, id: string): StatusSession {
  const s = obj.sessions[id]
  if (s === undefined) throw new Error(`session ${id} absent from status output`)
  return s
}

/** Writes a journal file (current or a `.1` generation) from JSONL lines. */
function writeJournal(dir: string, file: string, lines: Entry[]): void {
  writeFileSync(join(dir, file), lines.map((l) => JSON.stringify(l)).join("\n") + "\n")
}

/** Builds a journal entry with a monotonic ISO timestamp. */
function line(ts: number, entry: Entry): Entry {
  return { ts: new Date(ts).toISOString(), ...entry }
}

const KEYS: Array<keyof StatusSession> = [
  "hasGatePass",
  "hasPlanVerdict",
  "planApproval",
  "lastGate",
  "lastVerdict",
  "waivers",
  "dispatches",
  "blocks",
  "permissionAsks",
  "permissionDecisions",
]

/**
 * Confirms every session's restored flags in the status `--json` output match
 * the ground truth from `createLedger().peek()`, and that the shape carries the
 * expected keys.
 * @param obj The parsed status document.
 * @param journalPath The journal path used to build the ground-truth ledger.
 */
function assertReplayParity(obj: StatusJSON, journalPath: string): void {
  const ledger = createLedger(journalPath)
  for (const [id, sess] of Object.entries(obj.sessions)) {
    const peek = ledger.peek(id)
    // Ground truth: a session replayed green iff peek exposes the restored flag.
    const expGate = peek?.hasGatePass ?? false
    const expPlan = peek?.hasPlanVerdict ?? false
    assert.equal(sess.hasGatePass, expGate, `${id}: hasGatePass parity`)
    assert.equal(sess.hasPlanVerdict, expPlan, `${id}: hasPlanVerdict parity`)
    for (const key of KEYS) assert.ok(key in sess, `${id}: missing key ${String(key)}`)
  }
}

/** The gate-flag reversal fixture: trailing FAIL wins; enforce unverified PASS
 *  never flips; flag unverified PASS flips then FAIL overrides. */
const TRAILING_FAIL: Entry[] = [
  line(1, {
    type: "gate",
    sessionID: "sp-trailfail",
    result: "PASS",
    verified: false,
    mode: "enforce",
    marker: "GATE: PASS tests=1 passed=1 failed=0",
  }),
  line(2, {
    type: "gate",
    sessionID: "sp-trailfail",
    result: "PASS",
    verified: false,
    mode: "flag",
    marker: "GATE: PASS tests=2 passed=2 failed=0",
  }),
  line(3, {
    type: "gate",
    sessionID: "sp-trailfail",
    result: "FAIL",
    marker: "GATE: FAIL tests=2 passed=1 failed=1",
  }),
]

/** A `.1` generation carrying the older, pre-restart half of one session. */
const GEN1: Entry[] = [
  line(1, {
    type: "gate",
    sessionID: "sp-split",
    result: "PASS",
    verified: false,
    mode: "flag",
    marker: "GATE: PASS tests=1 passed=1 failed=0",
  }),
  line(2, { type: "plan", sessionID: "sp-split", result: "APPROVE", source: "task-result" }),
]

/** The current file carrying the decisive (newer) half of that session. */
const GEN0: Entry[] = [
  line(3, {
    type: "gate",
    sessionID: "sp-split",
    result: "FAIL",
    marker: "GATE: FAIL tests=1 passed=0 failed=1",
  }),
  line(4, {
    type: "gate",
    sessionID: "sp-new",
    result: "PASS",
    verified: true,
    mode: "enforce",
    marker: "GATE: PASS tests=5 passed=5 failed=0",
  }),
  line(5, { type: "plan", sessionID: "sp-new", result: "APPROVE", source: "task-result" }),
]

test("flag restoration matches state.ts replay: trailing FAIL wins and enforce unverified PASS never flips", () => {
  const dir = metricsDir()
  try {
    const journalPath = join(dir, "turnstile.jsonl")
    writeJournal(dir, "turnstile.jsonl", TRAILING_FAIL)
    const res = runStatus(dir, ["--json"])
    assert.equal(code(res), 0)
    const obj = JSON.parse(res.stdout) as StatusJSON
    assertReplayParity(obj, journalPath)
    // enforce unverified PASS is skipped; flag unverified PASS flips; trailing
    // FAIL overrides it → gate is red. No plan entry exists, so no plan approval.
    assert.equal(
      oSession(obj, "sp-trailfail").hasGatePass,
      false,
      "trailing FAIL keeps the gate red",
    )
    assert.equal(oSession(obj, "sp-trailfail").hasPlanVerdict, false, "no plan APPROVE restores")
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("reads the .1 generation and current file, with slice(-2000) window parity", () => {
  const dir = metricsDir()
  try {
    const journalPath = join(dir, "turnstile.jsonl")
    // sp-split flips green in .1 (flag unverified PASS + plan APPROVE) then the
    // current file drives it red with a trailing FAIL — so .1 must be read and
    // the tail bound holds across both files.
    writeJournal(dir, "turnstile.jsonl.1", GEN1)
    writeJournal(dir, "turnstile.jsonl", GEN0)
    const res = runStatus(dir, ["--json"])
    assert.equal(code(res), 0)
    const obj = JSON.parse(res.stdout) as StatusJSON
    // The journal files are reported oldest-first.
    assert.deepEqual(obj.files, ["turnstile.jsonl.1", "turnstile.jsonl"])
    assertReplayParity(obj, journalPath)
    assert.equal(oSession(obj, "sp-split").hasGatePass, false, ".1 + current trailing FAIL")
    assert.equal(oSession(obj, "sp-split").hasPlanVerdict, true, "plan APPROVE from .1 restores")
    assert.equal(oSession(obj, "sp-new").hasGatePass, true)
    assert.equal(oSession(obj, "sp-new").hasPlanVerdict, true)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("verifying kinds restore green: plain PASS, flag unverified PASS, and legacy field-less PASS", () => {
  const dir = metricsDir()
  try {
    const journalPath = join(dir, "turnstile.jsonl")
    writeJournal(dir, "turnstile.jsonl", [
      line(1, {
        type: "gate",
        sessionID: "sp-plain",
        result: "PASS",
        verified: true,
        mode: "enforce",
        marker: "GATE: PASS tests=1 passed=1 failed=0",
      }),
      line(2, {
        type: "gate",
        sessionID: "sp-flag",
        result: "PASS",
        verified: false,
        mode: "flag",
        marker: "GATE: PASS tests=1 passed=1 failed=0",
      }),
      line(3, {
        type: "gate",
        sessionID: "sp-legacy",
        result: "PASS",
        marker: "GATE: PASS tests=1 passed=1 failed=0",
      }),
      line(4, {
        type: "gate",
        sessionID: "sp-enforceunverified",
        result: "PASS",
        verified: false,
        mode: "enforce",
        marker: "GATE: PASS tests=1 passed=1 failed=0",
      }),
    ])
    const res = runStatus(dir, ["--json"])
    assert.equal(code(res), 0)
    const obj = JSON.parse(res.stdout) as StatusJSON
    assertReplayParity(obj, journalPath)
    assert.equal(oSession(obj, "sp-plain").hasGatePass, true)
    assert.equal(
      oSession(obj, "sp-flag").hasGatePass,
      true,
      "flag unverified PASS DID flip at runtime",
    )
    assert.equal(
      oSession(obj, "sp-legacy").hasGatePass,
      true,
      "legacy field-less PASS restores (fail-open)",
    )
    assert.equal(
      oSession(obj, "sp-enforceunverified").hasGatePass,
      false,
      "enforce unverified PASS never flips",
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("plan approval state: session-prompt approval restores plan gate and is surfaced", () => {
  const dir = metricsDir()
  try {
    const journalPath = join(dir, "turnstile.jsonl")
    writeJournal(dir, "turnstile.jsonl", [
      line(1, {
        type: "plan",
        sessionID: "sp-prompt",
        result: "APPROVE",
        source: "session-prompt",
        marker: "PLAN APPROVED:",
        ts: new Date(1).toISOString(),
      }),
      line(2, {
        type: "verdict",
        sessionID: "sp-prompt",
        marker: "VERDICT: APPROVE crit=0 high=0 med=0 low=0",
        source: "task-result",
        ts: new Date(2).toISOString(),
      }),
    ])
    const res = runStatus(dir, ["--json"])
    assert.equal(code(res), 0)
    const obj = JSON.parse(res.stdout) as StatusJSON
    assertReplayParity(obj, journalPath)
    const pa = oSession(obj, "sp-prompt").planApproval
    assert.equal(
      oSession(obj, "sp-prompt").hasPlanVerdict,
      true,
      "prompt approval replays like any plan APPROVE",
    )
    assert.equal(pa.promptApproval, true, "session-prompt approval surfaced")
    assert.equal(pa.effective, "APPROVE")
    assert.equal(pa.verdict, "APPROVE")
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("counts: dispatch, block, and permission asks + once/always/reject decisions", () => {
  const dir = metricsDir()
  try {
    writeJournal(dir, "turnstile.jsonl", [
      line(1, {
        type: "dispatch",
        sessionID: "sp-c",
        agent: "reviewer",
        ts: new Date(1).toISOString(),
      }),
      line(2, {
        type: "dispatch",
        sessionID: "sp-c",
        agent: "executor",
        ts: new Date(2).toISOString(),
      }),
      line(3, {
        type: "dispatch",
        sessionID: "sp-c",
        agent: "executor",
        ts: new Date(3).toISOString(),
      }),
      line(4, {
        type: "blocked",
        sessionID: "sp-c",
        agent: "reviewer",
        reason: "round-limit",
        ts: new Date(4).toISOString(),
      }),
      line(5, {
        type: "blocked",
        sessionID: "sp-c",
        tool: "read",
        reason: "read-limit",
        ts: new Date(5).toISOString(),
      }),
      line(6, {
        type: "permission",
        sessionID: "sp-c",
        action: "ask",
        reason: "plan-gate",
        plan: "plans.md",
        ts: new Date(6).toISOString(),
      }),
      line(7, {
        type: "permission",
        sessionID: "sp-c",
        decision: "once",
        ts: new Date(7).toISOString(),
      }),
      line(8, {
        type: "permission",
        sessionID: "sp-c",
        decision: "always",
        ts: new Date(8).toISOString(),
      }),
      line(9, {
        type: "permission",
        sessionID: "sp-c",
        decision: "reject",
        ts: new Date(9).toISOString(),
      }),
    ])
    const res = runStatus(dir, ["--json"])
    assert.equal(code(res), 0)
    const obj = JSON.parse(res.stdout) as StatusJSON
    const s = oSession(obj, "sp-c")
    assert.equal(s.dispatches, 3)
    assert.equal(s.blocks, 2)
    assert.equal(s.permissionAsks, 1)
    assert.deepEqual(s.permissionDecisions, { once: 1, always: 1, reject: 1 })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("last markers carry the marker text and timestamp", () => {
  const dir = metricsDir()
  try {
    writeJournal(dir, "turnstile.jsonl", [
      line(1, {
        type: "gate",
        sessionID: "sp-m",
        result: "PASS",
        verified: true,
        mode: "enforce",
        marker: "GATE: PASS tests=1 passed=1 failed=0",
        ts: new Date(1).toISOString(),
      }),
      line(2, {
        type: "verdict",
        sessionID: "sp-m",
        marker: "VERDICT: APPROVE crit=0 high=1 med=0 low=0",
        source: "task-result",
        ts: new Date(2).toISOString(),
      }),
      line(3, {
        type: "gate",
        sessionID: "sp-m",
        result: "PASS",
        verified: true,
        mode: "enforce",
        marker: "GATE: PASS tests=2 passed=2 failed=0",
        ts: new Date(3).toISOString(),
      }),
    ])
    const res = runStatus(dir, ["--json"])
    assert.equal(code(res), 0)
    const obj = JSON.parse(res.stdout) as StatusJSON
    const s = oSession(obj, "sp-m")
    assert.equal(
      s.lastGate.marker,
      "GATE: PASS tests=2 passed=2 failed=0",
      "last GATE marker (latest wins)",
    )
    assert.equal(s.lastGate.ts, new Date(3).toISOString())
    assert.equal(s.lastVerdict.marker, "VERDICT: APPROVE crit=0 high=1 med=0 low=0")
    assert.equal(s.lastVerdict.ts, new Date(2).toISOString())
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("waiver events carry their channel", () => {
  const dir = metricsDir()
  try {
    writeJournal(dir, "turnstile.jsonl", [
      line(1, {
        type: "gate",
        sessionID: "sp-w",
        result: "WAIVED",
        channel: "prompt",
        waiver: "<present>",
        ts: new Date(1).toISOString(),
      }),
      line(2, {
        type: "plan",
        sessionID: "sp-w",
        result: "WAIVED",
        channel: "prompt",
        waiver: "<present>",
        ts: new Date(2).toISOString(),
      }),
    ])
    const res = runStatus(dir, ["--json"])
    assert.equal(code(res), 0)
    const obj = JSON.parse(res.stdout) as StatusJSON
    const s = oSession(obj, "sp-w")
    assert.equal(s.waivers.length, 2)
    assert.ok(s.waivers.every((w) => w.channel === "prompt"))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("--json output is valid JSON with the expected top-level and per-session keys", () => {
  const dir = metricsDir()
  try {
    writeJournal(dir, "turnstile.jsonl", [
      line(1, {
        type: "dispatch",
        sessionID: "sp-k",
        agent: "reviewer",
        ts: new Date(1).toISOString(),
      }),
    ])
    const res = runStatus(dir, ["--json"])
    assert.equal(code(res), 0)
    const obj = JSON.parse(res.stdout) as StatusJSON
    for (const key of ["journal", "files", "noJournal", "sessions"]) {
      assert.ok(key in obj, `top-level key ${String(key)}`)
    }
    assert.equal(obj.noJournal, false)
    const s = oSession(obj, "sp-k")
    assert.ok(s)
    for (const key of KEYS) assert.ok(key in s, `session key ${String(key)}`)
    assert.ok(["once", "always", "reject"].every((k) => k in s.permissionDecisions))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("absent journal file exits 0 with a 'no journal yet' note (table and json)", () => {
  const dir = metricsDir()
  try {
    const table = runStatus(dir, [])
    assert.equal(code(table), 0)
    assert.match(table.stdout, /journal yet/i)
    assert.match(table.stdout, /nothing to report/i)

    const json = runStatus(dir, ["--json"])
    assert.equal(code(json), 0)
    const obj = JSON.parse(json.stdout) as StatusJSON
    assert.equal(obj.noJournal, true)
    assert.deepEqual(obj.sessions, {})
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("malformed journal lines are skipped, valid sessions still aggregate", () => {
  const dir = metricsDir()
  try {
    const journalPath = join(dir, "turnstile.jsonl")
    writeJournal(dir, "turnstile.jsonl", [
      line(1, {
        type: "gate",
        sessionID: "sp-mal",
        result: "PASS",
        verified: true,
        mode: "enforce",
        marker: "GATE: PASS tests=1 passed=1 failed=0",
      }),
    ])
    // Append raw garbage right onto the current file (bypasses writeJournal).
    const garbage = [
      "this is not json",
      '{"ts":"2026-01-01T00:00:00.000Z","type":"gate","sessionID":"sp-mal","result":', // truncated
      "42",
      '"just a string"',
    ]
    writeFileSync(journalPath, readFileSync(journalPath, "utf8") + garbage.join("\n") + "\n")
    const res = runStatus(dir, ["--json"])
    assert.equal(code(res), 0)
    const obj = JSON.parse(res.stdout) as StatusJSON
    // The malformed lines did not create phantom sessions.
    assert.deepEqual(Object.keys(obj.sessions), ["sp-mal"])
    assert.equal(oSession(obj, "sp-mal").hasGatePass, true)
    assertReplayParity(obj, journalPath)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("unknown flags exit 2", () => {
  const dir = metricsDir()
  try {
    const res = runStatus(dir, ["--bogus"])
    assert.equal(code(res), 2)
    assert.match(res.stderr, /unknown argument/i)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("status subcommand is routed from the CLI router", () => {
  const dir = metricsDir()
  try {
    // bin/cli.mjs routes `status` onto scripts/status.mjs; a --json spawn of the
    // router against an empty temp dir must behave like the script directly.
    const cli = spawnSync(
      process.execPath,
      [join(repoRoot, "bin", "cli.mjs"), "status", "--json"],
      {
        env: { ...process.env, TURNSTILE_METRICS_DIR: dir },
        encoding: "utf8",
      },
    )
    assert.equal(code(cli), 0)
    const obj = JSON.parse(cli.stdout) as StatusJSON
    assert.equal(obj.noJournal, true)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
