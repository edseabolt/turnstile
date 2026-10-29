/**
 * @fileoverview Write-shape classifier for bash/shell commands: a stateless
 * verdict (`gate` / `telemetry` / `none`) per command, shared by the hands-on
 * telemetry (`observeBashWrite`) and the bash write gate (`guardBashWrite`).
 *
 * A command classifies `gate` when a known file-writer mutates files — a
 * redirect from a writer head (`cat`/`echo`/`printf`/`head`/`tail`), `tee`
 * with a file operand, `sed` in-place (`-i`/`-I`/`--in-place[=…]`),
 * `cp`/`mv`/`dd`/`truncate`/`touch` — and `telemetry` for any other head with
 * a non-`/dev` redirect (output capture such as `npm test > log` is observed,
 * never gated). Output-capture and no-op shapes never classify `gate`:
 * `echo hi > /dev/null`, `grep x file > /dev/null`, `git push > /dev/null`,
 * `echo "a > b"` (quoted), `cmd 2>&1` (fd dup), `cat <<EOF` (heredoc stdin).
 * Deliberately not gated at all: `rsync`, `install`, `mkdir` (dir-only),
 * interactive editors (`vim`/`nano` — they cannot run in a non-tty tool call),
 * and `rm` (destructive, not a file write; out of scope for the hands-on
 * gate). Remaining by-design gates that may surprise: `echo x > build.log`,
 * `mv a b`, `cp -n`, `touch` on an existing file — real file writes,
 * consistent with the write/edit tool gate that ignores paths.
 *
 * This boundary owns the shell-aware tokenizer (`splitCommands`/
 * `tokenizeWords`, relocated here from tool-policy and re-exported there) so
 * detection reuses the single parser shared with landing and commit-lint —
 * no second parser, and the dependency direction stays acyclic
 * (`tool-policy → bash-write`).
 */

/**
 * Splits a command into simple commands on top-level shell separators
 * (`;` `|` `&` `\r` `\n`), quote- and backslash-aware: a backslash escapes the
 * next character (`\;` inside quotes is not a separator, `\"` does not close a
 * quote early), so a quoted `echo "git commit"` stays on one side of a
 * separator (never parsed as an invocation). Shared with the commit-lint and
 * landing guards so landing detection, commit linting, and write-shape
 * classification parse the same shape.
 * @param command The raw command string to split.
 * @returns The simple command strings, in order.
 */
export function splitCommands(command: string): string[] {
  const out: string[] = []
  let cur = ""
  let quote = ""
  let escaped = false
  for (const ch of command) {
    if (escaped) {
      // The previous backslash consumed this character: append it verbatim.
      cur += ch
      escaped = false
      continue
    }
    if (quote) {
      if (ch === "\\") {
        escaped = true
        cur += ch
        continue
      }
      if (ch === quote) quote = ""
      cur += ch
      continue
    }
    if (ch === "\\") {
      escaped = true
      cur += ch
      continue
    }
    if (ch === '"' || ch === "'") {
      quote = ch
      cur += ch
      continue
    }
    if (ch === ";" || ch === "|" || ch === "&" || ch === "\r" || ch === "\n") {
      out.push(cur)
      cur = ""
      continue
    }
    cur += ch
  }
  out.push(cur)
  return out
}

/**
 * Tokenizes one simple command into quoted-aware words, stripping the quotes so
 * a `-m "feat: x"` word yields the bare message `feat: x`. Honors the same
 * backslash escape so a `\"` inside a double-quoted word is a literal quote,
 * not a word break.
 * @param input The simple command string to tokenize.
 * @returns The bare words, in order.
 */
export function tokenizeWords(input: string): string[] {
  const words: string[] = []
  let cur = ""
  let quote = ""
  let escaped = false
  for (const ch of input) {
    if (escaped) {
      cur += ch
      escaped = false
      continue
    }
    if (quote) {
      if (ch === "\\") {
        escaped = true
        cur += ch
        continue
      }
      if (ch === quote) quote = ""
      else cur += ch
      continue
    }
    if (ch === "\\") {
      escaped = true
      cur += ch
      continue
    }
    if (ch === '"' || ch === "'") {
      quote = ch
      continue
    }
    if (/\s/.test(ch)) {
      if (cur) words.push(cur)
      cur = ""
      continue
    }
    cur += ch
  }
  if (cur) words.push(cur)
  return words
}

/** The classifier verdict for one command string. */
export type BashWriteVerdict = "gate" | "telemetry" | "none"

/**
 * Heads that gate only when a non-`/dev` redirect target is present: their
 * plain form feeds stdout (a pipe or capture), which the gate must not touch.
 */
const REDIRECT_WRITER_HEADS = new Set(["cat", "echo", "printf", "head", "tail"])

/** Heads that gate unconditionally: they exist to copy/move/mutate files. */
const UNCONDITIONAL_WRITER_HEADS = new Set(["cp", "mv", "dd", "truncate", "touch"])

