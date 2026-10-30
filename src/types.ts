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

/**
 * Tool result as delivered by the host's `execute.after` hook. Two host
 * delivery shapes are observed: the v1 `task` shape, where `output` is the
 * child's result string and the event is child-keyed; and the v2 `subagent`
 * shape, where `output` is a structured object (`{ sessionID, status,
 * output }`) whose `output` string is the child's canonical result text,
 * the child session ID rides on `metadata.sessionID` (the structured
 * `output` object carries it too), and `content` is the model-visible text
 * — a string or an array of content blocks — that the host normalizes into
 * the transcript, stringifying `output` only when `content` is absent.
 * Fields are `unknown` because the host does not type them; `src/setup.ts`
 * classifies the shape once per delivery (`classifyDelivery`) and fails
 * open on an unrecognized one.
 */
export interface ToolResult {
  output?: unknown
  title?: unknown
  input?: unknown
  /**
   * Model-visible text on structured subagent results: a string, or an
   * array of content blocks (e.g. `{ type: "text", text: "…" }`) that the
   * host passes through to the transcript. Absent on the v1 string shape,
   * whose text is `output` itself; the child's canonical text on the
   * structured shape is the structured `output` string.
   */
  content?: unknown
  metadata?: {
    exit?: unknown
    exitCode?: unknown
    code?: unknown
    /** Child session ID on structured subagent results (v2 shape). */
    sessionID?: unknown
    /** Dispatch state on structured subagent results (e.g. `"completed"`). */
    status?: unknown
  }
}

/** Payload of the `tool.execute.before` and `tool.execute.after` hooks. */
export interface ToolHookEvent {
  tool?: unknown
  /**
   * Dispatched subagent/agent name, observed on v2.0.27
   * execute.before/after payloads. The host contract does not type this
   * field, hence `unknown`; `src/setup.ts` reads it (against the configured
   * agent-name set) as a conservative exclusion fallback for orchestrator
   * policy injection: it applies only when the child→parent edge is
   * unresolvable, to avoid injecting into an unregistered child's own text;
   * every such skip is journaled (`skipped:true`, `reason:"agent-name"`).
   */
  agent?: unknown
  sessionID?: unknown
  input?: TaskInput
  result?: ToolResult
}

/** Payload of the `session.prompt` hook. */
export interface PromptHookProperties {
  sessionID?: unknown
  /**
   * Candidate key for the raw user prompt text on v2.0.27. The host does not
   * type this field, hence `unknown`; `src/setup.ts` reads it (against the
   * candidate `text ?? prompt`) to capture user-authored waiver/approval markers
   * at prompt admission. Fails open when absent.
   */
  text?: unknown
  /**
   * Alternate candidate key for the raw user prompt text. On opencode ≥ 2.0.29
   * the host may instead send its mutable prompt input object
   * (`{text, files, agents, skills}`) here; `src/setup.ts` reads the object's
   * `text` field as a THIRD candidate (via a guarded cast), so a user
   * waiver/approval marker in `prompt.text` is captured too. Fails open when
   * absent.
   */
  prompt?: unknown
  /**
   * Host message id on the session prompt hook payload (opencode ≥ 2.0.29).
   * This is the same id the inbox stream delivers as `inboxID`, so a prompt
   * admitted via both transports dedupes on `${sessionID}:${messageID}`.
   */
  messageID?: unknown
}

/**
 * Generation draft passed to the `session.generate`/`session.context` hooks.
 * The context hook is the primary-turn surface (v2.2.x): its draft carries
 * the mutable system block array the policy head and intent nudge append to.
 */
export interface GenerateDraft {
  agent?: unknown
  options?: { temperature?: number }
  /** Lenient: the v2.2.x primary-turn draft carries the host session id. */
  sessionID?: unknown
  /** Lenient: mutable system block array on the context draft (v2.2.x). */
  system?: Array<{ type?: string; text?: string }>
  /** Lenient: message list on the context draft (never read, only described). */
  messages?: unknown
}

/** Compaction draft passed to the `session.compaction` hook. */
export interface CompactionDraft {
  system?: Array<{ type: string; text?: string }>
  /**
   * Session identity on v2.x's compaction payload (host contract mirrors the
   * session-scoped prompt/generate payloads, which carry a lenient
   * `sessionID?: unknown`). Read through the `asSessionID` helper in
   * `src/setup.ts` so the snapshot hydrates the parent bucket; a missing or
   * hostile value degrades to instruction-only (fail-open).
   */
  sessionID?: unknown
}

