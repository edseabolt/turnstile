/**
 * @fileoverview Test-overlap boundary: pure helpers behind the
 * `requireTestOverlap` gate corroboration — path-token extraction from
 * command lines and command stdout, cross-ecosystem test-file
 * classification over a configurable regex list, glob translation for the
 * exemption list, and the overlap computation itself. Leaf module: no
 * imports, no fs, no journal; throws nothing over its documented inputs.
 * The policy decision (what a zero overlap means) lives in
 * `src/verdict-capture.ts`; this module only computes the evidence.
 */

/**
 * The overlap evidence computed for one `GATE: PASS` evaluation, journaled
 * on the `type:"gate"` row whenever the computation ran: how many executed
 * test files and touched change-set files were seen, how many joined, and
 * either the exemption or skip reason when the rule did not apply.
 */
export interface TestOverlapEvidence {
  /** Number of executed test-file tokens extracted (both sources unioned). */
  executed: number
  /** Number of touched change-set paths recorded for the task window. */
  touched: number
  /** Executed files that join a touched path (0 = the zero-overlap case). */
  matched: number
  /** True when every touched path matched a `testOverlapExempt` glob. */
  exempt?: boolean
  /** Why the rule did not apply: `no-touched-files` or `no-test-files`. */
  skipped?: string
}

/**
 * Cap on path tokens extracted from one text (command line or stdout
 * window): a hostile or pathological output cannot balloon the scan.
 */
export const MAX_PATH_TOKENS = 64

/**
 * Default cross-ecosystem test-file classification list for
 * `testOverlapTestFilePattern` (regex sources, compiled with `"i"`).
 * Convention-based per ecosystem: JS/TS (`.test.` / `.spec.` / `tests/` /
 * `__tests__/`), Python (`test_*.py` / `*_test.py`), Go (`*_test.go`),
 * Rust (`tests/` / `*_test.rs`), Java/Kotlin (`*Test.java` / `*Tests.kt` /
 * `src/test/`), Ruby (`*_spec.rb` / `test/`), and C/C++ (`test_*.c…` /
 * `*_test.c…`). Config extends the list; it never has to replace it.
 */
export const DEFAULT_TEST_FILE_PATTERNS: readonly string[] = [
  "\\.test\\.[cm]?[jt]sx?$",
  "\\.spec\\.[cm]?[jt]sx?$",
  "(^|/)tests?/",
  "__tests__/",
  "(^|/)test_[^/]*\\.py$",
  "(^|/)[^/]*_test\\.py$",
  "(^|/)[^/]*_test\\.go$",
  "(^|/)[^/]*_test\\.rs$",
  "[^/]*Test\\.java$",
  "[^/]*Tests?\\.kt$",
  "src/test/",
  "(^|/)[^/]*_spec\\.rb$",
  "(^|/)test/",
  "(^|/)test_[^/]*\\.c(c|pp|xx|\\+\\+)?$",
  "(^|/)[^/]*_test\\.c(c|pp|xx|\\+\\+)?$",
]

/**
 * Translates a glob to a case-sensitive full-match RegExp: `**` matches
 * anything (including `/`), `*` matches within one segment, `?` matches one
 * non-separator character, everything else is escaped.
 * @param glob The glob source (e.g. `docs/**`, `**\/*.generated.ts`).
 * @returns The compiled regex, or null when the glob is empty/blank (the
 *     caller skips it — a silent skip keeps this module pure).
 */
export function globToRegExp(glob: string): RegExp | null {
  if (glob.trim().length === 0) return null
  let out = ""
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]!
    if (c === "*") {
      if (glob[i + 1] === "*") {
        out += ".*"
        i++
      } else {
        out += "[^/]*"
      }
    } else if (c === "?") {
      out += "[^/]"
    } else {
      out += c.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
    }
  }
  return new RegExp(`^${out}$`)
}

/**
 * Extracts path-like tokens from free text (a command line or a stdout
 * window): a token qualifies when it contains a path separator and ends
 * with a file extension. Tokens are split on whitespace and common
 * shell/log punctuation, deduped, and capped at `MAX_PATH_TOKENS`.
 * @param text The text to scan.
 * @returns The deduped path-like tokens in first-seen order.
 */
