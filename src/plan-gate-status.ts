/**
 * @fileoverview Plan-gate status mirror and plan-scope resolution: whether
 * the plan-approval gate is red for a parent (mirroring the enforcing
 * dispatch's guard so the evaluate handler and the dispatch decide escalation
 * from the exact same scan), the plan preview/summary surfaces, the approval
 * binding capture, and the plan-impact classifier with its owned scope cache.
 * Extracted from `src/gates-plan.ts`. Every consumer fails open: an
 * unreadable plans dir is journaled, never fatal.
 */

import * as fs from "node:fs"
import * as path from "node:path"

import type { Journaler } from "./journal.ts"
import type { GateLedger } from "./ledger.ts"
import type { GateState, TurnstileConfig } from "./types.ts"
import { waiverCovers } from "./gates-common.ts"
import { classifyPlanImpact, planScopeFiles } from "./plan-scope.ts"
import type { PlanImpact, PlanScope } from "./plan-scope.ts"
import { planSpecRegion } from "./plan-region.ts"
import { createPlansScanCache, journalPlansUnreadable, type PlansScan } from "./plans-scan.ts"

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
 * The plan gate's guarding stage group: a user's waiver vocabulary for the
 * plan gate names the plan-reviewer stage as often as the executor stage
 * ("approve the plan, skip the plan-reviewer"), so either configured name
 * covers the plan gate. One source; the enforcing dispatch
 * (`enforcePlanApproval`) and the status mirror (`planGateStatus`) both read
 * it, so the handler/dispatch agreement stays exact.
 * @param config The resolved plugin configuration.
 * @returns The stage names covering the plan gate.
 */
export function planGateStages(config: TurnstileConfig): string[] {
  return [config.agents.planReviewer, config.agents.executor]
}

/**
 * Extracts the plan file names a dispatch prompt mentions: the basenames of
 * every `*.md` token, last five (keeps a hostile or pathological prompt
 * bounded). Pure text — no fs, no membership check; callers resolve the
 * candidates against the current scan.
 * @param prompt The dispatch prompt text.
 * @returns The mentioned plan basenames in prompt order, capped at five.
 */
