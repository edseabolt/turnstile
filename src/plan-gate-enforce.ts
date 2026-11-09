/**
 * @fileoverview Plan-gate enforcement: the decomposition gate (executor
 * dispatches must cite the chunk-N / AC-n they implement when the resolved
 * plan carries a `## Decomposition` block) and the plan-approval gate
 * (executor dispatches require a current plan-reviewer `VERDICT: APPROVE` or
 * a waiver for the plans the dispatch resolves). Extracted from
 * `src/gates-plan.ts`; the red-status mirror it escalates from lives in
 * `src/plan-gate-status.ts`. Functions here either return normally or throw
 * a deliberate BLOCKED error; every other failure fails open (unreadable
 * plan dirs are journaled, never fatal).
 */

import * as fs from "node:fs"

import type { Journaler } from "./journal.ts"
import type { GateLedger } from "./ledger.ts"
import type { GateState, TurnstileConfig } from "./types.ts"
import { BlockError, journalProvWaiver, waiverCovers, waiverStateNote } from "./gates-common.ts"
import type { PlanGateRed } from "./plan-gate-status.ts"
import { decompFallback, planGateStages, referencedPlans } from "./plan-gate-status.ts"
import { journalPlansUnreadable, type PlansScan } from "./plans-scan.ts"

/**
 * The plans a decomposition-gate dispatch resolves, in exclusive fallback
 * order: the prompt's unique referenced existing plan, else the session's
 * bound plan when it still exists, else the decomposition fallback
 * (byte-identical to the legacy rule, including no-ledger calls).
 * @param scan The current plans-dir scan.
 * @param prompt The dispatch prompt text.
 * @param s The session's gate state, or null on a no-ledger call.
 * @param projectDir The current project directory (the scope key).
 * @param sessionID The parent session ID.
 * @param ledger The optional gate ledger.
 * @returns The resolved target plan name, or null when nothing resolves.
 */
function resolveDecompTarget(
  scan: PlansScan,
  prompt: string,
  s: GateState | null,
  projectDir: string,
  sessionID: string,
  ledger?: GateLedger,
): string | null {
  const ref = s !== null ? referencedPlans(prompt, scan) : []
  const named = ref.length === 1 ? ref[0]! : null
  const bound =
    named === null && s !== null && s.approvedPlan !== "" && scan.names.includes(s.approvedPlan)
      ? s.approvedPlan
      : null
  return named ?? bound ?? decompFallback(scan, projectDir, sessionID, ledger)
}

/**
 * Journals the `plan WAIVED` entry + trace for a waiver-covered executor
 * dispatch. No `scope` stamp: this entry's shape never carries one (the
 * reviewer gate's WAIVED entry stamps the parsed scope when scoped).
 * Provenance: the waiver opened the gate from the user prompt, not a
 * dispatch prompt. The waiver quote carries raw prompt context and is
 * already trace-gated by the prompt-hook capture (SECURITY.md redaction
 * contract). The decision-ledger row carries only the covered stages
 * (no waiver text).
 * @param st The plan-gate enforcement state (journaler, config, stages).
 * @param sessionID The parent session ID.
 * @param s The gate state carrying the live waiver.
 */
function journalPlanWaiver(st: PlanGateEnforceState, sessionID: string, s: GateState): void {
  const { journaler } = st
  journaler.journal({
    type: "plan",
    sessionID,
    result: "WAIVED",
    channel: "prompt",
    waiver: s.userWaiver,
  })
  journaler.traceEvent("user", "plan-waiver", s.userWaiver, sessionID)
  journalProvWaiver(st.journaler, st.config, sessionID, st.stages)
}

/**
 * The English enumeration of plan names for the plan-gate block message:
 * a single name as-is, two names joined with " or ", three or more as an
 * Oxford list ("a, b, or c"). Red status implies at least one blocker, so
 * the first branch handles only the single-name case in practice.
 * @param names The plan names to enumerate, in enumeration order (≥ 1).
 * @returns The enumeration phrase.
 */
function listPhrase(names: string[]): string {
  if (names.length <= 1) return names[0]!
  if (names.length === 2) return `${names[0]} or ${names[1]}`
  return `${names.slice(0, -1).join(", ")}, or ${names[names.length - 1]}`
}

/**
 * Journals one plan-gate blocked row for an executor dispatch.
 * @param config The resolved plugin configuration (the executor agent name).
 * @param journaler The telemetry writer.
 * @param sessionID The parent session ID.
 * @param plan The plan the row names (the first blocker's preview file).
 * @param reason The blocked reason (`no-plan-verdict` or
 *     `durable-key-stale`).
 */
function journalPlanBlocked(
  config: TurnstileConfig,
  journaler: Journaler,
  sessionID: string,
  plan: string,
  reason: "no-plan-verdict" | "durable-key-stale",
): void {
  journaler.journal({ type: "blocked", sessionID, agent: config.agents.executor, reason, plan })
}

