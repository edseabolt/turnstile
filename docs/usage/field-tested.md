# Field-tested on itself

Turnstile is built with turnstile: most of this plugin's own development
runs through the pipeline it enforces, gates and journal on, so the
enforcement doubles as a field test. In the first week of that (Oct 8–15,
2026), the journal records ~350 pipeline dispatches and ~390 blocked calls
on this repo. Most of those blocks are the read-horizon cap doing its
unglamorous job; about 65 caught real pipeline violations: executor
dispatches without an approved plan, unverified `GATE: PASS` claims, invalid
commit subjects, and unapproved pushes that never landed.

This repo now runs the landing gate enforced: an unapproved push is
refused, not journaled. The flip was motivated by 54
`no-landing-approval` would-blocks across 38 sessions — pushes the
approved ensemble had actually earned, recorded by the observe-mode
journaling that predates enforced landing. A fix to
the delivery-credit path (a reviewer `VERDICT: APPROVE` delivered without
`input.agent` never credited the gate) landed before the flip, so the
enforced gate releases on approvals it would otherwise have missed.

Don't take this section at face value: run `npx opencode-turnstile status`
and read the journal yourself.

Publishing that record is part of the field test: this repo ships the
evidence workflow under `.github/workflows`, so the pipeline claims a
reviewer would otherwise take on faith are posted on the pull request
itself — the same artifact the `evidence` command emits, validated in the
untrusted job and published from the base-context one.
