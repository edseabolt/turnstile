/**
 * @fileoverview Journal-persistence boundary: the append/rotate primitives
 * (`appendLine`, `rotateIfLarge`, `now`), the session-ID shape rule, the
 * per-file sink resolution, rotation locking, and trace-line formatting
 * behind `createJournaler` in `src/journal.ts`. Extracted so the journaler
 * factory stays a thin composition over one persistence boundary; every
 * write remains fail-open by contract.
 */

import * as fs from "node:fs"
import * as path from "node:path"
import * as zlib from "node:zlib"

import { withFileLock } from "./lockfile.ts"

/**
 * Host session-ID alphabet, length-capped: the only shapes that may name a
 * per-session journal file (and the only shapes replay accepts as bucket
 * keys). Anything else is hostile bytes, not a session. Canonical export:
 * both the journal sink routing and the ledger replay validate against this
 * one rule.
 */
export const REPLAY_SESSION_RE = /^[A-Za-z0-9._-]{1,64}$/

/**
 * Returns the current time as an ISO-8601 timestamp.
 * @returns The current UTC timestamp, e.g. `2026-10-08T12:00:00.000Z`.
 */
export function now(): string {
  return new Date().toISOString()
}

/**
 * Rotates a journal file when it grows past the size limit, keeping at
 * most `maxGenerations` numbered generations. When `archiveGenerations` is
 * positive, the outgoing final generation is gzip-archived before the prune.
 * Silent on any failure.
 * @param file Path of the journal file to check and rotate.
 * @param maxBytes Rotation threshold in bytes.
 * @param maxGenerations Number of numbered generations to keep.
 * @param archiveGenerations Archived generations kept per family; 0 = off.
 */
export function rotateIfLarge(
  file: string,
  maxBytes: number,
  maxGenerations: number,
  archiveGenerations: number,
): void {
  try {
    const stat = fs.statSync(file)
    if (stat.size <= maxBytes) return
    // prune the oldest generation first so the shift below has a free slot
    const oldest = `${file}.${maxGenerations}`
    if (archiveGenerations > 0) archiveGeneration(oldest, archiveGenerations)
    try {
      fs.unlinkSync(oldest)
    } catch {
      // no generation at the limit yet; nothing to prune
    }
    for (let gen = maxGenerations - 1; gen >= 1; gen--) {
      try {
        fs.renameSync(`${file}.${gen}`, `${file}.${gen + 1}`)
      } catch {
        // missing generation: skip; lower generations still shift correctly
      }
    }
    fs.renameSync(file, `${file}.1`)
  } catch {
    // missing file or stat failure: nothing to rotate
  }
}

/**
 * Lists a family's existing archive files oldest-first.
 * @param archiveDir The family's `archive/` directory.
 * @param prefix The archive-name prefix (the journal file's basename).
 * @returns The matching `.gz` paths, lexicographically sorted.
 */
function listArchives(archiveDir: string, prefix: string): string[] {
  return fs
    .readdirSync(archiveDir)
    .filter((name) => name.startsWith(`${prefix}.`) && name.endsWith(".gz"))
    .sort()
    .map((name) => path.join(archiveDir, name))
}

/**
 * Prunes the oldest archives beyond the keep bound for one family.
 * @param archiveDir The family's `archive/` directory.
 * @param prefix The archive-name prefix (the journal file's basename).
 * @param keep Maximum number of archives to retain.
 */
function pruneArchives(archiveDir: string, prefix: string, keep: number): void {
  const archives = listArchives(archiveDir, prefix)
  for (const stale of archives.slice(0, Math.max(0, archives.length - keep))) {
    try {
      fs.unlinkSync(stale)
    } catch {
      // already gone: nothing to prune
    }
  }
}