/** True when a redirect target is a device or fd-dup (never a file write). */
function isDevOrFdTarget(target: string): boolean {
  return target.startsWith("/dev/") || target.startsWith("&")
}

/**
 * Scans ONE simple command for write redirects: the operators `>>`, `>`,
 * `&>`, `2>`, `1>` found OUTSIDE quotes, collecting each non-`/dev`,
 * non-fd-dup target (the characters after the operator up to unquoted
 * whitespace, quotes stripped). Heredoc/stdin operators `<<`/`<<<` are
 * deliberately not collected — they feed stdin, never a file, and a heredoc
 * that writes a file always also carries `>`/`>>` on the same simple command.
 * @param simple One simple command string (already separator-split).
 * @returns The collected write-target strings (`[]` when none).
 */
function scanRedirects(simple: string): string[] {
  const targets: string[] = []
  let quote = ""
  let escaped = false
  for (let i = 0; i < simple.length; i++) {
    const ch = simple[i]!
    if (escaped) {
      escaped = false
      continue
    }
    if (quote) {
      if (ch === "\\") escaped = true
      else if (ch === quote) quote = ""
      continue
    }
    if (ch === "\\") {
      escaped = true
      continue
    }
    if (ch === '"' || ch === "'") {
      quote = ch
      continue
    }
    if (ch === ">") {
      // `>>` appends, `&>`/`>&`/`2>`/`1>` are fd-aware forms; the target
      // parse is identical for all of them.
      if (simple[i + 1] === ">") i++
      // Whitespace between the operator and its target is legal shell
      // (`npm test > log`), so skip it before reading the target word.
      let target = ""
      for (i++; i < simple.length && /\s/.test(simple[i]!); i++);
      for (; i < simple.length; i++) {
        const t = simple[i]!
        if (t === '"' || t === "'") continue
        if (/\s/.test(t)) break
        target += t
      }
      if (target && !isDevOrFdTarget(target)) targets.push(target)
    }
  }
  return targets
}

/**
 * True when the word is an `in-place` sed flag: `-i`, `-I`, a bundled
 * `-i.bak`-style cluster, or `--in-place` (optionally `--in-place=EXT`).
 * @param word A tokenized word of the simple command.
 * @returns True when the word enables in-place editing.
 */
function isSedInPlaceFlag(word: string): boolean {
  return (
    word === "-i" ||
    word === "-I" ||
    word.startsWith("--in-place") ||
    word.startsWith("-i.") ||
    word.startsWith("-I.")
  )
}

/**
 * True when the word is a redirect operator token or a token that embeds one
 * (`>f`, `>>log`) — used to keep `tee`'s operand scan from counting a
 * redirect target as a file operand.
 * @param word A tokenized word of the simple command.
 * @returns True when the word is (or carries) a redirect operator.
 */
function isRedirectToken(word: string): boolean {
  return word === ">" || word === ">>" || word.startsWith(">") || word.startsWith(">>")
}

/**
 * Classifies ONE simple command. The head decides: an unconditional writer
 * (`cp`/`mv`/`dd`/`truncate`/`touch`) gates outright; `sed` gates on an
 * in-place flag; `tee` gates on a non-flag, non-redirect file operand;
 * redirect writers (`cat`/`echo`/`printf`/`head`/`tail`) gate on a collected
 * redirect target; any other head with a collected target is telemetry.
 * @param simple One simple command string (already separator-split).
 * @returns The per-simple verdict.
 */
function classifySimple(simple: string): BashWriteVerdict {
  const words = tokenizeWords(simple)
  const head = words[0] ?? ""
  if (UNCONDITIONAL_WRITER_HEADS.has(head)) return "gate"
  if (head === "sed") {
    return words.slice(1).some(isSedInPlaceFlag) ? "gate" : "none"
  }
  if (head === "tee") {
    const operand = words.slice(1).some((w) => !w.startsWith("-") && !isRedirectToken(w))
    return operand ? "gate" : "none"
  }
  const redirects = scanRedirects(simple)
  if (redirects.length === 0) return "none"
  return REDIRECT_WRITER_HEADS.has(head) ? "gate" : "telemetry"
}

/**
 * Classifies a bash/shell command's write shape: `"gate"` for confident
 * file writes (see the file overview), `"telemetry"` for a non-`/dev`
 * redirect from a non-writer head (observed, never gated), `"none"`
 * otherwise. The first simple command that yields a verdict wins, so a clean
 * first command does not mask a write later in the string (`true && cat > f`
 * gates).
 * @param command The raw command value from the host payload.
 * @returns The write-shape verdict.
 */
export function classifyBashWrite(command: unknown): BashWriteVerdict {
  if (typeof command !== "string" || command.trim() === "") return "none"
  let telemetry = false
  for (const simple of splitCommands(command)) {
    const v = classifySimple(simple)
    if (v === "gate") return "gate"
    if (v === "telemetry") telemetry = true
  }
  return telemetry ? "telemetry" : "none"
}
