# Turnstile — Architecture

Turnstile is an OpenCode v2 promise-plugin that mechanically enforces an agent
pipeline (**planner → plan-reviewer → executor → test-runner → reviewer**) by
interposing on the host's hook surface: every dispatch, read, shell call, and
user prompt is checked against per-parent gate state before it is allowed to
proceed. Enforcement is fail-open — internal errors are journaled, never
thrown — except for deliberate `BLOCKED by turnstile:` errors.

This document is written for two audiences at once:

- **New users**: sections 1–4 explain what the plugin does to your sessions,
  which prompts unlock which gates, and where to look when a dispatch is
  blocked.
- **Developers**: sections 2, 5–8 map every module, hook, and state field to
  source. All claims carry function/hook names; `docs/diagrams/*.d2` are the
  editable sources for the SVGs in `docs/images/` (re-render with D2).

---

## Contents

1. [Overview](#1-overview)
2. [Module map](#2-module-map)
3. [Hooks: where the plugin intercepts the host](#3-hooks-where-the-plugin-intercepts-the-host)
4. [A task, end to end](#4-a-task-end-to-end)
5. [Gate state machine](#5-gate-state-machine)
6. [Persistence: journal and restart](#6-persistence-journal-and-restart)
7. [Configuration surface](#7-configuration-surface)
8. [Design invariants](#8-design-invariants)
9. [Policy injection](#9-policy-injection)
10. [Security posture and limits](#10-security-posture-and-limits)
11. [Positioning: how turnstile fits the ecosystem](#11-positioning-how-turnstile-fits-the-ecosystem)

---

## 1. Overview

Three ideas explain the whole plugin:

1. **A contract of markers.** Pipeline subagents emit machine-checkable first
   lines: the test-runner emits
   `GATE: PASS tests=<n> passed=<n> failed=<n>`; the reviewers emit
   `VERDICT: APPROVE|BLOCK crit=<n> high=<n> med=<n> low=<n>` (see
   `agents/test-runner.md`, `agents/reviewer.md`, `agents/plan-reviewer.md`).
   The planner emits no marker — instead it produces numbered `AC-n` /
   `chunk-N` entries that the executor must cite and the plan gate scans for
   (`## Decomposition` in `.opencode/plans/`).
2. **Per-parent gate state.** Every session that admits a user prompt becomes a
   _parent_ (`ledger.markParent`). Gate flags, round counters, and the read
   budget all key off the parent via the `childToParent` edge map — a
   subagent's reads and dispatches draw down its parent's budget, never its own.
3. **Fail-open plumbing, fail-toward-strict enforcement.** Hook bodies catch
   their own errors and journal them; only deliberate `BlockError` decisions
   reach the host. Where evidence can go stale (plan edits), the plugin
   invalidates approvals rather than trusting them.

Human decision points exist at every gate: a literal `USER WAIVER:` or
`PLAN APPROVED:` in the **user's own prompt** (never in an agent-composed
dispatch prompt), or an interactive permission ask the plugin escalates when a
gate is red.

---

## 2. Module map

One boundary per file under `src/`; dependencies flow one way, no cycles.
`turnstile.ts` stays a thin entry point (`{ id: "turnstile", server, setup }`;
`server` is a legacy v1 shim).

![Module map](images/d01-modules.svg)

| Module               | Responsibility                                                                                                                                      |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `turnstile.ts`       | Entry point: module shape + factory; the doc comment atop it is the authoritative contract summary                                                  |
| `src/setup.ts`       | Everything wired at runtime: config resolution, hook registration, prompt admission, verdict attribution, the event stream loop, lifecycle/disposal |
| `src/config.ts`      | Four-layer config (code defaults ⊕ `~/.config/opencode/turnstile.json` ⊕ env ⊕ injected opts), per-key validation, `configDigest`                   |
| `src/state.ts`       | `GateLedger`: per-parent `GateState` buckets (LRU), child→parent edges, child-verdict store, journal replay                                         |
| `src/markers.ts`     | Pure parsing of `GATE:`/`VERDICT:` regexes, dedup with first-sight provenance, cross-child suppression                                              |
| `src/gates.ts`       | Enforcement decisions: reviewer dispatch gate, loop caps, read horizon, plan-approval and decomposition gates, ensemble completeness                |
| `src/tool-policy.ts` | Stateless bash denylist, commit-message lint, landing-gate matching — throws the same `BlockError` as gates                                         |
| `src/evidence.ts`    | Correlates `GATE: PASS` against recorded exit-0 test executions per parent                                                                          |
| `src/fingerprint.ts` | Worktree fingerprint (git toplevel+branch) and the gate-scoped continuation-carry predicate                                                         |
| `src/journal.ts`     | Persistence: `turnstile.jsonl` audit trail + optional trace, append-only hot path with a periodic lock-guarded rename, fail-open appends            |
| `src/policy.ts`      | `ORCHESTRATOR_POLICY` prose injected into parent context once per task (placeholder digits so echoed text never parses as markers)                  |
| `src/types.ts`       | Host wire shapes, `GateState`, `TurnstileConfig`                                                                                                    |

---

## 3. Hooks: where the plugin intercepts the host

`setup(h)` registers seven interception points, each tracked for disposal and
counted into the load heartbeat (`type:"setup"`).

![Hook surface](images/d02-hooks.svg)

**`session.hook` ×3**

- **`prompt`** → `admitPrompt` (`setup.ts`): the single prompt-admission body,
  shared with the inbox stream and deduped on the host message id. Marks the
  session a live parent, performs `resetState` (with optional
  continuation-carry via `fingerprint.ts` when the worktree is unchanged),
  clears evidence and latches, and captures `USER WAIVER:` / `PLAN APPROVED:`
  literals.
- **`generate`** → decoding clamps: reviewer/plan-reviewer temperature forced
  to 0; executor/test-runner/debugger clamped ≤ 0.2.
- **`compaction`** → appends a system block demanding verbatim preservation of
  open findings, AC status, and the last GATE/VERDICT markers, then the live
  gate-state snapshot (`formatGateSnapshot`) from the ledger — concrete state,
  not just a demand. The snapshot's `GATE:`/`VERDICT:` tokens are de-tokenized
  (leading token lowercased) so it can never re-parse as an authoritative
  marker. It hydrates the parent bucket keyed off `draft.sessionID`, falling
  back to the last-admitted parent when the payload omits `sessionID`.

**`tool.hook("execute.before")`** — _all gating lives here_:

- `task`/`subagent`: dispatch budget (16 total), per-leg caps
  (planner 3 / plan-reviewer 3 / test-runner 4), plan-approval gate,
  decomposition gate, reviewer gate (green tests + round cap 2), one-shot
  grants.
- `read`: parent-keyed read horizon — warn at 8 whole-file reads, block at 15.
- `bash`/`shell`: bash denylist → commit-message lint → landing gate
  (`git push` requires reviewer approval).
- `write`/`edit`: path denylist.

**`tool.hook("execute.after")`** — observation only, never blocks: first surfaces any
config-validation warnings once per load (a `[turnstile] config:` block
prepended to the first string-output result, journaled `type:"config"`), then
parses markers out of task deliveries, attributes plan verdicts, credits reviewer
approval (ensemble-gated), prepends the orchestrator policy once per task,
corrects the read counter charge down when a read produced no string output
(`execute.before` charged it on the guard), and promotes an `unverifiedPass`
when a correlated exit-0 test execution appears.

**`permission.hook("evaluate")`** — never blocks; when the plan gate is red on
a task dispatch, or a push lacks reviewer approval, it _forces_ an interactive
`ask` to the user. Replies are matched to recorded ask request-IDs only:
`always` stands a verdict/approval, `once` releases exactly one dispatch/push,
`reject` keeps the gate red.

**`event.subscribe` loop** — child→parent edges (`session.created`), marker
parsing from streamed child text (`message.part.updated`,
`session.text.ended`, `session.text.delta`): each `GATE:`/`VERDICT:`
observation is applied only when the emitting session's agent holds the marker
contract for that kind (a `GATE:` from `test-runner`, a `VERDICT:` from
`reviewer` / `plan-reviewer`), and a denied observation is journaled
`suppressed` rather than flipping state, permission ask/reply bookkeeping,
prompt admission via `session.inbox.enqueued` (opencode ≥ 2.0.29, for hosts
where the prompt hook does not fire), and error telemetry. Streamed child text
is ingested through a per-session sliding window: a marker the host splits
across `session.text.delta` chunks is reassembled and re-parsed so a completed
marker is first-sighted once (dedup-suppressing the re-parse), then the window
ages out on the next task dispatch. A subscription that throws or a stream that
completes without abort is journaled and the consumer re-subscribes up to a
cumulative budget of 5 restarts; the terminal disablement journals and
`session.text.*` ingestion stops once the budget is spent (a throw while
aborted stays silent).

---

## 4. A task, end to end

The three lifelines: orchestrator (parent session), child subagent sessions,
and the journal — the only persistence edge.

![Task flow](images/d03-task-flow.svg)

A typical enforced run:

1. The user's prompt is admitted; a new task resets prior gate state (or
   carries earned flags across a continuation prompt with an unchanged
   worktree fingerprint).
2. The planner runs (subject only to loop caps); its `AC-n`/`chunk-N` plan
   lands in `.opencode/plans/`.
3. The plan-reviewer must APPROVE. A BLOCK dead-ends nothing: the plan is
   revised and re-review is attributed via round-scoped evidence (the newest
   dispatched plan-reviewer round wins within the parent).
4. The executor is gated on plan approval; its result must cite `chunk-N` /
   `AC-n` entries from the decomposition.
5. The test-runner's `GATE: PASS` may require corroborating exit-0 bash
   evidence (`gateEvidence:"enforce"`); without it the flag is held as
   `unverifiedPass` and promoted when evidence arrives.
6. The reviewer's APPROVE credits the landing gate — under
   `reviewEnsemble:"enforce"` only after ≥2 unwaived reviewer dispatches.
7. `git push` is blocked until reviewer approval exists; a repeat push arms the
   interactive landing ask.

---

## 5. Gate state machine

All state is keyed per parent session. `replayGrace` gives restart-restored
flags a one-prompt survival window; `continuationCarry` re-arms it when a
continuing prompt has an unchanged worktree fingerprint.

![Gate state machine](images/d04-gate-state.svg)

### What each gate blocks

| Gate               | Guard                                            | Blocks                                                                                                           | Escape hatches                                                             |
| ------------------ | ------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| Reviewer dispatch  | `guardReviewerDispatch`                          | reviewer task until `hasGatePass`; round cap 2                                                                   | `userWaiver`                                                               |
| Plan approval      | `enforcePlanApproval`                            | executor task until `hasPlanVerdict` + fresh path-free `plansSignature` (a same-content move survives)           | `userWaiver`, `PLAN APPROVED:`, permission `always`, one-shot `once` grant |
| Decomposition      | `enforceDecomposition`                           | executor task without `## Decomposition` in `.opencode/plans/`                                                   | —                                                                          |
| Loop caps / budget | `guardDispatchBudget`                            | planner>3, plan-reviewer>3, test-runner>4, total>16                                                              | `userWaiver`                                                               |
| Read horizon       | `guardReadLimit`                                 | whole-file read #15+ per parent (warn at 8)                                                                      | —                                                                          |
| Reviewer ensemble  | `reviewEnsembleComplete`                         | landing credit below 2 unwaived reviewer dispatches                                                              | `reviewEnsemble:"advise"`                                                  |
| Landing            | `guardLanding`                                   | `git push` without `hasReviewApprove`                                                                            | permission `always` / `once`                                               |
| Tool policy        | `guardBash` / `guardCommitMessage` / `guardPath` | denied git operations (worktree, branch switch, merge, `gh pr`), non-conforming commit subjects (`enforce` mode) | mode `shadow` / `off`                                                      |

### Key `GateState` fields (`src/types.ts`)

| Field                                                                                        | Set by                                                                                        | Cleared by                                                     | Blocks                                                              |
| -------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- | -------------------------------------------------------------- | ------------------------------------------------------------------- |
| `hasGatePass`                                                                                | first-sight `GATE: PASS`; evidence promotion; replay                                          | `GATE: FAIL` (latest-wins); prompt reset                       | reviewer dispatch                                                   |
| `unverifiedPass`                                                                             | `GATE: PASS` without correlated exit-0 test (`gateEvidence:"enforce"`)                        | green flip; FAIL; task reset                                   | reviewer block reason becomes `gate-unverified`                     |
| `hasPlanVerdict`                                                                             | plan-reviewer APPROVE; `PLAN APPROVED:`; permission `always`; replay                          | BLOCK; signature mismatch; prompt reset                        | executor dispatch                                                   |
| `plansSignature`                                                                             | stamped at approval from the path-free plans-dir signature                                    | BLOCK; plans-dir edit ⇒ mismatch ⇒ STALE journaled + re-review | stale approvals                                                     |
| `hasReviewApprove`                                                                           | reviewer APPROVE on task-result delivery, ensemble-gated; landing permission `always`; replay | prompt reset                                                   | `git push`                                                          |
| `userWaiver`                                                                                 | `USER WAIVER:` in the user's prompt only                                                      | consumed by the dispatch it unlocks; prompt reset              | exempts reviewer gate, plan gate, loop caps                         |
| `pendingOnceGrant.plan/.landing`                                                             | permission reply `once`                                                                       | consumed by one executor dispatch / one push                   | per-reason keying prevents cross-consumption                        |
| `reviewRounds`, `plannerRounds`, `planReviewerRounds`, `testRunnerRounds`, `totalDispatches` | dispatch guards                                                                               | prompt reset                                                   | round caps / budget                                                 |
| `reads`                                                                                      | `execute.before` increments; `execute.after` corrects a failed read                           | prompt reset                                                   | warn 8 / block 15                                                   |
| `replayGrace`                                                                                | journal replay; continuation-carry re-arm                                                     | consumed by first `resetState`                                 | one-prompt survival of restored flags                               |
| `taskFingerprint`                                                                            | stamped when `continuationCarry` on                                                           | new stamp                                                      | identity signal for carry                                           |
| `lastGateMarker`, `lastVerdictMarker`                                                        | stamped at first-sight `GATE:`/`VERDICT:` (de-tokenized, so they cannot re-parse)             | prompt reset                                                   | rendered into the compaction snapshot; display only, never enforces |

---

## 6. Persistence: journal and restart

![Journal and replay](images/d05-persistence.svg)

The journal lives outside the repo at `~/.local/share/opencode/metrics/`:

- **`turnstile.jsonl`** — the always-on audit trail (18 entry types:
  `setup`, `dispatch`, `gate`, `plan`, `verdict`, `ensemble`, `blocked`,
  `escalation`, `permission`, `attribution`, `policy`, `config`, `continuation`,
  `evidence`, `violation`, `tool`, `error`, `suppressed`). A `dispatch` entry is written at
  guard exit and stamps `blocked:true` when a guard rejected the attempt (the
  guard's own `blocked` entry is the countable signal; `scripts/status.mjs`
  excludes the stamp from its dispatches counter to avoid a double count).
  A `suppressed` entry is the audit trail for a `GATE:`/`VERDICT:` marker first
  observed from an unauthoritative emitter — an agent without the marker
  contract for that kind (`GATE:`↔`test-runner`, `VERDICT:`↔`reviewer` /
  `plan-reviewer`), or one whose agent could not be resolved. It is
  audit-only and replay-inert (nothing replays against a denial), its marker
  string carries the digits for forensics, and a re-delivery of identical text
  adds none (dedup stays registered). Both journal replay and the status
  aggregate treat it as inert.
  A `config` entry is the surface audit for the once-per-load `[turnstile]
 config:` block: `{type:"config", sessionID, surfaced:true, count}` on a
  successful prepend, or `{..., surfaced:false, error}` when the prepend threw
  (fail-open). It is replay-inert (a surface record, not gate state) and never
  re-journaled — the warnings themselves are journaled exactly once by the
  config layer, so this entry is a count-only audit, not a second copy.
  Rotation: the append hot path never stats or renames — `journal()` only
  appends and advances a per-file counter. The rotate-then-rename sequence
  runs once per `rotateEveryEntries` appends (default 512), only under a
  created `<file>.lock` atomic-mkdir mutex, so two concurrent sessions never
  both rename the shared file. Disk usage stays bounded at `(N + 1) ×
maxBytes`, plus at most `rotateEveryEntries × ~2 KB` of overshoot between
  the size check and the rename; a contended lock or any rotation error is
  swallowed (fail-open); a leftover `<file>.lock` from a crash between create
  and remove is skipped, so that file stops rotating until the directory is
  removed while journaling keeps appending. A residual bounded race remains:
  a writer that opens the path across the rename may land an entry in a `.1`
  generation replay never reads, but the window is small and clock-free.
  Rotates at 5 MB, 5 generations.
- **`gate-events.jsonl`** — human-readable trace, only when `trace:true`.

On restart, `replayGatePasses` (`src/state.ts`) reads the last 2000 lines of
the current + `.1` generations and restores per session, last-wins:
`hasGatePass`, `hasPlanVerdict` (+ `plansSignature`), `hasReviewApprove`
(task-result source only — streamed child verdicts never restore it), and
ensemble counts. Restored buckets get `replayGrace`, surviving exactly the
resume prompt. Values, not provenance, are carried: a live `GATE: FAIL` after
replay stays false. Any read error is fail-open.

For a read-only status view: `opencode-turnstile status [--json]` aggregates
gate/plan/verdict/dispatch/blocked/permission entries per parent session.

---

## 7. Configuration surface

Config resolves in four layers — code defaults ⊕ `~/.config/opencode/turnstile.json`
⊕ environment (`TURNSTILE_TRACE`, `TURNSTILE_METRICS_DIR`, `TURNSTILE_CONFIG`)
⊕ injected options — with per-key validation; invalid values are warned into
the journal (never thrown) and summarized once into the session context at
startup (a `[turnstile] config:` block). A shipped JSON schema
(`schemas/turnstile.schema.json`, editor opt-in via a `$schema` key that is
silently ignored at load) documents every key; the marker keys
(`gateMarker`/`verdictMarker`) are additionally breadth-checked against the
canonical defaults, so a user regex that matches text the default rejects is
warned. Highlights:

| Group       | Keys                                                                                                                                   | Defaults worth knowing                                                                             |
| ----------- | -------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| Caps        | `maxReviewerRounds`, `maxPlannerRounds`, `maxPlanReviewerRounds`, `maxTestRunnerRounds`, `maxTotalDispatches`, `maxSessions`           | 2 / 3 / 3 / 4 / 16 / 64                                                                            |
| Reads       | `readWarn`, `readBlock`                                                                                                                | 8 / 15 (clamped)                                                                                   |
| Markers     | `gateMarker`, `verdictMarker`, `waiverMarker`, `approvalMarker`, `evidencePattern`                                                     | built-in regexes; custom sources must compile or fall back (journaled)                             |
| Behavior    | `gateEvidence` (`enforce`/`flag`/`off`), `reviewEnsemble` (`enforce`/`advise`), `trace`, `continuationCarry`, `plansDir`, `metricsDir` | `enforce`, `enforce`, `true`, `false`, `.opencode/plans`; `metricsDir` is computed at load time    |
| Tool policy | `toolPolicy.mode`, `toolPolicy.bashDeny`, `toolPolicy.pathDeny`                                                                        | mode `enforce`; denylist covers worktree ops, branch switch/checkout, merge, `gh pr create\|merge` |
| Git gates   | `gitGates.mode`, `gitGates.commitLint`, `gitGates.commitFormat`, `gitGates.landingGate`                                                | mode `shadow` — audit-only adoption path; flip to `enforce` when confident                         |

Known guarded interactions: `reviewEnsemble:"enforce"` with
`maxReviewerRounds < 2` warns — the ensemble would be mechanically
unsatisfiable. A user `gateMarker`/`verdictMarker` that matches text the
shipped default rejects is warned as broader than the default (a match-oracle
probe; a disjoint custom syntax stays silent).

---

## 8. Design invariants

- **Fail-open vs BLOCKED.** Only `BlockError` reaches the host, and only from
  deliberate gate decisions. Every hook body journals internal errors and
  proceeds; the plugin always loads.
- **Parent-keyed state.** Reads, round counts, and gate flags count against
  the parent, resolved asynchronously via `childToParent`; unresolved edges
  journal a fallback signal rather than mis-keying.
- **Provenance-scoped waivers.** `USER WAIVER:` / `PLAN APPROVED:` are honored
  only from the user's own prompt (hook or inbox stream, deduped by message
  id) — agent-composed dispatch prompts containing those literals are inert.
- **Latest-wins markers.** A `GATE: FAIL` un-greens an earlier PASS, within
  and across texts; dedup is per parent with first-sight provenance;
  cross-child duplicate observations are suppressed (counted, not silently
  dropped).
- **Fail-toward-strict on stale evidence.** A plans-dir content-signature
  mismatch invalidates approvals rather than trusting them; restart grace
  survives exactly one prompt (`replayGrace`).
- **Marker drift is mechanically checked.** The marker regexes in
  `src/markers.ts`, the examples in `README.md` and `agents/*.md`, and the
  policy prose in `src/policy.ts` are validated together by
  `scripts/check-markers.mjs` (wired into `npm run ci`).

---

## 9. Policy injection

Turnstile does not read orchestrator policy from a file at install time — it
makes that policy available by injecting it at runtime. When the plugin is
loaded, `src/setup.ts` prepends the orchestrator policy paragraph from
`src/policy.ts` to the primary session's first `task` (or `subagent`) result
delivery, once per task, via the `tool.hook("execute.after")` handler — the
same hook the plugin already uses to rewrite tool output reaching the model.
The source of truth is code shipped with the plugin, so a fresh install can
never lose it, and it follows the plugin through updates and
uninstall–reinstall cycles.

- **Fail-open.** The injection is fully guarded with an inner try/catch; on
  failure it journals a `type:"policy"` entry with `injected:false` and
  proceeds — a broken injection never blocks a tool call.
- **Per-task idempotency.** A `GateState.policyInjected` flag (cleared on
  each new prompt, so the block re-injects per task) means the policy is
  prepended exactly once per task, not once per turn.
- **Marker placeholders.** The injected paragraph quotes the gate/verdict
  markers with `<n>` placeholders (e.g. `GATE: PASS tests=<n> passed=<n>
failed=<n>`, `VERDICT: APPROVE crit=<n> high=<n> med=<n> low=<n>`) rather
  than concrete digits, and never the pipe-joined `PASS|FAIL` form. The
  plugin parses markers from _any_ session text but applies them only from a
  marker-contracted emitter, so a fully concrete example echoed back by an
  unauthoritative session is journaled `suppressed` rather than flipping a
  gate. The placeholder form stays unparseable, which is defense in depth
  against a contracted emitter echoing a fully concrete line (e.g. a reviewer
  re-stating a verdict) and against contract drift.
- **Per-agent instructions** are not injected by the plugin: they live in
  each `agents/<name>.md` installed alongside the plugin.

With the plugin **off**, none of this prose is present anywhere — there is no
AGENTS.md block to fall back on. That is the deliberate tradeoff: loss-proof
by construction while the plugin loads, and a known, documented gap when it
does not.

A legacy variant once wrote a managed contract block into
`~/.config/opencode/AGENTS.md`. That block is now orphaned: the plugin no
longer reads or manages it, and it will coexist with the injected policy
(duplicate prose until removed). There is deliberately no installer to remove
it — turnstile no longer owns that file, so it never rewrites it. Delete the
section between the `<!-- turnstile:start -->` and `<!-- turnstile:end -->`
sentinels by hand, once; after that, the injected policy is the single source
of orchestrator policy for the session.

---

## 10. Security posture and limits

Turnstile is a speed bump and an audit trail, not a security boundary.

- Any text matching the gate marker — including a marker an agent
  hallucinated or copied from documentation — is journaled `verified:false`
  under the default `gateEvidence:enforce` mode and does not flip
  `hasGatePass` unless the current task's bash/shell executions contain a
  matching exit-0 test command (plausibility checked against
  `evidencePattern`). An agent that wants a green gate can no longer emit
  `GATE: PASS tests=1 passed=1 failed=0` without running anything — but
  `gateEvidence:flag` reverts to the historical flip-on-trust semantics
  (still stamped `verified:false`), and `gateEvidence:off` journals without
  the field at all.
- A `GATE: PASS` is only as trustworthy as the journal: an attacker who can
  write or replay the metrics directory can craft a `verified:true` entry,
  and `flag`/`off` make a fabricated marker trust-lossless. Tests that run
  outside the observable bash/shell surface (external CI, a differently
  named execution tool) leave enforce mode with no evidence to verify
  against — operators in that situation use `flag`/`off` at the cost of the
  guarantee. The journal records what was _claimed_, never proof.
- The dispatch-prompt waiver-forgery vector is closed: a `USER WAIVER:` (or
  `PLAN APPROVED:`) substring inside an agent-composed dispatch prompt
  unlocks nothing — turnstile reads waivers and approvals only from the
  user's prompt at admission. The residual trust stance is unchanged: the
  journal is still the record of what was _claimed_ (an attacker who can
  write or replay the metrics directory can still craft entries), so the
  journal is treated as sensitive data (see SECURITY.md).
- `scripts/check-markers.mjs` guards against accidental drift between the
  parser and documented markers; it cannot guard against forgery, because
  the markers are plain prose by design.
- The `bash`/`shell`/`write`/`edit` denylist is a deterrent, not a sandbox: it
  matches strings, so `bash -c "$X"`, script files, `eval` indirection, and
  values sourced from the environment still bypass it. A block names the matched
  _rule_ (never the raw command, per the redaction contract); a dropped or
  invalid regex _source_ means the operation it guarded is now **allowed**
  (documented so a config typo weakens the policy visibly in the journal rather
  than silently). The git rules are global-option tolerant, so `git -C dir
checkout main` is caught as well as `git checkout main`, and the checkout guard
  allows the file-restore form `git [global options] checkout [<ref>] -- <path>`
  while blocking `git [global options] checkout <branch>` and `-b`/`-C`; but two
  gaps remain by design. `git` **aliases** (e.g. `git co main`, `git cm -m x`)
  are not matched, because a rule names `git` plus a literal subcommand only; and
  the wider base can _over-match_ — e.g. `git commit -m "… merge …"` trips the
  `merge` rule. `session_move` never blocks.
- MCP tools and other tool names not named in `execute.before` (`task`,
  `subagent`, `read`, `bash`, `shell`, `write`, `edit`, `session_move`) remain
  unguarded. Governing them is a follow-on, not part of this policy layer.

Use OpenCode's permission and sandboxing mechanisms against hostile agents.
Treat turnstile's journal as the record of what was _claimed_, and treat the
journal itself as sensitive data (see SECURITY.md).

The shadow-first adoption path applies to both policy layers:
`toolPolicy.mode: shadow` journals would-block commands/paths with
`"reason":"tool-policy"` without throwing; `gitGates.mode: shadow` (the
default) journals `"reason":"invalid-commit-message"` /
`"reason":"no-landing-approval"` the same way. Boot a session in shadow,
grep the journal for those reasons, review and tune the rules, then flip to
`enforce` and restart sessions (config is read once at setup).

---

## 11. Positioning: how turnstile fits the ecosystem

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
  this task's plan is approved" and per-leg round caps expressible —
  and decidable in `tool.hook("execute.before")`, outside the model
  loop.
- **Evidence correlation.** No host feature verifies a model's claim
  against actual tool history. `src/evidence.ts` correlates a
  `GATE: PASS` marker with a recorded exit-0 test execution matching
  `evidencePattern` before the reviewer gate flips; a bare marker stays
  `unverifiedPass` and never greens the gate under
  `gateEvidence:"enforce"`.
- **A decision journal.** OpenCode logs are diagnostics, not a
  structured decision record. `src/journal.ts` appends every gate
  transition, block, waiver, and dispatch to a replayable JSONL trail
  (`replayGatePasses`, `src/state.ts`), which is what makes gates
  reviewable after the fact and stateful across restarts.

The README's "Why turnstile" section states the same three properties in
one screen for arriving readers; this section is where a developer can
see the mechanisms behind them.

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
  (`src/state.ts`), and replayed from the JSONL journal on restart, so
  replayed gate state survives a restart and the next user prompt, then
  every later prompt starts a clean gate cycle rather than living in a
  prompt.
- Failure posture. Hooks fail open: an internal error is journaled and
  the call proceeds. The only refusals are deliberate
  `BLOCKED by turnstile:` throws at a declared gate. A broken
  enforcement plugin should degrade to prompt contracts, not break
  every session.
- Auditability. Every dispatch, gate transition, verdict, and blocked
  call is appended to `turnstile.jsonl` (bounded rotation, see
  SECURITY.md). The journal is the record of what was claimed, which is
  what makes the gates reviewable after the fact.

The tradeoff is scope: turnstile is host-coupled to the OpenCode v2
plugin API, verified against v2.0.22, and enforces exactly the
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
