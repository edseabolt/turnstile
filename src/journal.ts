/**
 * @fileoverview Telemetry boundary: JSONL journal and human-readable trace
 * persistence. A `Journaler` instance is created per plugin setup from the
 * resolved config and injected into the state, gate, and wiring layers,
 * so no module-level paths exist and tests can redirect all writes. Journaling is
 * fail-open by contract: no write ever breaks execution.
 */

import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"

import { merkleRoot, recordHash } from "./chain.ts"
import {
  appendLine,
  createJournalSinks,
  formatTraceLine,
  now,
  sessionJournalPath,
} from "./journal-sinks.ts"
import type { JournalSinks } from "./journal-sinks.ts"
import type { AnchorRef, AnchorSink } from "./types.ts"

export {
  REPLAY_SESSION_RE,
  appendLine,
  now,
  rotateIfLarge,
  sessionJournalPath,
} from "./journal-sinks.ts"

/**
 * Resolves the default metrics directory from an environment. Relative
 * `XDG_DATA_HOME` or `HOME` values are ignored: the XDG spec demands the
 * former be absolute, and this plugin's contract is that the resulting
 * path is never relative.
 * @param env Environment to consult; defaults to `process.env`.
 * @returns The absolute default metrics directory.
 */
export function defaultMetricsDir(env: Record<string, string | undefined> = process.env): string {
  const abs = (v: string | undefined): string | undefined =>
    v !== undefined && path.isAbsolute(v) ? v : undefined
  const home = abs(env.HOME) ?? os.homedir()
  const base = abs(env.XDG_DATA_HOME) ?? path.join(home, ".local/share")
  return path.join(base, "opencode", "metrics")
}

/** Default metrics directory, used only before config resolves (e.g. to
 * journal a malformed config file). */
export const DEFAULT_METRICS_DIR: string = defaultMetricsDir()

/** Default JSONL journal path inside {@link DEFAULT_METRICS_DIR}. */
export const DEFAULT_JOURNAL_PATH: string = path.join(DEFAULT_METRICS_DIR, "turnstile.jsonl")

/** One parsed journal entry (a JSON object line). */
export type JournalEntry = Record<string, unknown>

/**
 * Reads the current journal file and returns its parsed object entries,
 * oldest-first. Fail-open: any read or parse problem yields the entries
 * parsed so far (an unreadable or missing file yields []); a malformed
 * non-object line is skipped and the rest of the file still parses.
 * Rotation generations are NOT walked — only the current file is read — so
 * a count that straddles a rotation undercounts visibly in the summary
 * line, which is acceptable for a display-only surface (the reader feeds
 * the session-end summary; see `src/summary.ts`).
 * @param journalPath Absolute path of the current JSONL journal file.
 * @returns The parsed entries, oldest-first.
 */
export function readJournalEntries(journalPath: string): JournalEntry[] {
  let text: string
  try {
    text = fs.readFileSync(journalPath, "utf8")
  } catch {
    // missing or unreadable journal: nothing to count
    return []
  }
  const entries: JournalEntry[] = []
  for (const line of text.split("\n")) {
    if (line.trim() === "") continue
    try {
      const parsed: unknown = JSON.parse(line)
      // Plain objects only: arrays and JSON scalars are not entry shapes.
      if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
        entries.push(parsed as JournalEntry)
      }
    } catch {
      // malformed line: skip, keep the rest
    }
  }
  return entries
}

/** Telemetry writer injected into the state, gate, and wiring layers. */
export interface Journaler {
  /** Absolute path of the shared (legacy fallback) JSONL journal file. */
  journalPath: string
  /** Absolute path of the per-session journal directory. */
  sessionsDir: string
  /** Absolute path of the human-readable trace file. */
  tracePath: string
  /**
   * Resolves the journal file that owns a parent session's entries.
   * @param parentID The parent session ID (already sanitized by the caller
   *     when used as a file name).
   * @returns The absolute path `<sessionsDir>/<parentID>.jsonl`.
   */
  journalPathFor(parentID: string): string
  /**
   * Appends one structured entry to the JSONL journal, timestamped.
   * @param entry The journal entry; a `ts` field is prepended.
   */
  journal(entry: Record<string, unknown>): void
  /**
   * Appends one line to the trace file in the AGENTS.md trace contract
   * format (`YYYY-MM-DD HH:MM | agent | event | detail`). No-op when the
   * config disables the trace.
   * @param agent The acting agent label (e.g. `orchestrator`, `reviewer`).
   * @param event The event kind (e.g. `dispatch`, `gate`, `verdict`).
   * @param detail Free-form event detail, truncated to 200 characters.
   * @param sessionID Optional session ID; when provided it is appended as a
   *     trailing ` | <id>` segment after `detail`. Omitting it leaves the
   *     four documented segments (`ts | agent | event | detail`) byte-identical.
   */
  traceEvent(agent: string, event: string, detail: string, sessionID?: string): void
  /**
   * Binds the anchor sinks resolved at setup (called once, before hooks
   * register). Until bound, `anchor()` closes partial epochs but keeps the
   * refs pending; publish fires to whatever sinks are bound at that time.
   * @param sinks The resolved anchor sinks.
   */
  bindAnchorSinks(sinks: AnchorSink[]): void
  /**
   * Closes the current partial epoch on every journal family with
   * unanchored rows and fire-and-forget publishes all pending anchor refs
   * to the bound sinks. Fail-open: sink rejections journal
   * `{type:"error", error:"anchor-publish: …"}` and never throw. No-op when
   * tamper evidence is disabled.
   * @param trigger What fired the anchor (task completion or session end).
   * @param _sessionID The parent session ID, when known (reserved for
   *     per-session attribution; unused today).
   */
  anchor(trigger: "task-complete" | "session-end", _sessionID?: string): void
}

