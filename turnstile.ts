/**
 * turnstile: runtime enforcement of the orchestrator pipeline contracts.
 *
 * - Orchestrator policy: injected into the primary (parent) session per task
 *   via the `execute.after` hook — the `ORCHESTRATOR_POLICY` block from
 *   `src/policy.ts` is prepended to the first `task`/`subagent` result delivery
 *   per task, with per-task idempotency via `GateState.policyInjected`, fully
 *   guarded and fail-open (a broken injection journals `type:"policy"` and
 *   proceeds). Nothing is written to an instructions file at install time — the
 *   AGENTS.md contract block is a historical install step, removed.
 *
 * Written for OpenCode v2.x promise-plugin host (`{ id, setup }`):
 * - `ctx.tool.hook("execute.before" | "execute.after", cb)`
 * - `ctx.session.hook("prompt" | "generate" | "compaction", cb)`
 * - `ctx.event.subscribe({ signal })`
 *
 * Enforced mechanically:
 * - Plan-approval gate: `task` dispatches to `executor` require a current
 *   plan approval whenever a plan file exists in `.opencode/plans/`: a
 *   plan-reviewer `VERDICT: APPROVE`, a prompt-channel human approval, or a
 *   permission-prompt human approval. A prompt-channel approval is a
 *   user-authored prompt (a `PLAN APPROVED:` literal in the user's prompt sets
 *   the plan verdict and records human provenance) and replays identically to
 *   a plan-reviewer verdict. When none holds, the first executor dispatch
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
 *   `USER WAIVER:` literal in the user's prompt waives the gate; a
 *   `USER WAIVER:` literal in an agent-composed dispatch prompt is inert —
 *   issue #34's injection hole, now closed. Plan-content changes invalidate
 *   approvals issued against the previous plans-dir signature (replayed
 *   approvals are accepted once, then stamped). A journal-replayed approval
 *   survives the first prompt after a restart (the resume prompt) and then
 *   every later prompt starts a clean cycle.
 * - Hard gate: `task` dispatches to `reviewer` require a recorded `GATE: PASS`
 *   from test-runner for the current task (a later `GATE: FAIL` un-sets
 *   it), or an explicit user waiver (`USER WAIVER:` literal in the user's
 *   prompt). Under the default `gateEvidence:enforce`
 *   mode a `GATE: PASS` satisfies the gate only when the current task's
 *   bash/shell executions include a matching exit-0 test command (plausibility
 *   via `evidencePattern`); an unverified PASS is journaled `verified:false`
 *   and does not flip the gate. `flag` degrades to the historical
 *   flip-on-trust semantics while still stamping `verified`, and `off`
 *   journals without the field — both documented in the README. A
 *   journal-replayed `GATE: PASS` survives the first prompt after a restart
 *   (the resume prompt) and then every later prompt starts a clean cycle.
 * - Loop caps: max 2 `reviewer` / 3 `planner` / 3 `plan-reviewer` / 4
 *   `test-runner` dispatches per task plus a 16-dispatch total budget,
 *   regardless of gate state. Each dispatch leg (planner, plan-reviewer,
 *   test-runner, and the total across all legs) is a mechanical loop backstop;
 *   a prompt-channel user waiver bypasses everything without counting toward
 *   it (a dispatch prompt with the `USER WAIVER:` marker is inert); a new user
 *   prompt resets the counters. Every cap exhaustion journals a `type:"escalation"`
 *   entry and throws a STOP-and-escalate `BLOCKED by turnstile:` error telling
 *   the dispatcher to stop re-dispatching and escalate to the user (so a
 *   subagent stuck at its own cap is not dead-ended by a "wait for a new prompt"
 *   hint).
 * - Parent-bucket eviction: live-parent gate buckets (hasGatePass,
 *   hasPlanVerdict, read counter, policyInjected) are registered per
 *   prompt/dispatch/delivery/edge via `markParent`, and the `states` LRU never
 *   evicts a registered parent; unresolved child buckets remain evictable and
 *   can no longer push a live parent out past `maxSessions`.
 * - Horizon: read-counter backstop (warn @8, block @15 whole-file reads),
 *   keyed off the parent session: the child→parent edge is awaited
 *   (host `session.get` when `session.created` has not yet landed) before the
 *   guard fires, so an in-flight child draws down the parent's budget; a
 *   still-unresolved child self-keys and journals a bounded signal.
 * - Decomposition: `task -> executor` dispatches must cite `chunk-N` / `AC-n`
 *   when a plan file with a `## Decomposition` block exists.
 * - Status: `turnstile status` (the `opencode-turnstile status` CLI) reads
 *   the journal read-only — it never writes — and reports gate + plan state
 *   per parent session: gate flags restored like replay, prompt-channel plan
 *   approvals and waiver events (with channel), last markers, and
 *   dispatch/block/permission counts (a human table or `--json`).
 * - Tool-call policy: `bash`/`shell` commands and `write`/`edit`
 *   target paths are matched in `execute.before` against a configurable
 *   denylist (`src/tool-policy.ts`). Under `toolPolicy.mode: enforce` a match
 *   throws `BLOCKED by turnstile:`; `shadow` journals the would-block without
 *   throwing and `off` is a no-op. Default `bashDeny` blocks the git-protective
 *   operations in `src/policy.ts` (worktree, branch `switch`/`checkout`, `merge`,
 *   `gh pr create|merge`); `pathDeny` defaults empty. `session_move` is journaled
 *   as telemetry only, never blocked. A misconfigured/absent host payload fails
 *   open with a journal entry rather than blocking.
 * - Commit-lint: `bash`/`shell` `git commit -m '<subject>'` messages are
 *   validated as conventional commits when `gitGates.commitMessages` is on
 *   (default) — a `type(scope)!: subject` shape (`type` ∈
 *   `{feat,fix,docs,style,refactor,perf,test,build,ci,chore,revert}`, `!`
 *   optional, subject ≤ 72 chars). A non-conventional message is
 *   `BLOCKED by turnstile: commit message '<subject>' is not a conventional
 *   commit — expected type(scope)!: subject` under `gitGates.mode: enforce`
 *   (journaled `reason:"invalid-commit-message"`); `shadow` journals only,
 *   `off` is a no-op. An uninspectable form (`-F`/`-t`/`--edit`/interactive;
 *   `--amend -m` is inspectable) is treated as non-conventional and blocked
 *   under `enforce` (`reason:"commit-message-uninspectable"`): pass the subject
 *   with `git commit -m <subject>`, not an editor or file.
 * - Landing gate: `git push` with no delivery-attributed reviewer
 *   `VERDICT: APPROVE` for the current task is `BLOCKED by turnstile:
 *   push/PR requires a reviewer VERDICT: APPROVE before landing — wait for the
 *   reviewer or escalate to the user` under `gitGates.mode: enforce` (journaled
 *   `reason:"no-landing-approval"`); `shadow` journals only, `off` is a no-op.
 *   Approval is set only when the reviewer's task-result delivery carries
 *   `VERDICT: APPROVE` (a streamed-only verdict in child text does not
 *   satisfy the gate); `gh pr create|merge` stays denied by the default
 *   `bashDeny` list (disjointly journaled), and every `git push` is journaled
 *   as landing telemetry in every mode.
 * - Landing escalation: on a repeat `git push` with no approval and
 *   `gitGates.mode: enforce`, turnstile journals a permission ask
 *   (`reason:"landing"`) and lets `execute.before` pass so the
 *   `permission.evaluate` handler forces a human ask
 *   (`turnstile: push/PR requires a reviewer VERDICT: APPROVE before
 *   landing`). The reply `always` stands a reviewer approval for the task,
 *   `once` grants exactly one push (consumed by the next push), and `reject`
 *   re-blocks and re-arms — the repeat push is the human decision point.
 * - Markers: `GATE:` / `VERDICT:` parsed from task results and child-session
 *   assistant text, deduped per task (streaming re-delivery is ignored);
 *   marker-less outputs from marker-contracted agents (test-runner/reviewer/
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
 *   so a verdict is plausible only within the parent's current task scope. Every
 *   self-keyed delivery journals one `type:"attribution"` entry before any mutation
 *   (`{decision, deliveryIsParent, sessionApi, candidates:{edge,unresolved,
 *   plausible} counts, unresolvedIDs, lookup:{session:{attempts,reason}}}`) so the
 *   field can tell the three root-cause hypotheses apart; the attribution is
 *   unanimous-pool driven. A plausible streamed `VERDICT: APPROVE` makes a
 *   self-keyed `BLOCK` unreachable (structural fail-open over BLOCK). The
 *   edge-resolved branch and the never-BLOCK-on-zero-candidates guarantee are
 *   unchanged, so an unattributable parent-keyed delivery stays a single
 *   `/unattributable/` error on fail-open paths.
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
 * - `src/state.ts`: per-session gate state, session mapping, journal replay.
 * - `src/markers.ts`: GATE/VERDICT parsing and dedup.
 * - `src/gates.ts`: enforcement decisions (plan-approval gate, reviewer
 *   gate, read horizon, decomposition).
 * - `src/tool-policy.ts`: stateless denylist matching for bash/shell and
 *   write/edit tools in `execute.before`.
 * - `src/setup.ts`: hook registration and the stream-event loop.
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
