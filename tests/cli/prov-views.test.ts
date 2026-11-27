/**
 * @fileoverview Tests for the `turnstile prov-views` surface
 * (scripts/prov-views.mjs), driven by spawning the script the same way
 * bin/cli.mjs does. It covers:
 *
 *  - origin classification of `prov:stated` rows (instruction, chatter,
 *    waiver-carried via the waiver and approval markers, the chatter length
 *    boundary, and config-file marker overrides);
 *  - the chatter noise rate (fraction math and the zero-stated case);
 *  - taste-drift aggregates (denied kinds incl. unknown kinds, overrides by
 *    tool with distinct children/paths, per-day bucketing, cross-session
 *    breakdown);
 *  - `--json` shape (origins/noiseRate/drift keys, read-time sha256 hash on
 *    stated rows only);
 *  - the read path shared with prov (--tail, sessionID filter, rotation,
 *    cross-sink dedupe);
 *  - the CLI surface (--help, unknown flag, bad tail, malformed session ID,
 *    extra positional, empty ledger / no prov rows exit 0 with no output);
 *  - the router spawn (`bin/cli.mjs prov-views`).
 *
 * All fixtures live in a temp dir under the OS temp dir, never the real
 * metrics directory, and the script is read-only.
 */

import { test } from "node:test"
import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { createHash } from "node:crypto"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..")
const viewsScript = join(repoRoot, "scripts", "prov-views.mjs")

/** A journaled entry; fields are deliberately loose (typed `any`). */
type Entry = Record<string, any>

/** Creates a fresh temp metrics dir, returned so the test can remove it. */
function metricsDir(): string {
  return mkdtempSync(join(tmpdir(), "turnstile-prov-views-test-"))
}

/**
 * Runs prov-views.mjs against a temp metrics dir.
 * @param dir The temp metrics directory.
 * @param args Arguments after the subcommand (e.g. `["--json"]`).
 * @param extraEnv Additional environment variables for this run.
 * @returns The spawn result with stdout coerced to string.
 */
