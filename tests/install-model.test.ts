/**
 * @fileoverview Model-config printer tests for the optional
 * `--print-model-config` CLI (scripts/install.mjs). Imports the pure exports
 * (parseModelSpecs, formatModelConfig, findMissingModels) and the injectable
 * command-runner seam to drive the write-free print/validate path in-process,
 * plus a few child-spawn smoke tests for exit codes and stdout. Nothing here
 * touches the install manifest, writes a ledger, or creates link/copy targets:
 * the printer short-circuits before any install work.
 */

import { test } from "node:test"
import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

// scripts/install.mjs is untyped JS; tests import its pure exports and the
// injected-runner seam directly rather than spawning.
import {
  parseModelSpecs,
  formatModelConfig,
  findMissingModels,
  setCommandRunner,
  main,
  // @ts-expect-error TS7016: scripts/install.mjs is untyped JS.
} from "../scripts/install.mjs"

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..")

const AGENT_ORDER = ["planner", "plan-reviewer", "executor", "test-runner", "reviewer", "debugger"]

// ---- parseModelSpecs -------------------------------------------------------

/** A bare spec seeds all six agents with that value. */
test("parseModelSpecs: a bare spec seeds all six agents", () => {
  assert.deepEqual(parseModelSpecs(["anthropic/claude-3"]), {
    planner: "anthropic/claude-3",
    "plan-reviewer": "anthropic/claude-3",
    executor: "anthropic/claude-3",
    "test-runner": "anthropic/claude-3",
    reviewer: "anthropic/claude-3",
    debugger: "anthropic/claude-3",
  })
})

/** A name= spec seeds only that one agent. */
test("parseModelSpecs: a name= spec seeds only one agent", () => {
  assert.deepEqual(parseModelSpecs(["planner=anthropic/claude-3"]), {
    planner: "anthropic/claude-3",
  })
})

/** A validly named spec is accepted and stored verbatim. */
test("parseModelSpecs: accepts a validly named spec", () => {
  assert.deepEqual(parseModelSpecs(["debugger=google/gemini-1.5-pro"]), {
    debugger: "google/gemini-1.5-pro",
  })
})

/** An optional #variant is preserved in the stored spec. */
test("parseModelSpecs: preserves an optional #variant", () => {
  assert.deepEqual(parseModelSpecs(["planner=anthropic/claude-3#fast"]), {
    planner: "anthropic/claude-3#fast",
  })
})

/** Last spec wins for an agent named more than once. */
test("parseModelSpecs: last spec wins for an agent named twice", () => {
  assert.deepEqual(
    parseModelSpecs(["planner=anthropic/claude-3", "planner=anthropic/claude-sonnet-4"]),
    { planner: "anthropic/claude-sonnet-4" },
  )
})

/** Multiple agents can be seeded in one call. */
test("parseModelSpecs: seeds distinct agents from multiple specs", () => {
  assert.deepEqual(
    parseModelSpecs(["planner=anthropic/claude-3", "executor=anthropic/claude-sonnet-4"]),
    {
      planner: "anthropic/claude-3",
      executor: "anthropic/claude-sonnet-4",
    },
  )
})

/** No specs yields an empty map (formatModelConfig then fills placeholders). */
test("parseModelSpecs: no specs yields an empty map", () => {
  assert.deepEqual(parseModelSpecs([]), {})
})

/** An unknown agent name throws, listing the six valid names. */
test("parseModelSpecs: rejects an unknown agent name, listing the six", () => {
  assert.throws(
    () => parseModelSpecs(["bogus=anthropic/claude-3"]),
    (err: unknown) => {
      const msg = String((err as Error).message)
      return (
        msg.includes('unknown agent "bogus"') &&
        ["planner", "plan-reviewer", "executor", "test-runner", "reviewer", "debugger"].every((n) =>
          msg.includes(n),
        )
      )
    },
  )
})