/**
 * Journals the blocked row and throws the BLOCKED error for a red plan
 * gate, branched on the pending cause: `never-approved` keeps the
 * no-approval row and message byte-identical to the pre-scheme behavior;
 * `durable-key-stale` journals the distinct reason and names the
 * one-re-approval recovery (the record matches neither key scheme, so one
 * re-approval re-keys it). Both messages share the verdict-marker/waiver
 * tail (one copy — the escape ladder is the same).
 * @param config The resolved plugin configuration.
 * @param journaler The telemetry writer.
 * @param sessionID The parent session ID.
 * @param s The session's gate state (the waiver-state note's source).
 * @param status The red plan-gate status (blockers, summary, cause).
 */
function blockPlanGate(
  config: TurnstileConfig,
  journaler: Journaler,
  sessionID: string,
  s: GateState,
  status: PlanGateRed,
): never {
  const plan = status.summary.file
  const phrase = listPhrase(status.blockers.map((n) => `"${n}"`))
  const tail =
    "`VERDICT: APPROVE crit=<n> high=<n> med=<n> low=<n>`, or obtain an explicit user waiver " +
    `(a user prompt this task must contain the literal marker '${config.waiverMarker}' followed by the user's words).` +
    waiverStateNote(s, `${config.agents.executor} or ${config.agents.planReviewer}`)
  if (status.cause === "durable-key-stale") {
    journalPlanBlocked(config, journaler, sessionID, plan, "durable-key-stale")
    throw new BlockError(
      `BLOCKED by turnstile: the durable plan approval for ${phrase} no longer covers the plan's current content (the plan changed after it was approved, or the approval was recorded under an obsolete key scheme). One ${config.agents.planReviewer} re-approval re-keys it: dispatch the ${config.agents.planReviewer} subagent; proceed with ${config.agents.executor} only after the ${config.agents.planReviewer}'s first line is ` +
        tail,
      "plan-gate",
    )
  }
  journalPlanBlocked(config, journaler, sessionID, plan, "no-plan-verdict")
  throw new BlockError(
    `BLOCKED by turnstile: no plan approval for ${phrase}. Dispatch the ${config.agents.planReviewer} subagent first; proceed with ${config.agents.executor} only after the ${config.agents.planReviewer}'s first line is ` +
      tail,
    "plan-gate",
  )
}

/**
 * The state shared by the plan-gate enforcement bodies: the resolved config,
 * the journaler, the instance-local plans-scan cache, the gate's stage
 * group, and the status mirror capability.
 */
interface PlanGateEnforceState {
  /** The resolved plugin configuration. */
  config: TurnstileConfig
  /** The telemetry writer for gate and blocked entries. */
  journaler: Journaler
  /** The instance-local plans-dir scan cache. */
  cache: { get(dir: string): PlansScan; resolvePlansDir(projectDir: string): string }
  /** The plan gate's guarding stage group (see {@link planGateStages}). */
  stages: string[]
  /** The status mirror capability (`planGateStatus`). */
  status: {
    planGateStatus(
      projectDir: string,
      ledger: GateLedger,
      sessionID: string,
      prompt?: string,
    ): { red: false } | PlanGateRed
  }
}

/**
 * Enforces the decomposition gate: when the resolved plan carries a
 * `## Decomposition` block, executor dispatches must cite the chunk-N
 * (or sub-chunk `chunk-Na`) / AC-n they implement. The resolved plan is
 * the dispatch prompt's named plan when it names exactly one existing
 * plan file, else the session's bound plan when it still exists, else the
 * first sorted decomposed plan that is still pending (a durably-approved
 * decomposed plan no longer forces chunk citations for unrelated work);
 * a no-ledger call enforces the first sorted decomposed plan
 * byte-identically (the legacy rule). Unreadable plans dirs fail open.
 * @param st The shared plan-gate enforce state.
 * @param sessionID The parent session ID (used in journal entries).
 * @param prompt The dispatch prompt text to check for chunk citations.
 * @param projectDir The current project directory.
 * @param ledger Optional gate ledger for active-plan resolution (session
 *     binding or prompt naming); when absent the legacy first-sorted rule
 *     applies.
 * @throws Error with a `BLOCKED by turnstile:` prefix when the resolved
 *     plan carries a decomposition and the prompt cites no chunk.
 */
function enforceDecomposition(
  st: PlanGateEnforceState,
  sessionID: string,
  prompt: string,
  projectDir: string,
  ledger?: GateLedger,
): void {
  if (/\b(?:chunk-\d+[a-z]?|AC-\d+)\b/.test(prompt)) return
  const plansDir = st.cache.resolvePlansDir(projectDir)
  try {
    if (!fs.existsSync(plansDir)) return
    const scan = st.cache.get(plansDir)
    const s = ledger ? ledger.state(sessionID) : null
    const target = resolveDecompTarget(scan, prompt, s, projectDir, sessionID, ledger)
    if (target !== null && scan.decomp.has(target)) {
      st.journaler.journal({
        type: "blocked",
        sessionID,
        agent: st.config.agents.executor,
        reason: "missing-chunk-ref",
        plan: target,
      })
      throw new BlockError(
        `BLOCKED by turnstile: plan "${target}" has a ## Decomposition block — executor dispatches must cite the chunk-N / AC-n they implement.`,
        "plan-gate",
      )
    }
  } catch (e) {
    if (e instanceof BlockError) throw e
    // Journal the fail-open so an unreadable plans dir stays observable.
    journalPlansUnreadable(st.journaler, e)
  }
}

