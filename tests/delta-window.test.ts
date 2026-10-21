/**
 * @fileoverview Delta-window bound tests: the streamed-marker reassembly
 * window is derived from the effective compiled marker sources with a 512
 * char floor (pure helper), and a configured marker literal past the floor
 * raises the bound (createHooksCore seam), so a long marker split across
 * session.text.delta chunks still reassembles and first-sights once. The seam
 * tests are hermetic: an injected env and a temp metrics dir keep config
 * resolution and journaling out of the real home directory.
 */

import { test } from "node:test"
import assert from "node:assert/strict"

import { createHooksCore, type TurnstileContext } from "../src/hooks-core.ts"
import { GATE_RE, VERDICT_RE, deltaWindowFloorChars } from "../src/markers.ts"
import type { TurnstileConfig } from "../src/types.ts"
import { turnstile } from "../turnstile.ts"
import { isolatedEnv, journalEntries, makeFakeHost, tmpDir, waitUntil } from "./helpers.ts"

/** A literal marker text past the 512 floor, shared by the seam and
 *  reassembly tests (no regex metacharacters, so it compiles verbatim). */
const LONG_GATE_MARKER = `GATE: PASS tests=1 passed=1 failed=1 ${"z".repeat(600)}`

/**
 * Creates a fresh hooks-core context over an isolated env and a temp metrics
 * dir, so neither config resolution nor journaling touches the real home.
 * @param config Injected config overrides (applied last by loadConfig).
 * @returns The context plus the temp metrics dir (for journal assertions).
 */
function coreWith(config: Partial<TurnstileConfig>): { ctx: TurnstileContext; metricsDir: string } {
  const metricsDir = tmpDir()
  const ctx = createHooksCore({
    env: isolatedEnv(metricsDir),
    config: { metricsDir, ...config },
  })
  return { ctx, metricsDir }
}

/** The default marker sources are short, so the bound stays at the 512 floor
 *  (default-config behavior is unchanged). */
test("deltaWindowFloorChars keeps the 512 floor for the default marker sources", () => {
  assert.equal(deltaWindowFloorChars(GATE_RE.source, VERDICT_RE.source), 512)
})

/** Past the floor, the bound is the sum of both sources, so each regex alone
 *  gets ≥2× slack over its own source length. */
test("deltaWindowFloorChars returns the sum of both sources past the floor", () => {
  assert.equal(deltaWindowFloorChars("a".repeat(600), "b".repeat(40)), 640)
})

/** A configured gateMarker past the floor raises the context's bound to the
 *  sum of the effective sources, while the unconfigured verdict marker keeps
 *  its default source. */
test("a long configured gateMarker raises the context's delta-window bound", () => {
  const { ctx } = coreWith({ gateMarker: LONG_GATE_MARKER })
  assert.equal(ctx.verdictRe.source, VERDICT_RE.source, "the verdict marker stays at its default")
  assert.ok(ctx.maxDeltaWindowChars >= ctx.gateRe.source.length, "the bound covers the gate source")
  assert.equal(
    ctx.maxDeltaWindowChars,
    ctx.gateRe.source.length + VERDICT_RE.source.length,
    "the bound is the sum of both effective sources",
  )
})

/** An invalid configured marker source falls back through compileMarkerRegex,
 *  so the bound derives from the effective (default) source, not the broken one. */
test("an invalid configured gateMarker derives the bound from the default source", () => {
  const { ctx } = coreWith({ gateMarker: "GATE: (unclosed" })
  assert.equal(ctx.gateRe.source, GATE_RE.source, "the fallback regex is in effect")
  assert.equal(ctx.maxDeltaWindowChars, 512, "the bound derives from the default source")
})

/**
 * A marker longer than the 512 floor, split across two session.text.delta
 * chunks, is reassembled by the per-session sliding window (whose bound now
 * covers it), so the flip is still observed exactly once with the exact
 * marker text — a fixed 512 window would have evicted the head before the
 * tail completed.
 */
test("a marker past the floor still reassembles across two deltas", async () => {
  const metricsDir = tmpDir()
  const h = makeFakeHost()
  const setup = turnstile(h.host, {
    env: isolatedEnv(metricsDir),
    config: { metricsDir, gateMarker: LONG_GATE_MARKER, gateEvidence: "flag" },
  })
  const dispose = (await setup(h.host)) as () => void
  h.pushEvent({
    type: "session.created",
    data: { sessionID: "c1", parentID: "p1", agent: "test-runner" },
  })
  h.pushEvent({ type: "session.error", data: { sessionID: "c1", error: "warmup" } })
  await waitUntil(() =>
    journalEntries(metricsDir).some((l) => l.type === "error" && l.error === "warmup"),
  )
  const half = Math.floor(LONG_GATE_MARKER.length / 2)
  // First chunk carries only the marker head — an incomplete parse, no first-sight.
  h.pushEvent({
    type: "session.text.delta",
    data: { sessionID: "c1", delta: LONG_GATE_MARKER.slice(0, half) },
  })
  // Second chunk completes the marker when folded into the window.
  h.pushEvent({
    type: "session.text.delta",
    data: { sessionID: "c1", delta: LONG_GATE_MARKER.slice(half) },
  })
  await waitUntil(() =>
    journalEntries(metricsDir).some((l) => l.type === "gate" && l.result === "PASS"),
  )
  const gates = journalEntries(metricsDir).filter((l) => l.type === "gate" && l.result === "PASS")
  assert.equal(gates.length, 1)
  assert.equal(gates[0]?.marker, LONG_GATE_MARKER)
  dispose()
})
