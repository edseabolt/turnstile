/**
 * @fileoverview Host-wiring boundary: registers turnstile's hooks with the
 * OpenCode v2 host and owns the plugin lifecycle: hook registration, the
 * event-stream lifecycle, and cleanup (the stream itself lives in
 * src/hooks-events.ts). Shared state and services are built by
 * src/hooks-core.ts and consumed through the per-setup context; enforcement
 * decisions delegate to src/gates.ts; marker parsing to src/markers.ts;
 * persistence to src/journal.ts; bookkeeping to src/state.ts.
 *
 * Fail-open by contract: every hook body is guarded; only the deliberate
 * BLOCKED errors thrown by the gate layer propagate to the host.
 */

import * as fs from "node:fs"
import * as path from "node:path"
import { fileURLToPath } from "node:url"

import { configDigest } from "./config.ts"
import { BlockError } from "./gates.ts"
import { evaluateHostCompat, HOST_COMPAT } from "./host-compat.ts"
import type { CompatResult } from "./host-compat.ts"
import { createHooksCore } from "./hooks-core.ts"
import type { TurnstileContext } from "./hooks-core.ts"
import { startEventStream } from "./hooks-events.ts"
import { createPermissionHooks } from "./hooks-permission.ts"
import { createSessionHooks } from "./hooks-session.ts"
import { createToolHooks } from "./hooks-tool.ts"
import type { Host, ToolHookEvent, TurnstileOptions } from "./types.ts"

/**
 * Tracks a hook registration handle so it can be disposed on teardown.
 * @param reg Registration handle returned by a host hook call.
 * @param cleanups Disposal list to append to.
 */
function track(reg: unknown, cleanups: Array<() => void>): void {
  if (reg && typeof (reg as { dispose?: unknown }).dispose === "function") {
    cleanups.push(() => (reg as { dispose: () => void }).dispose())
  }
}

/**
 * Builds the disposer returned to the host: runs every tracked cleanup once;
 * individual dispose failures are inert.
 * @param cleanups The disposal list assembled during setup.
 * @returns A synchronous disposer.
 */
function disposeAll(cleanups: Array<() => void>): () => void {
  return () => {
    for (const fn of cleanups) {
      try {
        fn()
      } catch {
        // dispose failures are inert
      }
    }
  }
}

/**
 * Registers the three session hooks (prompt, generate, compaction). Each
 * registration is independent: a failure journals and skips that hook only.
 * @param h The live host context.
 * @param ctx The per-setup shared context.
 * @param cleanups Disposal list for successful registrations.
 * @returns The number of hooks successfully registered.
 */
async function registerSessionHooks(
  h: Host,
  ctx: TurnstileContext,
  cleanups: Array<() => void>,
): Promise<number> {
  if (typeof h.session?.hook !== "function") return 0
  const hook = h.session.hook
  const sessionHooks = createSessionHooks(ctx)
  const hooks: Array<["prompt" | "generate" | "compaction", Parameters<typeof hook>[1]]> = [
    ["prompt", sessionHooks.prompt],
    ["generate", sessionHooks.generate],
    ["compaction", sessionHooks.compaction],
  ]
  let count = 0
  for (const [name, fn] of hooks) {
    const ok = await registerHostHook(() => hook(name, fn), `session.${name}`, ctx, cleanups)
    if (ok) count++
  }
  return count
}

/**
 * Registers the permission-escalation hook: on a `task` dispatch
 * the host asks the plugin to evaluate whether the call should proceed. The
 * payload carries NO tool input, so escalation is driven by the parent
 * session's plan-gate state (planGateStatus), never the dispatch target.
 * Optional surface: an absent permission.hook degrades to no registration.
 * @param h The live host context.
 * @param ctx The per-setup shared context.
 * @param cleanups Disposal list for successful registrations.
 * @returns The number of hooks successfully registered (0 or 1).
 */
async function registerPermissionHook(
  h: Host,
  ctx: TurnstileContext,
  cleanups: Array<() => void>,
): Promise<number> {
  if (typeof h.permission?.hook !== "function") return 0
  const hook = h.permission.hook
  const { evaluate } = createPermissionHooks(ctx)
  const ok = await registerHostHook(
    () => hook("evaluate", evaluate),
    "permission.evaluate",
    ctx,
    cleanups,
  )
  return ok ? 1 : 0
}

