/**
 * @fileoverview Shared type definitions for the turnstile plugin: the
 * OpenCode v2 host wire shape, hook payloads, and gate-state structures.
 *
 * The host boundary is intentionally permissive: payloads crossing the
 * plugin boundary are typed as optional fields so a host that omits or
 * reshapes a field fails open instead of failing hard.
 */

/** Task dispatch input as delivered by the host's `task`/`subagent` tools. */
export interface TaskInput {
  subagent_type?: unknown
  agent?: unknown
  subagent?: unknown
  prompt?: unknown
  description?: unknown
  command?: unknown
  cmd?: unknown
  /**
   * Target path as delivered by the host's `write`/`edit` tools. The shape is
   * unconfirmed on v2.0.27, hence `unknown`; `src/tool-policy.ts` reads it as a
   * documented candidate (`filePath ?? path`) and fails open when absent.
   */
  filePath?: unknown
  /** Alternate candidate key for the same write/edit target path. */
  path?: unknown
}

/** Tool result as delivered by the host's `execute.after` hook. */
export interface ToolResult {
  output?: unknown
  title?: unknown
  input?: unknown
  metadata?: { exit?: unknown; exitCode?: unknown; code?: unknown }
}

/** Payload of the `tool.execute.before` and `tool.execute.after` hooks. */
export interface ToolHookEvent {
  tool?: unknown
  /**
   * Dispatched subagent/agent name, observed on v2.0.27
   * execute.before/after payloads. The host contract does not type this
   * field, hence `unknown`; `src/setup.ts` reads it (against the configured
   * agent-name set) to skip injecting orchestrator policy into child
   * sessions.
   */
  agent?: unknown
  sessionID?: unknown
  input?: TaskInput
  result?: ToolResult
}

/** Payload of the `session.prompt` hook. */
export interface PromptHookProperties {
  sessionID?: unknown
}

/** Generation draft passed to the `session.generate` hook. */
export interface GenerateDraft {
  agent?: unknown
  options?: { temperature?: number }
}

/** Compaction draft passed to the `session.compaction` hook. */
export interface CompactionDraft {
  system?: Array<{ type: string; text?: string }>
}

/** Session record returned by the host's `session.get`. */
export interface SessionRecord {
  parentID?: unknown
  data?: { parentID?: unknown }
}

/** Properties bag carried by host stream events. */
export interface EventProperties {
  type?: unknown
  sessionID?: unknown
  parentID?: unknown
  directory?: unknown
  location?: { directory?: unknown }
  part?: { type?: unknown; text?: unknown; sessionID?: unknown }
  text?: unknown
  delta?: unknown
  error?: unknown
}

/** A single host stream event delivered by `event.subscribe`. */
export interface StreamEvent {
  type: string
  data?: EventProperties
  properties?: EventProperties
}

/**
 * Evidence-correlation mode for the reviewer gate. `enforce` (default) refuses
 * to flip `hasGatePass` on a `GATE: PASS` with no correlated exit-0
 * bash/shell test execution; `flag` flips but still stamps `verified`;
 * `off` behaves exactly as before (no correlation).
 */
export type GateEvidenceMode = "enforce" | "flag" | "off"

/**
 * Enforcement mode for the tool-call denylist policy in `src/tool-policy.ts`.
 * `enforce` (default) blocks matching bash/shell commands and write/edit paths;
 * `shadow` journals the would-block without throwing (adoption path); `off` is
 * a silent no-op escape hatch. Mirrors `GateEvidenceMode`.
 */
export type ToolPolicyMode = "enforce" | "shadow" | "off"

/**
 * Denylist policy governing the tools that flow through `execute.before`:
 * bash/shell commands and write/edit target paths. Defaults encode the
 * git-protective prose of `src/policy.ts` verbatim in `bashDeny` and leave
 * `pathDeny` empty (ordinary editing is covered — a decision is made and, on
 * block, journaled — with no default blocks, so it never breaks until a user
 * configures `pathDeny`). Regex sources are case-insensitive, compiled once at
 * setup, and matched with `RegExp.test`.
 */
