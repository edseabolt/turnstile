#!/usr/bin/env node
// Installs the turnstile contract block into a global AGENTS.md file.
// Idempotent: only the sentinel-delimited managed block is written or
// replaced — surrounding personal content is preserved. (Agent definitions
// are installed as symlinks by scripts/install.mjs; this script no longer
// copies them.)
//
// Usage:
//   node scripts/install-agents.mjs [--file <path>] [--check]
//
//   --file   Target AGENTS.md (default: ~/.config/opencode/AGENTS.md)
//   --check  Exit 0 when the installed block matches the template, 1 when
//            it differs or is missing; nothing is written in check mode.

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const START = "<!-- turnstile:start"
const END = "<!-- turnstile:end -->"

const root = join(dirname(fileURLToPath(import.meta.url)), "..")
const templatePath = join(root, "templates", "global-AGENTS.md")

function parseArgs(argv) {
  const args = {
    file: join(homedir(), ".config/opencode/AGENTS.md"),
    check: false,
  }
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === "--file") args.file = argv[++i]
    else if (argv[i] === "--check") args.check = true
    else {
      console.error(`install-agents: unknown argument ${argv[i]}`)
      process.exit(2)
    }
  }
  return args
}

/**
 * Extracts the managed block (including sentinel markers) from the template.
 * @returns {string} The exact block to install.
 */
function readBlock() {
  const template = readFileSync(templatePath, "utf8")
  const start = template.indexOf(START)
  const end = template.indexOf(END)
  if (start === -1 || end === -1 || end < start) {
    throw new Error(`template is missing a complete managed block: ${templatePath}`)
  }
  return template.slice(start, end + END.length) + "\n"
}

/**
 * Replaces or inserts the managed block in the given file content.
 * @param {string} current Existing file content ("" when the file is new).
 * @param {string} block The managed block to write.
 * @returns {string} The new file content.
 */
function merge(current, block) {
  const start = current.indexOf(START)
  if (start === -1) {
    const separator = current.trim().length ? "\n\n" : ""
    return current.replace(/\n*$/, "\n") + separator + block
  }
  const end = current.indexOf(END, start)
  if (end === -1) {
    throw new Error(
      `${args.file}: found a start sentinel without an end sentinel — refusing to touch it; fix the file manually`,
    )
  }
  // The block ends with its own newline; strip one leading newline from
  // the suffix so an unchanged file stays byte-identical on rerun.
  const suffix = current.slice(end + END.length).replace(/^\n/, "")
  return current.slice(0, start) + block + suffix
}

/**
 * Detects turnstile contract content that lacks the sentinel markers.
 * Matches the section heading and the pipeline order chain — signatures
 * unlikely to appear in unrelated content. A blind install would append a
 * duplicate block alongside such content, so the installer refuses.
 * @param {string} content Existing file content.
 * @returns {boolean} True when unmanaged contract content is present.
 */
function hasUnmanagedContractContent(content) {
  if (content.includes(START)) return false
  return (
    /^#{1,3} .*turnstile/im.test(content) ||
    /planner\s*→\s*executor\s*→\s*test-runner/.test(content)
  )
}

/**
 * Returns the installed managed block from a file, or "" when absent.
 * @param {string} file Path to an AGENTS.md file.
 * @returns {string} The block including sentinel markers, or "".
 */
function installedBlock(file) {
  if (!existsSync(file)) return ""
  const current = readFileSync(file, "utf8")
  const start = current.indexOf(START)
  const end = current.indexOf(END)
  if (start === -1 || end === -1) return ""
  return current.slice(start, end + END.length) + "\n"
}

const args = parseArgs(process.argv)
const block = readBlock()
const current = existsSync(args.file) ? readFileSync(args.file, "utf8") : ""

if (hasUnmanagedContractContent(current)) {
  const reconcile =
    `Reconcile first: wrap the existing section with <!-- turnstile:start --> and ` +
    `<!-- turnstile:end --> (updating its content to match templates/global-AGENTS.md), ` +
    `or remove the stale section, then re-run.`
  if (args.check) {
    console.error(
      `check-agents: ${args.file} contains pipeline-gates content WITHOUT the sentinel markers — installing would append a duplicate block. ${reconcile}`,
    )
  } else {
    console.error(
      `install-agents: refusing to write ${args.file} — it contains pipeline-gates content WITHOUT the sentinel markers, so installing would create a duplicate block. ${reconcile}`,
    )
  }
  process.exit(1)
}

if (args.check) {
  const installed = installedBlock(args.file)
  if (installed === block) {
    console.log(`check-agents: OK (${args.file})`)
    process.exit(0)
  }
  console.error(
    `check-agents: managed block in ${args.file} differs from the template (missing or outdated)`,
  )
  process.exit(1)
}

const next = merge(current, block)
if (next === current) {
  console.log(`install-agents: already up to date (${args.file})`)
} else {
  mkdirSync(dirname(args.file), { recursive: true })
  writeFileSync(args.file, next)
  const verb = current.trim().length ? "updated managed block in" : "created"
  console.log(`install-agents: ${verb} ${args.file}`)
}
console.log("restart OpenCode sessions to pick up the change.")
