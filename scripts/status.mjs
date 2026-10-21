#!/usr/bin/env node
// Read-only report of turnstile gate/plan state over the JSONL journal.
//
// This is the `turnstile status` surface: it reports, per parent
// session, what the journal says a task currently is WITHOUT touching the host
// or writing anything. It is deliberately a plain ESM script outside the 100%
// coverage gate (bin/ and scripts/ never are), and it is exercised by
// tests/status.test.ts via spawn rather than imported.
//
// Journal resolution precedence (mirrors config.ts's env → file → default):
//   TURNSTILE_METRICS_DIR  →  TURNSTILE_CONFIG's metricsDir  →  ~ default
// The journal file is `turnstile.jsonl`; its rotated generation
// `${journal}.1` is read first so the `replayTailLines` replay tail (default
// 2000) holds across both.
//
//   opencode-turnstile status            Human-readable table.
//   opencode-turnstile status --json     Machine-readable JSON.
//   opencode-turnstile status --help     This usage. Unknown flags exit 2.

import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"

const USAGE = `Usage: opencode-turnstile status [--json]

Reports turnstile gate and plan state per parent session, read from the
JSONL journal. Read-only: nothing is written. The journal reflects the last
prompt-cycle; in-memory state can be fresher.

Options:
  --json    Print machine-readable JSON instead of the table
  --help    Show this help`

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
 * Resolves both the metrics directory and the replay tail bound the status
 * surface uses. The config file is parsed once (silently-failing, fail-open)
 * and always supplies the replay tail bound; the TURNSTILE_METRICS_DIR env
 * overrides only the metrics directory (precedence env → file → default).
 * @param {NodeJS.ProcessEnv} env The process environment.
 * @returns {{ metricsDir: string, replayTailLines: number }} The resolved values.
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
  return { metricsDir, replayTailLines: resolveReplayTailLines(config?.replayTailLines) }
}

/**
 * Reads the journal file and its `.1` generation as a single oldest-first line
 * stream, applying the same `replayTailLines` tail bound (default 2000) the
 * runtime replay uses so the status flags stay replay-parity. Silently
 * tolerates a missing generation.
 * @param {string} journalPath Absolute path of `turnstile.jsonl`.
 * @param {number} tailLines The replay tail bound in lines to keep.
 * @returns {{ files: string[], lines: string[] }} The files read and their lines.
 */
function readJournal(journalPath, tailLines) {
  const generations = [`${journalPath}.1`, journalPath].filter((p) => fs.existsSync(p))
  if (generations.length === 0) return { files: [], lines: [] }
  const lines = generations.flatMap((p) => fs.readFileSync(p, "utf8").split("\n").filter(Boolean))
  return { files: generations.map((p) => path.basename(p)), lines: lines.slice(-tailLines) }
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
  }
}

/**
 * Aggregates the journal lines into per-session status. Replays the same
 * gate/plan last-wins rules as ledger.ts's replayGatePasses: a trailing
 * `GATE: FAIL` keeps the gate red, an enforce-mode `verified:false` PASS never
 * flips, and a `type:plan` APPROVE restores plan approval. Malformed lines are
 * skipped. Parent-keyed.
 * @param {string[]} lines Journal lines, oldest-first.
 * @returns {Map<string, Record<string, unknown>>} sessionID → accumulator.
 */
function aggregate(lines) {
  const sessions = new Map()
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
    const sid = typeof e.sessionID === "string" && e.sessionID ? e.sessionID : ""
    if (!sid) continue
    const a = forSession(sid)
    const type = e.type
    const result = e.result

    if (type === "gate") {
      // Gate flags restored exactly like replayGatePasses: last flipping result
      // wins; an enforce-mode unverified PASS neither flips here nor at runtime.
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
      const marker = typeof e.marker === "string" && e.marker ? e.marker : ""
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
    }
  }

  return sessions
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
 * Renders the human-readable table.
 * @param {Map<string, Record<string, unknown>>} sessions Aggregated sessions.
 * @param {string} journalPath The journal file path for the header.
 * @returns {string} The table text.
 */
function renderTable(sessions, journalPath) {
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
  }))

  const headers = ["SESSION", "GATE", "PLAN", "VERDICT", "WV", "DIS", "BLK", "PERM"]
  const cells = [
    (r) => r.session,
    (r) => r.gate,
    (r) => r.plan,
    (r) => r.verdict,
    (r) => String(r.wv),
    (r) => String(r.dis),
    (r) => String(r.bl),
    (r) => `${r.ask}/${r.dec}`,
  ]

  const widths = headers.map((h, i) => Math.max(h.length, ...rows.map((r) => cells[i](r).length)))
  const line = (vals) =>
    vals
      .map((v, i) => v.padEnd(widths[i]))
      .join("  ")
      .replace(/\s+$/, "")

  const out = [`turnstile status — ${journalPath}`]
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
 * Parses the status arguments. Recognizes --json and --help; anything else is
 * an unknown flag and fails with exit code 2.
 * @param {string[]} argv Arguments after the `status` subcommand.
 * @returns {{ json: boolean, help: boolean }} Parsed flags.
 */
function parseArgs(argv) {
  const json = argv.includes("--json")
  const help = argv.includes("--help")
  for (const a of argv) {
    if (a === "--json" || a === "--help") continue
    throw new Error(`unknown argument "${a}"`)
  }
  return { json, help }
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
    process.stderr.write("usage: opencode-turnstile status [--json]\n")
    return 2
  }
  if (flags.help) {
    process.stdout.write(`${USAGE}\n`)
    return 0
  }

  const { metricsDir, replayTailLines } = resolveConfig(process.env)
  const journalPath = path.join(metricsDir, "turnstile.jsonl")
  const { files, lines } = readJournal(journalPath, replayTailLines)

  const base = {
    journal: journalPath,
    files,
    noJournal: files.length === 0,
    sessions: {},
  }

  if (files.length === 0) {
    // Read-only no-op: nothing recorded yet.
    if (flags.json) {
      process.stdout.write(`${JSON.stringify(base, null, 2)}\n`)
    } else {
      process.stdout.write(`No turnstile journal yet at ${journalPath} — nothing to report.\n`)
    }
    return 0
  }

  const sessions = aggregate(lines)
  for (const [id, a] of sessions) {
    base.sessions[id] = a
  }

  if (flags.json) {
    process.stdout.write(`${JSON.stringify(base, null, 2)}\n`)
  } else {
    process.stdout.write(`${renderTable(sessions, journalPath)}\n`)
  }
  return 0
}

main(process.argv.slice(2)).then((code) => process.exit(code ?? 0))
