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

const {
  configDigest,
  defaultConfig,
  CONFIG_PATH,
  ENV_KEYS,
  loadConfig,
  mergeConfig,
  DEFAULT_EVIDENCE_PATTERN,
  DEFAULT_COMMIT_FORMAT,
} = await import("../src/config.ts")
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
  assert.equal(cfg.approvalMarker, "PLAN APPROVED:")
  assert.equal(cfg.trace, true)
  assert.equal(cfg.journalMaxBytes, 5 * 1024 * 1024)
  assert.equal(cfg.journalMaxGenerations, 5)
  assert.equal(cfg.gateEvidence, "enforce")
  assert.equal(cfg.evidencePattern, DEFAULT_EVIDENCE_PATTERN)
  assert.deepEqual(cfg.agents, {
    planner: "planner",
    reviewer: "reviewer",
    planReviewer: "plan-reviewer",
    executor: "executor",
    testRunner: "test-runner",
    debugger: "debugger",
    bareOutput: ["test-runner", "reviewer", "plan-reviewer"],
  })
  assert.equal(cfg.agents.planner, "planner")
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

/** approvalMarker is a valid string key: a non-empty string merges, an
 *  invalid value is rejected with a warning (mirroring waiverMarker). */
test("mergeConfig validates approvalMarker like waiverMarker", () => {
  const base = defaultConfig({})
  const ok = mergeConfig(base, { approvalMarker: "HUMAN GO:" })
  assert.equal(ok.config.approvalMarker, "HUMAN GO:")
  assert.equal(ok.warnings.length, 0)
  const bad = mergeConfig(base, { approvalMarker: 42 as unknown })
  assert.equal(bad.config.approvalMarker, "PLAN APPROVED:")
  assert.ok(
    bad.warnings.some((w) => w === 'config: invalid value for "approvalMarker"; keeping default'),
  )
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

/** The digest is exactly 12 lowercase hex characters. */
test("configDigest returns 12 lowercase hex chars", () => {
  const digest = configDigest(defaultConfig({}))
  assert.match(digest, /^[0-9a-f]{12}$/)
})

/** An independently-built config with the same content digests identically. */
test("configDigest is deterministic across independently-built configs", () => {
  assert.equal(configDigest(defaultConfig({})), configDigest(defaultConfig({})))
})

/** Flipping one key changes the digest. */
test("configDigest flips when a key value changes", () => {
  const base = defaultConfig({})
  const flipped = { ...base, trace: !base.trace }
  assert.notEqual(configDigest(base), configDigest(flipped))
})

/** (f) readWarn >= readBlock clamps readWarn to readBlock-1 with exactly one warning. */
test("loadConfig clamps readWarn down to readBlock-1 with exactly one warning", () => {
  const file = path.join(xdgTmp, "warn-clamp.json")
  fs.writeFileSync(file, "{}")
  const { config, warnings } = loadConfig(
    { [ENV_KEYS.config]: file },
    { readWarn: 20, readBlock: 15 },
  )
  assert.equal(config.readWarn, 14)
  assert.equal(config.readBlock, 15)
  assert.equal(warnings.length, 1)
  assert.equal(warnings[0], "config: readWarn (20) >= readBlock (15); clamping readWarn to 14")
})

/** (o)/(f) default config never clamps and its digest stays byte-identical to defaultConfig. */
test("loadConfig leaves the default bareOutput and digest unchanged", () => {
  const file = path.join(xdgTmp, "default-stable.json")
  fs.writeFileSync(file, "{}")
  const { config } = loadConfig({ [ENV_KEYS.config]: file })
  assert.deepEqual(config.agents.bareOutput, ["test-runner", "reviewer", "plan-reviewer"])
  assert.equal(config.readWarn, 8)
  assert.equal(config.readBlock, 15)
  assert.equal(configDigest(config), configDigest(defaultConfig({})))
})

/** (g) a relative metricsDir from the file layer is rejected, default kept, warned. */
test("loadConfig rejects a relative metricsDir from the file layer", () => {
  const file = path.join(xdgTmp, "rel-file.json")
  fs.writeFileSync(file, JSON.stringify({ metricsDir: "./metrics" }))
  const { config, warnings } = loadConfig({ [ENV_KEYS.config]: file })
  assert.ok(path.isAbsolute(config.metricsDir))
  assert.ok(warnings.some((w) => w === 'config: invalid value for "metricsDir"; keeping default'))
})

/** (g) a relative metricsDir from the env layer is rejected, default kept, warned.
 *  Runs in a temp cwd so the documented cwd-relative journal write stays out of
 *  the repo working tree. */
test("loadConfig rejects a relative metricsDir from the env layer", async () => {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "turnstile-rel-"))
  const prev = process.cwd()
  process.chdir(sandbox)
  try {
    const { config, warnings } = loadConfig({ [ENV_KEYS.metricsDir]: "rel/metrics" })
    assert.ok(path.isAbsolute(config.metricsDir))
    assert.ok(
      warnings.some(
        (w) => w === `env ${ENV_KEYS.metricsDir}="rel/metrics" is relative; keeping current value`,
      ),
    )
  } finally {
    process.chdir(prev)
  }
})

