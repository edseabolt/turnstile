/**
 * @fileoverview Differential scenario `prov`: the decision-ledger surface.
 * Builder matrix over `provStatedEntry`/`provDeniedEntry`/`provWaiverEntry`/
 * `provOverrideEntry` including exact JSON serialization (stable key order),
 * redact-then-truncate boundary cells (a secret straddling `LEDGER_TEXT_CAP`,
 * secrets inside/after the cap, path redaction before the `LEDGER_PATH_CAP`
 * cut), and the capture-wiring sequence (parent prompt, dedupe, pipeline-child
 * exclusion, permission denial, override-adjacency `child` attribution)
 * through the full plugin boot.
 *
 * Stateful (capture wiring) — runs one subprocess per tree. The module probe
 * on `src/decision-ledger.ts` is what makes pre-ledger references report
 * `SKIPPED (absent in ref)` instead of crashing.
 */

import * as path from "node:path"
import {
  callHook,
  emit,
  importFrom,
  isolatedEnv,
  makeFakeHost,
  normalize,
  readJournal,
  tmpMetricsDir,
  tmpProjectDir,
  waitUntil,
  withModules,
} from "./driver-lib.mjs"

/** The secret shapes used by the redaction cells (synthetic only). */
const SECRET = "sk-abc123DEF456ghi789JKLmno"

/**
 * Adds the builder-matrix cells: representative inputs per builder, plus the
 * exact JSON serialization (stable key order is part of the contract).
 * @param {Object} dl The tree's `src/decision-ledger.ts` module.
 * @param {Object<string, unknown>} cells The cell map to add to.
 */
function builderCells(dl, cells) {
  const stated = dl.provStatedEntry({ sessionID: "ses_1", text: "continue" })
  const denied = dl.provDeniedEntry({ sessionID: "ses_2", kind: "plan" })
  const waiver = dl.provWaiverEntry({ sessionID: "ses_3", stages: ["plan", "landing"] })
  const override = dl.provOverrideEntry({
    sessionID: "p1",
    tool: "edit",
    path: "/r/a.ts",
    child: "c1",
  })
  cells["prov.builder.stated"] = { entry: stated, json: JSON.stringify(stated) }
  cells["prov.builder.denied"] = { entry: denied, json: JSON.stringify(denied) }
  cells["prov.builder.waiver"] = { entry: waiver, json: JSON.stringify(waiver) }
  cells["prov.builder.override"] = { entry: override, json: JSON.stringify(override) }
}

/**
 * Adds the redact-then-truncate boundary cells: a secret straddling the text
 * cap must be masked before truncation (never a half-visible prefix), a
 * secret inside the cap is masked, a secret after the cap is sliced away,
 * and the override path is redacted before the path-cap cut.
 * @param {Object} dl The tree's `src/decision-ledger.ts` module.
 * @param {Object<string, unknown>} cells The cell map to add to.
 */
/**
 * Adds the straddling-cap redaction cell: a secret straddling the text cap
 * must be masked before truncation (never a half-visible prefix).
 * @param {Object} dl The tree's `src/decision-ledger.ts` module.
 * @param {Object<string, unknown>} cells The cell map to add to.
 */
function redactionStraddlingCells(dl, cells) {
  const cap = dl.LEDGER_TEXT_CAP
  const straddling = dl.provStatedEntry({
    sessionID: "s",
    text: `${"x".repeat(cap - 21)} ${SECRET} ${"x".repeat(30)}`,
  })
  cells["prov.redact.straddling-cap"] = {
    truncated: straddling.truncated,
    length: straddling.text.length,
    hasSentinel: straddling.text.includes("[REDACTED]"),
    leaksSecret: straddling.text.includes("sk-"),
  }
}

/**
 * Adds the inside/after-cap redaction cells: a secret inside the cap is
 * masked, a secret after the cap is sliced away.
 * @param {Object} dl The tree's `src/decision-ledger.ts` module.
 * @param {Object<string, unknown>} cells The cell map to add to.
 */
function redactionTextCells(dl, cells) {
  const cap = dl.LEDGER_TEXT_CAP
  const inside = dl.provStatedEntry({
    sessionID: "s",
    text: `deploy ${SECRET} now ${"x".repeat(cap)}`,
  })
  cells["prov.redact.secret-inside-cap"] = {
    truncated: inside.truncated,
    hasSentinel: inside.text.includes("[REDACTED]"),
    leaksSecret: inside.text.includes("sk-"),
  }
  const after = dl.provStatedEntry({ sessionID: "s", text: `${"x".repeat(cap + 5)} ${SECRET}` })
  cells["prov.redact.secret-after-cap"] = {
    truncated: after.truncated,
    leaksSecret: after.text.includes("sk-"),
  }
}

