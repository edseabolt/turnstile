#!/usr/bin/env node
// Read-only report of turnstile gate/plan state over the JSONL journal.
//
// This is the `turnstile status` surface: it reports, per parent
// session, what the journal says a task currently is — it never touches the
// host, and its only write is `--check-updates`' 24h cache file. It is
// deliberately a plain ESM script outside the 100%
// coverage gate (bin/ and scripts/ never are), and it is exercised by
// tests/status.test.ts via spawn rather than imported.
//
// Journal resolution precedence (mirrors config.ts's env → file → default):
//   TURNSTILE_METRICS_DIR  →  TURNSTILE_CONFIG's metricsDir  →  ~ default
// The journal file is `turnstile.jsonl`; its rotated generations
// (`${journal}.1`, `.2`, …) are walked newest-first with an early stop, so the
// `replayTailLines` replay tail (default 2000) holds across all retained
// generations — replay parity with src/ledger.ts.
//
//   opencode-turnstile status            Human-readable table.
//   opencode-turnstile status --json     Machine-readable JSON.
//   opencode-turnstile status --help     This usage. Unknown flags exit 2.
//
// `--check-updates` (opt-in) checks npm for a newer turnstile: the installed
// version comes from the script's own package.json; the registry lookup is
// cached at `<metricsDir>/update-check.json` for 24h so repeated runs stay
// network-free, and failures are never cached.

import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { fileURLToPath } from "node:url"

const USAGE = `Usage: opencode-turnstile status [--json] [--check-updates]

Reports turnstile gate and plan state per parent session, read from the
JSONL journal. Read-only: nothing is written. The journal reflects the last
prompt-cycle; in-memory state can be fresher.

Options:
  --json            Print machine-readable JSON instead of the table
  --check-updates   Check npm for a newer turnstile (network, cached 24h)
  --help            Show this help`

/**
 * Resolves the default metrics directory (copy of the journaler default so the
 * standalone script needs no TS source). Honors an absolute XDG_DATA_HOME or
 * HOME; anything relative falls back to the OS-provided value.
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
 * The default replay tail bound (lines). This mirrors the runtime config
 * default so the standalone script needs no TS source; a configured
 * `replayTailLines` in the config file overrides it.
 */
const DEFAULT_REPLAY_TAIL_LINES = 2000

/** Age (ms) a cached update-check result stays fresh (24h). */
const UPDATE_CACHE_TTL_MS = 24 * 60 * 60 * 1000

/** Default npm registry URL for the latest-turnstile lookup (tests override via TURNSTILE_UPDATE_URL). */
const DEFAULT_UPDATE_URL = "https://registry.npmjs.org/opencode-turnstile/latest"

/**
 * Local semver subset for the update comparison (standalone-script copy; see
 * the REPLAY_SESSION_RE precedent — this script cannot import TS source).
 * @param {string} s Version string to parse.
 * @returns {{ major: number, minor: number, patch: number } | null} Parsed
 *     core fields, or null when not a strict `major.minor.patch`.
 */
function parseSemverJs(s) {
  const m = /^v?(\d+)\.(\d+)\.(\d+)/.exec(String(s ?? ""))
  return m ? { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]) } : null
}

/**
 * Numeric three-field compare of two already-parsed semver cores.
 * @param {{ major: number, minor: number, patch: number }} a Left side.
 * @param {{ major: number, minor: number, patch: number }} b Right side.
 * @returns {number} Negative / zero / positive as a <, ==, > b.
 */
function compareCores(a, b) {
  for (const k of ["major", "minor", "patch"]) {
    if (a[k] !== b[k]) return a[k] - b[k]
  }
  return 0
}

/**
 * Reads the installed turnstile version from the script's own package.json.
 * @returns {string | null} The version, or null when unreadable.
 */
function installedVersion() {
  try {
    const pkgPath = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "package.json")
    return JSON.parse(fs.readFileSync(pkgPath, "utf8")).version ?? null
  } catch {
    return null
  }
}

