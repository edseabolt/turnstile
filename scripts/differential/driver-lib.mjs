/**
 * @fileoverview Shared helpers for the differential scenario drivers: tree
 * import probing, value normalization/serialization, a minimal fake OpenCode
 * host with a drain-tracked event bus, and an isolated metrics dir. A driver
 * module exports `scenario(treeRoot)` returning
 * `{ ok: true, cells: {key: value} }` or
 * `{ ok: false, code, message, module? }`; when executed directly it runs
 * `scenario(process.argv[2])` and prints the result as one JSON line, so the
 * harness can drive stateful scenarios one subprocess per tree.
 */

import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { pathToFileURL } from "node:url"

/**
 * Dynamically imports one repo-relative module from a tree root.
 * @param {string} treeRoot The tree root directory.
 * @param {string} spec The repo-relative specifier (e.g. "src/config.ts").
 * @returns {Promise<unknown>} The module namespace.
 */
export async function importFrom(treeRoot, spec) {
  return import(pathToFileURL(path.join(treeRoot, spec)).href)
}

/**
 * Probes the modules a scenario needs, mapping `ERR_MODULE_NOT_FOUND` to a
 * structured skip so the harness can report `SKIPPED (absent in ref)`.
 * @param {string} treeRoot The tree root directory.
 * @param {string[]} specs The repo-relative specifiers to probe.
 * @returns {Promise<{ok: boolean, modules?: Object<string, unknown>, code?: string, module?: string}>}
 *     The probed modules, or the absence record.
 */
export async function probeModules(treeRoot, specs) {
  const modules = {}
  for (const spec of specs) {
    try {
      modules[spec] = await importFrom(treeRoot, spec)
    } catch (e) {
      if (
        e &&
        (e.code === "ERR_MODULE_NOT_FOUND" || String(e.message).includes("Cannot find module"))
      ) {
        return { ok: false, code: "ERR_MODULE_NOT_FOUND", module: spec }
      }
      throw e
    }
  }
  return { ok: true, modules }
}

/**
 * Recursively converts Sets to sorted arrays and Maps to sorted entry
 * arrays, so state objects compare deterministically as JSON.
 * @param {unknown} value The value to normalize.
 * @returns {unknown} The JSON-safe clone.
 */
export function normalize(value) {
  if (value instanceof Set) return [...value].map(String).sort()
  if (value instanceof Map) {
    return [...value.entries()]
      .map(([k, v]) => [String(k), normalize(v)])
      .sort((a, b) => String(a[0]).localeCompare(String(b[0])))
  }
  if (Array.isArray(value)) return value.map(normalize)
  if (value !== null && typeof value === "object") {
    const out = {}
    for (const k of Object.keys(value).sort()) out[k] = normalize(value[k])
    return out
  }
  return value
}

/**
 * Creates a fresh temp metrics directory.
 * @returns {string} The absolute temp directory.
 */
export function tmpMetricsDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "turnstile-diff-metrics-"))
}

/**
 * Creates a fresh temp project directory (the driver chdirs into it so the
 * plans scan and git probes see a stable, empty project).
 * @returns {string} The absolute temp directory.
 */
export function tmpProjectDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "turnstile-diff-project-"))
}

/**
 * Builds an isolated env for a boot: `TURNSTILE_CONFIG` points at a config
 * file in the metrics dir with `journalPerSession: false`, so journals land
 * on the single shared file the drivers read, and the developer's real
 * config/env never leak in.
 * @param {string} metricsDir The temp metrics dir.
 * @returns {Record<string, string>} The env map.
 */
export function isolatedEnv(metricsDir) {
  const configPath = path.join(metricsDir, "empty-config.json")
  fs.writeFileSync(configPath, JSON.stringify({ journalPerSession: false }))
  return { TURNSTILE_CONFIG: configPath }
}

/**
 * Reads and parses a metrics dir's shared JSONL journal.
 * @param {string} metricsDir The metrics dir.
 * @returns {Array<Object>} Parsed entries (empty when absent).
 */
export function readJournal(metricsDir) {
  const p = path.join(metricsDir, "turnstile.jsonl")
  if (!fs.existsSync(p)) return []
  return fs
    .readFileSync(p, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line)
      } catch {
        return null
      }
    })
    .filter((e) => e !== null)
}

