/**
 * @fileoverview Orchestrator-side turnstile policy, built from the resolved
 * config for runtime injection by the plugin (prepended into the parent
 * session's task/subagent result). This is the runtime source of truth, not a
 * file written to AGENTS.md at install: a fresh install can never lose
 * orchestrator policy because the plugin supplies it whenever it is loaded.
 * Per-agent instruction lines live in each `agents/<name>.md`. Marker wire
 * format is unchanged; the plugin parses markers from output text regardless
 * of which layer told the agent to emit them. Every GATE:/VERDICT: example
 * uses `<n>` placeholders so an echoed copy never parses into a real
 * gate/verdict — `parseMarkers` runs on any session text. The enforcement
 * numbers (loop caps, dispatch budget), the prompt markers, and the journal
 * paths are interpolated from config so the injected prose always matches the
 * mechanical enforcement.
 */

import type { TurnstileConfig } from "./types.ts"

/** The config slice the orchestrator policy text interpolates. */
export type PolicyConfig = Pick<
  TurnstileConfig,
  | "maxReviewerRounds"
  | "maxPlannerRounds"
  | "maxPlanReviewerRounds"
  | "maxTestRunnerRounds"
  | "maxTotalDispatches"
  | "waiverMarker"
  | "approvalMarker"
  | "metricsDir"
>

/**
 * Opening paragraph: provenance of the injected policy (runtime, not a file
 * on disk) and the unchanged marker wire format.
 * @returns The opening paragraph text.
 */
function openingSection(): string {
  return `Orchestrator policy is injected by the turnstile plugin (this runtime policy, not a file on disk): a fresh install can never lose it, because the plugin supplies it whenever it is loaded. Per-agent instruction lines live in each agents/<name>.md. Marker wire format is unchanged; the plugin parses markers from output text no matter which layer told the agent to emit them.`
}

/**
 * Pipeline order line: the fixed stage order the continuation imperative
 * dispatches through.
 * @returns The pipeline order line.
 */
function pipelineOrderSection(): string {
  return `Pipeline order: planner → plan-reviewer → executor → test-runner → reviewer.`
}

/**
 * Continuation imperative line: dispatch the next pipeline stage in the same
 * turn, treat a user's named dispatch list as a subset of the pipeline, end
 * at reviewer approval plus the landing gate, and obey the PIPELINE: status
 * line.
 * @returns The continuation imperative line.
 */
function continuationSection(): string {
  return `Continuation (imperative): whenever a child result arrives and the task has no reviewer APPROVE yet, dispatch the next agent in the order above in the same turn; the user's named dispatch list is a subset of the pipeline, not a replacement for it — follow the full order; the task ends at reviewer approval plus the landing gate, not at implementation completion; obey the PIPELINE: status line appended to each pipeline task result.`
}

/**
 * Waivers and approvals line: waiver/approval markers are user-authored
 * prompt literals; scoping by configured agent names, per-stage waiver
 * allowances, and the prohibition on fabricating or relaying markers. The
 * marker literals are interpolated from config.
 * @param c The resolved config slice (prompt markers).
 * @returns The waivers and approvals line.
 */
function waiversSection(c: PolicyConfig): string {
  return `Waivers and approvals: a waiver or a human plan approval is a user-authored prompt the plugin observes at prompt admission — put the literal marker in the user's OWN prompt to obtain one (\`${c.waiverMarker} <your words>\` to waive a gate, \`${c.approvalMarker} <your words>\` to approve the plan). Naming configured agent names in your words scopes the waiver to those stages' gates (the plan gate is covered by either the plan-reviewer or executor name); a scoped waiver stays live until that stage's waiver allowance — <n> waiver-unblocked dispatches, metered apart from the ordinary caps — is spent; an unscoped waiver covers every gate but the reviewer gate consumes it on the first dispatch it unlocks; a new user prompt drops it; a blocked dispatch reports whether a waiver is live, out of scope, or consumed. A dispatch prompt from an agent that merely contains the marker unlocks nothing; do not fabricate, paste, or relay a waiver/approval marker to open a gate — escalate to the user if none holds.`
}

