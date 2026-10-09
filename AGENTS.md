# AGENTS.md — turnstile

## What this repo is

OpenCode v2 promise-plugin: `turnstile.ts` is the thin entry point the host
loads; behavior lives in focused modules under `src/`, one boundary per
file (`types`, `config`, `journal`, `state`, `markers`, `gates`, `setup`). It
mechanically enforces an agent pipeline (planner → executor →
test-runner → reviewer) defined in the host's instructions file; install
the matching contract block with the bundled skill or
`node scripts/install-agents.mjs` (see `templates/global-AGENTS.md`).
The plugin and pipeline subagent definitions are installed by
`npm run install` (symlinks by default, `--copy` for real copies; manifest:
`install.json`), making this repo the source of truth for
`~/.config/opencode/plugin(s)` and `~/.config/opencode/agents`.
The subagent definitions the pipeline dispatches (planner, executor,
test-runner, reviewer, debugger) ship as examples in `.opencode/agents/`;
`npm run install` links or copies them into `~/.config/opencode/agents/`;
adjust the `model:` frontmatter in the repo files, since installs share it.
Verification tooling: ESLint + typescript-eslint (lint), Prettier
(format), `tsc` strict (typecheck), and `scripts/check-markers.mjs` (marker
drift), all chained in `npm run ci`:

```
npm run ci   # lint -> format:check -> typecheck -> check:markers -> test
```

## Coding practices

### Functional design

Functions should be small, focused, and easy to understand. Avoid complex
logic in single functions. If a function exceeds 20 lines, consider breaking
it down. (In this repo, behavior already splits one concern per file under
`src/`; keep new logic in the boundary that owns it, not in `turnstile.ts`,
which stays a thin entry point.)

### Architectural alignment

Follow SOLID principles. Each module or component should have a single,
well-defined responsibility. Avoid tight coupling between modules. (The
`src/` boundaries are the architecture: `gates.ts` decides, `markers.ts`
parses, `state.ts` remembers, `journal.ts` persists, `setup.ts` wires.
Dependencies flow one way; no cycles.)

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
the critical path; the planned harness is `node:test` with
`--experimental-strip-types`, wired into `npm run ci`.)

### Error handling

Handle errors explicitly and provide meaningful error messages. Log errors
appropriately without exposing sensitive information to users. (This repo's
contract: fail open; journal internal errors, never throw from hooks except
the deliberate `BLOCKED by turnstile:` enforcement messages.)

### Intentional commenting

Write comments only when necessary. Code should be self-explanatory through
clear naming and structure. Comments should explain "why" not "what".
(All functions carry Google-standard JSDoc with fully typed parameters and
returns; the doc comment atop `turnstile.ts` documents contracts, not
implementation.)

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
- Host API is the v2 shape `{ tool.hook, session.hook, event.subscribe }`,
  verified against opencode v2.0.22. If hooks don't fire, check the host
  version before assuming a logic bug.
- The doc comment at the top of `turnstile.ts` is the authoritative summary
  of enforced contracts. Update it whenever enforcement behavior changes.

## Enforcement behavior (easy to regress)

- Fail-open by design: every hook body is guarded; internal errors are
  journaled, never block tool calls. Only deliberate `BLOCKED by turnstile:`
  errors throw. Keep that distinction when editing hooks.
- Journal replay: `GATE: PASS` entries from `~/.local/share/opencode/metrics/turnstile.jsonl`
  restore gate state on restart (last 2000 lines). A new user prompt resets
  the session's gate state.
- Marker regexes (`GATE: PASS|FAIL tests=…`, `VERDICT: APPROVE|BLOCK …`) are
  parsed from task results and child-session text. Changing marker syntax
  requires updating both the regexes here and the global AGENTS.md contracts.
- The read-counter keys off the parent session (`childToParent` map); state
  is per parent, not per child subagent session.

## Operational notes

- Journals live outside the repo at `~/.local/share/opencode/metrics/`
  (`turnstile.jsonl` rotates at 5 MB, 5 generations). Retention is bounded:
  2 files × (1 current + 5 generations) × 5 MB ≈ ~30 MB per journal, worst
  case ~60 MB total. With `trace: false` the trace file is never written,
  roughly halving that; the JSONL journal is the audit trail and always
  writes.
- Executor dispatch blocking scans `.opencode/plans/*.md` in the project dir
  for `## Decomposition`; plans there are load-bearing, not scratch files.
