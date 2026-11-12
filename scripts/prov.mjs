#!/usr/bin/env node
// Read-only query surface for the decision-provenance ledger (`prov:*`
// journal rows).
//
// This is the `turnstile prov` surface: it renders the journaled human
// decision events — `prov:stated` (captured prompts, redacted at write
// time), `prov:denied` (human permission denials), `prov:waiver`
// (human gate waivers; the row shape exists, wiring is post-MVP), and
// `prov:override` (parent overrides of pipeline-child writes) —
// oldest-first. It never writes anything and never blocks. Like
// scripts/log.mjs it is a plain ESM script outside the 100% coverage gate
// (bin/ and scripts/ never are), exercised by tests/prov-cli.test.ts via
// spawn rather than imported.
//
// Sources: every per-session sink `sessions/<sessionID>.jsonl` (+ rotated
// generations) plus the shared `turnstile.jsonl` (+ generations). With an
// explicit sessionID the walk covers that session's sink and the shared
// journal filtered to it; without one, every session's `prov:*` rows are
// shown. Rows whose `type` does not start with `prov:` are dropped.
//
//   opencode-turnstile prov [sessionID] [--json] [--tail <n>]
//   opencode-turnstile prov --verify   Check the journal hash chain + anchors.
//   opencode-turnstile prov --help      This usage. Unknown flags exit 2.

import * as fs from "node:fs"
import * as path from "node:path"

import {
  clockOf,
  loadConfigFile,
  parseTailValue,
  provEntriesOf,
  readAllProvLines,
  readSessionProvLines,
  requireSessionShape,
  resolveConfig,
  truncateField,
} from "./journal-read.mjs"
import {
  absentAnchoredRefs,
  merklePath,
  merklePathRoot,
  merkleRoot,
  readAnchoredRefs,
  resolveAnchorSinks,
  verifyAnchors,
  verifyFamilies,
  verifySessionFamilies,
} from "./chain-read.mjs"

const USAGE = `Usage: opencode-turnstile prov [sessionID] [--json] [--tail <n>]
       opencode-turnstile prov --verify
       opencode-turnstile prov --verify --session <id> [--json]

Prints the decision-provenance ledger: the journaled human decision events
(prompts stated, permission denials, gate waivers, parent overrides of
pipeline-child writes) for one session, or for
every session when no sessionID is given. Read-only: nothing is written.

With --verify, instead checks the journal hash chain: every journal file
family folds across its rotation generations, each committed epoch's Merkle
root is re-derived, and the epoch refs are verified against the configured
anchor sinks. Exit 0 when the chain is intact and anchored; exit 1 on the
first broken link or any unanchored/mismatched ref; exit 2 on usage errors.

With --verify --session <id>, the check is scoped: only the shared journal
and that session's sink fold, each prov:* row reports its inclusion proof
(row hash, Merkle path, anchored status, weakest vouching trust domain),
and a mutated prov:* row is localized to the row and its epoch. --json is
honored in scoped mode only.

Options:
  --json            Print the raw journal rows as JSON instead of the
                    rendered lines (scoped verify: the stable JSON report)
  --tail <n>        Bound the output to the last <n> prov rows (default: the
                    configured replayTailLines)
  --verify          Verify the journal hash chain and anchors instead of
                    rendering
  --session <id>    With --verify: scope the check to one session's sink
                    plus the shared journal, with per-row inclusion proofs
  --help            Show this help`

/** Render bound for `prov:stated` text so one long prompt cannot blow out a row. */
const STATED_RENDER_CAP = 120

/**
 * Parses the prov arguments. Recognizes one optional positional sessionID,
 * --json, --tail <n>, --verify, --session <id>, and --help; anything else
 * is unknown and fails with exit code 2 (log parity).
 * @param {string[]} argv Arguments after the `prov` subcommand.
 * @returns {{ sessionID: string, json: boolean, tail: number | null,
 *     help: boolean, verify: boolean, session: string }} Parsed arguments;
 *     `tail` is null when the flag is absent, `session` "" when --session
 *     is absent.
 */