/**
 * Plan gate line: executor dispatch requires a plan-reviewer APPROVE or a
 * human approval; the marker literals are interpolated from config.
 * @param c The resolved config slice (prompt markers).
 * @returns The plan gate line.
 */
function planGateSection(c: PolicyConfig): string {
  return `Plan gate: dispatch executor only after this task's plan-reviewer first line is \`VERDICT: APPROVE crit=<n> high=<n> med=<n> low=<n>\`, or a human approval (see waivers and approvals above: a \`${c.approvalMarker}\` in the user's prompt, or a \`${c.waiverMarker}\` waiver). If no approval holds, the first executor dispatch escalates to the human — see human-approval escalation below; do not attempt to bypass or auto-approve. plan-file changes invalidate the approval (re-plan, then re-dispatch plan-reviewer before resuming executor work).`
}

/**
 * Human-approval escalation line: the plan-gate permission prompt is a human
 * decision point to answer honestly.
 * @returns The human-approval escalation line.
 */
function escalationSection(): string {
  return `Human-approval escalation: when turnstile raises the plan gate through OpenCode's permission prompt, that prompt appears with the plan file + head and the human decides the outcome (reply \`always\` to approve, \`once\` for a single dispatch, or \`reject\`); respond to it honestly, do not attempt to bypass it or auto-approve.`
}

/**
 * Dispatch gate line: the reviewer gate's GATE: PASS requirement and cap,
 * the per-stage loop caps, and the total dispatch budget — all interpolated
 * from config.
 * @param c The resolved config slice (caps and budget).
 * @returns The dispatch gate line.
 */
function dispatchGateSection(c: PolicyConfig): string {
  return `Dispatch gate: dispatch reviewer only after this task's test-runner first line is \`GATE: PASS tests=<n> passed=<n> failed=<n>\`, or an explicit user waiver (from the user's prompt, per waivers and approvals); max ${c.maxReviewerRounds} reviewer dispatches per task (waived dispatches don't count toward the cap; a new user prompt resets it; a reviewer-scoped waiver stays live until its own allowance (${c.maxReviewerRounds} waiver-unblocked dispatches) is spent, then the round-limit escalates), then escalate the open findings to the user. Loop caps: per task the plugin also caps \`planner\`, \`plan-reviewer\`, and \`test-runner\` dispatches (${c.maxPlannerRounds}/${c.maxPlanReviewerRounds}/${c.maxTestRunnerRounds}) and a total dispatch budget (${c.maxTotalDispatches}); a blocked dispatch means the pipeline is looping — STOP, escalate to the user, do not re-dispatch; waived dispatches are exempt; a new user prompt resets all counters.`
}

/**
 * Marker parsing line: the machine-parseable first lines each stage emits,
 * all numeric fields as `<n>` placeholders.
 * @returns The marker parsing line.
 */
function markerParsingSection(): string {
  return `Marker parsing (orchestrator): the test-runner emits a machine-parseable first line, one of \`GATE: PASS tests=<n> passed=<n> failed=<n>\` or \`GATE: FAIL tests=<n> passed=<n> failed=<n>\`; a reviewer and a plan-reviewer each emit \`VERDICT: APPROVE crit=<n> high=<n> med=<n> low=<n>\` or \`VERDICT: BLOCK crit=<n> high=<n> med=<n> low=<n>\` on their first line. All numeric fields are <n> placeholders.`
}

/**
 * Reviewer ensemble line: two reviewer dispatches per task under
 * `reviewEnsemble: enforce`, waived reviews released only by the human, and
 * the finding-merge rules.
 * @returns The reviewer ensemble line.
 */
function ensembleSection(): string {
  return `Reviewer ensemble: dispatch two reviewer subagents on the same diff; turnstile mechanically counts unwaived reviewer dispatches per task (the \`{type:"ensemble"}\` journal entry, carrying the running count) and, under \`reviewEnsemble: enforce\` (default) refuses to consider the task reviewed — the landing gate stays red, escalate or obtain the permission-prompt release — until the second dispatch has been journaled; waived dispatches never satisfy the ensemble: a waived review is still released only by the human permission ask, never by the reviewer verdict; merge one finding per file+symbol at max severity; a singleton CRITICAL/HIGH blocks only after re-reading the cited location; LOW singletons become UNCONFIRMED notes.`
}

