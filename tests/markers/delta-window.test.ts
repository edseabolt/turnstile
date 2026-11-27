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

import { createHooksCore, type TurnstileContext } from "../../src/hooks/hooks-core.ts"
import { createEventHandlers } from "../../src/hooks/event-stream-handlers.ts"
import {
  GATE_RE,
  VERDICT_RE,
  deltaWindowFloorChars,
  findTruncatedMarkerSpans,
} from "../../src/markers/markers.ts"
import type { TurnstileConfig } from "../../src/util/types.ts"
import { turnstile } from "../../turnstile.ts"
import { isolatedEnv, journalEntries, makeFakeHost, tmpDir, waitUntil } from "../support/helpers.ts"

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

/** The default marker fits the window, so no truncation is reported. */
test("findTruncatedMarkerSpans returns nothing when the buffer fits the window", () => {
  const buffer = "GATE: PASS tests=1 passed=1 failed=1"
  assert.deepEqual(findTruncatedMarkerSpans(buffer, buffer, "", GATE_RE), [])
})

/** A match whose head was tail-sliced away is reported; a match starting at
 *  or after the cut point is fully inside the window and not reported. */
test("findTruncatedMarkerSpans reports a match whose head was tail-sliced away", () => {
  // A non-anchored custom source, so the match start is a plain index.
  const custom = /GATE: (PASS|FAIL) tests=\d+/g
  const gateText = "GATE: PASS tests=1"
  const buffer = "xx" + gateText
  assert.deepEqual(findTruncatedMarkerSpans(buffer, buffer.slice(5), "", custom), [gateText])
  // A match starting exactly at the cut point is fully inside the window.
  assert.deepEqual(findTruncatedMarkerSpans(buffer, buffer.slice(2), "", custom), [])
})

/** A match already fully inside the previous window was credited in an
 *  earlier fold, so tail-slicing it out now is not a truncation; a span
 *  straddling the previous-window boundary was never seen complete and is
 *  still reported. */
test("findTruncatedMarkerSpans skips a span complete in the previous window", () => {
  const custom = /GATE: (PASS|FAIL) tests=\d+/g
  const gateText = "GATE: PASS tests=1"
  const buffer = gateText + "yy"
  const previousWindow = gateText
  // The span sits fully inside the previous window: not a truncation.
  assert.deepEqual(findTruncatedMarkerSpans(buffer, "yy", previousWindow, custom), [])
  // The same span straddles the previous-window boundary: never seen
  // complete, so it is reported.
  assert.deepEqual(findTruncatedMarkerSpans(buffer, "s=1yy", gateText.slice(0, 10), custom), [
    gateText,
  ])
})

/** A regex without the `g` flag is defensively cloned inside the helper, so
 *  a non-global input cannot make `matchAll` throw. */
test("findTruncatedMarkerSpans tolerates a non-global regex", () => {
  const nonGlobal = /GATE: (PASS|FAIL) tests=\d+/
  const gateText = "GATE: PASS tests=1"
  const buffer = "xx" + gateText
  assert.deepEqual(findTruncatedMarkerSpans(buffer, buffer.slice(5), "", nonGlobal), [gateText])
})

/** Two regexes matching the same span (or a repeated match) dedupe to one
 *  entry, in first-seen order. */
test("findTruncatedMarkerSpans dedupes a span matched by both regexes", () => {
  const buffer = "GATE: PASS tests=1 passed=1 failed=1"
  const window = buffer.slice(3)
  assert.deepEqual(findTruncatedMarkerSpans(buffer, window, "", GATE_RE, GATE_RE), [
    "GATE: PASS tests=1 passed=1 failed=1",
  ])
})

/**
 * A streamed marker longer than the default 512 window is tail-sliced by the
 * fold; the loss journals one `delta-truncated` marker entry carrying the
 * de-tokenized span, and no gate flip is parsed from streaming (the
 * task-result delivery re-parse owns that credit). The marker is split inside
 * its head, so streaming never sees it complete before the slicing fold.
 */
test("a marker longer than the window journals a delta-truncated entry", async () => {
  const { ctx, metricsDir } = coreWith({})
  const handlers = createEventHandlers(ctx)
  const long = `GATE: PASS tests=1 passed=1 failed=1 ${"z".repeat(600)}`
  handlers["session.created"]!({ sessionID: "c1", parentID: "p1", agent: "test-runner" })
  handlers["session.text.delta"]!({ sessionID: "c1", delta: long.slice(0, 20) })
  handlers["session.text.delta"]!({ sessionID: "c1", delta: long.slice(20) })
  const truncated = journalEntries(metricsDir).filter(
    (l) => l.type === "marker" && l.event === "delta-truncated",
  )
  assert.equal(truncated.length, 1)
  assert.equal(truncated[0]?.sessionID, "c1")
  assert.equal(truncated[0]?.marker, "gate: PASS tests=1 passed=1 failed=1")
  assert.equal(
    journalEntries(metricsDir).some((l) => l.type === "gate" && l.result === "PASS"),
    false,
    "streaming never credits a truncated marker",
  )
})

/**
 * A marker emitted mid-stream and credited by streaming first-sight is not a
 * truncation when a later fold tail-slices it out: more than a full window of
 * trailing output must journal no `delta-truncated` entry.
 */
test("a marker credited in streaming is not journaled as delta-truncated later", async () => {
  const { ctx, metricsDir } = coreWith({ gateEvidence: "flag" })
  const handlers = createEventHandlers(ctx)
  handlers["session.created"]!({ sessionID: "c1", parentID: "p1", agent: "test-runner" })
  handlers["session.text.delta"]!({
    sessionID: "c1",
    delta: "GATE: PASS tests=1 passed=1 failed=1",
  })
  await waitUntil(() =>
    journalEntries(metricsDir).some((l) => l.type === "gate" && l.result === "PASS"),
  )
  handlers["session.text.delta"]!({ sessionID: "c1", delta: "x".repeat(600) })
  assert.equal(
    journalEntries(metricsDir).some((l) => l.type === "marker" && l.event === "delta-truncated"),
    false,
    "a span complete in the previous window is not a truncation",
  )
})

/**
 * A journaler that throws on the diagnostic entry fails open: the delta
 * handler completes, and the internal failure lands as an `error` entry.
 * The marker is split inside its head, so the completing fold is the one
 * that probes.
 */
test("a throwing journaler fails open on the delta-truncated probe", async () => {
  const { ctx, metricsDir } = coreWith({})
  const inner = ctx.journaler.journal.bind(ctx.journaler)
  ctx.journaler.journal = (entry: Record<string, unknown>): void => {
    if (entry.event === "delta-truncated") throw new Error("sink down")
    inner(entry)
  }
  const handlers = createEventHandlers(ctx)
  const long = `GATE: PASS tests=1 passed=1 failed=1 ${"z".repeat(600)}`
  handlers["session.created"]!({ sessionID: "c1", parentID: "p1", agent: "test-runner" })
  handlers["session.text.delta"]!({ sessionID: "c1", delta: long.slice(0, 20) })
  await handlers["session.text.delta"]!({ sessionID: "c1", delta: long.slice(20) })
  const errors = journalEntries(metricsDir).filter(
    (l) => l.type === "error" && String(l.error).startsWith("delta-window truncation probe"),
  )
  assert.equal(errors.length, 1)
  assert.equal(errors[0]?.sessionID, "c1")
})
