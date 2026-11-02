/**
 * @fileoverview Export-shape tests: the module shape the OpenCode host
 * loads, the factory alias, and journal rotation mechanics.
 */

import { test } from "node:test"
import assert from "node:assert/strict"
import * as fs from "node:fs"
import * as path from "node:path"

import { rotateIfLarge } from "../src/journal.ts"
import turnstileModule, { turnstile } from "../turnstile.ts"
import { tmpDir } from "./helpers.ts"

/** The default export must have exactly the keys id, server, setup, with id "turnstile". */
test("default export has the frozen plugin shape", () => {
  assert.deepEqual(Object.keys(turnstileModule).sort(), ["id", "server", "setup"])
  assert.equal(turnstileModule.id, "turnstile")
  assert.equal(typeof turnstileModule.setup, "function")
})

/** The legacy v1 server shim must resolve to an empty object. */
test("server is a legacy shim returning an empty object", async () => {
  assert.deepEqual(await turnstileModule.server(), {})
})

/** The named factory export `turnstile` must remain a function. */
test("the named factory export is a function", () => {
  assert.equal(typeof turnstile, "function")
})

/** The gates composition module must expose exactly BlockError and createGates at runtime. */
test("gates.ts exposes only BlockError and createGates at runtime", async () => {
  const mod = await import("../src/gates.ts")
  assert.deepEqual(Object.keys(mod).sort(), ["BlockError", "createGates"])
})

/**
 * The shared gates leaf must expose the block error, the two waiver-semantics
 * helpers both gate families import, and the pure journal-entry composers
 * (the gate composers plus the observe-mode admission-stamp, suppressed-block
 * audit, and summary marker builders).
 */
test("gates-common.ts exposes the block error, waiver helpers, and composers", async () => {
  const mod = await import("../src/gates-common.ts")
  assert.deepEqual(Object.keys(mod).sort(), [
    "BlockError",
    "decisionEntry",
    "observeEntry",
    "observeSummaryEntry",
    "reviewerEnsembleEntry",
    "waiverCovers",
    "waiverStateNote",
    "wouldBlockEntry",
  ])
})

/** The dispatch gates module must expose exactly createDispatchGates at runtime. */
test("gates-dispatch.ts exposes only createDispatchGates at runtime", async () => {
  const mod = await import("../src/gates-dispatch.ts")
  assert.deepEqual(Object.keys(mod).sort(), ["createDispatchGates"])
})

/** The plan gates module must expose exactly createPlanGates at runtime. */
test("gates-plan.ts exposes only createPlanGates at runtime", async () => {
  const mod = await import("../src/gates-plan.ts")
  assert.deepEqual(Object.keys(mod).sort(), ["createPlanGates"])
})

/**
 * The host-payload delivery module must expose exactly the coercion and
 * classification helpers, the candidate-key tables, and the two ask-message
 * prefixes at runtime.
 */
test("delivery.ts exposes only the delivery helpers and key tables at runtime", async () => {
  const mod = await import("../src/delivery.ts")
  assert.deepEqual(Object.keys(mod).sort(), [
    "AGENT_KEYS",
    "DIRECTORY_KEYS",
    "HANDSON_ASK_MESSAGE_PREFIX",
    "LANDING_ASK_MESSAGE_PREFIX",
    "PARENT_KEYS",
    "PLAN_ASK_MESSAGE_PREFIX",
    "asSessionID",
    "classifyDelivery",
    "describeResultShape",
    "isPlainRecord",
    "metadataChildOf",
    "mutateDeliveryText",
    "prependDeliveryText",
    "promptTextOf",
    "readRecordString",
    "shapeOf",
    "structuredPartsOf",
  ])
})

/**
 * The shared hook-state module must expose exactly createHooksCore at
 * runtime (the TurnstileContext interface is type-only and erased).
 */
test("hooks-core.ts exposes only createHooksCore at runtime", async () => {
  const mod = await import("../src/hooks-core.ts")
  assert.deepEqual(Object.keys(mod).sort(), ["createHooksCore"])
})

