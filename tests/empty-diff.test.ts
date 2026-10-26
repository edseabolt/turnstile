/**
 * @fileoverview Empty-diff probe tests: the static `planPushRefs` decision
 * table (each ambiguous shape returns `null`, each resolvable shape returns
 * its plan) and the total git-side probe `isEmptyDiffPush` over an injected
 * exec seam — upstream ref equality exempts, and every failure mode (throwing seam,
 * detached HEAD, unresolvable upstream, divergent or garbage refs, a bare
 * name that is both a remote and a branch) is `false`, never a throw.
 */

import { test } from "node:test"
import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"

import { isEmptyDiffPush, planPushRefs } from "../src/empty-diff.ts"
import { tmpDir } from "./helpers.ts"

/** True when git is available (the real-exec fixture cases skip otherwise). */
const hasGit = spawnSync("git", ["--version"]).error === undefined

/**
 * Builds a routed exec seam: the argv after `-C <dir>` is joined and looked
 * up in `routes`; a key listed in `failures` or missing from `routes` throws
 * like a failing git call (non-zero exit).
 * @param routes Map of `argv-slice-joined-by-space` → stdout.
 * @param failures argv keys that must throw instead of returning.
 * @returns The exec seam.
 */
function routed(
  routes: Record<string, string>,
  failures: string[] = [],
): (command: string, args: ReadonlyArray<string>) => string {
  return (_command, args) => {
    const key = args.slice(2).join(" ")
    if (failures.includes(key)) throw new Error(`simulated failure: ${key}`)
    const out = routes[key]
    if (out === undefined) throw new Error(`unrouted git argv: ${key}`)
    return out
  }
}

/** `planPushRefs` plans a two-positional `git push <remote> <branch>` push. */
test("planPushRefs: an explicit remote plus branch plans one probe", () => {
  assert.deepEqual(planPushRefs("git push origin main"), { remote: "origin", branches: ["main"] })
})

/** A bare `git push` and a single bare name both defer resolution to the probe. */
test("planPushRefs: a bare push and a bare name plan upstream-mode resolution", () => {
  assert.deepEqual(planPushRefs("git push"), { remote: null, branches: [] })
  // A bare name is deliberately not classified statically (branch-or-remote
  // is a git fact, not a text fact); the probe disambiguates it.
  assert.deepEqual(planPushRefs("git push main"), { remote: null, branches: ["main"] })
})

/** Force flags are never whitelisted: a force push can rewind the remote, so it gates. */
test("planPushRefs: force flags are ambiguous, other value-free flags pass", () => {
  assert.equal(planPushRefs("git push --force origin main"), null)
  assert.equal(planPushRefs("git push -f origin main"), null)
  assert.deepEqual(planPushRefs("git push -q --atomic origin main"), {
    remote: "origin",
    branches: ["main"],
  })
  assert.equal(planPushRefs("git push --mirror"), null)
  assert.equal(planPushRefs("git push --tags origin main"), null)
  assert.equal(planPushRefs("git push --follow-tags origin main"), null)
  assert.equal(planPushRefs("git push -u origin main"), null)
  assert.equal(planPushRefs("git push --force-with-lease origin main"), null)
  assert.equal(planPushRefs("git push --repo=/x origin main"), null)
  assert.equal(planPushRefs("git push --dry-run origin main"), null)
})

/** An equal, probe-safe refspec plans its branch; a rename, `HEAD` source,
 *  sha, range, or unsafe-side shape is ambiguous. A refspec side carried as
 *  the second positional is kept verbatim (the probe's rev-parse fails strict
 *  on it, so nothing is exempted). */
test("planPushRefs: equal safe refspecs plan; rename, HEAD-src, sha, and range shapes are ambiguous", () => {
  assert.deepEqual(planPushRefs("git push main:main"), { remote: null, branches: ["main"] })
  assert.deepEqual(planPushRefs("git push origin main:main"), {
    remote: "origin",
    branches: ["main:main"],
  })
  assert.equal(planPushRefs("git push other:main"), null)
  assert.equal(planPushRefs("git push HEAD:main"), null)
  assert.equal(planPushRefs("git push main:HEAD"), null)
  assert.equal(planPushRefs("git push deadbeef:deadbeef"), null)
  assert.equal(planPushRefs("git push a..b:a..b"), null)
  assert.equal(planPushRefs("git push a+b:a+b"), null)
  assert.equal(planPushRefs("git push a:b:c"), null)
})