export interface TurnstileToolPolicy {
  /** Enforcement mode: `enforce` (default), `shadow`, or `off`. */
  mode: ToolPolicyMode
  /** Case-insensitive regex sources matched against bash/shell commands. */
  bashDeny: string[]
  /** Case-insensitive regex sources matched against write/edit target paths. */
  pathDeny: string[]
  /** Journal `session_move` dispatches (never blocks). */
  observeSessionMove: boolean
}

/** Gate state for one parent session. */
export interface GateState {
  hasGatePass: boolean
  /**
   * Last `GATE: PASS` rejected for lack of correlated test execution (an
   * unverified claim under `enforce`); "" when none. Cleared on a green flip,
   * on `GATE: FAIL`, and on a task reset. Task-scoped: never carried through
   * `mergeAfterReplay`.
   */
  unverifiedPass: string
  /** True when this task's plan has a current plan-reviewer APPROVE. */
  hasPlanVerdict: boolean
  /**
   * True once this task's first parent task/subagent result delivery has
   * carried the injected orchestrator policy forward into model context.
   * Cleared per task by `ledger.resetState()` on every user prompt, so the
   * policy is re-injected on each task (the intended per-task re-supply,
   * which also re-applies it after compaction).
   */
  policyInjected: boolean
  /**
   * Dedup key → raw session ID that first observed the marker; written
   * alongside `seen.add` by `observeMarker`. Tracks first-sight provenance so
   * a dedup hit from a different raw session can be accounted as cross-child
   * suppression (a different raw session than the stored provenance).
   *
   * Holds gate-kind provenance only: verdict-kind streaming dedup lives in the
   * per-child `childVerdicts` store, not here.
   */
  seenFrom: Map<string, string>
  /**
   * Cross-child suppressions pending attribution on the next emitted
   * `MarkerEvent` (a `GATE:` dedup hit whose raw session differs from the
   * provenance stored in `seenFrom`). Read and zeroed when an event emits; 0 on
   * a fresh bucket. Verdict-kind deliveries use the per-child store instead, so
   * this counter is now gated on gate-kind hits only.
   */
  suppressedPending: number
  reviewRounds: number
  reads: number
  seen: Set<string>
  /**
   * Plans-dir signature the approval was issued against; "" means
   * unknown (journal-replayed or pre-stamp) and is accepted once, then
   * stamped, on the next enforcing dispatch.
   */
  plansSignature: string
  /**
   * True while a journal-replayed bucket's unconsumed one-prompt grace is
   * outstanding: the next reset carries hasGatePass/hasPlanVerdict forward
   * instead of wiping them. Cleared by the first reset; re-granted only by
   * journal replay at ledger creation (process restart or plugin reload).
   */
  replayGrace: boolean
}

/** One first-sight marker observation returned by the marker parser. */
export interface MarkerEvent {
  kind: "gate" | "verdict"
  marker: string
  result?: "PASS" | "FAIL"
  rounds?: number
  /**
   * Evidence verdict of a `PASS` gate event: true (correlated exit-0 test
   * execution exists for this session) or false (flagged, unverified). Present
   * only on `PASS` gate events when the evidence mode is not `"off"`.
   */
  verified?: boolean
  /** Evidence mode at the time this event was stamped, when `verified` is. */
  mode?: GateEvidenceMode
  /** Marker matches observed in the same text but not journaled
   *  (latest-wins policy); 0 when this was the only match. */
  suppressed: number
}

/**
 * The latest `VERDICT:` marker observation for a single child session and the
 * provenance label of the pipeline that carried it. The store is
 * verdict-kind only: only `VERDICT:` markers are stored (never `GATE:`), so a
 * GATE-only child can never suppress a plan-reviewer bare-output violation.
 *
 * It is also the streamed-verdict observation ledger: `recordChildVerdict`
 * returns whether the observation changed (first-record, marker flip, or
 * source change), so a caller can distinguish a flip from an identical
 * re-record without re-reading the store. Gate-kind (`GATE:`) dedup still
 * lives in `GateState.seen`; this store is verdict-kind only.
 */
export interface ChildVerdict {
  /** Last `VERDICT:` marker observed for the child, or "" when none. */
  marker: string
  /** Pipeline provenance label, e.g. "child-text" or "child-message". */
  source: string
  /**
   * `Date.now()` when this verdict was last recorded; `0` on the empty default.
   *
   * Used by the plausibility join: an unresolved-child verdict is
   * plausible for a parent only when it was recorded at-or-after that parent's
   * most recent plan-reviewer dispatch.
   */
  recordedAt: number
}

