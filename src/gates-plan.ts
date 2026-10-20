/**
 * @fileoverview Plan-domain enforcement decisions: the plan-approval gate and
 * the decomposition gate, built on a cached plans-dir content scan (per
 * `createGates` instance). Functions here either return normally or throw a
 * deliberate BLOCKED error; every other failure fails open (unreadable plan
 * dirs are journaled, never fatal). All tunables (plans dir, agent names,
 * marker) come from the injected config; persistence goes through the
 * injected Journaler.
 */

import * as fs from "node:fs"
import { createHash } from "node:crypto"
import * as path from "node:path"

import type { Journaler } from "./journal.ts"
import type { GateLedger } from "./state.ts"
import type { GateState, TurnstileConfig } from "./types.ts"
import { BlockError, waiverCovers, waiverStateNote } from "./gates-common.ts"

/**
 * Plan-domain enforcement functions bound to one resolved config +
 * journaler. The method contracts are documented on the public `Gates`
 * interface in `gates.ts`, which re-exposes these seven unchanged.
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
  ): {
    red: boolean
    summary?: { file: string; head: string }
  }
  promptPlanNames(prompt: string): string[]
  planApprovalBinding(
    projectDir: string,
    candidates: string[],
  ): { name: string; key: string } | undefined
}

/**
 * Binds the plan-domain enforcement functions to a resolved config and
 * journaler. The plans-dir scan cache is instance-local: each `createGates`
 * call gets its own rescan cache, so multi-instance consumers never share
 * fail-open journaling.
 * @param config The resolved plugin configuration.
 * @param journaler The telemetry writer for gate and blocked entries.
 * @returns The seven plan-domain enforcement functions.
 */
