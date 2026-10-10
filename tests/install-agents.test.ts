/**
 * @fileoverview Tests for the exported helpers in scripts/install-agents.mjs.
 * `removeBlock` deletes the sentinel-delimited managed block while preserving
 * surrounding content and refuses an unbalanced start sentinel. The chunk-5
 * adoption helpers — `analyze` (classify), `applyPlan` (write action),
 * `checkReport` (check-mode line), `findLegacySection` (locator),
 * `sectionsEquivalent` (comparison), `installBlock` (splice) — are exercised
 * directly. Pure: no CLI spawn, no filesystem writes, never touches a real
 * home.
 */

import { test } from "node:test"
import assert from "node:assert/strict"

import {
  removeBlock,
  installBlock,
  findLegacySection,
  sectionsEquivalent,
  analyze,
  applyPlan,
  checkReport,
  // @ts-expect-error TS7016 — scripts/install-agents.mjs is untyped JS; tests
  // import the pure helpers directly rather than spawning the CLI.
} from "../scripts/install-agents.mjs"
import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const START = "<!-- turnstile:start"
const END = "<!-- turnstile:end -->"

// Read the real template block and inner so the adoption tests key off the
// shipped contract rather than a hand-copied copy.
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..")
const template = readFileSync(join(repoRoot, "templates", "global-AGENTS.md"), "utf8")
const block = template.slice(template.indexOf(START), template.indexOf(END) + END.length) + "\n"
const startCommentEnd = template.indexOf("-->", template.indexOf(START)) + "-->".length
const endCommentStart = template.lastIndexOf(END)
const templateInner = template.slice(startCommentEnd, endCommentStart)

/** Wraps body content between the two turnstile sentinels (block-only file). */
function blockOnly(body: string): string {
  return `${START} -->\n${body}\n${END}\n`
}

/** Removes the sentinel-delimited block, preserving surrounding content. */
test("removeBlock deletes the block and preserves surrounding content byte-for-byte", () => {
  const current = `# Top\n\nbefore the block\n${START} -->\n## gates\norder planner, plan-reviewer, executor\n${END}\nafter the block\n`
  const { removed, next } = removeBlock(current, "AGENTS.md")
  assert.equal(removed, true)
  assert.ok(!next.includes(START), "start sentinel should be gone")
  assert.ok(!next.includes(END), "end sentinel should be gone")
  assert.equal(next, "# Top\n\nbefore the block\nafter the block\n")
})

/** On block-only content the result is empty (all-whitespace). */
test("removeBlock on block-only content yields an empty result", () => {
  const { removed, next } = removeBlock(blockOnly("## gates\norder planner ..."))
  assert.equal(removed, true)
  assert.equal(next.trim(), "")
})

/** When the block is absent this is a no-op: content unchanged, removed false. */
test("removeBlock is a no-op when the block is absent", () => {
  const current = "just instructions\nand more\n"
  const { removed, next } = removeBlock(current)
  assert.equal(removed, false)
  assert.equal(next, current)
})

/** A start sentinel without an end sentinel is refused (throws). */
test("removeBlock throws on a start sentinel without an end sentinel", () => {
  const current = "before\n<!-- turnstile:start -->\ncontent with no end\n"
  assert.throws(
    () => removeBlock(current, "AGENTS.md"),
    /found a start sentinel without an end sentinel/,
  )
})

/** Boundary newlines are trimmed and the two sides join with exactly one newline,
 * keeping any inner leading whitespace of the prefix. */
test("removeBlock trims boundary newlines and joins surrounding content with one newline", () => {
  const current = `  head\n${START} -->\nx\n${END}\ntail\n`
  // prefix "  head\n" → "  head"; suffix "tail\n" has no leading newline to trim.
  assert.equal(removeBlock(current).next, "  head\ntail\n")
})

// ---- chunk-5 adoption decision helpers ----

test("analyze: empty content decides 'append'", () => {
  assert.deepEqual(analyze("", block), { decision: "append" })
})

test("analyze: a managed block equal to the template decides 'ok'", () => {
  assert.deepEqual(analyze(block, block), { decision: "ok" })
})

test("analyze: a managed block that differs from the template decides 'drift'", () => {
  const stale = block.replace("plan-reviewer", "reviewer")
  assert.equal(analyze(stale, block).decision, "drift")
})

test("analyze: a legacy section equal to the real template inner decides 'adopt'", () => {
  const legacy = templateInner.trim()
  const analysis = analyze(legacy, block)
  assert.equal(analysis.decision, "adopt")
  // Wrapping the equivalent section with the sentinels reproduces the block
  // byte-for-byte (the only difference from the unmanaged form is the sentinels).
  assert.equal(installBlock(legacy, analysis.span, block), block)
})

test("analyze + installBlock: an equivalent legacy section adopts, preserving surroundings", () => {
  const S = "<!-- turnstile:start"
  const E = "<!-- turnstile:end -->"
  const synthetic = `${S} -->\n## Turnstile gates\n\norder: planner → plan-reviewer → executor → test-runner → reviewer\n\nmore note here\n${E}\n`
  const inner =
    "## Turnstile gates\n\norder: planner → plan-reviewer → executor → test-runner → reviewer\n\nmore note here\n"
  const before = "# Notes\n\npersonal\n"
  const after = "## Footer\n\nx\n"
  const unmanaged = before + inner + after
  const analysis = analyze(unmanaged, synthetic)
  assert.equal(analysis.decision, "adopt")
  assert.equal(analysis.span.start, unmanaged.indexOf("## Turnstile gates"))
  assert.equal(analysis.span.end, unmanaged.indexOf("## Footer"))
  // Adopt splices the block in place: surroundings preserved byte-for-byte.
  assert.equal(installBlock(unmanaged, analysis.span, synthetic), before + synthetic + after)
})