/**
 * Builds the `execute.before` hook body: the only hook whose throw is
 * sanctioned — the gate layer's deliberate BlockError is rethrown to the
 * host; every other failure journals (fail-open).
 * @param ctx The per-setup shared context (journaler).
 * @param before The gate-layer before hook to guard.
 * @returns The guarded before hook body.
 */
function guardedToolBefore(
  ctx: TurnstileContext,
  before: (event: ToolHookEvent) => Promise<void>,
): (event: ToolHookEvent) => Promise<void> {
  return async (event: ToolHookEvent): Promise<void> => {
    try {
      await before(event)
    } catch (e) {
      if (e instanceof BlockError) throw e
      ctx.journaler.journal({ type: "error", error: `tool.execute.before: ${e}` })
    }
  }
}

/**
 * Registers the tool-level gate hooks (execute.before with the sanctioned
 * BlockError rethrow, and execute.after for trace).
 * @param h The live host context.
 * @param ctx The per-setup shared context.
 * @param cleanups Disposal list for successful registrations.
 * @returns The number of hooks successfully registered (0-2).
 */
async function registerToolHooks(
  h: Host,
  ctx: TurnstileContext,
  cleanups: Array<() => void>,
): Promise<number> {
  if (typeof h.tool?.hook !== "function") return 0
  const toolHook = h.tool.hook
  const toolHooks = createToolHooks(ctx)
  const before = guardedToolBefore(ctx, toolHooks.before)
  let count = 0
  const beforeOk = await registerHostHook(
    () => toolHook("execute.before", before),
    "tool.before",
    ctx,
    cleanups,
  )
  if (beforeOk) count++
  const afterOk = await registerHostHook(
    () => toolHook("execute.after", toolHooks.after),
    "tool.after",
    ctx,
    cleanups,
  )
  if (afterOk) count++
  return count
}

/**
 * Subscribes the event mirror (child→parent resolution, marker parsing from
 * child sessions, errors). Thrown deaths burn a cumulative restart budget; a
 * clean host recycle re-subscribes for free. The stream's supervisor never
 * rejects, so a stop is surfaced exactly once as a journaled error — never
 * thrown (the disposer stays synchronous and never awaits the stream).
 * @param h The live host context.
 * @param ctx The per-setup shared context.
 * @param cleanups Disposal list; the abort controller is appended.
 * @returns The number of hooks successfully registered (0 or 1).
 */
function registerEventStream(h: Host, ctx: TurnstileContext, cleanups: Array<() => void>): number {
  if (typeof h.event?.subscribe !== "function") return 0
  const controller = new AbortController()
  const consuming = startEventStream(ctx, h.event.subscribe, controller.signal)
  // Surface *why* marker ingestion stopped, exactly once, the moment the
  // supervisor stops — so a spent budget is never silent and a clean host
  // recycle never reaches this line. A dispose/abort resolves "aborted"
  // (silent), matching the abort-silent contract.
  void consuming.then((reason) => {
    if (reason === "aborted") return
    ctx.journaler.journal({
      type: "error",
      error: "event stream restart budget exhausted; session.text.* marker ingestion is disabled",
    })
  })
  // No .catch: the supervision promise never rejects, so a catch would be an untestable dead branch.
  cleanups.push(() => {
    controller.abort()
  })
  return 1
}

/**
 * Runs one host hook registration, tracking the handle for teardown. A failed
 * registration journals (fail-open) and does not count.
 * @param register The registration call (host hook invocation).
 * @param label The journal error label naming the surface.
 * @param ctx The per-setup shared context (journaler).
 * @param cleanups Disposal list for the successful registration.
 * @returns True when the registration succeeded.
 */
async function registerHostHook(
  register: () => Promise<unknown>,
  label: string,
  ctx: TurnstileContext,
  cleanups: Array<() => void>,
): Promise<boolean> {
  try {
    track(await register(), cleanups)
    return true
  } catch (e) {
    ctx.journaler.journal({ type: "error", error: `${label} hook registration: ${e}` })
    return false
  }
}

/**
 * Writes the one-per-boot setup heartbeat entry (telemetry only, never
 * blocks). Shared by the incompatible-host path and the full-setup path so
 * the entry shape lives in exactly one place.
 * @param ctx The per-setup shared context.
 * @param version The plugin version string (or null when unreadable).
 * @param compat The compat label to stamp on the heartbeat.
 * @param hooksCount The number of successfully registered hooks.
 */
