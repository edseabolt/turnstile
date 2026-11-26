# Security posture and limits

Turnstile is a speed bump and an audit trail, not a security boundary.

- Any text matching the gate marker (including a marker an agent
  hallucinated or copied from documentation) is journaled `verified:false`
  under the default `gateEvidence:enforce` mode. It does not flip
  `hasGatePass` unless the current task's bash/shell executions contain a
  matching exit-0 test command (plausibility checked against
  `evidencePattern`; the default covers the canonical `npm run ci`
  verification chain). An agent that wants a green gate can no longer emit
  `GATE: PASS tests=1 passed=1 failed=0` without running anything. But
  `gateEvidence:flag` reverts to the historical flip-on-trust semantics
  (still stamped `verified:false`), and `gateEvidence:off` journals without
  the field at all.
- A `GATE: PASS` is only as trustworthy as the journal: an attacker who can
  write or replay the metrics directory can craft a `verified:true` entry,
  and `flag`/`off` make a fabricated marker trust-lossless. Tests that run
  outside the observable bash/shell surface (external CI, a differently
  named execution tool) leave enforce mode with no evidence to verify
  against; operators in that situation use `flag`/`off` at the cost of the
  guarantee. The journal records what was _claimed_, never proof.
- The dispatch-prompt waiver-forgery vector is closed: a `USER WAIVER:` (or
  `PLAN APPROVED:`) substring inside an agent-composed dispatch prompt
  unlocks nothing. Turnstile reads waivers and approvals only from the
  user's prompt at admission. The residual trust stance is unchanged: the
  journal is still the record of what was _claimed_ (an attacker who can
  write or replay the metrics directory can still craft entries), so the
  journal is treated as sensitive data (see SECURITY.md).
- `scripts/check-markers.mjs` guards against accidental drift between the
  parser and documented markers; it cannot guard against forgery, because
  the markers are plain prose by design.
- Which text surfaces can mint gate and verdict state is fixed by the
  channel-authority matrix below; a marker in any other surface is inert.
- The `bash`/`shell`/`write`/`edit` denylist is a deterrent, not a sandbox:
  it matches strings, so `bash -c "$X"`, script files, `eval` indirection,
  and values sourced from the environment still bypass it. A block names the
  matched _rule_ (never the raw command, per the redaction contract). A
  dropped or invalid regex _source_ means the operation it guarded is now
  **allowed** (documented so a config typo weakens the policy visibly in the
  journal rather than silently). Both denylists default to empty, so none of
  this applies unless rules are configured, but gaps remain by design.
  `git` **aliases** (e.g. `git co main`, `git cm -m x`) are not matched,
  because a rule names `git` plus a literal subcommand only; the wider base
  can _over-match_ (e.g. `git commit -m "… merge …"` trips the `merge`
  rule). Git/gh consent rides the host permission `ask` layer by default; a
  host `allow` never unblocks a configured turnstile deny, because the
  layers are complementary. `session_move` never blocks.
- MCP tools and other tool names not named in `execute.before` (`task`,
  `subagent`, `read`, `bash`, `shell`, `write`, `edit`, `session_move`) remain
  unguarded. Governing them is a follow-on, not part of this policy layer.

## Marker channel authority

Markers move state only when the channel and the emitter are both authorized.
The parser scans five channels; every other surface is invisible to marker
parsing and can never mint gate or verdict state.

| Channel                                      | Scanned | Who may mint `GATE:`   | Who may mint `VERDICT:`              |
| -------------------------------------------- | ------- | ---------------------- | ------------------------------------ |
| `task-result` (task/subagent delivery)       | yes     | configured test-runner | configured reviewer or plan-reviewer |
| `child-message` (streamed text part)         | yes     | configured test-runner | configured reviewer or plan-reviewer |
| `child-text` (streamed text end)             | yes     | configured test-runner | configured reviewer or plan-reviewer |
| `child-text-delta` (streamed window)         | yes     | configured test-runner | configured reviewer or plan-reviewer |
| `subagent-synthetic` (background completion) | yes     | configured test-runner | configured reviewer or plan-reviewer |
| User prompts                                 | never   | nobody                 | nobody                               |
| `read`/`bash`/`shell`/`write`/`edit` results | never   | nobody                 | nobody                               |
| MCP and other tool results, file contents    | never   | nobody                 | nobody                               |

The emitter check is the emitter-authority cache: the agent name resolved
from the dispatch input, the session-created event, or the delivery. An
unresolved name is denied (fail closed). A denied marker mutates no state,
registers its dedup key, and journals one `type:"suppressed"` row keyed on
the emitter with the denial reason (see `docs/journal/entry-types.md`).
Replay never restores state from a suppressed row.

Quoted markers are the residual exposure of the scanned channels: a
test-runner echoing a reviewer's `VERDICT: APPROVE` is denied because the
kind does not match the emitter's contract, and any marker inside a tool
result or file is never parsed at all. What the matrix cannot prevent is a
contracted emitter genuinely minting a marker its role owes; that is the
evidence layer's problem (`gateEvidence`), not the channel layer's.

Use OpenCode's permission and sandboxing mechanisms against hostile agents.
Treat turnstile's journal as the record of what was _claimed_, and treat the
journal itself as sensitive data (see SECURITY.md).

There is no audit-only mode: every configured rule blocks. The opt-outs
are per-feature config keys: `gitGates.commitMessages: false` disables
commit lint, `gitGates.landingGate: false` disables the landing gate, an
empty denylist leaves the tool policy idle, and `TURNSTILE OFF:` (the
suspend marker) suspends all blocking session-wide. Legacy configs that
still carry `toolPolicy.mode`, `gitGates.mode`, or `handsOnGate` have
those keys dropped with a surfaced warning at load; the enforcement stays
on.
