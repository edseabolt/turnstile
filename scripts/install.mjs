#!/usr/bin/env node
// Installs this repo's artifacts into ~/.config/opencode, driven by
// install.json. The repo is the source of truth: symlink mode (auto-detected
// on a git checkout) links targets into the checkout so repo edits are live;
// copy mode duplicates files and records what it installed in a ledger file
// so later syncs can tell "repo changed" from "user edited".
//
// Usage:
//   node scripts/install.mjs [--manifest <path>] [--check] [--force]
//                            [--uninstall] [--link | --copy] [--repair]
//
//   --manifest     Manifest to install (default: install.json at the repo root).
//                  Missing value, or a `--`-prefixed next token, exits 2 here
//                  ("requires a path") rather than crashing downstream.
//   --check        Verify all targets without writing; exit 1 on drift. With
//                  --repair, repairable drift is printed as `would repair`
//                  (write-free dry run); unrepairable drift still fails.
//   --force        Convert conflicting targets after backing them up
//   --uninstall    Reverse the manifest: remove repo-owned links / ledger-owned
//                  copies for every entry (then retire leftovers); exit 1 only
//                  when a manifest entry could not be removed (conflict/unowned)
//                  — an unowned retired leftover is reported but exits 0.
//   --repair       Apply-mode: relink/copy each repairable entry (`missing`/`stale`
//                  link-mode; `missing`/ledger-`stale` copy-mode) via the same
//                  path as install, print `install: repair <dest> (<code>)`,
//                  exit 1 only if something unrepairable remains. `conflict`
//                  stays gated behind --force (no unprompted backup). Retired
//                  entries are not swept on this path (apply and check handle
//                  them).
//   --link/--copy  Override the mode. Resolution: CLI flag > manifest "mode"
//                  field > auto-detect (.git present => link, else copy)
//
//   A manifest "links" entry may name a directory: it installs
//                  file-by-file (recursive, sorted) so a whole module tree
//                  ships with per-file ledger records and links. A "verify"
//                  list of ~-paths is dynamically imported (Node with
//                  --experimental-strip-types) after install and on every
//                  check, so an entry point whose import graph does not
//                  resolve fails the command instead of loading broken.
//
//   --print-model-config  Print a ready-to-paste {"agents": {...}} model
//                  snippet to stdout and write nothing (short-circuits before
//                  any manifest/install work, like --check). Repeatable
//                  --model specs seed individual agents:
//                  --model [name=]provider/model[#variant] (bare => all six;
//                  name= sets one; last spec wins per agent). Model ids may be
//                  multi-segment (e.g. oMLX/oQ/GLM-5.3-Flash-oQ4-mtp).
//                  --validate cross-checks concrete specs against
//                  `opencode models` (exit 1 naming a model it does not list).
//                  --model/--validate without --print-model-config exit 2.
//
// Ownership model: symlink targets are repo-owned iff the link resolves
// inside this checkout; copied files are repo-owned iff the ledger records
// them. Unowned files are never modified or removed (their contents may be
// read when classifying drift). Conflicts
// (real files differing from the repo, or user-edited copies) fail with a
// summary unless --force converts them, backing up to <name>.bak.<ts>.

import {
  readFileSync,
  writeFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  statSync,
  symlink,
  unlink,
  rename,
  copyFile,
  lstat,
  realpath,
  realpathSync,
} from "node:fs"
import { spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import { homedir } from "node:os"
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { promisify } from "node:util"

const symlinkP = promisify(symlink)
const unlinkP = promisify(unlink)
const renameP = promisify(rename)
const copyFileP = promisify(copyFile)
const lstatP = promisify(lstat)
const realpathP = promisify(realpath)

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..")
const defaultLedger = "~/.config/opencode/.turnstile-install.json"
// Single read of the package version at startup; recorded in every copy-mode
// ledger entry so `check` can report an outdated install. Guarded:
// a missing or malformed package.json must not crash the module at import
// time (fail-open contract); version records as null and `check` suppresses
// the outdated warning only for a ledger record whose version is null — a
// null package version next to a recorded version still prints the
// outdated line.
let pkgVersion = null
try {
  pkgVersion = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8")).version ?? null
} catch {
  // Fall through with null: metadata is advisory, not load-bearing.
}

/**
 * Parses command-line arguments.
 * @param {string[]} argv Raw argv (process.argv).
 * @returns {{manifest: string, check: boolean, force: boolean, uninstall: boolean, mode: "link"|"copy"|null, model: string[], printModelConfig: boolean, validate: boolean, modelSpecs: Record<string,string>, repair: boolean}} Parsed arguments. A `--model`/`--validate` without `--print-model-config` is an error and exits 2 (checked after the token loop, before any I/O). Model specs are validated here only when the printer flag is set; a malformed or unknown-name spec prints an actionable message and exits 2 (matching the unknown-arg contract), and the parsed map is stashed as `modelSpecs` for `main`. A missing or flag-shaped value for `--manifest` or `--model` also exits 2 at the assignment site, naming the offending flag (so neither path reaches a late fs parse-crash).
 */
function parseArgs(argv) {
  const args = {
    manifest: join(repoRoot, "install.json"),
    check: false,
    force: false,
    uninstall: false,
    mode: null,
    model: [],
    printModelConfig: false,
    validate: false,
    modelSpecs: {},
    repair: false,
  }
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === "--manifest") {
      const val = argv[++i]
      if (val === undefined || val.startsWith("--")) {
        console.error("install: --manifest requires a path")
        process.exit(2)
      }
      args.manifest = val
    } else if (argv[i] === "--check") args.check = true
    else if (argv[i] === "--force") args.force = true
    else if (argv[i] === "--uninstall") args.uninstall = true
    else if (argv[i] === "--link") args.mode = "link"
    else if (argv[i] === "--copy") args.mode = "copy"
    else if (argv[i] === "--model") {
      const val = argv[++i]
      if (val === undefined || val.startsWith("--")) {
        console.error("install: --model requires a spec")
        process.exit(2)
      }
      args.model.push(val)
    } else if (argv[i] === "--repair") args.repair = true
    else if (argv[i] === "--print-model-config") args.printModelConfig = true
    else if (argv[i] === "--validate") args.validate = true
    else {
      console.error(`install: unknown argument ${argv[i]}`)
      process.exit(2)
    }
  }
  // --model/--validate only mean something for the printer: given without
  // --print-model-config they have no effect, so reject them loudly (exit 2,
  // like an unknown argument) instead of silently falling through to a real
  // install. Checked after the token loop, before any manifest I/O below.
  if (!args.printModelConfig && (args.model.length > 0 || args.validate)) {
    console.error("install: --validate/--model require --print-model-config")
    process.exit(2)
  }
  // A --model spec only matters for the printer; validate it up front (so a
  // bad one exits 2 like an unknown argument) and stash the parsed map for
  // `main`.
  if (args.printModelConfig) {
    try {
      args.modelSpecs = parseModelSpecs(args.model)
    } catch (error) {
      console.error(`install: ${error.message}`)
      process.exit(2)
    }
  }
  return args
}

