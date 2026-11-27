/**
 * @fileoverview Anchor-sink boundary: the durable stores a committed journal
 * epoch's Merkle root is published to and later verified against. Three
 * builtin sinks (session-state, git-note, commit-trailer) plus external
 * `{plugin}` sinks resolved by lazy `import()` with a factory shape-check.
 * Every failure path degrades fail-open: resolution problems become warning
 * strings, publish/verify rejections are returned or thrown to a caller that
 * journals them — nothing here breaks the host.
 */

import * as fs from "node:fs"
import * as path from "node:path"
import { execFileSync } from "node:child_process"
import type { StdioOptions } from "node:child_process"

import { repairTornTail } from "./journal-sinks.ts"

import type { AnchorRef, AnchorSelection, AnchorSink, AnchorVerdict } from "./types.ts"

export type { AnchorRef, AnchorSelection, AnchorSink, AnchorVerdict } from "./types.ts"

/** Options threaded to sink factories and resolution. */
export interface AnchorOptions {
  /** The metrics directory (hosts `anchors.jsonl`). */
  metricsDir: string
  /** The project directory (cwd for git-backed sinks). */
  projectDir: string
}

/** The command-execution seam for git-backed sinks (overridable in tests). */
type ExecFile = (command: string, args: ReadonlyArray<string>, options?: ExecOptions) => string

/** The child_process options subset the git sinks need. */
type ExecOptions = { timeout?: number; stdio?: StdioOptions; cwd?: string }

/** Git invocation options: bounded hang mode, piped stdout, silent stderr. */
const GIT_EXEC_OPTS: ExecOptions = { timeout: 2000, stdio: ["ignore", "pipe", "ignore"] }

/**
 * Runs a git command in the project directory and returns its stdout.
 * @param exec The execution seam.
 * @param projectDir The cwd for the invocation.
 * @param args The git argv (after `git`).
 * @returns The command's stdout as a string; a non-zero exit throws.
 */
function git(exec: ExecFile, projectDir: string, args: string[]): string {
  return exec("git", args, { ...GIT_EXEC_OPTS, cwd: projectDir })
}

/**
 * Builds the builtin `session-state` sink: refs are appended as JSON lines
 * to `<metricsDir>/anchors.jsonl` and verified by scanning that file. An
 * honest host-domain anchor — a second file a journal rewriter must also
 * forge; it defeats lazy edit-in-place only.
 * @param options The anchor options (metrics dir).
 * @returns The sink.
 */
export function sessionStateSink(options: AnchorOptions): AnchorSink {
  const file = path.join(options.metricsDir, "anchors.jsonl")
  // Per-line parse, skipping malformed lines (journal fail-open row
  // semantics): one torn or garbage line must not blind the whole store.
  const readRefs = (): AnchorRef[] => {
    try {
      return fs
        .readFileSync(file, "utf8")
        .split("\n")
        .filter(Boolean)
        .flatMap((line) => {
          try {
            return [JSON.parse(line) as AnchorRef]
          } catch {
            return []
          }
        })
    } catch {
      return []
    }
  }
  return {
    id: "session-state",
    trustDomain: "host",
    publish(ref: AnchorRef): void {
      // Skip a ref the store already holds (same source, epoch, root, head):
      // repeated anchor triggers must not accumulate duplicate lines.
      const duplicate = readRefs().some(
        (r) =>
          r.source === ref.source &&
          r.epoch === ref.epoch &&
          r.root === ref.root &&
          r.head === ref.head,
      )
      if (duplicate) return
      // Same torn-tail repair as the journal: a crash mid-append must not
      // concatenate the next ref onto a partial line.
      repairTornTail(file)
      fs.mkdirSync(path.dirname(file), { recursive: true })
      fs.appendFileSync(file, JSON.stringify(ref) + "\n")
    },
    verify(ref: AnchorRef): AnchorVerdict {
      const hit = readRefs().find((r) => r.source === ref.source && r.epoch === ref.epoch)
      if (!hit) return { status: "missing", detail: `${ref.source}#${ref.epoch} not anchored` }
      if (hit.root !== ref.root || hit.head !== ref.head) {
        return { status: "mismatch", detail: `${ref.source}#${ref.epoch} root/head differ` }
      }
      return { status: "ok", anchoredAt: hit.ts }
    },
  }
}

/**
 * Verifies one git note against a target ref: shows the note body, parses
 * it as an anchor ref, and compares source/epoch/root/head. A note that
 * cannot be read or parsed, or belongs to another ref, is skipped.
 * @param exec The execution seam.
 * @param projectDir The cwd for the git invocations.
 * @param noteArgs The `notes --ref=…` argv prefix.
 * @param ref The ref being verified.
 * @param noteRef The annotated object sha (the note to show).
 * @returns The verdict for this note, or undefined to keep scanning.
 */
