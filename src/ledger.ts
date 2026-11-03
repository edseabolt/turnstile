/**
 * @fileoverview Ledger boundary: the LRU-capped session maps behind the gate
 * bookkeeping — child→parent edges, the child verdict store, and live-parent
 * eviction protection — plus journal replay so a completed task's `GATE: PASS`
 * survives restarts, the observe-mode period state (per-session admission
 * phases plus the running would-block totals) survives the same way, the
 * session-level gate suspension map (prompt-marker suspend/resume, last-wins
 * replay) survives the same way, and a
 * bounded durable approved-plan sidecar so a bound plan approval survives
 * replay-aging, a process restart, and a new-task-scope reset. Sidecar
 * records carry a key-scheme tag: a legacy whole-file-keyed record whose
 * bytes still match is honored and transparently re-keyed to the current
 * spec-region scheme on first content-verified touch (journaled
 * `plan-rekey`). On a parent's
 * task-scope reset, also releases that parent's registered children's metering
 * counters. Pure bookkeeping; no enforcement decisions here.
 */

import { createHash } from "node:crypto"
import * as fs from "node:fs"
import * as path from "node:path"

import { evictTo } from "./bounded.ts"
import { CANONICAL_REVIEWER_AGENT } from "./config.ts"
import type { ChildVerdict, GateState } from "./types.ts"
import { appendLine, now, REPLAY_SESSION_RE } from "./journal.ts"
import { REVIEW_ENSEMBLE_SIZE, mergeAfterReplay, newState } from "./state.ts"
import {
  cap,
  createCreditTrace,
  createLedgerRegistry,
  promote,
  type CreditTrace,
  type LedgerRegistry,
} from "./ledger-registry.ts"
import type { StickyReleaseKind } from "./gates-common.ts"

/**
 * The observe-mode admission phase of a session: `observe` (gate decisions
 * are computed and journaled but not enforced), `enforce` (normal
 * enforcement), or `off` (the configured period is 0 — observe mode
 * disabled).
 */
export type ObservePhase = "observe" | "enforce" | "off"

/** Live gate bookkeeping shared by the gate, marker, and wiring layers. */
export interface GateLedger {
  /** Child→parent session-ID mapping; readable for membership checks. */
  childToParent: Map<string, string>
  /**
   * Returns the gate state for a parent session, creating an empty one on
   * first access.
   * @param sessionID The parent session ID.
   * @returns The session's mutable gate state.
   */
  state(sessionID: string): GateState
  /**
   * Returns the gate state for a session without creating one, for read-only
   * checks that must not insert a fresh bucket into the LRU (e.g. promotion
   * lookups for unknown bash sessions).
   * @param sessionID The session ID to look up.
   * @returns The session's mutable gate state, or `undefined` when none exists.
   */
  peek(sessionID: string): GateState | undefined
  /**
   * Resets a session's gate state for a task-scope change (a plan-approval
   * binding a different plan, a task retire, or a planless worktree
   * change — a same-scope prompt never reaches it). The first prompt after a
   * restart carries the journal-replayed
   * flags forward with a single-prompt grace (values, not provenance — a live
   * GATE: FAIL after replay is carried as false). The grace-carry set is
   * representative, not exhaustive: the restart-sticky flags (`hasGatePass`,
   * `hasPlanVerdict`, `hasReviewApprove`, `humanApproval`, `handsOnRelease`,
   * `stickyRelease`, the paired `reviewerDispatches`), the waiver family
   * (`userWaiver`, `userWaiverScope`, `userWaiverConsumed`,
   * `reviewWaiverRounds`), and the plan identity fields (`plansSignature`,
   * `approvedPlan`/`approvedPlanKey`, `activePlan`) carried while
   * `hasPlanVerdict` holds. `mergeAfterReplay` in `src/state.ts` is the
   * authority for the exact carry set. Every other reset is a full
   * reset (fresh flags; `reviewRounds`/`plannerRounds`/
   * `planReviewerRounds`/`testRunnerRounds`/`totalDispatches`/`reads`/`seen`/
   * `seenFrom`/`suppressedPending` are always fresh). Fail-open: pure object map
   * operations.
   *
   * The optional `merge` argument overrides the grace-arm decision: true
   * forces the merge (the grace carry even without an armed `replayGrace`
   * is never used today — callers pass the armed flag), false forces a
   * clean rebuild (a reset-at-capture plan approval must not carry the old
   * scope's releases through an armed grace), and undefined keeps the
   * default (merge iff the bucket's `replayGrace` is armed).
   *
   * With continuation carry enabled, a continuation prompt (the same
   * worktree/branch — `taskFingerprint` unchanged) re-arms `replayGrace` on
   * the reset so the restart-sticky flags carry forward too: values, not
   * provenance, the same single-prompt grace the restart-resume path grants.
   * The carry is CREDIT-SCOPED — an earned `hasGatePass` or
   * `hasReviewApprove` (each paired with `reviewerDispatches`) survives, so
   * a continuation before any `GATE: PASS` or reviewer `VERDICT: APPROVE`
   * starts a clean cycle. `taskFingerprint` is stamped by setup after the
   * reset, so a fresh bucket starts empty and the next carry predicate keys
   * off the just-stamped identity.
   *
   * A scope-changing prompt also releases the session's registered children:
   * their stored verdict evidence is dropped and their metering counters are
   * cleared (see `clearMeteringCounters`), so a cap-exhausted child is
   * re-dispatchable after the parent's next task boundary.
   *
   * The credit-bearing reviewer APPROVE trace (`markCreditedApproval` /
   * `hasCreditedApproval`) is a deliberate exception to this reset: it is
   * bucket-free provenance, not a bucket flag, so the task-scope reset that drops
   * `hasReviewApprove` leaves it intact — the window the landing gate reads to
   * escalate a credited session's first push. A refusal stamp suppresses the
   * mark at restore (replay) time, never at read time, so this reset performs
   * no refusal re-check.
   * @param sessionID The parent session ID to reset.
   * @returns The number of registered child buckets whose metering counters
   *     were non-fresh before clearing (0 for a no-op release).
   */
  resetState(sessionID: string, merge?: boolean): number
  /**
   * Maps a session to its parent, falling back to the session itself when
   * no parent edge is known.
   * @param sessionID The (possibly undefined) session ID.
   * @returns The parent session ID, the session ID itself, or an empty
   *     string for nullish input.
   */
  parentOf(sessionID: string | undefined): string
  /**
   * Records a resolved child→parent edge. The edge is journaled as a
   * `child-edge` row (carrying the child's resolved emitter agent when one
   * is supplied) whenever it is new or changed — the data the setup re-seed
   * replays after a plugin reload wipes the in-memory map (#225). An
   * unchanged re-set is silent (idempotent registrations stay journaled
   * once). An agent upgrade (a previously agent-less row gaining a resolved
   * agent, or an agent change) re-journals — the journaled agent feeds the
   * post-reload emitter re-seed, so it must never be frozen empty; an empty
   * agent never downgrades a journaled one. Both IDs and the optional agent
   * must already be validated by the caller; journaling is fail-open
   * (`appendLine` never throws).
   * @param sessionID The child session ID.
   * @param parentID The parent session ID.
   * @param agent The child's resolved emitter agent name, or "" when
   *     unresolved (the journaled row then omits the field).
   */
  setParent(sessionID: string, parentID: string, agent?: string): void
  /**
   * Re-applies the child→parent edges restored by the boot replay's
   * `child-edge` fold (last-wins per child over the replay tail), rebuilding
   * the in-memory map after a plugin reload without journaling (a re-seed
   * must not re-append the rows it just folded, or every restart would grow
   * the journal and re-reseed forever). Each restored edge marks its parent
   * live and is LRU-capped like a live registration.
   * @returns The restored edges as `{ child, parent, agent }` records, in
   *     replay order; empty when the tail held no `child-edge` rows.
   */
  reseedEdges(): Array<{ child: string; parent: string; agent: string }>
  /**
   * Registers a session as a live parent so the `states` cap never evicts
   *  its bucket while it stays tracked. Registration is the
   *  eviction-protection signal; refreshed by every prompt, guarded
   *  dispatch, task delivery, edge resolution, and root-session event, so an
   *  active parent re-registers long before the registry's LRU churn can evict
   *  it (bounded by `maxTrackedParents`). No-op on an empty id.
   * @param sessionID The parent session ID.
   */
  markParent(sessionID: string): void
  /**
   * Whether a session is a currently-registered live parent (membership with
   *  LRU promotion — the registry is LRU by use).
   * @param sessionID The session ID to test.
   * @returns True when the session is a registered live parent.
   */
  isParent(sessionID: string): boolean
  /**
   * Returns the most-recently-admitted live parent (the MRU of the registry,
   * which `markParent` promotes to the end on), or "" when none is registered.
   * Used as a fallback when a compaction payload carries no `sessionID`: the
   * most-recently-active parent is otherwise unresolvable. Fail-open — the
   * registry is never mutated, so this reads without an LRU reorder.
   * @returns The last admitted parent session ID, or "" when the registry is empty.
   */
  lastParent(): string
  /**
   *
   * Overwrites the child's latest `VERDICT:` marker observation and its
   * provenance source label. Recording is verdict-kind only (only `VERDICT:`
   * markers are ever stored; never `GATE:`) and is conditioned on the caller
   * having emitter authority for the verdict kind (the authority decision lives
   * in the wiring layer — `src/setup.ts` — not here; the ledger itself stays
   * agent-agnostic). The plan gate is the sole consumer, and because
   * attribution is keyed by child ID this cannot leak a verdict to a different
   * child or let a GATE-only child suppress a plan-reviewer bare-output violation.
   *
   * Returns whether the stored observation actually changed (its `marker` or
   * `source` differed from the prior entry): the setup/store layer journals a
   * streamed verdict observation iff this is true, so per (child, marker,
   * source) first-sight journaling is owned here rather than by the parent
   * bucket's dedup set.
   * @param childID The child session ID.
   * @param marker The last `VERDICT:` marker observed in the child's text.
   * @param source Pipeline provenance label the marker was observed in.
   * @returns True when the stored `marker` or `source` changed; false on an
   *     identical re-record (a dedup hit for streamed sources).
   */
  recordChildVerdict(childID: string, marker: string, source: string): boolean
  /**
   * Returns the child's latest `VERDICT:` marker observation, or an empty
   * verdict (`{ marker: "", source: "", recordedAt: 0 }`) when the child has
   * none. Touches the child to keep it most-recently-used (LRU).
   * @param childID The child session ID.
   * @returns The stored observation, or the empty verdict default.
   */
  childVerdict(childID: string): ChildVerdict
  /**
   * Snapshot of children with a stored (non-empty) verdict, as
   * `{ child, verdict }` copies. Pure read — never promotes and never caps, so
   * it is safe to call from the attribution layer without disturbing the LRU
   * order (the plausibility scan reads, never writes).
   * @returns A new array of `{ child, verdict }` pairs with non-empty verdicts.
   */
  evidencedChildren(): Array<{ child: string; verdict: ChildVerdict }>
  /**
   * Whether — and why — a plan identity lacks a durable approval recorded for
   * this project. The store holds records keyed by project scope, plan name,
   * and content key under a key scheme: the current scheme hashes the plan's
   * spec region (`"spec"` tag); the legacy scheme (pre-chunk-3.5, untagged)
   * hashed the whole file. A record is `live` when its key equals the plan's
   * spec-region key (the current scheme) or its whole-file key (the legacy
   * scheme — a whole-file match proves the approved bytes are byte-identical,
   * so honoring it widens nothing); the first such match transparently
   * re-keys the record to the current scheme (in-memory, sidecar append, and
   * one replay-inert `plan-rekey` journal row). A record matching neither key
   * is `stale-key`: the plan was edited after approval, or the record cannot
   * prove the spec region unchanged — one cheap re-approval re-keys it. A
   * durable approval is a fact about a plan file's bytes (recorded when a
   * bound plan approval was captured) that lives outside the journal replay
   * window and the session bucket, so it survives replay-aging, a process
   * restart, and a new-task-scope reset. All arguments are sanitized before
   * the lookup; an unbound (empty) name or spec key reports `absent`, and a
   * bad-shaped whole key skips the legacy arm.
   * @param name The plan file name (path-free).
   * @param key The plan file's spec-region sha256 content key (current scheme).
   * @param wholeKey The plan file's whole-file sha256 key (legacy scheme).
   * @param projectDir The project directory the identity is checked under.
   * @param sessionID Optional journal-row provenance for the re-key row;
   *     omitted or failing the replay ID shape, the row carries no sessionID.
   * @returns `live` when a record covers the identity (after any re-key),
   *     `stale-key` when a record matches neither key, `absent` otherwise.
   */
  planApprovalState(
    name: string,
    key: string,
    wholeKey: string,
    projectDir: string,
    sessionID?: string,
  ): DurablePlanApprovalState
  /**
   * Records a durable approval for a plan identity under a project: the bound
   * identity (name + content key) plus the project scope, persisted to the
   * bounded sidecar beside the journal. A re-record refreshes the entry's
   * recency; over the cap the oldest entry is evicted and the file is
   * rewritten compacted (bounded growth). All file access fails open: an
   * unwritable sidecar journals one error and leaves the in-memory store
   * without the record (the non-durable wall keeps applying), and never
   * throws; a bad-shaped argument is dropped without any write.
   * @param name The plan file name (path-free).
   * @param key The plan file's sha256 content key.
   * @param projectDir The project directory the approval was recorded under.
   */
  recordPlanApprovalDurable(name: string, key: string, projectDir: string): void
  /**
   * Marks a parent session's reviewer APPROVE as credit-bearing — the fact
   * that a non-refused credit was earned for this session (a live mechanical
   * credit or a human `always` release) or restored from replay. The
   * `hasReviewApprove` flag lives on the session bucket, which a task-scope reset
   * rebuilds; the journal-recorded credit outlives that reset, so the ledger
   * carries this provenance bucket-free. It is the ledger's signal for the
   * landing gate's credit-driven escalation (a credited session's first push
   * arms the human ask instead of throwing `no-landing-approval`). Re-marks
   * are idempotent; LRU-capped like the other session maps.
   * @param sessionID The parent session ID the credit is bound to.
   */
  markCreditedApproval(sessionID: string): void
  /**
   * Whether a parent session carries a credit-bearing reviewer APPROVE mark
   * (see `markCreditedApproval`). Refusal-stamped credits are never marked, so
   * this reports the journaled provenance, not the live bucket flag.
   * @param sessionID The parent session ID to test.
   * @returns True when the session carries an earned credit mark.
   */
  hasCreditedApproval(sessionID: string): boolean
  /**
   * Returns the observe-mode admission phase for a session, stamping it when
   * the session is seen for the first time: the running `observed` total
   * increments once per unseen session ID, and the stamped phase is
   * `observe` while the total stays within the configured period, `enforce`
   * past it. `isNew` marks a first-time stamp: the caller journals exactly
   * one `observe` entry per new session — every stamp, not just the
   * completing one. The journaled session IDs ARE the admission dedup set at
   * replay: a stamp that never reaches the journal means a restart re-folds
   * a shorter set and re-increments the `observed` total for a session it
   * already counted, corrupting the period boundary. `completed` marks the
   * period boundary (the total just crossed the configured count on this
   * unseen session ID). A session journaled as admitted (a surviving
   * `would-block` line) but lacking a phase stamp restores its `observe`
   * phase without re-incrementing (a suppression presupposes an
   * observe-phase stamp that aged out of the replay tail). With a configured
   * period of 0, or for an empty session ID, the phase is `off` and nothing
   * is stamped.
   * @param sessionID The parent session ID to look up or stamp.
   * @returns The phase, whether this call stamped it, and whether the
   *     period just completed on this stamp.
   */
  observePhase(sessionID: string): { phase: ObservePhase; isNew: boolean; completed: boolean }
  /**
   * Records one suppressed enforcement decision: increments the running
   * would-block total and returns both running totals for the stamped
   * `would-block` entry. The session is also recorded as admitted — its
   * suppression presupposes an observe-phase stamp, and re-recording keeps
   * the dedup set whole when the stamp's line ages out of the replay tail.
   * @param sessionID The session whose decision was suppressed.
   * @returns The running `observed` and `wouldBlocks` totals.
   */
  noteWouldBlock(sessionID: string): { observed: number; wouldBlocks: number }
  /**
   * Returns the running observe-mode totals plus `pendingSummary`: true once
   * the `observed` total passes the configured period and no journaled
   * end-of-period summary marker exists in the replayed tail — the surfaced
   * summary is journaled as a `kind:"summary"` marker, so it never re-fires
   * after a restart.
   * @returns The totals and the pending-summary probe.
   */
  observeCounts(): { observed: number; wouldBlocks: number; pendingSummary: boolean }
  /**
   * Sets (or clears) a parent session's gate suspension. When on, the
   * session's enforcement decisions keep computing and journaling but every
   * deliberate block is suppressed (observe-like). Keyed per parent; the map
   * is LRU-capped at `maxSessions` like the other session maps. No-op on an
   * empty id.
   * @param sessionID The parent session ID.
   * @param on True to suspend, false to resume.
   */
  setSuspended(sessionID: string, on: boolean): void
  /**
   * Whether a parent session's gate enforcement is currently suspended (with
   * LRU promotion — the map is LRU by use).
   * @param sessionID The parent session ID to test.
   * @returns True when the session is suspended.
   */
  isSuspended(sessionID: string): boolean
  /**
   * Clears a session's gate state for a fresh start with NO restart-sticky
   * carry: the delete→new→cap→release-children sequence of `resetState` with
   * the `replayGrace` merge disabled (the suspension/resume fresh-start
   * contract — credit earned before the clear never rehydrates, even on the
   * grace prompt).
   * @param sessionID The parent session ID to clear.
   * @returns The number of registered child buckets whose metering counters
   *     were non-fresh before clearing (0 for a no-op release).
   */
  clearState(sessionID: string): number
}

