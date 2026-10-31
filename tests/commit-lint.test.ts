/**
 * @fileoverview Commit-lint tests: the decision matrix for
 * `ToolPolicy.guardCommitMessage` — the guard crossed with the three payload
 * shapes (a matching conventional message, a non-conventional one, and an
 * uninspectable form) — plus the
 * shell-separator parsing negatives, the `-m`/`-F` argument extraction, and the
 * compile-once + invalid-config fallback of `commitFormat`.
 */

import { test } from "node:test"
import assert from "node:assert/strict"

import { createToolPolicy, type ToolPolicy } from "../src/tool-policy.ts"
import { defaultConfig, DEFAULT_COMMIT_FORMAT } from "../src/config.ts"
import { BlockError } from "../src/gates.ts"
import type { Journaler } from "../src/journal.ts"
import type { TurnstileConfig, TurnstileGitGates } from "../src/types.ts"

/**
 * Builds a capturing Journaler: every journal entry is deep-copied into
 * `entries`, every trace line is appended to `traces`.
 * @returns The journaler, its entries, and its trace lines.
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
 * Builds a policy over the default config with one-level-deep `gitGates`
 * override, with a capturing journaler.
 * @param overrides `gitGates` fields to merge over the defaults.
 * @returns The policy, its journaled entries, and its trace lines.
 */
function makePolicy(overrides: { gitGates?: Partial<TurnstileGitGates> } = {}): {
  policy: ToolPolicy
  entries: any[]
  traces: string[]
} {
  const { journaler, entries, traces } = captureJournaler()
  const cfg: TurnstileConfig = {
    ...defaultConfig({}),
    gitGates: { ...defaultConfig({}).gitGates, ...(overrides.gitGates ?? {}) },
  }
  return { policy: createToolPolicy(cfg, journaler), entries, traces }
}

/** The block entries of a given reason, or an empty array. */
function blockEntries(entries: any[], reason: string): any[] {
  return entries.filter((e) => e.type === "blocked" && e.reason === reason)
}

/** Asserts `fn` throws the deliberate `BlockError`. */
function blocks(fn: () => void): void {
  assert.throws(fn, (e: unknown) => e instanceof BlockError)
}

/** Asserts `fn` does not throw (allow path). */
function allows(fn: () => void): void {
  assert.doesNotThrow(fn)
}

/**
 * The commit-lint decision matrix: the guard (on via `commitMessages: true`)
 * crossed with the three payload shapes (matching / non-conventional /
 * uninspectable), and the `commitMessages: false` off switch. A matching
 * message never blocks; a non-conventional or uninspectable one journals a
 * block and throws; the off switch never throws and journals nothing.
 */
test("guardCommitMessage: payload decision matrix and the commitMessages off switch", () => {
  const payloads = {
    match: 'git commit -m "feat: add the thing"',
    noMatch: 'git commit -m "this is not conventional"',
    uninspectable: "git commit -F /tmp/patch.txt",
  }
  const reasons = {
    match: null as string | null,
    noMatch: "invalid-commit-message",
    uninspectable: "commit-message-uninspectable",
  }
  for (const [key, command] of Object.entries(payloads)) {
    const { policy, entries } = makePolicy({ gitGates: { commitMessages: true } })
    const reason = reasons[key as keyof typeof reasons]
    const invoke = () => policy.guardCommitMessage("bash", command, "s1")
    if (reason === null) {
      // A matching conventional message never blocks.
      allows(invoke)
      continue
    }
    blocks(invoke)
    assert.equal(blockEntries(entries, reason).length, 1, `expected one ${reason} block`)
    // The off switch disables the guard entirely: no block, no throw.
    const off = makePolicy({ gitGates: { commitMessages: false } })
    allows(() => off.policy.guardCommitMessage("bash", command, "s1"))
    assert.deepEqual(blockEntries(off.entries, reason), [])
  }
})

/** A matching conventional message is allowed in every shape. */
test("guardCommitMessage: accepts conventional messages (single/double quoted)", () => {
  {
    const { policy } = makePolicy()
    allows(() => policy.guardCommitMessage("bash", 'git commit -m "feat: add x"', "s1"))
    allows(() => policy.guardCommitMessage("bash", "git commit -m 'feat: add x'", "s1"))
    allows(() => policy.guardCommitMessage("bash", "git commit -m 'fix(scope): y'", "s1"))
    allows(() => policy.guardCommitMessage("bash", "git commit -m 'feat!: boom'", "s1"))
    allows(() => policy.guardCommitMessage("bash", "git commit --message 'docs: z'", "s1"))
    allows(() => policy.guardCommitMessage("bash", "git commit --message='chore: tidy'", "s1"))
    allows(() => policy.guardCommitMessage("bash", 'git commit --amend -m "feat: x"', "s1"))
  }
})

