/**
 * @fileoverview Fail-open and error-path tests: every uncovered defensive
 * branch in the plugin (hook-registration failures, hostile hook payloads,
 * unreadable plans dirs and journals, broken telemetry sinks, bounds
 * eviction, and the legacy module shim) is driven here and must journal or
 * stay silent instead of throwing, per the fail-open contract.
 */

import { test } from "node:test"
import assert from "node:assert/strict"
import * as fs from "node:fs"
import * as path from "node:path"

import turnstileModule, { turnstile } from "../turnstile.ts"
import { readPluginVersion } from "../src/setup.ts"
import { validateResolved, defaultConfig } from "../src/config.ts"
import { createGates } from "../src/gates.ts"
import { createJournaler, appendLine } from "../src/journal.ts"
import { parseGateMarkers, agentFromTaskInput } from "../src/markers.ts"
import { createLedger, newState } from "../src/state.ts"
import { createEvidenceTracker } from "../src/evidence.ts"
import { createToolPolicy } from "../src/tool-policy.ts"
import type { Host, StreamEvent } from "../src/types.ts"
import {
  callSession,
  callTool,
  isolatedEnv,
  journalEntries,
  makeFakeHost,
  tmpDir,
  type FakeHost,
} from "./helpers.ts"

const APPROVE = "VERDICT: APPROVE crit=0 high=0 med=0 low=0"

/** A fresh default config (XDG untouched; nothing writes to the real env). */
const cfg = (): ReturnType<typeof defaultConfig> => defaultConfig()

/** A pass-through parent resolver: every raw session resolves to itself. */
const identityParent = (raw: string): string => raw

/** Gives the async event loop a tick to drain queued stream events. */
const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 30))

/** Boots a plugin on a host in a temp metrics dir, returning the pieces. */
async function boot(
  host: Host = makeFakeHost().host,
): Promise<{ dispose: () => void; metricsDir: string }> {
  const metricsDir = tmpDir()
  const setup = turnstile(host, { env: isolatedEnv(metricsDir), config: { metricsDir } })
  const dispose = (await setup(host)) as () => void
  return { dispose, metricsDir }
}

/**
 * A host that throws from `session.hook`/`tool.hook` for the given hook
 * names and delegates everything else to a fake host.
 * @param failNames Hook names that throw at registration.
 * @returns The fake host tables plus the failing host.
 */
function makeThrowingRegHost(failNames: string[]): { h: FakeHost; host: Host } {
  const h = makeFakeHost()
  const base = h.host
  const host: Host = {
    tool: {
      hook: async (name: string, cb: any): Promise<unknown> => {
        if (failNames.includes(name)) throw new Error(`registration boom: ${name}`)
        return base.tool?.hook?.(name, cb)
      },
    },
    session: {
      hook: async (name: string, cb: any): Promise<unknown> => {
        if (failNames.includes(name)) throw new Error(`registration boom: ${name}`)
        return base.session?.hook?.(name, cb)
      },
      get: base.session?.get,
    },
    event: base.event,
  }
  return { h, host }
}

/** The legacy module shape: id stays "turnstile", server resolves empty. */
test("module shim: id, server(), and setup() all work", async () => {
  assert.equal(turnstileModule.id, "turnstile")
  assert.deepEqual(await turnstileModule.server(), {})
  const h = makeFakeHost()
  const metricsDir = tmpDir()
  const dispose = (await turnstileModule.setup(h.host, {
    env: isolatedEnv(metricsDir),
    config: { metricsDir },
  })) as () => void
  assert.ok(typeof dispose === "function")
  dispose()
})

/** appendLine swallows a write whose parent directory path is a file. */
test("appendLine never throws when the parent path is a file", () => {
  const dir = tmpDir()
  const blocker = path.join(dir, "notadir")
  fs.writeFileSync(blocker, "x")
  appendLine(path.join(blocker, "child.jsonl"), "hello")
  assert.equal(fs.existsSync(path.join(blocker, "child.jsonl")), false)
})

/** A traceEvent without a session ID keeps the four documented segments. */
test("traceEvent without a session ID omits the trailing segment", () => {
  const metricsDir = tmpDir()
  const j = createJournaler({
    metricsDir,
    trace: true,
    maxBytes: 1024 * 1024,
    maxGenerations: 1,
  })
  j.traceEvent("agent", "event", "detail")
  const line = fs.readFileSync(path.join(metricsDir, "gate-events.jsonl"), "utf8").trim()
  assert.equal(line.split("|").length, 4)
})

