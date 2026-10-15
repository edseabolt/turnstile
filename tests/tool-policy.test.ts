/**
 * @fileoverview Tool-policy tests: direct unit tests against `createToolPolicy`
 * with an injected capturing journaler, plus the fail-open / shadow-enforce
 * matrix. The `execute.before` integration lives in the setup wiring;
 * these cover the decision boundary itself.
 */

import { test } from "node:test"
import assert from "node:assert/strict"

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

/** The bash/git default rules block, asserted each in isolation. */
test("default bashDeny blocks each git-protective operation", async () => {
  const { policy } = makePolicy()
  await blocks(() => policy.guardBash("bash", "git worktree add ../foo", "s1"))
  await blocks(() => policy.guardBash("bash", "git worktree prune", "s1"))
  await blocks(() => policy.guardBash("bash", "git switch main", "s1"))
  await blocks(() => policy.guardBash("bash", "git checkout next", "s1"))
  await blocks(() => policy.guardBash("bash", "git merge main", "s1"))
  await blocks(() => policy.guardBash("shell", "gh pr create", "s1"))
  await blocks(() => policy.guardBash("shell", "gh pr merge --squash", "s1"))
})

/** Each default block carries the required journal fields and a trace line. */
test("default block journals reason/tool/rule/mode and traces", async () => {
  const { policy, entries, traces } = makePolicy()
  await blocks(() => policy.guardBash("bash", "git worktree add ../foo", "s1"))
  const blocked = blockEntry(entries)
  assert.ok(blocked)
  assert.equal(blocked.type, "blocked")
  assert.equal(blocked.tool, "bash")
  assert.equal(blocked.reason, "tool-policy")
  assert.equal(blocked.mode, "enforce")
  assert.equal(blocked.rule, 0)
  assert.match(blocked.sessionID, /s1/)
  assert.ok(traces.some((t) => t.startsWith("tool-policy | blocked | bash rule 0 | s1")))
})

/** Ordinary commands — including the git file-restore form — are allowed. */
test("default bashDeny allows ordinary commands and git path restore", () => {
  const { policy } = makePolicy()
  allow(() => policy.guardBash("bash", "npm test", "s1"))
  allow(() => policy.guardBash("bash", "git status", "s1"))
  allow(() => policy.guardBash("bash", "git log --oneline", "s1"))
  allow(() => policy.guardBash("bash", "git checkout -- file.ts", "s1"))
})

/** `git checkout -b/-C` (branch work) is blocked; `git checkout -- <path>` is not. */
test("git checkout -b is blocked while checkout -- path is allowed", async () => {
  const { policy } = makePolicy()
  await blocks(() => policy.guardBash("bash", "git checkout -b feature", "s1"))
  await blocks(() => policy.guardBash("bash", "git switch -c feature", "s1"))
  allow(() => policy.guardBash("bash", "git checkout -- kept.ts", "s1"))
})

/**
 * Global options interleaved between `git` and the subcommand are still caught,
 * Widen the default regexes so an option (`-C dir`,
 * `--git-dir=…`, a flag) never shields a branch/merge worktree switch, while the
 * file-restore form stays allowed.
 */
test("git global options before the subcommand are still blocked", async () => {
  const { policy } = makePolicy()
  // switch/checkout with a global option before the subcommand.
  await blocks(() => policy.guardBash("bash", "git -C ../other checkout main", "s1"))
  await blocks(() => policy.guardBash("bash", "git --git-dir=/tmp/repo checkout main", "s1"))
  await blocks(() => policy.guardBash("bash", "git -C dir checkout main", "s1"))
  // worktree and merge with a global option before the subcommand.
  await blocks(() => policy.guardBash("bash", "git -C dir worktree add ../w", "s1"))
  await blocks(() => policy.guardBash("bash", "git --no-ff merge feature", "s1"))
})

/**
 * The git file-restore form is allowed with or without an intervening global
 * option, including the `git checkout <ref> -- <path>` shape, so
 * widening the regex does not regress the restore exemption.
 */
