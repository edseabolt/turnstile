#!/usr/bin/env node
// Shareable, schema-versioned summary of one task's journaled evidence.
//
// This is the `turnstile evidence` surface: it derives, for a single task, a
// whitelist projection of the JSONL journal that is safe to publish. It is
// deliberately a plain ESM script outside the 100% coverage gate (bin/ and
// scripts/ never are), and it is exercised by tests/evidence-cli.test.ts via
// spawn rather than import.
//
// The document is built key by key — that is the redaction mechanism — so a
// journal field cannot leak into the artifact by omission: only derived
// counts, canonical GATE:/VERDICT: marker lines, a one-way task handle, and
// two shas survive. The raw session ID, prompt text, dispatch descriptions,
// and bash command text never appear.
//
// Journal resolution precedence (mirrors config.ts's env → file → default):
//   TURNSTILE_METRICS_DIR  →  TURNSTILE_CONFIG's metricsDir  →  ~ default
// The journal file is `turnstile.jsonl`; its rotated generations
// (`${journal}.1`, `.2`, …) are walked newest-first with an early stop, so the
// `replayTailLines` replay tail (default 2000) holds across all retained
// generations — replay parity with src/ledger.ts.
//
//   opencode-turnstile evidence [--task <session|latest>] [--format json|markdown]
//                               [--out <path>] [--validate <path>] [--help]
//
// `--task` defaults to `latest` (the session owning the last journaled line);
// `--format` defaults to `json`. `--out` writes the artifact (and, for a
// `.json` path, the sibling `.md` the Action posts) instead of stdout.
// `--validate` re-checks a committed artifact and writes nothing. An absent
// journal or a task not in the tail emits a `noJournal`/`noTask` document and
// exits 0. Unknown flags and unknown task ids exit 2.

import * as crypto from "node:crypto"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"

const USAGE = `Usage: opencode-turnstile evidence [--task <session|latest>] [--format json|markdown]
                                     [--out <path>] [--validate <path>] [--help]

Emit a shareable evidence summary for one task. Read-only: nothing is written
to the journal. The summary is a whitelist projection — derived counts,
canonical marker lines, and shas; session IDs, prompts, and command text never
appear.

Options:
  --task <session|latest>  Task to summarize (default: latest)
  --format json|markdown   Output format (default: json)
  --out <path>             Write to <path> (a .json path also writes the
                           sibling .md) instead of stdout
  --validate <path>        Re-check a committed artifact, write nothing
  --help                   Show this help`

const SCHEMA = "turnstile-evidence/v1"

/**
 * The default replay tail bound (lines). This mirrors the runtime config
 * default so the standalone script needs no TS source; a configured
 * `replayTailLines` in the config file overrides it.
 */
const DEFAULT_REPLAY_TAIL_LINES = 2000

/**
 * The reviewer-ensemble size (src/state.ts `REVIEW_ENSEMBLE_SIZE`). The
 * standalone script cannot import TS source, so the constant is copied: under
 * the default `enforce` mode the landing gate credits at two unwaived reviewer
 * dispatches, so that is the bar the artifact reports against.
 */
const REVIEW_ENSEMBLE_SIZE = 2

/**
 * The default `reviewEnsemble` mode (src/config.ts). `enforce` requires the
 * full ensemble; `advise` credits a single reviewer APPROVE, so the reported
 * bar is one.
 */
const DEFAULT_REVIEW_ENSEMBLE = "enforce"

/**
 * Host session-ID alphabet, length-capped. Mirrors the canonical constant in
 * src/ledger.ts (this standalone script cannot import TS source): a session
 * whose ID fails the shape is not a session, so a hostile journal line mints no
 * task key.
 */
const REPLAY_SESSION_RE = /^[A-Za-z0-9._-]{1,64}$/

/**
 * The canonical marker pair, rebuilt from the parser shape in src/markers.ts.
 * A journaled `marker` string is emitted only when it matches this verbatim;
 * an oversized or free-text marker (the journaled field is length-bounded)
 * degrades to null, so the artifact carries counts, canonical marker lines,
 * and shas only — never free text.
 */
const MARKER_OK =
  /^(?:GATE: (?:PASS|FAIL) tests=\d+ passed=\d+ failed=\d+|VERDICT: (?:APPROVE|BLOCK) crit=\d+ high=\d+ med=\d+ low=\d+)$/

/** The one-way task-handle shape: `t-` plus 8 hex chars. */
const TASK_RE = /^t-[0-9a-f]{8}$/

/** The journal-head sha shape: `sha256:` plus 12 hex chars. */
const HEAD_RE = /^sha256:[0-9a-f]{12}$/

/** ISO-8601 UTC timestamp (or empty: a fold that saw no timestamped entry). */
const TS_RE = /^(?:\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z)$/

/** The journaled plan provenance literals the emitter may copy into `plan.source`. */
const SOURCE_OK = /^(?:session-prompt|task-result|child-message|child-text|child-text-delta)$/

/** The gate-evidence modes the runtime journals on a gate entry. */
const GATE_MODE_OK = /^(?:enforce|flag|off)$/

/** Plan verdicts and gate results the artifact may carry. */
const PLAN_VERDICT_OK = /^(?:APPROVE|BLOCK|STALE)$/
const TEST_RESULT_OK = /^(?:PASS|FAIL)$/

