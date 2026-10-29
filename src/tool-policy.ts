/**
 * @fileoverview Tool-call policy boundary: stateless matching for the tools
 * that flow through `execute.before` — bash/shell commands (`guardBash`,
 * `guardCommitMessage`, `observeLanding`, `guardLanding` — whose opt-in
 * empty-diff exemption rides the capability's total probe) and write/edit
 * target paths (`guardPath`) — plus non-blocking `session_move` telemetry
 * (`observeSessionMove`). The `bashDeny`/`pathDeny` denylist sources and the
 * landing/commit-format regexes compile once at creation; the hot path is a
 * cached `RegExp.test`. A match throws the same `BlockError` the gate layer
 * throws (the hook rethrows it), and every internal failure fails open
 * (journaled, never thrown).
 *
 * First-match wins: the lowest-indexed matching rule is the one recorded and
 * blocked. A source that fails to compile is dropped (defensively re-checked
 * here even though `mergeConfig` drops it first) and journaled as a persistent
 * `{type:"error"}`, so a config typo that weakens the denylist is never silent.
 * See the `src/types.ts` `TurnstileToolPolicy` contract for the config shape.
 */

import { DEFAULT_COMMIT_FORMAT } from "./config.ts"
import { BlockError } from "./gates.ts"
import type { Journaler } from "./journal.ts"
import type { TurnstileConfig } from "./types.ts"
import type { BashWriteVerdict } from "./bash-write.ts"

// The shell-aware tokenizer lives in `src/bash-write.ts` (the write-shape
// classifier owns it so the dependency stays acyclic); it is re-exported here
// so `empty-diff.ts` and the tests keep importing from this boundary.
export { splitCommands, tokenizeWords } from "./bash-write.ts"
import { splitCommands, tokenizeWords } from "./bash-write.ts"

/** One compiled denylist rule, paired with its source index for the journal. */
interface CompiledRule {
  re: RegExp
  index: number
  source: string
}

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
 * target. Detection routes through the shell-aware tokenizer above (shared with
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
 * Core landing-gate text shared by the enforce-path throw and the human ask
 * message, so the two never drift. Stamped after `BLOCKED by turnstile:` (the
 * ask message is `turnstile: ${LANDING_REQUIREMENT}`, prefixed so the stream
 * consumer can recognize a landing ask by its `turnstile: push/PR …` prefix).
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
 * `turnstile: ${HANDSON_REQUIREMENT}`, prefixed so the stream consumer can
 * recognize a hands-on ask by its `turnstile: hands-on edits …` prefix).
 * Mode-true in both escalation modes (see LANDING_REQUIREMENT): it instructs
 * stop-and-report and drops the ask promise.
 */
export const HANDSON_REQUIREMENT =
  "parent-session write/edit requires the pipeline — dispatch the executor on the approved plan; report this block to the user and stop; the gate releases only on the user's explicit approval (waiver)"

/**
 * Suffix added to the invalid-commit-block ask, describing the accepted shape.
 * @returns The "expected …" suffix.
 */
const COMMIT_EXPECTED = "is not a conventional commit — expected type(scope)!: subject"

/**
 * Reads a bundled short-flag cluster (e.g. `-am`) and returns the embedded
 * `-m` message when `m` is present and no editor/template flag precedes it,
 * or `uninspectable: true` when an `e`/`t`/`F` character precedes `m`, when
 * `m` requires a separate next token that is missing or is itself a flag.
 * Characters after `m` are its inline value (git bundling semantics), so they
 * are never scanned for editor flags — e.g. `-am"feat: x"` tokenizes to
 * `-amfeat: x`. Returns `{ uninspectable: false }` (no message) when the
 * cluster has no `m` at all.
 * @param token The cluster word including the leading `-` (e.g. `-am`).
 * @param next The word following the cluster in the arg list, or `undefined`.
 * @returns The parsed result: `message` when `m` carried an inline or adjacent
 *     value, `uninspectable` when the cluster is uninspectable, and
 *     `consumedNext` when the caller must advance the loop index by one.
 */
