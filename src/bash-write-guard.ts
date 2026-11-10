/**
 * @fileoverview Bash/write-guard concern: the `bash`/`shell` and
 * `write`/`edit` execute.before paths — the denylist guards, the
 * conventional-commit lint, the landing and bash-write telemetry, the
 * scratch-target and pipeline-child exemptions, the plan-impact advisory,
 * the hands-on ladder with its once-grant, and the reviewer-gated landing
 * gate with its landing once-grant — plus the `session_move` telemetry.
 * Extracted from `src/hooks-core.ts`; the shared per-setup state is threaded
 * as one typed state object and the cross-concern helpers stay behind
 * function-typed fields. A guard block throws `BlockError` for the caller's
 * fail-open catch.
 */

import type { Journaler } from "./journal.ts"
import type { GateLedger } from "./ledger.ts"
import type {
  BashWriteGateCapability,
  HandsOnGateCapability,
  LandingGateCapability,
  ToolPolicy,
} from "./tool-policy.ts"
import type { Gates } from "./gates.ts"
import type { GateState, ToolHookEvent, TurnstileConfig } from "./types.ts"
import type { PlanImpact } from "./plan-scope.ts"
import { classifyBashWrite } from "./bash-write.ts"
import { isScratchTarget } from "./scratch.ts"
import { isEmptyDiffPush } from "./empty-diff.ts"
import { waiverCovers } from "./gates-common.ts"
import { isPushLanding } from "./tool-policy.ts"
import { planImpactAdvisory } from "./policy.ts"
import { asSessionID } from "./delivery.ts"
import type { OverrideAdjacency } from "./override-adjacency.ts"

/**
 * The state the bash/write-guard concern reads and mutates: the shared deps
 * and the cross-concern helpers it delegates to.
 */
export interface BashWriteGuardState {
  /** The resolved plugin configuration. */
  config: TurnstileConfig
  /** The telemetry journal writer. */
  journaler: Journaler
  /** The gate-state ledger (edge map, buckets, credited approvals). */
  ledger: GateLedger
  /** Tool policy (denylist, commit lint, landing/hands-on/bash-write gates). */
  toolPolicy: ToolPolicy
  /** Gate decision service (the plan-impact classifier). */
  gates: Gates
  /** Last-known project directory per session (plan-impact + empty-diff). */
  sessionDirs: Map<string, string>
  /** Resolves a session's registration status (pipeline-child exemption). */
  childStatus(sid: string, agent: string): "child" | "parent" | "unknown"
  /** Returns the last-known project directory for a session. */
  currentProjectDir(sessionID: string): string
  /** Whether reactive enforcement is armed for the session's parent. */
  enforcementArmed(sessionID: string): boolean
  /** Arms the pending-landing-ask latch; true when the ask row must journal. */
  armLandingAsk(parent: string): boolean
  /** Arms the pending-hands-on-ask latch; true when the ask row must journal. */
  armHandsOnAsk(parent: string): boolean
  /** Evicts the oldest intent-nudge/advisory state past the caps. */
  boundIntentNudges(): void
  /** Parent → pending plan-impact advisory text awaiting the next delivery. */
  planImpactAdvisories: Map<string, string>
  /** In-memory child-write adjacency for prov:override capture; shared with the tool after-surface. */
  overrideAdjacency: OverrideAdjacency
}

/**
 * The telemetry half of a bash/shell dispatch: the denylist guard, the
 * conventional-commit lint (armed only), the landing telemetry, and the
 * hands-on bash telemetry. The write-shape verdict is classified ONCE here
 * and threaded into both the telemetry and the gate sequence.
 * @param st The bash-write-guard state.
 * @param event The execute.before tool event (bash/shell shape).
 * @param tool The narrowed tool name (`"bash"` or `"shell"`).
 * @param sid The event's session ID.
 * @returns The armed flag, the command text, and the write-shape verdict.
 */
