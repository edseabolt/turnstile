/**
 * @fileoverview Plans-dir content scan: the cached scan both plan gates build
 * on — sorted `.md` names, per-file spec-region and whole-file sha256 keys,
 * and the `## Decomposition` set — keyed by the dir's path-free content
 * signature. Extracted from `src/gates-plan.ts`; the cache is owned by one
 * object (`createPlansScanCache`), not a closure `let`, so each `createGates`
 * instance gets its own rescan cache and multi-instance consumers never share
 * fail-open journaling. Any fs error throws to the caller's fail-open.
 */

import * as fs from "node:fs"
import { createHash } from "node:crypto"
import * as path from "node:path"

import type { Journaler } from "./journal.ts"
import type { TurnstileConfig } from "./types.ts"
import { planSpecRegion } from "./plan-region.ts"

/** What one plans-dir scan establishes for both plan gates. */
export interface PlansScan {
  /**
   * Content signature of the plans dir: `name:sha256hex,…`. Two scans
   * with different keys mean the plans dir _content_ changed (an add,
   * delete, rename, or same-size/content edit); a utimes-only or dir touch
   * leaves it identical — dir mtime is deliberately not hashed. The key is
   * path-free so an approval issued against one checkout survives a
   * same-content move; the empty dir maps to the `"empty"` sentinel (never
   * `""`, which would collide with the accept-once stamp).
   */
  key: string
  /** Sorted plan file names (empty when the dir holds no plans). */
  names: string[]
  /**
   * First (sorted) plan carrying a `## Decomposition` block, or null.
   * Derived from `decomp` for the legacy no-ledger rule; superseded by
   * active-plan resolution when a plan is bound or named.
   */
  decompFile: string | null
  /** Every plan name whose bytes carry a `## Decomposition` block. */
  decomp: Set<string>
  /**
   * Every plan name → sha256 hex of its spec-region bytes (the
   * bound-staleness key; `# Progress` content is excluded — see
   * `src/plan-region.ts`).
   */
  fileKeys: Map<string, string>
  /**
   * Every plan name → sha256 hex of its whole-file bytes (the legacy
   * pre-spec-region approval key). The durable store matches a record
   * under either scheme, so a pre-spec-region record whose bytes are
   * unchanged still covers the plan.
   */
  wholeFileKeys: Map<string, string>
}

/**
 * Sorted `.md` names with per-file content buffers, one readdir + read
 * each; the buffers feed the digest so the scan never re-reads a file.
 * @param dir Absolute plans directory path.
 * @returns Sorted `{ name, bytes }` for every `.md` entry (empty when none).
 */
function readEntries(dir: string): Array<{ name: string; bytes: Buffer }> {
  const names = fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".md"))
    .sort()
  return names.map((name) => ({ name, bytes: fs.readFileSync(path.join(dir, name)) }))
}

/**
 * sha256 hex of one plan file's spec region (`planSpecRegion`): the per-file
 * content identity that both the dir key and a bound approval's key are
 * built from — one hash per file per scan, never recomputed.
 * @param bytes The plan file bytes.
 * @returns The hex digest.
 */
function hashEntry(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex")
}

/**
 * Content signature of the plans dir: `name:sha256hex,…`, path-free so a
 * same-content move survives an approval. Identical iff the plans dir's
 * content is identical — an add, delete, rename, or same-size/content edit
 * changes it; a utimes-only or dir touch does not. The empty dir emits the
 * literal sentinel `"empty"` (never `""`, which collides with the accept-once
 * stamp: an approval stamped on an empty dir must mismatch once a plan file
 * appears, journaling STALE loudly rather than silently re-stamping green).
 * @param pairs The plan name + per-file sha256 hex pairs from the scan.
 * @returns The path-free content signature, or `"empty"` when there are none.
 */
function plansKey(pairs: Array<{ name: string; hash: string }>): string {
  if (pairs.length === 0) return "empty"
  return pairs.map((p) => `${p.name}:${p.hash}`).join(",")
}

/**
 * Builds the decomposition set of one scan: every plan name whose bytes
 * carry a `## Decomposition` block.
 * @param entries The plan name + bytes entries.
 * @returns The decomposed plan names.
 */
function collectDecomp(entries: Array<{ name: string; bytes: Buffer }>): Set<string> {
  const decomp = new Set<string>()
  for (const e of entries) {
    if (e.bytes.toString("utf8").includes("## Decomposition")) decomp.add(e.name)
  }
  return decomp
}

/**
 * Builds the scan record from one read of the plans dir: the pieces are
 * derived from the same entries so the key and the per-file maps can never
 * disagree.
 * @param key The dir's path-free content signature.
 * @param entries The plan name + bytes entries.
 * @param pairs The plan name + spec-region sha256 hex pairs.
 * @returns The scan record.
 */
