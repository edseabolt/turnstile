# Turnstile — Architecture

Turnstile is an OpenCode v2 promise-plugin that mechanically enforces an agent
pipeline (**planner → plan-reviewer → executor → test-runner → reviewer**; an
optional, default-off requirements leg may precede the planner) by
interposing on the host's hook surface: every dispatch, read, shell call, and
user prompt is checked against per-parent gate state before it is allowed to
proceed. Enforcement is fail-open except for deliberate
`BLOCKED by turnstile:` errors.

Three ideas explain the whole plugin:

1. **A contract of markers.** Pipeline subagents emit machine-checkable first
   lines: the test-runner emits
   `GATE: PASS tests=<n> passed=<n> failed=<n>`; the reviewers emit
   `VERDICT: APPROVE|BLOCK crit=<n> high=<n> med=<n> low=<n>` (see
   `agents/test-runner.md`, `agents/reviewer.md`, `agents/plan-reviewer.md`).
   The planner emits no marker. Instead it produces numbered `AC-n` /
   `chunk-N` entries that the executor must cite and the plan gate scans for
   (`## Decomposition` in `.opencode/plans/`).
2. **Per-parent gate state.** Every session that admits a user prompt becomes a
   _parent_ (`ledger.markParent`). Gate flags, round counters, and the read
   budget all key off the parent via the `childToParent` edge map. A
   subagent's reads and dispatches draw down its parent's budget, never its
   own.
3. **Fail-open plumbing, fail-toward-strict enforcement.** Hook bodies catch
   their own errors and journal them; only deliberate `BlockError` decisions
   reach the host. Where evidence can go stale (plan edits), the plugin
   invalidates approvals rather than trusting them.

This document is the entry point to the architecture reference. The module
map — one boundary per file under `src/`, dependencies one way, no cycles —
lives in [modules.md](modules.md), with the
[d01-modules diagram](images/d01-modules.svg).

## Contents

| Section                                       | File                                                                 |
| --------------------------------------------- | -------------------------------------------------------------------- |
| Hooks: where the plugin intercepts the host   | [architecture/hooks.md](architecture/hooks.md)                       |
| A task, end to end                            | [architecture/task-flow.md](architecture/task-flow.md)               |
| Gate state machine                            | [architecture/gates.md](architecture/gates.md)                       |
| Persistence: journal and restart              | [architecture/persistence.md](architecture/persistence.md)           |
| Configuration surface                         | [architecture/configuration.md](architecture/configuration.md)       |
| Design invariants                             | [architecture/invariants.md](architecture/invariants.md)             |
| Policy injection                              | [architecture/policy-injection.md](architecture/policy-injection.md) |
| Security posture and limits                   | [architecture/security.md](architecture/security.md)                 |
| Positioning: how turnstile fits the ecosystem | [architecture/positioning.md](architecture/positioning.md)           |

For day-to-day operation — worked session, waivers, install, configuration —
see [usage.md](usage.md).
