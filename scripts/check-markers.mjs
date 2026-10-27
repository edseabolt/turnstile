// CI guard: the marker examples in README.md must be accepted by the parser
// regexes in turnstile.ts. Exits non-zero on drift.
import { readdirSync, readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const root = join(dirname(fileURLToPath(import.meta.url)), "..")
// The marker regex literals live in src/markers.ts (the marker boundary);
// turnstile.ts stays in the list so older single-file layouts still guard.
const ts = ["turnstile.ts", "src/markers.ts"]
  .map((f) => readFileSync(join(root, f), "utf8"))
  .join("\n")
const readme = readFileSync(join(root, "README.md"), "utf8")
// The standalone evidence emitter carries its own copy of the canonical marker
// pair so it can degrade a journaled marker to null without importing TS
// source; guard that copy against the same concrete README examples below.
const evidence = readFileSync(join(root, "scripts", "evidence.mjs"), "utf8")

function extractRegex(name) {
  const m = ts.match(new RegExp(`const ${name} = /(.+)/([a-z]*)`))
  if (!m) throw new Error(`could not find ${name} in turnstile.ts or src/markers.ts`)
  // strip the g flag: RegExp.test is stateful with /g (lastIndex advances)
  return new RegExp(m[1], m[2].replace(/g/g, ""))
}

const gateRe = extractRegex("GATE_RE")
const verdictRe = extractRegex("VERDICT_RE")

// MARKER_OK is declared across two lines (`const MARKER_OK =` then the literal),
// so the extraction tolerates the newline between the `=` and the `/`.
const markerOkMatch = evidence.match(/const MARKER_OK\s*=\s*\/(.+)\/([a-z]*)/)
if (!markerOkMatch) throw new Error("could not find MARKER_OK in scripts/evidence.mjs")
const markerOkRe = new RegExp(markerOkMatch[1], markerOkMatch[2].replace(/g/g, ""))

// Every fenced ```-block line that looks like a marker must match a regex.
const lines = [...readme.matchAll(/```[a-z]*\n([\s\S]*?)```/g)]
  .flatMap((m) => m[1].split("\n"))
  .filter((l) => /^(GATE|VERDICT): /.test(l.trim()) && !/[<>]/.test(l))

if (lines.length === 0) {
  console.error("check-markers: no concrete marker examples found in README.md")
  process.exit(1)
}

let failed = 0
for (const line of lines) {
  const ok = gateRe.test(line) || verdictRe.test(line)
  if (!ok) {
    console.error(`check-markers: README marker not accepted by parser: ${line}`)
    failed++
  }
  // The evidence emitter's MARKER_OK copy must accept the same concrete
  // examples the parser does, so a drift in that second copy fails the guard.
  if (!markerOkRe.test(line)) {
    console.error(`check-markers: README marker not accepted by evidence MARKER_OK: ${line}`)
    failed++
  }
}

// Agent templates: the backticked GATE:/VERDICT: examples in
// agents/*.md are the prompt-side half of the marker contract.
// Templates spell the numeric fields <n>; they must parse once the
// placeholder stands in for digits.
const agentsDir = join(root, "agents")
let agentTemplates = 0
for (const f of readdirSync(agentsDir).filter((f) => f.endsWith(".md"))) {
  const text = readFileSync(join(agentsDir, f), "utf8")
  for (const m of text.matchAll(/`((?:GATE|VERDICT): [^\n`]*)`/g)) {
    const line = m[1].replaceAll("<n>", "1")
    const re = line.startsWith("GATE") ? gateRe : verdictRe
    agentTemplates++
    if (!re.test(line)) {
      console.error(`check-markers: agent marker template not accepted by parser: ${f}: ${line}`)
      failed++
    }
  }
}
if (agentTemplates === 0) {
  console.error("check-markers: no marker templates found in agents/")
  failed++
}

// Plugin policy: the backticked GATE:/VERDICT: examples in src/policy.ts are
// the orchestrator-side half of the marker contract — the runtime policy
// injected into the parent session. Same extraction rule as the agent
// templates: they spell <n> and must parse once the placeholder stands in
// for digits. (The template source that once lived here for this contract is
// gone; src/policy.ts is its successor, so its examples are validated too.)
const policyFile = join(root, "src", "policy.ts")
let policyTemplates = 0
for (const m of readFileSync(policyFile, "utf8").matchAll(/`((?:GATE|VERDICT): [^\n`]*)`/g)) {
  const line = m[1].replaceAll("<n>", "1")
  const re = line.startsWith("GATE") ? gateRe : verdictRe
  policyTemplates++
  if (!re.test(line)) {
    console.error(`check-markers: policy marker template not accepted by parser: ${line}`)
    failed++
  }
}
if (policyTemplates === 0) {
  console.error("check-markers: no marker templates found in src/policy.ts")
  failed++
}

// Inverse check: the regexes must also reject malformed markers.
for (const [re, bad] of [
  [gateRe, "GATE: PASS tests=12"],
  [gateRe, "GATE: OK tests=1 passed=1 failed=0"],
  [verdictRe, "VERDICT: APPROVE crit=1"],
  [verdictRe, "VERDICT: MAYBE crit=0 high=0 med=0 low=0"],
]) {
  if (re.test(bad)) {
    console.error(`check-markers: parser accepted malformed marker: ${bad}`)
    failed++
  }
}

if (failed) {
  console.error(`check-markers: ${failed} drift finding(s)`)
  process.exit(1)
}
console.log(
  `check-markers: OK (${lines.length} README examples verified against parser + evidence MARKER_OK, ${agentTemplates} agent + ${policyTemplates} policy templates verified against parser)`,
)
