# AGENTS.md — turnstile

## Branching & releases (standing instruction — Ed, Oct 2026)

- `dev` is the default and the only primary development branch; it is
  GitHub-protected (required `ci` status check, no direct pushes). All work
  lands in `dev` via PR — never push directly, never commit to `main`.
- `main` is release-only. It is promoted exclusively by a `dev` → `main`
  PR that **Ed merges himself**. Do not merge anything into `main`, and do
  not click through a dev→main PR merge, unless Ed asks explicitly in the
  session.
- Keep local `main` as a read-only mirror of `origin/main`; branch feature
  work from `dev`.

## What this repo is

OpenCode v2 promise-plugin: `turnstile.ts` is the thin entry point the host
loads; behavior lives in focused modules under `src/`, one boundary per
file — the authoritative module map (every file + responsibility) is
`docs/architecture.md` §2; do not hand-copy it here.
It
mechanically enforces an agent pipeline (planner → plan-reviewer →
executor → test-runner → reviewer). The orchestrator policy is injected
into the parent session at runtime by the plugin (from `src/policy.ts`) —
primarily via the `session.context` channel, with the `execute.after` hook
as the fallback re-supply — rather than written to any instructions
file at install time; a fresh install can never lose it; per-agent
instruction lines live in each `agents/<name>.md`.
The plugin and pipeline subagent definitions are installed by
`npm run init` (symlinks by default, `--copy` for real copies; manifest:
`install.json`), making this repo the source of truth for
`~/.config/opencode/plugin(s)`, `~/.config/opencode/agents`, and
`~/.config/opencode/skills` (the vendored `turnstile-setup` and
`turnstile-suspend` skills).
The subagent definitions the pipeline dispatches (planner, plan-reviewer,
executor, test-runner, reviewer, debugger) ship as examples in
`agents/`;
`npm run init` links or copies them into `~/.config/opencode/agents/`;
the shipped definitions carry no `model:` frontmatter — subagents inherit
the dispatching session's model, and per-agent pins belong in
`~/.config/opencode/opencode.json` under `agents.<name>.model`; installs
never carry user state.
`--print-model-config` optionally prints a ready-to-paste `{"agents": {…}}`
model snippet (repeatable `--model [name=]provider/model[#variant]` seeds;
model ids may be multi-segment, e.g. `oMLX/oQ/GLM-5.3-Flash-oQ4-mtp`;
`--validate` checks concrete specs against `opencode models` and exits 1 on a
miss; `--model`/`--validate` given without `--print-model-config` exit 2) and
writes nothing — `install.mjs` prints the snippet and short-circuits before
any manifest work (see the README).
Verification tooling: ESLint + typescript-eslint (lint), Prettier
(format), `tsc` strict (typecheck), and `scripts/check-markers.mjs` (marker
drift). `npm test` enforces 100% line, branch, and function coverage over
`src/` + `turnstile.ts` via node:test's built-in V8 coverage thresholds
(100 for lines, branches, and functions) with `--experimental-test-isolation=none` — fully
deterministic on a green suite: a red branch report is a real
never-executed decision, never a merge artifact — the installer scripts
(`bin/`, `scripts/`) are outside the gate:

```
npm run ci           # ci:host (lint -> format:check -> typecheck -> check:markers -> test) — host chain only
npm run ci:installed # install:check — install-drift, run after npm run init
```

## Coding practices

These rules are enforced on every change, not aspirational. A review that
spots a violation rejects the change or refactors it in the same change set —
"cleanup later" is not an option.

### Functional design (function size cap)

Functions should be small, focused, and easy to understand. Hard guideline:
**a function is at most 20–30 lines** (clean-code best practice; the tighter
20 is the target, 30 is the ceiling before a refactor is mandatory). If a
function exceeds it, break it down by the concerns inside it — extraction is
not optional past the ceiling. A function that needs a comment to explain its
structure is already too big. (In this repo, behavior already splits one
concern per file under `src/`; keep new logic in the boundary that owns it,
not in `turnstile.ts`, which stays a thin entry point.)

### DRY (don't repeat yourself)

No duplicated logic. The same decision, rule, constant, or transformation
lives in exactly one place; a second occurrence of non-trivial logic is a
defect, not a shortcut. Concretely in this repo:

- A value already derived in one boundary is passed in, not recomputed in
  another (e.g. a computed path or count is threaded as a parameter, not
  rebuilt at each call site).
- Marker syntax, config defaults, and policy text each have one canonical
  source (`src/markers.ts`, `src/config.ts`, `src/policy.ts`); anything that
  needs them imports or is checked against the source by
  `scripts/check-markers.mjs` — never copy them by hand.
- When a repeated block appears a third time, extract it in the same change
  set that added it. A comment like "keep these in sync" marks a DRY
  violation to fix, not a convention to follow.

### Architectural alignment (SOLID)

