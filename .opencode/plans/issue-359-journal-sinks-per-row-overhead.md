# Objective

Fix GitHub issue #359: remove the per-row filesystem overhead in the JSONL journal hot path. Every `appendLine` call currently pays a `mkdirSync(recursive)` plus a full torn-tail repair (open / fstat / 1-byte read / close, and possibly a second append) before the actual append. Both are amortizable: the directory only needs creating once per process, and the torn-tail repair only matters on the first write this process makes to a file (a torn tail can only be left by a prior process that crashed mid-append; this process's own writes are single `appendFileSync` calls, and the *next* process's first write repairs any tail this process leaves when it crashes).

Scope constraint (Ed): do NOT plan or implement anything from issue #363 (sqlite sink). This is a standalone jsonl-path fix.

# Requirements

- R1: `appendLine` (`src/journal-sinks.ts:173-181`) must not run `mkdirSync` on every row — once per directory per process suffices.
- R2: `appendLine` must not run `repairTornTail` on every row — once per file per process suffices (first write in this process).
- R3: Fail-open contract preserved: journaling never throws; a row lost to an I/O error is swallowed.
- R4: Zero runtime dependencies; functions ≤20–30 lines; Google-standard JSDoc; DRY; erasable TypeScript.
- R5: `repairTornTail` stays exported (consumed by `src/anchor.ts:16,95` and asserted in `tests/export-shape.test.ts:318`).
- R6: 100% line/branch/function coverage over the new branches via `npm test`.
- R7: No behavior change visible to replay/verify/chain consumers: on-disk format, rotation, and repair semantics unchanged.

Assumptions:
- "Once per file per process" is an acceptable approximation of the issue's "only when the previous write was by a prior process": within one process, a torn tail after the first write can only be self-inflicted by a crash, and the repairing writer is by definition the next process. No pid/epoch stamping in the file format is needed.
- The mid-session directory-deletion edge (metricsDir removed under a live session) is worth a cheap retry-once path rather than permanent silent row loss.

# Existing Architecture

- `src/journal-sinks.ts` is the journal-persistence boundary. `appendLine(file, text)` at :173-181 does, per call: `fs.mkdirSync(path.dirname(file), { recursive: true })` (:175) → `repairTornTail(file)` (:176) → `fs.appendFileSync(file, text + "\n")` (:177), all inside one try/catch that swallows everything.
- `repairTornTail(file)` (:144-160, exported at :183): opens the file read-only, fstats, reads the last byte, appends `"\n"` if it is not `0x0a`. Missing file → early return. Also called directly by `src/anchor.ts:95` before the session-state sink's append (anchor publishes are rare — out of scope; the shared helper is reused unchanged).
- `appendLine` is a module-level free function called from many boundaries (`src/journal.ts:217,458,592,702`, `src/ledger.ts:603,1247,1250,1585,2380,2486`, `src/ledger-registry.ts:125`, `src/config.ts:385`, and `journal-sinks.ts:299`). There is no per-sink object to hang open-time state on, so amortization state must be module-level memoization keyed by directory / file path.
- Rotation (`tickRotate`) already runs on an entry-count tick, not per row — the same amortization pattern this fix applies to mkdir/repair.
- Docs: `docs/journal/*` and `docs/architecture/persistence.md` do not describe per-write mkdir or per-write repair anywhere (grep verified), so no doc-sync trigger fires.

# Approaches Considered

1. **Module-level memo Sets (recommended).** `Set<string>` of ensured directories and repaired files, populated lazily, plus retry-once that invalidates memos when an append fails. Minimal diff (one file + tests), uniform for all callers, no config, no format change.
2. **Per-sink open-time warmup in `createJournalSinks`.** Only covers the journaler's sinks, not `config.ts` / `ledger.ts` call sites, and still needs memoization — strictly more code for less coverage. Rejected.
3. **Persisted pid/epoch stamp per file.** Changes the on-disk contract and adds read-back; unnecessary. Rejected.

