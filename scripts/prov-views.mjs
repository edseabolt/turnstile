#!/usr/bin/env node
// Read-only derived views over the decision-provenance ledger (`prov:*`
// journal rows).
//
// This is the `turnstile prov-views` surface: the "derivation is smart" half
// of "capture is dumb, derivation is smart". It classifies `prov:stated`
// prompts by origin (direct instruction, pipeline chatter, waiver-carried
// directive), computes the chatter noise rate, and aggregates taste-drift
// signals (denied ask kinds, parent overrides of pipeline-child writes)
// across sessions and UTC days. Purely read-time: journal rows are never
// rewritten, and no derived value feeds gates or capture. Like scripts/prov.mjs
// it is a plain ESM script outside the 100% coverage gate (bin/ and scripts/
// never are), exercised by tests/prov-views.test.ts via spawn rather than
// imported.
//
// Sources: the same sink walk as `prov` — every per-session sink
// `sessions/<sessionID>.jsonl` (+ rotated generations) plus the shared
// `turnstile.jsonl` (+ generations); with an explicit sessionID the walk
// covers that session's sink and the shared journal filtered to it.
//
//   opencode-turnstile prov-views [sessionID] [--json] [--tail <n>]
//   opencode-turnstile prov-views --help   This usage. Unknown flags exit 2.

import { createHash } from "node:crypto"
import {
  loadConfigFile,
  parseTailValue,
  provEntriesOf,
  readAllProvLines,
  readSessionProvLines,
  requireSessionShape,
  resolveConfig,
} from "./journal-read.mjs"

const USAGE = `Usage: opencode-turnstile prov-views [sessionID] [--json] [--tail <n>]

Prints derived views over the decision-provenance ledger: origin labels for
the stated prompts (instruction, pipeline chatter, waiver-carried), the
chatter noise rate, and taste-drift aggregates over denials and overrides.
Read-time derivation only: journal rows are never rewritten, nothing is
written, and no derived value feeds gates or capture.

Options:
  --json      Print the views as one JSON document instead of the summary
  --tail <n>  Bound the row walk to the last <n> prov rows (default: the
              configured replayTailLines)
  --help      Show this help`

/**
 * Bounded length after trim for a stated text to qualify as chatter; a long
 * text containing an ack word is an instruction, not chatter.
 */
const CHATTER_MAX_LEN = 32

/**
 * Acknowledgement phrases treated as pipeline chatter (anchored, case-
 * insensitive, optional trailing punctuation/space run). Heuristic by
 * design: a mislabel only skews the noise-rate metric, never enforcement.
 */
const CHATTER_RE =
  /^(ok|okay|yes|yeah|no|continue|go|go ahead|proceed|thanks|thank you|done|ack|acknowledged|lgtm|ship it|looks good|sure|fine)[.!, ]*$/i

/**
 * Marker defaults; mirrors the runtime config defaults in src/config.ts
 * (scripts cannot import TS source). A config file's `waiverMarker` /
 * `approvalMarker` keys override these.
 */
const DEFAULT_WAIVER_MARKER = "USER WAIVER:"
const DEFAULT_APPROVAL_MARKER = "PLAN APPROVED:"

/** Display cap for the distinct overridden-path list in human output. */
const PATH_DISPLAY_CAP = 8

/**
 * Parses the prov-views arguments. Recognizes one optional positional
 * sessionID, --json, --tail <n>, and --help; anything else is unknown and
 * fails with exit code 2 (prov parity).
 * @param {string[]} argv Arguments after the `prov-views` subcommand.
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
 * Resolves the origin markers: the config file's `waiverMarker` /
 * `approvalMarker` values when set, the code defaults otherwise.
 * @param {NodeJS.ProcessEnv} env The process environment.
 * @returns {{ waiverMarker: string, approvalMarker: string }} The markers.
 */
function markersOf(env) {
  const config = loadConfigFile(env)
  const str = (v, fallback) => (typeof v === "string" && v ? v : fallback)
  return {
    waiverMarker: str(config?.waiverMarker, DEFAULT_WAIVER_MARKER),
    approvalMarker: str(config?.approvalMarker, DEFAULT_APPROVAL_MARKER),
  }
}

/**
 * Classifies one `prov:stated` row's origin. Waiver-carried wins (a waiver
 * or approval marker means the directive rode in on a waiver/approval
 * event), then the bounded chatter heuristic, then instruction.
 * @param {Record<string, unknown>} e The parsed stated row.
 * @param {{ waiverMarker: string, approvalMarker: string }} markers The origin markers.
 * @returns {"instruction" | "chatter" | "waiver-carried"} The origin label.
 */
function classifyOrigin(e, markers) {
  const text = typeof e.text === "string" ? e.text : ""
  if (text.includes(markers.waiverMarker) || text.includes(markers.approvalMarker)) {
    return "waiver-carried"
  }
  const trimmed = text.trim()
  if (trimmed.length <= CHATTER_MAX_LEN && CHATTER_RE.test(trimmed)) return "chatter"
  return "instruction"
}