/** Session record returned by the host's `session.get`. */
export interface SessionRecord {
  parentID?: unknown
  /**
   * Directory of the session's current checkout, as delivered by the host.
   * The host does not type this field, hence `unknown`; `src/setup.ts` reads it
   * (against the candidate keys `directory` / `data.directory`) to resolve the
   * project directory per dispatch and fails open when absent.
   */
  directory?: unknown
  /**
   * Agent name of the session, as delivered by the host. The host does not
   * type this field, hence `unknown`; `src/setup.ts` reads it (against the
   * candidate keys `agent` / `data.agent`, the shared `AGENT_KEYS`) to decide
   * whether the session's `GATE:`/`VERDICT:` marker text is authoritative for
   * that kind. Fails open to unresolved: an unproven agent is denied (fail-closed
   * for text observation), and the `execute.after` delivery path seeds the agent
   * from dispatch input as the recovery channel.
   */
  agent?: unknown
  /**
   * Hosted directory of the session's current checkout, as delivered by the
   * host. The host does not type this field, hence `unknown`; `src/setup.ts`
   * reads `location.directory` as a fourth candidate and fails open when
   * absent.
   */
  location?: { directory?: unknown }
  data?: {
    parentID?: unknown
    directory?: unknown
    agent?: unknown
    location?: { directory?: unknown }
  }
}

