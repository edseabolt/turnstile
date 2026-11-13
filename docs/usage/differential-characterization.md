# Differential characterization harness — worked example

`npm run test:differential` drives HEAD and a reference commit through the
same inputs and compares the serialized results cell by cell. It is the
command behind a "behavior-preserving" claim, and the README only summarizes
it; this section shows what a run prints and how to read it.

### Running it

```sh
# every scenario against the default reference (138c809^)
npm run test:differential

# one scenario, against the first commit with the full decision ledger
npm run test:differential -- --scenario prov --ref 687270b
```

The default ref predates the decision ledger, so a full run reports
`prov: SKIPPED (absent in ref)` — exactly the caveat the README states: for
`prov` and recovery/replay cells use a reference at or after `687270b`, since
refs inside the partial-ledger merge window fail with a driver error rather
than a structured skip. `--keep` leaves the reference worktree on disk for
debugging. A deliberate behavior change re-points `--ref` at the commit that
introduced it (the last rule below).

### A passing run

Captured on this repo, trimmed: the real run prints one `NEW-IN-HEAD` line
per new cell (68 here), and `…` marks where lines were cut.

```text
> opencode-turnstile@0.12.0 test:differential
> node --experimental-strip-types scripts/differential.mjs

differential: HEAD (/home/lopp/Projects/turnstile) vs ref 138c809^ (26b5f8f47320)

## config: PASS (cells=836)
NEW-IN-HEAD: config.planReviewAcceptMarker=true
NEW-IN-HEAD: config.planReviewAcceptMarker=false
NEW-IN-HEAD: config.planReviewAcceptMarker=0
NEW-IN-HEAD: config.planReviewAcceptMarker=1
NEW-IN-HEAD: config.planReviewAcceptMarker=2
NEW-IN-HEAD: config.planReviewAcceptMarker=-1
NEW-IN-HEAD: config.planReviewAcceptMarker=1.5
NEW-IN-HEAD: config.planReviewAcceptMarker=""
NEW-IN-HEAD: config.planReviewAcceptMarker="x"
NEW-IN-HEAD: config.planReviewAcceptMarker="/abs"
NEW-IN-HEAD: config.planReviewAcceptMarker="on"
NEW-IN-HEAD: config.planReviewAcceptMarker="quiet"
NEW-IN-HEAD: config.planReviewAcceptMarker="off"
NEW-IN-HEAD: config.planReviewAcceptMarker="ask"
NEW-IN-HEAD: config.planReviewAcceptMarker="block"
NEW-IN-HEAD: config.planReviewAcceptMarker="enforce"
NEW-IN-HEAD: config.planReviewAcceptMarker="flag"
NEW-IN-HEAD: config.planReviewAcceptMarker="advise"
NEW-IN-HEAD: config.planReviewAcceptMarker=null
NEW-IN-HEAD: config.planReviewAcceptMarker=undefined
NEW-IN-HEAD: config.planReviewAcceptMarker=[]
NEW-IN-HEAD: config.planReviewAcceptMarker={}
NEW-IN-HEAD: config.planReviewRejectMarker=true
NEW-IN-HEAD: config.planReviewRejectMarker=false
NEW-IN-HEAD: config.planReviewRejectMarker=0
NEW-IN-HEAD: config.planReviewRejectMarker=1
NEW-IN-HEAD: config.planReviewRejectMarker=2
NEW-IN-HEAD: config.planReviewRejectMarker=-1
NEW-IN-HEAD: config.planReviewRejectMarker=1.5
NEW-IN-HEAD: config.planReviewRejectMarker=""
NEW-IN-HEAD: config.planReviewRejectMarker="x"
NEW-IN-HEAD: config.planReviewRejectMarker="/abs"
NEW-IN-HEAD: config.planReviewRejectMarker="on"
NEW-IN-HEAD: config.planReviewRejectMarker="quiet"
NEW-IN-HEAD: config.planReviewRejectMarker="off"
NEW-IN-HEAD: config.planReviewRejectMarker="ask"
NEW-IN-HEAD: config.planReviewRejectMarker="block"
NEW-IN-HEAD: config.planReviewRejectMarker="enforce"
NEW-IN-HEAD: config.planReviewRejectMarker="flag"
NEW-IN-HEAD: config.planReviewRejectMarker="advise"
NEW-IN-HEAD: config.planReviewRejectMarker=null
NEW-IN-HEAD: config.planReviewRejectMarker=undefined
NEW-IN-HEAD: config.planReviewRejectMarker=[]
NEW-IN-HEAD: config.planReviewRejectMarker={}
NEW-IN-HEAD: config.planUserReview=true
NEW-IN-HEAD: config.planUserReview=false
NEW-IN-HEAD: config.planUserReview=0
NEW-IN-HEAD: config.planUserReview=1
NEW-IN-HEAD: config.planUserReview=2
NEW-IN-HEAD: config.planUserReview=-1
NEW-IN-HEAD: config.planUserReview=1.5
NEW-IN-HEAD: config.planUserReview=""
NEW-IN-HEAD: config.planUserReview="x"
NEW-IN-HEAD: config.planUserReview="/abs"
NEW-IN-HEAD: config.planUserReview="on"
NEW-IN-HEAD: config.planUserReview="quiet"
NEW-IN-HEAD: config.planUserReview="off"
NEW-IN-HEAD: config.planUserReview="ask"
NEW-IN-HEAD: config.planUserReview="block"
NEW-IN-HEAD: config.planUserReview="enforce"
NEW-IN-HEAD: config.planUserReview="flag"
NEW-IN-HEAD: config.planUserReview="advise"
NEW-IN-HEAD: config.planUserReview=null
NEW-IN-HEAD: config.planUserReview=undefined
NEW-IN-HEAD: config.planUserReview=[]
NEW-IN-HEAD: config.planUserReview={}

## markers: PASS (cells=13)

## replay: PASS (cells=7)

## dispatch: PASS (cells=4)

## journal: PASS (cells=15)
NEW-IN-HEAD: journal.prov:stated.0
NEW-IN-HEAD: journal.prov:waiver.0

## prov: SKIPPED (absent in ref) (cells=0)
DIFFERENTIAL: PASS scenarios=6 cells=875 skipped=1 newInHead=68
```

