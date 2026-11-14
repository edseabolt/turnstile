# Files and journals

- Journals live outside the repo in `~/.local/share/opencode/metrics/`:
  - `turnstile.jsonl`: shared JSONL audit trail (the fallback sink for
    entries without a sessionID); hot path is append-only and rotates
    once per `journalRotateEveryEntries` (default 512) writes under a
    lock-guarded rename, keeps `journalMaxGenerations` (default 5)
    generations; a lock left behind by a crash between create and remove of
    `<file>.lock` is stolen once its age passes a staleness bound
    (`ROTATION_LOCK_STALE_MS`, 60s) and the rotation proceeds, and journaling
    keeps appending through fresh contention
  - `sessions/<parentID>.jsonl`: per-parent-session segments (when
    `journalPerSession` is on, the default) — every entry with a resolvable
    parent sessionID appends here, so one session's story reads
    top-to-bottom; same rotation bounds per file. Grep one session's
    history with `rg … ~/.local/share/opencode/metrics/sessions/<parentID>.jsonl`
  - `gate-events.log`: human-readable
    `YYYY-MM-DD HH:MM | agent | event | detail` lines, with an optional
    trailing ` | <sessionID>` segment when the trace line is wired to a
    session (the first four segments are unchanged when it is absent);
    suppressed entirely by `trace: false`
  - `approved-plans.jsonl`: durable, bounded, project-scoped store of
    bound plan-reviewer approvals (plan name + content key + project
    scope + key-scheme tag (`scheme: "spec"`; untagged = legacy whole-file
    key)), capped at 256 records and rewritten on eviction. A plan whose
    name and content key still match a record for the current project is
    not _pending_ — the plan gate stays green for it even after its
    journal APPROVE line has aged out of `replayTailLines` and across
    prompt resets; an edited or replaced plan (key mismatch) stays
    pending. A legacy record whose whole-file key still matches the
    whole-file sha256 at the current plans scan is honored and re-keyed to
    the spec scheme on first touch (journaled `plan-rekey`; the re-key
    writes the current spec key). A cached scan may reflect the bytes at
    its last refresh rather than the current file — a progress-only edit
    leaves the spec region (and the cached scan signature) unchanged, so a
    legacy record can be honored across such an edit. A record matching
    neither key blocks with
    the `durable-key-stale` reason and a one-re-approval recovery message.
    Fail-open: read/write errors are journaled and the gate
    degrades to journal-replay semantics
- Retention is bounded: 2 files × (1 current + 5 generations) × 5 MB ≈
  ~30 MB per journal, worst case ~60 MB total, plus the approved-plan
  sidecar (≤ 256 short records). With `journalPerSession` on, each live
  session adds its own `sessions/<parentID>.jsonl` with the same per-file
  bounds, so aggregate retention and boot replay read cost scale with the
  live session count. Rotate overshoot is another
  `journalRotateEveryEntries` (default 512) entries × ~2 KB per journal,
  taken between the size check and the rename on the lock tick.
- `.opencode/plans/*.md` containing `## Decomposition` are load-bearing:
  their presence activates the executor chunk-citation gate.
- The journal also carries `{type:"ensemble", sessionID, agent, count}`
  entries: one per unwaived `task -> reviewer` dispatch, carrying the
  running `count`. Under `reviewEnsemble: enforce`, declining a
  single-reviewer APPROVE adds a `refusedApprove:true` stamp to the last
  `ensemble` entry and a `blocked` entry (`reason:"ensemble-incomplete"`,
  carrying `count` and `need: 2`). A human `always` release journals
  `refusedApprove:false` to clear the stamp. Each type is replayed at boot
  and contributes to the `replayTailLines` tail (default 2000): the last
  `ensemble` entry per session sets `reviewerDispatches`, and when it is
  stamped `refusedApprove:true` replay does not re-credit that APPROVE's
  `hasReviewApprove` on restart. When the landing gate is already released,
  a later APPROVE delivery is credited without a stamp: the release (human
  grant or mechanical) is never re-stamped as a refusal.
