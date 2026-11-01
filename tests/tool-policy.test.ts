/**
 * @fileoverview Tool-policy tests: direct unit tests against `createToolPolicy`
 * with an injected capturing journaler, plus the fail-open and enforcement
 * matrix. The `execute.before` integration lives in the setup wiring;
 * these cover the decision boundary itself.
 */

import { test } from "node:test"
import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"

import { turnstile } from "../turnstile.ts"
import { BlockError } from "../src/gates.ts"
import { defaultConfig } from "../src/config.ts"
import { createToolPolicy, type ToolPolicy } from "../src/tool-policy.ts"
import type { Journaler } from "../src/journal.ts"
import type { TurnstileConfig, TurnstileGitGates, TurnstileToolPolicy } from "../src/types.ts"
import {
  callTool,
  isolatedEnv,
  journalEntries,
  makeFakeHost,
  tmpDir,
  type FakeHost,
} from "./helpers.ts"

/**
 * Builds a capturing Journaler: every journal entry is deep-copied into
 * `entries`, every trace line is appended (formatted like the trace file) to
 * `traces`. Tests assert on these instead of reading a file.
 */
function captureJournaler(): { journaler: Journaler; entries: any[]; traces: string[] } {
  const entries: any[] = []
  const traces: string[] = []
  const journaler: Journaler = {
    journalPath: "",
    sessionsDir: "",
    journalPathFor: () => "",
    tracePath: "",
    journal(entry) {
      entries.push({ ...entry })
    },
    traceEvent(agent, event, detail, sessionID) {
      traces.push(`${agent} | ${event} | ${detail}${sessionID ? ` | ${sessionID}` : ""}`)
    },
  }
  return { journaler, entries, traces }
}

/**
 * Builds a policy over the full default config with optional `toolPolicy` /
 * `gitGates` (each merged one level deep, mirroring `mergeConfig`) or
 * top-level overrides, with a capturing journaler.
 * @param overrides Config overrides; `toolPolicy` and `gitGates` are merged one
 *     level deep.
 * @returns The policy, its journaled entries, and its trace lines.
 */
function makePolicy(
  overrides: {
    toolPolicy?: Partial<TurnstileToolPolicy>
    gitGates?: Partial<TurnstileGitGates>
    trace?: boolean
  } = {},
): { policy: ToolPolicy; entries: any[]; traces: string[] } {
  const { journaler, entries, traces } = captureJournaler()
  const cfg: TurnstileConfig = {
    ...defaultConfig({}),
    ...overrides,
    toolPolicy: { ...defaultConfig({}).toolPolicy, ...(overrides.toolPolicy ?? {}) },
    gitGates: { ...defaultConfig({}).gitGates, ...(overrides.gitGates ?? {}) },
  }
  return { policy: createToolPolicy(cfg, journaler), entries, traces }
}

/** Asserts the next call to a guard does not throw (allow path). */
function allow(fn: () => void): void {
  assert.doesNotThrow(fn)
}

/** Asserts the next call to a guard throws the deliberate `BlockError`. */
function blocks(fn: () => void): void {
  assert.throws(fn, (e: unknown) => e instanceof BlockError)
}

/** The single tool-policy block entry, or null when none was journaled. */
function blockEntry(entries: any[]): any | null {
  return entries.find((e) => e.reason === "tool-policy") ?? null
}

/**
 * The historical default `bashDeny` sources, kept in the original order
 * (0: worktree, 1: switch/checkout, 2: merge, 3: gh pr) as a *configured*
 * policy fixture: the default denylist is now empty, but the mechanism tests
 * (rule indices, option-tolerant base, restore-form lookahead, first-match)
 * keep covering the historical regex shapes when the rules are configured.
 */