/** plansSignature fails open (null) when the plans dir is unreadable. */
test("plansSignature fails open on an unreadable plans dir", () => {
  const project = tmpDir()
  const plans = path.join(project, ".opencode", "plans")
  fs.mkdirSync(plans, { recursive: true })
  const metricsDir = tmpDir()
  const g = createGates(
    defaultConfig(),
    createJournaler({ metricsDir, trace: false, maxBytes: 1e6, maxGenerations: 1 }),
  )
  fs.chmodSync(plans, 0o000)
  try {
    assert.equal(g.plansSignature(project), null)
  } finally {
    fs.chmodSync(plans, 0o755)
  }
  const errors = journalEntries(metricsDir).filter((e) => e.type === "error")
  assert.ok(errors.some((e) => String(e.error).includes("plans dir unreadable")))
})

/** Journal replay fails open when the journal path is a directory. */
test("createLedger fails open when the journal path is unreadable", () => {
  const dir = tmpDir()
  const ledger = createLedger(dir, 64)
  const s = ledger.state("p1")
  assert.equal(s.hasGatePass, false)
  assert.equal(s.reads, 0)
})

/** A telemetry sink that throws on a block never breaks the guards. */
test("tool-policy guards journal their internal failure when the sink throws", () => {
  const metricsDir = tmpDir()
  const inner = createJournaler({ metricsDir, trace: false, maxBytes: 1e6, maxGenerations: 1 })
  const hostile = {
    journal: (entry: Record<string, unknown>): void => {
      if (entry.reason === "tool-policy") throw new Error("sink down")
      inner.journal(entry)
    },
  } as unknown as Parameters<typeof createToolPolicy>[1]
  const config = defaultConfig()
  config.toolPolicy = {
    mode: "enforce",
    bashDeny: ["git\\s+push"],
    pathDeny: ["\\.env$"],
    observeSessionMove: false,
  }
  const policy = createToolPolicy(config, hostile)
  assert.doesNotThrow(() => policy.guardBash("bash", "git push origin main", "p1"))
  assert.doesNotThrow(() => policy.guardPath("edit", "/repo/.env", "p1"))
  const errors = journalEntries(metricsDir).filter((e) => e.type === "error")
  assert.ok(errors.some((e) => String(e.error).includes("tool policy guard")))
})

/**
 * The git-side guards (guardCommitMessage/observeLanding/guardLanding) carry the
 * same fail-open contract: a telemetry sink that throws on their block and
 * landing-telemetry entries must never break tool calls. Each is journaled as an
 * internal error, and the landing-gate capability here is a plain stub (the real
 * one lives in setup.ts).
 */
test("git-side guards journal their internal failure when the sink throws", () => {
  const metricsDir = tmpDir()
  const inner = createJournaler({ metricsDir, trace: false, maxBytes: 1e6, maxGenerations: 1 })
  const hostile = {
    journal: (entry: Record<string, unknown>): void => {
      // The guard's primary journal (blocked entry / landing telemetry) throws;
      // the fail-open error journal (type:"error") is unaffected, so recovery
      // itself succeeds.
      if (entry.type === "blocked" || entry.landing === true) throw new Error("sink down")
      inner.journal(entry)
    },
  } as unknown as Parameters<typeof createToolPolicy>[1]
  const config = defaultConfig()
  config.toolPolicy = { mode: "enforce", bashDeny: [], pathDeny: [], observeSessionMove: false }
  const policy = createToolPolicy(config, hostile)
  const stub = {
    hasApproval: (): boolean => false,
    priorBlocks: (): number => 0,
    recordBlock: (): void => {},
    escalate: (): void => {},
  }
  assert.doesNotThrow(() => policy.guardCommitMessage("bash", 'git commit -m "garbage"', "p1"))
  assert.doesNotThrow(() => policy.observeLanding("p1", "git push origin main"))
  assert.doesNotThrow(() => policy.guardLanding("bash", "git push origin main", "p1", stub))
  const errors = journalEntries(metricsDir).filter((e) => e.type === "error")
  assert.equal(errors.length, 3)
  assert.ok(errors.every((e) => String(e.error).includes("tool policy guard")))
})