/**
 * Upper bound on a replayed VERDICT marker string (a real marker fits
 *  well under this; anything longer is hostile padding). */
const MAX_REPLAY_MARKER_LEN = 512
/** Upper bound on a replayed plan file name (a path-free file name). */
const MAX_REPLAY_NAME_LEN = 128
/** Upper bound on a replayed plans-dir signature string. */
const MAX_REPLAY_SIG_LEN = 4096
/** sha256 hex: the shape of a journaled per-plan content key. */
const SHA256_HEX_RE = /^[0-9a-f]{64}$/
/** Alphabet of a path-free plan file name (length bounded separately by
 *  `MAX_REPLAY_NAME_LEN`). */
const PLAN_NAME_RE = /^[A-Za-z0-9._-]+$/
/** Cap on per-dropped-line telemetry entries per boot; the overflow is
 *  journaled as one summary entry instead (bounded writes, like
 *  maxTrackedNearMiss elsewhere in the codebase). */
const MAX_REPLAY_TELEMETRY = 16
/** Sidecar file name beside the journal: the durable approved-plan store. */
const APPROVAL_LEDGER_FILE = "approved-plans.jsonl"
/** Cap on durable approval records; over-cap, the oldest record is evicted
 *  and the sidecar is rewritten compacted (bounded growth, like the journal). */
const MAX_APPROVAL_RECORDS = 256
/** Upper bound on a replayed emitter agent name (a real agent name fits
 *  well under this; anything longer is hostile padding). */
const MAX_REPLAY_AGENT_LEN = 128
/** Upper bound on a replayed task fingerprint (an internal worktree/branch
 *  identity string; anything longer is hostile padding). */
const MAX_REPLAY_FP_LEN = 1024

/** Shape of a stored project scope token (a `projectScope` output). */
const PROJECT_SCOPE_RE = /^[0-9a-f]{16}$/
/** Upper bound on a replayed observe-mode counter (a real period stays far
 *  below this; anything larger is hostile padding). */
const MAX_REPLAY_OBSERVE_COUNT = 1_000_000

/**
 * One replay line rejected by validation, awaiting its telemetry entry.
 * `sessionID` is present only when the value already passed the shape check
 * (hostile bytes are never echoed back into the journal).
 */
interface ReplayDrop {
  reason: "malformed" | "session-id" | "entry-shape" | "count-invalid"
  sessionID?: string
}

/** The six last-wins replay maps, one store per replayed entry kind.
 *  Observe-mode entries (`observe`/`would-block`) fold directly into the
 *  passed-in period state instead of a map here. The task-scope fold
 *  (`scopeFolds`) is NOT last-wins: it is the ordered per-session scope
 *  record the journal-ordered walk maintains from the plan-APPROVE,
 *  sticky-decision, and `task-complete` row families, and only its FINAL
 *  record is restored. `lastGateFp` parallels `lastGateResult` for the same
 *  `gate` entry kind: the last recorded flip's task fingerprint.
 *  `lastVerdictAgent` parallels `lastReviewVerdict` for the same `verdict`
 *  entry kind: the emitting agent of the last folded verdict (sanitized;
 *  `""` when the row carried no usable `agent`). */
interface ReplayMaps {
  lastGateResult: Map<string, string>
  /** The last recorded flip's task fingerprint (sanitized; absent when the
   *  row carried no usable `fp`). */
  lastGateFp: Map<string, string>
  lastPlanResult: Map<string, { result: string; plan: unknown; planKey: unknown; sig: unknown }>
  lastReviewVerdict: Map<string, string>
  /** The last folded verdict's emitting agent (sanitized; `""` when the row
   *  carried no usable `agent`). */
  lastVerdictAgent: Map<string, string>
  lastEnsemble: Map<string, number>
  lastRefusedApprove: Map<string, boolean>
  /** Last-wins engagement value per session (the `engagement` entry kind). */
  lastEngagement: Map<string, boolean>
  /** Last-wins `plan-review` action per session (`pause`/`accept`/`reject`). */
  lastPlanReview: Map<string, string>
  /** Restored child→parent edges (last-wins per child), for the setup re-seed. */
  childEdges: Map<string, { parent: string; agent: string }>
  /** Ordered per-session task-scope fold (see {@link ScopeFold}). */
  scopeFolds: Map<string, ScopeFold>
}

/**
 * One ordered task-scope fold record for one session, maintained in journal
 * order by the replay walk from the three scope row families: a plan APPROVE
 * carrying a bound plan name establishes `activePlan` (a DIFFERENT name, or a
 * re-approval after a completion, restarts the scope — releases cleared,
 * retire cleared); a sticky decision row records the standing human release
 * within the current scope; a `task-complete` row clears the release and
 * marks the task retired. Only the FINAL record is restored, so a completion
 * supersedes earlier releases and a later approval restarts the scope.
 */
interface ScopeFold {
  /** The active task's plan identity (path-free name; "" unbound). */
  activePlan: string
  /** True once a `task-complete` row retired the task. */
  taskComplete: boolean
  /** The sticky human release within the current scope, or null. */
  sticky: StickyDecisionRow | null
}

/**
 * A fresh empty scope fold record.
 * @returns The empty record.
 */
function emptyScopeFold(): ScopeFold {
  return { activePlan: "", taskComplete: false, sticky: null }
}

/**
 * One folded sticky decision row: a task-scoped standing human release
 * journaled through the decision-row family. `stages` is present only for
 * waiver rows (the parsed waiver stage scope; empty = unscoped).
 */
interface StickyDecisionRow {
  /** The decision kind: `always` (a gate ask) or `waiver` (prompt capture). */
  decision: "always" | "waiver"
  /** The released surface: `plan`, `landing`, `hands-on`, or `waiver`. */
  kind: StickyReleaseKind
  /** Waiver stage scope (agent names); empty array = unscoped. */
  stages: string[]
}

/**
 * The observe-mode period state: the per-session admission phases, the
 * admitted-session dedup set, the running totals, and the end-of-period
 * summary marker. Restored last-wins by the boot replay and mutated at
 * runtime by the ledger's observe methods. The phase map, dedup set, and
 * totals are deliberately uncapped: evicting an admitted session ID would
 * let a later re-admission re-increment the `observed` total and corrupt
 * the period boundary (the double-count guard), so nothing here is subject
 * to the session-bucket LRU.
 */
interface ObservePeriod {
  /** Per-session admission phase (stamped `observe` entries only). */
  phases: Map<string, "observe" | "enforce">
  /** Journaled session IDs (admission stamps + would-blocks): the
   *  admission dedup set (see `observePhase`). */
  admitted: Set<string>
  /** Total admitted sessions (last-wins from the replayed tail). */
  observed: number
  /** Total suppressed blocks (last-wins from the replayed tail). */
  wouldBlocks: number
  /** True when the replayed tail holds a journaled summary marker. */
  summary: boolean
}

/**
 * A fresh empty observe-period state (the boot replay fills it).
 * @returns The empty period state.
 */
function newObservePeriod(): ObservePeriod {
  return { phases: new Map(), admitted: new Set(), observed: 0, wouldBlocks: 0, summary: false }
}

/** One durable approved-plan record (one sidecar line, JSONL): the bound
 *  plan identity plus the project scope it was recorded under. */
interface ApprovalRecord {
  /** The plan file name (path-free, sanitized). */
  name: string
  /** The plan file's sha256 content key (sanitized). */
  key: string
  /** The project scope token (16 hex chars; see `projectScope`). */
  project: string
  /** Key scheme: "spec" = spec-region sha256 (current); absent = legacy
   *  whole-file sha256 (pre-chunk-3.5) or an unknown-scheme record. */
  scheme?: "spec"
}

/**
 * Whether a plan identity is covered by a durable approval: `live` (a record
 * matches the spec key or the legacy whole-file key — content-verified),
 * `stale-key` (a record exists but matches neither key — the plan was edited
 * after approval, or the record cannot prove the spec region unchanged), or
 * `absent` (no usable record).
 */
export type DurablePlanApprovalState = "live" | "stale-key" | "absent"

/**
 * Fresh empty replay maps (the last-wins stores the boot replay fills).
 * @returns The empty map set.
 */
function newReplayMaps(): ReplayMaps {
  return {
    lastGateResult: new Map(),
    lastGateFp: new Map(),
    lastPlanResult: new Map(),
    lastReviewVerdict: new Map(),
    lastVerdictAgent: new Map(),
    lastEnsemble: new Map(),
    lastRefusedApprove: new Map(),
    lastEngagement: new Map(),
    lastPlanReview: new Map(),
    childEdges: new Map(),
    scopeFolds: new Map(),
  }
}

/**
 * Reads the retained journal lines of one file family (the current file plus
 * its rotated generations), oldest-first, up to `remaining` lines.
 * Walks generations newest-first (`file`, then `${file}.1`, `.2`, …, stopping
 * at the first missing generation — a missing current file is the
 * post-rotation state, so the walk starts at `.1`) and stops as soon as the
 * collected lines alone satisfy the bound. An unreadable generation (a
 * directory in its place, a permission failure) folds nothing from its file:
 * one message-free `replay` error entry is journaled (the walk is bounded by
 * the generation count, so the entries are bounded too) and the walk
 * continues with the next-older generation.
 * @param file Absolute path of the current journal file.
 * @param remaining The per-file tail bound in lines (the caller guarantees a
 *     positive bound).
 * @param errorSink Absolute path of the file that receives the `replay`
 *     error telemetry row when a generation is unreadable (the shared
 *     journal, never the file being read).
 * @returns The file's tail-window lines, oldest-first (empty when nothing is
 *     read).
 */
