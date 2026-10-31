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
 * `echo "a > b"` (quoted), `cmd 2>&1` (fd dup). A heredoc operator (`<<`/
 * `<<<`) caps the whole command at `telemetry` — the splitter sees the
 * heredoc body lines as independent simple commands, but they are stdin
 * data, so a heredoc-bearing command never gates (a real redirect hidden on
 * the head, e.g. `cat > f <<EOF`, is observed, not blocked). `tee` operands
 * that are `/dev` targets or fd-dup forms (`2>&1`, `>&N`, `N>&M`) are not
 * file operands, and `dd` with every `of=` on `/dev` writes no file. Leading
 * `NAME=value` assignments and `sudo`/`env`/`nice`/`command` wrappers are
 * stripped before the head dispatch (`sudo cp a b` gates like `cp a b`).
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

/** Wrapper words that prefix a command without changing the executed head. */
const WRAPPER_WORDS = new Set(["sudo", "env", "nice", "command"])

/** True when a redirect target is a device or fd-dup (never a file write). */
function isDevOrFdTarget(target: string): boolean {
  return target.startsWith("/dev/") || target.startsWith("&")
}

/**
 * True when a tokenized `tee` operand is an fd form, never a file operand:
 * `>&N`, the tokenized `N>&M` fd-dup, or a split remnant like `N>` (the
 * tokenizer sees `2>&1` as one word, but the separator splitter cuts it at
 * the `&`, leaving `2>` beside the `1`).
 * @param word A tokenized word of the simple command.
 * @returns True when the word is an fd form.
 */
function isFdFormWord(word: string): boolean {
  return word.startsWith("&") || /^\d*>>?&?\d*$/.test(word)
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
 * True when the string carries a heredoc operator (`<<` or `<<<`) outside
 * quotes: everything after the operator's line is stdin data, which
 * {@link splitCommands} still sees as independent simple commands — so a
 * heredoc-bearing command must not be gated on its body lines.
 * @param simple One simple command string (already separator-split).
 * @returns True when a heredoc operator is present.
 */
function hasHeredocOperator(simple: string): boolean {
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
    if (ch === "<" && simple[i + 1] === "<") return true
  }
  return false
}

/**
 * Strips leading `NAME=value` assignment words and `sudo`/`env`/`nice`/
 * `command` wrapper words: they prefix a command without changing the
 * executed head, so classification must dispatch on the real head
 * (`sudo cp a b` gates like `cp a b`).
 * @param words The tokenized words of one simple command.
 * @returns The words after the prefix, in order.
 */
function stripPrefixWords(words: string[]): string[] {
  let i = 0
  while (
    i < words.length &&
    (WRAPPER_WORDS.has(words[i]!) || /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[i]!))
  ) {
    i++
  }
  return words.slice(i)
}

/**
 * True when a `dd` command writes no file: every `of=` operand names a
 * `/dev` target (a bare `dd` with no `of=` writes stdout).
 * @param words The tokenized words of the `dd` simple command.
 * @returns True when no `of=` operand names a non-`/dev` file.
 */
function ddWritesNoFile(words: string[]): boolean {
  return words.filter((w) => w.startsWith("of=")).every((w) => w.slice(3).startsWith("/dev/"))
}

/**
 * Classifies ONE simple command. The head decides: an unconditional writer
 * (`cp`/`mv`/`dd`/`truncate`/`touch`) gates outright (`dd` only when an
 * `of=` operand names a non-`/dev` file); `sed` gates on an in-place flag;
 * `tee` gates on a non-flag, non-redirect file operand (`/dev` targets and
 * fd-dup forms are skipped); redirect writers (`cat`/`echo`/`printf`/`head`/
 * `tail`) gate on a collected redirect target; any other head with a
 * collected target is telemetry. Leading assignments and wrapper words are
 * stripped first.
 * @param simple One simple command string (already separator-split).
 * @returns The per-simple verdict.
 */
function classifySimple(simple: string): BashWriteVerdict {
  const words = stripPrefixWords(tokenizeWords(simple))
  const head = words[0] ?? ""
  if (UNCONDITIONAL_WRITER_HEADS.has(head)) {
    return head === "dd" && ddWritesNoFile(words) ? "none" : "gate"
  }
  if (head === "sed") {
    return words.slice(1).some(isSedInPlaceFlag) ? "gate" : "none"
  }
  if (head === "tee") {
    const operand = words
      .slice(1)
      .some(
        (w) => !w.startsWith("-") && !isRedirectToken(w) && !isDevOrFdTarget(w) && !isFdFormWord(w),
      )
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
 * gates). A heredoc operator anywhere caps the verdict at `telemetry`: the
 * splitter sees the heredoc body lines as independent simple commands, but
 * they are stdin data, never writes.
 * @param command The raw command value from the host payload.
 * @returns The write-shape verdict.
 */
export function classifyBashWrite(command: unknown): BashWriteVerdict {
  if (typeof command !== "string" || command.trim() === "") return "none"
  let telemetry = false
  let heredoc = false
  for (const simple of splitCommands(command)) {
    if (hasHeredocOperator(simple)) heredoc = true
    const v = classifySimple(simple)
    if (v === "gate") {
      if (!heredoc) return "gate"
      telemetry = true
    } else if (v === "telemetry") {
      telemetry = true
    }
  }
  return telemetry ? "telemetry" : "none"
}
