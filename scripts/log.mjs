#!/usr/bin/env node
// Read-only chronological timeline of one session's turnstile journal.
//
// This is the `turnstile log` surface: it renders the journaled events of a
// single parent session — dispatches, gate results, blocks, waivers,
// verdicts, suppressions, marker retries — oldest-first, ending with a
// one-line summary. It never writes anything and never blocks. Like
// scripts/status.mjs it is a plain ESM script outside the 100% coverage gate
// (bin/ and scripts/ never are), exercised by tests/log.test.ts via spawn
// rather than imported.
//
// Sources: the per-session sink `sessions/<sessionID>.jsonl` (+ rotated
// generations) is primary; the shared `turnstile.jsonl` (+ generations) is
// also walked, keeping only rows whose `sessionID` matches the requested
// session — or one of its children (child-keyed rows such as `marker-retry`
// are journaled with the child session ID; children are recovered from
// `child-edge` rows whose `parent` is the requested session). This covers
// pre-segmentation rows and `journalPerSession: false` layouts.
//
//   opencode-turnstile log [sessionID] [--json] [--tail <n>]
//   opencode-turnstile log --help       This usage. Unknown flags exit 2.

import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"

const USAGE = `Usage: opencode-turnstile log [sessionID] [--json] [--tail <n>]

Prints a chronological, human-readable timeline of one session's turnstile
journal — dispatches, gate results, blocks, waivers, verdicts, suppressions,
and marker retries — ending with a summary line. Read-only: nothing is
written. Without a sessionID, the most recent per-session journal is used.

Options:
  --json      Print machine-readable JSON instead of the timeline
  --tail <n>  Bound the timeline to the last <n> journal lines (default:
              the configured replayTailLines)
  --help      Show this help`

/**
 * Host session-ID alphabet, length-capped. Standalone-script copy of the
 * canonical constant in src/ledger.ts (this script cannot import TS source).
 */
const REPLAY_SESSION_RE = /^[A-Za-z0-9._-]{1,64}$/

/** The default replay tail bound (lines); mirrors the runtime config default. */
const DEFAULT_REPLAY_TAIL_LINES = 2000

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
 * a missing or malformed file (fail-open). Standalone copy of status.mjs's
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
 * default, mirroring config.ts). Standalone copy of status.mjs's resolver.
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
 * Parses the log arguments. Recognizes one optional positional sessionID,
 * --json, --tail <n>, and --help; anything else is unknown and fails with
 * exit code 2 (status parity).
 * @param {string[]} argv Arguments after the `log` subcommand.
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
 * Picks the newest per-session journal file by mtime (ties and stat failures
 * fall back to the lexicographically-last entry).
 * @param {string[]} names The `*.jsonl` (non-generation) file names.
 * @param {string} sessionsDir The per-session journal directory.
 * @returns {string} The chosen session ID, or "" when none.
 */
function newestSessionFile(names, sessionsDir) {
  let best = ""
  let bestKey = -1
  for (const name of [...names].sort()) {
    let mtime = 0
    try {
      mtime = fs.statSync(path.join(sessionsDir, name)).mtimeMs
    } catch {
      // unreadable stat: mtime 0, lexicographic order still applies
    }
    if (mtime >= bestKey) {
      bestKey = mtime
      best = name.replace(/\.jsonl$/, "")
    }
  }
  return best
}

/**
 * Resolves the session to render: an explicit positional wins (shape
 * validated); otherwise the newest per-session sink; otherwise the last
 * distinct sessionID in the shared journal's tail (the shared-file fallback
 * for `journalPerSession: false` layouts); otherwise "".
 * @param {string} positional The positional sessionID argument ("" when absent).
 * @param {string} metricsDir The metrics directory.
 * @param {number} tailLines The tail bound for the shared-file fallback scan.
 * @returns {string} The session ID, or "" when nothing is recorded.
 */
