/**
 * @fileoverview Secret-detection tests: the canonical pattern boundary
 * (`src/secret-patterns.ts` — compiler, entropy heuristic), the config merge
 * arms for the `secrets` block, the write-time guard decision matrix, and
 * the end-to-end wiring (write/edit and bash arms, pipeline-child coverage,
 * redaction with configured extras).
 */

import { test } from "node:test"
import assert from "node:assert/strict"

import {
  BUILTIN_SECRET_PATTERN_SOURCES,
  compileSecretPatterns,
  findHighEntropyLiterals,
} from "../src/util/secret-patterns.ts"
import {
  REDACTION_SENTINEL,
  redactSecrets,
  SECRET_PATTERNS,
} from "../src/journal/decision-ledger-redact.ts"
import { defaultConfig, mergeConfig } from "../src/config/config.ts"
import { createToolPolicy, type ToolPolicy } from "../src/tool-policy/tool-policy.ts"
import { BlockError } from "../src/gates/gates.ts"
import { createHooksCore, type TurnstileContext } from "../src/hooks/hooks-core.ts"
import type { Journaler } from "../src/journal/journal.ts"
import type { TurnstileConfig, TurnstileSecrets } from "../src/util/types.ts"
import { isolatedEnv, journalEntries, tmpDir } from "./helpers.ts"

/** A 24-char run of distinct letter+digit characters (entropy ≈ 4.58 bits). */
const HIGH_ENTROPY_RUN = "aB3xK9mQ2pL7vN4zR8cT5wY6"

/**
 * Builds a capturing Journaler: every journal entry is deep-copied into
 * `entries` (mirroring the tool-policy test harness).
 */
function captureJournaler(): { journaler: Journaler; entries: any[] } {
  const entries: any[] = []
  const journaler: Journaler = {
    bindAnchorSinks() {},
    anchor() {},
    async anchorAsync() {},
    journalPath: "",
    sessionsDir: "",
    journalPathFor: () => "",
    tracePath: "",
    journal(entry) {
      entries.push({ ...entry })
    },
    traceEvent() {},
  }
  return { journaler, entries }
}

/** Builds a policy with the given `secrets` overrides and compiled patterns. */
function makePolicy(
  secrets?: Partial<TurnstileSecrets>,
  secretPatterns?: RegExp[],
): { policy: ToolPolicy; entries: any[]; stashed: string[] } {
  const { journaler, entries } = captureJournaler()
  const base = defaultConfig({})
  const cfg: TurnstileConfig = {
    ...base,
    secrets: { ...base.secrets, ...(secrets ?? {}) },
  }
  const stashed: string[] = []
  const policy = createToolPolicy(cfg, journaler, secretPatterns)
  return { policy, entries, stashed }
}

/** The stash closure the tests pass to `guardSecretWrite`. */
function stashOf(stashed: string[]): (text: string) => void {
  return (text) => stashed.push(text)
}

// ── canonical pattern source ─────────────────────────────────────────────────

test("BUILTIN_SECRET_PATTERN_SOURCES is a frozen ordered list with flags", () => {
  assert.ok(Object.isFrozen(BUILTIN_SECRET_PATTERN_SOURCES))
  assert.ok(BUILTIN_SECRET_PATTERN_SOURCES.length >= 9)
  for (const spec of BUILTIN_SECRET_PATTERN_SOURCES) {
    assert.equal(typeof spec.source, "string")
    assert.match(spec.flags, /g/)
  }
})

test("compileSecretPatterns: built-ins come first in canonical order, extras append", () => {
  const patterns = compileSecretPatterns(null, ["myorg-[A-Za-z0-9]{16,}"])
  assert.equal(patterns.length, BUILTIN_SECRET_PATTERN_SOURCES.length + 1)
  for (const [i, spec] of BUILTIN_SECRET_PATTERN_SOURCES.entries()) {
    assert.equal(patterns[i]!.source, spec.source)
    assert.equal(patterns[i]!.flags, spec.flags)
  }
  assert.equal(patterns[patterns.length - 1]!.source, "myorg-[A-Za-z0-9]{16,}")
})

