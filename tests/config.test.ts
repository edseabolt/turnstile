/**
 * @fileoverview Config tests: default parity, layered merge, per-key
 * validation, env precedence, and fail-open handling of malformed files.
 * This file redirects XDG_DATA_HOME *before* importing the plugin so the
 * config-error journal lands in a temp directory.
 */

import { test } from "node:test"
import assert from "node:assert/strict"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"

const xdgTmp = fs.mkdtempSync(path.join(os.tmpdir(), "turnstile-xdg-"))
process.env.XDG_DATA_HOME = xdgTmp

const { defaultConfig, CONFIG_PATH, ENV_KEYS, loadConfig, mergeConfig } =
  await import("../src/config.ts")
const { DEFAULT_JOURNAL_PATH } = await import("../src/journal.ts")
const { GATE_RE } = await import("../src/markers.ts")

/** Verifies every default value matches the historical constants exactly. */
test("defaultConfig reproduces the historical constants", () => {
  const cfg = defaultConfig({ XDG_DATA_HOME: undefined })
  assert.equal(cfg.maxReviewerRounds, 2)
  assert.equal(cfg.readWarn, 8)
  assert.equal(cfg.readBlock, 15)
  assert.equal(cfg.maxSessions, 64)
  assert.equal(cfg.waiverMarker, "USER WAIVER:")
  assert.equal(cfg.trace, true)
  assert.equal(cfg.journalMaxBytes, 5 * 1024 * 1024)
  assert.equal(cfg.journalMaxGenerations, 5)
  assert.deepEqual(cfg.agents, {
    reviewer: "reviewer",
    planReviewer: "plan-reviewer",
    executor: "executor",
    testRunner: "test-runner",
    debugger: "debugger",
    bareOutput: ["test-runner", "reviewer", "plan-reviewer"],
  })
})

/** Covers the XDG_DATA_HOME → ~/.local/share fallback for metricsDir. */
test("defaultConfig metricsDir falls back to ~/.local/share without XDG", () => {
  const cfg = defaultConfig({ XDG_DATA_HOME: undefined, HOME: "/home/tester" })
  assert.equal(cfg.metricsDir, path.join("/home/tester", ".local/share", "opencode", "metrics"))
})

/** Never-relative contract: relative XDG_DATA_HOME/HOME fall back. */
test("defaultConfig ignores relative XDG_DATA_HOME and HOME values", () => {
  const viaHome = defaultConfig({ XDG_DATA_HOME: "relative/xdg", HOME: "/home/tester" })
  assert.equal(viaHome.metricsDir, path.join("/home/tester", ".local/share", "opencode", "metrics"))
  const viaOsHome = defaultConfig({ XDG_DATA_HOME: "relative/xdg", HOME: "relative/home" })
  assert.ok(path.isAbsolute(viaOsHome.metricsDir))
})

/** Drift guard: the gate marker config must be the canonical regex source. */
test("marker config defaults are the canonical regex sources (drift guard)", () => {
  const cfg = defaultConfig({})
  assert.equal(cfg.gateMarker, GATE_RE?.source ?? "")
})

/** Unknown keys and wrongly-typed values are dropped with one warning each. */
test("mergeConfig ignores unknown keys and invalid values with warnings", () => {
  const base = defaultConfig({})
  const { config, warnings } = mergeConfig(base, {
    nope: 1,
    maxReviewerRounds: 0,
    readWarn: "8",
    trace: "yes",
  })
  assert.equal(config.maxReviewerRounds, 2)
  assert.equal(config.readWarn, 8)
  assert.equal(config.trace, true)
  assert.equal(warnings.length, 4)
})

/** One-level-deep agents merge; bareOutput must be an array of strings. */
test("mergeConfig merges agents one level deep and validates bareOutput", () => {
  const base = defaultConfig({})
  const { config, warnings } = mergeConfig(base, {
    agents: { reviewer: "qc", bareOutput: ["qc"], bogus: "x" },
  } as any)
  assert.equal(config.agents.reviewer, "qc")
  assert.equal(config.agents.executor, "executor")
  assert.deepEqual(config.agents.bareOutput, ["qc"])
  assert.equal(warnings.length, 1)
  const bad = mergeConfig(base, { agents: { bareOutput: [1, 2] } })
  assert.deepEqual(bad.config.agents.bareOutput, ["test-runner", "reviewer", "plan-reviewer"])
})

/** The config file layer applies over defaults. */
test("loadConfig honors the config file layer", () => {
  const file = path.join(xdgTmp, "turnstile.json")
  fs.writeFileSync(file, JSON.stringify({ maxReviewerRounds: 5, agents: { reviewer: "qc" } }))
  const { config } = loadConfig({ [ENV_KEYS.config]: file })
  assert.equal(config.maxReviewerRounds, 5)
  assert.equal(config.agents.reviewer, "qc")
})

/** Precedence check: TURNSTILE_TRACE=0 beats trace:true from the file. */
test("env layer wins over the file layer", () => {
  const file = path.join(xdgTmp, "trace-on.json")
  fs.writeFileSync(file, JSON.stringify({ trace: true }))
  const { config } = loadConfig({ [ENV_KEYS.config]: file, [ENV_KEYS.trace]: "0" })
  assert.equal(config.trace, false)
})

/** Boolean env parsing accepts 0/1/false/true; anything else warns and keeps the default. */
test("TURNSTILE_TRACE accepts the 0/1/false/true matrix", () => {
  assert.equal(loadConfig({ [ENV_KEYS.trace]: "0" }).config.trace, false)
  assert.equal(loadConfig({ [ENV_KEYS.trace]: "false" }).config.trace, false)
  assert.equal(loadConfig({ [ENV_KEYS.trace]: "1" }).config.trace, true)
  assert.equal(loadConfig({ [ENV_KEYS.trace]: "true" }).config.trace, true)
  const invalid = loadConfig({ [ENV_KEYS.trace]: "sometimes" })
  assert.equal(invalid.config.trace, true)
  assert.equal(invalid.warnings.length, 1)
})

/** TURNSTILE_METRICS_DIR redirects the journal directory. */
test("TURNSTILE_METRICS_DIR overrides the metrics directory", () => {
  const { config } = loadConfig({ [ENV_KEYS.metricsDir]: "/tmp/elsewhere" })
  assert.equal(config.metricsDir, "/tmp/elsewhere")
})

/** Injected (setup-time) overrides take precedence over the env layer. */
test("injected overrides win over the env layer", () => {
  const { config } = loadConfig({ [ENV_KEYS.trace]: "0" }, { trace: true })
  assert.equal(config.trace, true)
})

/** Fail-open contract: malformed JSON yields defaults and a journaled error. */
test("malformed config file fails open: defaults + journaled error", () => {
  const file = path.join(xdgTmp, "broken.json")
  fs.writeFileSync(file, "{not json")
  const { config, warnings } = loadConfig({ [ENV_KEYS.config]: file })
  assert.equal(config.maxReviewerRounds, 2)
  assert.equal(warnings.length, 1)
  const errors = fs
    .readFileSync(DEFAULT_JOURNAL_PATH, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l))
    .filter((l) => l.type === "error" && String(l.error).includes("broken.json"))
  assert.equal(errors.length, 1)
})

/** The exported CONFIG_PATH constant points at ~/.config/opencode/turnstile.json. */
test("module-level CONFIG_PATH points at the user config location", () => {
  assert.equal(CONFIG_PATH, path.join(os.homedir(), ".config", "opencode", "turnstile.json"))
})