/**
 * Gzip-archives one outgoing generation into `<dir>/archive/` next to its
 * journal, then prunes archives beyond the keep bound. The archive name
 * embeds a zero-padded epoch-ms timestamp plus a collision-bumped sequence
 * (`-001`, `-002`, … within one millisecond), so lexicographic order equals
 * chronological order and no archive is ever silently overwritten. Runs
 * under the caller's rotation lock. Silent on any failure: an archive
 * problem never breaks rotation or journaling.
 * @param gen Path of the outgoing generation file.
 * @param keep Maximum number of archives to retain for the family.
 */
function archiveGeneration(gen: string, keep: number): void {
  try {
    const text = fs.readFileSync(gen, "utf8")
    const dir = path.join(path.dirname(gen), "archive")
    const base = path.basename(gen)
    fs.mkdirSync(dir, { recursive: true })
    const ts = String(Date.now()).padStart(15, "0")
    let seq = 0
    let target = path.join(dir, `${base}.${ts}-${String(seq).padStart(3, "0")}.gz`)
    while (fs.existsSync(target)) {
      seq++
      target = path.join(dir, `${base}.${ts}-${String(seq).padStart(3, "0")}.gz`)
    }
    fs.writeFileSync(target, zlib.gzipSync(text))
    pruneArchives(dir, base, keep)
  } catch {
    // archiving must never break rotation
  }
}

/**
 * Repairs a torn tail before appending: a crash mid-append can leave the
 * file's last line without a trailing newline, and appending directly would
 * concatenate the next row onto it (an unparseable merged line that breaks
 * the chain fold forever). One `\n` separates the partial line — it stays
 * as an inert row the fold and chain seeding already skip (malformed JSON
 * or a row without a `hash` field).
 * @param file The file to inspect and repair.
 */
function repairTornTail(file: string): void {
  let fd: number
  try {
    fd = fs.openSync(file, "r")
  } catch {
    return // missing file: nothing to repair
  }
  try {
    const size = fs.fstatSync(fd).size
    if (size === 0) return
    const last = Buffer.alloc(1)
    fs.readSync(fd, last, 0, 1, size - 1)
    if (last[0] !== 0x0a) fs.appendFileSync(file, "\n")
  } finally {
    fs.closeSync(fd)
  }
}

/** Directories this process has already ensured exist (per-process memo:
 * mkdir is an open-time cost, not a per-row cost). Invalidated by the
 * retry-once path when an append fails. */
const ensuredDirs = new Set<string>()
/** Journal files this process has already torn-tail-repaired (the first
 * write by this process; a torn tail can only be left by a prior
 * process's crash, which the next process's first write repairs). */
const repairedFiles = new Set<string>()

/**
 * Creates the parent directory for a journal file, at most once per
 * directory per process.
 * @param dir The directory to ensure exists.
 */
function ensureDirOnce(dir: string): void {
  if (ensuredDirs.has(dir)) return
  fs.mkdirSync(dir, { recursive: true })
  ensuredDirs.add(dir)
}

/**
 * Runs the torn-tail repair for a journal file, at most once per file per
 * process (the first write by this process).
 * @param file The file to repair before its first append in this process.
 */
function repairOnce(file: string): void {
  if (repairedFiles.has(file)) return
  repairTornTail(file)
  repairedFiles.add(file)
}

/**
 * Appends one line to a file, creating the parent directory once per process
 * and running the torn-tail repair once per file per process (a torn tail can
 * only be left by a prior process's crash, which the next process's first
 * write repairs); a failed append drops both memos for the path and retries
 * once. The caller is still responsible for rotating when a size bound applies
 * (the journaler's `journal()`/`traceEvent()` call `tickRotate` on an
 * entry-count tick, under a lock-guarded rename). A torn final line (no
 * trailing newline, left by a crash mid-append) is separated with one `\n`
 * first so the new line always parses on its own. Silent on any failure:
 * journaling must never break execution.
 * @param file Path of the file to append to.
 * @param text The line to append (a trailing newline is added).
 */
