#!/usr/bin/env node
// Read-only query surface for the decision-provenance ledger (`prov:*`
// journal rows).
//
// This is the `turnstile prov` surface: it renders the journaled human
// decision events — `prov:stated` (captured prompts, redacted at write
// time), `prov:denied` (human permission denials), and `prov:waiver`
// (human gate waivers; the row shape exists, wiring is post-MVP) —
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
//   opencode-turnstile prov --help      This usage. Unknown flags exit 2.

import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"

const USAGE = `Usage: opencode-turnstile prov [sessionID] [--json] [--tail <n>]

Prints the decision-provenance ledger: the journaled human decision events
(prompts stated, permission denials, gate waivers) for one session, or for
every session when no sessionID is given. Read-only: nothing is written.

Options:
  --json      Print the raw journal rows as JSON instead of the rendered lines
  --tail <n>  Bound the output to the last <n> prov rows (default: the
              configured replayTailLines)
  --help      Show this help`

/**
 * Host session-ID alphabet, length-capped. Standalone-script copy of the
 * canonical constant in src/journal-sinks.ts (this script cannot import TS
 * source; src/ledger.ts re-imports the same constant).
 */
const REPLAY_SESSION_RE = /^[A-Za-z0-9._-]{1,64}$/

/** The default replay tail bound (lines); mirrors the runtime config default. */
const DEFAULT_REPLAY_TAIL_LINES = 2000

/** Render bound for `prov:stated` text so one long prompt cannot blow out a row. */
const STATED_RENDER_CAP = 120

/**
 * Resolves the default metrics directory (standalone copy of the journaler
 * default; honors an absolute XDG_DATA_HOME or HOME).
 * @param {Record<string, string | undefined>} env Environment to consult.
 * @returns {string} The absolute default metrics directory.
 */
function defaultMetricsDir(env) {
  const abs = (v) => (typeof v === "string" && path.isAbsolute(v) ? v : undefined)
  const home = abs(env.HOME) ?? os.homedir()
  const base = abs(env.XDG_DATA_HOME) ?? path.join(home, ".local/share")
  return path.join(base, "opencode", "metrics")
}

/**
 * Reads and parses the config file the config layer uses, silently tolerating
 * a missing or malformed file (fail-open). Standalone copy of log.mjs's
 * loader (this script cannot import TS source).
 * @param {NodeJS.ProcessEnv} env The process environment.
 * @returns {Record<string, unknown> | null} The parsed config object, or null.
 */
function loadConfigFile(env) {
  const configPath =
    env.TURNSTILE_CONFIG ?? path.join(os.homedir(), ".config", "opencode", "turnstile.json")
  try {
    const cfg = JSON.parse(fs.readFileSync(configPath, "utf8"))
    return cfg && typeof cfg === "object" && !Array.isArray(cfg) ? cfg : null
  } catch {
    return null // missing/unreadable/malformed config: fall through to the default.
  }
}

/**
 * Validates a configured or flagged tail bound. Only a finite positive
 * integer is accepted; anything else falls back to the default.
 * @param {unknown} value The raw tail value.
 * @returns {number} The validated tail bound.
 */
function resolveReplayTailLines(value) {
  return Number.isInteger(value) && value > 0 ? value : DEFAULT_REPLAY_TAIL_LINES
}

/**
 * Resolves the metrics directory and tail bound (precedence env → file →
 * default, mirroring config.ts). Standalone copy of log.mjs's resolver,
 * without the reviewer key the timeline fold needs.
 * @param {NodeJS.ProcessEnv} env The process environment.
 * @param {number | null} tailFlag The `--tail` override, or null.
 * @returns {{ metricsDir: string, tailLines: number }} The resolved values.
 */
function resolveConfig(env, tailFlag) {
  const config = loadConfigFile(env)
  const envDir =
    typeof env.TURNSTILE_METRICS_DIR === "string" && env.TURNSTILE_METRICS_DIR
      ? env.TURNSTILE_METRICS_DIR
      : ""
  const fileDir =
    config && typeof config.metricsDir === "string" && config.metricsDir ? config.metricsDir : ""
  return {
    metricsDir: envDir || fileDir || defaultMetricsDir(env),
    tailLines: tailFlag ?? resolveReplayTailLines(config?.replayTailLines),
  }
}

/**
 * Parses the prov arguments. Recognizes one optional positional sessionID,
 * --json, --tail <n>, and --help; anything else is unknown and fails with
 * exit code 2 (log parity).
 * @param {string[]} argv Arguments after the `prov` subcommand.
 * @returns {{ sessionID: string, json: boolean, tail: number | null, help: boolean }}
 *     Parsed arguments; `tail` is null when the flag is absent.
 */