// The six pipeline agents, in canonical order. This is the single source of
// truth for both the printer (formatModelConfig) and the validator
// (findMissingModels), so the JSON block and the --validate pass can never
// disagree on which agents exist.
const AGENT_NAMES = ["planner", "plan-reviewer", "executor", "test-runner", "reviewer", "debugger"]

/** The placeholder used by `formatModelConfig` for any agent left unset. */
const MODEL_PLACEHOLDER = "<provider>/<model-id>"

/**
 * Human-readable model-spec grammar shown in error messages — never the raw
 * regex source. The name binds at the `=`, the provider to the first segment,
 * and a `#variant` to the tail; a model id may itself be multi-segment
 * (e.g. `oMLX/oQ/GLM-5.3-Flash-oQ4-mtp`), so "model" spans interior slashes.
 */
const SPEC_GRAMMAR = "[name=]provider/model[#variant] (model ids may be multi-segment)"

/**
 * Grammar for one model spec body — after `parseModelSpecs` splits off the
 * optional `<name>=` prefix on the first `=`, only the body reaches this
 * regex (so the regex carries no name group): provider (first segment), a
 * slash, then a model id — the remainder, slashes included so real
 * multi-segment ids parse, but never a leading `/` — with an optional
 * `#variant` bound to the tail.
 */
