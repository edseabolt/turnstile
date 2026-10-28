/**
 * @fileoverview Tests for the host-compatibility boundary (`src/host-compat.ts`)
 * and its setup wiring: semver parse/compare units, the verdict evaluator,
 * and the setup-level kill switch (incompatible → no hooks + toast; unknown
 * → enforce with a one-time journal warning).
 */

import assert from "node:assert/strict"
import { test } from "node:test"

import { compareSemver, evaluateHostCompat, HOST_COMPAT, parseSemver } from "../src/host-compat.ts"
import { createTurnstile } from "../src/setup.ts"
import { journalEntries, makeFakeHost, tmpDir, waitUntil, isolatedEnv } from "./helpers.ts"

/**
 * Builds a fully isolated env whose journal lands in `dir` (isolatedEnv only
 * pins the config file; the metrics dir must be pinned separately so the
 * compat tests read their own journal).
 * @param dir Temp directory for both the config file and the metrics dir.
 * @returns The isolated env map.
 */
function envFor(dir: string): Record<string, string> {
  return { ...isolatedEnv(dir), TURNSTILE_METRICS_DIR: dir }
}

// ── parseSemver ──────────────────────────────────────────────────────────────

test("parseSemver accepts strict, v-prefixed, and pre-release versions", () => {
  assert.deepEqual(parseSemver("2.0.22"), { major: 2, minor: 0, patch: 22, pre: [] })
  assert.deepEqual(parseSemver("v3.1.0"), { major: 3, minor: 1, patch: 0, pre: [] })
  assert.deepEqual(parseSemver("2.0.0-rc.1"), { major: 2, minor: 0, patch: 0, pre: ["rc", "1"] })
})

test("parseSemver rejects junk, partial, empty, and non-string input", () => {
  assert.equal(parseSemver("abc"), null)
  assert.equal(parseSemver("2.0"), null)
  assert.equal(parseSemver(""), null)
  assert.equal(parseSemver("2.x.1"), null)
})

// ── compareSemver ────────────────────────────────────────────────────────────

test("compareSemver orders versions numerically and pre before release", () => {
  assert.ok(compareSemver("2.0.21", "2.0.22") < 0)
  assert.ok(compareSemver("2.0.22", "2.0.22") === 0)
  assert.ok(compareSemver("2.1.0", "2.0.22") > 0)
  assert.ok(compareSemver("2.0.22-rc.1", "2.0.22") < 0)
  assert.ok(compareSemver("2.0.22", "2.0.22-rc.1") > 0)
})

test("compareSemver with unparseable input sorts the junk side lower", () => {
  assert.ok(compareSemver("junk", "2.0.0") < 0)
  assert.ok(compareSemver("2.0.0", "junk") > 0)
  assert.ok(compareSemver("junk", "also-junk") === 0)
})

// ── evaluateHostCompat ───────────────────────────────────────────────────────

test("evaluateHostCompat flags below-min and at-or-above-max as incompatible", () => {
  const below = evaluateHostCompat("2.0.21", "0.7.0", HOST_COMPAT)
  assert.equal(below.verdict, "incompatible")
  assert.match(
    below.message,
    /turnstile 0\.7\.0 expects opencode >=2\.0\.22,<3\.0\.0; you're on 2\.0\.21 — upgrade turnstile/,
  )
  const atMax = evaluateHostCompat("3.0.0", "0.7.0", HOST_COMPAT)
  const above = evaluateHostCompat("3.1.0", null, HOST_COMPAT)
  for (const r of [atMax, above]) {
    assert.equal(r.verdict, "incompatible")
    assert.match(r.message, /upgrade turnstile \(npm i opencode-turnstile@latest\) or pin opencode/)
  }
  assert.match(above.message, /turnstile \(unknown\) expects/)
})

test("evaluateHostCompat treats a pre-release of the max version as compatible", () => {
  // Standard semver: 3.0.0-nightly < 3.0.0 (pre-release sorts before the
  // release), and it clears the 2.0.22 floor — so it stays inside the range.
  const r = evaluateHostCompat("3.0.0-nightly", "0.7.0", HOST_COMPAT)
  assert.equal(r.verdict, "compatible")
  assert.equal(r.message, "")
})

