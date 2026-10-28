/**
 * turnstile: runtime enforcement of the orchestrator pipeline contracts.
 *
 * An OpenCode v2 promise-plugin (`{ id: "turnstile", server, setup }` —
 * `server` is a legacy v1 shim kept for loaders that require it) that
 * mechanically enforces the pipeline planner → plan-reviewer → executor →
 * test-runner → reviewer by interposing on the host's hook surface
 * (`execute.before`/`after`, `prompt`/`generate`/`compaction`,
 * `permission.evaluate`, `event.subscribe`). Enforcement is fail-open:
 * every hook body is guarded, internal errors are journaled, and the tool
 * call proceeds — only deliberate `BLOCKED by turnstile:` gate decisions
 * throw.
 *
 * Contract-level rules (the enforced detail — gates, state fields, escape
 * ladders, replay, journal schema — is documented in `docs/architecture.md`,
 * the authoritative reference):
 * - Marker authority: a `GATE:` flips state only from the configured
 *   test-runner and a `VERDICT:` only from `reviewer`/`plan-reviewer`
 *   (each in `agents.bareOutput`); text from any other or unresolved
 *   emitter is journaled `suppressed` and flips nothing.
 * - Prompt-channel provenance: `USER WAIVER:` and `PLAN APPROVED:` are
 *   honored only from the user's own prompt at admission, never from an
 *   agent-composed dispatch prompt. The same channel carries the session
 *   suspend/resume markers (`TURNSTILE OFF:` / `TURNSTILE ON:` by default,
 *   kill-switched by `allowSuspend`): while suspended, decisions keep
 *   computing and journaling but nothing throws `BLOCKED`, and a resume
 *   starts from fresh state — journaled and replay-safe across restarts.
 * - Orchestration prose is injected at runtime, not installed to a file:
 *   the `execute.after` body prepends the policy head (`src/policy.ts`)
 *   once per task and appends a per-delivery `PIPELINE:` status tail to
 *   pipeline-stage deliveries, so a fresh install can never lose the
 *   policy. Per-agent instruction lines live in each `agents/<name>.md`.
 * - Config resolves once at setup: code defaults ⊕
 *   `~/.config/opencode/turnstile.json` ⊕ env (`TURNSTILE_TRACE`,
 *   `TURNSTILE_METRICS_DIR`, `TURNSTILE_CONFIG`) ⊕ injected options.
 *   Invalid keys are ignored and journaled; restart to apply.
 *
 * Module layout — one boundary per file; this file stays the thin entry
 * point (shape + factory only). Update this list when `src/` changes:
 * - `src/types.ts`: host wire shapes, `GateState`, `TurnstileConfig`.
 * - `src/config.ts`: layered config, per-key validation, `configDigest`.
 * - `src/host-compat.ts`: host-version guard (semver, shipped range).
 * - `src/journal.ts`: JSONL journal + trace persistence, fail-open appends.
 * - `src/state.ts`: gate-state shape, snapshot/pipeline rendering, replay
 *   merge.
 * - `src/ledger.ts`: per-parent LRU buckets, edges, verdict store, journal
 *   replay, eviction protection.
 * - `src/fingerprint.ts`: worktree/branch identity, carry predicate.
 * - `src/markers.ts`: GATE/VERDICT parsing, dedup, waiver scope parsing.
 * - `src/gates.ts`: composition of the gate modules (`Gates` contract).
 * - `src/gates-dispatch.ts`: reviewer gate, loop caps, read horizon,
 *   ensemble.
 * - `src/gates-plan.ts`: plan-approval and decomposition gates, plans scan.
 * - `src/gates-common.ts`: `BlockError`, waiver coverage semantics.
 * - `src/tool-policy.ts`: denylist matching, commit lint, landing gate.
 * - `src/empty-diff.ts`: landing empty-diff probe (pure ref-equality check).
 * - `src/evidence.ts`: GATE↔exit-0 test-execution correlation.
 * - `src/bounded.ts`: shared bounded-FIFO trim loops.
 * - `src/policy.ts`: orchestrator policy prose (`orchestratorPolicyFor`).
 * - `src/summary.ts`: session-end summary counting + formatting.
 * - `src/delivery.ts`: result-shape classification, text mutation,
 *   ask-message prefixes.
 * - `src/hooks-core.ts`: shared hook state/services (`TurnstileContext`).
 * - `src/hooks-session.ts`: prompt, generate, compaction hook bodies.
 * - `src/hooks-permission.ts`: permission-escalation hook body.
 * - `src/hooks-tool.ts`: execute.before gating, execute.after observation.
 * - `src/hooks-events.ts`: event stream consume + supervised re-subscribe.
 * - `src/setup.ts`: wiring only — registration, heartbeat, lifecycle.
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
  // path is `setup` (an empty stub object satisfies any v1 loader).
  server: async (): Promise<Record<string, never>> => ({}),
  setup: async (ctx: Host, opts?: TurnstileOptions): Promise<(() => void) | void> =>
    turnstile(ctx, opts)(ctx),
}

export default module