const SPEC_RE = /^([\w.-]+)\/(?!\/)([\w.:/-]+)(?:#([\w.-]+))?$/

/**
 * Parses model specs into an agent→spec map, in canonical order. A bare spec
 * (no `<name>=` prefix) seeds all six agents; `name=` seeds exactly one; the
 * last spec to name an agent wins. Pure: no filesystem, no spawn.
 * @param {string[]} specs The raw --model spec strings (possibly empty).
 * @returns {Record<string, string>} Map of agent name to spec.
 * @throws {Error} On an unknown agent name (lists the six) or a malformed spec
 *   (shows the grammar).
 */
function parseModelSpecs(specs) {
  const result = {}
  for (const spec of specs) {
    if (typeof spec !== "string")
      throw new Error(`invalid --model spec "${spec}"; expected ${SPEC_GRAMMAR}`)
    const eq = spec.indexOf("=")
    let name = null
    let body = spec
    if (eq !== -1) {
      name = spec.slice(0, eq)
      body = spec.slice(eq + 1)
      if (!AGENT_NAMES.includes(name))
        throw new Error(
          `unknown agent "${name}" in --model spec; expected one of ${AGENT_NAMES.join(", ")}`,
        )
    }
    if (!body.match(SPEC_RE))
      throw new Error(`invalid --model spec "${spec}"; expected ${SPEC_GRAMMAR}`)
    const targets = name ? [name] : AGENT_NAMES
    for (const agent of targets) result[agent] = body
  }
  return result
}

/**
 * Formats an agent→spec map into a JSON `{"agents": {...}}` snippet, one entry
 * per agent in canonical order. Unset agents fall back to a placeholder so the
 * output is always a complete, paste-ready block. Pure.
 * @param {Record<string, string>} specs Map of agent name to spec.
 * @returns {string} The two-space-indented JSON snippet.
 */
function formatModelConfig(specs) {
  const agents = {}
  for (const agent of AGENT_NAMES) {
    agents[agent] = specs[agent] ?? MODEL_PLACEHOLDER
  }
  return JSON.stringify({ agents }, null, 2)
}

/**
 * Finds the concrete specs a user actually named that are not present in
 * `available` (the parsed lines of `opencode models`). Placeholder specs and
 * agents the user never named are skipped — only seeded, concrete models are
 * checked. A `#variant` suffix is stripped before matching (host model lists
 * the base id) but the spec is reported as named on a miss. Pure: no spawn.
 * @param {Record<string, string>} specs Map of agent name to spec.
 * @param {string[]} available Model identifiers as listed by `opencode models`.
 * @returns {string[]} The named-but-unknown specs, in canonical agent order.
 */
function findMissingModels(specs, available) {
  const availableSet = new Set(available)
  const missing = []
  for (const agent of AGENT_NAMES) {
    const spec = specs[agent]
    if (!spec || spec === MODEL_PLACEHOLDER) continue
    if (!availableSet.has(spec.split("#")[0])) missing.push(spec)
  }
  return missing
}

/**
 * The command runner used by --validate. A thin seam around `spawnSync` so
 * tests can inject canned `opencode models` output via setCommandRunner
 * (ESM named imports are read-only, so the runner is overridden through the
 * setter, not by reassigning the import).
 */
let commandRunner = (command, args, options) => spawnSync(command, args, options)

/**
 * Overrides the --validate command runner (see commandRunner).
 * @param {(command: string, args: string[], options?: object) => {stdout?: string}} fn New runner.
 * @returns {void}
 */
function setCommandRunner(fn) {
  commandRunner = fn
}

/**
 * Lists the model identifiers the host knows about, by running
 * `opencode models` through the injectable commandRunner seam. Lines are
 * split on newlines for `findMissingModels`. A failed spawn throws
 * `could not run opencode models (<reason>)` rather than reporting every spec
 * as unknown; `main` consumes that error and returns false (mapped to exit 1),
 * so this tested path never calls process.exit directly.
 * @returns {Promise<string[]>} The available model identifiers.
 * @throws {Error} When the spawn fails, naming it so `main` can report it.
 */
async function availableModels() {
  const res = commandRunner("opencode", ["models"], { encoding: "utf8" })
  if (res.error || res.status !== 0) {
    // A failed spawn must not masquerade as "every spec is unknown"; report it
    // and stop. This runs through the injectable commandRunner seam, so tests
    // can drive the branch without a live host `opencode models`.
    const reason = res.error?.message ?? `exit code ${res.status}`
    throw new Error(`could not run opencode models (${reason})`)
  }
  return (res.stdout ?? "").split(/\r?\n/)
}

/**
 * Auto-detects the install mode from the filesystem: a git checkout links
 * (working tree is the source of truth, edits are live); an extracted
 * package copies (installed files are the source of truth).
 * @returns {"link"|"copy"} The detected mode.
 */
function detectMode() {
  return existsSync(join(repoRoot, ".git")) ? "link" : "copy"
}

/**
 * Resolves the install mode by precedence: an explicit CLI flag wins, then
 * the manifest's "mode" field, then filesystem auto-detect. A manifest
 * mode outside {"link","copy"} is ignored (with a warning) rather than
 * silently degrading to link behavior.
 * @param {"link"|"copy"|null} modeOverride Mode from the command line, if any.
 * @param {"link"|"copy"|undefined} manifestMode The manifest's "mode" field, if any.
 * @returns {"link"|"copy"} The resolved mode.
 */
function resolveMode(modeOverride, manifestMode) {
  if (manifestMode !== undefined && manifestMode !== "link" && manifestMode !== "copy") {
    console.warn(`install: ignoring unknown manifest mode "${manifestMode}"`)
    return modeOverride ?? detectMode()
  }
  return modeOverride ?? manifestMode ?? detectMode()
}

/**
 * Expands a manifest entry whose source is a directory into one entry per
 * file beneath it, recursively and in sorted order (stable output across
 * platforms). A file or missing source passes through untouched: the
 * existing inspect path reports it as `invalid`.
 * @param {{src: string, dest: string}} entry Entry with paths already joined/expanded.
 * @returns {Array<{src: string, dest: string}>} One entry per installed file.
 */
function flattenEntry(entry) {
  if (!existsSync(entry.src) || !statSync(entry.src).isDirectory()) return [entry]
  const dir = entry.src
  const files = readdirSync(dir, { recursive: true, encoding: "utf8" })
    .filter((rel) => statSync(join(dir, rel)).isFile())
    .sort()
  // An existing-but-empty directory yields no files; keep the original entry
  // (rather than dropping it) so the inspect path reports it as a missing
  // source instead of the entry silently vanishing from the manifest.
  if (!files.length) return [entry]
  return files.map((rel) => ({ src: join(dir, rel), dest: join(entry.dest, rel) }))
}

/**
 * Applies `flattenEntry` across all manifest sources, keeping entry order.
 * @param {Array<{src: string, dest: string}>} entries Already-resolved entries.
 * @returns {Array<{src: string, dest: string}>} Flattened entries.
 */
function flattenLinks(entries) {
  return entries.flatMap(flattenEntry)
}

/**
 * Reads and validates the install manifest. Directory link sources are
 * flattened to one entry per file so the per-file inspect/ledger/uninstall
 * machinery applies unchanged; `verify` lists installed entry points that
 * check/apply load-probe after the per-entry pass.
 * @param {string} file Path to install.json.
 * @param {"link"|"copy"|null} modeOverride Mode from the command line, if any.
 * @returns {{mode: "link"|"copy", ledgerPath: string, links: Array<{src: string, dest: string}>, retired: string[], verify: string[]}} Validated manifest.
 */
function readManifest(file, modeOverride) {
  const raw = JSON.parse(readFileSync(file, "utf8"))
  const mode = resolveMode(modeOverride, raw.mode)
  const links = flattenLinks(
    (raw.links ?? []).map((entry) => ({
      src: join(repoRoot, entry.src),
      dest: expand(entry.dest),
    })),
  )
  const retired = (raw.retired ?? []).map((entry) => expand(entry.dest ?? entry))
  const verify = (raw.verify ?? []).map(expand)
  if (!links.length && !retired.length)
    throw new Error(`manifest declares nothing to install: ${file}`)
  return { mode, ledgerPath: expand(raw.ledger ?? defaultLedger), links, retired, verify }
}

/**
 * Expands a leading ~ in a destination path.
 * @param {string} path Destination path, possibly ~-prefixed.
 * @returns {string} Absolute path.
 */
function expand(path) {
  if (path === "~") return homedir()
  if (path.startsWith("~/")) return join(homedir(), path.slice(2))
  return resolve(path)
}

/**
 * Computes the content hash used by the copy-mode ledger.
 * @param {string} content File content.
 * @returns {string} SHA-256 hex digest.
 */
function hashContent(content) {
  return createHash("sha256").update(content).digest("hex")
}

/**
 * Normalizes one ledger entry to the current shape: missing `version`
 * defaults to `null`, missing `mode` defaults to `"copy"` (the legacy
 * copy-mode layout). Path transforms are intentionally skipped:
 * `relative(repoRoot, src)` already equals the manifest-relative string for
 * every recorded entry. Pure: no filesystem access.
 * @param {Record<string, unknown>} ledger Raw ledger keyed by destination.
 * @returns {Record<string, {src: string, hash: string, version: string | null, mode: "link" | "copy"}>} Normalized ledger.
 */
function normalizeLedger(ledger) {
  const normalized = {}
  for (const [dest, record] of Object.entries(ledger)) {
    normalized[dest] = {
      src: record.src,
      hash: record.hash,
      version: record.version ?? null,
      mode: record.mode ?? "copy",
    }
  }
  return normalized
}

/**
 * Loads the copy-mode ownership ledger, normalizing legacy entries on read.
 * An absent ledger is an empty record; the written form stays normalized,
 * so `saveLedger` persists the migration permanently. An unparseable ledger
 * fails loudly with the file path and a delete-or-repair instruction:
 * silently falling back to an empty record would strand ledger-owned copies
 * as untracked, which `removeEntry` then refuses to remove.
 * @param {string} file Ledger path.
 * @returns {Record<string, {src: string, hash: string, version: string | null, mode: "link" | "copy"}>} Ledger keyed by destination.
 * @throws {Error} When the ledger exists but is not valid JSON.
 */
function loadLedger(file) {
  if (!existsSync(file)) return {}
  const content = readFileSync(file, "utf8")
  let parsed
  try {
    parsed = JSON.parse(content)
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    throw new Error(
      `ledger at ${file} is not valid JSON (${reason}). Delete or repair it — the file is ${file} — then re-run.`,
      { cause: error },
    )
  }
  return normalizeLedger(parsed)
}

/**
 * Persists the ownership ledger, creating parent directories as needed.
 * @param {string} file Ledger path.
 * @param {Record<string, {src: string, hash: string, version: string | null, mode: "link" | "copy"}>} ledger Ledger to write.
 * @returns {void}
 */
function saveLedger(file, ledger) {
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, `${JSON.stringify(ledger, null, 2)}\n`)
}