test("compileSecretPatterns: a valid extra compiles and matches", () => {
  const [extra] = compileSecretPatterns(null, ["myorg-[A-Za-z0-9]{16,}"]).slice(-1)
  assert.ok(extra!.test("myorg-abcdef0123456789ab"))
})

test("compileSecretPatterns: an invalid extra is dropped with a journaled error", () => {
  const { journaler, entries } = captureJournaler()
  const patterns = compileSecretPatterns(journaler, ["myorg-[A-Za-z0-9{16,}", "ok-[A-Za-z]{4}"])
  assert.equal(patterns.length, BUILTIN_SECRET_PATTERN_SOURCES.length + 1)
  assert.deepEqual(entries, [
    {
      type: "error",
      error:
        'secret patterns: dropped invalid secrets.patterns[0] regex "myorg-[A-Za-z0-9{16,}"; it detects nothing',
    },
  ])
})

test("compileSecretPatterns: a null journaler drops an invalid extra silently", () => {
  const patterns = compileSecretPatterns(null, ["myorg-[A-Za-z0-9{16,}"])
  assert.equal(patterns.length, BUILTIN_SECRET_PATTERN_SOURCES.length)
})

// ── entropy heuristic ────────────────────────────────────────────────────────

test("findHighEntropyLiterals: flags a long mixed letter+digit run", () => {
  assert.deepEqual(findHighEntropyLiterals(`key ${HIGH_ENTROPY_RUN} end`), [HIGH_ENTROPY_RUN])
})

test("findHighEntropyLiterals: prose, paths, and hex hashes never flag", () => {
  const text =
    "this is a plain prose sentence about building things, " +
    "see /usr/local/share/doc/examples for the docs, " +
    "commit 9f2a7c1b8e3d5a0f4c6b2d8e1a7f3c5b9d0e2a4c fixed it"
  assert.deepEqual(findHighEntropyLiterals(text), [])
})

test("findHighEntropyLiterals: a letters-only or digits-only run never flags", () => {
  assert.deepEqual(findHighEntropyLiterals("abcdefghijklmnopqrst uvwxyz123456789012"), [])
})

test("findHighEntropyLiterals: a run shorter than 20 characters never flags", () => {
  assert.deepEqual(findHighEntropyLiterals("aB3xK9mQ2pL7vN4zR8"), [])
})

test("findHighEntropyLiterals: flags are capped at five per call", () => {
  const text = Array.from({ length: 6 }, (_, i) => `${HIGH_ENTROPY_RUN}${i}`).join(" ")
  assert.equal(findHighEntropyLiterals(text).length, 5)
})

// ── redaction with configured extras ─────────────────────────────────────────

test("redactSecrets: a configured extra pattern redacts alongside the built-ins", () => {
  const pats = compileSecretPatterns(null, ["myorg-[A-Za-z0-9]{16,}"])
  assert.equal(redactSecrets("myorg-abcdef0123456789ab", pats), REDACTION_SENTINEL)
})

test("redactSecrets: the default path redacts with the built-ins only", () => {
  assert.equal(redactSecrets("deploy AKIAIOSFODNN7EXAMPLE now"), "deploy [REDACTED] now")
  assert.ok(SECRET_PATTERNS.length >= 9)
})

// ── config merge arms ────────────────────────────────────────────────────────

test("defaultConfig carries the secrets defaults", () => {
  const cfg = defaultConfig({})
  assert.deepEqual(cfg.secrets, { patterns: [], writeGuard: "advise", entropy: false })
})

test("mergeSecretsPatch: a non-object secrets block keeps the defaults", () => {
  const { config, warnings } = mergeConfig(defaultConfig({}), { secrets: "nope" })
  assert.deepEqual(config.secrets, { patterns: [], writeGuard: "advise", entropy: false })
  assert.ok(warnings.includes("config: secrets must be an object; keeping defaults"))
})

test("mergeSecretsPatch: an unknown sub-key is ignored with a warning", () => {
  const { config, warnings } = mergeConfig(defaultConfig({}), { secrets: { mode: "off" } })
  assert.equal(config.secrets.writeGuard, "advise")
  assert.ok(warnings.includes('config: unknown secrets key "mode" ignored'))
})