function resolveSessionID(positional, metricsDir, tailLines) {
  if (positional !== "") return requireSessionShape(positional)
  try {
    const names = fs
      .readdirSync(path.join(metricsDir, "sessions"))
      .filter((name) => /\.jsonl$/.test(name))
    const newest = newestSessionFile(names, path.join(metricsDir, "sessions"))
    if (newest !== "" && REPLAY_SESSION_RE.test(newest)) return newest
  } catch {
    // No sessions dir (legacy layout) or unreadable: shared-file fallback.
  }
  return lastSharedSessionID(path.join(metricsDir, "turnstile.jsonl"), tailLines)
}

/**
 * Finds the last distinct sessionID in the shared journal's tail (fail-open:
 * any read or parse problem yields "").
 * @param {string} journalPath Absolute path of the shared journal file.
 * @param {number} tailLines How many trailing lines to scan.
 * @returns {string} The last distinct session ID, or "".
 */
function lastSharedSessionID(journalPath, tailLines) {
  try {
    const lines = fs.readFileSync(journalPath, "utf8").split("\n").filter(Boolean).slice(-tailLines)
    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        const sid = JSON.parse(lines[i]).sessionID
        if (typeof sid === "string" && REPLAY_SESSION_RE.test(sid)) return sid
      } catch {
        // malformed line: keep scanning backwards
      }
    }
  } catch {
    // missing/unreadable shared journal: nothing recorded
  }
  return ""
}

/**
 * Reads one journal file family (current file plus rotated generations) as
 * oldest-first blocks: a newest-first walk stopping at the first missing
 * generation, silently tolerating missing files. Standalone copy of
 * status.mjs's reader (this script cannot import TS source).
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
 * missing or unparseable `ts` sorts oldest. Standalone copy of status.mjs's
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
 * plain object (fail-open, status parity).
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
 * Collects the child session IDs of one parent from `child-edge` rows in the
 * given entries (child-keyed rows such as `marker-retry` carry the child
 * session ID, so the shared-file filter must admit them too).
 * @param {Record<string, unknown>[]} entries Parsed shared-file entries.
 * @param {string} sessionID The requested parent session ID.
 * @returns {Set<string>} The child IDs whose parent is the requested session.
 */
function childIDsOf(entries, sessionID) {
  const children = new Set()
  for (const e of entries) {
    if (e.type === "child-edge" && e.parent === sessionID && typeof e.sessionID === "string") {
      children.add(e.sessionID)
    }
  }
  return children
}

/**
 * Reads the session's journal lines: the per-session sink family plus the
 * shared file filtered to the requested session (and its child-keyed rows).
 * Merged lines are `ts`-ordered (missing/unparseable sorts oldest) and the
 * global tail is kept. Fail-open: unreadable files contribute nothing.
 * @param {string} metricsDir The metrics directory.
 * @param {string} sessionID The requested parent session ID.
 * @param {number} tailLines The global tail bound in lines.
 * @returns {{ files: string[], entries: Record<string, unknown>[] }} The
 *     files read (oldest-first basenames) and the tail-bounded entries,
 *     oldest-first.
 */
function readSessionLines(metricsDir, sessionID, tailLines) {
  const sessionBlocks = readFileGenerations(
    path.join(metricsDir, "sessions", `${sessionID}.jsonl`),
    tailLines,
  )
  const sharedBlocks = readFileGenerations(path.join(metricsDir, "turnstile.jsonl"), tailLines)
  const sharedEntries = sharedBlocks
    .flatMap((b) => b.lines)
    .map(parseLine)
    .filter(Boolean)
  const keep = new Set([sessionID, ...childIDsOf(sharedEntries, sessionID)])
  const sharedLines = sharedBlocks
    .flatMap((b) => b.lines)
    .filter((line) => {
      const e = parseLine(line)
      return e !== null && keep.has(e.sessionID)
    })
  const lines = [...sessionBlocks.flatMap((b) => b.lines), ...sharedLines]
  lines.sort((a, b) => {
    const ka = tsKey(a)
    const kb = tsKey(b)
    return ka === kb ? 0 : ka < kb ? -1 : 1
  })
  return {
    files: [...sessionBlocks, ...sharedBlocks].map((b) => b.name),
    entries: lines.slice(-tailLines).map(parseLine).filter(Boolean),
  }
}