function gitNoteVerdict(
  exec: ExecFile,
  projectDir: string,
  noteArgs: readonly string[],
  ref: AnchorRef,
  noteRef: string,
): AnchorVerdict | undefined {
  let body: string
  try {
    body = git(exec, projectDir, [...noteArgs, "show", noteRef])
  } catch {
    return undefined
  }
  let parsed: AnchorRef
  try {
    parsed = JSON.parse(body.trim()) as AnchorRef
  } catch {
    return undefined
  }
  if (parsed.source !== ref.source || parsed.epoch !== ref.epoch) return undefined
  if (parsed.root !== ref.root || parsed.head !== ref.head) {
    return { status: "mismatch", detail: `${ref.source}#${ref.epoch} root/head differ` }
  }
  return { status: "ok", anchoredAt: parsed.ts }
}

/**
 * Builds the builtin `git-note` sink: refs are stored as git notes on HEAD
 * in `refs/notes/turnstile` (repo trust domain — the git object store).
 * Publish and verify shell out to git in the project directory; a git
 * failure throws to the caller's fail-open journaling.
 * @param options The anchor options (project dir).
 * @param exec The execution seam (tests inject a routed or throwing seam).
 * @returns The sink.
 */
export function gitNoteSink(options: AnchorOptions, exec: ExecFile = defaultExec): AnchorSink {
  const noteArgs = ["notes", "--ref=refs/notes/turnstile"]
  return {
    id: "git-note",
    trustDomain: "repo",
    publish(ref: AnchorRef): void {
      git(exec, options.projectDir, [...noteArgs, "add", "-f", "-m", JSON.stringify(ref), "HEAD"])
    },
    verify(ref: AnchorRef): AnchorVerdict {
      let notes: string
      try {
        notes = git(exec, options.projectDir, [...noteArgs, "list"])
      } catch (e) {
        return { status: "missing", detail: `git notes list failed: ${String(e)}` }
      }
      for (const line of notes.split("\n")) {
        // `git notes list` prints "<note-blob-sha> <annotated-object-sha>";
        // `git notes show` takes the annotated object (the second column).
        const noteRef = line.trim().split(/\s+/)[1]
        if (!noteRef) continue
        const verdict = gitNoteVerdict(exec, options.projectDir, noteArgs, ref, noteRef)
        if (verdict) return verdict
      }
      return { status: "missing", detail: `${ref.source}#${ref.epoch} not anchored` }
    },
  }
}

/**
 * The default execution seam: real `execFileSync`, stringified.
 * @param command The command to run.
 * @param args The argv array.
 * @param options Optional child_process options.
 * @returns The command's stdout as a string.
 */
function defaultExec(command: string, args: ReadonlyArray<string>, options?: ExecOptions): string {
  return String(execFileSync(command, args, options))
}

/**
 * Builds the builtin `commit-trailer` sink (repo trust domain, corroboration
 * channel only): publish records the pending ref in
 * `<project>/.git/turnstile/trailer-anchors.jsonl` — the trailer itself is
 * added by a landing-commit flow outside core scope, so verify reports
 * `missing` until then. Verify scans recent commit bodies for a
 * `Turnstile-Anchor:` trailer matching the ref.
 * @param options The anchor options (project dir).
 * @param exec The execution seam (tests inject a routed or throwing seam).
 * @returns The sink.
 */
export function commitTrailerSink(
  options: AnchorOptions,
  exec: ExecFile = defaultExec,
): AnchorSink {
  const pendingFile = path.join(options.projectDir, ".git", "turnstile", "trailer-anchors.jsonl")
  return {
    id: "commit-trailer",
    trustDomain: "repo",
    publish(ref: AnchorRef): void {
      fs.mkdirSync(path.dirname(pendingFile), { recursive: true })
      fs.appendFileSync(pendingFile, JSON.stringify(ref) + "\n")
    },
    verify(ref: AnchorRef): AnchorVerdict {
      let bodies: string
      try {
        bodies = git(exec, options.projectDir, ["log", "--format=%B", "-n", "50"])
      } catch (e) {
        return { status: "missing", detail: `git log failed: ${String(e)}` }
      }
      const prefix = `Turnstile-Anchor: source=${ref.source} epoch=${ref.epoch} `
      for (const line of bodies.split("\n")) {
        const trimmed = line.trim()
        if (!trimmed.startsWith(prefix)) continue
        const fields = new URLSearchParams(trimmed.slice(prefix.length).replace(/ /g, "&"))
        if (fields.get("root") !== ref.root || fields.get("head") !== ref.head) {
          return { status: "mismatch", detail: `${ref.source}#${ref.epoch} root/head differ` }
        }
        return { status: "ok", anchoredAt: ref.ts }
      }
      return { status: "missing", detail: `${ref.source}#${ref.epoch} trailer not found` }
    },
  }
}

