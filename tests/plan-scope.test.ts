/**
 * @fileoverview Plan-scope boundary tests: path-token extraction from a
 * plan's spec region (advisory vs structural sets), impact classification in
 * both match modes (equality for write/edit targets, containment for bash
 * command text), the plan-file-self rule, and the never-throw contract.
 */

import { test } from "node:test"
import assert from "node:assert/strict"

const { planScopeFiles, classifyPlanImpact } = await import("../src/plan-scope.ts")

/** A spec region with paths in both halves plus prose that must not match. */
const SPEC = [
  "# Objective",
  "Update `README.md` and src/gates.ts to add the advisory.",
  "See chunk-1 and the docs for context.",
  "## Decomposition",
  "- chunk-1: rewrite `./src/ledger.ts` and tests/plan-scope.test.ts",
  "- chunk-2: touch src/policy.ts",
].join("\n")

/** Extraction: Decomposition-section paths are structural, steps paths advisory. */
test("planScopeFiles: Decomposition-section paths are structural, steps paths advisory", () => {
  const scope = planScopeFiles(SPEC)
  assert.deepEqual([...scope.structuralFiles].sort(), [
    "src/ledger.ts",
    "src/policy.ts",
    "tests/plan-scope.test.ts",
  ])
  assert.deepEqual([...scope.advisoryFiles].sort(), ["README.md", "src/gates.ts"])
})

/** Prose without a `/`+extension shape (chunk-1, docs) never extracts. */
test("planScopeFiles: prose words and chunk citations never match", () => {
  const scope = planScopeFiles("Rewrite chunk-1 and the docs, see #247.")
  assert.equal(scope.advisoryFiles.size, 0)
  assert.equal(scope.structuralFiles.size, 0)
})

/** A spec region without a Decomposition heading puts every path in advisory. */
test("planScopeFiles: a plan without ## Decomposition is all advisory", () => {
  const scope = planScopeFiles("# Objective\nEdit src/gates.ts only.")
  assert.ok(scope.advisoryFiles.has("src/gates.ts"))
  assert.equal(scope.structuralFiles.size, 0)
})

/** Accepts a Buffer (the planSpecRegion output shape) as well as a string. */
test("planScopeFiles: accepts a Buffer spec region", () => {
  const fromString = planScopeFiles(SPEC)
  const fromBuffer = planScopeFiles(Buffer.from(SPEC, "utf8"))
  assert.deepEqual([...fromString.advisoryFiles], [...fromBuffer.advisoryFiles])
  assert.deepEqual([...fromString.structuralFiles], [...fromBuffer.structuralFiles])
})

/** Equality mode (write/edit): exact scope member classifies advisory. */
test("classifyPlanImpact: equality match on an advisory path classifies advisory", () => {
  const scope = planScopeFiles(SPEC)
  assert.equal(classifyPlanImpact("src/gates.ts", scope, "", false), "advisory")
  assert.equal(classifyPlanImpact("./src/gates.ts", scope, "", false), "advisory")
})

/** Equality mode: a structural-set member classifies structural. */
test("classifyPlanImpact: equality match on a Decomposition path classifies structural", () => {
  const scope = planScopeFiles(SPEC)
  assert.equal(classifyPlanImpact("src/ledger.ts", scope, "", false), "structural")
})

/** Equality mode: an unknown path classifies none. */
test("classifyPlanImpact: unknown path classifies none", () => {
  const scope = planScopeFiles(SPEC)
  assert.equal(classifyPlanImpact("nope/other.ts", scope, "", false), "none")
})

/** Containment mode (bash): a command naming a scope path classifies. */
test("classifyPlanImpact: containment match finds a scope path in command text", () => {
  const scope = planScopeFiles(SPEC)
  assert.equal(classifyPlanImpact("cp src/ledger.ts /tmp/backup.ts", scope, "", true), "structural")
  assert.equal(classifyPlanImpact("cat README.md | head", scope, "", true), "advisory")
})

/** Containment mode: a command naming no scope path classifies none. */
test("classifyPlanImpact: command text without a scope path classifies none", () => {
  const scope = planScopeFiles(SPEC)
  assert.equal(classifyPlanImpact("npm test", scope, "", true), "none")
})

/** Plan-file-self rule: editing the active plan file itself is structural. */
test("classifyPlanImpact: the plan file's own path classifies structural", () => {
  const scope = planScopeFiles(SPEC)
  assert.equal(
    classifyPlanImpact(".opencode/plans/plan-x.md", scope, "plan-x.md", false),
    "structural",
  )
  assert.equal(classifyPlanImpact("plan-x.md", scope, "", false), "none")
})

/** The self rule is disabled by an empty plan path (the caller's fail-open). */
test("classifyPlanImpact: an empty plan path disables the self rule", () => {
  const scope = planScopeFiles(SPEC)
  assert.equal(classifyPlanImpact("plan-x.md", scope, "", false), "none")
})
