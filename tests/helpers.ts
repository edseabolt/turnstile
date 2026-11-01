/**
 * @fileoverview Test helpers: fake OpenCode host, temp directories, and
 * journal/trace readers. All tests inject config with a temp `metricsDir`,
 * so no test writes to the real metrics directory.
 */

import * as fs from "node:fs"
import assert from "node:assert/strict"
import * as os from "node:os"
import * as path from "node:path"
import type { TestContext } from "node:test"
import { defaultConfig, mergeConfig } from "../src/config.ts"
import { orchestratorPolicyFor } from "../src/policy.ts"
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
  /** Permission hook callbacks keyed by hook name (`evaluate`, …). */
  permissionHooks: Record<string, (event: any) => unknown | Promise<unknown>>
  /**
   * Pushes a stream event to the host's `event.subscribe` consumer.
   * Resolves when the consumer has finished handling the event (or the
   * stream is aborted), so awaiting it orders the test deterministically
   * behind the handler; an un-awaited call remains valid when the test
   * does not need that ordering.
   */
  pushEvent: (event: { type: string; data?: unknown; properties?: unknown }) => Promise<void>
  /** Recorded toast calls (`tui.toast.show`), in delivery order. */
  toasts: Array<{ message: string; variant?: string }>
  /** Recorded `session.prompt` calls, in delivery order. */
  sessionPrompts: Array<{ sessionID: string; text: string }>
}

/** A promise with externally held settlement controls. */
export interface Deferred<T = undefined> {
  /** The promise that the controls settle. */
  promise: Promise<T>
  /** Settles the promise with a value. */
  resolve: (value: T) => void
  /** Rejects the promise with a reason. */
  reject: (reason?: unknown) => void
}

/**
 * Creates a promise the caller can settle from outside — used to park a
 * plugin await on a controllable lookup (e.g. `session.get`) and release it
 * at a chosen point, such as after a dispose. The Promise executor runs
 * synchronously in the constructor, so the controls are assigned before the
 * returned object exists: no definite-assignment marker is needed and the
 * module stays erasable TypeScript.
 * @returns The promise plus its resolve/reject controls.
 */
export function createDeferred<T = undefined>(): Deferred<T> {
  const controls: { resolve?: (value: T) => void; reject?: (reason?: unknown) => void } = {}
  const promise = new Promise<T>((res, rej) => {
    controls.resolve = res
    controls.reject = rej
  })
  return {
    promise,
    resolve: (value: T): void => {
      controls.resolve?.(value)
    },
    reject: (reason?: unknown): void => {
      controls.reject?.(reason)
    },
  }
}

/** A queued bus event plus the boundary that resolves its pusher's promise. */
type BusEvent = { event: any; drain: () => void }

/**
 * Creates a push-based async-iterable event bus backing a fake host's
 * `event.subscribe`. The iterable ends when the subscriber's abort signal
 * fires (the plugin's dispose path), mirroring the real host stream.
 *
 * Each pushed event carries a drain boundary: the promise `push` returns
 * resolves once the consumer has finished handling the event. The consumer
 * awaits each handler before its next `next()` call, and the iterator
 * resolves the previous event's boundary at the top of that call, so the
 * boundary is a precise "handler complete" signal. Any still-pending
 * boundary also resolves when the stream is aborted, so a late push can
 * never hang a disposed test.
 * @returns The push function and the subscribe factory.
 */
