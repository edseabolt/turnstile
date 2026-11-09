/**
 * @fileoverview Tool-policy guards and telemetry: the denylist guards
 * (`guardBash`, `guardPath`), the commit-message lint (`guardCommitMessage`),
 * the landing gate (`guardLanding`), the hands-on gates (`guardHandsOn`,
 * `guardBashWrite`), the non-blocking telemetry observers, and the compiled
 * denylist/commit-format builders — extracted from `src/tool-policy.ts`,
 * which now only builds the shared {@link ToolPolicyState} and composes the
 * creators. The pure text helpers (`gitInvocation`, `isPushLanding`,
 * `describeCommitMismatch`) live here too (one home each) and are re-exported
 * from `src/tool-policy.ts` so the public import path is unchanged. A match
 * throws the same `BlockError` the gate layer throws (the hook rethrows it),
 * and every internal failure fails open (journaled, never thrown).
 *
 * First-match wins: the lowest-indexed matching rule is the one recorded and
 * blocked. A source that fails to compile is dropped (defensively re-checked
 * here even though `mergeConfig` drops it first) and journaled as a persistent
 * `{type:"error"}`, so a config typo that weakens the denylist is never silent.
 */

import { DEFAULT_COMMIT_FORMAT } from "./config.ts"
import { BlockError } from "./gates.ts"
import type { Journaler } from "./journal.ts"
import { splitCommands, tokenizeWords, type BashWriteVerdict } from "./bash-write.ts"
import { parseCommitArgs } from "./commit-args.ts"
import type { TurnstileConfig } from "./types.ts"

/**
 * Core landing-gate text shared by the enforce-path throw and the human ask
 * message, so the two never drift. Stamped after `BLOCKED by turnstile:` (the
 * ask message is `turnstile: ${LANDING_REQUIREMENT}`, prefixed with
 * `LANDING_ASK_MESSAGE_PREFIX` in `src/delivery.ts` so the stream
 * consumer can recognize a landing ask).
 * Mode-true in both escalation modes: it instructs stop-and-report and names
 * the release signals (user waiver / earned reviewer verdict), promising no
 * permission ask — correct under `escalation: "block"`, and still the right
 * instruction under `"ask"` (the ask happens, but the agent must stop and
 * report until the reply lands).
 */
export const LANDING_REQUIREMENT =
  "pushing requires a reviewer VERDICT: APPROVE before landing — report this block to the user and stop; the gate releases only on the user's explicit approval (waiver) or an earned reviewer verdict"

/**
 * Core hands-on-gate text (enforce throw + ask message share it, so the two
 * never drift). Stamped after `BLOCKED by turnstile:` (the ask message is
 * `turnstile: ${HANDSON_REQUIREMENT}`, prefixed with
 * `HANDSON_ASK_MESSAGE_PREFIX` in `src/delivery.ts` so the stream consumer
 * can recognize a hands-on ask).
 * Mode-true in both escalation modes (see LANDING_REQUIREMENT): it instructs
 * stop-and-report and drops the ask promise.
 */
export const HANDSON_REQUIREMENT =
  "parent-session write/edit requires the pipeline — dispatch the executor on the approved plan; report this block to the user and stop; the gate releases only on the user's explicit approval (waiver)"

/**
 * The conventional commit types the default `commitFormat` accepts, as one
 * alternation source. Single source for the compiled default (via
 * `DEFAULT_COMMIT_FORMAT` consumers), the block text, and the mismatch
 * classifier, so the three cannot drift.
 */
const COMMIT_TYPE_LIST = "feat|fix|docs|style|refactor|perf|test|build|ci|chore|revert"

/**
 * Suffix added to the invalid-commit-block error, stating the accepted shape.
 * The separator alternatives mirror the default regex's `(?:[!]:?|:) `
 * separator — each requires a trailing space — so a message the gate accepts
 * is never denied by this text.
 */
const COMMIT_EXPECTED =
  `is not a conventional commit — must be '<type>(<scope>)?: <subject>' — type one of ` +
  `${COMMIT_TYPE_LIST.split("|").join(", ")}, optional (scope), a ': ', '! ', or '!: ' ` +
  `separator, subject of 1-72 chars, at most one body line`

/**
 * Canonical example appended to the block error once a session's blind-retry
 * burst crosses `gitGates.commitRetryThreshold` within the window.
 */
const COMMIT_EXAMPLE =
  "Example of an accepted message: 'feat(gates): block uninspectable commit forms'"

/** One compiled denylist rule, paired with its source index for the journal. */
export interface CompiledRule {
  re: RegExp
  index: number
  source: string
}

/**
 * The stateful landing-gate capability `setup.ts` hands to the landing guard
 * so the stateful ledger never crosses into the pure tool-policy boundary. The
 * stateful side (`landingBlocks`, `hasReviewApprove`) lives only in `setup.ts`;
 * tool-policy mutates it exclusively through `recordBlock`/`escalate`.
 */
export interface LandingGateCapability {
  /** True when the task already carries a reviewer `VERDICT: APPROVE` (release signal). */
  hasApproval(): boolean
  /**
   * True when the session journaled a credited reviewer APPROVE — the
   * bucket-free credit that a task-scope reset drops the `hasReviewApprove` flag
   * for (refuses only a refusal-stamped verdict). Lets guardLanding escalate
   * a credited session's first push instead of throwing the first block.
   */
  hasCreditedApproval(): boolean
  /** Count of `no-landing-approval` blocks recorded this task. */
  priorBlocks(): number
  /** Increment {@link LandingGateCapability.priorBlocks} (block path only). */
  recordBlock(): void
  /**
   * Arms the ask latch; returns true when the caller must journal the ask
   * row (dedupe collapses same-tick re-arms within the latch TTL into one
   * journaled ask).
   */
  escalate(): boolean
  /**
   * True when `command` is a statically-provable empty-diff push (a total
   * probe: every refspec's branch resolves to the same commit as its
   * upstream — ref equality, so a behind branch never qualifies; every
   * ambiguous shape, force flags included, is `false`). Consulted only with
   * `gitGates.emptyDiffExempt` on.
   */
  isEmptyDiff(command: string): boolean
}