function writeSetupHeartbeat(
  ctx: TurnstileContext,
  version: string | null,
  compat: "compatible" | "unknown" | "incompatible",
  hooksCount = 0,
): void {
  ctx.journaler.journal({
    type: "setup",
    version,
    digest: configDigest(ctx.config),
    hooks: hooksCount,
    compat,
    ...(ctx.config.trace
      ? { trace: true, agents: ctx.config.agents, metricsDir: ctx.config.metricsDir }
      : {}),
  })
}

/**
 * Evaluates the host-compat guard for one setup call: an incompatible host is
 * journaled, toasted, and heartbeat-stamped (fail-open to a full no-op); an
 * unreadable version journals a one-time `compat` warning and enforces as
 * usual.
 * @param ctx The per-setup shared context (journaler, toast).
 * @param hostVersion Host version provider; read inside the guarded
 *     evaluation so a throwing `app.version` getter degrades to `unknown`.
 * @param version The plugin version string (or null when unreadable).
 * @returns The compat verdict for the heartbeat stamp.
 */
async function evaluateCompatGuard(
  ctx: TurnstileContext,
  hostVersion: () => unknown,
  version: string | null,
): Promise<"compatible" | "unknown" | "incompatible"> {
  let compat: CompatResult
  try {
    compat = evaluateHostCompat(hostVersion(), version, HOST_COMPAT)
  } catch (e) {
    ctx.journaler.journal({ type: "error", error: `compat evaluation: ${e}` })
    compat = { verdict: "unknown", hostVersion: "", message: "" }
  }
  if (compat.verdict === "unknown") {
    journalUnknownCompat(ctx, compat, version)
    return "unknown"
  }
  if (compat.verdict !== "incompatible") return "compatible"
  await handleIncompatibleHost(ctx, compat, version)
  return "incompatible"
}

/**
 * Journals the one-time `compat` warning for an unreadable host version.
 * @param ctx The per-setup shared context (journaler).
 * @param compat The evaluated compat result (verdict `unknown`).
 * @param version The plugin version string (or null when unreadable).
 */
function journalUnknownCompat(
  ctx: TurnstileContext,
  compat: CompatResult,
  version: string | null,
): void {
  ctx.journaler.journal({
    type: "compat",
    event: "unknown-host",
    host: compat.hostVersion,
    plugin: version,
  })
}

/**
 * Journals and toasts the incompatible-host leg: records the host version and
 * the accepted range, then delivers the compat message as a warning toast.
 * A broken toast is journaled (fail-open) and never blocks setup.
 * @param ctx The per-setup shared context (journaler, toast).
 * @param compat The evaluated compat result (verdict `incompatible`).
 * @param version The plugin version string (or null when unreadable).
 */
async function handleIncompatibleHost(
  ctx: TurnstileContext,
  compat: CompatResult,
  version: string | null,
): Promise<void> {
  ctx.journaler.journal({
    type: "compat",
    event: "incompatible",
    host: compat.hostVersion,
    plugin: version,
    min: HOST_COMPAT.minInclusive,
    max: HOST_COMPAT.maxExclusive,
  })
  try {
    await ctx.toast?.(compat.message, "warning")
  } catch (e) {
    ctx.journaler.journal({ type: "error", error: `compat toast: ${e}` })
  }
}

/**
 * Reads the plugin version from package.json for the load heartbeat.
 *
 * Fail-open: returns null when package.json is unreadable (e.g. a bare
 * `setup.ts` + `src/` copy without it), mirroring the `install.mjs` version
 * read. Resolved from `import.meta.url` so it is correct under symlink
 * installs (Node realpaths the module URL to the repo) and npm installs
 * (`package.json` ships at the root). `pkgPath` is injectable so tests can
 * exercise the unreadable path without mocking `fs`.
 * @param pkgPath Optional package.json path override (tests).
 * @returns The version string, or null when it cannot be read.
 */
export function readPluginVersion(pkgPath?: string): string | null {
  try {
    const resolved =
      pkgPath ?? path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "package.json")
    return JSON.parse(fs.readFileSync(resolved, "utf8")).version ?? null
  } catch {
    return null
  }
}