/** Per-file-family hash-chain state, the sibling of the tick counters. */
interface FamilyChain {
  /** Sequence number of the last appended row (0-based). */
  seq: number
  /** Hash of the last appended row ("" at a chain start). */
  prevHash: string
  /** 0-based index of the epoch currently accumulating. */
  epochIndex: number
  /** Data-row hashes accumulated in the current (possibly partial) epoch. */
  epochHashes: string[]
}

/**
 * Resolves the family label a journal file belongs to: `"shared"` for the
 * shared journal, the sanitized parent session ID for a session sink
 * (matching `sinkFor`'s routing).
 * @param sinks The sink capability (names the shared journal path).
 * @param file The resolved journal file path.
 * @returns The family label.
 */
function familyLabel(sinks: JournalSinks, file: string): string {
  if (file === sinks.journalPath) return "shared"
  return path.basename(file).replace(/\.jsonl$/, "")
}

/**
 * Appends one chained row to `file`: computes the record hash over the
 * canonical payload, appends the row with the chain fields last, and
 * advances the chain state. The caller decides epoch bookkeeping.
 * @param file The journal file to append to.
 * @param ts The row timestamp.
 * @param payload The row payload (`ts` included, chain fields excluded).
 * @param chain The family's chain state (mutated in place).
 * @returns The appended row's hash.
 */
function appendChainedRow(
  file: string,
  ts: string,
  payload: Record<string, unknown>,
  chain: FamilyChain,
): string {
  const hash = recordHash(chain.prevHash, ts, payload)
  appendLine(file, JSON.stringify({ ...payload, seq: chain.seq, prevHash: chain.prevHash, hash }))
  chain.seq++
  chain.prevHash = hash
  return hash
}

/**
 * Closes the current epoch on a family: appends a chained `chain-epoch`
 * row carrying the Merkle root and head, records the pending anchor ref,
 * and resets the epoch window (the epoch row itself is chained but is not
 * a data row of the next epoch).
 * @param sinks The sink capability (family label).
 * @param file The journal file the epoch closed on.
 * @param chain The family's chain state (mutated in place).
 * @param pendingRefs The pending anchor-ref list (appended to).
 */
function closeEpoch(
  sinks: JournalSinks,
  file: string,
  chain: FamilyChain,
  pendingRefs: AnchorRef[],
): void {
  const ts = now()
  const count = chain.epochHashes.length
  const root = merkleRoot(chain.epochHashes)
  const head = chain.epochHashes[count - 1]!
  const source = familyLabel(sinks, file)
  const epochRow = {
    type: "chain-epoch",
    source,
    epoch: chain.epochIndex,
    count,
    root,
    head,
    ts,
  }
  appendChainedRow(file, ts, epochRow, chain)
  pendingRefs.push({ sink: "", source, epoch: chain.epochIndex, root, head, ts })
  chain.epochIndex++
  chain.epochHashes = []
}

/**
 * Seeds one family's chain state from its on-disk rows: walks the family's
 * rotation generations oldest-first (then the current file) and continues
 * `seq`/`prevHash` from the last chained row, recovering the epoch window
 * (data-row hashes after the last `chain-epoch` row) and the epoch index so
 * a journaler created after a host restart keeps the chain continuous.
 * Missing or unreadable files contribute nothing; rows without a `hash`
 * field (legacy unchained rows) are inert.
 * @param file The family's current journal file path.
 * @param maxGenerations The rotation generation count convention.
 * @returns The seeded chain state (fresh when no chained rows exist).
 */