/**
 * Builds the fake host's hook registry: each surface (`tool`, `session`,
 * `permission`) records its callbacks by name in the given table.
 * @param {Object<string, Record<string, Function>>} tables The per-surface
 *     callback tables keyed by surface name.
 * @returns {Object} The host's hook surfaces.
 */
function makeHookSurfaces(tables) {
  return {
    tool: {
      hook: async (name, cb) => {
        tables.tool[name] = cb
        return { dispose: () => {} }
      },
    },
    session: {
      hook: async (name, cb) => {
        tables.session[name] = cb
        return { dispose: () => {} }
      },
    },
    permission: {
      hook: async (name, cb) => {
        tables.permission[name] = cb
        return { dispose: () => {} }
      },
    },
  }
}

/**
 * Creates a minimal fake OpenCode v2 host: records tool/session/permission
 * hook callbacks by name and exposes a push-based event bus whose `push`
 * resolves when the consumer finished handling the event.
 * @returns {{host: Object, toolHooks: Object, sessionHooks: Object, permissionHooks: Object, pushEvent: (event: Object) => Promise<void>}}
 *     The host plus the recorded callback tables and event pusher.
 */
export function makeFakeHost() {
  const tables = { tool: {}, session: {}, permission: {} }
  const queue = []
  const pending = []
  let current = null
  const subscribe = makeSubscribe({
    queue,
    pending,
    get: () => current,
    set: (entry) => {
      current = entry
    },
  })
  const host = { ...makeHookSurfaces(tables), event: { subscribe } }
  return {
    host,
    toolHooks: tables.tool,
    sessionHooks: tables.session,
    permissionHooks: tables.permission,
    pushEvent: subscribe.pushEvent,
  }
}

/**
 * Builds the subscription's async iterator: drains the in-flight event
 * before yielding the next queued one, waits on the notify resolver when the
 * queue is empty, and on abort drains everything and stops.
 * @param {{queue: Object[], pending: Object[], get: () => Object|null, set: (entry: Object|null) => void}} state
 *     The shared queue state (see `makeSubscribe`).
 * @param {{get: () => boolean, set: (v: boolean) => void}} aborted The abort
 *     flag accessor shared with the pusher.
 * @param {{get: (() => void)|null, set: ((r: () => void) => void)}} notify
 *     The wakeup resolver accessor shared with the pusher.
 * @param {AbortSignal} [signal] The consumer's abort signal.
 * @returns {{next: () => Promise<{done: boolean, value: Object|undefined}>}} The iterator.
 */
function makeIterator(state, aborted, notify, signal) {
  const { pending } = state
  signal?.addEventListener(
    "abort",
    () => {
      aborted.set(true)
      for (const entry of pending.splice(0)) entry.drain()
      const n = notify.get()
      notify.set(null)
      n?.()
    },
    { once: true },
  )
  return { next: () => nextEvent(state, aborted, notify, signal) }
}

/**
 * Yields the next event from the queue: drains the in-flight event first,
 * returns the next queued one, or waits on the wakeup resolver.
 * @param {{queue: Object[], pending: Object[], get: () => Object|null, set: (entry: Object|null) => void}} state
 *     The shared queue state (see `makeIterator`).
 * @param {{get: () => boolean}} aborted The abort flag accessor.
 * @param {{get: (() => void)|null, set: ((r: () => void) => void)}} notify
 *     The wakeup resolver accessor.
 * @param {AbortSignal} [signal] The consumer's abort signal.
 * @returns {Promise<{done: boolean, value: Object|undefined}>} The iterator step.
 */
async function nextEvent(state, aborted, notify, signal) {
  for (;;) {
    const current = state.get()
    if (current) {
      current.drain()
      state.set(null)
    }
    if (aborted.get() || signal?.aborted) return { done: true, value: undefined }
    const entry = state.queue.shift()
    if (entry) {
      state.set(entry)
      return { done: false, value: entry.event }
    }
    await new Promise((resolve) => {
      notify.set(resolve)
    })
  }
}

