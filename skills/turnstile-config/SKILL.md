---
name: turnstile-config
description: Show the user's resolved turnstile configuration — which keys are overridden vs default, the computed metricsDir, and any config warnings — without editing anything. Use when the user asks what their turnstile config is or why a setting behaves the way it does.
---

# Turnstile config

Display the user's turnstile configuration read-only. Never apply edits —
point at `examples/turnstile.example.json` (every key except the computed
`metricsDir`) and the config table in `docs/usage.md` §4 instead.

## Steps

1. Locate the raw config file: the `TURNSTILE_CONFIG` env var if set, else
   `~/.config/opencode/turnstile.json`. If the file is absent, report "no
   config file (all defaults in effect)".

2. Cross-check the resolved values against `status --json` (detect context:
   inside the turnstile repo use `node bin/cli.mjs status --json`; elsewhere
   `npx opencode-turnstile status --json`) — its `suspension.configPath` and
   `suspension.configFilePresent` confirm which file the CLI consulted.

3. Compare the raw overrides against the defaults table (docs/usage.md §4)
   and mark each key as overridden or default.

4. Report `metricsDir` as computed at load time — it is deliberately absent
   from `examples/turnstile.example.json`.

5. Surface any `[turnstile] config:` invalid-key warnings from the journal
   if present.

6. If the user names any status options, forward them to the CLI invocation.
   If the CLI rejects an option, surface the usage error verbatim; never
   retry blind, never drop the flag.
