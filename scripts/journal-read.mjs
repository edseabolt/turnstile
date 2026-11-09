// Shared read-only helpers for the journal-reading CLI surfaces
// (scripts/log.mjs, scripts/prov.mjs, scripts/prov-views.mjs).
//
// These were standalone copies duplicated across the surfaces; they now live
// here once (DRY). Every helper is fail-open: missing files, malformed lines,
// and unreadable directories contribute nothing rather than throwing. None of
// these write anything — the journal sinks are read-only from here.
//
// This is a plain ESM module outside the 100% coverage gate (bin/ and
// scripts/ never are); the surfaces are exercised by spawn tests
// (tests/log.test.ts, tests/prov-cli.test.ts, tests/prov-views.test.ts).

import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"

/**
 * Host session-ID alphabet, length-capped. Standalone-script copy of the
 * canonical constant in src/journal-sinks.ts (scripts cannot import TS
 * source; src/ledger.ts re-imports the same constant).
 */
export const REPLAY_SESSION_RE = /^[A-Za-z0-9._-]{1,64}$/

/** The default replay tail bound (lines); mirrors the runtime config default. */
export const DEFAULT_REPLAY_TAIL_LINES = 2000

/**
 * Canonical default reviewer agent name; mirrors CANONICAL_REVIEWER_AGENT in
 * src/config.ts (the `agents.reviewer` default).
 */
const DEFAULT_REVIEWER_AGENT = "reviewer"

/**
 * Resolves the default metrics directory (standalone copy of the journaler
 * default; honors an absolute XDG_DATA_HOME or HOME).
 * @param {Record<string, string | undefined>} env Environment to consult.
 * @returns {string} The absolute default metrics directory.
 */
export function defaultMetricsDir(env) {
  const abs = (v) => (typeof v === "string" && path.isAbsolute(v) ? v : undefined)
  const home = abs(env.HOME) ?? os.homedir()
  const base = abs(env.XDG_DATA_HOME) ?? path.join(home, ".local/share")
  return path.join(base, "opencode", "metrics")
}

/**
 * Reads and parses the config file the config layer uses, silently tolerating
 * a missing or malformed file (fail-open). Standalone copy of the config
 * loader (scripts cannot import TS source).
 * @param {NodeJS.ProcessEnv} env The process environment.
 * @returns {Record<string, unknown> | null} The parsed config object, or null.
 */
export function loadConfigFile(env) {
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
export function resolveReplayTailLines(value) {
  return Number.isInteger(value) && value > 0 ? value : DEFAULT_REPLAY_TAIL_LINES
}

/**
 * Reads the file-configured reviewer agent name (the `agents.reviewer` key),
 * tolerating a missing or malformed `agents` block (fail-open).
 * @param {Record<string, unknown> | null} config The parsed config file, or null.
 * @returns {string} The configured reviewer name, or "" when unset.
 */
function fileReviewerOf(config) {
  const agents =
    config &&
    typeof config.agents === "object" &&
    config.agents !== null &&
    !Array.isArray(config.agents)
      ? config.agents
      : {}
  return typeof agents.reviewer === "string" && agents.reviewer ? agents.reviewer : ""
}

/**
 * Resolves the metrics directory, tail bound, and reviewer agent name
 * (precedence env → file → default, mirroring config.ts). The reviewer key
 * is the timeline fold's need; surfaces that don't use it simply ignore it.
 * @param {NodeJS.ProcessEnv} env The process environment.
 * @param {number | null} tailFlag The `--tail` override, or null.
 * @returns {{ metricsDir: string, tailLines: number, reviewerAgent: string }}
 *     The resolved values.
 */
export function resolveConfig(env, tailFlag) {
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
    reviewerAgent: fileReviewerOf(config) || DEFAULT_REVIEWER_AGENT,
  }
}

/**
 * Parses the `--tail` value. A missing or non-positive-integer value is a
 * usage error (exit 2), unlike the config-file path which silently falls
 * back — an explicit flag is a deliberate request.
 * @param {string | undefined} raw The raw flag value.
 * @returns {number} The validated tail bound.
 */
export function parseTailValue(raw) {
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
export function requireSessionShape(id) {
  if (!REPLAY_SESSION_RE.test(id)) throw new Error(`unknown or malformed session id "${id}"`)
  return id
}

/**
 * Reads one journal file family (current file plus rotated generations) as
 * oldest-first blocks: a newest-first walk stopping at the first missing
 * generation, silently tolerating missing files.
 * @param {string} file Absolute path of the current journal file.
 * @param {number} tailLines The per-file tail bound in lines to keep.
 * @returns {{ name: string, lines: string[] }[]} The blocks, oldest-first.
 */
export function readFileGenerations(file, tailLines) {
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
 * missing or unparseable `ts` sorts oldest.
 * @param {string} line A raw JSONL journal line.
 * @returns {string} The sort key.
 */
export function tsKey(line) {
  try {
    const ts = JSON.parse(line).ts
    return typeof ts === "string" && !Number.isNaN(Date.parse(ts)) ? ts : ""
  } catch {
    return ""
  }
}

/**
 * Parses one journal line into an entry, or null when malformed or not a
 * plain object (fail-open).
 * @param {string} line A raw JSONL journal line.
 * @returns {Record<string, unknown> | null} The parsed entry, or null.
 */
export function parseLine(line) {
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
export function sessionSinkPaths(metricsDir) {
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
 * Dedupes raw journal lines that appear in more than one sink. A row is
 * parent-keyed into `sessions/<id>.jsonl` while `journalPerSession` routing
 * is active but may also exist in the shared `turnstile.jsonl` (routing
 * changed mid-session, or a legacy `journalPerSession:false` layout), so a
 * row identity present in both sinks must be counted once. Identity is the
 * row's full JSON text — journal writes are append-only and unmodified, so
 * two copies of one row serialize identically, while two genuinely distinct
 * events never do.
 * @param {string[]} lines Raw journal lines from all walked sinks.
 * @returns {string[]} The lines with cross-sink duplicates removed,
 *     first occurrence kept (sink order is oldest-generation first).
 */
export function dedupeSinks(lines) {
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
export function provEntriesOf(lines, tailLines) {
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
 * Reads the `prov:*` lines for one explicit session: its per-session sink
 * family plus the shared file filtered to that session. Fail-open:
 * unreadable files contribute nothing.
 * @param {string} metricsDir The metrics directory.
 * @param {string} sessionID The requested session ID.
 * @param {number} tailLines The tail bound in lines.
 * @returns {{ files: string[], lines: string[] }} The files read
 *     (oldest-first basenames) and the raw matching lines.
 */
export function readSessionProvLines(metricsDir, sessionID, tailLines) {
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
export function readAllProvLines(metricsDir, tailLines) {
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
 * Renders a timestamp as HH:MM:SS (UTC-less, verbatim from the ISO string;
 * an unparseable ts renders as `--:--:--`).
 * @param {unknown} ts The raw `ts` field.
 * @returns {string} The clock text.
 */
export function clockOf(ts) {
  if (typeof ts !== "string" || Number.isNaN(Date.parse(ts))) return "--:--:--"
  return ts.slice(11, 19)
}

/**
 * Truncates one rendered field value to a bounded length so a long prompt
 * cannot blow out the rendered row.
 * @param {string} value The raw field value.
 * @param {number} max The maximum rendered length.
 * @returns {string} The value, ellipsized when over the bound.
 */
export function truncateField(value, max) {
  return value.length <= max ? value : `${value.slice(0, max)}…`
}
