/**
 * turnstile: runtime enforcement of the orchestrator pipeline contracts.
 *
 * - Orchestrator policy: injected into the primary (parent) session per task
 *   via the `execute.after` hook — the `ORCHESTRATOR_POLICY` block from
 *   `src/policy.ts` is prepended to the first `task`/`subagent` result delivery
 *   per task, with per-task idempotency via `GateState.policyInjected`, fully
 *   guarded and fail-open (a broken injection journals `type:"policy"` and
 *   proceeds). Nothing is written to an instructions file at install time — the
 *   AGENTS.md contract block is a historical install step, removed in issue #28.
 *
 * Written for OpenCode v2.x promise-plugin host (`{ id, setup }`):
 * - `ctx.tool.hook("execute.before" | "execute.after", cb)`
 * - `ctx.session.hook("prompt" | "generate" | "compaction", cb)`
 * - `ctx.event.subscribe({ signal })`
 *
 * Enforced mechanically:
 * - Plan-approval gate: `task` dispatches to `executor` require a current
 *   plan-reviewer `VERDICT: APPROVE` for the task whenever a plan file
 *   exists in `.opencode/plans/`, or an explicit user waiver (`USER
 *   WAIVER:` literal in the prompt). Plan-content changes invalidate approvals
 *   issued against the previous plans-dir signature (replayed approvals are
 *   accepted once, then stamped). A journal-replayed approval survives the
 *   first prompt after a restart (the resume prompt) and then every later
 *   prompt starts a clean cycle.
 * - Hard gate: `task` dispatches to `reviewer` require a recorded `GATE: PASS`
 *   from test-runner for the current task (a later `GATE: FAIL` un-sets
 *   it), or an explicit user waiver (the dispatch prompt must contain the
 *   literal marker `USER WAIVER:`). Under the default `gateEvidence:enforce`
 *   mode a `GATE: PASS` satisfies the gate only when the current task's
 *   bash/shell executions include a matching exit-0 test command (plausibility
 *   via `evidencePattern`); an unverified PASS is journaled `verified:false`
 *   and does not flip the gate. `flag` degrades to the historical
 *   flip-on-trust semantics while still stamping `verified`, and `off`
 *   journals without the field — both documented in the README. A
 *   journal-replayed `GATE: PASS` survives the first prompt after a restart
 *   (the resume prompt) and then every later prompt starts a clean cycle.
 * - Round cap: max 2 `task -> reviewer` dispatches per task, regardless of gate
 *   state; a dispatch with the `USER WAIVER:` marker bypasses the cap without
 *   counting toward it; a new user prompt resets it.
 * - Horizon: read-counter backstop (warn @8, block @15 whole-file reads).
 * - Decomposition: `task -> executor` dispatches must cite `chunk-N` / `AC-n`
 *   when a plan file with a `## Decomposition` block exists.
 * - Tool-call policy (issue #32): `bash`/`shell` commands and `write`/`edit`
 *   target paths are matched in `execute.before` against a configurable
 *   denylist (`src/tool-policy.ts`). Under `toolPolicy.mode: enforce` a match
 *   throws `BLOCKED by turnstile:`; `shadow` journals the would-block without
 *   throwing and `off` is a no-op. Default `bashDeny` blocks the git-protective
 *   operations in `src/policy.ts` (worktree, branch `switch`/`checkout`, `merge`,
 *   `gh pr create|merge`); `pathDeny` defaults empty. `session_move` is journaled
 *   as telemetry only, never blocked. A misconfigured/absent host payload fails
 *   open with a journal entry rather than blocking.
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
 * - Verdict attribution (issue #51): every journaled `type:"plan"` entry is
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