/**
 * Registers every hook surface and returns the total count. Each registration
 * is independent (a failure journals and skips only that hook). The count
 * feeds the load heartbeat (7 on a full host: 3 session + 1 permission + 2
 * tool + 1 event subscriber).
 * @param h The live host context.
 * @param ctx The per-setup shared context.
 * @param cleanups Disposal list for successful registrations.
 * @returns The number of hooks successfully registered.
 */
async function registerAllHooks(
  h: Host,
  ctx: TurnstileContext,
  cleanups: Array<() => void>,
): Promise<number> {
  return (
    (await registerSessionHooks(h, ctx, cleanups)) +
    (await registerPermissionHook(h, ctx, cleanups)) +
    (await registerToolHooks(h, ctx, cleanups)) +
    registerEventStream(h, ctx, cleanups)
  )
}

/**
 * Binds the host surfaces the shared context needs up front: the session API
 * for the shared `resolveParent` helper (hooks already fire post-setup) and
 * the toast surface (optional-chained — an absent or broken `tui.toast.show`
 * is a no-op binder, so the session-end summary then delivers journal-only,
 * the headless path).
 * @param ctx The per-setup shared context.
 * @param h The live host context.
 */
function bindHostSurfaces(ctx: TurnstileContext, h: Host): void {
  ctx.bindHost(h.session)
  ctx.bindToast(h.tui?.toast?.show)
}

/**
 * The per-setup body: builds the shared context, applies the host-compat
 * guard, registers every hook surface, and returns a disposer that unwinds
 * them all.
 * @param h The live OpenCode host context.
 * @param fallbackHost The factory-time host context, used as a fallback for
 *     the compat version read.
 * @param opts Injected config/env overrides (tests); defaults to env.
 * @param version The plugin version string for the heartbeat (or null).
 * @returns A disposer that disposes every registration; failures inert.
 */
async function runSetup(
  h: Host,
  fallbackHost: Host | undefined | null,
  opts: TurnstileOptions,
  version: string | null,
): Promise<(() => void) | void> {
  const ctx = createHooksCore(opts)
  bindHostSurfaces(ctx, h)

  // Host-compat guard: an incompatible host is journaled, toasted, and
  // left hookless (fail-open to a full no-op); an unreadable version
  // enforces as usual with a one-time `compat` warning.
  const compat = await evaluateCompatGuard(
    ctx,
    () => h?.app?.version ?? fallbackHost?.app?.version,
    version,
  )
  if (compat === "incompatible") {
    writeSetupHeartbeat(ctx, version, compat)
    return () => {}
  }

  const cleanups: Array<() => void> = []
  // Load heartbeat: one entry per host-session boot, emitted after every
  // registration so `hooks` is accurate. Telemetry only — it never blocks.
  const hooks = await registerAllHooks(h, ctx, cleanups)
  writeSetupHeartbeat(ctx, version, compat, hooks)
  return disposeAll(cleanups)
}

/**
 * Builds the plugin factory: on each setup call it assembles the per-setup
 * shared context via createHooksCore (config, journaler, gates, ledger,
 * maps, services), then returns the async setup function that registers
 * every hook. All shared state is per-setup: a host calling setup() twice
 * gets fresh dedupe/metering state; the one-setup-per-load lifecycle makes
 * this unobservable.
 * @param _host The host context; unused at build time (hooks receive the
 *     live host at setup). Kept for factory-shape compatibility.
 * @param opts Injected config/env overrides (tests); defaults to env.
 * @returns The plugin setup function; resolves to a cleanup disposer.
 */
export function createTurnstile(
  _host: Host | undefined | null,
  opts: TurnstileOptions = {},
): (h: Host) => Promise<(() => void) | void> {
  // Version is read once here (fail-open, alongside the shared context build) for the
  // load heartbeat; null on exotic installs where package.json is unreadable.
  const version = readPluginVersion()

  /**
   * The plugin setup function handed to the host: registers the session,
   * tool, and event hooks, and returns a disposer that unwinds them all.
   * @param h The live OpenCode host context.
   * @returns A disposer that disposes every registration; failures inert.
   */
  return async function setup(h: Host): Promise<(() => void) | void> {
    return runSetup(h, _host, opts, version)
  }
}
