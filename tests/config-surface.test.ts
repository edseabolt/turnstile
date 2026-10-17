/**
 * @fileoverview Config-warning surfacing contract tests: the once-per-load
 * `[turnstile] config:` block is prepended to the first tool result carrying
 * string output when the resolved config produced warnings, journaled as a
 * `type:"config"` surface audit, and fail-open on a throwing mutation. A clean
 * config leaves every output byte-identical and journals no `config` entry, so
 * the existing injection suite stays green. This file redirects XDG_DATA_HOME
 * to a temp dir before importing the plugin so the pre-journaler config-error
 * sink never touches the user's real journal.
 */

import { test } from "node:test"
import assert from "node:assert/strict"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"

// Every plugin load below (and the pre-journaler config sink it drives)
// resolves XDG live at call time, so redirecting before the tests run keeps
// the config-error journal out of the user's real metrics directory.
const xdgTmp = fs.mkdtempSync(path.join(os.tmpdir(), "turnstile-xdg-"))
process.env.XDG_DATA_HOME = xdgTmp

import { turnstile } from "../turnstile.ts"
import { ORCHESTRATOR_POLICY } from "../src/policy.ts"
import {
  callTool,
  isolatedEnv,
  journalEntries,
  makeFakeHost,
  tmpDir,
  type FakeHost,
} from "./helpers.ts"

/** Boots the plugin over a fake host with a temp metrics dir and the given
 *  config override. */
async function boot(
  config: Record<string, unknown> = {},
): Promise<{ h: FakeHost; dispose: () => void; metricsDir: string }> {
  const metricsDir = tmpDir()
  const h = makeFakeHost()
  const setup = turnstile(h.host, {
    env: isolatedEnv(metricsDir),
    config: { metricsDir, ...config },
  })
  const dispose = (await setup(h.host)) as () => void
  return { h, dispose, metricsDir }
}

/** A deterministic single-warning trigger: a typo'd (unknown) key. */
const WARNING_CONFIG: Record<string, unknown> = { maxSesssions: 5 }

/** (12) A config that produced a warning surfaces once: the first string-output
 *  result is prefixed with the block (warning text + journal path), the original
 *  output is preserved, and exactly one `config` journal entry reports
 *  `surfaced:true` with the warning count. */
test("config surfacing: injected warnings surface once with the journal path", async () => {
  const { h, dispose, metricsDir } = await boot(WARNING_CONFIG)
  try {
    const event = { tool: "read", sessionID: "s1", result: { output: "body" } }
    await callTool(h, "execute.after", event)
    const out = String(event.result.output)
    assert.ok(out.startsWith("[turnstile] config:"), "the output is warning-prefixed")
    assert.ok(out.includes("maxSesssions"), "the surfaced warning names the typo'd key")
    assert.ok(
      out.includes(path.join(metricsDir, "turnstile.jsonl")),
      "the journal path is present in the header",
    )
    assert.ok(out.endsWith("body"), "the original output is preserved")
    const configEntries = journalEntries(metricsDir).filter((l) => l.type === "config")
    assert.equal(configEntries.length, 1, "exactly one config journal entry")
    assert.equal(configEntries[0]!.surfaced, true, "the entry reports surfaced:true")
    assert.equal(configEntries[0]!.count, 1, "the entry counts the one warning")
  } finally {
    dispose()
  }
})

/** (13) The block is once-per-load: a fresh second delivery is left untouched
 *  (the flag is consumed, so no second prepend) and journals no second
 *  `config` entry. */
test("config surfacing: a second delivery is untouched (flag consumed)", async () => {
  const { h, dispose, metricsDir } = await boot(WARNING_CONFIG)
  try {
    const first = { tool: "read", sessionID: "s1", result: { output: "body" } }
    await callTool(h, "execute.after", first)
    assert.ok(
      String(first.result.output).startsWith("[turnstile] config:"),
      "the first delivery is prefixed",
    )
    const second = { tool: "read", sessionID: "s1", result: { output: "body" } }
    await callTool(h, "execute.after", second)
    assert.equal(String(second.result.output), "body", "the second delivery is untouched")
    assert.equal(
      journalEntries(metricsDir).filter((l) => l.type === "config").length,
      1,
      "still exactly one config journal entry",
    )
  } finally {
    dispose()
  }
})

/** (14) A non-string `result.output` leaves the block pending and journals
 *  nothing; a later string-output event still surfaces. */
test("config surfacing: non-string output keeps the block pending, no entry", async () => {
  const { h, dispose, metricsDir } = await boot(WARNING_CONFIG)
  try {
    const nonString = { tool: "read", sessionID: "s1", result: { output: 42 } }
    await callTool(h, "execute.after", nonString)
    assert.equal(String(nonString.result.output), "42", "a non-string result is untouched")
    assert.equal(
      journalEntries(metricsDir).filter((l) => l.type === "config").length,
      0,
      "no entry for a non-string result",
    )
    const later = { tool: "read", sessionID: "s1", result: { output: "body" } }
    await callTool(h, "execute.after", later)
    assert.ok(String(later.result.output).startsWith("[turnstile] config:"))
    assert.equal(
      journalEntries(metricsDir).filter((l) => l.type === "config").length,
      1,
      "the later string-output event surfaces",
    )
  } finally {
    dispose()
  }
})