/**
 * The stateful hands-on-gate capability `setup.ts` hands to the hands-on
 * guard (mirrors LandingGateCapability): the stateful side (`handsOnBlocks`,
 * `handsOnRelease`, the waiver read, the pending-hands-on-ask latch) lives
 * only in the hook layer; tool-policy mutates it exclusively through
 * `recordBlock`/`escalate`.
 */
export interface HandsOnGateCapability {
  /** True when a human `always` reply released this task's parent edits. */
  hasRelease(): boolean
  /** True when the live user waiver's scope covers the `executor` stage. */
  hasWaiver(): boolean
  /** Count of `parent-hands-on` blocks recorded this task. */
  priorBlocks(): number
  /** Increment {@link HandsOnGateCapability.priorBlocks} (block path only). */
  recordBlock(): void
  /**
   * Arms the ask latch; returns true when the caller must journal the ask
   * row (dedupe collapses same-tick re-arms within the latch TTL into one
   * journaled ask).
   */
  escalate(): boolean
}

/**
 * The stateful capability for the bash write gate: the hands-on capability
 * plus the once-grant consume, which only the bash arm runs (the write/edit
 * gate's grant is consumed in the hook layer). Extending without altering
 * keeps existing {@link HandsOnGateCapability} fakes and tests untouched.
 */
export interface BashWriteGateCapability extends HandsOnGateCapability {
  /** Consumes the pending `.handsOn` once-grant; true when one was pending. */
  consumeGrant(): boolean
}

/**
 * The state shared by every tool-policy guard and telemetry observer, built
 * once by `createToolPolicy`: the resolved config, the journaler, the
 * compiled denylists and commit-format matcher, and the commit-lint blind-
 * retry burst counters.
 */
export interface ToolPolicyState {
  /** The resolved plugin configuration. */
  config: TurnstileConfig
  /** The telemetry writer for blocked and error entries. */
  journaler: Journaler
  /** The compiled `bashDeny` rules (each paired with its source index). */
  bashDeny: CompiledRule[]
  /** The compiled `pathDeny` rules (each paired with its source index). */
  pathDeny: CompiledRule[]
  /** The compiled commit-format matcher (anchored, dotall). */
  commitFormat: RegExp
  /** Per-session blind-retry burst counters for the commit lint. */
  commitRetries: Map<string, { count: number; lastMs: number }>
}

/**
 * The landing candidate matcher for `gh pr create|ready|merge`: telemetry
 * only, since a `gh pr create|merge` deny is a configured `bashDeny` rule
 * that fires before observeLanding ever runs (with the empty default that
 * deny is configured-only).
 */
const GH_PR_RE = new RegExp("\\bgh\\s+pr\\s+(create|ready|merge)\\b")

/**
 * Blind-retry escalation map cap for the commit lint: insertion order gives
 * oldest-first eviction at the cap.
 */
const COMMIT_RETRY_MAP_CAP = 1000

/**
 * Returns the git subcommand of one simple command's words and its token index
 * (skipping leading git global options such as `-C dir` / `--git-dir=dir`, each
 * of which may take a value in the following token), or `null` when `words` is
 * not a `git` invocation. Shared by `isPushLanding`, `analyzeCommit`, and
 * `planPushRefs` (the empty-diff probe) so the positional parse has a single
 * source of truth (no duplicated option-skip logic).
 * @param words The tokenized words of one simple command.
 * @returns The subcommand verb and its index, or `null` for a non-git invocation.
 */
export function gitInvocation(words: string[]): { verb: string; index: number } | null {
  if (words.length === 0 || words[0] !== "git") return null
  let i = 1
  while (i < words.length && words[i]!.startsWith("-")) {
    i++ // skip the option token itself
    // A value held in the following token (e.g. `-C dir`) is a global option
    // value and is skipped; an inline value (`--opt=val`) has none.
    if (i < words.length && !words[i]!.startsWith("-")) i++
  }
  return i < words.length ? { verb: words[i]!, index: i } : null
}

/**
 * True when `command` invokes a `git push` — the landing gate's enforcement
 * target. Detection routes through the shell-aware tokenizer (shared with
 * commit linting) so the candidate set has no false positives: `git push`
 * matches (tolerating global options like `-C dir` before the subcommand), but
 * `echo remember to git push`, `git commit -m "docs: git push"`, and
 * `git log --grep push` do not (their subcommand is `echo`/`commit`/`log`).
 * Exported so `setup.ts` arms the evaluate-handler ask against this exact
 * candidate set (single source of truth; no duplicate-regex drift).
 * @param command The raw bash/shell command string.
 * @returns True for a `git push` candidate.
 */
export function isPushLanding(command: string): boolean {
  if (typeof command !== "string" || command.trim() === "") return false
  return splitCommands(command).some(
    (simple) => gitInvocation(tokenizeWords(simple))?.verb === "push",
  )
}