function makeEventBus(): {
  push: (event: any) => Promise<void>
  subscribe: (options?: { signal?: AbortSignal }) => AsyncIterable<any>
} {
  const queue: BusEvent[] = []
  const pending: BusEvent[] = []
  let notify: (() => void) | null = null
  let current: BusEvent | null = null
  let aborted = false
  const push = (event: any): Promise<void> => {
    if (aborted) return Promise.resolve()
    const entry: BusEvent = { event, drain: (): void => {} }
    const drained = new Promise<void>((resolve) => {
      entry.drain = (): void => {
        const i = pending.indexOf(entry)
        if (i !== -1) pending.splice(i, 1)
        resolve()
      }
    })
    pending.push(entry)
    queue.push(entry)
    const n = notify
    notify = null
    n?.()
    return drained
  }
  const subscribe = (options?: { signal?: AbortSignal }): AsyncIterable<any> => ({
    [Symbol.asyncIterator](): AsyncIterator<any> {
      const signal = options?.signal
      const onAbort = (): void => {
        aborted = true
        for (const entry of pending.splice(0)) entry.drain()
        const n = notify
        notify = null
        n?.()
      }
      signal?.addEventListener("abort", onAbort, { once: true })
      return {
        next: async (): Promise<IteratorResult<any>> => {
          for (;;) {
            // The consumer only calls next() after the previous handler has
            // completed, so the previous event is drained here.
            if (current) {
              current.drain()
              current = null
            }
            if (signal?.aborted) {
              signal.removeEventListener("abort", onAbort)
              return { done: true, value: undefined }
            }
            const entry = queue.shift()
            if (entry) {
              current = entry
              return { done: false, value: entry.event }
            }
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
 * @param opts Optional host behavior: `sessionGet` delegates `session.get`
 *     to a caller-controlled function (checked first — a controllable
 *     lookup window); `sessionRecords` backs the `session.get` API with a
 *     session-ID → record map; `throwingGet` makes `session.get` reject
 *     (models a record not yet visible).
 * @returns The host plus the recorded callback tables and event pusher.
 */
export function makeFakeHost(opts?: {
  /** When set, `session.get` delegates to this function (checked first). */
  sessionGet?: (input: { sessionID: string }) => Promise<any>
  sessionRecords?: Map<string, any>
  /** When set, `session.get` rejects (models a record not yet visible). */
  throwingGet?: boolean
  /**
   * Whether the fake host exposes the `permission` surface (default true: a
   * full v2.0.27 host passes the evaluate callback). Set false to model the
   * degraded host without the permission surface.
   */
  permission?: boolean
  /**
   * Whether the fake host exposes the `session` surface (default true). Set
   * false to model a host without session hooks (the `g_session` degradation
   * path in `setup.ts`).
   */
  session?: boolean
  /**
   * Whether the fake host exposes the `tool` surface (default true). Set false
   * to model a host without tool hooks (the `g_tool` degradation path).
   */
  tool?: boolean
  /**
   * Whether the fake host exposes the `tui.toast` surface (default false).
   * The recorded calls land in the returned `toasts`; `toastReject` makes
   * each `show` reject so the failure path is testable.
   */
  tui?: boolean
  /** When set (with `tui`), every toast `show` rejects with an Error. */
  toastReject?: boolean
  /**
   * Whether the fake host exposes `session.prompt` (default true when the
   * session surface exists). Recorded calls land in the returned
   * `sessionPrompts`; `sessionPromptReject` makes each prompt reject so the
   * failure path is testable.
   */
  sessionPrompt?: boolean
  /** When set, every `session.prompt` rejects with an Error. */
  sessionPromptReject?: boolean
  /**
   * When set, the fake host exposes `app` (v2 Context.app identity block)
   * carrying this version string; feeds the host-compat guard at setup.
   */
  appVersion?: string
}): FakeHost {
  const withPermission = opts?.permission ?? true
  const withSession = opts?.session ?? true
  const withTool = opts?.tool ?? true
  const toolHooks: Record<string, (event: any) => Promise<void> | void> = {}
  const sessionHooks: Record<string, (input: any) => Promise<void> | void> = {}
  const permissionHooks: Record<string, (event: any) => Promise<void> | void> = {}
  const sessionRecords = opts?.sessionRecords
  const { push, subscribe } = makeEventBus()
  const toasts: Array<{ message: string; variant?: string }> = []
  const sessionPrompts: Array<{ sessionID: string; text: string }> = []
  const withSessionPrompt = opts?.sessionPrompt ?? true
  const host: Host = {
    ...(withTool
      ? {
          tool: {
            hook: async (name: string, cb: any): Promise<unknown> => {
              toolHooks[name] = cb
              return { dispose: (): void => {} }
            },
          },
        }
      : {}),
    ...(withSession
      ? {
          session: {
            hook: async (name: string, cb: any): Promise<unknown> => {
              sessionHooks[name] = cb
              return { dispose: (): void => {} }
            },
            ...(opts?.sessionGet
              ? { get: opts.sessionGet }
              : opts?.throwingGet
                ? {
                    get: async (): Promise<any> => {
                      throw new Error("not visible")
                    },
                  }
                : sessionRecords
                  ? {
                      get: async ({ sessionID }: { sessionID: string }): Promise<any> =>
                        sessionRecords.get(sessionID),
                    }
                  : {}),
            ...(withSessionPrompt
              ? {
                  prompt: async (input: { sessionID: string; text: string }): Promise<unknown> => {
                    if (opts?.sessionPromptReject) throw new Error("prompt failed")
                    sessionPrompts.push(input)
                    return undefined
                  },
                }
              : {}),
          },
        }
      : {}),
    event: { subscribe },
    ...(opts?.tui
      ? {
          tui: {
            toast: {
              show: async (input: { message: string; variant?: string }): Promise<unknown> => {
                if (opts?.toastReject) throw new Error("toast failed")
                toasts.push(input)
                return undefined
              },
            },
          },
        }
      : {}),
    ...(opts?.appVersion !== undefined
      ? { app: { name: "opencode", version: opts.appVersion } }
      : {}),
    ...(withPermission
      ? {
          permission: {
            hook: async (name: string, cb: any): Promise<unknown> => {
              permissionHooks[name] = cb
              return { dispose: (): void => {} }
            },
          },
        }
      : {}),
  }
  return { host, toolHooks, sessionHooks, permissionHooks, pushEvent: push, toasts, sessionPrompts }
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
 * Invokes a recorded permission hook callback, always awaited. Used to drive
 * the `evaluate` handler directly (the host calls it on a permission request).
 * @param h The fake host tables.
 * @param name The hook name (`evaluate`).
 * @param event The permission payload (mutated in place by the handler).
 */
export async function callPermission(h: FakeHost, name: string, event: unknown): Promise<void> {
  const cb = h.permissionHooks[name]
  assert.ok(cb, `no ${name} permission hook recorded`)
  await cb(event)
}

/**
 * Reads the raw trace text of a metrics directory.
 * @param metricsDir The metrics directory.
 * @returns Trace file contents, or "" when the file does not exist.
 */
export function traceText(metricsDir: string): string {
  const p = path.join(metricsDir, "gate-events.log")
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

/** Controls for a clock frozen by {@link frozenClock}. */
export interface FrozenClock {
  /** Advances the frozen clock by the given number of milliseconds. */
  advance(ms: number): void
  /** Restores the original `Date.now`; safe to call more than once. */
  restore(): void
}

/**
 * Freezes `Date.now` at the call moment for a test's duration, so latch TTLs
 * and marker timestamps can be aged deterministically instead of by sleeping.
 * The original `Date.now` is restored both by {@link FrozenClock.restore}
 * (idempotent) and through the test's `after` hook, so a failed assertion
 * never leaks the patch into a later test.
 * @param t The test context, used to register the after-hook restore.
 * @returns Controls for advancing and restoring the frozen clock.
 */
export function frozenClock(t: TestContext): FrozenClock {
  const realNow = Date.now
  let value = realNow()
  ;(Date as unknown as { now: () => number }).now = (): number => value
  let restored = false
  const restore = (): void => {
    if (restored) return
    restored = true
    ;(Date as unknown as { now: () => number }).now = realNow
  }
  t.after(restore)
  return {
    advance: (ms: number): void => {
      value += ms
    },
    restore,
  }
}

/**
 * Builds the orchestrator policy text a test can expect to be prepended for
 * the given injected config overrides: the same builder the plugin runs at
 * setup time (`orchestratorPolicyFor`) over the code defaults merged with
 * the overrides through the repo's layered-resolution primitive
 * (`mergeConfig`), so tests never re-implement config resolution or the
 * policy text itself.
 * @param overrides Injected config overrides, the same shape as a test
 *     boot's `config` patch (typically includes a temp `metricsDir`).
 * @returns The policy text the plugin would prepend for that config.
 */
export function expectedPolicy(overrides: Record<string, unknown> = {}): string {
  const { config } = mergeConfig(defaultConfig({}), overrides)
  return orchestratorPolicyFor(config)
}