/** (g) an absolute metricsDir from the env layer passes with no relative warning. */
test("loadConfig accepts an absolute metricsDir from the env layer", () => {
  const abs = path.join(xdgTmp, "abs-metrics")
  const { config, warnings } = loadConfig({ [ENV_KEYS.metricsDir]: abs })
  assert.equal(config.metricsDir, abs)
  const rel = warnings.filter((w) => w.includes("metricsDir") && w.includes("relative"))
  assert.equal(rel.length, 0)
})

/** (o) renamed agents without an explicit bareOutput re-derive into bareOutput. */
test("loadConfig derives bareOutput from renamed agents when bareOutput is unset", () => {
  const file = path.join(xdgTmp, "rename.json")
  fs.writeFileSync(
    file,
    JSON.stringify({
      agents: { testRunner: "ci-bot", reviewer: "ci-rev", planReviewer: "ci-plan" },
    }),
  )
  const { config } = loadConfig({ [ENV_KEYS.config]: file })
  assert.deepEqual(config.agents.bareOutput, ["ci-bot", "ci-rev", "ci-plan"])
})

/** (o) derived bareOutput dedups identical agent names (plan-reviewer default kept). */
test("loadConfig dedups derived bareOutput", () => {
  const file = path.join(xdgTmp, "dedupe.json")
  fs.writeFileSync(file, JSON.stringify({ agents: { testRunner: "ci", reviewer: "ci" } }))
  const { config } = loadConfig({ [ENV_KEYS.config]: file })
  assert.deepEqual(config.agents.bareOutput, ["ci", "plan-reviewer"])
})

/** (o) an explicit non-default bareOutput list is kept verbatim, renames ignored. */
test("loadConfig keeps an explicit non-default bareOutput list verbatim", () => {
  const file = path.join(xdgTmp, "explicit.json")
  fs.writeFileSync(
    file,
    JSON.stringify({ agents: { testRunner: "ci-bot", bareOutput: ["ci-bot", "custom-agent"] } }),
  )
  const { config } = loadConfig({ [ENV_KEYS.config]: file })
  assert.deepEqual(config.agents.bareOutput, ["ci-bot", "custom-agent"])
})

/** (o) an explicit list byte-identical to the default literal is treated as unset and re-derived. */
test("loadConfig re-derives when an explicit bareOutput equals the default literal", () => {
  const file = path.join(xdgTmp, "default-list.json")
  fs.writeFileSync(
    file,
    JSON.stringify({
      agents: { testRunner: "ci-bot", bareOutput: ["test-runner", "reviewer", "plan-reviewer"] },
    }),
  )
  const { config } = loadConfig({ [ENV_KEYS.config]: file })
  assert.deepEqual(config.agents.bareOutput, ["ci-bot", "reviewer", "plan-reviewer"])
})

/** (AC-8) an invalid gateEvidence value keeps the default, names the key, and warns once. */
test("mergeConfig rejects an invalid gateEvidence and keeps the enforce default", () => {
  const base = defaultConfig({})
  assert.equal(base.gateEvidence, "enforce")
  const { config, warnings } = mergeConfig(base, { gateEvidence: "strict" })
  assert.equal(config.gateEvidence, "enforce")
  assert.deepEqual(warnings, [
    'config: gateEvidence must be "enforce", "flag", or "off"; keeping default',
  ])
})

/** (AC-8) every valid gateEvidence literal is accepted verbatim. */
test("mergeConfig accepts each valid gateEvidence literal", () => {
  for (const mode of ["enforce", "flag", "off"] as const) {
    const { config, warnings } = mergeConfig(defaultConfig({}), { gateEvidence: mode })
    assert.equal(config.gateEvidence, mode)
    assert.equal(warnings.length, 0)
  }
})

