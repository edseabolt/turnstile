#!/usr/bin/env node
// Installs this repo's artifacts into ~/.config/opencode, driven by
// install.json. The repo is the source of truth: symlink mode (auto-detected
// on a git checkout) links targets into the checkout so repo edits are live;
// copy mode duplicates files and records what it installed in a ledger file
// so later syncs can tell "repo changed" from "user edited".
//
// Usage:
//   node scripts/install.mjs [--manifest <path>] [--check] [--force]
//                            [--uninstall] [--link | --copy]
//
//   --manifest     Manifest to install (default: install.json at the repo root)
//   --check        Verify all targets without writing; exit 1 on drift
//   --force        Convert conflicting targets after backing them up
//   --uninstall    Reverse the manifest: remove repo-owned links / ledger-owned
//                  copies for every entry (then retire leftovers); exit 1 only
//                  when something could not be removed (conflict/unowned).
//   --link/--copy  Override the mode. Resolution: CLI flag > manifest "mode"
//                  field > auto-detect (.git present => link, else copy)
//
// Ownership model: symlink targets are repo-owned iff the link resolves
// inside this checkout; copied files are repo-owned iff the ledger records
// them. Unowned files are never read, modified, or removed. Conflicts
// (real files differing from the repo, or user-edited copies) fail with a
// summary unless --force converts them, backing up to <name>.bak.<ts>.

import {
  readFileSync,
  writeFileSync,
  existsSync,
  mkdirSync,
  symlink,
  unlink,
  rename,
  copyFile,
  lstat,
  realpath,
} from "node:fs"
import { createHash } from "node:crypto"
import { homedir } from "node:os"
import { dirname, isAbsolute, join, relative, resolve } from "node:path"
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
// ledger entry so `check` can report an outdated install (AC-4). Guarded:
// a missing or malformed package.json must not crash the module at import
// time (fail-open contract); version records as null and `check` treats
// null as "no version info" rather than an outdated install.
let pkgVersion = null
try {
  pkgVersion = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8")).version ?? null
} catch {
  // Fall through with null: metadata is advisory, not load-bearing.
}

/**
 * Parses command-line arguments.
 * @param {string[]} argv Raw argv (process.argv).
 * @returns {{manifest: string, check: boolean, force: boolean, uninstall: boolean, mode: "link"|"copy"|null}} Parsed arguments.
 */
function parseArgs(argv) {
  const args = {
    manifest: join(repoRoot, "install.json"),
    check: false,
    force: false,
    uninstall: false,
    mode: null,
  }
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === "--manifest") args.manifest = argv[++i]
    else if (argv[i] === "--check") args.check = true
    else if (argv[i] === "--force") args.force = true
    else if (argv[i] === "--uninstall") args.uninstall = true
    else if (argv[i] === "--link") args.mode = "link"
    else if (argv[i] === "--copy") args.mode = "copy"
    else {
      console.error(`install: unknown argument ${argv[i]}`)
      process.exit(2)
    }
  }
  return args
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
 * Reads and validates the install manifest.
 * @param {string} file Path to install.json.
 * @param {"link"|"copy"|null} modeOverride Mode from the command line, if any.
 * @returns {{mode: "link"|"copy", ledgerPath: string, links: Array<{src: string, dest: string}>, retired: string[]}} Validated manifest.
 */
function readManifest(file, modeOverride) {
  const raw = JSON.parse(readFileSync(file, "utf8"))
  const mode = resolveMode(modeOverride, raw.mode)
  const links = (raw.links ?? []).map((entry) => ({
    src: join(repoRoot, entry.src),
    dest: expand(entry.dest),
  }))
  const retired = (raw.retired ?? []).map((entry) => expand(entry.dest ?? entry))
  if (!links.length && !retired.length)
    throw new Error(`manifest declares nothing to install: ${file}`)
  return { mode, ledgerPath: expand(raw.ledger ?? defaultLedger), links, retired }
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
 * copy-mode layout). Path transforms are intentionally skipped —
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
 * so `saveLedger` persists the migration permanently.
 * @param {string} file Ledger path.
 * @returns {Record<string, {src: string, hash: string, version: string | null, mode: "link" | "copy"}>} Ledger keyed by destination.
 */
