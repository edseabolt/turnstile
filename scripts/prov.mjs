#!/usr/bin/env node
// Read-only query surface for the decision-provenance ledger (`prov:*`
// journal rows).
//
// This is the `turnstile prov` surface: it renders the journaled human
// decision events — `prov:stated` (captured prompts, redacted at write
// time), `prov:denied` (human permission denials), `prov:waiver`
// (human gate waivers; the row shape exists, wiring is post-MVP), and
// `prov:override` (parent overrides of pipeline-child writes) —
// oldest-first. It never writes anything and never blocks. Like
// scripts/log.mjs it is a plain ESM script outside the 100% coverage gate
// (bin/ and scripts/ never are), exercised by tests/prov-cli.test.ts via
// spawn rather than imported.
//
// Sources: every per-session sink `sessions/<sessionID>.jsonl` (+ rotated
// generations) plus the shared `turnstile.jsonl` (+ generations). With an
// explicit sessionID the walk covers that session's sink and the shared
// journal filtered to it; without one, every session's `prov:*` rows are
// shown. Rows whose `type` does not start with `prov:` are dropped.
//
//   opencode-turnstile prov [sessionID] [--json] [--tail <n>]
//   opencode-turnstile prov --verify   Check the journal hash chain + anchors.
//   opencode-turnstile prov --help      This usage. Unknown flags exit 2.

import * as fs from "node:fs"
import * as path from "node:path"

import {
  clockOf,
  loadConfigFile,
  parseTailValue,
  provEntriesOf,
  readAllProvLines,
  readSessionProvLines,
  requireSessionShape,
  resolveConfig,
  truncateField,
} from "./journal-read.mjs"
import {
  absentAnchoredRefs,
  resolveAnchorSinks,
  verifyAnchors,
  verifyFamilies,
} from "./chain-read.mjs"

const USAGE = `Usage: opencode-turnstile prov [sessionID] [--json] [--tail <n>]
       opencode-turnstile prov --verify

Prints the decision-provenance ledger: the journaled human decision events
(prompts stated, permission denials, gate waivers, parent overrides of
pipeline-child writes) for one session, or for
every session when no sessionID is given. Read-only: nothing is written.

With --verify, instead checks the journal hash chain: every journal file
family folds across its rotation generations, each committed epoch's Merkle
root is re-derived, and the epoch refs are verified against the configured
anchor sinks. Exit 0 when the chain is intact and anchored; exit 1 on the
first broken link or any unanchored/mismatched ref; exit 2 on usage errors.

Options:
  --json      Print the raw journal rows as JSON instead of the rendered lines
  --tail <n>  Bound the output to the last <n> prov rows (default: the
              configured replayTailLines)
  --verify    Verify the journal hash chain and anchors instead of rendering
  --help      Show this help`

/** Render bound for `prov:stated` text so one long prompt cannot blow out a row. */
const STATED_RENDER_CAP = 120

/**
 * Parses the prov arguments. Recognizes one optional positional sessionID,
 * --json, --tail <n>, and --help; anything else is unknown and fails with
 * exit code 2 (log parity).
 * @param {string[]} argv Arguments after the `prov` subcommand.
 * @returns {{ sessionID: string, json: boolean, tail: number | null, help: boolean }}
 *     Parsed arguments; `tail` is null when the flag is absent.
 */
function parseArgs(argv) {
  const out = { sessionID: "", json: false, tail: null, help: false, verify: false }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === "--json") out.json = true
    else if (a === "--help") out.help = true
    else if (a === "--verify") out.verify = true
    else if (a === "--tail") out.tail = parseTailValue(argv[++i])
    else if (a.startsWith("--")) throw new Error(`unknown argument "${a}"`)
    else if (out.sessionID === "") out.sessionID = a
    else throw new Error(`unexpected extra argument "${a}"`)
  }
  if (out.verify && out.sessionID !== "") {
    throw new Error("--verify checks every session and cannot be combined with a sessionID")
  }
  return out
}

/**
 * Renders one `prov:stated` row: the redacted prompt text (write-time
 * redaction is the journal's job; this renders it verbatim, bounded), with
 * the truncation marker when the capture cap was applied.
 * @param {Record<string, unknown>} e The parsed entry.
 * @returns {string} The rendered line.
 */
function renderStated(e) {
  const text = typeof e.text === "string" ? e.text : "?"
  const marker = e.truncated === true ? " (truncated)" : ""
  return `stated  ${truncateField(text, STATED_RENDER_CAP)}${marker}`
}

