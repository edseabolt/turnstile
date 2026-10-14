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
   * waives the dispatch when the task's prompt-channel waiver
   * (`ledger.state().userWaiver`, captured from the user prompt in the setup
   * hook) is set, then blocks when the dispatch cap is exhausted or the test
   * gate has not gone green. A waiver bypasses the cap without counting toward
   * it and is consumed by the dispatch that unlocks it (per-dispatch); the
   * task waiver otherwise stays live.
   * @param sessionID The parent session ID.
   * @param ledger The gate ledger to read and mutate state from.
   * @throws Error with a `BLOCKED by turnstile:` prefix when the dispatch
   *     must not proceed.
   */
  guardReviewerDispatch(sessionID: string, ledger: GateLedger): void
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
   * The waiver is the task's prompt-channel waiver
   * (`ledger.state().userWaiver`, captured from the user prompt): non-empty
   * waives this gate for the whole task (not per dispatch).
   * @param sessionID The parent session ID.
   * @param projectDir The current project directory.
   * @param ledger The gate ledger to read and mutate plan state from.
   * @throws Error with a `BLOCKED by turnstile:` prefix when no plan file
   *     exists yet is approved for this task.
   */
  enforcePlanApproval(sessionID: string, projectDir: string, ledger: GateLedger): void
  /**
   * Returns the current plans-dir signature for approval-time stamping, or
   * null when the dir is absent or unreadable (fail-open: an unstampable
   * approval behaves as unknown and is validated on the next enforcing
   * dispatch).
   * @param projectDir The current project directory.
   * @returns The plans-dir content signature, or null when absent/unreadable.
   */
  plansSignature(projectDir: string): string | null
  /**
   * Returns the first plan file's name and a short body preview, or undefined
   * when the plans dir is absent, unreadable, or empty (fail-open). The preview
   * is the first ~40 non-heading lines; shared by the escalatable plan gate so
   * the ask the evaluate handler surfaces names the same file and shows its
   * body.
   * @param projectDir The current project directory.
   * @returns `{ file, head }` for the first sorted plan, or undefined.
   */
  planSummary(projectDir: string): { file: string; head: string } | undefined
  /**
   * Returns whether the plan-approval gate is currently red for a parent, and
   * when red, the plan file + body preview to surface in a permission ask.
   * Mirrors `enforcePlanApproval`'s guard (waived, absent/empty dir, or an
   * approved verdict is not red; otherwise red) so the evaluate handler and the
   * enforcing dispatch decide escalation from the exact same scan. Waiver and
   * approval are folded into `red`: a red result implies a non-empty waiver is
   * absent and `hasPlanVerdict` is false, so the caller only tests `red`.
   * @param projectDir The current project directory.
   * @param ledger The gate ledger to read (and reconcile) state from.
   * @param sessionID The parent session whose plan-gate state is read.
   * @returns `{ red: false }` when the gate is not red, or `{ red: true, summary }` when it is.
   */
  planGateStatus(
    projectDir: string,
    ledger: GateLedger,
    sessionID: string,
  ): {
    red: boolean
    summary?: { file: string; head: string }
  }
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
   * Waives the dispatch when the task's prompt-channel waiver
   * (`s.userWaiver`, captured from the user prompt in the setup hook) is set,
   * then blocks when the dispatch cap is exhausted or the test gate has not
   * gone green. The cap counts reviewer dispatches themselves (per the
   * documented "max 2 reviewer dispatches per task" contract), not BLOCK
   * verdicts. A waiver bypasses the cap without counting toward it and is
   * consumed by the dispatch that unlocks it (per-dispatch): a stale waiver
   * cannot outlive that single reviewer dispatch. Provenance matters (issue
   * #34, AC-1): the waiver is read from the task prompt, never the dispatch
   * prompt.
   * @param sessionID The parent session ID.
   * @param ledger The gate ledger to read and mutate state from.
   * @throws Error with a `BLOCKED by turnstile:` prefix when the dispatch
   *     must not proceed.
   */
  function guardReviewerDispatch(sessionID: string, ledger: GateLedger): void {
    const s = ledger.state(sessionID)
    const waived = s.userWaiver !== ""
    if (waived) {
      journaler.journal({
        type: "gate",
        sessionID,
        result: "WAIVED",
        // Provenance: this waiver opened the gate from the user prompt, not a
        // dispatch prompt (issue #34, AC-1).
        channel: "prompt",
        // Waiver quotes carry raw prompt context; journal them only when
        // the trace is enabled (SECURITY.md redaction contract). `s.userWaiver`
        // is already trace-gated by the prompt-hook capture.
        waiver: s.userWaiver,
      })
      journaler.traceEvent("user", "waiver", s.userWaiver, sessionID)
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
            `(a user prompt this task must contain the literal marker '${config.waiverMarker}' followed by the user's words).`,
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
          `(a user prompt this task must contain the literal marker '${config.waiverMarker}' followed by the user's words).`,
      )
    }
    // Check-then-increment: the Nth dispatch is allowed and the (N+1)th is
    // blocked, so exactly `maxReviewerRounds` dispatches succeed per task.
    // A waiver is an explicit per-dispatch user escape, so it bypasses the
    // cap without counting toward it — the cap bounds the unwaived re-dispatch
    // loop only. The waiver is consumed by the dispatch that unlocks it (per
    // the historical quote-consumption semantics), so a stale task waiver
    // cannot grant a later reviewer dispatch.
    if (!waived) s.reviewRounds++
    else s.userWaiver = ""
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

  /**
   * The leading preview of one plan file's body: the first ~40 non-heading
   * lines (lines not beginning with '#' after optional leading whitespace),
   * joined and trimmed. Feeds the permission-ask message so the human sees the
   * plan's body without the heading scaffold.
   * @param bytes The plan file bytes.
   * @returns The head text, or "" when the file has no non-heading lines.
   */
  function planHead(bytes: Buffer): string {
    const lines = bytes.toString("utf8").split("\n")
    const body = lines
      .filter((line) => !/^\s*#/.test(line))
      .slice(0, 40)
      .join("\n")
    return body.trim()
  }

  /**
   * Builds the `{ file, head }` preview for the first sorted plan of a scan,
   * reading that plan's bytes once (they were already read to compute the scan
   * key). Shared by both `planSummary` and the escalatable plan gate so the
   * ask names exactly the plan `enforcePlanApproval` would block on.
   * @param scan The current plans-dir scan.
   * @param plansDir The absolute plans directory of `scan`.
   * @returns The first plan's `{ file, head }`.
   */
  function firstPlanSummary(scan: PlansScan, plansDir: string): { file: string; head: string } {
    // The callers guard names.length === 0 before calling, so names[0] exists;
    // the non-null assertion is enforced by that guard, not silently assumed.
    const name = scan.names[0]!
    const bytes = fs.readFileSync(path.join(plansDir, name))
    return { file: name, head: planHead(bytes) }
  }

  /**
   * Returns the first plan file's name and a short body preview, or undefined
   * when the plans dir is absent, unreadable, or empty (fail-open). The preview
   * is the first ~40 non-heading lines; shared with the escalatable plan gate
   * so the ask the evaluate handler surfaces names the same file and shows its
   * body.
   * @param projectDir The current project directory.
   * @returns `{ file, head }` for the first sorted plan, or undefined.
   */
  function planSummary(projectDir: string): { file: string; head: string } | undefined {
    const plansDir = path.join(projectDir, config.plansDir)
    try {
      if (!fs.existsSync(plansDir)) return undefined
      const scan = scanPlans(plansDir)
      if (scan.names.length === 0) return undefined
      return firstPlanSummary(scan, plansDir)
    } catch (e) {
      // Journal the fail-open so the unreadable plans dir stays observable.
      journaler.journal({ type: "error", error: `plans dir unreadable: ${e}` })
      return undefined
    }
  }

  /**
   * Returns whether the plan-approval gate is currently red for a parent, and
   * when red, the plan file + body preview to surface in a permission ask.
   * Mirrors `enforcePlanApproval`'s guard (waived, absent/empty dir, or an
   * approved verdict is not red; otherwise red) so the evaluate handler and the
   * enforcing dispatch decide escalation from the exact same scan. Waiver and
   * approval are folded into `red`: a red result implies a non-empty waiver is
   * absent and `hasPlanVerdict` is false, so the caller only tests `red`.
   * @param projectDir The current project directory.
   * @param ledger The gate ledger to read (and reconcile) state from.
   * @param sessionID The parent session whose plan-gate state is read.
   * @returns `{ red: false }` when not red, or `{ red: true, summary }` when red.
   */
  function planGateStatus(
    projectDir: string,
    ledger: GateLedger,
    sessionID: string,
  ): { red: boolean; summary?: { file: string; head: string } } {
    const s = ledger.state(sessionID)
    if (s.userWaiver !== "") return { red: false }
    const plansDir = path.join(projectDir, config.plansDir)
    try {
      if (!fs.existsSync(plansDir)) return { red: false }
      const scan = scanPlans(plansDir)
      if (scan.names.length === 0) return { red: false }
      // Reconcile this session's approval with the current scan: a stamp that
      // differs from the current key means re-plan → stale verdict. Same rule
      // as enforcePlanApproval, so the handler and the dispatch agree.
      reconcilePlanStamp(s, scan)
      if (s.hasPlanVerdict) return { red: false }
      return { red: true, summary: firstPlanSummary(scan, plansDir) }
    } catch (e) {
      // Journal the fail-open so an unreadable plans dir stays observable.
      journaler.journal({ type: "error", error: `plans dir unreadable: ${e}` })
      return { red: false }
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

  function enforcePlanApproval(sessionID: string, projectDir: string, ledger: GateLedger): void {
    const s = ledger.state(sessionID)
    if (s.userWaiver !== "") {
      journaler.journal({
        type: "plan",
        sessionID,
        result: "WAIVED",
        // Provenance: this waiver opened the gate from the user prompt, not a
        // dispatch prompt (issue #34, AC-1).
        channel: "prompt",
        // Waiver quotes carry raw prompt context; journal them only when
        // the trace is enabled (SECURITY.md redaction contract). `s.userWaiver`
        // is already trace-gated by the prompt-hook capture.
        waiver: s.userWaiver,
      })
      journaler.traceEvent("user", "plan-waiver", s.userWaiver, sessionID)
      return
    }
    const status = planGateStatus(projectDir, ledger, sessionID)
    // status.red ⇒ summary is always present: planGateStatus builds it from a
    // scan whose names[0] was already read to compute the scan key, so the
    // non-null assertion is sound. The block message is byte-identical to the
    // pre-refactor scan; only the source of `plan` changed.
    if (status.red) {
      const plan = status.summary!.file
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
          `(a user prompt this task must contain the literal marker '${config.waiverMarker}' followed by the user's words).`,
      )
    }
  }

  return {
    guardReviewerDispatch,
    guardReadLimit,
    enforceDecomposition,
    enforcePlanApproval,
    plansSignature,
    planSummary,
    planGateStatus,
  }
}
