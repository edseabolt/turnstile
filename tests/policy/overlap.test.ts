/**
 * @fileoverview Test-overlap pure-boundary unit tests: glob translation,
 * path-token extraction, the cross-ecosystem test-file classification table,
 * the stdout/command-line union extraction, and the overlap computation
 * semantics (skip arms, exemption, zero-overlap violation, path joins).
 */

import { test } from "node:test"
import assert from "node:assert/strict"

import {
  computeTestOverlap,
  DEFAULT_TEST_FILE_PATTERNS,
  extractPathTokens,
  extractTestFiles,
  globToRegExp,
  MAX_PATH_TOKENS,
} from "../../src/policy/overlap.ts"

/** Compiles regex sources the way the tracker boundary does (with `"i"`). */
const compile = (sources: readonly string[]): RegExp[] => sources.map((s) => new RegExp(s, "i"))

/** zero overlap between executed tests and touched files is a violation. */
test("zero overlap is a violation", () => {
  const r = computeTestOverlap(["src/a.test.ts"], ["src/b.ts"], [])
  assert.equal(r.matched, 0)
  assert.ok(!r.exempt && !r.skipped)
  assert.equal(r.executed, 1)
  assert.equal(r.touched, 1)
})

/** an exempt glob list covering every touched path satisfies the rule. */
test("exempt glob satisfies", () => {
  const r = computeTestOverlap(["src/a.test.ts"], ["docs/guide.md"], ["docs/**"])
  assert.equal(r.exempt, true)
  assert.equal(r.matched, 0)
})

/** a partial exemption does not satisfy: one non-exempt touched file keeps
 *  the rule live (the exemption needs every touched path covered). */
test("partial exemption does not satisfy", () => {
  const r = computeTestOverlap(["src/a.test.ts"], ["docs/g.md", "src/b.ts"], ["docs/**"])
  assert.ok(!r.exempt)
  assert.equal(r.matched, 0)
})

/** an empty touched set skips the rule (no change set to correlate). */
test("empty touched set skips as no-touched-files", () => {
  const r = computeTestOverlap(["src/a.test.ts"], [], [])
  assert.equal(r.skipped, "no-touched-files")
  assert.equal(r.touched, 0)
})

/** an empty executed set skips the rule (today's evidence behavior stands). */
test("empty executed set skips as no-test-files", () => {
  const r = computeTestOverlap([], ["src/b.ts"], [])
  assert.equal(r.skipped, "no-test-files")
  assert.equal(r.executed, 0)
})

/** the stdout scan is language-agnostic: Python and Go conventions from one
 *  stdout window, unioned with the command line's own tokens. */
test("stdout scan is language-agnostic", () => {
  const out = "PASS  tests/test_foo.py\nok   internal/foo_test.go"
  const files = extractTestFiles("pytest", out, compile(DEFAULT_TEST_FILE_PATTERNS))
  assert.deepEqual(files.sort(), ["internal/foo_test.go", "tests/test_foo.py"])
})

/** the per-ecosystem classification table: one representative per language. */
test("classification table covers every default ecosystem", () => {
  const cases: Array<[string, boolean]> = [
    ["src/a.test.ts", true],
    ["src/a.spec.mjs", true],
    ["tests/util.ts", true],
    ["src/__tests__/x.tsx", true],
    ["tests/test_foo.py", true],
    ["pkg/foo_test.py", true],
    ["internal/foo_test.go", true],
    ["tests/lib.rs", true],
    ["src/foo_test.rs", true],
    ["com/x/FooTest.java", true],
    ["com/x/FooTests.kt", true],
    ["src/test/Foo.kt", true],
    ["spec/foo_spec.rb", true],
    ["test/helper.rb", true],
    ["test_foo.c", true],
    ["src/foo_test.cpp", true],
    // Non-test paths miss.
    ["src/main.ts", false],
    ["docs/guide.md", false],
    ["pkg/foo.py", false],
    ["internal/foo.go", false],
    ["src/lib.rs", false],
    ["com/x/Foo.java", false],
    ["lib/foo.rb", false],
    ["src/foo.c", false],
  ]
  for (const [token, expected] of cases) {
    assert.equal(classify(token), expected, token)
  }
  function classify(token: string): boolean {
    for (const source of DEFAULT_TEST_FILE_PATTERNS) {
      if (new RegExp(source, "i").test(token)) return true
    }
    return false
  }
})

