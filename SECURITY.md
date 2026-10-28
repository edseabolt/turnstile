# Security Policy

## What turnstile is and is not

Turnstile is a speed bump and audit trail, not a security boundary. It
enforces process discipline over cooperative agents; it cannot constrain a
determined or hostile agent:

- Gate markers (`GATE: PASS tests=…`, `VERDICT: …`) are parsed from plain
  text. A marker emitted by a genuine contracted agent is trusted as to
  veracity — a hallucinated `GATE: PASS` from the real test-runner flips gate
  state (under the default `gateEvidence:enforce` a PASS additionally needs a
  correlating exit-0 test execution). Text from other sources — quoted,
  echoed, streamed by the wrong agent, or from an unattributed session —
  never flips state; it is journaled `suppressed`.
- The waiver and approval markers (`USER WAIVER:`, `PLAN APPROVED:`) are read
  only from the user's own prompt at admission — a marker inside an
  agent-composed dispatch prompt unlocks nothing, and a prompt-channel
  `PLAN APPROVED:` is honored exactly like a plan-reviewer verdict. The
  approval path via OpenCode's permission prompt is host-side UI, unreachable
  from session text. The dispatch-prompt waiver-forgery vector is closed; the
  residual trust stance (the journal is still the record of what was claimed)
  is unchanged.
- `scripts/check-markers.mjs` guards against accidental drift, not forgery.

Against hostile agents, use OpenCode's permission and sandboxing
mechanisms. Turnstile's value is the journal: it records what was claimed,
blocked, and waived.

## Attack surface: the journal

The plugin writes telemetry outside the repo at
`~/.local/share/opencode/metrics/` (or `$XDG_DATA_HOME/opencode/metrics`):

- `turnstile.jsonl`: dispatch descriptions, gate/verdict markers, bash
  command text (up to 500 chars, only when `trace` is enabled — otherwise
  journaled as `"<redacted>"`), read counts, errors
- `gate-events.jsonl`: human-readable event lines

Both files default to world-readable permissions implied by the directory
(0755/0644). Bash commands and dispatch descriptions can contain secrets,
hostnames, and paths. Retention is bounded at ~30 MB per journal
(1 current + 5 rotated generations × 5 MB), ~60 MB worst case across the
two files. `gate-events.jsonl` only exists while `trace: true` (the
default) and rotates on the same bounds, so `trace: false` roughly halves
the footprint.

Setting `trace: false` (or `TURNSTILE_TRACE=0`) suppresses the
human-readable trace file entirely and redacts bash command text
(`"<redacted>"`), dispatch descriptions (`""`), and waiver quotes
(`"<present>"`) from the JSONL journal. The JSONL journal itself always
writes; it is the audit trail.

If the journal contents are sensitive in your environment, protect the
metrics directory (e.g. user-only permissions) or point `metricsDir` at an
encrypted location.

The read side treats the journal as untrusted data, not a trust root: boot
replay shape-validates every line before applying it — session IDs failing
the ID-shape check are dropped and never become state keys, out-of-range
ensemble counts clamp, and plan identity fields that fail shape degrade to
unbound so the existing staleness validation applies. Each dropped line is
journaled as a replay-inert `suppressed` audit entry, so a hostile append is
observable. A single appended line can no longer mint a session bucket or
flip a restored gate. Protecting the metrics directory above remains the
actual boundary against a local writer.

## The published summary

`opencode-turnstile evidence` is the only path by which journal-derived data
is meant to leave the machine, and it is a whitelist projection, not an
excerpt: the document is assembled from permitted keys (derived counts,
canonical `GATE:`/`VERDICT:` marker lines, a one-way task handle, and the
sha256 of the most recent journaled line), so the fields above — session
paths and IDs, bash command text, dispatch descriptions — are absent by
construction rather than redacted after the fact. `evidence --validate`
re-asserts that in CI, rejecting any artifact carrying a session-ID-shaped or
path-shaped value.

What it cannot do is make the claim true. The summary reports what the journal
_claims_, in the same terms as the threat model above: a correlated claim, not
proof. It carries the journal head sha precisely so a reader can ask the
author for the raw journal and check the excerpt's tail.

## Reporting a vulnerability

Open a private GitHub security advisory on this repository. Do not open a
public issue for exploitable findings.