function observeBashTelemetry(
  st: BashWriteGuardState,
  event: ToolHookEvent,
  tool: "bash" | "shell",
  sid: string,
): { armed: boolean; text: string; gw: ReturnType<typeof classifyBashWrite> } {
  const command = event.input?.command ?? event.input?.cmd
  // Denylist first: a configured `gh pr` deny wins over the landing
  // telemetry/gate below, and the two journal reasons stay disjoint (under
  // the empty default there is no such deny, so `gh pr` flows to the
  // landing telemetry below).
  st.toolPolicy.guardBash(tool, command, sid)
  // Dormant-until-engaged: the denylist above and all telemetry below run
  // unconditionally; the pipeline gates (commit lint, bash-write hands-on
  // ladder, landing gate) sleep until the parent engages.
  const armed = st.enforcementArmed(sid)
  // Conventional-commit lint (fail-closed for uninspectable forms).
  if (armed) st.toolPolicy.guardCommitMessage(tool, command, sid)
  // Landing telemetry (always) then the reviewer-gated landing gate.
  const text = String(command ?? "")
  st.toolPolicy.observeLanding(sid, text)
  // Hands-on bash telemetry (all sessions, never blocks), then the
  // write-shaped bash gate for parents and non-pipeline subagents — a
  // registered pipeline child's own file-writing bash is its work.
  const gw = classifyBashWrite(text)
  st.toolPolicy.observeBashWrite(sid, text, gw)
  return { armed, text, gw }
}

/**
 * The gate half of a bash/shell dispatch: the pipeline-child exemption, the
 * write-shaped bash gate behind the plan-impact advisory, the landing
 * once-grant short-circuit, and the reviewer-gated landing gate. Invariant:
 * this arm runs BEFORE `consumeLandingGrant` and the hands-on once-grant is
 * consumed inside `guardBashWrite` itself — so a landing grant can never
 * release a bash write, and a hands-on block throws before the landing
 * grant is burned.
 * @param st The bash-write-guard state.
 * @param event The execute.before tool event (bash/shell shape).
 * @param tool The narrowed tool name (`"bash"` or `"shell"`).
 * @param sid The event's session ID.
 * @param armed Whether enforcement is armed for the session's parent.
 * @param text The command text.
 * @param gw The write-shape verdict from the telemetry half.
 */
function guardBashGates(
  st: BashWriteGuardState,
  event: ToolHookEvent,
  tool: "bash" | "shell",
  sid: string,
  armed: boolean,
  text: string,
  gw: ReturnType<typeof classifyBashWrite>,
): void {
  // Fail-closed exemption, mirroring the write/edit arm: only a pipeline
  // child's own bash is exempt (agent-name precedence first, then the edge
  // + emitter fallback), and an unresolved status gates like a parent. The
  // exemption sits AFTER the telemetry (so a child still journals its
  // `handsOn` row) and BEFORE the guards (so the bash-write guard — and with
  // it the parent bucket's pending hands-on once-grant — and the landing
  // gate are never reached by a child dispatch).
  if (st.childStatus(sid, typeof event?.agent === "string" ? event.agent : "") === "child") return
  const parent = st.ledger.parentOf(sid)
  const s = st.ledger.state(parent)
  if (!armed) return
  // Plan-impact advisory for gate-tier write shapes: with a plan bound, a
  // write-shaped bash command naming a scope path skips ONLY the bash-write
  // block (strict mode falls through to it for structural overlap) — the
  // landing gate below still runs, so a compound write+push command cannot
  // ride the advisory past it. Non-gate verdicts (`telemetry`/`none`) never
  // classify — the ladder below is a no-op for them.
  if (gw !== "gate" || classifyParentPlanImpact(st, tool, text, true, parent, s) !== "allow") {
    st.toolPolicy.guardBashWrite(tool, text, gw, sid, bashWriteGateHandles(st, s, parent))
  }
  if (consumeLandingGrant(s, text)) return
  st.toolPolicy.guardLanding(tool, text, sid, landingGateHandles(st, s, parent, sid))
}

/**
 * Handles a `bash`/`shell` tool call: the denylist guard, the
 * conventional-commit lint, the landing telemetry, and the hands-on bash
 * telemetry + write-shaped bash gate, then the reviewer-gated landing gate
 * with a landing once-grant short-circuit for push candidates. A denylist,
 * hands-on, or landing block throws BlockError (re-thrown by the outer
 * catch).
 * @param st The bash-write-guard state.
 * @param event The execute.before tool event (bash/shell shape).
 * @param tool The narrowed tool name (`"bash"` or `"shell"`).
 */
