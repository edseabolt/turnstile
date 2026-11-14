# Positioning: how turnstile fits the ecosystem

Claude Code's agent workflows are backed by host-side governance:
permission prompts and tool hooks that can stop a call before it
happens. Turnstile brings that shape to OpenCode: gates the
runtime enforces, not requests the model honors. It borrows the
enforcement model without the implementation, and stays
OpenCode-native: zero dependencies, TypeScript, loaded from your own
checkout.

The baseline question is what OpenCode v2 already provides natively:
subagents, per-tool permission rules, and prompt instructions. Those
cover the steering half of a pipeline. The mechanical half rests on
three capabilities the native surface structurally cannot express, and
each maps to a turnstile mechanism:

- **Stateful, task-scoped gates.** Permission rules are stateless
  per-tool-call decisions; they cannot condition a dispatch on prior
  task state. Turnstile's `GateState` buckets (`src/state.ts`), keyed
  per parent session and reset per prompt, make "executor blocked until
  this task's plan is approved" and per-leg round caps expressible
  and decidable in `tool.hook("execute.before")`, outside the model
  loop.
- **Evidence correlation.** No host feature verifies a model's claim
  against actual tool history. `src/evidence.ts` correlates a
  `GATE: PASS` marker with a recorded exit-0 test execution matching
  `evidencePattern` (the default covers the canonical `npm run ci`
  verification chain) before the reviewer gate flips; a bare marker stays
  `unverifiedPass` and never greens the gate under
  `gateEvidence:"enforce"`. The correlation re-runs when a child→parent
  edge resolves late (a background dispatch) and at reviewer-dispatch
  time, bounded to the parent's current task window (a prompt-admission
  stamp), so a stale prior-task execution cannot verify a new task's
  claim; a gate-unverified refusal names the sessions it searched
  (parent plus every child with journaled executions, with attribution
  reasons) in the `BLOCKED` message and the `searched` field of the
  journaled `blocked` entry.
- **A decision journal.** OpenCode logs are diagnostics, not a
  structured decision record. `src/journal.ts` appends every gate
  transition, block, waiver, and dispatch to a replayable JSONL trail
  (`replayGatePasses`, `src/ledger.ts`), which is what makes gates
  reviewable after the fact and stateful across restarts.

The README's pitch states the same three properties in one screen for
arriving readers; this section is where a developer can see the mechanisms
behind them.

Most other agent-structure projects on OpenCode are orchestration
suites: an orchestrator plans work, dispatches specialists, and
reconciles results. Some add pipeline discipline on top, but the
discipline is carried by prompts: a phase header the model prints at
the start of a response, a "review gate" step inside a skill's
instructions, a warning when a write lands without a prior test run.
Those asks work when the model complies. Turnstile's gates aim a step
further: they are decided in tool and task-dispatch hooks, outside the
model loop, so a dispatch that violates a gate fails before a subagent
session is created.

Turnstile is a layer under orchestration suites, not a competitor: it
reads task dispatches to attribute markers and enforce gates; it never
plans work, routes models, or spawns specialists. An orchestration
suite that dispatches task calls with agent names will pass through
turnstile unchanged unless a gate applies. Other adjacent approaches
gate on written artifacts, like spec workflows, or on a single
human-approval point; turnstile gates the machine steps around those.
The bundled planner/executor/test-runner/reviewer agents in
`agents/` are the reference pipeline, not a requirement; the
gates key off agent names and markers, and other suites' agents can
carry their own markers.

Three properties matter for comparing enforcement layers, and all three
are visible in this repo's tests:

- Verifiable state. `GATE:` and `VERDICT:` markers are parsed from
  child session text (`src/markers.ts`), stored per parent session
  (`src/ledger.ts`), and replayed from the JSONL journal on restart, so
  replayed gate state survives a restart and the next user prompt; then
  every later prompt starts a clean gate cycle rather than living in a
  prompt.
- Failure posture. Hooks fail open ([invariants](invariants.md)): an internal error is journaled and
  the call proceeds. The only refusals are deliberate
  `BLOCKED by turnstile:` throws at a declared gate. A broken
  enforcement plugin should degrade to prompt contracts, not break
  every session.
- Auditability. Every dispatch, gate transition, verdict, and blocked
  call is appended to `turnstile.jsonl` (bounded rotation, see
  SECURITY.md). The journal is the record of what was claimed, which is
  what makes the gates reviewable after the fact.

The tradeoff is scope: turnstile is host-coupled to the OpenCode v2
plugin API and enforces exactly the
pipeline above. Multi-harness suites reach further; turnstile goes
deeper on one host and one pipeline.

---

### Maintaining the diagrams

SVGs in `docs/images/` are rendered from D2 sources in `docs/diagrams/`
(dark theme 200):

```sh
d2 --theme 200 docs/diagrams/d01-modules.d2 docs/images/d01-modules.svg
```

Update the `.d2` source, re-render, and commit both.
