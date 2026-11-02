/**
 * @fileoverview Shell-parsing boundary: the quote-aware command splitter and
 * word tokenizer shared by the write-shape classifier, the landing guard, and
 * the commit lint — one parser, so every consumer parses the same shape — plus
 * the redirect-target scanner the classifier uses. Pure string logic; no
 * journal, state, or enforcement decisions here.
 */

/** Mutable quote/escape scanner state shared by the tokenizer loops. */
interface QuoteState {
  /** The active quote character (`""` when none is open). */
  quote: string
  /** True when the previous backslash escapes the next character. */
  escaped: boolean
}

/**
 * Appends a backslash-escaped character verbatim and clears the escape flag.
 * @param cur The accumulated token so far.
 * @param ch The escaped character.
 * @param st The scanner state to update.
 * @returns The token with the character appended.
 */
function appendEscaped(cur: string, ch: string, st: QuoteState): string {
  // The previous backslash consumed this character: append it verbatim.
  st.escaped = false
  return cur + ch
}

/**
 * Consumes one character inside an open quote for the separator splitter:
 * the quote character itself is kept in the token (the splitter preserves the
 * raw shape), a backslash arms the escape flag.
 * @param cur The accumulated token so far.
 * @param ch The character inside the quote.
 * @param st The scanner state to update.
 * @returns The token with the character consumed.
 */
function splitQuotedChar(cur: string, ch: string, st: QuoteState): string {
  if (ch === "\\") {
    st.escaped = true
    return cur + ch
  }
  if (ch === st.quote) st.quote = ""
  return cur + ch
}

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
  const st: QuoteState = { quote: "", escaped: false }
  for (const ch of command) {
    if (st.escaped) {
      cur = appendEscaped(cur, ch, st)
      continue
    }
    if (st.quote) {
      cur = splitQuotedChar(cur, ch, st)
      continue
    }
    if (ch === "\\") {
      st.escaped = true
      cur += ch
      continue
    }
    if (ch === '"' || ch === "'") {
      st.quote = ch
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
 * Consumes one character inside an open quote for the word tokenizer: quotes
 * are stripped (a `-m "feat: x"` word yields the bare message), a backslash
 * arms the escape flag and is kept (the tokenizer preserves the escape pair).
 * @param cur The accumulated word so far.
 * @param ch The character inside the quote.
 * @param st The scanner state to update.
 * @returns The word with the character consumed.
 */
function tokenizeQuotedChar(cur: string, ch: string, st: QuoteState): string {
  if (ch === "\\") {
    st.escaped = true
    return cur + ch
  }
  if (ch === st.quote) st.quote = ""
  else return cur + ch
  return cur
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
  const st: QuoteState = { quote: "", escaped: false }
  for (const ch of input) {
    if (st.escaped) {
      cur = appendEscaped(cur, ch, st)
      continue
    }
    if (st.quote) {
      cur = tokenizeQuotedChar(cur, ch, st)
      continue
    }
    if (ch === "\\") {
      st.escaped = true
      cur += ch
      continue
    }
    if (ch === '"' || ch === "'") {
      st.quote = ch
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

/** True when a redirect target is a device or fd-dup (never a file write). */
export function isDevOrFdTarget(target: string): boolean {
  return target.startsWith("/dev/") || target.startsWith("&")
}

/**
 * Reads one redirect target starting just after the operator: skips legal
 * inter-token whitespace (`npm test > log`), then collects characters up to
 * unquoted whitespace with quotes stripped.
 * @param simple One simple command string (already separator-split).
 * @param i The index of the last operator character.
 * @returns The target string (possibly empty) and the index the scan stopped
 *     at (the whitespace that ended it, or the string length).
 */
function readRedirectTarget(simple: string, i: number): { target: string; next: number } {
  let j = i
  let target = ""
  for (j++; j < simple.length && /\s/.test(simple[j]!); j++);
  for (; j < simple.length; j++) {
    const t = simple[j]!
    if (t === '"' || t === "'") continue
    if (/\s/.test(t)) break
    target += t
  }
  return { target, next: j }
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
export function scanRedirects(simple: string): string[] {
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
      const { target, next } = readRedirectTarget(simple, i)
      i = next - 1
      if (target && !isDevOrFdTarget(target)) targets.push(target)
    }
  }
  return targets
}