/**
 * Renders a timestamp as HH:MM:SS (UTC-less, verbatim from the ISO string;
 * an unparseable ts renders as `--:--:--`).
 * @param {unknown} ts The raw `ts` field.
 * @returns {string} The clock text.
 */
function clockOf(ts) {
  if (typeof ts !== "string" || Number.isNaN(Date.parse(ts))) return "--:--:--"
  return ts.slice(11, 19)
}

/**
 * Renders one `dispatch` row: agent, running per-agent round ordinal, and
 * description; a blocked attempt renders the `dispatch-blocked` outcome.
 * @param {Record<string, unknown>} e The parsed entry.
 * @param {number} round The per-agent dispatch ordinal (1-based).
 * @returns {string} The timeline line.
 */
function renderDispatch(e, round) {
  const agent = typeof e.agent === "string" ? e.agent : "?"
  const desc = typeof e.description === "string" ? e.description : ""
  if (e.blocked === true) return `dispatch-blocked  ${agent}  #${round}  ${desc} (blocked)`
  return `dispatch  ${agent}  #${round}  ${desc}`
}

/**
 * Renders one `gate` row: result with `tests=` and verified/mode markers, or
 * the WAIVED channel + waiver name.
 * @param {Record<string, unknown>} e The parsed entry.
 * @returns {string} The timeline line.
 */
function renderGate(e) {
  const result = typeof e.result === "string" ? e.result : "?"
  if (result === "WAIVED") {
    const channel = typeof e.channel === "string" ? e.channel : "?"
    const waiver = typeof e.waiver === "string" ? e.waiver : ""
    return `gate  WAIVED  ${channel}${waiver ? ` (${waiver})` : ""}`
  }
  const tests = Number.isInteger(e.tests) ? ` tests=${e.tests}` : ""
  const verified = e.verified === false ? " unverified" : " verified"
  const mode = e.mode === "flag" ? " mode=flag" : ""
  return `gate  ${result}${tests}${verified}${mode}`
}

/**
 * Renders one `blocked` row: the refused tool or agent plus the reason, and
 * the plan name when present.
 * @param {Record<string, unknown>} e The parsed entry.
 * @returns {string} The timeline line.
 */
function renderBlocked(e) {
  const subject = typeof e.tool === "string" ? e.tool : typeof e.agent === "string" ? e.agent : "?"
  const reason = typeof e.reason === "string" ? e.reason : "?"
  const plan = typeof e.plan === "string" && e.plan ? ` (plan ${e.plan})` : ""
  return `block  ${subject}  reason=${reason}${plan}`
}

/**
 * Renders one `plan` row: result, plan name, and source; a STALE row renders
 * its reason field; a WAIVED row (the plan-gate waiver entry) renders the
 * waiver channel and waiver text instead of a plan name.
 * @param {Record<string, unknown>} e The parsed entry.
 * @returns {string} The timeline line.
 */
function renderPlan(e) {
  const result = typeof e.result === "string" ? e.result : "?"
  const source = typeof e.source === "string" ? ` (source ${e.source})` : ""
  if (result === "WAIVED") {
    const channel = typeof e.channel === "string" ? e.channel : "?"
    const waiver = typeof e.waiver === "string" ? e.waiver : ""
    return `plan  WAIVED  ${channel}${waiver ? ` (${waiver})` : ""}${source}`
  }
  const plan = typeof e.plan === "string" ? e.plan : ""
  const reason = result === "STALE" && typeof e.reason === "string" ? ` reason=${e.reason}` : ""
  return `plan  ${result}  ${plan}${source}${reason}`
}