function parseArgs(argv) {
  const out = {
    sessionID: "",
    json: false,
    tail: null,
    help: false,
    verify: false,
    session: "",
  }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === "--json") out.json = true
    else if (a === "--help") out.help = true
    else if (a === "--verify") out.verify = true
    else if (a === "--tail") out.tail = parseTailValue(argv[++i])
    else if (a === "--session") out.session = parseSessionValue(argv[++i])
    else if (a.startsWith("--")) throw new Error(`unknown argument "${a}"`)
    else if (out.sessionID === "") out.sessionID = a
    else throw new Error(`unexpected extra argument "${a}"`)
  }
  if (out.session !== "" && out.sessionID !== "") {
    throw new Error("--session cannot be combined with a positional sessionID")
  }
  if (out.verify && out.sessionID !== "") {
    throw new Error("--verify checks every session and cannot be combined with a sessionID")
  }
  if (out.session !== "" && !out.verify) {
    throw new Error("--session requires --verify")
  }
  return out
}

/**
 * Validates the `--session` value: it must be present (a value-taking flag
 * like --tail) and non-empty.
 * @param {string | undefined} value The raw flag value.
 * @returns {string} The validated value.
 */
function parseSessionValue(value) {
  if (typeof value !== "string" || value === "") {
    throw new Error("--session requires a session id value")
  }
  return value
}

/**
 * Renders one `prov:stated` row: the redacted prompt text (write-time
 * redaction is the journal's job; this renders it verbatim, bounded), with
 * the truncation marker when the capture cap was applied.
 * @param {Record<string, unknown>} e The parsed entry.
 * @returns {string} The rendered line.
 */
function renderStated(e) {
  const text = typeof e.text === "string" ? e.text : "?"
  const marker = e.truncated === true ? " (truncated)" : ""
  return `stated  ${truncateField(text, STATED_RENDER_CAP)}${marker}`
}

/**
 * Renders one `prov:denied` row: the ask kind that was denied.
 * @param {Record<string, unknown>} e The parsed entry.
 * @returns {string} The rendered line.
 */
function renderDenied(e) {
  const kind = typeof e.kind === "string" ? e.kind : "?"
  return `denied  kind=${kind}`
}

/**
 * Renders one `prov:waiver` row: the gate stages the waiver's coverage
 * opened (the row shape exists; wiring is post-MVP, so this renders rows
 * that only a hand-seeded or future journal can carry).
 * @param {Record<string, unknown>} e The parsed entry.
 * @returns {string} The rendered line.
 */
function renderWaiver(e) {
  const stages = Array.isArray(e.stages) ? e.stages.map(String).join(",") : "?"
  return `waiver  stages=${stages}`
}

/**
 * Renders one `prov:override` row: the parent-side tool, the overridden
 * child session, and the (capped) target path.
 * @param {Record<string, unknown>} e The parsed entry.
 * @returns {string} The rendered line.
 */
function renderOverride(e) {
  const tool = typeof e.tool === "string" ? e.tool : "?"
  const child = typeof e.child === "string" ? e.child : "?"
  const path = typeof e.path === "string" ? e.path : "?"
  return `override  tool=${tool} child=${child} path=${truncateField(path, STATED_RENDER_CAP)}`
}

/**
 * Renders one prov entry to its ledger line; an unrecognized `prov:*` type
 * renders its raw type so future journal types never break the surface.
 * @param {Record<string, unknown>} e The parsed entry.
 * @returns {string} The rendered line.
 */
function renderProv(e) {
  const type = typeof e.type === "string" ? e.type : "?"
  if (type === "prov:stated") return renderStated(e)
  if (type === "prov:denied") return renderDenied(e)
  if (type === "prov:waiver") return renderWaiver(e)
  if (type === "prov:override") return renderOverride(e)
  return `${type}  (unrecognized)`
}

/**
 * Builds the rendered ledger rows: one line per prov entry, oldest-first.
 * @param {Record<string, unknown>[]} entries Parsed prov entries, oldest-first.
 * @returns {{ ts: string, text: string }[]} The rendered rows.
 */
