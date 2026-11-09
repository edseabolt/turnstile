#!/usr/bin/env node
/**
 * Differential characterization harness (#265): drives HEAD and a reference
 * commit's `src/` through identical inputs and diffs the outputs, so a
 * behavior-preserving refactor is verified by a command, not by eye.
 *
 * Characterization contract: the harness asserts tree A ≡ tree B, never
 * tree B ≡ "intended behavior". When a behavior change is deliberate,
 * re-point `--ref` at the commit that introduced it.
 *
 * Execution rule per scenario: pure-function scenarios (`config`, `markers`)
 * run in-process — Node's module cache is keyed by resolved path, so both
 * trees' `src/*.ts` load independently without a process boundary. Stateful
 * scenarios (`replay`, `dispatch`, `journal`, `prov` — journalers, ledgers,
 * host hooks) run one subprocess per tree via
 * `node --experimental-strip-types scripts/differential/driver-<name>.mjs <tree>`.
 *
 * Drift tolerance: a scenario whose required module is absent in the ref
 * tree reports `SKIPPED (absent in ref)` instead of crashing. Cells present
 * only in the HEAD tree (surface growth, e.g. config keys added after the
 * ref) are reported as `NEW-IN-HEAD` and do not fail the run; cells present
 * only in the ref tree are a removal and DO fail it.
 *
 * CLI: `node scripts/differential.mjs [--ref <git-ref>] [--scenario <name|all>] [--keep]`
 * Summary marker: `DIFFERENTIAL: PASS scenarios=<n> cells=<n> …` /
 * `DIFFERENTIAL: FAIL …`. Exit 0 only when no scenario failed (skips allowed).
 */

import { execFileSync, spawnSync } from "node:child_process"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const DRIVERS_DIR = path.join(REPO_ROOT, "scripts", "differential")
const DEFAULT_REF = "138c809^"
const SCENARIO_NAMES = ["config", "markers", "replay", "dispatch", "journal", "prov"]
/** Scenarios driven in-process (pure functions only); the rest subprocess. */
const INPROCESS_SCENARIOS = new Set(["config", "markers"])
const WORKTREE_PREFIX = "turnstile-diff-ref-"

/**
 * Parses the harness CLI arguments.
 * @param {string[]} argv Raw `process.argv` tail.
 * @returns {{ref: string, scenario: string, keep: boolean}} Parsed options.
 */
function parseArgs(argv) {
  const opts = { ref: DEFAULT_REF, scenario: "all", keep: false }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === "--ref") opts.ref = argv[++i] ?? fail("missing value for --ref")
    else if (arg === "--scenario") opts.scenario = argv[++i] ?? fail("missing value for --scenario")
    else if (arg === "--keep") opts.keep = true
    else fail(`unknown argument: ${arg}`)
  }
  if (!SCENARIO_NAMES.includes(opts.scenario) && opts.scenario !== "all") {
    fail(`unknown scenario "${opts.scenario}" (choose: ${SCENARIO_NAMES.join(", ")}, all)`)
  }
  return opts
}

/**
 * Prints an error and exits nonzero.
 * @param {string} message The failure reason.
 * @returns {never} Never returns.
 */
function fail(message) {
  console.error(`differential: ${message}`)
  process.exit(1)
}

/**
 * Resolves a git revision to a full sha, failing with a clear message when
 * unknown (a shallow clone may lack old refs).
 * @param {string} ref The revision to resolve.
 * @returns {string} The full sha.
 */
function resolveRef(ref) {
  try {
    return execFileSync("git", ["rev-parse", "--verify", `${ref}^{commit}`], {
      cwd: REPO_ROOT,
      encoding: "utf8",
    }).trim()
  } catch {
    return fail(`unknown ref "${ref}" — not in this repository's history (shallow clone?)`)
  }
}

/**
 * Creates a detached worktree at the given ref for the reference tree.
 * @param {string} ref The resolved ref sha.
 * @returns {string} The worktree directory.
 */
function makeRefWorktree(ref) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), WORKTREE_PREFIX))
  try {
    execFileSync("git", ["worktree", "add", "--detach", dir, ref], { cwd: REPO_ROOT })
  } catch (e) {
    fs.rmSync(dir, { recursive: true, force: true })
    fail(`could not create reference worktree at ${ref}: ${e}`)
  }
  return dir
}

/**
 * Removes the reference worktree unless kept for debugging.
 * @param {string} dir The worktree directory.
 * @param {boolean} keep When true, leave the worktree in place and print its path.
 */