/** observeSessionMove: false disables the telemetry entirely. */
test("observeSessionMove is a no-op when disabled and redacts under trace:false", () => {
  const metricsDir = tmpDir()
  const j = createJournaler({ metricsDir, trace: false, maxBytes: 1e6, maxGenerations: 1 })
  const config = defaultConfig()
  config.trace = false
  config.toolPolicy = { mode: "enforce", bashDeny: [], pathDeny: [], observeSessionMove: false }
  const policy = createToolPolicy(config, j)
  policy.observeSessionMove("p1", "/tmp/somewhere")
  assert.equal(journalEntries(metricsDir).length, 0)
  config.toolPolicy.observeSessionMove = true
  const policy2 = createToolPolicy(config, j)
  policy2.observeSessionMove("p1", "/tmp/somewhere")
  const entries = journalEntries(metricsDir)
  assert.equal(entries.length, 1)
  assert.equal(entries[0]!.directory, "<redacted>")
})

/** validateResolved warns on a relative metricsDir (reachable only directly). */
test("validateResolved clamps readWarn and warns on a relative metricsDir", () => {
  const config = defaultConfig()
  config.readWarn = 15
  config.readBlock = 15
  config.metricsDir = "relative/dir"
  const warnings = validateResolved(config)
  assert.equal(config.readWarn, 14)
  assert.equal(warnings.length, 2)
  assert.ok(warnings.some((w) => w.includes("readWarn")))
  assert.ok(warnings.some((w) => w.includes("relative")))
})

/** readPluginVersion returns null when package.json is unreadable. */
test("readPluginVersion returns null when package.json cannot be read", () => {
  // A directory path makes readFileSync fail with EISDIR, the same catch a
  // bare setup.ts + src/ copy hits when package.json is absent.
  assert.equal(readPluginVersion(tmpDir()), null)
})

/** The failed-lookup bound evicts its oldest entries past 256 sessions. */
test("boundLookups evicts failed-lookup entries past the cap", async () => {
  const h = makeFakeHost({ throwingGet: true })
  const { dispose } = await boot(h.host)
  try {
    for (let i = 0; i < 257; i++) {
      h.pushEvent({ type: "session.text.delta", properties: { sessionID: `s${i}`, delta: "x" } })
    }
    await settle()
  } finally {
    dispose()
  }
})

/** The dispatch-timestamp bound evicts its oldest entries past 256 parents. */
test("boundDispatches evicts plan-reviewer dispatch stamps past the cap", async () => {
  const h = makeFakeHost()
  const { dispose } = await boot(h.host)
  try {
    for (let i = 0; i < 257; i++) {
      await callTool(h, "execute.before", {
        tool: "task",
        sessionID: `p${i}`,
        input: { agent: "plan-reviewer", prompt: "review" },
      })
    }
  } finally {
    dispose()
  }
})

/** An internal error inside execute.before journals instead of blocking. */
test("execute.before journals an internal error and proceeds", async () => {
  const h = makeFakeHost()
  const { dispose, metricsDir } = await boot(h.host)
  try {
    const input: Record<string, unknown> = {}
    Object.defineProperty(input, "subagent_type", {
      get() {
        throw new Error("hostile input")
      },
    })
    await callTool(h, "execute.before", { tool: "task", sessionID: "p1", input })
    const errors = journalEntries(metricsDir).filter((e) => e.type === "error")
    assert.ok(errors.some((e) => String(e.error).includes("tool.execute.before")))
  } finally {
    dispose()
  }
})

/** An internal error inside execute.after journals instead of blocking. */
test("execute.after journals an internal error and proceeds", async () => {
  const h = makeFakeHost()
  const { dispose, metricsDir } = await boot(h.host)
  try {
    const result: Record<string, unknown> = {}
    Object.defineProperty(result, "output", {
      get() {
        throw new Error("hostile result")
      },
    })
    await callTool(h, "execute.after", {
      tool: "task",
      sessionID: "c1",
      input: { agent: "executor" },
      result,
    })
    const errors = journalEntries(metricsDir).filter((e) => e.type === "error")
    assert.ok(errors.some((e) => String(e.error).includes("tool.execute.after")))
  } finally {
    dispose()
  }
})