/**
 * The glued `--message=` and `-m<msg>` readers only consume the word after the
 * flag, so an unquoted multi-word subject cannot be conventional: both are
 * rejected (exercising the two slice branches).
 */
test("guardCommitMessage: rejects glued --message= and -m<msg> forms", () => {
  for (const command of ["git commit --message=ci: pipeline", "git commit -mfeat: glued"]) {
    const { policy } = makePolicy()
    blocks(() => policy.guardCommitMessage("bash", command, "s1"))
  }
})

/** A non-conventional first-line message is blocked. */
test("guardCommitMessage: rejects non-conventional messages", () => {
  for (const bad of ["not a commit", "feat x", "fixes: plural", "feature: bogus"]) {
    const { policy } = makePolicy()
    assert.throws(
      () => policy.guardCommitMessage("bash", `git commit -m "${bad}"`, "s1"),
      (e: Error) => e instanceof BlockError && e.message.includes(bad),
    )
  }
})

/** The BlockError names the offending subject and the expected conventional shape. */
test("guardCommitMessage: the enforce error names the subject and the expected shape", () => {
  const { policy } = makePolicy()
  assert.throws(
    () => policy.guardCommitMessage("bash", 'git commit -m "garbage subject"', "s1"),
    (e: Error) => {
      assert.match(e.message, /^BLOCKED by turnstile: commit message 'garbage subject'/)
      assert.match(e.message, /is not a conventional commit — expected type\(scope\)!: subject/)
      return true
    },
  )
})

/** Each uninspectable form fail-closes; a bare commit is uninspectable too. */
test("guardCommitMessage: each uninspectable form blocks", () => {
  for (const command of [
    "git commit -F /tmp/p.txt",
    "git commit --file /tmp/p.txt",
    "git commit -t /tmp/t.txt",
    "git commit --template /tmp/t.txt",
    "git commit --edit",
    "git commit -e",
    "git commit",
    "git commit -m",
  ]) {
    const { policy, entries } = makePolicy()
    blocks(() => policy.guardCommitMessage("bash", command, "s1"))
    assert.equal(blockEntries(entries, "commit-message-uninspectable").length, 1)
  }
})

/** --amend with -m is inspectable: the message is linted, not treated as uninspectable. */
test("guardCommitMessage: --amend -m is inspectable (lints the message)", () => {
  const enforce = makePolicy()
  blocks(() => enforce.policy.guardCommitMessage("bash", 'git commit --amend -m "garbage"', "s1"))
  const ok = makePolicy()
  allows(() => ok.policy.guardCommitMessage("bash", 'git commit --amend -m "feat: x"', "s1"))
})

/**
 * Negatives: `echo git commit` (not a commit invocation) and `git commit-graph`
 * (a hyphenated subcommand word, never equal to `commit`) are never linted.
 */
test("guardCommitMessage: does not parse substrings as commit invocations", () => {
  const { policy } = makePolicy()
  allows(() => policy.guardCommitMessage("bash", "echo git commit", "s1"))
  allows(() => policy.guardCommitMessage("bash", 'echo "git commit -m bad"', "s1"))
  allows(() => policy.guardCommitMessage("bash", "git commit-graph show", "s1"))
  allows(() => policy.guardCommitMessage("bash", "git add -A && echo ok", "s1"))
})

/**
 * A `git commit` in a `&&`/`||`/`;`/`|`/`\r`/`\n` span is detected in isolation:
 * the separators split the command, and the bad commit in any segment blocks.
 */
test("guardCommitMessage: detects a commit after each shell separator", () => {
  const separators: Record<string, string> = {
    semicolon: 'git log; git commit -m "bad"',
    pipe: 'git log | git commit -m "bad"',
    and: 'git log && git commit -m "bad"',
    or: 'git log || git commit -m "bad"',
    newline: 'git commit -m "feat: a"\ngit commit -m "bad"',
    cr: 'git commit -m "feat: a"\rgit commit -m "bad"',
  }
  for (const [name, command] of Object.entries(separators)) {
    const { policy, entries } = makePolicy()
    blocks(() => policy.guardCommitMessage("bash", command, "s1"))
    assert.ok(
      blockEntries(entries, "invalid-commit-message").length === 1,
      `separator ${name} should detect the bad commit`,
    )
  }
})

/** A quoted `-m` spanning a separator stays inside the message (not split). */
test("guardCommitMessage: a quoted newline stays inside the message, not a separator", () => {
  const { policy, entries } = makePolicy()
  const command = 'git commit -m "feat: x\nbody line"'
  allows(() => policy.guardCommitMessage("bash", command, "s1"))
  assert.deepEqual(blockEntries(entries, "invalid-commit-message"), [])
})