test("git checkout restore form is allowed, option or not", () => {
  const { policy } = makePolicy()
  allow(() => policy.guardBash("bash", "git checkout -- src/app.ts", "s1"))
  allow(() => policy.guardBash("bash", "git checkout main -- src/app.ts", "s1"))
  allow(() => policy.guardBash("bash", "git -C /tmp/repo checkout -- src/app.ts", "s1"))
  allow(() => policy.guardBash("bash", "git -C /tmp/repo checkout main -- src/app.ts", "s1"))
})

/**
 * Documented tradeoff of the wider, global-option-tolerant base: the `merge`
 * rule can over-match on the bare subcommand word elsewhere (e.g. a commit
 * message), so `git commit -m "… merge …"` blocks. See README limits.
 */
test("option-tolerant base over-matches the merge word in a commit message (documented tradeoff)", async () => {
  const { policy } = makePolicy()
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

/** Under `off` the policy is a silent no-op: no block, no misconfig journal. */
test("off mode is a silent no-op", () => {
  const { policy, entries } = makePolicy({ toolPolicy: { mode: "off" } })
  allow(() => policy.guardBash("bash", "git merge main", "s1"))
  allow(() => policy.guardPath("write", "/.env", "s1"))
  allow(() => policy.guardBash("bash", "", "s1"))
  assert.deepEqual(
    entries.filter((e) => e.reason === "tool-policy"),
    [],
  )
  assert.deepEqual(
    entries.filter((e) => e.type === "error"),
    [],
  )
})

/** Under `shadow` the block journals with mode:"shadow" but does not throw. */
test("shadow mode journals the block without throwing", async () => {
  const { policy, entries, traces } = makePolicy({ toolPolicy: { mode: "shadow" } })
  allow(() => policy.guardBash("bash", "git merge main", "s1"))
  const blocked = blockEntry(entries)
  assert.ok(blocked)
  assert.equal(blocked.mode, "shadow")
  assert.equal(blocked.rule, 2)
  assert.ok(traces.some((t) => t.startsWith("tool-policy | blocked | bash rule 2")))
})

/** The same event under shadow vs enforce journals identically, only the mode
 *  field and the throw differ. */
test("shadow and enforce journal identical entries modulo the mode field", async () => {
  const en = makePolicy({ toolPolicy: { mode: "enforce" } })
  const sh = makePolicy({ toolPolicy: { mode: "shadow" } })
  await blocks(() => en.policy.guardBash("bash", "git merge main", "p1"))
  allow(() => sh.policy.guardBash("bash", "git merge main", "p1"))
  const enBlock = blockEntry(en.entries)
  const shBlock = blockEntry(sh.entries)
  assert.ok(enBlock && shBlock)
  const stripMode = (e: any) => {
    const { mode: _mode, ...rest } = e
    return rest
  }
  assert.deepEqual(stripMode(enBlock), stripMode(shBlock))
  // The trace lines are byte-identical across the two modes.
  assert.deepEqual(en.traces, sh.traces)
})

/** A misconfigured sessionID (child-style) still throws and journals it. */
test("a child-style sessionID is thrown and journaled unchanged", async () => {
  const { policy, entries } = makePolicy()
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

/** session_move journals one telemetry entry when observing, none otherwise. */
test("session_move journals when observing and is silent otherwise", () => {
  const { policy, entries } = makePolicy()
  allow(() => policy.observeSessionMove("s1", "/repo/subdir"))
  const sm = entries.find((e) => e.tool === "session_move")
  assert.ok(sm)
  assert.equal(sm.type, "tool")
  // Never blocks, even for a child-style sessionID.
  allow(() => policy.observeSessionMove("child-xyz", "/repo"))

  const { policy: p2, entries: e2 } = makePolicy({
    toolPolicy: { observeSessionMove: false },
  })
  allow(() => p2.observeSessionMove("s1", "/repo"))
  assert.deepEqual(
    e2.filter((e) => e.tool === "session_move"),
    [],
  )
})

/** The session_move directory is redacted when the trace is disabled. */
test("session_move directory honors the trace redaction gate", () => {
  const on = makePolicy({ toolPolicy: { observeSessionMove: true } })
  on.policy.observeSessionMove("s1", "/secret/dir")
  assert.equal(on.entries[0].directory, "/secret/dir")

  const off = makePolicy({ trace: false, toolPolicy: { observeSessionMove: true } })
  off.policy.observeSessionMove("s1", "/secret/dir")
  assert.equal(off.entries[0].directory, "<redacted>")
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
    // A partial toolPolicy is structurally not a Partial<TurnstileConfig> (the
    // nested object is required); the cast mirrors the codebase's test pattern
    // of passing partial nested config, and loadConfig is permissive at runtime.
    config: { metricsDir, ...configOverrides } as Partial<TurnstileConfig>,
  })
  const dispose = ((await setup(h.host)) as (() => void) | undefined) ?? (() => {})
  return { h, metricsDir, dispose }
}

/** A would-blocked bash command is rejected by the registered execute.before. */
test("integration: execute.before blocks a denied bash command", async () => {
  const { h, metricsDir, dispose } = await boot()
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
    assert.equal(blocked.mode, "enforce")
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

/** Under shadow, execute.before journals the block and does not throw. */
test("integration: execute.before shadow mode journals without throwing", async () => {
  const { h, metricsDir, dispose } = await boot({
    toolPolicy: { mode: "shadow" },
  })
  try {
    await callTool(h, "execute.before", {
      tool: "bash",
      sessionID: "s1",
      input: { command: "git merge main" },
    })
    const blocked = journalEntries(metricsDir).find(
      (e) => e.reason === "tool-policy" && e.mode === "shadow",
    )
    assert.ok(blocked)
  } finally {
    dispose()
  }
})

/** Same event under shadow vs enforce: journal identical modulo mode, only the
 *  throw differs — verified through the registered execute.before callback. */
test("integration: shadow and enforce differ only in the throw and mode field", async () => {
  const en = await boot({ toolPolicy: { mode: "enforce" } })
  const sh = await boot({ toolPolicy: { mode: "shadow" } })
  try {
    await assert.rejects(
      () =>
        callTool(en.h, "execute.before", {
          tool: "bash",
          sessionID: "p1",
          input: { command: "git merge main" },
        }),
      (e: unknown) => e instanceof BlockError,
    )
    await callTool(sh.h, "execute.before", {
      tool: "bash",
      sessionID: "p1",
      input: { command: "git merge main" },
    })
    const enBlock = journalEntries(en.metricsDir).find((e) => e.reason === "tool-policy")
    const shBlock = journalEntries(sh.metricsDir).find((e) => e.reason === "tool-policy")
    assert.ok(enBlock && shBlock)
    // Two independent boots write the entries at different moments, so the
    // journaler's prepended `ts` differs; the assertion is about the policy
    // content (identical modulo `mode`), not the write timestamp.
    const stripMode = ({ mode: _mode, ts: _ts, ...rest }: any) => rest
    assert.deepEqual(stripMode(enBlock), stripMode(shBlock))
  } finally {
    en.dispose()
    sh.dispose()
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
 * `guardLanding`. First block under `enforce` throws and records a landing
 * block (exercising the capability's `recordBlock`); the repeat attempt journals
 * a landing permission ask and escalates (the capability's `escalate`, a
 * documented no-op on the real capability), so `execute.before` allows through.
 */
test("integration: execute.before gates a git push through the landing guard", async () => {
  const { h, metricsDir, dispose } = await boot({ gitGates: { mode: "enforce" } })
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
    assert.equal(perm.mode, "enforce")
    // The landing deny stays disjoint from bashDeny: no tool-policy block.
    assert.deepEqual(
      journalEntries(metricsDir).filter((e) => e.reason === "tool-policy"),
      [],
    )
  } finally {
    dispose()
  }
})