function buildScan(
  key: string,
  entries: Array<{ name: string; bytes: Buffer }>,
  pairs: Array<{ name: string; hash: string }>,
): PlansScan {
  const names = entries.map((e) => e.name)
  const decomp = collectDecomp(entries)
  return {
    key,
    names,
    decomp,
    fileKeys: new Map(pairs.map((p) => [p.name, p.hash])),
    wholeFileKeys: new Map(entries.map((e) => [e.name, hashEntry(e.bytes)])),
    decompFile: names.find((n) => decomp.has(n)) ?? null,
  }
}

/**
 * The mutable cache cell owned by one `createPlansScanCache` instance: the
 * last scan keyed by its content signature, or null before the first scan.
 */
interface PlansCacheCell {
  entry: { key: string; scan: PlansScan } | null
}

/**
 * Returns the current scan for the plans dir, caching by content signature
 * in the caller's cell. The cache skips a redundant rescan: a key hit
 * returns the cached scan, skipping the utf8 decode and `## Decomposition`
 * search; a key miss replaces it — either way the returned key reports the
 * dir's current content. The key is path-free, so the cached scan is
 * directory-agnostic and a same-content move reuses it. One read of the
 * dir feeds both the key check and the rebuilt scan, so they can never
 * disagree.
 * @param cell The instance's cache cell (read and replaced in place).
 * @param dir Absolute plans directory path.
 * @returns The current scan; `scan.key` is the dir's content signature.
 */
function cachedScan(cell: PlansCacheCell, dir: string): PlansScan {
  const entries = readEntries(dir)
  // The per-file key hashes the spec region (src/plan-region.ts), not the
  // whole file: the leading `# Progress` section is pipeline-maintained by
  // design, so a progress-only edit must not invalidate a bound approval.
  // Capture (planApprovalBinding), reconcile (reconcileBoundStamp), and the
  // durable sidecar compare all read this one map — one shared extractor,
  // one key shape everywhere.
  const pairs = entries.map((e) => ({ name: e.name, hash: hashEntry(planSpecRegion(e.bytes)) }))
  const key = plansKey(pairs)
  const cached = cell.entry
  // Cache-hit caveat, accepted: the signature hashes spec regions only, so
  // a progress-only edit lands here and the returned scan's `wholeFileKeys`
  // still hash the bytes at the last refresh — the durable store's legacy
  // arm can then match against last-scan bytes rather than the current
  // file. Sound to honor: the hit proves the spec region unchanged since
  // that scan, and the re-key it triggers writes the current spec key. The
  // mirror edit-then-revert can leave whole-file hashes from the interim
  // bytes, false-blocking a legacy record until restart or the next
  // signature change rescan — fail-toward-strict, self-healing.
  if (cached !== null && cached.key === key) return cached.scan
  const scan = buildScan(key, entries, pairs)
  cell.entry = { key, scan }
  return scan
}

/**
 * Single source for the plans-dir location: a relative value (the default)
 * joins the per-dispatch project dir; an absolute value is honored as-is
 * (validateResolved journaled a warning at load).
 * @param config The resolved plugin configuration.
 * @param projectDir The current project directory.
 * @returns The absolute plans directory path.
 */
export function resolvePlansDir(config: TurnstileConfig, projectDir: string): string {
  return path.isAbsolute(config.plansDir) ? config.plansDir : path.join(projectDir, config.plansDir)
}

/**
 * Creates the instance-local plans-dir scan cache. A key hit returns the
 * cached scan and skips the per-file hashing, the utf8 decode, and the
 * `## Decomposition` search; a key miss recomputes the scan (fileKeys,
 * decomp, decompFile). Any fs error throws to the caller's fail-open.
 * @param config The resolved plugin configuration (the plans-dir location).
 * @returns `get(dir)` (the cached scan) and `resolvePlansDir(projectDir)`
 *     (the single plans-dir location resolution).
 */
export function createPlansScanCache(config: TurnstileConfig): {
  get(dir: string): PlansScan
  resolvePlansDir(projectDir: string): string
} {
  const cell: PlansCacheCell = { entry: null }
  return {
    get: (dir) => cachedScan(cell, dir),
    resolvePlansDir: (projectDir) => resolvePlansDir(config, projectDir),
  }
}

/**
 * Journals the fail-open for an unreadable plans dir so it stays observable.
 * Shared shape for every plan-gate consumer's catch arm.
 * @param journaler The telemetry writer.
 * @param e The caught error.
 */
export function journalPlansUnreadable(journaler: Journaler, e: unknown): void {
  journaler.journal({ type: "error", error: `plans dir unreadable: ${e}` })
}