/**
 * Resolves what sits at a destination path without following symlinks.
 * @param {string} dest Destination path.
 * @returns {Promise<"missing"|"link"|"file"|"other">} The kind of entry present.
 */
async function kindAt(dest) {
  try {
    const st = await lstatP(dest)
    if (st.isSymbolicLink()) return "link"
    if (st.isFile()) return "file"
    return "other"
  } catch {
    return "missing"
  }
}

/**
 * Returns a symlink's resolved target, or null when unavailable.
 * @param {string} dest Destination path.
 * @returns {Promise<string|null>} Resolved link target or null.
 */
async function linkTarget(dest) {
  try {
    return await realpathP(dest)
  } catch {
    return null
  }
}

/**
 * Decides whether a resolved path belongs to this checkout.
 * @param {string|null} resolved Absolute resolved path or null.
 * @returns {boolean} True when the path is inside the repo root.
 */
function ownedByRepo(resolved) {
  if (!resolved) return false
  const rel = relative(repoRoot, resolved)
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel)
}

/**
 * True when a manifest entry's source cannot be installed as a single file:
 * it is absent, or it is a directory that flattened to nothing (an empty
 * directory source is reported like a missing source rather than installed as
 * a directory). The two inspect paths share this guard so a directory source
 * is classified identically in link and copy mode.
 * @param {{src: string}} entry Manifest entry.
 * @returns {boolean} Whether the source is unusable for a file install.
 */
function sourceNotInstallable(entry) {
  return !existsSync(entry.src) || statSync(entry.src).isDirectory()
}

/**
 * Computes the drift of a symlink entry against the desired state.
 * @param {{src: string, dest: string}} entry Manifest link entry.
 * @returns {Promise<{code: "ok"|"stale"|"conflict"|"missing"|"invalid", detail?: string}>} Drift report.
 */
async function inspectLink(entry) {
  if (sourceNotInstallable(entry))
    return { code: "invalid", detail: `source missing: ${entry.src}` }
  const kind = await kindAt(entry.dest)
  if (kind === "missing") return { code: "missing" }
  if (kind === "link") {
    const target = await linkTarget(entry.dest)
    if (target === entry.src) return { code: "ok" }
    if (!ownedByRepo(target))
      return { code: "conflict", detail: `symlink points outside the repo: ${target}` }
    return { code: "stale", detail: target }
  }
  if (kind === "file") {
    const same = readFileSync(entry.dest, "utf8") === readFileSync(entry.src, "utf8")
    if (same) return { code: "missing" }
    return { code: "conflict", detail: "real file differs from repo source" }
  }
  return { code: "conflict", detail: `${kind} exists at destination` }
}

/**
 * Computes the drift of a copy entry against the desired state and ledger.
 * A copied file that no longer matches its last-installed hash is treated
 * as user-edited: the repo wins only via --force.
 * @param {{src: string, dest: string}} entry Manifest link entry.
 * @param {Record<string, {src: string, hash: string, version: string | null, mode: "link" | "copy"}>} ledger Ownership ledger.
 * @returns {{code: "ok"|"adopt"|"stale"|"conflict"|"missing"|"invalid", detail?: string}} Drift report.
 */
function inspectCopy(entry, ledger) {
  if (sourceNotInstallable(entry))
    return { code: "invalid", detail: `source missing: ${entry.src}` }
  if (!existsSync(entry.dest)) return { code: "missing" }
  const srcContent = readFileSync(entry.src, "utf8")
  const record = ledger[entry.dest]
  try {
    const destContent = readFileSync(entry.dest, "utf8")
    if (destContent === srcContent) return record ? { code: "ok" } : { code: "adopt" }
    if (!record) return { code: "conflict", detail: "untracked real file differs from repo source" }
    if (hashContent(destContent) !== record.hash) {
      return { code: "conflict", detail: "installed copy was edited after install" }
    }
    return { code: "stale" }
  } catch {
    return { code: "conflict", detail: "destination is not a readable file" }
  }
}

/**
 * Computes the drift of one manifest entry under the resolved mode.
 * @param {{src: string, dest: string}} entry Manifest link entry.
 * @param {"link"|"copy"} mode Install mode.
 * @param {Record<string, {src: string, hash: string, version: string | null, mode: "link" | "copy"}>} ledger Ownership ledger.
 * @returns {Promise<{code: string, detail?: string}>} Drift report.
 */
async function inspectEntry(entry, mode, ledger) {
  return mode === "copy" ? inspectCopy(entry, ledger) : inspectLink(entry)
}

/**
 * Decides whether a drift code is repairable by `--repair` without prompting.
 * Link mode reports `missing`/`stale`; `inspectCopy` only returns `stale` for
 * a ledger-recorded match, so the same predicate covers both modes. A
 * `conflict` is deliberately excluded: repairing it would back up user files,
 * which `--repair` must never do unprompted (that path stays gated behind
 * `--force`).
 * @param {string} code Drift code from `inspectEntry`.
 * @returns {boolean} True when `--repair` would fix it.
 */
function isRepairable(code) {
  return code === "missing" || code === "stale"
}