/** The rotated-generation basenames the journal may report. */
const JOURNAL_FILE_OK = /^turnstile\.jsonl(?:\.\d+)?$/

/**
 * Keys that must never appear anywhere in a published artifact: they name the
 * journal fields SECURITY.md treats as sensitive. The set is the whole leak
 * surface, so a leak must be deliberately re-keyed to survive it.
 */
const FORBIDDEN_KEYS = new Set(["sessionID", "raw", "command", "description", "waiver", "error"])

/**
 * Resolves the default metrics directory (copy of the journaler default so the
 * standalone script needs no TS source). Honors an absolute XDG_DATA_HOME or
 * HOME; anything relative falls back to the OS-provided value.
 * @param {Record<string, string | undefined>} env Environment to consult.
 * @returns {string} The absolute default metrics directory.
 */
function defaultMetricsDir(env) {
  const abs = (v) => (typeof v === "string" && path.isAbsolute(v) ? v : undefined)
  const home = abs(env.HOME) ?? os.homedir()
  const base = abs(env.XDG_DATA_HOME) ?? path.join(home, ".local/share")
  return path.join(base, "opencode", "metrics")
}

/**
 * Reads and parses the config file the config layer uses, silently tolerating
 * a missing or malformed file (fail-open). Returns `null` when nothing usable
 * is present.
 * @param {NodeJS.ProcessEnv} env The process environment.
 * @returns {Record<string, unknown> | null} The parsed config object, or null.
 */
function loadConfigFile(env) {
  const configPath =
    env.TURNSTILE_CONFIG ?? path.join(os.homedir(), ".config", "opencode", "turnstile.json")
  try {
    const cfg = JSON.parse(fs.readFileSync(configPath, "utf8"))
    return cfg && typeof cfg === "object" && !Array.isArray(cfg) ? cfg : null
  } catch {
    return null
  }
}

/**
 * Validates a configured `replayTailLines`. Only a finite positive integer is
 * accepted; anything else falls back to the default.
 * @param {unknown} value The raw `replayTailLines` from the config file.
 * @returns {number} The validated tail bound.
 */
function resolveReplayTailLines(value) {
  return Number.isInteger(value) && value > 0 ? value : DEFAULT_REPLAY_TAIL_LINES
}

/**
 * Validates a configured `reviewEnsemble`. Only the two mode literals are
 * accepted; anything else falls back to the default so the review bar degrades
 * rather than misphasing (mirrors the replay-tail junk rejection).
 * @param {unknown} value The raw `reviewEnsemble` from the config file.
 * @returns {"enforce" | "advise"} The validated ensemble mode.
 */
function resolveReviewEnsemble(value) {
  return value === "advise" ? "advise" : DEFAULT_REVIEW_ENSEMBLE
}

/**
 * The reviewer bar the artifact reports against: the ensemble size the
 * runtime itself credits at, not the dispatch cap — `maxReviewerRounds` bounds
 * how many reviewer dispatches may happen, while the ensemble decides when the
 * review requirement is satisfied (two unwaived dispatches under `enforce`, a
 * single reviewer APPROVE under `advise`). Deriving the bar from the cap made
 * a fully-credited two-dispatch ensemble render `reviewer 2/4` red on any
 * machine whose config raised the cap.
 * @param {"enforce" | "advise"} mode The resolved ensemble mode.
 * @returns {number} The reviewer count the green rule requires.
 */
function ensembleBar(mode) {
  return mode === "advise" ? 1 : REVIEW_ENSEMBLE_SIZE
}

/**
 * Resolves the metrics directory and the two config values the evidence
 * surface uses. The config file is parsed once (silently-failing, fail-open)
 * and always supplies the tail bound and the ensemble mode; the
 * TURNSTILE_METRICS_DIR env overrides only the metrics directory (precedence
 * env → file → default).
 * @param {NodeJS.ProcessEnv} env The process environment.
 * @returns {{ metricsDir: string, replayTailLines: number, reviewEnsemble: "enforce" | "advise" }} The resolved values.
 */
function resolveConfig(env) {
  const config = loadConfigFile(env)
  const envDir =
    typeof env.TURNSTILE_METRICS_DIR === "string" && env.TURNSTILE_METRICS_DIR
      ? env.TURNSTILE_METRICS_DIR
      : ""
  const fileDir =
    config && typeof config.metricsDir === "string" && config.metricsDir ? config.metricsDir : ""
  const metricsDir = envDir || fileDir || defaultMetricsDir(env)
  return {
    metricsDir,
    replayTailLines: resolveReplayTailLines(config?.replayTailLines),
    reviewEnsemble: resolveReviewEnsemble(config?.reviewEnsemble),
  }
}

/**
 * Reads the journal's retained generations as a single oldest-first line
 * stream: a newest-first walk over `turnstile.jsonl`, then `.1`, `.2`, …
 * (stopping at the first missing generation — a missing current file is the
 * post-rotation state, so the walk starts at `.1`), stopping as soon as the
 * collected lines satisfy the `replayTailLines` tail bound. Silently tolerates
 * missing generations.
 * @param {string} journalPath Absolute path of `turnstile.jsonl`.
 * @param {number} tailLines The replay tail bound in lines to keep.
 * @returns {{ files: string[], lines: string[] }} The files read (oldest-first
 *     basenames) and their tail-bounded lines, oldest-first.
 */
