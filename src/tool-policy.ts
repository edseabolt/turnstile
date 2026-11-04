/**
 * @fileoverview Tool-call policy boundary: stateless matching for the tools
 * that flow through `execute.before` — bash/shell commands (`guardBash`,
 * `guardCommitMessage`, `observeLanding`, `guardLanding` — whose opt-in
 * empty-diff exemption rides the capability's total probe) and write/edit
 * target paths (`guardPath`) — plus non-blocking `session_move` telemetry
 * (`observeSessionMove`). The guards, telemetry observers, and the pure text
 * helpers live in `src/tool-policy-guards.ts`; this module compiles the
 * shared state once at creation and composes the guard creators, so every
 * later guard is a cached `RegExp.test` on the hot path. A match throws the
 * same `BlockError` the gate layer throws (the hook rethrows it), and every
 * internal failure fails open (journaled, never thrown).
 *
 * The pure helpers and gate texts are re-exported here so `empty-diff.ts`,
 * `setup.ts`, and the tests keep importing from this boundary.
 */

import type { Journaler } from "./journal.ts"
import type { TurnstileConfig } from "./types.ts"
import type { BashWriteVerdict } from "./bash-write.ts"
import type {
  BashWriteGateCapability,
  HandsOnGateCapability,
  LandingGateCapability,
} from "./tool-policy-guards.ts"
import {
  compileCommitFormat,
  compileDenylist,
  createBashWriteGuards,
  createCommitGuard,
  createDenylistGuards,
  createHandsOnGuard,
  createLandingGuard,
  createTelemetry,
  type ToolPolicyState,
} from "./tool-policy-guards.ts"

export {
  HANDSON_REQUIREMENT,
  LANDING_REQUIREMENT,
  describeCommitMismatch,
  gitInvocation,
  isPushLanding,
} from "./tool-policy-guards.ts"
export type {
  BashWriteGateCapability,
  HandsOnGateCapability,
  LandingGateCapability,
} from "./tool-policy-guards.ts"

// The shell-aware tokenizer lives in `src/bash-write.ts` (the write-shape
// classifier owns it so the dependency stays acyclic); it is re-exported here
// so `empty-diff.ts` and the tests keep importing from this boundary.
export { splitCommands, tokenizeWords } from "./bash-write.ts"

/**
 * The stateless tool-call policy bound to one resolved config + journaler.
 * Every guard fails open on an internal error; only a deliberate block throws.
 */