/**
 * Computes the chatter noise rate over the origin counts: the fraction of
 * stated rows that are pure pipeline chatter (0 when nothing was stated).
 * @param {Record<string, number>} origins The origin counts.
 * @returns {{ stated: number, chatter: number, rate: number }} The metric.
 */
function noiseRate(origins) {
  const stated =
    (origins.instruction ?? 0) + (origins.chatter ?? 0) + (origins["waiver-carried"] ?? 0)
  const chatter = origins.chatter ?? 0
  return {
    stated,
    chatter,
    rate: stated === 0 ? 0 : Math.round((chatter / stated) * 10000) / 10000,
  }
}

/**
 * Buckets one entry's UTC day from its `ts` ("" when unparseable).
 * @param {Record<string, unknown>} e The parsed entry.
 * @returns {string} The YYYY-MM-DD day, or "".
 */
function dayOf(e) {
  const ts = typeof e.ts === "string" ? e.ts : ""
  return Number.isNaN(Date.parse(ts)) ? "" : new Date(ts).toISOString().slice(0, 10)
}

/**
 * Aggregates the taste-drift views over the walked prov entries: denials by
 * kind, overrides by tool/child/path, a per-day timeline, and a per-session
 * breakdown. Cross-session by construction.
 * @param {Record<string, unknown>[]} entries Parsed prov entries, oldest-first.
 * @returns {Record<string, unknown>} The drift document.
 */
function driftViews(entries) {
  const deniedKinds = {}
  const overrideTools = {}
  const children = new Set()
  const paths = new Set()
  const days = new Map()
  const bySession = {}
  for (const e of entries) {
    foldEntry(e, { deniedKinds, overrideTools, children, paths, days, bySession })
  }
  return {
    deniedKinds,
    overrideTools,
    children: [...children].sort(),
    paths: [...paths].sort(),
    timeline: [...days.entries()]
      .sort((a, b) => (a[0] < b[0] ? -1 : 1))
      .map(([day, c]) => ({ day, ...c })),
    bySession,
  }
}

/**
 * Folds one entry into the drift accumulators.
 * @param {Record<string, unknown>} e The parsed entry.
 * @param {{ deniedKinds: Record<string, number>, overrideTools: Record<string, number>, children: Set<string>, paths: Set<string>, days: Map<string, {denied: number, overrides: number}>, bySession: Record<string, {denied: number, overrides: number}> }} acc The accumulators.
 * @returns {void}
 */
function foldEntry(e, acc) {
  const sessionID = typeof e.sessionID === "string" ? e.sessionID : "?"
  const day = dayOf(e)
  const dayBucket = acc.days.get(day) ?? { denied: 0, overrides: 0 }
  const sesBucket = acc.bySession[sessionID] ?? { denied: 0, overrides: 0 }
  if (e.type === "prov:denied") {
    const kind = typeof e.kind === "string" ? e.kind : "unknown"
    acc.deniedKinds[kind] = (acc.deniedKinds[kind] ?? 0) + 1
    dayBucket.denied++
    sesBucket.denied++
  } else if (e.type === "prov:override") {
    const tool = typeof e.tool === "string" ? e.tool : "unknown"
    acc.overrideTools[tool] = (acc.overrideTools[tool] ?? 0) + 1
    if (typeof e.child === "string" && e.child) acc.children.add(e.child)
    if (typeof e.path === "string" && e.path) acc.paths.add(e.path)
    dayBucket.overrides++
    sesBucket.overrides++
  } else {
    return // neither a denial nor an override: no drift signal
  }
  acc.days.set(day, dayBucket)
  acc.bySession[sessionID] = sesBucket
}

/**
 * Builds the origin-labelled rows for `--json`: stated rows gain `origin`
 * and a read-time sha256 `hash` of their text; other rows pass through
 * verbatim plus their ts. Rows are never rewritten in place — each output
 * row is a new object.
 * @param {Record<string, unknown>[]} entries Parsed prov entries, oldest-first.
 * @param {{ waiverMarker: string, approvalMarker: string }} markers The origin markers.
 * @returns {Record<string, unknown>[]} The view rows.
 */
function viewRows(entries, markers) {
  return entries.map((e) => {
    if (e.type !== "prov:stated") return { ...e }
    const text = typeof e.text === "string" ? e.text : ""
    return {
      ...e,
      origin: classifyOrigin(e, markers),
      hash: createHash("sha256").update(text).digest("hex"),
    }
  })
}

/**
 * Renders the human-readable summary.
 * @param {Record<string, unknown>[]} entries Parsed prov entries, oldest-first.
 * @param {Record<string, unknown>[]} rows The origin-labelled view rows.
 * @param {Record<string, unknown>} drift The drift document.
 * @param {Set<string>} sessions The distinct session IDs seen.
 * @returns {string} The summary text.
 */
