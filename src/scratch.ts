/**
 * @fileoverview Scratch-target predicate for parent write/edit exemption: a
 * target path that resolves under the platform temp dir (`os.tmpdir()`) is
 * scratch — an operation with zero governance value (not implementation work,
 * not project I/O), so the hands-on gate exempts it with telemetry instead of
 * running the ladder. Deliberately temp-dir-scoped, NOT "outside projectDir":
 * worktrees live outside the main checkout but are load-bearing project
 * state, so an out-of-project rule would wrongly exempt worktree writes; the
 * platform temp dir can never be a repo or worktree.
 *
 * Resolution is realpath-based so symlinks cannot smuggle a target across
 * the temp-dir boundary: both the base (`tmpdir()`) and the target are
 * canonicalized through their deepest existing ancestor (a not-yet-existing
 * scratch file resolves through its nearest existing ancestor plus the
 * unmatched tail), and any final-component symlink chain — including a
 * dangling link, which the host would write through — is resolved manually
 * before the walk. The comparison is a canonical-prefix check, so a symlink
 * escaping the temp dir classifies as not scratch. Non-string and empty
 * inputs fail toward gating: the predicate returns false and the ordinary
 * hands-on ladder decides. Two further fail-safe properties are accepted as
 * known behavior: a symlink chain deeper than the resolution cap fails
 * toward gating (the predicate returns false rather than trusting a path
 * the walk could not finish), and the prefix comparison is case-sensitive,
 * so a target typed with non-on-disk casing on a case-insensitive platform
 * (e.g. macOS) also fails toward gating.
 *
 * This boundary owns only the temp-dir question. The write/edit arm consumes
 * it in the hook layer; the bash write classifier is its second consumer
 * (owned by the bash-hands-on-gate plan) — one predicate, two consumers, no
 * second implementation.
 */

import { existsSync, lstatSync, readlinkSync, realpathSync } from "node:fs"
import { tmpdir } from "node:os"
import * as path from "node:path"

/**
 * Resolves a symlinked final component before the ancestor walk: a dangling
 * symlink (target not yet created — the common scratch-write shape through a
 * link) cannot be canonicalized by `realpathSync`, but the host would write
 * through it, so the link is read and resolved manually. Bounded to a small
 * chain depth; on depth exhaustion `null` is returned, which the predicate
 * treats as fail toward gating — an unresolvable chain must never be
 * trusted with a path the walk could not finish.
 * @param resolved The fully resolved (absolute, normalized) path.
 * @returns The path with any final-component symlink chain resolved, or
 *   `null` when the chain depth cap was exhausted.
 */
function resolveFinalSymlinks(resolved: string): string | null {
  let current = resolved
  for (let depth = 0; depth < 10; depth++) {
    try {
      if (!lstatSync(current).isSymbolicLink()) return current
      const link = readlinkSync(current)
      current = path.isAbsolute(link) ? link : path.resolve(path.dirname(current), link)
    } catch {
      return current
    }
  }
  return null
}

/**
 * Canonicalizes a path through its deepest existing ancestor: walks up with
 * `existsSync` until an existing directory is found, then rejoins the
 * unmatched tail onto its canonical (`realpathSync`) form. Symlinks in the
 * existing part resolve; the not-yet-existing tail is plain normalization.
 * The walk always terminates: the filesystem root exists, so the loop's
 * exit condition is reached at worst there.
 * @param resolved The fully resolved (absolute, normalized) path.
 * @returns The canonical path.
 */
function canonicalThroughExistingAncestor(resolved: string): string {
  let dir = resolved
  const tail: string[] = []
  while (!existsSync(dir)) {
    tail.unshift(path.basename(dir))
    dir = path.dirname(dir)
  }
  return path.join(realpathSync(dir), ...tail)
}

/**
 * Decides whether a write/edit target path resolves under the platform temp
 * dir. Non-string and empty inputs are not scratch (fail toward gating). The
 * comparison is realpath-based on both sides (see the file doc), so a
 * symlinked target that escapes the temp dir is not scratch, and a target
 * that does not exist yet classifies through its nearest existing ancestor.
 * @param filePath The raw target-path value from the host payload (`unknown`).
 * @returns True when the path resolves strictly inside `os.tmpdir()`.
 */
export function isScratchTarget(filePath: unknown): boolean {
  if (typeof filePath !== "string" || filePath.length === 0) return false
  const base = canonicalThroughExistingAncestor(path.resolve(tmpdir()))
  const resolvedTarget = resolveFinalSymlinks(path.resolve(filePath))
  // Depth exhaustion on the final-component chain: the path could not be
  // proven to stay inside the temp dir, so it fails toward gating.
  if (resolvedTarget === null) return false
  const target = canonicalThroughExistingAncestor(resolvedTarget)
  // Strictly inside: the prefix is the canonical temp dir plus a separator,
  // so the temp dir itself is not a scratch target and no sibling or parent
  // path can prefix-match.
  return target.startsWith(base + path.sep)
}