const GIT_DENY: string[] = [
  "\\bgit\\b[^;&|]*?\\sworktree\\s+(add|remove|prune)\\b",
  "\\bgit\\b[^;&|]*?\\s(switch|checkout)\\b(?![^;&|]*?--\\s)",
  "\\bgit\\b[^;&|]*?\\smerge\\b",
  "\\bgh\\s+pr\\s+(create|merge)\\b",
]

/**
 * The default `bashDeny` is empty: git branch, worktree, merge, and `gh pr`
 * commands pass unblocked and journal nothing — consent for these operations
 * is the host permission system's, not a hardcoded denylist's.
 */
test("default bashDeny is empty: git branch, worktree, merge, and gh pr commands pass unblocked and journal nothing", () => {
  const { policy, entries } = makePolicy()
  allow(() => policy.guardBash("bash", "git worktree add ../foo", "s1"))
  allow(() => policy.guardBash("bash", "git switch main", "s1"))
  allow(() => policy.guardBash("bash", "git checkout next", "s1"))
  allow(() => policy.guardBash("bash", "git merge main", "s1"))
  allow(() => policy.guardBash("shell", "gh pr create", "s1"))
  allow(() => policy.guardBash("shell", "gh pr merge --squash", "s1"))
  assert.deepEqual(
    entries.filter((e) => e.reason === "tool-policy"),
    [],
  )
})

/** The configured git-protective rules block, asserted each in isolation. */
test("configured git-protective bashDeny blocks each operation", async () => {
  const { policy } = makePolicy({ toolPolicy: { bashDeny: GIT_DENY } })
  await blocks(() => policy.guardBash("bash", "git worktree add ../foo", "s1"))
  await blocks(() => policy.guardBash("bash", "git worktree prune", "s1"))
  await blocks(() => policy.guardBash("bash", "git switch main", "s1"))
  await blocks(() => policy.guardBash("bash", "git checkout next", "s1"))
  await blocks(() => policy.guardBash("bash", "git merge main", "s1"))
  await blocks(() => policy.guardBash("shell", "gh pr create", "s1"))
  await blocks(() => policy.guardBash("shell", "gh pr merge --squash", "s1"))
})

/** Each configured-rule block carries the required journal fields and a trace line. */
test("configured block journals reason/tool/rule and traces", async () => {
  const { policy, entries, traces } = makePolicy({ toolPolicy: { bashDeny: GIT_DENY } })
  await blocks(() => policy.guardBash("bash", "git worktree add ../foo", "s1"))
  const blocked = blockEntry(entries)
  assert.ok(blocked)
  assert.equal(blocked.type, "blocked")
  assert.equal(blocked.tool, "bash")
  assert.equal(blocked.reason, "tool-policy")
  assert.equal(blocked.rule, 0)
  assert.match(blocked.sessionID, /s1/)
  assert.ok(traces.some((t) => t.startsWith("tool-policy | blocked | bash rule 0 | s1")))
})

/** Ordinary commands — including git worktree/branch operations and the git
 *  file-restore form — are allowed under the empty default denylist. */
test("default config allows ordinary commands and git worktree/branch operations", () => {
  const { policy } = makePolicy()
  allow(() => policy.guardBash("bash", "npm test", "s1"))
  allow(() => policy.guardBash("bash", "git status", "s1"))
  allow(() => policy.guardBash("bash", "git log --oneline", "s1"))
  allow(() => policy.guardBash("bash", "git worktree add ../foo", "s1"))
  allow(() => policy.guardBash("bash", "git switch main", "s1"))
  allow(() => policy.guardBash("bash", "git checkout -- file.ts", "s1"))
})

/** With the rules configured, `git checkout -b/-C` (branch work) is blocked;
 *  `git checkout -- <path>` is not. */
test("git checkout -b is blocked while checkout -- path is allowed", async () => {
  const { policy } = makePolicy({ toolPolicy: { bashDeny: GIT_DENY } })
  await blocks(() => policy.guardBash("bash", "git checkout -b feature", "s1"))
  await blocks(() => policy.guardBash("bash", "git switch -c feature", "s1"))
  allow(() => policy.guardBash("bash", "git checkout -- kept.ts", "s1"))
})