export interface ToolPolicy {
  /**
   * Yields on allow; journals and throws (`BlockError`) when `command` matches
   * a `bashDeny` rule; journals `{type:"error"}` and allows on an empty/absent
   * command.
   *
   * The `command` argument is the host payload value coerced by `setup.ts` via
   * `event.input?.command ?? event.input?.cmd` — those two keys are the
   * documented candidates; if the host reshapes the payload the empty-command
   * path journals the misconfiguration so the change is observable rather than
   * silently allowed.
   * @param tool The tool name, recorded in the journal (`"bash"` or `"shell"`).
   * @param command The raw command value from the host payload (typed `unknown`).
   * @param sessionID The session ID, recorded in journal entries.
   * @throws Error with a `BLOCKED by turnstile:` prefix when a rule matches.
   */
  guardBash(tool: "bash" | "shell", command: unknown, sessionID: string): void
  /**
   * Yields on allow; journals and throws (`BlockError`) when `filePath`
   * matches a `pathDeny` rule; journals `{type:"error"}` and allows on an
   * empty/absent path.
   *
   * The `filePath` argument is the host payload value coerced by `setup.ts` via
   * `event.input?.filePath ?? event.input?.path` — those two keys are the
   * documented candidates; if the host reshapes the payload the empty-path path
   * journals the misconfiguration so the change is observable.
   * @param tool The tool name, recorded in the journal (`"write"` or `"edit"`).
   * @param filePath The raw target-path value from the host payload (`unknown`).
   * @param sessionID The session ID, recorded in journal entries.
   * @throws Error with a `BLOCKED by turnstile:` prefix when a rule matches.
   */
  guardPath(tool: "write" | "edit", filePath: unknown, sessionID: string): void
  /**
   * Journals a `session_move` dispatch as telemetry; never blocks. Only writes
   * when `toolPolicy.observeSessionMove` is true. The directory is recorded only
   * when the trace is enabled (the same redaction gating `bash` commands).
   * Serves two channels: the `session_move` tool hook, and the project-directory
   * resolver when it replaces a session's cached directory with a different one
   * — a move the tool hook did not witness. The resolver passes `origin` so the
   * journal entry carries `reason` and an enforced project switch is never
   * silent.
   * @param sessionID The session ID, recorded in the journal entry.
   * @param directory The move target directory from the host payload or the
   *     resolver (`unknown`).
   * @param origin The telemetry channel label, recorded as `reason` on the
   *     journal entry (`"re-resolved"` when the resolver, not the tool hook,
   *     witnessed the change).
   */
  observeSessionMove(sessionID: string, directory: unknown, origin?: "re-resolved"): void
  /**
   * Lints `git commit` messages as conventional commits under `gitGates.commitMessages`.
   * Extracts `git commit` invocations (not substrings such as `git commit-graph`
   * or `echo git commit`), validates each `-m` argument against the compiled
   * `commitFormat`, and for uninspectable forms (`-F`/`-t`/`--edit`/`-e` or a
   * bare interactive commit) fail-closes: journals `{type:"blocked",
   * reason:"commit-message-uninspectable"}` and throws (`BlockError`). A `-m`
   * message that fails to match journals
   * `{type:"blocked", reason:"invalid-commit-message"}` the same way. Every
   * internal failure fails open.
   * @param tool The tool name, recorded in the journal (`"bash"` or `"shell"`).
   * @param command The raw command value from the host payload (`unknown`).
   * @param sessionID The session ID, recorded in journal entries.
   * @throws Error with a `BLOCKED by turnstile:` prefix when the lint rejects.
   */
  guardCommitMessage(tool: "bash" | "shell", command: unknown, sessionID: string): void
  /**
   * Journals `{type:"tool", tool:"bash", landing:true}` telemetry for
   * `git push` / `gh pr create|ready|merge` candidates — always, and
   * non-blocking. Never touches the landing gate itself: a landing deny comes
   * from `guardLanding`, and a `gh pr` deny from a configured `bashDeny` rule
   * fires in `guardBash` before this runs (with the empty default that deny is
   * configured-only, so `gh pr` normally reaches this telemetry; when the deny
   * is configured, the two journal reasons stay disjoint). Fail-open on an
   * internal error.
   * @param sessionID The session ID, recorded in the journal entry.
   * @param command The raw command value from the host payload (`unknown`).
   */
  observeLanding(sessionID: string, command: unknown): void
  /**
   * Gates a `git push` on a reviewer `VERDICT: APPROVE` under `gitGates.landingGate`.
   * Candidate detection is {@link isPushLanding} (the single source of truth
   * also used by `setup.ts` to arm the evaluate-handler ask). `gate` is the
   * stateful capability from `setup.ts`. With approval: allow, no journal noise.
   * Without approval, first block this task: journal
   * `{type:"blocked", reason:"no-landing-approval"}`, call `gate.recordBlock()`,
   * and throw (`BlockError`). A repeat attempt (`priorBlocks() >= 1`) without
   * approval is ask-first: it journals
   * `{type:"permission", action:"ask", reason:"landing"}` and calls
   * `gate.escalate()` (arming the pending-landing-ask latch; a within-window
   * duplicate arm journals no second ask row), and `execute.before` then
   * passes so the setup-side evaluate handler forces the human ask naming the
   * missing reviewer verdict — in BOTH `escalation` modes. The deliberate
   * block-throw is the fallback for a first attempt or a latch that cannot
   * arm (within-TTL duplicate). Fail-toward-strict:
   * a host `reject` leaves approval absent, so the next attempt re-blocks.
   * Fail-open on an internal error. With `gitGates.emptyDiffExempt`
   * (default true; `false` is the strict opt-out), a push the capability proves
   * statically empty against upstream is journaled `exempt:"empty-diff"` and
   * allowed; every ambiguous shape (detached HEAD, unresolvable remote/upstream,
   * explicit shas/ranges, `--mirror`/`--tags`, any non-empty refspec) falls
   * through to the ladder — fail-toward-strict.
   * @param tool The tool name, recorded in the journal.
   * @param command The raw command value from the host payload (`unknown`).
   * @param sessionID The session ID, recorded in journal entries.
   * @param gate The landing-gate capability supplied by `setup.ts`.
   * @throws Error with a `BLOCKED by turnstile:` prefix when the gate blocks.
   */
  guardLanding(
    tool: "bash" | "shell",
    command: unknown,
    sessionID: string,
    gate: LandingGateCapability,
  ): void
  /**
   * Gates a parent-session `write`/`edit` (always on). `gate` is the
   * stateful capability from the hook layer (parent sessions only — the
   * caller skips registered pipeline children, whose edits are the executor's
   * own work). A live release (human `always`) or an executor-scoped
   * `USER WAIVER:` allows silently. Otherwise the first attempt this task
   * journals `{type:"blocked", reason:"parent-hands-on"}`, calls
   * `gate.recordBlock()`, and throws (`BlockError` stamped `cause:"hands-on"`).
   * A repeat attempt (`priorBlocks() >= 1`) is ask-first: it journals
   * `{type:"permission", action:"ask", reason:"hands-on"}` and calls
   * `gate.escalate()` (arming the pending-hands-on-ask latch; a within-window
   * duplicate arm journals no second ask row); `execute.before` then passes
   * so the evaluate handler forces the human ask naming the hands-on
   * requirement — in BOTH `escalation` modes, the deliberate block-throw
   * being the fallback for a first attempt or a latch that cannot arm
   * (within-TTL duplicate). Reply-granted release paths (`handsOnRelease`,
   * the hands-on once-grant) release replies to asks the plugin raised, in
   * either mode. Plan approval never releases this gate.
   * Fail-toward-strict: a host `reject` leaves the gate red, so the next
   * attempt re-blocks. An empty/absent path journals
   * `{type:"error"}` and allows (fail-open misconfiguration telemetry).
   * Fail-open on an internal error.
   * @param tool The tool name, recorded in the journal (`"write"` or `"edit"`).
   * @param filePath The raw target-path value from the host payload (`unknown`).
   * @param sessionID The session ID, recorded in journal entries.
   * @param gate The hands-on-gate capability supplied by the hook layer.
   * @throws Error with a `BLOCKED by turnstile:` prefix when the gate blocks.
   */
  guardHandsOn(
    tool: "write" | "edit",
    filePath: unknown,
    sessionID: string,
    gate: HandsOnGateCapability,
  ): void
  /**
   * Journals `{type:"tool", tool:"bash", handsOn:true}` telemetry for
   * write-shaped bash commands — in every mode, for every session (children
   * included, like landing telemetry), and never blocking. The write-shape
   * verdict is classified once by the caller (via
   * {@link classifyBashWrite}) and threaded here, so the command is never
   * re-parsed. Fail-open on an internal error.
   * @param sessionID The session ID, recorded in the journal entry.
   * @param command The raw command value from the host payload (`unknown`).
   * @param verdict The caller's write-shape verdict for the command.
   */
  observeBashWrite(sessionID: string, command: unknown, verdict: BashWriteVerdict): void
  /**
   * Journals `{type:"tool", tool:"write"|"edit", scratch:true, path}` telemetry
   * for a scratch-target parent write/edit — the audit trail for the
   * temp-dir exemption (every exempt write is journaled with its target
   * path, so the exemption can only ever exempt, never gate, and stays
   * observable). The path is recorded unconditionally (bounded), unlike the
   * trace-gated `session_move` directory: the audit trail is the point of
   * the row. Fail-open on an internal error.
   * @param tool The tool name, recorded in the journal (`"write"` or `"edit"`).
   * @param filePath The raw target-path value from the host payload (`unknown`).
   * @param sessionID The session ID, recorded in the journal entry.
   */
  observeScratchWrite(tool: "write" | "edit", filePath: unknown, sessionID: string): void
  /**
   * Gates confident file-writing bash commands through the hands-on ladder
   * (mirroring {@link ToolPolicy.guardHandsOn}): a no-op unless
   * `toolPolicy.bashWriteGate` is set and `verdict` is `"gate"`. A live
   * release or an executor-scoped waiver allows silently; then a pending
   * `.handsOn` once-grant is consumed and allows; otherwise the shared
   * hands-on ladder tail runs (block / repeat-attempt escalation — see
   * {@link ToolPolicy.guardHandsOn}). Ordering: the grant is consumed here,
   * after the flag and verdict checks, so with the gate disabled or a
   * non-gate shape a pending grant is never burned. Fail-open on an
   * internal error.
   * @param tool The tool name, recorded in the journal (`"bash"` or `"shell"`).
   * @param command The raw command value from the host payload (`unknown`).
   * @param verdict The caller's write-shape verdict for the command.
   * @param sessionID The session ID, recorded in journal entries.
   * @param gate The bash-write-gate capability supplied by the hook layer.
   * @throws Error with a `BLOCKED by turnstile:` prefix when the gate blocks.
   */
  guardBashWrite(
    tool: "bash" | "shell",
    command: unknown,
    verdict: BashWriteVerdict,
    sessionID: string,
    gate: BashWriteGateCapability,
  ): void
}