/**
 * Renders one `verdict` row: the marker and its source/agent provenance.
 * @param {Record<string, unknown>} e The parsed entry.
 * @returns {string} The timeline line.
 */
function renderVerdict(e) {
  const marker = typeof e.marker === "string" ? e.marker : "?"
  const source = typeof e.source === "string" ? ` (source ${e.source}` : " (source ?"
  const agent = typeof e.agent === "string" ? `, agent ${e.agent})` : ")"
  return `verdict  ${marker}${source}${agent}`
}

/**
 * Renders the small audit row types (suppressed, marker-retry, intent,
 * continuation, violation) with their salient fields.
 * @param {Record<string, unknown>} e The parsed entry.
 * @returns {string} The timeline line.
 */
function renderAudit(e) {
  const parts = []
  if (typeof e.kind === "string") parts.push(`kind=${e.kind}`)
  if (typeof e.marker === "string" && e.marker) parts.push(`marker=${e.marker}`)
  if (Number.isInteger(e.attempt)) parts.push(`attempt=${e.attempt}`)
  if (typeof e.outcome === "string") parts.push(`outcome=${e.outcome}`)
  if (Number.isInteger(e.count)) parts.push(`count=${e.count}`)
  if (typeof e.reason === "string" && e.reason) parts.push(`reason=${e.reason}`)
  if (typeof e.agent === "string" && e.agent) parts.push(`agent=${e.agent}`)
  return `${e.type}  ${parts.join("  ")}`.trimEnd()
}

/**
 * Renders one compact row for the remaining known types (permission,
 * maintenance, task-complete, child-edge, plan-rekey, observe, would-block,
 * ensemble, error, child-reset): the type plus its first distinguishing
 * fields.
 * @param {Record<string, unknown>} e The parsed entry.
 * @returns {string} The timeline line.
 */
function renderCompact(e) {
  const parts = []
  for (const key of ["action", "decision", "kind", "plan", "parent", "agent", "error", "result"]) {
    if (typeof e[key] === "string" && e[key]) parts.push(`${key}=${e[key]}`)
  }
  if (Number.isInteger(e.count)) parts.push(`count=${e.count}`)
  if (e.refusedApprove === true) parts.push("refusedApprove=true")
  if (e.capped === true) parts.push("capped=true")
  return `${e.type}  ${parts.join("  ")}`.trimEnd()
}

/** The row types rendered by renderAudit (the small audit rows). */
const AUDIT_TYPES = ["suppressed", "marker-retry", "intent", "continuation", "violation"]

/** The row types rendered by renderCompact (the remaining known types). */
const COMPACT_TYPES = [
  "permission",
  "maintenance",
  "task-complete",
  "child-edge",
  "plan-rekey",
  "observe",
  "would-block",
  "ensemble",
  "error",
  "child-reset",
]

/**
 * Renders one known entry type to its timeline text, or null when the type
 * is unrecognized (the caller renders `(unrecognized)` so future journal
 * types never break the surface).
 * @param {Record<string, unknown>} e The parsed entry.
 * @param {Map<string, number>} rounds The running per-agent dispatch ordinals.
 * @returns {string | null} The rendered text, or null for an unknown type.
 */
function renderKnown(e, rounds) {
  const type = typeof e.type === "string" ? e.type : "?"
  if (type === "dispatch") {
    const agent = typeof e.agent === "string" ? e.agent : "?"
    const round = (rounds.get(agent) ?? 0) + 1
    rounds.set(agent, round)
    return renderDispatch(e, round)
  }
  if (type === "gate") return renderGate(e)
  if (type === "blocked") return renderBlocked(e)
  if (type === "plan") return renderPlan(e)
  if (type === "verdict") return renderVerdict(e)
  if (AUDIT_TYPES.includes(type)) return renderAudit(e)
  if (COMPACT_TYPES.includes(type)) return renderCompact(e)
  return null
}