export function appendLine(file: string, text: string): void {
  if (tryAppend(file, text)) return
  // A failure usually means a memo is stale (the directory was removed
  // mid-session). Drop the memos for this path and retry exactly once.
  ensuredDirs.delete(path.dirname(file))
  repairedFiles.delete(file)
  tryAppend(file, text)
}

/**
 * Performs one append attempt with the memoized directory-ensure and
 * torn-tail repair, swallowing any I/O error.
 * @param file Path of the file to append to.
 * @param text The line to append (a trailing newline is added).
 * @returns True when the append succeeded.
 */
function tryAppend(file: string, text: string): boolean {
  try {
    ensureDirOnce(path.dirname(file))
    repairOnce(file)
    fs.appendFileSync(file, text + "\n")
    return true
  } catch {
    return false // journaling must never break execution
  }
}

export { repairTornTail }

/**
 * Resolves the per-session journal file for a parent session ID.
 * @param metricsDir The metrics directory.
 * @param parentID The parent session ID.
 * @returns The absolute path `<metricsDir>/sessions/<parentID>.jsonl`.
 */
export function sessionJournalPath(metricsDir: string, parentID: string): string {
  return path.join(metricsDir, "sessions", `${parentID}.jsonl`)
}

/** A created `<file>.lock` older than this cannot be held by a live
 *  rotation (the hold spans one stat + at most maxGenerations renames):
 *  it marks a crashed process. Steal it. */
const ROTATION_LOCK_STALE_MS = 60_000

/** Options accepted by `createJournaler`, threaded into the sink helpers. */
export interface JournalSinksOptions {
  /** Directory that receives both telemetry files. */
  metricsDir: string
  /** Whether trace lines are written (journal always is). */
  trace: boolean
  /** Rotation threshold per journal file. */
  maxBytes: number
  /** Rotated generations kept per journal file. */
  maxGenerations: number
  /** Archived generations kept per family in the sibling `archive/`
   *  directory; 0 = off. Threaded from config (`journalArchiveGenerations`,
   *  default 5) — no fallback here, so a missing thread is a type error. */
  archiveGenerations: number
  /** Hot path is append-only; the size check and rotation run once per this
   *  many appends. Entries between the check and the rename are the bounded
   *  overshoot. */
  rotateEveryEntries: number
  /** When true, entries carrying a resolvable parent sessionID route to
   *  `sessions/<parentID>.jsonl`; everything else stays on the shared
   *  `turnstile.jsonl`. */
  perSession?: boolean
  /** Resolves the parent sessionID whose file owns an entry, or `""` for the
   *  shared sink. Bound late by the wiring (the ledger is built after the
   *  journaler). */
  sinkFor?: (sessionID: string) => string
}

/** The sink capability `createJournaler` composes over. */
export interface JournalSinks {
  /** Absolute path of the shared (legacy fallback) JSONL journal file. */
  journalPath: string
  /** Absolute path of the per-session journal directory. */
  sessionsDir: string
  /** Absolute path of the human-readable trace file. */
  tracePath: string
  /** Resolves the sink file that owns one journal entry. */
  sinkFor(entry: Record<string, unknown>): string
  /** Rotates `file` once per `rotateEveryEntries` writes. */
  tickRotate(file: string, counter: { n: number }): void
}

/**
 * Resolves the sink file that owns one journal entry: the parent session's
 * file when per-session segmentation is on, the entry carries a string
 * `sessionID`, the resolver yields a parent, and that parent passes the
 * session-ID shape rule; the shared file otherwise.
 * @param options The journaler options (segmentation + resolver).
 * @param journalPath The shared journal file path (the fallback sink).
 * @param entry The journal entry about to be appended.
 * @returns The absolute path of the owning journal file.
 */
function sinkFor(
  options: JournalSinksOptions,
  journalPath: string,
  entry: Record<string, unknown>,
): string {
  const sessionID = entry.sessionID
  if (!options.perSession || typeof sessionID !== "string") return journalPath
  const parent = options.sinkFor?.(sessionID) ?? ""
  if (parent === "" || !REPLAY_SESSION_RE.test(parent)) return journalPath
  return sessionJournalPath(options.metricsDir, parent)
}