function readJournal(journalPath, tailLines) {
  if (tailLines <= 0) return { files: [], lines: [] }
  const blocks = []
  let generation = fs.existsSync(journalPath) ? 0 : 1
  for (;;) {
    const file = generation === 0 ? journalPath : `${journalPath}.${generation}`
    if (!fs.existsSync(file)) break
    blocks.unshift({
      name: path.basename(file),
      lines: fs.readFileSync(file, "utf8").split("\n").filter(Boolean),
    })
    if (blocks.reduce((total, b) => total + b.lines.length, 0) >= tailLines) break
    generation++
  }
  return {
    files: blocks.map((b) => b.name),
    lines: blocks.flatMap((b) => b.lines).slice(-tailLines),
  }
}

/**
 * True when a journal entry is exit-0 evidence: the journaled `exit` is 0
 * (numeric or the string "0", mirroring the tool hook's coercion).
 * @param {Record<string, unknown>} entry A parsed `evidence` journal entry.
 * @returns {boolean} Whether the entry records an exit-0 run.
 */
function isExitZero(entry) {
  const e = entry.exit
  return e === 0 || e === "0"
}

/**
 * The red/green rule for one task: the plan approved, the gate passed, the
 * pass is not an unverified enforce-mode claim, and the reviewer ensemble is
 * complete. The unverified clause is the same rule status.mjs applies, so a
 * PASS with no correlated exit-0 run is reported red.
 * @param {Record<string, unknown>} plan The folded plan section.
 * @param {Record<string, unknown>} tests The folded tests section.
 * @param {Record<string, unknown>} review The folded review section.
 * @returns {boolean} Whether the task is green.
 */
function greenRule(plan, tests, review) {
  return (
    plan.verdict === "APPROVE" &&
    tests.result === "PASS" &&
    !(tests.verified === false && tests.mode !== "flag") &&
    review.approves >= review.expected
  )
}

/**
 * Folds one task's journaled entries into the document's sections, reusing
 * status.mjs's last-wins rules: a trailing `GATE: FAIL` keeps the gate red, an
 * enforce-mode `verified:false` PASS never flips, and a plan BLOCK/STALE keeps
 * the plan red. Malformed lines and lines whose sessionID fails the shape
 * check are skipped before any fold.
 * @param {Record<string, unknown>} acc The task-window accumulator.
 * @returns {{ plan: Record<string, unknown>, tests: Record<string, unknown>, review: Record<string, number>, waivers: number, blocks: number, dispatches: number, exitZeroRuns: number }}
 *     The folded sections and running counts.
 */