/** A hostile generate draft journals and never throws. */
test("generate hook journals an internal error from a hostile draft", async () => {
  const h = makeFakeHost()
  const { dispose, metricsDir } = await boot(h.host)
  try {
    const draft: Record<string, unknown> = {}
    Object.defineProperty(draft, "agent", {
      get() {
        throw new Error("hostile draft")
      },
    })
    await callSession(h, "generate", draft)
    const errors = journalEntries(metricsDir).filter((e) => e.type === "error")
    assert.ok(errors.some((e) => String(e.error).includes("generate hook")))
  } finally {
    dispose()
  }
})

/** The compaction hook appends the preserve-verbatim instruction. */
test("compaction hook injects the preserve-verbatim instruction", async () => {
  const h = makeFakeHost()
  const { dispose } = await boot(h.host)
  try {
    const draft: { system?: Array<{ type: string; text?: string }> } = { system: [] }
    await callSession(h, "compaction", draft)
    assert.equal(draft.system?.length, 1)
    assert.match(draft.system?.[0]?.text ?? "", /Preserve verbatim/)
    // A draft without a system array is left alone.
    await callSession(h, "compaction", {})
  } finally {
    dispose()
  }
})

/** A hostile compaction draft (a throwing push) journals and never throws. */
test("compaction hook journals an internal error from a hostile draft", async () => {
  const h = makeFakeHost()
  const { dispose, metricsDir } = await boot(h.host)
  try {
    const hostile: { type: string; text?: string }[] = []
    Object.defineProperty(hostile, "push", {
      get() {
        throw new Error("hostile push")
      },
    })
    await callSession(h, "compaction", { system: hostile })
    const errors = journalEntries(metricsDir).filter((e) => e.type === "error")
    assert.ok(errors.some((e) => String(e.error).includes("compaction hook")))
  } finally {
    dispose()
  }
})

/** A subscribe() that throws journals the subscription error. */
test("event subscription failure journals and does not crash setup", async () => {
  const h = makeFakeHost()
  const throwingHost: Host = {
    ...h.host,
    event: {
      subscribe: (): AsyncIterable<never> => {
        throw new Error("subscribe boom")
      },
    },
  }
  const { dispose, metricsDir } = await boot(throwingHost)
  await settle()
  dispose()
  const errors = journalEntries(metricsDir).filter((e) => e.type === "error")
  assert.ok(errors.some((e) => String(e.error).includes("event subscription")))
})

/** Registration failures journal and leave the plugin functional. */
test("hook registration failures journal per hook and do not crash setup", async () => {
  for (const name of ["prompt", "generate", "compaction"]) {
    const { host } = makeThrowingRegHost([name])
    const { dispose, metricsDir } = await boot(host)
    dispose()
    const errors = journalEntries(metricsDir).filter((e) => e.type === "error")
    assert.ok(
      errors.some((e) => String(e.error).includes(`${name} hook registration`)),
      `expected a registration error for ${name}`,
    )
  }
})

/** Tool-hook registration failures journal and do not crash setup. */
test("tool hook registration failures journal and do not crash setup", async () => {
  for (const name of ["execute.before", "execute.after"]) {
    const { host } = makeThrowingRegHost([name])
    const { dispose, metricsDir } = await boot(host)
    dispose()
    const errors = journalEntries(metricsDir).filter((e) => e.type === "error")
    assert.ok(
      errors.some((e) =>
        String(e.error).includes(`${name.replace("execute.", "")} hook registration`),
      ),
      `expected a registration error for ${name}`,
    )
  }
})

/** A stream that ends without an abort journals the stream-death signal. */
test("event stream ending without abort journals a stream-ended error", async () => {
  const h = makeFakeHost()
  const finiteHost: Host = {
    ...h.host,
    event: {
      subscribe: async function* (): AsyncIterable<StreamEvent> {
        // Ends immediately: a silent death mode the plugin must journal.
      },
    },
  }
  const { dispose, metricsDir } = await boot(finiteHost)
  await settle()
  dispose()
  const errors = journalEntries(metricsDir).filter((e) => e.type === "error")
  assert.ok(errors.some((e) => String(e.error) === "event stream ended"))
})

