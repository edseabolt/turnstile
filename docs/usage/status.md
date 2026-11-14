# Status

`opencode-turnstile status` reports turnstile gate and plan state per parent
session, read from the journal, as a human-readable table by default or JSON
with `--json`:

```
opencode-turnstile status
opencode-turnstile status --json
opencode-turnstile status --check-updates
```

It is read-only: it never writes to the journal or config. The one write it
can make is `--check-updates`' cache file (`<metricsDir>/update-check.json`,
24h TTL) — an opt-in npm lookup for a newer turnstile, failures never cached.
Per session it
replays the same gate/plan last-wins rules the runtime uses (a trailing
`GATE: FAIL` keeps the gate red; a `verified:false` PASS never
flips), plus last markers, waiver events (with channel; the reviewer gate's
WAIVED entry also carries a scope in the journal, which status does not
currently render), and dispatch/block/permission counts. Blocked dispatches are
journaled with a `reason` (`round-limit`, `loop-cap`, `dispatch-budget`, …)
and every loop-cap exhaustion additionally writes a paired `escalation`
entry, so a stuck pipeline leaves a visible trail in the journal. Blocked
entries — including `loop-cap` and `dispatch-budget` reasons — are counted
in the BLK column, but status does not yet break them out by reason, and it
does not parse or render the paired `escalation` entries — that is a
documented gap, not a silence: the entries are written, they are just not
rendered by status yet. The journal reflects the last prompt-cycle;
in-memory state can be fresher (a session that has prompted since is newer
than the journal records), so treat status as the durable state of the
previous cycle rather than a live snapshot. The `--json` document also
carries a top-level `suspension` block (the resolved `allowSuspend`,
`suspendMarker`/`resumeMarker`, config path, and file presence) — the
surface the `turnstile-off`/`turnstile-on` skills read ([install](install.md)).

### Sharing the evidence

`opencode-turnstile evidence` is the sharing half of the same read-only view:
where `status` answers "what is this session's state right now", `evidence`
answers "what did this task earn, in a form I can publish". It folds the same
replay-parity window with the same shape checks, then emits only derived
counts, canonical marker lines, and shas — session IDs, prompts, dispatch
descriptions, and bash command text are absent by construction, because the
document is built key by key rather than filtered. A task is named by a
one-way handle (`t-<8 hex>`), the journal by its head sha. `--format markdown`
renders the sticky-comment body; `--out` writes `<name>.json` and the sibling
`<name>.md`; `--validate` re-checks a committed artifact without writing. The
`review` section reports against the ensemble bar the runtime credits at — two
unwaived reviewer dispatches under the default `reviewEnsemble: "enforce"`, one
under `"advise"` — not against `maxReviewerRounds`, which only caps dispatches;
a refusal stamp keeps the section red, and a human release satisfies it, the
same credit rule the landing gate applies. It
is a correlated claim, not proof — say so in the comment you post.