/** Only exactly one `git push` simple command is ever planned. */
test("planPushRefs: a multi-command string or a non-push invocation is ambiguous", () => {
  assert.equal(planPushRefs("git push origin main && git push origin dev"), null)
  assert.equal(planPushRefs("git push origin main; git status"), null)
  assert.equal(planPushRefs("echo remember to git push"), null)
  assert.equal(planPushRefs("git status"), null)
  assert.equal(planPushRefs("git pushgraph show"), null)
})

/** An unsafe first positional and more than two positionals are ambiguous. */
test("planPushRefs: an unsafe explicit remote and three positionals are ambiguous", () => {
  assert.equal(planPushRefs("git push origin:main main"), null)
  assert.equal(planPushRefs("git push deadbeef main"), null)
  assert.equal(planPushRefs("git push origin main dev"), null)
})

/** Ref equality with an explicit remote's ref exempts; divergence, garbage, or a behind branch does not. */
test("isEmptyDiffPush: ref equality with the explicit remote ref exempts", () => {
  const routes = { "rev-parse origin/main main": "abc1234\nabc1234\n" }
  assert.equal(isEmptyDiffPush("git push origin main", "/x", routed(routes)), true)
  // Ahead: the local branch is a different (newer) commit — gates.
  assert.equal(
    isEmptyDiffPush(
      "git push origin main",
      "/x",
      routed({ "rev-parse origin/main main": "abc1234\nabc9999\n" }),
    ),
    false,
  )
  // Behind: the remote ref is a different (newer) commit — gates. The
  // ahead-only rev-list count was 0 here; ref equality is the invariant.
  assert.equal(
    isEmptyDiffPush(
      "git push origin main",
      "/x",
      routed({ "rev-parse origin/main main": "abc9999\nabc1234\n" }),
    ),
    false,
  )
  assert.equal(
    isEmptyDiffPush(
      "git push origin main",
      "/x",
      routed({ "rev-parse origin/main main": "garbage\n" }),
    ),
    false,
  )
})

/** The probe is total: an ambiguous command and a throwing seam are false without running git. */
test("isEmptyDiffPush: ambiguous shapes and a throwing seam are false without running git", () => {
  const noGit = (): string => {
    throw new Error("no git")
  }
  assert.equal(isEmptyDiffPush("git push --mirror", "/x", noGit), false)
  assert.equal(isEmptyDiffPush("git push origin main dev", "/x", noGit), false)
  assert.equal(isEmptyDiffPush("git push origin main", "/x", noGit), false)
})

/** A bare push resolves HEAD: ref equality with the configured upstream exempts. */
test("isEmptyDiffPush: a bare push at ref equality with the configured upstream exempts", () => {
  const routes = {
    "rev-parse --abbrev-ref HEAD": "main\n",
    "rev-parse --abbrev-ref main@{upstream}": "origin/main\n",
    "rev-parse origin/main main": "abc1234\nabc1234\n",
  }
  assert.equal(isEmptyDiffPush("git push", "/x", routed(routes)), true)
  assert.equal(
    isEmptyDiffPush(
      "git push",
      "/x",
      routed({ ...routes, "rev-parse origin/main main": "abc1234\nabc9999\n" }),
    ),
    false,
  )
})

/** Detached or unborn HEAD, and a throwing head probe, gate. */
test("isEmptyDiffPush: detached or unresolved HEAD gates", () => {
  assert.equal(
    isEmptyDiffPush("git push", "/x", routed({ "rev-parse --abbrev-ref HEAD": "HEAD\n" })),
    false,
  )
  assert.equal(
    isEmptyDiffPush("git push", "/x", routed({ "rev-parse --abbrev-ref HEAD": "\n" })),
    false,
  )
  assert.equal(isEmptyDiffPush("git push", "/x", routed({})), false)
})

/** A bare local-branch name at ref equality with its configured upstream exempts. */
test("isEmptyDiffPush: a bare local-branch name equal to its upstream exempts", () => {
  const routes = {
    "rev-parse --abbrev-ref main@{upstream}": "origin/main\n",
    "rev-parse origin/main main": "abc1234\nabc1234\n",
  }
  assert.equal(
    isEmptyDiffPush("git push main", "/x", routed(routes, ["config --get remote.main.url"])),
    true,
  )
})

/** An unresolvable upstream (literal `@{upstream}` or empty output) gates. */
test("isEmptyDiffPush: an unresolvable upstream gates", () => {
  const notARemote = ["config --get remote.main.url"]
  assert.equal(
    isEmptyDiffPush(
      "git push main",
      "/x",
      routed({ "rev-parse --abbrev-ref main@{upstream}": "@{upstream}\n" }, notARemote),
    ),
    false,
  )
  assert.equal(
    isEmptyDiffPush(
      "git push main",
      "/x",
      routed({ "rev-parse --abbrev-ref main@{upstream}": "\n" }, notARemote),
    ),
    false,
  )
  assert.equal(
    isEmptyDiffPush("git push main", "/x", routed({}, ["config --get remote.main.url"])),
    false,
  )
})

