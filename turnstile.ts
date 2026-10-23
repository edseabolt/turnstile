/**
 * turnstile: runtime enforcement of the orchestrator pipeline contracts.
 *
 * - Orchestrator policy and pipeline status: injected into the receiving
 *   parent session per task via the `execute.after` hook. On the FIRST
 *   `task`/`subagent` result delivery per task the policy block built by
 *   `orchestratorPolicyFor` from the resolved config (`src/policy.ts`) is
 *   prepended as the policy head, and on EVERY
 *   such delivery whose agent is a pipeline stage a one-line `PIPELINE:`
 *   status tail is appended (the just-completed stage, the live plan/test
 *   gate flags, the reviewer ensemble count, and the next stage the
 *   orchestrator dispatches) — the first delivery reads head+tail, every
 *   later delivery tail-only, so a follow-up delivery still names the next
 *   stage after the head has already landed. Both are attributed to the
 *   delivery's parent through the `childToParent` edge (seeded by
 *   `session.created`, back-filled via `session.get`) — the same edge + host
 *   session record that resolves the delivery's agent for the reviewer credit
 *   and the plan-verdict attribution when the dispatch input names none; the
 *   head is idempotent
 *   per task via `GateState.policyInjected` keyed on that parent, and the
 *   tail runs independently of that flag. The tail is rendered by
 *   `formatPipelineStatus` (`src/state.ts`) from the resolved parent's gate
 *   state and the delivery's agent, with stage names read from
 *   `config.agents` (renamed stages route correctly); for an agent that is
 *   not one of the five pipeline stages it renders "" and the append is
 *   skipped entirely, leaving non-pipeline deliveries byte-identical.
 *   Each delivery is classified once (`classifyDelivery`) into its host shape:
 *   the v1 string shape (child-keyed event, text in `result.output`, a string
 *   `metadata.sessionID` naming the child when present) or the v2 structured
 *   shape (parent-keyed event, structured `result.output`, child via
 *   `metadata.sessionID` or the structured `output.sessionID`, canonical
 *   child text in `output.output`, model-visible `content` as a string or a
 *   block array). Head and tail both land on the shape's model-visible text
 *   through the shared shape ladder (`mutateDeliveryText`: a block-array
 *   `content` gains the head block at the front and the tail block at the
 *   end, so the output reads policy head → child text → `PIPELINE:` tail; the
 *   once-per-load `[turnstile] config:` block, when present, sits between the
 *   head and the child text) — `result.output` for the string shape; string
 *   or block-array `result.content` for the structured one (absent falls back
 *   to the structured output string, and the `output` object otherwise stays
 *   unmutated) — and the classified child and text drive marker parsing, the
 *   bare-output check, and the reviewer capture with no re-derivation. The
 *   reviewer credit and the plan-verdict attribution resolve the delivery's
 *   agent through the child→parent edge + host session record when the
 *   dispatch input names none (the edge is awaited before parsing); the raw
 *   dispatch-input agent stays the signal for the cosmetic status tail, the
 *   policy injection, the bare-output check, and the emitter seed. The
 *   silent skips are the once-flag (which now gates only the policy head —
 *   the tail lands on every pipeline-stage delivery) and an absent result; a
 *   present-but-unclassifiable result journals loudly on EVERY such delivery
 *   (the once-flag no longer gates it) (`{type:"policy", injected:false,
 *   reason:"unknown-shape", shape:<descriptor>}`). The name-based exclusion
 *   is a conservative fallback for non-structured deliveries whose edge is
 *   unresolvable: a config-known subagent name with no registered edge is
 *   skipped and journaled `skipped:true` (`reason:"agent-name"`) rather than
 *   injected; structured deliveries skip the guard by construction (the host
 *   builds that result on the parent's own tool call, so it is always
 *   parent-facing). Fully guarded and fail-open, with the two text mutations
 *   as independent fail-open paths: a broken head journals `type:"policy"`
 *   and proceeds (the tail still lands), and a broken tail journals
 *   `{type:"error", error:"pipeline-status: …"}` without rethrowing (the head
 *   still lands). Nothing is written to an instructions file at install time
 *   — the AGENTS.md contract block is a historical install step, removed.
 *
 * - Config warnings: surfaced into the session context once per plugin load.
 *   When the resolved config produced validation warnings (a typo'd key, a
 *   readWarn/readBlock clamp, a marker regex that differs from the default),
 *   the first tool result carrying string output — any session's, plugin
 *   hooks included for subagents, so a child that delivers first receives the
 *   block — is prefixed with a `[turnstile] config:` block listing each
 *   warning and the journal path. Once per load (warnings are static for the
 *   process; re-injecting per task would be spam), fully guarded and
 *   fail-open (a broken prefix journals a `type:"config"` entry and proceeds).
 *   The placement is a documented approximation: primary-session identity is
 *   not synchronously knowable at execute.after time (child→parent edges seed
 *   asynchronously), so surfacing keys off delivery, not session identity; the
 *   journal remains the complete audit. A host without a tool surface never
 *   reaches it, so its warnings stay journal-only.
 *
 * Written for OpenCode v2.x promise-plugin host (`{ id, setup }`):
 * - `ctx.tool.hook("execute.before" | "execute.after", cb)`
 * - `ctx.session.hook("prompt" | "generate" | "compaction", cb)`
 * - `ctx.event.subscribe({ signal })`
 *
 * - `compaction` → appends the preserve-verbatim instruction plus the live
 *   gate-state snapshot (`formatGateSnapshot`), sourced from the ledger and
 *   keyed off `draft.sessionID` (falling back to the last-admitted parent when
 *   absent). Its `GATE:`/`VERDICT:` tokens are de-tokenized so it can never
 *   re-parse as an authoritative marker. Fully guarded and fail-open.
 *
 * Enforced mechanically:
 * - Marker authority: text observation mutates gate/verdict state only from a
 *   marker-contracted emitter. A `GATE:` is authoritative only from the
 *   `test-runner` agent and a `VERDICT:` only from `reviewer` / `plan-reviewer`
 *   (each also in `agents.bareOutput`); a quoted, echoed, or prompt-injected
 *   marker from any other or unresolved emitter flips nothing and is journaled
 *   as a replay-inert `type:"suppressed"` audit entry. The same marker delivered
 *   authoritatively via an `execute.after` task result still flips — delivery is
 *   the recovery channel for a stream-time authority lookup failure.
 * - Plan-approval gate: `task` dispatches to `executor` require a current
 *   plan approval whenever a plan file exists in `.opencode/plans/`: a
 *   plan-reviewer `VERDICT: APPROVE`, a prompt-channel human approval, or a
 *   permission-prompt human approval. A prompt-channel approval is a
 *   user-authored prompt captured at prompt admission through whichever host
 *   channel carries it — the `session` prompt hook, or the correlated
 *   `session.inbox.enqueued` admission carrying the same host message id where
 *   the surface does not dispatch the hook. Both speak an identical marker,
 *   provenance rule, and journal shape, and one prompt is admitted exactly
 *   once across both (deduped on the shared id); a surface delivering the
 *   inbox stream but never the hook journals a one-time error capturing that.
 *   The approval replays identically to a plan-reviewer verdict. When none
 *   holds, the first executor dispatch
 *   escalates to the human through the host permission surface:
 *   `permission.evaluate` forced `ask` with the plan file + head; a reply
 *   `always` sets the verdict, `once` grants exactly one executor dispatch
 *   (any other agent's dispatch leaves the grant pending and still runs its
 *   own guards), and `reject` keeps the gate red (that single reply is
 *   consumed). Replies match only asks escalated as plan-gate asks (recorded
 *   per request id, bounded, per session) — a reply to an unrelated permission
 *   ask can never release the gate: an ask is recorded only when its message
 *   carries the plan-ask prefix, or when the parent's escalation latch is
 *   still live (it expires after a few seconds and is cleared by a prompt
 *   reset) and the ask carries no message of its own. The explicit
 *   user waiver is prompt-channel too (see the hard-gate bullet): a
 *   `USER WAIVER:` literal in the user's prompt waives the gate when the
 *   waiver covers this gate — unscoped covers every gate, while naming
 *   configured agent names in the waiver text scopes it to those stages'
 *   gates (this gate is covered by either the plan-reviewer or executor
 *   name), and a scoped waiver stays live until that stage's waiver
 *   allowance is spent (a new user prompt drops the waiver); a
 *   `USER WAIVER:` literal in an agent-composed dispatch prompt is inert,
 *   closing the injection hole. The enforcing dispatch resolves the
 *   session's own directory via `session.get`, falling back to the cached
 *   last-known directory, then `process.cwd()`; a cache replaced by a
 *   different resolved directory journals `session_move` telemetry
 *   (`reason:"re-resolved"`) so an enforced project switch is never
 *   silent. A plan-reviewer APPROVE whose dispatch prompt names
 *   exactly one existing plan file binds the approval to that plan (the
 *   file name + its content key, journaled as `plan`/`planKey` on the
 *   `plan` entry so journal replay restores the identity): a bound
 *   approval goes stale only when THAT plan's content changes
 *   (`plan-edited`) or the file disappears (`plan-missing`) — changes to
 *   other plans do not invalidate it. Unbound approvals (human releases,
 *   prompts naming no single plan, legacy replays) stamp the path-free
 *   plans-dir signature (directory-independent): a same-content move to
 *   another checkout survives, while any plans-dir change drops the
 *   verdict loudly, journaling a replay-inert `STALE` entry
 *   (`signature-mismatch`) rather than a silent mismatch. A replayed
 *   unbound approval carries its journaled dir signature and is validated
 *   against the current dir like a live one (a field-less legacy line is
 *   accepted once and re-stamped); a replayed bound
 *   approval is validated against the current files immediately. The block
 *   and permission-ask preview name the resolved plan — the dispatch's
 *   named plan, then the session's bound plan, then the first sorted plan.
 *   A journal-replayed approval
 *   survives the first prompt after a restart (the resume prompt) and then
 *   every later prompt starts a clean cycle.
 * - Hard gate: `task` dispatches to `reviewer` require a recorded `GATE: PASS`
 *   from test-runner for the current task (a later `GATE: FAIL` un-sets
 *   it), or an explicit user waiver captured at prompt admission — a
 *   `USER WAIVER:` literal in the user's prompt through the `session` prompt
 *   hook or the correlated `session.inbox.enqueued` stream carrying the same
 *   host message id — that covers the reviewer stage: an unscoped waiver
 *   covers every gate but this gate consumes it on the first dispatch it
 *   unlocks, while naming the configured reviewer name scopes the waiver to
 *   reviewer-stage gates and it stays live until that stage's waiver
 *   allowance (max 2 waiver-unblocked dispatches, metered separately from
 *   the ordinary dispatch caps) is spent; a new user prompt drops the waiver. A marker-shaped near-miss of either prompt-channel
 *   literal (`USER WAIVER:` / `PLAN APPROVED:` — a case, separator, or colon
 *   variant) is never admitted: the strict capture is byte-identical, the hit
 *   is journaled as a `marker`/`near-miss` entry, and it surfaces once as a
 *   `[turnstile] marker:` block on the session's next string tool output,
 *   naming the exact expected literal (diagnostic-only, no gate effect).
 *   Under the default `gateEvidence:enforce`
 *   mode a `GATE: PASS` satisfies the gate only when the current task's
 *   bash/shell executions include a matching exit-0 test command (plausibility
 *   via `evidencePattern`); an unverified PASS is journaled `verified:false`
 *   and does not flip the gate. A pending unverified PASS re-checks its
 *   evidence correlation when a child→parent edge resolves late (a background
 *   dispatch) and, as a cheap safety net, again at reviewer-dispatch time —
 *   by then the edge-resolution triggers have normally already promoted, so
 *   the decision-time check usually runs as a no-op — bounded to the parent's
 *   current task window (stamped at prompt admission) so a stale prior-task
 *   execution cannot verify the new task's claim; a parent that never admits
 *   a prompt keeps the unbounded join (fail-open). When the gate is refused
 *   with a pending unverified PASS, the `BLOCKED` message and the journaled
 *   `blocked` entry name the searched sessions (the parent and every child
 *   with journaled executions, each with its attribution reason) so the
 *   missing evidence is diagnosable without guessing. `flag` degrades to the
 *   historical flip-on-trust semantics while still stamping `verified`, and
 *   `off` journals without the field — both documented in the README. A
 *   journal-replayed `GATE: PASS` survives the first prompt after a restart
 *   (the resume prompt) and then every later prompt starts a clean cycle.
 *   When `continuationCarry` is on (default off), a prompt re-admitted in an
 *   unchanged worktree/branch carries that restart-sticky bundle across the
 *   reset via the same one-prompt replay grace the resume uses; the fingerprint
 *   (git worktree/branch, else the project directory) is the only
 *   continuation-vs-new-task signal, so a new task on the same branch carries
 *   too — that is the reason it is opt-in. The carry is gate-scoped: it needs a
 *   prior `GATE: PASS` (a continuation before one still resets fully), and it
 *   carries flags only, never the cleared evidence/dispatch-scope maps.
 * - Loop caps: max 2 `reviewer` / 3 `planner` / 3 `plan-reviewer` / 4
 *   `test-runner` dispatches per task plus a 16-dispatch total budget,
 *   regardless of gate state. Each dispatch leg (planner, plan-reviewer,
 *   test-runner, and the total across all legs) is a mechanical loop backstop;
 *   a prompt-channel user waiver covering a dispatched stage exempts its leg
 *   cap and the total budget without counting toward it (an unscoped waiver
 *   covers every stage — the legacy whole-task exemption; a dispatch prompt
 *   with the `USER WAIVER:` marker is inert); a new user prompt resets the
 *   counters. Every cap exhaustion journals a `type:"escalation"`
 *   entry and throws a STOP-and-escalate `BLOCKED by turnstile:` error telling
 *   the dispatcher to stop re-dispatching and escalate to the user. A block
 *   raised on an edge-registered child (a subagent that never admits a user
 *   prompt) routes the escalation through the child's delivery instead: the
 *   message carries an end-the-turn-and-report clause rather than the
 *   wait-for-a-new-prompt promise, the `blocked`/`escalation` entries stamp
 *   `parent`, and the parent's next prompt releases the child's metering
 *   counters (journaled as a `type:"child-reset"` entry) — a child stuck at
 *   its own cap is not dead-ended by a reset only the parent can trigger.
 * - Dispatch journaling: every `task`/`subagent` dispatch is journaled once at
 *   guard exit, so an allowed dispatch stays byte-identical while a blocked
 *   attempt stamps `blocked:true` (audit distinguishes dispatched from
 *   blocked-and-attempted; `turnstile status` omits that stamp from its
 *   dispatches counter, the block already being counted by the guard's
 *   `blocked` entry).
 * - Reviewer ensemble: every unwaived `task -> reviewer` dispatch is counted
 *   per task and journaled as `{type:"ensemble", sessionID, agent, count}`;
 *   under `reviewEnsemble: enforce` (default) a reviewer `VERDICT: APPROVE`
 *   credits the task (`hasReviewApprove`, the landing gate's release signal)
 *   only when at least two dispatches were journaled for the task. Fewer
 *   leaves the gate red: the incomplete ensemble journals
 *   `blocked/ensemble-incomplete` and trails a `refusedApprove:true` stamp on
 *   the last `ensemble` entry, so replay never re-credits the refused APPROVE
 *   across a restart and the existing permission-ask ladder decides the
 *   outcome. `advise` tracks and journals the count but credits unconditionally
 *   (no gate). A human `always` grant is never gated and journals a
 *   `refusedApprove:false` clearing entry so the human release survives restart;
 *   the count survives a restart via journal replay and one grace prompt.
 *   When the landing gate is already released (`hasReviewApprove` true), a
 *   later reviewer APPROVE delivery is credited without journaling, so a human
 *   grant or mechanical release is never re-stamped as a refusal.
 *   Merging findings stays orchestrator work.
 * - Parent-bucket eviction: live-parent gate buckets (hasGatePass,
 *   hasPlanVerdict, read counter, policyInjected) are registered per
 *   prompt/dispatch/delivery/edge via `markParent`, and the `states` LRU never
 *   evicts a registered parent; unresolved child buckets remain evictable and
 *   can no longer push a live parent out past `maxSessions`.
 * - Horizon: read-counter backstop (warn @8, block @15 whole-file reads),
 *   keyed off the parent session: the increment happens atomically in
 *   `execute.before` (check-then-increment, so the horizon is charged even
 *   for a read that later yields no output); `execute.after` corrects the
 *   charge down when a read produced no string output. The child→parent edge
 *   is awaited (host `session.get` when `session.created` has not yet landed)
 *   before the guard fires, so an in-flight child draws down the parent's
 *   budget; a still-unresolved child self-keys and journals a bounded signal.
 * - Decomposition: `task -> executor` dispatches must cite `chunk-N` / `AC-n`
 *   when the resolved plan — the dispatch's named plan, then the session's
 *   bound plan, then the first sorted decomposed plan — carries a
 *   `## Decomposition` block.
 * - Status: `turnstile status` (the `opencode-turnstile status` CLI) reads
 *   the journal read-only — it never writes — and reports gate + plan state
 *   per parent session: gate flags restored like replay, prompt-channel plan
 *   approvals and waiver events (with channel), last markers, and
 *   dispatch/block/permission counts (a human table or `--json`).
 * - Tool-call policy: `bash`/`shell` commands and `write`/`edit`
 *   target paths are matched in `execute.before` against a configurable
 *   denylist (`src/tool-policy.ts`). Under `toolPolicy.mode: enforce` a match
 *   throws `BLOCKED by turnstile:`; `shadow` journals the would-block without
 *   throwing and `off` is a no-op. Default `bashDeny` and `pathDeny` are empty;
 *   the denylist blocks only what a user configures (git/gh consent rides the
 *   host permission system, and a configured rule blocks the moment it is
 *   added). `session_move` is journaled as telemetry only, never blocked. A
 *   misconfigured/absent host payload fails open with a journal entry rather
 *   than blocking.
 * - Commit-lint: `bash`/`shell` `git commit` messages are validated as
 *   conventional commits when `gitGates.commitMessages` is on (default) —
 *   a `type(scope)!: subject` shape (`type` ∈
 *   `{feat,fix,docs,style,refactor,perf,test,build,ci,chore,revert}`, `!`
 *   optional, subject ≤ 72 chars). The subcommand is resolved positionally
 *   (git global options such as `-C dir` are skipped), so a bare `commit`
 *   word in another subcommand's args is never matched. A non-conventional
 *   message is `BLOCKED by turnstile: commit message '<subject>' is not a
 *   conventional commit — expected type(scope)!: subject` under
 *   `gitGates.mode: enforce` (journaled `reason:"invalid-commit-message"`);
 *   `shadow` journals only, `off` is a no-op. An uninspectable form
 *   (`-F`/`-t`/`--edit`/interactive; `--amend -m` and bundled short-flag
 *   clusters carrying `-m` (e.g. `-am`) are inspectable) is treated as
 *   non-conventional and blocked under `enforce`
 *   (`reason:"commit-message-uninspectable"`): pass the subject with
 *   `git commit -m <subject>`, not an editor or file.
 * - Landing gate: `git push` with no delivery-attributed reviewer
 *   `VERDICT: APPROVE` for the current task is `BLOCKED by turnstile:
 *   push/PR requires a reviewer VERDICT: APPROVE before landing — wait for the
 *   reviewer or escalate to the user` under `gitGates.mode: enforce` (journaled
 *   `reason:"no-landing-approval"`); `shadow` journals only, `off` is a no-op.
 *   Approval is set only when the reviewer's task-result delivery carries
 *   `VERDICT: APPROVE` (a streamed-only verdict in child text does not
 *   satisfy the gate); `gh pr create|merge` flows as landing telemetry unless
 *   the user configures a `bashDeny` rule that denies it first (the two
 *   journal reasons stay disjoint either way), and every `git push` is
 *   journaled as landing telemetry in every mode.
 * - Landing escalation: on a repeat `git push` with no approval and
 *   `gitGates.mode: enforce`, turnstile journals a permission ask
 *   (`reason:"landing"`) and lets `execute.before` pass so the
 *   `permission.evaluate` handler forces a human ask
 *   (`turnstile: push/PR requires a reviewer VERDICT: APPROVE before
 *   landing`). The reply `always` stands a reviewer approval for the task,
 *   `once` grants exactly one push (consumed by the next push), and `reject`
 *   re-blocks and re-arms — the repeat push is the human decision point.
 * - Markers: `GATE:` / `VERDICT:` parsed from task results and child-session
 *   assistant text, deduped per task (streaming re-delivery is ignored); a
 *   marker the host streams across `session.text.delta` chunks is reassembled
 *   in a per-session sliding window before parsing (its completion is
 *   first-sighted once, dedup-suppressing the re-parse), so a split marker
 *   still flips the gate; marker-less outputs from marker-contracted agents
 *   (test-runner/reviewer/
 *   plan-reviewer) are journaled as violations; the summary/divergence
 *   suppression (a child's streamed verdict hiding a marker-less summarized
 *   delivery) is scoped to the plan-reviewer only — reviewer/test-runner
 *   violate on a marker-less delivery even when the child's streamed text
 *   quoted a VERDICT; the last `VERDICT` for a dispatch moves the plan-approval
 *   gate, taken from the task result or, when the host summarized the result,
 *   from that child session's assistant text; the journaled `type:"plan"`
 *   `source` names the winning pipeline; a delivery with no marker on any
 *   source keeps the gate red (parent-keyed, journaled as type `plan`); gate
 *   journal entries are keyed by the parent session so replay restores where
 *   the gates look.
 * - Verdict attribution: every journaled `type:"plan"` entry is
 *   keyed `raw` = an actual child session id, never the parent/session id; a
 *   marker-less parent-keyed re-fire can never journal a `{raw: p1}` phantom
 *   that clobbers a live verification. Attribution is gated on the delivery's
 *   agent being `plan-reviewer`: the child→parent edge is awaited (host
 *   `session.get` when `session.created` has not yet landed), then, for any
 *   self-keyed delivery (its own id is not a registered child, marker-less or
 *   not), candidate discovery attributes it to the unique evidenced registered
 *   child (via the child-text verdict store); an own VERDICT: APPROVE with zero
 *   evidenced candidates is dropped to the error journal (fail-safe), and zero
 *   or more-than-one candidate journals an unattributable `type:"error"` and
 *   returns (fail-open, gate unchanged, nothing mutated). Child-text verdict
 *   observations dedup per (child, marker, source): identical re-delivery and a
 *   cross-source same-marker replay are both suppressed; only a marker flip
 *   journals, and a prompt reset drops the previous
 *   task's children's evidence (scoped to the reset parent, other parents intact).
 * - Verdict attribution, unresolved edge: a self-keyed delivery whose
 *   child→parent edge is unresolved now also claims the unique child evidenced
 *   only in the streaming store — plausibility = a recorded plan-reviewer
 *   dispatch for the parent predates (at-or-before) the observation's recordedAt,
 *   plausibly unique across parents (a verdict with two candidate parents is
 *   ambiguous and excluded). Timestamps are last-wins and cleared on prompt reset,
 *   so a verdict is plausible only within the parent's current task scope. The registered-edge scan is round-scoped the same way — only edge children whose stored verdict was recorded at-or-after the parent's most-recent dispatch are kept, so a prior-round BLOCK left behind by an earlier review is superseded by this round's verdict. Every
 *   self-keyed delivery journals one `type:"attribution"` entry before any mutation
 *   (`{decision, deliveryIsParent, sessionApi, candidates:{edge,unresolved,
 *   plausible} counts, unresolvedIDs, lookup:{session:{attempts,reason}}}`) so the
 *   field can tell the three root-cause hypotheses apart; the `edge` count is the round-scoped one; the attribution is
 *   unanimous-pool driven. A plausible streamed `VERDICT: APPROVE` makes a
 *   self-keyed `BLOCK` unreachable (structural fail-open over BLOCK). The
 *   edge-resolved branch and the never-BLOCK-on-zero-candidates guarantee are
 *   unchanged, so an unattributable parent-keyed delivery stays a single
 *   `/unattributable/` error on fail-open paths.
 * - Event stream: `event.subscribe` feeds marker parsing from streamed child
 *   text; a subscription that throws is journaled per death and
 *   re-subscribed under a cumulative budget of 5 restarts, after which the
 *   disablement journals once and `session.text.*` ingestion stops; a clean
 *   host recycle (a stream that completes without abort) re-subscribes for
 *   free and never spends the budget, and the stream-ended telemetry for a
 *   run of clean closes journals once per stop, not once per close (an
 *   abort/dispose exit stays silent).
 * - Trace: JSONL journal of dispatches, gate transitions, verdicts, blocked
 *   calls, bash commands, errors, and the load heartbeat
 *   (a "setup" entry: plugin version, config digest, hook count). Errors also
 *   cover the stream-end and unresolvable-agent signals; all telemetry only.
 * - Decoding: executor/test-runner/debugger temperature clamped ≤ 0.2;
 *   reviewer temperature = 0.
 * - Config: layered and read once at setup: code defaults ⊕
 *   `~/.config/opencode/turnstile.json` ⊕ env (`TURNSTILE_TRACE`,
 *   `TURNSTILE_METRICS_DIR`, `TURNSTILE_CONFIG`) ⊕ injected options (tests).
 *   Invalid keys are ignored and journaled (fail-open); restart to apply.
 *
 * Fail-open by design: every hook body is guarded; an internal error is
 * journaled and the tool call proceeds. Removing this file leaves the
 * pipeline functional (prompt contracts alone).
 *
 * Module layout: one boundary per file; this file is the thin entry point
 * the host loads, holding only the module shape and setup composition:
 * - `src/types.ts`: host wire shapes and gate-state structures.
 * - `src/journal.ts`: telemetry persistence (JSONL journal + trace).
 * - `src/state.ts`: per-session gate state shape, snapshot and pipeline
 *   rendering, replay-merge carry.
 * - `src/ledger.ts`: LRU session maps, child verdict store, journal replay,
 *   eviction protection.
 * - `src/fingerprint.ts`: worktree/branch identity and the GATE-SCOPED carry
 *   predicate.
 * - `src/markers.ts`: GATE/VERDICT parsing and dedup.
 * - `src/gates.ts`: composition of the per-gate enforcement modules; the
 *   `Gates` interface is the host-facing contract.
 * - `src/gates-dispatch.ts`: reviewer dispatch gate, loop caps, read
 *   horizon, ensemble completeness.
 * - `src/gates-plan.ts`: plan-approval and decomposition gates, with the
 *   plans-dir scan and its cache.
 * - `src/gates-common.ts`: shared `BlockError` and waiver coverage
 *   semantics.
 * - `src/tool-policy.ts`: stateless denylist matching for bash/shell and
 *   write/edit tools in `execute.before`.
 * - `src/delivery.ts`: host payload delivery — result-shape classification,
 *   text mutation (policy head/tail, config/marker blocks), candidate-key
 *   tables, ask-message prefixes.
 * - `src/hooks-core.ts`: shared hook state and services, built once per
 *   setup (`TurnstileContext`: config, journaler, gates, ledger, admission,
 *   marker parsing, verdict attribution).
 * - `src/hooks-session.ts`: session-surface hook bodies (prompt, generate,
 *   compaction).
 * - `src/hooks-permission.ts`: permission-surface hook body (evaluate:
 *   plan-gate and landing-gate escalation).
 * - `src/hooks-tool.ts`: tool-surface hook bodies (execute.before gating,
 *   execute.after observation).
 * - `src/hooks-events.ts`: event-surface stream (consume + supervise under
 *   the restart budget).
 * - `src/setup.ts`: wiring only — hook registration, heartbeat, lifecycle.
 */
import { createTurnstile } from "./src/setup.ts"
import type { Host, TurnstileOptions } from "./src/types.ts"

/** The async setup function a plugin instance hands to the host. */
export type SetupFn = (h: Host) => Promise<(() => void) | void>

/**
 * Creates a turnstile plugin bound to the given host context.
 * @param host The OpenCode host context, or null in degraded loads.
 * @param opts Injected config/env overrides (tests); defaults to env.
 * @returns The plugin's setup function; resolves to a cleanup disposer.
 */
export const turnstile = (host: Host | undefined | null, opts?: TurnstileOptions): SetupFn =>
  createTurnstile(host, opts)

/** The module object the OpenCode host loads. */
const module: {
  id: string
  server: () => Promise<Record<string, never>>
  setup: (ctx: Host, opts?: TurnstileOptions) => Promise<(() => void) | void>
} = {
  id: "turnstile",
  // Legacy v1 shape kept for loaders that require `server`; the active v2
  // path is `setup` (same pattern as the working orca-opencode-status plugin).
  server: async (): Promise<Record<string, never>> => ({}),
  setup: async (ctx: Host, opts?: TurnstileOptions): Promise<(() => void) | void> =>
    turnstile(ctx, opts)(ctx),
}

export default module
