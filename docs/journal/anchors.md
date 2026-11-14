# Tamper evidence: anchors and verification sinks

The chain fields and epochs are described in [the hash chain](chain.md);
verification is described in [chain.md](chain.md). This file covers the
anchor sinks.

**Anchoring (the anchor-sink boundary, `src/anchor.ts`).** A Merkle root in
the same file an attacker can rewrite proves nothing by itself, so each
committed epoch's ref (`{sink, source, epoch, root, head, ts}`) is
published to independent durable stores, the anchor sinks, at the
task-completion trigger, fire-and-forget: every publish runs concurrently,
a rejection journals an `anchor-publish:` `error` row, and nothing blocks
the pipeline. Sinks are selected by `tamperEvidence.anchor`:

| Sink                      | Trust domain | Store                                                                                                                                              | Defeats                                                                       |
| ------------------------- | ------------ | -------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| `session-state` (default) | host         | `<metricsDir>/anchors.jsonl`                                                                                                                       | lazy edit-in-place of the journal: a rewriter must also forge the second file |
| `git-note`                | repo         | git notes on HEAD, `refs/notes/turnstile`                                                                                                          | anything short of rewriting the git object store                              |
| `commit-trailer`          | repo         | `Turnstile-Anchor:` trailers on landing commits (pending refs parked in `.git/turnstile/trailer-anchors.jsonl` until the landing flow stamps them) | same, plus ties the epoch to project history                                  |
| `{plugin: "<specifier>"}` | external     | whatever the imported factory implements                                                                                                           | strongest: a store outside the host's control                                 |

An array selects several: all publish, verify intersects (a ref is anchored
when any sink vouches; the report names the **weakest vouching trust
domain** (external > repo > host)). **Caveat:** a plugin specifier is code
the host executes, so only point `plugin:` at modules you trust as much as
turnstile itself.

Each selection form, configured under `tamperEvidence.anchor`:

```jsonc
{
  "tamperEvidence": {
    "enabled": true,
    "anchor": "session-state",
  },
}
```

```jsonc
// A repo-trust anchor: every committed epoch lands as a git note on HEAD.
{
  "tamperEvidence": {
    "enabled": true,
    "anchor": "git-note",
  },
}
```

```jsonc
// Tie epochs to project history: pending refs wait in
// .git/turnstile/trailer-anchors.jsonl until a landing commit carries the
// Turnstile-Anchor: trailer; verify reports missing until then.
{
  "tamperEvidence": {
    "enabled": true,
    "anchor": "commit-trailer",
  },
}
```

```jsonc
// An external plugin sink, alone or mixed with builtins. `options` is
// passed through to the plugin factory verbatim.
{
  "tamperEvidence": {
    "enabled": true,
    "anchor": [
      "session-state",
      { "plugin": "./my-anchor-sink.mjs", "options": { "bucket": "turnstile-anchors" } },
    ],
  },
}
```

### The `{plugin}` sink contract

A plugin sink is a module (resolved by lazy `import()`, so relative paths
resolve against the config file) whose **default export is a factory**:

```js
// my-anchor-sink.mjs — minimal example: a second host-domain store.
import * as fs from "node:fs"

export default function factory({ config }) {
  // config is the `options` object verbatim: { bucket: "…" } above.
  const file = `${config.bucket}.anchors.jsonl`
  return {
    id: "my-anchor", // string, appears in verdicts
    trustDomain: "external", // "host" | "repo" | "external"
    publish(ref) {
      fs.appendFileSync(file, JSON.stringify(ref) + "\n")
    },
    verify(ref) {
      // Return { status: "ok", anchoredAt } when this store vouches for
      // the ref, { status: "missing", detail } when it holds nothing for
      // it, or { status: "mismatch", detail } when it holds a differing
      // root/head for the same source#epoch.
    },
  }
}
```

The factory is called once at setup with `{ config: <the configured
`options` object> }`. Its returned sink is shape-checked: a string `id`, a
`trustDomain` in the union, and callable `publish`/`verify` (both may be
async — `publish(ref)` receives the anchor ref `{sink, source, epoch,
root, head, ts}`; `verify(ref)` returns an `AnchorVerdict`). Every
failure path degrades fail-open: a failed import, a non-function default
export, a factory throw, or a malformed sink each become a journaled
`anchor-sink:` warning and the entry is skipped — never a boot failure.

**Row-level inclusion proofs (`prov --verify --session <id>`).** The scoped
variant folds only the shared journal and the target session's sink.
`merklePath`/`merklePathRoot` (`src/chain.ts`) derive a per-row audit
path under the same Bitcoin-style pairwise/self-hash conventions as
`merkleRoot` (odd nodes hashed with themselves, a final root self-hash —
deliberately _not_ RFC 6962/9162's copied-node tree, so the proofs verify
only against this implementation's verifier); the CLI validates each `prov:*` row's path against its epoch's
anchored ref root (`merkleOk`, `false` when an anchor disagrees with the
journal), reports the weakest vouching trust domain per row via the existing
anchor-sink verdicts, and localizes a mutated `prov:*` row (row + epoch)
while leaving the global verdict and the tamper matrix untouched.
Open-window rows, written after the last epoch close, are reported as
not-yet-anchored (`epoch: null`, with a reason) and never flip the exit
code. The same applies to rows whose epoch window spans a pruned rotation
generation: the surviving leaf list is partial, so no inclusion proof can
be derived (`epochRoot`/`merklePath`/`merkleOk` null, an "epoch window
incomplete" reason), while `epochs[].count` still reports the commit row's
declared committed count. `--json` is honored in scoped mode only; plain
`--verify` keeps its human-only output.

The anchor store grows by one ref per epoch commit (duplicates skipped by
the session-state sink), is host-local, and is bounded only by the epoch
commit rate. A hostile writer can also forge an arbitrarily large epoch
index and pollute identity numbering, but the forged commit's ref then
verifies unanchored, the host-trust-domain ceiling already described above.