/**
 * Extracts the subject text following the type (and optional scope) of a
 * commit message's first line, or `null` when no accepted separator
 * (`'! '`, `'!: '`, or `': '` — mirroring the default regex's
 * `(?:[!]:?|:) `, each requiring a trailing space) is present. Helper for
 * {@link describeCommitMismatch}.
 * @param rest The first line after the leading type word.
 * @returns The subject after the separator, or `null` when the separator is
 *     missing (including an unclosed scope).
 */
function subjectAfterSeparator(rest: string): string | null {
  if (rest.startsWith("(")) {
    const close = rest.indexOf(")")
    if (close === -1) return null
    rest = rest.slice(close + 1)
  }
  if (rest.startsWith("!: ")) return rest.slice(3)
  if (rest.startsWith("! ")) return rest.slice(2)
  if (rest.startsWith(": ")) return rest.slice(2)
  return null
}

/**
 * Classifies why `message` failed the compiled commit format, returning a
 * concrete clause for the block error (empty string when no specific class
 * matches — e.g. a custom `gitGates.commitFormat` rejecting a message the
 * default-shape classes all pass). Pure: no config, no I/O. First match wins.
 * The clauses describe the DEFAULT format; when an operator overrides
 * `gitGates.commitFormat` the block error carries an additional note (see the
 * block-throw site), so a custom format is never silently mis-described.
 * @param message The attempted commit message.
 * @returns The mismatch clause, or `""` when no specific class matches.
 */
export function describeCommitMismatch(message: string): string {
  // `split` with limit 1 always yields a first element, so the assertion is safe.
  const firstLine = message.split(/\r?\n/, 1)[0]!
  const type = /^([a-z]+)/.exec(firstLine)?.[1]
  if (type === undefined || !COMMIT_TYPE_LIST.split("|").includes(type))
    return `missing a known type prefix (${COMMIT_TYPE_LIST})`
  const subject = subjectAfterSeparator(firstLine.slice(type.length))
  if (subject === null) return "missing the ': ' or '!' separator after the type/scope"
  if (subject === "") return "missing the subject after ': '"
  if (subject.length > 72)
    return `subject exceeds 72 characters (first line is ${firstLine.length} chars)`
  const body = message.slice(firstLine.length)
  if (body !== "" && !/^(\r?\n){1,2}[^\r\n]*$/.test(body)) return "more than one body line"
  return ""
}

/**
 * Compiles a denylist, dropping and journaling any non-compiling source.
 * A drop is journaled as a persistent `{type:"error"}` so a typed rule that
 * weakens the denylist is recorded for the operator, never silent.
 * @param journaler The telemetry writer for the drop entries.
 * @param name Which list is compiled (`"bashDeny"` or `"pathDeny"`).
 * @param sources The regex sources to compile.
 * @returns The compilable rules, each paired with its source index.
 */
export function compileDenylist(
  journaler: Journaler,
  name: "bashDeny" | "pathDeny",
  sources: string[],
): CompiledRule[] {
  const rules: CompiledRule[] = []
  sources.forEach((source, index) => {
    try {
      rules.push({ re: new RegExp(source, "i"), index, source })
    } catch {
      journaler.journal({
        type: "error",
        error: `tool policy: dropped invalid ${name}[${index}] regex "${source}"; the operation it guarded is now allowed`,
      })
    }
  })
  return rules
}

/**
 * Compiles the commit-format matcher: `commitFormat` is a conventional-commits
 * regex SOURCE (no anchors); the returned regex wraps it with `"^…$"` + the
 * `"s"` flag so `.` spans the optional body line. The default (a validated
 * conventional-commit source) is the fall-back when the configured source does
 * not compile — `mergeConfig` already drops invalid sources, so this is a
 * defensive re-check, but it is journaled (never silent) if a source slips
 * through.
 * @param config The resolved plugin configuration.
 * @param journaler The telemetry writer for the fallback entry.
 * @returns The anchored, dotall commit-format matcher.
 */
export function compileCommitFormat(config: TurnstileConfig, journaler: Journaler): RegExp {
  const source =
    typeof config.gitGates.commitFormat === "string"
      ? config.gitGates.commitFormat
      : DEFAULT_COMMIT_FORMAT
  try {
    return new RegExp(`^${source}$`, "s")
  } catch {
    journaler.journal({
      type: "error",
      error: `tool policy: dropped invalid gitGates.commitFormat "${source}"; falling back to the conventional-commit default`,
    })
    return new RegExp(`^${DEFAULT_COMMIT_FORMAT}$`, "s")
  }
}

/**
 * Journals a gate block — one source for the landing, commit-lint, and
 * hands-on block entries, so the three ladders cannot drift in entry shape.
 * @param state The shared tool-policy state.
 * @param tool The tool name, recorded in the journal entry.
 * @param sessionID The session ID, recorded in journal entries.
 * @param reason The gate-specific block reason string.
 * @param retries Optional burst-retry count (commit-lint invalid-message
 *     blocks only); omitted from the entry when absent.
 */
function journalGateBlock(
  state: ToolPolicyState,
  tool: string,
  sessionID: string,
  reason: string,
  retries?: number,
): void {
  state.journaler.journal({
    type: "blocked",
    sessionID,
    tool,
    reason,
    ...(retries === undefined ? {} : { retries }),
  })
  state.journaler.traceEvent("tool-policy", "blocked", `${tool} ${reason}`, sessionID)
}

/**
 * Journals a denylist block and hands control back to the caller, which
 * throws.
 * @param state The shared tool-policy state.
 * @param tool The tool name, recorded in the journal entry.
 * @param rule The matching rule.
 * @param sessionID The session ID, recorded in journal entries.
 */
