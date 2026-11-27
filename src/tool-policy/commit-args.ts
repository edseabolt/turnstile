/**
 * @fileoverview Commit-args boundary: the `git commit` argument scanner that
 * extracts `-m`/`--message` messages and detects uninspectable forms
 * (`-F`/`-t`/`--edit`/`-e`, or a bundled short-flag cluster carrying an
 * editor/template flag). Pure string logic shared by the commit lint; no
 * journal, state, or enforcement decisions here.
 */

/**
 * True when the arg is an uninspectable commit flag: a message arrives from a
 * file (`-F`/`--file`), a template (`-t`/`--template`), or an editor
 * (`-e`/`--edit`) — the operator cannot see the subject, so the lint
 * fail-closes on these.
 * @param a One commit arg word.
 * @returns True when the arg names an uninspectable message source.
 */
function isUninspectableFlag(a: string): boolean {
  return (
    a === "-F" || a === "--file" || a === "-t" || a === "--template" || a === "-e" || a === "--edit"
  )
}

/**
 * Reads a bundled short-flag cluster (e.g. `-am`) and returns the embedded
 * `-m` message when `m` is present and no editor/template flag precedes it,
 * or `uninspectable: true` when an `e`/`t`/`F` character precedes `m`, when
 * `m` requires a separate next token that is missing or is itself a flag.
 * Characters after `m` are its inline value (git bundling semantics), so they
 * are never scanned for editor flags — e.g. `-am"feat: x"` tokenizes to
 * `-amfeat: x`. Returns `{ uninspectable: false }` (no message) when the
 * cluster has no `m` at all.
 * @param token The cluster word including the leading `-` (e.g. `-am`).
 * @param next The word following the cluster in the arg list, or `undefined`.
 * @returns The parsed result: `message` when `m` carried an inline or adjacent
 *     value, `uninspectable` when the cluster is uninspectable, and
 *     `consumedNext` when the caller must advance the loop index by one.
 */
function readShortCluster(
  token: string,
  next: string | undefined,
): { message?: string; uninspectable: boolean; consumedNext: boolean } {
  const letters = token.slice(1)
  const mIdx = letters.indexOf("m")
  const flagPart = mIdx === -1 ? letters : letters.slice(0, mIdx)
  if (/[eFt]/.test(flagPart)) return { uninspectable: true, consumedNext: false }
  if (mIdx === -1) return { uninspectable: false, consumedNext: false }
  const inline = letters.slice(mIdx + 1)
  if (inline.length > 0) return { message: inline, uninspectable: false, consumedNext: false }
  if (next !== undefined && !next.startsWith("-"))
    return { message: next, uninspectable: false, consumedNext: true }
  return { uninspectable: true, consumedNext: false }
}

/**
 * Scans the commit args of a `git commit` invocation for `-m`/`--message`
 * messages and uninspectable flags. Bundled short-flag clusters that embed
 * `-m` (e.g. `-am`, `-am<msg>`) are inspectable: their message is extracted
 * and linted. A cluster carrying an `e`/`t`/`F` flag stays uninspectable.
 * @param args The word list following the `commit` subcommand.
 * @returns The extracted messages and whether the invocation is uninspectable.
 */
export function parseCommitArgs(args: string[]): { messages: string[]; uninspectable: boolean } {
  const messages: string[] = []
  let uninspectable = false
  for (let j = 0; j < args.length; j++) {
    const a = args[j]!
    if (a === "-m" || a === "--message") {
      const next = args[j + 1]
      if (next !== undefined) messages.push(next)
      else uninspectable = true
    } else if (a.startsWith("--message=")) {
      messages.push(a.slice("--message=".length))
    } else if (a.startsWith("-m")) {
      messages.push(a.slice(2))
    } else if (/^-[A-Za-z]{2,}/.test(a)) {
      const r = readShortCluster(a, args[j + 1])
      if (r.uninspectable) uninspectable = true
      else if (r.message !== undefined) messages.push(r.message)
      if (r.consumedNext) j++
    } else if (isUninspectableFlag(a)) {
      uninspectable = true
    }
  }
  return { messages, uninspectable }
}
