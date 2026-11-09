/**
 * @fileoverview Differential scenario `journal`: re-runs the scripted
 * dispatch sequence and diffs both trees' JSONL entries as normalized
 * objects — `ts` values and `sessionID` values are ignored (compared as
 * types only), everything else (entry types, counts, key sets, all other
 * fields) must match.
 *
 * Stateful — runs one subprocess per tree.
 */

import { emit, normalize } from "./driver-lib.mjs"
import { runDispatchScript } from "./dispatch-script.mjs"

/**
 * Normalizes one journal entry for comparison: drops `ts` and the
 * release-varying identity fields (`version`, `plugin`, `digest`), replaces
 * path-valued `sessionID`/`metricsDir` with their types, and keeps everything
 * else. The identity fields name the plugin release, not behavior, so a
 * version bump between ref and HEAD is not a characterization divergence.
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
 * Runs the journal-shape comparison for one tree. Cells are keyed per entry
 * type and per-type occurrence index (not global index): rows a newer tree
 * adds (e.g. `prov:*`) shift global indices, so per-type keying lets the
 * harness report them as NEW-IN-HEAD growth instead of a cascade of
 * index-shift divergences.
 * @param {string} treeRoot The tree root directory.
 * @returns {Promise<{ok: boolean, cells?: Object, code?: string, module?: string}>}
 *     The scenario result.
 */
export async function scenario(treeRoot) {
  const res = await runDispatchScript(treeRoot)
  if (!res.ok) return res
  const cells = {}
  const perType = {}
  for (const entry of res.entries) {
    const type = String(entry.type)
    const n = perType[type] ?? 0
    perType[type] = n + 1
    cells[`journal.${type}.${n}`] = normalizeEntry(entry)
  }
  return { ok: true, cells }
}

// Direct execution: `node driver-journal.mjs <treeRoot>` (subprocess mode).
if (process.argv[1] && import.meta.url === import.meta.resolve(process.argv[1])) {
  emit(await scenario(process.argv[2]))
}
