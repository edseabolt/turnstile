# Journal replay on restart

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
with live sessions; see [the retention note](rotation.md)).

The journal is treated as untrusted data on the read side. A line folds
into the last-wins maps only if its `sessionID` passes the replay ID-shape
check (alphanumeric plus `.`, `_`, `-`, length 1–64) and its kind fields
pass their shape guards: verdict marker ≤ 512 chars, ensemble count an
integer in `[0, REVIEW_ENSEMBLE_SIZE]` (higher integers clamp, others
drop). Each dropped line journals one replay-drop `suppressed` entry
([entry-type catalog](entry-types.md)). An unreadable generation file (a directory in its place, a
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
exempt through [the durable approved-plan store](file-layout.md).

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
journal holds `plan-rekey` rows (the durable-store scheme migration in the
[entry-type catalog](entry-types.md)),
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