function seedFamilyChain(file: string, maxGenerations: number): FamilyChain {
  const chain: FamilyChain = { seq: 0, prevHash: "", epochIndex: 0, epochHashes: [] }
  for (let gen = maxGenerations; gen >= 1; gen--) seedFromFile(chain, `${file}.${gen}`)
  seedFromFile(chain, file)
  return chain
}

/**
 * Folds one generation file's chained rows into the seeding chain state.
 * @param chain The chain state being seeded (mutated in place).
 * @param file The generation file to read (missing/unreadable: no-op).
 */
function seedFromFile(chain: FamilyChain, file: string): void {
  let text: string
  try {
    text = fs.readFileSync(file, "utf8")
  } catch {
    return
  }
  for (const line of text.split("\n")) {
    if (line.trim() === "") continue
    try {
      const row = JSON.parse(line) as Record<string, unknown>
      if (typeof row["hash"] !== "string") continue
      if (typeof row["seq"] === "number") chain.seq = row.seq + 1
      chain.prevHash = row["hash"]
      if (row["type"] === "chain-epoch") {
        chain.epochIndex++
        chain.epochHashes = []
      } else {
        chain.epochHashes.push(row["hash"])
      }
    } catch {
      // malformed line: skip, keep the rest
    }
  }
}

/**
 * Appends one entry under tamper evidence: chains the row, accumulates the
 * epoch, and closes the epoch when the configured cadence is reached. The
 * family's chain state is seeded lazily on first write (scanning the
 * existing rows) so a restarted host continues the chain instead of
 * forking it.
 * @param sinks The sink capability.
 * @param chains The per-file chain states (created on first write).
 * @param pendingRefs The pending anchor-ref list (appended to).
 * @param file The resolved journal file.
 * @param entry The journal entry; a `ts` field is prepended and any
 *     entry-supplied `ts` is overridden so the hashed timestamp is the row's.
 * @param epochEntries Data rows per Merkle epoch.
 * @param maxGenerations The rotation generation count (for chain seeding).
 */
function appendChainedEntry(
  sinks: JournalSinks,
  chains: Map<string, FamilyChain>,
  pendingRefs: AnchorRef[],
  file: string,
  entry: Record<string, unknown>,
  epochEntries: number,
  maxGenerations: number,
): void {
  let chain = chains.get(file)
  if (!chain) {
    chain = seedFamilyChain(file, maxGenerations)
    chains.set(file, chain)
  }
  const ts = now()
  const hash = appendChainedRow(file, ts, { ...entry, ts }, chain)
  chain.epochHashes.push(hash)
  if (chain.epochHashes.length >= epochEntries) closeEpoch(sinks, file, chain, pendingRefs)
}

/**
 * Fire-and-forget publishes the pending anchor refs to the bound sinks.
 * Every rejection (sync or async) journals an `anchor-publish:` error row
 * and never propagates; the refs are consumed either way.
 * @param pendingRefs The pending anchor-ref list (consumed).
 * @param boundSinks The currently bound anchor sinks.
 * @param journal The journaler's append (for fail-open error rows).
 */
function publishPendingRefs(
  pendingRefs: AnchorRef[],
  boundSinks: readonly AnchorSink[],
  journal: (entry: Record<string, unknown>) => void,
): void {
  if (pendingRefs.length === 0 || boundSinks.length === 0) return
  const refs = pendingRefs.splice(0)
  for (const ref of refs) {
    for (const sink of boundSinks) {
      Promise.resolve()
        .then(() => sink.publish({ ...ref, sink: sink.id }))
        .catch((e: unknown) => {
          journal({ type: "error", error: `anchor-publish: ${sink.id}: ${String(e)}` })
        })
    }
  }
}

/**
 * Appends one timestamped journal entry to its owning sink and runs the
 * rotation tick for that file, managing the per-file tick counter (created
 * on first write; keyed by resolved file path). Under tamper evidence the
 * row is chained and epoch bookkeeping runs; without it the row bytes are
 * the legacy unchained shape.
 * @param sinks The sink capability (sink resolution + rotation).
 * @param journalTicks The per-file tick counters, mutated in place.
 * @param chains The per-file chain states, mutated in place.
 * @param pendingRefs The pending anchor-ref list, mutated in place.
 * @param tamper The tamper-evidence options (enabled + epoch cadence).
 * @param entry The journal entry; a `ts` field is prepended.
 */