/**
 * Reads the cached update-check result, tolerating missing/malformed files.
 * @param {string} metricsDir The metrics directory holding the cache file.
 * @returns {{ fetchedAt: number, latest: string } | null} The cache, or null.
 */
function readUpdateCache(metricsDir) {
  try {
    const c = JSON.parse(fs.readFileSync(path.join(metricsDir, "update-check.json"), "utf8"))
    return typeof c.fetchedAt === "number" && typeof c.latest === "string"
      ? { fetchedAt: c.fetchedAt, latest: c.latest }
      : null
  } catch {
    return null
  }
}

/**
 * Fetches the latest published turnstile version (fail-open: any network or
 * shape failure returns null and nothing is cached).
 * @param {NodeJS.ProcessEnv} env Environment; TURNSTILE_UPDATE_URL overrides
 *     the registry endpoint (tests stub it with a local server).
 * @returns {Promise<string | null>} The latest version string, or null.
 */
async function fetchLatest(env) {
  try {
    const res = await fetch(env.TURNSTILE_UPDATE_URL || DEFAULT_UPDATE_URL)
    if (!res.ok) return null
    const json = await res.json()
    return typeof json.version === "string" ? json.version : null
  } catch {
    return null
  }
}

/**
 * Runs the opt-in update check: a fresh cache short-circuits the network;
 * otherwise the registry is fetched and a success rewrites the cache
 * (failures are never cached).
 * @param {NodeJS.ProcessEnv} env Environment for the registry URL.
 * @param {string} metricsDir The metrics directory holding the cache file.
 * @returns {Promise<{ checked: boolean, latest?: string, error?: string }>}
 *     The update-check result block for the status output.
 */
async function resolveUpdateCheck(env, metricsDir) {
  const cached = readUpdateCache(metricsDir)
  const fresh = cached && Date.now() - cached.fetchedAt < UPDATE_CACHE_TTL_MS
  const latest = fresh ? cached.latest : await fetchLatest(env)
  if (!fresh && !latest) {
    return { checked: true, error: "update check failed (network or response shape)" }
  }
  if (!fresh && latest) {
    try {
      fs.writeFileSync(
        path.join(metricsDir, "update-check.json"),
        JSON.stringify({ fetchedAt: Date.now(), latest }),
      )
    } catch {
      // an unwritable cache is inert — the check still reports this run
    }
  }
  return { checked: true, latest }
}

/**
 * Host session-ID alphabet, length-capped. Mirrors the canonical constant in
 * src/ledger.ts (this standalone script cannot import TS source): a session
 * whose ID fails the shape is not a session — replay parity, so a hostile
 * journal line mints no status row.
 */
const REPLAY_SESSION_RE = /^[A-Za-z0-9._-]{1,64}$/

/**
 * Upper bound on a journaled VERDICT marker string. Mirrors the canonical
 * bound in src/ledger.ts: an oversized marker is treated like an absent one
 * (the existing empty-marker handling), never as a live verdict.
 */
const MAX_REPLAY_MARKER_LEN = 512

/**
 * Upper bound on a journaled observe-mode counter. Mirrors the canonical
 * bound in src/ledger.ts (this standalone script cannot import TS source): a
 * real period stays far below it, so anything larger — or non-integer — is
 * hostile padding, not a count, and the line folds nothing.
 */
const MAX_REPLAY_OBSERVE_COUNT = 1_000_000

/**
 * Reads and parses the config file the config layer uses, silently tolerating
 * a missing or malformed file (fail-open). Returns `null` when nothing usable
 * is present.
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
 * Validates a configured `replayTailLines`. Only a finite positive integer is
 * accepted; anything else falls back to the default so the script can never
 * slice past the start of the line array (mirrors the runtime config's junk
 * rejection — except this script journals nothing, so the fallback is silent).
 * @param {unknown} value The raw `replayTailLines` from the config file.
 * @returns {number} The validated tail bound.
 */
function resolveReplayTailLines(value) {
  return Number.isInteger(value) && value > 0 ? value : DEFAULT_REPLAY_TAIL_LINES
}