function handleBashDispatchBody(
  st: BashWriteGuardState,
  event: ToolHookEvent,
  tool: "bash" | "shell",
): void {
  const sid = asSessionID(event?.sessionID)
  const { armed, text, gw } = observeBashTelemetry(st, event, tool, sid)
  guardBashGates(st, event, tool, sid, armed, text, gw)
}

/**
 * The child-write telemetry for `prov:override` capture: when the decision
 * ledger is enabled and the target path is a non-empty string, records the
 * write into the in-memory adjacency tracker (shared with the tool
 * after-surface) and journals one bounded `{type:"tool", childWrite:true}`
 * telemetry row — the audit trail is the point, so recording is
 * unconditional once the ledger gate passes. Fail-open: an internal error
 * journals `type:"error"` and never blocks the exempt dispatch.
 * @param st The bash-write-guard state.
 * @param sid The child session ID.
 * @param tool The narrowed tool name (`"write"` or `"edit"`).
 * @param filePath The raw target-path value.
 */
function observeChildWrite(
  st: BashWriteGuardState,
  sid: string,
  tool: "write" | "edit",
  filePath: unknown,
): void {
  if (!st.config.decisionLedger.enabled) return
  const path = typeof filePath === "string" ? filePath : ""
  if (path === "") return
  try {
    st.overrideAdjacency.recordChildWrite(st.ledger.parentOf(sid), sid, path, Date.now())
    st.journaler.journal({
      type: "tool",
      sessionID: sid,
      tool,
      childWrite: true,
      path: path.slice(0, 200),
    })
  } catch (e) {
    st.journaler.journal({ type: "error", sessionID: sid, error: `child-write telemetry: ${e}` })
  }
}

/**
 * The exemption half of a write/edit dispatch: a registered pipeline child's
 * own write/edit is the executor's work and never gates (a non-empty event
 * agent name in the configured pipeline set is authoritative evidence — edge
 * or not; parents never carry a subagent agent name — and an unresolved
 * status gates like a parent, fail-closed), and a scratch-target write is
 * zero-governance work: journal the audit row and allow, before any grant
 * economy runs (a scratch write never consumes a pending once-grant and
 * never reaches the hands-on ladder).
 * @param st The bash-write-guard state.
 * @param event The execute.before tool event (write/edit shape).
 * @param tool The narrowed tool name (`"write"` or `"edit"`).
 * @param sid The event's session ID.
 * @param filePath The raw target-path value.
 * @returns True when the dispatch is exempt (allowed without the ladder).
 */
function writeEditExempt(
  st: BashWriteGuardState,
  event: ToolHookEvent,
  tool: "write" | "edit",
  sid: string,
  filePath: unknown,
): boolean {
  // Hands-on gate: parent sessions and non-pipeline subagents; only a
  // pipeline child's own write/edit (the executor's work) is exempt
  // (agent-name precedence first, then the edge + emitter fallback).
  if (st.childStatus(sid, typeof event?.agent === "string" ? event.agent : "") === "child") {
    observeChildWrite(st, sid, tool, filePath)
    return true
  }
  if (isScratchTarget(filePath)) {
    st.toolPolicy.observeScratchWrite(tool, filePath, sid)
    return true
  }
  return false
}

/**
 * Handles a `write`/`edit` tool call: the path denylist, the pipeline-child
 * and scratch-target exemptions, then the hands-on gate behind the
 * plan-impact advisory and the hands-on once-grant. A denylist or hands-on
 * block throws BlockError (re-thrown by the outer catch).
 * @param st The bash-write-guard state.
 * @param event The execute.before tool event (write/edit shape).
 * @param tool The narrowed tool name (`"write"` or `"edit"`).
 */
