Run the turnstile status CLI and present the result readably (gate state,
suspension, journal paths, replayed state). Detect context: inside the
turnstile repo use `node bin/cli.mjs status`; elsewhere
`npx opencode-turnstile status`. Forward any arguments the user supplied
verbatim, e.g. `$ARGUMENTS` (such as `--json` or `--check-updates`). If the
CLI prints a usage error, show it to the user — do not retry or drop flags.
