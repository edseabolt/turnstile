/**
 * @fileoverview Tests for the loaded-plugin version check in the
 * `turnstile status` surface (scripts/status.mjs), driven by spawning the
 * script the same way bin/cli.mjs does. It covers:
 *
 *  - a stale setup row (loaded older than installed) renders the restart
 *    warning line in the table and `stale: true` in the `pluginLoad` key;
 *  - a current or newer setup row renders the quiet-positive line and
 *    `stale: false`;
 *  - no setup row omits both the line and the `pluginLoad` key;
 *  - a missing or unparseable version in the setup row is treated as
 *    unknown and omits the report;
 *  - the newest setup row wins when several exist;
 *  - the `pluginLoad` JSON shape carries exactly the four documented keys.
 *
 * Fixture versions are derived from the repo's real package.json version, so
 * the tests never hardcode stale/current. All fixtures live in a temp dir
 * under the OS temp dir, never the real metrics directory, and the script is
 * read-only.
 */

import { test } from "node:test"
import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..")
const statusScript = join(repoRoot, "scripts", "status.mjs")

/** A journaled entry; fields are deliberately loose (typed `any`). */
type Entry = Record<string, any>

/** Creates a fresh temp metrics dir, returned so the test can remove it. */
function metricsDir(): string {
  return mkdtempSync(join(tmpdir(), "turnstile-status-loaded-test-"))
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

/**
 * Reads the installed turnstile version from the repo's package.json, so the
 * fixtures can be written relative to the real installed version.
 * @returns The installed version string.
 */
function installedPkgVersion(): string {
  return JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8")).version
}

/**
 * Decrements the patch field of a strict `major.minor.patch` version, with
 * borrow when the patch is 0 (0.18.0 becomes 0.17.9), so a stale fixture
 * always parses even after the next x.y.0 release.
 * @param v The version to decrement.
 * @returns The decremented version string.
 */
function decPatch(v: string): string {
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(v)
  assert.ok(m, `fixture version must be strict semver: ${v}`)
  const major = Number(m[1])
  const minor = Number(m[2])
  const patch = Number(m[3])
  return patch > 0 ? `${major}.${minor}.${patch - 1}` : `${major}.${minor - 1}.9`
}

/**
 * Builds a `setup` heartbeat row (the shape src/setup.ts journals on plugin
 * load; no sessionID).
 * @param ts The journal timestamp.
 * @param version The plugin version the row stamps.
 * @returns The journal entry.
 */
function setupRow(ts: string, version: string | null): Entry {
  return { ts, type: "setup", version, digest: "d", hooks: 8, compat: "compatible" }
}

/** A gate-only row, so fixtures can also carry non-setup journal content. */
function gateRow(ts: string): Entry {
  return { ts, type: "gate", sessionID: "ses_a", parentID: "ses_a", gate: "PASS", tests: "3" }
}

test("warns when the loaded plugin is older than the installed one", () => {
  const dir = metricsDir()
  try {
    const v = installedPkgVersion()
    writeJournal(dir, "turnstile.jsonl", [setupRow("2026-01-01T10:00:00Z", decPatch(v))])
    const res = runStatus(dir)
    assert.equal(code(res), 0)
    assert.match(res.stdout, /loaded plugin: .* RESTART OPENCODE \(installed: /)
    const json = JSON.parse(runStatus(dir, ["--json"]).stdout)
    assert.equal(json.pluginLoad.stale, true)
    assert.equal(json.pluginLoad.loadedVersion, decPatch(v))
    assert.equal(json.pluginLoad.installedVersion, v)
    assert.equal(json.pluginLoad.loadedAt, "2026-01-01T10:00:00Z")
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("reports the loaded plugin as current when versions match", () => {
  const dir = metricsDir()
  try {
    const v = installedPkgVersion()
    writeJournal(dir, "turnstile.jsonl", [setupRow("2026-01-01T10:00:00Z", v)])
    const res = runStatus(dir)
    assert.equal(code(res), 0)
    assert.match(res.stdout, new RegExp(`loaded plugin: ${v} \\(current\\)`))
    assert.doesNotMatch(res.stdout, /RESTART OPENCODE/)
    const json = JSON.parse(runStatus(dir, ["--json"]).stdout)
    assert.equal(json.pluginLoad.stale, false)
    assert.equal(json.pluginLoad.loadedVersion, v)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("reports a newer loaded plugin as current", () => {
  const dir = metricsDir()
  try {
    const v = installedPkgVersion()
    const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(v)
    assert.ok(m, `installed version must be strict semver: ${v}`)
    const newer = `${Number(m[1])}.${Number(m[2])}.${Number(m[3]) + 1}`
    writeJournal(dir, "turnstile.jsonl", [setupRow("2026-01-01T10:00:00Z", newer)])
    const res = runStatus(dir)
    assert.equal(code(res), 0)
    assert.match(res.stdout, new RegExp(`loaded plugin: ${newer} \\(current\\)`))
    const json = JSON.parse(runStatus(dir, ["--json"]).stdout)
    assert.equal(json.pluginLoad.stale, false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("omits the loaded-plugin line and pluginLoad key without a setup row", () => {
  const dir = metricsDir()
  try {
    writeJournal(dir, "turnstile.jsonl", [gateRow("2026-01-01T10:00:00Z")])
    const res = runStatus(dir)
    assert.equal(code(res), 0)
    assert.doesNotMatch(res.stdout, /loaded plugin:/)
    const json = JSON.parse(runStatus(dir, ["--json"]).stdout)
    assert.equal("pluginLoad" in json, false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("treats an unparseable loaded version as unknown and omits the report", () => {
  const dir = metricsDir()
  try {
    writeJournal(dir, "turnstile.jsonl", [
      setupRow("2026-01-01T10:00:00Z", null),
      setupRow("2026-01-01T10:01:00Z", "not-a-version"),
    ])
    const res = runStatus(dir)
    assert.equal(code(res), 0)
    assert.doesNotMatch(res.stdout, /loaded plugin:/)
    const json = JSON.parse(runStatus(dir, ["--json"]).stdout)
    assert.equal("pluginLoad" in json, false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("uses the newest setup row when several exist", () => {
  const dir = metricsDir()
  try {
    const v = installedPkgVersion()
    writeJournal(dir, "turnstile.jsonl", [
      setupRow("2026-01-01T10:00:00Z", decPatch(v)),
      gateRow("2026-01-01T10:01:00Z"),
      setupRow("2026-01-01T10:02:00Z", v),
    ])
    const res = runStatus(dir)
    assert.equal(code(res), 0)
    assert.match(res.stdout, new RegExp(`loaded plugin: ${v} \\(current\\)`))
    assert.doesNotMatch(res.stdout, /RESTART OPENCODE/)
    const json = JSON.parse(runStatus(dir, ["--json"]).stdout)
    assert.equal(json.pluginLoad.loadedVersion, v)
    assert.equal(json.pluginLoad.loadedAt, "2026-01-01T10:02:00Z")
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("pluginLoad carries exactly the documented keys", () => {
  const dir = metricsDir()
  try {
    const v = installedPkgVersion()
    writeJournal(dir, "turnstile.jsonl", [setupRow("2026-01-01T10:00:00Z", v)])
    const json = JSON.parse(runStatus(dir, ["--json"]).stdout)
    assert.deepEqual(Object.keys(json.pluginLoad).sort(), [
      "installedVersion",
      "loadedAt",
      "loadedVersion",
      "stale",
    ])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

/**
 * Runs the status script from a copy whose sibling package.json carries a
 * malformed version, exercising the unparseable-installed-version edge
 * (installedVersion() returns a string parseSemverJs cannot parse).
 * @param dir The temp metrics directory holding the journal fixture.
 * @returns The spawn result with stdout coerced to string.
 */
function runStatusWithMalformedInstalled(dir: string, args: string[] = []) {
  const pkgRoot = join(dir, "pkg")
  mkdirSync(join(pkgRoot, "scripts"), { recursive: true })
  for (const f of ["status.mjs", "journal-read.mjs"]) {
    copyFileSync(join(repoRoot, "scripts", f), join(pkgRoot, "scripts", f))
  }
  writeFileSync(join(pkgRoot, "package.json"), JSON.stringify({ version: "not-a-version" }))
  return spawnSync(process.execPath, [join(pkgRoot, "scripts", "status.mjs"), ...args], {
    env: {
      ...process.env,
      TURNSTILE_METRICS_DIR: dir,
      TURNSTILE_CLI_CONFIG: join(dir, "absent-cli.json"),
    },
    encoding: "utf8",
  })
}

test("omits the report when the installed version is not parseable semver", () => {
  const dir = metricsDir()
  try {
    writeJournal(dir, "turnstile.jsonl", [setupRow("2026-01-01T10:00:00Z", installedPkgVersion())])
    const res = runStatusWithMalformedInstalled(dir)
    assert.equal(code(res), 0)
    assert.doesNotMatch(res.stdout, /loaded plugin:/)
    const json = JSON.parse(runStatusWithMalformedInstalled(dir, ["--json"]).stdout)
    assert.equal("pluginLoad" in json, false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("an empty journal directory reports nothing and exits 0", () => {
  const dir = metricsDir()
  try {
    mkdirSync(join(dir, "sessions"), { recursive: true })
    const res = runStatus(dir)
    assert.equal(code(res), 0)
    assert.doesNotMatch(res.stdout, /loaded plugin:/)
    const json = JSON.parse(runStatus(dir, ["--json"]).stdout)
    assert.equal("pluginLoad" in json, false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
