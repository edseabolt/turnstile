/**
 * @fileoverview Empty-diff probe boundary: the static analysis and the
 * total, never-throwing git-side decision of whether a `git push` command is
 * *provably* a no-op against its upstream — every planned branch resolving to
 * the same commit as its upstream ref — the opt-in landing-gate
 * exemption (`gitGates.emptyDiffExempt`, default on; `false` is the strict
 * opt-out). `planPushRefs` stays pure text;
 * the git-side probes (current branch, remote/upstream, ref-hash equality) run
 * through a child_process seam exactly like `fingerprint.ts` (that module is
 * the prior seam occurrence; lifting it to a shared module is a follow-up,
 * not a third inline copy).
 *
 * Fail-toward-strict: every ambiguous shape (detached HEAD, unresolvable
 * remote/upstream, explicit commits or sha ranges, `--mirror`/`--tags`, any
 * force flag, any
 * non-whitelisted flag, more than two positionals) yields `null`/`false`,
 * so the caller keeps the gate. The enabled push's explicit remote wins when
 * given (upstream ref `<remote>/<branch>`); otherwise the branch's
 * configured upstream resolves via `@{upstream}`.
 */

import { execFileSync } from "node:child_process"
import type { StdioOptions } from "node:child_process"

import { gitInvocation, splitCommands, tokenizeWords } from "./tool-policy.ts"

/**
 * The child_process options shared by every probe call: bound the hang mode
 * and silence git's stdio so a stuck or noisy binary can never stall the hook
 * (same shape as `fingerprint.ts`'s `GIT_EXEC_OPTS`).
 */
const GIT_PROBE_OPTS: ExecOptions = { timeout: 1000, stdio: ["ignore", "pipe", "ignore"] }

/**
 * The command-execution seam: a `child_process.execFileSync`-shaped function,
 * defaulted to `realExec` at the call site and overridable in tests (mirrors
 * the seam in `fingerprint.ts`; a non-zero exit throws, like `execFileSync`).
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
 * A push shape the probe can resolve: an explicit remote token when the
 * command gives one, plus the branch names as given (a refspec's src or the
 * bare name); `branches` is empty only for a bare `git push` (the probe
 * resolves HEAD).
 */
export interface PushPlan {
  /** The explicit remote token, or `null` when resolution goes via `@{upstream}`. */
  remote: string | null
  /** The branch names as given; empty for a bare `git push`. */
  branches: string[]
}

// Value-free push flags that do not change which refs land. Force flags are
// deliberately absent: a force push of a branch at or behind its upstream
// would rewind the remote ref, so it must always gate. Any other flag-shaped
// token (`--mirror`, `--tags`, `-u`, `--force-with-lease`, `--repo=…`,
// value-taking or unknown — `--dry-run` deliberately included) makes the push
// statically unresolvable, so the probe gates.
const PUSH_FLAG_WHITELIST: ReadonlySet<string> = new Set([
  "--quiet",
  "-q",
  "--verbose",
  "-v",
  "--atomic",
])

// A refspec side usable as a branch name: no `:`/`^`/whitespace or other
// ref-syntax characters (the class excludes them), no `..` range, and not a
// bare 4–40-hex sha (an explicit commit — a branch named `deadbeef` is
// conservatively ambiguous and gates).
const NAME_RE = /^[A-Za-z0-9._/-]+$/
const SHA_RE = /^[0-9a-f]{4,40}$/i

/**
 * True when `name` is usable as a branch name in a rev-list comparison
 * (see `NAME_RE`/`SHA_RE` above for the exclusions and why).
 * @param name The refspec side or remote token to classify.
 * @returns True when the name is probe-safe.
 */
function isBranchName(name: string): boolean {
  return NAME_RE.test(name) && !name.includes("..") && !SHA_RE.test(name)
}

/**
 * The static half of the probe: plans a `git push` command into the remote
 * and branch names to check, or `null` when the shape is ambiguous and the
 * probe must exempt nothing. Only exactly one simple command that is a
 * `git push` is ever planned (a multi-push pipeline exempts nothing).
 * @param text The raw bash/shell command string.
 * @returns The push plan, or `null` for any ambiguous shape.
 */