/**
 * With the rules configured, global options interleaved between `git` and the
 * subcommand are still caught: an option (`-C dir`, `--git-dir=…`, a flag)
 * never shields a branch/merge worktree switch, while the file-restore form
 * stays allowed.
 */
test("git global options before the subcommand are still blocked", async () => {
  const { policy } = makePolicy({ toolPolicy: { bashDeny: GIT_DENY } })
  // switch/checkout with a global option before the subcommand.
  await blocks(() => policy.guardBash("bash", "git -C ../other checkout main", "s1"))
  await blocks(() => policy.guardBash("bash", "git --git-dir=/tmp/repo checkout main", "s1"))
  await blocks(() => policy.guardBash("bash", "git -C dir checkout main", "s1"))
  // worktree and merge with a global option before the subcommand.
  await blocks(() => policy.guardBash("bash", "git -C dir worktree add ../w", "s1"))
  await blocks(() => policy.guardBash("bash", "git --no-ff merge feature", "s1"))
})

/**
 * With the rules configured, the git file-restore form is allowed with or
 * without an intervening global option, including the
 * `git checkout <ref> -- <path>` shape, so the option-tolerant base does not
 * regress the restore exemption.
 */
test("git checkout restore form is allowed, option or not", () => {
  const { policy } = makePolicy({ toolPolicy: { bashDeny: GIT_DENY } })
  allow(() => policy.guardBash("bash", "git checkout -- src/app.ts", "s1"))
  allow(() => policy.guardBash("bash", "git checkout main -- src/app.ts", "s1"))
  allow(() => policy.guardBash("bash", "git -C /tmp/repo checkout -- src/app.ts", "s1"))
  allow(() => policy.guardBash("bash", "git -C /tmp/repo checkout main -- src/app.ts", "s1"))
})

/**
 * Documented tradeoff of the wider, global-option-tolerant base of the
 * git-protective rules (when configured): the `merge` rule can over-match on
 * the bare subcommand word elsewhere (e.g. a commit message), so
 * `git commit -m "… merge …"` blocks. See README limits.
 */
test("configured option-tolerant base over-matches the merge word in a commit message (documented tradeoff)", async () => {
  const { policy } = makePolicy({ toolPolicy: { bashDeny: GIT_DENY } })
  await blocks(() => policy.guardBash("bash", 'git commit -m "add merge feature"', "s1"))
})

/** A configured pathDeny blocks only the matching path, nothing else. */
test("configured pathDeny blocks the matching path only", async () => {
  const { policy, entries } = makePolicy({
    toolPolicy: { pathDeny: ["\\.env$"] },
  })
  allow(() => policy.guardPath("write", "/repo/src/app.ts", "s1"))
  allow(() => policy.guardPath("edit", "/repo/README.md", "s1"))
  await blocks(() => policy.guardPath("write", "/repo/.env", "s1"))
  const blocked = blockEntry(entries)
  assert.ok(blocked)
  assert.equal(blocked.tool, "write")
  assert.equal(blocked.rule, 0)
})

/** Default config never blocks a write/edit and journals nothing. */
test("default config allows every write/edit and journals nothing", () => {
  const { policy, entries } = makePolicy()
  allow(() => policy.guardPath("write", "/repo/a.ts", "s1"))
  allow(() => policy.guardPath("edit", "/repo/b.ts", "s1"))
  assert.deepEqual(
    entries.filter((e) => e.reason === "tool-policy"),
    [],
  )
})

/** An empty or absent command fails open with misconfiguration telemetry. */
test("empty or absent bash command fails open with a misconfiguration error", () => {
  const { policy, entries } = makePolicy()
  allow(() => policy.guardBash("bash", "", "s1"))
  allow(() => policy.guardBash("bash", undefined, "s1"))
  const errs = entries.filter((e) => e.type === "error" && String(e.error).includes("command"))
  assert.equal(errs.length, 2)
  assert.match(errs[0].error, /command or cmd/)
})

