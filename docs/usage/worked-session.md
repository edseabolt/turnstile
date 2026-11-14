# A worked session

The annotated transcript of the pipeline running on a real task, with the
journal entries behind each step. Assume a fresh task on a repo with the
plugin installed (`npx opencode-turnstile init`) and OpenCode restarted.

**Prompt 1 — start from the planner.** You paste the issue and ask for the
pipeline explicitly, but even a plain "fix X" prompt routes through the
injected orchestrator policy:

```text
Work on issue #42 (flaky retry in the upload path). Start from the planner:
produce a plan with a decomposition, then run the pipeline through review.
```

What happens, mechanically:

- The prompt is admitted (`session.hook("prompt")` → `admitPrompt`): the
  session becomes a _parent_, prior gate state resets (a new prompt is a new
  task), no waiver/approval literals are found.
- The orchestrator dispatches the **planner** (loop cap: 3 per task). The
  planner writes a plan with numbered `AC-n` / `chunk-N` entries under
  `## Decomposition` to `.opencode/plans/`.
- The planner's delivery comes back with the status tail:

```text
PIPELINE: planner=done plan=PENDING tests=RED reviewer=0/2
next=plan-reviewer — dispatch the next agent in this same turn
```

- Journal entries: a `dispatch` entry for the planner, a `policy` entry
  recording the injected orchestrator policy head (`injected:true`).

**Prompt continues in the same turn — plan-reviewer.** The orchestrator
dispatches the **plan-reviewer**. Two outcomes:

- `VERDICT: APPROVE crit=…` — the approval flips `hasPlanVerdict`, journaled
  as a `verdict` entry, and the executor gate goes green.
- `VERDICT: BLOCK crit=…` — the orchestrator sends the plan back to the
  planner for revision; the newest dispatched plan-reviewer round wins when
  the revised plan is re-reviewed. Nothing is dead-ended; you just watch it
  iterate (or stop it with a plain prompt).

The delivery tail now reads:

```text
PIPELINE: plan-reviewer=done plan=APPROVED tests=RED reviewer=0/2
next=executor — dispatch the next agent in this same turn
```

**Prompt continues — executor.** The **executor** dispatch is allowed only
because the plan gate is green. Two gates bind it:

- _Decomposition gate_: the executor's result must cite `chunk-N` / `AC-n`
  entries from the plan's `## Decomposition` block — implementation traces
  to the plan. A result that cites nothing is journaled as a violation.
- The executor is temperature-clamped ≤ 0.2 (as are test-runner and
  debugger).

Had the plan not been approved, the dispatch would have failed before the
subagent session was created:

```text
BLOCKED by turnstile: no plan approval for "<plan path>". Dispatch the
plan-reviewer subagent first; proceed with executor only after the
plan-reviewer's first line is `VERDICT: APPROVE crit=<n> high=<n> med=<n>
low=<n>`, or obtain an explicit user waiver (a user prompt this task must
contain the literal marker 'USER WAIVER:' followed by the user's words).
```

— and, with no approval holding, the first executor attempt escalates:
under the default `escalation: "block"` it blocks outright, while
`escalation: "ask"` raises it to you as an interactive permission ask naming
the plan file and its head (`always` = approved for the task, `once` = one
dispatch, `reject` = gate stays red).

**Prompt continues — test-runner.** The **test-runner** runs the suite and
emits its marker as the first line of its output:

```text
GATE: PASS tests=12 passed=12 failed=0
```

The marker may be wrapped in markdown backticks (inline or inside a fenced
code block) — the parser credits the backticked form identically. A marker
that is missing or malformed keeps the gate red.

Under the default `gateEvidence:enforce`, that marker only flips the gate
when a real exit-0 test execution exists in this task's bash/shell history
(matched against `evidencePattern`). A pass claimed without a run is held
as `unverifiedPass` and promoted the moment the execution is journaled —
including when a background child's edge resolves late. A `GATE: FAIL`
latest-wins: it un-greens an earlier PASS and sends the orchestrator back to
the executor.

**Diagnosing a red gate.** A `no-gate-pass` block despite a real green test
run usually means the marker was emitted by an agent turnstile does not
contract for gate markers, so the marker was journaled as `suppressed`
instead of flipping state. Check
`~/.local/share/opencode/metrics/turnstile.jsonl` for entries with
`type:"suppressed", kind:"gate"`: the `reason` field names the cause —
`emitter agent unresolved` (the emitting session's agent could not be
resolved) versus `agent not contracted for kind` (the agent is known but is
not the configured emitter for gate markers, e.g. a test runner named
`build` without `agents.testRunner` set). The fix is configuration, not
marker retry: set `agents.testRunner` (and the other `agents.*` names if
your pipeline uses custom names) as described in
[Installing and maintaining](install.md), then re-run.

**Prompt continues — reviewer, twice.** The **reviewer** is gated on the
verified pass and capped at 2 dispatches per task. Under the default
`reviewEnsemble:enforce`, a single reviewer APPROVE does not credit the
landing gate — the orchestrator dispatches the reviewer a second time
(unwaived), and only then does the approval carry.

A reviewer running on a waived dispatch never counts toward the ensemble:
a fully waived review leaves the landing gate red regardless of the verdict.

