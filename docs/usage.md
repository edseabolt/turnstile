# Turnstile — Usage

Day-to-day operation of the turnstile plugin: a worked session from planner
to landing, waivers and approvals in full, installing and maintaining the
plugin, the complete configuration reference, journals and retention, and
the `status` command. For how the plugin works inside — hook surface, gate
state machine, policy injection — see [`architecture.md`](architecture.md);
the module map lives in [`modules.md`](modules.md) and the journal catalog
in [`journal.md`](journal.md).

## Contents

| Section                                                | File                                                                             |
| ------------------------------------------------------ | -------------------------------------------------------------------------------- |
| A worked session                                       | [usage/worked-session.md](usage/worked-session.md)                               |
| Waivers and approvals                                  | [usage/waivers.md](usage/waivers.md)                                             |
| Installing and maintaining                             | [usage/install.md](usage/install.md)                                             |
| Configuration                                          | [usage/configuration.md](usage/configuration.md)                                 |
| Files and journals                                     | [usage/files-and-journals.md](usage/files-and-journals.md)                       |
| Status                                                 | [usage/status.md](usage/status.md)                                               |
| Field-tested on itself                                 | [usage/field-tested.md](usage/field-tested.md)                                   |
| Differential characterization harness — worked example | [usage/differential-characterization.md](usage/differential-characterization.md) |

## Marker quick-reference

Pipeline subagents emit machine-checkable markers as the first line of their
output. The test-runner emits the gate marker; the reviewers emit the verdict
marker:

```text
GATE: PASS tests=12 passed=12 failed=0
VERDICT: APPROVE crit=3 high=1 med=0 low=0
```

A `GATE: FAIL tests=… passed=… failed=…` un-greens an earlier PASS
(latest-wins), and a `VERDICT: BLOCK crit=… high=… med=… low=…` sends the
plan back to the planner. The full semantics live in
[usage/worked-session.md](usage/worked-session.md) and
[architecture/gates.md](architecture/gates.md).