/** An empty or absent path fails open symmetrically, naming filePath/path. */
test("empty or absent write/edit path fails open with a misconfiguration error", () => {
  const { policy, entries } = makePolicy()
  allow(() => policy.guardPath("write", "", "s1"))
  allow(() => policy.guardPath("edit", undefined, "s1"))
  const errs = entries.filter((e) => e.type === "error" && String(e.error).includes("target path"))
  assert.equal(errs.length, 2)
  assert.match(errs[0].error, /filePath or path/)
})

/** With no rules configured the policy never blocks; an empty command still
 *  journals its misconfiguration telemetry. */
test("an empty denylist never blocks", () => {
  const { policy, entries } = makePolicy()
  allow(() => policy.guardBash("bash", "git merge main", "s1"))
  allow(() => policy.guardPath("write", "/.env", "s1"))
  allow(() => policy.guardBash("bash", "", "s1"))
  assert.deepEqual(
    entries.filter((e) => e.reason === "tool-policy"),
    [],
  )
  const errs = entries.filter((e) => e.type === "error")
  assert.equal(errs.length, 1)
  assert.match(errs[0].error, /command or cmd/)
})

/** A misconfigured sessionID (child-style) still throws and journals it. */
test("a child-style sessionID is thrown and journaled unchanged", async () => {
  const { policy, entries } = makePolicy({ toolPolicy: { bashDeny: GIT_DENY } })
  await blocks(() => policy.guardBash("shell", "git worktree add", "child-abc123"))
  const blocked = blockEntry(entries)
  assert.equal(blocked.sessionID, "child-abc123")
})

/** Multi-rule match journals the lowest-index (first) matching rule. */
test("multi-rule match journals the first (lowest-index) rule", async () => {
  const { policy, entries } = makePolicy({
    toolPolicy: { bashDeny: ["\\bfirst\\b", "\\bsecond\\b"] },
  })
  // Both rule 0 and rule 1 match; first-match (rule 0) wins.
  await blocks(() => policy.guardBash("bash", "run second then first", "s1"))
  const blocked = blockEntry(entries)
  assert.equal(blocked.rule, 0)
})

/** A non-compiling source is dropped and journaled at createToolPolicy time. */
test("an invalid regex element is dropped and journaled as an error", async () => {
  const { policy, entries } = makePolicy({
    toolPolicy: { bashDeny: ["\\bvalid-x\\b", "("] },
  })
  const errs = entries.filter((e) => e.type === "error" && String(e.error).includes("bashDeny[1]"))
  assert.equal(errs.length, 1)
  // The valid rule still blocks; the dropped one is inert.
  await blocks(() => policy.guardBash("bash", "valid-x go", "s1"))
  allow(() => policy.guardBash("bash", "git merge", "s1"))
})

/** session_move journals one telemetry entry when observing, none otherwise;
 *  the tool-hook call shape is byte-stable (no reason key) and the resolver
 *  channel carries its origin as reason. */
test("session_move journals when observing and is silent otherwise", () => {
  const { policy, entries } = makePolicy()
  allow(() => policy.observeSessionMove("s1", "/repo/subdir"))
  const sm = entries.find((e) => e.tool === "session_move")
  assert.ok(sm)
  assert.equal(sm.type, "tool")
  // The tool-hook call journals the exact pre-origin shape — deep equality
  // proves no extra keys (notably no reason) were added.
  assert.deepEqual(sm, {
    type: "tool",
    sessionID: "s1",
    tool: "session_move",
    directory: "/repo/subdir",
  })
  // Never blocks, even for a child-style sessionID.
  allow(() => policy.observeSessionMove("child-xyz", "/repo"))
  // The resolver channel (a cached directory replaced by a different one)
  // carries its origin as a reason marker on the entry.
  allow(() => policy.observeSessionMove("s1", "/repo/moved", "re-resolved"))
  const re = entries.find((e) => e.tool === "session_move" && e.reason === "re-resolved")
  assert.ok(re)
  assert.equal(re.sessionID, "s1")
  assert.equal(re.directory, "/repo/moved")

  const { policy: p2, entries: e2 } = makePolicy({
    toolPolicy: { observeSessionMove: false },
  })
  allow(() => p2.observeSessionMove("s1", "/repo"))
  assert.deepEqual(
    e2.filter((e) => e.tool === "session_move"),
    [],
  )
})