test("evaluateHostCompat accepts the floor, interior, and tested versions", () => {
  for (const v of ["2.0.22", "2.0.27", "2.0.29", "2.5.3"]) {
    const r = evaluateHostCompat(v, "0.7.0", HOST_COMPAT)
    assert.equal(r.verdict, "compatible")
    assert.equal(r.message, "")
    assert.equal(r.hostVersion, v)
  }
})

test("evaluateHostCompat yields unknown for unparseable and non-string versions", () => {
  for (const bad of ["abc", "2.0", "", undefined, 123, null]) {
    const r = evaluateHostCompat(bad, "0.7.0", HOST_COMPAT)
    assert.equal(r.verdict, "unknown")
    assert.match(r.message, /could not read the OpenCode version/)
  }
  assert.equal(evaluateHostCompat("junk", "0.7.0", HOST_COMPAT).hostVersion, "junk")
  assert.equal(evaluateHostCompat(undefined, "0.7.0", HOST_COMPAT).hostVersion, "")
})

// ── setup wiring ─────────────────────────────────────────────────────────────

test("incompatible host registers no hooks and toasts the upgrade text", async () => {
  const dir = tmpDir()
  const { host, toolHooks, toasts } = makeFakeHost({ tui: true, appVersion: "3.1.0" })
  const setup = createTurnstile(undefined, { env: envFor(dir) })
  const dispose = await setup(host)
  await waitUntil(() => toasts.length === 1)
  assert.match(toasts[0]!.message, /upgrade turnstile/)
  assert.equal(toasts[0]!.variant, "warning")
  assert.equal(toolHooks["execute.before"], undefined)
  const entries = journalEntries(dir)
  const compatEntry = entries.find((e) => e.type === "compat")
  assert.ok(compatEntry)
  assert.equal(compatEntry.event, "incompatible")
  assert.equal(compatEntry.host, "3.1.0")
  const heartbeat = entries.find((e) => e.type === "setup")
  assert.ok(heartbeat)
  assert.equal(heartbeat.compat, "incompatible")
  assert.equal(heartbeat.hooks, 0)
  dispose?.()
})

test("incompatible host with a rejecting toast journals the failure, no throw", async () => {
  const dir = tmpDir()
  const { host, toolHooks } = makeFakeHost({
    tui: true,
    toastReject: true,
    appVersion: "1.0.0",
  })
  const setup = createTurnstile(undefined, { env: envFor(dir) })
  const dispose = await setup(host)
  const errors = journalEntries(dir).filter((e) => e.type === "error")
  assert.ok(errors.some((e) => String(e.error).startsWith("compat toast:")))
  assert.equal(toolHooks["execute.before"], undefined)
  dispose?.()
})

test("incompatible host without a TUI surface degrades to journal-only", async () => {
  const dir = tmpDir()
  const { host, toolHooks } = makeFakeHost({ appVersion: "0.9.9" })
  const setup = createTurnstile(undefined, { env: envFor(dir), config: { trace: false } })
  const dispose = await setup(host)
  assert.equal(toolHooks["execute.before"], undefined)
  const entries = journalEntries(dir)
  assert.ok(entries.some((e) => e.type === "compat" && e.event === "incompatible"))
  assert.equal(
    entries.some((e) => e.type === "error"),
    false,
  )
  // trace:false exercises the no-trace heartbeat shape on the early-return path.
  const heartbeat = entries.find((e) => e.type === "setup")
  assert.ok(heartbeat)
  assert.equal(heartbeat.trace, undefined)
  assert.equal(heartbeat.compat, "incompatible")
  dispose?.()
})