function foldTask(acc) {
  let planResult = null
  let planStale = false
  let planSource = null
  let planTs = ""
  let planMarker = ""
  let verdictResult = null
  let verdictMarker = ""
  let verdictTs = ""
  let gateResult = undefined
  let gateVerified = undefined
  let gateMode = undefined
  let gateMarker = ""
  let gateTs = ""
  let dispatches = 0
  let blocks = 0
  let waivers = 0
  let exitZeroRuns = 0
  // The ensemble fold mirrors src/ledger.ts's replay (foldEnsemble +
  // restoreHumanGrants): `ensemble` entries carry the RUNNING dispatch count,
  // so last-wins — not summation — is the honest read. Summing the running
  // counts reported a two-dispatch, fully-credited ensemble as three approvals.
  let lastEnsembleCount = null
  let lastEnsembleStamp = undefined

  for (const e of acc.entries) {
    const type = e.type
    const result = e.result
    if (type === "gate") {
      if (result === "PASS" || result === "FAIL") {
        gateResult = result
        if (typeof e.marker === "string" && e.marker) {
          gateMarker = e.marker
          gateTs = typeof e.ts === "string" ? e.ts : ""
        }
        if (e.verified !== undefined) {
          gateVerified = e.verified
          gateMode = e.mode
        }
      } else if (result === "WAIVED") {
        waivers++
      }
    } else if (type === "plan") {
      if (result === "APPROVE" || result === "BLOCK" || result === "STALE") {
        planResult = result
        planStale = result === "STALE"
        planSource = typeof e.source === "string" ? e.source : null
        planTs = typeof e.ts === "string" ? e.ts : ""
        planMarker = typeof e.marker === "string" ? e.marker : ""
      } else if (result === "WAIVED") {
        waivers++
      }
    } else if (type === "verdict") {
      const marker = typeof e.marker === "string" ? e.marker : ""
      const r = marker.includes("APPROVE") ? "APPROVE" : "BLOCK"
      verdictResult = r
      verdictMarker = marker
      verdictTs = typeof e.ts === "string" ? e.ts : ""
      if (typeof e.source === "string" && e.source) planSource = e.source
    } else if (type === "dispatch") {
      if (e.blocked !== true) dispatches++
    } else if (type === "blocked") {
      blocks++
    } else if (type === "evidence") {
      if (isExitZero(e)) exitZeroRuns++
    } else if (type === "ensemble") {
      const count = e.count
      if (Number.isInteger(count) && count >= 0) {
        lastEnsembleCount = Math.min(count, acc.expected)
        // The refusal stamp follows the last valid entry: an explicit `true`
        // suppresses the credit, an explicit `false` is the human grant's
        // clearing stamp (a release outranks the mechanical ensemble), and an
        // absent field un-stamps a prior refusal.
        if (e.refusedApprove === true) lastEnsembleStamp = true
        else if (e.refusedApprove === false) lastEnsembleStamp = false
        else lastEnsembleStamp = undefined
      }
    }
  }

  const verdict = verdictResult ?? planResult ?? null
  // A STALE plan with no other result reports STALE so the document's verdict
  // stays one of the three allowed literals (a stale plan is, by definition,
  // not an approval).
  const shownVerdict = planStale && verdict === null ? "STALE" : verdict
  // The plan marker is the canonical VERDICT/GATE marker: prefer the verdict
  // entry's marker, fall back to the plan entry's marker, else null.
  const planMarkerOut = MARKER_OK.test(verdictMarker)
    ? verdictMarker
    : MARKER_OK.test(planMarker)
      ? planMarker
      : null
  // The review credit is the runtime's own rule, encoded in the count so the
  // green rule stays a pure read of the document: the ensemble is satisfied at
  // the bar (with the last stamp not a refusal), or the human release cleared
  // one — a release outranks the mechanical ensemble, so the artifact reports
  // the review requirement as satisfied by the same decision the gate took.
  // When credit is suppressed (a refusal stamp, or the bar unmet) the count is
  // capped under the bar, so `approves >= expected` cannot be true.
  const humanRelease = lastEnsembleStamp === false
  const credited =
    humanRelease ||
    (lastEnsembleCount !== null && lastEnsembleCount >= acc.expected && lastEnsembleStamp !== true)
  const approves = humanRelease
    ? acc.expected
    : credited
      ? Math.min(lastEnsembleCount ?? 0, acc.expected)
      : Math.min(lastEnsembleCount ?? 0, acc.expected - 1)
  const plan = {
    verdict: shownVerdict,
    marker: planMarkerOut,
    at: verdictTs || planTs,
    source: planSource,
    stale: planStale,
  }
  const tests = {
    result: gateResult,
    marker: MARKER_OK.test(gateMarker) ? gateMarker : null,
    at: gateTs,
    // A journaled `verified`/`mode` is emitted only when it is one of the
    // whitelisted shapes (a boolean / a gate-evidence mode), degrading to null
    // exactly as the markers do — a hostile string cannot leak into the
    // artifact and fail the document's own --validate.
    verified: typeof gateVerified === "boolean" ? gateVerified : null,
    mode: typeof gateMode === "string" && GATE_MODE_OK.test(gateMode) ? gateMode : null,
    exitZeroRuns,
  }
  return {
    plan,
    tests,
    review: { approves, expected: acc.expected },
    waivers,
    blocks,
    dispatches,
    exitZeroRuns,
  }
}

/**
 * Projects one task window into the `turnstile-evidence/v1` document. The
 * document is built key by key from whitelisted values, so a journal field
 * cannot leak by omission; the task is named by a one-way handle (a sha256
 * of the session ID, truncated) and the journal by the sha256 of its last
 * line.
 * @param {{ entries: Record<string, unknown>[], head: string | null, expected: number }} window
 *     The task's journaled entries, the journal-head line, and the reviewer bar.
 * @param {string} sessionID The parent session the task is named after.
 * @returns {Record<string, unknown>} The emitted document.
 */
function buildDoc(window, sessionID) {
  const hash = (s) => crypto.createHash("sha256").update(s).digest("hex")
  const { plan, tests, review, waivers, blocks, dispatches } = foldTask(window)
  return {
    schema: SCHEMA,
    generatedAt: new Date(0).toISOString(),
    noJournal: false,
    noTask: false,
    task: "t-" + hash(sessionID).slice(0, 8),
    green: greenRule(plan, tests, review),
    plan,
    tests,
    review,
    waivers,
    blocks,
    dispatches,
    journal: {
      files: window.files,
      lines: window.lines,
      head: window.head === null ? null : "sha256:" + hash(window.head).slice(0, 12),
    },
  }
}

/**
 * The degraded document emitted when there is no journal or no task in the
 * tail. It carries the schema and the honest flags the validator re-checks.
 * @param {{ noJournal: boolean, noTask: boolean, files: string[], lines: number, head: string | null, expected: number }} info
 *     The document's flags and the (empty) journal window.
 * @returns {Record<string, unknown>} The degraded document.
 */
function emptyDoc(info) {
  return {
    schema: SCHEMA,
    generatedAt: new Date(0).toISOString(),
    noJournal: info.noJournal,
    noTask: info.noTask,
    task: null,
    green: false,
    plan: { verdict: null, marker: null, at: "", source: null, stale: false },
    tests: { result: null, marker: null, at: "", verified: null, mode: null, exitZeroRuns: 0 },
    review: { approves: 0, expected: info.expected },
    waivers: 0,
    blocks: 0,
    dispatches: 0,
    journal: { files: info.files, lines: info.lines, head: info.head },
  }
}

/**
 * The red badge's first clause: the first failing dimension in rule order
 * (plan, tests, review), so a red badge names what failed rather than hiding
 * it.
 * @param {Record<string, unknown>} doc The emitted document.
 * @returns {string} The failing-dimension clause.
 */