Follow SOLID principles. Each module or component should have a single,
well-defined responsibility. Avoid tight coupling between modules. (The
`src/` boundaries are the architecture: `gates.ts` decides, `markers.ts`
parses, `state.ts` remembers, `ledger.ts` persists and evicts, `journal.ts`
persists, the `hooks-*` modules carry the per-surface hook bodies, and
`setup.ts` wires.
Dependencies flow one way; no cycles. New behavior extends existing
boundaries through their exported interfaces — a boundary is never reached
into or bypassed to avoid touching its API.)

### Security

- Never store secrets in code
- Validate all user input
- Use parameterized queries for database operations
- Keep dependencies updated

### Performance awareness

Write efficient code by default. Profile before optimizing. Avoid premature
optimization but be mindful of algorithmic complexity.

### Testing

Write tests for critical paths and complex logic. Aim for high test coverage
on business logic. Use descriptive test names that explain the expected
behavior. All tests should have docstrings too. (The gate state machine in `src/state.ts` and `src/markers.ts` is
the critical path; the harness is `node:test` with
`--experimental-strip-types --experimental-test-isolation=none`, wired into `npm run ci`.
Coverage is enforced at 100% lines, branches, and functions over `src/` +
`turnstile.ts` by the same command — a coverage extension is not needed, the
Node test runner's built-in thresholds gate it, and with `--experimental-test-isolation=none`
a green suite is deterministic: a red branch report is a real
never-executed decision, never a merge artifact. `bin/` and `scripts/` sit
outside the gate.)

### Error handling

Handle errors explicitly and provide meaningful error messages. Log errors
appropriately without exposing sensitive information to users. (This repo's
contract: fail open; journal internal errors, never throw from hooks except
the deliberate `BLOCKED by turnstile:` enforcement messages.)

### Intentional commenting

Write comments only when necessary. Code should be self-explanatory through
clear naming and structure. Comments should explain "why" not "what".
(All functions carry Google-standard JSDoc with fully typed parameters and
returns; the doc comment atop `turnstile.ts` is a contract-level summary
pointing at `docs/architecture.md`, the authoritative detailed reference.)

Comments and docstrings must be self-contained: a reader without the plan,
the issue, or this session's context must still understand them. Never
reference chunks, acceptance criteria, plan files, or issue numbers in
source comments, docstrings, or test titles — those citations belong in the
plan file and the commit message, not the code.

### Naming conventions

Use descriptive, self-documenting names for variables, functions, and
classes. Follow language-specific conventions (camelCase for TypeScript).

### Formatting

Follow language-specific formatting standards. Use consistent indentation
and spacing. (Enforced mechanically by Prettier, `npm run format`, except
the marker regex literals in `src/markers.ts`, which are `prettier-ignore`d
because `scripts/check-markers.mjs` extracts them as single lines.)

### Dependencies

Minimize the use of external dependencies. Only add dependencies that are
absolutely necessary for the project. (Zero runtime dependencies is a
stated feature; devDependencies are tooling only.)

## Plugin contract (do not break silently)

- Module shape: default export `{ id: "turnstile", server, setup }`. `id`
  must stay `"turnstile"`. `server` is a legacy v1 shim kept only for loaders
  that require it; the factory is exported as `turnstile`.
- `src/` and `tests/` must stay erasable TypeScript (no enums, namespaces,
  parameter properties); the test harness runs the real source through
  `node --experimental-strip-types`.
- Host API is the v2 shape
  `{ tool.hook, session.hook, permission.hook, event.subscribe }`, verified
  against opencode v2.0.22. If hooks don't fire, check the host version before
  assuming a logic bug.
- `docs/architecture.md` is the authoritative reference for enforced
  contracts; the doc comment atop `turnstile.ts` is a contract-level
  summary that points at it, and its module list must track `src/`.

## Enforcement behavior (easy to regress)

- Fail-open by design: every hook body is guarded; internal errors are
  journaled, never block tool calls. Only deliberate `BLOCKED by turnstile:`
  errors throw. Keep that distinction when editing hooks.
- Journal replay: `GATE: PASS` entries from `~/.local/share/opencode/metrics/turnstile.jsonl`
  and the per-session `sessions/<parentID>.jsonl` sinks restore gate state on
  restart (the newest `replayTailLines` lines, default
  2000, walked across journal generations newest-first and merged
  ts-ordered across sinks), and plan-reviewer
  `VERDICT: APPROVE` entries restore the plan-approval gate the same way.
  A new user prompt resets the session's gate state, unless
  `continuationCarry` re-arms the one-prompt grace for a same-worktree/branch
  continuation carrying earned credit (a journaled `GATE: PASS` or a credited
  reviewer `VERDICT: APPROVE`; a retired plan-bound task whose review was
  interrupted mid-flight — green gate, ≥1 counted reviewer dispatch or a
  waived reviewer round, no credited approval — carries the same way,
  journaled as a `recovery: true` continuation row); replay-time
  `refusedApprove:true` last-wins
  suppression still outranks the carried approval.
- Marker regexes (`GATE: PASS|FAIL tests=…`, `VERDICT: APPROVE|BLOCK …`) are
  parsed from task results and child-session text. Changing marker syntax
  requires updating both the regexes here and the marker examples in the
  validated sources — README.md, `docs/usage.md`, `agents/*.md`, and
  `src/policy.ts` — checked together by `scripts/check-markers.mjs`.