/** The result of resolving an anchor selection: the usable sinks plus one
 *  warning string per malformed selection entry (fail-open degradation). */
export interface ResolvedSinks {
  /** The sinks that resolved successfully, in selection order. */
  sinks: AnchorSink[]
  /** One warning per malformed selection entry (prefixed `anchor-sink:`). */
  warnings: string[]
}

/**
 * Resolves one selection element to a sink, or a warning on failure.
 * @param element The selection element (builtin name or `{plugin}`).
 * @param options The anchor options.
 * @param warnings The warning list to append malformed-entry warnings to.
 * @returns The sink, or undefined when the element is malformed.
 */
async function resolveSinkElement(
  element: string | { plugin: string; options?: Record<string, unknown> },
  options: AnchorOptions,
  warnings: string[],
): Promise<AnchorSink | undefined> {
  if (typeof element === "string") {
    if (element === "session-state") return sessionStateSink(options)
    if (element === "git-note") return gitNoteSink(options)
    if (element === "commit-trailer") return commitTrailerSink(options)
    warnings.push(`anchor-sink: unknown builtin sink "${element}"`)
    return undefined
  }
  return resolvePluginSink(element.plugin, element.options ?? {}, warnings)
}

/**
 * Lazy-imports an external sink module and shape-checks its factory.
 * @param specifier The module specifier to import.
 * @param sinkOptions The options passed to the factory.
 * @param warnings The warning list to append failure warnings to.
 * @returns The sink, or undefined when the import/factory/shape fails.
 */
async function resolvePluginSink(
  specifier: string,
  sinkOptions: Record<string, unknown>,
  warnings: string[],
): Promise<AnchorSink | undefined> {
  let mod: unknown
  try {
    mod = await import(specifier)
  } catch (e) {
    warnings.push(`anchor-sink: plugin "${specifier}" failed to import: ${String(e)}`)
    return undefined
  }
  const factory = (mod as Record<string, unknown> | null)?.["default"]
  if (typeof factory !== "function") {
    warnings.push(`anchor-sink: plugin "${specifier}" default export is not a function`)
    return undefined
  }
  let sink: unknown
  try {
    sink = (factory as (o: { config: Record<string, unknown> }) => unknown)({
      config: sinkOptions,
    })
  } catch (e) {
    warnings.push(`anchor-sink: plugin "${specifier}" factory threw: ${String(e)}`)
    return undefined
  }
  if (!isAnchorSink(sink)) {
    warnings.push(`anchor-sink: plugin "${specifier}" factory returned a malformed sink`)
    return undefined
  }
  return sink
}

/**
 * Shape-checks a candidate sink: string `id`, a trustDomain in the union,
 * and callable `publish`/`verify`.
 * @param value The candidate value.
 * @returns True when the value is a well-formed AnchorSink.
 */
function isAnchorSink(value: unknown): value is AnchorSink {
  if (value === null || typeof value !== "object") return false
  const s = value as Record<string, unknown>
  return (
    typeof s["id"] === "string" &&
    (s["trustDomain"] === "host" ||
      s["trustDomain"] === "repo" ||
      s["trustDomain"] === "external") &&
    typeof s["publish"] === "function" &&
    typeof s["verify"] === "function"
  )
}

/**
 * Resolves the configured anchor selection into sinks. A string names a
 * builtin; `{plugin}` lazy-imports an external factory; an array resolves
 * every element (all publish, verify intersects). Malformed entries yield a
 * warning and no sink — never a throw.
 * @param anchor The configured selection.
 * @param options The anchor options (metrics + project dir).
 * @returns The resolved sinks plus the degradation warnings.
 */
export async function resolveAnchorSinks(
  anchor: AnchorSelection,
  options: AnchorOptions,
): Promise<ResolvedSinks> {
  const warnings: string[] = []
  const elements = Array.isArray(anchor) ? anchor : [anchor]
  const sinks: AnchorSink[] = []
  for (const element of elements) {
    const sink = await resolveSinkElement(element, options, warnings)
    if (sink) sinks.push(sink)
  }
  return { sinks, warnings }
}

