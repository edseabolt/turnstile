/**
 * @fileoverview Tool-call policy boundary: stateless denylist matching for the
 * tools that flow through `execute.before` — bash/shell commands
 * (`guardBash`) and write/edit target paths (`guardPath`) — plus non-blocking
 * `session_move` telemetry (`observeSessionMove`). The denylist regex sources
 * compile once at creation; the hot path is a cached `RegExp.test`. A match
 * throws the same `BlockError` the gate layer throws (the hook rethrows it),
 * and every internal failure fails open (journaled, never thrown).
 *
 * First-match wins: the lowest-indexed matching rule is the one recorded and
 * blocked. A source that fails to compile is dropped (defensively re-checked
 * here even though `mergeConfig` drops it first) and journaled as a persistent
 * `{type:"error"}`, so a config typo that weakens the denylist is never silent.
 * See the `src/types.ts` `TurnstileToolPolicy` contract for the config shape.
 */

import { BlockError } from "./gates.ts"
import type { Journaler } from "./journal.ts"
import type { TurnstileConfig } from "./types.ts"

/** One compiled denylist rule, paired with its source index for the journal. */
interface CompiledRule {
  re: RegExp
  index: number
  source: string
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

  return { guardBash, guardPath, observeSessionMove }
}