function buildRows(entries) {
  return entries.map((e) => ({ ts: clockOf(e.ts), text: renderProv(e) }))
}

/**
 * Emits the output: the raw rows as JSON, or the rendered ledger lines.
 * Empty output prints nothing (exit 0 either way).
 * @param {Record<string, unknown>[]} entries The parsed prov entries, oldest-first.
 * @param {boolean} json Whether `--json` was requested.
 * @returns {void}
 */
function emit(entries, json) {
  if (entries.length === 0) return
  if (json) {
    process.stdout.write(`${JSON.stringify(entries, null, 2)}\n`)
  } else {
    const rows = buildRows(entries)
    process.stdout.write(`${rows.map((r) => `${r.ts}  ${r.text}`).join("\n")}\n`)
  }
}

/**
 * Resolves the config, walks the sinks, and filters to the prov rows (the
 * resolve-and-read step of `main`). A malformed explicit session ID writes
 * the error to stderr.
 * @param {{ sessionID: string, tail: number | null }} args The parsed args.
 * @returns {{ files: string[], entries: Record<string, unknown>[] } | number}
 *     The walked files with the prov entries, or the exit code to return
 *     when the session ID is malformed (2).
 */
function resolveAndRead(args) {
  const { metricsDir, tailLines } = resolveConfig(process.env, args.tail)
  if (args.sessionID !== "") {
    let sessionID
    try {
      sessionID = requireSessionShape(args.sessionID)
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      process.stderr.write(`${msg}\n`)
      return 2
    }
    const read = readSessionProvLines(metricsDir, sessionID, tailLines)
    return { files: read.files, entries: provEntriesOf(read.lines, tailLines) }
  }
  const read = readAllProvLines(metricsDir, tailLines)
  return { files: read.files, entries: provEntriesOf(read.lines, tailLines) }
}

/**
 * Reads the configured anchor selection from the config file (the
 * `tamperEvidence.anchor` key), defaulting to `session-state` — the same
 * default `defaultConfig()` uses.
 * @param {NodeJS.ProcessEnv} env The process environment.
 * @returns {string | object | Array<string | object>} The anchor selection.
 */
function anchorSelectionOf(env) {
  const config = loadConfigFile(env)
  const te =
    config && typeof config.tamperEvidence === "object" && config.tamperEvidence !== null
      ? config.tamperEvidence
      : {}
  return te.anchor ?? "session-state"
}

/**
 * Reads the journal rotation generation count from the config file (the
 * `journalMaxGenerations` key), defaulting to 5 — the same default
 * `defaultConfig()` uses. Verify must fold the same generations the
 * journaler wrote or an intact journal reports a broken link.
 * @param {NodeJS.ProcessEnv} env The process environment.
 * @returns {number} The configured generation count.
 */
function maxGenerationsOf(env) {
  const config = loadConfigFile(env)
  const gens = config?.journalMaxGenerations
  return Number.isInteger(gens) && gens > 0 ? gens : 5
}

/**
 * Reports the unanchored epoch refs (no sink vouches for them) to stdout.
 * @param {Array<{ ref: object, domain: string | null }>} weakest The
 *     weakest vouching domain per ref.
 * @param {Array<{ ref: object, sink: string, verdict: object }>} verdicts
 *     The per-sink verdicts.
 * @returns {number} 1 when at least one ref is unanchored, 0 otherwise.
 */
function reportUnanchored(weakest, verdicts) {
  const failed = weakest.filter((w) => w.domain === null)
  for (const f of failed) {
    const v = verdicts.find((x) => x.ref === f.ref && x.verdict.status !== "ok")
    const detail = v ? v.verdict.detail : "not anchored by any configured sink"
    process.stdout.write(`unanchored: ${f.ref.source}#${f.ref.epoch}: ${detail}\n`)
  }
  return failed.length > 0 ? 1 : 0
}

/**
 * Runs the `--verify` check: folds every journal family, then verifies the
 * collected epoch refs against the configured anchor sinks. Read-only.
 * @returns {Promise<number>} The exit code: 0 ok, 1 broken/unanchored.
 */
