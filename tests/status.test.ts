/**
 * @fileoverview Tests for the `turnstile status` surface (scripts/status.mjs),
 * driven by spawning the script the same way bin/cli.mjs does. It covers:
 *
 *  - gate/plan flag restoration parity with the real replay in
 *    src/ledger.ts (last PASS/FAIL wins; trailing FAIL keeps the gate red;
 *    enforce-mode `verified:false` never flips) via `createLedger().peek()`;
 *  - the replay window across all retained journal generations (a newest-first
 *    walk that stops once the tail bound is met);
 *  - per-session counts (dispatch/block/permission asks+decisions);
 *  - last markers (text + timestamp);
 *  - waiver events (with channel) and prompt-channel plan approvals;
 *  - the `--json` shape;
 *  - the observe-mode header line (phase + period totals, rendered only when
 *    the journal holds observe-mode entries; journals without them stay
 *    byte-identical);
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

import { createLedger } from "../src/ledger.ts"

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

/** Writes a journal file (current or a rotated generation) from JSONL lines. */
function writeJournal(dir: string, file: string, lines: Entry[]): void {
  writeFileSync(join(dir, file), lines.map((l) => JSON.stringify(l)).join("\n") + "\n")
}

/** Builds a journal entry with a monotonic ISO timestamp. */
function line(ts: number, entry: Entry): Entry {
  return { ts: new Date(ts).toISOString(), ...entry }
}

/**
 * Writes an eight-entry `WAIVED` gate journal for one session. Waivers are a
 * cumulative counter — the only last-wins-invisible observable — so the replay
 * tail bound is readable off it: a tail of N keeps exactly the last N entries.
 * @param dir The metrics directory to write into.
 */