function readShortCluster(
  token: string,
  next: string | undefined,
): { message?: string; uninspectable: boolean; consumedNext: boolean } {
  const letters = token.slice(1)
  const mIdx = letters.indexOf("m")
  const flagPart = mIdx === -1 ? letters : letters.slice(0, mIdx)
  if (/[eFt]/.test(flagPart)) return { uninspectable: true, consumedNext: false }
  if (mIdx === -1) return { uninspectable: false, consumedNext: false }
  const inline = letters.slice(mIdx + 1)
  if (inline.length > 0) return { message: inline, uninspectable: false, consumedNext: false }
  if (next !== undefined && !next.startsWith("-"))
    return { message: next, uninspectable: false, consumedNext: true }
  return { uninspectable: true, consumedNext: false }
}

/**
 * Scans the commit args of a `git commit` invocation for `-m`/`--message`
 * messages and uninspectable flags. Bundled short-flag clusters that embed
 * `-m` (e.g. `-am`, `-am<msg>`) are inspectable: their message is extracted
 * and linted. A cluster carrying an `e`/`t`/`F` flag stays uninspectable.
 * @param args The word list following the `commit` subcommand.
 * @returns The extracted messages and whether the invocation is uninspectable.
 */
function parseCommitArgs(args: string[]): { messages: string[]; uninspectable: boolean } {
  const messages: string[] = []
  let uninspectable = false
  for (let j = 0; j < args.length; j++) {
    const a = args[j]!
    if (a === "-m" || a === "--message") {
      const next = args[j + 1]
      if (next !== undefined) messages.push(next)
      else uninspectable = true
    } else if (a.startsWith("--message=")) {
      messages.push(a.slice("--message=".length))
    } else if (a.startsWith("-m")) {
      messages.push(a.slice(2))
    } else if (/^-[A-Za-z]{2,}/.test(a)) {
      const r = readShortCluster(a, args[j + 1])
      if (r.uninspectable) uninspectable = true
      else if (r.message !== undefined) messages.push(r.message)
      if (r.consumedNext) j++
    } else if (
      a === "-F" ||
      a === "--file" ||
      a === "-t" ||
      a === "--template" ||
      a === "-e" ||
      a === "--edit"
    ) {
      uninspectable = true
    }
  }
  return { messages, uninspectable }
}

/**
 * The stateful landing-gate capability `setup.ts` hands to {@link ToolPolicy.guardLanding}
 * so the stateful ledger never crosses into the pure tool-policy boundary. The
 * stateful side (`landingBlocks`, `hasReviewApprove`) lives only in `setup.ts`;
 * tool-policy mutates it exclusively through `recordBlock`/`escalate`.
 */
