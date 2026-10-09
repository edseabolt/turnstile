/**
 * @fileoverview Policy boundary: enforcement decisions — the reviewer
 * dispatch gate, the whole-file read horizon, and the decomposition gate.
 * Functions here either return normally or throw a deliberate BLOCKED
 * error; every other failure fails open upstream (hooks guard and journal).
 * All tunables (thresholds, marker, agent names) come from the injected
 * config; persistence goes through the injected Journaler.
 */

import * as fs from "node:fs"
import * as path from "node:path"

import type { Journaler } from "./journal.ts"
import type { GateLedger } from "./state.ts"
import type { TurnstileConfig } from "./types.ts"

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
   * dispatch carrying it only — every dispatch prompt must contain the
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
  // Cached decomposition verdict keyed by the plans directory's content
  // signature (dir mtime + sorted plan names + per-file mtimes). Saves the
  // per-dispatch rescan; any fs error throws to the caller's fail-open.
  let plansCache: { key: string; hasDecomp: boolean; file: string | null } | null = null

  /**
   * Computes a change-detection key for a plans directory.
   * @param dir Absolute plans directory path.
   * @returns Dir mtime plus sorted plan names with per-file mtimes.
   */
  function plansKey(dir: string): string {
    const names = fs
      .readdirSync(dir)
      .filter((f) => f.endsWith(".md"))
      .sort()
    const files = names.map((n) => `${n}:${fs.statSync(path.join(dir, n)).mtimeMs}`)
    return `${dir}|${fs.statSync(dir).mtimeMs}|${files.join(",")}`
  }

  function enforceDecomposition(sessionID: string, prompt: string, projectDir: string): void {
    if (/\b(?:chunk-\d+|AC-\d+)\b/.test(prompt)) return
    const plansDir = path.join(projectDir, config.plansDir)
    try {
      if (!fs.existsSync(plansDir)) return
      const key = plansKey(plansDir)
      let verdict = plansCache
      if (verdict === null || verdict.key !== key) {
        const withDecomp = fs
          .readdirSync(plansDir)
          .filter((f) => f.endsWith(".md"))
          .find((f) => fs.readFileSync(path.join(plansDir, f), "utf8").includes("## Decomposition"))
        verdict = { key, hasDecomp: withDecomp !== undefined, file: withDecomp ?? null }
        plansCache = verdict
      }
      if (verdict.hasDecomp && verdict.file !== null) {
        journaler.journal({
          type: "blocked",
          sessionID,
          agent: config.agents.executor,
          reason: "missing-chunk-ref",
          plan: verdict.file,
        })
        throw new BlockError(
          `BLOCKED by turnstile: plan "${verdict.file}" has a ## Decomposition block — executor dispatches must cite the chunk-N / AC-n they implement.`,
        )
      }
    } catch (e) {
      if (e instanceof BlockError) throw e
      // unreadable plans dir: fail-open
    }
  }

  return { guardReviewerDispatch, guardReadLimit, enforceDecomposition }
}