/** (AC-8) a non-compiling evidencePattern keeps the default and warns naming the key. */
test("mergeConfig rejects a non-compiling evidencePattern and keeps the default", () => {
  const base = defaultConfig({})
  const { config, warnings } = mergeConfig(base, { evidencePattern: "(" })
  assert.equal(config.evidencePattern, base.evidencePattern)
  assert.ok(
    warnings.some((w) => w === 'config: invalid value for "evidencePattern"; keeping default'),
  )
})

/** (AC-8) a compiling evidencePattern is accepted, even one overriding the default toolchain. */
test("mergeConfig accepts a compiling custom evidencePattern", () => {
  const base = defaultConfig({})
  const { config, warnings } = mergeConfig(base, { evidencePattern: "\\brspec\\b" })
  assert.equal(config.evidencePattern, "\\brspec\\b")
  assert.equal(warnings.length, 0)
})

/** (AC-8) the digest flips when gateEvidence or evidencePattern override defaults. */
test("configDigest flips on evidence-key overrides", () => {
  const base = defaultConfig({})
  assert.notEqual(configDigest(base), configDigest({ ...base, gateEvidence: "flag" }))
  assert.notEqual(configDigest(base), configDigest({ ...base, evidencePattern: "\\brspec\\b" }))
})

/** (AC-2) default config ships the git-protective toolPolicy denylist. */
test("defaultConfig ships the toolPolicy denylist defaults", () => {
  const cfg = defaultConfig({})
  assert.equal(cfg.toolPolicy.mode, "enforce")
  assert.deepEqual(cfg.toolPolicy.bashDeny, [
    "\\bgit\\b[^;&|]*?\\sworktree\\s+(add|remove|prune)\\b",
    "\\bgit\\b[^;&|]*?\\s(switch|checkout)\\b(?![^;&|]*?--\\s)",
    "\\bgit\\b[^;&|]*?\\smerge\\b",
    "\\bgh\\s+pr\\s+(create|merge)\\b",
  ])
  assert.deepEqual(cfg.toolPolicy.pathDeny, [])
  assert.equal(cfg.toolPolicy.observeSessionMove, true)
})

/** gitGates defaults: shadow mode, conventional-commit linting on, landing gate on. */
test("defaultConfig ships the gitGates defaults (shadow)", () => {
  const cfg = defaultConfig({})
  assert.equal(cfg.gitGates.mode, "shadow")
  assert.equal(cfg.gitGates.commitMessages, true)
  assert.equal(cfg.gitGates.commitFormat, DEFAULT_COMMIT_FORMAT)
  assert.equal(cfg.gitGates.landingGate, true)
})

/** The default commitFormat compiles as a `^…$` + `"s"` pattern. */
test("defaultConfig commitFormat compiles as a conventional-commit regex", () => {
  const re = new RegExp(`^${DEFAULT_COMMIT_FORMAT}$`, "s")
  assert.equal(re.test("feat: fix the bug"), true)
  assert.equal(re.test("feat(api)!: big change"), true)
  assert.equal(re.test("feat no separator"), false)
})

/** A non-object gitGates keeps every default and warns once. */
test("mergeConfig rejects a non-object gitGates and keeps defaults", () => {
  const base = defaultConfig({})
  const { config, warnings } = mergeConfig(base, { gitGates: "nope" as unknown })
  assert.deepEqual(config.gitGates, base.gitGates)
  assert.deepEqual(warnings, ["config: gitGates must be an object; keeping defaults"])
})

/** An invalid gitGates.mode keeps the shadow default and names it. */
test("mergeConfig rejects an invalid gitGates.mode and keeps shadow", () => {
  const base = defaultConfig({})
  const { config, warnings } = mergeConfig(base, { gitGates: { mode: "strict" } })
  assert.equal(config.gitGates.mode, "shadow")
  assert.deepEqual(warnings, [
    'config: gitGates.mode must be "enforce", "shadow", or "off"; keeping default',
  ])
})

/** Valid gitGates overrides are applied one level deep. */
test("mergeConfig applies valid gitGates overrides", () => {
  const base = defaultConfig({})
  const { config } = mergeConfig(base, {
    gitGates: { mode: "enforce", commitMessages: false, landingGate: false },
  })
  assert.equal(config.gitGates.mode, "enforce")
  assert.equal(config.gitGates.commitMessages, false)
  assert.equal(config.gitGates.landingGate, false)
  // Untouched sub-keys keep their defaults.
  assert.equal(config.gitGates.commitFormat, DEFAULT_COMMIT_FORMAT)
})