async function runVerify() {
  const { metricsDir } = resolveConfig(process.env, null)
  const report = verifyFamilies(metricsDir, maxGenerationsOf(process.env))
  const broken = report.families.find((f) => f.verdict.status === "broken")
  if (broken) {
    process.stdout.write(`chain broken at ${broken.verdict.detail}\n`)
    return 1
  }
  const { sinks, warnings } = await resolveAnchorSinks(anchorSelectionOf(process.env), {
    metricsDir,
    projectDir: process.cwd(),
  })
  for (const warning of warnings) process.stderr.write(`${warning}\n`)
  // Repo-domain sinks shell out to git in the process cwd; without a .git
  // there they can never anchor or verify — say so instead of failing silently.
  if (
    sinks.some((s) => s.trustDomain === "repo") &&
    !fs.existsSync(path.join(process.cwd(), ".git"))
  ) {
    process.stderr.write(
      `warning: repo-domain anchor sinks resolve against ${process.cwd()}, which has no .git\n`,
    )
  }
  const { verdicts, weakest } = await verifyAnchors(sinks, report.refs)
  if (reportUnanchored(weakest, verdicts) === 1) return 1
  const absent = absentAnchoredRefs(metricsDir, report.refs)
  if (absent.length > 0) {
    for (const d of absent) process.stdout.write(`${d}\n`)
    return 1
  }
  const domains = [...new Set(weakest.map((w) => w.domain))].join("+")
  const ids = [...new Set(verdicts.filter((v) => v.verdict.status === "ok").map((v) => v.sink))]
  const anchored =
    report.refs.length === 0 ? "nothing to anchor" : `anchored by ${domains} [${ids.join(", ")}]`
  process.stdout.write(
    `chain ok (${report.rows} rows, ${report.refs.length} epochs) · ${anchored}\n`,
  )
  return 0
}

/**
 * Entry point. Parses args, walks the journal sinks, and prints the prov
 * rows. An empty ledger exits 0 with no output; usage errors exit 2.
 * @param {string[]} argv Arguments after the `prov` subcommand.
 * @returns {number | Promise<number>} The process exit code.
 */
function main(argv) {
  let args
  try {
    args = parseArgs(argv)
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    process.stderr.write(`${msg}\n`)
    process.stderr.write(
      "usage: opencode-turnstile prov [sessionID] [--json] [--tail <n>] [--verify] [--verify --session <id>]\n",
    )
    return 2
  }
  if (args.help) {
    process.stdout.write(`${USAGE}\n`)
    return 0
  }
  if (args.verify && args.session !== "") return runVerifyScoped(args)
  if (args.verify) return runVerify()
  const read = resolveAndRead(args)
  if (typeof read === "number") return read
  emit(read.entries, args.json)
  return 0
}

/**
 * Resolves the anchor sinks for the scoped verify (the same configured
 * selection the global verify uses) and verifies the scoped refs against
 * them.
 * @param {string} metricsDir The metrics directory.
 * @param {object[]} refs The epoch refs to verify.
 * @returns {Promise<{ verdicts: object[], weakest: object[], sinks:
 *     object[] }>} The verdicts, the weakest vouching domain per ref, and
 *     the resolved sinks.
 */
async function resolveScopedAnchors(metricsDir, refs) {
  const { sinks, warnings } = await resolveAnchorSinks(anchorSelectionOf(process.env), {
    metricsDir,
    projectDir: process.cwd(),
  })
  for (const warning of warnings) process.stderr.write(`${warning}\n`)
  const { verdicts, weakest } = await verifyAnchors(sinks, refs)
  return { verdicts, weakest, sinks }
}

/**
 * Builds the per-epoch anchored facts for the scoped report: whether each
 * committed epoch ref is anchored, its weakest vouching trust domain, and
 * the sink ids that vouched.
 * @param {object[]} refs The committed epoch refs.
 * @param {Array<{ ref: object, sink: string, verdict: object }>} verdicts
 *     The per-sink verdicts.
 * @param {Array<{ ref: object, domain: string | null }>} weakest The
 *     weakest vouching domain per ref.
 * @returns {Map<string, { anchored: boolean, weakestDomain: string | null,
 *     sinks: string[] }>} The facts keyed by `source#epoch`.
 */