function journalBlocked(
  state: ToolPolicyState,
  tool: string,
  rule: CompiledRule,
  sessionID: string,
): void {
  state.journaler.journal({
    type: "blocked",
    sessionID,
    tool,
    reason: "tool-policy",
    rule: rule.index,
  })
  state.journaler.traceEvent("tool-policy", "blocked", `${tool} rule ${rule.index}`, sessionID)
}

/**
 * Journals the empty-input misconfiguration shared by every guard: the host
 * payload carried no usable text, so the guard fails open with telemetry
 * naming the documented candidate keys (a host payload reshape is observable
 * rather than silently allowed).
 * @param state The shared tool-policy state.
 * @param text The coerced input text (already `""` when absent/non-string).
 * @param sessionID The session ID, recorded in the journal entry.
 * @param label The guard label naming the check in the entry.
 * @param noun What the guard expected (`"command"` / `"target path"`).
 * @param keys The documented host payload candidate keys.
 * @returns True when the input is empty (the caller fails open and returns).
 */
function requireCommandText(
  state: ToolPolicyState,
  text: string,
  sessionID: string,
  label: string,
  noun: string,
  keys: string,
): boolean {
  if (text.length !== 0) return false
  state.journaler.journal({
    type: "error",
    sessionID,
    error: `execute.before: ${label} carried no ${noun}; does the host input shape still use ${keys}?`,
  })
  return true
}

/**
 * The guards' shared fail-open catch tail: rethrows the deliberate
 * `BlockError` (never swallowed), journals every other internal failure.
 * @param state The shared tool-policy state.
 * @param e The caught error.
 */
function guardFailOpen(state: ToolPolicyState, e: unknown): void {
  if (e instanceof BlockError) throw e
  state.journaler.journal({ type: "error", error: `tool policy guard: ${e}` })
}

/**
 * Journals and throws the invalid-commit-message block, with a concrete
 * mismatch diagnosis and the blind-retry escalation: the session's counter
 * is reset when the last failure is older than `commitRetryWindowMs`,
 * incremented otherwise, and once it reaches `commitRetryThreshold` the
 * canonical example rides the error. When the active `commitFormat` differs
 * from the default, a note says the diagnosis describes the default the
 * custom format overrides. One guard call counts as ONE attempt: the first
 * invalid `-m` message throws, so later messages of the same command are
 * never counted.
 * @param state The shared tool-policy state.
 * @param tool The tool name, recorded in the journal entry.
 * @param sessionID The committing session (the burst counter's key).
 * @param message The invalid commit message.
 * @throws BlockError — the deliberate block (rethrown by the guard's
 *     fail-open wrapper, never swallowed).
 */
function blockInvalidCommit(
  state: ToolPolicyState,
  tool: string,
  sessionID: string,
  message: string,
): never {
  const now = Date.now()
  const prev = state.commitRetries.get(sessionID)
  const withinWindow =
    prev !== undefined && now - prev.lastMs <= state.config.gitGates.commitRetryWindowMs
  const count = (withinWindow ? prev!.count : 0) + 1
  if (state.commitRetries.size >= COMMIT_RETRY_MAP_CAP && !state.commitRetries.has(sessionID)) {
    const oldest = state.commitRetries.keys().next().value
    if (oldest !== undefined) state.commitRetries.delete(oldest)
  }
  state.commitRetries.set(sessionID, { count, lastMs: now })
  const why = describeCommitMismatch(message)
  const customNote =
    state.config.gitGates.commitFormat !== DEFAULT_COMMIT_FORMAT
      ? " (the diagnosis describes the default format; a custom gitGates.commitFormat overrides it)"
      : ""
  const escalated = count >= state.config.gitGates.commitRetryThreshold
  // `retries` rides only the escalated entry: the burst count is escalation
  // metadata, not noise for every sub-threshold block.
  journalGateBlock(state, tool, sessionID, "invalid-commit-message", escalated ? count : undefined)
  throw new BlockError(
    `BLOCKED by turnstile: commit message '${message.slice(0, 80)}' ${COMMIT_EXPECTED}` +
      `${customNote}${why ? ` — ${why}` : ""}${escalated ? ` ${COMMIT_EXAMPLE}` : ""}`,
  )
}

/**
 * Given one simple command's words, return its `git commit` analysis: the
 * extracted `-m` messages and whether the invocation is uninspectable
 * (`-F`/`-t`/`--edit`/`-e` present, or a bundled cluster carrying an
 * editor/template flag). Returns null when `words` is not a `git commit`
 * invocation — so `git commit-graph` (subcommand `commit-graph`) and
 * `echo git commit` (command `echo`) never match.
 * @param words The tokenized words of one simple command.
 * @returns The messages and uninspectable flag, or `null` for a non-commit.
 */
function analyzeCommit(words: string[]): { messages: string[]; uninspectable: boolean } | null {
  const inv = gitInvocation(words)
  if (inv === null || inv.verb !== "commit") return null
  return parseCommitArgs(words.slice(inv.index + 1))
}

/**
 * Inputs to the shared guard ladder tail (see {@link guardLadderTail}).
 */
interface LadderTail {
  /** True when this attempt escalates (repeat, or a credited first attempt). */
  armed: boolean
  /** Tool name, recorded in journal entries. */
  tool: string
  /** Session ID, recorded in journal entries. */
  sessionID: string
  /** Ask reason string (`"landing"` / `"hands-on"`). */
  reason: string
  /** Escalation + block-recording capability from the caller's gate. */
  gate: { escalate(): boolean; recordBlock(): void }
  /** The gate's block journaler (a journalGateBlock delegation). */
  journalBlock: (tool: string, sessionID: string) => void
  /** Requirement text the enforce throw names. */
  requirement: string
  /** Optional BlockError cause stamp (the hands-on gate stamps `"hands-on"`). */
  blockCause?: string
}