/**
 * Backs up a real file by renaming it aside with a timestamp suffix.
 * @param {string} dest Destination path to back up.
 * @returns {Promise<string>} The backup path.
 */
async function backup(dest) {
  const stamp = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14)
  const target = `${dest}.bak.${stamp}`
  await renameP(dest, target)
  return target
}

/**
 * Installs one entry as a symlink.
 * @param {{src: string, dest: string}} entry Manifest link entry.
 * @param {{force: boolean}} args Parsed arguments.
 * @param {Record<string, {src: string, hash: string, version: string | null, mode: "link" | "copy"}>} ledger Ownership ledger (link installs prune their entry).
 * @returns {Promise<{acted: boolean, note?: string}>} Whether a change was made.
 */
async function installLink(entry, args, ledger) {
  const report = await inspectLink(entry)
  if (report.code === "invalid") throw new Error(`install: ${entry.dest} — ${report.detail}`)
  if (report.code === "ok") {
    delete ledger[entry.dest]
    return { acted: false }
  }
  if (report.code === "conflict" && !args.force) {
    throw new Error(
      `install: ${entry.dest} — conflict (${report.detail}). Re-run with --force to back it up and replace, after reviewing.`,
    )
  }
  mkdirSync(dirname(entry.dest), { recursive: true })
  let note
  if (report.code === "conflict") {
    const saved = await backup(entry.dest)
    note = `backed up to ${saved}`
  }
  await unlinkP(entry.dest).catch(() => {})
  await symlinkP(entry.src, entry.dest)
  delete ledger[entry.dest]
  return { acted: true, note }
}

/**
 * Refreshes a stale version stamp on a content-identical copy record and
 * returns the previously recorded version, or undefined when no refresh
 * applies. Called from `installCopy` when the destination already matches
 * the package source: without this the `check` outdated warning (driven by
 * `record.version !== version`) would nag forever after a release whose
 * installed files are byte-identical, because no re-copy ever rewrites the
 * stamp. Mutates `ledger` in place. Pure filesystem-free.
 * @param {Record<string, {src: string, hash: string, version: string | null, mode: "link" | "copy"}>} ledger Ownership ledger, mutated on refresh.
 * @param {string} dest Destination key of the record to refresh.
 * @param {string} version Current package version to stamp in.
 * @returns {string | null | undefined} The replaced version (`null` when the
 *   record had none, i.e. a legacy unset stamp), or `undefined` when no
 *   refresh applies — call sites must treat `undefined` as the no-op
 *   sentinel and must not collapse it with the legacy-`null` case.
 */
function refreshVersionStamp(ledger, dest, version) {
  const record = ledger[dest]
  if (!record || record.version === version) return undefined
  const previous = record.version
  record.version = version
  return previous
}

/**
 * Formats the `version stamp updated` report line shared by apply and repair.
 * @param {string} dest Destination whose stamp was refreshed.
 * @param {string | null} previous The replaced version, or null when the record had none.
 * @returns {string} e.g. `install: version stamp updated <dest> (was 0.6.1, now 0.7.0)`.
 */
function stampUpdatedLine(dest, previous) {
  return `install: version stamp updated ${dest} (was ${previous ?? "unset"}, now ${pkgVersion})`
}

/**
 * Installs one entry as a copy, recording ownership in the ledger. A
 * content-identical destination with a stale version stamp updates the
 * stamp in place (no file write) and reports the previous version via
 * `refreshed`.
 * @param {{src: string, dest: string}} entry Manifest link entry.
 * @param {{force: boolean}} args Parsed arguments.
 * @param {Record<string, {src: string, hash: string, version: string | null, mode: "link" | "copy"}>} ledger Ownership ledger, mutated on success.
 * @param {string} version Current package version, recorded for the `check` stale report.
 * @param {"link"|"copy"} mode Install mode this record was written under.
 * @returns {Promise<{acted: boolean, note?: string, refreshed?: string | null}>} Whether a change was made; `refreshed` carries the replaced version stamp (`null` for a legacy unset stamp) when a content-identical run refreshed it.
 */
async function installCopy(entry, args, ledger, version, mode) {
  const report = inspectCopy(entry, ledger)
  if (report.code === "invalid") throw new Error(`install: ${entry.dest} — ${report.detail}`)
  if (report.code === "ok") {
    const previous = refreshVersionStamp(ledger, entry.dest, version)
    return previous === undefined ? { acted: false } : { acted: false, refreshed: previous }
  }
  if (report.code === "conflict" && !args.force) {
    throw new Error(
      `install: ${entry.dest} — conflict (${report.detail}). Re-run with --force to back it up and replace, after reviewing.`,
    )
  }
  mkdirSync(dirname(entry.dest), { recursive: true })
  let note
  if (report.code === "conflict") {
    const saved = await backup(entry.dest)
    note = `backed up to ${saved}`
  }
  await unlinkP(entry.dest).catch(() => {})
  await copyFileP(entry.src, entry.dest)
  ledger[entry.dest] = {
    src: relative(repoRoot, entry.src),
    hash: hashContent(readFileSync(entry.src, "utf8")),
    version,
    mode,
  }
  return { acted: true, note }
}

/**
 * Removes a path when it is repo-owned: a symlink resolving into the
 * checkout, or a copied file recorded in the ledger. Unowned files (a
 * symlink pointing outside the repo, or an untracked file) are never touched;
 * they are reported as left alone. Retired leftovers are handled by calling
 * this with the retired destination.
 * @param {string} dest Destination path.
 * @param {{write: boolean}} mode Write when true, report-only otherwise.
 * @param {Record<string, {src: string, hash: string, version: string | null, mode: "link" | "copy"}>} ledger Ownership ledger.
 * @returns {Promise<{acted: boolean, note?: string}>} Whether a change was (or would be) made.
 */
async function removeEntry(dest, mode, ledger) {
  const kind = await kindAt(dest)
  if (kind === "missing") return { acted: false }
  if (kind === "link") {
    const target = await linkTarget(dest)
    if (!ownedByRepo(target)) return { acted: false, note: `symlink not repo-owned (${target})` }
    if (!mode.write) return { acted: true, note: "link still present" }
    await unlinkP(dest)
    return { acted: true }
  }
  if (kind === "file") {
    if (!ledger[dest]) return { acted: false, note: "untracked file left alone" }
    if (!mode.write) return { acted: true, note: "copy still present" }
    await unlinkP(dest)
    delete ledger[dest]
    return { acted: true }
  }
  return { acted: false, note: `left alone (${kind})` }
}