/**
 * Validates a configured `observeSessions` period. Only an integer ≥ 0 is
 * accepted; anything else falls back to 0 (observe mode off) so the observe
 * header line degrades to the in-period rendering rather than misphasing or
 * crashing (mirrors the runtime config's junk rejection — except this script
 * journals nothing, so the fallback is silent).
 * @param {unknown} value The raw `observeSessions` from the config file.
 * @returns {number} The validated period.
 */
function resolveObserveSessions(value) {
  return Number.isInteger(value) && value >= 0 ? value : 0
}

/**
 * Resolves both the metrics directory and the replay tail bound the status
 * surface uses. The config file is parsed once (silently-failing, fail-open)
 * and always supplies the replay tail bound and the observe period; the
 * TURNSTILE_METRICS_DIR env overrides only the metrics directory (precedence
 * env → file → default).
 * @param {NodeJS.ProcessEnv} env The process environment.
 * @returns {{ metricsDir: string, replayTailLines: number, observeSessions: number }} The resolved values.
 */
function resolveConfig(env) {
  const config = loadConfigFile(env)
  const envDir =
    typeof env.TURNSTILE_METRICS_DIR === "string" && env.TURNSTILE_METRICS_DIR
      ? env.TURNSTILE_METRICS_DIR
      : ""
  const fileDir =
    config && typeof config.metricsDir === "string" && config.metricsDir ? config.metricsDir : ""
  const metricsDir = envDir || fileDir || defaultMetricsDir(env)
  return {
    metricsDir,
    replayTailLines: resolveReplayTailLines(config?.replayTailLines),
    observeSessions: resolveObserveSessions(config?.observeSessions),
  }
}

/**
 * Reads the journal's retained generations as a single oldest-first line
 * stream: a newest-first walk over `turnstile.jsonl`, then `.1`, `.2`, …
 * (stopping at the first missing generation — a missing current file is the
 * post-rotation state, so the walk starts at `.1`), stopping as soon as the
 * collected lines satisfy the `replayTailLines` tail bound (default 2000) the
 * runtime replay uses, so the status flags stay replay-parity. Silently
 * tolerates missing generations.
 * @param {string} journalPath Absolute path of `turnstile.jsonl`.
 * @param {number} tailLines The replay tail bound in lines to keep.
 * @returns {{ files: string[], lines: string[] }} The files read (oldest-first
 *     basenames) and their tail-bounded lines, oldest-first.
 */
function readJournal(journalPath, tailLines) {
  if (tailLines <= 0) return { files: [], lines: [] }
  const blocks = []
  let generation = fs.existsSync(journalPath) ? 0 : 1
  for (;;) {
    const file = generation === 0 ? journalPath : `${journalPath}.${generation}`
    if (!fs.existsSync(file)) break
    blocks.unshift({
      name: path.basename(file),
      lines: fs.readFileSync(file, "utf8").split("\n").filter(Boolean),
    })
    if (blocks.reduce((total, b) => total + b.lines.length, 0) >= tailLines) break
    generation++
  }
  return {
    files: blocks.map((b) => b.name),
    lines: blocks.flatMap((b) => b.lines).slice(-tailLines),
  }
}

/**
 * Accumulator for one parent session, seeded to the empty status state.
 * @returns {Record<string, unknown>} Fresh session accumulator.
 */
function freshSession() {
  return {
    lastGateResult: null,
    hasGatePass: false,
    lastPlanResult: null,
    hasPlanVerdict: false,
    planApproval: { effective: null, verdict: null, source: null, promptApproval: false },
    lastGate: { marker: "", ts: "" },
    lastVerdict: { marker: "", ts: "" },
    waivers: [],
    dispatches: 0,
    blocks: 0,
    permissionAsks: 0,
    permissionDecisions: { once: 0, always: 0, reject: 0 },
    suspended: false,
  }
}