/**
 * Enforces the plan-approval gate: executor dispatches require a current
 * plan-reviewer `VERDICT: APPROVE` for the session (or a waiver) for the
 * plans the dispatch resolves — the prompt-referenced existing plans, else
 * the session's bound plan, else (nothing resolvable) every pending plan;
 * a plans dir holding only unrelated stale plans no longer blocks a
 * dispatch whose own plan approval is live. A plan
 * is pending when its bytes carry no live durable, project-scoped approval in
 * the ledger's approval store — a legacy whole-file record whose bytes are
 * unchanged is live (and transparently re-keyed); a record matching neither
 * key scheme is pending with the distinct `durable-key-stale` cause and
 * recovery message, everything else with `no-plan-verdict` — so a
 * byte-identical plan's exemption
 * survives replay-aging, a process restart, and a new-task-scope reset. A
 * bound approval (the session's plan identity) is invalidated only when
 * THAT plan's content changes or the file disappears; unbound approvals
 * invalidate on any plans-dir change (the dir-signature rule). A stale
 * verdict is dropped loudly, journaling a replay-inert `STALE` plan entry
 * rather than a silent mismatch. The blocker set is an exclusive
 * fallback, not a union: the prompt-referenced pending plans in prompt
 * order if any referenced plan is pending, else the session-bound pending
 * plan, else (nothing resolvable) every pending plan in sorted scan
 * order.
 * The waiver is the task's prompt-channel waiver
 * (`ledger.state().userWaiver`, captured from the user prompt): a waiver
 * covers every gate while unscoped (the reviewer gate consumes an unscoped
 * waiver on the first dispatch it unlocks); naming configured agent names
 * in the waiver text scopes it to those stages' gates — this gate is
 * covered by either its plan-reviewer or executor stage name — and a
 * scoped waiver stays live until that stage's waiver allowance is spent,
 * metered separately from the ordinary dispatch caps; the waiver holds for
 * the whole task scope, a task-scope change drops it. A waiver covering
 * this gate is never consumed (the plan gate is sticky).
 * @param st The shared plan-gate enforce state.
 * @param sessionID The parent session ID.
 * @param projectDir The current project directory.
 * @param ledger The gate ledger to read and mutate plan state from.
 * @param prompt Optional dispatch prompt text for active-plan resolution.
 * @throws Error with a `BLOCKED by turnstile:` prefix when the plans the
 *     dispatch resolves are pending (no live approval covers them).
 */
function enforcePlanApproval(
  st: PlanGateEnforceState,
  sessionID: string,
  projectDir: string,
  ledger: GateLedger,
  prompt?: string,
): void {
  const s = ledger.state(sessionID)
  if (waiverCovers(s, st.stages)) {
    journalPlanWaiver(st, sessionID, s)
    return
  }
  const gateStatus = st.status.planGateStatus(projectDir, ledger, sessionID, prompt)
  // status.red ⇒ summary and blockers are present: the red branch builds the
  // summary from blockers[0]'s preview, so the journal keeps naming it.
  if (gateStatus.red) blockPlanGate(st.config, st.journaler, sessionID, s, gateStatus)
}

/**
 * Creates the plan-gate enforcement functions, bound to one resolved config +
 * journaler + plans-scan cache + status mirror. The bodies live at module
 * level; the factory only builds the shared state object.
 * @param config The resolved plugin configuration.
 * @param journaler The telemetry writer for gate and blocked entries.
 * @param cache The instance-local plans-dir scan cache.
 * @param status The status mirror capability (`planGateStatus`).
 * @returns `enforceDecomposition` and `enforcePlanApproval`.
 */
export function createPlanGateEnforce(
  config: TurnstileConfig,
  journaler: Journaler,
  cache: { get(dir: string): PlansScan; resolvePlansDir(projectDir: string): string },
  status: {
    planGateStatus(
      projectDir: string,
      ledger: GateLedger,
      sessionID: string,
      prompt?: string,
    ): { red: false } | PlanGateRed
  },
): {
  enforceDecomposition(
    sessionID: string,
    prompt: string,
    projectDir: string,
    ledger?: GateLedger,
  ): void
  enforcePlanApproval(
    sessionID: string,
    projectDir: string,
    ledger: GateLedger,
    prompt?: string,
  ): void
} {
  const st: PlanGateEnforceState = {
    config,
    journaler,
    cache,
    stages: planGateStages(config),
    status,
  }
  return {
    enforceDecomposition: (sessionID, prompt, projectDir, ledger) =>
      enforceDecomposition(st, sessionID, prompt, projectDir, ledger),
    enforcePlanApproval: (sessionID, projectDir, ledger, prompt) =>
      enforcePlanApproval(st, sessionID, projectDir, ledger, prompt),
  }
}