function readReplayFileLines(file: string, remaining: number, errorSink: string): string[] {
  const blocks: string[][] = []
  let generation = fs.existsSync(file) ? 0 : 1
  for (;;) {
    const gen = generation === 0 ? file : `${file}.${generation}`
    if (!fs.existsSync(gen)) break
    let block: string[]
    try {
      block = fs.readFileSync(gen, "utf8").split("\n").filter(Boolean)
    } catch {
      // One unreadable generation must not sink the replay of the rest:
      // journal a message-free error entry on the shared sink, fold
      // nothing, keep walking.
      appendLine(errorSink, JSON.stringify({ ts: now(), type: "replay", error: true }))
      block = []
    }
    blocks.unshift(block)
    if (blocks.reduce((total, chunk) => total + chunk.length, 0) >= remaining) break
    generation++
  }
  return blocks.flat().slice(-remaining)
}

/**
 * Sorts one replay line by its `ts` field for the cross-sink merge. An
 * ISO-8601 `ts` is lexicographically sortable; a missing or unparseable `ts`
 * sorts oldest (it never wins a last-wins fold against a parseable row).
 * @param line The raw journal line.
 * @returns The sort key (empty string sorts first).
 */
function replayTsKey(line: string): string {
  try {
    const ts = (JSON.parse(line) as { ts?: unknown }).ts
    return typeof ts === "string" && !Number.isNaN(Date.parse(ts)) ? ts : ""
  } catch {
    return ""
  }
}

/**
 * Reads the retained journal lines covering the replay window across all
 * sinks, oldest-first by timestamp. Walks the shared file's generations,
 * then every `sessions/` file family's generations the same way (a guarded
 * directory read: any failure yields no session sinks; every entry maps to
 * its family root — `p1.jsonl.2` roots at `p1.jsonl` — and the set of roots
 * is deduplicated, so each generation is visited exactly once by its own
 * family's walk, including a fully rotated family whose current file is
 * absent), merges all collected lines, orders them by the `ts` field
 * (missing/unparseable sorts oldest), and slices the global tail. Last-wins
 * folds are per-sessionID and each sessionID's rows live in exactly one
 * file, so cross-file ordering cannot change any per-session fold; the
 * global `ts` sort only preserves the observe-mode global totals' last-wins
 * behavior.
 * @param journalPath Absolute path of the current shared journal file.
 * @param sessionsDir Absolute path of the per-session journal directory.
 * @param tailLines The tail bound in lines (non-positive reads nothing).
 * @returns The tail-window lines, oldest-first (empty when nothing is read).
 */
function readReplayLines(journalPath: string, sessionsDir: string, tailLines: number): string[] {
  if (tailLines <= 0) return []
  const lines = readReplayFileLines(journalPath, tailLines, journalPath)
  let sessionFiles: string[] = []
  try {
    sessionFiles = [
      ...new Set(
        fs
          .readdirSync(sessionsDir)
          .filter((name) => /\.jsonl(\.\d+)?$/.test(name))
          .map((name) => path.join(sessionsDir, name.replace(/(\.\d+)+$/, ""))),
      ),
    ]
  } catch {
    // No sessions dir (legacy layout) or unreadable: replay the shared file only.
  }
  for (const file of sessionFiles) lines.push(...readReplayFileLines(file, tailLines, journalPath))
  return lines
    .map((line, i) => ({ line, key: replayTsKey(line), i }))
    .sort((a, b) => (a.key === b.key ? a.i - b.i : a.key < b.key ? -1 : 1))
    .map(({ line }) => line)
    .slice(-tailLines)
}

/**
 * Parses one journal line for the boot replay.
 * @param line The raw journal line.
 * @returns The parsed record when `line` is a JSON object of a replay-typed
 *     kind (`gate`, `plan`, `verdict`, `ensemble`, `observe`,
 *     `would-block`, `suspended`, `child-edge`, `permission`); `"malformed"` when
 *     the line does not parse to an object record (a JSON error, a
 *     non-object, or an array); and `null` for every other, replay-inert
 *     line (any other entry type) — inert lines stay inert without
 *     telemetry, exactly as before. `permission` rows are admitted for the
 *     sticky-decision fold only (see {@link foldStickyDecision}); ask rows,
 *     forced-ask consumes, and other `permission` audit flavors fold inert.
 */
function parseReplayLine(line: string): Record<string, unknown> | "malformed" | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(line)
  } catch {
    return "malformed"
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return "malformed"
  const entry = parsed as Record<string, unknown>
  if (
    entry.type !== "gate" &&
    entry.type !== "plan" &&
    entry.type !== "verdict" &&
    entry.type !== "ensemble" &&
    entry.type !== "observe" &&
    entry.type !== "would-block" &&
    entry.type !== "suspended" &&
    entry.type !== "child-edge" &&
    entry.type !== "permission" &&
    entry.type !== "task-complete" &&
    entry.type !== "engagement" &&
    entry.type !== "plan-impact" &&
    entry.type !== "plan-review"
  ) {
    return null
  }
  return entry
}

/**
 * Folds a `gate` entry into the last-wins result and fingerprint maps. Only
 * `PASS`/`FAIL` replay (a `WAIVED` or other sub-kind stays inert). The
 * flipping-entry rule: an enforce-mode unverified PASS never flipped (nor did
 * it at runtime), so it is not recorded as the deciding last result; a
 * flag-mode unverified PASS DID flip at runtime and restores green; a
 * field-less legacy PASS restores (fail-open, documented). The task
 * fingerprint is last-wins on PASS and FAIL alike (a trailing FAIL's
 * fingerprint is restored even though the gate stays red, so a later
 * recovery sees the right identity); the enforce-unverified early return
 * folds neither result nor fingerprint.
 * @param entry The parsed `gate` entry.
 * @param lastGateResult The last-wins gate-result map to fill.
 * @param lastGateFp The last-wins gate-fingerprint map to fill.
 * @param sessionID The validated session ID.
 */
function foldGate(
  entry: Record<string, unknown>,
  lastGateResult: Map<string, string>,
  lastGateFp: Map<string, string>,
  sessionID: string,
): void {
  const result = entry.result
  if (result === "PASS") {
    if (entry.verified === false && entry.mode !== "flag") return
    recordGateFlip(lastGateResult, lastGateFp, sessionID, result, entry.fp)
    return
  }
  if (result === "FAIL") recordGateFlip(lastGateResult, lastGateFp, sessionID, result, entry.fp)
}

/**
 * Records one flipping gate result last-wins: the result always, and the
 * sanitized task fingerprint only when the row carries a non-empty one (a
 * legacy row without `fp` leaves a previously folded fingerprint standing).
 * @param lastGateResult The last-wins gate-result map to fill.
 * @param lastGateFp The last-wins gate-fingerprint map to fill.
 * @param sessionID The validated session ID.
 * @param result The flipping result (`PASS` or `FAIL`).
 * @param fp The raw `fp` field of the gate entry.
 */
function recordGateFlip(
  lastGateResult: Map<string, string>,
  lastGateFp: Map<string, string>,
  sessionID: string,
  result: string,
  fp: unknown,
): void {
  lastGateResult.set(sessionID, result)
  const fingerprint = sanitizeFingerprint(fp)
  if (fingerprint !== "") lastGateFp.set(sessionID, fingerprint)
}

/**
 * Applies a bound plan approval to the session's ordered scope fold: a
 * binding APPROVE establishes `activePlan`; a DIFFERENT name, or a
 * re-approval after a completion, restarts the scope (release cleared, retire
 * cleared). An unbound approval (`""`) is a no-op for scope. Sanitizes the
 * raw journaled name through `sanitizePlanName`.
 * @param maps The replay maps holding the scope folds.
 * @param sessionID The validated session ID.
 * @param plan The raw `plan` field of the plan entry.
 */
function applyPlanApprovalScope(maps: ReplayMaps, sessionID: string, plan: unknown): void {
  const name = sanitizePlanName(plan)
  if (name === "") return
  const fold = maps.scopeFolds.get(sessionID) ?? emptyScopeFold()
  if (name !== fold.activePlan || fold.taskComplete) {
    fold.sticky = null
    fold.taskComplete = false
    fold.activePlan = name
    maps.scopeFolds.set(sessionID, fold)
  }
}

/**
 * Folds a `plan` entry into the last-wins result map and the ordered scope
 * fold. Only `APPROVE`/`BLOCK` replay (a `WAIVED`/`STALE` or other sub-kind
 * stays inert). The identity fields (plan/planKey/plansSig) are stored raw —
 * the restore loop sanitizes them; a bound APPROVE additionally drives the
 * scope fold (see {@link applyPlanApprovalScope}).
 * @param entry The parsed `plan` entry.
 * @param maps The replay maps to fill.
 * @param sessionID The validated session ID.
 */
function foldPlan(entry: Record<string, unknown>, maps: ReplayMaps, sessionID: string): void {
  const result = entry.result
  if (result !== "APPROVE" && result !== "BLOCK") return
  maps.lastPlanResult.set(sessionID, {
    result,
    plan: entry.plan,
    planKey: entry.planKey,
    sig: entry.plansSig,
  })
  if (result === "APPROVE") applyPlanApprovalScope(maps, sessionID, entry.plan)
}

/**
 * Sanitizes a replayed emitter agent name: a string within the length bound.
 * Anything else — a non-string or an over-length value — degrades to the
 * empty agent, which matches no configured reviewer name (a degraded
 * attribution is inert, never a drop). The agent is only ever
 * equality-compared against the configured reviewer name, so the length
 * bound is the only defense needed; never throws.
 * @param agent The raw `agent` field of a replayed verdict or child-edge
 *     entry.
 * @returns The agent name, or `""` when unattributed.
 */
function sanitizeReplayAgent(agent: unknown): string {
  if (typeof agent !== "string" || agent.length > MAX_REPLAY_AGENT_LEN) return ""
  return agent
}

/**
 * Folds a `verdict` entry into the last-wins verdict and agent maps. Only
 * `task-result` sources are credited — the landing gate releases only on a
 * delivery-attributed reviewer verdict, so a verdict streamed in child text
 * never restores the flag (this is how the invariant holds across a restart
 * too) — and a trailing `VERDICT: BLOCK` leaves the flag off (the recency
 * boundary is the last verdict, not task reset). The marker must be a string
 * within the marker bound; a shape violation is a drop, never a silent skip
 * (a hostile marker never folded at runtime either). The emitting agent is
 * folded last-wins beside the verdict (sanitized; a legacy row without
 * `agent` degrades to `""`), so the restore can credit only the verdicts the
 * configured reviewer agent emitted.
 * @param entry The parsed `verdict` entry.
 * @param lastReviewVerdict The last-wins verdict map to fill.
 * @param lastVerdictAgent The last-wins verdict-agent map to fill.
 * @param sessionID The validated session ID.
 * @returns A shape drop for an invalid marker, or `null` when folded or inert.
 */
function foldVerdict(
  entry: Record<string, unknown>,
  lastReviewVerdict: Map<string, string>,
  lastVerdictAgent: Map<string, string>,
  sessionID: string,
): ReplayDrop | null {
  if (entry.source !== "task-result") return null
  const marker = entry.marker
  if (typeof marker !== "string" || marker.length > MAX_REPLAY_MARKER_LEN) {
    return { reason: "entry-shape", sessionID }
  }
  lastReviewVerdict.set(sessionID, marker.includes("APPROVE") ? "APPROVE" : "BLOCK")
  lastVerdictAgent.set(sessionID, sanitizeReplayAgent(entry.agent))
  return null
}

/**
 * Folds an `ensemble` entry into the last-wins count map. The count must be
 * a non-negative integer; a count above the ensemble size clamps to it
 * (enforcement only tests `>= REVIEW_ENSEMBLE_SIZE`, so the clamped restore
 * is enforcement-equivalent), and a non-integer or negative count is a drop.
 * The entry's explicit `refusedApprove` stamp follows the last valid entry:
 * an explicit refusal, an explicit human-grant clear, or an absent field
 * (which un-stamps a prior refusal, matching the runtime rule).
 * @param entry The parsed `ensemble` entry.
 * @param lastEnsemble The last-wins count map to fill.
 * @param lastRefusedApprove The last-wins refusal-stamp map to fill.
 * @param sessionID The validated session ID.
 * @returns A count drop for an invalid count, or `null` when folded.
 */
function foldEnsemble(
  entry: Record<string, unknown>,
  lastEnsemble: Map<string, number>,
  lastRefusedApprove: Map<string, boolean>,
  sessionID: string,
): ReplayDrop | null {
  const count = entry.count
  if (typeof count !== "number" || !Number.isInteger(count) || count < 0) {
    return { reason: "count-invalid", sessionID }
  }
  lastEnsemble.set(sessionID, Math.min(count, REVIEW_ENSEMBLE_SIZE))
  if (entry.refusedApprove === true) lastRefusedApprove.set(sessionID, true)
  else if (entry.refusedApprove === false) lastRefusedApprove.set(sessionID, false)
  else lastRefusedApprove.delete(sessionID)
  return null
}

/**
 * Validates and extracts the `observed`/`wouldBlocks` pair carried by an
 * observe-mode replay entry: both must be non-negative integers within the
 * counter bound (a real period stays far below it; anything larger or
 * non-integer is hostile padding, not a count).
 * @param entry The parsed `observe` or `would-block` entry.
 * @returns The validated counts, or `null` when either fails its shape.
 */
function validateObserveCounts(
  entry: Record<string, unknown>,
): { observed: number; wouldBlocks: number } | null {
  const { observed, wouldBlocks } = entry
  if (
    typeof observed !== "number" ||
    !Number.isInteger(observed) ||
    observed < 0 ||
    observed > MAX_REPLAY_OBSERVE_COUNT
  ) {
    return null
  }
  if (
    typeof wouldBlocks !== "number" ||
    !Number.isInteger(wouldBlocks) ||
    wouldBlocks < 0 ||
    wouldBlocks > MAX_REPLAY_OBSERVE_COUNT
  ) {
    return null
  }
  return { observed, wouldBlocks }
}