/**
 * Runs the installer in apply mode and prints a per-target report. In
 * uninstall mode it removes repo-owned links / ledger-owned copies for every
 * manifest entry (reporting unowned ones as failures) before retiring
 * leftovers — and skips the `verify` probe, since the graph is intentionally
 * gone; otherwise it installs as configured and load-probes every `verify`
 * path after the links pass, printing `install: loadable <file>` /
 * `install: unloadable <file> — <reason>` (the latter failing the run), so
 * an install that shipped an unresolvable import graph exits non-zero.
 * Tracks whether any change was made so the caller can gate the "restart
 * OpenCode sessions" note.
 * @param {{mode: "link"|"copy", ledgerPath: string, links: Array<{src: string, dest: string}>, retired: string[], verify: string[]}} manifest Validated manifest.
 * @param {{check: boolean, force: boolean, uninstall: boolean, mode: "link"|"copy"|null}} args Parsed arguments.
 * @returns {Promise<{ok: boolean, changed: boolean}>} Success flag and whether anything changed.
 */
async function apply(manifest, args) {
  const ledger = loadLedger(manifest.ledgerPath)
  let ok = true
  let changed = false

  if (args.uninstall) {
    for (const entry of manifest.links) {
      try {
        const result = await removeEntry(entry.dest, { write: true }, ledger)
        if (result.acted) {
          changed = true
          console.log(`install: removed ${entry.dest}`)
        } else if (result.note) {
          // Could not remove something that was left alone (unowned / conflict).
          ok = false
          console.log(`install: could not remove ${entry.dest} — ${result.note}`)
        } else console.log(`install: up to date ${entry.dest}`)
      } catch (error) {
        ok = false
        console.error(String(error.message ?? error))
      }
    }
    for (const dest of manifest.retired) {
      try {
        const result = await removeEntry(dest, { write: true }, ledger)
        if (result.acted) {
          changed = true
          console.log(`install: removed retired ${dest}`)
        } else if (result.note) {
          console.log(`install: retired ${dest} — ${result.note}`)
        }
      } catch (error) {
        ok = false
        console.error(String(error.message ?? error))
      }
    }
    saveLedger(manifest.ledgerPath, ledger)
    return { ok, changed }
  }

  for (const entry of manifest.links) {
    try {
      const result =
        manifest.mode === "copy"
          ? await installCopy(entry, args, ledger, pkgVersion, manifest.mode)
          : await installLink(entry, args, ledger)
      if (result.acted) {
        changed = true
        console.log(
          `install: ${manifest.mode} ${entry.dest}${result.note ? ` (${result.note})` : ""}`,
        )
      } else if (result.refreshed !== undefined)
        console.log(stampUpdatedLine(entry.dest, result.refreshed))
      else console.log(`install: up to date ${entry.dest}`)
    } catch (error) {
      ok = false
      console.error(String(error.message ?? error))
    }
  }
  if (!(await reportVerifyProbes(manifest.verify, "install", true))) ok = false
  for (const dest of manifest.retired) {
    const result = await removeEntry(dest, { write: true }, ledger)
    if (result.acted) {
      changed = true
      console.log(`install: removed retired ${dest}`)
    } else if (result.note) {
      console.log(`install: retired ${dest} — ${result.note}`)
    }
  }
  saveLedger(manifest.ledgerPath, ledger)
  return { ok, changed }
}

/**
 * Repairs repairable drift across every manifest entry, relinking `missing`
 * /`stale` link-mode entries and re-copying `missing`/ledger-`stale` copy-mode
 * entries via the same `installLink`/`installCopy` path `apply()` uses.
 * `conflict` stays gated behind `--force`: `--repair` must never back up user
 * files unprompted, so a conflict left without `--force` is reported as
 * unrepairable and fails. After the links pass it load-probes every `verify`
 * path with the same fatal block as apply: a graph that will not load is
 * exactly what `--repair` should refuse to report success for. Runs in apply
 * mode; the `--check --repair` dry run is handled by `check()`.
 * @param {{mode: "link"|"copy", ledgerPath: string, links: Array<{src: string, dest: string}>, retired: string[], verify: string[]}} manifest Validated manifest.
 * @param {{force: boolean, repair: boolean}} args Parsed arguments.
 * @returns {Promise<{ok: boolean, changed: boolean}>} Success flag and whether anything changed.
 */
async function repair(manifest, args) {
  const ledger = loadLedger(manifest.ledgerPath)
  let ok = true
  let changed = false

  for (const entry of manifest.links) {
    const report = await inspectEntry(entry, manifest.mode, ledger)
    if (report.code === "ok") {
      const previous =
        manifest.mode === "copy" ? refreshVersionStamp(ledger, entry.dest, pkgVersion) : undefined
      if (previous === undefined) {
        console.log(`install: up to date ${entry.dest}`)
        continue
      }
      console.log(stampUpdatedLine(entry.dest, previous))
      continue
    }
    // Conflict without --force, or an invalid (missing-source) entry, can not
    // be repaired here: neither would back up user files or invent a source.
    if (!isRepairable(report.code) && !args.force) {
      ok = false
      console.error(
        `install: ${entry.dest} — ${report.code}${
          report.detail ? `: ${report.detail}` : ""
        } (unrepairable; rerun with --force for conflicts)`,
      )
      continue
    }
    try {
      const result =
        manifest.mode === "copy"
          ? await installCopy(entry, args, ledger, pkgVersion, manifest.mode)
          : await installLink(entry, args, ledger)
      if (result.acted) {
        changed = true
        console.log(`install: repair ${entry.dest} (${report.code})`)
      } else if (result.refreshed !== undefined)
        console.log(stampUpdatedLine(entry.dest, result.refreshed))
      else console.log(`install: up to date ${entry.dest}`)
    } catch (error) {
      ok = false
      console.error(String(error.message ?? error))
    }
  }
  if (!(await reportVerifyProbes(manifest.verify, "install", true))) ok = false
  saveLedger(manifest.ledgerPath, ledger)
  return { ok, changed }
}

