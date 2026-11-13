# Journal file layout

## File layout

- **`turnstile.jsonl`** — the shared, always-on audit trail. Entries without
  a resolvable parent sessionID land here.
- **`sessions/<parentID>.jsonl`** — the per-session sink (the default, when
  `journalPerSession` is on). Every entry with a resolvable parent sessionID
  (via the ledger's `parentOf` map) appends here instead of the shared file,
  so one session's dispatches, verdicts, gates, blocks, and waivers read
  top-to-bottom in one file. Entries without a sessionID, or with an ID
  failing the session-ID shape rule, land in the shared `turnstile.jsonl`.
- **`gate-events.log`** — human-readable trace, only when `trace:true`.
- **`anchors.jsonl`** — the session-state anchor store, written only when
  `tamperEvidence.enabled` is `true` (see [tamper evidence: the hash
  chain](chain.md) and [anchors](anchors.md)). One published epoch ref per
  line, appended by the `session-state`
  sink at the task-completion and session-end triggers.
- **`approved-plans.jsonl`** — the durable approved-plan store (beside the
  journal by default; the factory's injected option redirects it). Each line
  is one record: a plan file name, its content key, and the project scope
  the approval was recorded under (derived from the resolved project
  directory).

  New records carry a `scheme: "spec"` tag; the key is the plan's
  spec-region sha256. A record without the tag was written under the legacy
  whole-file scheme, or an unknown newer scheme. A record covers a plan when
  its key equals the file's spec-region key or its whole-file key; then the
  plan is not pending. The whole-file key is the sha256 of the file's bytes
  at the current plans scan. A cached scan may reflect the bytes at its last
  refresh rather than the current file: a progress-only edit leaves the
  spec region (and the cached scan signature) unchanged, so a legacy record
  can be honored across such an edit, and the re-key it performs writes the
  current spec key.

  The first legacy match is transparently re-keyed to the current scheme:
  in-memory, sidecar append, and one replay-inert `plan-rekey` journal row
  with `reason: "durable-key-scheme"`. A record matching neither key leaves
  the plan pending with cause `durable-key-stale`: the enforcing dispatch
  journals the blocked row with that reason and a recovery message (one
  re-approval re-keys it) instead of the `no-plan-verdict` never-approved
  message.

  At boot the ledger loads the store. A missing file is a silent empty;
  another read error is journaled once and degrades to empty. The in-memory
  map is last-wins per (project, plan), capped at 256 records, and rewritten
  on eviction.

  A record is written when a _bound_ plan-reviewer APPROVE credits the gate.
  An unbound approval records nothing: human releases, prompts naming no
  single plan, a reviewer approval whose dispatch named no resolvable plan.

  A plan whose name and content key still match a record under the current
  project is not _pending_: the plan gate stays green for it even after the
  journal's APPROVE line has aged out of the replay window and across prompt
  resets. The exemption is re-derived from the sidecar, not the session
  bucket. A dispatch whose resolved plan is not pending is exempt even while
  unrelated plans stay pending.

  A record restores no session bucket itself (`hasPlanVerdict` and kin
  remain replay-only). An edited or replaced plan (content-key mismatch) or
  another project's plan stays pending. Read or write failures are
  fail-open: journaled, never blocking.
