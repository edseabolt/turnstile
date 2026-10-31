/**
 * @fileoverview Plan spec-region extraction tests: the `# Progress` exclusion
 * from the hashed spec region, its fail-closed fallbacks (missing, misspelled,
 * or misplaced header → whole file; progress-only file → whole file), and the
 * spec-vs-progress keying outcomes (progress-only edits keep the key, spec
 * edits and combined edits change it).
 */

import { test } from "node:test"
import assert from "node:assert/strict"
import { createHash } from "node:crypto"

import { planSpecRegion, PROGRESS_HEADER } from "../src/plan-region.ts"

const keyOf = (text: string): string => {
  const bytes = Buffer.from(text, "utf8")
  return createHash("sha256").update(planSpecRegion(bytes)).digest("hex")
}

const PLAN = [
  PROGRESS_HEADER,
  "",
  "- chunk-1 — DONE",
  "",
  "# Objective",
  "",
  "Close the gates.",
  "",
  "# Requirements",
  "",
  "Be strict.",
  "",
].join("\n")

test("plan-region: a plan without a Progress header keys on the whole file", () => {
  const body = "# Objective\n\nSpec only.\n"
  assert.equal(keyOf(body), createHash("sha256").update(body).digest("hex"))
  assert.equal(planSpecRegion(Buffer.from(body, "utf8")).toString("utf8"), body)
})

test("plan-region: a progress-only append keeps the spec key live", () => {
  const appended = PLAN.replace("- chunk-1 — DONE", "- chunk-1 — DONE\n- chunk-2 — DONE")
  assert.notEqual(appended, PLAN)
  assert.equal(keyOf(appended), keyOf(PLAN))
})

test("plan-region: a spec edit changes the key", () => {
  const edited = PLAN.replace("Close the gates.", "Close every gate.")
  assert.notEqual(keyOf(edited), keyOf(PLAN))
})

test("plan-region: a combined spec edit + progress append changes the key (spec wins)", () => {
  const combined = PLAN.replace("Close the gates.", "Close every gate.").replace(
    "- chunk-1 — DONE",
    "- chunk-1 — DONE\n- chunk-2 — DONE",
  )
  assert.notEqual(keyOf(combined), keyOf(PLAN))
})

test("plan-region: a misspelled Progress header falls back to whole-file keying", () => {
  const misspelled = PLAN.replace(PROGRESS_HEADER, "## Progress")
  assert.equal(keyOf(misspelled), createHash("sha256").update(misspelled).digest("hex"))
  const glued = PLAN.replace(PROGRESS_HEADER, "#Progress")
  assert.equal(keyOf(glued), createHash("sha256").update(glued).digest("hex"))
})

test("plan-region: a Progress header not at line 1 falls back to whole-file keying", () => {
  const misplaced = "# Title\n\n" + PLAN
  assert.equal(keyOf(misplaced), createHash("sha256").update(misplaced).digest("hex"))
})

test("plan-region: a progress-only file (no following heading) falls back to whole-file keying", () => {
  const body = PROGRESS_HEADER + "\n\n- chunk-1 — DONE\n"
  assert.equal(keyOf(body), createHash("sha256").update(body).digest("hex"))
})

test("plan-region: the spec region starts at the first top-level heading after Progress", () => {
  const region = planSpecRegion(Buffer.from(PLAN, "utf8")).toString("utf8")
  assert.equal(region, PLAN.slice(PLAN.indexOf("# Objective")))
})

test("plan-region: trailing whitespace on the Progress header line is tolerated", () => {
  const spaced = PLAN.replace(PROGRESS_HEADER, PROGRESS_HEADER + "   ")
  assert.equal(keyOf(spaced), keyOf(PLAN))
})

test("plan-region: leading whitespace on the Progress header fails closed to whole-file keying", () => {
  const indented = PLAN.replace(PROGRESS_HEADER, " " + PROGRESS_HEADER)
  assert.equal(keyOf(indented), createHash("sha256").update(indented).digest("hex"))
})

test("plan-region: the exported header is the canonical literal", () => {
  assert.equal(PROGRESS_HEADER, "# Progress")
})