export interface LandingGateCapability {
  /** True when the task already carries a reviewer `VERDICT: APPROVE` (release signal). */
  hasApproval(): boolean
  /**
   * True when the session journaled a credited reviewer APPROVE — the
   * bucket-free credit that a prompt reset drops the `hasReviewApprove` flag
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
 * The stateful hands-on-gate capability `setup.ts` hands to
 * {@link ToolPolicy.guardHandsOn} (mirrors LandingGateCapability): the
 * stateful side (`handsOnBlocks`, `handsOnRelease`, the waiver read, the
 * pending-hands-on-ask latch) lives only in the hook layer; tool-policy
 * mutates it exclusively through `recordBlock`/`escalate`.
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
 * The stateful capability for the bash write gate
 * ({@link ToolPolicy.guardBashWrite}): the hands-on capability plus the
 * once-grant consume, which only the bash arm runs (the write/edit gate's
 * grant is consumed in the hook layer). Extending without altering keeps
 * existing {@link HandsOnGateCapability} fakes and tests untouched.
 */
export interface BashWriteGateCapability extends HandsOnGateCapability {
  /** Consumes the pending `.handsOn` once-grant; true when one was pending. */
  consumeGrant(): boolean
}

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
   * approval branches on `config.escalation`: under `"ask"` it journals
   * `{type:"permission", action:"ask", reason:"landing"}` and calls
   * `gate.escalate()` (arming the pending-landing-ask latch; a within-window
   * duplicate arm journals no second ask row), and `execute.before` then
   * passes so the setup-side evaluate handler forces the human ask naming the
   * missing reviewer verdict; under `"block"` (the default) the repeat
   * attempt takes the block path again — no ask, no latch. Fail-toward-strict:
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
   * A repeat attempt (`priorBlocks() >= 1`) branches on `config.escalation`:
   * under `"ask"` it journals
   * `{type:"permission", action:"ask", reason:"hands-on"}` and calls
   * `gate.escalate()` (arming the pending-hands-on-ask latch; a within-window
   * duplicate arm journals no second ask row); `execute.before` then passes
   * so the evaluate handler forces the human ask naming the hands-on
   * requirement; under `"block"` (the default) the repeat attempt takes the
   * block path again — no ask, no latch. Under `"block"` the reply-granted
   * release paths (`handsOnRelease`, the hands-on once-grant) stay naturally
   * inert: they are granted only from replies to asks the plugin raised, and
   * `"block"` raises none (a release granted in a prior `"ask"` session
   * within the same ledger bucket still releases). Plan approval never
   * releases this gate.
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
 * is a cached `RegExp.test`.
 * @param config The resolved plugin configuration.
 * @param journaler The telemetry writer for blocked and error entries.
 * @returns The stateless tool-call policy.
 */
export function createToolPolicy(config: TurnstileConfig, journaler: Journaler): ToolPolicy {
  /**
   * Compiles a denylist, dropping and journaling any non-compiling source.
   * A drop is journaled as a persistent `{type:"error"}` so a typed rule that
   * weakens the denylist is recorded for the operator, never silent.
   * @param name Which list is compiled (`"bashDeny"` or `"pathDeny"`).
   * @param sources The regex sources to compile.
   * @returns The compilable rules, each paired with its source index.
   */
  function compile(name: "bashDeny" | "pathDeny", sources: string[]): CompiledRule[] {
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

  const bashDeny = compile("bashDeny", config.toolPolicy.bashDeny)
  const pathDeny = compile("pathDeny", config.toolPolicy.pathDeny)

  // The commit-format matcher: `commitFormat` is a conventional-commits regex
  // SOURCE (no anchors); callers wrap it with `"^…$"` + the `"s"` flag so `.`
  // spans the optional body line. The default (a validated conventional-commit
  // source) is the fall-back when the configured source does not compile —
  // `mergeConfig` already drops invalid sources, so this is a defensive
  // re-check, but it is journaled (never silent) if a source slips through.
  const commitFormat = (() => {
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
  })()
  // The landing candidate matchers. `isPushLanding` is the single source of
  // truth for `git push` candidates (shared with guardLanding and the
  // evaluate-handler arm); `ghPrRe` additionally covers `gh pr ready` for
  // telemetry only, since a `gh pr create|merge` deny is a configured
  // `bashDeny` rule that fires before observeLanding ever runs (with the empty
  // default that deny is configured-only).
  const ghPrRe = new RegExp("\\bgh\\s+pr\\s+(create|ready|merge)\\b")

  /**
   * Journals a denylist block and hands control back to the caller, which
   * throws. Fail-open: an internal error is journaled and the guard returns
   * without throwing.
   * @param tool The tool name, recorded in the journal entry.
   * @param rule The matching rule.
   * @param sessionID The session ID, recorded in journal entries.
   */
  function journalBlocked(tool: string, rule: CompiledRule, sessionID: string): void {
    journaler.journal({
      type: "blocked",
      sessionID,
      tool,
      reason: "tool-policy",
      rule: rule.index,
    })
    journaler.traceEvent("tool-policy", "blocked", `${tool} rule ${rule.index}`, sessionID)
  }

  // Given one simple command's words, return its `git commit` analysis: the
  // extracted `-m` messages and whether the invocation is uninspectable
  // (`-F`/`-t`/`--edit`/`-e` present, or a bundled cluster carrying an
  // editor/template flag). Returns null when `words` is not a `git commit`
  // invocation — so `git commit-graph` (subcommand `commit-graph`) and
  // `echo git commit` (command `echo`) never match.
  function analyzeCommit(words: string[]): { messages: string[]; uninspectable: boolean } | null {
    const inv = gitInvocation(words)
    if (inv === null || inv.verb !== "commit") return null
    return parseCommitArgs(words.slice(inv.index + 1))
  }

  // --- Block-throw journal helpers -------------------------------------------
  // Journals a commit-lint block; the caller throws. The offending text rides
  // the `BlockError` (host-facing); the journal records only the reason,
  // mirroring the denylist's minimal journal.
  function journalCommitBlock(tool: string, sessionID: string, reason: string): void {
    journalGateBlock(tool, sessionID, reason)
  }

  // Journals a landing `no-landing-approval` block; the caller throws.
  function journalLandingBlock(tool: string, sessionID: string): void {
    journalGateBlock(tool, sessionID, "no-landing-approval")
  }

  /**
   * Journals a gate block — one source for the landing, commit-lint, and
   * hands-on block entries, so the three ladders cannot drift in entry shape.
   * @param tool The tool name, recorded in the journal entry.
   * @param sessionID The session ID, recorded in journal entries.
   * @param reason The gate-specific block reason string.
   */
  function journalGateBlock(tool: string, sessionID: string, reason: string): void {
    journaler.journal({ type: "blocked", sessionID, tool, reason })
    journaler.traceEvent("tool-policy", "blocked", `${tool} ${reason}`, sessionID)
  }

  // Journals a hands-on `parent-hands-on` block; the caller throws.
  function journalHandsOnBlock(tool: string, sessionID: string): void {
    journalGateBlock(tool, sessionID, "parent-hands-on")
  }

  /**
   * Guards a bash/shell command: fails open on an empty command (misconfiguration
   * telemetry), yields on a non-match, and journals + throws a match.
   * @param tool The tool name, recorded in the journal entry.
   * @param command The raw command value from the host payload.
   * @param sessionID The session ID, recorded in journal entries.
   * @throws Error with a `BLOCKED by turnstile:` prefix when a rule matches.
   */
  function guardBash(tool: "bash" | "shell", command: unknown, sessionID: string): void {
    try {
      const text = typeof command === "string" ? command : ""
      if (text.length === 0) {
        journaler.journal({
          type: "error",
          sessionID,
          error:
            "execute.before: bash/shell carried no command; does the host input shape still use command or cmd?",
        })
        return
      }
      const rule = bashDeny.find((r) => r.re.test(text))
      if (!rule) return
      journalBlocked(tool, rule, sessionID)
      throw new BlockError(
        `BLOCKED by turnstile: ${tool} blocked by policy rule ${rule.index}: ${rule.source}`,
      )
    } catch (e) {
      if (e instanceof BlockError) throw e
      journaler.journal({ type: "error", error: `tool policy guard: ${e}` })
    }
  }

  /**
   * Guards a write/edit target path: same shape as {@link guardBash} but matched
   * against `pathDeny` (empty by default, so ordinary editing is never blocked
   * until a user configures `pathDeny`).
   * @param tool The tool name, recorded in the journal entry.
   * @param filePath The raw target-path value from the host payload.
   * @param sessionID The session ID, recorded in journal entries.
   * @throws Error with a `BLOCKED by turnstile:` prefix when a rule matches.
   */
  function guardPath(tool: "write" | "edit", filePath: unknown, sessionID: string): void {
    try {
      const text = typeof filePath === "string" ? filePath : ""
      if (text.length === 0) {
        journaler.journal({
          type: "error",
          sessionID,
          error:
            "execute.before: write/edit carried no target path; does the host input shape still use filePath or path?",
        })
        return
      }
      const rule = pathDeny.find((r) => r.re.test(text))
      if (!rule) return
      journalBlocked(tool, rule, sessionID)
      throw new BlockError(
        `BLOCKED by turnstile: ${tool} blocked by policy rule ${rule.index}: ${rule.source}`,
      )
    } catch (e) {
      if (e instanceof BlockError) throw e
      journaler.journal({ type: "error", error: `tool policy guard: ${e}` })
    }
  }

  /**
   * Journals a `session_move` dispatch as telemetry only; never blocks. No-op
   * when `observeSessionMove` is false. Called by two channels: the
   * `session_move` tool hook, and the project-directory resolver when it
   * replaces a session's cached directory with a different one (a move the
   * tool hook did not witness); the resolver passes `origin` so its entry
   * carries `reason` and the enforced project switch is observable.
   * @param sessionID The session ID, recorded in the journal entry.
   * @param directory The move target directory from the host payload or the resolver.
   * @param origin The telemetry channel label, recorded as `reason` when provided.
   */
  function observeSessionMove(sessionID: string, directory: unknown, origin?: "re-resolved"): void {
    if (!config.toolPolicy.observeSessionMove) return
    journaler.journal({
      type: "tool",
      sessionID,
      tool: "session_move",
      directory: config.trace ? String(directory ?? "").slice(0, 200) : "<redacted>",
      ...(origin ? { reason: origin } : {}),
    })
  }

  /**
   * Lints `git commit` messages as conventional commits. Extracts the `git
   * commit` invocations (via the shell-aware tokenizer above, so substrings and
   * `git commit-graph` are never matched), validates each `-m` argument against
   * the compiled `commitFormat`, and fail-closes on uninspectable forms
   * (`-F`/`-t`/`--edit`/`-e`, or a bare interactive commit with no `-m`).
   * @param tool The tool name, recorded in the journal.
   * @param command The raw command value from the host payload (`unknown`).
   * @param sessionID The session ID, recorded in journal entries.
   * @throws Error with a `BLOCKED by turnstile:` prefix when the lint rejects.
   */
  function guardCommitMessage(tool: "bash" | "shell", command: unknown, sessionID: string): void {
    try {
      if (!config.gitGates.commitMessages) return
      const text = typeof command === "string" ? command : ""
      if (text.length === 0) {
        journaler.journal({
          type: "error",
          sessionID,
          error:
            "execute.before: git commit lint carried no command; does the host input shape still use command or cmd?",
        })
        return
      }
      for (const simple of splitCommands(text)) {
        const analysis = analyzeCommit(tokenizeWords(simple))
        if (analysis === null) continue
        // Uninspectable (an -F/-t/--edit/-e flag, or a bare interactive commit
        // with no -m): the operator cannot see the subject, so fail-closed —
        // treat it as non-conventional.
        if (analysis.uninspectable || analysis.messages.length === 0) {
          journalCommitBlock(tool, sessionID, "commit-message-uninspectable")
          throw new BlockError(
            `BLOCKED by turnstile: commit message could not be inspected — pass it with 'git commit -m <subject>' (-F/-t/--edit/-e are not inspectable)`,
          )
          // The `throw` exits the guard; later simple commands in this string
          // are not linted (the first failure is the one surfaced).
        }
        for (const message of analysis.messages) {
          if (!commitFormat.test(message)) {
            const subject = message.slice(0, 80)
            journalCommitBlock(tool, sessionID, "invalid-commit-message")
            throw new BlockError(
              `BLOCKED by turnstile: commit message '${subject}' ${COMMIT_EXPECTED}`,
            )
          }
        }
      }
    } catch (e) {
      if (e instanceof BlockError) throw e
      journaler.journal({ type: "error", error: `tool policy guard: ${e}` })
    }
  }

  /**
   * Journals landing telemetry (`{type:"tool", tool:"bash", landing:true}`) for
   * `git push` / `gh pr create|ready|merge` candidates — in every mode, and
   * never blocking. `gh pr` telemetry is disjoint from a configured
   * `bashDeny` deny of `gh pr create|merge` (with the empty default that deny
   * fires only when configured; when it is configured, `guardBash` fires first
   * and the two journal reasons stay disjoint).
   * @param sessionID The session ID, recorded in the journal entry.
   * @param command The raw command value from the host payload (`unknown`).
   */
  function observeLanding(sessionID: string, command: unknown): void {
    try {
      const text = typeof command === "string" ? command : ""
      if (text.length === 0) return
      if (isPushLanding(text) || ghPrRe.test(text)) {
        journaler.journal({ type: "tool", sessionID, tool: "bash", landing: true })
      }
    } catch (e) {
      journaler.journal({ type: "error", error: `tool policy guard: ${e}` })
    }
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
   * Shared guard ladder tail: under `escalation: "ask"` an armed attempt
   * journals the permission ask (only when `gate.escalate()` reports the
   * arm is not a within-window duplicate — dedupe collapses same-tick
   * re-arms into one ask row) and allows (the evaluate handler forces the
   * human ask); under `escalation: "block"` (the default) or when the
   * escalate arm is deduped, the attempt takes the block path — journal,
   * record, then throw. Fail-toward-strict: a reject leaves the gate red
   * and the next attempt re-blocks. One source for the landing and
   * hands-on ladders so the two cannot drift.
   * @param t The parameterized ladder inputs (see {@link LadderTail}).
   */
  function guardLadderTail(t: LadderTail): void {
    if (t.armed && config.escalation === "ask" && t.gate.escalate()) {
      journaler.journal({
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
   * @param tool The tool name, recorded in journal entries.
   * @param sessionID The session ID, recorded in journal entries.
   * @param gate The hands-on capability from the caller's gate.
   */
  function handsOnTail(tool: string, sessionID: string, gate: HandsOnGateCapability): void {
    guardLadderTail({
      armed: gate.priorBlocks() >= 1,
      tool,
      sessionID,
      reason: "hands-on",
      gate,
      journalBlock: journalHandsOnBlock,
      requirement: HANDSON_REQUIREMENT,
      blockCause: "hands-on",
    })
  }

  /**
   * Guards a parent-session `write`/`edit` target path. `gate` is the
   * stateful capability from the hook layer (registered pipeline children
   * never reach it — the caller's dispatch skip owns the parent-only
   * contract). A live release or an executor-scoped waiver allows silently;
   * otherwise the shared ladder tail runs (see {@link guardHandsOn}'s
   * interface doc). An empty/absent path journals the misconfiguration and
   * allows (fail-open telemetry).
   * @param tool The tool name, recorded in the journal.
   * @param filePath The raw target-path value from the host payload.
   * @param sessionID The session ID, recorded in journal entries.
   * @param gate The hands-on-gate capability supplied by the hook layer.
   * @throws Error with a `BLOCKED by turnstile:` prefix when the gate blocks.
   */
  function guardHandsOn(
    tool: "write" | "edit",
    filePath: unknown,
    sessionID: string,
    gate: HandsOnGateCapability,
  ): void {
    try {
      const text = typeof filePath === "string" ? filePath : ""
      if (text.length === 0) {
        journaler.journal({
          type: "error",
          sessionID,
          error:
            "execute.before: hands-on gate carried no target path; does the host input shape still use filePath or path?",
        })
        return
      }
      if (gate.hasRelease() || gate.hasWaiver()) return
      handsOnTail(tool, sessionID, gate)
    } catch (e) {
      if (e instanceof BlockError) throw e
      journaler.journal({ type: "error", error: `tool policy guard: ${e}` })
    }
  }

  /**
   * Journals hands-on bash write telemetry (`{type:"tool", tool:"bash",
   * handsOn:true}`) for write-shaped commands — always, in every mode, for
   * every session (children included, like landing telemetry), and never
   * blocking. No-op for a non-write-shaped command.
   * @param sessionID The session ID, recorded in the journal entry.
   * @param command The raw command value from the host payload (`unknown`).
   * @param verdict The caller's write-shape verdict for the command.
   */
  function observeBashWrite(sessionID: string, command: unknown, verdict: BashWriteVerdict): void {
    try {
      if (verdict === "none") return
      journaler.journal({ type: "tool", sessionID, tool: "bash", handsOn: true })
    } catch (e) {
      journaler.journal({ type: "error", error: `tool policy guard: ${e}` })
    }
  }

  /**
   * Gates confident file-writing bash commands through the hands-on ladder
   * (see {@link ToolPolicy.guardBashWrite}). Ordering: the `bashWriteGate`
   * flag and the `verdict === "gate"` check come first, then the release /
   * waiver short-circuits, then the once-grant is consumed HERE (so a
   * disabled gate or a non-gate shape never burns a pending grant), then
   * the shared ladder tail.
   * @param tool The tool name, recorded in the journal.
   * @param command The raw command value from the host payload (`unknown`).
   * @param verdict The caller's write-shape verdict for the command.
   * @param sessionID The session ID, recorded in journal entries.
   * @param gate The bash-write-gate capability supplied by the hook layer.
   * @throws Error with a `BLOCKED by turnstile:` prefix when the gate blocks.
   */
  function guardBashWrite(
    tool: "bash" | "shell",
    command: unknown,
    verdict: BashWriteVerdict,
    sessionID: string,
    gate: BashWriteGateCapability,
  ): void {
    try {
      if (!config.toolPolicy.bashWriteGate || verdict !== "gate") return
      if (gate.hasRelease() || gate.hasWaiver()) return
      if (gate.consumeGrant()) return
      handsOnTail(tool, sessionID, gate)
    } catch (e) {
      if (e instanceof BlockError) throw e
      journaler.journal({ type: "error", error: `tool policy guard: ${e}` })
    }
  }

  /**
   * Gates a `git push` on a reviewer `VERDICT: APPROVE`. `gate` is the
   * stateful capability from `setup.ts`. With approval: allow, no journal noise
   * beyond telemetry. Without, the first block journals
   * `no-landing-approval` and throws — unless the session already carries a
   * credited reviewer APPROVE that a prompt reset dropped, in which case even
   * the first attempt is the human decision point: it journals a `permission`
   * ask and signals escalation, allowing `execute.before` to pass so the
   * evaluate handler forces the ask. A repeat attempt escalates the same way.
   * With `gitGates.emptyDiffExempt` (default true; `false` is the strict
   * opt-out), a push the capability proves statically empty against upstream is
   * journaled `exempt:"empty-diff"` and allowed; every ambiguous shape falls
   * through to the ladder — fail-toward-strict.
   * @param tool The tool name, recorded in the journal.
   * @param command The raw command value from the host payload (`unknown`).
   * @param sessionID The session ID, recorded in journal entries.
   * @param gate The landing-gate capability supplied by `setup.ts`.
   * @throws Error with a `BLOCKED by turnstile:` prefix when the gate blocks.
   */
  function guardLanding(
    tool: "bash" | "shell",
    command: unknown,
    sessionID: string,
    gate: LandingGateCapability,
  ): void {
    try {
      if (!config.gitGates.landingGate) return
      const text = typeof command === "string" ? command : ""
      if (text.length === 0) {
        journaler.journal({
          type: "error",
          sessionID,
          error:
            "execute.before: landing gate carried no command; does the host input shape still use command or cmd?",
        })
        return
      }
      if (!isPushLanding(text)) return
      // Approval releases the gate: allow, no journal noise beyond telemetry.
      if (gate.hasApproval()) return
      // Empty-diff exemption: a push the capability proves statically
      // empty against its upstream is journaled and allowed. The probe is
      // total (every ambiguous shape is false), so this clause can only
      // release pushes the git state proves to land nothing.
      if (config.gitGates.emptyDiffExempt && gate.isEmptyDiff(text)) {
        journaler.journal({ type: "tool", sessionID, tool, landing: true, exempt: "empty-diff" })
        return
      }
      // A journaled credit escalates the first attempt too: the prompt reset
      // dropped the `hasReviewApprove` flag, but the session still carries a
      // non-refused reviewer APPROVE, so the human decides this first push
      // rather than one wasted `no-landing-approval` block earlier.
      guardLadderTail({
        armed: gate.priorBlocks() >= 1 || gate.hasCreditedApproval(),
        tool,
        sessionID,
        reason: "landing",
        gate,
        journalBlock: journalLandingBlock,
        requirement: LANDING_REQUIREMENT,
      })
    } catch (e) {
      if (e instanceof BlockError) throw e
      journaler.journal({ type: "error", error: `tool policy guard: ${e}` })
    }
  }

  return {
    guardBash,
    guardPath,
    observeSessionMove,
    guardCommitMessage,
    observeLanding,
    guardLanding,
    guardHandsOn,
    observeBashWrite,
    guardBashWrite,
  }
}