/**
 * Shared guard ladder tail, ask-first: an armed attempt arms the one-shot
 * ask latch (`gate.escalate()`) and — when the arm is not a within-window
 * duplicate — journals the permission ask row and allows (the evaluate
 * handler forces the human ask off the latch). The deliberate block-throw
 * is the FALLBACK, not the default: it fires when the escalation is not
 * armed (first attempt) or the latch cannot be armed (within-TTL
 * duplicate arm — the ask is already live for this gate). This holds in
 * BOTH `escalation` modes: the mode does not select block-vs-ask on
 * armed attempts, because an
 * interactive host can surface the ask in either and the throw only
 * serves the no-human-attached fallback. Fail-toward-strict: a reject
 * leaves the gate red and the next attempt re-blocks. One source for the
 * landing and hands-on ladders so the two cannot drift.
 * @param state The shared tool-policy state.
 * @param t The parameterized ladder inputs (see {@link LadderTail}).
 */
function guardLadderTail(state: ToolPolicyState, t: LadderTail): void {
  if (t.armed && t.gate.escalate()) {
    state.journaler.journal({
      type: "permission",
      sessionID: t.sessionID,
      tool: t.tool,
      action: "ask",
      reason: t.reason,
    })
    return
  }
  t.journalBlock(t.tool, t.sessionID)
  t.gate.recordBlock()
  throw new BlockError(`BLOCKED by turnstile: ${t.requirement}.`, t.blockCause)
}

/**
 * Shared hands-on ladder tail: both the write/edit guard and the bash
 * write guard pass identical inputs to {@link guardLadderTail}, so the
 * block/escalation decision has one source (DRY).
 * @param state The shared tool-policy state.
 * @param tool The tool name, recorded in journal entries.
 * @param sessionID The session ID, recorded in journal entries.
 * @param gate The hands-on capability from the caller's gate.
 */
function handsOnTail(
  state: ToolPolicyState,
  tool: string,
  sessionID: string,
  gate: HandsOnGateCapability,
): void {
  guardLadderTail(state, {
    armed: gate.priorBlocks() >= 1,
    tool,
    sessionID,
    reason: "hands-on",
    gate,
    journalBlock: (t, s) => journalGateBlock(state, t, s, "parent-hands-on"),
    requirement: HANDSON_REQUIREMENT,
    blockCause: "hands-on",
  })
}

/**
 * Guards a bash/shell command: fails open on an empty command (misconfiguration
 * telemetry), yields on a non-match, and journals + throws a match.
 * @param state The shared tool-policy state.
 * @param tool The tool name, recorded in the journal entry.
 * @param command The raw command value from the host payload.
 * @param sessionID The session ID, recorded in journal entries.
 * @throws Error with a `BLOCKED by turnstile:` prefix when a rule matches.
 */
function guardBash(
  state: ToolPolicyState,
  tool: "bash" | "shell",
  command: unknown,
  sessionID: string,
): void {
  try {
    const text = typeof command === "string" ? command : ""
    if (requireCommandText(state, text, sessionID, "bash/shell", "command", "command or cmd"))
      return
    const rule = state.bashDeny.find((r) => r.re.test(text))
    if (!rule) return
    journalBlocked(state, tool, rule, sessionID)
    throw new BlockError(
      `BLOCKED by turnstile: ${tool} blocked by policy rule ${rule.index}: ${rule.source}`,
    )
  } catch (e) {
    guardFailOpen(state, e)
  }
}

/**
 * Guards a write/edit target path: same shape as {@link guardBash} but matched
 * against `pathDeny` (empty by default, so ordinary editing is never blocked
 * until a user configures `pathDeny`).
 * @param state The shared tool-policy state.
 * @param tool The tool name, recorded in the journal entry.
 * @param filePath The raw target-path value from the host payload.
 * @param sessionID The session ID, recorded in journal entries.
 * @throws Error with a `BLOCKED by turnstile:` prefix when a rule matches.
 */
function guardPath(
  state: ToolPolicyState,
  tool: "write" | "edit",
  filePath: unknown,
  sessionID: string,
): void {
  try {
    const text = typeof filePath === "string" ? filePath : ""
    if (requireCommandText(state, text, sessionID, "write/edit", "target path", "filePath or path"))
      return
    const rule = state.pathDeny.find((r) => r.re.test(text))
    if (!rule) return
    journalBlocked(state, tool, rule, sessionID)
    throw new BlockError(
      `BLOCKED by turnstile: ${tool} blocked by policy rule ${rule.index}: ${rule.source}`,
    )
  } catch (e) {
    guardFailOpen(state, e)
  }
}

/**
 * Lints one simple command of a `git commit` guard call: analyzes the
 * invocation, fail-closes on uninspectable forms, and validates each `-m`
 * message against the compiled format.
 * @param state The shared tool-policy state.
 * @param tool The tool name, recorded in the journal.
 * @param sessionID The session ID, recorded in journal entries.
 * @param simple One simple command string (already separator-split).
 */