function handleWriteEditDispatchBody(
  st: BashWriteGuardState,
  event: ToolHookEvent,
  tool: "write" | "edit",
): void {
  const sid = asSessionID(event?.sessionID)
  const filePath = event.input?.filePath ?? event.input?.path
  // Denylist first: a configured pathDeny wins and the journal reasons stay
  // disjoint (mirrors the bash denylist-before-landing-gate ordering).
  st.toolPolicy.guardPath(tool, filePath, sid)
  if (writeEditExempt(st, event, tool, sid, filePath)) return
  const parent = st.ledger.parentOf(sid) // == sid for a parent; self-keys if unregistered
  const s = st.ledger.state(parent)
  // Dormant-until-engaged: the denylist above and the scratch exemption ran
  // unconditionally; the hands-on ladder sleeps until the parent engages (a
  // dormant session cannot hold a pending once-grant — grants are earned
  // inside engaged scopes — so skipping the consume is safe).
  if (!st.enforcementArmed(parent)) return
  if (consumeHandsOnGrant(s)) return // once-grant: released for this one edit
  // Plan-impact advisory: with a plan bound, an overlapping write/edit is
  // allowed with a journaled classification instead of the hands-on block
  // (strict mode falls through to the ladder for structural overlap). A
  // released edit above never burns the advisory's one-shot stash. An empty
  // raw target or an `uninspectable` classification falls through to the
  // ladder.
  const target = typeof filePath === "string" ? filePath : ""
  if (target !== "" && classifyParentPlanImpact(st, tool, target, false, parent, s) === "allow") {
    return
  }
  st.toolPolicy.guardHandsOn(tool, filePath, sid, handsOnGateHandles(st, s, parent))
}

/**
 * Consumes the landing once-grant for a push candidate when one is pending,
 * and reports whether the push is thereby released. A landing once-grant
 * (from a `permission.replied` `once` for a landing ask) releases exactly
 * ONE push, consumed here, before the gate decides, so a stale grant cannot
 * outlive that single dispatch. Scoped to landing candidates: a non-push
 * bash command leaves the grant pending (burning it on `git status` would
 * defeat the "single push" contract). Keyed per-reason (`.landing`), so it
 * can never be consumed by a plan-gate (task) dispatch or vice versa.
 * @param s The parent's gate-state bucket.
 * @param text The bash command text.
 * @returns True when the landing once-grant was consumed (the push is
 *     released by it).
 */
function consumeLandingGrant(s: GateState, text: string): boolean {
  if (s.pendingOnceGrant.landing !== "" && isPushLanding(text)) {
    s.pendingOnceGrant.landing = ""
    return true
  }
  return false
}

/**
 * Consumes the hands-on once-grant when one is pending and reports whether
 * the parent write/edit is thereby released. A hands-on once-grant (from a
 * `permission.replied` `once` for a hands-on ask) releases exactly ONE
 * parent edit, consumed before the gate decides, so a stale grant cannot
 * outlive the single edit it was given for. Every write/edit is a hands-on
 * candidate, so no command-shape predicate is needed (unlike the landing
 * grant). Keyed per-reason (`.handsOn`), so it can never be consumed by a
 * plan-gate (task) dispatch or a landing push and vice versa.
 * @param s The parent's gate-state bucket (mutated on consume).
 * @returns True when the hands-on once-grant was consumed (the edit is
 *     released by it).
 */
function consumeHandsOnGrant(s: GateState): boolean {
  if (s.pendingOnceGrant.handsOn === "") return false
  s.pendingOnceGrant.handsOn = ""
  return true
}

/**
 * Classifies a parent tool call's target against the bound active plan's
 * scope (the plan-impact advisory, the replacement for the parent-hands-on
 * block while a plan is active). Runs only while the pipeline is engaged and
 * a plan is bound; with no plan the hands-on ladder runs unchanged. `"none"`
 * allows silently (no journal row, no advisory); `"uninspectable"` — a
 * target the classifier cannot place inside the project dir — falls through
 * to the hands-on ladder without a journal row; `"advisory"`/`"structural"`
 * journal one `{type:"plan-impact"}` row and stash the advisory text for the
 * next parent-facing delivery — except structural overlap under
 * `planImpactStrict`, which returns `"proceed-hands-on"` so the existing
 * hands-on ladder restores the block (the row is already journaled, so the
 * strict block stays auditable). Fail-open: a classification error journals
 * and proceeds to the hands-on ladder.
 * @param st The bash-write-guard state.
 * @param tool The narrowed tool name (for the journal row).
 * @param target The write/edit file path, or the bash command text.
 * @param matchInText True for containment matching (bash command text).
 * @param parent The parent session (the advisory stash's key).
 * @param s The parent's gate-state bucket (carries `activePlan`).
 * @returns `"allow"` to skip the hands-on ladder, or `"proceed-hands-on"`
 *     to fall through to it.
 */