/** An empty name prefix (leading =) is an unknown agent. */
test("parseModelSpecs: rejects an empty name prefix", () => {
  assert.throws(() => parseModelSpecs(["=anthropic/claude-3"]), /unknown agent ""/)
})

/** A spec without a provider/model shape throws, showing the grammar. */
test("parseModelSpecs: rejects a malformed spec, showing the grammar", () => {
  assert.throws(
    () => parseModelSpecs(["not-a-spec"]),
    (err: unknown) => {
      const msg = String((err as Error).message)
      return msg.includes('invalid --model spec "not-a-spec"') && msg.includes("expected")
    },
  )
})

// ---- formatModelConfig -----------------------------------------------------

/** formatModelConfig emits all six agents in canonical order, placeholders unset. */
test("formatModelConfig: six canonical entries with placeholder defaults", () => {
  const out = JSON.parse(formatModelConfig({}))
  assert.deepEqual(Object.keys(out.agents), AGENT_ORDER)
  for (const name of Object.keys(out.agents))
    assert.equal(out.agents[name], "<provider>/<model-id>")
})

/** Seeded agents appear with their value; unset stays a placeholder. */
test("formatModelConfig: seeds named agents, leaves the rest placeholders", () => {
  const out = JSON.parse(formatModelConfig({ planner: "anthropic/claude-3" }))
  assert.equal(out.agents.planner, "anthropic/claude-3")
  assert.equal(out.agents["plan-reviewer"], "<provider>/<model-id>")
  // canonical order is preserved with a seed in the first slot
  assert.deepEqual(Object.keys(out.agents), AGENT_ORDER)
})