function lintOneCommand(
  state: ToolPolicyState,
  tool: string,
  sessionID: string,
  simple: string,
): void {
  const analysis = analyzeCommit(tokenizeWords(simple))
  if (analysis === null) return
  // Uninspectable (an -F/-t/--edit/-e flag, or a bare interactive commit
  // with no -m): the operator cannot see the subject, so fail-closed —
  // treat it as non-conventional.
  if (analysis.uninspectable || analysis.messages.length === 0) {
    journalGateBlock(state, tool, sessionID, "commit-message-uninspectable")
    throw new BlockError(
      `BLOCKED by turnstile: commit message could not be inspected — pass it with 'git commit -m <subject>' (-F/-t/--edit/-e are not inspectable)`,
    )
    // The `throw` exits the guard; later simple commands in this string
    // are not linted (the first failure is the one surfaced).
  }
  for (const message of analysis.messages) {
    if (!state.commitFormat.test(message)) blockInvalidCommit(state, tool, sessionID, message)
    // A passing message ends the burst: the session's counter is
    // dropped, so the next failure counts as the first attempt.
    state.commitRetries.delete(sessionID)
  }
}

/**
 * Lints `git commit` messages as conventional commits. Extracts the `git
 * commit` invocations (via the shell-aware tokenizer, so substrings and
 * `git commit-graph` are never matched), validates each `-m` argument against
 * the compiled `commitFormat`, and fail-closes on uninspectable forms
 * (`-F`/`-t`/`--edit`/`-e`, or a bare interactive commit with no `-m`).
 * @param state The shared tool-policy state.
 * @param tool The tool name, recorded in the journal.
 * @param command The raw command value from the host payload (`unknown`).
 * @param sessionID The session ID, recorded in journal entries.
 * @throws Error with a `BLOCKED by turnstile:` prefix when the lint rejects.
 */
function guardCommitMessage(
  state: ToolPolicyState,
  tool: "bash" | "shell",
  command: unknown,
  sessionID: string,
): void {
  try {
    if (!state.config.gitGates.commitMessages) return
    const text = typeof command === "string" ? command : ""
    if (requireCommandText(state, text, sessionID, "git commit lint", "command", "command or cmd"))
      return
    for (const simple of splitCommands(text)) lintOneCommand(state, tool, sessionID, simple)
  } catch (e) {
    guardFailOpen(state, e)
  }
}

/**
 * Journals landing telemetry (`{type:"tool", tool:"bash", landing:true}`) for
 * `git push` / `gh pr create|ready|merge` candidates — in every mode, and
 * never blocking. `gh pr` telemetry is disjoint from a configured
 * `bashDeny` deny of `gh pr create|merge` (with the empty default that deny
 * fires only when configured; when it is configured, `guardBash` fires first
 * and the two journal reasons stay disjoint).
 * @param state The shared tool-policy state.
 * @param sessionID The session ID, recorded in the journal entry.
 * @param command The raw command value from the host payload (`unknown`).
 */
function observeLanding(state: ToolPolicyState, sessionID: string, command: unknown): void {
  try {
    const text = typeof command === "string" ? command : ""
    if (text.length === 0) return
    if (isPushLanding(text) || GH_PR_RE.test(text)) {
      state.journaler.journal({ type: "tool", sessionID, tool: "bash", landing: true })
    }
  } catch (e) {
    state.journaler.journal({ type: "error", error: `tool policy guard: ${e}` })
  }
}

/**
 * Guards a parent-session `write`/`edit` target path. `gate` is the
 * stateful capability from the hook layer (registered pipeline children
 * never reach it — the caller's dispatch skip owns the parent-only
 * contract). A live release or an executor-scoped waiver allows silently;
 * otherwise the shared ladder tail runs (see {@link guardHandsOn}'s
 * interface doc). An empty/absent path journals the misconfiguration and
 * allows (fail-open telemetry).
 * @param state The shared tool-policy state.
 * @param tool The tool name, recorded in the journal.
 * @param filePath The raw target-path value from the host payload.
 * @param sessionID The session ID, recorded in journal entries.
 * @param gate The hands-on-gate capability supplied by the hook layer.
 * @throws Error with a `BLOCKED by turnstile:` prefix when the gate blocks.
 */
function guardHandsOn(
  state: ToolPolicyState,
  tool: "write" | "edit",
  filePath: unknown,
  sessionID: string,
  gate: HandsOnGateCapability,
): void {
  try {
    const text = typeof filePath === "string" ? filePath : ""
    if (
      requireCommandText(state, text, sessionID, "hands-on gate", "target path", "filePath or path")
    )
      return
    if (gate.hasRelease() || gate.hasWaiver()) return
    handsOnTail(state, tool, sessionID, gate)
  } catch (e) {
    guardFailOpen(state, e)
  }
}

/**
 * Gates confident file-writing bash commands through the hands-on ladder
 * (see {@link ToolPolicy.guardBashWrite}). Ordering: the `bashWriteGate`
 * flag and the `verdict === "gate"` check come first, then the release /
 * waiver short-circuits, then the once-grant is consumed HERE (so a
 * disabled gate or a non-gate shape never burns a pending grant), then
 * the shared ladder tail.
 * @param state The shared tool-policy state.
 * @param tool The tool name, recorded in the journal.
 * @param command The raw command value from the host payload (`unknown`).
 * @param verdict The caller's write-shape verdict for the command.
 * @param sessionID The session ID, recorded in journal entries.
 * @param gate The bash-write-gate capability supplied by the hook layer.
 * @throws Error with a `BLOCKED by turnstile:` prefix when the gate blocks.
 */