/**
 * Binds the tool-call policy to a resolved config and journaler, compiling the
 * denylists once (each rule paired with its source index) so every later guard
 * is a cached `RegExp.test`. The guards and observers themselves live in
 * `src/tool-policy-guards.ts`; this factory builds the shared state and
 * composes the creators.
 * @param config The resolved plugin configuration.
 * @param journaler The telemetry writer for blocked and error entries.
 * @returns The stateless tool-call policy.
 */
export function createToolPolicy(config: TurnstileConfig, journaler: Journaler): ToolPolicy {
  const bashDeny = compileDenylist(journaler, "bashDeny", config.toolPolicy.bashDeny)
  const pathDeny = compileDenylist(journaler, "pathDeny", config.toolPolicy.pathDeny)
  const commitFormat = compileCommitFormat(config, journaler)
  // Blind-retry escalation state for the commit lint: per-session burst
  // counters (presentation-tier ergonomics, not gate state — deliberately
  // closure-local and not journaled/replayed; a restart resetting the count
  // only degrades the escalation hint, never enforcement).
  const state: ToolPolicyState = {
    config,
    journaler,
    bashDeny,
    pathDeny,
    commitFormat,
    commitRetries: new Map(),
  }
  return {
    ...createDenylistGuards(state),
    ...createTelemetry(state),
    ...createCommitGuard(state),
    ...createLandingGuard(state),
    ...createHandsOnGuard(state),
    ...createBashWriteGuards(state),
  }
}