/**
 * Folds an `observe` entry into the period state. An end-of-period summary
 * marker (`kind:"summary"`) folds inert: it is exempt from the phase check
 * and sets only the summary flag (the `pendingSummary` probe) — never the
 * per-session phase, the dedup set, or the totals. A plain admission stamp
 * requires an exact `observe`/`enforce` phase and records the session as
 * admitted. The totals are last-wins.
 * @param entry The parsed `observe` entry.
 * @param period The period state to fill.
 * @param sessionID The validated session ID.
 * @returns A drop record for invalid counts or a bad phase, or `null` when
 *     folded (a summary marker folds with no drop).
 */
function foldObserve(
  entry: Record<string, unknown>,
  period: ObservePeriod,
  sessionID: string,
): ReplayDrop | null {
  const counts = validateObserveCounts(entry)
  if (counts === null) return { reason: "count-invalid", sessionID }
  if (entry.kind === "summary") {
    period.summary = true
    return null
  }
  if (entry.phase !== "observe" && entry.phase !== "enforce") {
    return { reason: "entry-shape", sessionID }
  }
  period.phases.set(sessionID, entry.phase)
  period.admitted.add(sessionID)
  period.observed = counts.observed
  period.wouldBlocks = counts.wouldBlocks
  return null
}

/**
 * Folds a `would-block` entry into the period state: records the session as
 * admitted (its suppression presupposes an observe-phase stamp) and applies
 * last-wins to the totals. The entry's `cause` is audit-only and never
 * folded.
 * @param entry The parsed `would-block` entry.
 * @param period The period state to fill.
 * @param sessionID The validated session ID.
 * @returns A count drop for invalid counters, or `null` when folded.
 */
function foldWouldBlock(
  entry: Record<string, unknown>,
  period: ObservePeriod,
  sessionID: string,
): ReplayDrop | null {
  const counts = validateObserveCounts(entry)
  if (counts === null) return { reason: "count-invalid", sessionID }
  period.admitted.add(sessionID)
  period.observed = counts.observed
  period.wouldBlocks = counts.wouldBlocks
  return null
}

/**
 * Folds a `suspended` entry into the suspension map: an `action:"off"` sets
 * the session suspended, an `action:"on"` clears it (both last-wins, so the
 * later marker in a restart's replay tail decides). Two flavors fold inert —
 * they record a refusal or a suppression, never a suspension change: a
 * `refused:true` entry (the `allowSuspend:false` refusal journal, which never
 * touched ledger state and must not resurrect a suspension after a restart)
 * and the `event:"would-block"` audit entry. Any other (missing or unknown)
 * action is a shape drop: a hostile action must not silently toggle the flag.
 * @param entry The parsed `suspended` entry.
 * @param suspended The suspension map to fill.
 * @param sessionID The validated session ID.
 * @returns A shape drop for an invalid action, or `null` when folded (or the
 *     audit flavor, which folds nothing and drops nothing).
 */
function foldSuspended(
  entry: Record<string, unknown>,
  suspended: Map<string, true>,
  sessionID: string,
): ReplayDrop | null {
  if (entry.event === "would-block" || entry.refused === true) return null
  if (entry.action !== "off" && entry.action !== "on") {
    return { reason: "entry-shape", sessionID }
  }
  if (entry.action === "off") suspended.set(sessionID, true)
  else suspended.delete(sessionID)
  return null
}

/** Upper bound on a replayed sticky decision row's stage list (a real
 *  waiver scope names a handful of pipeline stages; anything longer is
 *  hostile padding). */
const MAX_REPLAY_STAGES = 16

/**
 * Sanitizes a replayed waiver stage list: an array of bounded strings. Any
 * non-array shape, a non-string element, or an over-length element degrades
 * the whole scope to unscoped (the consumer's `waiverCovers` treats an
 * empty scope as covering every stage, so a degraded restore stays a live
 * release — fail-open in the release direction, which is what the human
 * granted; the stage names are never an enforcement input beyond matching).
 * @param stages The raw `stages` field of a sticky waiver row.
 * @returns The sanitized stage names (empty when unscoped or degraded).
 */
function sanitizeStickyStages(stages: unknown): string[] {
  if (!Array.isArray(stages)) return []
  const names: string[] = []
  for (const stage of stages) {
    if (typeof stage !== "string" || stage.length < 1 || stage.length > MAX_REPLAY_AGENT_LEN) {
      return []
    }
    names.push(stage)
  }
  return names.slice(0, MAX_REPLAY_STAGES)
}

/**
 * Folds a `permission` decision row into the session's ordered scope fold
 * (the sticky release within the current scope). Three flavors fold inert
 * without a drop: any row carrying `action` (an ask row) or `event` (a
 * forced-ask consume, a latch-steal, a suspicion, an unrecorded reply) —
 * audit rows, never decisions — and a legacy decision row without `scope`
 * (pre-sticky rows stay replay-inert, exactly as before this fold existed).
 * A row with `scope:"task"` and a valid decision/kind pair folds; anything
 * else (a non-allowlisted decision, a bad kind, a wrong scope) is a shape
 * drop — a hostile row must not silently decide a release.
 * @param entry The parsed `permission` entry.
 * @param maps The replay maps to fill.
 * @param sessionID The validated session ID.
 * @returns A shape drop for an invalid sticky row, or `null` when folded or
 *     inert.
 */
function foldStickyDecision(
  entry: Record<string, unknown>,
  maps: ReplayMaps,
  sessionID: string,
): ReplayDrop | null {
  if (entry.action !== undefined || entry.event !== undefined) return null
  if (entry.scope === undefined) return null // legacy decision row: replay-inert as before
  if (entry.scope !== "task") return { reason: "entry-shape", sessionID }
  const decision = entry.decision
  if (decision !== "always" && decision !== "waiver") return { reason: "entry-shape", sessionID }
  const kind = entry.kind
  if (kind !== "plan" && kind !== "landing" && kind !== "hands-on" && kind !== "waiver") {
    return { reason: "entry-shape", sessionID }
  }
  const fold = maps.scopeFolds.get(sessionID) ?? emptyScopeFold()
  fold.sticky = {
    decision,
    kind,
    stages: decision === "waiver" ? sanitizeStickyStages(entry.stages) : [],
  }
  maps.scopeFolds.set(sessionID, fold)
  return null
}

/**
 * Folds a `task-complete` entry into the session's ordered scope fold: the
 * explicit/implicit retire clears the sticky human release within the
 * current scope and marks the task complete, so the FINAL restored record
 * carries the retirement (a later plan APPROVE restarts the scope). The
 * optional `plan` field is audit-only (the retired plan's name, when bound)
 * and is not validated into state.
 * @param entry The parsed `task-complete` entry.
 * @param maps The replay maps to fill.
 * @param sessionID The validated session ID.
 */
function foldTaskComplete(maps: ReplayMaps, sessionID: string): void {
  const fold = maps.scopeFolds.get(sessionID) ?? emptyScopeFold()
  fold.sticky = null
  fold.taskComplete = true
  maps.scopeFolds.set(sessionID, fold)
}

/**
 * Folds a `child-edge` entry into the re-seed edge map (last-wins per child).
 * The parent ID must pass the host session-ID shape (a hostile parent is a
 * drop, never folded); the emitter agent is optional — a non-string or
 * over-length value degrades to "" (the re-seed then skips the emitter
 * cache for that child) without dropping the edge.
 * @param entry The parsed `child-edge` entry.
 * @param maps The last-wins maps to fill.
 * @param sessionID The validated child session ID.
 * @returns A session-id drop for an invalid parent, or `null` when folded.
 */
function foldChildEdge(
  entry: Record<string, unknown>,
  maps: ReplayMaps,
  sessionID: string,
): ReplayDrop | null {
  const parent = entry.parent
  if (typeof parent !== "string" || !REPLAY_SESSION_RE.test(parent)) {
    return { reason: "session-id", sessionID }
  }
  const agent = entry.agent
  maps.childEdges.set(sessionID, {
    parent,
    agent: sanitizeReplayAgent(agent),
  })
  return null
}

/**
 * Dispatches a replay-typed entry to its per-kind fold.
 * @param entry The parsed replay-typed entry.
 * @param maps The last-wins maps to fill.
 * @param sessionID The validated session ID.
 * @param period The observe-mode period state to fill (observe-mode kinds
 *     only).
 * @returns The kind's drop record, or `null` when the entry folded (or is an
 *     inert sub-kind, which folds nothing and drops nothing).
 */
/**
 * One per-kind replay fold arm: folds a parsed journal entry of a known
 * `type` into the last-wins maps / period state, returning the kind's drop
 * record (or `null` when the entry folded).
 */
type ReplayFoldArm = (
  entry: Record<string, unknown>,
  maps: ReplayMaps,
  sessionID: string,
  period: ObservePeriod,
  suspended: Map<string, true>,
) => ReplayDrop | null

/** Folds an `engagement` row: last-wins boolean per session. */
function foldEngagement(
  entry: Record<string, unknown>,
  maps: ReplayMaps,
  sessionID: string,
): ReplayDrop | null {
  const engaged = entry.engaged
  if (typeof engaged === "boolean") maps.lastEngagement.set(sessionID, engaged)
  return null
}

/**
 * Folds a `plan-review` row: last-wins action per session, recorded only for
 * the three lifecycle literals (`pause`/`accept`/`reject`); a hostile or
 * unknown action drops the record (fold-inert, like a non-boolean
 * engagement field).
 * @param entry The parsed `plan-review` entry.
 * @param maps The replay maps holding the last-wins plan-review map.
 * @param sessionID The validated session ID.
 * @returns Always null (the row folds or is inert; never dropped).
 */
function foldPlanReview(
  entry: Record<string, unknown>,
  maps: ReplayMaps,
  sessionID: string,
): ReplayDrop | null {
  const action = entry.action
  if (action === "pause" || action === "accept" || action === "reject") {
    maps.lastPlanReview.set(sessionID, action)
  }
  return null
}

/** Dispatch table for the replay fold: one arm per known entry `type`.
 *  Unknown types (and the inert `plan-impact` rows) fall through to the
 *  ensemble arm via the `foldReplayLine` fallback, matching the historical
 *  if-chain's tail. */
const REPLAY_FOLDS: Record<string, ReplayFoldArm> = {
  gate: (entry, maps, sessionID) => {
    foldGate(entry, maps.lastGateResult, maps.lastGateFp, sessionID)
    return null
  },
  plan: (entry, maps, sessionID) => {
    foldPlan(entry, maps, sessionID)
    return null
  },
  verdict: (entry, maps, sessionID) =>
    foldVerdict(entry, maps.lastReviewVerdict, maps.lastVerdictAgent, sessionID),
  observe: (entry, _maps, sessionID, period) => foldObserve(entry, period, sessionID),
  "would-block": (entry, _maps, sessionID, period) => foldWouldBlock(entry, period, sessionID),
  suspended: (entry, _maps, sessionID, _period, suspended) =>
    foldSuspended(entry, suspended, sessionID),
  "child-edge": (entry, maps, sessionID) => foldChildEdge(entry, maps, sessionID),
  permission: (entry, maps, sessionID) => foldStickyDecision(entry, maps, sessionID),
  "task-complete": (_entry, maps, sessionID) => {
    foldTaskComplete(maps, sessionID)
    return null
  },
  engagement: (entry, maps, sessionID) => foldEngagement(entry, maps, sessionID),
  "plan-review": (entry, maps, sessionID) => foldPlanReview(entry, maps, sessionID),
  "plan-impact": () => null,
}

/**
 * Folds one parsed replay-typed journal entry into the replay state, by
 * dispatching on `entry.type` through `REPLAY_FOLDS`; unknown types fall to
 * the ensemble arm (the historical if-chain's fallback).
 * @param entry The parsed replay-typed entry.
 * @param maps The last-wins maps to fill.
 * @param sessionID The validated session ID.
 * @param period The observe-mode period state to fill (observe-mode kinds
 *     only).
 * @param suspended The suspended-session map to fill (`suspended` kind only).
 * @returns The kind's drop record, or `null` when the entry folded (or is an
 *     inert sub-kind, which folds nothing and drops nothing).
 */
function foldReplayLine(
  entry: Record<string, unknown>,
  maps: ReplayMaps,
  sessionID: string,
  period: ObservePeriod,
  suspended: Map<string, true>,
): ReplayDrop | null {
  const fold = REPLAY_FOLDS[entry.type as string]
  if (fold) return fold(entry, maps, sessionID, period, suspended)
  return foldEnsemble(entry, maps.lastEnsemble, maps.lastRefusedApprove, sessionID)
}

/**
 * Journals one `suppressed`-style telemetry entry per dropped replay line,
 * capped at `MAX_REPLAY_TELEMETRY` per-line entries plus a single summary
 * entry naming the suppressed remainder when the cap is exceeded (bounded
 * writes: a hostile journal cannot force unbounded appends per boot). The
 * entries are replay-inert and status-inert by construction — neither the
 * boot replay nor the status chain reads a `kind:"replay"` line.
 * `appendLine` is fail-open by contract; this never throws.
 * @param journalPath Absolute path of the journal to append to.
 * @param drops The dropped lines, oldest-first.
 */
function journalReplayDrops(journalPath: string, drops: ReplayDrop[]): void {
  if (drops.length === 0) return
  const ts = now()
  for (const drop of drops.slice(0, MAX_REPLAY_TELEMETRY)) {
    const entry: Record<string, unknown> = {
      ts,
      type: "suppressed",
      kind: "replay",
      reason: drop.reason,
    }
    if (drop.sessionID !== undefined) entry.sessionID = drop.sessionID
    appendLine(journalPath, JSON.stringify(entry))
  }
  if (drops.length > MAX_REPLAY_TELEMETRY) {
    appendLine(
      journalPath,
      JSON.stringify({
        ts,
        type: "suppressed",
        kind: "replay",
        event: "summary",
        dropped: drops.length,
      }),
    )
  }
}

