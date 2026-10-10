/**
 * @fileoverview Contract-block unmerge tests for the exported `removeBlock`
 * helper from scripts/install-agents.mjs. It deletes the sentinel-delimited
 * managed block while preserving the surrounding content, refuses an
 * unbalanced start sentinel, and is a no-op when the block is absent. Pure: no
 * filesystem access, so nothing is written.
 */

import { test } from "node:test"
import assert from "node:assert/strict"

// @ts-expect-error TS7016 — scripts/install-agents.mjs is untyped JS; tests
// import removeBlock directly rather than spawning the CLI.
import { removeBlock } from "../scripts/install-agents.mjs"

const START = "<!-- turnstile:start"
const END = "<!-- turnstile:end -->"

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