/** Repeatable -m validates each message; a valid pair passes, a bad pair blocks. */
test("guardCommitMessage: validates each repeatable -m message", () => {
  const ok = makePolicy()
  allows(() => ok.policy.guardCommitMessage("bash", 'git commit -m "feat: a" -m "fix: b"', "s1"))
  const bad = makePolicy()
  blocks(() => bad.policy.guardCommitMessage("bash", 'git commit -m "feat: a" -m "nope"', "s1"))
})

/** An empty or absent command fails open with misconfiguration telemetry. */
test("guardCommitMessage: empty or absent command fails open", () => {
  const { policy, entries } = makePolicy()
  allows(() => policy.guardCommitMessage("bash", "", "s1"))
  allows(() => policy.guardCommitMessage("bash", undefined, "s1"))
  assert.ok(
    entries.some(
      (e) => e.type === "error" && /git commit lint carried no command/.test(String(e.error)),
    ),
  )
})

/** commitMessages:false short-circuits the guard entirely. */
test("guardCommitMessage: commitMessages:false disables linting", () => {
  const { policy, entries } = makePolicy({ gitGates: { commitMessages: false } })
  allows(() => policy.guardCommitMessage("bash", "git commit -F /tmp/p.txt", "s1"))
  assert.deepEqual(blockEntries(entries, "commit-message-uninspectable"), [])
})

/** A non-string command is treated as empty and fails open. */
test("guardCommitMessage: a non-string command fails open", () => {
  const { policy, entries } = makePolicy()
  allows(() => policy.guardCommitMessage("bash", 42, "s1"))
  assert.ok(entries.some((e) => e.type === "error" && /no command/.test(String(e.error))))
})

/**
 * Default commitFormat compiles as a `^…$` + `"s"` conventional-commit pattern,
 * so a multi-line conventional commit (subject + body) matches.
 */
test("guardCommitMessage: the default commitFormat spans a subject and body line", () => {
  const { policy } = makePolicy()
  const command = 'git commit -m "feat: add x\n\nA longer body line describing the change"'
  allows(() => policy.guardCommitMessage("bash", command, "s1"))
})

/**
 * The commitFormat regex source is compiled once; an invalid configured source
 * journals a compile error and falls back to the conventional-commit default so
 * ordinary commits still pass.
 */
test("guardCommitMessage: invalid commitFormat source journals a compile error and falls back", () => {
  const { policy, entries } = makePolicy({ gitGates: { commitFormat: "(" } })
  assert.ok(
    entries.some(
      (e) =>
        e.type === "error" &&
        /dropped invalid gitGates.commitFormat/.test(String(e.error)) &&
        String(e.error).includes("("),
    ),
  )
  // The fall-back default still lints: a conventional commit passes.
  allows(() => policy.guardCommitMessage("bash", 'git commit -m "feat: ok"', "s1"))
})

/**
 * A non-string commitFormat falls back to the conventional-commit default and
 * lints normally (the defensive fallback `mergeConfig` also normalizes away).
 * A non-conventional subject journals an invalid-commit-message block.
 */
test("guardCommitMessage: a non-string commitFormat falls back to the default", () => {
  const { policy, entries } = makePolicy({ gitGates: { commitFormat: undefined } })
  blocks(() => policy.guardCommitMessage("bash", 'git commit -m "garbage"', "s1"))
  assert.deepEqual(blockEntries(entries, "invalid-commit-message").length, 1)
  assert.ok(!entries.some((e) => /commitFormat/.test(String(e.error ?? ""))))
})

/**
 * The shipped default commitFormat compiles and accepts the conventional set,
 * mirroring the config test but at the tool-policy compile boundary.
 */
test("guardCommitMessage: the DEFAULT_COMMIT_FORMAT constant compiles as expected", () => {
  const re = new RegExp(`^${DEFAULT_COMMIT_FORMAT}$`, "s")
  assert.ok(re.test("feat: subject"))
  assert.ok(!re.test("nope: subject"))
})

/**
 * Negatives: a bare `commit` word as an argument to a non-commit subcommand
 * (e.g. `git log --grep commit`) is not a `git commit` invocation and is never
 * linted. `git -c user.name=x commit -m "feat: x"` proves the positional parse
 * skips global options before resolving the subcommand.
 */
