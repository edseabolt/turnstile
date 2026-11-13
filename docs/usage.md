# Turnstile — Usage

Day-to-day operation of the turnstile plugin: a worked session from planner
to landing, waivers and approvals in full, installing and maintaining the
plugin, the complete configuration reference, journals and retention, and
the `status` command. For how the plugin works inside — hook surface, gate
state machine, policy injection — see [`architecture.md`](architecture.md);
the module map lives in [`modules.md`](modules.md) and the journal catalog
in [`journal.md`](journal.md).

## Contents

1. [A worked session](#1-a-worked-session)
2. [Waivers and approvals](#2-waivers-and-approvals)
3. [Installing and maintaining](#3-installing-and-maintaining)
4. [Configuration](#4-configuration)
5. [Files and journals](#5-files-and-journals)
6. [Status](#6-status)
7. [Field-tested on itself](#7-field-tested-on-itself)

---

## 1. A worked session

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
your pipeline uses custom names) as described in "Installing and
maintaining", then re-run.

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

---

## 2. Waivers and approvals

Turnstile reads a waiver or a human plan approval only from the user's OWN
prompt — the plugin observes it at prompt admission, never from an agent's
dispatch prompt. A marker inside an agent-composed prompt must never unlock
a gate, so the channel is checked, not the text.

### Observe mode

`observeSessions: N` runs the first N admitted parent sessions as an
adoption period: every gate keeps computing and journaling exactly as
before, but the deliberate `BLOCKED by turnstile:` throw is suppressed —
the decision is journaled as a `would-block` entry and the call proceeds,
metered like an admitted dispatch. When the next session admits past the
boundary, the period completes and enforcement switches on; the first
string-output delivery after it carries a once-per-load `[turnstile]
observe:` block reporting the would-have-blocked counts, and that
surfacing is journaled so a restart never re-fires it. The default
`observeSessions: 0` enforces from the first session — byte-identical to
the pre-observe behavior. Fail-toward-enforce: if the observe phase read
itself fails, the error is journaled and the block proceeds. The
summary's counts are read at injection time, so sessions admitted between
period completion and the first delivery shift the reported totals
slightly (cosmetic drift, accepted). A boot that replays a completed
period whose summary never surfaced re-arms the block even if the current
config has since been disarmed (`observeSessions: 0`) — at most one block
per load, accepted behavior.

### Prompt-channel waiver

Put the literal marker `USER WAIVER:` in the text of your prompt to waive a
gate. Your words may name configured agent stages to scope the waiver: the
grammar is literal configured stage names (the `config.agents` values —
`planner`, `plan-reviewer`, `executor`, `test-runner`, `reviewer`), matched
case-insensitively. The plan gate is covered by either its plan-reviewer or
executor stage name; a name with no guarded gate (e.g. `debugger`) names
nothing the waiver covers — the block message self-explains at runtime.

Two lifecycles:

- An **unscoped** waiver covers every gate, but the reviewer gate consumes
  it on the first dispatch it unlocks.
- A **scoped** waiver stays live until that stage's waiver allowance is
  spent (for the reviewer gate, max 2 waiver-unblocked dispatches, metered
  separately from the ordinary dispatch caps on `reviewWaiverRounds`).

A new user prompt drops the waiver; a blocked dispatch reports whether a
waiver is out of scope or consumed.

A waiver-admitted reviewer dispatch never counts toward the reviewer
ensemble: under `reviewEnsemble: enforce` a fully waived review leaves the
landing gate red — it is released only by the human, never by
the waived verdict. The landing gate is never waiver-released at all: a
`USER WAIVER:` in your prompt covers the dispatch gates but does not release
`git push` — only the credited reviewer verdict or your explicit approval
(prompt marker, or your permission reply under `escalation: "ask"`)
does (a waiver aimed at landing is captured at admission and inert there).

Only the reviewer stage meters waiver exemptions; a waiver covering another
stage exempts that leg's loop cap and the total dispatch budget without
counting — by design, a planner-scoped waiver permits an unbounded planner
loop within the task; the bound is the user's own prompt.

### Prompt-channel approval

Put `PLAN APPROVED:` in your prompt to approve the plan the same way a
plan-reviewer `VERDICT: APPROVE` would; it records human provenance and
replays across restart like a reviewer verdict.

### Permission-prompt escalation

Repeat-attempt escalation of the landing and hands-on gates is controlled by
`escalation` (`"block"`, the default, or `"ask"`):

- **`block` (default) — ask-first with block fallback.** The repeat attempt
  arms the same one-shot latch and forces the host permission ask exactly as
  under `"ask"`: reply `always` (released for the task), `once` (one
  dispatch/edit), or `reject` (gate stays red). The block-throw with the
  stop-and-report instruction is only the fallback for the no-human cases:
  when no one answers the ask, or when a re-arm inside the ask-latch TTL
  journals no second ask row (same-tick dedupe collapses parallel tool
  batches that escalate together into one ask row) and re-blocks instead,
  while the already-armed latch still forces the ask. Release also flows via
  a user-authored prompt marker (`USER WAIVER:` for hands-on / dispatch
  gates, `PLAN APPROVED:` for the plan gate) or an earned reviewer
  `VERDICT: APPROVE` (landing).
- **`ask` — interactive ladder.** Identical ask-first behavior: the repeat
  attempt arms a one-shot latch and forces the host permission ask with the
  same `always`/`once`/`reject` replies, with the same TTL dedupe and
  block fallback.

The plan-gate escalation (the first executor dispatch when no plan approval
holds) follows the `escalation` mode: under `"block"` (the default) the
dispatch blocks with the stop-and-report instruction and release flows via
`PLAN APPROVED:` or a waiver; under `"ask"` it surfaces the permission
prompt. It is not part of the landing/hands-on ladder.

> **Warning — auto-accept voids the human decision point.** If the host
> answers permission asks automatically (`session.permissions:
"autoaccept"` in `~/.config/opencode/cli.json`), the landing/hands-on
> ask latches (both `escalation` modes) and the ensemble's human release
> are all answered without you: the landing gate degrades to a two-push
> delay and, under `"ask"`, the plan gate degrades to a one-block
> delay. Turnstile
> assumes a human actually answers; this is one reason the default is
> `"block"`. `opencode-turnstile status` prints an
> advisory when it detects the setting.

### Parent hands-on edits

You normally never edit files from your own prompt — the pipeline does the
work. If the parent session (the one you type into) tries a `write` or
`edit` itself, the always-on hands-on gate steps in:

- The **first** parent edit of a task is refused with
  `BLOCKED by turnstile: parent-session write/edit requires the pipeline…`.
- The **repeat** attempt arms a one-shot ask latch and escalates to an
  interactive permission ask through OpenCode's permission surface in BOTH
  `escalation` modes (the block-throw is only the no-human fallback). Reply
  `always` to release the gate for the rest of the task, `once` to release
  exactly the one edit in flight, or `reject` to keep the gate red — the
  next attempt re-blocks (a within-window re-arm after a reject throws
  instead of re-asking). The gate also releases on a `USER WAIVER:` (below)
  or a hands-on release carried from a prior session.
- A `USER WAIVER:` in your prompt whose scope covers the `executor` stage
  also releases the gate. Plan approval does **not** — approving the plan
  tells turnstile the executor may start, not that the parent may edit.
- A new user prompt resets the gate: the block count and any `always`
  release start over.

The gate covers the parent session and every non-pipeline subagent;
only the pipeline's own agents (executor and friends) are exempt, because
their writes are the pipeline's work.

If you genuinely want one-off hands-on fixes, reply `once` per edit, or
scope a `USER WAIVER: executor` for a task of small direct tweaks.

### How the plugin sees your prompt

Capture happens at prompt admission on whichever host channel carries it —
the `session` prompt hook, or the correlated `session.inbox.enqueued`
admission (same message id, same marker, same journal shapes). A prompt
delivered on neither channel is journaled as one distinguishing error rather
than failing silently.

### Stale approvals

Plan edits invalidate approvals: a bound approval (recorded for a specific
plan file) is dropped only by that plan's own content change or removal
(`plan-edited` / `plan-missing`, journaled STALE); unbound approvals stamp a
path-free whole-directory signature, so any plan-file change drops them
loudly the same way (`signature-mismatch`). The unbound stamp is journaled
with the APPROVE entry, so a plan edited while the process was down
invalidates the restored approval on its first dispatch.

---

## 3. Installing and maintaining

Three ways to install; pick one, and do not combine the plugin-array path
with the CLI install.

1. **Zero-config enforcement (plugin only).** Add the package to your
   OpenCode config's plugin array and restart:

   ```json
   { "plugins": ["opencode-turnstile"] }
   ```

   turnstile loads and enforces its gates, injecting the orchestrator policy
   into the parent session at runtime — nothing is written to any
   instructions file. The pipeline agent definitions are not installed by
   this option alone (recognition is by dispatch _name_, not by installed
   files, so the gates still fire).

2. **Full install via the CLI.** `npx opencode-turnstile init` installs the
   plugin and the pipeline agent definitions into `~/.config/opencode`
   (`plugins`, `agents`, `skills`).

3. **Develop from a clone.** Clone this repo and run `npm run init`
   (symlink mode) so installed artifacts stay live against your edits.

### No postinstall

Turnstile has **no** npm lifecycle hook (`postinstall`, etc.). Installing
`opencode-turnstile` as a dependency never writes to `~/.config/opencode`;
it only makes the gates available through the plugin array. Everything else
(the agent definitions) happens only when you run an explicit command. This
is deliberate: writes to your config directory are opt-in, not automatic.

### Modes

`init` auto-detects an install mode: a git checkout installs by linking (the
working tree stays the source of truth, so edits are live); an `npx` package
install copies files (the installed files are the source of truth). Override
with `--link` or `--copy`:

```sh
npx opencode-turnstile init --copy
```

Copy mode records the mode it used in the ledger (alongside each entry's
source, hash, and version); symlink mode deletes ledger entries rather than
recording them. `check` does not read the mode from the ledger — it
re-resolves it on each run from the CLI flag, then the manifest, then
filesystem auto-detection, so it stays consistent across reruns.

### Check

`npx opencode-turnstile check` verifies the installed state against the
manifest and exits 0 (clean) or 1 (drift). A copy install whose recorded
version is older than the published package is reported as a warning
(`check: outdated <dest> (installed X, package Y)`) and does not fail the
check. Running `init` on a content-identical destination refreshes the
recorded version in place (`install: version stamp updated <dest> (was X,
now Y)`), clearing the warning without rewriting any files.

The check is load-aware, not just presence-aware: after the per-entry pass
it dynamically imports every manifest `verify` path (the installed plugin
entry point by default) through a child `node --experimental-strip-types`,
printing `check: loadable <file>` when the whole import graph resolves and
failing with `check: unloadable <file> — <reason>` when it does not.
`init` applies the same probe to what it just installed, so a missing
module tree fails the install that caused it.

### Upgrade

The plugin updates with your dependency manager (`npm update
opencode-turnstile`, or your registry's equivalent). Re-run `check` to see
whether anything is outdated or drifted, then `init` to re-sync only what
changed: `npx opencode-turnstile init --copy` for package installs,
`npm run init -- --copy` from a clone. The injected orchestrator policy
travels with the plugin, so re-syncing the plugin re-supplies it — there is
no separate contract block to re-sync.

### Uninstall

`npx opencode-turnstile uninstall` reverses the install: it removes
ledger-owned copies and repo-owned symlinks and stops injecting the
orchestrator policy. It is idempotent and ownership-aware: files it never
installed (untracked files, symlinks pointing outside the repo) are left
alone, and a second run is a clean no-op. Injected policy is gone the moment
the plugin is unloaded; a legacy contract block once written by hand into
`~/.config/opencode/AGENTS.md` is not owned by turnstile and is removed
separately — see
[architecture §9](architecture.md#9-policy-injection).

### Retired paths

The manifest also carries a `retired` list: destinations turnstile once
installed but no longer ships (for example the old `turnstile-suspend` and
`turnstile-setup` skills, or the command files from when `status` and `log`
were slash commands). `init`, `check`, and `uninstall` sweep these paths on
every run, so upgrading removes the stale installed copies automatically —
repo-owned symlinks (including links whose repo target is gone) and
ledger-owned copies are removed; anything unowned is reported and left
alone. Between the upgrade and the next `init`, `check` (and
`npm run install:check`) reports the drift and exits non-zero.

### From a clone

This repo is the source of truth for what lands in `~/.config/opencode`:
the plugin and the pipeline agent definitions are installed per the manifest
in `install.json`; unowned files in the target directories are never
touched. Two install modes:

A manifest entry may name a directory as its source (the plugin's `src/`
tree ships this way): the directory installs file-by-file — recursive,
sorted — so each file is individually ledger-recorded (copy) or linked
(link), removed by uninstall, and reported by check.

|                           | Symlink (default)                                   | Copy (`--copy`)                                         |
| ------------------------- | --------------------------------------------------- | ------------------------------------------------------- |
| Best for                  | developing turnstile                                | general use, dotfiles repos that reject foreign links   |
| How targets point at repo | symlinks into the checkout                          | real copies                                             |
| After `git pull`          | nothing to do; edits are live on next session start | re-run `npm run init -- --copy` to re-sync              |
| Editing installed files   | edit the repo; links share it                       | edit the repo; user-edited copies conflict on next sync |

```sh
git clone <repo-url> && cd turnstile
npm install              # typescript + @types/node, for typechecking
npm run init             # symlink mode
# or: npm run install:copy
npm run install:check    # verify installed state; exit 1 on drift (gates local CI)
```

A target that differs from the repo is a **conflict**: `install` fails with
a per-path summary. Re-run with `--force` to back the file up
(`<name>.bak.<timestamp>`) and replace it. Conflicts mean:

- symlink mode: a real file (or a link pointing outside the repo) sits at a
  manifest target and differs from the source, typically pre-existing files
  or hand edits.
- copy mode: an installed copy was edited after install (the ledger can tell
  user edits from repo updates), or an untracked real file sits at a target.

Copy mode records everything it installed in
`~/.config/opencode/.turnstile-install.json` (the ledger: destination mapped
to source, content hash, package version, and install mode). The ledger
makes re-syncs safe: repo updates re-copy cleanly and user edits fail
loudly. It also lets the installer remove copies whose manifest entry was
deleted. Deleting the ledger turns every copy into an untracked file the
installer will refuse to touch.

### Set the agents' models

The six agent definitions in `agents/` ship **without** a `model:`
frontmatter key. Each subagent therefore runs on the model of the session
that dispatched it — OpenCode v2's documented inheritance rule — so there is
nothing to configure for the common case.

To pin a specific model per agent, paste a block into
`~/.config/opencode/opencode.json` (**plural** `agents` is the v2 key; v1
used singular `agent`):

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "agents": {
    "planner": { "model": "oMLX/oQ/Qwen3.8-Flash-Next-oQ4-mtp" },
    "plan-reviewer": { "model": "oMLX/oQ/GLM-5.3-Flash-oQ4-mtp" },
    "executor": { "model": "oMLX/oQ/Qwen3.8-27B-oQ8-mtp" },
    "test-runner": { "model": "oMLX/oQ/Qwen3.8-27B-oQ8-mtp" },
    "reviewer": { "model": "oMLX/oQ/GLM-5.3-Flash-oQ4-mtp" },
    "debugger": { "model": "oMLX/oQ/GLM-5.3-Flash-oQ4-mtp" },
  },
}
```

This is the author's actual local setup (a self-hosted oMLX engine serving
Qwen and GLM models). Frontier hosted models work the same way — any
`provider/model-id` your OpenCode install lists, e.g.
`anthropic/claude-sonnet-4-5` — and are the right choice if your local
models struggle with the executor or reviewer roles.

Model IDs come from `opencode models` and take the form `provider/modelID`,
with an optional `#variant`. Restarts pick the change up. Because the
shipped definitions are silent on `model:`, a pin you add is the only
definition of that model — there is no merge precedence to reason about.

Copy-mode users: after a `git pull` that changes these definitions, re-run
`npm run install:copy` to pick up the new frontmatter. `npm run
install:check` will report `stale` (not `conflict`) until you do.

### Printing a model config

To generate a `{"agents": {…}}` snippet instead of copying the six agent
names by hand, run the printer. It writes nothing — it short-circuits before
any install work, so the ledger, links, and copies are untouched:

```sh
npm run init -- --print-model-config
```

That prints one entry per agent, each defaulting to a placeholder:

```json
{
  "agents": {
    "planner": "<provider>/<model-id>",
    "plan-reviewer": "<provider>/<model-id>",
    "executor": "<provider>/<model-id>",
    "test-runner": "<provider>/<model-id>",
    "reviewer": "<provider>/<model-id>",
    "debugger": "<provider>/<model-id>"
  }
}
```

Seed individual agents with repeatable `--model` seeds. A bare
`provider/model` (optionally `#variant`) seeds all six; `name=` seeds one.
Model ids may be multi-segment — providers require interior slashes, e.g.
`oMLX/oQ/GLM-5.3-Flash-oQ4-mtp` — so the model body is everything after the
first slash.

```sh
npm run init -- --print-model-config \
  --model planner=oMLX/oQ/Qwen3.8-Flash-Next-oQ4-mtp \
  --model executor=oMLX/oQ/Qwen3.8-27B-oQ8-mtp
```

Add `--validate` to cross-check every concrete seed against
`opencode models` and exit 1 naming a model it does not list; placeholder
seeds are skipped. `--model` and `--validate` are only valid with
`--print-model-config`: given without it, install.mjs prints an actionable
message and exits 2.

Paste the output into `~/.config/opencode/opencode.json` (see
[Set the agents' models](#set-the-agents-models)).

### Customizing the pipeline agents

The agent definitions are opinionated on purpose: turnstile recognizes and
clamps them by name, and the marker contract in the agent prompts is what
the plugin enforces against. Editing the installed files is therefore not a
supported customization path: symlink installs share the repo file, and copy
installs conflict on the next sync.

Two sanctioned ways to change the pipeline:

- **Bring your own agents.** Add your own agent definitions (any names) to
  `~/.config/opencode/agents/`; the installer never touches files it does
  not own. Then point turnstile at them via
  `~/.config/opencode/turnstile.json`: `agents.planReviewer`,
  `agents.reviewer`, `agents.executor`, `agents.testRunner`, and
  `agents.debugger` take the names turnstile should recognize, clamp, and
  hold to the marker contract. Your agents get the same gates the shipped
  ones do. Gate authority follows these configured names, not the agent's
  role: an agent that runs the test suite under a custom name (e.g. `build`)
  must be configured as `agents.testRunner` — `agents.bareOutput` then
  derives — or its `GATE:` markers are journaled as `suppressed` and the
  gate stays red.
- **Fork the repo.** To change the pipeline content itself, fork and edit
  `agents/*.md` there; your installer serves your fork.

One coupling to know when customizing either way: the shipped definitions
reference `.opencode/plans/` as turnstile's **default** `plansDir`, not a
constant — the plan path travels in the dispatch prompt, and the agents are
instructed to honor it over the default (see the frontmatter comment in
`agents/planner.md`). If you reconfigure `plansDir`,
update your agent definitions' write permission (planner) accordingly; a
copy-mode user edits their installed copies, a fork edits `agents/*.md`.

### Updating

Symlink mode: because everything is linked into the checkout, updating is
just:

```sh
git pull            # in this repo
npm install         # only if dependencies changed
```

then restart OpenCode sessions (or `opencode service restart`) so the
running server reloads the plugin. There is no separate install step for
code or agent changes; the links are already live. Re-run `npm run init`
only when the **set** of artifacts changes (a new agent added to
`install.json`, an artifact removed or moved): it creates, fixes, or removes
repo-owned links to match the manifest.

Copy mode adds one extra step, because copies do not follow the repo:

```sh
git pull            # in this repo
npm install         # only if dependencies changed
npm run init -- --copy   # re-sync: re-copies changed files, skips clean ones
```

then restart OpenCode sessions. Unchanged files are skipped; changed ones
are re-copied; user-edited copies conflict and wait for `--force`.

Shared caveats:

- Symlinks point at the clone's absolute path. Do not move, rename, or
  delete the checkout; if you relocate it, re-run `npm run init`.
- `npm run install:check` reports drift between the manifest and what is
  actually installed. There is no `install:agents:check`: the orchestrator
  policy is injected from code (`src/policy.ts`), not a manifest-managed
  template, so nothing to verify there — `npm run ci:installed` is now just
  `install:check`. These install checks must run after `npm run init` on a
  machine with artifacts installed — a fresh clone has nothing to check. The
  host chain (`npm run ci` = `npm run ci:host`) covers lint, format:check,
  typecheck, check:markers, and test without the install checks. GitHub CI
  runs `npm run ci:host`, the host chain only, because a runner has no
  installs to check. Verify a copy install with
  `npm run install:check -- --copy`.

---

### Vendored skills

The full install ships nine skills into `~/.config/opencode/skills/`:

| Skill                  | What it does                                                                                                                     |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `turnstile-init`       | Install, check, uninstall, or inspect the turnstile install (`init` / `check` / `uninstall` / `status`).                         |
| `turnstile-off`        | Compose a copy-ready suspend prompt for **you** to send (see below).                                                             |
| `turnstile-on`         | Compose a copy-ready resume prompt for **you** to send.                                                                          |
| `turnstile-evidence`   | Publish or inspect an evidence bundle (`evidence`, §6).                                                                          |
| `turnstile-config`     | Show which config keys are overridden vs default, read-only.                                                                     |
| `turnstile-status`     | Run `status` and present the result readably; forwards options the user names (e.g. `--json`).                                   |
| `turnstile-log`        | Tail the JSONL journal via `log` (default `--tail 50`); forwards options the user names.                                         |
| `turnstile-prov`       | Report the decision ledger via `prov` (`prov:stated` prompts, `prov:denied` denials, `prov:waiver` waivers); forwards options.   |
| `turnstile-prov-views` | Show derived views over the decision ledger via `prov-views` (origin labels, chatter noise rate, taste-drift); forwards options. |

Derived views (origin labels, noise rate, taste-drift) are available offline
via `opencode-turnstile prov-views`; they read the same `prov:*` rows and
never mutate them.

The on/off skills never send the suspend/resume markers themselves — the
markers are honored only from user-typed prompts, so an agent relaying one
does nothing. Instead the skill reads the resolved suspension config from
`status --json`'s `suspension` block:

```json
"suspension": {
  "allowSuspend": true,
  "suspendMarker": "TURNSTILE OFF:",
  "resumeMarker": "TURNSTILE ON:",
  "configPath": "~/.config/opencode/turnstile.json",
  "configFilePresent": true
}
```

A worked `turnstile-off` flow: the skill runs `status --json`, reads
`suspendMarker` and `allowSuspend` from the block, and hands you a
copy-ready prompt — "Send this yourself (do not let the agent send it):
`<suspendMarker> <your reason>`". If your config sets `allowSuspend: false`
(the kill switch), the skill says so and stops — it does not compose a
prompt that would be refused. A renamed marker (`suspendMarker` in §4's
table) is picked up automatically because the value always comes from the
CLI, never from the skill text. All eight skills and both commands forward
any options you name to the CLI verbatim and surface usage errors instead
of retrying.

---

## 4. Configuration

Defaults live in code (`src/config.ts`); override via
`~/.config/opencode/turnstile.json`, environment variables, or both.

**Quick start: copy the example config** —
[`examples/turnstile.example.json`](../examples/turnstile.example.json) to
`~/.config/opencode/turnstile.json` and edit from there. Every key in it is
optional and matches the code defaults; delete any key to fall back to the
default. One key is deliberately omitted from the example:

- `metricsDir`: computed at load time (`$XDG_DATA_HOME/opencode/metrics`,
  fallback `~/.local/share/opencode/metrics`); if you set it yourself it
  must be an absolute path (`~` is not expanded)

Copying the example is safe as-is: its `agents.bareOutput: []` IS the code
default in effect, because the loader re-derives the list when it resolves to
an empty one.

The example also carries `gateMarker` / `verdictMarker` verbatim so you can
see the format; leave them alone unless you are intentionally changing the
marker syntax (the shipped subagent definitions emit the canonical markers).

**Schema** — `schemas/turnstile.schema.json` ships with the package and
describes every key in the table below. To get editor completion, point your
config at the shipped schema with a `$schema` key (an absolute path to the
installed package's schema file):

```json
{
  "$schema": "/abs/path/to/opencode-turnstile/schemas/turnstile.schema.json"
}
```

The `$schema` key is ignored at load when it is a string (a non-string
warns; it is not a turnstile key), and validation itself runs inside
`mergeConfig` (per-key merge arms in `src/config-merge.ts`, the value rules
and resolved invariants in `src/config-validate.ts`) — the schema is an
editor and documentation artifact, not a runtime validator.

Precedence: defaults < config file < env. The plugin reads config once, at
setup; restart sessions to apply. Invalid keys are ignored, journaled, and
summarized once into the session context on the first tool result after
load — a `[turnstile] config:` block naming up to 5 warnings (beyond that,
`(N more; see the journal)`) and the journal path, with the full list in the
journal (fail-open); a malformed config file never breaks the host.

| Key                                                                                                                                                | Default                                                                                                                                                                      | Meaning                                                                                                                                                                                                                                                                                                                                                                                                                        |
| -------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `metricsDir`                                                                                                                                       | `$XDG_DATA_HOME/opencode/metrics`, fallback `~/.local/share/opencode/metrics`                                                                                                | directory for both telemetry files                                                                                                                                                                                                                                                                                                                                                                                             |
| `journalMaxBytes`                                                                                                                                  | 5242880                                                                                                                                                                      | rotate a journal file past this size                                                                                                                                                                                                                                                                                                                                                                                           |
| `journalMaxGenerations`                                                                                                                            | 5                                                                                                                                                                            | rotated generations kept per journal                                                                                                                                                                                                                                                                                                                                                                                           |
| `journalRotateEveryEntries`                                                                                                                        | 512                                                                                                                                                                          | rotation cadence in appends; the rotate-then-rename runs once this many appends apart                                                                                                                                                                                                                                                                                                                                          |
| `journalPerSession`                                                                                                                                | true                                                                                                                                                                         | segment the journal per parent session: entries with a resolvable parent sessionID append to `sessions/<parentID>.jsonl` (same rotation bounds per file); entries without one stay in the shared `turnstile.jsonl`. `false` restores the single-file layout                                                                                                                                                                    |
| `replayTailLines`                                                                                                                                  | 2000                                                                                                                                                                         | newest journal lines replayed per boot to restore gate/plan state — the walk covers all retained generations and stops early once the bound is met; bound plan approvals older than the window persist through the `approved-plans.jsonl` sidecar (§5)                                                                                                                                                                         |
| `maxReviewerRounds`                                                                                                                                | 2                                                                                                                                                                            | reviewer dispatches per task, regardless of gate state (waived dispatches exempt)                                                                                                                                                                                                                                                                                                                                              |
| `maxPlannerRounds`                                                                                                                                 | 3                                                                                                                                                                            | planner dispatches per task (waived dispatches exempt)                                                                                                                                                                                                                                                                                                                                                                         |
| `maxPlanReviewerRounds`                                                                                                                            | 3                                                                                                                                                                            | plan-reviewer dispatches per task (waived dispatches exempt)                                                                                                                                                                                                                                                                                                                                                                   |
| `maxTestRunnerRounds`                                                                                                                              | 4                                                                                                                                                                            | test-runner dispatches per task (waived dispatches exempt)                                                                                                                                                                                                                                                                                                                                                                     |
| `maxTotalDispatches`                                                                                                                               | 16                                                                                                                                                                           | total task dispatches per task across every leg — the global loop backstop (waived dispatches exempt)                                                                                                                                                                                                                                                                                                                          |
| `maxSessions`                                                                                                                                      | 64                                                                                                                                                                           | LRU cap on tracked sessions (gate state, verdicts); the child→parent edge registry is capped at `max(256, 4 × maxSessions)`; registered live parents are never evicted                                                                                                                                                                                                                                                         |
| `agentMarkerRetry`                                                                                                                                 | 1                                                                                                                                                                            | compliance re-prompts per child delivery that returned no GATE/VERDICT marker (bare-output); 0 disables the retry — the first marker-less delivery counts a violation immediately                                                                                                                                                                                                                                              |
| `readWarn` / `readBlock`                                                                                                                           | 8 / 15                                                                                                                                                                       | whole-file read horizon                                                                                                                                                                                                                                                                                                                                                                                                        |
| `observeSessions`                                                                                                                                  | 0                                                                                                                                                                            | first N admitted sessions journal decisions without blocking; `0` enforces immediately                                                                                                                                                                                                                                                                                                                                         |
| `waiverMarker`                                                                                                                                     | `USER WAIVER:`                                                                                                                                                               | literal waiver marker                                                                                                                                                                                                                                                                                                                                                                                                          |
| `approvalMarker`                                                                                                                                   | `PLAN APPROVED:`                                                                                                                                                             | literal prompt-channel plan-approval marker                                                                                                                                                                                                                                                                                                                                                                                    |
| `plansDir`                                                                                                                                         | `.opencode/plans`                                                                                                                                                            | executor decomposition scan directory — an absolute value is honored as-is with a journaled warning (not joined to projectDir)                                                                                                                                                                                                                                                                                                 |
| `trace`                                                                                                                                            | `true`                                                                                                                                                                       | write the human-readable trace file (JSONL journal always writes)                                                                                                                                                                                                                                                                                                                                                              |
| `continuationCarry`                                                                                                                                | `true`                                                                                                                                                                       | carry the task's gate flags across a prompt reset when the worktree/branch is unchanged (continuation), instead of starting a clean cycle                                                                                                                                                                                                                                                                                      |
| `suspendMarker`                                                                                                                                    | `TURNSTILE OFF:`                                                                                                                                                             | literal prompt marker that suspends gate blocking for the session (decisions keep journaling, nothing blocks, state cleared fresh); honored only from the user's own prompt                                                                                                                                                                                                                                                    |
| `resumeMarker`                                                                                                                                     | `TURNSTILE ON:`                                                                                                                                                              | literal prompt marker that resumes enforcement with fresh task state (no credit earned while suspended rehydrates)                                                                                                                                                                                                                                                                                                             |
| `taskDoneMarker`                                                                                                                                   | `TASK DONE:`                                                                                                                                                                 | literal prompt marker that, appearing in the user's own prompt, explicitly retires the session's active task: journals `{type:"task-complete", plan}` and stamps `taskComplete`, so the NEXT admitted prompt starts a fresh task scope; admission-only — child results and dispatch prompts never retire a task                                                                                                                |
| `allowSuspend`                                                                                                                                     | `true`                                                                                                                                                                       | whether the suspend/resume markers are honored; `false` refuses both the OFF and ON markers (journaled `refused:true` + surfaced diagnostic) with no state change                                                                                                                                                                                                                                                              |
| `intentNudge`                                                                                                                                      | `true`                                                                                                                                                                       | advisory intent nudge: a prompt classified as implementation intent (work verb at code, gh issue reference, plan-file reference, or plan-dispatch request) with no plan approval journals `{type:"intent"}` and prepends one advisory pipeline-entry nudge to the next tool delivery; `false` is a full no-op                                                                                                                  |
| `alwaysEnforce`                                                                                                                                    | `false`                                                                                                                                                                      | `true` restores the legacy always-armed behavior (enforcement from the first prompt); the default `false` is dormant-until-engaged — enforcement arms when the user provides a plan (a `PLAN APPROVED:` marker or a plan-file reference) or asks to run the planner/pipeline, and sleeps again on task completion, `TURNSTILE OFF:`, or a prompt with no continuation credit; the user-configured denylists enforce regardless |
| `planImpactStrict`                                                                                                                                 | `false`                                                                                                                                                                      | plan-impact advisory: parent edit/write/write-shaped bash calls that overlap the bound active plan's scope are allowed with a journaled `plan-impact` classification instead of the parent-hands-on block; `true` restores blocking for structural overlap (files or the `## Decomposition` section named by the plan)                                                                                                         |
| `planUserReview`                                                                                                                                   | `false`                                                                                                                                                                      | pause the pipeline after the planner writes a plan: the plan-reviewer dispatch is blocked until the user's own prompt carries the accept or reject literal; the pending state survives restarts and prompt boundaries (see the README's User plan review section)                                                                                                                                                              |
| `planReviewAcceptMarker` / `planReviewRejectMarker`                                                                                                | `PLAN REVIEWED:` / `PLAN REJECTED:`                                                                                                                                          | the prompt literals that accept the written plan (unblocks the plan-reviewer dispatch; the edited file is what the reviewer reads) or reject it (retires the task scope with no counted plan-reviewer dispatch); only consulted while `planUserReview` is on                                                                                                                                                                   |
| `requirementsPhase`                                                                                                                                | `false`                                                                                                                                                                      | dispatch the requirements subagent before the planner for non-trivial tasks (spec + Open Questions round-trip, verbatim hand-off into the planner dispatch); soft and ungated — no marker, no gate — loop-capped via `maxRequirementsRounds` (see the README's Requirements phase section)                                                                                                                                     |
| `maxRequirementsRounds`                                                                                                                            | 2                                                                                                                                                                            | requirements-phase dispatches per task (waived dispatches exempt); only consulted while `requirementsPhase` is on                                                                                                                                                                                                                                                                                                              |
| `sessionSummary`                                                                                                                                   | `quiet`                                                                                                                                                                      | session-end summary surface: `quiet` prints one recap line at session.idle for sessions that did something (silent for zero-activity sessions); `on` also prints an all-gates-green line for zero-activity sessions; `off` disables the surface                                                                                                                                                                                |
| `agents.reviewer` / `agents.planReviewer` / `agents.executor` / `agents.testRunner` / `agents.debugger` / `agents.planner` / `agents.requirements` | `reviewer` / `plan-reviewer` / `executor` / `test-runner` / `debugger` / `planner` / `requirements`                                                                          | agent names recognized in dispatches                                                                                                                                                                                                                                                                                                                                                                                           |
| `agents.bareOutput`                                                                                                                                | `["test-runner", "reviewer", "plan-reviewer"]`                                                                                                                               | agents whose marker-less output is a violation; derived from the configured test-runner, reviewer, and plan-reviewer names when the key is absent or the list is empty (JSON has no way to write the code's "unset" sentinel, so the shipped example carries [] and the loader treats an empty list as unset)                                                                                                                  |
| `gateMarker` / `verdictMarker`                                                                                                                     | canonical regex sources                                                                                                                                                      | marker patterns, compiled with `gm`                                                                                                                                                                                                                                                                                                                                                                                            |
| `gateEvidence`                                                                                                                                     | `enforce`                                                                                                                                                                    | `enforce` requires a correlating exit-0 test command to flip the gate; `flag` flips on trust (stamps `verified`); `off` journals without it                                                                                                                                                                                                                                                                                    |
| `reviewEnsemble`                                                                                                                                   | `enforce`                                                                                                                                                                    | `enforce` credits a reviewer `VERDICT: APPROVE` only when at least two unwaived `task -> reviewer` dispatches were journaled this task (`reviewerDispatches >= 2`); `advise` tracks and journals the count but credits unconditionally                                                                                                                                                                                         |
| `evidencePattern`                                                                                                                                  | npm test / npm run test / the npm run ci verification chain / pnpm / yarn / bun / deno / node `--test` (interpolated node flags allowed) / pytest / `make test` / go / cargo | regex matched (case-insensitively) against bash/shell commands; user-overridable for non-JS toolchains (e.g. Ruby/`rspec`)                                                                                                                                                                                                                                                                                                     |
| `toolPolicy.bashDeny`                                                                                                                              | `[]` (empty)                                                                                                                                                                 | case-insensitive regex sources matched against `bash`/`shell` commands and blocked; the default-empty list is the off switch; an invalid source is dropped and journaled                                                                                                                                                                                                                                                       |
| `toolPolicy.pathDeny`                                                                                                                              | `[]` (empty)                                                                                                                                                                 | case-insensitive regex sources matched against `write`/`edit` target paths and blocked; the default-empty list is the off switch; a dropped source is journaled                                                                                                                                                                                                                                                                |
| `toolPolicy.observeSessionMove`                                                                                                                    | `true`                                                                                                                                                                       | journal `session_move` dispatches as telemetry (never blocks)                                                                                                                                                                                                                                                                                                                                                                  |
| `toolPolicy.bashWriteGate`                                                                                                                         | `true`                                                                                                                                                                       | gate confident file-writing bash commands (redirects from writer commands, `tee`, `sed -i`/`--in-place`, `cp`/`mv`/`dd`/`truncate`/`touch`) through the parent hands-on ladder; write-shaped commands always journal `handsOn` telemetry                                                                                                                                                                                       |
| `gitGates.commitMessages`                                                                                                                          | `true`                                                                                                                                                                       | validate `git commit -m` subjects as conventional commits and block invalid ones; `false` disables commit lint                                                                                                                                                                                                                                                                                                                 |
| `gitGates.commitFormat`                                                                                                                            | a conventional-commits regex source                                                                                                                                          | conventional-commits regex source (compiled `^...$`) matched against each subject; a bad source is dropped and journaled                                                                                                                                                                                                                                                                                                       |
| `gitGates.landingGate`                                                                                                                             | `true`                                                                                                                                                                       | gate `git push` on this task reviewer `VERDICT: APPROVE` — blocks; a repeat attempt escalates to the human ask in BOTH `escalation` modes (the block-throw is only the no-human fallback); `false` disables the gate                                                                                                                                                                                                           |
| `escalation`                                                                                                                                       | `block`                                                                                                                                                                      | repeat-attempt escalation mode for the landing and hands-on gates: both modes arm a one-shot latch and force the host permission ask on a repeat attempt (the block-throw is only the no-human fallback; collapses to allow under auto-accepting hosts); the plan-gate escalation is mode-gated (`block` blocks, `ask` prompts)                                                                                                |
| `gitGates.emptyDiffExempt`                                                                                                                         | `true`                                                                                                                                                                       | exempt a statically-resolvable `git push` whose every refspec's branch resolves to the same commit as its upstream (ref equality); journals `exempt:"empty-diff"`; every ambiguous shape — force flags included — still gates; `false` is the strict opt-out                                                                                                                                                                   |
| `gitGates.commitRetryThreshold`                                                                                                                    | 3                                                                                                                                                                            | blind-retry escalation: failed `invalid-commit-message` attempts for the same session within `commitRetryWindowMs` before the block message appends a full canonical example                                                                                                                                                                                                                                                   |
| `gitGates.commitRetryWindowMs`                                                                                                                     | 60000                                                                                                                                                                        | window in milliseconds for `commitRetryThreshold` burst counting                                                                                                                                                                                                                                                                                                                                                               |
| `decisionLedger.enabled`                                                                                                                           | `true`                                                                                                                                                                       | observe-only decision ledger: every admitted parent prompt journals a redacted, capped `prov:stated` entry, each human permission denial (plan/landing/hands-on reject) journals `prov:denied`, and each human gate waiver (plan/reviewer `WAIVED`) journals `prov:waiver`; query with `opencode-turnstile prov`. `false` disables all `prov:*` journaling with no other behavior change                                       |

Environment variables (override the file):

- `TURNSTILE_TRACE=0|1|true|false`: disable/enable the trace file (anything
  else is warned about and ignored)
- `TURNSTILE_METRICS_DIR=<dir>`: relocate the telemetry directory (absolute
  paths only; a relative value is warned about and ignored, leaving the
  default directory in place)
- `TURNSTILE_CONFIG=<path>`: use a different config file

---

## 5. Files and journals

- Journals live outside the repo in `~/.local/share/opencode/metrics/`:
  - `turnstile.jsonl`: shared JSONL audit trail (the fallback sink for
    entries without a sessionID); hot path is append-only and rotates
    once per `journalRotateEveryEntries` (default 512) writes under a
    lock-guarded rename, keeps `journalMaxGenerations` (default 5)
    generations; a lock left behind by a crash between create and remove of
    `<file>.lock` is stolen once its age passes a staleness bound
    (`ROTATION_LOCK_STALE_MS`, 60s) and the rotation proceeds, and journaling
    keeps appending through fresh contention
  - `sessions/<parentID>.jsonl`: per-parent-session segments (when
    `journalPerSession` is on, the default) — every entry with a resolvable
    parent sessionID appends here, so one session's story reads
    top-to-bottom; same rotation bounds per file. Grep one session's
    history with `rg … ~/.local/share/opencode/metrics/sessions/<parentID>.jsonl`
  - `gate-events.log`: human-readable
    `YYYY-MM-DD HH:MM | agent | event | detail` lines, with an optional
    trailing ` | <sessionID>` segment when the trace line is wired to a
    session (the first four segments are unchanged when it is absent);
    suppressed entirely by `trace: false`
  - `approved-plans.jsonl`: durable, bounded, project-scoped store of
    bound plan-reviewer approvals (plan name + content key + project
    scope + key-scheme tag (`scheme: "spec"`; untagged = legacy whole-file
    key)), capped at 256 records and rewritten on eviction. A plan whose
    name and content key still match a record for the current project is
    not _pending_ — the plan gate stays green for it even after its
    journal APPROVE line has aged out of `replayTailLines` and across
    prompt resets; an edited or replaced plan (key mismatch) stays
    pending. A legacy record whose whole-file key still matches the
    whole-file sha256 at the current plans scan is honored and re-keyed to
    the spec scheme on first touch (journaled `plan-rekey`; the re-key
    writes the current spec key). A cached scan may reflect the bytes at
    its last refresh rather than the current file — a progress-only edit
    leaves the spec region (and the cached scan signature) unchanged, so a
    legacy record can be honored across such an edit. A record matching
    neither key blocks with
    the `durable-key-stale` reason and a one-re-approval recovery message.
    Fail-open: read/write errors are journaled and the gate
    degrades to journal-replay semantics
- Retention is bounded: 2 files × (1 current + 5 generations) × 5 MB ≈
  ~30 MB per journal, worst case ~60 MB total, plus the approved-plan
  sidecar (≤ 256 short records). With `journalPerSession` on, each live
  session adds its own `sessions/<parentID>.jsonl` with the same per-file
  bounds, so aggregate retention and boot replay read cost scale with the
  live session count. Rotate overshoot is another
  `journalRotateEveryEntries` (default 512) entries × ~2 KB per journal,
  taken between the size check and the rename on the lock tick.
- `.opencode/plans/*.md` containing `## Decomposition` are load-bearing:
  their presence activates the executor chunk-citation gate.
- The journal also carries `{type:"ensemble", sessionID, agent, count}`
  entries: one per unwaived `task -> reviewer` dispatch, carrying the
  running `count`. Under `reviewEnsemble: enforce`, declining a
  single-reviewer APPROVE adds a `refusedApprove:true` stamp to the last
  `ensemble` entry and a `blocked` entry (`reason:"ensemble-incomplete"`,
  carrying `count` and `need: 2`). A human `always` release journals
  `refusedApprove:false` to clear the stamp. Each type is replayed at boot
  and contributes to the `replayTailLines` tail (default 2000): the last
  `ensemble` entry per session sets `reviewerDispatches`, and when it is
  stamped `refusedApprove:true` replay does not re-credit that APPROVE's
  `hasReviewApprove` on restart. When the landing gate is already released,
  a later APPROVE delivery is credited without a stamp: the release (human
  grant or mechanical) is never re-stamped as a refusal.

---

## 6. Status

`opencode-turnstile status` reports turnstile gate and plan state per parent
session, read from the journal, as a human-readable table by default or JSON
with `--json`:

```
opencode-turnstile status
opencode-turnstile status --json
opencode-turnstile status --check-updates
```

It is read-only: it never writes to the journal or config. The one write it
can make is `--check-updates`' cache file (`<metricsDir>/update-check.json`,
24h TTL) — an opt-in npm lookup for a newer turnstile, failures never cached.
Per session it
replays the same gate/plan last-wins rules the runtime uses (a trailing
`GATE: FAIL` keeps the gate red; a `verified:false` PASS never
flips), plus last markers, waiver events (with channel; the reviewer gate's
WAIVED entry also carries a scope in the journal, which status does not
currently render), and dispatch/block/permission counts. Blocked dispatches are
journaled with a `reason` (`round-limit`, `loop-cap`, `dispatch-budget`, …)
and every loop-cap exhaustion additionally writes a paired `escalation`
entry, so a stuck pipeline leaves a visible trail in the journal. Blocked
entries — including `loop-cap` and `dispatch-budget` reasons — are counted
in the BLK column, but status does not yet break them out by reason, and it
does not parse or render the paired `escalation` entries — that is a
documented gap, not a silence: the entries are written, they are just not
rendered by status yet. The journal reflects the last prompt-cycle;
in-memory state can be fresher (a session that has prompted since is newer
than the journal records), so treat status as the durable state of the
previous cycle rather than a live snapshot. The `--json` document also
carries a top-level `suspension` block (the resolved `allowSuspend`,
`suspendMarker`/`resumeMarker`, config path, and file presence) — the
surface the `turnstile-off`/`turnstile-on` skills read (§3).

### Sharing the evidence

`opencode-turnstile evidence` is the sharing half of the same read-only view:
where `status` answers "what is this session's state right now", `evidence`
answers "what did this task earn, in a form I can publish". It folds the same
replay-parity window with the same shape checks, then emits only derived
counts, canonical marker lines, and shas — session IDs, prompts, dispatch
descriptions, and bash command text are absent by construction, because the
document is built key by key rather than filtered. A task is named by a
one-way handle (`t-<8 hex>`), the journal by its head sha. `--format markdown`
renders the sticky-comment body; `--out` writes `<name>.json` and the sibling
`<name>.md`; `--validate` re-checks a committed artifact without writing. The
`review` section reports against the ensemble bar the runtime credits at — two
unwaived reviewer dispatches under the default `reviewEnsemble: "enforce"`, one
under `"advise"` — not against `maxReviewerRounds`, which only caps dispatches;
a refusal stamp keeps the section red, and a human release satisfies it, the
same credit rule the landing gate applies. It
is a correlated claim, not proof — say so in the comment you post.

---

## 7. Field-tested on itself

Turnstile is built with turnstile: most of this plugin's own development
runs through the pipeline it enforces, gates and journal on, so the
enforcement doubles as a field test. In the first week of that (Oct 8–15,
2026), the journal records ~350 pipeline dispatches and ~390 blocked calls
on this repo. Most of those blocks are the read-horizon cap doing its
unglamorous job; about 65 caught real pipeline violations: executor
dispatches without an approved plan, unverified `GATE: PASS` claims, invalid
commit subjects, and unapproved pushes that never landed.

This repo now runs the landing gate enforced: an unapproved push is
refused, not journaled. The flip was motivated by 54
`no-landing-approval` would-blocks across 38 sessions — pushes the
approved ensemble had actually earned, recorded by the observe-mode
journaling that predates enforced landing. A fix to
the delivery-credit path (a reviewer `VERDICT: APPROVE` delivered without
`input.agent` never credited the gate) landed before the flip, so the
enforced gate releases on approvals it would otherwise have missed.

Don't take this section at face value: run `npx opencode-turnstile status`
and read the journal yourself.

Publishing that record is part of the field test: this repo ships the
evidence workflow under `.github/workflows`, so the pipeline claims a
reviewer would otherwise take on faith are posted on the pull request
itself — the same artifact the `evidence` command emits, validated in the
untrusted job and published from the base-context one.