/**
 * Builds the timeline rows: one rendered line per entry, with dispatch
 * rounds as running per-agent ordinals.
 * @param {Record<string, unknown>[]} entries Parsed journal entries, oldest-first.
 * @returns {{ ts: string, text: string }[]} The rendered rows.
 */
function buildTimeline(entries) {
  const rounds = new Map()
  return entries.map((e) => {
    const ts = clockOf(e.ts)
    const type = typeof e.type === "string" ? e.type : "?"
    return { ts, text: renderKnown(e, rounds) ?? `${type}  (unrecognized)` }
  })
}

/**
 * Folds the final gate state with the replay flip rule (status.mjs parity):
 * last PASS/FAIL wins; an enforce-mode `verified:false` PASS never flips.
 * @param {Record<string, unknown>[]} entries Parsed journal entries, oldest-first.
 * @returns {"PASS" | "FAIL" | "none"} The final gate state.
 */
function finalGateOf(entries) {
  let gate = "none"
  for (const e of entries) {
    if (e.type !== "gate") continue
    if (e.result !== "PASS" && e.result !== "FAIL") continue
    const flips = !(e.result === "PASS" && e.verified === false && e.mode !== "flag")
    if (flips) gate = e.result
  }
  return gate
}

/**
 * Folds the credited-approval status exactly the way the replay fold does
 * (src/ledger.ts foldVerdict/foldEnsemble): only `verdict` rows with
 * `source === "task-result"` count, last task-result verdict wins (APPROVE
 * sets the flag, anything else clears it), and `ensemble` rows carry the
 * last-wins refusal stamp (`refusedApprove:true` stamps a refusal,
 * `refusedApprove:false` clears it, an absent field leaves it unchanged).
 * Credited means the last task-result verdict is APPROVE and the refusal
 * stamp is not true.
 * @param {Record<string, unknown>[]} entries Parsed journal entries, oldest-first.
 * @returns {"yes" | "no"} Whether the approval stands credited.
 */
function creditedApprovalOf(entries) {
  let approved = false
  let refused = false
  for (const e of entries) {
    if (e.type === "ensemble") {
      if (e.refusedApprove === true) refused = true
      else if (e.refusedApprove === false) refused = false
    } else if (e.type === "verdict" && e.source === "task-result") {
      approved = typeof e.marker === "string" && e.marker.includes("APPROVE")
    }
  }
  return approved && !refused ? "yes" : "no"
}

/**
 * Builds the summary fields: blocks grouped by reason, dispatch and waiver
 * counts, credited approval, and the final gate state.
 * @param {Record<string, unknown>[]} entries Parsed journal entries, oldest-first.
 * @returns {{ blocks: Record<string, number>, dispatches: number, dispatchesBlocked: number, waivers: number, finalGate: string, creditedApproval: string }} The summary.
 */
function summarize(entries) {
  const blocks = {}
  let dispatches = 0
  let dispatchesBlocked = 0
  let waivers = 0
  for (const e of entries) {
    if (e.type === "blocked") {
      const reason = typeof e.reason === "string" ? e.reason : "?"
      blocks[reason] = (blocks[reason] ?? 0) + 1
    } else if (e.type === "dispatch") {
      if (e.blocked === true) dispatchesBlocked++
      else dispatches++
    } else if (
      (e.type === "gate" || e.type === "plan") &&
      (e.result === "WAIVED" || e.result === "waived")
    ) {
      waivers++
    }
  }
  return {
    blocks,
    dispatches,
    dispatchesBlocked,
    waivers,
    finalGate: finalGateOf(entries),
    creditedApproval: creditedApprovalOf(entries),
  }
}

/**
 * Renders the one-line summary text from the summary fields.
 * @param {ReturnType<typeof summarize>} s The summary fields.
 * @returns {string} The summary line.
 */
function renderSummary(s) {
  const reasons = Object.entries(s.blocks)
  const blockText =
    reasons.length === 0 ? "none" : reasons.map(([reason, n]) => `${reason}×${n}`).join(", ")
  return (
    `summary: ${reasons.reduce((t, [, n]) => t + n, 0)} blocks (${blockText}), ` +
    `${s.dispatches} dispatches, ${s.waivers} waivers, ` +
    `credited approval: ${s.creditedApproval}, final gate ${s.finalGate}`
  )
}