/**
 * Validates the two running totals an `observe` or `would-block` line
 * carries. Both must be integers within the replay counter bound (a real
 * period stays far below it; anything larger or non-integer is hostile
 * padding, not a count) — the all-or-nothing shape src/ledger.ts's replay
 * validation uses, deliberately parallel because this standalone script
 * cannot import TS source. A line whose counters fail folds nothing (status
 * is observation-only, so a dropped line is silent here rather than
 * journaled).
 * @param {Record<string, unknown>} entry The parsed `observe`/`would-block` line.
 * @returns {{ observed: number, wouldBlocks: number } | null} The validated
 *     totals, or null when either fails its shape.
 */
function observeCountsOf(entry) {
  const { observed, wouldBlocks } = entry
  if (!Number.isInteger(observed) || observed < 0 || observed > MAX_REPLAY_OBSERVE_COUNT) {
    return null
  }
  if (!Number.isInteger(wouldBlocks) || wouldBlocks < 0 || wouldBlocks > MAX_REPLAY_OBSERVE_COUNT) {
    return null
  }
  return { observed, wouldBlocks }
}

/**
 * Aggregates the journal lines into per-session status. Replays the same
 * gate/plan last-wins rules as ledger.ts's replayGatePasses: a trailing
 * `GATE: FAIL` keeps the gate red, a `verified:false` PASS never
 * flips, and a `type:plan` APPROVE restores plan approval. Malformed lines are
 * skipped, and lines whose sessionID fails the replay session-ID shape check
 * are skipped before any fold, for parity with replayGatePasses (status is
 * observation-only, so a dropped line is silent here rather than journaled).
 * Verdict markers over the replay marker bound degrade to "" (they then flow
 * into the empty-marker BLOCK fallback below). Parent-keyed.
 *
 * Suspension lines (`type:"suspended"`) fold last-wins like ledger.ts's
 * foldSuspended: `action:"off"` marks the session suspended, `action:"on"`
 * clears it, an `event:"would-block"` audit entry folds inert, and an unknown
 * action folds nothing (a hostile action must not toggle the flag).
 *
 * Observe-mode lines fold in parallel with the ledger replay: last-wins on
 * the two running totals (every line carries both, so the last stamped line
 * restores the whole period), a `kind:"summary"` marker folds inert (its only
 * replay role is the one-shot summary probe, never the totals), and a line
 * whose counters fail validation folds nothing. `observe.seen` marks that the
 * journal holds observe-mode entries at all — the report's observe header
 * line renders only then, so journals without them stay byte-identical.
 * @param {string[]} lines Journal lines, oldest-first.
 * @returns {{ sessions: Map<string, Record<string, unknown>>, observe: { seen: number, observed: number, wouldBlocks: number } }}
 *     sessionID → accumulator, plus the folded observe-mode state.
 */