test("guardCommitMessage: bare-word commit args and global-option commits are not false positives", () => {
  const { policy, entries } = makePolicy()
  allows(() => policy.guardCommitMessage("bash", "git log --grep commit", "s1"))
  allows(() => policy.guardCommitMessage("bash", "git status --porcelain commit", "s1"))
  allows(() => policy.guardCommitMessage("bash", "echo commit", "s1"))
  allows(() => policy.guardCommitMessage("bash", 'git -c user.name=x commit -m "feat: x"', "s1"))
  assert.deepEqual(blockEntries(entries, "invalid-commit-message"), [])
  assert.deepEqual(blockEntries(entries, "commit-message-uninspectable"), [])
})

/**
 * Bundled short-flag clusters that embed `-m` (e.g. `-am`, `-am<msg>`,
 * `-aqm`) are inspectable: the message is extracted and linted normally.
 * A cluster with a missing message (`-am` alone) blocks
 * `commit-message-uninspectable`; a non-conventional message blocks
 * `invalid-commit-message` (never `commit-message-uninspectable`).
 */
test("guardCommitMessage: bundled -m clusters are inspectable", () => {
  const ok = makePolicy()
  allows(() => ok.policy.guardCommitMessage("bash", 'git commit -am "feat: x"', "s1"))
  allows(() => ok.policy.guardCommitMessage("bash", 'git commit -am"feat: x"', "s1"))
  allows(() => ok.policy.guardCommitMessage("bash", 'git commit -aqm "feat: x"', "s1"))
  assert.deepEqual(blockEntries(ok.entries, "commit-message-uninspectable"), [])

  const bad = makePolicy()
  blocks(() => bad.policy.guardCommitMessage("bash", 'git commit -am "garbage"', "s1"))
  assert.equal(blockEntries(bad.entries, "invalid-commit-message").length, 1)
  assert.deepEqual(blockEntries(bad.entries, "commit-message-uninspectable"), [])

  const noMsg = makePolicy()
  blocks(() => noMsg.policy.guardCommitMessage("bash", "git commit -am", "s1"))
  assert.equal(blockEntries(noMsg.entries, "commit-message-uninspectable").length, 1)
})

/**
 * A bundled cluster carrying an editor flag (`e`/`t`/`F`) stays uninspectable
 * (fail-closed); a cluster whose `m` needs a next token that is itself a flag
 * also blocks `commit-message-uninspectable`.
 */
test("guardCommitMessage: a bundled cluster with an editor flag blocks uninspectable", () => {
  const { policy, entries } = makePolicy()
  blocks(() => policy.guardCommitMessage("bash", "git commit -aem", "s1"))
  assert.equal(blockEntries(entries, "commit-message-uninspectable").length, 1)

  const { policy: p2, entries: e2 } = makePolicy()
  blocks(() => p2.guardCommitMessage("bash", "git commit -am -e", "s1"))
  assert.equal(blockEntries(e2, "commit-message-uninspectable").length, 1)
})

/** A bundled cluster without `-m` (e.g. `-aq`) has no message and blocks uninspectable. */
test("guardCommitMessage: a bundled cluster without -m blocks uninspectable", () => {
  const { policy, entries } = makePolicy()
  blocks(() => policy.guardCommitMessage("bash", "git commit -aq", "s1"))
  assert.equal(blockEntries(entries, "commit-message-uninspectable").length, 1)
})

/**
 * A cluster consuming its next token advances the arg scan exactly once, so a
 * following `-m <msg>` is still linted: both messages are valid, and if either
 * is non-conventional the block is `invalid-commit-message` (both messages
 * reach the lint, none is lost to mispairing).
 */
test("guardCommitMessage: bundled cluster advancement keeps later -m messages linted", () => {
  const ok = makePolicy()
  allows(() => ok.policy.guardCommitMessage("bash", 'git commit -am "feat: a" -m "fix: b"', "s1"))
  assert.deepEqual(blockEntries(ok.entries, "commit-message-uninspectable"), [])

  const bad = makePolicy()
  blocks(() => bad.policy.guardCommitMessage("bash", 'git commit -am "feat: a" -m "garbage"', "s1"))
  assert.equal(blockEntries(bad.entries, "invalid-commit-message").length, 1)
  assert.deepEqual(blockEntries(bad.entries, "commit-message-uninspectable"), [])
})

/** The bundled `-am "garbage"` block is `invalid-commit-message`, never uninspectable. */
test("guardCommitMessage: a bundled -am invalid message journals invalid-commit-message", () => {
  const { policy, entries } = makePolicy()
  blocks(() => policy.guardCommitMessage("bash", 'git commit -am "garbage"', "s1"))
  assert.equal(blockEntries(entries, "invalid-commit-message").length, 1)
  assert.equal(blockEntries(entries, "commit-message-uninspectable").length, 0)
})
