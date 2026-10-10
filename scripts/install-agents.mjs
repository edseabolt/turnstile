#!/usr/bin/env node
// Installs the turnstile contract block into a global AGENTS.md file.
// Idempotent: only the sentinel-delimited managed block is written or
// replaced — surrounding personal content is preserved. (Agent definitions
// are installed as symlinks by scripts/install.mjs; this script no longer
// copies them.)
//
// Usage:
//   node scripts/install-agents.mjs [--file <path>] [--check] [--remove] [--no-adopt]
//
//   --file     Target AGENTS.md (default: ~/.config/opencode/AGENTS.md)
//   --check    Report the adoption decision without writing; exit 0 only when
//              the managed block matches the template.
//   --remove   Delete the sentinel-delimited managed block (surrounding
//              content preserved); refuses a start-sentinel-without-end.
//              Idempotent — running on a file without the block is a no-op.
//   --no-adopt Refuse to replace a differing legacy section: print
//              reconciliation instructions and exit 1 instead of adopting.

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

const START = "<!-- turnstile:start"
const END = "<!-- turnstile:end -->"

const root = join(dirname(fileURLToPath(import.meta.url)), "..")
const templatePath = join(root, "templates", "global-AGENTS.md")

// Legacy pipeline-chain signature: the current pipeline order (planner →
// plan-reviewer → executor → test-runner → reviewer). It is one of two section
// locators; the other is a heading matching /turnstile/i.
const CHAIN_RE = /planner\s*→\s*plan-reviewer\s*→\s*executor\s*→\s*test-runner\s*→\s*reviewer/

// Distinct errors so the caller can tell "ambiguous (multiple sections)" apart
// from "corrupted (start sentinel without end sentinel)". Both exit 1 but with
// different advice.
class AmbiguousError extends Error {
  constructor(message) {
    super(message)
    this.name = "AmbiguousError"
    this.ambiguous = true
  }
}

class CorruptedError extends Error {
  constructor(message) {
    super(message)
    this.name = "CorruptedError"
    this.corrupted = true
  }
}

function parseArgs(argv) {
  const args = {
    file: join(homedir(), ".config/opencode/AGENTS.md"),
    check: false,
    remove: false,
    noAdopt: false,
  }
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === "--file") args.file = argv[++i]
    else if (argv[i] === "--check") args.check = true
    else if (argv[i] === "--remove") args.remove = true
    else if (argv[i] === "--no-adopt") args.noAdopt = true
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
 * The managed block minus its sentinel comment lines: the canonical inner
 * content that a legacy section is compared against for equivalence. The
 * start comment may span several lines; inner begins at the first "-->" that
 * closes it and ends at the end sentinel. Pure.
 * @param {string} block The full managed block (sentinels included).
 * @returns {string} The inner content between the sentinel comments.
 */
function templateInner(block) {
  const start = block.indexOf(START)
  const endCommentStart = block.lastIndexOf(END)
  const startCommentEnd = block.indexOf("-->", start) + "-->".length
  return block.slice(startCommentEnd, endCommentStart)
}

/**
 * Removes the sentinel-delimited managed block from the given file content,
 * preserving the surrounding content. When the block is absent this is a
 * no-op; a start sentinel without an end sentinel is refused (throw), the
 * same corruption guard `merge()` applies. Pure: no filesystem access.
 * @param {string} current Existing file content.
 * @param {string} [file] File label for the refusal message.
 * @returns {{removed: boolean, next: string}} Whether a block was found and the new content.
 */
function removeBlock(current, file) {
  const start = current.indexOf(START)
  if (start === -1) return { removed: false, next: current }
  const end = current.indexOf(END, start)
  if (end === -1) {
    throw new Error(
      `${file ?? "file"}: found a start sentinel without an end sentinel — refusing to touch it; fix the file manually`,
    )
  }
  const prefix = current.slice(0, start).replace(/\n*$/, "")
  const suffix = current.slice(end + END.length).replace(/^\n/, "")
  const next = prefix && suffix ? `${prefix}\n${suffix}` : suffix || (prefix ? `${prefix}\n` : "")
  return { removed: true, next }
}