function redReason(doc) {
  if (doc.plan.verdict !== "APPROVE") {
    if (doc.plan.verdict === "BLOCK") return "plan blocked"
    if (doc.plan.verdict === "STALE") return "plan stale"
    return "plan not approved"
  }
  if (doc.tests.result !== "PASS") return "tests failed"
  if (doc.tests.verified === false && doc.tests.mode !== "flag")
    return "tests claimed but unverified (no correlated exit-0 run)"
  return `review incomplete (${doc.review.approves}/${doc.review.expected})`
}

/**
 * Renders the document's sticky-comment body. This is the single render
 * function: the emitter writes it to the sibling `.md`, and the validator
 * re-renders it from a committed document to require a byte match (posted
 * bytes are therefore validated by construction).
 * @param {Record<string, unknown>} doc The document to render.
 * @returns {string} The Markdown comment body.
 */
function render(doc) {
  const plan = doc.plan
  const tests = doc.tests
  const review = doc.review
  const badge = doc.green ? "✓" : "✗"
  const head2 = doc.green
    ? `> **turnstile ${badge}** — plan approved, tests verified, reviewer ${review.approves}/${review.expected}.`
    : `> **turnstile ${badge}** — ${redReason(doc)}`
  const marks = [
    plan.marker ? `\`${plan.marker}\`` : null,
    tests.marker ? `\`${tests.marker}\`` : null,
  ].filter(Boolean)
  const parts = [`${tests.exitZeroRuns} exit-0 run${tests.exitZeroRuns === 1 ? "" : "s"}`]
  if (doc.task) parts.push(`task \`${doc.task}\``)
  if (doc.journal && doc.journal.head) parts.push(`journal head \`${doc.journal.head}\``)
  let line3 = `> ${marks.join(" · ") || "no canonical marker"} · ${parts.join(" · ")}`
  const extras = []
  if (doc.waivers > 0) extras.push(`· waivers ${doc.waivers}`)
  if (doc.blocks > 0) extras.push(`· blocks ${doc.blocks}`)
  if (extras.length) line3 += ` ${extras.join(" ")}`
  return [
    "<!-- turnstile:evidence -->",
    head2,
    line3,
    ">",
    "> _Not proof: a correlated claim from the local journal. Ask for the journal to audit._",
  ].join("\n")
}

/**
 * Collects every forbidden key path (the sensitive set) at any depth,
 * including keys nested inside array elements.
 * @param {unknown} node The document (or a subtree) to scan.
 * @param {string} prefix The dotted key path to the subtree.
 * @param {string[]} found Accumulator of offending key paths.
 */
function walkForbidden(node, prefix, found) {
  if (Array.isArray(node)) {
    node.forEach((el, i) => walkForbidden(el, `${prefix}[${i}]`, found))
    return
  }
  if (node && typeof node === "object") {
    for (const [k, v] of Object.entries(node)) {
      const p = prefix ? `${prefix}.${k}` : k
      if (FORBIDDEN_KEYS.has(k)) found.push(p)
      walkForbidden(v, p, found)
    }
  }
}

/**
 * Counts that must be non-negative safe integers.
 * @param {unknown} v The value to check.
 * @returns {boolean} Whether it is a non-negative safe integer.
 */
function isCount(v) {
  return typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= Number.MAX_SAFE_INTEGER
}

/**
 * True when a value is a plain object (not null, not an array) — the shape the
 * three evidence sections must carry for the green rule and the sibling render.
 * `typeof null === "object"`, so the null and array cases are excluded by name.
 * @param {unknown} v The value to check.
 * @returns {boolean} Whether it is a plain object.
 */
function isPlainObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v)
}

/**
 * Applies rules 5–7 (the per-key shape and pattern checks) to a document,
 * naming every offending key path. This is the same source of truth the
 * emitter's patterns come from, so a re-keyed leak or a smuggled value in a
 * permitted key is caught by construction.
 * @param {Record<string, unknown>} doc The parsed artifact.
 * @returns {string[]} The offending rule names and key paths.
 */