/**
 * Publishes refs to every sink, fire-and-forget style: all publishes run
 * concurrently and every failure becomes a returned `{sink, error}` pair
 * (never a thrown exception). A hostile sink whose `id` getter throws is
 * reported under `"unknown"` instead of breaking the fan-out.
 * @param sinks The sinks to publish to.
 * @param refs The refs to publish (each ref is copied per sink with the
 *     sink's id stamped into `sink`).
 * @returns One pair per failed publish (empty when all succeeded).
 */
export async function publishRefs(
  sinks: readonly AnchorSink[],
  refs: readonly AnchorRef[],
): Promise<Array<{ sink: string; error: string }>> {
  const results = await Promise.all(
    refs.flatMap((ref) =>
      sinks.map(async (sink) => {
        let id = "unknown"
        try {
          id = sink.id
        } catch {
          // a hostile id getter must not break the fan-out
        }
        try {
          await sink.publish({ ...ref, sink: id })
          return null
        } catch (e) {
          return { sink: id, error: String(e) }
        }
      }),
    ),
  )
  return results.filter((r): r is { sink: string; error: string } => r !== null)
}

/**
 * Verifies one ref against every sink, collecting the per-sink verdicts. A
 * throwing sink (including a throwing `id` access) is a broken verifier,
 * not a missing anchor: it is recorded as an error verdict so reports
 * distinguish it from "not anchored".
 * @param sinks The sinks to verify against.
 * @param ref The ref to verify.
 * @returns One verdict entry per sink.
 */
async function verifyRefAgainstSinks(
  sinks: readonly AnchorSink[],
  ref: AnchorRef,
): Promise<Array<{ ref: AnchorRef; sink: string; verdict: AnchorVerdict }>> {
  return Promise.all(
    sinks.map(async (sink) => {
      try {
        const verdict = await sink.verify(ref)
        return { ref, sink: sink.id, verdict }
      } catch (e) {
        return {
          ref,
          sink: sink.id,
          verdict: {
            status: "mismatch" as const,
            detail: `sink ${sink.id} verify failed: ${String(e)}`,
          },
        }
      }
    }),
  )
}

/**
 * Verifies refs across the sinks: each ref is checked against every sink
 * and the per-sink verdicts are returned with the weakest trust domain that
 * vouches for it (a ref no sink reports `ok` for is unanchored).
 * @param sinks The sinks to verify against.
 * @param refs The refs to verify.
 * @returns Per-ref verdicts plus the weakest vouching domain per ref.
 */
export async function verifyAnchors(
  sinks: readonly AnchorSink[],
  refs: readonly AnchorRef[],
): Promise<{
  verdicts: Array<{ ref: AnchorRef; sink: string; verdict: AnchorVerdict }>
  weakest: Array<{ ref: AnchorRef; domain: string | null }>
}> {
  const settled = await Promise.allSettled(refs.map((ref) => verifyRefAgainstSinks(sinks, ref)))
  const verdicts: Array<{ ref: AnchorRef; sink: string; verdict: AnchorVerdict }> = []
  for (const result of settled) {
    if (result.status === "fulfilled") verdicts.push(...result.value)
  }
  const domains = new Map(sinks.map((s) => [s.id, s.trustDomain]))
  const weakest = refs.map((ref) => ({ ref, domain: weakestTrustDomain(verdicts, domains, ref) }))
  return { verdicts, weakest }
}

/** Trust-domain strength order: external (strongest) > repo > host. */
const DOMAIN_STRENGTH: Record<string, number> = { host: 0, repo: 1, external: 2 }

/**
 * Resolves the weakest trust domain among the sinks whose verdict for the
 * ref is `ok`; null when no sink vouches for the ref.
 * @param verdicts The per-sink verdicts accumulated so far.
 * @param domains The sink-id → trust-domain map.
 * @param ref The ref to report on.
 * @returns The weakest vouching domain, or null when unanchored.
 */
export function weakestTrustDomain(
  verdicts: ReadonlyArray<{ ref: AnchorRef; sink: string; verdict: AnchorVerdict }>,
  domains: ReadonlyMap<string, AnchorSink["trustDomain"]>,
  ref: AnchorRef,
): string | null {
  const vouched = verdicts
    .filter(
      (v) => v.ref.source === ref.source && v.ref.epoch === ref.epoch && v.verdict.status === "ok",
    )
    .map((v) => domains.get(v.sink))
    .filter((d): d is AnchorSink["trustDomain"] => d !== undefined)
  if (vouched.length === 0) return null
  return vouched.reduce((a, b) => (DOMAIN_STRENGTH[a]! <= DOMAIN_STRENGTH[b]! ? a : b))
}
