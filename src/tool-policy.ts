/**
 * @fileoverview Tool-call policy boundary: stateless matching for the tools
 * that flow through `execute.before` — bash/shell commands (`guardBash`,
 * `guardCommitMessage`, `observeLanding`, `guardLanding`) and write/edit target
 * paths (`guardPath`) — plus non-blocking `session_move` telemetry
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

/** One compiled denylist rule, paired with its source index for the journal. */
interface CompiledRule {
  re: RegExp
  index: number
  source: string
}

// Matches a `git push` invocation (with optional global options) — the landing
// gate's enforcement target. Exported so `setup.ts` can arm the evaluate-handler
// ask against the exact same candidate set the guard enforces (single source of
// truth; no duplicate-regex drift).
const pushRe = new RegExp("\\bgit\\b[^;&|]*?\\bpush\\b")

/**
 * True when `command` invokes a `git push` — the landing gate's enforcement
 * target, tolerating global options such as `-C dir` between `git` and `push`.
 * @param command The raw bash/shell command string.
 * @returns True for a `git push` candidate.
 */
export function isPushLanding(command: string): boolean {
  return pushRe.test(command)
}

/**
 * Core landing-gate text shared by the enforce-path throw and the human ask
 * message, so the two never drift. Stamped after `BLOCKED by turnstile:` (or
 * as the bare ask body by the evaluate handler).
 */
const LANDING_REQUIREMENT =
  "push/PR requires a reviewer VERDICT: APPROVE before landing — wait for the reviewer or escalate to the user"

/**
 * Suffix added to the invalid-commit-block ask, describing the accepted shape.
 * @returns The "expected …" suffix.
 */
const COMMIT_EXPECTED = "is not a conventional commit — expected type(scope)!: subject"

/**
 * The stateful landing-gate capability `setup.ts` hands to {@link ToolPolicy.guardLanding}
 * so the stateful ledger never crosses into the pure tool-policy boundary. The
 * stateful side (`landingBlocks`, `hasReviewApprove`) lives only in `setup.ts`;
 * tool-policy mutates it exclusively through `recordBlock`/`escalate`.
 */
export interface LandingGateCapability {
  /** True when the task already carries a reviewer `VERDICT: APPROVE` (release signal). */
  hasApproval(): boolean
  /** Count of `no-landing-approval` blocks recorded this task. */
  priorBlocks(): number
  /** Increment {@link LandingGateCapability.priorBlocks} (block path only). */
  recordBlock(): void
  /** Signal the setup-side permission wiring to arm the human ask (repeat attempt). */
  escalate(): void
}

/**
 * The stateless tool-call policy bound to one resolved config + journaler.
 * Every guard fails open on an internal error; only a deliberate block throws.
 */
