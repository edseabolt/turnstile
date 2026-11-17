/**
 * @fileoverview Tests for the `opencode-turnstile evidence` sharing surface
 * (scripts/evidence.mjs), driven by spawning the script the same way
 * bin/cli.mjs does. It covers:
 *
 *  - the whitelist projection (a task's evidence folded to derived counts,
 *    canonical marker lines, a one-way task handle, and two shas — with no
 *    session ID, prompt, dispatch description, or command text emitted);
 *  - task selection (`--task latest` last-line-wins over shape-checked lines;
 *    an explicit `--task <id>` hit and an unknown id);
 *  - the last-wins folds (a trailing GATE: FAIL keeps the gate red; an
 *    enforce-mode `verified:false` PASS reports red; a flag-mode one stays
 *    green; plan BLOCK/STALE; marker allowlist; exit-0 evidence counting;
 *    reviewer ensemble vs. the configured bar; dispatches excluding
 *    blocked:true; waivers surfaced);
 *  - the `--format markdown` sticky-comment body (green and red variants);
 *  - `--out` writing the JSON and sibling `.md` (and an unwritable path);
 *  - the journal read (rotation parity, the replay-tail bound, and
 *    malformed/hostile lines that are skipped or degraded);
 *  - the journal-head sha's stability;
 *  - `--validate` accepting an emitted artifact and rejecting a smuggled
 *    forbidden key, an unknown top-level key, a non-canonical marker, a
 *    smuggled path-shaped value, a bad handle/sha, and a green mismatch;
 *  - unknown flags (exit 2), `--help` (exit 0), and router parity.
 *
 * All fixtures live in a temp dir under the OS temp dir, never the real
 * metrics directory, and the script is read-only.
 */

import * as crypto from "node:crypto"
import { test } from "node:test"
import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { mkdtempSync, mkdirSync, rmSync, readFileSync, writeFileSync, existsSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

import { recordHash } from "../src/chain.ts"

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..")
const evidenceScript = join(repoRoot, "scripts", "evidence.mjs")

/** A journaled entry; fields are deliberately loose (typed `any`). */
type Entry = Record<string, any>

/** The `--format json` document shape the tests key off. */
interface EvidenceDoc {
  schema: string
  generatedAt: string
  noJournal: boolean
  noTask: boolean
  task: string | null
  green: boolean
  emittedAt: string
  plan: {
    verdict: string | null
    marker: string | null
    at: string
    source: string | null
    stale: boolean
  }
  tests: {
    result: string | null
    marker: string | null
    at: string
    verified: boolean | null
    mode: string | null
    exitZeroRuns: number
  }
  review: { approves: number; expected: number }
  waivers: number
  blocks: number
  dispatches: number
  journal: { files: string[]; lines: number; head: string | null }
}

/** Creates a fresh temp metrics dir, returned so the test can remove it. */
function metricsDir(): string {
  return mkdtempSync(join(tmpdir(), "turnstile-evidence-test-"))
}

/**
 * Runs evidence.mjs against a temp metrics dir with a guaranteed-absent config
 * file, so a developer's real config (e.g. `maxReviewerRounds` or
 * `replayTailLines`) can never leak into an assertion on the reviewer bar or
 * the folded window.
 * @param dir The temp metrics directory.
 * @param args Arguments after the subcommand (e.g. `["--format", "json"]`).
 * @returns The spawn result with stdout coerced to string.
 */
function runEvidence(dir: string, args: string[] = []) {
  return spawnSync(process.execPath, [evidenceScript, ...args], {
    env: {
      ...process.env,
      TURNSTILE_METRICS_DIR: dir,
      TURNSTILE_CONFIG: join(dir, "absent-config.json"),
    },
    encoding: "utf8",
  })
}

/**
 * Normalizes the spawn exit code across Node builds.
 * @param res The spawnSync result.
 * @returns The numeric exit code, or -1 when the process did not exit cleanly.
 */
function code(res: { status: number | null; exitCode?: number | null }): number {
  return res.status ?? res.exitCode ?? -1
}

/** Writes a journal file (current or a rotated generation) from JSONL lines. */
function writeJournal(dir: string, file: string, lines: Entry[]): void {
  const target = join(dir, file)
  mkdirSync(dirname(target), { recursive: true })
  writeFileSync(target, lines.map((l) => JSON.stringify(l)).join("\n") + "\n")
}

/** Builds a journal entry with a monotonic ISO timestamp. */
function line(ts: number, entry: Entry): Entry {
  return { ts: new Date(ts).toISOString(), ...entry }
}

/** The sensitive key names that must never appear in a published artifact. */
const FORBIDDEN = ["sessionID", "raw", "command", "description", "waiver", "error"]

/** Collects every forbidden key path at any depth (including array elements). */
function collectForbiddenKeys(node: unknown, found: string[] = []): string[] {
  if (Array.isArray(node)) {
    node.forEach((el) => collectForbiddenKeys(el, found))
    return found
  }
  if (node && typeof node === "object") {
    for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
      if (FORBIDDEN.includes(k)) found.push(k)
      collectForbiddenKeys(v, found)
    }
  }
  return found
}

/** A completed, green task: plan approved, two reviewer votes, a verified gate PASS. */
function greenTask(sid: string): Entry[] {
  return [
    line(1, { type: "plan", sessionID: sid, result: "APPROVE", source: "session-prompt" }),
    line(2, {
      type: "verdict",
      sessionID: sid,
      marker: "VERDICT: APPROVE crit=0 high=0 med=0 low=0",
      source: "task-result",
    }),
    line(3, { type: "ensemble", sessionID: sid, agent: "reviewer", count: 1 }),
    line(4, { type: "ensemble", sessionID: sid, agent: "reviewer", count: 2 }),
    line(5, {
      type: "gate",
      sessionID: sid,
      result: "PASS",
      verified: true,
      mode: "enforce",
      marker: "GATE: PASS tests=904 passed=904 failed=0",
    }),
    line(6, { type: "dispatch", sessionID: sid, agent: "executor" }),
  ]
}

