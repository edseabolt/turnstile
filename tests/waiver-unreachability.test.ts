/**
 * @fileoverview Reachability pins for the live-unscoped waiver arm of
 * `waiverStateNote` (`src/gates-common.ts`): every block site that appends
 * the note is gated on `!waiverCovers(...)`, so a live unscoped waiver —
 * which covers every stage — always admits and the live-unscoped arm of the
 * note can never render. Each test here crafts the would-block state for one
 * block-site family, sets a live unscoped waiver, and asserts the dispatch
 * admits: if a future block site stops short-circuiting on `waiverCovers`,
 * these tests flip. The block-side behavior of each site is pinned by the
 * scoped-variant tests in `tests/waiver-scope.test.ts` and
 * `tests/user-waiver.test.ts`.
 */

import { test } from "node:test"
import assert from "node:assert/strict"
import * as fs from "node:fs"
import * as path from "node:path"

import { createGates } from "../src/gates.ts"
import { defaultConfig } from "../src/config.ts"
import { createJournaler } from "../src/journal.ts"
import { createLedger } from "../src/ledger.ts"
import { turnstile } from "../turnstile.ts"
import {
  callSession,
  callTool,
  isolatedEnv,
  makeFakeHost,
  tmpDir,
  type FakeHost,
} from "./helpers.ts"

/** The default config, read once for the cap values the crafted counters
 *  must reach (never hardcoded literals — the caps are configurable). */
const CONFIG = defaultConfig()

/** Boots a gate ledger + gates pair over a temp metrics dir (default config,
 *  trace off) for direct guard assertions against a crafted ledger bucket. */
function bootGates(): {
  gates: ReturnType<typeof createGates>
  ledger: ReturnType<typeof createLedger>
} {
  const metricsDir = tmpDir()
  const ledger = createLedger(path.join(metricsDir, "turnstile.jsonl"), 64, 2000)
  const journaler = createJournaler({
    metricsDir,
    trace: false,
    maxBytes: 1e6,
    maxGenerations: 1,
    rotateEveryEntries: 512,
  })
  return { gates: createGates(CONFIG, journaler), ledger }
}

/** Boots the plugin in a temp project dir containing a plan file, so the
 *  plan gate is live. */
async function bootWithPlan(): Promise<{
  h: FakeHost
  restore: () => void
}> {
  const project = tmpDir()
  fs.mkdirSync(path.join(project, ".opencode", "plans"), { recursive: true })
  fs.writeFileSync(path.join(project, ".opencode", "plans", "plan.md"), "# P\n")
  const metricsDir = tmpDir()
  const h = makeFakeHost()
  const prev = process.cwd()
  process.chdir(project)
  const setup = turnstile(h.host, {
    env: isolatedEnv(metricsDir),
    config: { metricsDir, alwaysEnforce: true },
  })
  const dispose = (await setup(h.host)) as () => void
  return {
    h,
    restore: (): void => {
      dispose()
      process.chdir(prev)
    },
  }
}

/** A live unscoped waiver at the reviewer round cap keeps the reviewer
 *  dispatch admitting: the round-cap block arm is gated on `!covered`, so
 *  the unscoped waiver covers the reviewer stage and the cap never fires.
 *  The waiver is consumed by the dispatch it unlocks. */
test("a live unscoped waiver keeps the capped reviewer round admitting", () => {
  const { gates, ledger } = bootGates()
  const s = ledger.state("p1")
  s.reviewRounds = CONFIG.maxReviewerRounds
  s.userWaiver = "USER WAIVER: just go"
  s.userWaiverScope = []
  gates.guardReviewerDispatch("p1", ledger) // must not throw
  assert.equal(
    ledger.state("p1").userWaiverConsumed,
    true,
    "the unscoped waiver is consumed by the dispatch it unlocks",
  )
})

/** A live unscoped waiver at the gate-unverified block keeps the reviewer
 *  dispatch admitting: both the unverified-PASS and no-gate-pass block arms
 *  sit behind the `!covered` conjunct, which the unscoped waiver falsifies. */
test("a live unscoped waiver keeps an unverified-PASS reviewer dispatch admitting", () => {
  const { gates, ledger } = bootGates()
  const s = ledger.state("p1")
  s.unverifiedPass = "GATE: PASS tests=1 passed=1 failed=0"
  s.hasGatePass = false
  s.userWaiver = "USER WAIVER: just go"
  s.userWaiverScope = []
  gates.guardReviewerDispatch("p1", ledger) // must not throw
})

/** A live unscoped waiver at the no-gate-pass block keeps the reviewer
 *  dispatch admitting: the block arm requires `!covered`, which the
 *  unscoped waiver falsifies. */
test("a live unscoped waiver keeps a no-gate-pass reviewer dispatch admitting", () => {
  const { gates, ledger } = bootGates()
  const s = ledger.state("p1")
  s.hasGatePass = false
  s.unverifiedPass = ""
  s.userWaiver = "USER WAIVER: just go"
  s.userWaiverScope = []
  gates.guardReviewerDispatch("p1", ledger) // must not throw
})

/** A live unscoped waiver keeps a capped planner leg and an exhausted
 *  dispatch budget admitting: the loop-cap and budget block arms are gated
 *  on `!waiverCovers`, which the unscoped waiver falsifies. The waived
 *  commit draws down neither counter. */
test("a live unscoped waiver keeps the capped planner leg and exhausted budget admitting", () => {
  const { gates, ledger } = bootGates()
  const s = ledger.state("p1")
  s.plannerRounds = CONFIG.maxPlannerRounds
  s.totalDispatches = CONFIG.maxTotalDispatches
  s.userWaiver = "USER WAIVER: just go"
  s.userWaiverScope = []
  assert.equal(
    gates.guardDispatchBudget("p1", ledger, "planner"),
    true,
    "the guard reports the admission-time waiver coverage",
  )
  const before = ledger.state("p1")
  gates.countDispatch("p1", ledger, "planner", true)
  const after = ledger.state("p1")
  assert.equal(after.totalDispatches, before.totalDispatches, "the budget is untouched")
  assert.equal(after.plannerRounds, before.plannerRounds, "the leg counter is untouched")
})

/** A live unscoped waiver keeps the plan gate admitting end-to-end: the
 *  executor dispatch over a pending plan resolves instead of throwing the
 *  plan-approval block, because the waiver return precedes `blockPlanGate`. */
test("a live unscoped waiver keeps the plan gate admitting", async () => {
  const { h, restore } = await bootWithPlan()
  try {
    await callSession(h, "prompt", { sessionID: "p1", text: "USER WAIVER: proceed" })
    await callTool(h, "execute.before", {
      tool: "task",
      sessionID: "p1",
      input: { agent: "executor", prompt: "do the work" },
    }) // must not reject
  } finally {
    restore()
  }
})