/**
 * Builds the fake host's event subscription: a push-based async-iterable
 * queue whose `push` resolves when the consumer finished handling the event,
 * and whose iterator drains the in-flight event before yielding the next.
 * The returned `subscribe` carries the pusher as `subscribe.pushEvent`.
 * @param {{queue: Object[], pending: Object[], get: () => Object|null, set: (entry: Object|null) => void}} state
 *     The shared queue state (`queue` waiting entries, `pending` undrained
 *     entries, `get`/`set` access to the single in-flight entry).
 * @returns {(options?: {signal?: AbortSignal}) => Object} The
 *     `event.subscribe` implementation.
 */
function makeSubscribe(state) {
  const { pending } = state
  let notify = null
  let aborted = false
  const push = (event) => {
    if (aborted) return Promise.resolve()
    const entry = { event, drain: () => {} }
    const drained = new Promise((resolve) => {
      entry.drain = () => {
        const i = pending.indexOf(entry)
        if (i !== -1) pending.splice(i, 1)
        resolve()
      }
    })
    pending.push(entry)
    state.queue.push(entry)
    const n = notify
    notify = null
    n?.()
    return drained
  }
  const subscribe = makeSubscriber(state, {
    aborted: () => aborted,
    setAborted: (v) => (aborted = v),
    notify: () => notify,
    setNotify: (r) => (notify = r),
  })
  subscribe.pushEvent = push
  return subscribe
}

/**
 * Builds the `event.subscribe` function: each call returns an object whose
 * async iterator is bound to the shared queue state and the pusher's
 * abort/notify accessors.
 * @param {{queue: Object[], pending: Object[], get: () => Object|null, set: (entry: Object|null) => void}} state
 *     The shared queue state (see `makeIterator`).
 * @param {{aborted: () => boolean, setAborted: (v: boolean) => void, notify: (() => void)|null|(() => void), setNotify: (r: (() => void)|null) => void}} accessors
 *     The abort flag and wakeup resolver accessors shared with the pusher.
 * @returns {(options?: {signal?: AbortSignal}) => Object} The
 *     `event.subscribe` implementation.
 */
function makeSubscriber(state, accessors) {
  return (options) => ({
    [Symbol.asyncIterator]: () =>
      makeIterator(
        state,
        { get: accessors.aborted, set: accessors.setAborted },
        { get: accessors.notify, set: accessors.setNotify },
        options?.signal,
      ),
  })
}

/**
 * Invokes a recorded hook callback, always awaited.
 * @param {Object} hooks The recorded callback table.
 * @param {string} name The hook name.
 * @param {unknown} event The hook payload.
 * @returns {Promise<void>} Resolves when the callback finished.
 */
export async function callHook(hooks, name, event) {
  const cb = hooks[name]
  if (!cb) throw new Error(`no ${name} hook recorded`)
  await cb(event)
}

/**
 * Polls a predicate until it holds or the timeout elapses.
 * @param {() => boolean} predicate The condition to await.
 * @param {number} ms Max milliseconds to wait (default 2000).
 * @returns {Promise<void>} Resolves when the predicate holds; throws otherwise.
 */
export async function waitUntil(predicate, ms = 2000) {
  const deadline = Date.now() + ms
  while (!predicate() && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  if (!predicate()) throw new Error("waitUntil: condition not met within timeout")
}

/**
 * Runs a scenario body with the module probe applied, mapping a ref-side
 * module absence to the structured skip record.
 * @param {string} treeRoot The tree root.
 * @param {string[]} specs The required repo-relative modules.
 * @param {(modules: Object<string, unknown>) => Promise<Object>} body The scenario body.
 * @returns {Promise<{ok: boolean, cells?: Object, code?: string, module?: string}>}
 *     The scenario result.
 */
export async function withModules(treeRoot, specs, body) {
  const probe = await probeModules(treeRoot, specs)
  if (!probe.ok) return { ok: false, code: probe.code, module: probe.module }
  const cells = await body(probe.modules)
  return { ok: true, cells }
}

/**
 * Prints a scenario result as one JSON line (the subprocess driver contract).
 * @param {{ok: boolean, cells?: Object, code?: string, message?: string, module?: string}} result
 *     The scenario result.
 */
export function emit(result) {
  process.stdout.write(JSON.stringify(result))
}
