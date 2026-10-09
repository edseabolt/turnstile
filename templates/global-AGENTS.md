<!-- turnstile:start (managed block — edit templates/global-AGENTS.md in the
     turnstile repo, then rerun the installer; do not edit in place) -->

## Turnstile pipeline gates

Order: planner → executor → test-runner → reviewer. This file is the
source of truth for policy; the `turnstile` plugin (installed at
`~/.config/opencode/plugins/turnstile.ts`) enforces it mechanically.
Enforcement mechanics (regexes, thresholds, journals) are canonical in
turnstile's README; if prose here diverges from enforcement, trust the
plugin and fix this file. Advisory only if the plugin is absent.

Dispatch gate: dispatch `reviewer` only after this task's test-runner first
line is `GATE: PASS tests=<n> passed=<n> failed=<n>`, or after an explicit
user waiver. Max 2 reviewer dispatches per task; then escalate the open
findings to the user.

Markers (first line, machine-parseable):

- test-runner: `GATE: PASS|FAIL tests=<n> passed=<n> failed=<n>`
- reviewer: `VERDICT: APPROVE|BLOCK crit=<n> high=<n> med=<n> low=<n>`
- reviewer acceptance table: add an `AC-ID` column referencing `AC-<n>`
- planner: number criteria `AC-1…AC-n`; if the change spans >5 files or >3
  outcomes, add `## Decomposition` with ordered `chunk-N` entries (≤5 files)
- executor/debugger: 5-file budget; if 10 tool calls pass without a test
  command, STOP, emit a state summary, re-anchor on the plan.

Reviewer ensemble: dispatch two `reviewer` subagents on the same diff; merge
one finding per `file+symbol` (max severity). A singleton CRITICAL/HIGH
blocks only after re-reading the cited location; LOW singletons become
`UNCONFIRMED` notes.

Worktree/commit: git worktrees will be used, but it does not matter how they
get created. Work inside the checkout and branch your session starts in; do
not create/add/remove worktrees, switch branches, merge, or open PRs unless
the user explicitly asks. On success, commit your change set with a
conventional message and stop. If a worktree is in use, assert a `WORKTREE:`
header for logging; otherwise skip it. Committing on a shared default branch
means your change lands there; treat main/branch commits as high
sensitivity; do not self-reset.

Trace (works with the plugin off): append every dispatch/verdict to
`~/.local/share/opencode/metrics/gate-events.jsonl` as
`YYYY-MM-DD HH:MM | agent | event | detail`. The plugin also writes
`~/.local/share/opencode/metrics/turnstile.jsonl`
(`{ts,sessionID,type,...}`). Read: grep/glob/rg first, whole-file reads last.

<!-- turnstile:end -->
