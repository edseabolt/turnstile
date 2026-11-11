/**
 * @fileoverview Anchor-sink boundary tests: the builtin session-state,
 * git-note, and commit-trailer sinks (publish/verify arms against a real
 * temp git repo), external plugin-sink resolution (valid factory, malformed
 * shapes, import failure), array selection, and weakest-trust-domain
 * reporting.
 */

import { test } from "node:test"
import assert from "node:assert/strict"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { execFileSync } from "node:child_process"

import {
  commitTrailerSink,
  gitNoteSink,
  publishRefs,
  resolveAnchorSinks,
  sessionStateSink,
  verifyAnchors,
  weakestTrustDomain,
} from "../src/anchor.ts"
import type { AnchorRef, AnchorSink, AnchorVerdict } from "../src/types.ts"
import { pathToFileURL } from "node:url"

/** Creates a temp metrics dir and project dir (a real git repo).
 *  @returns Both directories. */
function dirs(): { metricsDir: string; projectDir: string } {
  const metricsDir = fs.mkdtempSync(path.join(os.tmpdir(), "anchor-metrics-"))
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "anchor-repo-"))
  execFileSync("git", ["init", "-q"], { cwd: projectDir })
  execFileSync("git", ["config", "user.email", "t@t"], { cwd: projectDir })
  execFileSync("git", ["config", "user.name", "t"], { cwd: projectDir })
  fs.writeFileSync(path.join(projectDir, "f.txt"), "x")
  execFileSync("git", ["add", "f.txt"], { cwd: projectDir })
  execFileSync("git", ["commit", "-q", "-m", "init"], { cwd: projectDir })
  return { metricsDir, projectDir }
}

/** Builds a ref for tests.
 *  @param overrides Field overrides.
 *  @returns The ref. */
function ref(overrides: Partial<AnchorRef> = {}): AnchorRef {
  return {
    sink: "",
    source: "shared",
    epoch: 0,
    root: "root-0",
    head: "head-0",
    ts: "2026-01-01T00:00:00.000Z",
    ...overrides,
  }
}

test("session-state publish appends to anchors.jsonl and verify reads it back", () => {
  const { metricsDir, projectDir } = dirs()
  const sink = sessionStateSink({ metricsDir, projectDir })
  assert.equal(sink.id, "session-state")
  assert.equal(sink.trustDomain, "host")
  sink.publish(ref())
  const file = path.join(metricsDir, "anchors.jsonl")
  assert.ok(fs.existsSync(file))
  assert.deepEqual(sink.verify(ref()), { status: "ok", anchoredAt: ref().ts })
})

test("session-state verify reports mismatch and missing", () => {
  const { metricsDir, projectDir } = dirs()
  const sink = sessionStateSink({ metricsDir, projectDir })
  sink.publish(ref())
  assert.equal((sink.verify(ref({ root: "other" })) as AnchorVerdict).status, "mismatch")
  assert.equal((sink.verify(ref({ epoch: 7 })) as AnchorVerdict).status, "missing")
})

test("session-state verify with no anchors file reports missing", () => {
  const { metricsDir, projectDir } = dirs()
  const sink = sessionStateSink({ metricsDir, projectDir })
  assert.equal((sink.verify(ref()) as AnchorVerdict).status, "missing")
})

test("git-note publish stores a note and verify reads it back", () => {
  const { metricsDir, projectDir } = dirs()
  const sink = gitNoteSink({ metricsDir, projectDir })
  assert.equal(sink.id, "git-note")
  assert.equal(sink.trustDomain, "repo")
  sink.publish(ref())
  assert.deepEqual(sink.verify(ref()), { status: "ok", anchoredAt: ref().ts })
})

test("git-note verify reports mismatch, missing, and git failure", () => {
  const { metricsDir, projectDir } = dirs()
  const sink = gitNoteSink({ metricsDir, projectDir })
  sink.publish(ref())
  assert.equal((sink.verify(ref({ root: "other" })) as AnchorVerdict).status, "mismatch")
  assert.equal((sink.verify(ref({ epoch: 3 })) as AnchorVerdict).status, "missing")
  // A project dir that is not a git repo fails the list probe: missing.
  const bare = gitNoteSink({ metricsDir, projectDir: os.tmpdir() })
  assert.equal((bare.verify(ref()) as AnchorVerdict).status, "missing")
})