/** a configured pattern extends the classification where the defaults miss. */
test("configured pattern extends classification", () => {
  const extended = compile([...DEFAULT_TEST_FILE_PATTERNS, "_test\\.exs$"])
  assert.deepEqual(extractTestFiles("mix test", "ok ./a_test.exs", extended), ["./a_test.exs"])
  assert.deepEqual(
    extractTestFiles("mix test", "ok ./a_test.exs", compile(DEFAULT_TEST_FILE_PATTERNS)),
    [],
  )
})

/** extractPathTokens keeps only path-like tokens (separator + extension). */
test("path token extraction filters non-path tokens", () => {
  assert.deepEqual(extractPathTokens("run tests/alpha.test.ts and beta.tsx now"), [
    "tests/alpha.test.ts",
  ])
})

/** extractPathTokens dedupes and strips common shell/log punctuation. */
test("path token extraction dedupes and strips punctuation", () => {
  const out = "ok src/a.test.ts\nPASS (src/a.test.ts) done; 'src/a.test.ts'"
  assert.deepEqual(extractPathTokens(out), ["src/a.test.ts"])
})

/** extractPathTokens caps at MAX_PATH_TOKENS. */
test("path token extraction caps at the token cap", () => {
  const many = Array.from({ length: MAX_PATH_TOKENS + 10 }, (_, i) => `d/f${i}.ts`).join(" ")
  assert.equal(extractPathTokens(many).length, MAX_PATH_TOKENS)
})

/** extractTestFiles dedupes across both sources and caps the union. */
test("test-file extraction dedupes across sources and caps", () => {
  assert.deepEqual(
    extractTestFiles("node --test src/a.test.ts", "ok src/a.test.ts", compile(["\\.test\\.ts$"])),
    ["src/a.test.ts"],
  )
  const many = Array.from({ length: MAX_PATH_TOKENS + 5 }, (_, i) => `d/t${i}.test.ts`).join(" ")
  assert.equal(extractTestFiles("", many, compile(["\\.test\\.ts$"])).length, MAX_PATH_TOKENS)
})

/** globToRegExp translates **, *, and ? and anchors the whole path. */
test("glob translation covers **, *, and ?", () => {
  const docs = globToRegExp("docs/**")
  assert.ok(docs)
  assert.ok(docs.test("docs/a/b.md"))
  assert.ok(!docs.test("src/docs/a.md"))
  const gen = globToRegExp("**/*.generated.ts")
  assert.ok(gen)
  assert.ok(gen.test("src/x.generated.ts"))
  assert.ok(gen.test("x.generated.ts"), "leading **/ also matches a root-level file")
  assert.ok(!gen.test("src/x.ts"))
  const q = globToRegExp("d?c/a.ts")
  assert.ok(q)
  assert.ok(q.test("doc/a.ts"))
  assert.ok(!q.test("dooc/a.ts"))
})

/** a blank glob is malformed: null (the caller skips it). */
test("blank glob returns null", () => {
  assert.equal(globToRegExp(""), null)
  assert.equal(globToRegExp("   "), null)
})

/** glob metacharacters in a glob are escaped, not interpreted. */
test("glob escapes regex metacharacters", () => {
  const g = globToRegExp("a(b).c+")
  assert.ok(g)
  assert.ok(g.test("a(b).c+"))
  assert.ok(!g.test("aab)c+"))
})

/** the overlap join normalizes separators and joins absolute/relative
 *  spellings of the same file by whole-segment suffix. */
test("overlap join normalizes paths and joins by segment suffix", () => {
  // Absolute touched path vs relative executed token.
  assert.equal(computeTestOverlap(["src/a.test.ts"], ["/repo/src/a.test.ts"], []).matched, 1)
  // Windows separators normalize.
  assert.equal(computeTestOverlap(["src\\a.test.ts"], ["src/a.test.ts"], []).matched, 1)
  // Leading ./ strips.
  assert.equal(computeTestOverlap(["./src/a.test.ts"], ["src/a.test.ts"], []).matched, 1)
  // A partial-segment suffix is not a join (b.test.ts vs ab.test.ts).
  assert.equal(computeTestOverlap(["b.test.ts"], ["src/ab.test.ts"], []).matched, 0)
})