function loadLedger(file) {
  if (!existsSync(file)) return {}
  return normalizeLedger(JSON.parse(readFileSync(file, "utf8")))
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
 * Computes the drift of a symlink entry against the desired state.
 * @param {{src: string, dest: string}} entry Manifest link entry.
 * @returns {Promise<{code: "ok"|"stale"|"conflict"|"missing"|"invalid", detail?: string}>} Drift report.
 */
async function inspectLink(entry) {
  if (!existsSync(entry.src)) return { code: "invalid", detail: `source missing: ${entry.src}` }
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
  if (!existsSync(entry.src)) return { code: "invalid", detail: `source missing: ${entry.src}` }
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
 * Installs one entry as a copy, recording ownership in the ledger.
 * @param {{src: string, dest: string}} entry Manifest link entry.
 * @param {{force: boolean}} args Parsed arguments.
 * @param {Record<string, {src: string, hash: string, version: string | null, mode: "link" | "copy"}>} ledger Ownership ledger, mutated on success.
 * @param {string} version Current package version, recorded for the `check` stale report.
 * @param {"link"|"copy"} mode Install mode this record was written under.
 * @returns {Promise<{acted: boolean, note?: string}>} Whether a change was made.
 */
async function installCopy(entry, args, ledger, version, mode) {
  const report = inspectCopy(entry, ledger)
  if (report.code === "invalid") throw new Error(`install: ${entry.dest} — ${report.detail}`)
  if (report.code === "ok") return { acted: false }
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
 * leftovers; otherwise it installs as configured. Tracks whether any change
 * was made so the caller can gate the "restart OpenCode sessions" note.
 * @param {{mode: "link"|"copy", ledgerPath: string, links: Array<{src: string, dest: string}>, retired: string[]}} manifest Validated manifest.
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
      } else console.log(`install: up to date ${entry.dest}`)
    } catch (error) {
      ok = false
      console.error(String(error.message ?? error))
    }
  }
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
 * Runs the installer in check mode: reports drift, writes nothing.
 * A ledger record whose version is older than the current package version
 * is reported (AC-4) as a warning and does not fail the check.
 * @param {{mode: "link"|"copy", ledgerPath: string, links: Array<{src: string, dest: string}>, retired: string[]}} manifest Validated manifest.
 * @param {string} version Current package version.
 * @returns {Promise<boolean>} True when no drift was found.
 */
async function check(manifest, version) {
  const ledger = loadLedger(manifest.ledgerPath)
  let ok = true
  for (const entry of manifest.links) {
    if (!existsSync(entry.src)) {
      ok = false
      console.error(`check: source missing: ${entry.src} (referenced by ${entry.dest})`)
      continue
    }
    const report = await inspectEntry(entry, manifest.mode, ledger)
    const record = ledger[entry.dest]
    if (record && record.version && record.version !== version)
      console.log(`check: outdated ${entry.dest} (installed ${record.version}, package ${version})`)
    if (report.code === "ok") console.log(`check: OK ${entry.dest}`)
    else {
      ok = false
      console.error(
        `check: ${report.code} ${entry.dest}${report.detail ? ` — ${report.detail}` : ""}`,
      )
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

async function main() {
  const args = parseArgs(process.argv)
  const manifest = readManifest(args.manifest, args.mode)
  console.log(
    `install: mode=${manifest.mode} (${manifest.mode === "link" ? "checkout" : "package"})`,
  )
  if (args.check) return await check(manifest, pkgVersion)
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

// Pure, side-effect-free helpers exported for unit tests (chunk-4): tests can
// import these directly without spawning the CLI.
export { detectMode, resolveMode, normalizeLedger, removeEntry }