/** A non-boolean commitMessages/landingGate keeps the default and warns. */
test("mergeConfig rejects non-boolean gitGates sub-keys", () => {
  const base = defaultConfig({})
  const { config, warnings } = mergeConfig(base, {
    gitGates: { commitMessages: "yes", landingGate: 1 },
  })
  assert.equal(config.gitGates.commitMessages, true)
  assert.equal(config.gitGates.landingGate, true)
  assert.deepEqual(warnings, [
    "config: gitGates.commitMessages must be a boolean; keeping default",
    "config: gitGates.landingGate must be a boolean; keeping default",
  ])
})

/** A non-compiling commitFormat is dropped with a warning; the default survives. */
test("mergeConfig rejects a non-compiling gitGates.commitFormat", () => {
  const base = defaultConfig({})
  const { config, warnings } = mergeConfig(base, { gitGates: { commitFormat: "(" } })
  assert.equal(config.gitGates.commitFormat, DEFAULT_COMMIT_FORMAT)
  assert.deepEqual(warnings, [
    "config: gitGates.commitFormat is not a valid regex; keeping default",
  ])
})

/** A well-shaped commitFormat override is kept. */
test("mergeConfig keeps a valid gitGates.commitFormat override", () => {
  const base = defaultConfig({})
  const { config } = mergeConfig(base, { gitGates: { commitFormat: "\\bcowsay\\b" } })
  assert.equal(config.gitGates.commitFormat, "\\bcowsay\\b")
})

/** Unknown gitGates sub-keys are ignored with a warning. */
test("mergeConfig ignores unknown gitGates sub-keys", () => {
  const base = defaultConfig({})
  const { config, warnings } = mergeConfig(base, { gitGates: { mode: "shadow", bogus: 1 } })
  assert.equal(config.gitGates.mode, "shadow")
  assert.deepEqual(warnings, ['config: unknown gitGates key "bogus" ignored'])
})

/** (AC-15) flipping a gitGates value flips the config digest. */
test("configDigest flips when a gitGates value changes", () => {
  const base = defaultConfig({})
  const before = configDigest(base)
  const after = configDigest({ ...base, gitGates: { ...base.gitGates, mode: "enforce" } })
  assert.notEqual(before, after)
})

/** A non-object toolPolicy keeps every default and warns once. */
test("mergeConfig rejects a non-object toolPolicy and keeps defaults", () => {
  const base = defaultConfig({})
  const { config, warnings } = mergeConfig(base, { toolPolicy: "nope" as unknown })
  assert.deepEqual(config.toolPolicy, base.toolPolicy)
  assert.deepEqual(warnings, ["config: toolPolicy must be an object; keeping defaults"])
})

/** An invalid toolPolicy.mode keeps the enforce default and names it. */
test("mergeConfig rejects an invalid toolPolicy.mode and keeps enforce", () => {
  const base = defaultConfig({})
  const { config, warnings } = mergeConfig(base, { toolPolicy: { mode: "strict" } })
  assert.equal(config.toolPolicy.mode, "enforce")
  assert.deepEqual(warnings, [
    'config: toolPolicy.mode must be "enforce", "shadow", or "off"; keeping default',
  ])
})

/** observeSessionMove must be a boolean; a non-boolean keeps the default. */
test("mergeConfig rejects a non-boolean toolPolicy.observeSessionMove", () => {
  const base = defaultConfig({})
  const { config, warnings } = mergeConfig(base, {
    toolPolicy: { observeSessionMove: "yes" },
  })
  assert.equal(config.toolPolicy.observeSessionMove, true)
  assert.deepEqual(warnings, [
    "config: toolPolicy.observeSessionMove must be a boolean; keeping default",
  ])
})

/** A well-shaped list drops only the non-compiling element, keeps the rest. */
test("mergeConfig drops one non-compiling toolPolicy.bashDeny element, keeps the rest", () => {
  const base = defaultConfig({})
  const { config, warnings } = mergeConfig(base, {
    toolPolicy: { bashDeny: ["\\bnpm\\s+test\\b", "("] },
  })
  assert.deepEqual(config.toolPolicy.bashDeny, ["\\bnpm\\s+test\\b"])
  assert.deepEqual(warnings, [
    "config: toolPolicy.bashDeny[1] is not a valid regex; dropping element",
  ])
})