/**
 * Adds the path redaction cell: the override path is redacted before the
 * path-cap cut.
 * @param {Object} dl The tree's `src/decision-ledger.ts` module.
 * @param {Object<string, unknown>} cells The cell map to add to.
 */
function redactionPathCells(dl, cells) {
  const pathCap = dl.LEDGER_PATH_CAP
  const override = dl.provOverrideEntry({
    sessionID: "p1",
    tool: "write",
    path: `/r/${"a".repeat(pathCap - 200 + 189)}/${SECRET}/b.ts`,
    child: "c1",
  })
  cells["prov.redact.path-straddling-cap"] = {
    length: override.path.length,
    leaksSecret: override.path.includes("sk-"),
  }
}

/** The plan-gate ask message prefix (the evaluate handler's echo). */
const PLAN_ASK_PREFIX = "turnstile: plan approval required"

/**
 * Boots the full plugin over a fake host in a temp project dir.
 * @param {string} treeRoot The tree root directory.
 * @param {Record<string, unknown>} configExtra Extra config overrides.
 * @param {string[]} [seedLines] Raw journal lines seeded before setup, so the
 *     boot replay restores state from them (e.g. a `child-edge` row).
 * @returns {Promise<{h: Object, dispose: () => void, metricsDir: string}>} The boot.
 */
async function boot(treeRoot, configExtra = {}, seedLines = []) {
  const plugin = await importFrom(treeRoot, "turnstile.ts")
  const turnstile = plugin.turnstile
  const metricsDir = tmpMetricsDir()
  if (seedLines.length > 0) {
    const { writeFileSync, mkdirSync } = await import("node:fs")
    writeFileSync(path.join(metricsDir, "turnstile.jsonl"), seedLines.join("\n") + "\n")
    mkdirSync(path.join(metricsDir, "sessions"), { recursive: true })
  }
  const project = tmpProjectDir()
  const prevCwd = process.cwd()
  process.chdir(project)
  const h = makeFakeHost()
  const setup = turnstile(h.host, {
    env: isolatedEnv(metricsDir),
    config: { metricsDir, alwaysEnforce: false, ...configExtra },
  })
  const dispose = await setup(h.host)
  return {
    h,
    metricsDir,
    dispose: () => {
      dispose()
      process.chdir(prevCwd)
    },
  }
}

/**
 * The `prov:*` rows of a metrics dir with `ts` normalized away.
 * @param {string} metricsDir The metrics dir.
 * @returns {Array<Object>} The normalized prov rows in journal order.
 */
function provRows(metricsDir) {
  return readJournal(metricsDir)
    .filter((e) => String(e.type).startsWith("prov:"))
    .map((e) => normalize({ ...e, ts: typeof e.ts }))
}

/**
 * Waits until the journal holds the given number of prov rows.
 * @param {string} metricsDir The metrics dir.
 * @param {number} n The expected row count.
 * @returns {Promise<void>} Resolves when reached; throws on timeout.
 */
async function awaitProvRows(metricsDir, n) {
  await waitUntil(() => provRows(metricsDir).length >= n)
}

/**
 * Adds the capture-wiring cells: parent prompt capture, dual-transport
 * dedupe, pipeline-child exclusion (via a replayed `child-edge` row),
 * permission-denial capture, and override-adjacency attribution.
 * @param {string} treeRoot The tree root directory.
 * @param {Object<string, unknown>} cells The cell map to add to.
 */
/**
 * The `child-edge` journal row seeding a pipeline-child session `c1` under
 * parent `p1` (used by the exclusion and adjacency boots).
 */
const CHILD_EDGE_SEED = JSON.stringify({
  ts: "t",
  type: "child-edge",
  sessionID: "c1",
  parent: "p1",
  agent: "executor",
})

/**
 * Runs the prompt-dedupe and permission-denial boot: two identical parent
 * prompts capture once, and a rejected plan-gate permission is captured as
 * a denial.
 * @param {string} treeRoot The tree root directory.
 * @param {Object<string, unknown>} cells The cell map to add to.
 */