/**
 * Returns the session's bucket (minting a fresh one when absent) and tags it
 * with replay grace — the one-prompt survival window for the first
 * post-restart prompt. Both restore loops touch the same bucket object when
 * a session has both a gate and a plan result, so the tag is set idempotently.
 * @param states The session→state map to populate.
 * @param sessionID The session whose bucket is restored.
 * @returns The bucket, tagged and stored.
 */
function graceBucket(states: Map<string, GateState>, sessionID: string): GateState {
  const s = states.get(sessionID) ?? newState()
  s.replayGrace = true
  states.set(sessionID, s)
  return s
}

/**
 * Restores the last flipping `GATE: PASS` per session (a trailing
 * `GATE: FAIL` keeps the gate red), tagging each bucket with replay grace.
 * A PASS whose fold recorded a task fingerprint stamps it onto the bucket,
 * so the restart-recovery carry matches the same worktree/branch identity
 * the live path stamped; a legacy row (no `fp`) restores the empty
 * fingerprint, byte-compatible with pre-fingerprint journals.
 * @param states The session→state map to populate.
 * @param lastGateResult The replayed last-wins gate results.
 * @param lastGateFp The replayed last-wins gate fingerprints (sanitized).
 */
function restoreGatePasses(
  states: Map<string, GateState>,
  lastGateResult: Map<string, string>,
  lastGateFp: Map<string, string>,
): void {
  for (const [sessionID, result] of lastGateResult) {
    if (result !== "PASS") continue
    const s = graceBucket(states, sessionID)
    s.hasGatePass = true
    const fp = lastGateFp.get(sessionID) ?? ""
    if (fp !== "") s.taskFingerprint = fp
  }
}

/**
 * Restores the last plan `APPROVE` per session with its sanitized bound
 * identity (a field-less, over-length, or malformed-shape field degrades to
 * the unbound/unstamped value — legacy lines replay unchanged). A restored
 * bound verdict is validated against the current plans dir immediately on
 * the next enforcing dispatch — stricter than the unbound accept-once rule.
 * @param states The session→state map to populate.
 * @param lastPlanResult The replayed last-wins plan results.
 */
function restorePlanVerdicts(
  states: Map<string, GateState>,
  lastPlanResult: ReplayMaps["lastPlanResult"],
): void {
  for (const [sessionID, entry] of lastPlanResult) {
    if (entry.result !== "APPROVE") continue
    const s = graceBucket(states, sessionID)
    s.hasPlanVerdict = true
    s.approvedPlan = sanitizePlanName(entry.plan)
    s.approvedPlanKey = sanitizePlanKey(entry.planKey)
    s.plansSignature = sanitizePlansSig(entry.sig)
  }
}

/**
 * Restores the last `task-result` `VERDICT: APPROVE` per session,
 * refusal-suppressed and agent-attributed: a session whose last counted
 * ensemble entry stamped `refusedApprove:true` (the runtime refused to credit
 * that APPROVE because fewer than two dispatches were counted) is not
 * re-credited on restart; an explicit clear (`refusedApprove:false`) or an
 * absent field both let the verdict through — only an explicit refusal
 * suppresses it. A verdict not attributed to the configured reviewer agent —
 * a plan-reviewer verdict, a legacy unattributed row, or a hostile/degraded
 * agent — never credits the landing gate either: the live path credits only
 * reviewer deliveries, so replay must not over-credit a verdict another
 * pipeline agent emitted.
 * @param states The session→state map to populate.
 * @param lastReviewVerdict The replayed last-wins reviewer verdicts.
 * @param lastVerdictAgent The replayed last-wins verdict agents (sanitized).
 * @param lastRefusedApprove The replayed last-wins refusal stamps.
 * @param reviewerAgent The configured reviewer agent name a credited verdict
 *     must be attributed to.
 * @param creditedApprovals The bucket-free credit trace to stamp with each
 *     restored, non-refused credit (the mark outlives a later task-scope reset).
 */
function restoreReviewApprovals(
  states: Map<string, GateState>,
  lastReviewVerdict: Map<string, string>,
  lastVerdictAgent: Map<string, string>,
  lastRefusedApprove: Map<string, boolean>,
  reviewerAgent: string,
  creditedApprovals: Map<string, number>,
): void {
  for (const [sessionID, result] of lastReviewVerdict) {
    if (result !== "APPROVE") continue
    if (lastRefusedApprove.get(sessionID) === true) continue
    if (lastVerdictAgent.get(sessionID) !== reviewerAgent) continue
    graceBucket(states, sessionID).hasReviewApprove = true
    creditedApprovals.set(sessionID, Date.now())
  }
}

/**
 * A human always-grant releases the landing gate by stamping the last
 * ensemble entry `refusedApprove:false` (a clear). Restores the flag so a
 * human release survives restart — independent of any verdict, since a human
 * release outranks the mechanical ensemble. A still-refused session (last
 * entry `refusedApprove:true`) falls through and is not re-credited.
 * @param states The session→state map to populate.
 * @param lastRefusedApprove The replayed last-wins refusal stamps.
 * @param creditedApprovals The bucket-free credit trace to stamp with each
 *     restored human grant (the mark outlives a later task-scope reset).
 */
function restoreHumanGrants(
  states: Map<string, GateState>,
  lastRefusedApprove: Map<string, boolean>,
  creditedApprovals: Map<string, number>,
): void {
  for (const [sessionID, refused] of lastRefusedApprove) {
    if (refused !== false) continue
    graceBucket(states, sessionID).hasReviewApprove = true
    creditedApprovals.set(sessionID, Date.now())
  }
}

/**
 * Restores the ordered per-session scope fold into the replayed buckets: the
 * FINAL scope record decides — the active plan identity, the retire stamp,
 * and the sticky human release within the current scope (a `task-complete`
 * row cleared it, so a completed task restores no release). Each released
 * surface's flag is stamped to mirror its runtime grant path exactly: a
 * `plan` grant stamps the plan-gate release pair (`hasPlanVerdict` + the
 * `humanApproval` provenance), a `landing` grant stamps `hasReviewApprove`
 * and credits the bucket-free credit trace (escalation provenance, mirroring
 * the live reply path), a `hands-on` grant stamps `handsOnRelease`, and a
 * `waiver` stamps the waiver family (`userWaiver` as the redacted presence
 * marker, the sanitized stage scope, and the `stickyRelease` provenance).
 * Buckets ride the same replay-grace window as the other restore loops.
 * @param states The session→state map to populate.
 * @param maps The filled replay maps.
 * @param creditedApprovals The bucket-free credit trace stamped by the
 *     landing sticky grant (its provenance for escalation).
 */
function restoreScopeFolds(
  states: Map<string, GateState>,
  maps: ReplayMaps,
  creditedApprovals: Map<string, number>,
): void {
  for (const [sessionID, fold] of maps.scopeFolds) {
    const s = graceBucket(states, sessionID)
    s.activePlan = fold.activePlan
    s.taskComplete = fold.taskComplete
    if (fold.taskComplete || fold.sticky === null) continue
    const row = fold.sticky
    if (row.decision === "waiver") {
      s.userWaiver = "<present>"
      s.userWaiverScope = row.stages
      s.stickyRelease = true
      continue
    }
    if (row.kind === "plan") {
      s.hasPlanVerdict = true
      s.humanApproval = true
    } else if (row.kind === "landing") {
      s.hasReviewApprove = true
      creditedApprovals.set(sessionID, Date.now())
    } else if (row.kind === "hands-on") {
      s.handsOnRelease = true
    }
  }
}

/**
 * Restores the last ensemble count per session (already clamped to the
 * ensemble size at fold time). A session that also had a flag restored
 * carries replay grace from the loops above, so it survives the grace prompt
 * together with its count; an ensemble-only line restores the bare count
 * with no grace and no one-prompt carry.
 * @param states The session→state map to populate.
 * @param lastEnsemble The replayed last-wins ensemble counts.
 */
function restoreEnsembleCounts(
  states: Map<string, GateState>,
  lastEnsemble: Map<string, number>,
): void {
  for (const [sessionID, count] of lastEnsemble) {
    const s = states.get(sessionID) ?? newState()
    s.reviewerDispatches = count
    states.set(sessionID, s)
  }
}

/**
 * Restores the last-wins engagement value per session (the dormant-until-
 * engaged pipeline switch). A hostile non-boolean field was already dropped
 * at fold time, so the map holds booleans only; a session with no engagement
 * row keeps its fresh dormant bucket.
 * @param states The session→state map to populate.
 * @param lastEngagement The replayed last-wins engagement values.
 */
function restoreEngagement(
  states: Map<string, GateState>,
  lastEngagement: Map<string, boolean>,
): void {
  for (const [sessionID, engaged] of lastEngagement) {
    const s = graceBucket(states, sessionID)
    s.engaged = engaged
  }
}

/**
 * Restores the last-wins `plan-review` action per session: `pause` re-arms
 * the user-review pending flag; `accept` and `reject` restore it cleared (a
 * reject also journaled `task-complete`, whose scope fold retires the task —
 * mergeAfterReplay then returns a fresh bucket, so the retired task never
 * carries the flag).
 * @param states The session→state map to populate.
 * @param lastPlanReview The replayed last-wins plan-review actions.
 */
function restorePlanReview(
  states: Map<string, GateState>,
  lastPlanReview: Map<string, string>,
): void {
  for (const [sessionID, action] of lastPlanReview) {
    graceBucket(states, sessionID).planReviewPending = action === "pause"
  }
}

/**
 * Runs the restore loops in order (gate, plan, verdict, human-grant,
 * scope fold, ensemble, engagement, plan-review) over the replayed maps.
 * @param states The session→state map to populate.
 * @param maps The filled replay maps.
 * @param reviewerAgent The configured reviewer agent name a credited verdict
 *     must be attributed to (see `restoreReviewApprovals`).
 * @param creditedApprovals The bucket-free credit trace stamped by the
 *     verdict/human-grant restore loops (their provenance for escalation).
 */
function restoreBuckets(
  states: Map<string, GateState>,
  maps: ReplayMaps,
  reviewerAgent: string,
  creditedApprovals: Map<string, number>,
): void {
  restoreGatePasses(states, maps.lastGateResult, maps.lastGateFp)
  restorePlanVerdicts(states, maps.lastPlanResult)
  restoreReviewApprovals(
    states,
    maps.lastReviewVerdict,
    maps.lastVerdictAgent,
    maps.lastRefusedApprove,
    reviewerAgent,
    creditedApprovals,
  )
  restoreHumanGrants(states, maps.lastRefusedApprove, creditedApprovals)
  restoreScopeFolds(states, maps, creditedApprovals)
  restoreEnsembleCounts(states, maps.lastEnsemble)
  restoreEngagement(states, maps.lastEngagement)
  restorePlanReview(states, maps.lastPlanReview)
}

/**
 * Sanitizes a replayed task fingerprint: a string within the length bound.
 * Anything else — a non-string, an empty value, or an over-length one —
 * degrades to the empty fingerprint (the restore then leaves the bucket
 * unstamped). The fingerprint is an internal worktree/branch identity that
 * is only ever equality-compared, so the length bound is the only defense
 * needed; never throws.
 * @param fp The raw `fp` field of a replayed gate entry.
 * @returns The fingerprint, or `""` when unstamped.
 */
export function sanitizeFingerprint(fp: unknown): string {
  if (typeof fp !== "string" || fp.length < 1 || fp.length > MAX_REPLAY_FP_LEN) return ""
  return fp
}

/**
 * Sanitizes a replayed bound plan file name: a path-free name within the
 * length bound. Anything else — a path separator, hostile bytes, an
 * over-length value, or a non-string — degrades to the unbound empty name.
 * @param plan The raw `plan` field of a replayed plan entry.
 * @returns The bound name, or `""` when unbound.
 */
function sanitizePlanName(plan: unknown): string {
  if (typeof plan !== "string" || plan.length < 1 || plan.length > MAX_REPLAY_NAME_LEN) return ""
  return PLAN_NAME_RE.test(plan) ? plan : ""
}

/**
 * Sanitizes a replayed bound plan content key: a sha256 hex digest (the
 * journaled key is always a content hash). Anything else degrades to the
 * unbound empty key.
 * @param planKey The raw `planKey` field of a replayed plan entry.
 * @returns The bound key, or `""` when unbound.
 */
function sanitizePlanKey(planKey: unknown): string {
  if (typeof planKey !== "string" || !SHA256_HEX_RE.test(planKey)) return ""
  return planKey
}

/**
 * Sanitizes a replayed plans-dir signature: a string within the length bound
 * (its `name:sha256hex,…` shape is revalidated against the live dir scan at
 * dispatch). Anything else degrades to the empty stamp, which keeps the
 * approval on the documented accept-once path.
 * @param sig The raw `plansSig` field of a replayed plan entry.
 * @returns The stamp, or `""` when unstamped.
 */
function sanitizePlansSig(sig: unknown): string {
  if (typeof sig !== "string" || sig.length > MAX_REPLAY_SIG_LEN) return ""
  return sig
}

/**
 * Journals one `approval ledger:` error entry for a failed sidecar operation
 * (one per failed operation — bounded). The entries are replay-inert and
 * status-inert by construction: neither the boot replay nor the status chain
 * reads them for state.
 * @param journalPath Absolute path of the journal to append to.
 * @param detail The failure detail (no plan content, no prompt text).
 */
function journalApprovalLedgerError(journalPath: string, detail: string): void {
  appendLine(
    journalPath,
    JSON.stringify({ ts: now(), type: "error", error: `approval ledger: ${detail}` }),
  )
}

/**
 * The durable store's project identity: a stable short hash of the resolved
 * project directory. A byte-identical plan approved in one project must not
 * exempt a same-named, same-content plan in another (the sidecar lives beside
 * the shared journal, outside any single checkout).
 * @param projectDir The project directory to scope under.
 * @returns The 16-hex-char scope token.
 */