test("mergeSecretsPatch: a non-array patterns value keeps the default", () => {
  const { config, warnings } = mergeConfig(defaultConfig({}), { secrets: { patterns: "x" } })
  assert.deepEqual(config.secrets.patterns, [])
  assert.ok(
    warnings.includes(
      "config: secrets.patterns must be an array of non-empty strings; keeping default",
    ),
  )
})

test("mergeSecretsPatch: non-string and non-compiling elements are dropped individually", () => {
  const { config, warnings } = mergeConfig(defaultConfig({}), {
    secrets: { patterns: [42, "myorg-[A-Za-z0-9{16,}", "  ", "ok-[A-Za-z]{4}"] },
  })
  assert.deepEqual(config.secrets.patterns, ["ok-[A-Za-z]{4}"])
  assert.ok(
    warnings.includes("config: secrets.patterns[0] is not a non-empty string; dropping element"),
  )
  assert.ok(warnings.includes("config: secrets.patterns[1] is not a valid regex; dropping element"))
  assert.ok(
    warnings.includes("config: secrets.patterns[2] is not a non-empty string; dropping element"),
  )
})

test("mergeSecretsPatch: an invalid writeGuard literal keeps the default", () => {
  const { config, warnings } = mergeConfig(defaultConfig({}), {
    secrets: { writeGuard: "block" },
  })
  assert.equal(config.secrets.writeGuard, "advise")
  assert.ok(
    warnings.includes(
      'config: secrets.writeGuard must be "off", "advise", or "enforce"; keeping default',
    ),
  )
})

test("mergeSecretsPatch: a non-boolean entropy keeps the default", () => {
  const { config, warnings } = mergeConfig(defaultConfig({}), { secrets: { entropy: "yes" } })
  assert.equal(config.secrets.entropy, false)
  assert.ok(warnings.includes("config: secrets.entropy must be a boolean; keeping default"))
})

test("mergeSecretsPatch: a valid block merges one level deep and is copied", () => {
  const { config } = mergeConfig(defaultConfig({}), {
    secrets: { patterns: ["myorg-[A-Za-z0-9]{16,}"], writeGuard: "enforce", entropy: true },
  })
  assert.deepEqual(config.secrets, {
    patterns: ["myorg-[A-Za-z0-9]{16,}"],
    writeGuard: "enforce",
    entropy: true,
  })
})

// ── guard decision matrix ────────────────────────────────────────────────────

test("guardSecretWrite: mode off is a full no-op even for matching content", () => {
  const { policy, entries, stashed } = makePolicy({ writeGuard: "off" })
  policy.guardSecretWrite("write", "token: supersecretvalue1", "s1", stashOf(stashed))
  assert.deepEqual(entries, [])
  assert.deepEqual(stashed, [])
})

test("guardSecretWrite: an empty compiled list is a no-op", () => {
  const { policy, entries, stashed } = makePolicy(undefined, [])
  policy.guardSecretWrite("write", "token: supersecretvalue1", "s1", stashOf(stashed))
  assert.deepEqual(entries, [])
  assert.deepEqual(stashed, [])
})

test("guardSecretWrite: empty or non-string content is a silent no-op", () => {
  const { policy, entries, stashed } = makePolicy()
  policy.guardSecretWrite("write", "", "s1", stashOf(stashed))
  policy.guardSecretWrite("edit", undefined, "s1", stashOf(stashed))
  policy.guardSecretWrite("edit", 42, "s1", stashOf(stashed))
  assert.deepEqual(entries, [])
  assert.deepEqual(stashed, [])
})

test("guardSecretWrite: advise mode journals one advisory row and stashes the nudge", () => {
  const { policy, entries, stashed } = makePolicy()
  policy.guardSecretWrite("write", "token: supersecretvalue1", "s1", stashOf(stashed))
  assert.deepEqual(entries, [
    { type: "tool", sessionID: "s1", tool: "write", secretWrite: true, pattern: 8 },
  ])
  assert.deepEqual(stashed, [
    "[turnstile] advisory: this write matches secret pattern 8; move secrets to a secret manager or env injection",
  ])
})