/** The session_move directory is redacted when the trace is disabled; the
 *  resolver's origin marker rides the entry under both trace settings. */
test("session_move directory honors the trace redaction gate", () => {
  const on = makePolicy({ toolPolicy: { observeSessionMove: true } })
  on.policy.observeSessionMove("s1", "/secret/dir")
  assert.equal(on.entries[0].directory, "/secret/dir")
  on.policy.observeSessionMove("s1", "/secret/dir", "re-resolved")
  assert.equal(on.entries[1].directory, "/secret/dir")
  assert.equal(on.entries[1].reason, "re-resolved")

  const off = makePolicy({ trace: false, toolPolicy: { observeSessionMove: true } })
  off.policy.observeSessionMove("s1", "/secret/dir")
  assert.equal(off.entries[0].directory, "<redacted>")
  off.policy.observeSessionMove("s1", "/secret/dir", "re-resolved")
  assert.equal(off.entries[1].directory, "<redacted>")
  assert.equal(off.entries[1].reason, "re-resolved")
})

/** A nullish move target resolves to an empty string under trace (the
 *  `directory ?? ""` fallback) instead of throwing. */
test("session_move records an empty directory when the payload is nullish", () => {
  const on = makePolicy({ toolPolicy: { observeSessionMove: true } })
  on.policy.observeSessionMove("s1", undefined)
  assert.equal(on.entries[0].directory, "")
})

/** Extraction coercion never throws on a nullish host payload. */
test("guards never throw on nullish command/path values", () => {
  const { policy } = makePolicy()
  allow(() => policy.guardBash("bash", null, "s1"))
  allow(() => policy.guardPath("write", null, "s1"))
})

/**
 * Integration: the policy decision runs through the plugin's registered
 * `execute.before` callback, not a direct guard call. Boots with a temp
 * metrics dir and isolated env.
 */

/** Boots the plugin over a temp metrics dir, optionally overriding config. */
type BootConfig = {
  toolPolicy?: Partial<TurnstileToolPolicy>
  gitGates?: Partial<TurnstileGitGates>
  trace?: boolean
}
async function boot(
  configOverrides: BootConfig = {},
): Promise<{ h: FakeHost; metricsDir: string; dispose: () => void }> {
  const metricsDir = tmpDir()
  const h = makeFakeHost()
  const setup = turnstile(h.host, {
    env: isolatedEnv(metricsDir),
    // emptyDiffExempt is pinned false so the landing-ladder tests (which
    // assert a push BLOCKS) stay deterministic against whatever git state
    // process.cwd() happens to have; the dedicated empty-diff tests opt
    // back in explicitly per call.
    config: {
      metricsDir,
      // Ask mode: these suites exercise the interactive ask ladder (see
      // permission-approval bootWithPlan); the block-mode default has
      // dedicated guard-level tests.
      escalation: "ask" as const,
      ...configOverrides,
      gitGates: { emptyDiffExempt: false, ...configOverrides.gitGates },
    } as Partial<TurnstileConfig>,
  })
  const dispose = ((await setup(h.host)) as (() => void) | undefined) ?? (() => {})
  return { h, metricsDir, dispose }
}

