/**
 * @fileoverview Fingerprint boundary: the worktree/branch identity a task was
 * admitted against, and the pure predicate deciding whether a continuation
 * prompt (an unchanged identity) carries the restart-sticky gate flags across
 * a prompt reset instead of wiping them. Both exports are total: they never
 * throw.
 */

import { execFileSync } from "node:child_process"
import type { StdioOptions } from "node:child_process"
import * as path from "node:path"

import type { GateState } from "./types.ts"

/**
 * The child_process options shared by both rev-parse calls: bound the hang
 * mode and silence git's stdio so a stuck or noisy binary can never stall or
 * block the hook.
 */
const GIT_EXEC_OPTS: ExecOptions = { timeout: 1000, stdio: ["ignore", "pipe", "ignore"] }

/**
 * The command-execution seam: a `child_process.execFileSync`-shaped function.
 * Defaulted to `realExec` at the call site and overridable in tests, so the
 * fallback branch is coverable without mocking `child_process` (mirroring the
 * optional-argument injectability of setup.ts's `readPluginVersion`).
 */
type ExecFile = (command: string, args: ReadonlyArray<string>, options?: ExecOptions) => string

/**
 * The executable-options shape for the seam; a structural subset of
 * child_process's `ExecFileSyncOptions` (only `timeout`/`stdio` are needed).
 */
type ExecOptions = { timeout?: number; stdio?: StdioOptions }

/**
 * Runs a command and returns its stdout as text. A defensive `String` wraps
 * execFileSync's `string | Buffer` return so the seam's return type stays
 * `string` regardless of which execFileSync overload resolves.
 * @param command The command to run.
 * @param args The argv array.
 * @param options Optional child_process options.
 * @returns The command's stdout as a string.
 */
function realExec(command: string, args: ReadonlyArray<string>, options?: ExecOptions): string {
  return String(execFileSync(command, args, options))
}

/**
 * Builds the two `git rev-parse` argvs `worktreeFingerprint` runs to read the
 * worktree root and the short branch name. The `-C <dir>` prefix is built once
 * here rather than duplicated at each call site.
 * @param projectDir The absolute project directory to run against.
 * @returns The `--show-toplevel` argv followed by the `--abbrev-ref HEAD` argv.
 */
function gitRevParseArgvs(projectDir: string): [string[], string[]] {
  return [
    ["-C", projectDir, "rev-parse", "--show-toplevel"],
    ["-C", projectDir, "rev-parse", "--abbrev-ref", "HEAD"],
  ]
}

/**
 * Returns a stable identity for the worktree/branch a task was admitted
 * against. Runs `git rev-parse --show-toplevel` then `--abbrev-ref HEAD` and
 * joins the two trimmed outputs with a NUL separator; both outputs are
 * non-empty for a real worktree, so the identity is well-formed. On any
 * failure (a non-git directory, no git binary, the timeout, or an injected
 * throw) it returns `path.resolve(projectDir)`, so continuation still works
 * inside any stable directory. This is the only continuation-vs-new-task
 * signal, so it must not throw.
 * @param projectDir The project directory to fingerprint.
 * @param exec Optional exec seam; defaults to `realExec` (the real
 *     `execFileSync`). Tests inject a throw to cover the fallback branch
 *     without mocking the binary.
 * @returns `` `${show-toplevel}\u0000${abbrev-ref HEAD}` `` for a git worktree,
 *     otherwise the resolved project directory.
 */
export function worktreeFingerprint(projectDir: string, exec: ExecFile = realExec): string {
  try {
    const argvs = gitRevParseArgvs(projectDir)
    const top = exec("git", argvs[0], GIT_EXEC_OPTS).trim()
    const branch = exec("git", argvs[1], GIT_EXEC_OPTS).trim()
    return `${top}\u0000${branch}`
  } catch {
    return path.resolve(projectDir)
  }
}

/**
 * Pure predicate deciding whether a continuation prompt carries the current
 * task's restart-sticky gate flags across a prompt reset. The carry is
 * GATE-SCOPED by design: it is a no-op unless a gate flag was actually earned
 * (`hasGatePass`), so a continuation arriving before any `GATE: PASS` resets
 * fully rather than carrying a freshly-earned-but-empty flag. Only
 * `taskFingerprint` distinguishes a same-branch continuation from a genuinely
 * new task, so a fingerprint mismatch never carries.
 * @param prior The prior prompt's gate state; `undefined` before any prompt.
 * @param fingerprint The worktree/branch identity the task was re-admitted
 *     against.
 * @param enabled The `continuationCarry` config flag, passed through so the
 *     predicate stays unit-testable without a real config.
 * @returns True only when carry is enabled, a gate flag was earned, and the
 *     task was admitted again in the exact same worktree/branch.
 */
export function shouldCarryGate(
  prior: GateState | undefined,
  fingerprint: string,
  enabled: boolean,
): boolean {
  return (
    enabled &&
    prior !== undefined &&
    prior.hasGatePass &&
    prior.taskFingerprint !== "" &&
    prior.taskFingerprint === fingerprint
  )
}