test("analyze: a differing legacy section decides 'replace'", () => {
  const differ =
    "## Turnstile gates\n\norder: planner → executor → test-runner → reviewer\n\nmore note here\n"
  const unmanaged = "# Notes\n\n" + differ + "## Footer\n\nx\n"
  const analysis = analyze(unmanaged, block)
  assert.equal(analysis.decision, "replace")
  const span = analysis.span
  assert.equal(span.start, unmanaged.indexOf("## Turnstile gates"))
  assert.equal(span.end, unmanaged.indexOf("## Footer"))
})

test("applyPlan: --no-adopt refuses every write outcome (adopt/append/drift/replace)", () => {
  const span = { start: 0, end: 3 }
  for (const decision of ["append", "adopt", "replace", "drift"]) {
    assert.equal(applyPlan({ decision, span }, { noAdopt: true }).action, "refuse")
  }
})

test("applyPlan: ok/append/adopt/drift map to up-to-date/append/adopt/resync", () => {
  assert.equal(applyPlan({ decision: "ok" }, {}).action, "up-to-date")
  assert.equal(applyPlan({ decision: "append" }, {}).action, "append")
  assert.equal(applyPlan({ decision: "adopt", span: { start: 0, end: 3 } }, {}).action, "adopt")
  assert.equal(applyPlan({ decision: "drift" }, {}).action, "resync")
})

test("applyPlan: an unknown decision throws instead of masking as success", () => {
  assert.throws(() => applyPlan({ decision: "bogus" }, {}), /unknown adoption decision/)
})

test("findLegacySection: returns null when no turnstile content is present", () => {
  assert.equal(findLegacySection("# Notes\n\njust instructions\nand more\n"), null)
})

test("findLegacySection: spans a turnstile-named heading to the next heading of <= level", () => {
  const content =
    "# Top\n\n## Turnstile gates\n\norder: planner → executor → test-runner\n\nbody\n\n## Other\n\nx\n"
  const span = findLegacySection(content)
  assert.equal(span.level, 2)
  assert.equal(span.start, content.indexOf("## Turnstile gates"))
  assert.equal(span.end, content.indexOf("## Other"))
})

test("findLegacySection: matches a section identified by the pipeline-chain signature", () => {
  const content =
    "## Pipeline gates\n\nOrder: planner → plan-reviewer → executor → test-runner → reviewer.\n\n## Other\n\nx\n"
  const span = findLegacySection(content)
  assert.equal(span.start, content.indexOf("## Pipeline gates"))
  assert.equal(span.end, content.indexOf("## Other"))
})

test("findLegacySection: returns null when a managed block is present", () => {
  assert.equal(findLegacySection(block), null)
})

test("findLegacySection: throws when more than one section matches (ambiguous)", () => {
  const content =
    "## Turnstile A\n\nplanner → executor → test-runner → reviewer\n\n## Turnstile B\n\nmore\n"
  assert.throws(() => findLegacySection(content), /ambiguous/)
})

test("analyze: ambiguous (two sections) throws, distinct from corrupted", () => {
  const two = "## Turnstile A\n\nplanner → executor\n\n## Turnstile B\n\nmore\n"
  assert.throws(() => analyze(two, block), /ambiguous/)
})

test("analyze: a start sentinel without an end sentinel is corrupted (throws)", () => {
  const corrupt = "# Notes\n\n<!-- turnstile:start -->\nno end sentinel here\n"
  assert.throws(() => analyze(corrupt, block), /found a start sentinel without an end sentinel/)
})

test("sectionsEquivalent: ignores sentinel comments and collapses whitespace", () => {
  const a =
    "<!-- turnstile:start -->\n## Turnstile gates\n\norder: planner → plan-reviewer → executor → test-runner → reviewer\n\nmore\n"
  const b =
    "## Turnstile gates\n order: planner → plan-reviewer → executor → test-runner → reviewer more\n"
  assert.equal(sectionsEquivalent(a, b), true)
})

test("sectionsEquivalent: distinguishes differing content", () => {
  assert.equal(sectionsEquivalent("## a\n\nx", "## a\n\ny"), false)
})

test("checkReport: each decision maps to its report line and exit code", () => {
  const ok = checkReport({ decision: "ok" }, "AGENTS.md")
  assert.deepEqual(ok, { message: "check-agents: OK (AGENTS.md)", code: 0 })

  const append = checkReport({ decision: "append" }, "AGENTS.md")
  assert.equal(append.code, 1)
  assert.ok(append.message.includes("drift: no managed contract block"), append.message)

  const adopt = checkReport({ decision: "adopt", span: { start: 0, end: 3 } }, "AGENTS.md")
  assert.equal(adopt.code, 1)
  assert.ok(adopt.message.includes("would-adopt-equivalent"), adopt.message)

  const replace = checkReport({ decision: "replace", span: { start: 0, end: 3 } }, "AGENTS.md")
  assert.equal(replace.code, 1)
  assert.ok(replace.message.includes("would-replace"), replace.message)

  const drift = checkReport({ decision: "drift" }, "AGENTS.md")
  assert.equal(drift.code, 1)
  assert.ok(drift.message.includes("drift: the managed block in AGENTS.md differs"), drift.message)
})
