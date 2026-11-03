Show the recent turnstile JSONL journal. Delegate to the CLI:
`node bin/cli.mjs log` inside the repo, `npx opencode-turnstile log`
elsewhere — it tails both the shared journal and the current session's
sink, defaults the tail to the configured replay bound, and handles
missing/rotated files. Default to `--tail 50` unless the user says
otherwise; forward any arguments verbatim: `$ARGUMENTS` (e.g.
`--tail 100`, a sessionID, `--json`). Pretty-print entry types
(GATE / VERDICT / suspended / refused / recovery) and surface the CLI's
usage errors verbatim if an argument is rejected.