/**
 * Renders one `prov:denied` row: the ask kind that was denied.
 * @param {Record<string, unknown>} e The parsed entry.
 * @returns {string} The rendered line.
 */
function renderDenied(e) {
  const kind = typeof e.kind === "string" ? e.kind : "?"
  return `denied  kind=${kind}`
}

/**
 * Renders one `prov:waiver` row: the gate stages the waiver's coverage
 * opened (the row shape exists; wiring is post-MVP, so this renders rows
 * that only a hand-seeded or future journal can carry).
 * @param {Record<string, unknown>} e The parsed entry.
 * @returns {string} The rendered line.
 */
function renderWaiver(e) {
  const stages = Array.isArray(e.stages) ? e.stages.map(String).join(",") : "?"
  return `waiver  stages=${stages}`
}

/**
 * Renders one `prov:override` row: the parent-side tool, the overridden
 * child session, and the (capped) target path.
 * @param {Record<string, unknown>} e The parsed entry.
 * @returns {string} The rendered line.
 */
function renderOverride(e) {
  const tool = typeof e.tool === "string" ? e.tool : "?"
  const child = typeof e.child === "string" ? e.child : "?"
  const path = typeof e.path === "string" ? e.path : "?"
  return `override  tool=${tool} child=${child} path=${truncateField(path, STATED_RENDER_CAP)}`
}

/**
 * Renders one prov entry to its ledger line; an unrecognized `prov:*` type
 * renders its raw type so future journal types never break the surface.
 * @param {Record<string, unknown>} e The parsed entry.
 * @returns {string} The rendered line.
 */
function renderProv(e) {
  const type = typeof e.type === "string" ? e.type : "?"
  if (type === "prov:stated") return renderStated(e)
  if (type === "prov:denied") return renderDenied(e)
  if (type === "prov:waiver") return renderWaiver(e)
  if (type === "prov:override") return renderOverride(e)
  return `${type}  (unrecognized)`
}

/**
 * Builds the rendered ledger rows: one line per prov entry, oldest-first.
 * @param {Record<string, unknown>[]} entries Parsed prov entries, oldest-first.
 * @returns {{ ts: string, text: string }[]} The rendered rows.
 */
function buildRows(entries) {
  return entries.map((e) => ({ ts: clockOf(e.ts), text: renderProv(e) }))
}

/**
 * Emits the output: the raw rows as JSON, or the rendered ledger lines.
 * Empty output prints nothing (exit 0 either way).
 * @param {Record<string, unknown>[]} entries The parsed prov entries, oldest-first.
 * @param {boolean} json Whether `--json` was requested.
 * @returns {void}
 */
function emit(entries, json) {
  if (entries.length === 0) return
  if (json) {
    process.stdout.write(`${JSON.stringify(entries, null, 2)}\n`)
  } else {
    const rows = buildRows(entries)
    process.stdout.write(`${rows.map((r) => `${r.ts}  ${r.text}`).join("\n")}\n`)
  }
}

/**
 * Resolves the config, walks the sinks, and filters to the prov rows (the
 * resolve-and-read step of `main`). A malformed explicit session ID writes
 * the error to stderr.
 * @param {{ sessionID: string, tail: number | null }} args The parsed args.
 * @returns {{ files: string[], entries: Record<string, unknown>[] } | number}
 *     The walked files with the prov entries, or the exit code to return
 *     when the session ID is malformed (2).
 */
function resolveAndRead(args) {
  const { metricsDir, tailLines } = resolveConfig(process.env, args.tail)
  if (args.sessionID !== "") {
    let sessionID
    try {
      sessionID = requireSessionShape(args.sessionID)
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      process.stderr.write(`${msg}\n`)
      return 2
    }
    const read = readSessionProvLines(metricsDir, sessionID, tailLines)
    return { files: read.files, entries: provEntriesOf(read.lines, tailLines) }
  }
  const read = readAllProvLines(metricsDir, tailLines)
  return { files: read.files, entries: provEntriesOf(read.lines, tailLines) }
}

/**
 * Reads the configured anchor selection from the config file (the
 * `tamperEvidence.anchor` key), defaulting to `session-state` — the same
 * default `defaultConfig()` uses.
 * @param {NodeJS.ProcessEnv} env The process environment.
 * @returns {string | object | Array<string | object>} The anchor selection.
 */
function anchorSelectionOf(env) {
  const config = loadConfigFile(env)
  const te =
    config && typeof config.tamperEvidence === "object" && config.tamperEvidence !== null
      ? config.tamperEvidence
      : {}
  return te.anchor ?? "session-state"
}