function aggregate(lines) {
  const sessions = new Map()
  const observe = { seen: 0, observed: 0, wouldBlocks: 0 }
  const forSession = (id) => {
    let a = sessions.get(id)
    if (!a) {
      a = freshSession()
      sessions.set(id, a)
    }
    return a
  }

  for (const line of lines) {
    let e
    try {
      e = JSON.parse(line)
    } catch {
      continue // malformed line: skip, replay-parity.
    }
    if (!e || typeof e !== "object" || Array.isArray(e)) continue
    const sid = e.sessionID
    if (typeof sid !== "string" || !REPLAY_SESSION_RE.test(sid)) continue
    const a = forSession(sid)
    const type = e.type
    const result = e.result

    if (type === "gate") {
      // Gate flags restored exactly like replayGatePasses: last flipping result
      // wins; an unverified PASS neither flips here nor at runtime.
      if (result === "PASS" || result === "FAIL") {
        const flips = !(result === "PASS" && e.verified === false && e.mode !== "flag")
        if (flips) {
          a.lastGateResult = result
          a.hasGatePass = result === "PASS"
        }
      }
      if (result === "WAIVED") {
        a.waivers.push({
          channel: typeof e.channel === "string" ? e.channel : "",
          waiver: typeof e.waiver === "string" ? e.waiver : "",
        })
      } else if (typeof e.marker === "string" && e.marker) {
        a.lastGate.marker = e.marker
        a.lastGate.ts = typeof e.ts === "string" ? e.ts : ""
      }
    } else if (type === "plan") {
      // Plan flags restored like replayGatePasses: last APPROVE/BLOCK wins.
      if (result === "APPROVE" || result === "BLOCK") {
        a.lastPlanResult = result
        a.hasPlanVerdict = result === "APPROVE"
        a.planApproval.effective = result
        a.planApproval.verdict = result
        a.planApproval.source = typeof e.source === "string" ? e.source : null
        // A `PLAN APPROVED:` in the user prompt is journaled as a type:plan
        // APPROVE (source "session-prompt"); replay restores it like any plan
        // APPROVE above, and the status display surfaces the human provenance.
        if (result === "APPROVE" && e.source === "session-prompt") {
          a.planApproval.promptApproval = true
        }
      } else if (result === "WAIVED") {
        a.waivers.push({ channel: typeof e.channel === "string" ? e.channel : "", waiver: "" })
      }
    } else if (type === "verdict") {
      // VERDICT: APPROVE/BLOCK observations (plan-reviewer verdict markers).
      const marker =
        typeof e.marker === "string" && e.marker.length <= MAX_REPLAY_MARKER_LEN ? e.marker : ""
      if (marker) {
        a.lastVerdict.marker = marker
        a.lastVerdict.ts = typeof e.ts === "string" ? e.ts : ""
      }
      if (marker.includes("APPROVE")) {
        a.planApproval.effective = "APPROVE"
        a.planApproval.verdict = "APPROVE"
      } else {
        a.planApproval.effective = "BLOCK"
        a.planApproval.verdict = "BLOCK"
      }
      a.planApproval.source = typeof e.source === "string" ? e.source : a.planApproval.source
    } else if (type === "suspended") {
      // Suspension fold (see the function doc): last-wins, mirroring
      // ledger.ts's foldSuspended — refused refusals, would-block audits,
      // and unknown actions fold nothing.
      if (e.event === "would-block" || e.refused === true) continue
      if (e.action === "off") a.suspended = true
      else if (e.action === "on") a.suspended = false
    } else if (type === "dispatch") {
      // A blocked attempt was never executed — its block is already counted by
      // the guard's `blocked` entry, so exclude the `blocked:true` stamp from
      // the dispatches counter (no double count).
      if (e.blocked !== true) a.dispatches++
    } else if (type === "blocked") {
      a.blocks++
    } else if (type === "permission") {
      if (e.action === "ask") {
        a.permissionAsks++
      } else if (e.decision === "once" || e.decision === "always" || e.decision === "reject") {
        a.permissionDecisions[e.decision]++
      }
    } else if (type === "observe" || type === "would-block") {
      // Observe-mode fold (see the function doc): the line is present no
      // matter which counter checks pass, so `seen` marks the header line;
      // then the summary marker folds inert and a counter-invalid line folds
      // nothing.
      observe.seen++
      if (type === "observe" && e.kind === "summary") continue
      const counts = observeCountsOf(e)
      if (counts === null) continue
      observe.observed = counts.observed
      observe.wouldBlocks = counts.wouldBlocks
    }
  }

  return { sessions, observe }
}

/**
 * Truncates a session ID for a table cell (JSON keeps the full ID).
 * @param {string} id The raw session ID.
 * @returns {string} The display ID.
 */
function fmtSession(id) {
  return id.length > 12 ? `${id.slice(0, 9)}…` : id
}

/**
 * Renders the human-readable table. When the journal holds observe-mode
 * entries, the report gains one extra line right below the header line with
 * the folded phase and running period totals — journals without observe
 * entries render byte-identically to before (the observe argument carries
 * `seen: 0` and no line is emitted).
 * @param {Map<string, Record<string, unknown>>} sessions Aggregated sessions.
 * @param {string} journalPath The journal file path for the header.
 * @param {{ seen: number, observed: number, wouldBlocks: number }} observe The folded observe-mode state.
 * @param {number} observeSessions The configured observe period (from the config file).
 * @returns {string} The table text.
 */
