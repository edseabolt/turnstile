/**
 * @fileoverview Plan-scope extraction and impact classification (pure): given
 * a plan file's spec region, extract the repo-relative file paths the plan
 * names — split into the advisory set (Objective/steps prose) and the
 * structural set (everything after the `## Decomposition` heading) — and
 * classify a parent tool call's target against those sets. Pure text
 * functions, never throw, no fs: the plan-gate boundary (gates-plan.ts) owns
 * reading the plan bytes and failing open.
 *
 * Plan-file-self-edit rule: a parent edit whose target IS the active plan
 * file classifies `structural` (editing the plan's Decomposition is the
 * definition of a structural change). The caller passes the resolved plan
 * path for this check — see `classifyPlanImpact`.
 */

/**
 * The impact classification of one parent tool call against the active
 * plan's scope: `none` (no overlap — proceed silently), `advisory` (the
 * target is named in the plan's steps — the steps may go stale),
 * `structural` (the target is named in the plan's `## Decomposition` block,
 * or the target is the plan file itself — a replan is required), or
 * `uninspectable` (an equality-mode target the classifier cannot place
 * inside the project dir — produced only by the plan-gate boundary's
 * `planImpactFor`, never by `classifyPlanImpact`; the hook layer hands the
 * decision to the hands-on ladder).
 */
export type PlanImpact = "none" | "advisory" | "structural" | "uninspectable"

/** The two scope sets extracted from one plan's spec region. */
export interface PlanScope {
  /** Paths named before the `## Decomposition` heading (Objective/steps). */
  advisoryFiles: Set<string>
  /** Paths named after the `## Decomposition` heading. */
  structuralFiles: Set<string>
}

/**
 * The path-like token shape: a word-ish token ending in a file extension of
 * at least two characters, so prose words, `chunk-1` citations, and `e.g.`
 * abbreviations never match while `README.md` and `src/gates.ts` do.
 */
const PATH_TOKEN_RE = /[\w.@/-]*\/?[\w@-]+\.[A-Za-z][\w]+/g

/**
 * Normalizes one extracted or target path: strips surrounding
 * backticks/quotes and a leading `./`, so a plan's `` `./src/gates.ts` ``
 * matches a tool call's `src/gates.ts`.
 * @param raw The raw path token.
 * @returns The normalized repo-relative path.
 */
function normalizePathToken(raw: string): string {
  return raw
    .replace(/^[`'"]+/, "")
    .replace(/[`'"]+$/, "")
    .replace(/^\.\//, "")
}

/**
 * Extracts the path-like tokens from one text block, normalized.
 * @param text The block of plan prose to scan.
 * @returns The normalized paths found in the block (deduped by the caller's set).
 */
function extractPaths(text: string): Set<string> {
  const found = new Set<string>()
  for (const match of text.matchAll(PATH_TOKEN_RE)) {
    found.add(normalizePathToken(match[0]))
  }
  return found
}

/**
 * Splits a plan's spec region at the `## Decomposition` heading and extracts
 * each half's path tokens: tokens AFTER the heading land in
 * `structuralFiles` (touching them means the plan's decomposition is stale),
 * tokens before it land in `advisoryFiles` (the steps go stale). A plan
 * without a `## Decomposition` heading puts every path in `advisoryFiles`.
 * @param specRegion The plan's spec-region text (see `planSpecRegion`).
 * @returns The advisory and structural path sets.
 */
export function planScopeFiles(specRegion: string | Buffer): PlanScope {
  const text = typeof specRegion === "string" ? specRegion : specRegion.toString("utf8")
  const idx = text.indexOf("## Decomposition")
  const before = idx === -1 ? text : text.slice(0, idx)
  const after = idx === -1 ? "" : text.slice(idx)
  return { advisoryFiles: extractPaths(before), structuralFiles: extractPaths(after) }
}

/**
 * Classifies a parent tool call's target against a plan's scope. Two match
 * modes share this one implementation (DRY): write/edit targets use EQUALITY
 * matching against the scope paths (the target is the file being edited);
 * bash command text uses CONTAINMENT matching (any scope path appearing in
 * the command classifies — a `cp a b` naming a scope file is an overlap).
 * The plan-file-self rule: a target equal to the active plan file's own path
 * classifies `structural`. Pure, never throws.
 * @param target The write/edit file path, or the bash command text.
 * @param scope The plan scope extracted by `planScopeFiles`.
 * @param planFilePath The active plan file's own path ("" disables the
 *     self-edit rule).
 * @param matchInText True for containment matching (bash command text),
 *     false for equality matching (write/edit targets).
 * @returns The impact classification.
 */
export function classifyPlanImpact(
  target: string,
  scope: PlanScope,
  planFilePath: string,
  matchInText: boolean,
): PlanImpact {
  const normalized = normalizePathToken(target)
  const planPath = normalizePathToken(planFilePath)
  // The self rule matches the plan file by its plans-dir-relative path (e.g.
  // `.opencode/plans/foo.md`): a bare-name trailing-segment match would
  // false-positive on any same-named file elsewhere in the repo, so the
  // caller passes the plans-dir-relative path and the comparison is exact.
  if (planPath !== "" && normalized === planPath) return "structural"
  const inSet = (set: Set<string>): boolean =>
    matchInText ? [...set].some((p) => normalized.includes(p)) : set.has(normalized)
  if (inSet(scope.structuralFiles)) return "structural"
  if (inSet(scope.advisoryFiles)) return "advisory"
  return "none"
}