test("git-note publish throws on git failure (caller journals fail-open)", () => {
  const { metricsDir } = dirs()
  const sink = gitNoteSink({ metricsDir, projectDir: os.tmpdir() })
  assert.throws(() => sink.publish(ref()))
})

test("commit-trailer publish records the pending ref; verify scans commit bodies", () => {
  const { metricsDir, projectDir } = dirs()
  const sink = commitTrailerSink({ metricsDir, projectDir })
  assert.equal(sink.id, "commit-trailer")
  assert.equal(sink.trustDomain, "repo")
  sink.publish(ref())
  const pending = path.join(projectDir, ".git", "turnstile", "trailer-anchors.jsonl")
  assert.ok(fs.existsSync(pending))
  // No trailer in any commit body yet: missing (corroboration-only sink).
  assert.equal((sink.verify(ref()) as AnchorVerdict).status, "missing")
  const trailer = `Turnstile-Anchor: source=shared epoch=0 root=root-0 head=head-0`
  execFileSync("git", ["commit", "-q", "--allow-empty", "-m", `landing\n\n${trailer}`], {
    cwd: projectDir,
  })
  assert.deepEqual(sink.verify(ref()), { status: "ok", anchoredAt: ref().ts })
})

test("git-note verify skips unreadable and non-JSON notes", () => {
  const { metricsDir, projectDir } = dirs()
  // A seam whose `show` always fails (unreadable note) and one whose note
  // body is not JSON: both notes are skipped, so the ref reports missing.
  const failingShow = gitNoteSink({ metricsDir, projectDir }, (_c, args) => {
    if (args.includes("show")) throw new Error("show failed")
    return "blob object\n"
  })
  assert.equal((failingShow.verify(ref()) as AnchorVerdict).status, "missing")
  const nonJson = gitNoteSink({ metricsDir, projectDir }, (_c, args) => {
    if (args.includes("show")) return "not json"
    return "blob object\n"
  })
  assert.equal((nonJson.verify(ref()) as AnchorVerdict).status, "missing")
})

test("commit-trailer verify reports a mismatching trailer", () => {
  const { metricsDir, projectDir } = dirs()
  const sink = commitTrailerSink({ metricsDir, projectDir })
  const trailer = `Turnstile-Anchor: source=shared epoch=0 root=evil head=head-0`
  execFileSync("git", ["commit", "-q", "--allow-empty", "-m", `landing\n\n${trailer}`], {
    cwd: projectDir,
  })
  assert.equal((sink.verify(ref()) as AnchorVerdict).status, "mismatch")
})

test("commit-trailer verify with no git repo reports missing", () => {
  const { metricsDir } = dirs()
  const sink = commitTrailerSink({ metricsDir, projectDir: os.tmpdir() })
  assert.equal((sink.verify(ref()) as AnchorVerdict).status, "missing")
})

test("external plugin sink resolves through its default-export factory", async () => {
  const { metricsDir, projectDir } = dirs()
  const mod = path.join(metricsDir, "good-sink.mjs")
  fs.writeFileSync(
    mod,
    `export default (o) => ({
      id: "external-good",
      trustDomain: "external",
      publish() {},
      verify() { return { status: "ok", anchoredAt: "t", ...o.config } },
    })\n`,
  )
  const { sinks, warnings } = await resolveAnchorSinks(
    { plugin: pathToFileURL(mod).href, options: { tagged: true } },
    { metricsDir, projectDir },
  )
  assert.deepEqual(warnings, [])
  assert.equal(sinks.length, 1)
  assert.equal(sinks[0]!.id, "external-good")
  const v = await sinks[0]!.verify(ref())
  assert.deepEqual(v, { status: "ok", anchoredAt: "t", tagged: true })
})

