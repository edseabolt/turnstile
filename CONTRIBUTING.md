# Contributing to turnstile

## Dev loop

```sh
npm install
npm run ci           # ci:host (lint, format:check, typecheck, check:markers, test) — host chain only; green on a fresh clone
npm run ci:installed # install:check — only after `npm run init` on a machine with installed artifacts
```

- `npm run lint`: ESLint (flat config, `eslint.config.mjs`)
- `npm run format` / `format:check`: Prettier (`.prettierrc.json`)
- `npm run typecheck`: `tsc --noEmit`, strict
- `npm run check:markers`: marker-drift guard (see below)
- `npm test`: `node --test --experimental-strip-types --experimental-test-isolation=none
tests/*.test.ts`, with 100% line/branch/function coverage enforced over
  `src/` + `turnstile.ts` via node:test's built-in thresholds — no coverage
  extension. `--experimental-test-isolation=none` makes a green suite deterministic, so a
  red branch report is a real never-executed decision, never a merge artifact.
  `npm test` is the sole coverage authority — `scripts/branch-coverage.mjs` is
  a diagnostic, never a work queue. `bin/` and `scripts/` sit outside the gate.

The test suite requires Node ≥ 22.8 (`--experimental-test-isolation` shipped in v22.8.0;
`--experimental-strip-types` predates it); the package declares
`engines: { "node": ">=22.8" }`, so the runtime floor matches the test-suite
floor even though `src/`, `bin/`, and `scripts/` use no API newer than
Node 18.

## Repo rules

1. **Marker drift:** the regex literals in `src/markers.ts` and the marker
   examples in `README.md`, `agents/*.md`, and the policy templates in
   `src/policy.ts` are synced by `scripts/check-markers.mjs`, which extracts
   the literals by name and asserts every example parses.
   Edit all sides together; `prettier-ignore` comments on the literals
   keep them single-line so the extraction keeps working.
2. **Erasable TypeScript only:** `src/` and `tests/` must stay erasable TS
   (no enums, namespaces, or parameter properties): the test harness runs
   the real source through `node --experimental-strip-types`.
3. **Verified host shape:** the plugin targets the OpenCode v2
   promise-plugin shape (`{ tool.hook, session.hook, permission.hook,
event.subscribe }` — permission registered when the host exposes it),
   verified against opencode v2.0.22. Do not assume hooks, events, or
   payload fields not already handled in `src/types.ts` without verifying
   them against a real host.
4. **Fail-open contract:** hook bodies are guarded; internal errors are
   journaled and the tool call proceeds. The only deliberate throws are
   `BlockError` instances with the `BLOCKED by turnstile:` prefix. New
   enforcement paths must follow this.
5. **Config:** defaults live in `src/config.ts`; invalid keys are ignored
   and journaled, never thrown. With no config file and no env vars,
   behavior must be identical to the documented defaults.
6. **Dependencies:** zero runtime dependencies is a stated feature;
   devDependencies are tooling only.
7. **Shipped scripts are dependency-free:** `scripts/*.mjs` and `bin/cli.mjs`
   import only `node:` builtins; they run from `npx opencode-turnstile`
   without a repo clone. Do not add imports beyond Node builtins, and keep
   the publish artifact aligned with `package.json` `files` (verify with
   `npm run pack:dry`).
8. **Shipped agent definitions treat config values as defaults, not
   constants:** where `agents/*.md` names a path backed by a config key
   (`.opencode/plans/` → `plansDir`), the instruction defers to a path given
   in the dispatch prompt and names the key. See the "Enforcement behavior"
   section of AGENTS.md; when a config default changes, check
   `agents/*.md` in the same change set.
9. **Architecture docs stay in sync:** `docs/architecture.md` (with
   `docs/images/*.svg` rendered from `docs/diagrams/*.d2`) is the living
   architecture reference. When a change alters what it describes — module
   map, hook surface, gates/`GateState`, journal/replay, config surface —
   update the D2 source (never the SVG), re-render with
   `d2 --theme 200 <docs/diagrams/X.d2> <docs/images/X.svg>`, update the
   prose, and commit source + SVG + doc in the same change set. Diagrams
   cite real function/hook/field names; a stale name is a docs bug. See the
   "Architecture docs" section of AGENTS.md for the full trigger list.

## Tests

Tests live in `tests/` and run the real plugin source against a fake host
(`tests/helpers.ts`) with injected temp `metricsDir`; no test writes to
the real metrics directory. When changing behavior, update the goldens in
`tests/default-golden.test.ts` deliberately: they pin journal entry shapes,
trace format, and the exact block messages.

## Commit style

Conventional messages (`feat:`, `fix:`, `refactor:`, `docs:`, `chore:`).
Keep each commit green under `npm run ci`.

## Dogfooding

Turnstile is developed with turnstile: feature work on this repo is expected
to run through the plugin's own pipeline (planner → plan-reviewer → executor
→ test-runner → reviewer) with the gates and journal on, and to land via the
same evidence rules it enforces on users. Hand-edits are fine for docs,
formatting, and trivial fixes; if a change skips the pipeline, say so in the
commit body. See the "Turnstile is built with turnstile" paragraph in the
README for what the journal shows about this in practice.

That includes published evidence: `.github/workflows/turnstile-evidence.yml`
is a copy of `examples/turnstile-evidence.yml` with one substitution
(`node scripts/evidence.mjs` instead of the published CLI, so the tree
validates itself). Edit the example and re-copy it in the same change set;
drift between the two is drift in what consumers install.
