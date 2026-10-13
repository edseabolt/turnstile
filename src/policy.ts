/**
 * @fileoverview Orchestrator-side turnstile policy, exported for runtime
 * injection by the plugin (prepended into the parent session's
 * task/subagent result). This is the runtime source of truth, not a file
 * written to AGENTS.md at install: a fresh install can never lose orchestrator
 * policy because the plugin supplies it whenever it is loaded. Per-agent
 * instruction lines live in each `agents/<name>.md`. Marker wire format is
 * unchanged; the plugin parses markers from output text regardless of which
 * layer told the agent to emit them. Every GATE:/VERDICT: example uses `<n>`
 * placeholders so an echoed copy never parses into a real gate/verdict —
 * `parseMarkers` runs on any session text.
 */

/**
 * Orchestrator policy injected into the parent session per task.
 *
 * One line per concern: the injected block is prepended to the model-facing
 * task output every task, so it costs tokens continuously. Marker examples use
 * `<n>` placeholders (never concrete digits, never a pipe-joined PASS|FAIL) so
 * `parseMarkers` on streamed session text can never mistake an echo for a gate.
 */
export const ORCHESTRATOR_POLICY: string = `Orchestrator policy is injected by the turnstile plugin (this runtime policy, not a file on disk): a fresh install can never lose it, because the plugin supplies it whenever it is loaded. Per-agent instruction lines live in each agents/<name>.md. Marker wire format is unchanged; the plugin parses markers from output text no matter which layer told the agent to emit them.

Pipeline order: planner → plan-reviewer → executor → test-runner → reviewer.
Plan gate: dispatch executor only after this task's plan-reviewer first line is \`VERDICT: APPROVE crit=<n> high=<n> med=<n> low=<n>\`, or an explicit user waiver; plan-file changes invalidate the approval (re-plan, then re-dispatch plan-reviewer before resuming executor work).
Dispatch gate: dispatch reviewer only after this task's test-runner first line is \`GATE: PASS tests=<n> passed=<n> failed=<n>\`, or an explicit user waiver; max 2 reviewer dispatches per task (waived dispatches don't count toward the cap; a new user prompt resets it), then escalate the open findings to the user.
Marker parsing (orchestrator): the test-runner emits a machine-parseable first line, one of \`GATE: PASS tests=<n> passed=<n> failed=<n>\` or \`GATE: FAIL tests=<n> passed=<n> failed=<n>\`; a reviewer and a plan-reviewer each emit \`VERDICT: APPROVE crit=<n> high=<n> med=<n> low=<n>\` or \`VERDICT: BLOCK crit=<n> high=<n> med=<n> low=<n>\` on their first line. All numeric fields are <n> placeholders.
Reviewer ensemble: dispatch two reviewer subagents on the same diff; merge one finding per file+symbol at max severity; a singleton CRITICAL/HIGH blocks only after re-reading the cited location; LOW singletons become UNCONFIRMED notes.
Worktree/commit: git worktrees will be used, but it does not matter how they get created; work inside the checkout and branch your session starts in; do not create/add/remove worktrees, switch branches, merge, or open PRs unless the user explicitly asks. On success, commit the change set with a conventional message and stop; if a worktree is in use, assert a \`WORKTREE:\` header for logging.
Trace (works with the plugin off): append every dispatch/verdict to ~/.local/share/opencode/metrics/gate-events.jsonl as \`YYYY-MM-DD HH:MM | agent | event | detail\` (session-bound lines carry an optional trailing \` | <sessionID>\` segment). The plugin also writes ~/.local/share/opencode/metrics/turnstile.jsonl ({ts,sessionID,type,...}); read: grep/glob/rg first, whole-file reads last.
Verification: the host chain (npm run ci, which is npm run ci:host) covers lint, format:check, typecheck, check:markers, and test on a fresh checkout and writes nothing under ~/.config; the install-drift chain (npm run ci:installed, which is npm run install:check) runs after npm run init, where a machine already has artifacts installed to check.`
