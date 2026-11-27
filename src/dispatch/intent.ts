/**
 * @fileoverview Stateless prompt-intent classifier for prompt admission: a
 * conservative detector of implementation intent in a user-authored prompt
 * (imperative work verbs addressed at code, a GitHub issue reference, a
 * plan-file reference, or a plan-dispatch request). Pure text in, one signal
 * kind or null out — no fs, no host access, no throwing: every read is a
 * total string operation, so the prompt admission path can call it unguarded
 * and still fail open. Deliberately conservative: questions, explanations,
 * status requests, and ordinary chat never classify, because a false positive
 * costs an advisory nudge line and a false negative costs nothing (the
 * reactive gates remain the structural backstop).
 */

/** One detected implementation-intent signal in a prompt. */
export type IntentKind =
  /** A GitHub issue reference (`#<n>`, an issue URL, or a `gh issue` mention). */
  | "issue"
  /** A plan-file reference (an `*.md` name, promptPlanNames-style). */
  | "plan-ref"
  /** A plan-dispatch request (run/dispatch the planner or pipeline). */
  | "dispatch"
  /** An imperative work verb addressed at the code. */
  | "work"

/**
 * The `IntentKind` union as a runtime list — the canonical source every
 * consumer that must visit every kind (e.g. clearing all per-kind nudge
 * latch keys) iterates, so a new kind added to the union cannot be missed.
 */
export const INTENT_KINDS: readonly IntentKind[] = ["issue", "plan-ref", "dispatch", "work"]

/**
 * Interrogative opener: a prompt that starts with a question word (or an
 * auxiliary verb forming a question) is a question or a request for
 * information, not implementation work — even when it also names a work verb
 * or an issue ("how do I fix the gate?" must not classify).
 */
const INTERROGATIVE_RE =
  /^\s*(can|could|would|should|is|are|am|do|does|did|has|have|was|were|what|how|why|when|where|which|who|whom|whose)\b/i

/**
 * Explanation/status framing anywhere in the prompt: asking for an
 * explanation, a description, a summary, or a status report is chat, not
 * implementation work ("can you explain how the gate works?" must not
 * classify even though it carries no question mark opener).
 */
const EXPLANATORY_RE =
  /\b(explain|explained|explaining|describe|summarize|summarise|summary|status|progress)\b/i

/**
 * GitHub issue reference: a bare `#<n>` token (delimited on the left by
 * start-of-text or a non-word char, so `#123` matches but `abc#1` in an
 * identifier does not, and CSS-color-like `#fff` does not), a GitHub issue
 * URL, or an explicit `gh issue` CLI mention.
 */
const ISSUE_REF_RE = /(^|[^\w])#\d+\b|github\.com\/[\w.-]+\/[\w.-]+\/issues\/\d+|\bgh issue\b/i

/**
 * Plan-file reference: an `*.md` token anywhere in the prompt. Same
 * token shape the plan gate's `promptPlanNames` extracts (word/dot/dash
 * run ending in `.md`); the classifier only needs existence, not the
 * basename list, so it does not re-derive one.
 */
const PLAN_FILE_RE = /[\w.-]+\.md/i

/**
 * Plan-dispatch request: a launch verb near a planner/pipeline mention, so
 * "dispatch the planner", "run the pipeline", "kick off the planner" classify
 * while a bare verb does not. The 40-char window keeps the two phrases
 * adjacent without spanning a sentence boundary.
 */
const DISPATCH_RE = /\b(dispatch|run|kick\s?off|start|begin)\b[^.!?\n]{0,40}\b(planner|pipeline)\b/i

/**
 * Imperative work verbs addressed at code: the conservative set of verbs
 * that plausibly open an implementation request. Questions are already
 * excluded by the framing guard, so a hit here reads as an instruction.
 */
const WORK_VERB_RE =
  /\b(fix|implement|refactor|add|create|write|update|remove|delete|patch|debug|migrate|port|extract|rename|land|ship|build|address|resolve)\b/i

/**
 * True when the prompt reads as a question, an explanation request, a status
 * request, or ordinary chat — the deliberate non-intent framings.
 * @param prompt The user prompt text (any string).
 * @returns True when the framing excludes implementation intent.
 */
function isNonIntentFraming(prompt: string): boolean {
  if (prompt.includes("?")) return true
  if (INTERROGATIVE_RE.test(prompt)) return true
  return EXPLANATORY_RE.test(prompt)
}

/**
 * Classifies one user prompt for implementation intent, returning the first
 * matching signal in a fixed priority order (issue reference, plan-file
 * reference, plan-dispatch request, work verb). Total on any string input:
 * every step is a plain regex test, so it never throws and the prompt
 * admission path needs no guard around the call itself.
 * @param prompt The user prompt text (any string, possibly empty).
 * @returns The detected signal kind, or null when the prompt carries no
 *     implementation intent (including every question, explanation, status
 *     request, and chat framing).
 */
export function classifyIntent(prompt: string): IntentKind | null {
  if (typeof prompt !== "string" || prompt === "" || isNonIntentFraming(prompt)) return null
  if (ISSUE_REF_RE.test(prompt)) return "issue"
  if (PLAN_FILE_RE.test(prompt)) return "plan-ref"
  if (DISPATCH_RE.test(prompt)) return "dispatch"
  if (WORK_VERB_RE.test(prompt)) return "work"
  return null
}
