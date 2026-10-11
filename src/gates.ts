/**
 * @fileoverview Policy boundary: enforcement decisions: the reviewer
 * dispatch gate, the plan-approval gate, the whole-file read horizon, and
 * the decomposition gate.
 * Functions here either return normally or throw a deliberate BLOCKED
 * error; every other failure fails open upstream (hooks guard and journal).
 * All tunables (thresholds, marker, agent names) come from the injected
 * config; persistence goes through the injected Journaler.
 */

import * as fs from "node:fs"
import * as path from "node:path"

import type { Journaler } from "./journal.ts"
import type { GateLedger } from "./state.ts"
import type { GateState, TurnstileConfig } from "./types.ts"

/**
 * The only error type turnstile deliberately throws at the host: an
 * enforcement block. Hook guards rethrow `BlockError` instances and
 * journal everything else (fail-open contract).
 */
export class BlockError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "BlockError"
  }
}

/** Enforcement functions bound to one resolved config + journaler. */
export interface Gates {
  /**
   * Enforces the reviewer dispatch gate for a pending `task` dispatch:
   * records a waiver when the prompt carries the waiver marker (per
   * dispatch, not sticky), then blocks when the dispatch cap is exhausted
   * or the test gate has not gone green.
   * @param sessionID The parent session ID.
   * @param prompt The dispatch prompt text.
   * @param ledger The gate ledger to read and mutate state from.
   * @throws Error with a `BLOCKED by turnstile:` prefix when the dispatch
   *     must not proceed.
   */
  guardReviewerDispatch(sessionID: string, prompt: string, ledger: GateLedger): void
  /**
   * Enforces the whole-file read horizon for a session.
   * @param sessionID The parent session ID.
   * @param ledger The gate ledger to read state from.
   * @throws Error with a `BLOCKED by turnstile:` prefix once the read
   *     count has reached the configured block threshold.
   */
  guardReadLimit(sessionID: string, ledger: GateLedger): void
  /**
   * Enforces the decomposition gate: when any plan file in the configured
   * plans directory carries a `## Decomposition` block, executor
   * dispatches must cite the chunk-N / AC-n they implement. Unreadable
   * plans dirs fail open.
   * @param sessionID The parent session ID (used in journal entries).
   * @param prompt The dispatch prompt text to check for chunk citations.
   * @param projectDir The current project directory.
   * @throws Error with a `BLOCKED by turnstile:` prefix when a decomposed
   *     plan exists and the prompt cites no chunk.
   */
  enforceDecomposition(sessionID: string, prompt: string, projectDir: string): void
  /**
   * Enforces the plan-approval gate: when any plan file exists in the
   * configured plans directory, executor dispatches require a current
   * plan-reviewer `VERDICT: APPROVE` for the session (or a waiver).
   * Approval is invalidated when this session's approval was issued against
   * a different plans-dir signature, forcing re-review after a re-plan.
   * @param sessionID The parent session ID.
   * @param prompt The dispatch prompt text (checked for the waiver marker).
   * @param projectDir The current project directory.
   * @param ledger The gate ledger to read and mutate plan state from.
   * @throws Error with a `BLOCKED by turnstile:` prefix when no plan file
   *     exists yet is approved for this task.
   */
  enforcePlanApproval(
    sessionID: string,
    prompt: string,
    projectDir: string,
    ledger: GateLedger,
  ): void
  /**
   * Returns the current plans-dir signature for approval-time stamping, or
   * null when the dir is absent or unreadable (fail-open: an unstampable
   * approval behaves as unknown and is validated on the next enforcing
   * dispatch).
   * @param projectDir The current project directory.
   * @returns The plans-dir content signature, or null when absent/unreadable.
   */
  plansSignature(projectDir: string): string | null
}

/**
 * Binds enforcement functions to a resolved config and journaler.
 * @param config The resolved plugin configuration.
 * @param journaler The telemetry writer for gate and blocked entries.
 * @returns The three enforcement functions.
 */