export function planPushRefs(text: string): PushPlan | null {
  const simples = splitCommands(text)
  if (simples.length !== 1) return null
  const words = tokenizeWords(simples[0]!)
  const inv = gitInvocation(words)
  if (inv === null || inv.verb !== "push") return null
  const positionals: string[] = []
  for (const arg of words.slice(inv.index + 1)) {
    if (arg.startsWith("-")) {
      if (!PUSH_FLAG_WHITELIST.has(arg)) return null
      continue
    }
    positionals.push(arg)
  }
  return planFromPositionals(positionals)
}

/**
 * Maps the classified positionals of a `git push` to a plan: 0 → bare push
 * (HEAD/upstream mode), 1 → refspec `src:dst` (equal and safe only) or a bare
 * name (passed through: branch-or-remote is a git fact the probe
 * disambiguates), 2 → explicit remote + branch, ≥3 → ambiguous.
 * @param positionals The non-flag tokens after the `push` subcommand.
 * @returns The push plan, or `null` when the positionals are ambiguous.
 */
function planFromPositionals(positionals: string[]): PushPlan | null {
  if (positionals.length === 0) return { remote: null, branches: [] }
  if (positionals.length === 1) return planSingle(positionals[0]!)
  if (positionals.length === 2) {
    const remote = positionals[0]!
    if (!isBranchName(remote)) return null
    return { remote, branches: [positionals[1]!] }
  }
  return null
}

/**
 * Plans one positional: a `src:dst` refspec plans its branch only when both
 * sides are probe-safe and equal (a rename or a `HEAD` source gates); a bare
 * name (no `:`) is deliberately not classified statically — whether it names
 * a branch or a remote is a git fact, so it is passed through for the probe.
 * @param ref The single positional after the `push` subcommand.
 * @returns The push plan, or `null` when the refspec is ambiguous.
 */
function planSingle(ref: string): PushPlan | null {
  const colon = ref.indexOf(":")
  if (colon === -1) return { remote: null, branches: [ref] }
  const src = ref.slice(0, colon)
  const dst = ref.slice(colon + 1)
  if (!isBranchName(src) || !isBranchName(dst)) return null
  if (src !== dst || src === "HEAD") return null
  return { remote: null, branches: [src] }
}

/**
 * The current branch name from `git rev-parse --abbrev-ref HEAD`.
 * @param projectDir The absolute project directory to run against.
 * @param exec The exec seam (real or injected).
 * @returns The branch name.
 * @throws Error when HEAD is detached (`"HEAD"`), unborn, or the call fails.
 */
function headBranch(projectDir: string, exec: ExecFile): string {
  const out = exec(
    "git",
    ["-C", projectDir, "rev-parse", "--abbrev-ref", "HEAD"],
    GIT_PROBE_OPTS,
  ).trim()
  if (out === "" || out === "HEAD") throw new Error("no resolvable head branch")
  return out
}

/**
 * True when `name` is a configured remote (`git config --get remote.<name>.url`
 * exits 0).
 * @param name The remote candidate name.
 * @param projectDir The absolute project directory to run against.
 * @param exec The exec seam (real or injected).
 * @returns True when the remote is configured.
 */
function isConfiguredRemote(name: string, projectDir: string, exec: ExecFile): boolean {
  try {
    exec("git", ["-C", projectDir, "config", "--get", `remote.${name}.url`], GIT_PROBE_OPTS)
    return true
  } catch {
    return false
  }
}

/**
 * True when `name` is a local branch (`git rev-parse --verify refs/heads/<name>`
 * exits 0) — the disambiguation for a bare name that is both a remote and a
 * branch.
 * @param name The branch candidate name.
 * @param projectDir The absolute project directory to run against.
 * @param exec The exec seam (real or injected).
 * @returns True when the local branch exists.
 */
function isLocalBranch(name: string, projectDir: string, exec: ExecFile): boolean {
  try {
    exec("git", ["-C", projectDir, "rev-parse", "--verify", `refs/heads/${name}`], GIT_PROBE_OPTS)
    return true
  } catch {
    return false
  }
}

/**
 * Resolves a branch's upstream ref via `@{upstream}`.
 * @param branch The local branch whose upstream is resolved.
 * @param projectDir The absolute project directory to run against.
 * @param exec The exec seam (real or injected).
 * @returns The `remote/branch` upstream ref string.
 * @throws Error when the output is empty, the unresolvable `@{upstream}`
 *     literal, or the call fails.
 */
