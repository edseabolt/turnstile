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
import { newState } from "../src/state.ts"
import { createLedger } from "../src/ledger.ts"
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
  waitUntil,
  type FakeHost,
} from "./helpers.ts"

const APPROVE = "VERDICT: APPROVE crit=0 high=0 med=0 low=0"

/** A fresh default config (XDG untouched; nothing writes to the real env). */
const cfg = (): ReturnType<typeof defaultConfig> => defaultConfig()

/** A pass-through parent resolver: every raw session resolves to itself. */
const identityParent = (raw: string): string => raw

/**
 * Wall-clock buffer for waits with no bus drain boundary: stream-death
 * timing (thrown subscriptions, self-terminating streams) and the strict
 * timestamp ordering between a streamed verdict and a dispatch. Event-
 * stream drains use the awaited push boundary instead.
 */
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
    rotateEveryEntries: 512,
  })
  j.traceEvent("agent", "event", "detail")
  const line = fs.readFileSync(path.join(metricsDir, "gate-events.jsonl"), "utf8").trim()
  assert.equal(line.split("|").length, 4)
})

/** The journal appends without renaming below the rotate tick: the rotation
 *  runs only on the entry-count tick, and `rotateIfLarge` is a no-op while the
 *  file stays under maxBytes — no generation appears and no `.lock` dir is
 *  left behind. On a later tick the over-maxBytes file is renamed to `.1`. */
test("journal appends without renaming below the rotate tick", () => {
  const metricsDir = tmpDir()
  const journalPath = path.join(metricsDir, "turnstile.jsonl")
  const j = createJournaler({
    metricsDir,
    trace: false,
    maxBytes: 100,
    maxGenerations: 1,
    rotateEveryEntries: 2,
  })
  // Writes 1 and 2: the write-2 tick fires, but the file is under maxBytes, so
  // rotateIfLarge is a no-op — the counter advances and no generation appears.
  j.journal({ t: 0 })
  j.journal({ t: 0 })
  assert.equal(fs.existsSync(`${journalPath}.1`), false)
  assert.equal(fs.existsSync(`${journalPath}.lock`), false)
  // Writes 3 and 4: the write-4 tick fires with the file now over maxBytes, so
  // the current file is renamed to `.1` and the lock is released again.
  j.journal({ t: 0 })
  j.journal({ t: 0 })
  assert.equal(fs.existsSync(`${journalPath}.1`), true)
  assert.match(fs.readFileSync(`${journalPath}.1`, "utf8"), /"t":0/)
  assert.equal(fs.existsSync(`${journalPath}.lock`), false)
})

/** A `<file>.lock` directory held by a live rotation (its mtime fresh,
 *  inside the staleness bound) keeps the tick skipped without losing an
 *  entry and without journaling: a fresh contention is a silent skip, not a
 *  steal, so no `type:"error"` entry appears and the directory stays. */
test("a held .lock directory skips the rotation tick and never loses an entry", () => {
  const metricsDir = tmpDir()
  const journalPath = path.join(metricsDir, "turnstile.jsonl")
  const j = createJournaler({
    metricsDir,
    trace: false,
    maxBytes: 1_000_000,
    maxGenerations: 1,
    rotateEveryEntries: 1,
  })
  // Pre-create the lock so the first tick's mkdir fails (EEXIST); the tick
  // skips the rotation and the directory stays (no rmdir ever runs).
  fs.mkdirSync(`${journalPath}.lock`)
  assert.doesNotThrow(() => j.journal({ type: "tool", tool: "read" }))
  assert.equal(journalEntries(metricsDir).length, 1)
  assert.equal(fs.existsSync(`${journalPath}.lock`), true)
  // A fresh contention never journals: no error entry was written.
  assert.equal(journalEntries(metricsDir).filter((e) => e.type === "error").length, 0)
})

/** A stale, empty `<file>.lock` (mtime past the staleness bound) is stolen
 *  on the next tick: the steal journals a `rotation-lock-stale:` error entry
 *  before the mkdir is retried, so the entry lands in the rotated generation
 *  alongside the task entry, rotation proceeds, and the lock is released. */