function checkShapes(doc) {
  const v = []
  const str = (x) => typeof x === "string"
  const bool = (x) => typeof x === "boolean"
  // A task document must carry all three sections; a degraded document
  // (noTask/noJournal) is exempt from the section-shape requirement below.
  const taskDoc = !doc.noTask && !doc.noJournal
  const TOP = new Set([
    "schema",
    "generatedAt",
    "noJournal",
    "noTask",
    "task",
    "green",
    "plan",
    "tests",
    "review",
    "waivers",
    "blocks",
    "dispatches",
    "journal",
  ])
  for (const k of Object.keys(doc)) if (!TOP.has(k)) v.push(`unknown key ${k}`)

  if (doc.schema !== SCHEMA) v.push(`schema must be "${SCHEMA}"`)
  if (!str(doc.generatedAt) || !TS_RE.test(doc.generatedAt)) v.push("generatedAt: bad timestamp")
  if (!bool(doc.noJournal) || !bool(doc.noTask)) v.push("noJournal/noTask must be booleans")
  if (doc.task !== null && !TASK_RE.test(doc.task)) v.push(`task ${doc.task}: bad handle`)
  if (!bool(doc.green)) v.push("green must be a boolean")

  for (const k of ["waivers", "blocks", "dispatches"])
    if (!isCount(doc[k])) v.push(`${k}: must be a non-negative integer`)

  const PLAN = new Set(["verdict", "marker", "at", "source", "stale"])
  if (isPlainObject(doc.plan)) {
    const p = doc.plan
    for (const k of Object.keys(p)) if (!PLAN.has(k)) v.push(`plan.${k}: unknown key`)
    if (p.verdict !== null && !PLAN_VERDICT_OK.test(p.verdict))
      v.push(`plan.verdict ${p.verdict}: not APPROVE/BLOCK/STALE`)
    if (p.marker !== null && !MARKER_OK.test(p.marker))
      v.push("plan.marker: not a canonical marker")
    if (!str(p.at) || !TS_RE.test(p.at)) v.push("plan.at: bad timestamp")
    if (p.source !== null && !SOURCE_OK.test(p.source))
      v.push(`plan.source ${p.source}: not a provenance literal`)
    if (!bool(p.stale)) v.push("plan.stale must be a boolean")
  } else if (taskDoc) {
    v.push("plan: must be a plain object")
  }

  const TESTS = new Set(["result", "marker", "at", "verified", "mode", "exitZeroRuns"])
  if (isPlainObject(doc.tests)) {
    const t = doc.tests
    for (const k of Object.keys(t)) if (!TESTS.has(k)) v.push(`tests.${k}: unknown key`)
    if (t.result !== null && !TEST_RESULT_OK.test(t.result))
      v.push(`tests.result ${t.result}: not PASS/FAIL`)
    if (t.marker !== null && !MARKER_OK.test(t.marker))
      v.push("tests.marker: not a canonical marker")
    if (!str(t.at) || !TS_RE.test(t.at)) v.push("tests.at: bad timestamp")
    if (t.verified !== null && t.verified !== undefined && !bool(t.verified))
      v.push("tests.verified must be a boolean")
    if (t.mode !== null && t.mode !== undefined && !GATE_MODE_OK.test(t.mode))
      v.push(`tests.mode ${t.mode}: not a gate-evidence mode`)
    if (!isCount(t.exitZeroRuns)) v.push("tests.exitZeroRuns: must be a non-negative integer")
  } else if (taskDoc) {
    v.push("tests: must be a plain object")
  }

  const REV = new Set(["approves", "expected"])
  if (isPlainObject(doc.review)) {
    for (const k of Object.keys(doc.review)) if (!REV.has(k)) v.push(`review.${k}: unknown key`)
    if (!isCount(doc.review.approves)) v.push("review.approves: must be a non-negative integer")
    if (!isCount(doc.review.expected)) v.push("review.expected: must be a non-negative integer")
  } else if (taskDoc) {
    v.push("review: must be a plain object")
  }

  const J = new Set(["files", "lines", "head"])
  if (doc.journal && typeof doc.journal === "object" && !Array.isArray(doc.journal)) {
    for (const k of Object.keys(doc.journal)) if (!J.has(k)) v.push(`journal.${k}: unknown key`)
    if (!Array.isArray(doc.journal.files)) v.push("journal.files must be a list")
    else
      for (const f of doc.journal.files)
        if (!JOURNAL_FILE_OK.test(f)) v.push(`journal.files ${f}: bad basename`)
    if (!isCount(doc.journal.lines)) v.push("journal.lines: must be a non-negative integer")
    if (doc.journal.head !== null && !HEAD_RE.test(doc.journal.head))
      v.push("journal.head: bad sha")
  }

  return v
}

/**
 * Walks every object except `plan`/`tests` and flags a `marker` key there: a
 * marker is legitimate payload under those two keys only, so a marker anywhere
 * else is an unknown key, not a leak (the six forbidden names are a separate
 * rule).
 * @param {unknown} node The subtree to scan (plan/tests are pruned by the caller).
 * @param {string} prefix The dotted key path to the subtree.
 * @param {string[]} found Accumulator of offending key paths.
 */
function walkMarkerKeys(node, prefix, found) {
  if (Array.isArray(node)) {
    node.forEach((el, i) => walkMarkerKeys(el, `${prefix}[${i}]`, found))
    return
  }
  if (node && typeof node === "object") {
    for (const [k, val] of Object.entries(node)) {
      const p = prefix ? `${prefix}.${k}` : k
      if (k === "marker") found.push(`${p}: marker key outside plan/tests`)
      walkMarkerKeys(val, p, found)
    }
  }
}

/**
 * Re-renders a validated document and requires a byte match against the
 * sibling `.md` next to the artifact. The emitter is deterministic and shares
 * this render function, so a hand-edited or re-keyed markdown body fails.
 * @param {Record<string, unknown>} doc The parsed artifact.
 * @param {string} jsonPath The artifact path (to locate the sibling).
 * @returns {string[]} The violation names (empty when the sibling matches).
 */
function checkSiblingMd(doc, jsonPath) {
  const dir = path.dirname(jsonPath)
  const base = path.basename(jsonPath)
  const mdPath = path.join(dir, base.replace(/\.json$/, "") + ".md")
  let sibling
  try {
    sibling = fs.readFileSync(mdPath, "utf8")
  } catch {
    sibling = null
  }
  if (sibling === null) return ["sibling markdown missing"]
  // The emitter always writes the render plus a trailing newline, so the byte
  // match includes it: a hand-trimmed or re-keyed body fails.
  return sibling === render(doc) + "\n" ? [] : ["sibling markdown does not match"]
}