/** A disposer whose hook cleanup throws stays inert. */
test("dispose failures are inert", async () => {
  const h = makeFakeHost()
  const base = h.host
  const throwingDisposeHost: Host = {
    ...base,
    tool: {
      hook: async (name: string): Promise<unknown> => ({
        dispose: (): void => {
          throw new Error(`dispose boom: ${name}`)
        },
      }),
    },
  }
  const { dispose } = await boot(throwingDisposeHost)
  assert.doesNotThrow(() => dispose())
})

/** The states cap tolerates over-cap when every entry is a protected parent. */
test("ledger keeps protected parents over the session cap", () => {
  const dir = tmpDir()
  fs.writeFileSync(path.join(dir, "turnstile.jsonl"), "")
  const ledger = createLedger(path.join(dir, "turnstile.jsonl"), 1)
  ledger.markParent("a")
  ledger.markParent("b")
  ledger.state("a")
  ledger.state("b") // insert-time cap: a and b protected, over-cap tolerated
  assert.ok(ledger.peek("a"))
  assert.ok(ledger.peek("b"))
  // An unregistered session is evictable: c evicts the oldest unprotected.
  ledger.state("c")
  assert.ok(ledger.peek("a"))
  assert.ok(ledger.peek("b"))
})

/** parentOf maps nullish input to "" and unknown sessions to themselves. */
test("ledger.parentOf handles nullish and unknown ids", () => {
  const ledger = createLedger(path.join(tmpDir(), "j.jsonl"), 64)
  assert.equal(ledger.parentOf(undefined as unknown as string), "")
  assert.equal(ledger.parentOf(""), "")
  assert.equal(ledger.parentOf("solo"), "solo")
})

/** parseGateMarkers applies the default regexes when none are passed. */
test("parseGateMarkers uses the default marker regexes", () => {
  const events = parseGateMarkers(newState(), "GATE: PASS tests=2 passed=2 failed=0")
  assert.equal(events.length, 1)
  assert.equal(events[0]!.kind, "gate")
  assert.equal(events[0]!.result, "PASS")
})

/** agentFromTaskInput returns "" for nullish or empty dispatch inputs. */
test("agentFromTaskInput returns empty for unknown inputs", () => {
  assert.equal(agentFromTaskInput(undefined), "")
  assert.equal(agentFromTaskInput(null), "")
  assert.equal(agentFromTaskInput({}), "")
})

/** The plan gate still moves on an echoed APPROVE via child session text. */
test("streamed child-text verdict records in the store and moves the parent gate", async () => {
  const h = makeFakeHost()
  const { dispose, metricsDir } = await boot(h.host)
  try {
    h.pushEvent({ type: "session.created", properties: { sessionID: "c1", parentID: "p1" } })
    h.pushEvent({
      type: "session.text.delta",
      properties: { sessionID: "c1", delta: `review done\n${APPROVE}` },
    })
    h.pushEvent({
      type: "session.text.ended",
      properties: { sessionID: "c1", text: `review done\n${APPROVE}` },
    })
    await settle()
    const verdicts = journalEntries(metricsDir).filter((e) => e.type === "verdict")
    assert.equal(verdicts.length, 1)
  } finally {
    dispose()
  }
})

/** Host payloads and edge cases that close the remaining branch sides. */

test("hooks tolerate nullish session IDs and empty drafts", async () => {
  const h = makeFakeHost()
  const { dispose } = await boot(h.host)
  try {
    // A read without a session ID keys the budget on the empty string.
    await callTool(h, "execute.before", { tool: "read" })
    // A null/undefined generate draft is a silent no-op.
    await callSession(h, "generate", undefined)
    await callSession(h, "generate", null)
  } finally {
    dispose()
  }
})

test("readPluginVersion returns null for JSON without a version field", () => {
  const dir = tmpDir()
  const pkg = path.join(dir, "package.json")
  fs.writeFileSync(pkg, "{}")
  assert.equal(readPluginVersion(pkg), null)
})

