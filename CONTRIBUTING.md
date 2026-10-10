# Contributing to turnstile

## Dev loop

```sh
npm install
npm run ci   # ci:host (lint, format:check, typecheck, check:markers, test) + install:check
```

- `npm run lint`: ESLint (flat config, `eslint.config.mjs`)
- `npm run format` / `format:check`: Prettier (`.prettierrc.json`)
- `npm run typecheck`: `tsc --noEmit`, strict
- `npm run check:markers`: marker-drift guard (see below)
- `npm test`: `node --test --experimental-strip-types tests/*.test.ts`

The test suite requires Node ≥ 22.6 (`--experimental-strip-types`); the
plugin runtime itself is Node ≥ 18.

## Repo rules

1. **Marker drift:** the regex literals in `src/markers.ts` and the marker
   examples in `README.md` are synced by `scripts/check-markers.mjs`, which
   extracts the literals by name and asserts the README examples parse.
   Edit both sides together; `prettier-ignore` comments on the literals
   keep them single-line so the extraction keeps working.
2. **Erasable TypeScript only:** `src/` and `tests/` must stay erasable TS
   (no enums, namespaces, or parameter properties): the test harness runs
   the real source through `node --experimental-strip-types`.
3. **Verified host shape:** the plugin targets the OpenCode v2
   promise-plugin shape (`{ tool.hook, session.hook, event.subscribe }`),
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

## Tests

Tests live in `tests/` and run the real plugin source against a fake host
(`tests/helpers.ts`) with injected temp `metricsDir`; no test writes to
the real metrics directory. When changing behavior, update the goldens in
`tests/default-golden.test.ts` deliberately: they pin journal entry shapes,
trace format, and the exact block messages.

## Commit style

Conventional messages (`feat:`, `fix:`, `refactor:`, `docs:`, `chore:`).
Keep each commit green under `npm run ci`.
