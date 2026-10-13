# turnstile

An [OpenCode](https://opencode.ai) v2 plugin that mechanically enforces an
agent pipeline: planner → plan-reviewer → executor → test-runner → reviewer.
The pipeline policy is injected at runtime by the plugin: when the plugin is
loaded, it prepends the orchestrator policy to the primary session's first
task result every task (see [Policy injection](#policy-injection)), so a fresh
install can never lose it and nothing is written to any instructions file at
install time. Per-agent instruction lines live in each `agents/<name>.md`. The
policy steers the agents, and turnstile blocks the dispatches that violate it.

The entry point is `turnstile.ts`; behavior lives in focused modules under
`src/` (one boundary per file: types, config, policy, journal, state,
markers, evidence, gates, tool-policy, setup). The plugin has zero runtime
dependencies and fails open.

Verify with:

```sh
npm install
npm run ci          # ci:host (lint, format:check, typecheck, check:markers, test with a 100% coverage gate) — host chain only; green on a fresh clone
npm run ci:installed  # install:check — run after `npm run init` on a machine with installed artifacts
```

## What it enforces

| Gate                   | Behavior                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Plan-approval gate     | `executor` subagent dispatches are blocked until a plan-reviewer result in the session recorded `VERDICT: APPROVE` (when any plan exists in `.opencode/plans/*.md`), or the dispatch prompt contains the literal marker `USER WAIVER:`; plan-content changes invalidate approvals issued against the previous plans-dir signature (replayed approvals are accepted once, then stamped)                                                                                                                                                                                                                              |
| Reviewer dispatch gate | `reviewer` subagent dispatches are blocked until a test-runner result in the session recorded a `GATE: PASS` _verified_ by the current task's bash/shell executions — a matching exit-0 test command under the default `gateEvidence:enforce`; `flag` flips on trust (still stamped), `off` never stamps — or the dispatch prompt contains the literal marker `USER WAIVER:`                                                                                                                                                                                                                                        |
| Reviewer round cap     | Max 2 `reviewer` dispatches per task, regardless of gate state; dispatches carrying `USER WAIVER:` bypass the cap and do not count toward it.                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| Decomposition gate     | `executor` dispatches must cite `chunk-N` / `AC-n` when any plan in `.opencode/plans/*.md` has a `## Decomposition` block                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| Read horizon           | Warns at 8 whole-file `read` calls per session, blocks at 15 (prefer grep/glob)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| Tool-call policy gate  | `bash`/`shell` commands and `write`/`edit` target paths are matched in `execute.before` against a configurable denylist and blocked with `BLOCKED by turnstile:` under `toolPolicy.mode: enforce`; `shadow` journals the would-block without throwing (adoption path), `off` is a silent no-op. Default `bashDeny` blocks the git-protective operations in [`src/policy.ts`](src/policy.ts) (worktree, branch `switch`/`checkout`, `merge`, `gh pr create or merge`); `pathDeny` defaults empty so ordinary editing is never blocked until configured. `session_move` is journaled as telemetry only, never blocked |
| Marker parsing         | `GATE:` / `VERDICT:` markers are parsed from task results and child-session text, deduped per task; marker-less outputs from marker-contracted agents (test-runner/reviewer/plan-reviewer) are journaled                                                                                                                                                                                                                                                                                                                                                                                                            |
| Trace                  | JSONL journal of dispatches, gate transitions, verdicts, blocked calls, bash commands, errors; `setup` heartbeat per session (plugin version, config digest, hook count), stream-death errors, unresolvable-agent dispatch errors                                                                                                                                                                                                                                                                                                                                                                                   |
| Decoding clamps        | executor/test-runner/debugger temperature ≤ 0.2; reviewer and plan-reviewer temperature = 0                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| Compaction             | Injects a "preserve verbatim" instruction for markers and findings                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |

A new user prompt resets the session's gate state. Replayed gate state
survives a restart and the next user prompt (the resume prompt), then
reverts: every later prompt starts a clean gate cycle. Replay reads the
last 2000 lines of the journal, spanning the current file and its previous
rotated generation (`GATE: PASS` and plan `VERDICT: APPROVE`
entries).

## How it fits the ecosystem

Claude Code's agent workflows are backed by host-side governance:
permission prompts and tool hooks that can stop a call before it
happens. I built turnstile to bring that shape to OpenCode: gates the
runtime enforces, not requests the model honors. It borrows the
enforcement model without the implementation, and stays
OpenCode-native: zero dependencies, TypeScript, loaded from your own
checkout.

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

## Install

Turnstile ships as the npm package
[`opencode-turnstile`](https://www.npmjs.com/package/opencode-turnstile).
There are three
ways to use it; pick one, and do not combine the plugin-array path with
the CLI install.

1. **Zero-config enforcement (plugin only).** Add the package to your
   OpenCode config's plugin array and restart. turnstile loads and enforces
   its gates, injecting the orchestrator policy into the primary session at
   runtime (see [Policy injection](#policy-injection)) — nothing is written to
   any instructions file, and the pipeline agent definitions are not installed
   by this option alone:

   ```json
   { "plugins": ["opencode-turnstile"] }
   ```

2. **Full install via the CLI.** `npx opencode-turnstile init` installs the
   plugin and the pipeline agent definitions; the orchestrator policy is
   injected at runtime by the plugin, so no contract block is written to
   `~/.config/opencode/AGENTS.md` (see
   [From a clone](#from-a-clone) below for the same commands run from
   a clone).

3. **Develop from a clone.** Clone this repo and run `npm run init`
   (symlink mode) so installed artifacts stay live against your edits.
   See [From a clone](#from-a-clone) below.

### No postinstall

Turnstile has **no** npm lifecycle hook (`postinstall`, etc.). Installing
`opencode-turnstile` as a dependency never writes to
`~/.config/opencode`; it only makes the gates available through the
plugin array. Everything else (the agent definitions) happens only when you
run an explicit command. This is deliberate: writes to your config directory
are opt-in, not automatic.

### Modes

`init` auto-detects an install mode: a git checkout installs by
linking (the working tree stays the source of truth, so edits are
live); an `npx` package install copies files (the installed files are
the source of truth). Override with `--link` or `--copy`:

```sh
npx opencode-turnstile init --copy
```

The chosen mode is recorded in the ledger, so `check` stays consistent
across reruns.

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
orchestrator policy. It is idempotent and ownership-aware:
files it never installed (untracked files, symlinks pointing outside the
repo) are left alone, and a second run is a clean no-op. Injected policy is
gone the moment the plugin is unloaded; a legacy contract block once written
by hand into `~/.config/opencode/AGENTS.md` is not owned by turnstile and is
removed separately — see
[Migrating a legacy AGENTS.md block](#migrating-a-legacy-agentsmd-block).

### From a clone

This repo is the source of truth for what lands in `~/.config/opencode`:
the plugin and the pipeline agent definitions are installed per the
manifest in `install.json`; unowned files in the target directories are
never touched. Two install modes are available:

|                           | Symlink (default)                                   | Copy (`--copy`)                                         |
| ------------------------- | --------------------------------------------------- | ------------------------------------------------------- |
| Best for                  | developing turnstile                                | general use, dotfiles repos that reject foreign links   |
| How targets point at repo | symlinks into the checkout                          | real copies                                             |
| After `git pull`          | nothing to do; edits are live on next session start | re-run `npm run init -- --copy` to re-sync              |
| Editing installed files   | edit the repo; links share it                       | edit the repo; user-edited copies conflict on next sync |

```sh
git clone <repo-url> && cd turnstile
npm install          # typescript + @types/node, for typechecking
npm run init      # symlink mode
# or: npm run install:copy
npm run install:check  # verify installed state; exit 1 on drift (gates local CI)
```

A target that differs from the repo is a **conflict**: `install` fails with
a per-path summary. Re-run with `--force` to back the file up
(`<name>.bak.<timestamp>`) and replace it. Conflicts mean:

- symlink mode: a real file (or a link pointing outside the repo) sits at a
  manifest target and differs from the source, typically pre-existing
  files or hand edits.
- copy mode: an installed copy was edited after install (the ledger can
  tell user edits from repo updates), or an untracked real file sits at a
  target.

Copy mode records everything it installed in
`~/.config/opencode/.turnstile-install.json` (the ledger: destination
mapped to source, content hash, package version, and install mode). The
ledger makes re-syncs safe: repo
updates re-copy cleanly and user edits fail loudly. It also lets the
installer remove copies whose manifest entry was deleted. Deleting the
ledger turns every copy into an untracked file the installer will refuse
to touch.

### Set the agents' models

The six agent definitions in `agents/` ship **without** a `model:`
frontmatter key. Each subagent therefore runs on the model of the session
that dispatched it — OpenCode v2's documented inheritance rule — so there
is nothing to configure for the common case.

To pin a specific model per agent, paste a block into
`~/.config/opencode/opencode.json` (**plural** `agents` is the v2 key;
v1 used singular `agent`):

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "agents": {
    "planner": { "model": "anthropic/claude-haiku-4-5" },
    "plan-reviewer": { "model": "anthropic/claude-haiku-4-5" },
    "executor": { "model": "anthropic/claude-sonnet-4-5" },
    "test-runner": { "model": "anthropic/claude-haiku-4-5" },
    "reviewer": { "model": "anthropic/claude-sonnet-4-5" },
    "debugger": { "model": "anthropic/claude-sonnet-4-5" },
  },
}
```

Model IDs come from `opencode models` and take the form
`provider/modelID`, with an optional `#variant`. Restarts pick the change
up. Because the shipped definitions are silent on `model:`, a pin you add
is the only definition of that model — there is no merge precedence to
reason about.

Copy-mode users: after a `git pull` that changes these definitions,
re-run `npm run install:copy` to pick up the new frontmatter. `npm run
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
  --model planner=anthropic/claude-haiku-4-5 \
  --model executor=oMLX/oQ/GLM-5.3-Flash-oQ4-mtp
```

Add `--validate` to cross-check every concrete seed against
`opencode models` and exit 1 naming a model it does not list; placeholder
seeds are skipped. `--model` and `--validate` are only valid with
`--print-model-config`: given without it, install.mjs prints an actionable
message and exits 2.

```sh
npm run init -- --print-model-config --model planner=anthropic/claude-haiku-4-5 --validate
```

Paste the output into `~/.config/opencode/opencode.json` (see the
[Set the agents' models](#set-the-agents-models) section).
`opencode-turnstile init -- --print-model-config` routes the same flags
through `scripts/install.mjs` and adds nothing of its own: `install.mjs`
recognizes `--print-model-config` and prints before writing, and the router
skips the agents install step entirely in that case — so the whole command
writes nothing (no ledger, no links, no agents, no injected policy). Plain
`init` still installs everything as usual.

### Customizing the pipeline agents

The agent definitions are opinionated on purpose: turnstile recognizes
and clamps them by name, and the marker contract in the agent prompts is
what the plugin enforces against. Editing the installed files is therefore
not a supported customization path: symlink installs share the repo file,
and copy installs conflict on the next sync.

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

### Updating

Symlink mode: because everything is linked into the checkout, updating is
just:

```sh
git pull            # in this repo
npm install         # only if dependencies changed
```

then restart OpenCode sessions (or `opencode service restart`) so the
running server reloads the plugin. There is no separate install step for
code or agent changes; the links are already live. Re-run
`npm run init` only when the **set** of artifacts changes (a new agent
added to `install.json`, an artifact removed or moved): it creates, fixes,
or removes repo-owned links to match the manifest.

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

### Policy injection

Turnstile does not read orchestrator policy from a file at install time —
it makes that policy available by injecting it at runtime. When the plugin is
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
  plugin parses markers from _any_ session text, so a fully concrete example
  echoed back by the model could flip a gate; the placeholder form stays
  unparseable while remaining human-readable.
- **Per-agent instructions** are not injected by the plugin: they live in
  each `agents/<name>.md` installed alongside the plugin.

With the plugin **off**, none of this prose is present anywhere — there is no
AGENTS.md block to fall back on. That is the deliberate tradeoff: loss-proof
by construction while the plugin loads, and a known, documented gap when it
does not.

### Migrating a legacy AGENTS.md block

If a previous turnstile install once wrote a managed contract block into
`~/.config/opencode/AGENTS.md`, that block is now orphaned: the plugin no
longer reads or manages it, and it will coexist with the injected policy
(duplicate prose until removed). There is deliberately no installer to remove
it — turnstile no longer owns that file, so it never rewrites it. Delete the
sentinel-delimited block by hand, once:

```sh
# ~/.config/opencode/AGENTS.md — delete the section between the
# `<!-- turnstile:start -->` and `<!-- turnstile:end -->` sentinels, then save
```

After that, the injected policy is the single source of orchestrator policy
for the session.

## Configuration

Defaults live in code (`src/config.ts`); override via
`~/.config/opencode/turnstile.json`, environment variables, or both.

**Quick start: copy the example config** — [`examples/turnstile.example.json`](examples/turnstile.example.json)
to `~/.config/opencode/turnstile.json` and edit from there. Every key in it
is optional and matches the code defaults; delete any key to fall back to the
default. One key is deliberately omitted from the example:

- `metricsDir`: computed at load time (`$XDG_DATA_HOME/opencode/metrics`,
  fallback `~/.local/share/opencode/metrics`); if you set it yourself it must
  be an absolute path (`~` is not expanded)

The example also carries `gateMarker` / `verdictMarker` verbatim so you can
see the format; leave them alone unless you are intentionally changing
the marker syntax (the shipped subagent definitions emit the canonical
markers).

Precedence: defaults < config file < env. The plugin reads config once, at
setup; restart sessions to apply. Invalid keys are ignored and journaled
(fail-open); a malformed config file never breaks the host.

| Key                                                                                                     | Default                                                                        | Meaning                                                                                                                                     |
| ------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `metricsDir`                                                                                            | `$XDG_DATA_HOME/opencode/metrics`, fallback `~/.local/share/opencode/metrics`  | directory for both telemetry files                                                                                                          |
| `journalMaxBytes`                                                                                       | 5242880                                                                        | rotate a journal file past this size                                                                                                        |
| `journalMaxGenerations`                                                                                 | 5                                                                              | rotated generations kept per journal                                                                                                        |
| `maxReviewerRounds`                                                                                     | 2                                                                              | reviewer dispatches per task, regardless of gate state (waived dispatches exempt)                                                           |
| `maxSessions`                                                                                           | 64                                                                             | LRU cap on tracked sessions (gate state, child→parent edges, verdicts); registered live parents are never evicted                           |
| `readWarn` / `readBlock`                                                                                | 8 / 15                                                                         | whole-file read horizon                                                                                                                     |
| `waiverMarker`                                                                                          | `USER WAIVER:`                                                                 | literal waiver marker                                                                                                                       |
| `plansDir`                                                                                              | `.opencode/plans`                                                              | executor decomposition scan directory                                                                                                       |
| `trace`                                                                                                 | `true`                                                                         | write the human-readable trace file (JSONL journal always writes)                                                                           |
| `agents.reviewer` / `agents.planReviewer` / `agents.executor` / `agents.testRunner` / `agents.debugger` | `reviewer` / `plan-reviewer` / `executor` / `test-runner` / `debugger`         | agent names recognized in dispatches                                                                                                        |
| `agents.bareOutput`                                                                                     | `["test-runner", "reviewer", "plan-reviewer"]`                                 | agents whose marker-less output is a violation                                                                                              |
| `gateMarker` / `verdictMarker`                                                                          | canonical regex sources                                                        | marker patterns, compiled with `gm`                                                                                                         |
| `gateEvidence`                                                                                          | `enforce`                                                                      | `enforce` requires a correlating exit-0 test command to flip the gate; `flag` flips on trust (stamps `verified`); `off` journals without it |
| `evidencePattern`                                                                                       | a npm/pnpm/yarn/bun/deno/node `--test`/pytest/`make test`/go/cargo pattern     | regex matched (case-insensitively) against bash/shell commands; user-overridable for non-JS toolchains (e.g. Ruby/`rspec`)                  |
| `toolPolicy.mode`                                                                                       | `enforce`                                                                      | `enforce` blocks matching commands/paths; `shadow` journals would-blocks without throwing (adoption path); `off` is a silent no-op          |
| `toolPolicy.bashDeny`                                                                                   | the git-protective defaults (worktree, branch switch/checkout, merge, `gh pr`) | case-insensitive regex sources matched against `bash`/`shell` commands; an invalid source is dropped and journaled                          |
| `toolPolicy.pathDeny`                                                                                   | `[]` (empty)                                                                   | case-insensitive regex sources matched against `write`/`edit` target paths; a dropped source is journaled                                   |
| `toolPolicy.observeSessionMove`                                                                         | `true`                                                                         | journal `session_move` dispatches as telemetry (never blocks)                                                                               |

Environment variables (override the file):

- `TURNSTILE_TRACE=0|1`: disable/enable the trace file
- `TURNSTILE_METRICS_DIR=<dir>`: relocate the telemetry directory
- `TURNSTILE_CONFIG=<path>`: use a different config file

## Markers

Subagents must emit these as the first line of their output. These examples
are the canonical syntax; CI asserts the parser in `src/markers.ts` accepts
exactly them.

```
GATE: PASS tests=12 passed=11 failed=1
GATE: FAIL tests=12 passed=10 failed=2

VERDICT: APPROVE crit=0 high=0 med=2 low=1
VERDICT: BLOCK crit=1 high=0 med=0 low=2
```

Waiver marker (must appear in the reviewer dispatch prompt, verbatim):

```
USER WAIVER: <the user's words>
```

## What turnstile is not

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
- `USER WAIVER:` as a substring anywhere in a dispatch prompt unlocks the
  reviewer gate. A prompt-injected waiver is indistinguishable from a real
  one.
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

### Adopting the tool-call policy (shadow first)

The default `toolPolicy.mode: enforce` blocks the git-protective operations the
policy already demands, so it is safe to adopt immediately. To tune it with zero
risk of breaking work, boot one session in `toolPolicy.mode: shadow` first:
would-block commands and paths are journaled with `"reason":"tool-policy"` and
`mode:"shadow"` but never throw. Grep the journal for that reason, review the
rules that fired, adjust `toolPolicy.bashDeny`/`pathDeny` (each rule is
case-insensitive), then flip to `enforce`. Restart sessions to apply config —
it is read once at setup.

## Files and journals

- Journals live outside the repo in `~/.local/share/opencode/metrics/`:
  - `turnstile.jsonl`: full JSONL trace; rotates at 5 MB, keeps 5
    generations
  - `gate-events.jsonl`: human-readable
    `YYYY-MM-DD HH:MM | agent | event | detail` lines, with an optional
    trailing ` | <sessionID>` segment when the trace line is wired to a
    session (the first four segments are unchanged when it is absent);
    suppressed entirely by `trace: false`
- Retention is bounded: 2 files × (1 current + 5 generations) × 5 MB ≈
  ~30 MB per journal, worst case ~60 MB total.
- `.opencode/plans/*.md` containing `## Decomposition` are load-bearing:
  their presence activates the executor chunk-citation gate.

## Behavior contract

- Fail-open by design. Every hook body is guarded; internal errors are
  journaled and the tool call proceeds. Removing the plugin leaves the
  pipeline functional (prompt contracts alone). The only thrown errors are
  the deliberate `BLOCKED by turnstile:` ones.
- The doc comment at the top of `turnstile.ts` is the authoritative summary
  of enforced contracts; this README mirrors it and CI keeps the marker
  examples in sync with the parser regexes.
- Host API is the OpenCode v2 promise-plugin shape
  (`{ tool.hook, session.hook, event.subscribe }`), verified against
  opencode v2.0.22.
