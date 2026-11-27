/**
 * @fileoverview Maintenance-dispatch classification rules: the pure
 * predicates that decide whether a bookkeeping-only executor dispatch
 * (plan-progress upkeep, doc prose) rides the lighter maintenance path —
 * skipping the plan-approval and decomposition gates (no plan-reviewer
 * re-approval cycle) — or is gated as ordinary implementation work.
 * Eligibility is structural, not trust-based: the prompt declares maintenance
 * scope for the active plan AND the working-tree diff touches only non-src
 * surfaces. No marker syntax is introduced; the declaration is the literal
 * word "maintenance" plus the active plan's file name. The orchestration
 * (git probe, marker-guard spawn, per-plan cap metering, journaling) lives in
 * `hooks-core.ts`.
 */

/** Cap on maintenance dispatches per active plan. */
export const MAINTENANCE_MAX_PER_PLAN = 4

/** Working-tree directories a maintenance dispatch may never touch. */
const MAINTENANCE_FORBIDDEN_DIRS = ["src/", "tests/", "bin/", "scripts/"]

/** Exact config/schema/example files a maintenance dispatch may never touch. */
const MAINTENANCE_FORBIDDEN_FILES = [
  "examples/turnstile.example.json",
  "schemas/turnstile.schema.json",
  "opencode.json",
]

/**
 * True when a repo file touched by a maintenance diff is one whose prose
 * examples are marker-validated by `scripts/check-markers.mjs` (README.md,
 * docs/usage.md, agents/*.md). Such a file qualifies only when the marker
 * guard passes; a guarded `src/` file never reaches this check — it is
 * already disqualified by the forbidden-dir rule.
 * @param file The repo-relative path from the working-tree diff.
 * @returns True when the marker guard is required for eligibility.
 */
export function maintenanceMarkerSensitive(file: string): boolean {
  const p = file.replaceAll("\\", "/")
  return p === "README.md" || p === "docs/usage.md" || p.startsWith("agents/")
}

/**
 * Declares whether a dispatch prompt is maintenance-scoped for a plan: the
 * prompt names the active plan file (its scope) and carries the literal word
 * "maintenance" (its declaration). Both parts are structural; a prompt that
 * names the plan without the declaration, or declares maintenance with no
 * plan in scope, is ordinary work (fail closed).
 * @param prompt The dispatch prompt text.
 * @param plan The session's bound active plan name ("" when none).
 * @param candidates The plan names the prompt mentions (`promptPlanNames`).
 * @returns True when the prompt declares maintenance for the plan.
 */
export function maintenanceDeclared(prompt: string, plan: string, candidates: string[]): boolean {
  return plan !== "" && candidates.includes(plan) && /\bmaintenance\b/i.test(prompt)
}

/**
 * True when a diff file sits on the configured plans dir: the active plan
 * file surface. The dir is matched as a path component (anchored), never as
 * a substring, so a nested lookalike (`agents/.opencode/plans/x.md`) does
 * not qualify through this rule — it falls through to the marker-guard-
 * required `agents/` rule. A dir outside the project (`..`-relative) or an
 * empty dir matches nothing (fail closed).
 * @param p The normalized repo-relative diff path.
 * @param plansDirRel The plans dir as a repo-relative path (never absolute).
 * @returns True when the path is a `.md` file directly under the plans dir.
 */
function maintenancePlanSurface(p: string, plansDirRel: string): boolean {
  const dir = plansDirRel.replaceAll("\\", "/").replace(/\/+$/, "")
  return (
    dir !== "" &&
    dir !== ".." &&
    !dir.startsWith("../") &&
    p.startsWith(`${dir}/`) &&
    p.endsWith(".md")
  )
}

/**
 * Eligibility of one working-tree file for a maintenance dispatch. Allowed
 * surfaces: the active plan file (a `.md` under the configured plans dir),
 * docs (`docs/*.md`), `README.md`, `CONTRIBUTING.md`, and `agents/*.md`
 * prose — the marker-validated ones (README.md, docs/usage.md, agents/*.md)
 * only when the marker guard passes. Anything else — the src/tests/bin/
 * scripts trees, the exact config/schema/example files, or any unrecognized
 * path — disqualifies (fail closed).
 * @param file The repo-relative path from the working-tree diff.
 * @param markerGuard True when `scripts/check-markers.mjs` passed.
 * @param plansDirRel The configured plans dir as a repo-relative path
 *     (threaded from the caller, which resolves `plansDir` against the
 *     project directory; an absolute configured dir arrives pre-relativized).
 * @returns True when the file is an allowed maintenance surface.
 */
export function maintenanceFileEligible(
  file: string,
  markerGuard: boolean,
  plansDirRel: string,
): boolean {
  const p = file.replaceAll("\\", "/")
  if (MAINTENANCE_FORBIDDEN_DIRS.some((d) => p.startsWith(d))) return false
  if (MAINTENANCE_FORBIDDEN_FILES.includes(p)) return false
  if (p === "CONTRIBUTING.md") return true
  if (maintenancePlanSurface(p, plansDirRel)) return true
  if (p.startsWith("docs/")) {
    return p.endsWith(".md") && (!maintenanceMarkerSensitive(p) || markerGuard)
  }
  if (maintenanceMarkerSensitive(p)) return markerGuard
  return false
}

/**
 * Whole-diff eligibility for a maintenance dispatch: a null file list (git
 * unavailable or a failed probe) is ineligible; otherwise every touched file
 * must be an allowed surface.
 * @param files The repo-relative changed paths, or null on probe failure.
 * @param markerGuard True when `scripts/check-markers.mjs` passed.
 * @param plansDirRel The configured plans dir as a repo-relative path (see
 *     {@link maintenanceFileEligible}).
 * @returns True when the whole diff is maintenance-eligible.
 */
export function maintenanceDiffEligible(
  files: string[] | null,
  markerGuard: boolean,
  plansDirRel: string,
): boolean {
  return files !== null && files.every((f) => maintenanceFileEligible(f, markerGuard, plansDirRel))
}