function anchoredFacts(refs, verdicts, weakest) {
  const facts = new Map()
  for (const ref of refs) {
    const key = `${ref.source}#${ref.epoch}`
    const w = weakest.find((x) => x.ref === ref)
    const sinks = [
      ...new Set(
        verdicts.filter((v) => v.ref === ref && v.verdict.status === "ok").map((v) => v.sink),
      ),
    ]
    facts.set(key, {
      anchored: w?.domain !== null && w?.domain !== undefined,
      weakestDomain: w?.domain ?? null,
      sinks,
    })
  }
  return facts
}

/**
 * Builds one scoped report row for a committed prov row whose epoch window
 * is incomplete (its earliest data rows were pruned): the surviving leaf
 * list is partial, so no inclusion proof can be derived — the row reports
 * null proof fields with a reason, like an open-window row, and never
 * flips the exit code.
 * @param {object} row The collected prov row.
 * @param {Map<string, { anchored: boolean, weakestDomain: string | null,
 *     sinks: string[] }>} facts The per-epoch anchored facts.
 * @returns {object} The report row.
 */
function incompleteRowReport(row, facts) {
  const fact = facts.get(`${row.source}#${row.epoch}`)
  return {
    type: row.payload.type,
    ts: row.ts,
    source: row.source,
    seq: row.seq,
    hash: row.hash,
    epoch: row.epoch,
    epochRoot: null,
    merklePath: null,
    merkleOk: null,
    anchored: fact.anchored,
    weakestDomain: fact.weakestDomain,
    sinks: fact.sinks,
    reason: "epoch window incomplete (earlier rows pruned)",
  }
}

/**
 * Builds one scoped report row for a committed prov row: its Merkle
 * inclusion path against its epoch's real leaf list (rebuilt from the
 * collected rows) and whether the recomputed path root matches the
 * anchored ref's root (falling back to the journal's committed root when
 * no anchored ref exists).
 * @param {object} row The collected prov row (source, seq, hash, epoch,
 *     position, ts, payload).
 * @param {Map<string, string[]>} leafLists The epoch leaf lists keyed by
 *     `source#epoch`.
 * @param {Map<string, { anchored: boolean, weakestDomain: string | null,
 *     sinks: string[] }>} facts The per-epoch anchored facts.
 * @param {object[]} anchoredRefs The refs in the anchor store.
 * @returns {object} The report row.
 */
function committedRowReport(row, leafLists, facts, anchoredRefs) {
  if (row.incompleteWindow === true) return incompleteRowReport(row, facts)
  const leaves = leafLists.get(`${row.source}#${row.epoch}`) ?? []
  const fact = facts.get(`${row.source}#${row.epoch}`)
  const path = merklePath(leaves, row.position)
  const anchoredRef = anchoredRefs.find((a) => a.source === row.source && a.epoch === row.epoch)
  const targetRoot = typeof anchoredRef?.root === "string" ? anchoredRef.root : merkleRoot(leaves)
  return {
    type: row.payload.type,
    ts: row.ts,
    source: row.source,
    seq: row.seq,
    hash: row.hash,
    epoch: row.epoch,
    epochRoot: merkleRoot(leaves),
    merklePath: path,
    merkleOk: merklePathRoot(row.hash, path) === targetRoot,
    anchored: fact.anchored,
    weakestDomain: fact.weakestDomain,
    sinks: fact.sinks,
    reason: null,
  }
}

/**
 * Builds the epoch leaf lists for the scoped report from the collected
 * rows: each committed epoch's leaf hashes in order, keyed by
 * `source#epoch`. Open-window rows (whose epoch index has no committed
 * ref) are excluded — they have no root to prove against.
 * @param {object[]} collected The collected data rows from the scoped fold.
 * @param {object[]} refs The committed epoch refs (defines which epochs
 *     are committed).
 * @returns {Map<string, string[]>} The leaf lists per committed epoch.
 */