/** A bare name that is a configured remote exempts its current branch at ref equality. */
test("isEmptyDiffPush: a bare name that is a remote exempts its current branch at ref equality", () => {
  const routes = {
    "config --get remote.origin.url": "git@github.com:example/repo.git\n",
    "rev-parse --abbrev-ref HEAD": "main\n",
    "rev-parse origin/main main": "abc1234\nabc1234\n",
  }
  assert.equal(
    isEmptyDiffPush(
      "git push origin",
      "/x",
      routed(routes, ["rev-parse --verify refs/heads/origin"]),
    ),
    true,
  )
  assert.equal(
    isEmptyDiffPush(
      "git push origin",
      "/x",
      routed({ ...routes, "rev-parse origin/main main": "abc1234\nabc9999\n" }, [
        "rev-parse --verify refs/heads/origin",
      ]),
    ),
    false,
  )
})

/** A bare name that is both a configured remote and a local branch is ambiguous. */
test("isEmptyDiffPush: a bare name that is both a remote and a branch gates", () => {
  const routes = {
    "config --get remote.origin.url": "git@github.com:example/repo.git\n",
    "rev-parse --verify refs/heads/origin": "abc1234\n",
  }
  assert.equal(isEmptyDiffPush("git push origin", "/x", routed(routes)), false)
})

/** A failing ref-equality probe gates even when the explicit remote ref resolves. */
test("isEmptyDiffPush: a throwing equality probe gates even with an explicit remote", () => {
  assert.equal(
    isEmptyDiffPush("git push origin main", "/x", routed({}, ["rev-parse origin/main main"])),
    false,
  )
})

/**
 * Builds a real git fixture: a bare origin plus a worktree on `main` with one
 * commit pushed and its upstream set (`push -u`), so the real-exec probe has
 * a resolvable remote and upstream.
 * @returns The worktree directory.
 */
function gitFixture(): string {
  const work = tmpDir("turnstile-emptydiff-")
  const origin = tmpDir("turnstile-emptydiff-origin-")
  const run = (dir: string, ...args: string[]): void => {
    const result = spawnSync("git", ["-C", dir, ...args], { stdio: "ignore" })
    assert.equal(result.status, 0, `git ${args.join(" ")} failed`)
  }
  run(origin, "init", "--bare", "-b", "main")
  run(work, "init", "-b", "main")
  run(work, "remote", "add", "origin", origin)
  run(
    work,
    "-c",
    "user.email=test@example.com",
    "-c",
    "user.name=Test",
    "commit",
    "--allow-empty",
    "-m",
    "init",
  )
  run(work, "push", "-u", "origin", "main")
  return work
}

/** Runs a git command in the fixture, asserting success. */
function runGit(dir: string, ...args: string[]): void {
  const result = spawnSync("git", ["-C", dir, ...args], { stdio: "ignore" })
  assert.equal(result.status, 0, `git ${args.join(" ")} failed`)
}

/** Against real git (the default seam): level exempts; ahead, behind, and force gate. */
test(
  "isEmptyDiffPush against real git: level exempts, ahead/behind/force gate",
  { skip: !hasGit },
  () => {
    const work = gitFixture()
    assert.equal(isEmptyDiffPush("git push origin main", work), true)
    assert.equal(isEmptyDiffPush("git push", work), true)
    const commit = spawnSync(
      "git",
      [
        "-C",
        work,
        "-c",
        "user.email=test@example.com",
        "-c",
        "user.name=Test",
        "commit",
        "--allow-empty",
        "-m",
        "feat: ahead",
      ],
      { stdio: "ignore" },
    )
    assert.equal(commit.status, 0)
    assert.equal(isEmptyDiffPush("git push origin main", work), false)
    // Publish the second commit, then rewind the local branch behind its
    // upstream: the ahead count is 0 but the refs differ — the probe must gate.
    runGit(work, "push", "origin", "main")
    runGit(work, "reset", "--hard", "HEAD~1")
    assert.equal(isEmptyDiffPush("git push origin main", work), false)
    // Any force-flagged push is statically ambiguous (rewind risk) — gates
    // before the git layer is ever consulted.
    assert.equal(isEmptyDiffPush("git push --force origin main", work), false)
    assert.equal(isEmptyDiffPush("git push -f origin main", work), false)
  },
)
