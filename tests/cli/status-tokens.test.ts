/**
 * @fileoverview Tests for the token-usage rollup in the `turnstile status`
 * surface (scripts/status.mjs), driven by spawning the script the same way
 * bin/cli.mjs does. It covers:
 *
 *  - the no-double-count source rule (a session with a `session-rollup` row
 *    counts from the rollup; a session with only per-message rows sums them);
 *  - per-parent grouping (a parent and its subagent children aggregate under
 *    one `parentID`; a row without a `parentID` groups under its own
 *    sessionID);
 *  - cross-sink dedup (an identical row in the shared file and a session sink
 *    counts once);
 *  - rotated generations and gzip-archived generations are read;
 *  - malformed token fields render as zeros (the row is not dropped);
 *  - mode behavior: the table gains `tokens:` lines and `--json` gains the
 *    `tokenUsage` key, both omitted entirely when the journal holds no
 *    token-usage rows.
 *
 * All fixtures live in a temp dir under the OS temp dir, never the real
 * metrics directory, and the script is read-only.
 */

import { test } from "node:test"
import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { gzipSync } from "node:zlib"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..")
const statusScript = join(repoRoot, "scripts", "status.mjs")

/** A journaled entry; fields are deliberately loose (typed `any`). */
type Entry = Record<string, any>

/** Creates a fresh temp metrics dir, returned so the test can remove it. */
function metricsDir(): string {
  return mkdtempSync(join(tmpdir(), "turnstile-status-tok-test-"))
}

/**
 * Runs status.mjs against a temp metrics dir.
 * @param dir The temp metrics directory.
 * @param args Arguments after the subcommand (e.g. `["--json"]`).
 * @returns The spawn result with stdout coerced to string.
 */
