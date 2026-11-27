/**
 * @fileoverview Plan-domain enforcement decisions: the plan-approval gate and
 * the decomposition gate, built on a cached plans-dir content scan (per
 * `createGates` instance). The scan cache lives in `src/plans-scan.ts`, the
 * status mirror and plan-scope surfaces in `src/plan-gate-status.ts`, and the
 * enforcement bodies in `src/plan-gate-enforce.ts`. Functions here either
 * return normally or throw a deliberate BLOCKED error; every other failure
 * fails open (unreadable plan dirs are journaled, never fatal). All tunables
 * (plans dir, agent names, marker) come from the injected config; persistence
 * goes through the injected Journaler.
 */

import type { Journaler } from "./journal.ts"
import type { GateLedger } from "./ledger.ts"
import type { TurnstileConfig } from "./types.ts"
import type { PlanImpact } from "./plan-scope.ts"
import { createPlansScanCache } from "./plans-scan.ts"
import { createPlanGateStatus, type PlanGateRed } from "./plan-gate-status.ts"
import { createPlanGateEnforce } from "./plan-gate-enforce.ts"
import { promptPlanNames } from "./plan-gate-status.ts"

export type { PlanGateRed }

/**
 * Plan-domain enforcement functions bound to one resolved config +
 * journaler. The method contracts are documented on the public `Gates`
 * interface in `gates.ts`, which re-exposes these eight unchanged.
 */
interface PlanGates {
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
  plansSignature(projectDir: string): string | null
  planSummary(projectDir: string, activeName?: string): { file: string; head: string } | undefined
  planGateStatus(
    projectDir: string,
    ledger: GateLedger,
    sessionID: string,
    prompt?: string,
  ): { red: false } | PlanGateRed
  promptPlanNames(prompt: string): string[]
  planApprovalBinding(
    projectDir: string,
    candidates: string[],
  ): { name: string; key: string } | undefined
  planImpactFor(
    projectDir: string,
    activePlan: string,
    targetPath: string,
    matchInText: boolean,
  ): PlanImpact
}

/**
 * Binds the plan-domain enforcement functions to a resolved config and
 * journaler. The plans-dir scan cache is instance-local: each `createGates`
 * call gets its own rescan cache, so multi-instance consumers never share
 * fail-open journaling.
 * @param config The resolved plugin configuration.
 * @param journaler The telemetry writer for gate and blocked entries.
 * @returns The eight plan-domain enforcement functions.
 */
export function createPlanGates(config: TurnstileConfig, journaler: Journaler): PlanGates {
  const cache = createPlansScanCache(config)
  const status = createPlanGateStatus(config, journaler, cache)
  const enforce = createPlanGateEnforce(config, journaler, cache, status)
  return {
    ...enforce,
    ...status,
    promptPlanNames,
  }
}