export function promptPlanNames(prompt: string): string[] {
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
export function referencedPlans(prompt: string, scan: PlansScan): string[] {
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
export function decompFallback(
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
 * @param journaler The telemetry writer for the stale-drop entries.
 * @param s The session's gate state (mutated).
 * @param scan The current plans-dir scan.
 * @param sessionID The session whose stale drop is journaled.
 */
function reconcilePlanStamp(
  journaler: Journaler,
  s: GateState,
  scan: PlansScan,
  sessionID: string,
): void {
  if (s.hasPlanVerdict && s.approvedPlan !== "" && s.approvedPlanKey !== "") {
    reconcileBoundStamp(journaler, s, scan, sessionID)
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
 * @param journaler The telemetry writer for the stale-drop entries.
 * @param s The session's gate state (mutated).
 * @param scan The current plans-dir scan.
 * @param sessionID The session whose stale drop is journaled.
 */
function reconcileBoundStamp(
  journaler: Journaler,
  s: GateState,
  scan: PlansScan,
  sessionID: string,
): void {
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
 * Resolves the dispatch's blocker set from the pending list: the
 * prompt-referenced pending plans in prompt order, else the session-bound
 * pending plan, else (nothing resolvable) every pending plan in sorted
 * scan order. An empty result means the dispatch's own plan holds a live
 * approval, so the dispatch is exempt (green) even while other plans stay
 * pending; the exempt resolution is traced here, where it is decided.
 * @param journaler The telemetry writer for the exempt trace.
 * @param scan The current plans-dir scan.
 * @param s The session's gate state (the bound-plan fallback).
 * @param sessionID The parent session ID (the exempt trace's provenance).
 * @param prompt The dispatch prompt text ("" when absent).
 * @param pending The pending plan names in scan order.
 * @returns The blocker names in resolution order (empty when exempt).
 */
function resolveBlockers(
  journaler: Journaler,
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
 * @param journaler The telemetry writer for the exempt trace.
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
  journaler: Journaler,
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
  const blockers = resolveBlockers(journaler, scan, s, sessionID, prompt, pending)
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
 * The state shared by the plan-gate status surfaces: the resolved config,
 * the journaler, the instance-local plans-scan cache, the gate's stage
 * group, and the owned impact-scope cache cell.
 */
interface PlanGateStatusState {
  /** The resolved plugin configuration. */
  config: TurnstileConfig
  /** The telemetry writer for gate and blocked entries. */
  journaler: Journaler
  /** The instance-local plans-dir scan cache. */
  cache: ReturnType<typeof createPlansScanCache>
  /** The plan gate's guarding stage group (see {@link planGateStages}). */
  stages: string[]
  /** The owned impact-scope cache cell (one entry, replaced in place). */
  impactScope: { entry: { planName: string; key: string; scope: PlanScope } | null }
}

/**
 * Builds (or cache-hits) the scope of the bound plan: the cache key is the
 * scan's per-file sha256 key, so a spec-region edit rebuilds and an
 * unchanged plan reuses the extracted scope without re-reading the file.
 * @param st The shared plan-gate status state.
 * @param plansDir The resolved plans directory.
 * @param scan The current plans-dir scan.
 * @param activePlan The bound plan name (a scan member).
 * @returns The plan's extracted scope.
 */
function planScopeFor(
  st: PlanGateStatusState,
  plansDir: string,
  scan: PlansScan,
  activePlan: string,
): PlanScope {
  const key = scan.fileKeys.get(activePlan)!
  const cached = st.impactScope.entry
  if (cached !== null && cached.planName === activePlan && cached.key === key) {
    return cached.scope
  }
  const bytes = fs.readFileSync(path.join(plansDir, activePlan))
  const scope = planScopeFiles(planSpecRegion(bytes))
  st.impactScope.entry = { planName: activePlan, key, scope }
  return scope
}

/**
 * Returns a plan file's name and a short body preview, or undefined when
 * the plans dir is absent, unreadable, or empty (fail-open; a named plan
 * that has since vanished fails open the same way). The preview is the
 * first ~40 non-heading lines of the named plan when `activeName` is
 * given, else the first sorted plan; shared with the escalatable plan gate
 * so the ask the evaluate handler surfaces names the same file and shows
 * its body.
 * @param st The shared plan-gate status state.
 * @param projectDir The current project directory.
 * @param activeName Optional resolved active plan name; undefined falls
 *     back to the first sorted plan.
 * @returns `{ file, head }` for the active (or first sorted) plan, or undefined.
 */
function planSummary(
  st: PlanGateStatusState,
  projectDir: string,
  activeName?: string,
): { file: string; head: string } | undefined {
  const plansDir = st.cache.resolvePlansDir(projectDir)
  try {
    if (!fs.existsSync(plansDir)) return undefined
    const scan = st.cache.get(plansDir)
    if (scan.names.length === 0) return undefined
    return planPreview(scan, plansDir, activeName)
  } catch (e) {
    // Journal the fail-open so the unreadable plans dir stays observable.
    journalPlansUnreadable(st.journaler, e)
    return undefined
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
 * @param st The shared plan-gate status state.
 * @param projectDir The current project directory.
 * @param ledger The gate ledger to read (and reconcile) state from.
 * @param sessionID The parent session whose plan-gate state is read.
 * @param prompt Optional dispatch prompt text for active-plan resolution.
 * @returns `{ red: false }` when not red, or the red shape (summary is the
 *     first blocker's preview, `cause` its pending classification).
 */
function planGateStatus(
  st: PlanGateStatusState,
  projectDir: string,
  ledger: GateLedger,
  sessionID: string,
  prompt?: string,
): { red: false } | PlanGateRed {
  const s = ledger.state(sessionID)
  if (waiverCovers(s, st.stages)) return { red: false }
  const plansDir = st.cache.resolvePlansDir(projectDir)
  try {
    if (!fs.existsSync(plansDir)) return { red: false }
    const scan = st.cache.get(plansDir)
    if (scan.names.length === 0) return { red: false }
    // Reconcile this session's approval with the current scan (bound
    // per-plan rule or the unbound dir-signature rule — same as
    // enforcePlanApproval, so the handler and the dispatch agree). A stale
    // verdict is dropped loudly (STALE journaled) so the evaluate ask never
    // re-grants a stale approval. Reconciling before the pending set means
    // the drop is journaled before red is decided; resolving after it means
    // a green session skips the pending computation.
    reconcilePlanStamp(st.journaler, s, scan, sessionID)
    if (s.hasPlanVerdict) return { red: false }
    return (
      redStatus(st.journaler, scan, ledger, s, sessionID, prompt ?? "", projectDir, plansDir) ?? {
        red: false,
      }
    )
  } catch (e) {
    // Journal the fail-open so an unreadable plans dir stays observable.
    journalPlansUnreadable(st.journaler, e)
    return { red: false }
  }
}

/**
 * Returns the current plans-dir signature for approval-time stamping, or
 * null when the dir is absent or unreadable (fail-open: an unstampable
 * approval behaves as unknown and is validated on the next enforcing
 * dispatch).
 * @param st The shared plan-gate status state.
 * @param projectDir The current project directory.
 * @returns The plans-dir content signature, or null when absent/unreadable.
 */
function plansSignature(st: PlanGateStatusState, projectDir: string): string | null {
  const plansDir = st.cache.resolvePlansDir(projectDir)
  if (!fs.existsSync(plansDir)) return null
  try {
    return st.cache.get(plansDir).key
  } catch (e) {
    // Journal the fail-open so the unreadable plans dir stays observable.
    journalPlansUnreadable(st.journaler, e)
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
 * @param st The shared plan-gate status state.
 * @param projectDir The current project directory.
 * @param candidates The plan names extracted from the dispatch prompt
 *     (`promptPlanNames` output).
 * @returns The unique bound identity, or undefined when unresolvable.
 */
function planApprovalBinding(
  st: PlanGateStatusState,
  projectDir: string,
  candidates: string[],
): { name: string; key: string } | undefined {
  const plansDir = st.cache.resolvePlansDir(projectDir)
  try {
    if (!fs.existsSync(plansDir)) return undefined
    const scan = st.cache.get(plansDir)
    // Dedupe mentions: a prompt that names one plan twice is still unique.
    const hits = [...new Set(candidates)].filter((c) => scan.names.includes(c))
    if (hits.length !== 1) return undefined
    const name = hits[0]!
    // The name is a scan member, so its key exists.
    return { name, key: scan.fileKeys.get(name)! }
  } catch (e) {
    // Journal the fail-open so the unreadable plans dir stays observable.
    journalPlansUnreadable(st.journaler, e)
    return undefined
  }
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
 * @param st The shared plan-gate status state.
 * @param projectDir The current project directory.
 * @param activePlan The bound active plan name ("" means none bound).
 * @param targetPath The write/edit file path, or the bash command text.
 * @param matchInText True for containment matching (bash command text),
 *     false for equality matching (write/edit targets).
 * @returns The impact classification (`none` / `advisory` / `structural` /
 *     `uninspectable`; fail-open `"none"`).
 */
function planImpactFor(
  st: PlanGateStatusState,
  projectDir: string,
  activePlan: string,
  targetPath: string,
  matchInText: boolean,
): PlanImpact {
  if (activePlan === "") return "none"
  const plansDir = st.cache.resolvePlansDir(projectDir)
  try {
    if (!fs.existsSync(plansDir)) return "none"
    const scan = st.cache.get(plansDir)
    if (!scan.names.includes(activePlan)) return "none"
    const scope = planScopeFor(st, plansDir, scan, activePlan)
    const target = matchInText ? targetPath : relativizeTarget(projectDir, targetPath)
    if (target === "") return "uninspectable"
    // The self rule compares against the plans-dir-relative path (e.g.
    // `.opencode/plans/foo.md`), not the bare name — a bare-name match
    // would false-positive on any same-named file in the repo.
    const planRel = path.relative(path.resolve(projectDir), path.join(plansDir, activePlan))
    return classifyPlanImpact(target, scope, planRel, matchInText)
  } catch (e) {
    // Journal the fail-open so an unreadable plans dir stays observable.
    journalPlansUnreadable(st.journaler, e)
    return "none"
  }
}

/**
 * Creates the plan-gate status mirror and plan-scope surfaces, bound to one
 * resolved config + journaler + plans-scan cache. The surfaces hold no
 * closure state beyond the shared state object (the impact-scope cache is
 * an owned cell on it), so the bodies live at module level.
 * @param config The resolved plugin configuration.
 * @param journaler The telemetry writer for gate and blocked entries.
 * @param cache The instance-local plans-dir scan cache.
 * @returns `planGateStatus`, `planSummary`, `plansSignature`,
 *     `planApprovalBinding`, and `planImpactFor`.
 */
export function createPlanGateStatus(
  config: TurnstileConfig,
  journaler: Journaler,
  cache: ReturnType<typeof createPlansScanCache>,
): {
  planGateStatus(
    projectDir: string,
    ledger: GateLedger,
    sessionID: string,
    prompt?: string,
  ): { red: false } | PlanGateRed
  planSummary(projectDir: string, activeName?: string): { file: string; head: string } | undefined
  plansSignature(projectDir: string): string | null
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
} {
  const st: PlanGateStatusState = {
    config,
    journaler,
    cache,
    stages: planGateStages(config),
    impactScope: { entry: null },
  }
  return {
    planGateStatus: (projectDir, ledger, sessionID, prompt) =>
      planGateStatus(st, projectDir, ledger, sessionID, prompt),
    planSummary: (projectDir, activeName) => planSummary(st, projectDir, activeName),
    plansSignature: (projectDir) => plansSignature(st, projectDir),
    planApprovalBinding: (projectDir, candidates) =>
      planApprovalBinding(st, projectDir, candidates),
    planImpactFor: (projectDir, activePlan, targetPath, matchInText) =>
      planImpactFor(st, projectDir, activePlan, targetPath, matchInText),
  }
}
