#!/usr/bin/env node
// Installs this repo's artifacts into ~/.config/opencode, driven by
// install.json. The repo is the source of truth: symlink mode (default)
// links targets into the checkout so repo edits are live; copy mode
// duplicates files and records what it installed in a ledger file so later
// syncs can tell "repo changed" from "user edited".
//
// Usage:
//   node scripts/install.mjs [--manifest <path>] [--check] [--force]
//                            [--link | --copy]
//
//   --manifest     Manifest to install (default: install.json at the repo root)
//   --check        Verify all targets without writing; exit 1 on drift
//   --force        Convert conflicting targets after backing them up
//   --link/--copy  Override the manifest's "mode" (default: link)
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
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"

const symlinkP = promisify(symlink)
const unlinkP = promisify(unlink)
const renameP = promisify(rename)
const copyFileP = promisify(copyFile)
const lstatP = promisify(lstat)
const realpathP = promisify(realpath)

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..")
const defaultLedger = "~/.config/opencode/.turnstile-install.json"

/**
 * Parses command-line arguments.
 * @param {string[]} argv Raw argv (process.argv).
 * @returns {{manifest: string, check: boolean, force: boolean, mode: "link"|"copy"|null}} Parsed arguments.
 */
function parseArgs(argv) {
  const args = { manifest: join(repoRoot, "install.json"), check: false, force: false, mode: null }
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === "--manifest") args.manifest = argv[++i]
    else if (argv[i] === "--check") args.check = true
    else if (argv[i] === "--force") args.force = true
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
 * Reads and validates the install manifest.
 * @param {string} file Path to install.json.
 * @param {"link"|"copy"|null} modeOverride Mode from the command line, if any.
 * @returns {{mode: "link"|"copy", ledgerPath: string, links: Array<{src: string, dest: string}>, retired: string[]}} Validated manifest.
 */
function readManifest(file, modeOverride) {
  const raw = JSON.parse(readFileSync(file, "utf8"))
  const mode = modeOverride ?? (raw.mode === "copy" ? "copy" : "link")
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
 * Loads the copy-mode ownership ledger, or an empty record when absent.
 * @param {string} file Ledger path.
 * @returns {Record<string, {src: string, hash: string}>} Ledger keyed by destination.
 */
function loadLedger(file) {
  if (!existsSync(file)) return {}
  return JSON.parse(readFileSync(file, "utf8"))
}

/**
 * Persists the ownership ledger, creating parent directories as needed.
 * @param {string} file Ledger path.
 * @param {Record<string, {src: string, hash: string}>} ledger Ledger to write.
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
 * @param {Record<string, {src: string, hash: string}>} ledger Ownership ledger.
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
 * @param {Record<string, {src: string, hash: string}>} ledger Ownership ledger.
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
 * @param {Record<string, {src: string, hash: string}>} ledger Ownership ledger (link installs prune their entry).
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
 * @param {Record<string, {src: string, hash: string}>} ledger Ownership ledger, mutated on success.
 * @returns {Promise<{acted: boolean, note?: string}>} Whether a change was made.
 */
async function installCopy(entry, args, ledger) {
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
  }
  return { acted: true, note }
}

/**
 * Removes a retired path when it is repo-owned: a symlink resolving into
 * the checkout, or a copied file recorded in the ledger.
 * @param {string} dest Retired destination path.
 * @param {{write: boolean}} mode Write when true, report-only otherwise.
 * @param {Record<string, {src: string, hash: string}>} ledger Ownership ledger.
 * @returns {Promise<{acted: boolean, note?: string}>} Whether a change was (or would be) made.
 */
async function removeRetired(dest, mode, ledger) {
  const kind = await kindAt(dest)
  if (kind === "missing") return { acted: false }
  if (kind === "link") {
    const target = await linkTarget(dest)
    if (!ownedByRepo(target)) return { acted: false, note: `symlink not repo-owned (${target})` }
    if (!mode.write) return { acted: true, note: "retired link still present" }
    await unlinkP(dest)
    return { acted: true }
  }
  if (kind === "file") {
    if (!ledger[dest]) return { acted: false, note: "untracked file left alone" }
    if (!mode.write) return { acted: true, note: "retired copy still present" }
    delete ledger[dest]
    await unlinkP(dest)
    return { acted: true }
  }
  return { acted: false, note: `left alone (${kind})` }
}

/**
 * Runs the installer in apply mode and prints a per-target report.
 * @param {{mode: "link"|"copy", ledgerPath: string, links: Array<{src: string, dest: string}>, retired: string[]}} manifest Validated manifest.
 * @param {{check: boolean, force: boolean, mode: "link"|"copy"|null}} args Parsed arguments.
 * @returns {Promise<boolean>} True when every change succeeded.
 */
async function apply(manifest, args) {
  const ledger = loadLedger(manifest.ledgerPath)
  let ok = true
  for (const entry of manifest.links) {
    try {
      const result =
        manifest.mode === "copy"
          ? await installCopy(entry, args, ledger)
          : await installLink(entry, args, ledger)
      if (result.acted)
        console.log(
          `install: ${manifest.mode} ${entry.dest}${result.note ? ` (${result.note})` : ""}`,
        )
      else console.log(`install: up to date ${entry.dest}`)
    } catch (error) {
      ok = false
      console.error(String(error.message ?? error))
    }
  }
  for (const dest of manifest.retired) {
    const result = await removeRetired(dest, { write: true }, ledger)
    if (result.acted) console.log(`install: removed retired ${dest}`)
    else if (result.note) console.log(`install: retired ${dest} — ${result.note}`)
  }
  saveLedger(manifest.ledgerPath, ledger)
  return ok
}

/**
 * Runs the installer in check mode: reports drift, writes nothing.
 * @param {{mode: "link"|"copy", ledgerPath: string, links: Array<{src: string, dest: string}>, retired: string[]}} manifest Validated manifest.
 * @returns {Promise<boolean>} True when no drift was found.
 */
async function check(manifest) {
  const ledger = loadLedger(manifest.ledgerPath)
  let ok = true
  for (const entry of manifest.links) {
    if (!existsSync(entry.src)) {
      ok = false
      console.error(`check: source missing: ${entry.src} (referenced by ${entry.dest})`)
      continue
    }
    const report = await inspectEntry(entry, manifest.mode, ledger)
    if (report.code === "ok") console.log(`check: OK ${entry.dest}`)
    else {
      ok = false
      console.error(
        `check: ${report.code} ${entry.dest}${report.detail ? ` — ${report.detail}` : ""}`,
      )
    }
  }
  for (const dest of manifest.retired) {
    const result = await removeRetired(dest, { write: false }, ledger)
    if (result.acted) {
      ok = false
      console.error(`check: retired link still present: ${dest}`)
    } else console.log(`check: OK ${dest}${result.note ? ` — ${result.note}` : ""}`)
  }
  return ok
}

const args = parseArgs(process.argv)
const manifest = readManifest(args.manifest, args.mode)
const ok = args.check ? await check(manifest) : await apply(manifest, args)
if (!args.check) console.log("restart OpenCode sessions to pick up changes.")
process.exit(ok ? 0 : 1)
