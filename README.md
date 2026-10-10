# turnstile

An [OpenCode](https://opencode.ai) v2 plugin that mechanically enforces an
agent pipeline: planner → plan-reviewer → executor → test-runner → reviewer.
The workflow
itself lives in a policy instruction file (e.g. `AGENTS.md`) that tells the
agents what the pipeline is; turnstile complements that file rather than
replacing it. The policy steers the agents, and turnstile blocks the
dispatches that violate it.

The entry point is `turnstile.ts`; behavior lives in focused modules under
`src/` (one boundary per file: types, journal, state, markers, gates,
setup). The plugin has zero runtime dependencies and fails open.

Verify with:

```sh
npm install
npm run ci          # ci:host (lint, format:check, typecheck, check:markers, test) + install:check
```

## What it enforces

| Gate                   | Behavior                                                                                                                                                                                                                                                                          |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Plan-approval gate     | `executor` subagent dispatches are blocked until a plan-reviewer result in the session recorded `VERDICT: APPROVE` (when any plan exists in `.opencode/plans/*.md`), or the dispatch prompt contains the literal marker `USER WAIVER:`; plan-file changes invalidate the approval |
| Reviewer dispatch gate | `reviewer` subagent dispatches are blocked until a test-runner result in the session recorded `GATE: PASS`, or the dispatch prompt contains the literal marker `USER WAIVER:`                                                                                                     |
| Reviewer round cap     | Max 2 `reviewer` dispatches per task without a `GATE: PASS`                                                                                                                                                                                                                       |
| Decomposition gate     | `executor` dispatches must cite `chunk-N` / `AC-n` when any plan in `.opencode/plans/*.md` has a `## Decomposition` block                                                                                                                                                         |
| Read horizon           | Warns at 8 whole-file `read` calls per session, blocks at 15 (prefer grep/glob)                                                                                                                                                                                                   |
| Marker parsing         | `GATE:` / `VERDICT:` markers are parsed from task results and child-session text, deduped per task; marker-less outputs from marker-contracted agents (test-runner/reviewer/plan-reviewer) are journaled                                                                          |
| Trace                  | JSONL journal of dispatches, gate transitions, verdicts, blocked calls, bash commands, errors                                                                                                                                                                                     |
| Decoding clamps        | executor/test-runner/debugger temperature ≤ 0.2; reviewer and plan-reviewer temperature = 0                                                                                                                                                                                       |
| Compaction             | Injects a "preserve verbatim" instruction for markers and findings                                                                                                                                                                                                                |

A new user prompt resets the session's gate state. Gate state survives
restarts via journal replay (last 2000 lines of `GATE: PASS` entries).

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
`.opencode/agents/` are the reference pipeline, not a requirement; the
gates key off agent names and markers, and other suites' agents can
carry their own markers.

Three properties matter for comparing enforcement layers, and all three
are visible in this repo's tests:

- Verifiable state. `GATE:` and `VERDICT:` markers are parsed from
  child session text (`src/markers.ts`), stored per parent session
  (`src/state.ts`), and replayed from the JSONL journal on restart, so
  gate state survives sessions and reloads rather than living in a
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
   OpenCode config's plugin array and restart. turnstile loads and
   enforces its gates, but neither the pipeline agent definitions nor the
   AGENTS.md contract block are installed:

   ```json
   { "plugins": ["opencode-turnstile"] }
   ```

2. **Full install via the CLI.** `npx opencode-turnstile init` installs
   the plugin, the pipeline agent definitions, and the managed contract
   block in `~/.config/opencode/AGENTS.md` (see
   [From a clone](#from-a-clone) below for the same commands run from
   a clone).

3. **Develop from a clone.** Clone this repo and run `npm run init`
   (symlink mode) so installed artifacts stay live against your edits.
   See [From a clone](#from-a-clone) below.

### No postinstall

Turnstile has **no** npm lifecycle hook (`postinstall`, etc.). Installing
`opencode-turnstile` as a dependency never writes to
`~/.config/opencode`; it only makes the gates available through the
plugin array. Everything else (agent definitions, the AGENTS.md contract
block) happens only when you run an explicit command. This is deliberate:
writes to your config directory are opt-in, not automatic.

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
`npm run init -- --copy` from a clone. The AGENTS.md contract block is
re-synced the same way, keeping only the managed block in step.

### Uninstall

`npx opencode-turnstile uninstall` reverses the install: it removes
ledger-owned copies and repo-owned symlinks and unmerges the managed
contract block from AGENTS.md. It is idempotent and ownership-aware:
files it never installed (untracked files, symlinks pointing outside the
repo) are left alone, and a second run is a clean no-op.

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

The six agent definitions in `.opencode/agents/` ship with `model:`
frontmatter pointing at the author's locally served models (`oMLX/...`).
You almost certainly do not have those models, and dispatches to the
pipeline agents will fail or fall back until you set your own.

Since installs share the repo's files (symlink mode) or conflict on
divergence (copy mode), set your models **in the clone**, not in
`~/.config/opencode/agents/`: edit the `model:` line of each agent file
(`planner`, `plan-reviewer`, `executor`, `test-runner`, `reviewer`,
`debugger`) to a model
you have, in `providerID/modelID` form, then install or re-sync per the
mode table above. Model overrides in installed copies are lost on the next
sync; the repo is the source of truth.

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
  `.opencode/agents/*.md` there; your installer serves your fork.

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
  actually installed; local `npm run ci` gates on it. GitHub CI runs
  `npm run ci:host`, the same chain without the install check, because a
  runner has no installs to check. Verify a copy install with
  `npm run install:check -- --copy`.

### Install the AGENTS.md contracts

Turnstile enforces what your instructions file declares. Install the
matching contract block into your global AGENTS.md:

```sh
node scripts/install-agents.mjs          # or: npm run install:agents
```

- Default target: `~/.config/opencode/AGENTS.md` (override with `--file`).
- The block is delimited by `<!-- turnstile:start -->` …
  `<!-- turnstile:end -->` sentinels; re-running updates only that block
  and preserves all surrounding personal content.
- Legacy targets are adopted automatically. If the file already contains
  pipeline-gates content _without_ sentinels (e.g. an install from before
  the block was managed), the installer classifies the existing section:
  equivalent to the template, it wraps the section in sentinels without
  changing its content; differing from the template, it backs the file up
  to `<name>.bak.<timestamp>` and replaces the section with the current
  block. Pass `--no-adopt` to refuse both and print reconciliation
  instructions instead.
- The installer refuses (exit 1, no write) only when a target is
  ambiguous (more than one turnstile section) or corrupted (a start
  sentinel without an end sentinel); reconcile those by hand.
- `--check` reports the outcome without writing: OK, or the adoption
  decision (would-adopt-equivalent / would-replace / drift), exiting 0
  only for OK. Useful in CI or dotfiles setup.
- Agent definitions and the plugin itself are installed separately via
  `npm run init` (symlinks, for development) or
  `npm run init -- --copy` (see the Install section above).

Alternatively, in an OpenCode session, invoke the bundled
`turnstile-setup` skill, which runs the installer and verifies marker
sync. The skill ships in the package and installs to
`~/.config/opencode/skills/turnstile-setup/SKILL.md`; the template
source lives at `templates/global-AGENTS.md`.

## Configuration

Defaults live in code (`src/config.ts`); override via
`~/.config/opencode/turnstile.json`, environment variables, or both.
Precedence: defaults < config file < env. The plugin reads config once, at
setup; restart sessions to apply. Invalid keys are ignored and journaled
(fail-open); a malformed config file never breaks the host.

| Key                                                                                                     | Default                                                                       | Meaning                                                           |
| ------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| `metricsDir`                                                                                            | `$XDG_DATA_HOME/opencode/metrics`, fallback `~/.local/share/opencode/metrics` | directory for both telemetry files                                |
| `journalMaxBytes`                                                                                       | 5242880                                                                       | rotate a journal file past this size                              |
| `journalMaxGenerations`                                                                                 | 5                                                                             | rotated generations kept per journal                              |
| `maxReviewerRounds`                                                                                     | 2                                                                             | reviewer dispatches per task without `GATE: PASS`                 |
| `readWarn` / `readBlock`                                                                                | 8 / 15                                                                        | whole-file read horizon                                           |
| `waiverMarker`                                                                                          | `USER WAIVER:`                                                                | literal waiver marker                                             |
| `plansDir`                                                                                              | `.opencode/plans`                                                             | executor decomposition scan directory                             |
| `trace`                                                                                                 | `true`                                                                        | write the human-readable trace file (JSONL journal always writes) |
| `agents.reviewer` / `agents.planReviewer` / `agents.executor` / `agents.testRunner` / `agents.debugger` | `reviewer` / `plan-reviewer` / `executor` / `test-runner` / `debugger`        | agent names recognized in dispatches                              |
| `agents.bareOutput`                                                                                     | `["test-runner", "reviewer", "plan-reviewer"]`                                | agents whose marker-less output is a violation                    |
| `gateMarker` / `verdictMarker`                                                                          | canonical regex sources                                                       | marker patterns, compiled with `gm`                               |

Environment variables (override the file):

- `TURNSTILE_TRACE=0|1`: disable/enable the trace file
- `TURNSTILE_METRICS_DIR=<dir>`: relocate the telemetry directory
- `TURNSTILE_CONFIG=<path>`: use a different config file

## Markers

Subagents must emit these as the first line of their output. These examples
are the canonical syntax; CI asserts the parser in `turnstile.ts` accepts
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

- Any text matching the gate marker, including a marker an agent
  hallucinated or copied from documentation, flips `hasGatePass`. An agent
  that wants a green gate can emit `GATE: PASS tests=1 passed=1 failed=0`
  without running anything.
- `USER WAIVER:` as a substring anywhere in a dispatch prompt unlocks the
  reviewer gate. A prompt-injected waiver is indistinguishable from a real
  one.
- `scripts/check-markers.mjs` guards against accidental drift between the
  parser and documented markers; it cannot guard against forgery, because
  the markers are plain prose by design.

Use OpenCode's permission and sandboxing mechanisms against hostile agents.
Treat turnstile's journal as the record of what was _claimed_, and treat the
journal itself as sensitive data (see SECURITY.md).

## Files and journals

- Journals live outside the repo in `~/.local/share/opencode/metrics/`:
  - `turnstile.jsonl`: full JSONL trace; rotates at 5 MB, keeps 5
    generations
  - `gate-events.jsonl`: human-readable
    `YYYY-MM-DD HH:MM | agent | event | detail` lines (suppressed entirely
    by `trace: false`)
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