export function createGates(config: TurnstileConfig, journaler: Journaler): Gates {
  /**
   * Enforces the reviewer dispatch gate for a pending `task` dispatch.
   * Records a waiver (with journal + trace) when the prompt carries the
   * waiver marker, then blocks the dispatch when the dispatch cap is
   * exhausted or the test gate has not gone green. The cap counts reviewer
   * dispatches themselves (per the documented "max 2 reviewer dispatches
   * per task" contract), not BLOCK verdicts. A waiver applies to the
   * dispatch carrying it only; every dispatch prompt must contain the
   * literal marker to be exempt.
   * @param sessionID The parent session ID.
   * @param prompt The dispatch prompt text.
   * @param ledger The gate ledger to read and mutate state from.
   * @throws Error with a `BLOCKED by turnstile:` prefix when the dispatch
   *     must not proceed.
   */
  function guardReviewerDispatch(sessionID: string, prompt: string, ledger: GateLedger): void {
    const s = ledger.state(sessionID)
    const at = prompt.indexOf(config.waiverMarker)
    const waived = at !== -1
    if (waived) {
      journaler.journal({
        type: "gate",
        sessionID,
        result: "WAIVED",
        // Waiver quotes carry raw prompt context; journal them only when
        // the trace is enabled (SECURITY.md redaction contract).
        waiver: config.trace ? prompt.slice(at, at + 200) : "<present>",
      })
      journaler.traceEvent("user", "waiver", prompt.slice(at, at + 120))
    }
    if (s.reviewRounds >= config.maxReviewerRounds && !waived) {
      journaler.journal({
        type: "blocked",
        sessionID,
        agent: config.agents.reviewer,
        reason: "round-limit",
      })
      throw new BlockError(
        `BLOCKED by turnstile: reviewer round limit (${config.maxReviewerRounds}) reached. Escalate the open findings to the user, or start a new task (a new user prompt resets the cap).`,
      )
    }
    if (!s.hasGatePass && !waived) {
      journaler.journal({
        type: "blocked",
        sessionID,
        agent: config.agents.reviewer,
        reason: "no-gate-pass",
      })
      throw new BlockError(
        "BLOCKED by turnstile: no reviewer dispatch before the test gate is green. " +
          "Run the test-runner subagent first; dispatch reviewer only after its first line is " +
          "`GATE: PASS tests=<n> passed=<n> failed=<n>`, or obtain an explicit user waiver " +
          "(the dispatch prompt must contain the literal marker 'USER WAIVER:' followed by the user's words).",
      )
    }
    // Check-then-increment: the Nth dispatch is allowed and the (N+1)th is
    // blocked, so exactly `maxReviewerRounds` dispatches succeed per task.
    s.reviewRounds++
  }

  /**
   * Enforces the whole-file read horizon for a session.
   * @param sessionID The parent session ID.
   * @param ledger The gate ledger to read state from.
   * @throws Error with a `BLOCKED by turnstile:` prefix once the read
   *     count has reached the configured block threshold.
   */
  function guardReadLimit(sessionID: string, ledger: GateLedger): void {
    if (ledger.state(sessionID).reads >= config.readBlock) {
      journaler.journal({ type: "blocked", sessionID, tool: "read", reason: "read-limit" })
      throw new BlockError(
        `BLOCKED by turnstile: ${config.readBlock} whole-file reads this session. Switch to grep/glob for targeted retrieval, or report being stuck and escalate to the user.`,
      )
    }
  }

  /**
   * Enforces the decomposition gate: when any plan file in the configured
   * plans directory carries a `## Decomposition` block, executor
   * dispatches must cite the chunk-N / AC-n they implement.
   * @param sessionID The parent session ID (used in journal entries).
   * @param prompt The dispatch prompt text to check for chunk citations.
   * @param projectDir The current project directory.
   * @throws Error with a `BLOCKED by turnstile:` prefix when a decomposed
   *     plan exists and the prompt cites no chunk.
   */
  // Cached plans-dir scan keyed by the directory's content signature
  // (dir mtime + sorted plan names + per-file mtimes). A key hit returns the
  // cached scan and skips both the rescan and the per-file re-read for the
  // `## Decomposition` check; a key miss recomputes decompFile. Any fs error
  // throws to the caller's fail-open.
  let plansCache: { key: string; scan: PlansScan } | null = null

  /** What one plans-dir scan establishes for both plan gates. */
  interface PlansScan {
    /**
     * Content signature of the plans dir: `dir|dirMtime|name:mtime,…`. Two
     * scans with different keys mean the plans dir changed.
     */
    key: string
    /** Sorted plan file names (empty when the dir holds no plans). */
    names: string[]
    /** First (sorted) plan carrying a `## Decomposition` block, or null. */
    decompFile: string | null
  }

  /**
   * Scans the plans directory, returning the scan whose `key` is the dir's
   * content signature. The cache skips a redundant rescan: a key hit returns
   * the cached scan, a key miss replaces it — either way the returned key
   * reports the dir's current content.
   * @param dir Absolute plans directory path.
   * @returns The current scan; `scan.key` is the dir's content signature.
   */
  function scanPlans(dir: string): PlansScan {
    const names = fs
      .readdirSync(dir)
      .filter((f) => f.endsWith(".md"))
      .sort()
    const files = names.map((n) => `${n}:${fs.statSync(path.join(dir, n)).mtimeMs}`)
    const key = `${dir}|${fs.statSync(dir).mtimeMs}|${files.join(",")}`
    const scan: PlansScan = { key, names, decompFile: null }
    const cached = plansCache
    if (cached !== null && cached.key === key) {
      return cached.scan
    }
    // Key miss: compute the `## Decomposition` file only now, so a key hit
    // skips this per-file re-read (the cached scan already carries it).
    scan.decompFile =
      names.find((n) => fs.readFileSync(path.join(dir, n), "utf8").includes("## Decomposition")) ??
      null
    plansCache = { key, scan }
    return scan
  }

  /**
   * Reconciles a session's approval with the current scan: a non-empty stamp
   * that differs from `scan.key` means the plan was re-planned since approval,
   * so the verdict is stale and re-review is required; a green pass re-stamps
   * the current key (idempotent, and how a replay-restored "" becomes
   * validated). A "" stamp is unknown — journal-replayed approvals must
   * survive restart, so it is accepted once, mirroring the old first-scan
   * rule. The accept-once window also covers a session that approved but never
   * ran an enforcing dispatch: its stamp is still empty until the first green
   * dispatch stamps it.
   * @param s The session's gate state (mutated).
   * @param scan The current plans-dir scan.
   */
  function reconcilePlanStamp(s: GateState, scan: PlansScan): void {
    if (s.hasPlanVerdict && s.plansSignature !== "" && s.plansSignature !== scan.key)
      s.hasPlanVerdict = false
    if (s.hasPlanVerdict) s.plansSignature = scan.key
  }

  function enforceDecomposition(sessionID: string, prompt: string, projectDir: string): void {
    if (/\b(?:chunk-\d+|AC-\d+)\b/.test(prompt)) return
    const plansDir = path.join(projectDir, config.plansDir)
    try {
      if (!fs.existsSync(plansDir)) return
      const scan = scanPlans(plansDir)
      if (scan.decompFile !== null) {
        journaler.journal({
          type: "blocked",
          sessionID,
          agent: config.agents.executor,
          reason: "missing-chunk-ref",
          plan: scan.decompFile,
        })
        throw new BlockError(
          `BLOCKED by turnstile: plan "${scan.decompFile}" has a ## Decomposition block — executor dispatches must cite the chunk-N / AC-n they implement.`,
        )
      }
    } catch (e) {
      if (e instanceof BlockError) throw e
      // unreadable plans dir: fail-open
    }
  }

  /**
   * Returns the current plans-dir signature for approval-time stamping, or
   * null when the dir is absent or unreadable (fail-open: an unstampable
   * approval behaves as unknown and is validated on the next enforcing
   * dispatch).
   * @param projectDir The current project directory.
   * @returns The plans-dir content signature, or null when absent/unreadable.
   */
  function plansSignature(projectDir: string): string | null {
    const plansDir = path.join(projectDir, config.plansDir)
    if (!fs.existsSync(plansDir)) return null
    try {
      return scanPlans(plansDir).key
    } catch {
      // unreadable plans dir: fail-open (unstampable approval → "")
      return null
    }
  }

  function enforcePlanApproval(
    sessionID: string,
    prompt: string,
    projectDir: string,
    ledger: GateLedger,
  ): void {
    const at = prompt.indexOf(config.waiverMarker)
    if (at !== -1) {
      journaler.journal({
        type: "plan",
        sessionID,
        result: "WAIVED",
        // Waiver quotes carry raw prompt context; journal them only when
        // the trace is enabled (SECURITY.md redaction contract).
        waiver: config.trace ? prompt.slice(at, at + 200) : "<present>",
      })
      journaler.traceEvent("user", "plan-waiver", prompt.slice(at, at + 120))
      return
    }
    const plansDir = path.join(projectDir, config.plansDir)
    try {
      if (!fs.existsSync(plansDir)) return
      const scan = scanPlans(plansDir)
      if (scan.names.length === 0) return
      const s = ledger.state(sessionID)
      // Reconcile this session's approval with the current scan: a stamp that
      // differs from the current key means re-plan → stale verdict; a green
      // pass re-stamps (and how a replay-restored "" becomes validated). Both
      // per-session stamps are checked, so an edit invalidates every session.
      reconcilePlanStamp(s, scan)
      if (!s.hasPlanVerdict) {
        const plan = scan.names[0]
        journaler.journal({
          type: "blocked",
          sessionID,
          agent: config.agents.executor,
          reason: "no-plan-verdict",
          plan,
        })
        throw new BlockError(
          `BLOCKED by turnstile: no plan approval for "${plan}". Dispatch the plan-reviewer subagent first; proceed with executor only after the plan-reviewer's first line is ` +
            "`VERDICT: APPROVE crit=<n> high=<n> med=<n> low=<n>`, or obtain an explicit user waiver " +
            "(the dispatch prompt must contain the literal marker 'USER WAIVER:' followed by the user's words).",
        )
      }
    } catch (e) {
      if (e instanceof BlockError) throw e
      // unreadable plans dir: fail-open
    }
  }

  return {
    guardReviewerDispatch,
    guardReadLimit,
    enforceDecomposition,
    enforcePlanApproval,
    plansSignature,
  }
}