function writeTailJournal(dir: string): void {
  writeJournal(
    dir,
    "turnstile.jsonl",
    Array.from({ length: 8 }, (_, i) =>
      line(i + 1, {
        type: "gate",
        sessionID: "sp-tail",
        result: "WAIVED",
        channel: "prompt",
        waiver: "<present>",
      }),
    ),
  )
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
  const ledger = createLedger(journalPath, 64, 2000)
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

test("flag restoration matches ledger.ts replay: trailing FAIL wins and enforce unverified PASS never flips", () => {
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

test("reads the .1 generation and current file, with replay-tail window parity", () => {
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

test("walks back through all retained generations, oldest-first, until the tail bound is met", () => {
  const dir = metricsDir()
  try {
    const journalPath = join(dir, "turnstile.jsonl")
    // sp-deep only goes green in the .2 generation; .1 and the current file
    // carry filler for a different session, so surfacing sp-deep proves the
    // walk went back past .1, not just current + .1.
    writeJournal(dir, "turnstile.jsonl.2", [
      line(1, {
        type: "gate",
        sessionID: "sp-deep",
        result: "PASS",
        verified: true,
        mode: "enforce",
        marker: "GATE: PASS tests=1 passed=1 failed=0",
      }),
    ])
    writeJournal(dir, "turnstile.jsonl.1", [
      line(2, { type: "dispatch", sessionID: "sp-fill", agent: "executor" }),
    ])
    writeJournal(dir, "turnstile.jsonl", [
      line(3, { type: "dispatch", sessionID: "sp-fill", agent: "executor" }),
    ])
    const res = runStatus(dir, ["--json"])
    assert.equal(code(res), 0)
    const obj = JSON.parse(res.stdout) as StatusJSON
    // The journal files are reported oldest-first, spanning three generations.
    assert.deepEqual(obj.files, ["turnstile.jsonl.2", "turnstile.jsonl.1", "turnstile.jsonl"])
    assertReplayParity(obj, journalPath)
    assert.equal(oSession(obj, "sp-deep").hasGatePass, true, "PASS from .2 surfaces")
    assert.equal(
      oSession(obj, "sp-fill").dispatches,
      2,
      "filler dispatches count across .1 and current",
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("honors a config-file replayTailLines even when the metrics-dir env is set", () => {
  const dir = metricsDir()
  const cfgDir = metricsDir()
  try {
    writeTailJournal(dir)
    const cfgPath = join(cfgDir, "turnstile.json")
    // The env wins on the metrics directory (journal read from `dir`), but the
    // file's tail bound still applies — so only the last three entries
    // aggregate.
    writeFileSync(cfgPath, JSON.stringify({ replayTailLines: 3 }))
    const res = spawnSync(process.execPath, [statusScript, "--json"], {
      env: { ...process.env, TURNSTILE_METRICS_DIR: dir, TURNSTILE_CONFIG: cfgPath },
      encoding: "utf8",
    })
    assert.equal(code(res), 0)
    const obj = JSON.parse(res.stdout) as StatusJSON
    assert.equal(
      oSession(obj, "sp-tail").waivers.length,
      3,
      "config-file tail honors with the metrics-dir env set",
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
    rmSync(cfgDir, { recursive: true, force: true })
  }
})

test("falls back to the default 2000-line tail when the env is set and no config resolves a tail", () => {
  const dir = metricsDir()
  const cfgDir = metricsDir()
  try {
    writeTailJournal(dir)
    // Point TURNSTILE_CONFIG at a nonexistent path so no config file resolves;
    // the env selects the journal and the tail stays at the default 2000, so
    // all eight entries aggregate.
    const res = spawnSync(process.execPath, [statusScript, "--json"], {
      env: {
        ...process.env,
        TURNSTILE_METRICS_DIR: dir,
        TURNSTILE_CONFIG: join(cfgDir, "absent.json"),
      },
      encoding: "utf8",
    })
    assert.equal(code(res), 0)
    const obj = JSON.parse(res.stdout) as StatusJSON
    assert.equal(oSession(obj, "sp-tail").waivers.length, 8, "default tail reads all eight entries")
  } finally {
    rmSync(dir, { recursive: true, force: true })
    rmSync(cfgDir, { recursive: true, force: true })
  }
})

test("honors a configured replayTailLines from the config file when the env is unset", () => {
  const dir = metricsDir()
  const cfgDir = metricsDir()
  try {
    writeTailJournal(dir)
    const cfgPath = join(cfgDir, "turnstile.json")
    // A config file with `replayTailLines: 3` resolves both metricsDir and the
    // tail bound, so only the last three entries aggregate.
    writeFileSync(cfgPath, JSON.stringify({ metricsDir: dir, replayTailLines: 3 }))
    const res = spawnSync(process.execPath, [statusScript, "--json"], {
      env: { ...process.env, TURNSTILE_METRICS_DIR: "", TURNSTILE_CONFIG: cfgPath },
      encoding: "utf8",
    })
    assert.equal(code(res), 0)
    const obj = JSON.parse(res.stdout) as StatusJSON
    assert.equal(
      oSession(obj, "sp-tail").waivers.length,
      3,
      "tail of 3 reads only the last three entries",
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
    rmSync(cfgDir, { recursive: true, force: true })
  }
})

test("an invalid config replayTailLines falls back silently to the default tail", () => {
  const dir = metricsDir()
  const cfgDir = metricsDir()
  try {
    writeTailJournal(dir)
    const cfgPath = join(cfgDir, "turnstile.json")
    // Zero is not a positive integer, so it is rejected and the fallback (silent —
    // the script journals nothing) keeps the default 2000-line tail.
    writeFileSync(cfgPath, JSON.stringify({ metricsDir: dir, replayTailLines: 0 }))
    const res = spawnSync(process.execPath, [statusScript, "--json"], {
      env: { ...process.env, TURNSTILE_METRICS_DIR: "", TURNSTILE_CONFIG: cfgPath },
      encoding: "utf8",
    })
    assert.equal(code(res), 0)
    const obj = JSON.parse(res.stdout) as StatusJSON
    assert.equal(oSession(obj, "sp-tail").waivers.length, 8, "invalid tail falls back to default")
  } finally {
    rmSync(dir, { recursive: true, force: true })
    rmSync(cfgDir, { recursive: true, force: true })
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
      // Valid JSON whose sessionID fails the replay session-ID shape check
      // (newline, then 65 chars): skipped before any fold, no phantom session.
      line(2, { type: "gate", sessionID: "sp\nmal", result: "PASS" }),
      line(3, { type: "gate", sessionID: "a".repeat(65), result: "PASS" }),
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

/** Runs status.mjs against a temp metrics dir plus a shared temp config
 *  file, so a developer's real config can never leak into the assertion.
 *  @param dir The temp metrics directory.
 *  @param cfgPath The installed config file path.
 *  @param args Arguments after the subcommand.
 *  @returns The spawn result.
 */
function runStatusWithConfig(dir: string, cfgPath: string, args: string[] = []) {
  return spawnSync(process.execPath, [statusScript, ...args], {
    env: { ...process.env, TURNSTILE_METRICS_DIR: dir, TURNSTILE_CONFIG: cfgPath },
    encoding: "utf8",
  })
}

/** The observe-mode header line renders right below the journal header with
 *  the folded phase and running totals: last-wins over observe and
 *  would-block lines, the summary marker folds inert, and a counter over the
 *  replay bound folds nothing; the `--json` shape stays unchanged (no
 *  observe key), and gate/plan flag parity with the real replay holds. */
test("observe-mode entries fold last-wins into the header line and leave the json shape unchanged", () => {
  const dir = metricsDir()
  const cfgDir = metricsDir()
  try {
    const cfgPath = join(cfgDir, "turnstile.json")
    writeFileSync(cfgPath, JSON.stringify({ observeSessions: 2 }))
    const journalPath = join(dir, "turnstile.jsonl")
    writeJournal(dir, "turnstile.jsonl", [
      line(1, {
        type: "gate",
        sessionID: "sp-obs",
        result: "PASS",
        verified: true,
        mode: "enforce",
        marker: "GATE: PASS tests=1 passed=1 failed=0",
      }),
      line(2, { type: "observe", sessionID: "s1", phase: "observe", observed: 1, wouldBlocks: 0 }),
      line(3, { type: "observe", sessionID: "s2", phase: "observe", observed: 2, wouldBlocks: 0 }),
      line(4, {
        type: "would-block",
        sessionID: "s2",
        cause: "plan-gate",
        observed: 2,
        wouldBlocks: 1,
      }),
      line(5, { type: "observe", sessionID: "s3", phase: "enforce", observed: 3, wouldBlocks: 1 }),
      line(6, {
        type: "observe",
        sessionID: "s3",
        kind: "summary",
        injected: true,
        observed: 3,
        wouldBlocks: 1,
      }),
      // A hostile counter over the replay bound folds nothing (the summary
      // marker above remains the last valid line).
      line(7, {
        type: "observe",
        sessionID: "s-hostile",
        phase: "observe",
        observed: 1e12,
        wouldBlocks: 0,
      }),
    ])
    const table = runStatusWithConfig(dir, cfgPath)
    assert.equal(code(table), 0)
    const out = table.stdout.split("\n")
    assert.equal(out[1], "observe: enforce 3/2 sessions, 1 would-blocks")
    const json = runStatusWithConfig(dir, cfgPath, ["--json"])
    assert.equal(code(json), 0)
    const obj = JSON.parse(json.stdout) as StatusJSON
    assert.ok(!("observe" in obj), "the json shape carries no observe state")
    assertReplayParity(obj, journalPath)
  } finally {
    rmSync(dir, { recursive: true, force: true })
    rmSync(cfgDir, { recursive: true, force: true })
  }
})

/** While the period is still running (folded total at the configured
 *  boundary, not past it), the header line reports the `observe` phase. */
test("an in-period journal renders the observe phase on the header line", () => {
  const dir = metricsDir()
  const cfgDir = metricsDir()
  try {
    const cfgPath = join(cfgDir, "turnstile.json")
    writeFileSync(cfgPath, JSON.stringify({ observeSessions: 2 }))
    writeJournal(dir, "turnstile.jsonl", [
      line(1, { type: "observe", sessionID: "s1", phase: "observe", observed: 1, wouldBlocks: 0 }),
      line(2, { type: "observe", sessionID: "s2", phase: "observe", observed: 2, wouldBlocks: 0 }),
    ])
    const res = runStatusWithConfig(dir, cfgPath)
    assert.equal(code(res), 0)
    assert.equal(res.stdout.split("\n")[1], "observe: observe 2/2 sessions, 0 would-blocks")
  } finally {
    rmSync(dir, { recursive: true, force: true })
    rmSync(cfgDir, { recursive: true, force: true })
  }
})

/** A journal without observe-mode entries renders byte-identically to the
 *  pre-observe table even when a period is configured: the observe line only
 *  renders over a journal that actually holds observe-mode entries. */
test("a journal without observe entries renders byte-identically despite a configured period", () => {
  const dir = metricsDir()
  const cfgDir = metricsDir()
  try {
    const cfgPath = join(cfgDir, "turnstile.json")
    writeFileSync(cfgPath, JSON.stringify({ observeSessions: 2 }))
    writeJournal(dir, "turnstile.jsonl", [
      line(1, {
        type: "gate",
        sessionID: "sp-b",
        result: "PASS",
        verified: true,
        mode: "enforce",
        marker: "GATE: PASS tests=1 passed=1 failed=0",
      }),
      line(2, { type: "dispatch", sessionID: "sp-b", agent: "executor" }),
    ])
    const res = runStatusWithConfig(dir, cfgPath)
    assert.equal(code(res), 0)
    const out = res.stdout.split("\n")
    assert.equal(out[0], `turnstile status — ${join(dir, "turnstile.jsonl")}`)
    assert.equal(out[1], "SESSION  GATE  PLAN  VERDICT  WV  DIS  BLK  PERM")
    assert.ok(!res.stdout.includes("observe:"), "no observe line renders")
  } finally {
    rmSync(dir, { recursive: true, force: true })
    rmSync(cfgDir, { recursive: true, force: true })
  }
})
