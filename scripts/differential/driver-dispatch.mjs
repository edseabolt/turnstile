/**
 * @fileoverview Differential scenario `dispatch`: the scripted reviewer/
 * executor dispatch sequence (see `dispatch-script.mjs`) driven through both
 * trees' full plugin boot, diffing block/allow outcomes and the exact block
 * messages (cap/round-limit/plan-gate vocabulary).
 *
 * Stateful — runs one subprocess per tree.
 */

import { emit } from "./driver-lib.mjs"
import { runDispatchScript } from "./dispatch-script.mjs"

/**
 * Runs the dispatch sequence against one tree.
 * @param {string} treeRoot The tree root directory.
 * @returns {Promise<{ok: boolean, cells?: Object, code?: string, module?: string}>}
 *     The scenario result.
 */
export async function scenario(treeRoot) {
  const res = await runDispatchScript(treeRoot)
  if (!res.ok) return res
  const cells = {}
  for (const [step, outcome] of Object.entries(res.steps)) {
    cells[`dispatch.${step}`] = outcome
  }
  return { ok: true, cells }
}

// Direct execution: `node driver-dispatch.mjs <treeRoot>` (subprocess mode).
if (process.argv[1] && import.meta.url === import.meta.resolve(process.argv[1])) {
  emit(await scenario(process.argv[2]))
}