What each line means:

- `## <scenario>: PASS|FAIL (cells=<n>)` — one block per scenario, in
  `config`, `markers`, `replay`, `dispatch`, `journal`, `prov` order. A
  **cell** is one input probe plus its full serialized result: `config`
  probes every scalar `defaultConfig()` key against a fixed
  matrix, which is why that scenario alone has 836 cells; the
  others key on their own surface — `journal` by entry type and per-type
  occurrence, `replay` by fixture name.
- `NEW-IN-HEAD: <cell>` — a cell the reference tree does not have. Surface
  growth is expected and never fails the run.
- `SKIPPED (absent in ref)` — the scenario's driver needs a module the
  reference tree lacks, so there is nothing to compare: `cells=0`, and the
  skip does not fail the run.
- `DIFFERENTIAL: PASS scenarios=6 cells=875 skipped=1 newInHead=68` — the
  machine-parseable summary. Exit 0 only when no scenario failed; skips are allowed.

The targeted invocation prints the same shape for one scenario, with the
ledger present in both trees:

```text
$ npm run test:differential -- --scenario prov --ref 687270b
…
## prov: PASS (cells=12)
DIFFERENTIAL: PASS scenarios=1 cells=12 skipped=0 newInHead=0
```

### A failing run (illustrative)

A real failing run was not captured for this doc, so this shape is
illustrative. A diverged cell prints its first
divergence as a line diff over the stable serializations, then the removal
lines, then a summary that names the failed scenarios.

An example is shown below:

```text
## replay: FAIL (cells=7)
--- ref replay.refused-approve
+++ HEAD replay.refused-approve
-{"drops":0,"sessions":{"p1":{"hasReviewApprove":false,…
+{"drops":0,"sessions":{"p1":{"hasReviewApprove":true,…
REMOVED-IN-HEAD: replay.recovery-row
DIFFERENTIAL: FAIL scenarios=6 cells=875 failed=1 skipped=1 newInHead=68 [replay(2)]
```

`--- ref <cell>` / `+++ HEAD <cell>` name the cell and the two trees; `-`
lines exist only in the ref, `+` lines only in HEAD. `REMOVED-IN-HEAD:` is a
cell the ref had and HEAD lost. The trailing `[replay(2)]` names each failed
scenario with its diverged-plus-removed cell count. The command exits 1.

### Drift-tolerance rules

All four live in `scripts/differential.mjs`; know them before reading a run
as a verdict:

- **Skip on absent in ref.** A scenario whose driver needs a module the ref
  tree lacks reports `SKIPPED (absent in ref)` instead of crashing.
- **Growth is non-failing.** Cells present only in HEAD print
  `NEW-IN-HEAD:` and count toward `newInHead=`, but didn't fail the run.
- **Removal and divergence fail.** A cell present only in the ref
  (`REMOVED-IN-HEAD:`) or holding a different value (the `--- ref`/`+++ HEAD`
  diff) fails its scenario.
- **Re-point after a deliberate change.** When you change behavior on purpose,
  point `--ref` at the commit that introduced the change.