/** The output is always valid, two-space-indented JSON. */
test("formatModelConfig: output is valid, two-space-indented JSON", () => {
  const text = formatModelConfig({ executor: "anthropic/claude-sonnet-4" })
  assert.match(text, /^ {2}"agents": \{$/m)
  assert.match(text, /^ {4}"executor": "anthropic\/claude-sonnet-4",$/m)
})

// ---- findMissingModels -----------------------------------------------------

/** A concrete spec present in `available` is not flagged. */
test("findMissingModels: a present concrete spec is not flagged", () => {
  assert.deepEqual(
    findMissingModels({ planner: "anthropic/claude-3" }, ["anthropic/claude-3", "x/y"]),
    [],
  )
})

/** A concrete spec absent from `available` is flagged. */
test("findMissingModels: an absent concrete spec is flagged", () => {
  assert.deepEqual(findMissingModels({ planner: "anthropic/nope" }, ["anthropic/claude-3"]), [
    "anthropic/nope",
  ])
})

/** Unset and placeholder agents are never validated. */
test("findMissingModels: skips unset and placeholder agents", () => {
  const specs = {
    planner: "anthropic/missing", // seeded + missing -> flagged
    "plan-reviewer": "anthropic/present", // seeded + present -> ok
    // test-runner: unset -> skipped
    reviewer: "<provider>/<model-id>", // placeholder -> skipped
  }
  assert.deepEqual(findMissingModels(specs, ["anthropic/present"]), ["anthropic/missing"])
})

// ---- in-process print/validate path (fake spawn) ---------------------------

/**
 * --validate with a faked `opencode models`: a seeded spec the fake does not
 * list makes the print path return false (mapped to exit 1) and name the model.
 */
test("main --print-model-config --validate: an unknown concrete model returns false and names it", async () => {
  const restore = (command: string, args: string[], options?: object) =>
    spawnSync(command, args, options)
  const errors: string[] = []
  const originalError = console.error
  console.error = (msg: unknown): void => {
    errors.push(String(msg))
  }
  setCommandRunner((): { stdout: string } => ({
    stdout: "anthropic/claude-3\nanthropic/claude-sonnet-4\n",
  }))
  try {
    const result = await main([
      "node",
      "install.mjs",
      "--print-model-config",
      "--model",
      "planner=anthropic/does-not-exist",
      "--validate",
    ])
    assert.equal(result, false)
    assert.ok(
      errors.some((e) => e.includes("validate: unknown model anthropic/does-not-exist")),
      `expected a naming error, got: ${errors.join(" | ")}`,
    )
  } finally {
    console.error = originalError
    setCommandRunner(restore)
  }
})

/**
 * --validate when the seeded model IS present: the print path returns true and
 * prints the snippet.
 */
test("main --print-model-config --validate: a present concrete model returns true", async () => {
  const restore = (command: string, args: string[], options?: object) =>
    spawnSync(command, args, options)
  setCommandRunner((): { stdout: string } => ({ stdout: "anthropic/claude-3\n" }))
  try {
    const result = await main([
      "node",
      "install.mjs",
      "--print-model-config",
      "--model",
      "planner=anthropic/claude-3",
      "--validate",
    ])
    assert.equal(result, true)
  } finally {
    setCommandRunner(restore)
  }
})

// ---- CLI smoke tests (child spawn, no live host CLI) -----------------------

/** --print-model-config exits 0 and prints six canonical agent names. */
test("CLI --print-model-config: exits 0 with six canonical agent names", () => {
  const res = spawnSync(
    process.execPath,
    [join(repoRoot, "scripts/install.mjs"), "--print-model-config"],
    {
      encoding: "utf8",
    },
  )
  assert.equal(res.status, 0)
  const out = JSON.parse(res.stdout)
  assert.deepEqual(Object.keys(out.agents), AGENT_ORDER)
})

/** --model planner=provider/model seeds only planner (AC-6 one-name seeding). */
test("CLI --model planner=provider/model seeds only planner", () => {
  const res = spawnSync(
    process.execPath,
    [
      join(repoRoot, "scripts/install.mjs"),
      "--print-model-config",
      "--model",
      "planner=anthropic/claude-3",
    ],
    { encoding: "utf8" },
  )
  assert.equal(res.status, 0)
  const out = JSON.parse(res.stdout)
  assert.equal(out.agents.planner, "anthropic/claude-3")
  assert.equal(out.agents["plan-reviewer"], "<provider>/<model-id>")
})

/** --print-model-config ignores the manifest: a bogus path still prints (write-free). */
test("CLI --print-model-config: short-circuits before the manifest", () => {
  const res = spawnSync(
    process.execPath,
    [
      join(repoRoot, "scripts/install.mjs"),
      "--print-model-config",
      "--manifest",
      join(repoRoot, "does-not-exist.json"),
    ],
    { encoding: "utf8" },
  )
  assert.equal(res.status, 0)
  const out = JSON.parse(res.stdout)
  assert.deepEqual(Object.keys(out.agents).sort(), AGENT_ORDER.sort())
})

/** A malformed spec exits 2 with an actionable message (AC-6). */
test("CLI malformed --model spec exits 2", () => {
  const res = spawnSync(
    process.execPath,
    [join(repoRoot, "scripts/install.mjs"), "--print-model-config", "--model", "not-a-spec"],
    { encoding: "utf8" },
  )
  assert.equal(res.status, 2)
  assert.match(res.stderr, /invalid --model spec "not-a-spec"/)
})

/** An unknown agent name exits 2, listing the six (AC-6). */
test("CLI unknown --model agent name exits 2, listing the six", () => {
  const res = spawnSync(
    process.execPath,
    [
      join(repoRoot, "scripts/install.mjs"),
      "--print-model-config",
      "--model",
      "bogus=anthropic/claude-3",
    ],
    { encoding: "utf8" },
  )
  assert.equal(res.status, 2)
  assert.match(res.stderr, /unknown agent "bogus"/)
  assert.match(res.stderr, /planner, plan-reviewer, executor, test-runner, reviewer, debugger/)
})

/** An unrelated unknown flag still exits 2 (contract preserved). */
test("CLI an unknown flag still exits 2", () => {
  const res = spawnSync(process.execPath, [join(repoRoot, "scripts/install.mjs"), "--nope"], {
    encoding: "utf8",
  })
  assert.equal(res.status, 2)
  assert.match(res.stderr, /unknown argument --nope/)
})