/** The session-surface module must expose exactly its hook factory at runtime. */
test("hooks-session.ts exposes only createSessionHooks at runtime", async () => {
  const mod = await import("../src/hooks-session.ts")
  assert.deepEqual(Object.keys(mod).sort(), ["createSessionHooks"])
})

/** The permission-surface module must expose exactly its hook factory at runtime. */
test("hooks-permission.ts exposes only createPermissionHooks at runtime", async () => {
  const mod = await import("../src/hooks-permission.ts")
  assert.deepEqual(Object.keys(mod).sort(), ["createPermissionHooks"])
})

/** The tool-surface module must expose exactly its hook factory at runtime. */
test("hooks-tool.ts exposes only createToolHooks at runtime", async () => {
  const mod = await import("../src/hooks-tool.ts")
  assert.deepEqual(Object.keys(mod).sort(), ["createToolHooks"])
})

/** The event-surface module must expose exactly its stream starter at runtime. */
test("hooks-events.ts exposes only startEventStream at runtime", async () => {
  const mod = await import("../src/hooks-events.ts")
  assert.deepEqual(Object.keys(mod).sort(), ["startEventStream"])
})

/** The config-merge module must expose exactly the default sub-object builders and the merge dispatcher. */
test("config-merge.ts exposes the default sub-object builders and merge dispatcher", async () => {
  const mod = await import("../src/config-merge.ts")
  assert.deepEqual(Object.keys(mod).sort(), [
    "CANONICAL_REVIEWER_AGENT",
    "DEFAULT_COMMIT_FORMAT",
    "defaultAgents",
    "defaultGitGates",
    "defaultToolPolicy",
    "mergeAgentsPatch",
    "mergeConfigKey",
    "mergeGitGatesPatch",
    "mergeScalarKey",
    "mergeToolPolicyPatch",
  ])
})

/** The config-validate module must expose exactly the scalar validator and the resolved-config invariants. */
test("config-validate.ts exposes the scalar validator and validateResolved", async () => {
  const mod = await import("../src/config-validate.ts")
  assert.deepEqual(Object.keys(mod).sort(), [
    "BARE_OUTPUT_UNSET",
    "isValidScalar",
    "validateResolved",
  ])
})

/** The gate-marker parsing module must expose exactly the marker parser. */
test("gate-markers-parse.ts exposes only parseGateMarkers at runtime", async () => {
  const mod = await import("../src/gate-markers-parse.ts")
  assert.deepEqual(Object.keys(mod).sort(), ["parseGateMarkers"])
})

/** The state-carry module must expose exactly the fresh-bucket factory and the replay carry merge. */
test("state-carry.ts exposes only newState and mergeAfterReplay at runtime", async () => {
  const mod = await import("../src/state-carry.ts")
  assert.deepEqual(Object.keys(mod).sort(), ["mergeAfterReplay", "newState"])
})

/** Under the size limit rotation must not fire and no generation file appears. */
test("rotateIfLarge no-ops when the file is within the size limit", () => {
  const dir = tmpDir()
  const file = path.join(dir, "j.jsonl")
  fs.writeFileSync(file, "line\n")
  rotateIfLarge(file, 1024, 5)
  assert.equal(fs.readFileSync(file, "utf8"), "line\n")
  assert.equal(fs.existsSync(`${file}.1`), false)
})

/** Oversize: the current file moves to .1 and the current path disappears. */
test("rotateIfLarge shifts the current file into generation .1", () => {
  const dir = tmpDir()
  const file = path.join(dir, "j.jsonl")
  fs.writeFileSync(file, "x".repeat(10))
  rotateIfLarge(file, 5, 5)
  assert.equal(fs.existsSync(file), false)
  assert.equal(fs.readFileSync(`${file}.1`, "utf8"), "x".repeat(10))
})

/** Generations beyond the cap shift down and the oldest is deleted. */
test("rotateIfLarge prunes the oldest generation beyond the cap", () => {
  const dir = tmpDir()
  const file = path.join(dir, "j.jsonl")
  fs.writeFileSync(file, "current")
  fs.writeFileSync(`${file}.1`, "gen1")
  fs.writeFileSync(`${file}.2`, "gen2")
  rotateIfLarge(file, 1, 2)
  assert.equal(fs.readFileSync(`${file}.1`, "utf8"), "current")
  assert.equal(fs.readFileSync(`${file}.2`, "utf8"), "gen1")
})

