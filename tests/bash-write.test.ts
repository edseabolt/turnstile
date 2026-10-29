/**
 * @fileoverview Write-shape classifier tests: the `classifyBashWrite` verdict
 * matrix over gated writers, telemetry-only redirects, and the zero-false-
 * positive shapes (`/dev` targets, quoted redirects, fd dups, heredocs).
 */

import { test } from "node:test"
import assert from "node:assert/strict"

import { classifyBashWrite, splitCommands, tokenizeWords } from "../src/bash-write.ts"
import { splitCommands as reExportedSplit } from "../src/tool-policy.ts"

test("classifyBashWrite: gated writer shapes", () => {
  const cases = [
    "cat > f",
    "cat > f.txt <<'EOF'\nbody\nEOF",
    "echo x >> f",
    "printf '%s' x > f",
    "head -5 src > out",
    "tail -1 a > b",
    "sed -i s/a/b/ f",
    "sed -i.bak s/a/b/ f",
    "sed -I s/a/b/ f",
    "sed -I.bak s/a/b/ f",
    "sed --in-place s/a/b/ f",
    "sed --in-place=.bak s/a/b/ f",
    "x | tee f",
    "tee -a f",
    "cp a b",
    "mv a b",
    "dd if=a of=b",
    "truncate -s 0 f",
    "touch f",
    "true && cat > f",
    "npm test; cat > f",
    "cat >f",
    "echo a>>b",
  ]
  for (const c of cases) {
    assert.equal(classifyBashWrite(c), "gate", `gate: ${c}`)
  }
})

test("classifyBashWrite: telemetry-only redirect shapes", () => {
  for (const c of [
    "npm test > log",
    "git log > f",
    "grep x f > out",
    "ls | tee f",
    "cmd > f 2>&1",
  ]) {
    // `ls | tee f` is split on the pipe, so the `tee f` simple gates; the
    // remaining cases are non-writer heads with a non-dev redirect.
    assert.equal(classifyBashWrite(c), c === "ls | tee f" ? "gate" : "telemetry", c)
  }
})

test("classifyBashWrite: zero-false-positive shapes never gate", () => {
  const cases = [
    "echo hi > /dev/null",
    "grep x file > /dev/null",
    "git push > /dev/null",
    "npm test 2> /dev/null",
    "cmd &> /dev/null",
    "echo x >& /dev/null",
    "sort 1> /dev/stdout",
    "echo err 2> /dev/stderr",
    "read x < /dev/tty",
    'echo "a > b"',
    "echo 'x > y' > /dev/null",
    "cmd 2>&1",
    "cat <<EOF",
    "sort <<< x",
    "",
    "   ",
    "ls -la",
    "sed s/a/b/ f",
    "tee -a",
  ]
  for (const c of cases) {
    assert.equal(classifyBashWrite(c), "none", `none: ${c}`)
  }
})

test("classifyBashWrite: escaped redirect metacharacters never gate", () => {
  // A backslash outside quotes escapes the next character (so `\>` is a
  // literal, not a redirect); inside quotes it is an escaped character the
  // scanner must consume without mistaking it for a delimiter.
  const cases = ["echo a\\>b", 'echo "x\\>y"', "echo 'a\\>b' > /dev/null"]
  for (const c of cases) {
    assert.equal(classifyBashWrite(c), "none", `none: ${c}`)
  }
  // The escaped `\>` is a literal argument, but the unescaped trailing
  // `>f` is a real redirect, so this shape still gates.
  assert.equal(classifyBashWrite("echo a\\>>f"), "gate")
  // Quoted redirect targets are collected with quotes stripped: still a file
  // write, still a gate.
  assert.equal(classifyBashWrite("cat > 'f'"), "gate")
  assert.equal(classifyBashWrite('echo x > "f"'), "gate")
})

test("classifyBashWrite: non-string input classifies none", () => {
  for (const v of [undefined, null, 42, { command: "cat > f" }]) {
    assert.equal(classifyBashWrite(v), "none")
  }
})

test("bash-write: splitCommands and tokenizeWords are re-exported from tool-policy", () => {
  assert.equal(reExportedSplit, splitCommands)
  assert.deepEqual(splitCommands("echo hi; cat > f | true"), ["echo hi", " cat > f ", " true"])
  assert.deepEqual(tokenizeWords('a -m "feat: x" b'), ["a", "-m", "feat: x", "b"])
})