test("guardSecretWrite: advise mode with no match is silent", () => {
  const { policy, entries, stashed } = makePolicy()
  policy.guardSecretWrite("write", "just some prose", "s1", stashOf(stashed))
  assert.deepEqual(entries, [])
  assert.deepEqual(stashed, [])
})

test("guardSecretWrite: enforce mode journals the block and throws the BlockError", () => {
  const { policy, entries, stashed } = makePolicy({ writeGuard: "enforce" })
  assert.throws(
    () => policy.guardSecretWrite("write", "token: supersecretvalue1", "s1", stashOf(stashed)),
    (e: unknown) =>
      e instanceof BlockError &&
      e.message ===
        "BLOCKED by turnstile: write blocked: content matches a configured secret pattern (index 8); move the secret out of the written content",
  )
  assert.deepEqual(entries, [
    { type: "blocked", sessionID: "s1", tool: "write", reason: "secret-write", pattern: 8 },
  ])
  assert.deepEqual(stashed, [])
})

test("guardSecretWrite: enforce mode with no match is silent", () => {
  const { policy, entries, stashed } = makePolicy({ writeGuard: "enforce" })
  policy.guardSecretWrite("write", "just some prose", "s1", stashOf(stashed))
  assert.deepEqual(entries, [])
  assert.deepEqual(stashed, [])
})

test("guardSecretWrite: entropy on flags a high-entropy write advisory-only", () => {
  const { policy, entries, stashed } = makePolicy({ entropy: true })
  policy.guardSecretWrite("write", `key ${HIGH_ENTROPY_RUN} end`, "s1", stashOf(stashed))
  assert.deepEqual(entries, [
    { type: "tool", sessionID: "s1", tool: "write", secretWrite: true, entropy: true },
  ])
  assert.deepEqual(stashed, [
    "[turnstile] advisory: this write contains a high-entropy literal; move secrets to a secret manager or env injection",
  ])
})

test("guardSecretWrite: entropy never blocks even under enforce", () => {
  const { policy, entries, stashed } = makePolicy({ entropy: true, writeGuard: "enforce" })
  policy.guardSecretWrite("write", `key ${HIGH_ENTROPY_RUN} end`, "s1", stashOf(stashed))
  assert.deepEqual(entries, [
    { type: "tool", sessionID: "s1", tool: "write", secretWrite: true, entropy: true },
  ])
})

test("guardSecretWrite: entropy off leaves a no-match write silent", () => {
  const { policy, entries, stashed } = makePolicy()
  policy.guardSecretWrite("write", `key ${HIGH_ENTROPY_RUN} end`, "s1", stashOf(stashed))
  assert.deepEqual(entries, [])
  assert.deepEqual(stashed, [])
})

test("guardSecretWrite: entropy on with no qualifying literal is silent", () => {
  const { policy, entries, stashed } = makePolicy({ entropy: true })
  policy.guardSecretWrite("write", "plain prose, no literals", "s1", stashOf(stashed))
  assert.deepEqual(entries, [])
  assert.deepEqual(stashed, [])
})

test("guardSecretWrite: an internal error fails open with a journaled error", () => {
  const { policy, entries } = makePolicy()
  policy.guardSecretWrite("write", "token: supersecretvalue1", "s1", () => {
    throw new Error("stash blew up")
  })
  const error = entries.find((e) => e.type === "error")
  assert.ok(error)
  assert.match(error!.error, /tool policy guard: Error: stash blew up/)
})

// ── end-to-end wiring ────────────────────────────────────────────────────────

/** Creates a fresh hooks-core context over an isolated env and temp metrics dir. */
function coreWith(config: Partial<TurnstileConfig>): { ctx: TurnstileContext; metricsDir: string } {
  const metricsDir = tmpDir()
  const ctx = createHooksCore({
    env: isolatedEnv(metricsDir),
    config: { metricsDir, alwaysEnforce: false, ...config },
  })
  return { ctx, metricsDir }
}

