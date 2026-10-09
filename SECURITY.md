# Security Policy

## What turnstile is and is not

Turnstile is a speed bump and audit trail, not a security boundary. It
enforces process discipline over cooperative agents; it cannot constrain a
determined or hostile agent:

- Gate markers (`GATE: PASS tests=…`, `VERDICT: …`) are parsed from plain
  text. Any text matching the pattern flips gate state, including forged or
  hallucinated markers.
- The waiver marker (`USER WAIVER:`) is a substring check on dispatch
  prompts; injected text unlocks the gate just like a real waiver.
- `scripts/check-markers.mjs` guards against accidental drift, not forgery.

Against hostile agents, use OpenCode's permission and sandboxing
mechanisms. Turnstile's value is the journal: a verifiable record of what
was claimed, blocked, and waived.

## Attack surface: the journal

The plugin writes telemetry outside the repo at
`~/.local/share/opencode/metrics/` (or `$XDG_DATA_HOME/opencode/metrics`):

- `turnstile.jsonl`: dispatch descriptions, gate/verdict markers, bash
  command text (up to 500 chars), read counts, errors
- `gate-events.jsonl`: human-readable event lines

Both files default to world-readable permissions implied by the directory
(0755/0644). Bash commands and dispatch descriptions can contain secrets,
hostnames, and paths. Retention is bounded at ~30 MB per journal
(1 current + 5 rotated generations × 5 MB), ~60 MB worst case.

Setting `trace: false` (or `TURNSTILE_TRACE=0`) suppresses the
human-readable trace file entirely and redacts bash command text
(`"<redacted>"`), dispatch descriptions (`""`), and waiver quotes
(`"<present>"`) from the JSONL journal. The JSONL journal itself always
writes; it is the audit trail.

If the journal contents are sensitive in your environment, protect the
metrics directory (e.g. user-only permissions) or point `metricsDir` at an
encrypted location.

## Reporting a vulnerability

Open a private GitHub security advisory on this repository. Do not open a
public issue for exploitable findings.