export function createPlanGates(config: TurnstileConfig, journaler: Journaler): PlanGates {
  /**
   * The plan gate's guarding stage group: a user's waiver vocabulary for the
   * plan gate names the plan-reviewer stage as often as the executor stage
   * ("approve the plan, skip the plan-reviewer"), so either configured name
   * covers the plan gate. One constant; the enforcing dispatch
   * (`enforcePlanApproval`) and the status mirror (`planGateStatus`) both read
   * it, so the handler/dispatch agreement stays exact.
   */
  const planGateStages = [config.agents.planReviewer, config.agents.executor]

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
  // (`name:sha256hex,…`). A key hit returns the cached scan and skips the
  // per-file hashing, the utf8 decode, and the `## Decomposition` search; a
  // key miss recomputes the scan (fileKeys, decomp, decompFile). Any fs
  // error throws to the caller's fail-open.
  let plansCache: { key: string; scan: PlansScan } | null = null

  /** What one plans-dir scan establishes for both plan gates. */
  interface PlansScan {
    /**
     * Content signature of the plans dir: `name:sha256hex,…`. Two scans
     * with different keys mean the plans dir _content_ changed (an add,
     * delete, rename, or same-size/content edit); a utimes-only or dir touch
     * leaves it identical — dir mtime is deliberately not hashed. The key is
     * path-free so an approval issued against one checkout survives a
     * same-content move; the empty dir maps to the `"empty"` sentinel (never
     * `""`, which would collide with the accept-once stamp).
     */
    key: string
    /** Sorted plan file names (empty when the dir holds no plans). */
    names: string[]
    /**
     * First (sorted) plan carrying a `## Decomposition` block, or null.
     * Derived from `decomp` for the legacy no-ledger rule; superseded by
     * active-plan resolution when a plan is bound or named.
     */
    decompFile: string | null
    /** Every plan name whose bytes carry a `## Decomposition` block. */
    decomp: Set<string>
    /** Every plan name → sha256 hex of its bytes (the bound-staleness key). */
    fileKeys: Map<string, string>
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
   * sha256 hex of one plan file's bytes: the per-file content identity that
   * both the dir key and a bound approval's key are built from — one hash per
   * file per scan, never recomputed.
   * @param bytes The plan file bytes.
   * @returns The hex digest.
   */
  function hashEntry(bytes: Buffer): string {
    return createHash("sha256").update(bytes).digest("hex")
  }

  /**
   * Content signature of the plans dir: `name:sha256hex,…`, path-free so a
   * same-content move survives an approval. Identical iff the plans dir's
   * content is identical — an add, delete, rename, or same-size/content edit
   * changes it; a utimes-only or dir touch does not. The empty dir emits the
   * literal sentinel `"empty"` (never `""`, which collides with the accept-once
   * stamp: an approval stamped on an empty dir must mismatch once a plan file
   * appears, journaling STALE loudly rather than silently re-stamping green).
   * @param pairs The plan name + per-file sha256 hex pairs from the scan.
   * @returns The path-free content signature, or `"empty"` when there are none.
   */
  function plansKey(pairs: Array<{ name: string; hash: string }>): string {
    if (pairs.length === 0) return "empty"
    return pairs.map((p) => `${p.name}:${p.hash}`).join(",")
  }

  /**
   * Scans the plans directory, returning the scan whose `key` is the dir's
   * content signature. The cache skips a redundant rescan: a key hit returns
   * the cached scan, skipping the utf8 decode and `## Decomposition` search;
   * a key miss replaces it — either way the returned key reports the dir's
   * current content. The key is path-free, so the cached scan is
   * directory-agnostic and a same-content move reuses it. One sha256 per file
   * per scan feeds both the dir key and the per-file `fileKeys` map.
   * @param dir Absolute plans directory path.
   * @returns The current scan; `scan.key` is the dir's path-free content signature.
   */
  function scanPlans(dir: string): PlansScan {
    const entries = readEntries(dir)
    const pairs = entries.map((e) => ({ name: e.name, hash: hashEntry(e.bytes) }))
    const key = plansKey(pairs)
    const cached = plansCache
    if (cached !== null && cached.key === key) return cached.scan
    const names = entries.map((e) => e.name)
    const decomp = new Set<string>()
    for (const e of entries) {
      if (e.bytes.toString("utf8").includes("## Decomposition")) decomp.add(e.name)
    }
    const scan: PlansScan = {
      key,
      names,
      decomp,
      fileKeys: new Map(pairs.map((p) => [p.name, p.hash])),
      decompFile: names.find((n) => decomp.has(n)) ?? null,
    }
    plansCache = { key, scan }
    return scan
  }

  /**
   * Single source for the plans-dir location: a relative value (the default)
   * joins the per-dispatch project dir; an absolute value is honored as-is
   * (validateResolved journaled a warning at load). Kept in one closure so the
   * plan-gate consumers never recompute the path.
   */
  function resolvePlansDir(projectDir: string): string {
    return path.isAbsolute(config.plansDir)
      ? config.plansDir
      : path.join(projectDir, config.plansDir)
  }

  /**
   * Extracts the plan file names a dispatch prompt mentions: the basenames of
   * every `*.md` token, last five (keeps a hostile or pathological prompt
   * bounded). Pure text — no fs, no membership check; callers resolve the
   * candidates against the current scan.
   * @param prompt The dispatch prompt text.
   * @returns The mentioned plan basenames in prompt order, capped at five.
   */
  function promptPlanNames(prompt: string): string[] {
    const matches = prompt.match(/[\w.-]+\.md/g)
    if (matches === null) return []
    return matches.map((m) => path.basename(m)).slice(-5)
  }

  /**
   * Resolves the plan a gate acts on: the dispatch prompt's name when it
   * names exactly one existing plan file (a prompt name beats the session
   * binding); else the session's bound plan when it still exists in the dir;
   * else null (callers fall back to the legacy first-sorted rule). A prompt
   * that names no plans, two or more distinct plans, or only missing files
   * resolves nothing from the prompt.
   * @param s The session's gate state (bound identity).
   * @param scan The current plans-dir scan.
   * @param prompt The dispatch prompt text.
   * @returns The resolved plan name, or null when unresolved.
   */
  function resolveActivePlan(s: GateState, scan: PlansScan, prompt: string): string | null {
    const named = new Set(promptPlanNames(prompt).filter((n) => scan.names.includes(n)))
    if (named.size === 1) return [...named][0]!
    if (s.approvedPlan !== "" && scan.names.includes(s.approvedPlan)) return s.approvedPlan
    return null
  }

  /**
   * Reconciles a session's approval with the current scan. A bound approval
   * (verdict + bound plan name + that file's content key) is checked
   * per-plan by `reconcileBoundStamp`; every other shape — including a bound
   * name with an empty key — keeps the dir-signature rule verbatim: a
   * non-empty stamp that differs from `scan.key` means the plan was
   * re-planned since approval, so the verdict is stale and re-review is
   * required; a green pass re-stamps the current key (idempotent, and how a
   * replay-restored "" becomes validated). A "" stamp is unknown: replayed
   * approvals now usually carry their journaled dir signature and validate
   * like live ones, so "" covers only field-less legacy lines and
   * genuinely unstampable approvals (absent/unreadable dir) — it is
   * accepted once, mirroring the old first-scan rule. The accept-once window also covers a
   * session that approved but never ran an enforcing dispatch: its stamp is
   * still empty until the first green dispatch stamps it.
   * @param s The session's gate state (mutated).
   * @param scan The current plans-dir scan.
   * @param sessionID The session whose stale drop is journaled.
   */
  function reconcilePlanStamp(s: GateState, scan: PlansScan, sessionID: string): void {
    if (s.hasPlanVerdict && s.approvedPlan !== "" && s.approvedPlanKey !== "") {
      reconcileBoundStamp(s, scan, sessionID)
      return
    }
    if (s.hasPlanVerdict && s.plansSignature !== "" && s.plansSignature !== scan.key) {
      s.hasPlanVerdict = false
      journaler.journal({ type: "plan", sessionID, result: "STALE", reason: "signature-mismatch" })
      journaler.traceEvent("plan-gate", "stale", "signature-mismatch", sessionID)
    }
    if (s.hasPlanVerdict) s.plansSignature = scan.key
  }

  /**
   * The bound half of `reconcilePlanStamp`: a bound approval is stale when the
   * bound plan has disappeared from the dir (`plan-missing`) or its content
   * key has changed (`plan-edited`) — changes to OTHER plans-dir files never
   * invalidate it. A still-matching bound plan re-stamps its key and the dir
   * signature idempotently (how a replay-restored bound verdict validates on
   * the next enforcing dispatch). A stale drop keeps the identity fields
   * (they inform the red preview and clear on the next stamp or reset).
   * @param s The session's gate state (mutated).
   * @param scan The current plans-dir scan.
   * @param sessionID The session whose stale drop is journaled.
   */
  function reconcileBoundStamp(s: GateState, scan: PlansScan, sessionID: string): void {
    const name = s.approvedPlan
    if (!scan.names.includes(name)) {
      s.hasPlanVerdict = false
      journaler.journal({ type: "plan", sessionID, result: "STALE", reason: "plan-missing" })
      journaler.traceEvent("plan-gate", "stale", "plan-missing", sessionID)
      return
    }
    // The name is a scan member, so its key exists (both structures are built
    // from the same entries); the assertion cannot fire.
    const currentKey = scan.fileKeys.get(name)!
    if (currentKey !== s.approvedPlanKey) {
      s.hasPlanVerdict = false
      journaler.journal({ type: "plan", sessionID, result: "STALE", reason: "plan-edited" })
      journaler.traceEvent("plan-gate", "stale", "plan-edited", sessionID)
      return
    }
    s.approvedPlanKey = currentKey
    s.plansSignature = scan.key
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
   * Builds the `{ file, head }` preview for one plan of a scan — the resolved
   * active name when given, else the first sorted plan (the legacy preview) —
   * reading that plan's bytes once (they were already read to compute the
   * scan key). Shared by both `planSummary` and the escalatable plan gate so
   * the ask names exactly the plan the resolved enforcement would act on.
   * @param scan The current plans-dir scan.
   * @param plansDir The absolute plans directory of `scan`.
   * @param activeName The resolved active plan name, or null/undefined for
   *     the first-sorted fallback.
   * @returns The plan's `{ file, head }`.
   */
  function planPreview(
    scan: PlansScan,
    plansDir: string,
    activeName?: string | null,
  ): { file: string; head: string } {
    // The callers guard names.length === 0 before calling, so names[0] exists;
    // the non-null assertion is enforced by that guard, not silently assumed.
    const name = activeName ?? scan.names[0]!
    const bytes = fs.readFileSync(path.join(plansDir, name))
    return { file: name, head: planHead(bytes) }
  }

  /**
   * Returns a plan file's name and a short body preview, or undefined when
   * the plans dir is absent, unreadable, or empty (fail-open; a named plan
   * that has since vanished fails open the same way). The preview is the
   * first ~40 non-heading lines of the named plan when `activeName` is
   * given, else the first sorted plan; shared with the escalatable plan gate
   * so the ask the evaluate handler surfaces names the same file and shows
   * its body.
   * @param projectDir The current project directory.
   * @param activeName Optional resolved active plan name; undefined falls
   *     back to the first sorted plan.
   * @returns `{ file, head }` for the active (or first sorted) plan, or undefined.
   */
  function planSummary(
    projectDir: string,
    activeName?: string,
  ): { file: string; head: string } | undefined {
    const plansDir = resolvePlansDir(projectDir)
    try {
      if (!fs.existsSync(plansDir)) return undefined
      const scan = scanPlans(plansDir)
      if (scan.names.length === 0) return undefined
      return planPreview(scan, plansDir, activeName)
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
   * approval are folded into `red`: a red result implies the task's waiver
   * does not cover this gate's stage group (no live waiver, or a waiver
   * scoped to other stages) and `hasPlanVerdict` is false, so the caller only
   * tests `red`. The
   * red preview names the resolved active plan (prompt-named, then
   * session-bound, then the first sorted fallback) — the same plan the
   * enforcement would act on, so a stale bound approval's ask still names
   * that plan.
   * @param projectDir The current project directory.
   * @param ledger The gate ledger to read (and reconcile) state from.
   * @param sessionID The parent session whose plan-gate state is read.
   * @param prompt Optional dispatch prompt text for active-plan resolution.
   * @returns `{ red: false }` when not red, or `{ red: true, summary }` when red.
   */
  function planGateStatus(
    projectDir: string,
    ledger: GateLedger,
    sessionID: string,
    prompt?: string,
  ): { red: boolean; summary?: { file: string; head: string } } {
    const s = ledger.state(sessionID)
    if (waiverCovers(s, planGateStages)) return { red: false }
    const plansDir = resolvePlansDir(projectDir)
    try {
      if (!fs.existsSync(plansDir)) return { red: false }
      const scan = scanPlans(plansDir)
      if (scan.names.length === 0) return { red: false }
      // Resolve the active plan BEFORE reconciling: a reconcile drop (bound
      // plan edited or missing) must still name that plan in the red preview
      // (the identity outlives the drop until the next stamp or reset).
      const active = resolveActivePlan(s, scan, prompt ?? "")
      // Reconcile this session's approval with the current scan (bound
      // per-plan rule or the unbound dir-signature rule — same as
      // enforcePlanApproval, so the handler and the dispatch agree). A stale
      // verdict is dropped loudly (STALE journaled) so the evaluate ask never
      // re-grants a stale approval.
      reconcilePlanStamp(s, scan, sessionID)
      if (s.hasPlanVerdict) return { red: false }
      return { red: true, summary: planPreview(scan, plansDir, active) }
    } catch (e) {
      // Journal the fail-open so an unreadable plans dir stays observable.
      journaler.journal({ type: "error", error: `plans dir unreadable: ${e}` })
      return { red: false }
    }
  }

  /**
   * Enforces the decomposition gate: when the resolved plan carries a
   * `## Decomposition` block, executor dispatches must cite the chunk-N /
   * AC-n they implement. The resolved plan is the dispatch prompt's named
   * plan when it names exactly one existing plan file, else the session's
   * bound plan when it still exists, else the first sorted decomposed plan
   * (the legacy rule — what a no-ledger call enforces, byte-identically).
   * Unreadable plans dirs fail open.
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
    sessionID: string,
    prompt: string,
    projectDir: string,
    ledger?: GateLedger,
  ): void {
    if (/\b(?:chunk-\d+|AC-\d+)\b/.test(prompt)) return
    const plansDir = resolvePlansDir(projectDir)
    try {
      if (!fs.existsSync(plansDir)) return
      const scan = scanPlans(plansDir)
      const active = ledger ? resolveActivePlan(ledger.state(sessionID), scan, prompt) : null
      const target = active ?? scan.decompFile
      if (target !== null && scan.decomp.has(target)) {
        journaler.journal({
          type: "blocked",
          sessionID,
          agent: config.agents.executor,
          reason: "missing-chunk-ref",
          plan: target,
        })
        throw new BlockError(
          `BLOCKED by turnstile: plan "${target}" has a ## Decomposition block — executor dispatches must cite the chunk-N / AC-n they implement.`,
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
    const plansDir = resolvePlansDir(projectDir)
    if (!fs.existsSync(plansDir)) return null
    try {
      return scanPlans(plansDir).key
    } catch (e) {
      // Journal the fail-open so the unreadable plans dir stays observable.
      journaler.journal({ type: "error", error: `plans dir unreadable: ${e}` })
      return null
    }
  }

  /**
   * Returns the plan identity to bind an approval to: the dispatch prompt's
   * plan candidates intersected with the current plans dir. Exactly one
   * distinct candidate that exists in the dir binds (`{ name, key }`, the
   * key being that file's sha256 hex); zero candidates, an ambiguous set, an
   * absent dir, or an unreadable dir fail open to undefined (the approval
   * stays unbound and keeps the dir-signature rule).
   * @param projectDir The current project directory.
   * @param candidates The plan names extracted from the dispatch prompt
   *     (`promptPlanNames` output).
   * @returns The unique bound identity, or undefined when unresolvable.
   */
  function planApprovalBinding(
    projectDir: string,
    candidates: string[],
  ): { name: string; key: string } | undefined {
    const plansDir = resolvePlansDir(projectDir)
    try {
      if (!fs.existsSync(plansDir)) return undefined
      const scan = scanPlans(plansDir)
      // Dedupe mentions: a prompt that names one plan twice is still unique.
      const hits = [...new Set(candidates)].filter((c) => scan.names.includes(c))
      if (hits.length !== 1) return undefined
      const name = hits[0]!
      // The name is a scan member, so its key exists.
      return { name, key: scan.fileKeys.get(name)! }
    } catch (e) {
      // Journal the fail-open so the unreadable plans dir stays observable.
      journaler.journal({ type: "error", error: `plans dir unreadable: ${e}` })
      return undefined
    }
  }

  /**
   * Enforces the plan-approval gate: when any plan file exists in the
   * configured plans directory, executor dispatches require a current
   * plan-reviewer `VERDICT: APPROVE` for the session (or a waiver). A bound
   * approval (the session's plan identity) is invalidated only when THAT
   * plan's content changes or the file disappears; unbound approvals
   * invalidate on any plans-dir change (the dir-signature rule). A stale
   * verdict is dropped loudly, journaling a replay-inert `STALE` plan entry
   * rather than a silent mismatch. The block message names the resolved
   * active plan (prompt-named, then session-bound, then first sorted).
   * The waiver is the task's prompt-channel waiver
   * (`ledger.state().userWaiver`, captured from the user prompt): a waiver
   * covers every gate while unscoped (the reviewer gate consumes an unscoped
   * waiver on the first dispatch it unlocks); naming configured agent names
   * in the waiver text scopes it to those stages' gates — this gate is
   * covered by either its plan-reviewer or executor stage name — and a
   * scoped waiver stays live until that stage's waiver allowance is spent,
   * metered separately from the ordinary dispatch caps; a new user prompt
   * drops the waiver. A waiver covering this gate is never consumed (the
   * plan gate is sticky).
   * @param sessionID The parent session ID.
   * @param projectDir The current project directory.
   * @param ledger The gate ledger to read and mutate plan state from.
   * @param prompt Optional dispatch prompt text for active-plan resolution.
   * @throws Error with a `BLOCKED by turnstile:` prefix when no plan file
   *     exists yet is approved for this task.
   */
  function enforcePlanApproval(
    sessionID: string,
    projectDir: string,
    ledger: GateLedger,
    prompt?: string,
  ): void {
    const s = ledger.state(sessionID)
    if (waiverCovers(s, planGateStages)) {
      journaler.journal({
        type: "plan",
        sessionID,
        result: "WAIVED",
        // Provenance: this waiver opened the gate from the user prompt, not a
        // dispatch prompt.
        channel: "prompt",
        // Waiver quotes carry raw prompt context; journal them only when
        // the trace is enabled (SECURITY.md redaction contract). `s.userWaiver`
        // is already trace-gated by the prompt-hook capture.
        waiver: s.userWaiver,
      })
      journaler.traceEvent("user", "plan-waiver", s.userWaiver, sessionID)
      return
    }
    const status = planGateStatus(projectDir, ledger, sessionID, prompt)
    // status.red ⇒ summary is always present: planGateStatus builds it from a
    // scan whose plan bytes were already read to compute the scan key, so the
    // non-null assertion is sound.
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
          `(a user prompt this task must contain the literal marker '${config.waiverMarker}' followed by the user's words).` +
          waiverStateNote(s, `${config.agents.executor} or ${config.agents.planReviewer}`),
      )
    }
  }

  return {
    enforceDecomposition,
    enforcePlanApproval,
    plansSignature,
    planSummary,
    planGateStatus,
    promptPlanNames,
    planApprovalBinding,
  }
}