function guardBashWrite(
  state: ToolPolicyState,
  tool: "bash" | "shell",
  command: unknown,
  verdict: BashWriteVerdict,
  sessionID: string,
  gate: BashWriteGateCapability,
): void {
  try {
    if (!state.config.toolPolicy.bashWriteGate || verdict !== "gate") return
    if (gate.hasRelease() || gate.hasWaiver()) return
    if (gate.consumeGrant()) return
    handsOnTail(state, tool, sessionID, gate)
  } catch (e) {
    guardFailOpen(state, e)
  }
}

/**
 * Gates a `git push` on a reviewer `VERDICT: APPROVE`. `gate` is the
 * stateful capability from `setup.ts`. With approval: allow, no journal noise
 * beyond telemetry. Without, the first block journals
 * `no-landing-approval` and throws — unless the session already carries a
 * credited reviewer APPROVE that a task-scope reset dropped, in which case even
 * the first attempt is the human decision point: it journals a `permission`
 * ask and signals escalation, allowing `execute.before` to pass so the
 * evaluate handler forces the ask. A repeat attempt escalates the same way.
 * With `gitGates.emptyDiffExempt` (default true; `false` is the strict
 * opt-out), a push the capability proves statically empty against upstream is
 * journaled `exempt:"empty-diff"` and allowed; every ambiguous shape falls
 * through to the ladder — fail-toward-strict.
 * @param state The shared tool-policy state.
 * @param tool The tool name, recorded in the journal.
 * @param command The raw command value from the host payload (`unknown`).
 * @param sessionID The session ID, recorded in journal entries.
 * @param gate The landing-gate capability supplied by `setup.ts`.
 * @throws Error with a `BLOCKED by turnstile:` prefix when the gate blocks.
 */
function guardLanding(
  state: ToolPolicyState,
  tool: "bash" | "shell",
  command: unknown,
  sessionID: string,
  gate: LandingGateCapability,
): void {
  try {
    if (!state.config.gitGates.landingGate) return
    const text = typeof command === "string" ? command : ""
    if (requireCommandText(state, text, sessionID, "landing gate", "command", "command or cmd"))
      return
    if (!isPushLanding(text)) return
    // Approval releases the gate: allow, no journal noise beyond telemetry.
    if (gate.hasApproval()) return
    if (allowEmptyDiff(state, tool, sessionID, text, gate)) return
    landingLadder(state, tool, sessionID, gate)
  } catch (e) {
    guardFailOpen(state, e)
  }
}

/**
 * The empty-diff exemption arm: a push the capability proves statically
 * empty against its upstream is journaled and allowed. The probe is
 * total (every ambiguous shape is false), so this clause can only
 * release pushes the git state proves to land nothing. Consulted only
 * with `gitGates.emptyDiffExempt` on.
 * @param state The shared tool-policy state.
 * @param tool The tool name, recorded in the journal entry.
 * @param sessionID The session ID, recorded in the journal entry.
 * @param text The push command text.
 * @param gate The landing-gate capability.
 * @returns True when the push was exempted (the caller allows and returns).
 */
function allowEmptyDiff(
  state: ToolPolicyState,
  tool: string,
  sessionID: string,
  text: string,
  gate: LandingGateCapability,
): boolean {
  if (!state.config.gitGates.emptyDiffExempt || !gate.isEmptyDiff(text)) return false
  state.journaler.journal({ type: "tool", sessionID, tool, landing: true, exempt: "empty-diff" })
  return true
}

/**
 * The landing ladder arm: a journaled credit escalates the first attempt
 * too — the task-scope reset dropped the `hasReviewApprove` flag, but the
 * session still carries a non-refused reviewer APPROVE, so the human
 * decides this first push rather than one wasted `no-landing-approval`
 * block earlier.
 * @param state The shared tool-policy state.
 * @param tool The tool name, recorded in journal entries.
 * @param sessionID The session ID, recorded in journal entries.
 * @param gate The landing-gate capability.
 */
function landingLadder(
  state: ToolPolicyState,
  tool: string,
  sessionID: string,
  gate: LandingGateCapability,
): void {
  guardLadderTail(state, {
    armed: gate.priorBlocks() >= 1 || gate.hasCreditedApproval(),
    tool,
    sessionID,
    reason: "landing",
    gate,
    journalBlock: (t, s) => journalGateBlock(state, t, s, "no-landing-approval"),
    requirement: LANDING_REQUIREMENT,
  })
}

/**
 * Journals a `session_move` dispatch as telemetry only; never blocks. No-op
 * when `observeSessionMove` is false. Called by two channels: the
 * `session_move` tool hook, and the project-directory resolver when it
 * replaces a session's cached directory with a different one (a move the
 * tool hook did not witness); the resolver passes `origin` so its entry
 * carries `reason` and the enforced project switch is observable.
 * @param state The shared tool-policy state.
 * @param sessionID The session ID, recorded in the journal entry.
 * @param directory The move target directory from the host payload or the resolver.
 * @param origin The telemetry channel label, recorded as `reason` when provided.
 */
function observeSessionMove(
  state: ToolPolicyState,
  sessionID: string,
  directory: unknown,
  origin?: "re-resolved",
): void {
  if (!state.config.toolPolicy.observeSessionMove) return
  state.journaler.journal({
    type: "tool",
    sessionID,
    tool: "session_move",
    directory: state.config.trace ? String(directory ?? "").slice(0, 200) : "<redacted>",
    ...(origin ? { reason: origin } : {}),
  })
}