test("turnstile falls back to process.env when no options are injected", async () => {
  const metricsDir = tmpDir()
  const cfgPath = path.join(metricsDir, "empty-config.json")
  fs.writeFileSync(cfgPath, "{}")
  const setVars: Record<string, string> = {
    TURNSTILE_METRICS_DIR: metricsDir,
    TURNSTILE_TRACE: "0",
    TURNSTILE_CONFIG: cfgPath,
  }
  const prior: Record<string, string | undefined> = {}
  for (const [k, v] of Object.entries(setVars)) {
    prior[k] = process.env[k]
    process.env[k] = v
  }
  try {
    const h = makeFakeHost()
    const setup = turnstile(h.host)
    const dispose = (await setup(h.host)) as () => void
    dispose()
    assert.ok(fs.existsSync(path.join(metricsDir, "turnstile.jsonl")))
  } finally {
    for (const [k, v] of Object.entries(prior)) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
  }
})

test("a parent edge resolves through the record's nested data.parentID", async () => {
  const h = makeFakeHost({
    sessionRecords: new Map([["c1", { data: { parentID: "p1" } }]]),
  })
  const { dispose, metricsDir } = await boot(h.host)
  try {
    await callTool(h, "execute.after", {
      tool: "task",
      sessionID: "c1",
      input: { agent: "plan-reviewer" },
      result: { output: `done\n${APPROVE}` },
    })
    const plans = journalEntries(metricsDir).filter((e) => e.type === "plan")
    assert.equal(plans.length, 1)
    assert.equal(plans[0]!.sessionID, "p1")
    assert.equal(plans[0]!.raw, "c1")
  } finally {
    dispose()
  }
})

test("a verdict older than the latest plan-reviewer dispatch is not plausible", async () => {
  const h = makeFakeHost()
  const { dispose, metricsDir } = await boot(h.host)
  try {
    // c1 streams APPROVE with no edge (no session record), then the parent
    // dispatches plan-reviewer afterwards: the stored verdict predates the
    // dispatch, so the plausibility window excludes it.
    h.pushEvent({
      type: "session.text.delta",
      properties: { sessionID: "c1", delta: `review\n${APPROVE}` },
    })
    await settle()
    await callTool(h, "execute.before", {
      tool: "task",
      sessionID: "p1",
      input: { agent: "plan-reviewer", prompt: "review" },
    })
    await callTool(h, "execute.after", {
      tool: "task",
      sessionID: "c1",
      input: { agent: "plan-reviewer" },
      result: { output: "review complete; see journal" },
    })
    const errors = journalEntries(metricsDir).filter((e) => e.type === "error")
    assert.ok(errors.some((e) => String(e.error).includes("unattributable")))
  } finally {
    dispose()
  }
})

test("a marker-less edge-resolved plan-reviewer delivery journals <none>", async () => {
  const h = makeFakeHost({
    sessionRecords: new Map([["c1", { parentID: "p1" }]]),
  })
  const { dispose, metricsDir } = await boot(h.host)
  try {
    await callTool(h, "execute.after", {
      tool: "task",
      sessionID: "c1",
      input: { agent: "plan-reviewer" },
      result: { output: "review complete; see journal" },
    })
    const plans = journalEntries(metricsDir).filter((e) => e.type === "plan")
    assert.equal(plans.length, 1)
    assert.equal(plans[0]!.marker, "<none>")
    assert.equal(plans[0]!.result, "BLOCK")
    assert.equal(plans[0]!.source, "task-result")
  } finally {
    dispose()
  }
})

test("stream events survive empty session ids and unknown event types", async () => {
  const h = makeFakeHost()
  const { dispose, metricsDir } = await boot(h.host)
  try {
    h.pushEvent({ type: "session.text.ended", properties: { sessionID: "", text: "hello" } })
    h.pushEvent({ type: "totally.unknown" })
    h.pushEvent({ type: "session.error", properties: { sessionID: "e1" } })
    h.pushEvent({
      type: "session.created",
      properties: { sessionID: "r1", location: { directory: "/tmp/a" } },
    })
    h.pushEvent({ type: "session.created", properties: { sessionID: "r2", directory: "/tmp/b" } })
    h.pushEvent({ type: "session.created", properties: { sessionID: "r3" } })
    h.pushEvent({ type: "session.created", properties: {} })
    await settle()
    const errors = journalEntries(metricsDir).filter((e) => e.type === "error")
    assert.ok(errors.some((e) => String(e.error) === ""))
  } finally {
    dispose()
  }
})