function buildLeafLists(collected, refs) {
  const committed = new Set(refs.map((r) => `${r.source}#${r.epoch}`))
  const lists = new Map()
  for (const r of collected) {
    const key = `${r.source}#${r.epoch}`
    if (!committed.has(key)) continue
    const list = lists.get(key) ?? []
    list[r.position] = r.hash
    lists.set(key, list)
  }
  return lists
}

/**
 * Looks up one committed epoch's data-row count from the scoped fold's
 * family verdicts (the commit row's declared count — the committed count,
 * which exceeds the surviving leaf list when earlier rows were pruned).
 * @param {object} report The scoped fold report.
 * @param {object} ref The epoch ref.
 * @returns {number | null} The epoch's committed data-row count, or null
 *     when the family broke before summarizing it.
 */
function epochCount(report, ref) {
  for (const f of report.families) {
    if (f.source !== ref.source || f.verdict.status !== "ok") continue
    const summary = f.verdict.epochs.find((e) => e.epoch === ref.epoch)
    if (summary) return summary.count
  }
  return null
}

/**
 * Builds one open-window report row: the row has no committed epoch to
 * prove inclusion in yet.
 * @param {object} r The collected prov row.
 * @returns {object} The report row.
 */
function openRowReport(r) {
  return {
    type: r.payload.type,
    ts: r.ts,
    source: r.source,
    seq: r.seq,
    hash: r.hash,
    epoch: null,
    epochRoot: null,
    merklePath: null,
    merkleOk: null,
    anchored: false,
    weakestDomain: null,
    sinks: [],
    reason: "open epoch window (not yet committed)",
  }
}

/**
 * Builds the scoped report's per-epoch entries: each committed epoch ref
 * with its anchored facts and committed row count.
 * @param {object} report The scoped fold report.
 * @param {Map<string, { anchored: boolean, weakestDomain: string | null,
 *     sinks: string[] }>} facts The per-epoch anchored facts.
 * @returns {object[]} The epoch entries.
 */
function epochReports(report, facts) {
  return report.refs.map((ref) => {
    const fact = facts.get(`${ref.source}#${ref.epoch}`)
    return {
      source: ref.source,
      epoch: ref.epoch,
      count: epochCount(report, ref),
      root: ref.root,
      anchored: fact.anchored,
      weakestDomain: fact.weakestDomain,
      sinks: fact.sinks,
    }
  })
}

/**
 * Builds the scoped report's JSON shape: the chain summary, the per-epoch
 * anchored facts, and one report row per prov row (committed rows carry
 * their inclusion proof; open-window and pruned-window rows carry null
 * proof fields and a reason).
 * @param {string} sessionID The scoped session's ID.
 * @param {object} report The scoped fold report.
 * @param {Map<string, { anchored: boolean, weakestDomain: string | null,
 *     sinks: string[] }>} facts The per-epoch anchored facts.
 * @param {object[]} anchoredRefs The refs in the anchor store.
 * @param {{ detail: string, index: number, prov: object | null } | null}
 *     broken The broken-chain localization, or null.
 * @returns {object} The JSON report.
 */
function buildScopedJson(sessionID, report, facts, anchoredRefs, broken) {
  const leafLists = buildLeafLists(report.collected, report.refs)
  const rows = report.collected
    .filter((r) => String(r.payload?.type ?? "").startsWith("prov:"))
    .map((r) => {
      const committed = report.refs.some((ref) => ref.source === r.source && ref.epoch === r.epoch)
      return committed ? committedRowReport(r, leafLists, facts, anchoredRefs) : openRowReport(r)
    })
  return {
    session: sessionID,
    chain: {
      status: broken === null ? "ok" : "broken",
      rows: report.rows,
      epochs: report.refs.length,
    },
    epochs: epochReports(report, facts),
    rows,
    broken,
  }
}