/** (15) A clean config leaves every `execute.after` output byte-identical and
 *  journals no `config` entry. */
test("config surfacing: a clean config leaves every output byte-identical", async () => {
  const { h, dispose, metricsDir } = await boot()
  try {
    for (const tool of ["read", "shell", "bash"]) {
      const event = { tool, sessionID: `c-${tool}`, result: { output: "raw" } }
      await callTool(h, "execute.after", event)
      assert.equal(String(event.result.output), "raw", `${tool} output untouched`)
    }
    assert.equal(
      journalEntries(metricsDir).filter((l) => l.type === "config").length,
      0,
      "no config entry for a clean config",
    )
  } finally {
    dispose()
  }
})

/** (16) A hostile `result` whose mutation throws is journaled `surfaced:false`,
 *  never re-thrown, and keeps the block pending for a later delivery. */
test("config surfacing: a hostile result whose mutation throws fails open", async () => {
  const { h, dispose, metricsDir } = await boot(WARNING_CONFIG)
  try {
    let threw = false
    try {
      // A frozen result: assigning the prefaced value throws in strict mode.
      await callTool(h, "execute.after", {
        tool: "read",
        sessionID: "s1",
        result: Object.freeze({ output: "frozen-body" }),
      })
    } catch {
      threw = true
    }
    assert.equal(threw, false, "the hook completes even when the mutation throws")
    const configEntries = journalEntries(metricsDir).filter((l) => l.type === "config")
    assert.equal(configEntries.length, 1, "the failure is journaled")
    assert.equal(configEntries[0]!.surfaced, false, "the entry reports surfaced:false")
    assert.match(String(configEntries[0]!.error ?? ""), /.+/, "an error string is recorded")
    // The flag stayed pending: a later string-output event still surfaces.
    const later = { tool: "read", sessionID: "s1", result: { output: "body" } }
    await callTool(h, "execute.after", later)
    assert.ok(String(later.result.output).startsWith("[turnstile] config:"))
  } finally {
    dispose()
  }
})

/** (17) On a task delivery carrying both surfaces, the policy prepend lands on
 *  top: the output reads ORCHESTRATOR_POLICY, then the `[turnstile] config:`
 *  block, then the child's own output — one policy and one config journal
 *  entry each. */
test("config surfacing: on a task delivery the policy lands above the config block", async () => {
  const { h, dispose, metricsDir } = await boot(WARNING_CONFIG)
  try {
    const event = { tool: "task", sessionID: "p1", result: { output: "child-body" } }
    await callTool(h, "execute.after", event)
    const out = String(event.result.output)
    assert.ok(out.startsWith(ORCHESTRATOR_POLICY), "the policy is on top")
    assert.ok(out.includes("[turnstile] config:"), "the config block is present")
    const policyIdx = out.indexOf(ORCHESTRATOR_POLICY)
    const configIdx = out.indexOf("[turnstile] config:")
    const bodyIdx = out.indexOf("child-body")
    assert.ok(
      policyIdx < configIdx && configIdx < bodyIdx,
      "policy precedes the config block precedes the child output",
    )
    assert.equal(
      journalEntries(metricsDir).filter((l) => l.type === "policy").length,
      1,
      "exactly one policy entry",
    )
    assert.equal(
      journalEntries(metricsDir).filter((l) => l.type === "config").length,
      1,
      "exactly one config entry",
    )
  } finally {
    dispose()
  }
})

/** (18) The block keys off the first string-output delivery, not session
 *  identity: a first delivery from an unregistered session id consumes the
 *  flag, journals one `config` entry with `surfaced:true`, and preserves the
 *  original output. Fixture caveat: the fake host registers no parent edges,
 *  so this fixture cannot distinguish a child from a primary session — the
 *  test pins the documented any-delivery contract, not child-specific
 *  handling. */
test("config surfacing: the first delivery from an unregistered session consumes the flag", async () => {
  const { h, dispose, metricsDir } = await boot(WARNING_CONFIG)
  try {
    const event = { tool: "read", sessionID: "child-1", result: { output: "body" } }
    await callTool(h, "execute.after", event)
    const out = String(event.result.output)
    assert.ok(
      out.startsWith("[turnstile] config:"),
      "the unregistered session's output is prefixed",
    )
    assert.ok(out.endsWith("body"), "the original output is preserved")
    const configEntries = journalEntries(metricsDir).filter((l) => l.type === "config")
    assert.equal(configEntries.length, 1, "exactly one config journal entry")
    assert.equal(configEntries[0]!.surfaced, true, "the entry reports surfaced:true")
  } finally {
    dispose()
  }
})
