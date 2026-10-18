/**
 * @fileoverview Per-dispatch project-directory resolution: the enforcing
 * dispatch resolves the session's directory from the host session record via
 * session.get, the sync consumers read a cached value, session_move
 * invalidates the cache unconditionally, a root session.created seeds both the
 * seed and the cache, and the cache is bounded. The resolver journals nothing
 * (fail-open), so the exact error-count assertions hold.
 */

import { test } from "node:test"
import assert from "node:assert/strict"
import * as fs from "node:fs"
import * as path from "node:path"

import { turnstile } from "../turnstile.ts"
import type { TurnstileConfig } from "../src/types.ts"
import {
  callPermission,
  callTool,
  isolatedEnv,
  journalEntries,
  makeFakeHost,
  tmpDir,
  type FakeHost,
} from "./helpers.ts"

/** Gives the async event loop a tick to drain queued stream events. */
const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 30))

/**
 * Builds a session record carrying `dir` at a dotted candidate key, e.g.
 * `data.location.directory`. One place for the four candidate shapes.
 * @param candidate The dotted candidate key.
 * @param dir The directory to nest.
 * @returns The nested record.
 */
function recordWith(candidate: string, dir: string): Record<string, unknown> {
  const record: Record<string, unknown> = {}
  let cur: Record<string, unknown> = record
  const parts = candidate.split(".")
  for (let i = 0; i < parts.length; i++) {
    const key = parts[i]!
    if (i === parts.length - 1) cur[key] = dir
    else {
      cur[key] = {}
      cur = cur[key] as Record<string, unknown>
    }
  }
  return record
}

/**
 * Boots two temp project dirs (seed A with plan.md, sibling B with other.md),
 * a temp metrics dir, and a fake host backed by an empty session-record map;
 * chdir A so process.cwd() is the seed. Populate the returned
 * `sessionRecords` (read by session.get at call time) after boot.
 * @param opts Optional host behavior: throwingGet, observeSessionMove, and
 *     withSession (host session surface).
 * @returns The host, metrics dir, both project dirs, the mutable record map,
 *     and a restore that disposes and returns to the previous directory.
 */
async function boot(opts?: {
  throwingGet?: boolean
  observeSessionMove?: boolean
  withSession?: boolean
}): Promise<{
  h: FakeHost
  metricsDir: string
  projectA: string
  projectB: string
  sessionRecords: Map<string, unknown>
  restore: () => void
}> {
  const projectA = tmpDir()
  const projectB = tmpDir()
  fs.mkdirSync(path.join(projectA, ".opencode", "plans"), { recursive: true })
  fs.writeFileSync(path.join(projectA, ".opencode", "plans", "plan.md"), "# A\n")
  fs.mkdirSync(path.join(projectB, ".opencode", "plans"), { recursive: true })
  fs.writeFileSync(path.join(projectB, ".opencode", "plans", "other.md"), "# B\n")
  const metricsDir = tmpDir()
  const sessionRecords = new Map<string, unknown>()
  const h = makeFakeHost({
    sessionRecords,
    ...(opts?.throwingGet ? { throwingGet: true } : {}),
    ...(opts?.withSession === false ? { session: false } : {}),
  })
  const toolPolicy =
    opts?.observeSessionMove !== undefined
      ? { toolPolicy: { observeSessionMove: opts.observeSessionMove } }
      : {}
  const prev = process.cwd()
  process.chdir(projectA)
  const setup = turnstile(h.host, {
    env: isolatedEnv(metricsDir),
    config: { metricsDir, ...toolPolicy } as Partial<TurnstileConfig>,
  })
  const dispose = (await setup(h.host)) as () => void
  return {
    h,
    metricsDir,
    projectA,
    projectB,
    sessionRecords,
    restore: (): void => {
      dispose()
      process.chdir(prev)
    },
  }
}

/** The block predicate matching the plan-approval executor block message. */
const blocksOn =
  (file: string) =>
  (e: Error): boolean =>
    e.message.includes(`no plan approval for "${file}"`)

/**
 * The executor dispatch resolves the directory from session.get's
 * location.directory, so with a stale seed A (plan.md) and a record pointing at
 * B (other.md) the block names B's plan file, proving the seed is not used.
 */
test("executor dispatch resolves the directory from session.get location.directory", async () => {
  const { h, restore, projectB, sessionRecords } = await boot()
  try {
    sessionRecords.set("p1", { location: { directory: projectB } })
    await assert.rejects(
      () =>
        callTool(h, "execute.before", {
          tool: "task",
          sessionID: "p1",
          input: { agent: "executor", prompt: "do the work" },
        }),
      blocksOn("other.md"),
    )
  } finally {
    restore()
  }
})

/**
 * Each supported nested directory candidate (directory, location.directory,
 * data.directory, data.location.directory) resolves to B; a record present
 * with no candidate, and an absent record, fall through to the seed A.
 */