/**
 * Reads the journal rotation generation count from the config file (the
 * `journalMaxGenerations` key), defaulting to 5 — the same default
 * `defaultConfig()` uses. Verify must fold the same generations the
 * journaler wrote or an intact journal reports a broken link.
 * @param {NodeJS.ProcessEnv} env The process environment.
 * @returns {number} The configured generation count.
 */
function maxGenerationsOf(env) {
  const config = loadConfigFile(env)
  const gens = config?.journalMaxGenerations
  return Number.isInteger(gens) && gens > 0 ? gens : 5
}

/**
 * Reports the unanchored epoch refs (no sink vouches for them) to stdout.
 * @param {Array<{ ref: object, domain: string | null }>} weakest The
 *     weakest vouching domain per ref.
 * @param {Array<{ ref: object, sink: string, verdict: object }>} verdicts
 *     The per-sink verdicts.
 * @returns {number} 1 when at least one ref is unanchored, 0 otherwise.
 */
function reportUnanchored(weakest, verdicts) {
  const failed = weakest.filter((w) => w.domain === null)
  for (const f of failed) {
    const v = verdicts.find((x) => x.ref === f.ref && x.verdict.status !== "ok")
    const detail = v ? v.verdict.detail : "not anchored by any configured sink"
    process.stdout.write(`unanchored: ${f.ref.source}#${f.ref.epoch}: ${detail}\n`)
  }
  return failed.length > 0 ? 1 : 0
}

/**
 * Runs the `--verify` check: folds every journal family, then verifies the
 * collected epoch refs against the configured anchor sinks. Read-only.
 * @returns {Promise<number>} The exit code: 0 ok, 1 broken/unanchored.
 */
async function runVerify() {
  const { metricsDir } = resolveConfig(process.env, null)
  const report = verifyFamilies(metricsDir, maxGenerationsOf(process.env))
  const broken = report.families.find((f) => f.verdict.status === "broken")
  if (broken) {
    process.stdout.write(`chain broken at ${broken.verdict.detail}\n`)
    return 1
  }
  const { sinks, warnings } = await resolveAnchorSinks(anchorSelectionOf(process.env), {
    metricsDir,
    projectDir: process.cwd(),
  })
  for (const warning of warnings) process.stderr.write(`${warning}\n`)
  // Repo-domain sinks shell out to git in the process cwd; without a .git
  // there they can never anchor or verify — say so instead of failing silently.
  if (
    sinks.some((s) => s.trustDomain === "repo") &&
    !fs.existsSync(path.join(process.cwd(), ".git"))
  ) {
    process.stderr.write(
      `warning: repo-domain anchor sinks resolve against ${process.cwd()}, which has no .git\n`,
    )
  }
  const { verdicts, weakest } = await verifyAnchors(sinks, report.refs)
  if (reportUnanchored(weakest, verdicts) === 1) return 1
  const absent = absentAnchoredRefs(metricsDir, report.refs)
  if (absent.length > 0) {
    for (const d of absent) process.stdout.write(`${d}\n`)
    return 1
  }
  const domains = [...new Set(weakest.map((w) => w.domain))].join("+")
  const ids = [...new Set(verdicts.filter((v) => v.verdict.status === "ok").map((v) => v.sink))]
  const anchored =
    report.refs.length === 0 ? "nothing to anchor" : `anchored by ${domains} [${ids.join(", ")}]`
  process.stdout.write(
    `chain ok (${report.rows} rows, ${report.refs.length} epochs) · ${anchored}\n`,
  )
  return 0
}

/**
 * Entry point. Parses args, walks the journal sinks, and prints the prov
 * rows. An empty ledger exits 0 with no output; usage errors exit 2.
 * @param {string[]} argv Arguments after the `prov` subcommand.
 * @returns {number | Promise<number>} The process exit code.
 */
function main(argv) {
  let args
  try {
    args = parseArgs(argv)
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    process.stderr.write(`${msg}\n`)
    process.stderr.write(
      "usage: opencode-turnstile prov [sessionID] [--json] [--tail <n>] [--verify]\n",
    )
    return 2
  }
  if (args.help) {
    process.stdout.write(`${USAGE}\n`)
    return 0
  }
  if (args.verify) return runVerify()
  const read = resolveAndRead(args)
  if (typeof read === "number") return read
  emit(read.entries, args.json)
  return 0
}

process.exit((await main(process.argv.slice(2))) ?? 0)