function writeJournalEntry(
  sinks: JournalSinks,
  journalTicks: Map<string, { n: number }>,
  chains: Map<string, FamilyChain>,
  pendingRefs: AnchorRef[],
  tamper: { enabled: boolean; epochEntries: number } | undefined,
  maxGenerations: number,
  entry: Record<string, unknown>,
): void {
  const file = sinks.sinkFor(entry)
  if (tamper?.enabled) {
    appendChainedEntry(sinks, chains, pendingRefs, file, entry, tamper.epochEntries, maxGenerations)
  } else {
    appendLine(file, JSON.stringify({ ts: now(), ...entry }))
  }
  let tick = journalTicks.get(file)
  if (!tick) {
    tick = { n: 0 }
    journalTicks.set(file, tick)
  }
  sinks.tickRotate(file, tick)
}

/**
 * Creates a telemetry writer bound to the given metrics directory.
 * @param options.metricsDir Directory that receives both telemetry files.
 * @param options.trace Whether trace lines are written (journal always is).
 * @param options.maxBytes Rotation threshold per journal file.
 * @param options.maxGenerations Rotated generations kept per journal file.
 * @param options.rotateEveryEntries Hot path is append-only; the size check
 *     and rotation run once per this many appends (documented in the
 *     rotation-bound comment above). Entries between the check and the
 *     rename are the bounded overshoot.
 * @param options.perSession When true, entries carrying a resolvable parent
 *     sessionID route to `sessions/<parentID>.jsonl`; everything else stays
 *     on the shared `turnstile.jsonl`. Default false (single-file layout).
 * @param options.sinkFor Resolves the parent sessionID whose file owns an
 *     entry, or `""` for the shared sink. Consulted only when `perSession`
 *     is on and the entry carries a string `sessionID`. Bound late by the
 *     wiring (the ledger is built after the journaler).
 * @param options.tamper Tamper-evidence options: when `enabled`, every row
 *     is chained (`seq`/`prevHash`/`hash` appended last) and a chained
 *     `chain-epoch` Merkle row commits every `epochEntries` data rows per
 *     file family. Omitted or `enabled: false` restores the legacy
 *     unchained row shape.
 * @returns A Journaler writing `turnstile.jsonl` (and, when `perSession` is
 *     on, `sessions/<parentID>.jsonl`) plus `gate-events.log` under
 *     `options.metricsDir`.
 */
export function createJournaler(options: {
  metricsDir: string
  trace: boolean
  maxBytes: number
  maxGenerations: number
  rotateEveryEntries: number
  perSession?: boolean
  sinkFor?: (sessionID: string) => string
  tamper?: { enabled: boolean; epochEntries: number }
}): Journaler {
  const sinks = createJournalSinks(options)
  // Counters per file, never shared: the journal, each session sink, and the
  // trace file each rotate on their own schedule (a trace-off journal still
  // counts its own ticks). Keyed by resolved file path; bounded by the live
  // session count plus the two fixed sinks.
  const journalTicks = new Map<string, { n: number }>()
  const traceTick = { n: 0 }
  // Per-file hash-chain state and the pending anchor refs, both meaningful
  // only when tamper evidence is enabled.
  const chains = new Map<string, FamilyChain>()
  const pendingRefs: AnchorRef[] = []
  let boundSinks: AnchorSink[] = []
  return {
    journalPath: sinks.journalPath,
    sessionsDir: sinks.sessionsDir,
    tracePath: sinks.tracePath,
    journalPathFor(parentID: string): string {
      return sessionJournalPath(options.metricsDir, parentID)
    },
    journal(entry: Record<string, unknown>): void {
      writeJournalEntry(
        sinks,
        journalTicks,
        chains,
        pendingRefs,
        options.tamper,
        options.maxGenerations,
        entry,
      )
    },
    bindAnchorSinks(sinks_: AnchorSink[]): void {
      boundSinks = sinks_
    },
    anchor(_trigger: "task-complete" | "session-end", _sessionID?: string): void {
      if (!options.tamper?.enabled) return
      // Close every family's partial epoch so no data rows stay unanchored.
      for (const [file, chain] of chains) {
        if (chain.epochHashes.length > 0) closeEpoch(sinks, file, chain, pendingRefs)
      }
      publishPendingRefs(pendingRefs, boundSinks, (e) => this.journal(e))
    },
    traceEvent(agent: string, event: string, detail: string, sessionID?: string): void {
      if (!options.trace) return
      appendLine(sinks.tracePath, formatTraceLine(agent, event, detail, sessionID))
      // The trace file shares the journal's rotation bound (AGENTS.md
      // retention contract: bounded at (N + 1) × maxBytes per file).
      sinks.tickRotate(sinks.tracePath, traceTick)
    },
  }
}