function runStatus(dir: string, args: string[] = []) {
  return spawnSync(process.execPath, [statusScript, ...args], {
    env: {
      ...process.env,
      TURNSTILE_METRICS_DIR: dir,
      // Pin the host-config probe off the real ~/.config/opencode/cli.json so
      // the autoaccept advisory never leaks into an assertion unexpectedly.
      TURNSTILE_CLI_CONFIG: join(dir, "absent-cli.json"),
    },
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

/** Writes a journal file (current or a rotated generation) from JSONL lines. */
function writeJournal(dir: string, file: string, lines: Entry[]): void {
  writeFileSync(join(dir, file), lines.map((l) => JSON.stringify(l)).join("\n") + "\n")
}

/** The task-root parent session ID used across the fixtures. */
const PARENT = "sesparent"

/**
 * Builds a per-message `token-usage` row.
 * @param sessionID The session that consumed the tokens.
 * @param parentID The task root (or "" to omit the field).
 * @param tokens The token counts (missing fields default to 0).
 * @param cost The host-computed cost.
 * @returns The journal entry.
 */
function msgRow(sessionID: string, parentID: string, tokens: Entry, cost = 0.1): Entry {
  const row: Entry = {
    ts: "2026-01-01T10:00:00Z",
    type: "token-usage",
    sessionID,
    messageID: "msg_1",
    modelID: "m",
    providerID: "p",
    tokens: { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, ...tokens },
    cost,
  }
  if (parentID !== "") row.parentID = parentID
  return row
}

/**
 * Builds a `session-rollup` `token-usage` row.
 * @param sessionID The session the rollup flushed for.
 * @param parentID The task root.
 * @param tokens The token counts.
 * @param cost The host-computed cost.
 * @returns The journal entry.
 */
function rollupRow(sessionID: string, parentID: string, tokens: Entry, cost = 0.2): Entry {
  return {
    ts: "2026-01-01T10:00:05Z",
    type: "token-usage",
    event: "session-rollup",
    sessionID,
    parentID,
    tokens: { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, ...tokens },
    cost,
  }
}

test("prefers the session rollup over per-message rows for the same session", () => {
  const dir = metricsDir()
  try {
    writeJournal(dir, "turnstile.jsonl", [
      msgRow(PARENT, PARENT, { input: 100 }, 0.05),
      rollupRow(PARENT, PARENT, { input: 250 }, 0.25),
    ])
    const r = runStatus(dir, ["--json"])
    assert.equal(code(r), 0)
    const json = JSON.parse(r.stdout)
    assert.equal(json.tokenUsage.byParent[PARENT].input, 250)
    assert.equal(json.tokenUsage.byParent[PARENT].cost, 0.25)
    assert.equal(json.tokenUsage.total.input, 250)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("sums per-message rows when a session has no rollup", () => {
  const dir = metricsDir()
  try {
    writeJournal(dir, "turnstile.jsonl", [
      msgRow(PARENT, PARENT, { input: 100, output: 10 }, 0.01),
      msgRow(PARENT, PARENT, { input: 50, output: 5 }, 0.02),
    ])
    const r = runStatus(dir, ["--json"])
    assert.equal(code(r), 0)
    const json = JSON.parse(r.stdout)
    assert.equal(json.tokenUsage.byParent[PARENT].input, 150)
    assert.equal(json.tokenUsage.byParent[PARENT].output, 15)
    assert.equal(json.tokenUsage.byParent[PARENT].cost, 0.03)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("aggregates a parent and its children under one parentID, in both modes", () => {
  const dir = metricsDir()
  try {
    writeJournal(dir, "turnstile.jsonl", [
      rollupRow(PARENT, PARENT, { input: 250 }, 0.25),
      msgRow("seschild1", PARENT, { input: 100 }, 0.01),
      rollupRow("seschild2", PARENT, { input: 30 }, 0.003),
    ])
    const json = JSON.parse(runStatus(dir, ["--json"]).stdout)
    const parents = Object.keys(json.tokenUsage.byParent)
    assert.deepEqual(parents, [PARENT])
    assert.equal(json.tokenUsage.byParent[PARENT].sessions, 3)
    assert.equal(json.tokenUsage.byParent[PARENT].input, 380)
    assert.equal(json.tokenUsage.total.input, 380)
    const table = runStatus(dir).stdout
    assert.match(table, /tokens: sesparent {2}in 380 out 0 reason 0 cacheR 0 cacheW 0 {2}\$0\.2630/)
    assert.match(table, /tokens: total {2}in 380 out 0 reason 0 cacheR 0 cacheW 0 {2}\$0\.2630/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("groups a row without a parentID under its own sessionID", () => {
  const dir = metricsDir()
  try {
    writeJournal(dir, "turnstile.jsonl", [msgRow("sesown", "", { input: 7 })])
    const json = JSON.parse(runStatus(dir, ["--json"]).stdout)
    assert.equal(json.tokenUsage.byParent.sesown.input, 7)
    assert.equal(json.tokenUsage.byParent.sesown.sessions, 1)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("counts a cross-sink duplicate row once", () => {
  const dir = metricsDir()
  try {
    mkdirSync(join(dir, "sessions"))
    const row = msgRow(PARENT, PARENT, { input: 42 })
    // The identical JSON text in both sinks is one row written twice (routing
    // changed mid-session); identity is the full line, so it counts once.
    writeJournal(dir, "turnstile.jsonl", [row])
    writeJournal(dir, join("sessions", `${PARENT}.jsonl`), [row])
    const json = JSON.parse(runStatus(dir, ["--json"]).stdout)
    assert.equal(json.tokenUsage.total.input, 42)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("omits the rollup when the journal has no token rows", () => {
  const dir = metricsDir()
  try {
    writeJournal(dir, "turnstile.jsonl", [
      {
        ts: "2026-01-01T10:00:00Z",
        type: "gate",
        sessionID: PARENT,
        result: "PASS",
        verified: true,
      },
    ])
    const r = runStatus(dir, ["--json"])
    assert.equal(code(r), 0)
    const json = JSON.parse(r.stdout)
    assert.equal("tokenUsage" in json, false)
    assert.equal(/tokens:/i.test(runStatus(dir).stdout), false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("renders zeros for a token row with missing token fields", () => {
  const dir = metricsDir()
  try {
    writeJournal(dir, "turnstile.jsonl", [
      {
        ts: "2026-01-01T10:00:00Z",
        type: "token-usage",
        sessionID: PARENT,
        parentID: PARENT,
        tokens: {},
      },
    ])
    const json = JSON.parse(runStatus(dir, ["--json"]).stdout)
    assert.equal(json.tokenUsage.total.input, 0)
    assert.equal(json.tokenUsage.total.cost, 0)
    assert.match(
      runStatus(dir).stdout,
      /tokens: total {2}in 0 out 0 reason 0 cacheR 0 cacheW 0 {2}\$0\.0000/,
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("reads rotated generations and gzip archives", () => {
  const dir = metricsDir()
  try {
    mkdirSync(join(dir, "archive"))
    writeJournal(dir, "turnstile.jsonl", [
      {
        ts: "2026-01-01T10:00:00Z",
        type: "gate",
        sessionID: PARENT,
        result: "PASS",
        verified: true,
      },
    ])
    writeJournal(dir, "turnstile.jsonl.1", [msgRow(PARENT, PARENT, { input: 10 })])
    const archived = [rollupRow("sesold", PARENT, { input: 20 })]
      .map((l) => JSON.stringify(l))
      .join("\n")
    writeFileSync(join(dir, "archive", "turnstile.jsonl.gz"), gzipSync(archived))
    const json = JSON.parse(runStatus(dir, ["--json"]).stdout)
    assert.equal(json.tokenUsage.total.input, 30)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

/** Builds a `child-edge` row naming the session's pipeline-stage agent. */
function edgeRow(sessionID: string, agent: string): Entry {
  return {
    ts: "2026-01-01T10:00:00Z",
    type: "child-edge",
    sessionID,
    parent: PARENT,
    agent,
  }
}

test("attributes token totals per stage via child-edge agent, parent fallback", () => {
  const dir = metricsDir()
  try {
    writeJournal(dir, "turnstile.jsonl", [
      edgeRow("seschild1", "executor"),
      msgRow("seschild1", PARENT, { input: 1200, output: 340 }, 0.045),
      msgRow(PARENT, PARENT, { input: 800, output: 120 }, 0.021),
    ])
    const json = JSON.parse(runStatus(dir, ["--json"]).stdout)
    assert.equal(json.tokenUsage.byStage.executor.input, 1200)
    assert.equal(json.tokenUsage.byStage.executor.sessions, 1)
    assert.equal(json.tokenUsage.byStage.parent.input, 800)
    assert.equal(json.tokenUsage.total.input, 2000)
    const table = runStatus(dir).stdout
    assert.match(
      table,
      /tokens by stage: executor {2}in 1200 out 340 reason 0 cacheR 0 cacheW 0 {2}\$0\.0450/,
    )
    assert.match(
      table,
      /tokens by stage: parent {4}in 800 out 120 reason 0 cacheR 0 cacheW 0 {2}\$0\.0210/,
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("a session whose child-edge rotated out attributes to parent", () => {
  const dir = metricsDir()
  try {
    writeJournal(dir, "turnstile.jsonl", [msgRow("seslost", PARENT, { input: 5 })])
    const json = JSON.parse(runStatus(dir, ["--json"]).stdout)
    assert.equal(json.tokenUsage.byStage.parent.input, 5)
    assert.equal("executor" in json.tokenUsage.byStage, false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
