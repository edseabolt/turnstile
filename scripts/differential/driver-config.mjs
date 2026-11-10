/**
 * @fileoverview Differential scenario `config`: the full `defaultConfig()`
 * scalar key set × a fixed value matrix through `mergeConfig`, diffing the
 * resolved value AND the exact warning strings per cell. This is the probe
 * family that caught the boolean-key regression (#263 follow-up): a numeric
 * value on a boolean key must warn and keep the default, never store.
 *
 * Pure functions only — runs in-process against both trees.
 */

import { emit, withModules } from "./driver-lib.mjs"

/** The fixed value matrix from the issue text (order-stable labels below). */
const VALUES = [
  true,
  false,
  0,
  1,
  2,
  -1,
  1.5,
  "",
  "x",
  "/abs",
  "on",
  "quiet",
  "off",
  "ask",
  "block",
  "enforce",
  "flag",
  "advise",
  null,
  undefined,
  [],
  {},
]

/**
 * Renders a stable label for a matrix value.
 * @param {unknown} value The matrix value.
 * @returns {string} The label used in the cell key.
 */
function valueLabel(value) {
  if (value === undefined) return "undefined"
  return JSON.stringify(value) ?? String(value)
}

/**
 * The scalar (non-object) top-level keys of a default config.
 * @param {Record<string, unknown>} base The tree's default config.
 * @returns {string[]} The scalar key names in declaration order.
 */
function scalarKeys(base) {
  return Object.keys(base).filter((k) => base[k] === null || typeof base[k] !== "object")
}

/**
 * Runs the config matrix against one tree.
 * @param {string} treeRoot The tree root directory.
 * @returns {Promise<{ok: boolean, cells?: Object, code?: string, module?: string}>}
 *     The scenario result.
 */
export async function scenario(treeRoot) {
  return withModules(treeRoot, ["src/config.ts"], async (modules) => {
    const config = modules["src/config.ts"]
    const base = config.defaultConfig({})
    const cells = {}
    for (const key of scalarKeys(base)) {
      for (const value of VALUES) {
        const { config: merged, warnings } = config.mergeConfig(base, { [key]: value })
        cells[`config.${key}=${valueLabel(value)}`] = {
          resolved: merged[key] === undefined ? "<<undefined>>" : merged[key],
          warnings,
        }
      }
    }
    return cells
  })
}

// Direct execution: `node driver-config.mjs <treeRoot>` (subprocess mode).
if (process.argv[1] && import.meta.url === import.meta.resolve(process.argv[1])) {
  emit(await scenario(process.argv[2]))
}