/**
 * Loads an installed entry point the way the host does: a child Node with
 * erasable-TypeScript stripping enabled dynamically imports it, so the
 * whole (transitive) import graph must resolve. Spawned, never in-process
 * — the probe must not warm or pollute the installer's own module graph.
 * @param {string} file Absolute path of the entry point to load.
 * @returns {Promise<{ok: boolean, reason: string}>} Outcome; `reason` is the child's first stderr line (or a spawn/timeout summary).
 */
async function probeLoad(file) {
  const url = pathToFileURL(file).href
  const code = `await import(${JSON.stringify(url)}).catch((error) => { console.error(error.message); process.exit(1) })`
  const res = spawnSync(
    process.execPath,
    ["--experimental-strip-types", "--input-type=module", "-e", code],
    { encoding: "utf8", timeout: 30_000 },
  )
  if (res.error) return { ok: false, reason: `probe spawn failed (${res.error.message})` }
  if (res.status === 0) return { ok: true, reason: "" }
  return { ok: false, reason: firstErrorLine(res.stderr, res.status) }
}

/**
 * Extracts the first real error line from a child loader's stderr, skipping
 * Node's own warning lines (e.g. the type-stripping ExperimentalWarning,
 * which leads the stream on Node versions where stripping still warns).
 * Those warnings are not the load error, so the reported reason stays on the
 * actual failure rather than a warning the engine prints on startup.
 * @param {string | undefined} stderr The child's stderr.
 * @param {number | null} status The child's exit status, used for the fallback.
 * @returns {string} The first non-warning line, or an exit-code summary.
 */
function firstErrorLine(stderr, status) {
  const line = (stderr ?? "")
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l !== "" && !l.startsWith("(node:") && !l.includes("ExperimentalWarning"))
  return line ?? `loader exited with code ${status}`
}

/**
 * Runs the load probe over every verify path, printing one line per path —
 * `<prefix>: loadable <file>` on success and `<prefix>: unloadable <file> —
 * <reason>` on failure — and returns whether every path loaded. A failure is
 * reported to stderr and clears the result when `fatal` is set (apply and
 * repair both pass `true`: an install or repair that left an unresolvable
 * import graph must fail the run), otherwise it is informative on stdout.
 * @param {string[]} files The verify paths to load-probe.
 * @param {string} prefix The verb prefix for the report lines (`install`).
 * @param {boolean} fatal Whether an unloadable path fails the run.
 * @returns {Promise<boolean>} True when every path loaded.
 */
async function reportVerifyProbes(files, prefix, fatal) {
  let pass = true
  for (const file of files) {
    const probe = await probeLoad(file)
    if (probe.ok) {
      console.log(`${prefix}: loadable ${file}`)
    } else {
      const line = `${prefix}: unloadable ${file} — ${probe.reason}`
      if (fatal) {
        pass = false
        console.error(line)
      } else console.log(line)
    }
  }
  return pass
}

/**
 * True when the text references the destination path as a whole path segment
 * (the destination itself, or a file located beneath it), not as a prefix of
 * a sibling path (e.g. `/a/b` inside `/a/bc`). A boundary is a path
 * separator, whitespace, a quote, or a string edge.
 * @param {string} text The text to search (a loader error reason).
 * @param {string} dest The installed destination path to look for.
 * @returns {boolean} Whether the text references the destination as a path.
 */
function pathReferenced(text, dest) {
  const boundary = (ch) => ch === "" || ch === "/" || ch === " " || ch === "'" || ch === '"'
  let from = 0
  for (;;) {
    const idx = text.indexOf(dest, from)
    if (idx === -1) return false
    const before = idx > 0 ? text[idx - 1] : ""
    const after = idx + dest.length < text.length ? text[idx + dest.length] : ""
    if (boundary(before) && boundary(after)) return true
    from = idx + 1
  }
}

/**
 * Resolves symlinks in the part of a path that exists, leaving a missing tail
 * intact, so the result matches the canonical form Node reports in a
 * module-not-found error (on macOS, /var resolves to /private/var). A path
 * with no existing prefix is returned unchanged.
 * @param {string} path The path to canonicalize.
 * @returns {string} The canonical path, or the input when it cannot be resolved.
 */
function canonicalizePath(path) {
  let dir = path
  const tail = []
  while (!existsSync(dir) && dir !== dirname(dir)) {
    tail.unshift(basename(dir))
    dir = dirname(dir)
  }
  let root
  try {
    root = realpathSync(dir)
  } catch {
    return path
  }
  return tail.length ? join(root, ...tail) : root
}

/**
 * Decides whether a verify probe failure is plausibly caused by drift that
 * `--repair` would fix, so the `--check --repair` dry run can report it as
 * non-fatal (annotated `would be loadable after repair`) instead of failing.
 * A failure is attributed to repairable drift only when the loader's reason
 * names a path a repairable entry would restore (its dest, or a file beneath
 * it); a broken graph whose missing module is unrelated to any repairable
 * entry still fails the check. Each dest is matched both as given and in its
 * symlink-resolved form so the comparison is immune to path symlinks (e.g.
 * macOS /var -> /private/var).
 * @param {string} reason The probe's loader error reason.
 * @param {string[]} repairableDests Destinations of entries `--repair` would fix.
 * @returns {boolean} Whether the failure is attributable to repairable drift.
 */
function reasonCausedByRepairable(reason, repairableDests) {
  return repairableDests.some((dest) => {
    const canonical = canonicalizePath(dest)
    return pathReferenced(reason, dest) || pathReferenced(reason, canonical)
  })
}

/**
 * Reports per-entry drift for the check pass. In repair mode, repairable
 * drift (`missing`/`stale`) is reported as `would repair` (and its dest
 * collected so a verify failure can be attributed to drift `--repair` would
 * fix); every other drift fails the check. The version-drift warning shown
 * here is cleared by apply/repair runs that refresh the stamp on a
 * content-identical destination.
 * @param {Array<{src: string, dest: string}>} links Manifest link entries.
 * @param {"link"|"copy"} mode Install mode.
 * @param {Record<string, {src: string, hash: string, version: string | null, mode: "link" | "copy"}>} ledger Ownership ledger.
 * @param {string} version Current package version.
 * @param {boolean} repairMode When true, report repairable drift as `would repair`.
 * @returns {Promise<{ok: boolean, repairableDests: string[]}>} Whether the pass failed the check, and the dests of repairable entries.
 */