/** The secret-write journal rows of a metrics dir, with `ts` omitted. */
function secretRowsOf(metricsDir: string): Array<Record<string, any>> {
  return journalEntries(metricsDir)
    .filter((e) => e.secretWrite === true)
    .map(({ ts: _ts, ...rest }) => rest)
}

test("wiring: the write arm scans input.content and the edit arm scans input.newString", () => {
  const { ctx, metricsDir } = coreWith({})
  ctx.handleWriteEditDispatch(
    {
      tool: "write",
      sessionID: "p1",
      input: { filePath: "/r/a.ts", content: "token: supersecretvalue1" },
    } as any,
    "write",
  )
  ctx.handleWriteEditDispatch(
    {
      tool: "edit",
      sessionID: "p1",
      input: { filePath: "/r/a.ts", newString: "api_key=supersecretvalue1" },
    } as any,
    "edit",
  )
  assert.deepEqual(secretRowsOf(metricsDir), [
    { type: "tool", sessionID: "p1", tool: "write", secretWrite: true, pattern: 8 },
    { type: "tool", sessionID: "p1", tool: "edit", secretWrite: true, pattern: 7 },
  ])
  assert.equal(
    ctx.planImpactAdvisories.get("p1"),
    "[turnstile] advisory: this write matches secret pattern 7; move secrets to a secret manager or env injection",
  )
})

test("wiring: the bash arm scans the command text including a heredoc body", () => {
  const { ctx, metricsDir } = coreWith({})
  ctx.handleBashDispatch(
    {
      tool: "bash",
      sessionID: "p1",
      input: {
        command: "cat > /r/env.sh <<'EOF'\nexport API_KEY=supersecretvalue1\nEOF",
      },
    } as any,
    "bash",
  )
  assert.deepEqual(secretRowsOf(metricsDir), [
    { type: "tool", sessionID: "p1", tool: "bash", secretWrite: true, pattern: 7 },
  ])
})

test("wiring: a pipeline child's write is guarded too (the exfil case)", () => {
  const { ctx, metricsDir } = coreWith({})
  ctx.ledger.childToParent.set("c1", "p1")
  ctx.handleWriteEditDispatch(
    {
      tool: "write",
      sessionID: "c1",
      agent: "executor",
      input: { filePath: "/r/a.ts", content: "token: supersecretvalue1" },
    } as any,
    "write",
  )
  assert.deepEqual(secretRowsOf(metricsDir), [
    { type: "tool", sessionID: "c1", tool: "write", secretWrite: true, pattern: 8 },
  ])
  // The nudge lands on the child's parent, the next delivery's reader.
  assert.match(ctx.planImpactAdvisories.get("p1")!, /secret pattern 8/)
})

test("wiring: enforce mode blocks the write at dispatch", () => {
  const { ctx } = coreWith({
    secrets: { patterns: [], writeGuard: "enforce", entropy: false },
  })
  assert.throws(
    () =>
      ctx.handleWriteEditDispatch(
        {
          tool: "write",
          sessionID: "p1",
          input: { filePath: "/r/a.ts", content: "token: supersecretvalue1" },
        } as any,
        "write",
      ),
    (e: unknown) =>
      e instanceof BlockError && /BLOCKED by turnstile: write blocked/.test(e.message),
  )
})

test("wiring: a configured extra pattern redacts in the ledger capture", () => {
  const { ctx, metricsDir } = coreWith({
    secrets: { patterns: ["myorg-[A-Za-z0-9]{16,}"], writeGuard: "advise", entropy: false },
  })
  ctx.admitPrompt("p1", { text: "ship myorg-abcdef0123456789ab now" }, "")
  const stated = journalEntries(metricsDir).find((e) => e.type === "prov:stated")
  assert.equal(stated!.text, `ship ${REDACTION_SENTINEL} now`)
})

test("wiring: the default redaction path is unchanged by the secrets block", () => {
  const { ctx, metricsDir } = coreWith({})
  ctx.admitPrompt("p1", { text: "deploy AKIAIOSFODNN7EXAMPLE now" }, "")
  const stated = journalEntries(metricsDir).find((e) => e.type === "prov:stated")
  assert.equal(stated!.text, "deploy [REDACTED] now")
})