export interface ToolPolicy {
  /**
   * Yields on allow; journals and throws (`BlockError`) under `enforce`, or
   * journals only under `shadow`, when `command` matches a `bashDeny` rule;
   * journals `{type:"error"}` and allows on an empty/absent command; no-op
   * under `off`.
   *
   * The `command` argument is the host payload value coerced by `setup.ts` via
   * `event.input?.command ?? event.input?.cmd` — those two keys are the
   * documented candidates; if the host reshapes the payload the empty-command
   * path journals the misconfiguration so the change is observable rather than
   * silently allowed.
   * @param tool The tool name, recorded in the journal (`"bash"` or `"shell"`).
   * @param command The raw command value from the host payload (typed `unknown`).
   * @param sessionID The session ID, recorded in journal entries.
   * @throws Error with a `BLOCKED by turnstile:` prefix under `enforce` only.
   */
  guardBash(tool: "bash" | "shell", command: unknown, sessionID: string): void
  /**
   * Yields on allow; journals and throws (`BlockError`) under `enforce`, or
   * journals only under `shadow`, when `filePath` matches a `pathDeny` rule;
   * journals `{type:"error"}` and allows on an empty/absent path; no-op under
   * `off`.
   *
   * The `filePath` argument is the host payload value coerced by `setup.ts` via
   * `event.input?.filePath ?? event.input?.path` — those two keys are the
   * documented candidates; if the host reshapes the payload the empty-path path
   * journals the misconfiguration so the change is observable.
   * @param tool The tool name, recorded in the journal (`"write"` or `"edit"`).
   * @param filePath The raw target-path value from the host payload (`unknown`).
   * @param sessionID The session ID, recorded in journal entries.
   * @throws Error with a `BLOCKED by turnstile:` prefix under `enforce` only.
   */
  guardPath(tool: "write" | "edit", filePath: unknown, sessionID: string): void
  /**
   * Journals a `session_move` dispatch as telemetry; never blocks. Only writes
   * when `toolPolicy.observeSessionMove` is true. The directory is recorded only
   * when the trace is enabled (the same redaction gating `bash` commands).
   * @param sessionID The session ID, recorded in the journal entry.
   * @param directory The move target directory from the host payload (`unknown`).
   */
  observeSessionMove(sessionID: string, directory: unknown): void
  /**
   * Lints `git commit` messages as conventional commits under `gitGates.commitMessages`.
   * Extracts `git commit` invocations (not substrings such as `git commit-graph`
   * or `echo git commit`), validates each `-m` argument against the compiled
   * `commitFormat`, and for uninspectable forms (`-F`/`-t`/`--edit`/`-e` or a
   * bare interactive commit) fail-closes: journals `{type:"blocked",
   * reason:"commit-message-uninspectable"}` and throws (`BlockError`) under
   * `enforce`, journals only under `shadow`, no-op under `off`. A `-m` message
   * that fails to match journals `{type:"blocked", reason:"invalid-commit-message"}`
   * the same way. Every internal failure fails open.
   * @param tool The tool name, recorded in the journal (`"bash"` or `"shell"`).
   * @param command The raw command value from the host payload (`unknown`).
   * @param sessionID The session ID, recorded in journal entries.
   * @throws Error with a `BLOCKED by turnstile:` prefix under `enforce` only.
   */
  guardCommitMessage(tool: "bash" | "shell", command: unknown, sessionID: string): void
  /**
   * Journals `{type:"tool", tool:"bash", landing:true}` telemetry for
   * `git push` / `gh pr create|ready|merge` candidates — in every mode
   * (non-blocking). Never touches `gitGates.mode`: a landing deny comes from
   * `guardLanding`, and `gh pr` is denied wholesale by the `bashDeny` rule
   * before this runs. Fail-open on an internal error.
   * @param sessionID The session ID, recorded in the journal entry.
   * @param command The raw command value from the host payload (`unknown`).
   */
  observeLanding(sessionID: string, command: unknown): void
  /**
   * Gates a `git push` on a reviewer `VERDICT: APPROVE` under `gitGates.landingGate`.
   * `gate` is the stateful capability from `setup.ts`. With approval: allow,
   * no journal noise. Without approval, first block this task: journal
   * `{type:"blocked", reason:"no-landing-approval"}`, call `gate.recordBlock()`,
   * and throw (`BlockError`) under `enforce`, journal-only under `shadow`,
   * no-op under `off`. A repeat attempt (`priorBlocks() >= 1`) without approval
   * under `enforce` journals `{type:"permission", action:"ask", reason:"landing"}`
   * and calls `gate.escalate()` (allowing `execute.before` to pass so the
   * setup-side evaluate handler forces the human ask); `shadow` journals only,
   * `off` is a no-op. Fail-open on an internal error.
   * @param tool The tool name, recorded in the journal.
   * @param command The raw command value from the host payload (`unknown`).
   * @param sessionID The session ID, recorded in journal entries.
   * @param gate The landing-gate capability supplied by `setup.ts`.
   * @throws Error with a `BLOCKED by turnstile:` prefix under `enforce` only.
   */
  guardLanding(
    tool: "bash" | "shell",
    command: unknown,
    sessionID: string,
    gate: LandingGateCapability,
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
  const mode = config.toolPolicy.mode
  const gateMode = config.gitGates.mode

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
  // The landing candidate matchers (compiled once). `pushRe` gates a `git push`
  // on a reviewer verdict (guardLanding); `ghPrRe` additionally covers `gh pr
  // ready` for telemetry only, since `gh pr create|merge` is denied by the
  // bashDeny rule before observeLanding ever runs. Both use the same
  // global-option-tolerant base as bashDeny so a `git [opts] push` still matches.
  const ghPrRe = new RegExp("\\bgh\\s+pr\\s+(create|ready|merge)\\b")

  /**
   * Journals a block (identical under every mode save the stamped `mode`) and
   * returns true when the caller must throw (`enforce`). Fail-open: an internal
   * error is journaled and the guard returns without throwing.
   * @param tool The tool name, recorded in the journal entry.
   * @param rule The matching rule.
   * @param sessionID The session ID, recorded in journal entries.
   */
  function journalBlocked(tool: string, rule: CompiledRule, sessionID: string): boolean {
    journaler.journal({
      type: "blocked",
      sessionID,
      tool,
      reason: "tool-policy",
      rule: rule.index,
      mode,
    })
    journaler.traceEvent("tool-policy", "blocked", `${tool} rule ${rule.index}`, sessionID)
    return mode === "enforce"
  }

  // --- Commit-lint analysis (pure) ------------------------------------------
  // Split a command into simple commands on top-level shell separators
  // (`;` `|` `&` `\r` `\n`), quote- and backslash-aware, so `git commit` inside
  // `&&`/`||`/`;` spans is parsed in isolation and a quoted `echo "git commit"`
  // stays on one side of a separator (never parsed as a commit invocation).
  // Quotes are preserved on both sides here so each emitted simple command is
  // balanced; `tokenizeWords` strips them and relies on that balance to keep a
  // quoted space together (`-m "feat: ok"` must not split into `feat:` / `ok`).
  function splitCommands(command: string): string[] {
    const out: string[] = []
    let cur = ""
    let quote = ""
    for (const ch of command) {
      if (quote) {
        if (ch === quote) quote = ""
        cur += ch
        continue
      }
      if (ch === '"' || ch === "'") {
        quote = ch
        cur += ch
        continue
      }
      if (ch === ";" || ch === "|" || ch === "&" || ch === "\r" || ch === "\n") {
        out.push(cur)
        cur = ""
        continue
      }
      cur += ch
    }
    out.push(cur)
    return out
  }

  // Tokenize one simple command into quoted-aware words, stripping the quotes
  // so a `-m "feat: x"` word yields the bare message `feat: x`.
  function tokenizeWords(input: string): string[] {
    const words: string[] = []
    let cur = ""
    let quote = ""
    for (const ch of input) {
      if (quote) {
        if (ch === quote) quote = ""
        else cur += ch
        continue
      }
      if (ch === '"' || ch === "'") {
        quote = ch
        continue
      }
      if (/\s/.test(ch)) {
        if (cur) words.push(cur)
        cur = ""
        continue
      }
      cur += ch
    }
    if (cur) words.push(cur)
    return words
  }

  // Given one simple command's words, return its `git commit` analysis: the
  // extracted `-m` messages and whether the invocation is uninspectable
  // (`-F`/`-t`/`--edit`/`-e` present). Returns null when `words` is not a
  // `git commit` invocation — so `git commit-graph` (subcommand `commit-graph`)
  // and `echo git commit` (command `echo`) never match.
  function analyzeCommit(words: string[]): { messages: string[]; uninspectable: boolean } | null {
    if (words[0] !== "git") return null
    const commitIdx = words.indexOf("commit", 1)
    if (commitIdx === -1) return null
    const args = words.slice(commitIdx + 1)
    let uninspectable = false
    const messages: string[] = []
    // `-F`/`-t` values fall through to the catch-all (never a message).
    for (const [j, a] of args.entries()) {
      if (a === "-m" || a === "--message") {
        const next = args[j + 1]
        if (next !== undefined) messages.push(next)
        else uninspectable = true
      } else if (a.startsWith("--message=")) {
        messages.push(a.slice("--message=".length))
      } else if (a.startsWith("-m")) {
        messages.push(a.slice(2))
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

  // --- Block-throw journal helpers -------------------------------------------
  // Journals a commit-lint block and returns true when the caller must throw
  // (`enforce`). The offending text rides the `BlockError` (host-facing); the
  // journal records only the reason, mirroring the denylist's minimal journal.
  function journalCommitBlock(tool: string, sessionID: string, reason: string): boolean {
    journaler.journal({ type: "blocked", sessionID, tool, reason, mode: gateMode })
    journaler.traceEvent("tool-policy", "blocked", `${tool} ${reason}`, sessionID)
    return gateMode === "enforce"
  }

  // Journals a landing `no-landing-approval` block and returns true when the
  // caller must throw (`enforce`).
  function journalLandingBlock(tool: string, sessionID: string): boolean {
    journaler.journal({
      type: "blocked",
      sessionID,
      tool,
      reason: "no-landing-approval",
      mode: gateMode,
    })
    journaler.traceEvent("tool-policy", "blocked", `${tool} no-landing-approval`, sessionID)
    return gateMode === "enforce"
  }

  /**
   * Guards a bash/shell command: fails open on an empty command (misconfiguration
   * telemetry), yields on a non-match, and blocks a match per `mode`.
   * @param tool The tool name, recorded in the journal entry.
   * @param command The raw command value from the host payload.
   * @param sessionID The session ID, recorded in journal entries.
   * @throws Error with a `BLOCKED by turnstile:` prefix under `enforce` only.
   */
  function guardBash(tool: "bash" | "shell", command: unknown, sessionID: string): void {
    try {
      if (mode === "off") return
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
      if (journalBlocked(tool, rule, sessionID)) {
        throw new BlockError(
          `BLOCKED by turnstile: ${tool} blocked by policy rule ${rule.index}: ${rule.source}`,
        )
      }
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
   * @throws Error with a `BLOCKED by turnstile:` prefix under `enforce` only.
   */
  function guardPath(tool: "write" | "edit", filePath: unknown, sessionID: string): void {
    try {
      if (mode === "off") return
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
      if (journalBlocked(tool, rule, sessionID)) {
        throw new BlockError(
          `BLOCKED by turnstile: ${tool} blocked by policy rule ${rule.index}: ${rule.source}`,
        )
      }
    } catch (e) {
      if (e instanceof BlockError) throw e
      journaler.journal({ type: "error", error: `tool policy guard: ${e}` })
    }
  }

  /**
   * Journals a `session_move` dispatch as telemetry only; never blocks. No-op
   * when `observeSessionMove` is false.
   * @param sessionID The session ID, recorded in the journal entry.
   * @param directory The move target directory from the host payload.
   */
  function observeSessionMove(sessionID: string, directory: unknown): void {
    if (!config.toolPolicy.observeSessionMove) return
    journaler.journal({
      type: "tool",
      sessionID,
      tool: "session_move",
      directory: config.trace ? String(directory ?? "").slice(0, 200) : "<redacted>",
    })
  }

  /**
   * Lints `git commit` messages as conventional commits. Extracts the `git
   * commit` invocations (via the shell-aware tokenizer above, so substrings and
   * `git commit-graph` are never matched), validates each `-m` argument against
   * the compiled `commitFormat`, and fail-closes on uninspectable forms
   * (`-F`/`-t`/`--edit`/`-e`, or a bare interactive commit with no `-m`).
   * Journal-only under `shadow`, no-op under `off`.
   * @param tool The tool name, recorded in the journal.
   * @param command The raw command value from the host payload (`unknown`).
   * @param sessionID The session ID, recorded in journal entries.
   * @throws Error with a `BLOCKED by turnstile:` prefix under `enforce` only.
   */
  function guardCommitMessage(tool: "bash" | "shell", command: unknown, sessionID: string): void {
    try {
      if (gateMode === "off" || !config.gitGates.commitMessages) return
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
        // treat it as non-conventional under enforce.
        if (analysis.uninspectable || analysis.messages.length === 0) {
          if (journalCommitBlock(tool, sessionID, "commit-message-uninspectable")) {
            throw new BlockError(
              `BLOCKED by turnstile: commit message could not be inspected — pass it with 'git commit -m <subject>' (—F/-t/--edit/-e are not inspectable)`,
            )
          }
          return
        }
        for (const message of analysis.messages) {
          if (!commitFormat.test(message)) {
            const subject = message.slice(0, 80)
            if (journalCommitBlock(tool, sessionID, "invalid-commit-message")) {
              throw new BlockError(
                `BLOCKED by turnstile: commit message '${subject}' ${COMMIT_EXPECTED}`,
              )
            }
            return
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
   * never blocking. `gh pr` telemetry is disjoint from the `bashDeny` deny that
   * handles `gh pr create|merge` (that deny fires in `guardBash` before this).
   * @param sessionID The session ID, recorded in the journal entry.
   * @param command The raw command value from the host payload (`unknown`).
   */
  function observeLanding(sessionID: string, command: unknown): void {
    try {
      const text = typeof command === "string" ? command : ""
      if (text.length === 0) return
      if (pushRe.test(text) || ghPrRe.test(text)) {
        journaler.journal({ type: "tool", sessionID, tool: "bash", landing: true })
      }
    } catch (e) {
      journaler.journal({ type: "error", error: `tool policy guard: ${e}` })
    }
  }

  /**
   * Gates a `git push` on a reviewer `VERDICT: APPROVE`. `gate` is the
   * stateful capability from `setup.ts`. With approval: allow, no journal noise
   * beyond telemetry. Without, the first block this task journals
   * `no-landing-approval` (and throws under `enforce`); a repeat attempt under
   * `enforce` journals a `permission` ask and signals escalation (allowing
   * `execute.before` to pass so the evaluate handler forces the human ask);
   * `shadow` journals only, `off` is a no-op.
   * @param tool The tool name, recorded in the journal.
   * @param command The raw command value from the host payload (`unknown`).
   * @param sessionID The session ID, recorded in journal entries.
   * @param gate The landing-gate capability supplied by `setup.ts`.
   * @throws Error with a `BLOCKED by turnstile:` prefix under `enforce` only.
   */
  function guardLanding(
    tool: "bash" | "shell",
    command: unknown,
    sessionID: string,
    gate: LandingGateCapability,
  ): void {
    try {
      if (gateMode === "off" || !config.gitGates.landingGate) return
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
      if (!pushRe.test(text)) return
      // Approval releases the gate: allow, no journal noise beyond telemetry.
      if (gate.hasApproval()) return
      const prior = gate.priorBlocks()
      if (prior >= 1) {
        // Repeat attempt without approval. Under enforce, arm the human ask (the
        // evaluate handler forces it off the same ledger state); allow
        // execute.before to pass so the permission surface fires. Fail-toward-
        // strict: a host reject leaves approval absent, so the next attempt
        // re-blocks. Under shadow, journal-only like the first block.
        if (gateMode === "enforce") {
          journaler.journal({
            type: "permission",
            sessionID,
            tool,
            action: "ask",
            reason: "landing",
            mode: gateMode,
          })
          gate.escalate()
          return
        }
        journalLandingBlock(tool, sessionID)
        gate.recordBlock()
        return
      }
      // First block this task: journal + record, then throw under enforce.
      const shouldThrow = journalLandingBlock(tool, sessionID)
      gate.recordBlock()
      if (shouldThrow) {
        throw new BlockError(`BLOCKED by turnstile: ${LANDING_REQUIREMENT}.`)
      }
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
  }
}
