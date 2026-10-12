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
import { createHash } from "node:crypto"
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
   * or the test gate has not gone green. A waiver bypasses the cap without
   * counting toward it.
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
   * dispatch carrying it only, bypasses the cap without counting toward it,
   * and expires with that dispatch; every dispatch prompt must contain the
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
      journaler.traceEvent("user", "waiver", prompt.slice(at, at + 120), sessionID)
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
      // An unverified PASS (evidence correlation, gateEvidence:enforce) leaves
      // unverifiedPass set: the gate is genuinely not green, so the block names
      // the evidence contract. The legacy no-gate-pass path stays byte-identical
      // when no unverified claim was recorded (s.unverifiedPass === "").
      if (s.unverifiedPass !== "") {
        journaler.journal({
          type: "blocked",
          sessionID,
          agent: config.agents.reviewer,
          reason: "gate-unverified",
        })
        throw new BlockError(
          "BLOCKED by turnstile: reviewer dispatch without gate evidence: a GATE: PASS " +
            "was recorded without a journaled successful test-command execution for this " +
            `session. Run the ${config.agents.testRunner} subagent first, or obtain an ` +
            `explicit user waiver ` +
            `(the dispatch prompt must contain the literal marker '${config.waiverMarker}' followed by the user's words).`,
        )
      }
      journaler.journal({
        type: "blocked",
        sessionID,
        agent: config.agents.reviewer,
        reason: "no-gate-pass",
      })
      throw new BlockError(
        "BLOCKED by turnstile: no reviewer dispatch before the test gate is green. " +
          `Run the ${config.agents.testRunner} subagent first; dispatch ${config.agents.reviewer} only after its first line is ` +
          "`GATE: PASS tests=<n> passed=<n> failed=<n>`, or obtain an explicit user waiver " +
          `(the dispatch prompt must contain the literal marker '${config.waiverMarker}' followed by the user's words).`,
      )
    }
    // Check-then-increment: the Nth dispatch is allowed and the (N+1)th is
    // blocked, so exactly `maxReviewerRounds` dispatches succeed per task.
    // A waiver is an explicit per-dispatch user escape, so it bypasses the
    // cap without counting toward it — the cap bounds the unwaived re-dispatch
    // loop only.
    if (!waived) s.reviewRounds++
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
  // (`dir|name:sha256hex,…`). A key hit returns the cached scan and skips the
  // utf8 decode and the `## Decomposition` search; a key miss recomputes
  // decompFile. Any fs error throws to the caller's fail-open.
  let plansCache: { key: string; scan: PlansScan } | null = null

  /** What one plans-dir scan establishes for both plan gates. */
  interface PlansScan {
    /**
     * Content signature of the plans dir: `dir|name:sha256hex,…`. Two scans
     * with different keys mean the plans dir _content_ changed (an add,
     * delete, rename, or same-size/content edit); a utimes-only or dir touch
     * leaves it identical — dir mtime is deliberately not hashed.
     */
    key: string
    /** Sorted plan file names (empty when the dir holds no plans). */
    names: string[]
    /** First (sorted) plan carrying a `## Decomposition` block, or null. */
    decompFile: string | null
  }

  /**
   * Sorted `.md` names with per-file content buffers, one readdir + read
   * each; the buffers feed the digest so `scanPlans` never re-reads a file.
   * @param dir Absolute plans directory path.
   * @returns Sorted `{ name, bytes }` for every `.md` entry (empty when none).
   */
  function readEntries(dir: string): Array<{ name: string; bytes: Buffer }> {
    const names = fs
      .readdirSync(dir)
      .filter((f) => f.endsWith(".md"))
      .sort()
    return names.map((name) => ({ name, bytes: fs.readFileSync(path.join(dir, name)) }))
  }

  /**
   * Content signature: `dir|name:sha256hex,…`. Identical iff the plans dir's
   * content is identical — an add, delete, rename, or same-size/content edit
   * changes it; a utimes-only or dir touch does not.
   * @param dir Absolute plans directory path.
   * @param entries The plan entries from `readEntries`.
   * @returns The content signature for `dir` and its entries.
   */
  function plansKey(dir: string, entries: Array<{ name: string; bytes: Buffer }>): string {
    const files = entries
      .map((e) => `${e.name}:${createHash("sha256").update(e.bytes).digest("hex")}`)
      .join(",")
    return `${dir}|${files}`
  }

  /**
   * Scans the plans directory, returning the scan whose `key` is the dir's
   * content signature. The cache skips a redundant rescan: a key hit returns
   * the cached scan, skipping the utf8 decode and `## Decomposition` search;
   * a key miss replaces it — either way the returned key reports the dir's
   * current content.
   * @param dir Absolute plans directory path.
   * @returns The current scan; `scan.key` is the dir's content signature.
   */
  function scanPlans(dir: string): PlansScan {
    const entries = readEntries(dir)
    const key = plansKey(dir, entries)
    const cached = plansCache
    if (cached !== null && cached.key === key) return cached.scan
    const scan: PlansScan = {
      key,
      names: entries.map((e) => e.name),
      decompFile:
        entries.find((e) => e.bytes.toString("utf8").includes("## Decomposition"))?.name ?? null,
    }
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
      // Journal the fail-open so an unreadable plans dir stays observable.
      journaler.journal({ type: "error", error: `plans dir unreadable: ${e}` })
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
    } catch (e) {
      // Journal the fail-open so the unreadable plans dir stays observable.
      journaler.journal({ type: "error", error: `plans dir unreadable: ${e}` })
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
      journaler.traceEvent("user", "plan-waiver", prompt.slice(at, at + 120), sessionID)
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
          `BLOCKED by turnstile: no plan approval for "${plan}". Dispatch the ${config.agents.planReviewer} subagent first; proceed with ${config.agents.executor} only after the ${config.agents.planReviewer}'s first line is ` +
            "`VERDICT: APPROVE crit=<n> high=<n> med=<n> low=<n>`, or obtain an explicit user waiver " +
            `(the dispatch prompt must contain the literal marker '${config.waiverMarker}' followed by the user's words).`,
        )
      }
    } catch (e) {
      if (e instanceof BlockError) throw e
      // Journal the fail-open so an unreadable plans dir stays observable.
      journaler.journal({ type: "error", error: `plans dir unreadable: ${e}` })
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