/** Agent names turnstile recognizes in dispatches and generation drafts. */
export interface TurnstileAgents {
  /** Planner: first in the pipeline; the primary session's plan gate gates dispatch. */
  planner: string
  reviewer: string
  /** Plan reviewer: adversarial review of the implementation plan. */
  planReviewer: string
  executor: string
  testRunner: string
  debugger: string
  /** Agents contracted to emit GATE/VERDICT markers (bare-output check). */
  bareOutput: string[]
}

/**
 * Layered plugin configuration. Defaults in `src/config.ts`; user overrides
 * via `~/.config/opencode/turnstile.json`, then env vars, then injected
 * options (tests). Read once at setup; restart sessions to apply.
 */
export interface TurnstileConfig {
  /** Directory holding the JSONL journal and trace files. */
  metricsDir: string
  /** Rotate a journal file when it exceeds this many bytes. */
  journalMaxBytes: number
  /** Number of rotated journal generations to keep. */
  journalMaxGenerations: number
  /**
   * Max reviewer dispatches per task; the cap counts dispatches, applies
   * regardless of gate state, and is bypassed by an explicit waiver.
   */
  maxReviewerRounds: number
  /** Cap on tracked sessions (LRU); oldest state evicted beyond this. */
  maxSessions: number
  /** Whole-file read count at which the horizon warning is injected. */
  readWarn: number
  /** Whole-file read count at which further reads are blocked. */
  readBlock: number
  /** Literal marker that waives the reviewer gate when in the prompt. */
  waiverMarker: string
  /** Project-relative directory scanned for `## Decomposition` plans. */
  plansDir: string
  /** Whether the human-readable trace file is written (JSONL journal always). */
  trace: boolean
  /** Agent names turnstile recognizes. */
  agents: TurnstileAgents
  /** Gate marker regex source (compiled with `gm`). */
  gateMarker: string
  /** Verdict marker regex source (compiled with `gm`). */
  verdictMarker: string
  /**
   * Evidence-correlation mode for the reviewer gate: `enforce` (default)
   * requires a correlated exit-0 bash/shell test execution before a
   * `GATE: PASS` flips the gate; `flag` flips yet stamps `verified`; `off`
   * keeps the pre-evidence behavior. See `src/evidence.ts`.
   */
  gateEvidence: GateEvidenceMode
  /**
   * Case-insensitive regex source a successful (exit-0) bash/shell command
   * must match to count as test execution. Overridable for non-JS/other
   * toolchains; the default covers npm/pnpm/yarn/bun/deno/node --test/
   * pytest/make test/go test/cargo test.
   */
  evidencePattern: string
  /**
   * Denylist policy for bash/shell and write/edit tools in `execute.before`.
   * Default `mode` is `enforce`; the default `bashDeny` encodes the
   * git-protective prose of `src/policy.ts`, `pathDeny` defaults empty, and
   * `observeSessionMove` journals `session_move` dispatches without blocking.
   * See `src/tool-policy.ts`.
   */
  toolPolicy: TurnstileToolPolicy
}

/** Options accepted by the plugin factory; tests inject config and env here. */
export interface TurnstileOptions {
  /** Overrides applied last, on top of file and env layers. */
  config?: Partial<TurnstileConfig>
  /** Environment for config resolution; defaults to `process.env`. */
  env?: Record<string, string | undefined>
}

/**
 * The v2 promise-plugin host shape (verified against opencode v2.0.22).
 *
 * Hook callback payloads are typed `any` at this wire boundary only; the
 * host does not expose stable payload types. Every function turnstile
 * defines has concrete parameter and return types; the `any` ends here.
 */
export type Host = {
  tool?: {
    hook?: (name: string, cb: (event: any) => Promise<void> | void) => Promise<unknown>
  }
  session?: {
    hook?: (name: string, cb: (input: any) => Promise<void> | void) => Promise<unknown>
    get?: (input: { sessionID: string }, options?: any) => Promise<SessionRecord | undefined>
  }
  event?: {
    subscribe?: (options?: { signal?: AbortSignal }) => AsyncIterable<StreamEvent>
  }
}