export function extractPathTokens(text: string): string[] {
  const tokens: string[] = []
  for (const raw of text.split(/[\s;,'"`()[\]{}|>&]+/)) {
    const token = raw.replace(/^[<("']+|[>)"',:]+$/g, "")
    if (!token.includes("/") || !/\.[^./]+$/.test(token)) continue
    if (!tokens.includes(token)) tokens.push(token)
    if (tokens.length >= MAX_PATH_TOKENS) break
  }
  return tokens
}

/**
 * Decides whether a path-like token is a test file under the configured
 * pattern list: any compiled pattern matching makes it test-ish. An
 * individual pattern that fails to compile is skipped (the tracker
 * boundary journals the drop at setup time; this pure layer stays silent).
 * @param token The path-like token to classify.
 * @param patterns The configured regex sources (compiled with `"i"`).
 * @returns True when any pattern matches the token.
 */
export function classifyTestFile(token: string, patterns: readonly string[]): boolean {
  for (const source of patterns) {
    try {
      if (new RegExp(source, "i").test(token)) return true
    } catch {
      // Invalid pattern: skipped here; the tracker boundary journals it.
    }
  }
  return false
}

/**
 * Extracts the executed test files for one command: the union of the
 * secondary source (path tokens in the command line itself) and the primary
 * source (path tokens in the command's stdout), filtered by
 * `classifyTestFile`, deduped, and capped at `MAX_PATH_TOKENS`.
 * @param commandText The command string (may be "").
 * @param stdout The command's output window (may be "").
 * @param patterns The configured test-file regex sources.
 * @returns The deduped test-file tokens in first-seen order.
 */
export function extractTestFiles(
  commandText: string,
  stdout: string,
  patterns: readonly string[],
): string[] {
  const files: string[] = []
  for (const token of [...extractPathTokens(commandText), ...extractPathTokens(stdout)]) {
    if (!classifyTestFile(token, patterns)) continue
    if (!files.includes(token)) files.push(token)
    if (files.length >= MAX_PATH_TOKENS) break
  }
  return files
}

/**
 * Normalizes a path for the overlap join: backslashes become posix
 * separators and a leading `./` is stripped. Case is preserved (the join
 * is suffix/segment based, so case differences degrade to a miss — the
 * under-block direction, never over-block).
 * @param p The path as written.
 * @returns The normalized posix-relative-ish path.
 */
function normalizePath(p: string): string {
  const posix = p.replace(/\\/g, "/")
  return posix.startsWith("./") ? posix.slice(2) : posix
}

/**
 * Whether two normalized paths name the same file: exact equality or a
 * whole-segment suffix join (an absolute touched path vs a relative
 * executed token, or the reverse).
 * @param a First normalized path.
 * @param b Second normalized path.
 * @returns True when the paths join.
 */
function pathsJoin(a: string, b: string): boolean {
  return a === b || a.endsWith(`/${b}`) || b.endsWith(`/${a}`)
}

/**
 * Whether one normalized path matches any exempt glob. A malformed glob
 * (empty/blank) is skipped silently by `globToRegExp`.
 * @param path The normalized path.
 * @param exempt The configured glob list.
 * @returns True when some glob matches the whole path.
 */
function isExempt(path: string, exempt: readonly string[]): boolean {
  return exempt.some((glob) => globToRegExp(glob)?.test(path) === true)
}

/**
 * Computes the overlap evidence for one `GATE: PASS` evaluation. Semantics:
 * an empty touched set (nothing written/edited) or an empty executed set
 * (no extractable test-file tokens from either source) skips the rule
 * (today's evidence behavior stands); a touched set entirely matching the
 * exempt globs is satisfied; otherwise `matched` counts executed files that
 * join a touched path on normalized (posix, relative-ish) paths.
 * @param executed The executed test-file tokens.
 * @param touched The touched change-set paths.
 * @param exempt The configured exemption globs.
 * @returns The overlap evidence (never throws).
 */
export function computeTestOverlap(
  executed: readonly string[],
  touched: readonly string[],
  exempt: readonly string[],
): TestOverlapEvidence {
  if (touched.length === 0) {
    return { executed: executed.length, touched: 0, matched: 0, skipped: "no-touched-files" }
  }
  if (executed.length === 0) {
    return { executed: 0, touched: touched.length, matched: 0, skipped: "no-test-files" }
  }
  const normTouched = touched.map(normalizePath)
  if (normTouched.every((p) => isExempt(p, exempt))) {
    return { executed: executed.length, touched: touched.length, matched: 0, exempt: true }
  }
  const normExecuted = executed.map(normalizePath)
  const matched = normExecuted.filter((e) => normTouched.some((t) => pathsJoin(e, t))).length
  return { executed: executed.length, touched: touched.length, matched }
}