/**
 * Worktree/commit line: work in the current checkout, commit with a
 * conventional message, and the landing gate's reviewer-APPROVE requirement
 * for push/PR.
 * @returns The worktree/commit line.
 */
function worktreeCommitSection(): string {
  return `Worktree/commit: git worktrees will be used, but it does not matter how they get created; work inside the checkout and branch your session starts in; do not create/add/remove worktrees, switch branches, merge, or open PRs unless the user explicitly asks (these operations ride the host permission \`ask\`; turnstile's default denylist is empty and a configured \`bashDeny\` rule may deny them mechanically). On success, commit the change set with a conventional message — turnstile mechanically validates each subject as \`type(scope)!: subject\` (a \`-F\`/\`-t\`/\`--edit\`/interactive commit is uninspectable and blocked under \`gitGates.mode:\` \`enforce\`; pass it with \`git commit -m '<subject>'\`) and stop; if a worktree is in use, assert a \`WORKTREE:\` header for logging. Pushing this branch or a PR lands it on a shared remote, so with \`gitGates:\` on (default) the landing gate (\`git push\`, \`gh pr\`) waits for this task's reviewer verdict \`VERDICT: APPROVE crit=<n> high=<n> med=<n> low=<n>\` (a reviewer-delivered verdict only; streamed child text does not satisfy it) — turnstile raises the permission prompt on a repeat push with no approval, and the human decides the outcome (reply \`always\` for a standing approval, \`once\` for a single push, or \`reject\`); do not attempt to bypass or auto-approve.`
}

/**
 * Trace line: the human-readable dispatch/verdict trace and the JSONL
 * journal, at the configured metrics directory.
 * @param c The resolved config slice (metrics directory).
 * @returns The trace line.
 */
function traceSection(c: PolicyConfig): string {
  return `Trace (works with the plugin off): append every dispatch/verdict to ${c.metricsDir}/gate-events.jsonl as \`YYYY-MM-DD HH:MM | agent | event | detail\` (session-bound lines carry an optional trailing \` | <sessionID>\` segment). The plugin also writes ${c.metricsDir}/turnstile.jsonl ({ts,sessionID,type,...}); read: grep/glob/rg first, whole-file reads last.`
}

/**
 * Verification line: the host chain (npm run ci) and the install-drift chain
 * (npm run ci:installed) and when each runs.
 * @returns The verification line.
 */
function verificationSection(): string {
  return `Verification: the host chain (npm run ci, which is npm run ci:host) covers lint, format:check, typecheck, check:markers, and test on a fresh checkout and writes nothing under ~/.config; the install-drift chain (npm run ci:installed, which is npm run install:check) runs after npm run init, where a machine already has artifacts installed to check.`
}

/**
 * Builds the orchestrator policy injected into the parent session per task.
 *
 * One line per concern: the injected block is prepended to the model-facing
 * task output every task, so it costs tokens continuously. Marker examples
 * use `<n>` placeholders (never concrete digits, never a pipe-joined
 * PASS|FAIL) so `parseMarkers` on streamed session text can never mistake an
 * echo for a gate; the enforcement numbers, prompt markers, and journal paths
 * are interpolated from `c` so the prose matches the mechanical caps.
 * @param c The resolved config slice the text interpolates.
 * @returns The policy text: the opening paragraph, a blank line, then one
 *     line per section joined by single newlines.
 */
export function orchestratorPolicyFor(c: PolicyConfig): string {
  return [
    openingSection(),
    [
      pipelineOrderSection(),
      continuationSection(),
      waiversSection(c),
      planGateSection(c),
      escalationSection(),
      dispatchGateSection(c),
      markerParsingSection(),
      ensembleSection(),
      worktreeCommitSection(),
      traceSection(c),
      verificationSection(),
    ].join("\n"),
  ].join("\n\n")
}