- The read-counter keys off the parent session (`childToParent` map); state
  is per parent, not per child subagent session.
- Shipped agent definitions (`agents/*.md`) must treat configured values as
  defaults, not constants: where a definition names a path that maps to a
  config key (`.opencode/plans/` → `plansDir`), the surrounding instruction
  must say to honor a path given in the dispatch prompt and name the
  config key so a customized setup doesn't strand the agent. Frontmatter
  permission rules that mirror a default (planner's `.opencode/plans/**`
  allow) carry a comment stating they must be updated when the key changes.
  `.opencode/knowledge/` is exempt — it is a repo-local convention, not a
  turnstile config key. When a config default changes, check `agents/*.md`
  phrasing in the same change set.

## Operational notes

- Journals live outside the repo at `~/.local/share/opencode/metrics/`
  (`turnstile.jsonl` and each `sessions/<parentID>.jsonl` rotate at 5 MB,
  5 generations per file). Retention is bounded:
  2 files × (1 current + 5 generations) × 5 MB ≈ ~30 MB per journal, worst
  case ~60 MB total, plus one bounded sink per live parent session. With
  `trace: false` the trace file is never written,
  roughly halving that; the JSONL journal is the audit trail and always
  writes.
- Executor dispatch blocking scans `.opencode/plans/*.md` in the project dir
  for `## Decomposition`; plans there are load-bearing, not scratch files.
- `CONTRIBUTING.md` is the contributor-facing summary of the rules in this
  file (dev loop, marker-drift source set, erasable TS, fail-open,
  dependencies, architecture-docs sync). When a rule here changes, update
  CONTRIBUTING.md in the same change set; if a rule lives only here, leave
  CONTRIBUTING.md pointing at this file rather than duplicating it.
- `npm test` is the sole coverage authority. `scripts/branch-coverage.mjs` is
  diagnostic-only — it localizes what `npm test` already flagged (file:line +
  snippet); never loop on its output, never treat its findings as a work
  queue. `test:stable`-style retry aliases are forbidden by design: the gate is
  deterministic, so a red run is a real gap.

## Architecture docs (keep in sync when code changes)

`docs/architecture.md` (with `docs/images/*.svg` rendered from
`docs/diagrams/*.d2`) is the living architecture reference for new users and
devs. It is not a snapshot: when a change alters what the diagrams or
document describe, update them in the same change set — not as a follow-up.

- **Trigger for updates** — touch the docs when a change affects any of:
  - the module map: new/renamed/removed files under `src/`, or changed
    dependency direction between boundaries;
  - the hook surface: hooks registered in `src/setup.ts` (session, tool,
    permission, event types handled), or what fires on each hook;
  - enforcement: gates added/removed/renamed, `GateState` fields, block
    reasons, caps/budgets/defaults, marker semantics;
  - persistence: journal entry types, replay behavior, rotation, the
    `opencode-turnstile status` output;
  - configuration: keys, defaults, validation, or the layered resolution.
    Refactors that move code without changing behavior (renames aside) don't
    require doc edits.
- **How to update** — edit the D2 source in `docs/diagrams/` (not the SVG),
  re-render the matching image, and update `docs/architecture.md` prose/tables
  to match:

  ```sh
  d2 --theme 200 docs/diagrams/d01-modules.d2 docs/images/d01-modules.svg
  ```

  Commit the source, the rendered SVG, and the doc together. Keep the
  diagram identities stable: `d01-modules` (module map), `d02-hooks` (hook
  surface), `d03-task-flow` (end-to-end sequence), `d04-gate-state` (state
  machine), `d05-persistence` (journal/replay). Add a new numbered diagram
  rather than overloading an existing one. The README hero banner
  (`docs/images/hero.svg`) is the exception: it is hand-authored SVG with no
  D2 source — edit the SVG directly (keep it valid XML, dark theme, wide
  aspect), and update it whenever enforcement points change.

- **Same accuracy bar as code** — diagrams cite real function/hook/field
  names; if a name in a diagram no longer exists in source, that's a bug in
  the docs. The doc's claims are verified against source the same way test
  expectations are.
- **CONTRIBUTING.md stays aligned too** — it mirrors the repo rules in
  short form (dev loop, marker-drift source set, architecture-docs rule).
  When a change above makes CONTRIBUTING.md's claims stale — the CI chain
  composition, the set of marker-validated sources, or the docs-sync rule —
  update it in the same change set. CONTRIBUTING.md defers detail to this
  file; keep it a summary, not a second source of truth.
- **`examples/turnstile.example.json` mirrors `defaultConfig()`** — the
  example carries every key from the defaults in `src/config.ts` verbatim,
  with exactly one deliberate omission (`metricsDir`, computed at load
  time). When a default value, key, or sub-block (`agents`, `toolPolicy`,
  `gitGates`) changes in `defaultConfig()`, update the example in the same
  change set, including the marker regex sources when `GATE_RE` /
  `VERDICT_RE` change. The README documents the example as matching the
  code defaults, so a stale example is a documented-behavior bug, not just
  a stale snippet.