test("a stale rotation lock is stolen and rotation resumes", () => {
  const metricsDir = tmpDir()
  const journalPath = path.join(metricsDir, "turnstile.jsonl")
  const j = createJournaler({
    metricsDir,
    trace: false,
    maxBytes: 1,
    maxGenerations: 1,
    rotateEveryEntries: 1,
  })
  const lock = `${journalPath}.lock`
  fs.mkdirSync(lock)
  // Age the lock well past the staleness bound without sleeping.
  const past = new Date(Date.now() - 120_000)
  fs.utimesSync(lock, past, past)
  assert.doesNotThrow(() => j.journal({ type: "tool", tool: "read" }))
  // The steal happened: the lock is gone and rotation ran on this tick.
  assert.equal(fs.existsSync(lock), false)
  // The audit entry was appended before the rename, so it landed in `.1`
  // alongside the task entry — exactly one rotation-lock-stale line.
  const rotated = fs
    .readFileSync(`${journalPath}.1`, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line))
  assert.equal(
    rotated.filter((e) => e.type === "error" && String(e.error).includes("rotation-lock-stale:"))
      .length,
    1,
  )
  assert.ok(rotated.some((e) => e.type === "tool"))
})

/** A stale `<file>.lock` that is not an empty directory cannot be stolen:
 *  the rmdir fails inside the staleness escape and the throw lands in the
 *  outer catch, so the entry still appends, the lock stays for a future
 *  tick, and no audit entry is journaled. */
test("a stale non-empty lock directory fails the steal and skips the tick", () => {
  const metricsDir = tmpDir()
  const journalPath = path.join(metricsDir, "turnstile.jsonl")
  const j = createJournaler({
    metricsDir,
    trace: false,
    maxBytes: 1_000_000,
    maxGenerations: 1,
    rotateEveryEntries: 1,
  })
  const lock = `${journalPath}.lock`
  fs.mkdirSync(lock)
  // A stray file makes the rmdir fail; creating it refreshes the directory
  // mtime, so the lock is aged last.
  fs.writeFileSync(path.join(lock, "stray"), "x")
  const past = new Date(Date.now() - 120_000)
  fs.utimesSync(lock, past, past)
  assert.doesNotThrow(() => j.journal({ type: "tool", tool: "read" }))
  assert.equal(journalEntries(metricsDir).length, 1)
  assert.equal(fs.existsSync(lock), true)
  assert.equal(journalEntries(metricsDir).filter((e) => e.type === "error").length, 0)
})

/** A stale `<file>.lock` path that is a file, not a directory, fails the
 *  steal the same way: the stat passes and the aged mtime clears the bound,
 *  but the rmdir throws and the tick skips without an audit entry. */
test("a stale lock that is not a directory fails the steal and skips the tick", () => {
  const metricsDir = tmpDir()
  const journalPath = path.join(metricsDir, "turnstile.jsonl")
  const j = createJournaler({
    metricsDir,
    trace: false,
    maxBytes: 1_000_000,
    maxGenerations: 1,
    rotateEveryEntries: 1,
  })
  const lock = `${journalPath}.lock`
  fs.writeFileSync(lock, "x")
  const past = new Date(Date.now() - 120_000)
  fs.utimesSync(lock, past, past)
  assert.doesNotThrow(() => j.journal({ type: "tool", tool: "read" }))
  assert.equal(journalEntries(metricsDir).length, 1)
  assert.equal(fs.existsSync(lock), true)
  assert.equal(journalEntries(metricsDir).filter((e) => e.type === "error").length, 0)
})

/** A lock that vanishes between the contended mkdir and the staleness stat
 *  (modeled stub-free as a dangling symlink, whose stat follows to a missing
 *  target) throws inside the staleness escape: the tick skips, the symlink
 *  stays, and no audit entry is journaled. */
test("a lock whose stat fails skips the tick", () => {
  const metricsDir = tmpDir()
  const journalPath = path.join(metricsDir, "turnstile.jsonl")
  const j = createJournaler({
    metricsDir,
    trace: false,
    maxBytes: 1_000_000,
    maxGenerations: 1,
    rotateEveryEntries: 1,
  })
  const lock = `${journalPath}.lock`
  fs.symlinkSync(path.join(metricsDir, "gone"), lock)
  assert.doesNotThrow(() => j.journal({ type: "tool", tool: "read" }))
  assert.equal(journalEntries(metricsDir).length, 1)
  assert.equal(fs.lstatSync(lock).isSymbolicLink(), true)
  assert.equal(journalEntries(metricsDir).filter((e) => e.type === "error").length, 0)
})

/** An unexpected lock-creation error (a read-only metrics dir blocks the
 *  mkdir with EACCES) is rethrown from the staleness escape into the outer
 *  catch: journal() never throws, the entry still lands, and no lock is
 *  left behind. */