# Relevant Files

- `src/journal-sinks.ts` — modify `appendLine`; add two module-level memo Sets and small helpers.
- `tests/fail-open.test.ts` — existing fail-open test stays green via the retry-once path.
- `tests/verify.test.ts` — existing torn-tail test stays green.
- `tests/export-shape.test.ts` — unchanged.
- New `tests/journal-append-hot-path.test.ts` — the new branches.

# Proposed Changes

All edits in `src/journal-sinks.ts`:

1. Module-level memo state:

```ts
/** Directories this process has already ensured exist (per-process memo:
 * mkdir is an open-time cost, not a per-row cost). Invalidated by the
 * retry-once path when an append fails. */
const ensuredDirs = new Set<string>()
/** Journal files this process has already torn-tail-repaired (the first
 * write by this process; a torn tail can only be left by a prior
 * process's crash, which the next process's first write repairs). */
const repairedFiles = new Set<string>()
```

2. Helpers (JSDoc'd, under the size cap):

```ts
function ensureDirOnce(dir: string): void {
  if (ensuredDirs.has(dir)) return
  fs.mkdirSync(dir, { recursive: true })
  ensuredDirs.add(dir)
}

function repairOnce(file: string): void {
  if (repairedFiles.has(file)) return
  repairTornTail(file)
  repairedFiles.add(file)
}
```

   Preferred shape: no inner catch in `repairOnce` — a repair read error propagates into `tryAppend`'s catch, costing that row exactly as today, and the memo is only added on success (keeps every branch deterministically coverable).

3. Rewritten `appendLine` with retry-once memo invalidation:

```ts
export function appendLine(file: string, text: string): void {
  if (tryAppend(file, text)) return
  // A failure usually means a memo is stale (the directory was removed
  // mid-session). Drop the memos for this path and retry exactly once.
  ensuredDirs.delete(path.dirname(file))
  repairedFiles.delete(file)
  tryAppend(file, text)
}

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
```

   Signature, return type, fail-open contract preserved.

4. No changes to `repairTornTail` itself, rotation, anchor's direct use, or any caller. No config keys, no docs, no diagrams.

5. Update the `appendLine` JSDoc middle sentences verbatim to: "The parent directory is created once per process and the torn-tail repair runs once per file per process (a torn tail can only be left by a prior process's crash, which the next process's first write repairs); a failed append drops both memos for the path and retries once. The caller is still responsible for rotating when a size bound applies (the journaler's `journal()`/`traceEvent()` call `tickRotate` on an entry-count tick, under a lock-guarded rename). A torn final line (no trailing newline, left by a crash mid-append) is separated with one `\n` first so the new line always parses on its own. Silent on any failure: journaling must never break execution."

# Tests

## Existing tests — assertion audit

| Assertion | Verdict |
| --- | --- |
| `tests/fail-open.test.ts:108-114` — "appendLine never throws when the parent path is a file" | green — exercises the retry-once branch (both attempts fail, swallowed) |
| `tests/verify.test.ts:335-371` — torn final line repaired by separation, verify ok; `appendLine(empty, "x")` empty-file sub-case :367-370 | green — repair still runs on first write per file per process |
| `tests/anchor.test.ts:252-266` — session-state sink torn-tail repair via `repairTornTail` directly | green — helper unchanged, anchor call site untouched |
| `tests/export-shape.test.ts:314,318` — `appendLine`, `repairTornTail` exported | green — both exports kept |
| `tests/journal-chain/segmentation/contention/archive.test.ts` — chained appends through `appendLine` | green — on-disk format and ordering unchanged |

Caveat: memo Sets are module-level and `npm test` runs `--experimental-test-isolation=none` (one process), so every test must use a unique `tmpDir()` — the existing suite already does. No test reuses a path across assertions expecting a second repair (audit found none).

## Branch → test mapping

| Branch | Test |
| --- | --- |
| `ensureDirOnce` memo hit | implicit in multi-append tests |
| `ensureDirOnce` memo miss → mkdir | hot-path test, first append |
| `repairOnce` memo hit → skipped | hot-path test, second append after simulated new torn tail |
| `repairOnce` memo miss → repair runs (incl. empty-file early return) | hot-path test; empty-file case mirrors `verify.test.ts:367-370` |
| `tryAppend` success | every append |
| `tryAppend` failure → retry-once | fail-open test (parent is a file) |
| retry-once succeeds after invalidation | vanish-dir test |
| retry-once fails → swallowed | fail-open test |

## New test skeletons (`tests/journal-append-hot-path.test.ts`)

```ts
test("appendLine repairs the torn tail on the first write and not again", () => {
  const file = path.join(tmpDir(), "torn.jsonl")
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, '{"ts":"t"') // torn tail, no newline
  appendLine(file, "first")
  assert.equal(fs.readFileSync(file, "utf8"), '{"ts":"t"\nfirst\n') // repaired once
  fs.appendFileSync(file, '{"torn":') // simulate a new torn tail mid-session
  appendLine(file, "second")
  assert.match(fs.readFileSync(file, "utf8"), /"torn":\nsecond\n/) // NOT repaired again
})
```

```ts
test("appendLine re-ensures the directory when it disappears mid-session", () => {
  const dir = path.join(tmpDir(), "vanish")
  const file = path.join(dir, "j.jsonl")
  appendLine(file, "one")
  fs.rmSync(dir, { recursive: true })
  appendLine(file, "two")
  assert.equal(fs.readFileSync(file, "utf8"), "one\ntwo\n")
})
```

```ts
test("appendLine still swallows an unwritable path (fail-open)", () => {
  const blocker = path.join(tmpDir(), "notadir")
  fs.writeFileSync(blocker, "x")
  appendLine(path.join(blocker, "child.jsonl"), "hello")
  assert.equal(fs.existsSync(path.join(blocker, "child.jsonl")), false)
})
```

# Risks

- **Multi-writer same-file:** two live processes append to the shared `turnstile.jsonl`. Today any process's next row heals a torn tail; after the fix only each process's first write does. Worst case: process A crashes mid-append, live process B (past its first write) appends onto the tail, producing one merged unparseable line. Bounded: replay/verify skip it as malformed, and the chain's next append re-validates head-vs-tail and reseeds (fallback already exercised by `verify.test.ts:346-352`). This is the issue's own suggested tradeoff.
- **Stale memo after external deletion:** handled by retry-once; second failure still loses the row silently, same as today.
- **Module-level state vs. test isolation:** mitigated by per-test `mkdtemp` (existing convention).
- **Coverage of `repairOnce`:** resolved by the no-inner-catch shape (memo added only on success) so every branch is deterministically reachable.

# Acceptance Criteria

1. AC-1 (R1): After the first `appendLine` to a directory in a process, subsequent appends issue no `mkdirSync`.
2. AC-2 (R2, R7): `repairTornTail` executes at most once per file per process from `appendLine`; a torn tail is still separated on the first write.
3. AC-3 (R3): `appendLine` never throws, including parent-is-a-file and vanished-directory cases.
4. AC-4 (R5): `repairTornTail` remains exported; `anchor.ts` behavior unchanged.
5. AC-5 (R6): `npm run ci` passes, including 100% coverage over modified `src/journal-sinks.ts`.
6. AC-6 (R7): verify/replay tests stay green; no on-disk format, config, or doc changes.
7. AC-7: Nothing from issue #363 (sqlite sink) appears in the change set.

## Decomposition

- chunk-1: `src/journal-sinks.ts` — module-level memo Sets (`ensuredDirs`, `repairedFiles`), `ensureDirOnce`/`repairOnce` helpers, rewrite `appendLine` as `tryAppend` + retry-once memo invalidation, update JSDoc.
- chunk-2: `tests/journal-append-hot-path.test.ts` — new test file covering the memo-hit/miss, retry-once-success, and fail-open branches per the plan's branch→test mapping.