/** A would-blocked bash command is rejected by the registered execute.before. */
test("integration: execute.before blocks a denied bash command", async () => {
  const { h, metricsDir, dispose } = await boot({ toolPolicy: { bashDeny: GIT_DENY } })
  try {
    await assert.rejects(
      () =>
        callTool(h, "execute.before", {
          tool: "bash",
          sessionID: "s1",
          input: { command: "git worktree add ../foo" },
        }),
      (e: unknown) => e instanceof BlockError && e.message.startsWith("BLOCKED by turnstile:"),
    )
    const blocked = journalEntries(metricsDir).find(
      (e) => e.reason === "tool-policy" && e.tool === "bash",
    )
    assert.ok(blocked)
    assert.equal(blocked.type, "blocked")
    assert.equal(blocked.rule, 0)
  } finally {
    dispose()
  }
})

/** A default bash command flows through execute.before unblocked. */
test("integration: execute.before allows an ordinary bash command", async () => {
  const { h, metricsDir, dispose } = await boot()
  try {
    await callTool(h, "execute.before", {
      tool: "bash",
      sessionID: "s1",
      input: { command: "npm test" },
    })
    assert.deepEqual(
      journalEntries(metricsDir).filter((e) => e.reason === "tool-policy"),
      [],
    )
  } finally {
    dispose()
  }
})

/** A denied edit target is blocked through the registered write branch. */
test("integration: execute.before blocks a denied write path", async () => {
  const { h, metricsDir, dispose } = await boot({
    toolPolicy: { pathDeny: ["\\.env$"] },
  })
  try {
    await assert.rejects(
      () =>
        callTool(h, "execute.before", {
          tool: "edit",
          sessionID: "s1",
          input: { filePath: "/repo/.env" },
        }),
      (e: unknown) => e instanceof BlockError,
    )
    const blocked = journalEntries(metricsDir).find(
      (e) => e.reason === "tool-policy" && e.tool === "edit",
    )
    assert.ok(blocked)
  } finally {
    dispose()
  }
})

/** A null input object fails open: no throw, misconfiguration journaled.
 *  The three bash-side guards (guardBash, guardCommitMessage, guardLanding) each
 *  independently detect the missing command, so each journals its own
 *  misconfiguration error — three, one per guard — rather than a single one. */
test("integration: a nullish command fails open with a journaled error", async () => {
  const { h, metricsDir, dispose } = await boot()
  try {
    // No throw: extraction coerces nullish input to empty and fails open.
    await callTool(h, "execute.before", { tool: "bash", sessionID: "s1", input: null })
    const errs = journalEntries(metricsDir).filter(
      (e) => e.type === "error" && String(e.error).includes("command"),
    )
    assert.equal(errs.length, 3)
  } finally {
    dispose()
  }
})

/** session_move is journaled as telemetry through execute.before (never blocks). */
test("integration: execute.before journals a session_move without blocking", async () => {
  const { h, metricsDir, dispose } = await boot()
  try {
    await callTool(h, "execute.before", {
      tool: "session_move",
      sessionID: "s1",
      input: { directory: "/repo/sub" },
    })
    const sm = journalEntries(metricsDir).find((e) => e.tool === "session_move")
    assert.ok(sm)
    assert.equal(sm.type, "tool")
    assert.equal(sm.directory, "/repo/sub")
  } finally {
    dispose()
  }
})

/** `npm run ci` golden: execute.after bash telemetry is untouched. */
test("integration: execute.after bash telemetry still records command+exit", async () => {
  const { h, metricsDir, dispose } = await boot()
  try {
    await callTool(h, "execute.after", {
      tool: "bash",
      sessionID: "s1",
      input: { command: "echo hi" },
      result: { metadata: { exitCode: 3 } },
    })
    const bash = journalEntries(metricsDir).find((e) => e.tool === "bash" && e.type === "tool")
    assert.ok(bash)
    assert.equal(bash.command, "echo hi")
    assert.equal(bash.exit, 3)
  } finally {
    dispose()
  }
})