/**
 * A missing journal file trips the outer catch: `statSync` throws and the
 * rename sequence never runs, so rotateIfLarge is a no-op on any failure.
 */
test("rotateIfLarge no-ops when the file is missing", () => {
  const dir = tmpDir()
  const file = path.join(dir, "missing.jsonl")
  rotateIfLarge(file, 1024, 5)
  assert.equal(fs.existsSync(file), false)
  assert.equal(fs.existsSync(`${file}.1`), false)
})

/**
 * The journal-sinks module must expose exactly the sink factory and the
 * trace-line formatter at runtime.
 */
test("journal-sinks.ts exposes the persistence primitives and sink factory", async () => {
  const mod = await import("../src/journal-sinks.ts")
  assert.deepEqual(Object.keys(mod).sort(), [
    "REPLAY_SESSION_RE",
    "appendLine",
    "createJournalSinks",
    "formatTraceLine",
    "now",
    "rotateIfLarge",
    "sessionJournalPath",
  ])
})

/**
 * The evidence-hits module must expose exactly the hits-operations factory
 * and the per-session ring cap at runtime.
 */
test("evidence-hits.ts exposes the hits factory and the ring cap", async () => {
  const mod = await import("../src/evidence-hits.ts")
  assert.deepEqual(Object.keys(mod).sort(), ["MAX_HITS_PER_SESSION", "createEvidenceHits"])
})

/**
 * The tool-hooks-before module must expose exactly the extracted
 * execute.before body at runtime.
 */
test("tool-hooks-before.ts exposes the before hook body", async () => {
  const mod = await import("../src/tool-hooks-before.ts")
  assert.deepEqual(Object.keys(mod).sort(), ["toolHooksBefore"])
})

/**
 * The tool-hooks-after module must expose exactly the extracted
 * execute.after body at runtime.
 */
test("tool-hooks-after.ts exposes the after hook body", async () => {
  const mod = await import("../src/tool-hooks-after.ts")
  assert.deepEqual(Object.keys(mod).sort(), ["toolHooksAfter"])
})

/**
 * The permission-evaluate module must expose exactly the extracted evaluate
 * body at runtime.
 */
test("permission-evaluate.ts exposes the permission evaluate body", async () => {
  const mod = await import("../src/permission-evaluate.ts")
  assert.deepEqual(Object.keys(mod).sort(), ["permissionEvaluate"])
})

/**
 * The event-stream-handlers module must expose exactly the handler-table
 * factory at runtime (the EventHandler type is erased).
 */
test("event-stream-handlers.ts exposes the handler-table factory", async () => {
  const mod = await import("../src/event-stream-handlers.ts")
  assert.deepEqual(Object.keys(mod).sort(), ["createEventHandlers"])
})

/**
 * The session-hook-bodies module must expose exactly the four extracted hook
 * bodies at runtime.
 */
test("hooks-session-bodies.ts exposes the four session hook bodies", async () => {
  const mod = await import("../src/hooks-session-bodies.ts")
  assert.deepEqual(Object.keys(mod).sort(), [
    "sessionCompactionBody",
    "sessionContextBody",
    "sessionGenerateBody",
    "sessionPromptBody",
  ])
})

/**
 * The commit-args module must expose exactly the commit argument scanner at
 * runtime (the cluster reader is module-private).
 */
test("commit-args.ts exposes only parseCommitArgs at runtime", async () => {
  const mod = await import("../src/commit-args.ts")
  assert.deepEqual(Object.keys(mod).sort(), ["parseCommitArgs"])
})

/**
 * The shell-parse module must expose exactly the shared tokenizer pair, the
 * redirect scanner, and the device/fd-target predicate at runtime.
 */
test("shell-parse.ts exposes the tokenizer pair, redirect scanner, and target predicate", async () => {
  const mod = await import("../src/shell-parse.ts")
  assert.deepEqual(Object.keys(mod).sort(), [
    "isDevOrFdTarget",
    "scanRedirects",
    "splitCommands",
    "tokenizeWords",
  ])
})
