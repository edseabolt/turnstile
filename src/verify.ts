/**
 * @fileoverview Full-chain verify orchestration: folds every journal file
 * family (shared + per-session sinks) across rotation generations, checks
 * the committed epoch roots, verifies the collected epoch refs against the
 * bound anchor sinks, and reports the weakest vouching trust domain. Used
 * by the session-end verify hook; the CLI mirrors the fold in
 * `scripts/chain-read.mjs` (scripts spawn under plain node and cannot
 * import this module).
 */

import * as fs from "node:fs"
import * as path from "node:path"

import { foldChain } from "./chain.ts"
import type { ChainVerdict, EpochSummary, ParsedRow } from "./chain.ts"
import { verifyAnchors } from "./anchor.ts"
import type { AnchorRef, AnchorSink } from "./types.ts"

/** Options for a full-chain verify over a metrics directory. */
export interface VerifyOptions {
  /** The metrics directory holding the journal families. */
  metricsDir: string
  /** The bound anchor sinks to verify refs against. */
  sinks: readonly AnchorSink[]
}

/** The full verify report: per-family chain verdicts, per-ref anchor
 *  verdicts, and the weakest vouching trust domain (null when unanchored). */
export interface VerifyReport {
  /** True when every family folded ok and every ref is anchored ok. */
  ok: boolean
  /** Per-family chain verdicts, keyed by family label. */
  families: Array<{ source: string; verdict: ChainVerdict }>
  /** The epoch refs collected from the committed `chain-epoch` rows. */
  refs: AnchorRef[]
  /** Per-ref weakest vouching domain (null when unanchored). */
  weakest: Array<{ ref: AnchorRef; domain: string | null }>
}

/**
 * Lists a file family's generations oldest-first: the numbered generations
 * `.maxGenerations..1` that exist, then the current file (when present).
 * @param file The current file path.
 * @param maxGenerations The generation count convention (5 in this repo).
 * @returns The existing file paths, oldest-first.
 */
function familyFiles(file: string, maxGenerations: number): string[] {
  const files: string[] = []
  for (let gen = maxGenerations; gen >= 1; gen--) {
    if (fs.existsSync(`${file}.${gen}`)) files.push(`${file}.${gen}`)
  }
  if (fs.existsSync(file)) files.push(file)
  return files
}

/**
 * Reads one journal file into the fold's row shape, skipping malformed
 * lines (fail-open: a corrupt line is inert, not fatal).
 * @param file The file to read.
 * @returns The parsed rows, oldest-first.
 */
function readFamilyRows(file: string): ParsedRow[] {
  let text: string
  try {
    text = fs.readFileSync(file, "utf8")
  } catch {
    return []
  }
  const rows: ParsedRow[] = []
  for (const line of text.split("\n")) {
    if (line.trim() === "") continue
    try {
      const parsed = JSON.parse(line) as Record<string, unknown>
      if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) continue
      const { seq, prevHash, hash, ...payload } = parsed
      rows.push({
        ts: typeof payload["ts"] === "string" ? payload["ts"] : "",
        payload,
        seq,
        prevHash,
        hash,
      })
    } catch {
      // malformed line: skip, keep the rest
    }
  }
  return rows
}

/**
 * Folds one file family across its generations and collects the epoch refs
 * its committed `chain-epoch` rows carry.
 * @param source The family label.
 * @param files The family's files, oldest-first.
 * @returns The chain verdict plus the family's epoch refs.
 */
function foldFamily(source: string, files: string[]): { verdict: ChainVerdict; refs: AnchorRef[] } {
  const rows = files.flatMap((file) => readFamilyRows(file))
  const verdict = foldChain(rows, source)
  const refs: AnchorRef[] = []
  if (verdict.status === "ok") {
    for (const epoch of verdict.epochs) refs.push(epochRef(epoch))
  }
  return { verdict, refs }
}

/**
 * Converts an epoch summary into the publishable anchor ref shape.
 * @param epoch The epoch summary from the fold.
 * @returns The anchor ref (sink field empty until published).
 */
function epochRef(epoch: EpochSummary): AnchorRef {
  return {
    sink: "",
    source: epoch.source,
    epoch: epoch.epoch,
    root: epoch.root,
    head: epoch.head,
    ts: epoch.ts,
  }
}

/**
 * Runs the full verify over a metrics directory: every journal family
 * (shared + one per session sink) folds across its generations, the
 * committed epoch refs verify against the bound sinks, and the report
 * carries the weakest vouching trust domain. Read-only.
 * @param options The metrics dir and the bound sinks.
 * @returns The verify report.
 */
export async function verifyJournalChain(options: VerifyOptions): Promise<VerifyReport> {
  const journalPath = path.join(options.metricsDir, "turnstile.jsonl")
  const sessionsDir = path.join(options.metricsDir, "sessions")
  const families: Array<{ source: string; verdict: ChainVerdict }> = []
  const refs: AnchorRef[] = []
  const shared = foldFamily("shared", familyFiles(journalPath, 5))
  families.push({ source: "shared", verdict: shared.verdict })
  refs.push(...shared.refs)
  let sessionFiles: string[] = []
  try {
    sessionFiles = fs.readdirSync(sessionsDir).filter((f) => f.endsWith(".jsonl"))
  } catch {
    // no sessions dir: only the shared family exists
  }
  for (const file of sessionFiles) {
    const source = file.replace(/\.jsonl$/, "")
    const folded = foldFamily(source, familyFiles(path.join(sessionsDir, file), 5))
    families.push({ source, verdict: folded.verdict })
    refs.push(...folded.refs)
  }
  const chainOk = families.every((f) => f.verdict.status === "ok")
  const { weakest } = await verifyAnchors(options.sinks, refs)
  const anchorsOk = weakest.every((w) => w.domain !== null)
  return { ok: chainOk && anchorsOk, families, refs, weakest }
}