/** The default three block messages remain byte-identical. */
test("integration: the historical block messages are unchanged", async () => {
  const { h, metricsDir, dispose } = await boot()
  try {
    await assert.rejects(
      () =>
        callTool(h, "execute.before", {
          tool: "task",
          sessionID: "p1",
          input: { agent: "reviewer", prompt: "p" },
        }),
      (e: Error) =>
        e.message ===
        "BLOCKED by turnstile: no reviewer dispatch before the test gate is green. " +
          "Run the test-runner subagent first; dispatch reviewer only after its first line is " +
          "`GATE: PASS tests=<n> passed=<n> failed=<n>`, or obtain an explicit user waiver " +
          "(a user prompt this task must contain the literal marker 'USER WAIVER:' followed by the user's words).",
    )
    assert.ok(journalEntries(metricsDir).some((e) => e.type === "dispatch"))
  } finally {
    dispose()
  }
})

/**
 * The bash-side guard chain runs end-to-end through `execute.before`: a `git
 * push` passes `guardBash`/`guardCommitMessage`/`observeLanding` and is gated by
 * `guardLanding`. The first block throws and records a landing block
 * (exercising the capability's `recordBlock`); the repeat attempt journals
 * a landing permission ask and escalates (the capability's `escalate`, a
 * documented no-op on the real capability), so `execute.before` allows through.
 */
test("integration: execute.before gates a git push through the landing guard", async () => {
  const { h, metricsDir, dispose } = await boot()
  try {
    // First block: no reviewer approval, enforce → throws and records a block.
    await assert.rejects(
      () =>
        callTool(h, "execute.before", {
          tool: "bash",
          sessionID: "p1",
          input: { command: "git push origin main" },
        }),
      (e: unknown) => e instanceof BlockError,
    )
    // Repeat attempt: enforce arms the human ask (permission + escalate) and
    // allows `execute.before` to pass so the evaluate handler can force it.
    await callTool(h, "execute.before", {
      tool: "bash",
      sessionID: "p1",
      input: { command: "git push origin main" },
    })
    const perm = journalEntries(metricsDir).find(
      (e) => e.type === "permission" && e.reason === "landing",
    )
    assert.ok(perm, "a landing permission ask is journaled on the repeat attempt")
    assert.equal(perm.action, "ask")
    // The landing deny stays disjoint from bashDeny: no tool-policy block.
    assert.deepEqual(
      journalEntries(metricsDir).filter((e) => e.reason === "tool-policy"),
      [],
    )
  } finally {
    dispose()
  }
})

/** True when git is available (the real-git fixture cases skip otherwise). */
const hasGit = spawnSync("git", ["--version"]).error === undefined

/**
 * Builds a real git fixture: a bare origin plus a worktree on `main` with one
 * commit pushed and its upstream set (`push -u`), so the empty-diff probe has
 * a resolvable remote and upstream.
 * @returns The worktree directory.
 */
function gitProjectFixture(): string {
  const work = tmpDir("turnstile-landing-emptydiff-")
  const origin = tmpDir("turnstile-landing-emptydiff-origin-")
  const run = (dir: string, ...args: string[]): void => {
    const result = spawnSync("git", ["-C", dir, ...args], { stdio: "ignore" })
    assert.equal(result.status, 0, `git ${args.join(" ")} failed`)
  }
  run(origin, "init", "--bare", "-b", "main")
  run(work, "init", "-b", "main")
  run(work, "remote", "add", "origin", origin)
  run(
    work,
    "-c",
    "user.email=test@example.com",
    "-c",
    "user.name=Test",
    "commit",
    "--allow-empty",
    "-m",
    "init",
  )
  run(work, "push", "-u", "origin", "main")
  return work
}

/**
 * Boots the plugin with the working directory swapped to a git fixture
 * project (a bare origin plus a worktree on `main`, one commit, upstream set),
 * so the empty-diff probe's project-directory fallback resolves inside the
 * worktree. The session's record has no directory on the default fake host,
 * so the probe reads `process.cwd()`.
 * @param configOverrides Config overrides forwarded to `boot`.
 * @returns The booted host, metrics dir, worktree path, and a `restore` that
 *     disposes and returns to the previous directory.
 */
