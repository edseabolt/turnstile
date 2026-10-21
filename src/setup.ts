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
import { createHooksCore } from "./hooks-core.ts"
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
 * Builds the turnstile plugin for a host: each setup call builds its own
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
    const ctx = createHooksCore(opts)

    // Bind the host session API for the shared `resolveParent` helper (hooks
    // already fire post-setup).
    ctx.bindHost(h.session)
    const cleanups: Array<() => void> = []
    // Count of successfully registered hooks (3 session + 1 permission + 2 tool
    // + 1 event subscriber = 7 on a full host); feeds the load heartbeat below.
    let hooks = 0
    // Task-state reset: a new user prompt starts a new task.
    if (typeof h.session?.hook === "function") {
      const sessionHooks = createSessionHooks(ctx)

      try {
        const reg = await h.session.hook("prompt", sessionHooks.prompt)
        track(reg, cleanups)
        hooks++
      } catch (e) {
        ctx.journaler.journal({ type: "error", error: `session.prompt hook registration: ${e}` })
      }

      // Decoding clamps + compaction context.
      try {
        const reg = await h.session.hook("generate", sessionHooks.generate)
        track(reg, cleanups)
        hooks++
      } catch (e) {
        ctx.journaler.journal({ type: "error", error: `session.generate hook registration: ${e}` })
      }

      try {
        const reg = await h.session.hook("compaction", sessionHooks.compaction)
        track(reg, cleanups)
        hooks++
      } catch (e) {
        ctx.journaler.journal({
          type: "error",
          error: `session.compaction hook registration: ${e}`,
        })
      }
    }

    // Permission escalation (Phase 1): on a `task` dispatch the host asks the
    // plugin to evaluate whether the call should proceed. The payload carries
    // NO tool input, so escalation is driven by the parent session's plan-gate
    // state (planGateStatus), never the dispatch target. Optional surface: an
    // absent permission.hook degrades to today's behavior exactly.
    if (typeof h.permission?.hook === "function") {
      const permissionHooks = createPermissionHooks(ctx)

      try {
        const reg = await h.permission.hook("evaluate", permissionHooks.evaluate)
        track(reg, cleanups)
        hooks++
      } catch (e) {
        // A registration failure journals (fail-open); a bad hook leaves
        // today's behavior exactly.
        ctx.journaler.journal({
          type: "error",
          error: `permission.evaluate hook registration: ${e}`,
        })
      }
    }

    // Tool-level gate + trace.
    if (typeof h.tool?.hook === "function") {
      const toolHooks = createToolHooks(ctx)

      try {
        const reg = await h.tool.hook("execute.before", async (event: ToolHookEvent) => {
          try {
            await toolHooks.before(event)
          } catch (e) {
            // execute.before is the only hook body whose throw is
            // sanctioned: the gate layer's deliberate BlockError is
            // rethrown to the host; every other failure journals
            // (fail-open).
            if (e instanceof BlockError) throw e
            ctx.journaler.journal({ type: "error", error: `tool.execute.before: ${e}` })
          }
        })
        track(reg, cleanups)
        hooks++
      } catch (e) {
        ctx.journaler.journal({ type: "error", error: `tool.before hook registration: ${e}` })
      }

      try {
        const reg = await h.tool.hook("execute.after", toolHooks.after)
        track(reg, cleanups)
        hooks++
      } catch (e) {
        ctx.journaler.journal({ type: "error", error: `tool.after hook registration: ${e}` })
      }
    }

    // Event mirror: child→parent resolution, marker parsing from child
    // sessions (primary path if task results are summarized), errors.
    if (typeof h.event?.subscribe === "function") {
      const controller = new AbortController()
      const consuming = startEventStream(ctx, h.event.subscribe, controller.signal)
      cleanups.push(() => {
        controller.abort()
        void consuming
      })
      hooks++
    }

    // Load heartbeat: one entry per host-session boot, emitted after every
    // registration so `hooks` is accurate. Telemetry only — it never blocks.
    ctx.journaler.journal({
      type: "setup",
      version,
      digest: configDigest(ctx.config),
      hooks,
      ...(ctx.config.trace
        ? { trace: true, agents: ctx.config.agents, metricsDir: ctx.config.metricsDir }
        : {}),
    })

    /**
     * Disposes every hook registration tracked during setup.
     * @returns Nothing; individual dispose failures are inert.
     */
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
}
