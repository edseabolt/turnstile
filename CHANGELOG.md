# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com). The
project is pre-1.0: 0.x minor bumps may carry breaking changes, noted in the
version section.

## [Unreleased]

## [v0.18.0] - 2026-11-25

### Added

- `opencode-turnstile status` compares the plugin version loaded by the
  running host against the installed package version and warns when the
  loaded copy is older, usually a stale plugin symlink or an un-restarted
  host after `npm run init` or an upgrade (#399). The check fails open: an
  unparseable installed version skips it rather than erroring the status run.

### Fixed

- Token usage accumulates and flushes on the host's 2.4.1 event contract;
  `message.updated` sessions resolve from `info.sessionID`, fixing
  attribution when the event's session context differs (#397, #398).
- `sessionTokenTotals` prefers the session-rollup row, so per-message and
  rollup rows are never double-counted.
- Rollup and summary rows are journaled before the session-end awaits, so a
  slow downstream handler can no longer drop the final rows.

### Documentation

- README explains how to verify the running plugin version after an upgrade
  (#399).
- The d02 hooks diagram names both event contracts; token-usage JSDoc synced
  (#398).
- Prose across the repo brought to a conservative em-dash level and the rule
  codified in AGENTS.md (#396).

## [v0.17.0] - 2026-11-24

### Added

- Per-session token-usage journaling (#392): completed assistant turns are
  journaled as `token-usage` rows keyed by the `childToParent`-resolved
  parent, deduplicated by `messageID` so one row lands per assistant turn.
  Rows are replay-inert. The idle rollup flush runs even when session
  summaries are off.
- New `tokenUsage` config key (`off`/`summary`/`per-message`, default
  `summary`), mirrored across the schema and
  `examples/turnstile.example.json`.
- New `src/token-usage.ts` boundary: pure extraction, merge, and rollup
  helpers over `message.updated` snapshots.
- Token usage in the CLI (#392): `opencode-turnstile status` appends a
  per-task token/cost rollup (also carried in `--json` under `tokenUsage`);
  `opencode-turnstile log` renders token rows and a totals line. Source
  selection is rollup-preferred per session; rotated generations and gzip
  archives are read.

### Changed

- Removed a plan file tracked under the gitignored `.opencode/` directory.
- Dev-dependency group bump (dependabot).

### Documentation

- README documents the capability: trace and telemetry row, CLI-section
  sentence, and a `tokenUsage` config-table row (#393).
- Journal reference documents both `token-usage` row shapes; architecture
  docs and the d02 hooks diagram updated in the same change sets (#392).

## [v0.16.0] - 2026-11-19

### Added

- Journal archive-on-rotate (#384): pruned journal generations are
  gzip-compressed into an `archive/` directory instead of being deleted,
  bounded by the new `journalArchiveGenerations` key (default 5). The
  archive is cold storage only: replay never reads it; `verify` and the CLI
  surfaces do.
- Evidence freshness in the PR flow (#377, #372, #375): the injected policy
  instructs an evidence refresh before every PR-adding push; the staleness
  comparison walks back to the parent commit for evidence-only heads and
  emits a journal event at comparison time; the evidence-only check detects
  files-list truncation instead of trusting a clipped manifest.
- Marker diagnostics: `config-validate` warns when a custom marker regex
  compiles but has no capture groups (#366); delta-truncated marker spans
  journal a diagnostic, with the probe suppressed for spans already seen
  complete (#364).

### Fixed

- Chained appends are serialized across hosts with a file lock (bounded
  retry, mtime-based stale steal), fixing multi-host journal corruption
  (#383).
- The append hot path amortizes per-row `mkdir` and torn-tail repair to once
  per append batch (#385).
- Chained telemetry error and rekey rows route through the journaler, so
  they enter the hash chain instead of bypassing it (#386).
- Evidence: a child-keyed latest line resolves to the parent session (#382);
  the artifact's journal read is scoped to the task's session tree (#368).
- Delivery: parent-keyed string deliveries are classified as parent-authored
  by event origin, fixing misattributed verdicts (#381).
- Dispatch: tamper stamps are keyed by parent and agent, avoiding false
  positives under concurrent dispatches (#378); armed probes and pre-gate
  read paths peek instead of minting evidence (#369).
- Policy: the retry prompt restates the marker syntax; injected texts carry
  a hash stamp (#378).
- The prompt hook body is wrapped fail-open, so a body error can no longer
  block prompt admission (#365).

### Changed

- OpenCode 2.3.2 added to the tested host list (`HOST_COMPAT` and the README
  matrix).

### Performance

- The fingerprint hot path collapses to a single `git rev-parse` with a
  250 ms timeout (#379).

### Documentation

- All 22 actionable findings from the 2026-11-18 deep documentation audit
  are fixed (#387): swapped parameter docs, stale reader attributions,
  fabricated module-map edges and missing module nodes in the d01 diagram,
  and retention math updated for archive-on-rotate.

## [v0.15.0] - 2026-11-14

### Added

- Scoped provenance verification (#330): `prov --verify --session <id>`
  reports per-row inclusion facts (anchored with its Merkle proof,
  unanchored, or pruned) with the committed epoch count, exiting 0 with the
  facts either way. A mutated prov row localizes the tamper to the row and
  its epoch in both JSON and human output. The unscoped `prov --verify`
  contract is tightened alongside: pruned-window rows report null proofs
  rather than failing the check.
- Planner write confinement (#331): planner child write and edit are
  confined to the configured `plansDir`; writes outside are blocked with the
  directory named. Custom relative and absolute `plansDir` values are
  honored; executor and other pipeline children stay exempt.

### Fixed

- Subagent verdicts are credited from synthetic inbox completions; synthetic
  verdicts dedupe per child and `refusedApprove` suppression is covered at
  replay and credit time (#342, #336).
- The plan-gate arm on permission evaluations routes on both `task` and
  `subagent` actions, so executor dispatches through either shape hit the
  gate (#344).
- The marker-retry prompt tells the child its output was received and
  parsed, instead of implying it was lost (#348).
- The differential harness default ref is re-pointed at the
  requirements-phase commit (#333); the hermetic git test env points at an
  empty temp file instead of `/dev/null` (#328).

### Changed

- `docs/architecture.md` and `docs/usage.md` split into per-section files;
  `docs/journal.md` split under `docs/journal/` with config examples for
  every anchor sink and the plugin-sink contract (#334, #338, #332).
- README compatibility matrix updated to turnstile 0.15.x with OpenCode
  2.3.0 added to the tested list.

### Documentation

- Plain-language (ISO 24495-1) pass across the split docs, README trim, and
  diagram prose synced with code (#337, #335, #334).
- The journal audit-path description is corrected: the tree is Bitcoin-style,
  not RFC 6962/9162 (#340).
- All 17 findings from the 2026-11-13 deep documentation audit are fixed
  (#346); `turnstile-config` quotes the actual config-warning wording (#347).

## [v0.14.0] - 2026-11-12

### Added

- Journal tamper evidence (#312): with `tamperEvidence.enabled` (default
  `false`; existing journals and consumers stay on the unchained row shape),
  every journal row carries `seq`, `prevHash`, and `hash` (SHA-256 over
  canonical JSON). Every `tamperEvidence.epochEntries` (default 512) data
  rows, a chained `chain-epoch` commit row carries the epoch's Merkle root
  and head.
- Anchor sinks: epoch refs publish fire-and-forget at task completion to
  independent stores in escalating trust domains (`session-state` on the
  host by default, `git-note` and `commit-trailer` in the repository, or an
  external plugin sink); an array publishes to all and verification reports
  the weakest vouching domain.
- `opencode-turnstile prov --verify` folds the chain across rotation
  generations, re-derives epoch roots, and cross-checks anchored refs;
  `tamperEvidence.verifyOnSessionEnd` runs the same check once per session
  at idle and journals the verdict. The config surface is mirrored in the
  example config, schema, README config table, and the architecture docs.
- Differential tamper-matrix harness (#312, #315): nine mutation classes
  pinned to expected `prov --verify` verdicts; the un-anchored tail is a
  deliberately documented blind spot.

### Fixed

- Marker results are classified from the regex capture group, so surrounding
  text no longer leaks into classification (#310).
- Chain verify hardened against restart, rotation, and multi-host edge
  cases: monotonic epoch indices across rotations and trust-root handling
  for pruned generations (#312).

### Documentation

- Replay global re-slice inclusion and boot memory bounds documented (#302,
  #304, #303).
- README compatibility matrix row updated to turnstile 0.14.x; `HOST_COMPAT`
  unchanged (floor stays OpenCode >= 2.0.22, < 3.0.0).

## [v0.13.0] - 2026-11-10

### Added

- Optional requirements phase (#306): `requirementsPhase` (default `false`)
  inserts a requirements agent leg before the planner, capped by
  `maxRequirementsRounds` with waiver exemption, mirrored in the example
  config, schema, and `agents/requirements.md`. The pipeline-status
  formatter renders the stage, and the policy injection describes the phase
  only when it is on.
- Decision-ledger derivations (#290, #298, #289, #288):
  `opencode-turnstile prov-views` derives origin labels for stated prompts,
  chatter noise rate, and taste-drift aggregates over denials and overrides;
  parent write/edit journals `prov:override` rows with child-write
  adjacency attribution; plan-gate and reviewer-gate waiver sites journal
  `prov:waiver` rows; new `turnstile-prov-views` skill vendored alongside
  `turnstile-prov`.
- Differential characterization harness (#292): behavior-pin tests pin gate
  messages, config, journal shapes, decision-ledger shapes, replay
  round-trips, and export shape against drift.

### Fixed

- Reviewer dispatches admitted through the dormant dispatch admit path now
  count toward the review ensemble, closing a hole where a credited approval
  could land without the ensemble being satisfied (#293).

### Changed

- All functions brought under the 30-line ceiling (#305).
- Docs audit fixes across the architecture and usage docs, policy prose, and
  the d01 to d05 diagrams (#287); hero banner decision-ledger chip sizing
  fixed.
- OpenCode 2.2.7 added to the host compatibility tested list.

## [v0.12.0] - 2026-11-09

### Added

- Decision ledger (#277): every admitted parent-session prompt journals a
  `prov:stated` entry (secret-redacted at write time, capped at 2000 chars
  with a `truncated` marker), and each human permission denial at the ask
  sites journals a `prov:denied` entry with the ask kind. Capture is gated
  on `decisionLedger.enabled` (default `true`); rows are replay-inert and
  capture is fail-open.
- `opencode-turnstile prov [sessionID] [--json] [--tail <n>]`: new read-only
  CLI subcommand printing the ledger, every session interleaved or one
  session by ID.
- Redaction: a fixed pattern list (API keys, AWS access keys,
  bearer/authorization headers, GitHub tokens, private-key blocks) replaces
  matches with `[REDACTED]` before truncation, so a secret straddling the
  cap boundary is never left half-visible.
- New pure modules `src/decision-ledger.ts` (entry builders) and
  `src/decision-ledger-redact.ts` (redaction); payloads are canonically
  serializable so a future tamper-evidence chain needs no migration.
- README hero and demo SVGs include the decision ledger in the rendered
  pipeline (#278).

### Changed

- Docs, the d02 hooks diagram, the usage configuration table, and README
  updated for the ledger and the `prov` command.

## [v0.11.0] - 2026-11-04

### Added

- Opt-in user plan review (#269): a config gate pauses the pipeline before
  plan-reviewer dispatch so you can review the plan yourself first; your
  approval enters the gate flow directly.
- Skill surface rework (#263, #266): `turnstile-suspend` is replaced by
  `turnstile-on` and `turnstile-off`; new `turnstile-evidence` and
  `turnstile-config` skills publish and inspect evidence bundles and show
  the resolved configuration; `turnstile-status` and `turnstile-log` ship as
  skills instead of commands; `turnstile-setup` is renamed `turnstile-init`.

### Fixed

- A rejected dispatch now clears the nudge latch via a shared retire helper
  (#271).
- The retired-path sweep removes repo-owned dangling symlinks and emptied
  directories (#265).
- Boolean keys are terminal in scalar validation, so `true`/`false` no
  longer fall through string coercion (#268).

### Changed

- `turnstile-config` shows raw config contents in its report;
  `docs/usage.md` documents the retired-path sweep in install maintenance.
- Module-split refactor wave (#264): hooks core composed from module-level
  concern state, with extraction of dispatch, budget, and review gates, plan
  scan/status/enforce modules, ledger parent-edge registry, tool-policy
  guards, event stream handlers, permission evaluate arms, journal sinks,
  prompt admission, bash-write guards, config merge/validate, shell parsing,
  and verdict capture. Module map and d01/d02/d04 diagrams re-synced.

## [v0.10.0] - 2026-11-01

### Added

- Dormant-until-engaged enforcement (#254): the gates no longer fire from
  session start; enforcement activates when the pipeline engages (plan
  bound, dispatch made, or gate state present). `alwaysEnforce` opts back
  into always-on enforcement. New module `src/engagement.ts`.
- Plan-impact advisory (#256): while a plan is bound, the parent's
  out-of-plan writes are classified against the plan scope
  (`src/plan-scope.ts`) and the hands-on ladder decides, instead of blocking
  outright; landing-gate preservation and relativized plan-impact targets
  (#247).
- Marker-retry compliance loop (#251): bare subagent output that omits gate
  markers gets one bounded retry with the marker contract re-stated before
  the gate fails.
- `opencode-turnstile log session` renders a per-session timeline from the
  journal, with corrected credit folding, waiver counting, and rendering of
  policy, tool, permission, and evidence rows (#253).
- Per-session journal segmentation (#252): the `journalPerSession` config
  key routes each parent session's journal rows to its own sink; replay
  merges per-session generations ts-ordered with the shared tail; `status`
  and `evidence` read segmented sinks.
- Commit-lint classifier gives a concrete mismatch diagnosis and escalates
  through a retry, and requires the separator space its regex always
  demanded (#257).

### Changed

- Plan gate: write targets outside the project are classified uninspectable
  so the hands-on ladder decides, rather than the plan gate guessing (#258).

### Fixed

- Commit-lint classifier requires the separator space the regex requires
  (#248); landing gate preserved and plan-impact targets relativized (#247).

### Security

- Dependency override: `minimatch` pinned to ^11.0.1 (CVE-2026-118764).

## [v0.9.0] - 2026-10-31

**Breaking:** the observe/meta-mode config keys are gone; there is one
enforcement mode, and config carrying the removed keys is rejected with a
diagnostic (#220). The new `escalation: ask|block` key replaces the old
implicit behavior: `block` (default) releases only on your explicit
approval, `ask` prompts (#224). Gate state is keyed on the active plan, with
legacy durable plan approvals re-keyed transparently on replay and the
migration surfaced as a `status` table advisory (#231, #237).

### Added

- Hands-on gate (#218, #229, #231): the parent session's own write and edit
  calls, and bash commands that write files (heredocs, `tee`, redirection,
  `sed -i`, `dd`), route through the same escalation ladder the pipeline
  uses. Registered pipeline children stay exempt, heredoc-bearing commands
  cap at telemetry, and scratch temp-dir targets are exempt.
- Governance redesign (#231): prompt intent classification with a policy
  head and intent nudge on the `session.context` primary-turn draft; an
  ask-first escalation ladder whose releases are sticky for the task scope
  and restored from the journal on replay; a dedicated maintenance dispatch
  path with an MNT column in `status`; child edges journaled at `setParent`
  and re-seeded on setup.

### Fixed

- Interrupted review state is recovered from the journal, task fingerprints
  restored on gate rows, and verdict replay attributed to the emitting agent
  (#236).
- Classifier skips `tee` dev and fd-dup operands, `dd of=` dev targets, and
  prefix words.
- Agent-name precedence for pipeline-child registration; the delivery agent
  resolves input echo before `event.agent`.
- Gate-events trace renamed to `.log`.
- Factual-defect fixes across README, usage, architecture, AGENTS, skills,
  and source docstrings; d01/d02/d04 diagrams synced with code (#238).

## [v0.8.0] - 2026-10-28

### Added

- Gate suspend and resume (#212): a user-typed `TURNSTILE OFF:` suspends
  blocking for the session (gate decisions keep being computed and journaled
  but never throw; all earned state clears) and `TURNSTILE ON:` resumes
  enforcement with a fresh task scope. The literals are config keys
  (`suspendMarker` / `resumeMarker`); `allowSuspend: false` refuses both
  with a journaled diagnostic. The markers are honored only from admitted
  user prompts. A thin `turnstile-suspend` skill documents them, and
  `opencode-turnstile status` gains a per-session suspension column.
- Host-compat detection (#210): at setup, the running opencode version is
  evaluated against a declared compatibility window (>= 2.0.22, < 3.0.0) and
  fails open, surfacing a verdict toast instead of silently misbehaving on
  an untested host. The tested list now includes 2.2.0.
- Session-end summary (#208): when a session goes idle, one recap line
  reports what the pipeline verified: test-claims credited, premature
  dispatches blocked, waivers spent. `sessionSummary` ships `quiet` (silent
  for zero-activity sessions), `on`, and `off`.

### Fixed

- Install refreshes the ledger version stamp on content-identical upgrades
  (#206).
- An explicit empty `bareOutput` resolves as unset instead of trapping the
  bare-output gate (#204).

## [v0.7.0] - 2026-10-27

### Added

- `opencode-turnstile evidence`: folds the journal's replay window into a
  shareable `turnstile-evidence/v1` document with derived counts, canonical
  marker lines, and shas only; session IDs, prompts, and command text are
  absent by construction. `--validate` re-checks a committed artifact in CI;
  `--format markdown` renders the sticky-comment body. The review section
  reports against the ensemble bar the runtime credits at.
- Sticky PR-comment Action (`examples/turnstile-evidence.yml`): a
  `pull_request` validate job with read-only permissions, and a
  `pull_request_target` publish job that reads the committed artifact
  through the Contents API and upserts exactly one comment keyed on
  `<!-- turnstile:evidence -->`.
- Turnstile's own repo runs the evidence workflow on its pull requests; the
  live demo caught two real Actions-runtime bugs before any consumer did,
  both fixed here.

### Fixed

- The evidence review bar derives from `reviewEnsemble` (the credit rule),
  not `maxReviewerRounds` (the dispatch cap); a fully-credited task can no
  longer render `reviewer 2/4` red.
- Evidence marker fields sanitized, validate crash paths guarded, and the
  forged-green bypass closed (#193).
- Marker parser regexes guarded against broadening drift in check-markers
  (#194).
- Copy-mode installs the full `src/` tree and verifies plugin load (#195).

## [v0.6.1] - 2026-10-26

### Added

- `gitGates.emptyDiffExempt` (default `true`; `false` is the strict opt-out):
  the landing gate releases `git push` commands whose every refspec resolves
  to the same commit as its upstream ref. Force flags, `--mirror`, `--tags`,
  explicit shas and ranges, detached HEAD, and unresolvable upstreams still
  gate; a branch behind its upstream never qualifies. A force/rewind bypass
  was caught by the reviewer ensemble and closed before landing (#182). New
  `src/empty-diff.ts` boundary.

### Documentation

- Module-map row for `empty-diff.ts`; d01/d03/d04 diagrams updated;
  README, usage, schema, and example JSON synced.
- Branching model documented: `dev` is the default protected development
  branch; `main` is release-only, promoted by a dev-to-main PR.

## [v0.6.0] - 2026-10-26

### Added

- Observe mode (#180): the new `observeSessions` config key runs turnstile
  in an observe phase where gate decisions are journaled without blocking,
  so you can evaluate the pipeline's verdicts before letting it enforce.
  Observe entries replay-fold, enforcement is suppressed in hook bodies
  during the phase, and `opencode-turnstile status` surfaces an
  end-of-period observe summary.

## [v0.5.1] - 2026-10-26

### Changed

- The npm package now carries the value-first README from #174. No runtime
  behavior changes; package version bump only (#175).

## [v0.5.0] - 2026-10-25

### Added

- The planner carries a mandatory pre-completion verification checklist
  (#165).

### Fixed

- Stale rotation locks are stolen and stale comments corrected (#158).
- Byte-identical approved plans are durably exempt from the executor plan
  gate (#159).
- The plan-approval gate is scoped to the plans the dispatch resolves (#161).
- Sub-chunk citations are admitted in the decomposition gate (#167).
- Earned landing approval carries across continuation prompts (#168).
- The landing ask escalates on the first push after a credited reviewer
  approval (#169).

## [v0.4.0] - 2026-10-24

**Breaking:** config-acceptance changes reject some configs v0.3.0
accepted: non-integer numeric config values are now rejected; a relative
`TURNSTILE_METRICS_DIR` is warned about and ignored (telemetry stays in the
default directory); `agents.bareOutput: []` now explicitly disables the
built-in derivation (delete the key to inherit the default).

### Fixed

- Dispatch budget is metered only at the admitted exit: blocked attempts no
  longer draw down the loop counters; waived dispatches meter with the
  admission-time verdict (#151, #139).
- The waiver family (`userWaiver`, `userWaiverScope`, `userWaiverConsumed`,
  `reviewWaiverRounds`) carries through `mergeAfterReplay` (#152, #140).
- `latch-steal` and `forced` telemetry journal on `permission` entries (#153,
  #141).
- Config validation enforces integer numerics, the `bareOutput` unset
  sentinel, and only absolute `TURNSTILE_METRICS_DIR` (#156, #144).
- The ledger validates replay input across retained generations (session-ID
  shape, marker-length bound) (#148, #134).
- A clean event-stream close no longer burns the restart budget (#147).
- Git gates inspect `-am` commit clusters; bare-word commit false positive
  fixed (#146).

### Changed

- Oversized hook functions split; shared DRY helpers extracted
  (`src/bounded.ts`, `gates-common` composers) (#155).

### Documentation

- Dispatch metering at the guard exit and restart-budget throw semantics
  documented; README and usage notes for the `bareOutput` sentinel and the
  absolute metrics-dir requirement.

## [v0.3.0] - 2026-10-21

**Breaking:** the default `bashDeny` is now empty; git and gh consent rides
the host permission ask instead of turnstile's denylist (#117, #58). Human
`PLAN APPROVED` prompt approvals are stamped with `plansSig`; stale or
offline plan edits no longer replay unstamped approvals (#118, #110).

### Added

- Journal rotation (`rotateEveryEntries`) and replay-tail knobs plumbed into
  config (#126, #123).

### Fixed

- The delta window derives from effective marker sources; single-source ask
  TTL and diagnostic block formatter (#127, #124).
- No-agent reviewer approvals are credited via edge and record so the
  landing gate passes (#132, #129).

### Changed

- `src/gates.ts` split into per-gate modules (#119, #113); `src/setup.ts`
  split into per-hook-surface modules (#121, #114); `src/ledger.ts`
  extracted from `src/state.ts` (#120, #115); orchestrator policy text built
  from resolved config (#125, #122).

### Documentation

- Temp-HOME integration tests cover the mutating install core (#128).
- README restructure, `docs/usage.md`, prose humanization, and
  agent-definition churn reduction (#130 to #134).

## [v0.2.10] - 2026-10-21

### Added

- Near-miss diagnostics for mistyped waiver and approval markers (#105).

### Fixed

- Stage-scoped user waivers with deterministic grammar (#107).
- `WAIVED` journals only for admitted reviewer dispatches; waiver state is
  reported at budget blocks (#107).
- The plan dir signature is journaled and replayed so restarts validate
  replayed approvals (#111, #43); replay-staleness closure is scoped to
  reviewer verdicts (#111).
- Metered child sessions release on parent prompt (#112, #40).

### Changed

- Execute.before dispatch branches extracted; the read warning fires once
  per task (#109).

## [v0.2.9] - 2026-10-19

### Added

- Per-delivery PIPELINE status tail and continuation imperative (#103).

### Fixed

- The project-directory fallback is scoped per session, deleting the
  session-global last-writer; resolver-witnessed directory swaps journal as
  `session_move` telemetry (#101, #44).

### Documentation

- `turnstile-setup` works in npm and npx contexts (#102).

## [v0.2.8] - 2026-10-18

### Added

- Config-validation warnings surface to the user; a JSON schema ships;
  diverging marker regexes warn (#92).

### Fixed

- Background test-runner evidence attributes to the parent task scope (#93).
- Policy injection attributes via the `childToParent` edge; conservative
  skips are journaled (#95).
- Plan identity binds to the session's approved plan (#96, #94).
- Both host delivery shapes are classified; unrecognized results fail loud
  (#97).
- Evidence pattern misses fixed: `npm run ci` and flag-interpolated
  `node --test` are recognized (#99).

## [v0.2.7] - 2026-10-17

### Added

- A concrete gate-state snapshot is injected at compaction (#85).

### Fixed

- MEDIUM-LOW batch (S7 to S12): six small enforcement defects (#83).
- Marker-authority guards for quoted and observed markers (#84, #46).

### Changed

- `npm test` made deterministic via `--test-isolation=none`, closing the
  real coverage holes (#78).
- Dev-dependency group bump (dependabot) (#79, #80).

### Documentation

- "turnstile is built with turnstile" (#76).

## [v0.2.6] - 2026-10-16

### Added

- Per-leg dispatch loop caps with escalation on cap exhaustion (#63).
- The reviewer ensemble is mechanically enforced with a per-task dispatch
  count (#65).

### Fixed

- Round-scope plan-verdict attribution to the current review round (#66).
- Prompt-channel waivers and approvals restored (nested payload shape and
  inbox transport) (#68).
- Earned gate state carries across continuation prompts (#69, #45).

### Documentation

- Architecture reference, README overhaul, config-sync guarantees (#70);
  DRY/SOLID rules and test-runner gate discipline (#71); diagram
  inaccuracies fixed and executor added to gate state (#72); the
  branch-coverage diagnostic referenced and then unreferenced (#73, #74).

## [v0.2.5] - 2026-10-15

### Added

- Git gates and landing enforcement (#35): new `gitGates` config (shadow
  mode by default) with commit-message lint, reviewer-gated landing, landing
  escalation to human approval, once-grant scoping to pushes, and one-shot
  latching.
- Human-in-the-loop plan approval (#34): a prompt-channel user waiver
  replaces the dispatch-prompt grep; permission-escalated plan approval with
  reply consumption; new `turnstile status` CLI subcommand over the journal.
- Tool-call denylist policy (#32): configurable denylist for bash, shell,
  write, edit, and session_move (enforce/shadow/off) with hardened default
  regexes against git global options.
- Runtime policy injection (#28): the orchestrator policy is injected into
  the primary session at runtime; the AGENTS.md contract-block installer is
  retired.
- Evidence-correlated `GATE: PASS` (#33): PASS markers are correlated with
  journaled test-command evidence.

### Fixed

- Live-parent gate buckets are protected from LRU eviction (#42).
- Self-keyed plan-reviewer verdicts are rescued via plausibility join (#54).
- The child-to-parent edge is awaited before the read-budget guard (#41).
- Gate-event suppressed counts only gate-kind cross-child hits;
  plan-reviewer verdict attribution re-keyed to the parent session (#51).
- Fail-open journaling, config validation, dedup accounting, installer CLI
  polish, and the CI contract split (#22).
- Waived reviewer dispatches bypass the round cap; plan approvals are
  invalidated per session via a content-hash `plansSignature` (catches
  same-mtime edits).

## [v0.2.1] - 2026-10-11

### Changed

- Updated the npm package description (the old one omitted
  plan-reviewer/debugger and predated the model-config work). Metadata-only
  release; no code changes.

## [v0.2.0] - 2026-10-11

**Breaking:** `agents/*.md` no longer pin `model:` frontmatter; subagents
inherit the dispatching session's model, and per-agent pins live in
`~/.config/opencode/opencode.json` under `agents.<name>.model`. Installs
(symlink or copy) carry zero user state (#10).

### Added

- Model-config printer: `npm run init -- --print-model-config` prints a
  ready-to-paste `{"agents": {…}}` snippet and writes nothing. Repeatable
  `--model [name=]provider/model[#variant]` seeds; `--validate` checks
  concrete specs against `opencode models`.

### Fixed

- Multi-segment model ids supported; the grammar splits on the first `/`.
- Orphan `--model`/`--validate` without `--print-model-config` exit 2 with
  an actionable message instead of silently running an install.
- `opencode-turnstile init -- --print-model-config` works (the router strips
  the `--` separator).
- `opencode models` spawn failures report the real cause instead of
  misreporting every model as unknown.

## [v0.1.1] - 2026-10-10

### Added

- First npm release of `opencode-turnstile`: install via
  `npx opencode-turnstile init`, plugin-array only, or dev from clone, with
  auto-detect (checkout links, package copies) and `--link` / `--copy`
  override.
- Commands: `init`, `check` (warn-only outdated report), `uninstall`
  (ownership-aware, idempotent), `version`.
- Ledger records destination, source, hash, package version, and install
  mode; legacy ledgers migrate on load.
- Legacy AGENTS.md adoption: equivalent sections wrapped in sentinels,
  differing sections backed up and replaced, `--no-adopt` opt-out, refusal
  only for ambiguous or corrupted targets.
- Vendored `turnstile-setup` skill shipped in the package.
- Published via npm trusted publishing (OIDC) with staged publishing: the
  tarball was CI-gated, provenance-signed, and approved with 2FA before
  going live.

## [v0.1.0] - 2026-10-09

### Added

- Initial public release: turnstile gates the planner, executor, test-runner,
  and reviewer pipeline from OpenCode v2 runtime hooks, not from prompts.
- Reviewer dispatch gate: blocked until a journaled `GATE: PASS`, or an
  explicit `USER WAIVER:` in the dispatch prompt.
- Reviewer round cap (2 per task without a green gate), executor
  decomposition gate (`chunk-N` / `AC-n` citation), and read horizon.
- `GATE:` / `VERDICT:` marker parsing with a JSONL journal; gate state
  survives restarts via replay.
- Fail-open hooks: the only refusals are deliberate `BLOCKED by turnstile:`
  throws.
- Symlink or copy install from the checkout per `install.json`; the five
  bundled agent definitions ship with the author's local `model:`
  frontmatter, so set your own before dispatching.

[Unreleased]: https://github.com/edseabolt/turnstile/compare/v0.18.0...HEAD
[v0.18.0]: https://github.com/edseabolt/turnstile/compare/v0.17.0...v0.18.0
[v0.17.0]: https://github.com/edseabolt/turnstile/compare/v0.16.0...v0.17.0
[v0.16.0]: https://github.com/edseabolt/turnstile/compare/v0.15.0...v0.16.0
[v0.15.0]: https://github.com/edseabolt/turnstile/compare/v0.14.0...v0.15.0
[v0.14.0]: https://github.com/edseabolt/turnstile/compare/v0.13.0...v0.14.0
[v0.13.0]: https://github.com/edseabolt/turnstile/compare/v0.12.0...v0.13.0
[v0.12.0]: https://github.com/edseabolt/turnstile/compare/v0.11.0...v0.12.0
[v0.11.0]: https://github.com/edseabolt/turnstile/compare/v0.10.0...v0.11.0
[v0.10.0]: https://github.com/edseabolt/turnstile/compare/v0.9.0...v0.10.0
[v0.9.0]: https://github.com/edseabolt/turnstile/compare/v0.8.0...v0.9.0
[v0.8.0]: https://github.com/edseabolt/turnstile/compare/v0.7.0...v0.8.0
[v0.7.0]: https://github.com/edseabolt/turnstile/compare/v0.6.1...v0.7.0
[v0.6.1]: https://github.com/edseabolt/turnstile/compare/v0.6.0...v0.6.1
[v0.6.0]: https://github.com/edseabolt/turnstile/compare/v0.5.1...v0.6.0
[v0.5.1]: https://github.com/edseabolt/turnstile/compare/v0.5.0...v0.5.1
[v0.5.0]: https://github.com/edseabolt/turnstile/compare/v0.4.0...v0.5.0
[v0.4.0]: https://github.com/edseabolt/turnstile/compare/v0.3.0...v0.4.0
[v0.3.0]: https://github.com/edseabolt/turnstile/compare/v0.2.10...v0.3.0
[v0.2.10]: https://github.com/edseabolt/turnstile/compare/v0.2.9...v0.2.10
[v0.2.9]: https://github.com/edseabolt/turnstile/compare/v0.2.8...v0.2.9
[v0.2.8]: https://github.com/edseabolt/turnstile/compare/v0.2.7...v0.2.8
[v0.2.7]: https://github.com/edseabolt/turnstile/compare/v0.2.6...v0.2.7
[v0.2.6]: https://github.com/edseabolt/turnstile/compare/v0.2.5...v0.2.6
[v0.2.5]: https://github.com/edseabolt/turnstile/compare/v0.2.1...v0.2.5
[v0.2.1]: https://github.com/edseabolt/turnstile/compare/v0.2.0...v0.2.1
[v0.2.0]: https://github.com/edseabolt/turnstile/compare/v0.1.1...v0.2.0
[v0.1.1]: https://github.com/edseabolt/turnstile/compare/v0.1.0...v0.1.1
[v0.1.0]: https://github.com/edseabolt/turnstile/compare/993a2990772b44437a183d453988c3e8d95c7991...v0.1.0
