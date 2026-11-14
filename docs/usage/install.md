# Installing and maintaining

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
[Policy injection](../architecture/policy-injection.md).

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

The seven agent definitions in `agents/` ship **without** a `model:`
frontmatter key. Each subagent therefore runs on the model of the session
that dispatched it — OpenCode v2's documented inheritance rule — so there is
nothing to configure for the common case. The `--print-model-config`
printer covers the six pipeline-stage names; the requirements agent
inherits the dispatching session's model and needs no pin.

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
| `turnstile-evidence`   | Publish or inspect an evidence bundle (`evidence`, [status](status.md)).                                                         |
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
prompt that would be refused. A renamed marker (`suspendMarker` in the [configuration](configuration.md)
table) is picked up automatically because the value always comes from the
CLI, never from the skill text. All nine skills forward
any options you name to the CLI verbatim and surface usage errors instead
of retrying.