function parseArgs(argv) {
  const out = { sessionID: "", json: false, tail: null, help: false }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === "--json") out.json = true
    else if (a === "--help") out.help = true
    else if (a === "--tail") out.tail = parseTailValue(argv[++i])
    else if (a.startsWith("--")) throw new Error(`unknown argument "${a}"`)
    else if (out.sessionID === "") out.sessionID = a
    else throw new Error(`unexpected extra argument "${a}"`)
  }
  return out
}

/**
 * Parses the `--tail` value. A missing or non-positive-integer value is a
 * usage error (exit 2), unlike the config-file path which silently falls
 * back — an explicit flag is a deliberate request.
 * @param {string | undefined} raw The raw flag value.
 * @returns {number} The validated tail bound.
 */
function parseTailValue(raw) {
  const n = Number(raw)
  if (raw === undefined || !Number.isInteger(n) || n <= 0) {
    throw new Error(`--tail expects a positive integer, got "${raw ?? ""}"`)
  }
  return n
}

/**
 * Validates a positional session ID against the host session-ID shape.
 * @param {string} id The raw positional argument.
 * @returns {string} The validated ID.
 */
function requireSessionShape(id) {
  if (!REPLAY_SESSION_RE.test(id)) throw new Error(`unknown or malformed session id "${id}"`)
  return id
}

/**
 * Reads one journal file family (current file plus rotated generations) as
 * oldest-first blocks: a newest-first walk stopping at the first missing
 * generation, silently tolerating missing files. Standalone copy of
 * log.mjs's reader (this script cannot import TS source).
 * @param {string} file Absolute path of the current journal file.
 * @param {number} tailLines The per-file tail bound in lines to keep.
 * @returns {{ name: string, lines: string[] }[]} The blocks, oldest-first.
 */
function readFileGenerations(file, tailLines) {
  const blocks = []
  let generation = fs.existsSync(file) ? 0 : 1
  for (;;) {
    const gen = generation === 0 ? file : `${file}.${generation}`
    if (!fs.existsSync(gen)) break
    blocks.unshift({
      name: path.basename(gen),
      lines: fs.readFileSync(gen, "utf8").split("\n").filter(Boolean),
    })
    if (blocks.reduce((total, b) => total + b.lines.length, 0) >= tailLines) break
    generation++
  }
  return blocks
}

/**
 * Extracts a lexicographic sort key from a journal line's `ts` field; a
 * missing or unparseable `ts` sorts oldest. Standalone copy of log.mjs's
 * key function.
 * @param {string} line A raw JSONL journal line.
 * @returns {string} The sort key.
 */
function tsKey(line) {
  try {
    const ts = JSON.parse(line).ts
    return typeof ts === "string" && !Number.isNaN(Date.parse(ts)) ? ts : ""
  } catch {
    return ""
  }
}

/**
 * Parses one journal line into an entry, or null when malformed or not a
 * plain object (fail-open, log parity).
 * @param {string} line A raw JSONL journal line.
 * @returns {Record<string, unknown> | null} The parsed entry, or null.
 */
function parseLine(line) {
  try {
    const e = JSON.parse(line)
    return e && typeof e === "object" && !Array.isArray(e) ? e : null
  } catch {
    return null
  }
}

/**
 * Lists every per-session sink family in the sessions directory (current
 * files only; their rotated generations are walked by readFileGenerations).
 * Fail-open: a missing or unreadable sessions directory yields nothing.
 * @param {string} metricsDir The metrics directory.
 * @returns {string[]} Absolute paths of the current per-session files.
 */
function sessionSinkPaths(metricsDir) {
  try {
    return fs
      .readdirSync(path.join(metricsDir, "sessions"))
      .filter((name) => /\.jsonl$/.test(name) && !/\.jsonl\.\d+$/.test(name))
      .sort()
      .map((name) => path.join(metricsDir, "sessions", name))
  } catch {
    return [] // no sessions dir (legacy layout) or unreadable: shared file only
  }
}

/**
 * Reads the `prov:*` lines for one explicit session: its per-session sink
 * family plus the shared file filtered to that session. Fail-open:
 * unreadable files contribute nothing.
 * @param {string} metricsDir The metrics directory.
 * @param {string} sessionID The requested session ID.
 * @param {number} tailLines The tail bound in lines.
 * @returns {{ files: string[], lines: string[] }} The files read
 *     (oldest-first basenames) and the raw matching lines.
 */
function readSessionProvLines(metricsDir, sessionID, tailLines) {
  const sessionBlocks = readFileGenerations(
    path.join(metricsDir, "sessions", `${sessionID}.jsonl`),
    tailLines,
  )
  const sharedBlocks = readFileGenerations(path.join(metricsDir, "turnstile.jsonl"), tailLines)
  const sharedLines = sharedBlocks
    .flatMap((b) => b.lines)
    .filter((line) => {
      const e = parseLine(line)
      return e !== null && e.sessionID === sessionID
    })
  return {
    files: [...sessionBlocks, ...sharedBlocks].map((b) => b.name),
    lines: [...sessionBlocks.flatMap((b) => b.lines), ...sharedLines],
  }
}