/**
 * Replaces or inserts the managed block in the given file content.
 * @param {string} current Existing file content ("" when the file is new).
 * @param {string} block The managed block to write.
 * @param {string} [file] File label for the refusal message.
 * @returns {string} The new file content.
 */
function merge(current, block, file) {
  const start = current.indexOf(START)
  if (start === -1) {
    const separator = current.trim().length ? "\n\n" : ""
    return current.replace(/\n*$/, "\n") + separator + block
  }
  const end = current.indexOf(END, start)
  if (end === -1) {
    throw new Error(
      `${file ?? "file"}: found a start sentinel without an end sentinel — refusing to touch it; fix the file manually`,
    )
  }
  // The block ends with its own newline; strip one leading newline from
  // the suffix so an unchanged file stays byte-identical on rerun.
  const suffix = current.slice(end + END.length).replace(/^\n/, "")
  return current.slice(0, start) + block + suffix
}

/**
 * Splices the managed block into `content` at the given span, preserving
 * everything outside the span. Pure.
 * @param {string} content Existing file content.
 * @param {{start: number, end: number}} span The span to replace.
 * @param {string} block The managed block to insert.
 * @returns {string} The new content.
 */
function installBlock(content, span, block) {
  return content.slice(0, span.start) + block + content.slice(span.end)
}

/**
 * Locates a legacy (unmanaged) turnstile contract section in `content`.
 * Returns { start, end, level } spanning the section, or null when none is
 * present. Throws AmbiguousError when more than one section matches (the
 * caller distinguishes this from the corrupted case, which `merge()`/
 * `removeBlock()` refuse). Pure: no filesystem access.
 * @param {string} content Existing file content.
 * @returns {{start: number, end: number, level: number} | null} The section span, or null.
 */