function classifyParentPlanImpact(
  st: BashWriteGuardState,
  tool: string,
  target: string,
  matchInText: boolean,
  parent: string,
  s: GateState,
): "proceed-hands-on" | "allow" {
  if (s.activePlan === "") return "proceed-hands-on"
  let impact: PlanImpact
  try {
    impact = st.gates.planImpact(st.currentProjectDir(parent), s.activePlan, target, matchInText)
  } catch (e) {
    st.journaler.journal({ type: "error", sessionID: parent, error: `plan-impact: ${e}` })
    return "proceed-hands-on"
  }
  if (impact === "none") return "allow"
  if (impact === "uninspectable") return "proceed-hands-on"
  return journalPlanImpactAdvisory(st, parent, tool, target, s, impact)
}

/**
 * Journals the plan-impact classification for a real overlap, applies the
 * strict-mode block for structural impact, and stashes the hands-on
 * advisory (refreshing the bound-intent nudges).
 * @param st The bash-write-guard state.
 * @param parent The parent session (the advisory stash's key).
 * @param tool The narrowed tool name (for the journal row).
 * @param target The write/edit file path, or the bash command text.
 * @param s The parent's gate-state bucket (carries `activePlan`).
 * @param impact The classified plan impact (never `none`/`uninspectable`).
 * @returns `"proceed-hands-on"` after a strict structural block, else
 *     `"allow"` to skip the hands-on ladder.
 */
function journalPlanImpactAdvisory(
  st: BashWriteGuardState,
  parent: string,
  tool: string,
  target: string,
  s: GateState,
  impact: PlanImpact,
): "proceed-hands-on" | "allow" {
  st.journaler.journal({
    type: "plan-impact",
    sessionID: parent,
    tool,
    plan: s.activePlan,
    impact,
    path: target.slice(0, 200),
  })
  if (impact === "structural" && st.config.planImpactStrict) return "proceed-hands-on"
  st.planImpactAdvisories.set(
    parent,
    planImpactAdvisory(s.activePlan, impact === "structural" ? "structural" : "advisory"),
  )
  st.boundIntentNudges()
  return "allow"
}

/**
 * The stateful hands-on-gate capability handed to `toolPolicy.guardHandsOn`
 * (mirrors landingGateHandles): only a shaped capability crosses the
 * boundary. `escalate` arms the pending-hands-on-ask latch (the evaluate
 * handler forces the human ask off it) and is called by guardHandsOn on a
 * repeat attempt (no release, >= 1 prior block) in both escalation modes —
 * the ask-first ladder arms the one-shot ask latch; the mode only governs
 * non-latch side effects (under `"ask"` a red plan gate forces the dispatch
 * permission ask); it returns whether the ask row must be journaled (within-TTL
 * duplicate arms return false); fail-toward-strict — a host reject leaves
 * the gate red, so the next attempt re-blocks.
 * @param st The bash-write-guard state.
 * @param s The parent's gate-state bucket.
 * @param parent The parent session (the latch's key).
 * @returns The hands-on-gate capability record.
 */
function handsOnGateHandles(
  st: BashWriteGuardState,
  s: GateState,
  parent: string,
): HandsOnGateCapability {
  return {
    hasRelease: () => s.handsOnRelease,
    hasWaiver: () => waiverCovers(s, ["executor"]),
    priorBlocks: () => s.handsOnBlocks,
    recordBlock: () => {
      s.handsOnBlocks += 1
    },
    escalate: (): boolean => st.armHandsOnAsk(parent),
  }
}

/**
 * The stateful bash-write-gate capability handed to
 * `toolPolicy.guardBashWrite`: the hands-on capability plus the once-grant
 * consume. The consume is NOT called at the arm site — `guardBashWrite`
 * runs it itself, after its flag and verdict checks, so a disabled gate or a
 * non-gate shape never burns a pending grant.
 * @param st The bash-write-guard state.
 * @param s The parent's gate-state bucket.
 * @param parent The parent session (the latch's key).
 * @returns The bash-write-gate capability record.
 */
function bashWriteGateHandles(
  st: BashWriteGuardState,
  s: GateState,
  parent: string,
): BashWriteGateCapability {
  return {
    ...handsOnGateHandles(st, s, parent),
    consumeGrant: () => consumeHandsOnGrant(s),
  }
}