function renderTable(sessions, journalPath, observe, observeSessions) {
  const rows = [...sessions.entries()].map(([id, a]) => ({
    session: fmtSession(id),
    gate: a.hasGatePass ? "PASS" : "red",
    plan: a.hasPlanVerdict ? "APPROVE" : (a.planApproval.effective ?? "·"),
    verdict: a.planApproval.effective ?? "·",
    wv: a.waivers.length,
    dis: a.dispatches,
    bl: a.blocks,
    ask: a.permissionAsks,
    dec: a.permissionDecisions.once + a.permissionDecisions.always + a.permissionDecisions.reject,
    sus: a.suspended ? "OFF" : "·",
  }))

  const headers = ["SESSION", "GATE", "PLAN", "VERDICT", "WV", "DIS", "BLK", "PERM", "SUS"]
  const cells = [
    (r) => r.session,
    (r) => r.gate,
    (r) => r.plan,
    (r) => r.verdict,
    (r) => String(r.wv),
    (r) => String(r.dis),
    (r) => String(r.bl),
    (r) => `${r.ask}/${r.dec}`,
    (r) => r.sus,
  ]

  const widths = headers.map((h, i) => Math.max(h.length, ...rows.map((r) => cells[i](r).length)))
  const line = (vals) =>
    vals
      .map((v, i) => v.padEnd(widths[i]))
      .join("  ")
      .replace(/\s+$/, "")

  const out = [`turnstile status — ${journalPath}`]
  if (observe.seen > 0) {
    // `enforce` once the folded total passes the configured period, `observe`
    // while the period is still running (a default-period journal holds no
    // observe entries, so this line never renders there).
    const phase = observe.observed > observeSessions ? "enforce" : "observe"
    out.push(
      `observe: ${phase} ${observe.observed}/${observeSessions} sessions, ${observe.wouldBlocks} would-blocks`,
    )
  }
  if (rows.length === 0) {
    out.push("(no sessions recorded yet)")
  } else {
    out.push(line(headers))
    for (const r of rows) out.push(line(cells.map((c) => c(r))))
  }
  out.push("", "journal reflects the last prompt-cycle; in-memory state can be fresher.")
  return out.join("\n")
}

/**
 * Parses the status arguments. Recognizes --json, --help, and
 * --check-updates; anything else is an unknown flag and fails with exit
 * code 2.
 * @param {string[]} argv Arguments after the `status` subcommand.
 * @returns {{ json: boolean, help: boolean, checkUpdates: boolean }} Parsed flags.
 */
function parseArgs(argv) {
  const json = argv.includes("--json")
  const help = argv.includes("--help")
  const checkUpdates = argv.includes("--check-updates")
  for (const a of argv) {
    if (a === "--json" || a === "--help" || a === "--check-updates") continue
    throw new Error(`unknown argument "${a}"`)
  }
  return { json, help, checkUpdates }
}

/**
 * Builds the human-readable update line for the table output. Reports a newer
 * published turnstile when one exists, or a one-line failure note when the
 * check failed; anything else (installed is current or unparsable) renders
 * nothing — the default output without the flag stays byte-identical.
 * @param {{ checked: boolean, latest?: string, error?: string }} update The
 *     update-check result block.
 * @returns {string} The update line, or "" when there is nothing to report.
 */
function updateLineText(update) {
  if (update?.error) return `update: ${update.error}`
  const installed = parseSemverJs(installedVersion())
  const latest = parseSemverJs(update?.latest)
  if (!installed || !latest || compareCores(latest, installed) <= 0) return ""
  return `update: a newer turnstile (${update.latest}) is available — npm i opencode-turnstile@latest`
}

/**
 * Async wrapper producing the table-mode update line for the empty-journal
 * path (the check must run before the line can render).
 * @param {string} metricsDir The metrics directory holding the cache file.
 * @returns {Promise<string>} The update line, or "".
 */