/**
 * Applies every `--validate` rule to a parsed document in order, naming each
 * failing rule. The emitted document always passes: the rules are the emitter
 * contract made checkable. The green rule recomputes from the document's own
 * fields (its `review` section is self-describing), not from local config.
 * @param {Record<string, unknown>} doc The parsed artifact.
 * @param {string} jsonPath The artifact path.
 * @returns {string[]} The failing rule names (empty when the artifact is valid).
 */
function validateDoc(doc, jsonPath) {
  const v = []
  if (doc.schema !== SCHEMA) v.push(`rule1: schema must be "${SCHEMA}"`)
  if (doc.noTask) {
    if (doc.task !== null) v.push("rule2: noTask requires task null")
  } else if (typeof doc.task !== "string" || !TASK_RE.test(doc.task)) {
    v.push("rule2: task is not a t-<8 hex> handle")
  }
  if (doc.noJournal) {
    if (doc.journal && doc.journal.head !== null)
      v.push("rule3: noJournal requires journal.head null")
  } else if (
    doc.journal == null ||
    typeof doc.journal.head !== "string" ||
    !HEAD_RE.test(doc.journal.head)
  ) {
    v.push("rule3: journal.head is not a sha256:<12 hex> value")
  }
  if (typeof doc.green !== "boolean") {
    v.push("rule4: green must be a boolean")
  } else if (!doc.noTask && !doc.noJournal) {
    // The green rule reads plan.verdict / tests.result / review.approves, so it
    // runs only when all three sections are plain objects. `typeof null ===
    // "object"` would otherwise let a null section reach the rule and throw; a
    // non-object section is named by rule7 (checkShapes) instead, so rule4
    // never crashes and never silently skips on a task document.
    if (isPlainObject(doc.plan) && isPlainObject(doc.tests) && isPlainObject(doc.review)) {
      const re = greenRule(doc.plan, doc.tests, doc.review)
      if (doc.green !== re)
        v.push("rule4: green does not match the rule recomputed from the document")
    }
  }
  const forbidden = []
  walkForbidden(doc, "", forbidden)
  for (const p of forbidden) v.push(`rule5: forbidden key ${p}`)
  const shapes = checkShapes(doc)
  if (shapes.length) v.push(`rule7: ${shapes.join("; ")}`)
  const strayMarkers = []
  walkMarkerKeys({ ...doc, plan: undefined, tests: undefined }, "", strayMarkers)
  for (const p of strayMarkers) v.push(`rule6: ${p}`)
  // The sibling re-render reads plan/tests/review fields, so it runs only when
  // those sections are plain objects; a malformed section is already named by
  // rule7, and re-rendering it would throw rather than report.
  if (
    !doc.noTask &&
    !doc.noJournal &&
    isPlainObject(doc.plan) &&
    isPlainObject(doc.tests) &&
    isPlainObject(doc.review)
  ) {
    v.push(...checkSiblingMd(doc, jsonPath))
  }
  return v
}

/**
 * Parses the evidence arguments. Recognizes --task, --format, --out,
 * --validate, and --help; a conflict or an unknown flag throws (exit 2).
 * @param {string[]} argv Arguments after the `evidence` subcommand.
 * @returns {{ task: string | null, format: string, out: string | null, validate: string | null, help: boolean }} Parsed flags.
 */
function parseArgs(argv) {
  const flags = { task: null, format: "json", out: null, validate: null, help: false }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    const val = () => {
      const v = argv[++i]
      if (v === undefined) throw new Error(`missing value for ${a}`)
      return v
    }
    if (a === "--task") flags.task = val()
    else if (a === "--format") flags.format = val()
    else if (a === "--out") flags.out = val()
    else if (a === "--validate") flags.validate = val()
    else if (a === "--help") flags.help = true
    else throw new Error(`unknown argument "${a}"`)
  }
  if (flags.out !== null && flags.validate !== null)
    throw new Error("--out and --validate are mutually exclusive")
  if (flags.task !== null && !REPLAY_SESSION_RE.test(flags.task) && flags.task !== "latest")
    throw new Error(`unknown task "${flags.task}"`)
  if (flags.format !== "json" && flags.format !== "markdown")
    throw new Error(`unknown format "${flags.format}"`)
  return flags
}

/**
 * Runs the `--validate` path: parse the committed artifact, apply every rule,
 * and report each failing rule on stderr. Writes nothing.
 * @param {string} jsonPath The artifact path.
 * @returns {Promise<number>} The process exit code (0 valid, 1 invalid).
 */
async function runValidate(jsonPath) {
  let raw
  try {
    raw = fs.readFileSync(jsonPath, "utf8")
  } catch {
    process.stderr.write(`cannot read ${jsonPath}\n`)
    return 1
  }
  let doc
  try {
    doc = JSON.parse(raw)
  } catch {
    process.stderr.write(`${jsonPath} is not valid JSON\n`)
    return 1
  }
  if (!doc || typeof doc !== "object" || Array.isArray(doc)) {
    process.stderr.write(`${jsonPath} is not a JSON object\n`)
    return 1
  }
  const problems = validateDoc(doc, jsonPath)
  if (problems.length === 0) {
    process.stdout.write(`OK: ${basePath(jsonPath)} is a valid turnstile-evidence/v1 document\n`)
    return 0
  }
  for (const p of problems) process.stderr.write(`invalid: ${p}\n`)
  return 1
}