test("evidence: an absent journal emits a noJournal document and exits 0", () => {
  // docstring: with nothing recorded there is no task to summarize, so the
  // honest noJournal flag is emitted and the run still succeeds.
  const dir = metricsDir()
  try {
    const res = runEvidence(dir, ["--format", "json"])
    assert.equal(code(res), 0)
    const obj = JSON.parse(res.stdout) as EvidenceDoc
    assert.equal(obj.noJournal, true)
    assert.equal(obj.task, null)
    assert.equal(obj.schema, "turnstile-evidence/v1")
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("evidence: --task <id> folds only that session's entries", () => {
  // docstring: an explicit task id selects exactly that session; another
  // session's dispatches do not leak into the fold.
  const dir = metricsDir()
  try {
    writeJournal(dir, "turnstile.jsonl", [
      line(1, { type: "dispatch", sessionID: "sp-a", agent: "executor" }),
      line(2, { type: "dispatch", sessionID: "sp-b", agent: "executor" }),
      line(3, { type: "dispatch", sessionID: "sp-b", agent: "executor" }),
      line(4, { type: "dispatch", sessionID: "sp-b", agent: "executor" }),
      line(5, { type: "dispatch", sessionID: "sp-b", agent: "executor" }),
      line(6, { type: "dispatch", sessionID: "sp-b", agent: "executor" }),
    ])
    const res = runEvidence(dir, ["--task", "sp-a", "--format", "json"])
    assert.equal(code(res), 0)
    const obj = JSON.parse(res.stdout) as EvidenceDoc
    assert.equal(obj.dispatches, 1, "only sp-a's single dispatch counts")
    assert.match(obj.task ?? "", /^t-[0-9a-f]{8}$/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("evidence: an unknown --task id exits 2 with an unknown-task message", () => {
  // docstring: a task id that names no session is an input error, not an
  // empty result, so it fails loudly with exit 2.
  const dir = metricsDir()
  try {
    writeJournal(dir, "turnstile.jsonl", [
      line(1, { type: "dispatch", sessionID: "sp-a", agent: "x" }),
    ])
    const res = runEvidence(dir, ["--task", "sp-missing", "--format", "json"])
    assert.equal(code(res), 2)
    assert.match(res.stderr, /unknown task/i)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("evidence: --task latest picks the session owning the greatest-ts line, not the append-last line", () => {
  // docstring: "most recent" is one rule — the greatest-`ts` journaled line's
  // owner (the replay-parity order) — so a line appended last with an older
  // ts still loses to the greatest-ts owner.
  const dir = metricsDir()
  try {
    writeJournal(dir, "turnstile.jsonl", [
      line(100, {
        type: "gate",
        sessionID: "sp-latest",
        result: "PASS",
        marker: "GATE: PASS tests=2 passed=2 failed=0",
      }),
      line(1, {
        type: "gate",
        sessionID: "sp-early",
        result: "PASS",
        marker: "GATE: PASS tests=1 passed=1 failed=0",
      }),
      line(2, { type: "dispatch", sessionID: "sp-appendedlast", agent: "executor" }),
    ])
    const res = runEvidence(dir, ["--format", "json"])
    assert.equal(code(res), 0)
    const obj = JSON.parse(res.stdout) as EvidenceDoc
    assert.equal(obj.task, taskHandle("sp-latest"), "the greatest-ts line's session wins")
    assert.match(obj.task ?? "", /^t-[0-9a-f]{8}$/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("evidence: a shape-invalid last line is skipped so the next valid owner wins", () => {
  // docstring: a hostile trailing line with an ill-shaped sessionID mints no
  // task key, so selection falls through to the last well-formed owner.
  const dir = metricsDir()
  try {
    writeJournal(dir, "turnstile.jsonl", [
      line(1, { type: "dispatch", sessionID: "sp-valid", agent: "executor" }),
      line(2, { type: "gate", sessionID: "bad\nsession", result: "PASS" }),
    ])
    const res = runEvidence(dir, ["--format", "json"])
    assert.equal(code(res), 0)
    const obj = JSON.parse(res.stdout) as EvidenceDoc
    assert.equal(obj.task, taskHandle("sp-valid"))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("evidence: a canonical marker is emitted verbatim; free text is dropped to null", () => {
  // docstring: only the canonical GATE:/VERDICT: pair is emitted; an
  // oversized or free-text journaled marker becomes null so counts, canonical
  // lines, and shas are the only marker-shaped payload.
  const dir = metricsDir()
  try {
    writeJournal(dir, "turnstile.jsonl", [
      line(1, { type: "plan", sessionID: "sp-m", result: "APPROVE", source: "session-prompt" }),
      line(2, {
        type: "gate",
        sessionID: "sp-m",
        result: "PASS",
        verified: true,
        mode: "enforce",
        marker: "GATE: PASS tests=904 passed=904 failed=0",
      }),
    ])
    const good = JSON.parse(runEvidence(dir, ["--format", "json"]).stdout) as EvidenceDoc
    assert.equal(good.tests.marker, "GATE: PASS tests=904 passed=904 failed=0")

    writeJournal(dir, "turnstile.jsonl", [
      line(1, { type: "plan", sessionID: "sp-m", result: "APPROVE", source: "session-prompt" }),
      line(2, {
        type: "gate",
        sessionID: "sp-m",
        result: "PASS",
        verified: true,
        mode: "enforce",
        marker: "GATE: PASS everything, trust me",
      }),
    ])
    const bad = JSON.parse(runEvidence(dir, ["--format", "json"]).stdout) as EvidenceDoc
    assert.equal(bad.tests.marker, null)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("evidence: an unverified enforce-mode PASS reports red", () => {
  // docstring: a GATE: PASS with no correlated exit-0 run is a claim, not
  // green — the same rule the status surface applies.
  const dir = metricsDir()
  try {
    writeJournal(dir, "turnstile.jsonl", [
      line(1, { type: "plan", sessionID: "sp-u", result: "APPROVE", source: "session-prompt" }),
      line(2, { type: "ensemble", sessionID: "sp-u", agent: "reviewer", count: 1 }),
      line(3, { type: "ensemble", sessionID: "sp-u", agent: "reviewer", count: 2 }),
      line(4, {
        type: "gate",
        sessionID: "sp-u",
        result: "PASS",
        verified: false,
        mode: "enforce",
        marker: "GATE: PASS tests=1 passed=1 failed=0",
      }),
    ])
    const obj = JSON.parse(runEvidence(dir, ["--format", "json"]).stdout) as EvidenceDoc
    assert.equal(obj.tests.verified, false)
    assert.equal(obj.tests.result, "PASS")
    assert.equal(obj.green, false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("evidence: an unverified flag-mode PASS reports green", () => {
  // docstring: in flag mode the gate flips on the marker alone, so an
  // unverified PASS is not the same red claim enforce mode reports.
  const dir = metricsDir()
  try {
    writeJournal(dir, "turnstile.jsonl", [
      line(1, { type: "plan", sessionID: "sp-f", result: "APPROVE", source: "session-prompt" }),
      line(2, { type: "ensemble", sessionID: "sp-f", agent: "reviewer", count: 1 }),
      line(3, { type: "ensemble", sessionID: "sp-f", agent: "reviewer", count: 2 }),
      line(4, {
        type: "gate",
        sessionID: "sp-f",
        result: "PASS",
        verified: false,
        mode: "flag",
        marker: "GATE: PASS tests=1 passed=1 failed=0",
      }),
    ])
    const obj = JSON.parse(runEvidence(dir, ["--format", "json"]).stdout) as EvidenceDoc
    assert.equal(obj.tests.verified, false)
    assert.equal(obj.green, true)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("evidence: a trailing GATE: FAIL keeps the gate red (last-wins)", () => {
  // docstring: replay is last-wins, so a trailing FAIL overrides an earlier
  // PASS and the task reports red.
  const dir = metricsDir()
  try {
    writeJournal(dir, "turnstile.jsonl", [
      line(1, { type: "plan", sessionID: "sp-tf", result: "APPROVE", source: "session-prompt" }),
      line(2, { type: "ensemble", sessionID: "sp-tf", agent: "reviewer", count: 1 }),
      line(3, { type: "ensemble", sessionID: "sp-tf", agent: "reviewer", count: 2 }),
      line(4, {
        type: "gate",
        sessionID: "sp-tf",
        result: "PASS",
        verified: true,
        mode: "enforce",
        marker: "GATE: PASS tests=1 passed=1 failed=0",
      }),
      line(5, {
        type: "gate",
        sessionID: "sp-tf",
        result: "FAIL",
        marker: "GATE: FAIL tests=1 passed=0 failed=1",
      }),
    ])
    const obj = JSON.parse(runEvidence(dir, ["--format", "json"]).stdout) as EvidenceDoc
    assert.equal(obj.tests.result, "FAIL")
    assert.equal(obj.green, false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("evidence: a plan BLOCK reports red; a STALE plan sets the stale flag", () => {
  // docstring: the plan gate is red unless approved, and a stale plan carries
  // its own flag so a lapsed approval is surfaced, not silently green.
  const dir = metricsDir()
  try {
    writeJournal(dir, "turnstile.jsonl", [
      line(1, { type: "plan", sessionID: "sp-block", result: "BLOCK", source: "task-result" }),
      line(2, {
        type: "verdict",
        sessionID: "sp-block",
        marker: "VERDICT: BLOCK crit=1 high=0 med=0 low=0",
        source: "task-result",
      }),
    ])
    const block = JSON.parse(runEvidence(dir, ["--format", "json"]).stdout) as EvidenceDoc
    assert.equal(block.plan.verdict, "BLOCK")
    assert.equal(block.green, false)

    writeJournal(dir, "turnstile.jsonl", [
      line(1, {
        type: "plan",
        sessionID: "sp-stale",
        result: "STALE",
        reason: "signature-mismatch",
      }),
    ])
    const stale = JSON.parse(runEvidence(dir, ["--format", "json"]).stdout) as EvidenceDoc
    assert.equal(stale.plan.stale, true)
    assert.equal(stale.green, false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("evidence: exit-0 evidence entries count into exitZeroRuns", () => {
  // docstring: the correlation stamp is only as real as the exit-0 runs
  // behind it, so they are counted from the journaled evidence entries.
  const dir = metricsDir()
  try {
    writeJournal(dir, "turnstile.jsonl", [
      line(1, { type: "evidence", sessionID: "sp-e", event: "observed", exit: 0 }),
      line(2, { type: "evidence", sessionID: "sp-e", event: "observed", exit: 0 }),
      line(3, { type: "evidence", sessionID: "sp-e", event: "observed", exit: 0 }),
    ])
    const obj = JSON.parse(runEvidence(dir, ["--format", "json"]).stdout) as EvidenceDoc
    assert.equal(obj.tests.exitZeroRuns, 3)

    writeJournal(dir, "turnstile.jsonl", [
      line(1, { type: "evidence", sessionID: "sp-e2", event: "observed", exit: 1 }),
    ])
    const none = JSON.parse(runEvidence(dir, ["--format", "json"]).stdout) as EvidenceDoc
    assert.equal(none.tests.exitZeroRuns, 0)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("evidence: the reviewer bar is the ensemble size, not the dispatch cap", () => {
  // docstring: the ensemble decides when the review requirement is satisfied —
  // two unwaived dispatches under the default enforce mode — while
  // `maxReviewerRounds` only bounds how many dispatches may happen. A raised
  // cap must not turn a fully-credited ensemble red, and the fold must read
  // the running counts last-wins (not sum them), so two dispatches report 2,
  // never 3.
  const dir = metricsDir()
  const cfgDir = metricsDir()
  try {
    const cfgPath = join(cfgDir, "turnstile.json")
    writeFileSync(cfgPath, JSON.stringify({ maxReviewerRounds: 3 }))
    writeJournal(dir, "turnstile.jsonl", [
      line(1, { type: "plan", sessionID: "sp-r", result: "APPROVE", source: "session-prompt" }),
      line(2, { type: "ensemble", sessionID: "sp-r", agent: "reviewer", count: 1 }),
      line(3, { type: "ensemble", sessionID: "sp-r", agent: "reviewer", count: 2 }),
      line(4, {
        type: "gate",
        sessionID: "sp-r",
        result: "PASS",
        verified: true,
        mode: "enforce",
        marker: "GATE: PASS tests=1 passed=1 failed=0",
      }),
    ])
    const res = spawnSync(process.execPath, [evidenceScript, "--format", "json"], {
      env: { ...process.env, TURNSTILE_METRICS_DIR: dir, TURNSTILE_CONFIG: cfgPath },
      encoding: "utf8",
    })
    assert.equal(code(res), 0)
    const obj = JSON.parse(res.stdout) as EvidenceDoc
    assert.equal(obj.review.expected, 2, "the bar is the ensemble size under enforce")
    assert.equal(obj.review.approves, 2, "running counts fold last-wins, never summed")
    assert.equal(obj.green, true, "a fully-credited ensemble is green despite the raised cap")
  } finally {
    rmSync(dir, { recursive: true, force: true })
    rmSync(cfgDir, { recursive: true, force: true })
  }
})

test("evidence: advise mode sets the bar at one reviewer APPROVE", () => {
  // docstring: under `reviewEnsemble: "advise"` the runtime credits a single
  // reviewer APPROVE, so the artifact's bar is one and a lone dispatch is green.
  const dir = metricsDir()
  const cfgDir = metricsDir()
  try {
    const cfgPath = join(cfgDir, "turnstile.json")
    writeFileSync(cfgPath, JSON.stringify({ reviewEnsemble: "advise" }))
    writeJournal(dir, "turnstile.jsonl", [
      line(1, { type: "plan", sessionID: "sp-adv", result: "APPROVE", source: "session-prompt" }),
      line(2, { type: "ensemble", sessionID: "sp-adv", agent: "reviewer", count: 1 }),
      line(3, {
        type: "gate",
        sessionID: "sp-adv",
        result: "PASS",
        verified: true,
        mode: "enforce",
        marker: "GATE: PASS tests=1 passed=1 failed=0",
      }),
    ])
    const res = spawnSync(process.execPath, [evidenceScript, "--format", "json"], {
      env: { ...process.env, TURNSTILE_METRICS_DIR: dir, TURNSTILE_CONFIG: cfgPath },
      encoding: "utf8",
    })
    assert.equal(code(res), 0)
    const obj = JSON.parse(res.stdout) as EvidenceDoc
    assert.equal(obj.review.expected, 1)
    assert.equal(obj.review.approves, 1)
    assert.equal(obj.green, true)
  } finally {
    rmSync(dir, { recursive: true, force: true })
    rmSync(cfgDir, { recursive: true, force: true })
  }
})

test("evidence: a refusal stamp keeps the ensemble red; a human release clears it", () => {
  // docstring: an APPROVE credited at an incomplete count is stamped refused
  // and the landing gate never credits on it, so the artifact stays red even
  // though a dispatch happened; the human always-grant writes the clearing
  // stamp and outranks the mechanical ensemble, so the released task reads
  // green with the bar satisfied.
  const dir = metricsDir()
  try {
    writeJournal(dir, "turnstile.jsonl", [
      line(1, { type: "plan", sessionID: "sp-ref", result: "APPROVE", source: "session-prompt" }),
      line(2, {
        type: "ensemble",
        sessionID: "sp-ref",
        agent: "reviewer",
        count: 1,
        refusedApprove: true,
      }),
      line(3, {
        type: "gate",
        sessionID: "sp-ref",
        result: "PASS",
        verified: true,
        mode: "enforce",
        marker: "GATE: PASS tests=1 passed=1 failed=0",
      }),
    ])
    const refused = JSON.parse(runEvidence(dir, ["--format", "json"]).stdout) as EvidenceDoc
    assert.equal(refused.review.approves, 1)
    assert.equal(refused.green, false, "a refused credit is not a satisfied ensemble")
    writeJournal(dir, "turnstile.jsonl", [
      line(1, { type: "plan", sessionID: "sp-hum", result: "APPROVE", source: "session-prompt" }),
      line(2, {
        type: "ensemble",
        sessionID: "sp-hum",
        agent: "reviewer",
        count: 1,
        refusedApprove: true,
      }),
      line(3, {
        type: "ensemble",
        sessionID: "sp-hum",
        agent: "reviewer",
        count: 1,
        refusedApprove: false,
      }),
      line(4, {
        type: "gate",
        sessionID: "sp-hum",
        result: "PASS",
        verified: true,
        mode: "enforce",
        marker: "GATE: PASS tests=1 passed=1 failed=0",
      }),
    ])
    const released = JSON.parse(runEvidence(dir, ["--format", "json"]).stdout) as EvidenceDoc
    assert.equal(released.review.approves, 2, "the human release satisfies the bar")
    assert.equal(released.green, true, "a human release outranks the mechanical ensemble")
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("evidence: a later plain entry un-stamps a refusal at the full count", () => {
  // docstring: the runtime's canonical recovery is the second reviewer
  // dispatch writing a plain (stamp-less) count-2 entry after an earlier
  // refusal — the absent field un-stamps the refusal, so the recovered
  // ensemble reads green with the bar met.
  const dir = metricsDir()
  try {
    writeJournal(dir, "turnstile.jsonl", [
      line(1, { type: "plan", sessionID: "sp-rec", result: "APPROVE", source: "session-prompt" }),
      line(2, {
        type: "ensemble",
        sessionID: "sp-rec",
        agent: "reviewer",
        count: 1,
        refusedApprove: true,
      }),
      line(3, { type: "ensemble", sessionID: "sp-rec", agent: "reviewer", count: 2 }),
      line(4, {
        type: "gate",
        sessionID: "sp-rec",
        result: "PASS",
        verified: true,
        mode: "enforce",
        marker: "GATE: PASS tests=1 passed=1 failed=0",
      }),
    ])
    const obj = JSON.parse(runEvidence(dir, ["--format", "json"]).stdout) as EvidenceDoc
    assert.equal(obj.review.approves, 2)
    assert.equal(obj.review.expected, 2)
    assert.equal(obj.green, true, "the un-stamped full count credits the ensemble")
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("evidence: the dispatch counter excludes blocked attempts", () => {
  // docstring: a rejected dispatch was never executed, so it is a block, not
  // a dispatch — counting both would double count the guard's own entry.
  const dir = metricsDir()
  try {
    writeJournal(dir, "turnstile.jsonl", [
      line(1, { type: "dispatch", sessionID: "sp-d", agent: "executor" }),
      line(2, { type: "dispatch", sessionID: "sp-d", agent: "executor", blocked: true }),
      line(3, { type: "dispatch", sessionID: "sp-d", agent: "test-runner" }),
      line(4, { type: "blocked", sessionID: "sp-d", agent: "executor", reason: "round-limit" }),
    ])
    const obj = JSON.parse(runEvidence(dir, ["--format", "json"]).stdout) as EvidenceDoc
    assert.equal(obj.dispatches, 2)
    assert.equal(obj.blocks, 1)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("evidence: a waived gate surfaces in the count and the markdown", () => {
  // docstring: a waived pass is surfaced, never hidden — the count and the
  // comment body both carry it.
  const dir = metricsDir()
  try {
    writeJournal(dir, "turnstile.jsonl", [
      line(1, { type: "plan", sessionID: "sp-w", result: "APPROVE", source: "session-prompt" }),
      line(2, { type: "ensemble", sessionID: "sp-w", agent: "reviewer", count: 1 }),
      line(3, { type: "ensemble", sessionID: "sp-w", agent: "reviewer", count: 2 }),
      line(4, {
        type: "gate",
        sessionID: "sp-w",
        result: "WAIVED",
        channel: "prompt",
        waiver: "<present>",
      }),
    ])
    const doc = JSON.parse(runEvidence(dir, ["--format", "json"]).stdout) as EvidenceDoc
    assert.equal(doc.waivers, 1)
    const md = runEvidence(dir, ["--format", "markdown"]).stdout
    assert.match(md, /· waivers 1/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("evidence: the markdown body carries the badge, markers, task, and head", () => {
  // docstring: the sticky-comment body starts on the marker comment, carries
  // the green badge, the two inline-backticked canonical markers, the one-way
  // task handle, and the journal head sha.
  const dir = metricsDir()
  try {
    writeJournal(dir, "turnstile.jsonl", greenTask("sp-md"))
    const md = runEvidence(dir, ["--format", "markdown"]).stdout
    const lines = md.split("\n")
    assert.equal(lines[0], "<!-- turnstile:evidence -->")
    assert.match(md, /\*\*turnstile ✓\*\*/)
    assert.match(md, /`VERDICT: APPROVE crit=0 high=0 med=0 low=0`/)
    assert.match(md, /`GATE: PASS tests=904 passed=904 failed=0`/)
    assert.match(md, /task `t-/)
    assert.match(md, /journal head `sha256:/)
    assert.match(md, /_Not proof:/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("evidence: the red markdown variant names the failing dimension", () => {
  // docstring: a red badge states which dimension failed rather than hiding
  // it, so a reviewer sees the reason in the comment itself.
  const dir = metricsDir()
  try {
    writeJournal(dir, "turnstile.jsonl", [
      line(1, { type: "plan", sessionID: "sp-red", result: "APPROVE", source: "session-prompt" }),
      line(2, {
        type: "verdict",
        sessionID: "sp-red",
        marker: "VERDICT: APPROVE crit=0 high=0 med=0 low=0",
        source: "task-result",
      }),
      line(3, { type: "ensemble", sessionID: "sp-red", agent: "reviewer", count: 1 }),
      line(4, { type: "ensemble", sessionID: "sp-red", agent: "reviewer", count: 2 }),
      line(5, { type: "plan", sessionID: "sp-red", result: "BLOCK", source: "task-result" }),
      line(6, {
        type: "verdict",
        sessionID: "sp-red",
        marker: "VERDICT: BLOCK crit=1 high=0 med=0 low=0",
        source: "task-result",
      }),
      line(7, {
        type: "gate",
        sessionID: "sp-red",
        result: "PASS",
        verified: true,
        mode: "enforce",
        marker: "GATE: PASS tests=1 passed=1 failed=0",
      }),
    ])
    const md = runEvidence(dir, ["--format", "markdown"]).stdout
    assert.match(md, /\*\*turnstile ✗\*\*/)
    assert.match(md, /plan blocked/)
    assert.match(md, /_Not proof:/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("evidence: --out writes the JSON and sibling .md and creates the dir", () => {
  // docstring: a .json out path writes both the artifact and the sibling
  // markdown the Action posts, creating the destination, and stdout stays
  // empty so the bytes land only in the files.
  const dir = metricsDir()
  try {
    writeJournal(dir, "turnstile.jsonl", greenTask("sp-out"))
    const out = join(dir, "nested", "evidence.json")
    const res = runEvidence(dir, ["--task", "sp-out", "--out", out])
    assert.equal(code(res), 0)
    assert.equal(res.stdout, "")
    assert.ok(existsSync(out), "json artifact written")
    assert.ok(existsSync(join(dir, "nested", "evidence.md")), "sibling markdown written")
    const md = readFileSync(join(dir, "nested", "evidence.md"), "utf8")
    assert.match(md, /<!-- turnstile:evidence -->/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("evidence: an unwritable --out path exits 1 naming the path", () => {
  // docstring: a write failure is reported as an error that names the path,
  // not a silent success.
  const dir = metricsDir()
  try {
    writeJournal(dir, "turnstile.jsonl", greenTask("sp-uw"))
    // A path whose parent is an existing file is unwritable: the recursive
    // mkdir cannot carve a directory through it.
    const block = join(dir, "block")
    writeFileSync(block, "x")
    const out = join(block, "evidence.json")
    const res = runEvidence(dir, ["--task", "sp-uw", "--out", out])
    assert.equal(code(res), 1)
    assert.match(res.stderr, /evidence\.json/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("evidence: no session identifier or journaled free text is emitted", () => {
  // docstring: the artifact is publishable, so the sensitive set is absent by
  // construction — assert it rather than assume the whitelist.
  const dir = metricsDir()
  try {
    writeJournal(dir, "turnstile.jsonl", [
      line(1, {
        type: "plan",
        sessionID: "ses_SUPERSECRET123",
        result: "APPROVE",
        source: "session-prompt",
      }),
      line(2, {
        type: "gate",
        sessionID: "ses_SUPERSECRET123",
        result: "PASS",
        verified: true,
        mode: "enforce",
        marker: "GATE: PASS tests=1 passed=1 failed=0",
        raw: "ses_CHILDSECRET",
        command: "echo topsecret",
        description: "dispatch desc secret",
        error: "boom",
      }),
      line(3, {
        type: "dispatch",
        sessionID: "ses_SUPERSECRET123",
        agent: "executor",
        description: "do the thing",
      }),
    ])
    const out = runEvidence(dir, ["--task", "ses_SUPERSECRET123", "--format", "json"]).stdout
    assert.ok(!out.includes("ses_SUPERSECRET123"), "parent session id absent")
    assert.ok(!out.includes("ses_CHILDSECRET"), "raw child id absent")
    assert.ok(!out.includes("topsecret"), "command text absent")
    assert.ok(!out.includes("do the thing"), "dispatch description absent")
    const doc = JSON.parse(out) as EvidenceDoc
    assert.deepEqual(collectForbiddenKeys(doc), [], "no forbidden key at any depth")
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("evidence: the journal head sha is stable and changes with the journal", () => {
  // docstring: the head sha is the audit handle — the same journal tail yields
  // the same sha, and a new line changes it, in the pinned 12-hex form.
  const dir = metricsDir()
  try {
    writeJournal(dir, "turnstile.jsonl", greenTask("sp-head"))
    const a = JSON.parse(
      runEvidence(dir, ["--task", "sp-head", "--format", "json"]).stdout,
    ) as EvidenceDoc
    assert.match(a.journal.head ?? "", /^sha256:[0-9a-f]{12}$/)
    const b = JSON.parse(
      runEvidence(dir, ["--task", "sp-head", "--format", "json"]).stdout,
    ) as EvidenceDoc
    assert.equal(b.journal.head, a.journal.head, "same tail, same head")
    writeJournal(dir, "turnstile.jsonl", [
      ...greenTask("sp-head"),
      line(9, { type: "dispatch", sessionID: "sp-head", agent: "executor" }),
    ])
    const c = JSON.parse(
      runEvidence(dir, ["--task", "sp-head", "--format", "json"]).stdout,
    ) as EvidenceDoc
    assert.notEqual(c.journal.head, a.journal.head, "a new line changes the head")
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("evidence: a rotated-only journal still folds and names the generation", () => {
  // docstring: after rotation the current file is absent, so the walk starts
  // at the .1 generation and the report names it.
  const dir = metricsDir()
  try {
    writeJournal(dir, "turnstile.jsonl.1", greenTask("sp-rot"))
    const obj = JSON.parse(
      runEvidence(dir, ["--task", "sp-rot", "--format", "json"]).stdout,
    ) as EvidenceDoc
    assert.deepEqual(obj.journal.files, ["turnstile.jsonl.1"])
    assert.equal(obj.green, true)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("evidence: --validate accepts the per-session sink basenames the emitter reports", () => {
  // docstring: the sessions/ layout names each sink <sessionID>.jsonl, and
  // readJournal walks and reports those basenames — the validator's
  // journal.files rule must accept them, or every artifact from a
  // sessions/-layout machine fails --validate (emitter/validator drift).
  const dir = metricsDir()
  try {
    writeJournal(dir, "turnstile.jsonl", greenTask("ses_abc123"))
    writeJournal(dir, join("sessions", "ses_abc123.jsonl"), greenTask("ses_abc123"))
    const p = join(dir, "evidence.json")
    runEvidence(dir, ["--task", "ses_abc123", "--out", p])
    const emitted = JSON.parse(readFileSync(p, "utf8")) as EvidenceDoc
    assert.ok(
      emitted.journal.files.some((f) => f.startsWith("ses_")),
      "emitter reports the session sink",
    )
    const res = runEvidence(dir, ["--validate", p])
    assert.equal(code(res), 0, `session basenames validate: ${res.stderr}`)
    // A basename outside the session-ID alphabet is still rejected.
    const tampered = JSON.parse(readFileSync(p, "utf8")) as EvidenceDoc
    tampered.journal.files = ["bad name!.jsonl"]
    writeFileSync(p, JSON.stringify(tampered))
    const bad = runEvidence(dir, ["--validate", p])
    assert.equal(code(bad), 1)
    assert.match(bad.stderr, /bad basename/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("evidence: the replay-tail bound limits the folded window", () => {
  // docstring: the fold honors the configured replay tail, so entries outside
  // the tail are not felt by the summary.
  const dir = metricsDir()
  const cfgDir = metricsDir()
  try {
    const cfgPath = join(cfgDir, "turnstile.json")
    writeFileSync(cfgPath, JSON.stringify({ replayTailLines: 2 }))
    // The last two lines are the task's; the older gate FAIL is outside the tail.
    writeJournal(dir, "turnstile.jsonl", [
      line(1, {
        type: "gate",
        sessionID: "sp-tail",
        result: "FAIL",
        marker: "GATE: FAIL tests=1 passed=0 failed=1",
      }),
      line(2, { type: "plan", sessionID: "sp-tail", result: "APPROVE", source: "session-prompt" }),
      line(3, {
        type: "gate",
        sessionID: "sp-tail",
        result: "PASS",
        verified: true,
        mode: "enforce",
        marker: "GATE: PASS tests=1 passed=1 failed=0",
      }),
    ])
    const res = spawnSync(
      process.execPath,
      [evidenceScript, "--task", "sp-tail", "--format", "json"],
      {
        env: { ...process.env, TURNSTILE_METRICS_DIR: dir, TURNSTILE_CONFIG: cfgPath },
        encoding: "utf8",
      },
    )
    assert.equal(code(res), 0)
    const obj = JSON.parse(res.stdout) as EvidenceDoc
    assert.equal(obj.journal.lines, 2, "only the tail is read")
    assert.equal(obj.tests.result, "PASS", "the out-of-tail FAIL is not felt")
  } finally {
    rmSync(dir, { recursive: true, force: true })
    rmSync(cfgDir, { recursive: true, force: true })
  }
})

test("evidence: malformed and hostile lines are skipped or degraded", () => {
  // docstring: hostile appends mint no task key and oversized markers degrade
  // to null, so a tampered journal cannot forge a summary.
  const dir = metricsDir()
  try {
    writeJournal(dir, "turnstile.jsonl", [
      line(1, {
        type: "gate",
        sessionID: "sp-h",
        result: "PASS",
        marker: "GATE: PASS tests=1 passed=1 failed=0",
      }),
      // A valid object with no sessionID is skipped before any fold.
      { ts: new Date(2).toISOString(), type: "gate", result: "PASS" },
      // An oversized marker degrades to null.
      line(3, {
        type: "gate",
        sessionID: "sp-h",
        result: "PASS",
        marker: "GATE: PASS " + "x".repeat(400),
      }),
    ])
    // Append raw garbage that is not even JSON.
    const p = join(dir, "turnstile.jsonl")
    writeFileSync(p, readFileSync(p, "utf8") + "{not json\n42\n")
    const res = runEvidence(dir, ["--task", "sp-h", "--format", "json"])
    assert.equal(code(res), 0)
    const obj = JSON.parse(res.stdout) as EvidenceDoc
    assert.equal(obj.task, taskHandle("sp-h"), "no phantom task minted")
    assert.equal(obj.tests.marker, null, "oversized marker degrades to null")
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("evidence: --validate accepts an emitted artifact without changing it", () => {
  // docstring: a freshly emitted artifact passes the CI re-check and the
  // validate path writes nothing.
  const dir = metricsDir()
  try {
    writeJournal(dir, "turnstile.jsonl", greenTask("sp-v"))
    const p = join(dir, "evidence.json")
    assert.equal(code(runEvidence(dir, ["--task", "sp-v", "--out", p])), 0)
    const before = readFileSync(p, "utf8")
    const res = runEvidence(dir, ["--validate", p])
    assert.equal(code(res), 0)
    assert.equal(readFileSync(p, "utf8"), before, "validate writes nothing")
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("evidence: --validate rejects a smuggled forbidden key at any depth", () => {
  // docstring: the sensitive set is rejected wherever it hides — top-level or
  // nested inside an array element — so a re-keyed leak still fails.
  const dir = metricsDir()
  try {
    writeJournal(dir, "turnstile.jsonl", greenTask("sp-fk"))
    const p = join(dir, "evidence.json")
    runEvidence(dir, ["--task", "sp-fk", "--out", p])
    for (const key of FORBIDDEN) {
      const tampered = { ...JSON.parse(readFileSync(p, "utf8")), [key]: "leak" }
      writeFileSync(p, JSON.stringify(tampered))
      const res = runEvidence(dir, ["--validate", p])
      assert.equal(code(res), 1, `${key} rejected`)
      assert.match(res.stderr, new RegExp(key), `${key} named`)
    }
    // One nested inside an array element.
    const nested = JSON.parse(readFileSync(p, "utf8"))
    nested.journal.files = ["turnstile.jsonl", { error: "nested" }]
    writeFileSync(p, JSON.stringify(nested))
    const res = runEvidence(dir, ["--validate", p])
    assert.equal(code(res), 1)
    assert.match(res.stderr, /error/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("evidence: --validate distinguishes an unknown key from the marker rule", () => {
  // docstring: an unexplained top-level key is an unknown key, while a
  // non-canonical plan marker is the marker rule — the two must not be
  // conflated, since a marker under plan/tests is legitimate payload.
  const dir = metricsDir()
  try {
    writeJournal(dir, "turnstile.jsonl", greenTask("sp-uk"))
    const p = join(dir, "evidence.json")
    runEvidence(dir, ["--task", "sp-uk", "--out", p])
    const withUnknown = { ...JSON.parse(readFileSync(p, "utf8")), bogus: 1 }
    writeFileSync(p, JSON.stringify(withUnknown))
    const u = runEvidence(dir, ["--validate", p])
    assert.equal(code(u), 1)
    assert.match(u.stderr, /unknown key bogus/)

    const withMarker = JSON.parse(readFileSync(p, "utf8"))
    withMarker.bogus = undefined
    withMarker.plan.marker = "VERDICT: APPROVE crit=0 (hand-edited)"
    writeFileSync(p, JSON.stringify(withMarker))
    const m = runEvidence(dir, ["--validate", p])
    assert.equal(code(m), 1)
    assert.match(m.stderr, /plan\.marker/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("evidence: --validate rejects a path-shaped value in a permitted key", () => {
  // docstring: a sensitive value smuggled into a permitted key (such as
  // plan.source) fails that key's pattern, not a blanket rule.
  const dir = metricsDir()
  try {
    writeJournal(dir, "turnstile.jsonl", greenTask("sp-src"))
    const p = join(dir, "evidence.json")
    runEvidence(dir, ["--task", "sp-src", "--out", p])
    const tampered = JSON.parse(readFileSync(p, "utf8"))
    tampered.plan.source = "/Users/ed/repo"
    writeFileSync(p, JSON.stringify(tampered))
    const res = runEvidence(dir, ["--validate", p])
    assert.equal(code(res), 1)
    assert.match(res.stderr, /plan\.source/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("evidence: --validate accepts the subagent-synthetic plan provenance", () => {
  // docstring: the runtime journals `subagent-synthetic` as the plan source
  // when a plan verdict is captured from a subagent task result (src/ledger.ts),
  // so the emitter's provenance whitelist must accept it or every artifact
  // from a subagent-driven task fails --validate (emitter/validator drift).
  const dir = metricsDir()
  try {
    const entries = greenTask("sp-sub").map((e) =>
      e.type === "verdict" ? { ...e, source: "subagent-synthetic" } : e,
    )
    writeJournal(dir, "turnstile.jsonl", entries)
    const p = join(dir, "evidence.json")
    runEvidence(dir, ["--task", "sp-sub", "--out", p])
    const res = runEvidence(dir, ["--validate", p])
    assert.equal(code(res), 0, `subagent-synthetic validates: ${res.stderr}`)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("evidence: --validate rejects a bad task handle, head sha, and green mismatch", () => {
  // docstring: each of the pinned invariants has its own rule, so a bad
  // handle, a bad head sha, and a green that contradicts its fields each
  // fail under their own name.
  const dir = metricsDir()
  try {
    writeJournal(dir, "turnstile.jsonl", greenTask("sp-rj"))
    const p = join(dir, "evidence.json")
    runEvidence(dir, ["--task", "sp-rj", "--out", p])

    const badTask = JSON.parse(readFileSync(p, "utf8"))
    badTask.task = "t-zzzznot-hex"
    writeFileSync(p, JSON.stringify(badTask))
    const t = runEvidence(dir, ["--validate", p])
    assert.equal(code(t), 1)
    assert.match(t.stderr, /task/)

    const badHead = JSON.parse(readFileSync(p, "utf8"))
    badHead.journal.head = "sha256:xyz"
    writeFileSync(p, JSON.stringify(badHead))
    const h = runEvidence(dir, ["--validate", p])
    assert.equal(code(h), 1)
    assert.match(h.stderr, /journal\.head/)

    const badGreen = JSON.parse(readFileSync(p, "utf8"))
    badGreen.plan.verdict = "BLOCK" // green=true no longer matches the rule
    writeFileSync(p, JSON.stringify(badGreen))
    const g = runEvidence(dir, ["--validate", p])
    assert.equal(code(g), 1)
    assert.match(g.stderr, /green/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("evidence: an unknown flag exits 2 and --help exits 0 with usage", () => {
  // docstring: input errors exit 2 with the usage text; help is a clean exit.
  const dir = metricsDir()
  try {
    const bad = runEvidence(dir, ["--bogus"])
    assert.equal(code(bad), 2)
    assert.match(bad.stderr, /unknown argument/i)
    const help = runEvidence(dir, ["--help"])
    assert.equal(code(help), 0)
    assert.match(help.stdout, /Usage: opencode-turnstile evidence/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("evidence: the evidence subcommand is routed from the CLI router", () => {
  // docstring: bin/cli.mjs routes `evidence` onto scripts/evidence.mjs, so a
  // router spawn against an empty temp dir behaves like the script directly.
  const dir = metricsDir()
  try {
    const cli = spawnSync(
      process.execPath,
      [join(repoRoot, "bin", "cli.mjs"), "evidence", "--format", "json"],
      {
        env: { ...process.env, TURNSTILE_METRICS_DIR: dir },
        encoding: "utf8",
      },
    )
    assert.equal(code(cli), 0)
    const obj = JSON.parse(cli.stdout) as EvidenceDoc
    assert.equal(obj.noJournal, true)
    assert.equal(obj.schema, "turnstile-evidence/v1")
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("evidence: a hostile journaled mode/verified degrades to null, not leaked", () => {
  // docstring: a journaled `verified`/`mode` survives only in its whitelisted
  // shape (a boolean / a gate-evidence mode); a path-shaped mode and a string
  // verified degrade to null just as a free-text marker does, so a hostile
  // journal value cannot leak into the artifact.
  const dir = metricsDir()
  try {
    writeJournal(dir, "turnstile.jsonl", [
      line(1, { type: "plan", sessionID: "sp-leak", result: "APPROVE", source: "session-prompt" }),
      line(2, {
        type: "gate",
        sessionID: "sp-leak",
        result: "PASS",
        verified: "yes",
        mode: "/Users/ed/secret-repo",
        marker: "GATE: PASS tests=1 passed=1 failed=0",
      }),
    ])
    const out = runEvidence(dir, ["--task", "sp-leak", "--format", "json"]).stdout
    const obj = JSON.parse(out) as EvidenceDoc
    assert.equal(obj.tests.verified, null, "string verified degrades to null")
    assert.equal(obj.tests.mode, null, "path-shaped mode degrades to null")
    assert.equal(obj.tests.result, "PASS", "the gate result is preserved")
    assert.ok(!out.includes("secret-repo"), "the hostile mode value is not leaked")
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("evidence: the emitted hostile-field document passes its own --validate", () => {
  // docstring: once the fold degrades the hostile mode/verified to null, the
  // emitted document is self-consistent — it passes the same --validate gate a
  // CI job runs on a committed artifact.
  const dir = metricsDir()
  try {
    writeJournal(dir, "turnstile.jsonl", [
      line(1, { type: "plan", sessionID: "sp-rt", result: "APPROVE", source: "session-prompt" }),
      line(2, {
        type: "gate",
        sessionID: "sp-rt",
        result: "PASS",
        verified: "yes",
        mode: "/Users/ed/secret-repo",
        marker: "GATE: PASS tests=1 passed=1 failed=0",
      }),
    ])
    const p = join(dir, "evidence.json")
    assert.equal(code(runEvidence(dir, ["--task", "sp-rt", "--out", p])), 0)
    const res = runEvidence(dir, ["--validate", p])
    assert.equal(code(res), 0, "the self-consistent hostile-field doc validates")
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("evidence: a null plan/tests/review reports a named rule and does not crash", () => {
  // docstring: a task document whose section is null is rejected with a named
  // shape rule, not an uncaught TypeError from the green rule or the sibling
  // render — the recompute and re-render both decline a non-object section.
  const dir = metricsDir()
  try {
    writeJournal(dir, "turnstile.jsonl", greenTask("sp-null"))
    const p = join(dir, "evidence.json")
    runEvidence(dir, ["--task", "sp-null", "--out", p])
    const original = readFileSync(p, "utf8")
    for (const section of ["plan", "tests", "review"]) {
      const tampered = JSON.parse(original)
      tampered[section] = null
      writeFileSync(p, JSON.stringify(tampered))
      const res = runEvidence(dir, ["--validate", p])
      assert.equal(code(res), 1, `${section}: null → invalid`)
      assert.match(
        res.stderr,
        new RegExp(`${section}: must be a plain object`),
        `${section}: named`,
      )
      assert.ok(!res.stderr.includes("TypeError"), `${section}: no uncaught TypeError`)
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("evidence: a forged green with null sections is rejected", () => {
  // docstring: green:true while every section is null cannot pass the
  // validator — the null sections are each named by the shape rule, so a
  // forged badge fails the re-check rather than the green rule crashing.
  const dir = metricsDir()
  try {
    writeJournal(dir, "turnstile.jsonl", greenTask("sp-forged"))
    const p = join(dir, "evidence.json")
    runEvidence(dir, ["--task", "sp-forged", "--out", p])
    const forged = JSON.parse(readFileSync(p, "utf8"))
    forged.green = true
    forged.plan = null
    forged.tests = null
    forged.review = null
    writeFileSync(p, JSON.stringify(forged))
    const res = runEvidence(dir, ["--validate", p])
    assert.equal(code(res), 1, "a forged green with null sections is rejected")
    assert.match(res.stderr, /plan: must be a plain object/)
    assert.ok(!res.stderr.includes("TypeError"), "no uncaught TypeError")
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("evidence: an array-typed plan section is a named violation, not accepted", () => {
  // docstring: an array where a plain-object section belongs is not a section;
  // the validator names it instead of reading it, so a re-typed section cannot
  // be smuggled past the green rule.
  const dir = metricsDir()
  try {
    writeJournal(dir, "turnstile.jsonl", greenTask("sp-arr"))
    const p = join(dir, "evidence.json")
    runEvidence(dir, ["--task", "sp-arr", "--out", p])
    const tampered = JSON.parse(readFileSync(p, "utf8"))
    tampered.plan = [{ note: "x" }, "y"]
    writeFileSync(p, JSON.stringify(tampered))
    const res = runEvidence(dir, ["--validate", p])
    assert.equal(code(res), 1, "an array-typed plan is rejected")
    assert.match(res.stderr, /plan: must be a plain object/)
    assert.ok(!res.stderr.includes("TypeError"), "no uncaught TypeError")
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

/** The one-way task handle for a session ID (the pinned t-<8 hex> form). */
function taskHandle(sessionID: string): string {
  // Reimplemented here so the test does not import the script; the handle is
  // sha256(sessionID) truncated to 8 hex chars, prefixed "t-".
  return "t-" + crypto.createHash("sha256").update(sessionID).digest("hex").slice(0, 8)
}

/**
 * Reads one journal file family's current file as parsed rows (generations are
 * not needed by these tests: the emit row always lands in the current file).
 * @param dir The metrics directory.
 * @param file The file basename or `sessions/<sid>.jsonl` relative path.
 * @returns The parsed rows, file order.
 */
function readJournalLines(dir: string, file: string): Entry[] {
  return readFileSync(join(dir, file), "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Entry)
}

/** Counts the `event:"emit"` rows in a parsed journal file. */
function emitRows(rows: Entry[]): Entry[] {
  return rows.filter((r) => r.type === "evidence" && r.event === "emit")
}

test('evidence: an --out emit journals one event:"emit" row for the task', () => {
  // docstring: an artifact write is the durable emit, so exactly one emit row
  // naming the task's session is appended to the shared journal.
  const dir = metricsDir()
  try {
    writeJournal(dir, "turnstile.jsonl", greenTask("sp-emit"))
    runEvidence(dir, ["--task", "sp-emit", "--out", join(dir, "e.json")])
    const emit = emitRows(readJournalLines(dir, "turnstile.jsonl"))
    assert.equal(emit.length, 1)
    assert.equal(emit[0]!.sessionID, "sp-emit")
    assert.match(emit[0]!.ts, /^\d{4}-\d{2}-\d{2}T/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("evidence: a stdout emit and a --validate journal nothing", () => {
  // docstring: stdout output is a read and --validate writes nothing, so
  // neither may append an emit row — only the artifact write journals.
  const dir = metricsDir()
  try {
    writeJournal(dir, "turnstile.jsonl", greenTask("sp-ro"))
    runEvidence(dir, ["--task", "sp-ro", "--format", "json"])
    const p = join(dir, "e.json")
    runEvidence(dir, ["--task", "sp-ro", "--out", p])
    const before = readJournalLines(dir, "turnstile.jsonl").length
    runEvidence(dir, ["--validate", p])
    const rows = readJournalLines(dir, "turnstile.jsonl")
    assert.equal(emitRows(rows).length, 1, "only the --out emit row exists")
    assert.equal(rows.length, before, "--validate appended nothing")
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("evidence: the emit row routes to the session sink when the family exists", () => {
  // docstring: when the sessions dir holds a family root for the task, the
  // emit row lands in that sink like the task's other rows; otherwise it
  // falls back to the shared file.
  const dir = metricsDir()
  try {
    writeJournal(dir, "turnstile.jsonl", greenTask("sp-shared"))
    writeJournal(dir, join("sessions", "sp-sink.jsonl"), greenTask("sp-sink"))
    runEvidence(dir, ["--task", "sp-sink", "--out", join(dir, "a.json")])
    runEvidence(dir, ["--task", "sp-shared", "--out", join(dir, "b.json")])
    assert.equal(emitRows(readJournalLines(dir, join("sessions", "sp-sink.jsonl"))).length, 1)
    assert.equal(emitRows(readJournalLines(dir, "turnstile.jsonl")).length, 1)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("evidence: task documents carry emittedAt; degraded docs carry an empty one", () => {
  // docstring: the emitted artifact's emittedAt equals the emit row's ts, and
  // a noTask degraded document carries the empty-string form.
  const dir = metricsDir()
  try {
    writeJournal(dir, "turnstile.jsonl", greenTask("sp-at"))
    const p = join(dir, "e.json")
    runEvidence(dir, ["--task", "sp-at", "--out", p])
    const doc = JSON.parse(readFileSync(p, "utf8")) as EvidenceDoc
    assert.match(doc.emittedAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/)
    const row = emitRows(readJournalLines(dir, "turnstile.jsonl"))[0]!
    assert.equal(doc.emittedAt, row.ts, "emittedAt equals the emit row's ts")
    // A noTask document: journal lines exist but none carries a valid
    // session ID, so the latest selector degrades to noTask (an explicit
    // unknown id would be an input error, exit 2).
    writeFileSync(
      join(dir, "turnstile.jsonl"),
      JSON.stringify({ ts: new Date(1).toISOString(), type: "gate", result: "PASS" }) + "\n",
    )
    const empty = JSON.parse(runEvidence(dir, ["--format", "json"]).stdout) as EvidenceDoc
    assert.equal(empty.noTask, true)
    assert.equal(empty.emittedAt, "")
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("evidence: a legacy artifact without emittedAt validates; a malformed one does not", () => {
  // docstring: the emittedAt rule is conditional on the key's presence, so a
  // pre-change artifact stays valid, while a present-but-malformed value is
  // named by the validator.
  const dir = metricsDir()
  try {
    writeJournal(dir, "turnstile.jsonl", greenTask("sp-legacy"))
    const p = join(dir, "e.json")
    runEvidence(dir, ["--task", "sp-legacy", "--out", p])
    const legacy: Record<string, unknown> = JSON.parse(readFileSync(p, "utf8"))
    delete legacy.emittedAt
    writeFileSync(p, JSON.stringify(legacy))
    assert.equal(code(runEvidence(dir, ["--validate", p])), 0, "absent emittedAt is valid")
    const bad = JSON.parse(readFileSync(p, "utf8")) as EvidenceDoc
    bad.emittedAt = "not-a-ts"
    writeFileSync(p, JSON.stringify(bad))
    const res = runEvidence(dir, ["--validate", p])
    assert.equal(code(res), 1)
    assert.match(res.stderr, /emittedAt: bad timestamp/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("evidence: emit rows never count into exitZeroRuns", () => {
  // docstring: an emit row carries no exit field, so the exit-0 run count
  // reflects only real exit-0 evidence rows, never artifact writes.
  const dir = metricsDir()
  try {
    writeJournal(dir, "turnstile.jsonl", [
      ...greenTask("sp-ez"),
      line(7, { type: "evidence", sessionID: "sp-ez", exit: 0 }),
    ])
    const p = join(dir, "e.json")
    runEvidence(dir, ["--task", "sp-ez", "--out", p])
    const doc = JSON.parse(readFileSync(p, "utf8")) as EvidenceDoc
    assert.equal(doc.tests.exitZeroRuns, 1)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("evidence: repeated emits are last-wins and advance the journal head", () => {
  // docstring: two artifact writes append two emit rows; the second (newer)
  // row's ts wins the fold and the reported head is the post-append tail.
  const dir = metricsDir()
  try {
    writeJournal(dir, "turnstile.jsonl", greenTask("sp-2x"))
    const p = join(dir, "e.json")
    runEvidence(dir, ["--task", "sp-2x", "--out", p])
    const first = JSON.parse(readFileSync(p, "utf8")) as EvidenceDoc
    runEvidence(dir, ["--task", "sp-2x", "--out", p])
    const second = JSON.parse(readFileSync(p, "utf8")) as EvidenceDoc
    const rows = emitRows(readJournalLines(dir, "turnstile.jsonl"))
    assert.equal(rows.length, 2)
    assert.equal(second.emittedAt, rows[1]!.ts, "the newer emit row wins")
    assert.notEqual(second.emittedAt, first.emittedAt)
    assert.notEqual(second.journal.head, first.journal.head, "the head advanced")
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("evidence: an unchained emit row leaves a chained journal verifiable", () => {
  // docstring: the emit row is appended without a hash field, so the hash
  // chain fold still reports ok over the seeded chained rows and the row is
  // visible in the audit trail.
  const dir = metricsDir()
  try {
    const ts = "2026-01-01T10:00:00.000Z"
    const payload = { ts, type: "gate", sessionID: "ses1", result: "PASS" }
    const hash = recordHash("", ts, payload)
    writeJournal(dir, "turnstile.jsonl", [{ ...payload, seq: 0, prevHash: "", hash }])
    const p = join(dir, "e.json")
    const res = runEvidence(dir, ["--task", "ses1", "--out", p])
    assert.equal(code(res), 0, `stderr: ${res.stderr}`)
    const rows = readJournalLines(dir, "turnstile.jsonl")
    assert.equal(rows.length, 2, "the emit row was appended")
    assert.equal(rows[1]!.hash, undefined, "the emit row is unchained")
    // The chain-verify spawn path (prov --verify, the pattern from
    // tests/prov-verify-cli.test.ts): the chain folds ok over the seeded
    // chained row plus the unchained emit row — the emit row did not fork
    // the hash chain.
    const v = spawnSync(process.execPath, [join(repoRoot, "scripts", "prov.mjs"), "--verify"], {
      env: { ...process.env, TURNSTILE_METRICS_DIR: dir },
      encoding: "utf8",
    })
    assert.equal(code(v), 0, v.stdout)
    assert.match(v.stdout, /chain ok \(2 rows, 0 epochs\)/, "the chain still verifies")
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("evidence: an explicit task scopes files and lines to its session tree", () => {
  // docstring: the task window reads only the task's session tree — its sink
  // family and the shared file filtered to it — so another session's rows
  // (even newer ones dominating the shared tail) neither enter the fold nor
  // the reported files/lines.
  const dir = metricsDir()
  try {
    writeJournal(dir, join("sessions", "sp-a.jsonl"), greenTask("sp-a"))
    writeJournal(dir, "turnstile.jsonl", [
      ...greenTask("sp-b"),
      line(100, { type: "dispatch", sessionID: "sp-b", agent: "executor" }),
    ])
    const obj = JSON.parse(
      runEvidence(dir, ["--task", "sp-a", "--format", "json"]).stdout,
    ) as EvidenceDoc
    assert.equal(obj.green, true, "the fold is sp-a's green task")
    assert.equal(obj.dispatches, 1)
    assert.ok(
      obj.journal.files.every((f) => !f.includes("sp-b")),
      "no other session's file is reported",
    )
    assert.equal(obj.journal.lines, greenTask("sp-a").length, "the scoped count, not the global")
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("evidence: a quiet session's rows are not evicted by a hot shared tail", () => {
  // docstring: the sink family is walked with the full replay tail, so a
  // session whose rows fell out of a hot shared tail still emits a full task.
  const dir = metricsDir()
  const cfgDir = metricsDir()
  try {
    const cfgPath = join(cfgDir, "turnstile.json")
    writeFileSync(cfgPath, JSON.stringify({ replayTailLines: 2 }))
    writeJournal(dir, join("sessions", "sp-quiet.jsonl"), greenTask("sp-quiet"))
    writeJournal(dir, "turnstile.jsonl", [
      line(10, { type: "dispatch", sessionID: "sp-hot", agent: "x" }),
      line(11, { type: "dispatch", sessionID: "sp-hot", agent: "x" }),
      line(12, { type: "dispatch", sessionID: "sp-hot", agent: "x" }),
    ])
    const res = spawnSync(
      process.execPath,
      [evidenceScript, "--task", "sp-quiet", "--format", "json"],
      {
        env: { ...process.env, TURNSTILE_METRICS_DIR: dir, TURNSTILE_CONFIG: cfgPath },
        encoding: "utf8",
      },
    )
    assert.equal(code(res), 0)
    const obj = JSON.parse(res.stdout) as EvidenceDoc
    assert.equal(obj.green, true, "the quiet session's full task is folded")
    assert.equal(obj.journal.lines, greenTask("sp-quiet").length, "the scoped window")
  } finally {
    rmSync(dir, { recursive: true, force: true })
    rmSync(cfgDir, { recursive: true, force: true })
  }
})

test("evidence: child-edge rows pull child sinks into the session tree", () => {
  // docstring: a child sink named by a shared-file `child-edge` row is walked
  // with the parent's, so its rows count into the reported journal window —
  // while the fold itself stays parent-keyed.
  const dir = metricsDir()
  try {
    const parentRows = greenTask("sp-parent")
    writeJournal(dir, join("sessions", "sp-parent.jsonl"), parentRows)
    const childRows = [
      line(7, { type: "marker-retry", sessionID: "sp-child", agent: "executor" }),
      line(8, { type: "marker-retry", sessionID: "sp-child", agent: "executor" }),
    ]
    writeJournal(dir, join("sessions", "sp-child.jsonl"), childRows)
    writeJournal(dir, "turnstile.jsonl", [
      line(9, { type: "child-edge", sessionID: "sp-child", parent: "sp-parent" }),
    ])
    const obj = JSON.parse(
      runEvidence(dir, ["--task", "sp-parent", "--format", "json"]).stdout,
    ) as EvidenceDoc
    assert.ok(
      obj.journal.files.some((f) => f.startsWith("sp-child")),
      "the child sink is reported",
    )
    assert.equal(obj.journal.lines, parentRows.length + childRows.length + 1)
    assert.equal(obj.dispatches, 1, "the fold counts only parent-keyed rows")
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("evidence: an explicit task with rows only in another session exits 2", () => {
  // docstring: an explicit id whose session tree holds no rows anywhere — no
  // sink, no shared rows — is an input error, so it exits 2 loudly.
  const dir = metricsDir()
  try {
    writeJournal(dir, "turnstile.jsonl", [
      line(1, { type: "dispatch", sessionID: "sp-b", agent: "x" }),
    ])
    const res = runEvidence(dir, ["--task", "sp-missing", "--format", "json"])
    assert.equal(code(res), 2)
    assert.match(res.stderr, /unknown task/i)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("evidence: --out mirrors the artifact beside the session sink", () => {
  // docstring: a task artifact written with --out is mirrored to
  // sessions/<sid>/evidence.json with the same bytes; a degraded document
  // mirrors nothing.
  const dir = metricsDir()
  try {
    writeJournal(dir, join("sessions", "sp-mir.jsonl"), greenTask("sp-mir"))
    const p = join(dir, "e.json")
    const res = runEvidence(dir, ["--task", "sp-mir", "--out", p])
    assert.equal(code(res), 0, `stderr: ${res.stderr}`)
    const mirror = join(dir, "sessions", "sp-mir", "evidence.json")
    assert.equal(readFileSync(mirror, "utf8"), readFileSync(p, "utf8"), "same bytes")
    // A degraded (noTask) document mirrors nothing.
    const p2 = join(dir, "e2.json")
    runEvidence(dir, ["--task", "latest", "--out", p2])
    assert.equal(code(res), 0)
    assert.equal(existsSync(join(dir, "sessions", "latest")), false, "no mirror for noTask")
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("evidence: a failed mirror write degrades to a stderr note with exit 0", () => {
  // docstring: the mirror is best-effort — an unwritable sessions path writes
  // one stderr note and the artifact is still emitted successfully.
  const dir = metricsDir()
  try {
    writeJournal(dir, join("sessions", "sp-mir2.jsonl"), greenTask("sp-mir2"))
    // A file where the mirror directory must be created blocks mkdir.
    writeFileSync(join(dir, "sessions", "sp-mir2"), "not a dir")
    const p = join(dir, "e.json")
    const res = runEvidence(dir, ["--task", "sp-mir2", "--out", p])
    assert.equal(code(res), 0, "the exit code is unaffected")
    assert.match(res.stderr, /could not mirror the artifact/)
    assert.ok(existsSync(p), "the artifact itself was still written")
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