function renderHuman(entries, rows, drift, sessions) {
  const origins = countOrigins(rows)
  const rate = noiseRate(origins)
  const lines = [
    `prov-views — ${entries.length} prov rows (${sessions.size} sessions)`,
    `origins: ${originText(origins)} (noise rate ${(rate.rate * 100).toFixed(1)}%)`,
    `drift: ${driftText(drift)}`,
  ]
  for (const d of drift.timeline) {
    lines.push(`per-day: ${d.day} denied=${d.denied} overrides=${d.overrides}`)
  }
  return lines.join("\n")
}

/**
 * Counts the origins over the view rows.
 * @param {Record<string, unknown>[]} rows The view rows.
 * @returns {Record<string, number>} The origin counts.
 */
function countOrigins(rows) {
  const origins = {}
  for (const r of rows) {
    if (typeof r.origin !== "string") continue
    origins[r.origin] = (origins[r.origin] ?? 0) + 1
  }
  return origins
}

/**
 * Renders the origins line segment.
 * @param {Record<string, number>} origins The origin counts.
 * @returns {string} e.g. `instruction=2 chatter=1 waiver-carried=0`.
 */
function originText(origins) {
  return ["instruction", "chatter", "waiver-carried"]
    .map((k) => `${k}=${origins[k] ?? 0}`)
    .join(" ")
}

/**
 * Renders the drift line segment: denied kinds, override tools, distinct
 * children, and the (capped) distinct path count.
 * @param {Record<string, unknown>} drift The drift document.
 * @returns {string} The drift text.
 */
function driftText(drift) {
  const kinds = Object.entries(drift.deniedKinds)
    .map(([k, n]) => `${k}=${n}`)
    .join(" ")
  const tools = Object.entries(drift.overrideTools)
    .map(([k, n]) => `${k}=${n}`)
    .join(" ")
  const shown = drift.paths.slice(0, PATH_DISPLAY_CAP).length
  return (
    `denied ${kinds || "none"}` +
    ` | overrides ${tools || "none"}` +
    ` (${drift.children.length} children, ${shown} paths)`
  )
}

/**
 * Builds the `--json` document.
 * @param {Record<string, unknown>[]} rows The origin-labelled view rows.
 * @param {Record<string, unknown>} drift The drift document.
 * @returns {Record<string, unknown>} The JSON document.
 */
function jsonDocument(rows, drift) {
  const origins = countOrigins(rows)
  return { rows, origins, noiseRate: noiseRate(origins), drift }
}

/**
 * Emits the output: the JSON document or the human summary. An empty ledger
 * prints nothing (exit 0, prov parity).
 * @param {Record<string, unknown>[]} entries Parsed prov entries, oldest-first.
 * @param {Record<string, unknown>[]} rows The origin-labelled view rows.
 * @param {Record<string, unknown>} drift The drift document.
 * @param {Set<string>} sessions The distinct session IDs seen.
 * @param {boolean} json Whether `--json` was requested.
 * @returns {void}
 */
function emit(entries, rows, drift, sessions, json) {
  if (entries.length === 0) return
  if (json) {
    process.stdout.write(`${JSON.stringify(jsonDocument(rows, drift), null, 2)}\n`)
  } else {
    process.stdout.write(`${renderHuman(entries, rows, drift, sessions)}\n`)
  }
}

/**
 * Resolves the config, walks the sinks, and filters to the prov rows (the
 * resolve-and-read step of `main`). A malformed explicit session ID writes
 * the error to stderr.
 * @param {{ sessionID: string, tail: number | null }} args The parsed args.
 * @returns {{ entries: Record<string, unknown>[] } | number} The prov
 *     entries, or the exit code when the session ID is malformed (2).
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
    return { entries: provEntriesOf(read.lines, tailLines) }
  }
  const read = readAllProvLines(metricsDir, tailLines)
  return { entries: provEntriesOf(read.lines, tailLines) }
}

/**
 * Entry point. Parses args, walks the journal sinks, derives the views, and
 * prints. An empty ledger exits 0 with no output; usage errors exit 2.
 * @param {string[]} argv Arguments after the `prov-views` subcommand.
 * @returns {number} The process exit code.
 */
function main(argv) {
  let args
  try {
    args = parseArgs(argv)
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    process.stderr.write(`${msg}\n`)
    process.stderr.write("usage: opencode-turnstile prov-views [sessionID] [--json] [--tail <n>]\n")
    return 2
  }
  if (args.help) {
    process.stdout.write(`${USAGE}\n`)
    return 0
  }
  const read = resolveAndRead(args)
  if (typeof read === "number") return read
  const markers = markersOf(process.env)
  const rows = viewRows(read.entries, markers)
  const drift = driftViews(read.entries)
  const sessions = new Set(
    read.entries.map((e) => e.sessionID).filter((s) => typeof s === "string"),
  )
  emit(read.entries, rows, drift, sessions, args.json)
  return 0
}

process.exit(main(process.argv.slice(2)) ?? 0)
