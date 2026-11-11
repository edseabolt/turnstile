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

/** The generation count used when a verify caller does not thread one:
 *  matches the `journalMaxGenerations` default in `defaultConfig()`. */
const DEFAULT_MAX_GENERATIONS = 5

/** Options for a full-chain verify over a metrics directory. */
export interface VerifyOptions {
  /** The metrics directory holding the journal families. */
  metricsDir: string
  /** The bound anchor sinks to verify refs against. */
  sinks: readonly AnchorSink[]
  /** The rotation generation count convention (`journalMaxGenerations`);
   *  defaults to 5 when unset. Must match the journaler's setting or an
   *  intact journal folds as broken. */
  maxGenerations?: number
}

/** The full verify report: per-family chain verdicts, per-ref anchor
 *  verdicts, the weakest vouching trust domain (null when unanchored), and
 *  any anchored epoch the surviving journal no longer contains. */
export interface VerifyReport {
  /** True when every family folded ok, every ref is anchored ok, and no
   *  anchored epoch is absent from the journal. */
  ok: boolean
  /** Per-family chain verdicts, keyed by family label. */
  families: Array<{ source: string; verdict: ChainVerdict }>
  /** The epoch refs collected from the committed `chain-epoch` rows. */
  refs: AnchorRef[]
  /** Per-ref weakest vouching domain (null when unanchored). */
  weakest: Array<{ ref: AnchorRef; domain: string | null }>
  /** One detail per anchored ref whose epoch is absent from the journal. */
  absentAnchored: string[]
}

/**
 * Lists a file family's generations oldest-first: the numbered generations
 * `.maxGenerations..1` that exist, then the current file (when present).
 * Also reports whether the family folds with a trust root: the oldest
 * surviving file is a numbered generation other than `.1` only when the
 * journaler pruned, so its first chained row continues a chain whose
 * earlier generations no longer exist.
 * @param file The current file path.
 * @param maxGenerations The generation count convention (5 in this repo).
 * @returns The existing file paths oldest-first plus the trust-root flag.
 */
function familyFiles(
  file: string,
  maxGenerations: number,
): { files: string[]; chainRootAtStart: boolean } {
  const files: string[] = []
  for (let gen = maxGenerations; gen >= 1; gen--) {
    if (fs.existsSync(`${file}.${gen}`)) files.push(`${file}.${gen}`)
  }
  if (fs.existsSync(file)) files.push(file)
  const oldest = files[0]
  const chainRootAtStart = oldest !== undefined && oldest !== file && oldest !== `${file}.1`
  return { files, chainRootAtStart }
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
 * @param family The family's files oldest-first plus the trust-root flag.
 * @returns The chain verdict plus the family's epoch refs.
 */
function foldFamily(
  source: string,
  family: { files: string[]; chainRootAtStart: boolean },
): { verdict: ChainVerdict; refs: AnchorRef[] } {
  const rows = family.files.flatMap((file) => readFamilyRows(file))
  const verdict = foldChain(rows, source, { chainRootAtStart: family.chainRootAtStart })
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
 * Reads the session-state anchor store (`<metricsDir>/anchors.jsonl`) and
 * returns the refs it names. Fail-open: a missing or malformed file yields
 * no anchored refs (the cross-check then finds nothing absent).
 * @param metricsDir The metrics directory hosting the anchor store.
 * @returns The anchored refs, oldest-first.
 */
function readAnchoredRefs(metricsDir: string): AnchorRef[] {
  try {
    return fs
      .readFileSync(path.join(metricsDir, "anchors.jsonl"), "utf8")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as AnchorRef)
  } catch {
    return []
  }
}

/**
 * Names the anchored refs the surviving journal positively fails to vouch
 * for. The committed root is the identity that survives rotation: an
 * anchored ref is satisfied when a retained epoch carries its root, or when
 * its epoch index lies below the family's lowest retained index (that
 * generation was pruned, so absence is undetectable). It is reported absent
 * only when the root matches nothing AND the index is at or above the
 * lowest retained index — a gap within, or truncation of, retained history.
 * @param metricsDir The metrics directory hosting the anchor store.
 * @param refs The epoch refs collected from the journal's chain-epoch rows.
 * @returns One detail string per absent anchored epoch.
 */
function absentAnchoredRefs(metricsDir: string, refs: readonly AnchorRef[]): string[] {
  const roots = new Set(refs.map((r) => r.root))
  const retained = new Set(refs.map((r) => `${r.source}#${r.epoch}`))
  const lowest = new Map<string, number>()
  for (const r of refs) {
    const cur = lowest.get(r.source)
    if (cur === undefined || r.epoch < cur) lowest.set(r.source, r.epoch)
  }
  return readAnchoredRefs(metricsDir)
    .filter((a) => {
      if (roots.has(a.root)) return false
      // No retained epoch for the source at all: any anchored index is a
      // positive mismatch (the same signal as whole-journal deletion).
      return a.epoch >= (lowest.get(a.source) ?? 0)
    })
    .map((a) =>
      retained.has(`${a.source}#${a.epoch}`)
        ? `anchored epoch ${a.source}#${a.epoch} root mismatch (reforged commit?)`
        : `anchored epoch ${a.source}#${a.epoch} absent from journal`,
    )
}

/**
 * Runs the full verify over a metrics directory: every journal family
 * (shared + one per session sink) folds across its generations, the
 * committed epoch refs verify against the bound sinks, and the report
 * carries the weakest vouching trust domain plus any anchored epoch the
 * journal no longer contains. Read-only.
 * @param options The metrics dir, the bound sinks, and the generation count.
 * @returns The verify report.
 */
export async function verifyJournalChain(options: VerifyOptions): Promise<VerifyReport> {
  const maxGenerations = options.maxGenerations ?? DEFAULT_MAX_GENERATIONS
  const journalPath = path.join(options.metricsDir, "turnstile.jsonl")
  const sessionsDir = path.join(options.metricsDir, "sessions")
  const families: Array<{ source: string; verdict: ChainVerdict }> = []
  const refs: AnchorRef[] = []
  const sharedFam = familyFiles(journalPath, maxGenerations)
  const shared = foldFamily("shared", sharedFam)
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
    const fam = familyFiles(path.join(sessionsDir, file), maxGenerations)
    const folded = foldFamily(source, fam)
    families.push({ source, verdict: folded.verdict })
    refs.push(...folded.refs)
  }
  const chainOk = families.every((f) => f.verdict.status === "ok")
  const { weakest } = await verifyAnchors(options.sinks, refs)
  const anchorsOk = weakest.every((w) => w.domain !== null)
  const absentAnchored = absentAnchoredRefs(options.metricsDir, refs)
  return {
    ok: chainOk && anchorsOk && absentAnchored.length === 0,
    families,
    refs,
    weakest,
    absentAnchored,
  }
}
