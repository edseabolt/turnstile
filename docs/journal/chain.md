# Tamper evidence: the journal hash chain

When `tamperEvidence.enabled` is `true` (default `false`; the legacy
unchained row shape stays the default so existing journal consumers are
untouched), every journaled row carries three chain fields appended after
the payload: `seq` (per-file monotonic counter starting at 0), `prevHash`
(the previous row's hash, `""` for the first), and `hash`, the SHA-256 over
the canonical JSON (RFC 8785-style: sorted keys, no whitespace) of
`{prevHash, ts, payload}` (`src/chain.ts`, `node:crypto` only, zero runtime
dependencies). Editing, deleting, or reordering any row breaks every hash
after it.

Epochs batch the chain for verification and
[anchoring](anchors.md): every `epochEntries`
data rows (default 512, matching the rotation cadence) the journaler
appends a `chain-epoch` row, itself chained like any other, carrying
`{source, epoch, count, root, head}` where `root` is the Merkle root over
the epoch's data-row hashes (pairwise `sha256(a + b)`, an odd trailing node
hashed with itself, the single survivor hashed with itself once more) and
`head` is the epoch's last data-row hash. Two more entry types ride the
chain: `chain-epoch` (the commit above) and `chain-verify` (the session-end
verdict; verification is described below, anchor sinks in
[anchors.md](anchors.md)).

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

Row-level inclusion proofs (`prov --verify --session <id>`) are described in
[anchors.md](anchors.md).

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

One deletion caveat remains: because pruning makes the oldest surviving
generation's first row a trust root, deleting the oldest generations resets
the chain root, the same trust domain as deleting the journal outright. And
verify over an empty or wholly deleted journal with an empty anchor store
is vacuously ok: absence of rows is not evidence of integrity, which is why
the anchors live in a second file (or sink domain) that still names the
epochs the deleted journal should have contained. With anchors retained,
that deletion is exactly what the absence check reports.