/**
 * Reads the `prov:*` lines across every per-session sink plus the shared
 * file (the no-sessionID walk). Fail-open: unreadable files contribute
 * nothing.
 * @param {string} metricsDir The metrics directory.
 * @param {number} tailLines The tail bound in lines.
 * @returns {{ files: string[], lines: string[] }} The files read
 *     (oldest-first basenames) and the raw matching lines.
 */
function readAllProvLines(metricsDir, tailLines) {
  const files = []
  const lines = []
  for (const sink of sessionSinkPaths(metricsDir)) {
    const blocks = readFileGenerations(sink, tailLines)
    files.push(...blocks.map((b) => b.name))
    lines.push(...blocks.flatMap((b) => b.lines))
  }
  const sharedBlocks = readFileGenerations(path.join(metricsDir, "turnstile.jsonl"), tailLines)
  files.push(...sharedBlocks.map((b) => b.name))
  lines.push(...sharedBlocks.flatMap((b) => b.lines))
  return { files, lines }
}

/**
 * Dedupes raw journal lines that appear in more than one sink. A `prov:*` row
 * is parent-keyed into `sessions/<id>.jsonl` while `journalPerSession` routing
 * is active but may also exist in the shared `turnstile.jsonl` (routing
 * changed mid-session, or a legacy `journalPerSession:false` layout), so a
 * row identity present in both sinks must render once. Identity is the row's
 * full JSON text — journal writes are append-only and unmodified, so two
 * copies of one row serialize identically, while two genuinely distinct
 * events never do.
 * @param {string[]} lines Raw journal lines from all walked sinks.
 * @returns {string[]} The lines with cross-sink duplicates removed,
 *     first occurrence kept (sink order is oldest-generation first).
 */
function dedupeSinks(lines) {
  const seen = new Set()
  return lines.filter((line) => {
    if (seen.has(line)) return false
    seen.add(line)
    return true
  })
}

/**
 * Filters raw journal lines to `prov:*` rows, ts-orders them (missing or
 * unparseable sorts oldest), and keeps the tail bound.
 * @param {string[]} lines Raw JSONL journal lines from the walked sinks.
 * @param {number} tailLines The tail bound in prov rows.
 * @returns {Record<string, unknown>[]} The parsed prov entries, oldest-first.
 */
function provEntriesOf(lines, tailLines) {
  const prov = dedupeSinks(lines).filter((line) => {
    const e = parseLine(line)
    return e !== null && typeof e.type === "string" && e.type.startsWith("prov:")
  })
  prov.sort((a, b) => {
    const ka = tsKey(a)
    const kb = tsKey(b)
    return ka === kb ? 0 : ka < kb ? -1 : 1
  })
  return prov.slice(-tailLines).map(parseLine).filter(Boolean)
}

/**
 * Renders a timestamp as HH:MM:SS (UTC-less, verbatim from the ISO string;
 * an unparseable ts renders as `--:--:--`). Standalone copy of log.mjs's
 * renderer.
 * @param {unknown} ts The raw `ts` field.
 * @returns {string} The clock text.
 */
function clockOf(ts) {
  if (typeof ts !== "string" || Number.isNaN(Date.parse(ts))) return "--:--:--"
  return ts.slice(11, 19)
}

/**
 * Truncates one rendered field value to a bounded length so a long prompt
 * cannot blow out the ledger row. Standalone copy of log.mjs's helper.
 * @param {string} value The raw field value.
 * @param {number} max The maximum rendered length.
 * @returns {string} The value, ellipsized when over the bound.
 */
function truncateField(value, max) {
  return value.length <= max ? value : `${value.slice(0, max)}…`
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
 * Entry point. Parses args, walks the journal sinks, and prints the prov
 * rows. An empty ledger exits 0 with no output; usage errors exit 2.
 * @param {string[]} argv Arguments after the `prov` subcommand.
 * @returns {number} The process exit code.
 */
function main(argv) {
  let args
  try {
    args = parseArgs(argv)
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    process.stderr.write(`${msg}\n`)
    process.stderr.write("usage: opencode-turnstile prov [sessionID] [--json] [--tail <n>]\n")
    return 2
  }
  if (args.help) {
    process.stdout.write(`${USAGE}\n`)
    return 0
  }
  const read = resolveAndRead(args)
  if (typeof read === "number") return read
  emit(read.entries, args.json)
  return 0
}

process.exit(main(process.argv.slice(2)) ?? 0)