function projectScope(projectDir: string): string {
  return createHash("sha256").update(path.resolve(projectDir)).digest("hex").slice(0, 16)
}

/**
 * Parses one sidecar line into a durable approval record, or null when the
 * line is not a well-shaped record (bad JSON, a non-object, or a field that
 * fails its shape check: the path-free plan-name alphabet, the sha256-hex
 * key, the 16-hex-char project scope). A `scheme` field of exactly `"spec"`
 * tags the record as spec-region-keyed; any other value (including unknown
 * strings) degrades to absent — the legacy whole-file scheme — so the
 * dual-key match still applies and nothing is dropped that could legitimately
 * match. The sidecar is untrusted input: a torn or hostile line sanitizes
 * away rather than throwing.
 * @param line The raw sidecar line.
 * @returns The parsed record, or null when malformed.
 */
function parseApprovalLine(line: string): ApprovalRecord | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(line)
  } catch {
    return null
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null
  const entry = parsed as Record<string, unknown>
  const name = sanitizePlanName(entry.name)
  const key = sanitizePlanKey(entry.key)
  const project =
    typeof entry.project === "string" && PROJECT_SCOPE_RE.test(entry.project) ? entry.project : ""
  if (name === "" || key === "" || project === "") return null
  return entry.scheme === "spec" ? { name, key, project, scheme: "spec" } : { name, key, project }
}

/**
 * Loads the durable approved-plan sidecar into the in-memory store at boot.
 * A missing file is the fresh state (empty store, nothing journaled); any
 * other read failure journals one error and leaves the store empty (the
 * non-durable wall then applies). Lines are untrusted input: a torn or
 * hostile line sanitizes away (see `parseApprovalLine`). Last-wins per
 * (project, name); insertion order is the eviction order. An over-cap file
 * (a torn tail or concurrent appends) still bounds the memory store; the file
 * recompacts on the next eviction-triggered rewrite.
 * @param sidecarPath Absolute path of the sidecar file.
 * @param journalPath Absolute path of the journal a read failure journals into.
 * @returns The loaded store (empty when nothing valid was read).
 */
function loadApprovedPlans(sidecarPath: string, journalPath: string): Map<string, ApprovalRecord> {
  const map = new Map<string, ApprovalRecord>()
  let raw: string
  try {
    raw = fs.readFileSync(sidecarPath, "utf8")
  } catch (e) {
    // ENOENT is the fresh-install state: nothing to journal.
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") {
      journalApprovalLedgerError(journalPath, `read failed: ${e}`)
    }
    return map
  }
  for (const line of raw.split("\n")) {
    if (line === "") continue
    const record = parseApprovalLine(line)
    if (record !== null) map.set(`${record.project}:${record.name}`, record)
  }
  evictTo(map, MAX_APPROVAL_RECORDS)
  return map
}

/**
 * Replays the journal's tail so completed `GATE: PASS` entries restore
 * gate state after a restart. Reads the last `tailLines` lines across all
 * retained generations; drops malformed lines. Only the *last flipping*
 * gate result per session decides the restored state, mirroring the runtime
 * latest-wins rule (a trailing `GATE: FAIL` keeps the gate red). Fail-open
 * by construction: each generation read is guarded per file (an unreadable
 * file journals a `replay` error entry and is excluded — see
 * `readReplayLines`), and the folds and the telemetry appends never throw.
 *
 * Replay treats the journal as untrusted input: a sessionID must match the
 * host shape or its line is dropped (never echoed back into the journal), a
 * non-`task-result` verdict is inert, an oversized verdict marker is a shape
 * drop, an ensemble count above the ensemble size clamps to it (a
 * non-integer or negative count is a drop), and a bound plan identity
 * degrades to the unbound value when it fails its shape (a name with path
 * separators or over-length, a non-sha256 key, an over-length signature).
 * An `observe` stamp requires an exact `observe`/`enforce` phase (a bad
 * phase is a shape drop), an end-of-period `kind:"summary"` marker is
 * exempt from the phase check and folds inert (it sets only the summary
 * probe), and an `observe` or `would-block` line requires both counters to
 * be non-negative integers within the counter bound (a violation is a count
 * drop). Each dropped line journals one replay-inert `suppressed` telemetry
 * entry (capped per boot, with a summary entry for the overflow) so
 * truncation and forgery are observable.
 *
 * A replayed `suspended` entry restores the session's gate suspension
 * last-wins: `action:"off"` re-suspends, `action:"on"` resumes (a restart
 * mid-suspension stays suspended — no silent re-enforcement); the
 * `event:"would-block"` audit flavor folds inert, and a missing or unknown
 * action is a shape drop. The restored map is LRU-capped after replay like
 * the other session maps.
 *
 * A replayed `child-edge` entry (last-wins per child) parks the restored
 * edge for the setup re-seed: the parent ID must pass the host session-ID
 * shape (a hostile parent is a session-id drop) and the optional emitter
 * agent degrades to "" when non-string or over-length. The restored edges
 * are applied later by the ledger's `reseedEdges` — never during replay —
 * so a reload re-applies them exactly once.
 * @param states The session→state map to populate.
 *
 * A replayed green is journaled audited evidence, not runtime proof: the
 * flipping-entry filter skips enforce-mode `verified:false` PASSes (they
 * never flipped at runtime, so they must not restore), while flag-mode
 * `verified:false` PASSes restore green (they DID flip at runtime) and
 * field-less legacy PASSes restore (fail-open). `unverifiedPass` is never
 * restored here and is task-scoped like `seen`/`reads`: as a consequence, a
 * runtime `gate-unverified` block (unverified PASS awaiting evidence) can
 * become a `no-gate-pass` block after a restart — same enforcement strength,
 * different diagnostic message. Both restore loops
 * tag the bucket with `replayGrace` — the one-prompt survival window for the
 * first post-restart prompt; both loops touch the same bucket object when a
 * session has both a gate and a plan result, so the tag is set once. A plan
 * APPROVE entry may carry the bound identity fields `plan` (file name) and
 * `planKey` (that file's content hash); when present and well-shaped they
 * restore `approvedPlan`/`approvedPlanKey` (absent, non-string, or
 * malformed-shape → unbound ""). It
 * may also carry `plansSig` (the plans-dir content signature stamped at
 * approval); when present and within the length bound it restores
 * `plansSignature`, so a restored
 * unbound verdict is validated against the current dir like a live one — a
 * plan edited while the process was down drops it (`signature-mismatch`
 * STALE) instead of riding the accept-once window. A field-less,
 * over-length, or malformed-shape entry restores the empty stamp, which the
 * grace prompt's
 * executor dispatch accepts once and re-stamps via reconcilePlanStamp —
 * edits _after_ restart still invalidate the restored approval. A
 * restored *bound* verdict is stricter than the unbound accept-once rule: it
 * is validated against the current files immediately on the next enforcing
 * dispatch (bound plan edited or removed → stale, no accept-once window).
 *
 * The reviewer-approval restore is refusal-suppressed: when the last counted
 * reviewer-ensemble entry for a session stamped `refusedApprove:true` (the
 * runtime refused to credit that APPROVE because fewer than two dispatches
 * were counted), replay does not restore `hasReviewApprove` — a refused credit
 * must not re-credit itself across a restart. It is also agent-attributed: a
 * verdict row whose folded `agent` is not the configured reviewer name (a
 * plan-reviewer verdict, a legacy unattributed row, or a hostile/degraded
 * agent) never restores the flag — the live path credits only reviewer
 * deliveries. An explicit clear on that last
 * entry (`refusedApprove:false`, a human grant) instead restores the flag so a
 * human release survives restart; an absent field lets a verdict through. The
 * ensemble count itself is always restored last-wins per session; a session
 * that also had a gate/plan verdict (or a clearing) restored keeps its
 * `replayGrace`, while an ensemble-only count line restores the bare count with
 * no grace and no one-prompt carry.
 * @param states The session→state map to populate.
 * @param journalPath Absolute path of the JSONL journal to replay. The scan
 *     walks the retained generations newest-first (`journalPath`, then
 *     `${journalPath}.1`, `.2`, …, stopping at the first missing generation —
 *     a missing current file is the post-rotation state, so the walk starts
 *     at `.1`), and stops as soon as the collected lines alone satisfy the
 *     tail bound: the walk stops within the newest generation that alone
 *     satisfies the tail bound; worst case bounded by retained-generation
 *     sizes, never the full `journalMaxGenerations × journalMaxBytes`
 *     envelope. An unreadable generation journals one message-free
 *     `replay` error entry, folds nothing from it, and the walk continues.
 * @param tailLines Maximum number of combined journal lines replayed; older
 *     lines are dropped.
 * @param creditedApprovals The bucket-free credit trace to stamp with each
 *     restored, non-refused credit (threaded to the restore loops).
 * @param reviewerAgent The configured reviewer agent name a restored
 *     reviewer-approval credit must be attributed to (see
 *     `restoreReviewApprovals`).
 * @param observePeriod The observe-mode period state to fill: the per-session
 *     admission phases, the admitted-session dedup set, the running totals
 *     (last-wins), and the summary-marker probe fold in directly, online, as
 *     the lines are read.
 * @param childEdges The map the restored `child-edge` records (last-wins per
 *     child) are parked into for the setup re-seed; filled at the end of the
 *     walk, never applied here.
 */
function replayGatePasses(
  states: Map<string, GateState>,
  journalPath: string,
  sessionsDir: string,
  tailLines: number,
  creditedApprovals: Map<string, number>,
  reviewerAgent: string,
  observePeriod: ObservePeriod,
  suspended: Map<string, true>,
  childEdges: Map<string, { parent: string; agent: string }>,
): void {
  const maps = newReplayMaps()
  const drops: ReplayDrop[] = []
  for (const line of readReplayLines(journalPath, sessionsDir, tailLines)) {
    const entry = parseReplayLine(line)
    if (entry === null) continue
    if (entry === "malformed") {
      drops.push({ reason: "malformed" })
      continue
    }
    const sessionID = entry.sessionID
    if (typeof sessionID !== "string" || !REPLAY_SESSION_RE.test(sessionID)) {
      drops.push({ reason: "session-id" })
      continue
    }
    const drop = foldReplayLine(entry, maps, sessionID, observePeriod, suspended)
    if (drop) drops.push(drop)
  }
  restoreBuckets(states, maps, reviewerAgent, creditedApprovals)
  for (const [child, edge] of maps.childEdges) childEdges.set(child, edge)
  journalReplayDrops(journalPath, drops)
}

/**
 * Creates the gate ledger and replays prior gate passes from the journal.
 * Both session maps are LRU-capped at `maxSessions` (promote-on-touch);
 * beyond the cap the least-recently-used entry is evicted. A replayed bucket
 * evicted before its grace prompt loses the one-prompt survival (fail-toward-
 * strict); without the tag the next prompt is an ordinary full reset.
 * Live parents register via `markParent` (per prompt, guarded dispatch, task
 * delivery, edge resolution, and root-session event). A registered parent is
 * never evicted from `states` while it stays in the bounded registry — leaked child buckets now only evict each other. Protection never
 * creates a bucket (minting is unchanged) and boot replay stays strict (the
 * registry is empty at replay, so the `replayGrace` loss behavior is
 * unchanged).
 * @param journalPath Absolute path of the JSONL journal to replay.
 * @param maxSessions LRU cap for tracked sessions (states + parent map).
 * @param replayTailLines Replay tail window in lines for the boot replay
 *     (see `replayGatePasses`).
 * @param approvalLedgerPath Optional absolute path of the durable approved-plan
 *     sidecar; defaults to `approved-plans.jsonl` beside the journal (the
 *     metrics dir). Injected to redirect the sidecar (tests, fail-open drills).
 * @param observeSessions The configured observe-mode period length (number of
 *     admitted parent sessions that observe before enforcement switches on);
 *     0 (the default) disables observe mode entirely.
 * @param reviewerAgent The configured reviewer agent name a restored
 *     reviewer-approval credit must be attributed to (defaults to the
 *     canonical reviewer name; the wiring passes `config.agents.reviewer` so
 *     a renamed reviewer works).
 * @param sessionsDir Optional absolute path of the per-session journal
 *     directory replayed alongside the shared file; defaults to `sessions`
 *     beside the journal (the metrics dir). Injected to redirect the sinks
 *     (tests).
 * @returns A ledger bound to a fresh in-memory session map.
 */

/**
 * The maps and per-instance state one ledger owns: the session buckets, the
 * child-verdict store, the observe-mode period, the suspension map, and the
 * durable approved-plan sidecar (path + loaded store). The edge maps and the
 * live-parent registry live in the registry (`src/ledger-registry.ts`); the
 * credit trace map in its own creator.
 */
interface LedgerMaps {
  /** The journal path (the edge rows' and persist errors' append target). */
  journalPath: string
  /** Session buckets, LRU-capped at `maxSessions`. */
  states: Map<string, GateState>
  /** Latest VERDICT marker observation per child session. */
  childVerdicts: Map<string, ChildVerdict>
  /** Observe-mode period state (see {@link ObservePeriod}). */
  observePeriod: ObservePeriod
  /** Sessions whose gate enforcement is suspended (parent → true). */
  suspended: Map<string, true>
  /** The durable approved-plan sidecar path. */
  sidecarPath: string
  /** The durable approved-plan store loaded from the sidecar at boot. */
  approvedPlans: Map<string, ApprovalRecord>
}

/**
 * Creates the maps and per-instance state one ledger owns. The sidecar path
 * defaults beside the journal; the boot load is fail-open (a missing file is
 * the fresh state; an unreadable one journals one error).
 * @param journalPath The journal path (the sidecar's default sibling).
 * @param approvalLedgerPath Optional explicit sidecar path override.
 * @returns The ledger's maps and sidecar state (see {@link LedgerMaps}).
 */