/**
 * Renders the human-readable timeline text.
 * @param {{ ts: string, text: string }[]} rows The rendered rows.
 * @param {ReturnType<typeof summarize>} summary The summary fields.
 * @param {string} sessionID The rendered session ID.
 * @param {string[]} files The journal files read (basenames).
 * @returns {string} The full timeline text.
 */
function renderTimeline(rows, summary, sessionID, files) {
  const out = [`turnstile log — ${sessionID} (${rows.length} entries; files: ${files.join(", ")})`]
  for (const row of rows) out.push(`${row.ts}  ${row.text}`)
  out.push(renderSummary(summary))
  return out.join("\n")
}

/**
 * Builds the machine-readable `--json` document.
 * @param {string} sessionID The rendered session ID.
 * @param {string[]} files The journal files read (basenames).
 * @param {Record<string, unknown>[]} entries The parsed entries, oldest-first.
 * @returns {Record<string, unknown>} The JSON document.
 */
function jsonDocument(sessionID, files, entries) {
  return { session: sessionID, files, entries, summary: summarize(entries) }
}

/**
 * Emits the rendered output: the machine-readable `--json` document or the
 * human-readable timeline.
 * @param {string} sessionID The rendered session ID.
 * @param {string[]} files The journal files read (basenames).
 * @param {Record<string, unknown>[]} entries The parsed entries, oldest-first.
 * @param {boolean} json Whether `--json` was requested.
 * @returns {void}
 */
function emit(sessionID, files, entries, json) {
  if (json) {
    process.stdout.write(`${JSON.stringify(jsonDocument(sessionID, files, entries), null, 2)}\n`)
  } else {
    const rows = buildTimeline(entries)
    process.stdout.write(`${renderTimeline(rows, summarize(entries), sessionID, files)}\n`)
  }
}

/**
 * Resolves the session and reads its journal lines (the resolve-and-read
 * step of `main`). A malformed explicit session ID writes the error to
 * stderr; an unresolvable session writes the no-journal note to stdout.
 * @param {{ sessionID: string, tail: number | null }} args The parsed args.
 * @returns {{ sessionID: string, files: string[], entries: Record<string, unknown>[] } | number}
 *     The resolved session with its journal lines, or the exit code to
 *     return when nothing can be reported (2 for a malformed session ID,
 *     0 for the no-journal note).
 */
function resolveAndRead(args) {
  const { metricsDir, tailLines } = resolveConfig(process.env, args.tail)
  let sessionID
  try {
    sessionID = resolveSessionID(args.sessionID, metricsDir, tailLines)
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    process.stderr.write(`${msg}\n`)
    return 2
  }
  if (sessionID === "") {
    process.stdout.write(`No turnstile journal yet at ${metricsDir} — nothing to report.\n`)
    return 0
  }
  return { sessionID, ...readSessionLines(metricsDir, sessionID, tailLines) }
}

/**
 * Entry point. Parses args, resolves the session, reads the journal, and
 * prints. Missing journal exits 0 with a note (status parity); usage errors
 * exit 2.
 * @param {string[]} argv Arguments after the `log` subcommand.
 * @returns {number} The process exit code.
 */
function main(argv) {
  let args
  try {
    args = parseArgs(argv)
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    process.stderr.write(`${msg}\n`)
    process.stderr.write("usage: opencode-turnstile log [sessionID] [--json] [--tail <n>]\n")
    return 2
  }
  if (args.help) {
    process.stdout.write(`${USAGE}\n`)
    return 0
  }
  const read = resolveAndRead(args)
  if (typeof read === "number") return read
  emit(read.sessionID, read.files, read.entries, args.json)
  return 0
}

process.exit(main(process.argv.slice(2)) ?? 0)