/**
 * Journals scratch-target write/edit telemetry (`{type:"tool",
 * tool:"write"|"edit", scratch:true, path}`) — the audit trail for the
 * temp-dir exemption. The target path is recorded unconditionally
 * (bounded), unlike the trace-gated `session_move` directory: the audit
 * trail is the point of the row. Fail-open on an internal error.
 * @param state The shared tool-policy state.
 * @param tool The tool name, recorded in the journal.
 * @param filePath The raw target-path value from the host payload (`unknown`).
 * @param sessionID The session ID, recorded in the journal entry.
 */
function observeScratchWrite(
  state: ToolPolicyState,
  tool: "write" | "edit",
  filePath: unknown,
  sessionID: string,
): void {
  try {
    state.journaler.journal({
      type: "tool",
      sessionID,
      tool,
      scratch: true,
      path: typeof filePath === "string" ? filePath.slice(0, 200) : "<redacted>",
    })
  } catch (e) {
    state.journaler.journal({ type: "error", error: `tool policy guard: ${e}` })
  }
}

/**
 * Journals hands-on bash write telemetry (`{type:"tool", tool:"bash",
 * handsOn:true}`) for write-shaped commands — always, in every mode, for
 * every session (children included, like landing telemetry), and never
 * blocking. No-op for a non-write-shaped command.
 * @param state The shared tool-policy state.
 * @param sessionID The session ID, recorded in the journal entry.
 * @param command The raw command value from the host payload (`unknown`).
 * @param verdict The caller's write-shape verdict for the command.
 */
function observeBashWrite(
  state: ToolPolicyState,
  sessionID: string,
  command: unknown,
  verdict: BashWriteVerdict,
): void {
  try {
    if (verdict === "none") return
    state.journaler.journal({ type: "tool", sessionID, tool: "bash", handsOn: true })
  } catch (e) {
    state.journaler.journal({ type: "error", error: `tool policy guard: ${e}` })
  }
}

/**
 * Builds the denylist guards bound to the shared state.
 * @param state The shared tool-policy state.
 * @returns `guardBash` (bash/shell command denylist) and `guardPath`
 *     (write/edit path denylist).
 */
export function createDenylistGuards(state: ToolPolicyState): {
  guardBash(tool: "bash" | "shell", command: unknown, sessionID: string): void
  guardPath(tool: "write" | "edit", filePath: unknown, sessionID: string): void
} {
  return {
    guardBash: (tool, command, sessionID) => guardBash(state, tool, command, sessionID),
    guardPath: (tool, filePath, sessionID) => guardPath(state, tool, filePath, sessionID),
  }
}

/**
 * Builds the non-blocking telemetry observers bound to the shared state.
 * @param state The shared tool-policy state.
 * @returns The four observers (`observeSessionMove`, `observeLanding`,
 *     `observeScratchWrite`, `observeBashWrite`).
 */
export function createTelemetry(state: ToolPolicyState): {
  observeSessionMove(sessionID: string, directory: unknown, origin?: "re-resolved"): void
  observeLanding(sessionID: string, command: unknown): void
  observeScratchWrite(tool: "write" | "edit", filePath: unknown, sessionID: string): void
  observeBashWrite(sessionID: string, command: unknown, verdict: BashWriteVerdict): void
} {
  return {
    observeSessionMove: (sessionID, directory, origin) =>
      observeSessionMove(state, sessionID, directory, origin),
    observeLanding: (sessionID, command) => observeLanding(state, sessionID, command),
    observeScratchWrite: (tool, filePath, sessionID) =>
      observeScratchWrite(state, tool, filePath, sessionID),
    observeBashWrite: (sessionID, command, verdict) =>
      observeBashWrite(state, sessionID, command, verdict),
  }
}

/**
 * Builds the commit-message lint guard bound to the shared state.
 * @param state The shared tool-policy state.
 * @returns `guardCommitMessage`.
 */
export function createCommitGuard(state: ToolPolicyState): {
  guardCommitMessage(tool: "bash" | "shell", command: unknown, sessionID: string): void
} {
  return {
    guardCommitMessage: (tool, command, sessionID) =>
      guardCommitMessage(state, tool, command, sessionID),
  }
}

/**
 * Builds the landing gate guard bound to the shared state.
 * @param state The shared tool-policy state.
 * @returns `guardLanding`.
 */
export function createLandingGuard(state: ToolPolicyState): {
  guardLanding(
    tool: "bash" | "shell",
    command: unknown,
    sessionID: string,
    gate: LandingGateCapability,
  ): void
} {
  return {
    guardLanding: (tool, command, sessionID, gate) =>
      guardLanding(state, tool, command, sessionID, gate),
  }
}

/**
 * Builds the hands-on write/edit guard bound to the shared state.
 * @param state The shared tool-policy state.
 * @returns `guardHandsOn`.
 */
export function createHandsOnGuard(state: ToolPolicyState): {
  guardHandsOn(
    tool: "write" | "edit",
    filePath: unknown,
    sessionID: string,
    gate: HandsOnGateCapability,
  ): void
} {
  return {
    guardHandsOn: (tool, filePath, sessionID, gate) =>
      guardHandsOn(state, tool, filePath, sessionID, gate),
  }
}

/**
 * Builds the bash write gate guard bound to the shared state.
 * @param state The shared tool-policy state.
 * @returns `guardBashWrite`.
 */
export function createBashWriteGuards(state: ToolPolicyState): {
  guardBashWrite(
    tool: "bash" | "shell",
    command: unknown,
    verdict: BashWriteVerdict,
    sessionID: string,
    gate: BashWriteGateCapability,
  ): void
} {
  return {
    guardBashWrite: (tool, command, verdict, sessionID, gate) =>
      guardBashWrite(state, tool, command, verdict, sessionID, gate),
  }
}
