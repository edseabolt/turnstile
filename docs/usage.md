# Turnstile — Usage

Day-to-day operation of the turnstile plugin: a worked session from planner
to landing, waivers and approvals in full, installing and maintaining the
plugin, the complete configuration reference, journals and retention, and
the `status` command. For how the plugin works inside — module map, hook
surface, gate state machine, journal/replay, policy injection — see
[`architecture.md`](architecture.md).

## Contents

1. [A worked session](#a-worked-session)
2. [Waivers and approvals](#waivers-and-approvals)
3. [Installing and maintaining](#installing-and-maintaining)
4. [Configuration](#configuration)
5. [Files and journals](#files-and-journals)
6. [Status](#status)
7. [Field-tested on itself](#field-tested-on-itself)

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
BLOCKED by turnstile: executor dispatch requires an approved plan
(VERDICT: APPROVE from plan-reviewer, PLAN APPROVED: in your prompt,
or approve the permission ask)
```

— and, with no approval holding, the first executor attempt escalates to
you as an interactive permission ask naming the plan file and its head
(`always` = approved for the task, `once` = one dispatch, `reject` = gate
stays red).

**Prompt continues — test-runner.** The **test-runner** runs the suite and
emits its marker as the first line of its output:

```text
GATE: PASS tests=12 passed=11 failed=1
```

Under the default `gateEvidence:enforce`, that marker only flips the gate
when a real exit-0 test execution exists in this task's bash/shell history
(matched against `evidencePattern`). A pass claimed without a run is held
as `unverifiedPass` and promoted the moment the execution is journaled —
including when a background child's edge resolves late. A `GATE: FAIL`
latest-wins: it un-greens an earlier PASS and sends the orchestrator back to
the executor.

**Prompt continues — reviewer, twice.** The **reviewer** is gated on the
verified pass and capped at 2 dispatches per task. Under the default
`reviewEnsemble:enforce`, a single reviewer APPROVE does not credit the
landing gate — the orchestrator dispatches the reviewer a second time
(unwaived), and only then does the approval carry.

A reviewer running on a waived dispatch never counts toward the ensemble:
a fully waived review leaves the landing gate red regardless of the verdict.

**Landing.** With a credited reviewer approval held, the landing gate
releases `git push` and it goes through. A push without approval is
refused (`"reason":"no-landing-approval"`) and, on a repeat, escalates to
the human permission ask. Commit subjects are linted as conventional
commits (`gitGates.commitMessages: true`); under `enforce` an invalid
subject blocks the commit outright. This is `gitGates.mode: enforce`, the
recommended configuration and what this repo runs. The shipped default is
still `shadow` — the adoption path: the same checks journal would-blocks
(`"reason":"no-landing-approval"` / `"invalid-commit-message"`) without
throwing, so you can grep the journal and tune the rules before flipping
the mode (config is read once at setup).

**Prompt 2 — a new task.** Your next prompt resets the session's gate state
(a restart-restored flag survives exactly the resume prompt, then reverts —
`replayGrace`). Earned state from issue #42 does not leak into the next
task; the pipeline starts over. Exception: `continuationCarry: true`
carries earned flags across a prompt whose worktree/branch fingerprint is
unchanged — gate-scoped, earned state only, never an unearned approval.

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
landing gate red — it is released only by the human permission ask, never by
the waived verdict.

Only the reviewer stage meters waiver exemptions; a waiver covering another
stage exempts that leg's loop cap and the total dispatch budget without
counting — by design, a planner-scoped waiver permits an unbounded planner
loop within the task; the bound is the user's own prompt.

### Prompt-channel approval

Put `PLAN APPROVED:` in your prompt to approve the plan the same way a
plan-reviewer `VERDICT: APPROVE` would; it records human provenance and
replays across restart like a reviewer verdict.

### Permission-prompt escalation

When no approval holds, the first executor dispatch escalates to you through
OpenCode's permission surface, naming the plan file and its head. Reply
`always` (approved for the task), `once` (one dispatch), or `reject` (gate
stays red).

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
check.

### Upgrade

The plugin updates with your dependency manager (`npm upgrade
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

### From a clone

This repo is the source of truth for what lands in `~/.config/opencode`:
the plugin and the pipeline agent definitions are installed per the manifest
in `install.json`; unowned files in the target directories are never
touched. Two install modes:

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
  ones do.
- **Fork the repo.** To change the pipeline content itself, fork and edit
  `agents/*.md` there; your installer serves your fork.

One coupling to know when customizing either way: the shipped definitions
reference `.opencode/plans/` as turnstile's **default** `plansDir`, not a
constant — the plan path travels in the dispatch prompt, and the agents are
instructed to honor it over the default. If you reconfigure `plansDir`,
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

The `$schema` key is silently ignored at load (it is not a turnstile key),
and validation itself stays in `mergeConfig` — the schema is an editor and
documentation artifact, not a runtime validator.

Precedence: defaults < config file < env. The plugin reads config once, at
setup; restart sessions to apply. Invalid keys are ignored, journaled, and
summarized once into the session context on the first tool result after
load — a `[turnstile] config:` block naming up to 5 warnings (beyond that,
`(N more; see the journal)`) and the journal path, with the full list in the
journal (fail-open); a malformed config file never breaks the host.

| Key                                                                                                                        | Default                                                                                                                                                                      | Meaning                                                                                                                                                                                                                                                |
| -------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `metricsDir`                                                                                                               | `$XDG_DATA_HOME/opencode/metrics`, fallback `~/.local/share/opencode/metrics`                                                                                                | directory for both telemetry files                                                                                                                                                                                                                     |
| `journalMaxBytes`                                                                                                          | 5242880                                                                                                                                                                      | rotate a journal file past this size                                                                                                                                                                                                                   |
| `journalMaxGenerations`                                                                                                    | 5                                                                                                                                                                            | rotated generations kept per journal                                                                                                                                                                                                                   |
| `journalRotateEveryEntries`                                                                                                | 512                                                                                                                                                                          | rotation cadence in appends; the rotate-then-rename runs once this many appends apart                                                                                                                                                                  |
| `replayTailLines`                                                                                                          | 2000                                                                                                                                                                         | newest journal lines replayed per boot to restore gate/plan state — the walk covers all retained generations and stops early once the bound is met; bound plan approvals older than the window persist through the `approved-plans.jsonl` sidecar (§5) |
| `maxReviewerRounds`                                                                                                        | 2                                                                                                                                                                            | reviewer dispatches per task, regardless of gate state (waived dispatches exempt)                                                                                                                                                                      |
| `maxPlannerRounds`                                                                                                         | 3                                                                                                                                                                            | planner dispatches per task (waived dispatches exempt)                                                                                                                                                                                                 |
| `maxPlanReviewerRounds`                                                                                                    | 3                                                                                                                                                                            | plan-reviewer dispatches per task (waived dispatches exempt)                                                                                                                                                                                           |
| `maxTestRunnerRounds`                                                                                                      | 4                                                                                                                                                                            | test-runner dispatches per task (waived dispatches exempt)                                                                                                                                                                                             |
| `maxTotalDispatches`                                                                                                       | 16                                                                                                                                                                           | total task dispatches per task across every leg — the global loop backstop (waived dispatches exempt)                                                                                                                                                  |
| `maxSessions`                                                                                                              | 64                                                                                                                                                                           | LRU cap on tracked sessions (gate state, child→parent edges, verdicts); registered live parents are never evicted                                                                                                                                      |
| `readWarn` / `readBlock`                                                                                                   | 8 / 15                                                                                                                                                                       | whole-file read horizon                                                                                                                                                                                                                                |
| `observeSessions`                                                                                                          | 0                                                                                                                                                                            | first N admitted sessions journal decisions without blocking; `0` enforces immediately                                                                                                                                                                 |
| `waiverMarker`                                                                                                             | `USER WAIVER:`                                                                                                                                                               | literal waiver marker                                                                                                                                                                                                                                  |
| `approvalMarker`                                                                                                           | `PLAN APPROVED:`                                                                                                                                                             | literal prompt-channel plan-approval marker                                                                                                                                                                                                            |
| `plansDir`                                                                                                                 | `.opencode/plans`                                                                                                                                                            | executor decomposition scan directory — an absolute value is honored as-is with a journaled warning (not joined to projectDir)                                                                                                                         |
| `trace`                                                                                                                    | `true`                                                                                                                                                                       | write the human-readable trace file (JSONL journal always writes)                                                                                                                                                                                      |
| `continuationCarry`                                                                                                        | `false`                                                                                                                                                                      | carry the task's gate flags across a prompt reset when the worktree/branch is unchanged (continuation), instead of starting a clean cycle                                                                                                              |
| `agents.reviewer` / `agents.planReviewer` / `agents.executor` / `agents.testRunner` / `agents.debugger` / `agents.planner` | `reviewer` / `plan-reviewer` / `executor` / `test-runner` / `debugger` / `planner`                                                                                           | agent names recognized in dispatches                                                                                                                                                                                                                   |
| `agents.bareOutput`                                                                                                        | `["test-runner", "reviewer", "plan-reviewer"]`                                                                                                                               | agents whose marker-less output is a violation; set to `[]` to disable the built-in derivation (JSON has no way to write the code's "unset" sentinel, which re-derives the list when agent names change)                                               |
| `gateMarker` / `verdictMarker`                                                                                             | canonical regex sources                                                                                                                                                      | marker patterns, compiled with `gm`                                                                                                                                                                                                                    |
| `gateEvidence`                                                                                                             | `enforce`                                                                                                                                                                    | `enforce` requires a correlating exit-0 test command to flip the gate; `flag` flips on trust (stamps `verified`); `off` journals without it                                                                                                            |
| `reviewEnsemble`                                                                                                           | `enforce`                                                                                                                                                                    | `enforce` credits a reviewer `VERDICT: APPROVE` only when at least two unwaived `task -> reviewer` dispatches were journaled this task (`reviewerDispatches >= 2`); `advise` tracks and journals the count but credits unconditionally                 |
| `evidencePattern`                                                                                                          | npm test / npm run test / the npm run ci verification chain / pnpm / yarn / bun / deno / node `--test` (interpolated node flags allowed) / pytest / `make test` / go / cargo | regex matched (case-insensitively) against bash/shell commands; user-overridable for non-JS toolchains (e.g. Ruby/`rspec`)                                                                                                                             |
| `toolPolicy.mode`                                                                                                          | `enforce`                                                                                                                                                                    | `enforce` blocks matching commands/paths; `shadow` journals would-blocks without throwing (adoption path); `off` is a silent no-op                                                                                                                     |
| `toolPolicy.bashDeny`                                                                                                      | `[]` (empty)                                                                                                                                                                 | case-insensitive regex sources matched against `bash`/`shell` commands; an invalid source is dropped and journaled                                                                                                                                     |
| `toolPolicy.pathDeny`                                                                                                      | `[]` (empty)                                                                                                                                                                 | case-insensitive regex sources matched against `write`/`edit` target paths; a dropped source is journaled                                                                                                                                              |
| `toolPolicy.observeSessionMove`                                                                                            | `true`                                                                                                                                                                       | journal `session_move` dispatches as telemetry (never blocks)                                                                                                                                                                                          |
| `gitGates.mode`                                                                                                            | `shadow`                                                                                                                                                                     | `enforce` blocks invalid commits and unapproved pushes (recommended; this repo runs it); `shadow` would-blocks without throwing (adoption path); `off` is a silent no-op                                                                               |
| `gitGates.commitMessages`                                                                                                  | `true`                                                                                                                                                                       | validate `git commit -m` subjects as conventional commits; `shadow` journals, `enforce` blocks, `off` is a no-op                                                                                                                                       |
| `gitGates.commitFormat`                                                                                                    | a conventional-commits regex source                                                                                                                                          | conventional-commits regex source (compiled `^...$`) matched against each subject; a bad source is dropped and journaled                                                                                                                               |
| `gitGates.landingGate`                                                                                                     | `true`                                                                                                                                                                       | gate `git push` on this task reviewer `VERDICT: APPROVE`; `shadow` journals, `enforce` blocks then escalates, `off` is a no-op                                                                                                                         |

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
  - `turnstile.jsonl`: full JSONL trace; hot path is append-only and rotates
    once per `journalRotateEveryEntries` (default 512) writes under a
    lock-guarded rename, keeps `journalMaxGenerations` (default 5)
    generations; a lock left behind by a crash between create and remove of
    `<file>.lock` is skipped (that file stops rotating) until the directory
    is removed, and journaling keeps appending through it
  - `gate-events.jsonl`: human-readable
    `YYYY-MM-DD HH:MM | agent | event | detail` lines, with an optional
    trailing ` | <sessionID>` segment when the trace line is wired to a
    session (the first four segments are unchanged when it is absent);
    suppressed entirely by `trace: false`
  - `approved-plans.jsonl`: durable, bounded, project-scoped store of
    bound plan-reviewer approvals (plan name + content key + project
    scope), capped at 256 records and rewritten on eviction. A plan whose
    name and content key still match a record for the current project is
    not _pending_ — the plan gate stays green for it even after its
    journal APPROVE line has aged out of `replayTailLines` and across
    prompt resets; an edited or replaced plan (key mismatch) stays
    pending. Fail-open: read/write errors are journaled and the gate
    degrades to journal-replay semantics
- Retention is bounded: 2 files × (1 current + 5 generations) × 5 MB ≈
  ~30 MB per journal, worst case ~60 MB total, plus the approved-plan
  sidecar (≤ 256 short records). Rotate overshoot is another
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
```

It is read-only: it never writes to the journal or config. Per session it
replays the same gate/plan last-wins rules the runtime uses (a trailing
`GATE: FAIL` keeps the gate red; an enforce-mode `verified:false` PASS never
flips), plus last markers, waiver events (with channel; the reviewer gate's
WAIVED entry also carries a scope, which status surfaces via the waiver
record), and dispatch/block/permission counts. Blocked dispatches are
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
previous cycle rather than a live snapshot.

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

This repo now lands under `gitGates.mode: enforce`: an unapproved push is
refused, not journaled. The flip was motivated by 54
`no-landing-approval` would-blocks across 38 sessions — pushes the
approved ensemble had actually earned but `shadow` only recorded. Issue
#129 fixed the underlying credit bug (a reviewer `VERDICT: APPROVE`
delivered without `input.agent` never credited the gate), so the enforced
gate now releases on approvals it used to miss.

Don't take this section at face value: run `npx opencode-turnstile status`
and read the journal yourself.