function cleanupWorktree(dir, keep) {
  if (keep) {
    console.log(`differential: kept reference worktree at ${dir}`)
    return
  }
  try {
    execFileSync("git", ["worktree", "remove", "--force", dir], { cwd: REPO_ROOT })
  } catch {
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

/**
 * Runs a driver in-process against one tree root.
 * @param {string} name The scenario name (driver module `driver-<name>.mjs`).
 * @param {string} treeRoot The tree root to bind the driver's imports to.
 * @returns {Promise<{ok: boolean, cells?: Object, code?: string, message?: string, module?: string}>}
 *     The driver result.
 */
async function runDriver(name, treeRoot) {
  const driver = await import(pathToFileURL(path.join(DRIVERS_DIR, `driver-${name}.mjs`)).href)
  return driver.scenario(treeRoot)
}

/**
 * Runs a driver as a subprocess against one tree root (fresh import state).
 * @param {string} name The scenario name.
 * @param {string} treeRoot The tree root passed as argv[2].
 * @returns {{ok: boolean, cells?: Object, code?: string, message?: string, module?: string}}
 *     The parsed driver result, or an error-shaped result on a crash.
 */
function runDriverSubprocess(name, treeRoot) {
  const driverPath = path.join(DRIVERS_DIR, `driver-${name}.mjs`)
  const res = spawnSync(process.execPath, ["--experimental-strip-types", driverPath, treeRoot], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    timeout: 120_000,
  })
  if (res.status !== 0 || res.stdout === null) {
    return {
      ok: false,
      code: "DRIVER_CRASH",
      message: `exit=${res.status} stderr=${String(res.stderr ?? "").slice(-800)}`,
    }
  }
  try {
    return JSON.parse(res.stdout)
  } catch {
    return {
      ok: false,
      code: "DRIVER_CRASH",
      message: `unparseable stdout: ${String(res.stdout).slice(-400)}`,
    }
  }
}

/**
 * Runs one scenario's driver against a tree root, choosing the execution mode.
 * @param {string} name The scenario name.
 * @param {string} treeRoot The tree root.
 * @returns {Promise<{ok: boolean, cells?: Object, code?: string, message?: string, module?: string}>}
 *     The driver result.
 */
async function runScenarioSide(name, treeRoot) {
  if (INPROCESS_SCENARIOS.has(name)) return runDriver(name, treeRoot)
  return runDriverSubprocess(name, treeRoot)
}

/**
 * Answers whether a driver result reports a module absence.
 * @param {{ok: boolean, code?: string}} res The driver result.
 * @returns {boolean} True when the tree lacks a required module.
 */
function isModuleAbsent(res) {
  return res.ok === false && res.code === "ERR_MODULE_NOT_FOUND"
}

/**
 * Renders a driver failure as a note, ignoring the (already-handled)
 * module-absence code.
 * @param {{ok: boolean, code?: string, message?: string, module?: string}} res The driver result.
 * @param {string} tree Which tree the result came from.
 * @returns {string|undefined} The failure note, or undefined on success.
 */
function resultError(res, tree) {
  if (res.ok === true) return undefined
  if (res.code === "ERR_MODULE_NOT_FOUND") return `${tree} tree missing module: ${res.module}`
  return `${tree} driver error (${res.code}): ${String(res.message).slice(0, 400)}`
}

/**
 * Compares the two trees' cell maps into a scenario report.
 * @param {string} name The scenario name.
 * @param {Object<string, unknown>} refCells The ref tree's cells.
 * @param {Object<string, unknown>} headCells The HEAD tree's cells.
 * @returns {{name: string, status: string, cells: number, diverged: string[], added: string[], removed: string[], note: string, refCells: Object, headCells: Object}}
 *     The scenario report.
 */
function compareCells(name, refCells, headCells) {
  const diverged = []
  const added = []
  const removed = []
  for (const key of Object.keys(refCells)) {
    if (!(key in headCells)) removed.push(key)
    else if (stable(refCells[key]) !== stable(headCells[key])) diverged.push(key)
  }
  for (const key of Object.keys(headCells)) {
    if (!(key in refCells)) added.push(key)
  }
  const status = diverged.length > 0 || removed.length > 0 ? "fail" : "pass"
  return {
    name,
    status,
    cells: Object.keys(refCells).length + added.length,
    diverged,
    added,
    removed,
    note: "",
    refCells,
    headCells,
  }
}

/**
 * Runs one scenario against both trees and compares the cell maps.
 * @param {string} name The scenario name.
 * @param {string} refTree The reference tree root.
 * @param {string} headTree The HEAD tree root (the cwd repo).
 * @returns {Promise<{name: string, status: string, cells: number, diverged: string[], added: string[], removed: string[], note: string, refCells: Object, headCells: Object}>}
 *     The scenario report.
 */
async function runScenario(name, refTree, headTree) {
  const refRes = await runScenarioSide(name, refTree)
  const headRes = await runScenarioSide(name, headTree)
  if (isModuleAbsent(refRes)) {
    return {
      name,
      status: "skipped",
      cells: 0,
      diverged: [],
      added: [],
      removed: [],
      note: "SKIPPED (absent in ref)",
      refCells: {},
      headCells: {},
    }
  }
  const refError = resultError(refRes, "ref")
  const headError = resultError(headRes, "HEAD")
  if (refError || headError) {
    return {
      name,
      status: "fail",
      cells: 0,
      diverged: [],
      added: [],
      removed: [],
      note: refError ?? headError,
      refCells: {},
      headCells: {},
    }
  }
  return compareCells(name, refRes.cells ?? {}, headRes.cells ?? {})
}

/**
 * Deterministic JSON string of a value: object keys sorted, `undefined`
 * mapped to a visible sentinel so a dropped field can never compare equal
 * to a present one.
 * @param {unknown} value The value to serialize.
 * @returns {string} The stable string.
 */
function stable(value) {
  return JSON.stringify(sortValue(value), (_k, v) => (v === undefined ? "<<undefined>>" : v))
}

/**
 * Recursively sorts object keys for stable comparison.
 * @param {unknown} value The value to sort.
 * @returns {unknown} The sorted clone (arrays keep order).
 */
function sortValue(value) {
  if (Array.isArray(value)) return value.map(sortValue)
  if (value !== null && typeof value === "object") {
    const out = {}
    for (const k of Object.keys(value).sort()) out[k] = sortValue(value[k])
    return out
  }
  return value
}

/**
 * First-divergence diff between the two trees' cell values (line-level over
 * the stable serializations — characterization corpora are small, so a
 * full line set is readable and bounded).
 * @param {string} key The cell key.
 * @param {unknown} refValue The ref tree's value.
 * @param {unknown} headValue The HEAD tree's value.
 * @returns {string} The diff text (empty when equal).
 */
function cellDiff(key, refValue, headValue) {
  const a = stable(refValue).split("\n")
  const b = stable(headValue).split("\n")
  const lines = [`--- ref ${key}`, `+++ HEAD ${key}`]
  for (const line of a) if (!b.includes(line)) lines.push(`-${line}`)
  for (const line of b) if (!a.includes(line)) lines.push(`+${line}`)
  return lines.join("\n")
}

/**
 * Prints one scenario's report block.
 * @param {{name: string, status: string, cells: number, diverged: string[], added: string[], removed: string[], note: string, refCells: Object, headCells: Object}} report
 *     The scenario report.
 */
function printScenario(report) {
  const label = report.status === "skipped" ? report.note : report.status.toUpperCase()
  console.log(`\n## ${report.name}: ${label} (cells=${report.cells})`)
  if (report.note && report.status === "fail") console.log(`note: ${report.note}`)
  for (const key of report.diverged) {
    console.log(cellDiff(key, report.refCells[key], report.headCells[key]))
  }
  for (const key of report.removed) console.log(`REMOVED-IN-HEAD: ${key}`)
  for (const key of report.added) console.log(`NEW-IN-HEAD: ${key}`)
}

/**
 * Harness entry point: parse, pair the trees, run the scenarios, report.
 */
async function main() {
  const opts = parseArgs(process.argv.slice(2))
  const names = opts.scenario === "all" ? SCENARIO_NAMES : [opts.scenario]
  const refSha = resolveRef(opts.ref)
  console.log(`differential: HEAD (${REPO_ROOT}) vs ref ${opts.ref} (${refSha.slice(0, 12)})`)
  const refTree = makeRefWorktree(refSha)
  process.on("SIGINT", () => {
    cleanupWorktree(refTree, opts.keep)
    process.exit(130)
  })
  const reports = []
  try {
    for (const name of names) {
      const report = await runScenario(name, refTree, REPO_ROOT)
      reports.push(report)
      printScenario(report)
    }
  } finally {
    cleanupWorktree(refTree, opts.keep)
  }
  printSummary(reports)
}

/**
 * Prints the machine-parseable summary line and exits with the run's status.
 * @param {Array<{name: string, status: string, cells: number, diverged: string[], added: string[], removed: string[]}>} reports
 *     All scenario reports.
 */
function printSummary(reports) {
  const cells = reports.reduce((n, r) => n + r.cells, 0)
  const failed = reports.filter((r) => r.status === "fail")
  const skipped = reports.filter((r) => r.status === "skipped")
  const growth = reports.reduce((n, r) => n + r.added.length, 0)
  if (failed.length === 0) {
    console.log(
      `DIFFERENTIAL: PASS scenarios=${reports.length} cells=${cells}` +
        ` skipped=${skipped.length} newInHead=${growth}`,
    )
    process.exit(0)
  }
  const detail = failed.map((r) => `${r.name}(${r.diverged.length + r.removed.length})`).join(",")
  console.log(
    `DIFFERENTIAL: FAIL scenarios=${reports.length} cells=${cells}` +
      ` failed=${failed.length} skipped=${skipped.length} newInHead=${growth} [${detail}]`,
  )
  process.exit(1)
}

main().catch((e) => fail(String(e)))