async function bootInGitProject(
  configOverrides: BootConfig = {},
): Promise<{ h: FakeHost; metricsDir: string; project: string; restore: () => void }> {
  const project = gitProjectFixture()
  const metricsDir = tmpDir()
  const h = makeFakeHost()
  const prev = process.cwd()
  process.chdir(project)
  const setup = turnstile(h.host, {
    env: isolatedEnv(metricsDir),
    // Same pin as boot(): the exemption-off default keeps push-blocking
    // assertions deterministic; the empty-diff tests opt in per call.
    config: {
      metricsDir,
      // Ask mode: these suites exercise the interactive ask ladder (see
      // permission-approval bootWithPlan); the block-mode default has
      // dedicated guard-level tests.
      escalation: "ask" as const,
      ...configOverrides,
      gitGates: { emptyDiffExempt: false, ...configOverrides.gitGates },
    } as Partial<TurnstileConfig>,
  })
  const dispose = ((await setup(h.host)) as (() => void) | undefined) ?? (() => {})
  return {
    h,
    metricsDir,
    project,
    restore: (): void => {
      dispose()
      process.chdir(prev)
    },
  }
}

/**
 * With the exemption on, a push the probe proves empty against its
 * upstream is allowed through the enforced landing gate and journaled exactly
 * once as `exempt:"empty-diff"`, with no landing block.
 */
test(
  "integration: a proved empty-diff push passes the enforced gate",
  { skip: !hasGit },
  async () => {
    const { h, metricsDir, restore } = await bootInGitProject({
      gitGates: { emptyDiffExempt: true },
    })
    try {
      await callTool(h, "execute.before", {
        tool: "bash",
        sessionID: "p1",
        input: { command: "git push origin main" },
      })
      const entries = journalEntries(metricsDir)
      const exempt = entries.filter((e) => e.exempt === "empty-diff")
      assert.equal(exempt.length, 1, "exactly one empty-diff exemption is journaled")
      const entry = exempt[0]
      assert.ok(entry, "the exemption entry exists")
      assert.equal(entry.type, "tool")
      assert.equal(entry.tool, "bash")
      assert.equal(entry.landing, true)
      assert.equal(entry.sessionID, "p1")
      assert.ok(!entries.some((e) => e.reason === "no-landing-approval"), "no landing block")
    } finally {
      restore()
    }
  },
)

/**
 * With the exemption on but the push non-empty (a new commit ahead of
 * upstream), the probe is false and the landing gate blocks with
 * `no-landing-approval`.
 */
test(
  "integration: a non-empty-diff push is blocked under the exemption",
  { skip: !hasGit },
  async () => {
    const { h, metricsDir, project, restore } = await bootInGitProject({
      gitGates: { emptyDiffExempt: true },
    })
    try {
      const commit = spawnSync(
        "git",
        [
          "-C",
          project,
          "-c",
          "user.email=test@example.com",
          "-c",
          "user.name=Test",
          "commit",
          "--allow-empty",
          "-m",
          "feat: ahead",
        ],
        { stdio: "ignore" },
      )
      assert.equal(commit.status, 0)
      await assert.rejects(
        () =>
          callTool(h, "execute.before", {
            tool: "bash",
            sessionID: "p1",
            input: { command: "git push origin main" },
          }),
        (e: unknown) => e instanceof BlockError,
      )
      const blocked = journalEntries(metricsDir).find((e) => e.reason === "no-landing-approval")
      assert.ok(blocked, "a no-landing-approval block is journaled")
      assert.equal(blocked.type, "blocked")
      assert.ok(
        !journalEntries(metricsDir).some((e) => e.exempt === "empty-diff"),
        "no exemption journaled",
      )
    } finally {
      restore()
    }
  },
)