test("a properties-only event parses markers like a data event", async () => {
  const h = makeFakeHost()
  const { dispose, metricsDir } = await boot(h.host)
  try {
    h.pushEvent({
      type: "message.part.updated",
      properties: { part: { type: "text", text: `ok\n${APPROVE}`, sessionID: "c1" } },
    })
    await settle()
    const verdicts = journalEntries(metricsDir).filter((e) => e.type === "verdict")
    assert.equal(verdicts.length, 1)
  } finally {
    dispose()
  }
})

test("message.part.updated falls back to the event properties as the part", async () => {
  const h = makeFakeHost()
  const { dispose, metricsDir } = await boot(h.host)
  try {
    // No nested `part`: the properties bag itself carries the text fields.
    h.pushEvent({
      type: "message.part.updated",
      properties: { type: "text", text: `ok\n${APPROVE}`, sessionID: "c1" },
    })
    await settle()
    const verdicts = journalEntries(metricsDir).filter((e) => e.type === "verdict")
    assert.equal(verdicts.length, 1)
  } finally {
    dispose()
  }
})

test("a non-string generate agent skips the decoding clamps", async () => {
  const h = makeFakeHost()
  const { dispose } = await boot(h.host)
  try {
    const draft = { agent: 123, options: { temperature: 1 } }
    await callSession(h, "generate", draft)
    assert.equal(draft.options.temperature, 1)
  } finally {
    dispose()
  }
})

test("execute.after bash commands are redacted when the trace is off", async () => {
  const h = makeFakeHost()
  const metricsDir = tmpDir()
  const setup = turnstile(h.host, {
    env: isolatedEnv(metricsDir),
    config: { metricsDir, trace: false },
  })
  const dispose = (await setup(h.host)) as () => void
  try {
    await callTool(h, "execute.after", {
      tool: "bash",
      sessionID: "p1",
      input: { command: "npm test" },
      result: { metadata: { exit: 0 } },
    })
    const tools = journalEntries(metricsDir).filter((e) => e.type === "tool")
    assert.equal(tools.length, 1)
    assert.equal(tools[0]!.command, "<redacted>")
  } finally {
    dispose()
  }
})

test("a self-keyed delivery after a same-session dispatch excludes stale verdicts", async () => {
  const h = makeFakeHost()
  const { dispose, metricsDir } = await boot(h.host)
  try {
    // The dispatch and the delivery share session c1: the verdict streamed
    // BEFORE the dispatch predates the plausibility window, so the pool is
    // empty and the delivery fails open.
    h.pushEvent({
      type: "session.text.delta",
      properties: { sessionID: "c1", delta: `review\n${APPROVE}` },
    })
    await settle()
    await callTool(h, "execute.before", {
      tool: "task",
      sessionID: "c1",
      input: { agent: "plan-reviewer", prompt: "review" },
    })
    await callTool(h, "execute.after", {
      tool: "task",
      sessionID: "c1",
      input: { agent: "plan-reviewer" },
      result: { output: "review complete; see journal" },
    })
    const errors = journalEntries(metricsDir).filter((e) => e.type === "error")
    assert.ok(errors.some((e) => String(e.error).includes("unattributable")))
  } finally {
    dispose()
  }
})

test("a marker-carrying self-keyed delivery attributes through its own verdict", async () => {
  const h = makeFakeHost({
    sessionRecords: new Map([["c1", { parentID: "p1" }]]),
  })
  const { dispose, metricsDir } = await boot(h.host)
  try {
    // The delivery reports the parent's own session id and carries an APPROVE
    // marker; the edge candidate c1 agrees, so the pool is unanimous and the
    // delivery's own marker wins the plan entry.
    h.pushEvent({ type: "session.created", properties: { sessionID: "c1", parentID: "p1" } })
    h.pushEvent({
      type: "session.text.delta",
      properties: { sessionID: "c1", delta: `review\n${APPROVE}` },
    })
    await settle()
    await callTool(h, "execute.after", {
      tool: "task",
      sessionID: "p1",
      input: { agent: "plan-reviewer" },
      result: { output: `summary\n${APPROVE}` },
    })
    const plans = journalEntries(metricsDir).filter((e) => e.type === "plan")
    assert.equal(plans.length, 1)
    assert.equal(plans[0]!.sessionID, "p1")
    assert.equal(plans[0]!.raw, "c1")
    assert.match(plans[0]!.marker, /APPROVE/)
    assert.equal(plans[0]!.source, "task-result")
  } finally {
    dispose()
  }
})