test("unknown host enforces with a one-time warning journal entry", async () => {
  const dir = tmpDir()
  const { host, toolHooks, pushEvent } = makeFakeHost({})
  const setup = createTurnstile(undefined, { env: envFor(dir) })
  const dispose = await setup(host)
  assert.ok(toolHooks["execute.before"], "gates should register on an unknown host")
  const entries = journalEntries(dir)
  const unknowns = entries.filter((e) => e.type === "compat" && e.event === "unknown-host")
  assert.equal(unknowns.length, 1)
  const heartbeat = entries.find((e) => e.type === "setup")
  assert.ok(heartbeat)
  assert.equal(heartbeat.compat, "unknown")
  // Enforcement fires: a gate pass marker on a prompt admits and passes.
  await toolHooks["execute.before"]({
    tool: "bash",
    sessionID: "s1",
    callID: "c1",
    input: { command: "echo hi" },
  })
  void pushEvent
  dispose?.()
})

test("compatible host enforces with a compatible heartbeat field", async () => {
  const dir = tmpDir()
  const { host, toolHooks } = makeFakeHost({ appVersion: "2.0.29" })
  const setup = createTurnstile(undefined, { env: envFor(dir) })
  const dispose = await setup(host)
  assert.ok(toolHooks["execute.before"], "gates should register on a compatible host")
  const heartbeat = journalEntries(dir).find((e) => e.type === "setup")
  assert.ok(heartbeat)
  assert.equal(heartbeat.compat, "compatible")
  dispose?.()
})

// ── host-version source fallbacks (review finding #2) ────────────────────────

test("setup with a throwing app.version getter journals and enforces (fail-open)", async () => {
  const dir = tmpDir()
  const { host, toolHooks } = makeFakeHost({})
  Object.defineProperty(host, "app", {
    get(): { name: string; version: string } {
      throw new Error("boom")
    },
  })
  const setup = createTurnstile(undefined, { env: envFor(dir) })
  const dispose = await setup(host)
  assert.ok(toolHooks["execute.before"], "a guard crash must not disable enforcement")
  const entries = journalEntries(dir)
  assert.ok(
    entries.some((e) => e.type === "error" && String(e.error).startsWith("compat evaluation:")),
  )
  assert.equal(entries.find((e) => e.type === "setup")?.compat, "unknown")
  dispose?.()
})

test("setup falls back to the factory host's app.version when setup host lacks it", async () => {
  const dir = tmpDir()
  const factoryHost = makeFakeHost({ appVersion: "2.0.27" }).host
  const { host, toolHooks } = makeFakeHost({})
  const setup = createTurnstile(factoryHost, { env: envFor(dir) })
  const dispose = await setup(host)
  assert.ok(toolHooks["execute.before"])
  const heartbeat = journalEntries(dir).find((e) => e.type === "setup")
  assert.ok(heartbeat)
  assert.equal(heartbeat.compat, "compatible")
  dispose?.()
})

test("setup prefers the setup host's app.version over the factory host's", async () => {
  const dir = tmpDir()
  const factoryHost = makeFakeHost({ appVersion: "2.0.22" }).host
  const { host, toolHooks } = makeFakeHost({ appVersion: "2.0.29" })
  const setup = createTurnstile(factoryHost, { env: envFor(dir) })
  const dispose = await setup(host)
  assert.ok(toolHooks["execute.before"])
  const heartbeat = journalEntries(dir).find((e) => e.type === "setup")
  assert.ok(heartbeat)
  assert.equal(heartbeat.compat, "compatible")
  dispose?.()
})

test("setup with no version on either host falls back to unknown", async () => {
  const dir = tmpDir()
  const { host, toolHooks } = makeFakeHost({})
  const setup = createTurnstile(undefined, { env: envFor(dir) })
  const dispose = await setup(host)
  assert.ok(toolHooks["execute.before"])
  const entries = journalEntries(dir)
  assert.ok(entries.some((e) => e.type === "compat" && e.event === "unknown-host"))
  const heartbeatUnknown = entries.find((e) => e.type === "setup")
  assert.ok(heartbeatUnknown)
  assert.equal(heartbeatUnknown.compat, "unknown")
  dispose?.()
})