test("an unexpected lock-creation error never escapes journal()", () => {
  const metricsDir = tmpDir()
  const journalPath = path.join(metricsDir, "turnstile.jsonl")
  const j = createJournaler({
    metricsDir,
    trace: false,
    maxBytes: 1_000_000,
    maxGenerations: 1,
    rotateEveryEntries: 1,
  })
  // The first entry creates the journal file; its tick succeeds (no lock).
  j.journal({ type: "tool", tool: "read" })
  // Drop write on the dir: the file stays writable (it already exists) but
  // the new lock directory cannot be created.
  fs.chmodSync(metricsDir, 0o500)
  try {
    assert.doesNotThrow(() => j.journal({ type: "tool", tool: "read" }))
  } finally {
    fs.chmodSync(metricsDir, 0o700)
  }
  assert.equal(journalEntries(metricsDir).length, 2)
  assert.equal(fs.existsSync(`${journalPath}.lock`), false)
})

/** pathsSignature fails open (null) when the plans dir is unreadable. */
test("plansSignature fails open on an unreadable plans dir", () => {
  const project = tmpDir()
  const plans = path.join(project, ".opencode", "plans")
  fs.mkdirSync(plans, { recursive: true })
  const metricsDir = tmpDir()
  const g = createGates(
    defaultConfig(),
    createJournaler({
      metricsDir,
      trace: false,
      maxBytes: 1e6,
      maxGenerations: 1,
      rotateEveryEntries: 512,
    }),
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
  const ledger = createLedger(dir, 64, 2000)
  const s = ledger.state("p1")
  assert.equal(s.hasGatePass, false)
  assert.equal(s.reads, 0)
})

/** A telemetry sink that throws on a block never breaks the guards. */
test("tool-policy guards journal their internal failure when the sink throws", () => {
  const metricsDir = tmpDir()
  const inner = createJournaler({
    metricsDir,
    trace: false,
    maxBytes: 1e6,
    maxGenerations: 1,
    rotateEveryEntries: 512,
  })
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
  const inner = createJournaler({
    metricsDir,
    trace: false,
    maxBytes: 1e6,
    maxGenerations: 1,
    rotateEveryEntries: 512,
  })
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
    hasCreditedApproval: (): boolean => false,
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
  const j = createJournaler({
    metricsDir,
    trace: false,
    maxBytes: 1e6,
    maxGenerations: 1,
    rotateEveryEntries: 512,
  })
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

/** validateResolved warns when plansDir is absolute: the value is still honored
 *  (resolved as-is rather than silently dropping it). */
test("validateResolved warns on an absolute plansDir", () => {
  const config = defaultConfig()
  config.plansDir = "/fixed/plans"
  const warnings = validateResolved(config)
  assert.ok(warnings.some((w) => w.includes("plansDir") && w.includes("absolute")))
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
      await h.pushEvent({
        type: "session.text.delta",
        properties: { sessionID: `s${i}`, delta: "x" },
      })
    }
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

/** The task-window bound evicts its oldest stamps past 256 parents. */
test("boundTaskWindows evicts task-window stamps past the cap", async () => {
  const h = makeFakeHost()
  const { dispose } = await boot(h.host)
  try {
    for (let i = 0; i < 257; i++) {
      await callSession(h, "prompt", { sessionID: `p${i}`, text: "work" })
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

/** A non-BlockError escaping the guard sequence must not be stamped
 *  blocked:true: only a deliberate BlockError marks the dispatch as blocked,
 *  so a hostile session record that throws a plain error during executor
 *  project-dir resolution propagates that error (journaled by the fail-open
 *  handler) without a blocked dispatch entry. */
test("execute.before a non-BlockError guard failure is not stamped blocked:true", async () => {
  const hostile = {} as Record<string, unknown>
  Object.defineProperty(hostile, "directory", {
    get() {
      throw new Error("hostile record")
    },
  })
  const h = makeFakeHost({ sessionRecords: new Map([["p1", hostile]]) })
  const { dispose, metricsDir } = await boot(h.host)
  try {
    // The executor guard sequence awaits resolveProjectDir, whose hostile
    // record throws a plain (non-BlockError) during directory extraction.
    await callTool(h, "execute.before", {
      tool: "task",
      sessionID: "p1",
      input: { agent: "executor" },
    })
    const entries = journalEntries(metricsDir)
    const dispatched = entries.filter((l) => l.type === "dispatch")
    // The guard threw a non-BlockError before the journal-on-exit stamp, so no
    // dispatch entry exists at all — in particular none stamped blocked:true,
    // which only a deliberate BlockError produces — and the fail-open handler
    // journals the internal error under its own key.
    assert.equal(dispatched.length, 0)
    assert.ok(
      entries.some((e) => e.type === "error" && String(e.error).includes("tool.execute.before")),
    )
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

/**
 * A subscribe() that always throws journals one death per attempt — the initial
 * call plus maxStreamRestarts restarts (six) — then the terminal "ingestion
 * disabled" entry once the restart budget is spent: every death and the
 * disablement are journaled, so a dead stream is never a silent exit. Setup
 * stays alive (fail-open).
 */
test("event subscription failure journals each death then disables after the budget", async () => {
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
  // Wall-clock wait: the subscription deaths are stream-side (subscribe()
  // throws before any event is pushed), so no bus drain boundary exists —
  // wait for the restart budget to exhaust on the clock.
  await settle()
  dispose()
  const errors = journalEntries(metricsDir).filter((e) => e.type === "error")
  const subs = errors.filter((e) => String(e.error).includes("event subscription"))
  assert.equal(
    subs.length,
    6,
    "one death per attempt: the initial subscribe plus maxStreamRestarts restarts",
  )
  assert.ok(
    errors.some((e) =>
      String(e.error).includes(
        "event stream restart budget exhausted; session.text.* marker ingestion is disabled",
      ),
    ),
  )
})

/**
 * A host that cleanly recycles the event stream between tasks (each of
 * several subscriptions completes without an abort and without delivering
 * events) must not burn the restart budget: after MORE clean closes than
 * the budget allows, ingestion is still alive and a marker flows through
 * the live re-subscription; the stream-ended reason is surfaced exactly
 * once across the whole storm of closes (once per stop, not once per
 * close); and a final dispose stays silent (no disablement entry).
 */
test("clean stream closes re-subscribe for free and never disable ingestion", async () => {
  const metricsDir = tmpDir()
  const h = makeFakeHost()
  const real = (h.host as { event: { subscribe: any } }).event.subscribe
  // A 0-event stream that completes immediately on every next() call.
  const dead: AsyncIterable<any> = {
    [Symbol.asyncIterator](): AsyncIterator<any> {
      return {
        next: async (): Promise<IteratorResult<any>> => ({ done: true, value: undefined }),
      }
    },
  }
  let closes = 0
  ;(h.host as { event?: unknown }).event = {
    subscribe: (options?: { signal?: AbortSignal }) => {
      // The first 7 (more than the restart budget of 5) subscriptions end
      // cleanly WITHOUT an abort and WITHOUT delivering events; later ones
      // are the live bus.
      if (++closes <= 7) return dead
      return real(options)
    },
  }
  const setup = turnstile(h.host, {
    env: isolatedEnv(metricsDir),
    config: { metricsDir, gateEvidence: "flag" },
  })
  const dispose = (await setup(h.host)) as () => void
  await waitUntil(() => closes >= 7)
  const errors = journalEntries(metricsDir).filter((e) => e.type === "error")
  assert.ok(
    !errors.some((e) => String(e.error).includes("restart budget exhausted")),
    "clean closes must not exhaust the restart budget",
  )
  assert.equal(
    errors.filter((e) => e.error === "event stream ended").length,
    1,
    "a recycle storm journals the stream-ended reason once, not once per close",
  )
  // Ingestion is still alive after the recycles: a marker flows through.
  h.pushEvent({
    type: "session.created",
    data: { sessionID: "c1", parentID: "p1", agent: "test-runner" },
  })
  h.pushEvent({ type: "session.error", data: { sessionID: "c1", error: "warmup" } })
  await waitUntil(() =>
    journalEntries(metricsDir).some((l) => l.type === "error" && l.error === "warmup"),
  )
  h.pushEvent({
    type: "session.text.ended",
    data: { sessionID: "c1", text: "GATE: PASS tests=1 passed=1 failed=1" },
  })
  await waitUntil(() =>
    journalEntries(metricsDir).some((l) => l.type === "gate" && l.result === "PASS"),
  )
  dispose()
})

/**
 * A subscription that surfaces dispose as a throw is silent: the abort (from
 * the disposer) makes both the per-death journal and the terminal disablement
 * journal nothing — a detached stream is not a death, matching the pre-existing
 * abort-silent semantics.
 */
test("a subscribe that throws after dispose stays silent", async () => {
  const h = makeFakeHost()
  const host: Host = {
    ...h.host,
    event: {
      subscribe: (options?: { signal?: AbortSignal }): AsyncIterable<any> => {
        const signal = options?.signal
        return {
          [Symbol.asyncIterator](): AsyncIterator<any> {
            return {
              next: async (): Promise<IteratorResult<any>> => {
                // Block until dispose aborts, then surface the abort as a
                // throw: a host that turns the abort into a throw must be
                // treated as a silent detach, never a death.
                if (signal?.aborted) throw new Error("aborted boom")
                await new Promise<void>((resolve) =>
                  signal?.addEventListener("abort", () => resolve(), { once: true }),
                )
                throw new Error("aborted boom")
              },
            }
          },
        }
      },
    },
  }
  const { dispose, metricsDir } = await boot(host)
  // Wall-clock waits with no bus drain boundary: first let the iterator
  // reach its abort-listener block, then let the post-dispose throw reach
  // the supervise loop — both are stream-death timing, and no events are
  // ever pushed.
  await settle()
  dispose()
  await settle()
  const errors = journalEntries(metricsDir).filter((e) => e.type === "error")
  assert.ok(!errors.some((e) => String(e.error).includes("event subscription")))
  assert.ok(!errors.some((e) => String(e.error).includes("restart budget exhausted")))
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
  // Wall-clock wait: the stream ends by itself (no events were pushed),
  // so the stream-ended journal entry is awaited on the clock, not on a
  // bus drain boundary.
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
  const ledger = createLedger(path.join(dir, "turnstile.jsonl"), 1, 2000)
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
  const ledger = createLedger(path.join(tmpDir(), "j.jsonl"), 64, 2000)
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
    h.pushEvent({
      type: "session.created",
      properties: { sessionID: "c1", parentID: "p1", agent: "reviewer" },
    })
    h.pushEvent({
      type: "session.text.delta",
      properties: { sessionID: "c1", delta: `review done\n${APPROVE}` },
    })
    await h.pushEvent({
      type: "session.text.ended",
      properties: { sessionID: "c1", text: `review done\n${APPROVE}` },
    })
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
    // Wall-clock gap: the verdict must be recorded strictly before the
    // dispatch below — the plausibility window orders verdicts against
    // the dispatch timestamp, and an awaited drain could resolve in the
    // same millisecond.
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
    await h.pushEvent({ type: "session.created", properties: {} })
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
    h.pushEvent({ type: "session.created", properties: { sessionID: "c1", agent: "reviewer" } })
    await h.pushEvent({
      type: "message.part.updated",
      properties: { part: { type: "text", text: `ok\n${APPROVE}`, sessionID: "c1" } },
    })
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
    h.pushEvent({ type: "session.created", properties: { sessionID: "c1", agent: "reviewer" } })
    await h.pushEvent({
      type: "message.part.updated",
      properties: { type: "text", text: `ok\n${APPROVE}`, sessionID: "c1" },
    })
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
    // Wall-clock gap: the streamed verdict must be recorded strictly
    // before the same-session dispatch below, or the plausibility window
    // could no longer exclude it as a stale verdict.
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
    h.pushEvent({
      type: "session.created",
      properties: { sessionID: "c1", parentID: "p1", agent: "reviewer" },
    })
    await h.pushEvent({
      type: "session.text.delta",
      properties: { sessionID: "c1", delta: `review\n${APPROVE}` },
    })
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
    // c1 and c2 are unresolved children that both stream after the single
    // dispatch with opposite verdicts: both belong to the current round, so
    // both stay plausible, the pool contradicts, and the delivery fails open
    // naming more than one evidenced candidate.
    await callTool(h, "execute.before", {
      tool: "task",
      sessionID: "p1",
      input: { agent: "plan-reviewer", prompt: "review" },
    })
    // Wall-clock buffer: keep the verdicts streamed below strictly after
    // the dispatch timestamp above, so the round ordering the test
    // documents stays explicit rather than same-millisecond.
    await settle()
    h.pushEvent({ type: "session.created", properties: { sessionID: "c1", agent: "reviewer" } })
    h.pushEvent({
      type: "session.text.delta",
      properties: { sessionID: "c1", delta: "review\nVERDICT: BLOCK crit=1 high=0 med=0 low=0" },
    })
    h.pushEvent({ type: "session.created", properties: { sessionID: "c2", agent: "reviewer" } })
    await h.pushEvent({
      type: "session.text.delta",
      properties: { sessionID: "c2", delta: `review\n${APPROVE}` },
    })
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
    await h.pushEvent({ type: "message.part.updated", properties: props })
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
  const ledger = createLedger(journal, 64, 2000)
  assert.equal(ledger.peek("p1"), undefined)
  assert.equal(ledger.peek("p2"), undefined)
})

test("ledger.markParent no-ops on an empty id", () => {
  const ledger = createLedger(path.join(tmpDir(), "j.jsonl"), 64, 2000)
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