/**
 * Rotates `file` once per `rotateEveryEntries` writes, under a created
 * `<file>.lock` directory that is an atomic mutex (mkdir fails with EEXIST
 * while another session holds it) so concurrent sessions never both rename
 * the shared file. The lock protocol is the shared `withFileLock` boundary:
 * a single attempt (`timeoutMs: 0` — a fresh contention is a silent skip,
 * not a retry), a stale lock — its mtime past the staleness bound, proving
 * its creator crashed — stolen once (journaled as a `rotation-lock-stale:`
 * error entry via the steal seam, before the rotation rename so the row
 * lands in the rotated generation). Non-EEXIST mkdir errors and steal-path
 * throws degrade to `{held:false}` inside the boundary, which skips the
 * tick. The error row always lands on the shared journal file, even when
 * the contended file is a session sink (one fixed audit location for
 * rotation errors). Fail-open: a failed release or any lock-state error
 * never propagates out of `journal()`. The per-write hot path never calls
 * this past the counter gate.
 * @param options The journaler options (rotation bounds).
 * @param journalPath The shared journal file path (the error row's sink).
 * @param file Path of the file to rotate.
 * @param counter A per-file `{ n }` counter; callers pass one bound here.
 */
function tickRotate(
  options: JournalSinksOptions,
  journalPath: string,
  file: string,
  counter: { n: number },
): void {
  if (++counter.n < options.rotateEveryEntries) return
  counter.n = 0
  withFileLock(
    file,
    {
      timeoutMs: 0,
      staleMs: ROTATION_LOCK_STALE_MS,
      onStaleSteal: () =>
        appendLine(
          journalPath,
          JSON.stringify({ ts: now(), type: "error", error: `rotation-lock-stale: ${file}` }),
        ),
    },
    () => rotateIfLarge(file, options.maxBytes, options.maxGenerations, options.archiveGenerations),
  )
}

/**
 * Formats one trace line in the AGENTS.md trace contract format
 * (`YYYY-MM-DD HH:MM | agent | event | detail`).
 * @param agent The acting agent label (e.g. `orchestrator`, `reviewer`).
 * @param event The event kind (e.g. `dispatch`, `gate`, `verdict`).
 * @param detail Free-form event detail, truncated to 200 characters.
 * @param sessionID Optional session ID; when provided it is appended as a
 *     trailing ` | <id>` segment after `detail`. Omitting it leaves the
 *     four documented segments (`ts | agent | event | detail`) byte-identical.
 * @returns The formatted trace line (no trailing newline).
 */
function formatTraceLine(agent: string, event: string, detail: string, sessionID?: string): string {
  const d = new Date()
  const pad = (n: number): string => String(n).padStart(2, "0")
  // The session segment is optional and appended last; the first four
  // segments (ts | agent | event | detail) stay byte-identical for every
  // existing `split("|")` consumer when it is omitted.
  const tail = sessionID ? ` | ${sessionID}` : ""
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())} | ${agent} | ${event} | ${String(detail).slice(0, 200)}${tail}`
}

/**
 * Builds the journal sink capability: the three fixed paths plus the sink
 * resolution, rotation locking, and tick cadence the journaler's write
 * methods delegate to.
 * @param options The journaler options (paths, rotation bounds, segmentation).
 * @returns The sink capability bound to the given options.
 */
export function createJournalSinks(options: JournalSinksOptions): JournalSinks {
  const journalPath = path.join(options.metricsDir, "turnstile.jsonl")
  const sessionsDir = path.join(options.metricsDir, "sessions")
  const tracePath = path.join(options.metricsDir, "gate-events.log")
  return {
    journalPath,
    sessionsDir,
    tracePath,
    sinkFor: (entry) => sinkFor(options, journalPath, entry),
    tickRotate: (file, counter) => tickRotate(options, journalPath, file, counter),
  }
}

export { formatTraceLine }
