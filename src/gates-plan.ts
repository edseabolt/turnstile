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
import type { GateLedger } from "./ledger.ts"
import type { GateState, TurnstileConfig } from "./types.ts"
import { BlockError, waiverCovers, waiverStateNote } from "./gates-common.ts"
import { planSpecRegion } from "./plan-region.ts"
import { classifyPlanImpact, planScopeFiles } from "./plan-scope.ts"
import type { PlanImpact, PlanScope } from "./plan-scope.ts"

/**
 * The red plan-gate status: the first blocker's preview, the blocker list,
 * and why the first blocker is pending — `never-approved` (no durable record
 * covers it) or `durable-key-stale` (a record exists but matches neither key
 * scheme; one re-approval re-keys it).
 */
export interface PlanGateRed {
  red: true
  summary: { file: string; head: string }
  blockers: string[]
  cause: "never-approved" | "durable-key-stale"
}

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
    /**
     * Every plan name → sha256 hex of its spec-region bytes (the
     * bound-staleness key; `# Progress` content is excluded — see
     * `src/plan-region.ts`).
     */
    fileKeys: Map<string, string>
    /**
     * Every plan name → sha256 hex of its whole-file bytes (the legacy
     * pre-spec-region approval key). The durable store matches a record
     * under either scheme, so a pre-spec-region record whose bytes are
     * unchanged still covers the plan.
     */
    wholeFileKeys: Map<string, string>
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
   * sha256 hex of one plan file's spec region (`planSpecRegion`): the per-file
   * content identity that both the dir key and a bound approval's key are
   * built from — one hash per file per scan, never recomputed.
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
    // The per-file key hashes the spec region (src/plan-region.ts), not the
    // whole file: the leading `# Progress` section is pipeline-maintained by
    // design, so a progress-only edit must not invalidate a bound approval.
    // Capture (planApprovalBinding), reconcile (reconcileBoundStamp), and the
    // durable sidecar compare all read this one map — one shared extractor,
    // one key shape everywhere.
    const pairs = entries.map((e) => ({ name: e.name, hash: hashEntry(planSpecRegion(e.bytes)) }))
    const key = plansKey(pairs)
    const cached = plansCache
    // Cache-hit caveat, accepted: the signature hashes spec regions only, so
    // a progress-only edit lands here and the returned scan's `wholeFileKeys`
    // still hash the bytes at the last refresh — the durable store's legacy
    // arm can then match against last-scan bytes rather than the current
    // file. Sound to honor: the hit proves the spec region unchanged since
    // that scan, and the re-key it triggers writes the current spec key. The
    // mirror edit-then-revert can leave whole-file hashes from the interim
    // bytes, false-blocking a legacy record until restart or the next
    // signature change rescan — fail-toward-strict, self-healing.
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
      wholeFileKeys: new Map(entries.map((e) => [e.name, hashEntry(e.bytes)])),
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
   * The plans a dispatch prompt references that exist in the current scan:
   * `promptPlanNames` deduped and filtered to the scan's names (a prompt that
   * mentions a missing plan or repeats an existing one resolves only the real,
   * unique mentions). Prompt order, capped at five (the cap is inherited from
   * `promptPlanNames`).
   * @param prompt The dispatch prompt text.
   * @param scan The current plans-dir scan to resolve against.
   * @returns The referenced existing plan names, prompt order, deduped, ≤ five.
   */
  function referencedPlans(prompt: string, scan: PlansScan): string[] {
    return [...new Set(promptPlanNames(prompt))].filter((n) => scan.names.includes(n))
  }

  /**
   * The pending plan names of a scan: the plans whose durable approval
   * (project-scoped, content-verified under either key scheme) no longer
   * covers the file on disk. A plan whose durable record is `live` — the
   * spec-region key or the legacy whole-file key matches — is exempt from
   * the plan gate; the rest are pending and drive its red state. Every scan
   * name carries a key in both maps (all are built from the same entries).
   * A live legacy record is transparently re-keyed to the current scheme as
   * a side effect (see `planApprovalState`).
   * @param scan The current plans-dir scan.
   * @param ledger The gate ledger carrying the durable approval store.
   * @param projectDir The current project directory (the scope key).
   * @param sessionID The parent session ID (the re-key journal row's
   *     provenance).
   * @returns The scan names lacking a live durable approval, in scan order.
   */
  function pendingPlans(
    scan: PlansScan,
    ledger: GateLedger,
    projectDir: string,
    sessionID: string,
  ): string[] {
    return scan.names.filter(
      (n) =>
        ledger.planApprovalState(
          n,
          scan.fileKeys.get(n)!,
          scan.wholeFileKeys.get(n)!,
          projectDir,
          sessionID,
        ) !== "live",
    )
  }

  /**
   * Why a plan is pending: `durable-key-stale` when a durable record exists
   * but matches neither key scheme (the plan was edited after approval, or
   * the record cannot prove the spec region unchanged), `never-approved`
   * otherwise (no usable record). Idempotent: a stale record re-probes
   * without writes — the re-key only fires on a live verdict.
   * @param scan The current plans-dir scan.
   * @param ledger The gate ledger carrying the durable approval store.
   * @param projectDir The current project directory (the scope key).
   * @param name The plan name to classify.
   * @returns The pending cause for the plan.
   */
  function pendingCauseOf(
    scan: PlansScan,
    ledger: GateLedger,
    projectDir: string,
    name: string,
  ): "never-approved" | "durable-key-stale" {
    return ledger.planApprovalState(
      name,
      scan.fileKeys.get(name)!,
      scan.wholeFileKeys.get(name)!,
      projectDir,
    ) === "stale-key"
      ? "durable-key-stale"
      : "never-approved"
  }

  /**
   * The decomposition fallback target for a scan: the first sorted decomposed
   * plan that is still pending (a durably-approved decomposed plan no longer
   * forces chunk citations for unrelated work), or — when no ledger is
   * present — the first sorted decomposed plan (the legacy rule, applied
   * byte-identically).
   * @param scan The current plans-dir scan.
   * @param projectDir The current project directory (the scope key).
   * @param sessionID The parent session ID (the re-key journal row's
   *     provenance).
   * @param ledger The optional gate ledger; absent, the legacy rule applies.
   * @returns The fallback plan name, or null when none applies.
   */
  function decompFallback(
    scan: PlansScan,
    projectDir: string,
    sessionID: string,
    ledger?: GateLedger,
  ): string | null {
    if (ledger === undefined) return scan.decompFile
    const pending = pendingPlans(scan, ledger, projectDir, sessionID)
    return scan.names.find((n) => scan.decomp.has(n) && pending.includes(n)) ?? null
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
   * Resolves the dispatch's blocker set from the pending list: the
   * prompt-referenced pending plans in prompt order, else the session-bound
   * pending plan, else (nothing resolvable) every pending plan in sorted
   * scan order. An empty result means the dispatch's own plan holds a live
   * approval, so the dispatch is exempt (green) even while other plans stay
   * pending; the exempt resolution is traced here, where it is decided.
   * @param scan The current plans-dir scan.
   * @param s The session's gate state (the bound-plan fallback).
   * @param sessionID The parent session ID (the exempt trace's provenance).
   * @param prompt The dispatch prompt text ("" when absent).
   * @param pending The pending plan names in scan order.
   * @returns The blocker names in resolution order (empty when exempt).
   */
  function resolveBlockers(
    scan: PlansScan,
    s: GateState,
    sessionID: string,
    prompt: string,
    pending: string[],
  ): string[] {
    const relevant = referencedPlans(prompt, scan)
    const relevantOrBound =
      relevant.length > 0
        ? relevant
        : s.approvedPlan !== "" && scan.names.includes(s.approvedPlan)
          ? [s.approvedPlan]
          : []
    const blockers =
      relevantOrBound.length > 0 ? relevantOrBound.filter((n) => pending.includes(n)) : pending
    if (blockers.length === 0) {
      journaler.traceEvent("plan-gate", "exempt", relevantOrBound.join(","), sessionID)
    }
    return blockers
  }

  /**
   * Decides the red shape once the session's approval has reconciled green:
   * the pending set, the resolved blockers, and the first blocker's preview
   * plus its pending cause. Returns null when nothing blocks the dispatch
   * (no pending plan, or the resolved set is exempt).
   * @param scan The current plans-dir scan.
   * @param ledger The gate ledger to read state from.
   * @param s The session's gate state (the bound-plan fallback).
   * @param sessionID The parent session ID.
   * @param prompt The dispatch prompt text ("" when absent).
   * @param projectDir The current project directory (the scope key).
   * @param plansDir The resolved plans directory (the preview's source).
   * @returns The red shape, or null when the dispatch is exempt.
   */
  function redStatus(
    scan: PlansScan,
    ledger: GateLedger,
    s: GateState,
    sessionID: string,
    prompt: string,
    projectDir: string,
    plansDir: string,
  ): PlanGateRed | null {
    const pending = pendingPlans(scan, ledger, projectDir, sessionID)
    if (pending.length === 0) return null
    const blockers = resolveBlockers(scan, s, sessionID, prompt, pending)
    if (blockers.length === 0) return null
    // Red implies at least one blocker; the cause classifies blockers[0],
    // the plan the journal row and preview already name.
    const first = blockers[0]!
    return {
      red: true,
      summary: planPreview(scan, plansDir, first),
      blockers,
      cause: pendingCauseOf(scan, ledger, projectDir, first),
    }
  }

  /**
   * Returns whether the plan-approval gate is currently red for a parent, and
   * when red, the plan file + body preview to surface in a permission ask.
   * Mirrors `enforcePlanApproval`'s guard (waived, absent/empty dir, a green
   * verdict, or no pending plan is not red; otherwise red) so the evaluate
   * handler and the enforcing dispatch decide escalation from the exact same
   * scan. Waiver, approval, and the pending set are folded into `red`: a red
   * result implies the task's waiver does not cover this gate's stage group
   * (no live waiver, or a waiver scoped to other stages), `hasPlanVerdict`
   * is false, and at least one genuine blocker is pending, so the caller
   * only tests `red`. "Pending" means the plan's bytes carry no live durable,
   * project-scoped approval in the ledger's approval store (a legacy
   * whole-file record whose bytes are unchanged is live and transparently
   * re-keyed). The gate resolves
   * the dispatch's relevant plans — the prompt-referenced existing plans, else
   * the session-bound plan, else (nothing resolvable) every pending plan —
   * and is red only when that resolution still holds a pending plan: a
   * dispatch whose own plan holds a live (durable or session) approval is
   * green even while unrelated plans stay pending, but with nothing
   * resolvable every pending plan blocks, as before. The red preview and
   * `blockers` name the resolved set's pending plans only — the
   * prompt-referenced pending plans in prompt order, else the session-bound
   * pending plan, else (nothing resolvable) every pending plan in sorted
   * scan order; the preview names `blockers[0]`, so a stale
   * bound approval's ask still names that plan. The red `cause` classifies
   * `blockers[0]`: `durable-key-stale` when a durable record matches neither
   * key scheme, `never-approved` otherwise.
   * @param projectDir The current project directory.
   * @param ledger The gate ledger to read (and reconcile) state from.
   * @param sessionID The parent session whose plan-gate state is read.
   * @param prompt Optional dispatch prompt text for active-plan resolution.
   * @returns `{ red: false }` when not red, or the red shape (summary is the
   *     first blocker's preview, `cause` its pending classification).
   */
  function planGateStatus(
    projectDir: string,
    ledger: GateLedger,
    sessionID: string,
    prompt?: string,
  ): { red: false } | PlanGateRed {
    const s = ledger.state(sessionID)
    if (waiverCovers(s, planGateStages)) return { red: false }
    const plansDir = resolvePlansDir(projectDir)
    try {
      if (!fs.existsSync(plansDir)) return { red: false }
      const scan = scanPlans(plansDir)
      if (scan.names.length === 0) return { red: false }
      // Reconcile this session's approval with the current scan (bound
      // per-plan rule or the unbound dir-signature rule — same as
      // enforcePlanApproval, so the handler and the dispatch agree). A stale
      // verdict is dropped loudly (STALE journaled) so the evaluate ask never
      // re-grants a stale approval. Reconciling before the pending set means
      // the drop is journaled before red is decided; resolving after it means
      // a green session skips the pending computation.
      reconcilePlanStamp(s, scan, sessionID)
      if (s.hasPlanVerdict) return { red: false }
      return (
        redStatus(scan, ledger, s, sessionID, prompt ?? "", projectDir, plansDir) ?? {
          red: false,
        }
      )
    } catch (e) {
      // Journal the fail-open so an unreadable plans dir stays observable.
      journaler.journal({ type: "error", error: `plans dir unreadable: ${e}` })
      return { red: false }
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
    if (/\b(?:chunk-\d+[a-z]?|AC-\d+)\b/.test(prompt)) return
    const plansDir = resolvePlansDir(projectDir)
    try {
      if (!fs.existsSync(plansDir)) return
      const scan = scanPlans(plansDir)
      // The resolved plan: the prompt's unique referenced existing plan, else
      // the session's bound plan when it still exists, else the decomposition
      // fallback (byte-identical to the legacy rule, including no-ledger calls).
      const s = ledger ? ledger.state(sessionID) : null
      const ref = ledger ? referencedPlans(prompt, scan) : []
      const named = ref.length === 1 ? ref[0]! : null
      const bound =
        named === null && s !== null && s.approvedPlan !== "" && scan.names.includes(s.approvedPlan)
          ? s.approvedPlan
          : null
      const target = named ?? bound ?? decompFallback(scan, projectDir, sessionID, ledger)
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
          "plan-gate",
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
   * key being that file's spec-region sha256 hex); zero candidates, an
   * ambiguous set, an
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
   * Journals the `plan WAIVED` entry + trace for a waiver-covered executor
   * dispatch. No `scope` stamp: this entry's shape never carries one (the
   * reviewer gate's WAIVED entry stamps the parsed scope when scoped).
   * Provenance: the waiver opened the gate from the user prompt, not a
   * dispatch prompt. The waiver quote carries raw prompt context and is
   * already trace-gated by the prompt-hook capture (SECURITY.md redaction
   * contract).
   * @param sessionID The parent session ID.
   * @param s The gate state carrying the live waiver.
   */
  function journalPlanWaiver(sessionID: string, s: GateState): void {
    journaler.journal({
      type: "plan",
      sessionID,
      result: "WAIVED",
      channel: "prompt",
      waiver: s.userWaiver,
    })
    journaler.traceEvent("user", "plan-waiver", s.userWaiver, sessionID)
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
   * @param sessionID The parent session ID.
   * @param plan The plan the row names (the first blocker's preview file).
   * @param reason The blocked reason (`no-plan-verdict` or
   *     `durable-key-stale`).
   */
  function journalPlanBlocked(
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
   * @param sessionID The parent session ID.
   * @param s The session's gate state (the waiver-state note's source).
   * @param status The red plan-gate status (blockers, summary, cause).
   */
  function blockPlanGate(sessionID: string, s: GateState, status: PlanGateRed): never {
    const plan = status.summary.file
    const phrase = listPhrase(status.blockers.map((n) => `"${n}"`))
    const tail =
      "`VERDICT: APPROVE crit=<n> high=<n> med=<n> low=<n>`, or obtain an explicit user waiver " +
      `(a user prompt this task must contain the literal marker '${config.waiverMarker}' followed by the user's words).` +
      waiverStateNote(s, `${config.agents.executor} or ${config.agents.planReviewer}`)
    if (status.cause === "durable-key-stale") {
      journalPlanBlocked(sessionID, plan, "durable-key-stale")
      throw new BlockError(
        `BLOCKED by turnstile: the durable plan approval for ${phrase} no longer covers the plan's current content (the plan changed after it was approved, or the approval was recorded under an obsolete key scheme). One ${config.agents.planReviewer} re-approval re-keys it: dispatch the ${config.agents.planReviewer} subagent; proceed with ${config.agents.executor} only after the ${config.agents.planReviewer}'s first line is ` +
          tail,
        "plan-gate",
      )
    }
    journalPlanBlocked(sessionID, plan, "no-plan-verdict")
    throw new BlockError(
      `BLOCKED by turnstile: no plan approval for ${phrase}. Dispatch the ${config.agents.planReviewer} subagent first; proceed with ${config.agents.executor} only after the ${config.agents.planReviewer}'s first line is ` +
        tail,
      "plan-gate",
    )
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
   * @param sessionID The parent session ID.
   * @param projectDir The current project directory.
   * @param ledger The gate ledger to read and mutate plan state from.
   * @param prompt Optional dispatch prompt text for active-plan resolution.
   * @throws Error with a `BLOCKED by turnstile:` prefix when the plans the
   *     dispatch resolves are pending (no live approval covers them).
   */
  function enforcePlanApproval(
    sessionID: string,
    projectDir: string,
    ledger: GateLedger,
    prompt?: string,
  ): void {
    const s = ledger.state(sessionID)
    if (waiverCovers(s, planGateStages)) {
      journalPlanWaiver(sessionID, s)
      return
    }
    const status = planGateStatus(projectDir, ledger, sessionID, prompt)
    // status.red ⇒ summary and blockers are present: the red branch builds the
    // summary from blockers[0]'s preview, so the journal keeps naming it.
    if (status.red) blockPlanGate(sessionID, s, status)
  }

  /**
   * The plan-impact scope cache: one entry per plan name, holding the
   * per-file sha256 key the entry was built from and the extracted scope.
   * A key hit reuses the scope without re-reading or re-tokenizing the plan
   * file; a key miss (the plan's spec region changed) or a name miss
   * rebuilds it. Bounded by the plans dir's plan count (one entry per name).
   */
  let impactScopeCache: { planName: string; key: string; scope: PlanScope } | null = null

  /**
   * Relativizes a tool target against the project dir: hosts report absolute
   * `filePath` values while plan scope entries are repo-relative, so the
   * equality arm would never match without this. A target resolving outside
   * the project dir (or equal to it) yields the empty string — the caller
   * classifies it `uninspectable`, which the hook layer maps to the
   * hands-on ladder.
   * @param projectDir The current project directory.
   * @param targetPath The raw write/edit target path.
   * @returns The repo-relative target, or "" when outside the project.
   */
  function relativizeTarget(projectDir: string, targetPath: string): string {
    const rel = path.relative(path.resolve(projectDir), path.resolve(targetPath))
    if (rel === "" || rel.startsWith("..") || path.isAbsolute(rel)) return ""
    return rel
  }

  /**
   * Builds (or cache-hits) the scope of the bound plan: the cache key is the
   * scan's per-file sha256 key, so a spec-region edit rebuilds and an
   * unchanged plan reuses the extracted scope without re-reading the file.
   * @param plansDir The resolved plans directory.
   * @param scan The current plans-dir scan.
   * @param activePlan The bound plan name (a scan member).
   * @returns The plan's extracted scope.
   */
  function planScopeFor(plansDir: string, scan: PlansScan, activePlan: string): PlanScope {
    const key = scan.fileKeys.get(activePlan)!
    if (
      impactScopeCache !== null &&
      impactScopeCache.planName === activePlan &&
      impactScopeCache.key === key
    ) {
      return impactScopeCache.scope
    }
    const bytes = fs.readFileSync(path.join(plansDir, activePlan))
    const scope = planScopeFiles(planSpecRegion(bytes))
    impactScopeCache = { planName: activePlan, key, scope }
    return scope
  }

  /**
   * Classifies a parent tool call's target against the bound active plan's
   * scope. Returns `"none"` when no plan is bound, the plan is absent from
   * the dir, or the plans dir is unreadable (fail-open, journaling the fs
   * error like the other plan-gate consumers). In equality mode (write/edit
   * targets) the target is first relativized against `projectDir` — hosts
   * report absolute paths while scope entries are repo-relative; a target
   * outside the project dir relativizes to "" and classifies
   * `uninspectable` — a verdict the hook layer maps to the hands-on ladder
   * rather than an allow. The scope is cached per plan keyed by the scan's per-file
   * sha256 key, so an unchanged plan is never re-read or re-tokenized.
   * Classifies with `classifyPlanImpact` — the plan-file-self rule names the
   * bound plan, so an edit to the plan file itself classifies `structural`.
   * @param projectDir The current project directory.
   * @param activePlan The bound active plan name ("" means none bound).
   * @param targetPath The write/edit file path, or the bash command text.
   * @param matchInText True for containment matching (bash command text),
   *     false for equality matching (write/edit targets).
   * @returns The impact classification (`none` / `advisory` / `structural` /
   *     `uninspectable`; fail-open `"none"`).
   */
  function planImpactFor(
    projectDir: string,
    activePlan: string,
    targetPath: string,
    matchInText: boolean,
  ): PlanImpact {
    if (activePlan === "") return "none"
    const plansDir = resolvePlansDir(projectDir)
    try {
      if (!fs.existsSync(plansDir)) return "none"
      const scan = scanPlans(plansDir)
      if (!scan.names.includes(activePlan)) return "none"
      const scope = planScopeFor(plansDir, scan, activePlan)
      const target = matchInText ? targetPath : relativizeTarget(projectDir, targetPath)
      if (target === "") return "uninspectable"
      // The self rule compares against the plans-dir-relative path (e.g.
      // `.opencode/plans/foo.md`), not the bare name — a bare-name match
      // would false-positive on any same-named file in the repo.
      const planRel = path.relative(path.resolve(projectDir), path.join(plansDir, activePlan))
      return classifyPlanImpact(target, scope, planRel, matchInText)
    } catch (e) {
      // Journal the fail-open so an unreadable plans dir stays observable.
      journaler.journal({ type: "error", error: `plans dir unreadable: ${e}` })
      return "none"
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
    planImpactFor,
  }
}