async function updateLine(metricsDir) {
  const update = await resolveUpdateCheck(process.env, metricsDir)
  return updateLineText(update)
}

/**
 * Detects a host CLI config that auto-answers permission asks. Reads
 * `~/.config/opencode/cli.json` (read-only, fail-open like every other read
 * here) and reports when `session.permissions` is `"autoaccept"` — with that
 * setting the human decision points turnstile's permission-ask gates rely on
 * are rubber-stamped (the landing gate's human release, the plan-gate
 * escalation, the ensemble's human release), degrading those gates to
 * delays. Missing or malformed config reports nothing.
 * @param {Record<string, string | undefined>} env The process environment.
 * @returns {string} The advisory line, or "" when nothing is detected.
 */
function autoacceptAdvisory(env) {
  const configPath =
    typeof env.TURNSTILE_CLI_CONFIG === "string" && env.TURNSTILE_CLI_CONFIG
      ? env.TURNSTILE_CLI_CONFIG
      : path.join(os.homedir(), ".config", "opencode", "cli.json")
  try {
    const cfg = JSON.parse(fs.readFileSync(configPath, "utf8"))
    if (cfg?.session?.permissions !== "autoaccept") return ""
    return (
      `advisory: session.permissions is "autoaccept" in ${configPath} — permission asks are ` +
      `answered automatically, so the landing gate's human release, the plan-gate escalation, ` +
      `and the ensemble's human release are rubber-stamped; those gates degrade to delays`
    )
  } catch {
    return "" // missing/unreadable/malformed host config: nothing to report.
  }
}

/**
 * Entry point. Parses args, resolves the journal, aggregates, and prints.
 * @param {string[]} argv Arguments after the `status` subcommand.
 * @returns {Promise<number>} The process exit code.
 */
async function main(argv) {
  let flags
  try {
    flags = parseArgs(argv)
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    process.stderr.write(`${msg}\n`)
    process.stderr.write("usage: opencode-turnstile status [--json] [--check-updates]\n")
    return 2
  }
  if (flags.help) {
    process.stdout.write(`${USAGE}\n`)
    return 0
  }

  const { metricsDir, replayTailLines, observeSessions } = resolveConfig(process.env)
  const journalPath = path.join(metricsDir, "turnstile.jsonl")
  const { files, lines } = readJournal(journalPath, replayTailLines)

  const base = {
    journal: journalPath,
    files,
    noJournal: files.length === 0,
    sessions: {},
  }

  const advisory = autoacceptAdvisory(process.env)

  if (files.length === 0) {
    // Read-only no-op: nothing recorded yet.
    if (flags.json) {
      const update = flags.checkUpdates
        ? await resolveUpdateCheck(process.env, metricsDir)
        : undefined
      process.stdout.write(
        `${JSON.stringify({ ...base, ...(update ? { update } : {}), ...(advisory ? { advisories: [advisory] } : {}) }, null, 2)}\n`,
      )
    } else {
      let text = `No turnstile journal yet at ${journalPath} — nothing to report.\n`
      if (flags.checkUpdates) text += `${await updateLine(metricsDir)}\n`
      if (advisory) text += `${advisory}\n`
      process.stdout.write(text)
    }
    return 0
  }

  const { sessions, observe } = aggregate(lines)
  for (const [id, a] of sessions) {
    base.sessions[id] = a
  }

  const update = flags.checkUpdates ? await resolveUpdateCheck(process.env, metricsDir) : undefined
  if (flags.json) {
    process.stdout.write(
      `${JSON.stringify({ ...base, ...(update ? { update } : {}), ...(advisory ? { advisories: [advisory] } : {}) }, null, 2)}\n`,
    )
  } else {
    let table = renderTable(sessions, journalPath, observe, observeSessions)
    if (update) {
      const line = updateLineText(update)
      if (line) table += `\n${line}`
    }
    if (advisory) table += `\n${advisory}`
    process.stdout.write(`${table}\n`)
  }
  return 0
}

main(process.argv.slice(2)).then((code) => process.exit(code ?? 0))