function upstreamRef(branch: string, projectDir: string, exec: ExecFile): string {
  const out = exec(
    "git",
    ["-C", projectDir, "rev-parse", "--abbrev-ref", `${branch}@{upstream}`],
    GIT_PROBE_OPTS,
  ).trim()
  if (out === "" || out.includes("@{upstream}")) throw new Error("unresolvable upstream")
  return out
}

/**
 * True when `upstreamRef` and `branch` resolve to the same commit
 * (`git rev-parse <upstreamRef> <branch>` prints one identical hash per
 * line). Ref equality — not just a zero ahead count — is the exemption
 * invariant: a branch *behind* its upstream has zero commits ahead too, but
 * pushing it (let alone force-pushing it) would rewind the remote, so it
 * must gate.
 * @param upstreamRef The upstream ref to compare against.
 * @param branch The local branch to compare.
 * @param projectDir The absolute project directory to run against.
 * @param exec The exec seam (real or injected).
 * @returns True when both refs resolve to the identical commit hash.
 */
function refsEqual(
  upstreamRef: string,
  branch: string,
  projectDir: string,
  exec: ExecFile,
): boolean {
  const out = exec("git", ["-C", projectDir, "rev-parse", upstreamRef, branch], GIT_PROBE_OPTS)
  const hashes = out.trim().split("\n")
  return hashes.length === 2 && hashes[0] === hashes[1] && hashes[0] !== ""
}

/**
 * True when one planned branch is provably empty against its upstream — the
 * branch resolves to the *same commit* as its upstream (ref equality, so a
 * behind branch never qualifies). The
 * explicit remote token wins (upstream ref `<remote>/<branch>`); a bare name
 * that is a configured remote resolves to its current-branch ref
 * `<name>/<head>` (and gates when it is also a local branch — ambiguous);
 * otherwise the branch's configured upstream resolves via `@{upstream}`.
 * @param branch The branch name to check.
 * @param plan The classified push (its explicit remote, if any).
 * @param projectDir The absolute project directory to run against.
 * @param exec The exec seam (real or injected).
 * @returns True when the branch equals its upstream ref.
 */
function branchIsEmpty(
  branch: string,
  plan: PushPlan,
  projectDir: string,
  exec: ExecFile,
): boolean {
  if (plan.remote !== null) return refsEqual(`${plan.remote}/${branch}`, branch, projectDir, exec)
  if (isConfiguredRemote(branch, projectDir, exec)) {
    if (isLocalBranch(branch, projectDir, exec)) return false
    const head = headBranch(projectDir, exec)
    return refsEqual(`${branch}/${head}`, head, projectDir, exec)
  }
  const upstream = upstreamRef(branch, projectDir, exec)
  return refsEqual(upstream, branch, projectDir, exec)
}

/**
 * Plans the branches to check: the refspec names as given, or the current
 * branch for a bare `git push` (throwing on detached/unborn HEAD).
 * @param plan The classified push.
 * @param projectDir The absolute project directory to run against.
 * @param exec The exec seam (real or injected).
 * @returns The non-empty branch list to compare.
 */
function resolveBranches(plan: PushPlan, projectDir: string, exec: ExecFile): string[] {
  if (plan.branches.length > 0) return plan.branches
  return [headBranch(projectDir, exec)]
}

/**
 * True when `command` is a statically-provable empty-diff push: every planned
 * branch resolves to the same commit as its upstream (ref equality, so a
 * behind branch never qualifies). Total — `planPushRefs` `null`
 * (any ambiguous shape) and every exec failure (throw, timeout, missing git)
 * yield `false`, never a throw, so the guard's fail-open contract holds and
 * the gate decision itself fails toward strict.
 * @param command The raw bash/shell command string.
 * @param projectDir The absolute project directory to run the probes against.
 * @param exec Optional exec seam; defaults to `realExec` (the real
 *     `execFileSync`). Tests inject a routed or throwing seam.
 * @returns True only when the push is provably empty against its upstream.
 */
export function isEmptyDiffPush(
  command: string,
  projectDir: string,
  exec: ExecFile = realExec,
): boolean {
  try {
    const plan = planPushRefs(command)
    if (plan === null) return false
    return resolveBranches(plan, projectDir, exec).every((branch) =>
      branchIsEmpty(branch, plan, projectDir, exec),
    )
  } catch {
    return false
  }
}