/**
 * The base name of a path (for the validation OK line).
 * @param {string} p A file path.
 * @returns {string} The base name.
 */
function basePath(p) {
  return path.basename(p)
}

/**
 * Writes the document per `--out`/`--format`, creating the destination
 * directory. For a `.json` out path the sibling `.md` is written too (the
 * posted body); otherwise only the requested format is written.
 * @param {string} out The `--out` path.
 * @param {string} format The `--format` value.
 * @param {Record<string, unknown>} doc The document to write.
 * @returns {Promise<number>} The process exit code (0 written, 1 on failure).
 */
async function writeOut(out, format, doc) {
  try {
    const dir = path.dirname(out)
    fs.mkdirSync(dir, { recursive: true })
    const isJson = out.endsWith(".json")
    if (isJson) {
      fs.writeFileSync(out, JSON.stringify(doc, null, 2) + "\n")
      const md = out.slice(0, -".json".length) + ".md"
      fs.writeFileSync(md, render(doc) + "\n")
    } else {
      const text = format === "json" ? JSON.stringify(doc, null, 2) + "\n" : render(doc) + "\n"
      fs.writeFileSync(out, text)
    }
    return 0
  } catch (e) {
    process.stderr.write(`cannot write ${out}: ${e instanceof Error ? e.message : String(e)}\n`)
    return 1
  }
}

/**
 * Entry point. Parses args, resolves the journal, selects the task, folds and
 * renders the document, and prints or writes it (or validates, when given).
 * @param {string[]} argv Arguments after the `evidence` subcommand.
 * @returns {Promise<number>} The process exit code.
 */
async function main(argv) {
  let flags
  try {
    flags = parseArgs(argv)
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    process.stderr.write(`${msg}\n`)
    process.stderr.write(USAGE.replace(/^/gm, "  ") + "\n")
    return 2
  }
  if (flags.help) {
    process.stdout.write(`${USAGE}\n`)
    return 0
  }

  const { metricsDir, replayTailLines, reviewEnsemble } = resolveConfig(process.env)
  const bar = ensembleBar(reviewEnsemble)

  if (flags.validate !== null) {
    return runValidate(flags.validate)
  }

  const journalPath = path.join(metricsDir, "turnstile.jsonl")
  const { files, lines } = readJournal(journalPath, replayTailLines)

  if (files.length === 0) {
    const doc = emptyDoc({
      noJournal: true,
      noTask: false,
      files: [],
      lines: 0,
      head: null,
      expected: bar,
    })
    return emit(flags, doc)
  }

  const bySession = new Map()
  let last = null
  for (const line of lines) {
    let e
    try {
      e = JSON.parse(line)
    } catch {
      continue
    }
    if (!e || typeof e !== "object" || Array.isArray(e)) continue
    const sid = e.sessionID
    if (typeof sid !== "string" || !REPLAY_SESSION_RE.test(sid)) continue
    if (!bySession.has(sid)) bySession.set(sid, { entries: [], head: line })
    const w = bySession.get(sid)
    w.entries.push(e)
    w.head = line
    last = { sid, line }
  }

  const taskArg = flags.task ?? "latest"
  const picked =
    taskArg === "latest" ? last : { sid: taskArg, line: null, present: bySession.has(taskArg) }

  if (taskArg !== "latest" && (!picked || !bySession.has(picked.sid))) {
    // An explicit id that names no session is an input error, not an empty
    // result: it fails loudly so a mistyped id is never mistaken for "no task".
    process.stderr.write(`unknown task "${taskArg}"\n`)
    process.stderr.write(USAGE.replace(/^/gm, "  ") + "\n")
    return 2
  }

  if (!picked || !bySession.has(picked.sid)) {
    const head = last ? last.line : null
    const doc = emptyDoc({
      noJournal: false,
      noTask: true,
      files,
      lines: lines.length,
      head:
        head === null
          ? null
          : "sha256:" + crypto.createHash("sha256").update(head).digest("hex").slice(0, 12),
      expected: bar,
    })
    return emit(flags, doc)
  }

  const win = bySession.get(picked.sid)
  const doc = buildDoc(
    {
      entries: win.entries,
      head: win.head,
      expected: bar,
      files,
      lines: lines.length,
    },
    picked.sid,
  )
  return emit(flags, doc)
}

/**
 * Prints or writes the document per the flags. `--out` writes (stdout stays
 * empty); otherwise the requested format goes to stdout.
 * @param {{ out: string | null, format: string }} flags The parsed flags.
 * @param {Record<string, unknown>} doc The document.
 * @returns {Promise<number>} The process exit code.
 */
async function emit(flags, doc) {
  if (flags.out !== null) return writeOut(flags.out, flags.format, doc)
  const text = flags.format === "json" ? JSON.stringify(doc, null, 2) + "\n" : render(doc) + "\n"
  process.stdout.write(text)
  return 0
}

main(process.argv.slice(2)).then((code) => process.exit(code ?? 0))
