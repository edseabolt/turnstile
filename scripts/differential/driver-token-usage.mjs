/**
 * @fileoverview Differential scenario `token-usage`: boots the full plugin
 * over the fake host and pushes `message.updated` events in the REAL host's
 * shape (the session ID only inside the snapshot, `info.sessionID`; no
 * top-level `sessionID`) plus `session.idle`, then diffs both trees'
 * journaled entries and `status` token output as normalized cells.
 *
 * Expected characterization: a tree without the session-ID fallback journals
 * no `token-usage` rows and no status token cells; a fixed tree shows the
 * rollup row and the status token block as NEW-IN-HEAD growth.
 *
 * Stateful — runs one subprocess per tree.
 */

import { spawnSync } from "node:child_process"
import * as path from "node:path"
import {
  emit,
  importFrom,
  isolatedEnv,
  makeFakeHost,
  normalize,
  readJournal,
  tmpMetricsDir,
} from "./driver-lib.mjs"

/** The fixture session ID pushed through the fake host. */
const SID = "p1"

/**
 * Normalizes one journal entry for comparison: drops `ts` and the
 * release-varying identity fields, replaces path-valued `sessionID`/
 * `metricsDir` with their types, and keeps everything else (same contract as
 * the `journal` scenario's normalizer).
 * @param {Record<string, unknown>} entry The parsed entry.
 * @returns {unknown} The normalized entry.
 */
function normalizeEntry(entry) {
  const {
    ts: _ts,
    sessionID,
    metricsDir,
    version: _version,
    plugin: _plugin,
    digest: _digest,
    ...rest
  } = entry
  return normalize({
    ...rest,
    sessionID: typeof sessionID,
    metricsDir: typeof metricsDir,
  })
}

/**
 * Replaces the fixture session ID with a sentinel in keys and string values,
 * so temp-unique session IDs never leak into a cell comparison.
 * @param {unknown} value The value to normalize.
 * @returns {unknown} The JSON-safe clone with the session ID masked.
 */
function maskSessionID(value) {
  if (Array.isArray(value)) return value.map(maskSessionID)
  if (value !== null && typeof value === "object") {
    const out = {}
    for (const k of Object.keys(value).sort()) {
      out[k === SID ? "<sessionID>" : k] = maskSessionID(value[k])
    }
    return out
  }
  return value === SID ? "<sessionID>" : value
}

/**
 * Runs status.mjs from the tree under test against the tree's temp metrics
 * dir (the ref tree's own script reports the ref surface, so a surface the
 * HEAD tree adds diffs as NEW-IN-HEAD growth).
 * @param {string} treeRoot The tree root directory.
 * @param {string} metricsDir The temp metrics dir the boot journaled into.
 * @param {string[]} args Extra status arguments.
 * @returns {{status: number | null, stdout: string}} The spawn result.
 */
function runStatus(treeRoot, metricsDir, args) {
  const res = spawnSync(process.execPath, [path.join(treeRoot, "scripts", "status.mjs"), ...args], {
    cwd: treeRoot,
    encoding: "utf8",
    env: {
      ...process.env,
      TURNSTILE_METRICS_DIR: metricsDir,
      TURNSTILE_CLI_CONFIG: path.join(metricsDir, "absent-cli.json"),
    },
  })
  return { status: res.status, stdout: String(res.stdout ?? "") }
}

/**
 * Runs the token-usage comparison for one tree.
 * @param {string} treeRoot The tree root directory.
 * @returns {Promise<{ok: boolean, cells?: Object, code?: string, module?: string}>}
 *     The scenario result.
 */
export async function scenario(treeRoot) {
  const probe = await importFrom(treeRoot, "turnstile.ts")
  const plugin = probe.turnstile ?? probe.default
  const metricsDir = tmpMetricsDir()
  const h = makeFakeHost()
  const setup = plugin(h.host, { env: isolatedEnv(metricsDir), config: { metricsDir } })
  const dispose = await setup(h.host)
  // Two completed turns in the real host's payload shape, then the idle that
  // flushes one merged rollup row in summary mode (the default).
  for (const id of ["msg_1", "msg_2"]) {
    await h.pushEvent({
      type: "message.updated",
      data: {
        info: {
          id,
          role: "assistant",
          finish: "stop",
          tokens: { input: 10, output: 5 },
          cost: 0.01,
          sessionID: SID,
        },
      },
    })
  }
  await h.pushEvent({ type: "session.idle", data: { sessionID: SID } })
  dispose()
  const cells = {}
  const perType = {}
  for (const entry of readJournal(metricsDir)) {
    const type = String(entry.type)
    const n = perType[type] ?? 0
    perType[type] = n + 1
    cells[`token.journal.${type}.${n}`] = normalizeEntry(entry)
  }
  const jsonRes = runStatus(treeRoot, metricsDir, ["--json"])
  if (jsonRes.status === 0) {
    const json = JSON.parse(jsonRes.stdout)
    if (json.tokenUsage) cells["token.status.json"] = maskSessionID(normalize(json.tokenUsage))
  }
  const tableRes = runStatus(treeRoot, metricsDir, [])
  if (tableRes.status === 0) {
    const lines = tableRes.stdout.split("\n").filter((l) => l.startsWith("tokens"))
    if (lines.length > 0) cells["token.status.table"] = maskSessionID(lines)
  }
  return { ok: true, cells }
}

// Direct execution: `node driver-token-usage.mjs <treeRoot>` (subprocess mode).
if (process.argv[1] && import.meta.url === import.meta.resolve(process.argv[1])) {
  emit(await scenario(process.argv[2]))
}
