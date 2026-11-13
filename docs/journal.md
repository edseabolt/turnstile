# Journal: catalog, replay, and tamper evidence

The journal is the plugin's only persistence edge. It lives outside the repo
at `~/.local/share/opencode/metrics/`. This document is the developer
reference for the file layout, the entry-type catalog, rotation, replay, and
tamper evidence. The state-machine view lives in
[architecture/persistence.md](architecture/persistence.md).

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
  `tamperEvidence.enabled` is `true` (see the tamper-evidence subsection
  below). One published epoch ref per line, appended by the `session-state`
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

## Entry-type catalog

The shared trail carries 43 entry types, all listed here. (The
[persistence](architecture/persistence.md) inventory enumerates 43 literals;
its prose count said 42.) The default disposition is audit-only: such
entries are replay-inert and status-inert. The table marks the exceptions.

| Type              | Records                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | Replay fold                                                                                                                                                                                                                                                                                                                                                                        | Status                                                                                                                         |
| ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `setup`           | the load heartbeat: hook registration counts, compat verdict                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | none                                                                                                                                                                                                                                                                                                                                                                               | inert                                                                                                                          |
| `dispatch`        | one row at guard exit; stamps `blocked:true` when a guard rejected the attempt (the guard's own `blocked` entry is the countable signal; `scripts/status.mjs` excludes the stamp from its dispatches counter to avoid a double count). The same guard exit meters the admitted dispatch, so a blocked attempt leaves every counter untouched                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | none                                                                                                                                                                                                                                                                                                                                                                               | inert                                                                                                                          |
| `maintenance`     | an admitted maintenance dispatch: `{sessionID, plan, capped:false}`; a cap-exceeded attempt journals `capped:true` before its blocked dispatch entry; `scripts/status.mjs` counts only the admitted rows (MNT column + JSON `maintenance`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | none                                                                                                                                                                                                                                                                                                                                                                               | inert                                                                                                                          |
| `gate`            | `GATE:` marker first-sight and flip records                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | last-wins per session: restores `hasGatePass` (a `GATE: FAIL` un-greens an earlier PASS)                                                                                                                                                                                                                                                                                           | folded                                                                                                                         |
| `plan`            | plan APPROVE entries; may carry the bound identity fields `plan` (path-free file name ≤ 128 chars), `planKey` (64-char lowercase sha256 hex), and `plansSig` (≤ 4096 chars); a field restores only in legal shape: absent, non-string, or malformed-shape means unbound, so legacy lines replay unchanged                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | last-wins per session: restores `hasPlanVerdict` (+ `plansSignature`); bound vs unbound staleness then applies per the replay rules below                                                                                                                                                                                                                                          | folded                                                                                                                         |
| `verdict`         | reviewer / plan-reviewer `VERDICT:` records                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | last-wins per session: restores `hasReviewApprove` (task-result source only; streamed child verdicts never restore it) and plan verdicts                                                                                                                                                                                                                                           | folded                                                                                                                         |
| `ensemble`        | reviewer ensemble count entries (`countReviewerEnsemble`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | count restore, shape-guarded: an integer in `[0, REVIEW_ENSEMBLE_SIZE]` (higher integers clamp, others drop)                                                                                                                                                                                                                                                                       | folded                                                                                                                         |
| `blocked`         | deliberate block records; the countable signal for a rejected dispatch attempt                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | none                                                                                                                                                                                                                                                                                                                                                                               | inert                                                                                                                          |
| `escalation`      | permission-ask escalation records                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | none                                                                                                                                                                                                                                                                                                                                                                               | inert                                                                                                                          |
| `permission`      | ask/reply bookkeeping; telemetry sub-kinds: `event:"latch-steal"` with `reason:"plan-gate"`; `event:"forced"` with `reason:"landing"` (the hands-on arm journals the same shape with `reason:"hands-on"`); `event:"unrecorded-reply"` with `requestID`. None carries `action:"ask"` or `decision`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | none (the ledger never replays `permission` rows)                                                                                                                                                                                                                                                                                                                                  | the status PERM-ask and PERM-decision counters key off `action`/`decision`, so these leave the human table untouched           |
| `attribution`     | marker-attribution records                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | none                                                                                                                                                                                                                                                                                                                                                                               | inert                                                                                                                          |
| `policy`          | policy-injection surface records (`injected:true/false`, skips with `reason`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | none                                                                                                                                                                                                                                                                                                                                                                               | inert                                                                                                                          |
| `config`          | surface audit for the once-per-load `[turnstile] config:` block: `{sessionID, surfaced:true, count}`, or `{surfaced:false, error}` when the prepend threw (fail-open); never re-journaled. It is a count-only audit, not a second copy of the warnings                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | none                                                                                                                                                                                                                                                                                                                                                                               | inert                                                                                                                          |
| `marker`          | near-miss diagnostics: `event:"near-miss"` `{sessionID, found, literal}` (the prompt text itself is never journaled) and `event:"surfaced"` `{sessionID, surfaced:true, count}`, or `surfaced:false, error` when the prepend threw (the diagnostic retries on the next delivery)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | none                                                                                                                                                                                                                                                                                                                                                                               | inert                                                                                                                          |
| `continuation`    | continuation-carry records; carries `recovery: true` for an interrupted-review carry                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | none                                                                                                                                                                                                                                                                                                                                                                               | inert                                                                                                                          |
| `child-reset`     | `{sessionID, children}`: a parent prompt's `resetState` freeing the metering counters of at least one edge-registered child; exists only on prompts that actually free a child                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | none                                                                                                                                                                                                                                                                                                                                                                               | inert (the aggregate's entry-type chain does not count it)                                                                     |
| `child-edge`      | child→parent edge registration records                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | none                                                                                                                                                                                                                                                                                                                                                                               | inert                                                                                                                          |
| `evidence`        | exit-0 test-execution evidence records                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | none                                                                                                                                                                                                                                                                                                                                                                               | inert                                                                                                                          |
| `violation`       | bare-output compliance violations                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | none                                                                                                                                                                                                                                                                                                                                                                               | inert                                                                                                                          |
| `tool`            | tool telemetry; includes the pipeline-child write row `{sessionID, tool, childWrite:true, path}` that feeds `prov:override` adjacency, and the scratch audit row `{type:"tool", scratch:true}` carrying the target path                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | none                                                                                                                                                                                                                                                                                                                                                                               | inert                                                                                                                          |
| `error`           | internal error telemetry (the fail-open record)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | none                                                                                                                                                                                                                                                                                                                                                                               | inert                                                                                                                          |
| `suppressed`      | the audit trail for a marker the pipeline deliberately did not honor; two flavors by `kind`. `kind:"gate"` / `kind:"verdict"`: a first-observed-from-an-unauthoritative-emitter record, with `reason` `emitter agent unresolved` or `agent not contracted for kind`. The marker string carries the digits for forensics; a re-delivery of identical text adds none (dedup stays registered). `kind:"replay"`: one entry per journal line the boot replay dropped for failing a shape check, `{ts, type:"suppressed", kind:"replay", reason}`, with `reason` one of `malformed`, `session-id`, `entry-shape`, `count-invalid`, plus `sessionID` only when it already passed the replay ID-shape check (hostile bytes are never echoed into the journal). A boot that drops more than 16 lines journals one final `{ts, type:"suppressed", kind:"replay", event:"summary", dropped:<total>}` in place of the overflow                                       | none (nothing replays against a denial or a drop)                                                                                                                                                                                                                                                                                                                                  | inert                                                                                                                          |
| `observe`         | observe-mode admission phase stamp: `{sessionID, phase, observed, wouldBlocks}` with `phase` `observe` or `enforce`. When the `[turnstile] observe:` block lands, the end-of-period marker `{type:"observe", kind:"summary", injected:true, observed, wouldBlocks}` is journaled                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | last-wins: the last stamped line restores the per-session phase map and the `observed`/`wouldBlocks` totals, and the journaled session IDs rebuild the admission dedup set, so a restart never re-increments a counted session. The `kind:"summary"` marker folds inert: it only sets the pending-summary probe, proving the summary surfaced so it never re-fires after a restart | folded                                                                                                                         |
| `would-block`     | one suppressed deliberate block: `{sessionID, cause, observed, wouldBlocks}` with `cause` the blocking gate's audit name (its stamped phrase, the dispatched agent name, `"read-budget"` for a read, or the `"gate"` fallback, truncated to 200 chars)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | last-wins into the phase map and totals, like `observe`                                                                                                                                                                                                                                                                                                                            | folded                                                                                                                         |
| `suspended`       | state flavor `{type:"suspended", sessionID, action:"off"\|"on"}`, plus `refused:true` when `allowSuspend:false` refused the marker; audit flavor `{type:"suspended", sessionID, event:"would-block", cause}` with cause truncated to 200 chars, one per deliberate block suppressed by the suspension                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | the state flavor folds last-wins into the ledger's suspension map (a restart mid-suspension stays suspended, an ON resumes); a `refused:true` entry folds inert (a refusal can never resurrect a suspension, so the kill switch cannot be defeated by replaying a refusal); a missing or unknown `action` is an `entry-shape` replay drop; the audit flavor folds inert            | the state flavor is status-visible (the aggregate folds the same last-wins suspension state); the audit flavor is status-inert |
| `replay`          | file-level audit of an unreadable journal generation during the boot replay: `{ts, type:"replay", error:true}` with no message, one per unreadable generation file, always appended to the shared `turnstile.jsonl` (never the file being read), bounded by the generation count                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | none                                                                                                                                                                                                                                                                                                                                                                               | inert                                                                                                                          |
| `session-summary` | delivery proof for the session-end summary: `{type:"session-summary", sessionID, verified, blockedDispatches, waivers, text}`; the counts mirror the recap line (`text`, bounded to 300 chars), shown as a TUI toast when the host offers `tui.toast.show` and delivered journal-only otherwise; one per session per host process (an in-memory dedupe set; a restarted host may re-summary a still-idle session once)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | none                                                                                                                                                                                                                                                                                                                                                                               | inert                                                                                                                          |
| `generate-draft`  | the one-per-boot request-draft telemetry row from the first `session.context`/`session.generate` fire: `{type:"generate-draft", surface, agent, hasSessionID, systemKind, systemLen, messagesKind, messagesLen, hasOptions, keys}`; kinds, counts, and presence flags only, never block or message text                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | none                                                                                                                                                                                                                                                                                                                                                                               | inert                                                                                                                          |
| `compat`          | host-compat verdict records (`event:"incompatible"`, `event:"unknown-host"`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | none                                                                                                                                                                                                                                                                                                                                                                               | inert                                                                                                                          |
| `intent`          | advisory intent classification `{sessionID, signal}` (one per detected intent signal; a plan approval clears the latch)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | none                                                                                                                                                                                                                                                                                                                                                                               | inert                                                                                                                          |
| `reseed`          | boot re-seed records (parent-edge rebuild)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | none                                                                                                                                                                                                                                                                                                                                                                               | inert                                                                                                                          |
| `task-complete`   | the task retire ([task-flow](architecture/task-flow.md))                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | none                                                                                                                                                                                                                                                                                                                                                                               | inert                                                                                                                          |
| `engagement`      | `{type:"engagement", sessionID, engaged, reason}` with `reason` one of `plan-approved` / `dispatch-request` / `plan-reference` (arm) or `task-complete` / `abort` / `continuation-drop` (sleep)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | last-wins per session (a non-boolean `engaged` field is an `entry-shape`-style drop: the value is sanitized and a hostile row restores dormancy), so a restart mid-task keeps enforcement armed and a journaled sleep restores it                                                                                                                                                  | folded                                                                                                                         |
| `plan-rekey`      | durable-store scheme-migration audit row: `{type:"plan-rekey", sessionID?, plan, reason:"durable-key-scheme", from, to}`, appended when a content-verified legacy (or untagged) approved-plan record is transparently re-keyed to the current spec-region scheme                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | none (an unlisted type returns no state)                                                                                                                                                                                                                                                                                                                                           | surfaced only through the status report's re-key advisory line                                                                 |
| `marker-retry`    | compliance re-prompt for a bare-output delivery: `attempt` is the prior retry count for that child and `outcome` is `prompted` (the reminder was sent via the host's `session.prompt`), `skipped-no-api` (the host exposes no prompt API), or `exhausted` (the child's retry budget is spent)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | not replayed into gate state                                                                                                                                                                                                                                                                                                                                                       | inert                                                                                                                          |
| `plan-impact`     | one classified parent tool call against the bound active plan's scope: `{type:"plan-impact", sessionID, tool, plan, impact, path}` with `impact` `advisory` (the target is named in the plan's steps, which may go stale) or `structural` (the target is named in the plan's `## Decomposition` block, or is the plan file itself, so a replan is required). A non-overlapping call classifies `none` and journals nothing                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | folded silently, no gate state; it is the audit trail the reviewer and replay see                                                                                                                                                                                                                                                                                                  | inert                                                                                                                          |
| `plan-review`     | one user plan-review lifecycle event: `{type:"plan-review", sessionID, action}` with `action` `pause` (a planner dispatch was admitted while `planUserReview` is on; the plan-reviewer dispatch is now blocked until the user resolves it), `accept` (the user's `planReviewAcceptMarker` prompt unblocked the review), or `reject` (the user's `planReviewRejectMarker` prompt retired the task; the row is accompanied by a `task-complete` row)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | last-wins per session: `pause` restores `planReviewPending`, `accept` and `reject` restore it cleared (a hostile `action` folds inert)                                                                                                                                                                                                                                             | folded                                                                                                                         |
| `prov:stated`     | one admitted parent-session human prompt: `{type:"prov:stated", sessionID, text, truncated}`. `text` is the prompt verbatim after mechanical secret redaction (`redactSecrets`), capped at 2000 chars (`truncated` marks the cap), with no relevance filtering ("continue" included)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | additive; folds nothing                                                                                                                                                                                                                                                                                                                                                            | gated on `decisionLedger.enabled` (default `true`); queryable via `opencode-turnstile prov`                                    |
| `prov:denied`     | one human permission denial at the plan, landing, or hands-on reject sites: `{type:"prov:denied", sessionID, kind}` with `kind` the ask kind                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | additive; folds nothing                                                                                                                                                                                                                                                                                                                                                            | gated on `decisionLedger.enabled`; queryable via `opencode-turnstile prov`                                                     |
| `prov:waiver`     | one human gate waiver at the two waiver-journaling sites, the plan gate's `journalPlanWaiver` (`src/plan-gate-enforce.ts`) and the reviewer gate's `journalReviewerWaiver` (`src/dispatch-review-gate.ts`): `{type:"prov:waiver", sessionID, stages}` with `stages` the covered stage list each site already computes for `waiverCovers`; the waiver quote text is not carried (it is redacted upstream)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | additive; folds nothing                                                                                                                                                                                                                                                                                                                                                            | gated on `decisionLedger.enabled`; queryable via `opencode-turnstile prov`                                                     |
| `prov:override`   | one parent-side write/edit that follows a pipeline-child write to the same path within a 15-minute adjacency window (`OVERRIDE_WINDOW_MS` in `src/override-adjacency.ts`): a human-side correction of pipeline work, whatever its semantics (edit, revert, or full rewrite). `{type:"prov:override", sessionID, tool, path, child}` with `tool` the parent-side tool, `path` the target path redacted then capped at 200 chars, and `child` the pipeline-child session whose write was overridden. The child-write side is journaled at the write/edit dispatch surface as a bounded `{type:"tool", ...}` telemetry row and recorded into an in-memory adjacency tracker (never child session content); the parent-side match happens at the `execute.after` write/edit surface (`afterWriteEdit` in `src/tool-hooks-after.ts`). The match is window-persistent, not consume-on-match: every completed parent edit inside the window journals its own row | additive; folds nothing                                                                                                                                                                                                                                                                                                                                                            | gated on `decisionLedger.enabled`; queryable via `opencode-turnstile prov`                                                     |
| `chain-epoch`     | the epoch commit row (see the tamper-evidence subsection), itself chained like any other row                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | none                                                                                                                                                                                                                                                                                                                                                                               | inert                                                                                                                          |
| `chain-verify`    | the session-end chain-verification verdict (see the tamper-evidence subsection)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | none                                                                                                                                                                                                                                                                                                                                                                               | inert                                                                                                                          |

## Rotation

The journaler appends on the hot path without stat or rename: `journal()`
only appends and advances a per-file counter. The rotate-then-rename
sequence runs once per `journalRotateEveryEntries` appends (default 512),
only under a created `<file>.lock` atomic-mkdir mutex, so two concurrent
sessions never both rename the shared file. Disk usage stays bounded at
`(N + 1) × maxBytes`, plus at most `journalRotateEveryEntries × ~2 KB` of
overshoot between the size check and the rename. A contended lock or any
rotation error is swallowed (fail-open). The journaler steals a leftover
`<file>.lock` from a crash once its mtime passes the staleness bound
(journaling a `rotation-lock-stale:` `error` entry), so rotation resumes
instead of stopping forever; a freshly held lock is still skipped silently
while journaling keeps appending. One bounded race remains: a writer that
opens the path across the rename may land an entry in a generation past the
current file, but the replay scan walks all retained generations, so such
an entry simply joins the tail window when it is read back (the window is
small and clock-free). Files rotate at 5 MB, 5 generations.

## Per-session sink rules

Each `sessions/<parentID>.jsonl` file carries the same rotation bounds as
the shared file (5 MB, 5 generations, same lock cadence and stale-lock
steal). The steal's `rotation-lock-stale:` error row always appends to the
shared `turnstile.jsonl`, even when the contended file is a session sink.
Aggregate retention and boot read cost scale with the live session count:
per-file bounds are equivalent, but the file count grows with sessions
(accepted; the shared-file bound alone is unchanged).

## Replay on restart

On restart, `replayGatePasses` (`src/ledger.ts`) walks the shared journal
generations newest-first (`turnstile.jsonl`, then `.1`, `.2`, … while the
file exists), then every `sessions/` file family's generations the same
way. The directory read is guarded: any failure replays the shared file
only. Every directory entry maps to its family root (`p1.jsonl.2` roots at
`p1.jsonl`), and the deduplicated root set is walked, so each generation is
read exactly once, including a fully rotated family whose current file is
absent.

The collected lines merge ordered by their `ts` field (missing/unparseable
sorts oldest) and the walk keeps the last `replayTailLines` lines (default 2000) globally. Last-wins folds are per-sessionID, and each sessionID's
rows live in exactly one file, so cross-file ordering cannot change any
per-session fold; the global `ts` sort only preserves the observe-mode
global totals' last-wins behavior.

The global slice is also an inclusion bound. Each session-sink family is
read with the full `replayTailLines` window, but the slice keeps the last
window overall: with a hot shared journal plus many session sinks, a quiet
session's entire contribution can fall outside the kept tail, so its boot
gate restore silently fails toward strict (the same eviction spirit as
journal rotation). The merge also bounds boot memory, not just boot I/O:
all read lines are held at once, O((1 + number of session-sink families) ×
`replayTailLines`) lines in the worst case (a bound, not a steady-state
cost). Per-file reads stay tail-capped with an early stop: the walk ends
inside the newest generation that alone satisfies the tail bound, so boot
I/O stays bounded by the retained-generation sizes, never the full
`journalMaxGenerations × journalMaxBytes` envelope (the file count grows
with live sessions; see the retention note above).

The journal is treated as untrusted data on the read side. A line folds
into the last-wins maps only if its `sessionID` passes the replay ID-shape
check (alphanumeric plus `.`, `_`, `-`, length 1–64) and its kind fields
pass their shape guards: verdict marker ≤ 512 chars, ensemble count an
integer in `[0, REVIEW_ENSEMBLE_SIZE]` (higher integers clamp, others
drop). Each dropped line journals one replay-drop `suppressed` entry
(above). An unreadable generation file (a directory in its place, a
permission failure) folds nothing from its lines: it journals one
message-free `{ts, type:"replay", error:true}` entry on the shared
`turnstile.jsonl` (bounded by the generation count) and the walk continues
with the next-older generation.

The walk then restores per session, last-wins: `hasGatePass`,
`hasPlanVerdict` (+ `plansSignature`), `hasReviewApprove` (task-result
source only; streamed child verdicts never restore it), ensemble counts,
the observe period (per-session phase, the admission dedup set, and the
running `observed`/`wouldBlocks` totals; last-wins, and a `kind:"summary"`
marker sets the pending-summary probe), and the gate suspension map
(last-wins `action:"off"` / `action:"on"`; a restart mid-suspension stays
suspended; the `refused:true` refusal flavor and the `event:"would-block"`
audit flavor fold inert).

A plan APPROVE entry may carry the bound identity fields `plan` (file
name) and `planKey` (that file's content hash); a field restores it only
in legal shape (path-free file name ≤ 128 chars; `planKey` a 64-char
lowercase sha256 hex; `plansSig` ≤ 4096 chars). Absent, non-string, or
malformed-shape means unbound, so legacy lines replay unchanged and
hostile bytes degrade to the existing unbound validation paths. Restored
buckets get `replayGrace`, surviving exactly the resume prompt. Values,
not provenance, are carried: a live `GATE: FAIL` after replay stays false.

Staleness then applies per approval kind. A restored _bound_ verdict is
validated against the current files immediately (bound plan edited or
removed → `plan-edited` / `plan-missing` STALE, no accept-once window). A
restored unbound verdict carries its journaled `plansSig` stamp and is
validated against the current dir (any plans-dir change →
`signature-mismatch` STALE). A field-less legacy line keeps the accept-once
window (accepted once and re-stamped). Any read error is fail-open. The
window bounds only the live approval: bound approvals older than it stay
exempt through the durable approved-plan store above.

For a read-only status view: `opencode-turnstile status [--json]`
aggregates gate/plan/verdict/dispatch/blocked/permission/suspension entries
per parent session, walking the same all-generation tail window with the
same session-ID and marker shape checks (observation-only, so a dropped
line is silent there rather than journaled). Suspension folds last-wins
like the ledger's `foldSuspended` (an OFF marks, an ON clears, a
`refused:true` refusal, an `event:"would-block"` audit, and an unknown
action fold nothing) and surfaces per session as the `suspended` JSON
field and the table's SUS column. When the journal holds observe-mode
entries, the report header adds the folded period line
(`observe: <phase> <observed>/<observeSessions> sessions, <wouldBlocks>
would-blocks`); journals without them render byte-identically. When the
journal holds `plan-rekey` rows (the durable-store scheme migration above),
one advisory line naming the re-keyed plans (capped at five, `+N more`
beyond) renders under the observe line; journals without them render
byte-identically too.

`opencode-turnstile evidence [--task <session|latest>]` is the publishable
half of that view: the same tail window and shape checks, folded to one
task and projected key by key into `turnstile-evidence/v1`: derived
counts, canonical marker lines, and two shas (a one-way task handle, and
`sha256` of the last journaled line). Nothing is filtered out of a larger
object: the document is built from whitelisted keys, so a journal field
cannot leak into a public artifact by oversight. It adds no entry type,
changes no replay rule, and writes nothing to the journal.

## Tamper evidence: the journal hash chain and anchors (opt-in)

When `tamperEvidence.enabled` is `true` (default `false`; the legacy
unchained row shape stays the default so existing journal consumers are
untouched), every journaled row carries three chain fields appended after
the payload: `seq` (per-file monotonic counter starting at 0), `prevHash`
(the previous row's hash, `""` for the first), and `hash`, the SHA-256 over
the canonical JSON (RFC 8785-style: sorted keys, no whitespace) of
`{prevHash, ts, payload}` (`src/chain.ts`, `node:crypto` only, zero runtime
dependencies). Editing, deleting, or reordering any row breaks every hash
after it.

Epochs batch the chain for verification and anchoring: every `epochEntries`
data rows (default 512, matching the rotation cadence) the journaler
appends a `chain-epoch` row, itself chained like any other, carrying
`{source, epoch, count, root, head}` where `root` is the Merkle root over
the epoch's data-row hashes (pairwise `sha256(a + b)`, an odd trailing node
hashed with itself, the single survivor hashed with itself once more) and
`head` is the epoch's last data-row hash. Two more entry types ride the
chain: `chain-epoch` (the commit above) and `chain-verify` (the session-end
verdict, below).

**Anchoring (the anchor-sink boundary, `src/anchor.ts`).** A Merkle root in
the same file an attacker can rewrite proves nothing by itself, so each
committed epoch's ref (`{sink, source, epoch, root, head, ts}`) is
published to independent durable stores, the anchor sinks, at the
task-completion trigger, fire-and-forget: every publish runs concurrently,
a rejection journals an `anchor-publish:` `error` row, and nothing blocks
the pipeline. Sinks are selected by `tamperEvidence.anchor`:

| Sink                      | Trust domain | Store                                                                                                                                              | Defeats                                                                       |
| ------------------------- | ------------ | -------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| `session-state` (default) | host         | `<metricsDir>/anchors.jsonl`                                                                                                                       | lazy edit-in-place of the journal: a rewriter must also forge the second file |
| `git-note`                | repo         | git notes on HEAD, `refs/notes/turnstile`                                                                                                          | anything short of rewriting the git object store                              |
| `commit-trailer`          | repo         | `Turnstile-Anchor:` trailers on landing commits (pending refs parked in `.git/turnstile/trailer-anchors.jsonl` until the landing flow stamps them) | same, plus ties the epoch to project history                                  |
| `{plugin: "<specifier>"}` | external     | whatever the imported factory implements                                                                                                           | strongest: a store outside the host's control                                 |

An array selects several: all publish, verify intersects (a ref is anchored
when any sink vouches; the report names the **weakest vouching trust
domain** (external > repo > host)). **Caveat:** a plugin specifier is code
the host executes, so only point `plugin:` at modules you trust as much as
turnstile itself.

Each selection form, configured under `tamperEvidence.anchor`:

```jsonc
{
  "tamperEvidence": {
    "enabled": true,
    "anchor": "session-state"
  }
}
```

```jsonc
// A repo-trust anchor: every committed epoch lands as a git note on HEAD.
{
  "tamperEvidence": {
    "enabled": true,
    "anchor": "git-note"
  }
}
```

```jsonc
// Tie epochs to project history: pending refs wait in
// .git/turnstile/trailer-anchors.jsonl until a landing commit carries the
// Turnstile-Anchor: trailer; verify reports missing until then.
{
  "tamperEvidence": {
    "enabled": true,
    "anchor": "commit-trailer"
  }
}
```

```jsonc
// An external plugin sink, alone or mixed with builtins. `options` is
// passed through to the plugin factory verbatim.
{
  "tamperEvidence": {
    "enabled": true,
    "anchor": [
      "session-state",
      { "plugin": "./my-anchor-sink.mjs", "options": { "bucket": "turnstile-anchors" } }
    ]
  }
}
```

### The `{plugin}` sink contract

A plugin sink is a module (resolved by lazy `import()`, so relative paths
resolve against the config file) whose **default export is a factory**:

```js
// my-anchor-sink.mjs — minimal example: a second host-domain store.
import * as fs from "node:fs"

export default function factory({ config }) {
  // config is the `options` object verbatim: { bucket: "…" } above.
  const file = `${config.bucket}.anchors.jsonl`
  return {
    id: "my-anchor",           // string, appears in verdicts
    trustDomain: "external",   // "host" | "repo" | "external"
    publish(ref) { fs.appendFileSync(file, JSON.stringify(ref) + "\n") },
    verify(ref) {
      // Return { status: "ok", anchoredAt } when this store vouches for
      // the ref, { status: "missing", detail } when it holds nothing for
      // it, or { status: "mismatch", detail } when it holds a differing
      // root/head for the same source#epoch.
    },
  }
}
```

The factory is called once at setup with `{ config: <the configured
`options` object> }`. Its returned sink is shape-checked: a string `id`, a
`trustDomain` in the union, and callable `publish`/`verify` (both may be
async — `publish(ref)` receives the anchor ref `{sink, source, epoch,
root, head, ts}`; `verify(ref)` returns an `AnchorVerdict`). Every
failure path degrades fail-open: a failed import, a non-function default
export, a factory throw, or a malformed sink each become a journaled
`anchor-sink:` warning and the entry is skipped — never a boot failure.

**Verification.** `verifyJournalChain` (`src/verify.ts`) folds every journal
file family (shared + per-session sinks) across its rotation generations
oldest-first, re-derives each row's hash and each epoch's Merkle root, and
reports the first broken link (`<family>:<line>: prevHash|seq|hash mismatch`
or an epoch root/head mismatch). Epoch indices are monotonic per family
across rotations: a seeding or resyncing journaler continues from the max
committed index in the surviving generations, so a `source#epoch` ref
identity is stable for the anchor cross-check. When rotation has pruned
generations (the oldest surviving file is a numbered generation other than
`.1`), its first chained row folds as a **trust root**: its `prevHash`
points into a pruned generation, so the prevHash continuity check is waived
for that row only (its own hash and a plausible `seq` are still verified).
When `tamperEvidence.verifyOnSessionEnd` is `true` (default `false`), the
session-idle handler runs it once per session and journals the
`chain-verify` verdict, toasting on failure, which shrinks the detection
window from "whenever someone runs the CLI" to one session. The same check
is available offline: `opencode-turnstile prov --verify` folds the chain
and verifies the epoch refs against the configured sinks, exiting 0 on an
intact anchored chain, 1 on the first broken link or any unanchored ref,
and 2 on usage errors.

**Row-level inclusion proofs (`prov --verify --session <id>`).** The scoped
variant folds only the shared journal and the target session's sink.
`merklePath`/`merklePathRoot` (`src/chain.ts`) derive a per-row RFC
6962-style audit path under the same pairwise/self-hash conventions as
`merkleRoot`; the CLI validates each `prov:*` row's path against its epoch's
anchored ref root (`merkleOk`, `false` when an anchor disagrees with the
journal), reports the weakest vouching trust domain per row via the existing
anchor-sink verdicts, and localizes a mutated `prov:*` row (row + epoch)
while leaving the global verdict and the tamper matrix untouched.
Open-window rows, written after the last epoch close, are reported as
not-yet-anchored (`epoch: null`, with a reason) and never flip the exit
code. The same applies to rows whose epoch window spans a pruned rotation
generation: the surviving leaf list is partial, so no inclusion proof can
be derived (`epochRoot`/`merklePath`/`merkleOk` null, an "epoch window
incomplete" reason), while `epochs[].count` still reports the commit row's
declared committed count. `--json` is honored in scoped mode only; plain
`--verify` keeps its human-only output.

**Differential characterization** (integration-tested in
`tests/tamper-matrix.test.ts`): for each mutation of a captured honest
journal, built through the real write path with a rotation generation and a
task-completion anchor, the observed `prov --verify` verdict must equal the
characterized verdict, so a detector regression (false negative or false
positive) fails loudly:

| #   | Mutation                                                                                    | Expected result                                                                                                                       | Caught by                                                                                                                                            |
| --- | ------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0   | none (control)                                                                              | verify passes                                                                                                                         | —                                                                                                                                                    |
| 1   | edit one row's payload                                                                      | fail, first broken link reported                                                                                                      | chain fold                                                                                                                                           |
| 2   | delete a row                                                                                | fail                                                                                                                                  | chain fold                                                                                                                                           |
| 3   | insert a fabricated row                                                                     | fail                                                                                                                                  | chain fold                                                                                                                                           |
| 4   | reorder rows                                                                                | fail                                                                                                                                  | chain fold / epoch root                                                                                                                              |
| 5   | fork (branch from an interior row)                                                          | fail                                                                                                                                  | chain fold / epoch root                                                                                                                              |
| 6   | rewrite-all with recomputed chain                                                           | chain folds clean, anchor check fails                                                                                                 | anchor                                                                                                                                               |
| 7   | edit rows within the un-anchored tail                                                       | **passes** (documented residual hole, bounded by the anchor cadence)                                                                  | —                                                                                                                                                    |
| 8   | truncate-and-continue (recurring-cleaner attack: truncate, keep logging into a fresh chain) | fail: previously published epoch roots become underivable from the current file, even though the new chain folds clean and re-anchors | anchor (CLI surfaces it via the unanchored-ref check against the retained store; missing-root detection confirmed at the `verifyJournalChain` level) |
| 9   | commit a wrong epoch root (row re-hashed honestly)                                          | fail: the per-record fold stays clean, so only the epoch-root check catches it                                                        | chain fold / epoch root                                                                                                                              |

Row 7 is deliberate: characterizing what the mechanism _cannot_ see is part
of the verification. Its scope is bounded by the anchoring trigger:
anything written after the last task-completion/session-end anchor is
unverifiable until the next one; if the anchor cadence changes,
re-characterize row 7.
Row 8 differs from a mid-file deletion (row 2): the surviving file is
internally valid from a new genesis, so only the anchor comparison catches
it. The harness also confirms a second task-completion anchor after the
truncation re-anchors the fresh chain without masking row 8's failure.
Row 9 isolates the epoch-root limb specifically: the tampered `chain-epoch`
row is re-hashed honestly, so rows 1–5's per-record detection is bypassed by
construction and the mismatch is attributable to the root/head check alone.
Integrity ≠ fidelity: a chain-valid journal that recorded fabricated
execution hashes fine and passes every row; detecting that class needs
ground-truth correlation outside the journal (out of scope here).

**Honesty caveats.** Integrity is not fidelity: the chain proves the
journal bytes are unchanged since they were written; it cannot prove the
_content_ was true (a gate that lied at write time hashes just as cleanly).
Detection latency is bounded by verification, not by chaining: an attacker
who controls the host can recompute the whole chain and forge the
host-domain `session-state` anchor too. Only the repo- and external-domain
sinks raise the cost above "edit two files", and nothing here stops a
determined host-level adversary (that is the tamper matrix's problem, out
of scope here).

Deletion and rotation semantics: anchor refs outlive the rows they vouch
for, so absence detection keys on the committed root (with the monotonic
epoch index as a bound), not on the ref's presence in the fold. An anchored
ref is reported absent only when its root matches no retained epoch AND its
index is at or above the family's lowest retained index, meaning a gap
within, or truncation of, retained history. An anchored epoch whose commit
row has rotated out entirely is satisfied silently: after that row is
pruned, absence is undetectable, the same trust domain as journal deletion.
Steady-state `verify` exit 0 is the expected signal; a red verify means
either genuine truncation within retained history or a store/journal
mismatch worth investigating.

The anchor store grows by one ref per epoch commit (duplicates skipped by
the session-state sink), is host-local, and is bounded only by the epoch
commit rate. A hostile writer can also forge an arbitrarily large epoch
index and pollute identity numbering, but the forged commit's ref then
verifies unanchored, the host-trust-domain ceiling already described above.

One deletion caveat remains: because pruning makes the oldest surviving
generation's first row a trust root, deleting the oldest generations resets
the chain root, the same trust domain as deleting the journal outright. And
verify over an empty or wholly deleted journal with an empty anchor store
is vacuously ok: absence of rows is not evidence of integrity, which is why
the anchors live in a second file (or sink domain) that still names the
epochs the deleted journal should have contained. With anchors retained,
that deletion is exactly what the absence check reports.
