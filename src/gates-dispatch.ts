/**
 * @fileoverview Dispatch-domain enforcement decisions: the reviewer dispatch
 * gate (round cap + gate evidence), the ensemble-completeness credit
 * decision, the per-leg loop caps + total-dispatch budget, and the
 * whole-file read horizon. The enforcement bodies live in
 * `src/dispatch-review-gate.ts` and `src/dispatch-budget.ts`; the shared
 * gate-message builders in `src/gate-messages.ts`. Functions here either
 * return normally or throw a deliberate BLOCKED error; every other failure
 * fails open upstream (hooks guard and journal). All tunables (thresholds,
 * marker, agent names) come from the injected config; persistence goes
 * through the injected Journaler.
 */

import type { Journaler } from "./journal.ts"
import type { GateLedger } from "./ledger.ts"
import type { TurnstileConfig } from "./types.ts"
import { createDispatchBudget } from "./dispatch-budget.ts"
import { createReviewGate } from "./dispatch-review-gate.ts"
import type { EvidenceSearch } from "./gate-messages.ts"

export type { EvidenceSearch } from "./gate-messages.ts"

/**
 * Dispatch-domain enforcement functions bound to one resolved config +
 * journaler. The method contracts are documented on the public `Gates`
 * interface in `gates.ts`, which re-exposes these six unchanged.
 */
interface DispatchGates {
  guardReviewerDispatch(sessionID: string, ledger: GateLedger, search?: EvidenceSearch): void
  reviewEnsembleComplete(sessionID: string, ledger: GateLedger): boolean
  countReviewerEnsemble(sessionID: string, ledger: GateLedger): void
  guardDispatchBudget(sessionID: string, ledger: GateLedger, agent: string): boolean
  countDispatch(sessionID: string, ledger: GateLedger, agent: string, waived: boolean): void
  guardReadLimit(sessionID: string, ledger: GateLedger): void
}

/**
 * Binds the dispatch-domain enforcement functions to a resolved config and
 * journaler, composing the review gate and the dispatch budget modules.
 * @param config The resolved plugin configuration.
 * @param journaler The telemetry writer for gate and blocked entries.
 * @returns The six dispatch-domain enforcement functions.
 */
export function createDispatchGates(config: TurnstileConfig, journaler: Journaler): DispatchGates {
  return {
    ...createReviewGate(config, journaler),
    ...createDispatchBudget(config, journaler),
  }
}