function createLedgerMaps(journalPath: string, approvalLedgerPath?: string): LedgerMaps {
  const states = new Map<string, GateState>()
  // Latest VERDICT marker observation per child session (rationale at
  // recordChildVerdict); the observe period and suspension map are restored
  // last-wins by the boot replay (see ObservePeriod).
  const childVerdicts = new Map<string, ChildVerdict>()
  const observePeriod = newObservePeriod()
  const suspended = new Map<string, true>()
  // Durable approved-plan sidecar: a bounded store of bound plan approvals
  // (name + content key + project scope) beside the journal, outside the
  // session bucket and the replay window. The boot load is fail-open (a
  // missing file is the fresh state; an unreadable one journals one error).
  const sidecarPath =
    approvalLedgerPath ?? path.join(path.dirname(journalPath), APPROVAL_LEDGER_FILE)
  const approvedPlans = loadApprovedPlans(sidecarPath, journalPath)
  return {
    journalPath,
    states,
    childVerdicts,
    observePeriod,
    suspended,
    sidecarPath,
    approvedPlans,
  }
}

/**
 * The state the observe-cap concern reads and mutates: the configured
 * admission period and the period state it folds into.
 */
interface ObserveCapState {
  /** The configured observe-mode admission period (0 disables). */
  observeSessions: number
  /** The period state (phases, dedup set, totals, summary probe). */
  period: ObservePeriod
}

/**
 * Returns the observe-mode admission phase for a session, stamping it for
 * the first time this process sees it (see the interface doc for the
 * journaled-dedup-set invariant). With a configured period of 0, or for an
 * empty session ID, nothing is stamped and the phase is `off`. A session
 * that already carries a stamped phase returns it unchanged (no re-stamp).
 * A session restored as admitted from replay but lacking a phase stamp
 * (its stamp line aged out of the tail, a surviving `would-block` kept it
 * in the dedup set) restores its `observe` phase without re-incrementing —
 * the double-count guard.
 * @param st The observe-cap state.
 * @param sessionID The parent session ID to look up or stamp.
 * @returns The phase, whether this call stamped it, and whether the period
 *     just completed on this stamp.
 */
function observePhaseOf(
  st: ObserveCapState,
  sessionID: string,
): { phase: ObservePhase; isNew: boolean; completed: boolean } {
  if (st.observeSessions === 0 || !sessionID)
    return { phase: "off", isNew: false, completed: false }
  const stamped = st.period.phases.get(sessionID)
  if (stamped !== undefined) return { phase: stamped, isNew: false, completed: false }
  if (st.period.admitted.has(sessionID)) {
    // A suppression presupposes an observe-phase stamp; restore that phase
    // without re-incrementing (the double-count guard).
    st.period.phases.set(sessionID, "observe")
    return { phase: "observe", isNew: false, completed: false }
  }
  const observed = (st.period.observed += 1)
  const phase = observed <= st.observeSessions ? "observe" : "enforce"
  st.period.phases.set(sessionID, phase)
  st.period.admitted.add(sessionID)
  return { phase, isNew: true, completed: observed === st.observeSessions + 1 }
}

/**
 * Records one suppressed enforcement decision: increments the running
 * would-block total, re-records the session in the admission dedup set (its
 * suppression presupposes an observe-phase stamp, and re-recording keeps the
 * set whole when the stamp's line ages out of the replay tail), and returns
 * both running totals for the stamped `would-block` entry.
 * @param st The observe-cap state.
 * @param sessionID The session whose decision was suppressed.
 * @returns The running `observed` and `wouldBlocks` totals.
 */
function noteWouldBlockIn(
  st: ObserveCapState,
  sessionID: string,
): { observed: number; wouldBlocks: number } {
  st.period.wouldBlocks += 1
  if (sessionID) st.period.admitted.add(sessionID)
  return { observed: st.period.observed, wouldBlocks: st.period.wouldBlocks }
}

/**
 * Returns the running observe-mode totals plus `pendingSummary`: true once
 * the `observed` total passes the configured period and no journaled
 * end-of-period summary marker exists in the replayed tail (see the
 * interface doc — the surfaced summary is journaled as a `kind:"summary"`
 * marker, so it never re-fires after a restart). With a configured period of
 * 0 the total never passes the period, so the probe is always false.
 * @param st The observe-cap state.
 * @returns The totals and the pending-summary probe.
 */
function observeCountsOf(st: ObserveCapState): {
  observed: number
  wouldBlocks: number
  pendingSummary: boolean
} {
  return {
    observed: st.period.observed,
    wouldBlocks: st.period.wouldBlocks,
    pendingSummary: st.period.observed > st.observeSessions && !st.period.summary,
  }
}

/**
 * Creates the observe-mode admission concern: the phase stamping, the
 * would-block recording, and the totals probe, all folding into one period
 * state.
 * @param observeSessions The configured observe-mode admission period.
 * @param observePeriod The period state the boot replay restored.
 * @returns The `observePhase`, `noteWouldBlock`, and `observeCounts` methods.
 */
function createObserveCap(
  observeSessions: number,
  observePeriod: ObservePeriod,
): Pick<GateLedger, "observePhase" | "noteWouldBlock" | "observeCounts"> {
  const st: ObserveCapState = { observeSessions, period: observePeriod }
  return {
    observePhase: (sessionID) => observePhaseOf(st, sessionID),
    noteWouldBlock: (sessionID) => noteWouldBlockIn(st, sessionID),
    observeCounts: () => observeCountsOf(st),
  }
}

/**
 * The state the suspension concern reads and mutates: the LRU cap and the
 * suspension map.
 */
interface SuspensionState {
  /** The LRU cap for the suspension map. */
  maxSessions: number
  /** Sessions whose gate enforcement is suspended (parent → true). */
  suspended: Map<string, true>
}

/**
 * Sets (or clears) a parent session's gate suspension (see the interface
 * doc). Setting is LRU-touched and capped at `maxSessions`; clearing just
 * deletes. No-op on an empty id.
 * @param st The suspension state.
 * @param sessionID The parent session ID.
 * @param on True to suspend, false to resume.
 */
function setSuspendedIn(st: SuspensionState, sessionID: string, on: boolean): void {
  if (!sessionID) return
  if (!on) {
    st.suspended.delete(sessionID)
    return
  }
  promote(st.suspended, sessionID)
  st.suspended.set(sessionID, true)
  cap(st.suspended, st.maxSessions)
}

/**
 * Whether a parent session's gate enforcement is currently suspended, with
 * LRU promotion (the map is LRU by use).
 * @param st The suspension state.
 * @param sessionID The parent session ID to test.
 * @returns True when the session is suspended.
 */
function isSuspendedIn(st: SuspensionState, sessionID: string): boolean {
  if (!st.suspended.has(sessionID)) return false
  promote(st.suspended, sessionID)
  return true
}

/**
 * Creates the suspension concern: set/clear and probe over one suspension
 * map, LRU-capped at `maxSessions` (only admitted parents set it, so no
 * extra bound is needed). The bodies live at module level; the factory only
 * builds the state object.
 * @param maxSessions The LRU cap for the suspension map.
 * @param suspended The suspension map the boot replay restored.
 * @returns The `setSuspended` and `isSuspended` methods.
 */
function createSuspension(
  maxSessions: number,
  suspended: Map<string, true>,
): Pick<GateLedger, "setSuspended" | "isSuspended"> {
  const st: SuspensionState = { maxSessions, suspended }
  return {
    setSuspended: (sessionID, on) => setSuspendedIn(st, sessionID, on),
    isSuspended: (sessionID) => isSuspendedIn(st, sessionID),
  }
}

/**
 * The state the bucket-store concern reads and mutates: the session buckets,
 * their LRU cap, the registry's eviction-protection predicate, and the
 * child-release sweep the resets trigger.
 */
interface BucketStoreState {
  /** Session buckets, LRU-capped at `maxSessions`. */
  states: Map<string, GateState>
  /** The LRU cap for the bucket map. */
  maxSessions: number
  /** The registry's live-parent predicate (eviction protection). */
  isParent: (sessionID: string) => boolean
  /** The registry's child-release sweep (triggered by every reset). */
  releaseChildren: (sessionID: string) => number
}

/**
 * The shared body of `resetState`/`clearState`: deletes the session's
 * bucket, rebuilds it (merging the restart-sticky flags when both the
 * merge flag and the prior bucket's `replayGrace` are set), re-caps the
 * LRU, and releases the parent's registered children. Written once so the
 * two callers cannot drift.
 * @param st The bucket-store state.
 * @param sessionID The parent session ID to reset.
 * @param merge Whether the rebuild may merge restart-sticky flags (only
 *     when the prior bucket carries `replayGrace`).
 * @returns The number of registered child buckets freed (0 for a no-op).
 */
function resetBucket(st: BucketStoreState, sessionID: string, merge: boolean): number {
  const prior = st.states.get(sessionID)
  st.states.delete(sessionID)
  st.states.set(sessionID, merge && prior?.replayGrace ? mergeAfterReplay(prior) : newState())
  cap(st.states, st.maxSessions, st.isParent)
  return st.releaseChildren(sessionID)
}

/**
 * Returns the gate state for a session, creating an empty one on first
 * access, with LRU promotion and a re-cap on insertion.
 * @param st The bucket-store state.
 * @param sessionID The parent session ID.
 * @returns The session's mutable gate state.
 */
function stateOf(st: BucketStoreState, sessionID: string): GateState {
  promote(st.states, sessionID)
  let s = st.states.get(sessionID)
  if (!s) {
    s = newState()
    st.states.set(sessionID, s)
    cap(st.states, st.maxSessions, st.isParent)
  }
  return s
}

/**
 * Resets a session's gate state for a task-scope change. The
 * restart-sticky merge arm carries the replayed flags through the first
 * post-restart prompt (the one-prompt grace); an explicit `merge`
 * argument overrides the armed-grace default (a reset-at-capture
 * approval forces false — no old-scope carry).
 * @param st The bucket-store state.
 * @param sessionID The parent session ID to reset.
 * @param merge Optional merge override (undefined keeps the armed default).
 * @returns The number of registered child buckets freed (0 for a no-op).
 */
function resetStateIn(st: BucketStoreState, sessionID: string, merge?: boolean): number {
  return resetBucket(st, sessionID, merge ?? st.states.get(sessionID)?.replayGrace ?? false)
}

/**
 * Creates the session-bucket store: the get-or-create, the pure read, and
 * the two reset shapes over one bucket map. The bodies live at module
 * level; the factory only builds the state object.
 * @param deps The bucket map, cap, protection predicate, and release sweep.
 * @returns The `state`, `peek`, `resetState`, and `clearState` methods.
 */
function createBucketStore(
  deps: BucketStoreState,
): Pick<GateLedger, "state" | "peek" | "resetState" | "clearState"> {
  const st = deps
  return {
    state: (sessionID) => stateOf(st, sessionID),
    /**
     * Returns the gate state for a session without creating one, for
     * read-only checks that must not insert a fresh bucket into the LRU.
     * Pure read: no insertion, no LRU reorder.
     * @param sessionID The session ID to look up.
     * @returns The session's mutable gate state, or `undefined` when none exists.
     */
    peek(sessionID: string): GateState | undefined {
      return st.states.get(sessionID)
    },
    resetState: (sessionID, merge) => resetStateIn(st, sessionID, merge),
    /**
     * Fresh start: the same rebuild sequence with the merge arm disabled,
     * so no credit (including the restart-sticky flags) rehydrates after a
     * suspension or resume clear.
     * @param sessionID The parent session ID to clear.
     * @returns The number of registered child buckets freed (0 for a no-op).
     */
    clearState(sessionID: string): number {
      return resetBucket(st, sessionID, false)
    },
  }
}

/**
 * The state the verdict-store concern reads and mutates: the LRU cap and
 * the verdict map.
 */
interface VerdictStoreState {
  /** The LRU cap for the verdict map. */
  maxSessions: number
  /** Latest VERDICT marker observation per child session. */
  childVerdicts: Map<string, ChildVerdict>
}

/**
 * Records one VERDICT marker observation for a child session. `changed`
 * = the marker or source actually moved; the setup layer journals a
 * streamed verdict observation iff this is true (per (child, marker,
 * source) first-sight dedup). LRU promotion + cap are unchanged; the
 * recordedAt stamp refreshes on every re-observation (the plausibility
 * join keeps a verdict plausible while its parent's task is live).
 * @param st The verdict-store state.
 * @param childID The child session ID.
 * @param marker The observed VERDICT marker.
 * @param source The observation source.
 * @returns True when the marker or source changed (journal the entry).
 */
function recordChildVerdictIn(
  st: VerdictStoreState,
  childID: string,
  marker: string,
  source: string,
): boolean {
  const prev = st.childVerdicts.get(childID) ?? { marker: "", source: "", recordedAt: 0 }
  const changed = prev.marker !== marker || prev.source !== source
  promote(st.childVerdicts, childID)
  st.childVerdicts.set(childID, { marker, source, recordedAt: Date.now() })
  cap(st.childVerdicts, st.maxSessions)
  return changed
}

/**
 * Returns a child session's latest verdict observation, with LRU
 * promotion; the empty verdict when none is recorded.
 * @param st The verdict-store state.
 * @param childID The child session ID.
 * @returns The child's verdict (empty when unrecorded).
 */
function childVerdictOf(st: VerdictStoreState, childID: string): ChildVerdict {
  promote(st.childVerdicts, childID)
  return st.childVerdicts.get(childID) ?? { marker: "", source: "", recordedAt: 0 }
}

/**
 * Snapshot of every recorded verdict carrying a marker: no LRU
 * promotion, no cap (pure read for the attribution scan). Returns copies
 * so callers cannot mutate the store in place.
 * @param st The verdict-store state.
 * @returns The `{ child, verdict }` records, insertion order.
 */
function evidencedChildrenOf(
  st: VerdictStoreState,
): Array<{ child: string; verdict: ChildVerdict }> {
  const out: Array<{ child: string; verdict: ChildVerdict }> = []
  for (const [child, v] of st.childVerdicts)
    if (v.marker !== "") out.push({ child, verdict: { ...v } })
  return out
}

