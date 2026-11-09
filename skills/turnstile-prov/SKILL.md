---
name: turnstile-prov
description: Report the decisions recorded in the turnstile decision ledger (human prompts journaled as prov:stated, human permission denials as prov:denied, and human gate waivers as prov:waiver) via the turnstile CLI. Use when the user asks what decisions were made, to see the decision ledger or provenance record, or to review human judgment captured during a session.
---

# Turnstile prov

Report the decisions made, from the turnstile decision ledger. Read-only —
never modify config or journals from this skill.

## Steps

1. Detect context: inside the turnstile repo use `node bin/cli.mjs prov`;
   elsewhere `npx opencode-turnstile prov`. It walks the shared journal and
   the session sinks and prints `prov:*` rows oldest-first; it handles
   missing/rotated files and exits 0 with no output on an empty ledger.
2. Scope: with no sessionID the ledger covers every session. When the user
   asks about a specific session or time range, pass the sessionID, and
   default to `--tail 200` so the report stays readable; otherwise default
   to `--tail 50`. If the user names other options (e.g. `--tail 100`,
   `--json`), forward them verbatim to the invocation; if the CLI rejects
   one, surface the usage error verbatim — never retry blind, never drop
   the flag.
3. Report the decisions, grouped per session and in order:
   - `prov:stated` — a human prompt: quote the redacted text, but skip rows
     that are pure pipeline chatter ("continue", bare acknowledgements)
     unless the user asked for the unfiltered record — the raw row is the
     source of truth, so note how many were skipped.
   - `prov:denied` — a human permission denial: report the ask kind
     (plan / landing / hands-on) as a decision the human made.
   - `prov:waiver` — a human gate waiver: report the covered stages.
4. Summarize what the record shows about judgment in the loop: what the
   human directed, what they refused, and any gap (e.g. a session missing
   from the ledger) — but do not editorialize beyond what the rows say.
   Prompt text is already secret-redacted at capture; never attempt to
   un-redact or infer redacted content.