test("resolves every nested directory candidate, falling through to the seed when none", async () => {
  for (const candidate of [
    "directory",
    "location.directory",
    "data.directory",
    "data.location.directory",
  ]) {
    const { h, restore, projectB, sessionRecords } = await boot()
    try {
      sessionRecords.set("p1", recordWith(candidate, projectB))
      await assert.rejects(
        () =>
          callTool(h, "execute.before", {
            tool: "task",
            sessionID: "p1",
            input: { agent: "executor", prompt: "do the work" },
          }),
        blocksOn("other.md"),
      )
    } finally {
      restore()
    }
  }
  for (const record of [{ parentID: "p1" }, null] as Array<Record<string, unknown> | null>) {
    const { h, restore, sessionRecords } = await boot()
    try {
      sessionRecords.set("p1", record)
      await assert.rejects(
        () =>
          callTool(h, "execute.before", {
            tool: "task",
            sessionID: "p1",
            input: { agent: "executor", prompt: "do the work" },
          }),
        blocksOn("plan.md"),
      )
    } finally {
      restore()
    }
  }
})

/**
 * A throwing session.get falls back to the cache then the seed without
 * journaling anything: an empty cache falls to the seed A (plan.md), and the
 * journal has no type:"error" entries.
 */
test("a throwing session.get falls back to the seed, journaling nothing", async () => {
  const { h, metricsDir, restore } = await boot({ throwingGet: true })
  try {
    await assert.rejects(
      () =>
        callTool(h, "execute.before", {
          tool: "task",
          sessionID: "p1",
          input: { agent: "executor", prompt: "do the work" },
        }),
      blocksOn("plan.md"),
    )
    const errors = journalEntries(metricsDir).filter((e) => e.type === "error")
    assert.equal(errors.length, 0)
  } finally {
    restore()
  }
})

/**
 * A host without the session surface resolves through the seed (A): no API to
 * consult, so the resolver returns currentProjectDir without touching it.
 */
test("falls back to the seed when the host exposes no session surface", async () => {
  const { h, restore } = await boot({ withSession: false })
  try {
    await assert.rejects(
      () =>
        callTool(h, "execute.before", {
          tool: "task",
          sessionID: "p1",
          input: { agent: "executor", prompt: "do the work" },
        }),
      blocksOn("plan.md"),
    )
  } finally {
    restore()
  }
})

/**
 * session_move invalidates the per-session directory cache unconditionally:
 * after the executor resolves B, a move then a record pointing back at A makes
 * the next dispatch block on A's plan. Asserted under both observeSessionMove
 * configs so mechanics do not hide behind telemetry.
 */
test("session_move invalidates the cache under both observeSessionMove configs", async () => {
  for (const observeSessionMove of [false, true]) {
    const { h, restore, projectA, projectB, sessionRecords } = await boot({ observeSessionMove })
    try {
      sessionRecords.set("p1", { location: { directory: projectB } })
      // Prime the cache to B, then move, then point the record at A.
      await assert.rejects(
        () =>
          callTool(h, "execute.before", {
            tool: "task",
            sessionID: "p1",
            input: { agent: "executor", prompt: "do the work" },
          }),
        blocksOn("other.md"),
      )
      await callTool(h, "execute.before", {
        tool: "session_move",
        sessionID: "p1",
        input: { directory: "/tmp/nowhere" },
      })
      sessionRecords.set("p1", { location: { directory: projectA } })
      await assert.rejects(
        () =>
          callTool(h, "execute.before", {
            tool: "task",
            sessionID: "p1",
            input: { agent: "executor", prompt: "do the work" },
          }),
        blocksOn("plan.md"),
      )
    } finally {
      restore()
    }
  }
})

/**
 * A root session.created carrying a directory seeds both the seed and the
 * per-session cache, so a subsequent dispatch for that root session (with no
 * session record) resolves to the seeded directory's plans dir.
 */
test("root session.created seeds the per-session directory cache", async () => {
  const { h, restore, projectB } = await boot()
  try {
    h.pushEvent({
      type: "session.created",
      data: { sessionID: "p1", location: { directory: projectB } },
    })
    await settle()
    await assert.rejects(
      () =>
        callTool(h, "execute.before", {
          tool: "task",
          sessionID: "p1",
          input: { agent: "executor", prompt: "do the work" },
        }),
      blocksOn("other.md"),
    )
  } finally {
    restore()
  }
})

/**
 * A session with no cache entry and no session record falls back to the
 * process cwd, never to a directory carried by another root session's created
 * event: after p1's created event seeds B, dispatching p2 (no record) blocks
 * on the cwd's plan file.
 */
test("another session's fallback is the process cwd, not a seeded directory", async () => {
  const { h, restore, projectB } = await boot()
  try {
    h.pushEvent({
      type: "session.created",
      data: { sessionID: "p1", location: { directory: projectB } },
    })
    await settle()
    await assert.rejects(
      () =>
        callTool(h, "execute.before", {
          tool: "task",
          sessionID: "p2",
          input: { agent: "executor", prompt: "do the work" },
        }),
      blocksOn("plan.md"),
    )
  } finally {
    restore()
  }
})

/**
 * When the resolver replaces a session's cached directory with a different one
 * (a move the session_move tool hook did not witness), it journals a loud
 * session_move telemetry entry: after a record flip from B to A the next
 * dispatch blocks on A's plan file, the journal holds exactly one
 * session_move entry carrying reason "re-resolved", and no type:"error"
 * entries are added.
 */
