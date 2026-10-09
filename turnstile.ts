/**
 * turnstile — runtime enforcement of the AGENTS.md pipeline contracts.
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
 *   WAIVER:` literal in the prompt). Plan-file changes invalidate the
 *   approval, forcing re-review after a re-plan.
 * - Hard gate: `task` dispatches to `reviewer` require a recorded `GATE: PASS`
 *   from test-runner for the current task (a later `GATE: FAIL` un-sets
 *   it), or an explicit user waiver (the dispatch prompt must contain the
 *   literal marker `USER WAIVER:`).
 * - Round cap: max 2 `task -> reviewer` dispatches per task.
 * - Horizon: read-counter backstop (warn @8, block @15 whole-file reads).
 * - Decomposition: `task -> executor` dispatches must cite `chunk-N` / `AC-n`
 *   when a plan file with a `## Decomposition` block exists.
 * - Markers: `GATE:` / `VERDICT:` parsed from task results and child-session
 *   assistant text, deduped per task (streaming re-delivery is ignored);
 *   marker-less outputs from marker-contracted agents (test-runner/reviewer/
 *   plan-reviewer) are journaled as violations; a plan-reviewer result's
 *   last `VERDICT` moves the plan-approval gate (parent-keyed, journaled as
 *   type `plan`); gate journal entries are keyed by the parent session so
 *   replay restores where the gates look.
 * - Trace: JSONL journal of dispatches, gate transitions, verdicts, blocked
 *   calls, bash commands, errors.
 * - Decoding: executor/test-runner/debugger temperature clamped ≤ 0.2;
 *   reviewer temperature = 0.
 * - Config: layered and read once at setup — code defaults ⊕
 *   `~/.config/opencode/turnstile.json` ⊕ env (`TURNSTILE_TRACE`,
 *   `TURNSTILE_METRICS_DIR`, `TURNSTILE_CONFIG`) ⊕ injected options (tests).
 *   Invalid keys are ignored and journaled (fail-open); restart to apply.
 *
 * Fail-open by design: every hook body is guarded; an internal error is
 * journaled and the tool call proceeds. Removing this file leaves the
 * pipeline functional (prompt contracts alone).
 *
 * Module layout — one boundary per file; this file is the thin entry point
 * the host loads, holding only the module shape and setup composition:
 * - `src/types.ts` — host wire shapes and gate-state structures.
 * - `src/journal.ts` — telemetry persistence (JSONL journal + trace).
 * - `src/state.ts` — per-session gate state, session mapping, journal replay.
 * - `src/markers.ts` — GATE/VERDICT parsing and dedup.
 * - `src/gates.ts` — enforcement decisions (plan-approval gate, reviewer
 *   gate, read horizon, decomposition).
 * - `src/setup.ts` — hook registration and the stream-event loop.
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