test("malformed external sinks degrade to anchor-sink warnings", async () => {
  const { metricsDir, projectDir } = dirs()
  const write = (name: string, body: string): string => {
    const mod = path.join(metricsDir, name)
    fs.writeFileSync(mod, body)
    return pathToFileURL(mod).href
  }
  const nonFunction = write("nonfn.mjs", "export default 42\n")
  const badShape = write(
    "badshape.mjs",
    `export default () => ({ id: 1, trustDomain: "galaxy", publish: "no" })\n`,
  )
  const nullFactory = write("nullfn.mjs", "export default () => null\n")
  const throwing = write("throwing.mjs", `export default () => { throw new Error("boom") }\n`)
  const missing = pathToFileURL(path.join(metricsDir, "absent.mjs")).href
  for (const [specifier, fragment] of [
    [nonFunction, "is not a function"],
    [badShape, "malformed sink"],
    [nullFactory, "malformed sink"],
    [throwing, "factory threw"],
    [missing, "failed to import"],
  ] as const) {
    const { sinks, warnings } = await resolveAnchorSinks(
      { plugin: specifier },
      { metricsDir, projectDir },
    )
    assert.equal(sinks.length, 0, specifier)
    assert.equal(warnings.length, 1, specifier)
    assert.ok(warnings[0]!.startsWith("anchor-sink:"), specifier)
    assert.ok(warnings[0]!.includes(fragment), specifier)
  }
})

test("unknown builtin names and malformed selections degrade with warnings", async () => {
  const { metricsDir, projectDir } = dirs()
  const unknown = await resolveAnchorSinks("no-such-sink", { metricsDir, projectDir })
  assert.equal(unknown.sinks.length, 0)
  assert.match(unknown.warnings[0]!, /anchor-sink: unknown builtin sink "no-such-sink"/)
  const empty = await resolveAnchorSinks([], { metricsDir, projectDir })
  assert.equal(empty.sinks.length, 0)
  assert.deepEqual(empty.warnings, [])
})

test("array selection resolves every element in order", async () => {
  const { metricsDir, projectDir } = dirs()
  const { sinks, warnings } = await resolveAnchorSinks(
    ["session-state", "git-note", "commit-trailer"],
    {
      metricsDir,
      projectDir,
    },
  )
  assert.deepEqual(warnings, [])
  assert.deepEqual(
    sinks.map((s) => s.id),
    ["session-state", "git-note", "commit-trailer"],
  )
})

test("publishRefs fans out to all sinks and collects rejections as strings", async () => {
  const { metricsDir, projectDir } = dirs()
  const good = sessionStateSink({ metricsDir, projectDir })
  const bad: AnchorSink = {
    id: "bad",
    trustDomain: "external",
    publish() {
      throw new Error("nope")
    },
    verify() {
      return { status: "missing", detail: "d" }
    },
  }
  const errors = await publishRefs([good, bad], [ref()])
  assert.equal(errors.length, 1)
  assert.match(errors[0]!, /nope/)
  const file = path.join(metricsDir, "anchors.jsonl")
  assert.ok(fs.readFileSync(file, "utf8").includes('"sink":"session-state"'))
})

test("verifyAnchors intersects sinks and reports the weakest vouching domain", async () => {
  const { metricsDir, projectDir } = dirs()
  const host = sessionStateSink({ metricsDir, projectDir })
  const repo = gitNoteSink({ metricsDir, projectDir })
  const anchored = ref()
  const unanchored = ref({ epoch: 9 })
  await publishRefs([host, repo], [anchored])
  const { verdicts, weakest } = await verifyAnchors([host, repo], [anchored, unanchored])
  assert.equal(verdicts.length, 4)
  assert.equal(weakest[0]!.domain, "host")
  assert.equal(weakest[1]!.domain, null)
})

test("verifyAnchors records a throwing sink as an error verdict, not a missing anchor", async () => {
  const broken: AnchorSink = {
    id: "broken",
    trustDomain: "external",
    publish() {},
    verify() {
      throw new Error("storage offline")
    },
  }
  const r = ref()
  const { verdicts, weakest } = await verifyAnchors([broken], [r])
  assert.equal(verdicts.length, 1)
  assert.equal(verdicts[0]!.verdict.status, "mismatch")
  assert.match(String(verdicts[0]!.verdict.detail), /sink broken verify failed: .*storage offline/)
  assert.equal(weakest[0]!.domain, null)
})

test("weakestTrustDomain picks the weakest domain among ok verdicts", () => {
  const r = ref()
  const verdicts = [
    { ref: r, sink: "a", verdict: { status: "ok" as const, anchoredAt: "t" } },
    { ref: r, sink: "b", verdict: { status: "ok" as const, anchoredAt: "t" } },
  ]
  const domains = new Map([
    ["a", "external" as const],
    ["b", "repo" as const],
  ])
  assert.equal(weakestTrustDomain(verdicts, domains, r), "repo")
  assert.equal(weakestTrustDomain([], domains, r), null)
})
