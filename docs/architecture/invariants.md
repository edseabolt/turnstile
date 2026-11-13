# Design invariants

- **Fail-open vs BLOCKED.** Enforcement is fail-open: every hook body journals
  internal errors and proceeds, and the plugin always loads. Only `BlockError`
  reaches the host, and only from deliberate gate decisions, which throw
  `BLOCKED by turnstile:`.
- **Parent-keyed state.** Reads, round counts, and gate flags count against
  the parent, resolved asynchronously via `childToParent`; unresolved edges
  journal a fallback signal rather than mis-keying.
- **Provenance-scoped, stage-aware waivers.** `USER WAIVER:` / `PLAN APPROVED:`
  are honored only from the user's own prompt (hook or inbox stream, deduped
  by message id); agent-composed dispatch prompts containing those literals
  are inert. Waiver scope is literal configured stage names, not intent
  parsing: the configured agent names named in the waiver text scope it to
  those stages' gates (the plan gate is covered by either the plan-reviewer
  or executor name); an unscoped waiver covers every gate but the reviewer
  gate consumes it on the first dispatch it unlocks, and a scoped waiver
  stays live until that stage's waiver allowance is spent, metered separately
  from the ordinary dispatch caps. The family rides the same one-prompt
  replay grace (a restart resume or a `continuationCarry` re-admission) and
  is otherwise dropped on a new prompt. One exception to "covers every
  gate": the landing gate never consults the waiver. `git push` is released
  only by the credited reviewer `VERDICT: APPROVE` or the human permission
  ask, so a waiver aimed at landing is captured at admission and inert at
  that gate.
- **Latest-wins markers.** A `GATE: FAIL` un-greens an earlier PASS, within
  and across texts; dedup is per parent with first-sight provenance;
  cross-child duplicate observations are suppressed (counted, not silently
  dropped).
- **Fail-toward-strict on stale evidence.** Stale approvals are invalidated
  rather than trusted: a bound approval goes stale when its own plan is
  edited (`plan-edited`) or removed (`plan-missing`); an unbound approval
  goes stale on any plans-dir content-signature change
  (`signature-mismatch`). Restart grace survives exactly one prompt
  (`replayGrace`).
- **Marker drift is mechanically checked.** The marker regexes in
  `src/markers.ts`, the examples in `README.md`, `docs/usage.md`, and
  `agents/*.md`, the policy prose in `src/policy.ts`, and
  `scripts/evidence.mjs`'s MARKER_OK copy are validated together by
  `scripts/check-markers.mjs` (wired into `npm run ci`), including negative
  probes that reject near-miss marker text.