async function reportEntryDrift(links, mode, ledger, version, repairMode) {
  let ok = true
  const repairableDests = []
  for (const entry of links) {
    if (!existsSync(entry.src)) {
      ok = false
      console.error(`check: source missing: ${entry.src} (referenced by ${entry.dest})`)
      continue
    }
    const report = await inspectEntry(entry, mode, ledger)
    const record = ledger[entry.dest]
    if (record && record.version && record.version !== version)
      console.log(`check: outdated ${entry.dest} (installed ${record.version}, package ${version})`)
    if (report.code === "ok") console.log(`check: OK ${entry.dest}`)
    else if (repairMode && isRepairable(report.code)) {
      repairableDests.push(entry.dest)
      console.log(`install: would repair ${entry.dest} (${report.code})`)
    } else {
      ok = false
      console.error(
        `check: ${report.code} ${entry.dest}${report.detail ? ` — ${report.detail}` : ""}`,
      )
    }
  }
  return { ok, repairableDests }
}

/**
 * Runs the installer in check mode: reports drift, writes nothing.
 * A ledger record whose version is older than the current package version
 * is reported as a warning and does not fail the check. The stamp is
 * refreshed by apply and repair runs on a content-identical destination,
 * so the warning clears on the next `install` instead of nagging forever.
 * After the per-entry
 * pass, every `verify` path is load-probed in both modes: `check: loadable
 * <file>` on a resolving import graph, `check: unloadable <file> — <reason>`
 * (stderr) otherwise, which fails the check. When `repairMode` is set
 * (`--check --repair`), repairable drift (`missing`/`stale`) is reported as
 * `would repair` instead of an error and does not fail the check (the entry
 * is going to be fixed); unrepairable drift still fails as before. A `verify`
 * failure in repair mode is non-fatal (stdout, annotated `would be loadable
 * after repair`) only when the loader's reason names a path a repairable
 * entry would restore; a broken graph unrelated to repairable drift is still
 * fatal. The per-entry drift pass is identical in both modes — only the
 * `verify` probe's repair-mode handling differs.
 * @param {{mode: "link"|"copy", ledgerPath: string, links: Array<{src: string, dest: string}>, retired: string[], verify: string[]}} manifest Validated manifest.
 * @param {string} version Current package version.
 * @param {boolean} [repairMode] When true, report repairable drift as `would repair` rather than failing.
 * @returns {Promise<boolean>} True when no unrepairable drift was found.
 */
async function check(manifest, version, repairMode = false) {
  const ledger = loadLedger(manifest.ledgerPath)
  const { ok: driftOk, repairableDests } = await reportEntryDrift(
    manifest.links,
    manifest.mode,
    ledger,
    version,
    repairMode,
  )
  let ok = driftOk
  for (const file of manifest.verify) {
    const probe = await probeLoad(file)
    if (probe.ok) console.log(`check: loadable ${file}`)
    else if (repairMode && reasonCausedByRepairable(probe.reason, repairableDests))
      console.log(`check: unloadable ${file} — ${probe.reason} (would be loadable after repair)`)
    else {
      ok = false
      console.error(`check: unloadable ${file} — ${probe.reason}`)
    }
  }
  for (const dest of manifest.retired) {
    const result = await removeEntry(dest, { write: false }, ledger)
    if (result.acted) {
      ok = false
      console.error(`check: retired link still present: ${dest}`)
    } else console.log(`check: OK ${dest}${result.note ? ` — ${result.note}` : ""}`)
  }
  return ok
}

async function main(argv = process.argv) {
  const args = parseArgs(argv)

  // --print-model-config writes nothing: it parses the requested specs,
  // optionally validates them against `opencode models`, prints a ready-to
  // paste snippet, and returns. This short-circuits before the manifest is
  // even read (like --check), so no link/copy target or ledger entry is
  // touched.
  if (args.printModelConfig) {
    if (args.validate) {
      let available
      try {
        available = await availableModels()
      } catch (error) {
        console.error(`install: ${error instanceof Error ? error.message : String(error)}`)
        return false
      }
      const missing = findMissingModels(args.modelSpecs, available)
      if (missing.length) {
        for (const model of missing) console.error(`validate: unknown model ${model}`)
        return false
      }
    }
    console.log(formatModelConfig(args.modelSpecs))
    return true
  }

  const manifest = readManifest(args.manifest, args.mode)
  console.log(
    `install: mode=${manifest.mode} (${manifest.mode === "link" ? "checkout" : "package"})`,
  )
  if (args.check) return await check(manifest, pkgVersion, args.repair)
  if (args.repair) {
    const { ok, changed } = await repair(manifest, args)
    if (changed) console.log("restart OpenCode sessions to pick up changes.")
    return ok
  }
  const { ok, changed } = await apply(manifest, args)
  if (changed) console.log("restart OpenCode sessions to pick up changes.")
  return ok
}

// Run as a script only when invoked directly; importing the module (e.g. for
// unit tests) must not execute the installer or call process.exit.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main()
    .then((ok) => process.exit(ok ? 0 : 1))
    .catch((error) => {
      console.error(`install: ${error instanceof Error ? error.message : String(error)}`)
      process.exit(1)
    })
}

// Pure, side-effect-free helpers exported for unit tests: tests can
// import these directly without spawning the CLI. `setCommandRunner` is the
// seam for faking the `opencode models` spawn (ESM named imports are
// read-only, so the runner is overridden through this setter); `main` is
// exported so the write-free print/validate path can be driven in-process
// with a fake runner (no child spawn, no process.exit in the tested path).
export {
  detectMode,
  resolveMode,
  normalizeLedger,
  removeEntry,
  parseModelSpecs,
  formatModelConfig,
  findMissingModels,
  setCommandRunner,
  main,
}