function runViews(dir: string, args: string[] = [], extraEnv: Record<string, string> = {}) {
  return spawnSync(process.execPath, [viewsScript, ...args], {
    env: { ...process.env, TURNSTILE_METRICS_DIR: dir, ...extraEnv },
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

/**
 * Writes a config file and returns its path (for TURNSTILE_CONFIG).
 * @param dir The temp metrics directory (the config lives beside the fixture).
 * @param config The config object to serialize.
 * @returns The config file path.
 */
function writeConfig(dir: string, config: Entry): string {
  const p = join(dir, "turnstile.json")
  writeFileSync(p, JSON.stringify(config))
  return p
}

test("classifies stated rows by origin and computes the noise rate", () => {
  // docstring: waiver/approval markers label waiver-carried, short ack
  // phrases label chatter, everything else is instruction; the noise rate is
  // chatter/stated.
  const dir = metricsDir()
  try {
    writeSessionJournal(dir, "ses1", [
      {
        ts: "2026-01-01T10:00:05Z",
        type: "prov:stated",
        sessionID: "ses1",
        text: "add a parser",
        truncated: false,
      },
      {
        ts: "2026-01-01T10:00:10Z",
        type: "prov:stated",
        sessionID: "ses1",
        text: "continue",
        truncated: false,
      },
      {
        ts: "2026-01-01T10:00:15Z",
        type: "prov:stated",
        sessionID: "ses1",
        text: "USER WAIVER: approve plan stage",
        truncated: false,
      },
      {
        ts: "2026-01-01T10:00:20Z",
        type: "prov:stated",
        sessionID: "ses1",
        text: "PLAN APPROVED: gate plan",
        truncated: false,
      },
    ])
    const r = runViews(dir, ["--json"])
    assert.equal(code(r), 0)
    const out = JSON.parse(r.stdout)
    assert.equal(out.origins.instruction, 1)
    assert.equal(out.origins.chatter, 1)
    assert.equal(out.origins["waiver-carried"], 2)
    assert.equal(out.noiseRate.stated, 4)
    assert.equal(out.noiseRate.chatter, 1)
    assert.equal(out.noiseRate.rate, 0.25)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("long text containing an ack word is an instruction, not chatter", () => {
  // docstring: the chatter heuristic is bounded — a text over the length cap
  // that merely contains an ack word stays an instruction.
  const dir = metricsDir()
  try {
    writeSessionJournal(dir, "ses1", [
      {
        ts: "2026-01-01T10:00:05Z",
        type: "prov:stated",
        sessionID: "ses1",
        text: "continue implementing the parser",
        truncated: false,
      },
    ])
    const r = runViews(dir, ["--json"])
    const out = JSON.parse(r.stdout)
    assert.equal(out.origins.instruction, 1)
    assert.equal(out.origins.chatter, undefined)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("a config file can override the waiver marker", () => {
  // docstring: waiverMarker/approvalMarker resolve from the config file with
  // the code defaults as fallback; a custom-marker row is waiver-carried
  // while a default-marker row is then a plain instruction.
  const dir = metricsDir()
  try {
    writeSessionJournal(dir, "ses1", [
      {
        ts: "2026-01-01T10:00:05Z",
        type: "prov:stated",
        sessionID: "ses1",
        text: "MY WAIVER: do it",
        truncated: false,
      },
      {
        ts: "2026-01-01T10:00:10Z",
        type: "prov:stated",
        sessionID: "ses1",
        text: "USER WAIVER: default marker",
        truncated: false,
      },
    ])
    const cfg = writeConfig(dir, { waiverMarker: "MY WAIVER:" })
    const r = runViews(dir, ["--json"], { TURNSTILE_CONFIG: cfg })
    const out = JSON.parse(r.stdout)
    assert.equal(out.origins["waiver-carried"], 1)
    assert.equal(out.origins.instruction, 1)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("the noise rate is 0 when no stated rows exist", () => {
  // docstring: with only non-stated prov rows the rate denominator is 0 and
  // the metric must be 0, not NaN.
  const dir = metricsDir()
  try {
    writeSessionJournal(dir, "ses1", [
      { ts: "2026-01-01T10:00:05Z", type: "prov:denied", sessionID: "ses1", kind: "plan" },
    ])
    const r = runViews(dir, ["--json"])
    const out = JSON.parse(r.stdout)
    assert.equal(out.noiseRate.stated, 0)
    assert.equal(out.noiseRate.rate, 0)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("drift aggregates denials by kind, tolerating unknown kinds", () => {
  // docstring: prov:denied rows count per kind; a bogus kind is tolerated as
  // its own bucket rather than crashing.
  const dir = metricsDir()
  try {
    writeSessionJournal(dir, "ses1", [
      { ts: "2026-01-01T10:00:05Z", type: "prov:denied", sessionID: "ses1", kind: "plan" },
      { ts: "2026-01-01T10:00:10Z", type: "prov:denied", sessionID: "ses1", kind: "landing" },
      { ts: "2026-01-01T10:00:15Z", type: "prov:denied", sessionID: "ses1", kind: "bogus" },
      { ts: "2026-01-01T10:00:20Z", type: "prov:denied", sessionID: "ses1" },
    ])
    const r = runViews(dir, [])
    assert.match(r.stdout, /denied plan=1 landing=1 bogus=1 unknown=1/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("drift aggregates overrides by tool with distinct children and paths", () => {
  // docstring: prov:override rows count per tool; distinct child sessions and
  // overridden paths are collected (a repeated path counts once).
  const dir = metricsDir()
  try {
    writeSessionJournal(dir, "ses1", [
      {
        ts: "2026-01-01T10:00:05Z",
        type: "prov:override",
        sessionID: "ses1",
        tool: "write",
        path: "/r/a.ts",
        child: "c1",
      },
      {
        ts: "2026-01-01T10:00:10Z",
        type: "prov:override",
        sessionID: "ses1",
        tool: "edit",
        path: "/r/a.ts",
        child: "c2",
      },
      {
        ts: "2026-01-01T10:00:15Z",
        type: "prov:override",
        sessionID: "ses1",
        tool: "edit",
        path: "/r/b.ts",
        child: "c2",
      },
    ])
    const r = runViews(dir, ["--json"])
    const out = JSON.parse(r.stdout)
    assert.deepEqual(out.drift.overrideTools, { write: 1, edit: 2 })
    assert.deepEqual(out.drift.children, ["c1", "c2"])
    assert.deepEqual(out.drift.paths, ["/r/a.ts", "/r/b.ts"])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("drift buckets per UTC day and breaks down across sessions", () => {
  // docstring: the drift timeline buckets per UTC day and the bySession
  // breakdown aggregates across session sinks (cross-session by design).
  const dir = metricsDir()
  try {
    writeSessionJournal(dir, "ses1", [
      { ts: "2026-01-01T10:00:05Z", type: "prov:denied", sessionID: "ses1", kind: "plan" },
      {
        ts: "2026-01-02T10:00:10Z",
        type: "prov:override",
        sessionID: "ses1",
        tool: "write",
        path: "/r/a.ts",
        child: "c1",
      },
    ])
    writeSessionJournal(dir, "ses2", [
      { ts: "2026-01-01T11:00:15Z", type: "prov:denied", sessionID: "ses2", kind: "plan" },
    ])
    const r = runViews(dir, ["--json"])
    const out = JSON.parse(r.stdout)
    assert.deepEqual(out.drift.timeline, [
      { day: "2026-01-01", denied: 2, overrides: 0 },
      { day: "2026-01-02", denied: 0, overrides: 1 },
    ])
    assert.deepEqual(out.drift.bySession, {
      ses1: { denied: 1, overrides: 1 },
      ses2: { denied: 1, overrides: 0 },
    })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("--json carries a read-time sha256 hash on stated rows only", () => {
  // docstring: stated rows gain origin + sha256(text) hash; other rows pass
  // through verbatim without those fields (rows are never rewritten).
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
      { ts: "2026-01-01T10:00:10Z", type: "prov:denied", sessionID: "ses1", kind: "plan" },
    ])
    const r = runViews(dir, ["--json"])
    const out = JSON.parse(r.stdout)
    assert.equal(out.rows[0]!.hash, createHash("sha256").update("ship it").digest("hex"))
    assert.equal(out.rows[0]!.origin, "chatter")
    assert.equal(out.rows[1]!.hash, undefined)
    assert.equal(out.rows[1]!.origin, undefined)
    assert.equal(out.rows[1]!.kind, "plan")
    assert.ok(out.origins && out.noiseRate && out.drift)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("--tail bounds the row walk", () => {
  // docstring: an explicit --tail bounds the prov rows the views derive from.
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
    const r = runViews(dir, ["--json", "--tail", "2"])
    const out = JSON.parse(r.stdout)
    assert.equal(out.rows.length, 2)
    assert.match(out.rows[0]!.text, /prompt 3/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("a sessionID argument filters both sinks", () => {
  // docstring: an explicit sessionID covers its per-session sink and the
  // shared journal's rows for that session, excluding other sessions.
  const dir = metricsDir()
  try {
    writeSessionJournal(dir, "ses1", [
      { ts: "2026-01-01T10:00:05Z", type: "prov:stated", sessionID: "ses1", text: "mine" },
    ])
    writeSharedJournal(dir, [
      { ts: "2026-01-01T10:00:10Z", type: "prov:stated", sessionID: "ses1", text: "shared" },
      { ts: "2026-01-01T10:00:15Z", type: "prov:stated", sessionID: "ses2", text: "theirs" },
    ])
    const r = runViews(dir, ["ses1", "--json"])
    const out = JSON.parse(r.stdout)
    assert.equal(out.rows.length, 2)
    assert.ok(out.rows.every((row: Entry) => row.sessionID === "ses1"))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("rotated generations are read and ts-ordered", () => {
  // docstring: a .jsonl.1 generation participates in the walk, ordered by ts.
  const dir = metricsDir()
  try {
    writeSessionJournal(dir, "ses1", [
      {
        ts: "2026-01-01T10:00:20Z",
        type: "prov:stated",
        sessionID: "ses1",
        text: "newest",
        truncated: false,
      },
    ])
    writeSessionJournal(
      dir,
      "ses1",
      [
        {
          ts: "2026-01-01T10:00:05Z",
          type: "prov:stated",
          sessionID: "ses1",
          text: "older",
          truncated: false,
        },
      ],
      1,
    )
    const r = runViews(dir, ["--json"])
    const out = JSON.parse(r.stdout)
    assert.equal(out.rows.length, 2)
    assert.match(out.rows[0]!.text, /older/)
    assert.match(out.rows[1]!.text, /newest/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("a prov row present in both sinks is derived once", () => {
  // docstring: cross-sink byte-identical duplicates dedupe before the views
  // aggregate, so one event never double-counts.
  const dir = metricsDir()
  try {
    const row = {
      ts: "2026-01-01T10:00:05Z",
      type: "prov:stated",
      sessionID: "ses1",
      text: "once",
    }
    writeSessionJournal(dir, "ses1", [row])
    writeSharedJournal(dir, [row])
    const r = runViews(dir, ["--json"])
    const out = JSON.parse(r.stdout)
    assert.equal(out.rows.length, 1)
    assert.equal(out.noiseRate.stated, 1)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("an empty ledger exits 0 with no output", () => {
  // docstring: prov parity — nothing journaled means no output, exit 0.
  const dir = metricsDir()
  try {
    const r = runViews(dir, [])
    assert.equal(code(r), 0)
    assert.equal(r.stdout, "")
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("a journal with no prov rows exits 0 with no output", () => {
  // docstring: non-prov rows are dropped before the views; no prov rows means
  // no output, exit 0.
  const dir = metricsDir()
  try {
    writeSessionJournal(dir, "ses1", [
      { ts: "2026-01-01T10:00:00Z", type: "gate", sessionID: "ses1", result: "PASS", tests: 1 },
    ])
    const r = runViews(dir, [])
    assert.equal(code(r), 0)
    assert.equal(r.stdout, "")
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("a malformed session id exits 2 with a message", () => {
  // docstring: the positional session ID is shape-validated like prov's.
  const dir = metricsDir()
  try {
    const r = runViews(dir, ["bad id!"])
    assert.equal(code(r), 2)
    assert.match(r.stderr, /unknown or malformed session id "bad id!"/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("an unknown flag exits 2", () => {
  // docstring: unrecognized flags are usage errors (exit 2).
  const dir = metricsDir()
  try {
    const r = runViews(dir, ["--wat"])
    assert.equal(code(r), 2)
    assert.match(r.stderr, /unknown argument "--wat"/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("a bad --tail value exits 2", () => {
  // docstring: an explicit --tail must be a positive integer.
  const dir = metricsDir()
  try {
    const r = runViews(dir, ["--tail", "0"])
    assert.equal(code(r), 2)
    assert.match(r.stderr, /--tail expects a positive integer/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("an extra positional exits 2", () => {
  // docstring: at most one positional sessionID is accepted.
  const dir = metricsDir()
  try {
    const r = runViews(dir, ["ses1", "ses2"])
    assert.equal(code(r), 2)
    assert.match(r.stderr, /unexpected extra argument "ses2"/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("--help prints usage and exits 0", () => {
  // docstring: the usage text names the surface and exits 0.
  const dir = metricsDir()
  try {
    const r = runViews(dir, ["--help"])
    assert.equal(code(r), 0)
    assert.match(r.stdout, /Usage: opencode-turnstile prov-views/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("the prov-views subcommand is routed from the CLI router", () => {
  // docstring: bin/cli.mjs routes `prov-views` onto scripts/prov-views.mjs,
  // so a router spawn against an empty temp dir exits 0 with no output.
  const dir = metricsDir()
  try {
    const cli = spawnSync(process.execPath, [join(repoRoot, "bin", "cli.mjs"), "prov-views"], {
      env: { ...process.env, TURNSTILE_METRICS_DIR: dir },
      encoding: "utf8",
    })
    assert.equal(code(cli), 0)
    assert.equal(cli.stdout, "")
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
