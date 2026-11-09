/**
 * @fileoverview The scripted dispatch sequence shared by the `dispatch` and
 * `journal` scenarios: boots the full plugin (`turnstile.ts`) over a minimal
 * fake host in a temp project dir, drives a waiver-scoped reviewer sequence
 * plus an executor dispatch through the real hooks, and returns the per-step
 * block/allow outcomes and the journaled entries. Stateful — always runs one
 * subprocess per tree.
 */

import * as path from "node:path"
import {
  callHook,
  importFrom,
  isolatedEnv,
  makeFakeHost,
  readJournal,
  tmpMetricsDir,
  tmpProjectDir,
} from "./driver-lib.mjs"

/**
 * Attempts one task dispatch through the recorded `execute.before` hook,
 * capturing a block as its message.
 * @param {{toolHooks: Object}} h The fake host tables.
 * @param {string} agent The dispatched agent name.
 * @param {string} prompt The dispatch prompt.
 * @returns {Promise<{blocked: boolean, message: string}>} The outcome.
 */
async function attempt(h, agent, prompt) {
  try {
    await callHook(h.toolHooks, "execute.before", {
      tool: "task",
      sessionID: "p1",
      input: { agent, prompt },
    })
    return { blocked: false, message: "" }
  } catch (e) {
    return { blocked: true, message: String(e.message) }
  }
}

/**
 * Sends one user prompt through the recorded session prompt hook.
 * @param {{sessionHooks: Object}} h The fake host tables.
 * @param {string} text The prompt text.
 * @returns {Promise<void>} Resolves when admission finished.
 */
async function prompt(h, text) {
  await callHook(h.sessionHooks, "prompt", { sessionID: "p1", text })
}

/**
 * Runs the scripted dispatch sequence against one tree.
 * @param {string} treeRoot The tree root directory.
 * @returns {Promise<{ok: boolean, steps?: Object, entries?: Array<Object>, code?: string, module?: string}>}
 *     The step outcomes and the journal entries.
 */
/**
 * Seeds the temp project with a plan file so the executor dispatch's
 * plan-gate block is deterministic (a planless project fails the gate open).
 * @param {string} project The temp project directory.
 * @returns {Promise<void>} Resolves when the plan file is written.
 */
async function seedPlan(project) {
  const { mkdirSync, writeFileSync } = await import("node:fs")
  mkdirSync(path.join(project, ".opencode", "plans"), { recursive: true })
  writeFileSync(path.join(project, ".opencode", "plans", "plan.md"), "# P\n")
}

/**
 * Runs the scripted dispatch sequence against one tree.
 * @param {string} treeRoot The tree root directory.
 * @returns {Promise<{ok: boolean, steps?: Object, entries?: Array<Object>, code?: string, module?: string}>}
 *     The step outcomes and the journal entries.
 */
export async function runDispatchScript(treeRoot) {
  const probe = await importFrom(treeRoot, "turnstile.ts")
  const plugin = probe.turnstile ?? probe.default
  const metricsDir = tmpMetricsDir()
  const project = tmpProjectDir()
  await seedPlan(project)
  const prevCwd = process.cwd()
  process.chdir(project)
  try {
    const h = makeFakeHost()
    const setup = plugin(h.host, {
      env: isolatedEnv(metricsDir),
      config: { metricsDir, alwaysEnforce: true, maxReviewerRounds: 1 },
    })
    const dispose = await setup(h.host)
    const steps = {}
    steps["step1-no-gate-pass"] = await attempt(h, "reviewer", "review it")
    await prompt(h, "USER WAIVER: reviewer")
    steps["step2-waived-reviewer"] = await attempt(h, "reviewer", "review it")
    steps["step3-waiver-allowance-spent"] = await attempt(h, "reviewer", "review it")
    steps["step4-executor-plan-gate"] = await attempt(h, "executor", "implement chunk-1")
    dispose()
    return { ok: true, steps, entries: readJournal(metricsDir) }
  } finally {
    process.chdir(prevCwd)
  }
}