/**
 * The stateful landing-gate capability handed to `toolPolicy.guardLanding`:
 * only a shaped capability crosses the boundary, so the stateful ledger
 * never enters the pure tool-policy module. `recordBlock`/`escalate` are its
 * only mutators; `escalate` arms the pending-landing-ask latch (the evaluate
 * handler forces the human ask off it) and is called by guardLanding on an
 * armed attempt (a repeat attempt, or a credited first attempt) in both
 * escalation modes — the ask-first ladder arms the one-shot ask latch; the
 * mode only governs non-latch side effects (under `"ask"` a red plan gate
 * forces the dispatch permission ask); it returns whether the ask row must
 * be journaled (within-TTL duplicate arms return false); fail-toward-strict — a host
 * reject leaves approval absent, so the next attempt re-blocks.
 * `hasCreditedApproval` is a read of the ledger's bucket-free credit trace
 * (a journaled, non-refused reviewer APPROVE that a prompt reset dropped the
 * `hasReviewApprove` flag for) that guardLanding consults to escalate a
 * credited session's first push instead of throwing the first block.
 * `isEmptyDiff` runs the static empty-diff probe against the session's
 * project directory (lazily resolved at probe time) and is consulted by
 * guardLanding only under `gitGates.emptyDiffExempt`; a false result or a
 * probe failure falls through to the gate — fail-toward-strict.
 * @param st The bash-write-guard state.
 * @param s The parent's gate-state bucket.
 * @param parent The parent session (the latch's key).
 * @param sid The session whose project directory the probe resolves.
 * @returns The landing-gate capability record.
 */
function landingGateHandles(
  st: BashWriteGuardState,
  s: GateState,
  parent: string,
  sid: string,
): LandingGateCapability {
  return {
    hasApproval: () => s.hasReviewApprove,
    hasCreditedApproval: () => st.ledger.hasCreditedApproval(parent),
    priorBlocks: () => s.landingBlocks,
    recordBlock: () => {
      s.landingBlocks += 1
    },
    escalate: (): boolean => st.armLandingAsk(parent),
    isEmptyDiff: (command: string): boolean => isEmptyDiffPush(command, st.currentProjectDir(sid)),
  }
}

/**
 * Handles a `session_move` tool call: journals the dispatched move
 * (telemetry only, never blocks) and invalidates the per-session directory
 * cache for the session and its parent so the next enforcement re-resolves
 * the moved location.
 * @param st The bash-write-guard state.
 * @param event The execute.before tool event (session_move shape).
 */
function handleSessionMoveBody(st: BashWriteGuardState, event: ToolHookEvent): void {
  // Telemetry only (never blocks): journal the dispatched move. The target
  // directory comes from the (unconfirmed) tool payload.
  const moveDir = (event.input as { directory?: unknown } | undefined)?.directory
  const sid = asSessionID(event?.sessionID)
  st.toolPolicy.observeSessionMove(sid, moveDir)
  // Invalidate the per-session directory cache unconditionally, regardless
  // of telemetry config: mechanics must not hide behind it. The next
  // enforcement re-resolves via session.get, which reflects the completed
  // move. A self-keyed dispatch has parentOf(sid) === sid, so the second
  // delete is a no-op there.
  st.sessionDirs.delete(sid)
  st.sessionDirs.delete(st.ledger.parentOf(sid))
}

/**
 * Creates the bash-write-guard concern bound to the factory's shared state.
 * The bodies live at module level; the factory only builds the state object.
 * @param st The bash-write-guard state (see {@link BashWriteGuardState}).
 * @returns The bash-write-guard methods the shared context exposes.
 */
export function createBashWriteGuard(st: BashWriteGuardState): {
  handleBashDispatch(event: ToolHookEvent, tool: "bash" | "shell"): void
  handleWriteEditDispatch(event: ToolHookEvent, tool: "write" | "edit"): void
  handleSessionMove(event: ToolHookEvent): void
} {
  return {
    handleBashDispatch: (event, tool) => handleBashDispatchBody(st, event, tool),
    handleWriteEditDispatch: (event, tool) => handleWriteEditDispatchBody(st, event, tool),
    handleSessionMove: (event) => handleSessionMoveBody(st, event),
  }
}