function findLegacySection(content) {
  if (content.includes(START)) return null // a managed block is not "legacy"
  const headings = []
  for (const m of content.matchAll(/^#{1,3}\s+/gm)) {
    const start = m.index
    const lineEnd = content.indexOf("\n", start)
    const end = lineEnd === -1 ? content.length : lineEnd
    const level = m[0].match(/^#*/)[0].length
    headings.push({ start, end, level, text: content.slice(start, end) })
  }
  const candidates = []
  for (const h of headings) {
    // Span first (next heading of <= level), then probe inside it. Nested
    // turnstile-named subsections are excluded from the probe: their content
    // belongs to them, not to an enclosing higher-level heading — otherwise
    // a `# Title` above a turnstile section would swallow the chain and look
    // like a second section.
    let spanEnd = content.length
    for (const x of headings) {
      if (x.start > h.start && x.level <= h.level) {
        spanEnd = x.start
        break
      }
    }
    let probeText = content.slice(h.start, spanEnd)
    for (const x of headings) {
      if (x.start <= h.start || x.start >= spanEnd) continue
      if (!/turnstile/i.test(x.text)) continue
      let xEnd = content.length
      for (const y of headings) {
        if (y.start > x.start && y.level <= x.level) {
          xEnd = y.start
          break
        }
      }
      probeText = probeText.replace(content.slice(x.start, xEnd), "")
    }
    const isTurnstileHeading = /turnstile/i.test(h.text)
    const hasChain = CHAIN_RE.test(probeText)
    if (isTurnstileHeading || hasChain) candidates.push(h)
  }
  if (candidates.length === 0) return null
  if (candidates.length > 1) {
    throw new AmbiguousError(
      "found more than one turnstile contract section — ambiguous; reconcile manually.",
    )
  }
  const h = candidates[0]
  let end = content.length
  for (const x of headings) {
    if (x.start > h.start && x.level <= h.level) {
      end = x.start
      break
    }
  }
  return { start: h.start, end, level: h.level }
}

/**
 * Normalizes a section for equivalence comparison: drops turnstile sentinel
 * comment lines, collapses every whitespace run to a single space, and trims.
 * Two sections are "equivalent" when their normalizations match. Pure.
 * @param {string} text A section of content.
 * @returns {string} The normalized form.
 */
function normalizeForCompare(text) {
  return text
    .split("\n")
    .filter((line) => !line.trim().startsWith("<!-- turnstile:"))
    .join("\n")
    .replace(/\s+/g, " ")
    .trim()
}

/**
 * True when two contract sections carry the same content (modulo sentinel
 * comments and whitespace). Pure.
 * @param {string} a First section.
 * @param {string} b Second section.
 * @returns {boolean}
 */
function sectionsEquivalent(a, b) {
  return normalizeForCompare(a) === normalizeForCompare(b)
}

/**
 * Classifies the adoption decision for `content` against the managed `block`.
 * Pure. Returns one of:
 *   { decision: "ok" }               managed block present and matches the template
 *   { decision: "append" }           no block and no legacy section
 *   { decision: "adopt", span }      legacy section equivalent to the template
 *   { decision: "replace", span }    legacy section differs from the template
 *   { decision: "drift" }            managed block present but out of date
 * Throws AmbiguousError (multiple sections) or CorruptedError (start sentinel
 * without end sentinel); callers convert these to exit-1 refusals with
 * distinct advice.
 * @param {string} content Existing file content ("" when the file is new).
 * @param {string} block The managed block to install.
 * @returns {{decision: string, span?: {start: number, end: number}}}
 */
function analyze(content, block) {
  const start = content.indexOf(START)
  if (start !== -1) {
    const end = content.indexOf(END, start)
    if (end === -1) {
      throw new CorruptedError(
        `found a start sentinel without an end sentinel — refusing to touch it; fix the file manually`,
      )
    }
    const installed = content.slice(start, end + END.length) + "\n"
    return installed === block ? { decision: "ok" } : { decision: "drift" }
  }
  const span = findLegacySection(content)
  if (!span) return { decision: "append" }
  const section = content.slice(span.start, span.end)
  return sectionsEquivalent(section, templateInner(block))
    ? { decision: "adopt", span }
    : { decision: "replace", span }
}

/**
 * Resolves the write-path action for a classified analysis. Pure: mirrors
 * exactly what `main()` performs, so the --no-adopt refusal and the
 * adopt-vs-backup-replace choice are unit-testable without the filesystem.
 * @param {{decision: string, span?: {start: number, end: number}}} analysis Result of analyze().
 * @param {{noAdopt: boolean}} args Parsed arguments.
 * @returns {{action: "up-to-date"|"append"|"adopt"|"replace"|"resync"|"refuse"}} The action to take.
 */
function applyPlan(analysis, args) {
  switch (analysis.decision) {
    case "ok":
      return { action: "up-to-date" }
    case "append":
      return { action: args.noAdopt ? "refuse" : "append" }
    case "adopt":
      return { action: args.noAdopt ? "refuse" : "adopt" }
    case "replace":
      return args.noAdopt ? { action: "refuse" } : { action: "replace" }
    case "drift":
      return { action: args.noAdopt ? "refuse" : "resync" }
    default:
      throw new Error(`unknown adoption decision: ${analysis.decision}`)
  }
}

/**
 * Turns a classified analysis into the check-mode report line and its exit
 * code. Pure.
 * @param {{decision: string, span?: {start: number, end: number}}} analysis Result of analyze().
 * @param {string} file Target file label.
 * @returns {{message: string, code: number}}
 */
function checkReport(analysis, file) {
  switch (analysis.decision) {
    case "ok":
      return { message: `check-agents: OK (${file})`, code: 0 }
    case "append":
      return {
        message: `check-agents: drift: no managed contract block in ${file} — the contract block would be appended`,
        code: 1,
      }
    case "adopt":
      return {
        message:
          `check-agents: would-adopt-equivalent (${file}) — the existing turnstile section matches ` +
          `the template; adopting would wrap it with sentinels`,
        code: 1,
      }
    case "replace":
      return {
        message:
          `check-agents: would-replace (${file}) — the existing turnstile section differs from the ` +
          `template; adopting would back up and replace it`,
        code: 1,
      }
    case "drift":
      return {
        message: `check-agents: drift: the managed block in ${file} differs from the template`,
        code: 1,
      }
    default:
      throw new Error(`unknown adoption decision: ${analysis.decision}`)
  }
}

function reconcileAdvice() {
  return (
    "Reconcile first: wrap the existing section with <!-- turnstile:start --> and " +
    "<!-- turnstile:end --> (updating its content to match templates/global-AGENTS.md), " +
    "or remove the stale section, then re-run."
  )
}

function writeResult(file, next, verb) {
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, next)
  console.log(`install-agents: ${verb} ${file}`)
  console.log("restart OpenCode sessions to pick up the change.")
}

function main() {
  const args = parseArgs(process.argv)
  const block = readBlock()
  const current = existsSync(args.file) ? readFileSync(args.file, "utf8") : ""

  // --remove only deletes the managed block; it must not be blocked by the
  // adopt analysis (a corrupted file is refused inside removeBlock instead,
  // mirroring the chunk-3 contract).
  if (args.remove) {
    let result
    try {
      result = removeBlock(current, args.file)
    } catch (error) {
      console.error(`install-agents: ${error instanceof Error ? error.message : String(error)}`)
      process.exit(1)
    }
    if (!result.removed || result.next === current) {
      console.log(`install-agents: up to date (${args.file})`)
      process.exit(0)
    }
    writeResult(args.file, result.next, "removed managed block in")
    process.exit(0)
  }

  let analysis
  try {
    analysis = analyze(current, block)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (error instanceof AmbiguousError) {
      console.error(
        `install-agents: refusing to write ${args.file} — ${message} ${reconcileAdvice()}`,
      )
    } else {
      console.error(`install-agents: refusing to write ${args.file} — ${message}`)
    }
    process.exit(1)
  }

  if (args.check) {
    const { message, code } = checkReport(analysis, args.file)
    if (code === 0) console.log(message)
    else console.error(message)
    process.exit(code)
  }

  const plan = applyPlan(analysis, args)
  const code = performAction(plan, analysis, current, block, args.file)
  process.exit(code)
}

/**
 * Performs the chosen write action for a classified, non-check analysis and
 * returns the process exit code (0 = success, 1 = refusal). Single exit keeps
 * each branch a plain return rather than a fall-through.
 * @param {{action: string}} plan Result of applyPlan().
 * @param {{decision: string, span?: {start: number, end: number}}} analysis Result of analyze().
 * @param {string} current Existing file content.
 * @param {string} block The managed block to install.
 * @param {string} file Target file path.
 * @returns {number} The exit code.
 */
function performAction(plan, analysis, current, block, file) {
  switch (plan.action) {
    case "up-to-date":
      console.log(`install-agents: already up to date (${file})`)
      return 0
    case "refuse":
      console.error(
        `install-agents: refusing to write ${file} — --no-adopt is set and the target needs ` +
          `adoption or re-sync. ${reconcileAdvice()}`,
      )
      return 1
    case "append": {
      const next = merge(current, block, file)
      writeResult(file, next, current.trim().length ? "updated managed block in" : "created")
      return 0
    }
    case "adopt": {
      // Legacy section equivalent to the template: splice the block in place,
      // preserving the section's content and any surrounding content.
      const next = installBlock(current, analysis.span, block)
      writeResult(file, next, `adopted existing turnstile section in (wrapped with sentinels)`)
      return 0
    }
    case "replace": {
      // Legacy section differs: adopt-with-backup by default. The backup is
      // written first and guarded — a failed backup must not leave a
      // half-adopted file, and its loss must not crash with a stack trace.
      const stamp = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14)
      let backupPath = `${file}.bak.${stamp}`
      for (let n = 1; existsSync(backupPath); n++) backupPath = `${file}.bak.${stamp}-${n}`
      mkdirSync(dirname(file), { recursive: true })
      try {
        writeFileSync(backupPath, current)
      } catch (error) {
        console.error(
          `install-agents: could not write backup ${backupPath} — refusing to adopt ` +
            `(${error instanceof Error ? error.message : String(error)}); fix the file manually`,
        )
        return 1
      }
      const next = installBlock(current, analysis.span, block)
      writeResult(file, next, "replaced differing turnstile section in")
      console.log(`backup: ${backupPath}`)
      return 0
    }
    case "resync": {
      // The managed block is present but out of date; re-sync it in place
      // (no backup — it is turnstile's own managed content).
      const next = merge(current, block, file)
      writeResult(file, next, "updated managed block in")
      return 0
    }
  }
  return 0
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main()

// Pure, side-effect-free helpers exported for unit tests (chunk-5): tests can
// import these directly rather than spawning the CLI.
export {
  removeBlock,
  installBlock,
  findLegacySection,
  sectionsEquivalent,
  analyze,
  applyPlan,
  checkReport,
}