/**
 * Derives the broken-chain localization from the scoped fold report.
 * @param {object} report The scoped fold report.
 * @returns {{ detail: string, index: number, prov: object | null } | null}
 *     The localization, or null when every family folded ok.
 */
function brokenOf(report) {
  const brokenFamily = report.families.find((f) => f.verdict.status === "broken")
  return brokenFamily
    ? {
        detail: brokenFamily.verdict.detail,
        index: brokenFamily.verdict.index,
        prov: brokenFamily.verdict.provContext ?? null,
      }
    : null
}

/**
 * Emits the broken-chain human verdict: the `chain broken` line plus, when
 * the broken row is a `prov:*` row, its localization.
 * @param {string} sessionID The scoped session's ID.
 * @param {{ detail: string, index: number, prov: object | null }} broken
 *     The broken-chain localization.
 * @returns {void}
 */
function emitBrokenScoped(sessionID, broken) {
  process.stdout.write(`chain broken at ${broken.detail}\n`)
  if (broken.prov !== null) {
    process.stdout.write(
      `mutated prov row: ${broken.prov.type} at ${sessionID}:${broken.prov.index} (epoch ${broken.prov.epoch})\n`,
    )
  }
}

/**
 * Emits the scoped verify's output: the JSON report, the broken-chain
 * verdict, or the intact per-row human report.
 * @param {{ json: boolean }} args The parsed args.
 * @param {string} sessionID The scoped session's ID.
 * @param {object} report The scoped fold report.
 * @param {Map<string, { anchored: boolean, weakestDomain: string | null,
 *     sinks: string[] }>} facts The per-epoch anchored facts.
 * @param {object[]} anchoredRefs The refs in the anchor store.
 * @param {{ detail: string, index: number, prov: object | null } | null}
 *     broken The broken-chain localization, or null.
 * @param {Array<{ ref: object, sink: string, verdict: object }>} verdicts
 *     The per-sink verdicts.
 * @param {Array<{ ref: object, domain: string | null }>} weakest The
 *     weakest vouching domain per ref.
 * @returns {void}
 */
function emitScoped(args, sessionID, report, facts, anchoredRefs, broken, verdicts, weakest) {
  if (args.json) {
    process.stdout.write(
      `${JSON.stringify(buildScopedJson(sessionID, report, facts, anchoredRefs, broken), null, 2)}\n`,
    )
  } else if (broken !== null) {
    emitBrokenScoped(sessionID, broken)
  } else {
    emitScopedOk(report, facts, anchoredRefs, verdicts, weakest)
  }
}

/**
 * Computes the scoped verify's exit code after the output is emitted: 1 on
 * any unanchored ref or an absent anchored epoch, 0 otherwise.
 * @param {{ json: boolean }} args The parsed args.
 * @param {string} metricsDir The metrics directory.
 * @param {object} report The scoped fold report.
 * @param {Array<{ ref: object, sink: string, verdict: object }>} verdicts
 *     The per-sink verdicts.
 * @param {Array<{ ref: object, domain: string | null }>} weakest The
 *     weakest vouching domain per ref.
 * @returns {number} The exit code.
 */
function scopedExitCode(args, metricsDir, report, verdicts, weakest) {
  if (!args.json) {
    if (reportUnanchored(weakest, verdicts) === 1) return 1
    const absent = absentAnchoredRefs(metricsDir, report.refs)
    if (absent.length > 0) {
      for (const d of absent) process.stdout.write(`${d}\n`)
      return 1
    }
    return 0
  }
  // JSON mode reports the same verdicts through the rows' anchored facts
  // instead of the human unanchored/absent lines.
  if (weakest.some((w) => w.domain === null)) return 1
  return absentAnchoredRefs(metricsDir, report.refs).length > 0 ? 1 : 0
}

/**
 * Runs the scoped `--verify --session <id>` check: folds only the shared
 * journal and the session's sink, verifies the scoped epoch refs against
 * the configured anchor sinks, and reports per-row inclusion facts. A
 * mutated `prov:*` row is localized to the row and its epoch. Read-only.
 * @param {{ session: string, json: boolean }} args The parsed args.
 * @returns {Promise<number>} The exit code: 0 ok, 1 broken/unanchored,
 *     2 usage (malformed session id).
 */