/**
 * Bad elements are dropped element-wise — a non-string, an empty string, and a
 * blank string are each discarded while the compilable strings survive
 * instead of the whole array being rejected. Each drop is named by index;
 * the surviving list is just the filtered sources.
 */
test("mergeConfig drops non-string and empty bashDeny elements, keeps the rest", () => {
  const base = defaultConfig({})
  const { config, warnings } = mergeConfig(base, {
    toolPolicy: {
      bashDeny: ["\\bnpm\\s+test\\b", 123, "", "   ", "\\bgit\\s+status\\b"],
    },
  })
  assert.deepEqual(config.toolPolicy.bashDeny, ["\\bnpm\\s+test\\b", "\\bgit\\s+status\\b"])
  assert.deepEqual(warnings, [
    "config: toolPolicy.bashDeny[1] is not a non-empty string; dropping element",
    "config: toolPolicy.bashDeny[2] is not a non-empty string; dropping element",
    "config: toolPolicy.bashDeny[3] is not a non-empty string; dropping element",
  ])
})

/**
 * A dropped element is journaled as {type:"error"} through loadConfig: the
 * bad element never reaches the resolved config, and each drop is
 * recorded as a persistent error, so a config typo weakens the denylist
 * visibly rather than silently. Non-array values fall back to the default.
 */
test("loadConfig journals each dropped bashDeny element as an error", () => {
  const file = path.join(xdgTmp, "tp-bad-elements.json")
  fs.writeFileSync(
    file,
    JSON.stringify({
      toolPolicy: { bashDeny: ["\\bnpm\\s+test\\b", 42, ""], pathDeny: ["valid-regex"] },
    }),
  )
  const { config } = loadConfig({ [ENV_KEYS.config]: file })
  assert.deepEqual(config.toolPolicy.bashDeny, ["\\bnpm\\s+test\\b"])
  assert.deepEqual(config.toolPolicy.pathDeny, ["valid-regex"])
  const errors = fs
    .readFileSync(DEFAULT_JOURNAL_PATH, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l))
    .filter(
      (l) =>
        l.type === "error" &&
        (String(l.error).includes("bashDeny[1] is not a non-empty string") ||
          String(l.error).includes("bashDeny[2] is not a non-empty string")),
    )
  assert.equal(errors.length, 2)
})

/** A non-array toolPolicy.bashDeny keeps the default and warns once. */
test("mergeConfig rejects a non-array toolPolicy.pathDeny and keeps defaults", () => {
  const base = defaultConfig({})
  const { config, warnings } = mergeConfig(base, {
    toolPolicy: { pathDeny: "not-an-array" },
  })
  assert.deepEqual(config.toolPolicy.pathDeny, [])
  assert.deepEqual(warnings, [
    "config: toolPolicy.pathDeny must be an array of non-empty strings; keeping default",
  ])
})

/** Unknown toolPolicy sub-keys are ignored with one warning. */
test("mergeConfig ignores unknown toolPolicy sub-keys", () => {
  const base = defaultConfig({})
  const { config, warnings } = mergeConfig(base, {
    toolPolicy: { mode: "shadow", bogus: true },
  })
  assert.equal(config.toolPolicy.mode, "shadow")
  assert.deepEqual(warnings, ['config: unknown toolPolicy key "bogus" ignored'])
})

/** Overrides merge one level deep: a supplied mode keeps unmentioned defaults. */
test("loadConfig merges toolPolicy one level deep", () => {
  const file = path.join(xdgTmp, "tp-deep.json")
  fs.writeFileSync(file, JSON.stringify({ toolPolicy: { mode: "shadow" } }))
  const { config } = loadConfig({ [ENV_KEYS.config]: file })
  assert.equal(config.toolPolicy.mode, "shadow")
  assert.deepEqual(config.toolPolicy.bashDeny, defaultConfig({}).toolPolicy.bashDeny)
})

/** The config digest flips when toolPolicy.mode changes from the default. */
test("configDigest flips when toolPolicy.mode changes", () => {
  const base = defaultConfig({})
  assert.notEqual(
    configDigest(base),
    configDigest({ ...base, toolPolicy: { ...base.toolPolicy, mode: "shadow" } }),
  )
})