test("the resolver journals a loud session_move when a session's cached directory changes", async () => {
  const { h, metricsDir, restore, projectA, projectB, sessionRecords } = await boot()
  try {
    sessionRecords.set("p1", { location: { directory: projectB } })
    await assert.rejects(
      () =>
        callTool(h, "execute.before", {
          tool: "task",
          sessionID: "p1",
          input: { agent: "executor", prompt: "do the work" },
        }),
      blocksOn("other.md"),
    )
    sessionRecords.set("p1", { location: { directory: projectA } })
    await assert.rejects(
      () =>
        callTool(h, "execute.before", {
          tool: "task",
          sessionID: "p1",
          input: { agent: "executor", prompt: "do the work" },
        }),
      blocksOn("plan.md"),
    )
    const moves = journalEntries(metricsDir).filter(
      (e) => e.type === "tool" && e.tool === "session_move",
    )
    assert.equal(moves.length, 1)
    const first = moves[0]
    assert.ok(first)
    assert.equal(first.sessionID, "p1")
    assert.equal(first.reason, "re-resolved")
    assert.equal(journalEntries(metricsDir).filter((e) => e.type === "error").length, 0)
  } finally {
    restore()
  }
})

/**
 * Re-resolving a session whose record still points at its cached directory
 * journals no telemetry: two dispatches against the same B record emit zero
 * session_move entries, so a stable project produces no audit noise.
 */
test("a cache that re-resolves to the same directory journals nothing", async () => {
  const { h, metricsDir, restore, projectB, sessionRecords } = await boot()
  try {
    sessionRecords.set("p1", { location: { directory: projectB } })
    for (let i = 0; i < 2; i++) {
      await assert.rejects(
        () =>
          callTool(h, "execute.before", {
            tool: "task",
            sessionID: "p1",
            input: { agent: "executor", prompt: "do the work" },
          }),
        blocksOn("other.md"),
      )
    }
    const moves = journalEntries(metricsDir).filter((e) => e.tool === "session_move")
    assert.equal(moves.length, 0)
  } finally {
    restore()
  }
})

/**
 * The re-resolution telemetry honors the observeSessionMove kill-switch: with
 * the flag false a record flip from B to A still switches enforcement to A, but
 * the journal holds no session_move entries at all.
 */
test("re-resolution telemetry honors the observeSessionMove kill-switch", async () => {
  const { h, metricsDir, restore, projectA, projectB, sessionRecords } = await boot({
    observeSessionMove: false,
  })
  try {
    sessionRecords.set("p1", { location: { directory: projectB } })
    await assert.rejects(
      () =>
        callTool(h, "execute.before", {
          tool: "task",
          sessionID: "p1",
          input: { agent: "executor", prompt: "do the work" },
        }),
      blocksOn("other.md"),
    )
    sessionRecords.set("p1", { location: { directory: projectA } })
    await assert.rejects(
      () =>
        callTool(h, "execute.before", {
          tool: "task",
          sessionID: "p1",
          input: { agent: "executor", prompt: "do the work" },
        }),
      blocksOn("plan.md"),
    )
    const moves = journalEntries(metricsDir).filter((e) => e.tool === "session_move")
    assert.equal(moves.length, 0)
  } finally {
    restore()
  }
})

/**
 * Caching past the bounded-directory cap evicts the oldest entry without
 * corrupting the most recent resolutions: 55 sessions in one instance each
 * resolve to the same B.
 */
test("per-session directory cache is bounded by eviction", async () => {
  const { h, metricsDir, restore, projectB, sessionRecords } = await boot()
  try {
    for (let i = 0; i < 55; i++) sessionRecords.set(`s${i}`, { location: { directory: projectB } })
    for (let i = 0; i < 55; i++) {
      await assert.rejects(
        () =>
          callTool(h, "execute.before", {
            tool: "task",
            sessionID: `s${i}`,
            input: { agent: "executor", prompt: "do the work" },
          }),
        blocksOn("other.md"),
      )
    }
    const errors = journalEntries(metricsDir).filter((e) => e.type === "error")
    assert.equal(errors.length, 0)
  } finally {
    restore()
  }
})

/**
 * The sync evaluate arm reads the cached directory when session.get would be
 * silent: after the executor primes the cache to B, the evaluate ask names B's
 * plan file even though the seed is still A.
 */
test("evaluate arm uses the cached directory", async () => {
  const { h, restore, projectB, sessionRecords } = await boot()
  try {
    sessionRecords.set("p1", { location: { directory: projectB } })
    await assert.rejects(
      () =>
        callTool(h, "execute.before", {
          tool: "task",
          sessionID: "p1",
          input: { agent: "executor", prompt: "do the work" },
        }),
      blocksOn("other.md"),
    )
    const pe: Record<string, unknown> = { sessionID: "p1", action: "task" }
    await callPermission(h, "evaluate", pe)
    assert.equal(pe.effect, "ask")
    assert.ok(String(pe.message).includes("other.md"))
  } finally {
    restore()
  }
})
