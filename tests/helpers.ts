/**
 * @fileoverview Test helpers: fake OpenCode host, temp directories, and
 * journal/trace readers. All tests inject config with a temp `metricsDir`,
 * so no test writes to the real metrics directory.
 */

import * as fs from "node:fs"
import assert from "node:assert/strict"
import * as os from "node:os"
import * as path from "node:path"
import type { Host } from "../src/types.ts"

// Fake-host payloads are intentionally loose (typed `any`); assertions
// check concrete shapes.

/** A fake OpenCode v2 host that records hook callbacks by name. */
export interface FakeHost {
  host: Host
  /** Tool hook callbacks keyed by hook name (`execute.before`, …). */
  toolHooks: Record<string, (event: any) => Promise<void> | void>
  /** Session hook callbacks keyed by hook name (`prompt`, …). */
  sessionHooks: Record<string, (input: any) => Promise<void> | void>
  /** Pushes a stream event to the host's `event.subscribe` consumer. */
  pushEvent: (event: { type: string; data?: unknown; properties?: unknown }) => void
}

/**
 * Creates a push-based async-iterable event bus backing a fake host's
 * `event.subscribe`. The iterable ends when the subscriber's abort signal
 * fires (the plugin's dispose path), mirroring the real host stream.
 * @returns The push function and the subscribe factory.
 */
function makeEventBus(): {
  push: (event: any) => void
  subscribe: (options?: { signal?: AbortSignal }) => AsyncIterable<any>
} {
  const queue: any[] = []
  let notify: (() => void) | null = null
  const push = (event: any): void => {
    queue.push(event)
    const n = notify
    notify = null
    n?.()
  }
  const subscribe = (options?: { signal?: AbortSignal }): AsyncIterable<any> => ({
    [Symbol.asyncIterator](): AsyncIterator<any> {
      const signal = options?.signal
      const onAbort = (): void => {
        const n = notify
        notify = null
        n?.()
      }
      signal?.addEventListener("abort", onAbort, { once: true })
      return {
        next: async (): Promise<IteratorResult<any>> => {
          for (;;) {
            if (signal?.aborted) {
              signal.removeEventListener("abort", onAbort)
              return { done: true, value: undefined }
            }
            if (queue.length > 0) return { done: false, value: queue.shift() }
            await new Promise<void>((resolve) => {
              notify = resolve
            })
          }
        },
      }
    },
  })
  return { push, subscribe }
}

/**
 * Creates a fake host whose `tool.hook`/`session.hook` store callbacks and
 * whose `event.subscribe` yields pushed events.
 * @param opts Optional host behavior: `sessionRecords` backs the
 *     `session.get` API with a session-ID → record map.
 * @returns The host plus the recorded callback tables and event pusher.
 */
export function makeFakeHost(opts?: { sessionRecords?: Map<string, any> }): FakeHost {
  const toolHooks: Record<string, (event: any) => Promise<void> | void> = {}
  const sessionHooks: Record<string, (input: any) => Promise<void> | void> = {}
  const sessionRecords = opts?.sessionRecords
  const { push, subscribe } = makeEventBus()
  const host: Host = {
    tool: {
      hook: async (name: string, cb: any): Promise<unknown> => {
        toolHooks[name] = cb
        return { dispose: (): void => {} }
      },
    },
    session: {
      hook: async (name: string, cb: any): Promise<unknown> => {
        sessionHooks[name] = cb
        return { dispose: (): void => {} }
      },
      ...(sessionRecords
        ? {
            get: async ({ sessionID }: { sessionID: string }): Promise<any> =>
              sessionRecords.get(sessionID),
          }
        : {}),
    },
    event: { subscribe },
  }
  return { host, toolHooks, sessionHooks, pushEvent: push }
}

/**
 * Creates a fresh temp directory for a test's metrics or project files.
 * @param prefix Name prefix for the directory.
 * @returns The absolute temp directory path.
 */
export function tmpDir(prefix = "turnstile-test-"): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix))
}

/**
 * Builds an env that isolates config resolution from the developer's real
 * environment: `TURNSTILE_CONFIG` points at an empty config file in the
 * given temp dir, so the real `~/.config/opencode/turnstile.json` and any
 * real `TURNSTILE_*` variables never leak into tests. Injected wholesale
 * via `opts.env` (which replaces `process.env`).
 * @param dir Temp directory to place the empty config file in.
 * @returns The isolated env map.
 */
export function isolatedEnv(dir: string): Record<string, string> {
  const configPath = path.join(dir, "empty-config.json")
  fs.writeFileSync(configPath, "{}")
  return { TURNSTILE_CONFIG: configPath }
}

/**
 * Reads and parses the JSONL journal of a metrics directory.
 * @param metricsDir The metrics directory.
 * @returns Parsed journal entries (empty when the file does not exist).
 */
export function journalEntries(metricsDir: string): Array<Record<string, any>> {
  const p = path.join(metricsDir, "turnstile.jsonl")
  if (!fs.existsSync(p)) return []
  return fs
    .readFileSync(p, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line))
}

/**
 * Invokes a recorded tool hook callback, always awaited.
 * @param h The fake host tables.
 * @param name The hook name (`execute.before`, `execute.after`).
 * @param event The hook payload.
 */
export async function callTool(h: FakeHost, name: string, event: unknown): Promise<void> {
  const cb = h.toolHooks[name]
  assert.ok(cb, `no ${name} tool hook recorded`)
  await cb(event)
}

/**
 * Invokes a recorded session hook callback, always awaited.
 * @param h The fake host tables.
 * @param name The hook name (`prompt`, `generate`, `compaction`).
 * @param input The hook payload.
 */
export async function callSession(h: FakeHost, name: string, input: unknown): Promise<void> {
  const cb = h.sessionHooks[name]
  assert.ok(cb, `no ${name} session hook recorded`)
  await cb(input)
}

/**
 * Reads the raw trace text of a metrics directory.
 * @param metricsDir The metrics directory.
 * @returns Trace file contents, or "" when the file does not exist.
 */
export function traceText(metricsDir: string): string {
  const p = path.join(metricsDir, "gate-events.jsonl")
  return fs.existsSync(p) ? fs.readFileSync(p, "utf8") : ""
}

/**
 * Polls a predicate until it holds or a timeout elapses. Used to wait for
 * the plugin's async event-loop consumer to process pushed events.
 * @param predicate The condition to await; must eventually hold.
 * @param ms Max milliseconds to wait before failing.
 */
export async function waitUntil(predicate: () => boolean, ms = 1000): Promise<void> {
  const deadline = Date.now() + ms
  while (!predicate() && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  assert.ok(predicate(), "waitUntil: condition not met within timeout")
}