test("a contradictory self-keyed pool reports plural candidates", async () => {
  const h = makeFakeHost()
  const { dispose, metricsDir } = await boot(h.host)
  try {
    // c1 (edge-resolved) holds a BLOCK; c2 (unresolved) streams APPROVE after
    // the dispatch: both are plausible, the pool contradicts, and the
    // delivery fails open naming more than one evidenced candidate.
    h.pushEvent({ type: "session.created", properties: { sessionID: "c1", parentID: "p1" } })
    h.pushEvent({
      type: "session.text.delta",
      properties: { sessionID: "c1", delta: "review\nVERDICT: BLOCK crit=1 high=0 med=0 low=0" },
    })
    await settle()
    await callTool(h, "execute.before", {
      tool: "task",
      sessionID: "p1",
      input: { agent: "plan-reviewer", prompt: "review" },
    })
    h.pushEvent({
      type: "session.text.delta",
      properties: { sessionID: "c2", delta: `review\n${APPROVE}` },
    })
    await settle()
    await callTool(h, "execute.after", {
      tool: "task",
      sessionID: "p1",
      input: { agent: "plan-reviewer" },
      result: { output: "summary; see journal" },
    })
    const errors = journalEntries(metricsDir).filter((e) => e.type === "error")
    assert.ok(errors.some((e) => String(e.error).includes("2 evidenced candidates")))
  } finally {
    dispose()
  }
})

test("a hostile stream-event payload journals and the loop continues", async () => {
  const h = makeFakeHost()
  const { dispose, metricsDir } = await boot(h.host)
  try {
    const props: Record<string, unknown> = { part: { type: "text", text: "hi" } }
    Object.defineProperty(props, "sessionID", {
      get() {
        throw new Error("hostile properties")
      },
    })
    h.pushEvent({ type: "message.part.updated", properties: props })
    await settle()
    const errors = journalEntries(metricsDir).filter((e) => e.type === "error")
    assert.ok(errors.some((e) => String(e.error).includes("event message.part.updated")))
  } finally {
    dispose()
  }
})

test("bash/shell and write/edit payloads resolve through alternate keys", async () => {
  const h = makeFakeHost()
  const { dispose } = await boot(h.host)
  try {
    // `cmd` and `path` are the alternate payload keys; both coerce.
    await callTool(h, "execute.before", {
      tool: "bash",
      sessionID: "p1",
      input: { cmd: "git status" },
    })
    await callTool(h, "execute.before", {
      tool: "edit",
      sessionID: "p1",
      input: { path: "/repo/README.md" },
    })
    // execute.after command recording falls back to cmd, then the title.
    await callTool(h, "execute.after", {
      tool: "bash",
      sessionID: "p1",
      input: { cmd: "npm test" },
      result: { metadata: { exit: 0 } },
    })
    await callTool(h, "execute.after", {
      tool: "bash",
      sessionID: "p1",
      input: {},
      result: { title: "npm run test", metadata: { exit: 0 } },
    })
  } finally {
    dispose()
  }
})

test("journal replay skips non-restore plan results", () => {
  const dir = tmpDir()
  const journal = path.join(dir, "turnstile.jsonl")
  const lines = [
    JSON.stringify({ type: "plan", sessionID: "p1", result: "WAIVED" }),
    JSON.stringify({ type: "plan", sessionID: "p2", result: "BLOCK" }),
  ]
  fs.writeFileSync(journal, lines.join("\n") + "\n")
  const ledger = createLedger(journal, 64)
  assert.equal(ledger.peek("p1"), undefined)
  assert.equal(ledger.peek("p2"), undefined)
})

test("ledger.markParent no-ops on an empty id", () => {
  const ledger = createLedger(path.join(tmpDir(), "j.jsonl"), 64)
  ledger.markParent("")
  assert.equal(ledger.isParent(""), false)
})

test("parseGateMarkers returns no events for empty text", () => {
  assert.deepEqual(parseGateMarkers(newState(), ""), [])
})

test("evidence.has and evidence.observe handle empty and undefined inputs", () => {
  const t = createEvidenceTracker(cfg(), identityParent)
  assert.equal(t.has(""), false)
  assert.equal(t.observe("c1", undefined, 0), false)
})