/**
 * Creates the child-verdict store: the record (with first-sight change
 * detection), the promote-on-read lookup, and the attribution snapshot, over
 * one LRU-capped map. The bodies live at module level; the factory only
 * builds the state object.
 * @param maxSessions The LRU cap for the verdict map.
 * @param childVerdicts The verdict map (shared with the registry's release
 *     sweep, which clears entries on a parent's task boundary).
 * @returns The `recordChildVerdict`, `childVerdict`, and `evidencedChildren`
 *     methods.
 */
function createVerdictStore(
  maxSessions: number,
  childVerdicts: Map<string, ChildVerdict>,
): Pick<GateLedger, "recordChildVerdict" | "childVerdict" | "evidencedChildren"> {
  const st: VerdictStoreState = { maxSessions, childVerdicts }
  return {
    recordChildVerdict: (childID, marker, source) =>
      recordChildVerdictIn(st, childID, marker, source),
    childVerdict: (childID) => childVerdictOf(st, childID),
    evidencedChildren: () => evidencedChildrenOf(st),
  }
}

/**
 * The state the durable approval store reads and mutates: the sidecar path,
 * the journal path (persist-error provenance), and the loaded store.
 */
interface ApprovalStoreState {
  /** The durable approved-plan sidecar path. */
  sidecarPath: string
  /** The journal path the persist-error row appends to. */
  journalPath: string
  /** The durable approved-plan store (project:name → record). */
  approvedPlans: Map<string, ApprovalRecord>
}

/**
 * Persists the sidecar after a record: a plain append (the appended line is
 * the store's most-recent entry) or, when an eviction just happened, a full
 * compacted rewrite so the file holds exactly the bounded store. Creates the
 * parent directory. Any fs failure journals one `approval ledger:` error and
 * reports false — the record rolls its in-memory entry back (an unpersisted
 * approval must not exempt in-process).
 * @param st The approval-store state.
 * @param record The just-recorded entry (the append payload).
 * @param rewrite True when an eviction just happened (the file is rewritten).
 * @returns True when the write landed.
 */
function persistApprovalStore(
  st: ApprovalStoreState,
  record: ApprovalRecord,
  rewrite: boolean,
): boolean {
  try {
    fs.mkdirSync(path.dirname(st.sidecarPath), { recursive: true })
    if (rewrite) {
      const lines = [...st.approvedPlans.values()].map((r) => JSON.stringify(r))
      fs.writeFileSync(st.sidecarPath, `${lines.join("\n")}\n`)
    } else {
      fs.appendFileSync(st.sidecarPath, `${JSON.stringify(record)}\n`)
    }
    return true
  } catch (e) {
    journalApprovalLedgerError(st.journalPath, `persist failed: ${e}`)
    return false
  }
}

/**
 * Re-keys a content-verified legacy (or untagged) approval record to the
 * current spec scheme: replaces the in-memory entry (delete+set keeps the
 * entry most-recent, like `recordPlanApprovalDurable`), appends the
 * re-keyed record to the sidecar (the last-wins loader collapses the
 * superseded line; the next eviction rewrite compacts), and journals one
 * replay-inert `plan-rekey` row. A no-op when the record already carries
 * the current scheme's key. Fail-open: a persist failure rolls the
 * in-memory entry back to the legacy record — the content match was real,
 * so the verdict stays live — and the next scan retries; the persist error
 * itself is journaled by `persistApprovalStore`.
 * @param st The approval-store state.
 * @param record The matched record (legacy whole-file or untagged).
 * @param key The plan's current spec-region sha256 key.
 * @param sessionID The journal-row provenance; omitted (or failing the
 *     replay ID shape) leaves the field off the row.
 */
function rekeyApprovalRecord(
  st: ApprovalStoreState,
  record: ApprovalRecord,
  key: string,
  sessionID?: string,
): void {
  if (record.key === key && record.scheme === "spec") return
  const mapKey = `${record.project}:${record.name}`
  const updated: ApprovalRecord = {
    name: record.name,
    key,
    project: record.project,
    scheme: "spec",
  }
  st.approvedPlans.delete(mapKey)
  st.approvedPlans.set(mapKey, updated)
  if (!persistApprovalStore(st, updated, false)) {
    st.approvedPlans.set(mapKey, record)
    return
  }
  const sid =
    typeof sessionID === "string" && REPLAY_SESSION_RE.test(sessionID) ? sessionID : undefined
  appendLine(
    st.journalPath,
    JSON.stringify({
      ts: now(),
      type: "plan-rekey",
      ...(sid !== undefined ? { sessionID: sid } : {}),
      plan: record.name,
      reason: "durable-key-scheme",
      from: record.key,
      to: key,
    }),
  )
}

/**
 * Probes the durable approval store for a plan: `absent` when the name
 * or key is unusable or no record covers the project-scoped name,
 * `stale-key` when a record exists but matches neither the spec-region
 * key nor the legacy whole-file key, `live` otherwise — and a live
 * legacy (or untagged) record is transparently re-keyed to the current
 * scheme (see `rekeyApprovalRecord`).
 * @param st The approval-store state.
 * @param name The plan file name.
 * @param key The plan's current spec-region sha256 key.
 * @param wholeKey The plan's current whole-file sha256 key.
 * @param projectDir The current project directory (the scope key).
 * @param sessionID Optional journal-row provenance for the re-key.
 * @returns The durable approval state for the plan.
 */
function planApprovalStateOf(
  st: ApprovalStoreState,
  name: string,
  key: string,
  wholeKey: string,
  projectDir: string,
  sessionID?: string,
): DurablePlanApprovalState {
  const n = sanitizePlanName(name)
  const k = sanitizePlanKey(key)
  if (n === "" || k === "") return "absent"
  const record = st.approvedPlans.get(`${projectScope(projectDir)}:${n}`)
  if (record === undefined) return "absent"
  const whole = sanitizePlanKey(wholeKey)
  if (record.key !== k && !(whole !== "" && record.key === whole)) return "stale-key"
  rekeyApprovalRecord(st, record, k, sessionID)
  return "live"
}

/**
 * Records a durable, project-scoped plan approval in the sidecar store.
 * delete+set keeps a re-record most-recent (a plain set would age the
 * entry out on its first-insertion slot); an eviction triggers the
 * compacted rewrite. An unpersisted record must not exempt in-process
 * (fail toward the non-durable wall): the entry rolls back when the
 * write failed.
 * @param st The approval-store state.
 * @param name The plan file name.
 * @param key The plan's spec-region sha256 key.
 * @param projectDir The current project directory (the scope key).
 */
function recordPlanApprovalDurableIn(
  st: ApprovalStoreState,
  name: string,
  key: string,
  projectDir: string,
): void {
  const n = sanitizePlanName(name)
  const k = sanitizePlanKey(key)
  if (n === "" || k === "") return
  const record = { name: n, key: k, project: projectScope(projectDir), scheme: "spec" as const }
  const mapKey = `${record.project}:${record.name}`
  st.approvedPlans.delete(mapKey)
  st.approvedPlans.set(mapKey, record)
  const overCap = st.approvedPlans.size > MAX_APPROVAL_RECORDS
  if (overCap) evictTo(st.approvedPlans, MAX_APPROVAL_RECORDS)
  if (!persistApprovalStore(st, record, overCap)) st.approvedPlans.delete(mapKey)
}

/**
 * Creates the durable approved-plan store: the project-scoped, content-
 * verified probe (with transparent legacy re-keying) and the durable record.
 * The bodies live at module level; the factory only builds the state object.
 * @param deps The sidecar path, journal path, and loaded store.
 * @returns The `planApprovalState` and `recordPlanApprovalDurable` methods.
 */
function createApprovalStore(
  deps: ApprovalStoreState,
): Pick<GateLedger, "planApprovalState" | "recordPlanApprovalDurable"> {
  const st = deps
  return {
    planApprovalState: (name, key, wholeKey, projectDir, sessionID) =>
      planApprovalStateOf(st, name, key, wholeKey, projectDir, sessionID),
    recordPlanApprovalDurable: (name, key, projectDir) =>
      recordPlanApprovalDurableIn(st, name, key, projectDir),
  }
}

/**
 * Runs the boot replay over the ledger's maps and applies the post-replay
 * LRU caps. Replay runs before capping so the restored set honors the LRU
 * cap too; the credit trace is capped once after replay (restore marks take
 * a boot-time stamp, and the map is bounded like the other session maps).
 * The observe period folds in online during the replay (see
 * `replayGatePasses`), and the suspension map folds the same way (last-wins
 * `action:"off"|"on"`).
 * @param maps The ledger's maps and sidecar state.
 * @param creditedApprovals The credit trace's provenance map.
 * @param isParent The registry's live-parent predicate (eviction protection).
 * @param reseededEdges The registry's replay-restored edge map (fold target).
 * @param journalPath The journal path the replay tail reads.
 * @param maxSessions The LRU cap for the session-keyed maps.
 * @param replayTailLines How many tail lines of each generation the replay walks.
 * @param reviewerAgent The canonical reviewer agent name for replay folds.
 * @param sessionsDir The per-session journal sink directory.
 */
function replayLedgerMaps(
  maps: LedgerMaps,
  creditedApprovals: Map<string, number>,
  isParent: (sessionID: string) => boolean,
  reseededEdges: Map<string, { parent: string; agent: string }>,
  journalPath: string,
  maxSessions: number,
  replayTailLines: number,
  reviewerAgent: string,
  sessionsDir: string,
): void {
  replayGatePasses(
    maps.states,
    journalPath,
    sessionsDir,
    replayTailLines,
    creditedApprovals,
    reviewerAgent,
    maps.observePeriod,
    maps.suspended,
    reseededEdges,
  )
  cap(maps.states, maxSessions, isParent)
  cap(creditedApprovals, maxSessions)
  cap(maps.suspended, maxSessions)
}

/**
 * Builds the ledger's parent-edge registry with the documented bound: 4× the
 * states cap, floored at 256 so a small cap still tracks an active fleet of
 * registered parents.
 * @param maps The ledger's maps (the registry shares the bucket and verdict
 *     maps for the child-release sweep).
 * @param journalPath The journal path the `child-edge` rows append to.
 * @param maxSessions The LRU cap for the session-keyed maps.
 * @returns The registry capability (see {@link LedgerRegistry}).
 */
function bootLedgerRegistry(
  maps: LedgerMaps,
  journalPath: string,
  maxSessions: number,
): LedgerRegistry {
  return createLedgerRegistry({
    maxSessions,
    maxTrackedParents: Math.max(256, maxSessions * 4),
    journalPath,
    states: maps.states,
    childVerdicts: maps.childVerdicts,
  })
}

/**
 * Composes the live ledger object from the concern stores: the registry's
 * edge surface, the bucket store, the verdict store, the durable approval
 * store, the credit trace, and the observe/suspension concerns. Pure
 * assembly — every method's behavior lives in its concern creator.
 * @param maps The ledger's maps and sidecar state.
 * @param registry The parent-edge registry capability.
 * @param credit The credit-trace capability.
 * @param maxSessions The LRU cap for the session-keyed maps.
 * @param observeSessions The observe-mode admission period (0 disables).
 * @returns The live gate ledger (see {@link GateLedger}).
 */
function composeLedger(
  maps: LedgerMaps,
  registry: LedgerRegistry,
  credit: CreditTrace,
  maxSessions: number,
  observeSessions: number,
): GateLedger {
  const { childToParent, markParent, isParent, lastParent, parentOf, setParent, reseedEdges } =
    registry
  return {
    childToParent,
    ...createBucketStore({
      states: maps.states,
      maxSessions,
      isParent,
      releaseChildren: registry.releaseChildren,
    }),
    parentOf,
    setParent,
    reseedEdges,
    markParent,
    isParent,
    lastParent,
    ...createVerdictStore(maxSessions, maps.childVerdicts),
    ...createApprovalStore({
      sidecarPath: maps.sidecarPath,
      journalPath: maps.journalPath,
      approvedPlans: maps.approvedPlans,
    }),
    ...credit,
    ...createObserveCap(observeSessions, maps.observePeriod),
    ...createSuspension(maxSessions, maps.suspended),
  }
}

/**
 * Creates the live gate ledger: the session buckets, the parent-edge
 * registry, the credit trace, and the observe/suspension/verdict/approval
 * concern stores, restored from the journal replay before the LRU caps are
 * applied.
 * @param journalPath The journal path the replay tail and the edge rows read
 *     and append.
 * @param maxSessions The LRU cap for the session-keyed maps.
 * @param replayTailLines How many tail lines of each journal generation the
 *     boot replay walks.
 * @param approvalLedgerPath Optional explicit sidecar path override.
 * @param observeSessions The observe-mode admission period (0 disables).
 * @param reviewerAgent The canonical reviewer agent name for replay folds.
 * @param sessionsDir The per-session journal sink directory.
 * @returns The live gate ledger (see {@link GateLedger}).
 */
export function createLedger(
  journalPath: string,
  maxSessions: number,
  replayTailLines: number,
  approvalLedgerPath?: string,
  observeSessions = 0,
  reviewerAgent: string = CANONICAL_REVIEWER_AGENT,
  sessionsDir: string = path.join(path.dirname(journalPath), "sessions"),
): GateLedger {
  const maps = createLedgerMaps(journalPath, approvalLedgerPath)
  const registry = bootLedgerRegistry(maps, journalPath, maxSessions)
  const credit = createCreditTrace({ maxSessions })
  replayLedgerMaps(
    maps,
    credit.creditedApprovals,
    registry.isParent,
    registry.reseededEdges,
    journalPath,
    maxSessions,
    replayTailLines,
    reviewerAgent,
    sessionsDir,
  )
  return composeLedger(maps, registry, credit, maxSessions, observeSessions)
}