async function runVerifyScoped(args) {
  let sessionID
  try {
    sessionID = requireSessionShape(args.session)
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    process.stderr.write(`${msg}\n`)
    return 2
  }
  const { metricsDir } = resolveConfig(process.env, null)
  const report = verifySessionFamilies(metricsDir, sessionID, maxGenerationsOf(process.env))
  const broken = brokenOf(report)
  const { verdicts, weakest } = await resolveScopedAnchors(metricsDir, report.refs)
  const facts = anchoredFacts(report.refs, verdicts, weakest)
  const anchoredRefs = readAnchoredRefs(metricsDir)
  emitScoped(args, sessionID, report, facts, anchoredRefs, broken, verdicts, weakest)
  if (broken !== null) return 1
  return scopedExitCode(args, metricsDir, report, verdicts, weakest)
}

/**
 * Emits the intact scoped verdict: the `chain ok` summary line followed by
 * one line per prov row with its inclusion facts.
 * @param {object} report The scoped fold report.
 * @param {Map<string, { anchored: boolean, weakestDomain: string | null,
 *     sinks: string[] }>} facts The per-epoch anchored facts.
 * @param {object[]} anchoredRefs The refs in the anchor store.
 * @param {Array<{ ref: object, sink: string, verdict: object }>} verdicts
 *     The per-sink verdicts.
 * @param {Array<{ ref: object, domain: string | null }>} weakest The
 *     weakest vouching domain per ref.
 * @returns {void}
 */
function emitScopedOk(report, facts, anchoredRefs, verdicts, weakest) {
  const domains = [...new Set(weakest.map((w) => w.domain).filter((d) => d !== null))].join("+")
  const ids = [...new Set(verdicts.filter((v) => v.verdict.status === "ok").map((v) => v.sink))]
  const anchored =
    report.refs.length === 0 ? "nothing to anchor" : `anchored by ${domains} [${ids.join(", ")}]`
  process.stdout.write(
    `chain ok (${report.rows} rows, ${report.refs.length} epochs) · ${anchored}\n`,
  )
  const leafLists = buildLeafLists(report.collected, report.refs)
  for (const r of report.collected) {
    if (!String(r.payload?.type ?? "").startsWith("prov:")) continue
    process.stdout.write(`${scopedRowLine(r, leafLists, facts, anchoredRefs)}\n`)
  }
}

/**
 * Renders one collected prov row's human line with its inclusion facts.
 * @param {object} r The collected row.
 * @param {Map<string, string[]>} leafLists The epoch leaf lists.
 * @param {Map<string, { anchored: boolean, weakestDomain: string | null,
 *     sinks: string[] }>} facts The per-epoch anchored facts.
 * @param {object[]} anchoredRefs The refs in the anchor store.
 * @returns {string} The rendered line.
 */
function scopedRowLine(r, leafLists, facts, anchoredRefs) {
  const rendered = renderProv(r.payload)
  const rowTag = `row=${String(r.hash).slice(0, 8)}`
  if (r.incompleteWindow === true) {
    const fact = facts.get(`${r.source}#${r.epoch}`)
    const anchored = fact?.anchored ? (fact.weakestDomain ?? "no") : "no"
    return `${rendered}  ${rowTag} epoch=${r.epoch} merkle=pruned anchored=${anchored} (earlier rows pruned)`
  }
  const committed = leafLists.has(`${r.source}#${r.epoch}`)
  if (!committed) {
    return `${rendered}  ${rowTag} epoch=open anchored=no (not yet committed)`
  }
  const report = committedRowReport(r, leafLists, facts, anchoredRefs)
  const merkle = report.merkleOk ? "ok" : "MISMATCH"
  const anchored = report.anchored ? (report.weakestDomain ?? "no") : "no"
  return `${rendered}  ${rowTag} epoch=${r.epoch} merkle=${merkle} anchored=${anchored}`
}

process.exit((await main(process.argv.slice(2))) ?? 0)