**Landing.** With a credited reviewer approval held, the landing gate
releases `git push` and it goes through. A push without approval is
refused (`"reason":"no-landing-approval"`) and a repeat attempt arms the
one-shot ask latch and forces the interactive human permission ask in BOTH
`escalation` modes (the block-throw is only the no-human fallback); the
gate also releases on your explicit `PLAN APPROVED:` prompt marker or an
earned reviewer verdict. Commit subjects are linted as conventional
commits (`gitGates.commitMessages: true`, the default): `git commit -m` must
match `<type>(<scope>)?: <subject>` — type one of
`feat|fix|docs|style|refactor|perf|test|build|ci|chore|revert`, an optional
`(scope)`, a separator followed by a space (`: `, `! `, or `!: `), a subject of
1–72 characters, and at most
one body line. An invalid subject blocks the commit, and the block message
names exactly what was wrong; after `gitGates.commitRetryThreshold` (default 3)
failed attempts within `gitGates.commitRetryWindowMs` (default 60000 ms) in the
same session, the block also carries a full canonical example. Gates are always
enforced — there is
no audit-only mode. The opt-outs are per-feature: `gitGates.landingGate:
false` disables the landing gate, `gitGates.commitMessages: false`
disables commit lint, and `TURNSTILE OFF:` suspends everything for the
session (config is read once at setup).

**Prompt 2 — a new task.** Your next prompt resets the session's gate state
(a restart-restored flag survives exactly the resume prompt, then reverts —
`replayGrace`). Earned state from issue #42 does not leak into the next
task; the pipeline starts over. Exception: continuation carry (default on)
carries earned flags across a prompt whose worktree/branch fingerprint is
unchanged — gate-scoped, earned state only, never an unearned approval. An
interrupted review is recovered the same way: after a plan-bound task's test
gate went green, the next prompt re-admitted in the same worktree/branch
carries the green gate, the dispatch count, and the plan approval, so an
aborted reviewer can be re-dispatched without re-running the test-runner —
provided a reviewer dispatch was already counted (or a round waived) and no
approval was credited yet. The recovered scope then persists like any live
plan-bound green task, bounded by the ensemble cap and the landing gate.
Set
`continuationCarry: false` to restore a clean cycle every prompt.

### Dormant until engaged

By default turnstile sleeps. It arms when your prompt provides a plan (a
`PLAN APPROVED:` marker or a plan-file reference) or asks to run the
planner/pipeline, and it sleeps again when the task completes, when you type
`TURNSTILE OFF:`, or when a new prompt starts without continuation credit.
Set `"alwaysEnforce": true` in `~/.config/opencode/turnstile.json` to
restore the legacy always-armed behavior.

While dormant, the reactive gates (dispatch guards, hands-on and bash-write
ladders, landing gate, commit lint, read horizon) do not block — only the
user-configured denylists (`toolPolicy.bashDeny` / `toolPolicy.pathDeny`)
and the audit telemetry keep running, and a strong implementation-intent
prompt surfaces the existing one-time advisory nudge. Every engagement
transition journals a `type:"engagement"` row, and a restart restores the
last journaled value.

### User plan review (opt-in)

Set `"planUserReview": true` in `~/.config/opencode/turnstile.json` to insert
a human checkpoint between the planner and the plan-reviewer: after the
planner dispatch is admitted, the plan-reviewer dispatch is blocked with a
`BLOCKED by turnstile:` message naming the plans directory, and you resolve
the pause from your own prompt — `PLAN REVIEWED:` accepts the written plan
(edit the plan file first if you wish; the edited file is what the reviewer
reads), `PLAN REJECTED:` rejects it (the task scope is retired with no
counted plan-reviewer dispatch; a new planner dispatch re-arms the pause).
A pause armed by an earlier planner dispatch stays armed until you accept or
reject, even if you switch to a plan you wrote yourself (`PLAN APPROVED:`) —
the pending accept/reject literal is still required before the next
plan-reviewer dispatch.
The literals work only in your own prompt, waivers do not bypass the pause,
and the pending state survives both a restart (journal replay) and the next
prompt's task-scope boundary. `planReviewAcceptMarker` /
`planReviewRejectMarker` rename the literals (defaults `PLAN REVIEWED:` /
`PLAN REJECTED:`).

### Requirements phase (opt-in)

Set `"requirementsPhase": true` in `~/.config/opencode/turnstile.json` to
insert an optional, ungated requirements leg before the planner for
non-trivial tasks: the orchestrator first dispatches the `requirements`
subagent with your request verbatim, and it returns a spec — objective,
explicit and implied requirements, constraints, non-goals, numbered
acceptance criteria `AC-1…AC-n`, and Open Questions each marked **blocking**
or **non-blocking**. If any Open Question remains, the orchestrator presents
them to you and stops; your written answers are folded into the spec (an
"use your judgment" answer is recorded as an explicit delegation with its
scope), and only then is the planner dispatched — with the finalized spec
passed verbatim at the top of its dispatch prompt. Trivial tasks (small
fixes, renames, doc/config changes) skip the leg.

The phase is soft: it emits no marker and no gate. The only enforcement
surface is a loop cap — `maxRequirementsRounds` (default 2) dispatches per
task inside the total dispatch budget, waived dispatches exempt — and if the
spec keeps coming back without converging, the orchestrator escalates to you.
`agents.requirements` renames the agent (default `requirements`).
