#!/usr/bin/env node
// Read-only report of turnstile gate/plan state over the JSONL journal.
//
// This is the `turnstile status` surface (issue #34): it reports, per parent
// session, what the journal says a task currently is WITHOUT touching the host
// or writing anything. It is deliberately a plain ESM script outside the 100%
// coverage gate (bin/ and scripts/ never are), and it is exercised by
// tests/status.test.ts via spawn rather than imported.
//
// Journal resolution precedence (mirrors config.ts's env → file → default):
//   TURNSTILE_METRICS_DIR  →  TURNSTILE_CONFIG's metricsDir  →  ~ default
// The journal file is `turnstile.jsonl`; its rotated generation
// `${journal}.1` is read first so the 2000-line replay tail holds across both.
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
 * Resolves the metrics directory that holds the journal, honoring the same
 * precedence the config layer uses: the TURNSTILE_METRICS_DIR env beats a
 * configured metricsDir in the TURNSTILE_CONFIG file, which beats the default.
 * @param {NodeJS.ProcessEnv} env The process environment.
 * @returns {string} The resolved metrics directory.
 */
function resolveMetricsDir(env) {
  if (typeof env.TURNSTILE_METRICS_DIR === "string" && env.TURNSTILE_METRICS_DIR) {
    return env.TURNSTILE_METRICS_DIR
  }
  const configPath =
    env.TURNSTILE_CONFIG ?? path.join(os.homedir(), ".config", "opencode", "turnstile.json")
  try {
    const cfg = JSON.parse(fs.readFileSync(configPath, "utf8"))
    if (cfg && typeof cfg.metricsDir === "string" && cfg.metricsDir) return cfg.metricsDir
  } catch {
    // missing/unreadable/malformed config: fall through to the default.
  }
  return defaultMetricsDir(env)
}

/**
 * Reads the journal file and its `.1` generation as a single oldest-first line
 * stream, applying the same 2000-line tail bound the runtime replay uses so the
 * status flags stay replay-parity. Silently tolerates a missing generation.
 * @param {string} journalPath Absolute path of `turnstile.jsonl`.
 * @returns {{ files: string[], lines: string[] }} The files read and their lines.
 */
function readJournal(journalPath) {
  const generations = [`${journalPath}.1`, journalPath].filter((p) => fs.existsSync(p))
  if (generations.length === 0) return { files: [], lines: [] }
  const lines = generations.flatMap((p) => fs.readFileSync(p, "utf8").split("\n").filter(Boolean))
  return { files: generations.map((p) => path.basename(p)), lines: lines.slice(-2000) }
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
 * gate/plan last-wins rules as state.ts's replayGatePasses: a trailing
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
      a.dispatches++
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

  const metricsDir = resolveMetricsDir(process.env)
  const journalPath = path.join(metricsDir, "turnstile.jsonl")
  const { files, lines } = readJournal(journalPath)

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