/** Properties bag carried by host stream events. */
export interface EventProperties {
  type?: unknown
  /**
   * Agent name carried on a `session.created` event, when the host includes
   * it. `unknown` (untyped by the host); `src/setup.ts` reads it against
   * `typeof ... === "string"` to seed the emitter-authority cache. Fails open
   * to empty: a created event without the agent stays unseeded at streaming
   * time and rests on the `execute.after` delivery seed.
   */
  agent?: unknown
  sessionID?: unknown
  parentID?: unknown
  directory?: unknown
  location?: { directory?: unknown }
  part?: { type?: unknown; text?: unknown; sessionID?: unknown }
  text?: unknown
  delta?: unknown
  error?: unknown
  /**
   * Host request id on `permission.asked`; the matched id on `permission.replied`.
   * Present only on the permission stream events (opencode v2.0.27+).
   */
  id?: unknown
  requestID?: unknown
  /**
   * A human reply to a permission ask: `"once"`, `"always"`, or `"reject"`.
   * Present only on `permission.replied`.
   */
  reply?: unknown
  /**
   * The ask message echoed by the host on `permission.asked`. Read to
   * recognize plan-gate asks (the evaluate handler stamps a known prefix);
   * unknown-typed, hence `unknown`.
   */
  message?: unknown
  /**
   * Host inbox request id on admission stream events (`session.inbox.enqueued`,
   * opencode ≥ 2.0.29). This is the same id the session prompt hook delivers as
   * `messageID`, so a prompt admitted via the inbox stream dedupes against the
   * hook path on `${sessionID}:${inboxID}`. Present only on inbox events.
   */
  inboxID?: unknown
  /**
   * Admission provenance for a host inbox stream event (`session.inbox.enqueued`,
   * opencode ≥ 2.0.29). `type:"user"` admits user-authored text whose
   * `payload.text` carries the user's words; `"synthetic"` / `"compaction"` /
   * `"move"` are agent/composition arrivals that never carry a user prompt and
   * are never admitted. `payload.text` is the user prompt text when `type` is
   * `"user"`.
   */
  item?: { type?: unknown; payload?: { text?: unknown } }
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
 * Enforcement mode for the reviewer ensemble. `enforce` (default): a reviewer
 * `VERDICT: APPROVE` credits the task (`hasReviewApprove`) only when at least
 * two unwaived reviewer dispatches were counted this task; `advise`: the count
 * is tracked and journaled but the credit is unconditional (today's
 * advisory-prose behavior). Mirrors `GateEvidenceMode` (both default to
 * `enforce`) and, like it, is a resolved literal validated at merge time.
 */
export type ReviewEnsembleMode = "enforce" | "advise"

/**
 * Denylist policy governing the tools that flow through `execute.before`:
 * bash/shell commands and write/edit target paths. Both denylists default
 * empty — the "unless the user explicitly asks" semantics for git/gh
 * operations belongs to the host permission system's `ask` rules, not a
 * hardcoded denylist — and a configured rule blocks the moment it is added
 * (an empty list is a harmless no-op; the session-wide escape hatch is the
 * suspend marker). `pathDeny` stays empty for ordinary editing (a decision is
 * made and, on block, journaled, with no default blocks). Regex sources are
 * case-insensitive, compiled once at setup, and matched with `RegExp.test`.
 */
export interface TurnstileToolPolicy {
  /** Case-insensitive regex sources matched against bash/shell commands. */
  bashDeny: string[]
  /** Case-insensitive regex sources matched against write/edit target paths. */
  pathDeny: string[]
  /** Journal `session_move` dispatches (never blocks). */
  observeSessionMove: boolean
  /**
   * Gate confident file-writing bash commands (redirects from writer
   * commands, `tee`, `sed -i`/`--in-place`, `cp`/`mv`/`dd`/`truncate`/
   * `touch`) through the parent hands-on ladder; write-shaped commands
   * always journal `handsOn` telemetry.
   */
  bashWriteGate: boolean
}

/**
 * Git-and-commit gate configuration backing the mechanical gates in
 * `src/tool-policy.ts`. There is no meta-mode: each boolean key is the
 * per-feature switch (`commitMessages` lints commit subjects, `landingGate`
 * gates pushes/PR landing on a reviewer verdict), enforced unconditionally
 * while true; the session-wide escape hatch is the suspend marker.
 *
 * `commitFormat` is a conventional-commits regex SOURCE string (no leading
 * `^`/trailing `$`): callers compile it with `new RegExp("^" + source + "$",
 * "s")`. It accepts one of the default types `{feat,fix,docs,style,refactor,
 * perf,test,build,ci,chore,revert}`, an optional `(scope)`, a required `!` or
 * `:` separator (only one is needed — no `BREAKING CHANGE` trailer), a subject
 * of up to 72 characters on the first line, and one optional following body
 * line.
 */
export interface TurnstileGitGates {
  /** Whether `git commit` messages are linted as conventional commits. */
  commitMessages: boolean
  /** Conventional-commit regex SOURCE string (compiled by callers with `"^…$"` + `"s"`). */
  commitFormat: string
  /** Whether pushing/PR-landing is gated on a reviewer `VERDICT: APPROVE`. */
  landingGate: boolean
  /** Whether a statically-provable empty-diff `git push` (ref-equal to upstream) skips the landing gate (default true; `false` is the strict opt-out). */
  emptyDiffExempt: boolean
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
  /**
   * Verbatim text of the task's last first-sight `GATE:` marker, de-tokenized
   * (leading `GATE:` lowercased) so an injected echo can never re-parse as an
   * authoritative marker; "" until observed. Task-scoped: fresh "" on every
   * task-scope reset and never carried through mergeAfterReplay. Display only —
   * rendered into the compaction snapshot, never consulted by enforcement.
   */
  lastGateMarker: string
  /**
   * Same for the task's last first-sight `VERDICT:` marker (reviewer or
   * plan-reviewer), de-tokenized for echo-safety. "" until observed.
   * Task-scoped: fresh "" on every task-scope reset and never carried through
   * mergeAfterReplay. Display only.
   */
  lastVerdictMarker: string
  /** True when this task's plan has a current plan-reviewer APPROVE. */
  hasPlanVerdict: boolean
  /**
   * True once this task's reviewer `execute.after` delivery has carried a
   * `VERDICT: APPROVE` for the parent — the landing gate's release signal.
   * Restart-sticky like `hasPlanVerdict`: restored by journal replay across a
   * restart and carried one prompt via `mergeAfterReplay`; fresh
   * `false` on an ordinary task-scope reset.
   */
  hasReviewApprove: boolean
  /**
   * Latest user-authored prompt text containing the waiver marker; "" when
   * none. Non-empty ⇒ the current task's reviewer/dispatch gates are waived
   * per the canonical waiver semantics: a waiver covers every gate while
   * unscoped, but the reviewer gate consumes an unscoped waiver on the first
   * dispatch it unlocks; naming configured agent names in the waiver text
   * scopes it to those stages' gates (the plan gate is covered by either its
   * plan-reviewer or executor stage name), and a scoped waiver stays live
   * until that stage's waiver allowance is spent — metered separately from
   * the ordinary dispatch caps. The waiver holds for the whole task scope: a
   * same-scope prompt never drops it (only a task-scope change does — a
   * different-plan approval, a task retire, or a planless fingerprint
   * change). Task-scoped: cleared on a scope-changing reset, but carried
   * one prompt through `mergeAfterReplay` exactly like the restart-sticky
   * gate flags, so a continuation-carry or replay grace prompt keeps the
   * waiver and its scope, consumed flag, and spent allowance the block
   * messages will read.
   */
  userWaiver: string
  /**
   * Configured agent names named by the waiver text at capture (the parsed
   * scope); `[]` = unscoped (covers every gate). See the canonical semantics
   * on `userWaiver`. Task-scoped: cleared when the task scope changes (an
   * approval binding a different plan, a task retire, or a planless
   * fingerprint change), but carried one prompt through `mergeAfterReplay`
   * exactly like the restart-sticky gate flags, so a continuation-carry or
   * replay grace prompt keeps the waiver's scope the block messages will
   * read. A same-scope prompt (every prompt while a plan is bound and not
   * retired) never clears it — the waiver holds for the whole task.
   */
  userWaiverScope: string[]
  /**
   * True once the reviewer gate consumed an unscoped waiver on the first
   * dispatch it unlocked; reports the consumed state to block messages and
   * the compaction snapshot. Task-scoped: cleared on an ordinary prompt
   * reset, but carried one prompt through `mergeAfterReplay` exactly like
   * the restart-sticky gate flags, so a continuation-carry or replay grace
   * prompt keeps the consumed flag the block messages will read.
   */
  userWaiverConsumed: boolean
  /**
   * Waiver-allowance slots spent by scoped-waived reviewer dispatches.
   * Deliberately NOT shared with `reviewRounds`: that counter is
   * journal-replayed and restart-sticky (carried through `mergeAfterReplay`),
   * so a shared counter would mis-attribute spent slots to the waiver after a
   * mid-task restart and would break the "waived dispatches don't count
   * toward the cap" invariant. Lifecycle mirrors the `userWaiver` pair:
   * task-scoped, fresh `0` on an ordinary task-scope reset, never replay-
   * restored, but carried one prompt through `mergeAfterReplay` exactly like
   * the restart-sticky gate flags, so a continuation-carry or replay grace
   * prompt keeps the spent allowance the block messages will read — the
   * waiver's own allowance travels with the waiver, while `reviewRounds`
   * (the metered dispatch count) does not.
   */
  reviewWaiverRounds: number
  /**
   * Provenance flag: true once a human (prompt marker or permission reply)
   * rather than the plan-reviewer subagent released the plan gate. Provenance
   * only — `execute.before` never consults it; it is read by the status CLI and
   * trace lines. Fresh `false` on each task-scope reset, but restart-restored values
   * survive the first post-restart prompt via `mergeAfterReplay`, exactly like
   * `hasPlanVerdict`.
   */
  humanApproval: boolean
  /**
   * A single-dispatch grant — the matched host `requestID` for a once-granted
   * human approval, keyed per ask-reason so a plan-gate `once` grant (releasing
   * exactly one executor dispatch) can never be consumed by a landing-gate
   * `once` grant (releasing exactly one push) and vice versa: `{ plan }` for the
   * plan gate (consumed by the executor dispatch short-circuit), `{ landing }`
   * for the landing gate (consumed by the bash short-circuit). "" per reason
   * when none. Task-scoped: cleared immediately after the single dispatch
   * consumes it (a stale grant cannot outlive one dispatch) and never carried
   * through `mergeAfterReplay`.
   */
  pendingOnceGrant: {
    /** Plan-gate once grant: the matched requestID, or "" when none. */
    plan: string
    /** Landing-gate once grant: the matched requestID, or "" when none. */
    landing: string
    /** Hands-on-gate once grant: the matched requestID, or "" when none. */
    handsOn: string
  }
  /**
   * True once this task's first parent task/subagent result delivery has
   * carried the injected orchestrator policy forward into model context.
   * Cleared by `ledger.resetState()` on every task-scope reset, so the
   * policy is re-injected per task (the intended per-task re-supply, which
   * also re-applies it after compaction).
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
  /**
   * Task-scoped ensemble count of *unwaived* `task -> reviewer` dispatches.
   * The landing credit (`hasReviewApprove`) requires `>= 2`. Unlike
   * `reviewRounds` it is restart-sticky: restored by journal replay across a
   * restart and carried one prompt via `mergeAfterReplay`; fresh `0` on an
   * ordinary task-scope reset. Waived dispatches never advance it (the waiver
   * short-circuits before counting, mirroring `reviewRounds`).
   */
  reviewerDispatches: number
  /**
   * Task-scoped planner dispatch count. Exceeded ⇒ the planner leg is spinning;
   * see `maxPlannerRounds`. Waived dispatches are exempt (the waiver
   * short-circuits before counting, mirroring the reviewer-cap precedent).
   * Task-scoped: fresh `0` on each task-scope reset and never carried through
   * `mergeAfterReplay`.
   */
  plannerRounds: number
  /**
   * Task-scoped plan-reviewer dispatch count. Exceeded ⇒ the plan is going in
   * circles; see `maxPlanReviewerRounds`. Waived dispatches are exempt.
   * Task-scoped: fresh `0` on each task-scope reset and never carried through
   * `mergeAfterReplay`.
   */
  planReviewerRounds: number
  /**
   * Task-scoped test-runner dispatch count. Exceeded ⇒ the test loop is
   * spinning; see `maxTestRunnerRounds`. Waived dispatches are exempt.
   * Task-scoped: fresh `0` on each task-scope reset and never carried through
   * `mergeAfterReplay`.
   */
  testRunnerRounds: number
  /**
   * Every task/subagent dispatch this task across all legs (planner,
   * plan-reviewer, executor, test-runner, reviewer, debugger, unknown),
   * capped by `maxTotalDispatches` as the global loop backstop. Waived
   * dispatches are exempt (the waiver short-circuits before counting).
   * Task-scoped: fresh `0` on each task-scope reset and never carried through
   * `mergeAfterReplay`.
   */
  totalDispatches: number
  /**
   * Count of `git push`/PR-landing blocks this task under the landing gate —
   * telemetry that arms the permission-ask escalation on a repeat attempt.
   * Task-scoped: fresh `0` on each task-scope reset and never carried through
   * `mergeAfterReplay`.
   */
  landingBlocks: number
  /**
   * Task-scoped count of parent hands-on (write/edit) blocks this task under
   * the hands-on gate — arms the permission-ask escalation on a repeat
   * attempt. Task-scoped: fresh `0` on each task-scope reset and never carried
   * through `mergeAfterReplay`. A restart mid-task drops it (never
   * replay-restored), so the ladder re-blocks and re-arms — the
   * fail-toward-strict direction.
   */
  handsOnBlocks: number
  /**
   * Task-scoped standing release from a human `always` reply to a hands-on
   * ask: the rest of this task's parent write/edit calls are allowed. Fresh
   * `false` on every task-scope reset; restart-restored by the sticky-decision
   * replay (a replayed `always` hands-on decision row re-stamps it) and
   * carried through `mergeAfterReplay` like the other standing releases —
   * a restart mid-task keeps the release (task-scoped human releases).
   */
  handsOnRelease: boolean
  /**
   * Task-scoped standing human release provenance: true once this task's
   * waiver was journaled through the sticky decision-row family (capture)
   * or restored by it (replay). Provenance/status only — the gates keep
   * reading the waiver family itself (`userWaiver`/`userWaiverScope`), so
   * each surface keeps exactly one release source of truth. Fresh `false`;
   * restart-sticky through `mergeAfterReplay`.
   */
  stickyRelease: boolean
  reads: number
  /**
   * True once this task's read-budget warning prefix has been injected into a
   * whole-file read result. The prefix is a once-per-task nudge: the corrected
   * `reads` counter is not monotonic (a failed read's charge is corrected
   * back down), so equality with `readWarn` could inject the warning again on
   * a later climb. Task-scoped: fresh `false` on every task-scope reset, never
   * carried through `mergeAfterReplay`, never replay-restored (`reads` itself
   * restarts at 0, so a restarted session may warn once again — intended).
   */
  readWarned: boolean
  seen: Set<string>
  /**
   * Plans-dir signature the approval was issued against; "" means unstampable
   * (absent/unreadable dir) or restored from a field-less legacy journal line,
   * and is accepted once, then stamped, on the next enforcing dispatch. A
   * journaled APPROVE's `plansSig` field restores it verbatim, so a replayed
   * unbound approval validates against the current dir like a live one.
   * Governs unbound approvals only.
   */
  plansSignature: string
  /**
   * Name of the plan file this task's plan approval is bound to; "" = unbound
   * (human release, legacy journal replay, or an approval whose dispatch
   * prompt named no single existing plan file). Restart-sticky and paired with
   * `hasPlanVerdict`: restored by journal replay (a `plan` entry's optional
   * `plan` field) and carried one prompt via `mergeAfterReplay`; fresh "" on
   * an ordinary task-scope reset.
   */
  approvedPlan: string
  /**
   * The active task's identity: the path-free name of the most recently
   * plan-approved plan file for this parent (the `PLAN APPROVED:` capture or
   * a reviewer-verdict binding), "" while the parent works without a bound
   * plan (the worktree `taskFingerprint` fallback governs scope instead).
   * Established ONLY by a plan-approval event — prompt mentions of plan files
   * never establish or flip scope. Scope resets exactly on: an approval
   * binding a different plan (the capture resets before stamping), an
   * explicit retire (`taskComplete`), or a fingerprint change while this is
   * "". Journaled in the plan-approval entry's `plan` field and restored by
   * the ordered scope fold at replay; carried through `mergeAfterReplay`
   * while `hasPlanVerdict` holds (and never out of a `taskComplete` bucket).
   */
  activePlan: string
  /**
   * True once the active task retired: a `GATE: PASS` journaling flip (the
   * gate entry's `task-complete` companion row) or a user prompt carrying the
   * configured `taskDoneMarker` literal (admission-only — child results and
   * dispatch prompts never retire a task). The NEXT admitted task-scope resets
   * for a fresh task; within the retiring turn, pipeline legs keep their
   * counters. Never carried through `mergeAfterReplay`: a completed task
   * contributes no flags, releases, or counters to the next task. Restored
   * by the ordered scope fold at replay (a `task-complete` row marks it; a
   * later plan APPROVE clears it).
   */
  taskComplete: boolean
  /**
   * sha256 hex of the bound plan file's bytes at approval time; "" = unknown.
   * A bound approval is stale when the bound plan's current file hash differs
   * (`plan-edited`) or the file no longer exists (`plan-missing`); changes to
   * other plans-dir files do not invalidate it. Paired with `approvedPlan`
   * across replay and the grace-prompt carry.
   */
  approvedPlanKey: string
  /**
   * True while a journal-replayed bucket's unconsumed one-prompt grace is
   * outstanding: the next reset carries hasGatePass/hasPlanVerdict forward
   * instead of wiping them. Cleared by the first reset; re-granted only by
   * journal replay at ledger creation (process restart or plugin reload).
   */
  replayGrace: boolean
  /**
   * Worktree/branch identity the current task was admitted against; "" until
   * the first enabled prompt stamps it (see src/fingerprint.ts). When the
   * carry is on, a prompt re-admitted in the same worktree/branch re-arms
   * replayGrace to carry the restart-sticky gate flags across the reset
   * instead of wiping them — but only if a gate flag was actually earned
   * (`hasGatePass`), so a continuation arriving before any GATE: PASS still
   * resets fully. A pure replay-resume bucket arrives with replayGrace
   * pre-armed and taskFingerprint still "" (it is never carried through
   * mergeAfterReplay): it carries via replayGrace rather than the carry
   * machinery, journals no continuation entry, and stamps this fingerprint
   * for subsequent prompts. "" is the pre-stamp "not-yet-a-task" state; a
   * fingerprint mismatch signals a reset.
   */
  taskFingerprint: string
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
   *  (latest-wins policy); 0 when this was the only match. Omitted on an
   *  `authority:"suppressed"` event (which stamps nothing).
   */
  suppressed?: number
  /**
   * Present only on a marker observation denied authority: the emitting
   * session's resolved agent name was not contracted for this kind (gate↔
   * test-runner, verdict↔reviewer/plan-reviewer). The caller journals a
   * `type:"suppressed"` audit entry for it and applies nothing, so a quoted or
   * echoed marker from an unauthoritative session flips no state. `result` /
   * `rounds` / `verified` / the numeric `suppressed` count are all omitted on
   * such an event (it stamps nothing; the marker string alone carries the
   * digits for audit). The field name `authority` is intentionally distinct
   * from the numeric `suppressed` match count above.
   */
  authority?: "suppressed"
}

/** One marker-shaped near miss found in user prompt text: the exact token
 * that was seen (`found`), which gate it tried to move (`label`, e.g.
 * "waiver"), and the exact configured literal it must match (`literal`). */
export interface MarkerNearMiss {
  found: string
  label: string
  literal: string
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
   * Size-check/rotation cadence: the journal append hot path only stats and
   * rotates once per this many appends; entries between the check and the
   * rename are the bounded overshoot.
   */
  journalRotateEveryEntries: number
  /**
   * Replay tail window in lines: the most recent this-many journal lines
   * (current file plus the previous generation, combined) are replayed at
   * boot; older lines are dropped.
   */
  replayTailLines: number
  /**
   * Max reviewer dispatches per task; the cap counts dispatches, applies
   * regardless of gate state, and is bypassed by an explicit waiver.
   */
  maxReviewerRounds: number
  /**
   * Max planner dispatches per task; the cap counts dispatches, applies
   * regardless of gate state, and is bypassed by an explicit waiver.
   */
  maxPlannerRounds: number
  /**
   * Max plan-reviewer dispatches per task; the cap counts dispatches, applies
   * regardless of gate state, and is bypassed by an explicit waiver.
   */
  maxPlanReviewerRounds: number
  /**
   * Max test-runner dispatches per task; the cap counts dispatches, applies
   * regardless of gate state, and is bypassed by an explicit waiver.
   */
  maxTestRunnerRounds: number
  /**
   * Total task/subagent dispatches per task across all legs, the global loop
   * backstop; the cap counts dispatches and is bypassed by an explicit waiver.
   */
  maxTotalDispatches: number
  /** Cap on tracked sessions (LRU); oldest state evicted beyond this. */
  maxSessions: number
  /** Whole-file read count at which the horizon warning is injected. */
  readWarn: number
  /** Whole-file read count at which further reads are blocked. */
  readBlock: number
  /**
   * Number of admitted parent sessions that run in observe mode
   * (decisions journaled, nothing blocked) before enforcement switches
   * on. 0 (default) enforces from the first session.
   */
  observeSessions: number
  /** Literal marker that waives the reviewer gate when in the prompt. */
  waiverMarker: string
  /**
   * Literal marker that releases the plan gate via an explicit human
   * approval, captured from the user's prompt at admission and honored like
   * a plan-reviewer verdict. Defaults to `PLAN APPROVED:`.
   */
  approvalMarker: string
  /** Project-relative directory scanned for `## Decomposition` plans. */
  plansDir: string
  /** Whether the human-readable trace file is written (JSONL journal always). */
  trace: boolean
  /**
   * Session-end summary surface. `quiet` (default) prints one recap line at
   * `session.idle` for sessions that did something (verified test-claims,
   * blocked dispatches, waivers — counts derived from the journal) and is
   * silent for zero-activity sessions; `on` additionally prints an
   * all-gates-green line for zero-activity sessions; `off` disables the
   * surface entirely. See `src/summary.ts` and the `session.idle` handler in
   * `src/hooks-events.ts`.
   */
  sessionSummary: "on" | "quiet" | "off"
  /**
   * Repeat-attempt escalation mode for the landing and hands-on gates.
   * Both modes are ask-first since Phase 2 (chunk-3): an armed repeat
   * attempt arms the one-shot ask latch and forces the host permission ask
   * (the block-throw fires only when the latch cannot be armed — a
   * within-window duplicate arm — or the host never surfaces the ask). The
   * mode still distinguishes the *first* attempt: under "ask" (default
   * behavior on the plan-gate arm until chunk-5) escalation may surface
   * before a recorded block, while "block" keeps the deliberate first
   * block-throw. Retained as a config key for the plan-gate arm and the
   * blocked-message vocabulary.
   */
  escalation: "ask" | "block"
  /**
   * When true, a prompt admitted in an unchanged worktree/branch carries the
   * current task's restart-sticky gate flags across the task-scope reset instead
   * of wiping them (a continuation, not a new task). The carry is
   * CREDIT-SCOPED: only earned credit (an earned gate pass `hasGatePass` or
   * a landing approval `hasReviewApprove`, each paired with the restart-
   * sticky ensemble count) is carried, so a continuation arriving before any
   * `GATE: PASS` or reviewer `VERDICT: APPROVE` still starts a clean cycle.
   * Default true: a reviewer-approved landing prompt re-arms earned credit
   * when the worktree/branch is unchanged; set false to restore a clean
   * cycle every prompt. A genuinely new task on the same branch is
   * indistinguishable from a continuation, and a carried landing approval
   * releases pushes for that new task too until a fresh task-scope resets the
   * bucket.
   */
  continuationCarry: boolean
  /**
   * Literal marker that, appearing in the user's own prompt, suspends gate
   * blocking for the session: enforcement decisions keep computing and
   * journaling (observe-like) but never throw `BLOCKED` while suspended, and
   * the session's gate state is cleared fresh. Not agent-dispatchable: only
   * admitted user prompts are scanned. Default `TURNSTILE OFF:`.
   */
  suspendMarker: string
  /**
   * Literal marker that, appearing in the user's own prompt, resumes
   * enforcement after a suspension with fresh task state: no credit earned
   * while suspended rehydrates. Default `TURNSTILE ON:`.
   */
  resumeMarker: string
  /**
   * Literal marker that, appearing in the user's own prompt, explicitly
   * retires the session's active task: journals `{type:"task-complete",
   * plan}` with the bucket's `activePlan` and stamps `taskComplete`, so the
   * NEXT admitted prompt starts a fresh task scope. Admission-only: child
   * results and dispatch prompts never retire a task. Default `TASK DONE:`.
   */
  taskDoneMarker: string
  /**
   * Whether the suspend/resume markers are honored at all. When false, an
   * OFF or ON marker is refused: the refusal is journaled (`refused:true`
   * with the marker's `action`) and surfaced as a marker-style diagnostic,
   * and no state changes (the refused entry folds replay-inert). Default
   * true.
   */
  allowSuspend: boolean
  /**
   * Whether the advisory intent nudge is enabled. When true (default), a
   * user prompt classified as implementation intent with no plan approval
   * journals `{type:"intent"}` and prepends one advisory pipeline-entry
   * nudge to the next tool delivery. When false, intent detection is a full
   * no-op: nothing is journaled and nothing is injected.
   */
  intentNudge: boolean
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
   * Enforcement mode for the reviewer ensemble. `enforce` (default) credits a
   * reviewer `VERDICT: APPROVE` (`hasReviewApprove`) only when at
   * least two unwaived reviewer dispatches were counted this task
   * (`reviewerDispatches >= 2`); `advise` tracks and journals the count but
   * credits unconditionally (today's advisory-prose behavior). The
   * `maxReviewerRounds < 2` interaction is validated at resolve time
   * (`config.validateResolved`).
   */
  reviewEnsemble: ReviewEnsembleMode
  /**
   * Case-insensitive regex source a successful (exit-0) bash/shell command
   * must match to count as test execution. Overridable for non-JS/other
   * toolchains; the default covers npm/pnpm/yarn/bun/deno/node --test/
   * pytest/make test/go test/cargo test.
   */
  evidencePattern: string
  /**
   * Denylist policy for bash/shell and write/edit tools in `execute.before`.
   * Both `bashDeny` and `pathDeny` default empty (git/gh consent is the host
   * permission system's, and a configured rule blocks the moment it is added),
   * and `observeSessionMove` journals `session_move` dispatches without
   * blocking. See `src/tool-policy.ts`.
   */
  toolPolicy: TurnstileToolPolicy
  /**
   * Git-and-commit gate configuration: `commitMessages` lints `git commit`
   * messages against the conventional-commits `commitFormat`, and
   * `landingGate` gates push/PR-landing on a reviewer `VERDICT: APPROVE` —
   * each enforced unconditionally while its boolean is true. See
   * `src/tool-policy.ts`.
   */
  gitGates: TurnstileGitGates
}

/** Options accepted by the plugin factory; tests inject config and env here. */
export interface TurnstileOptions {
  /** Overrides applied last, on top of file and env layers. */
  config?: Partial<TurnstileConfig>
  /** Environment for config resolution; defaults to `process.env`. */
  env?: Record<string, string | undefined>
  /**
   * Absolute path of the durable approved-plan sidecar; defaults to
   * `approved-plans.jsonl` beside the journal (the metrics dir). Injected to
   * redirect the sidecar (tests, fail-open drills).
   */
  approvalLedgerPath?: string
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
  permission?: {
    hook?: (
      name: string,
      callback: (event: unknown) => unknown | Promise<unknown>,
    ) => Promise<unknown>
  }
  /**
   * Host identity block (v2 Context.app). Optional; the version feeds the
   * host-compat guard only — never enforcement.
   */
  app?: { name?: unknown; version?: unknown }
  /**
   * TUI surface, when the host exposes one (verified on the TUI side as
   * `tui.toast.show` with `message` required). Optional-chained everywhere;
   * the toast is a best-effort delivery channel on top of the journal.
   */
  tui?: {
    toast?: {
      show?: (input: {
        message: string
        title?: string
        variant?: "info" | "success" | "warning" | "error"
        duration?: number
      }) => Promise<unknown>
    }
  }
}

/**
 * Properties carried by a host `permission.evaluate` request at the wire
 * boundary. Every field is optional and typed `unknown`: the host does not
 * expose a stable shape for this payload, so a reshaped or partial payload
 * fails open rather than failing hard. The plugin matches on `action` (the
 * host's task/subagent dispatch name) and `source` rather than the tool input
 * (which this payload does not carry), so escalation surfaces the same decision
 * to a human without leaking the dispatch target to the subagent.
 */
export interface PermissionEvaluateEvent {
  sessionID?: unknown
  action?: unknown
  resources?: unknown
  metadata?: unknown
  source?: {
    type?: unknown
    messageID?: unknown
    id?: unknown
  }
  effect?: unknown
  message?: unknown
}