async function promptDedupeCells(treeRoot, cells) {
  const b = await boot(treeRoot, { alwaysEnforce: true })
  try {
    await callHook(b.h.sessionHooks, "prompt", {
      sessionID: "p1",
      text: "deploy with AKIAIOSFODNN7EXAMPLE now",
      messageID: "m1",
    })
    await callHook(b.h.sessionHooks, "prompt", {
      sessionID: "p1",
      text: "deploy with AKIAIOSFODNN7EXAMPLE now",
      messageID: "m1",
    })
    await awaitProvRows(b.metricsDir, 1)
    cells["prov.capture.prompt-dedupe"] = provRows(b.metricsDir)

    await b.h.pushEvent({
      type: "permission.asked",
      properties: { id: "r1", sessionID: "p1", message: `${PLAN_ASK_PREFIX} — plan.md` },
    })
    await b.h.pushEvent({
      type: "permission.replied",
      properties: { sessionID: "p1", requestID: "r1", reply: "reject" },
    })
    await awaitProvRows(b.metricsDir, 2)
    cells["prov.capture.denied"] = provRows(b.metricsDir)
  } finally {
    b.dispose()
  }
}

/**
 * Drives one tool call's before/after hooks through the recorded tables.
 * @param {Object} toolHooks The recorded tool hook table.
 * @param {string} tool The tool name.
 * @param {string} sessionID The calling session.
 * @param {Object} extra Extra hook payload fields (e.g. `agent`).
 * @returns {Promise<void>} Resolves when both hooks finished.
 */
async function toolCall(toolHooks, tool, sessionID, extra = {}) {
  const input = { filePath: "/r/a.ts" }
  await callHook(toolHooks, "execute.before", { tool, sessionID, ...extra, input })
  await callHook(toolHooks, "execute.after", { tool, sessionID, ...extra, input })
}

/**
 * Runs the override-adjacency boot: a pipeline-child write followed by a
 * parent edit attributes the override to the child via the replayed
 * `child-edge` row.
 * @param {string} treeRoot The tree root directory.
 * @param {Object<string, unknown>} cells The cell map to add to.
 */
async function overrideAdjacencyCells(treeRoot, cells) {
  const b = await boot(treeRoot, { alwaysEnforce: false }, [CHILD_EDGE_SEED])
  try {
    await toolCall(b.h.toolHooks, "write", "c1", { agent: "executor" })
    await toolCall(b.h.toolHooks, "edit", "p1")
    await awaitProvRows(b.metricsDir, 1)
    cells["prov.capture.override-adjacency"] = provRows(b.metricsDir)
  } finally {
    b.dispose()
  }
}

/**
 * Runs the child-exclusion boot: a prompt on a pipeline-child session is
 * never captured as a parent statement.
 * @param {string} treeRoot The tree root directory.
 * @param {Object<string, unknown>} cells The cell map to add to.
 */
async function childExclusionCells(treeRoot, cells) {
  const b = await boot(treeRoot, { alwaysEnforce: true }, [CHILD_EDGE_SEED])
  try {
    await callHook(b.h.sessionHooks, "prompt", {
      sessionID: "c1",
      text: "a pipeline-child dispatch prompt",
    })
    await new Promise((resolve) => setTimeout(resolve, 50))
    cells["prov.capture.child-prompt-excluded"] = provRows(b.metricsDir)
  } finally {
    b.dispose()
  }
}

/**
 * Adds the capture-wiring cells: parent prompt capture, dual-transport
 * dedupe, pipeline-child exclusion (via a replayed `child-edge` row),
 * permission-denial capture, and override-adjacency attribution.
 * @param {string} treeRoot The tree root directory.
 * @param {Object<string, unknown>} cells The cell map to add to.
 */
async function captureCells(treeRoot, cells) {
  await promptDedupeCells(treeRoot, cells)
  await overrideAdjacencyCells(treeRoot, cells)
  await childExclusionCells(treeRoot, cells)
}

/**
 * Runs the prov scenario against one tree.
 * @param {string} treeRoot The tree root directory.
 * @returns {Promise<{ok: boolean, cells?: Object, code?: string, module?: string}>}
 *     The scenario result.
 */
export async function scenario(treeRoot) {
  return withModules(treeRoot, ["src/decision-ledger.ts"], async (modules) => {
    const cells = {}
    const dl = modules["src/decision-ledger.ts"]
    builderCells(dl, cells)
    redactionStraddlingCells(dl, cells)
    redactionTextCells(dl, cells)
    redactionPathCells(dl, cells)
    await captureCells(treeRoot, cells)
    return cells
  })
}

// Direct execution: `node driver-prov.mjs <treeRoot>` (subprocess mode).
if (process.argv[1] && import.meta.url === import.meta.resolve(process.argv[1])) {
  emit(await scenario(process.argv[2]))
}
