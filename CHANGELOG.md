# Changelog

All notable changes to this project are documented here. The format is
based on [Keep a Changelog](https://keepachangelog.com/); versioning is
semver.

## [0.1.0] — 2026-10-08

### Added

- `turnstile`: OpenCode v2 promise-plugin enforcing the planner → executor
  → test-runner → reviewer pipeline: reviewer dispatch gate with `USER
WAIVER:` escape, round cap, read horizon (warn @8 / block @15),
  decomposition gate over `.opencode/plans/`, marker parsing, JSONL
  journal and trace, decoding clamps.
- Layered configuration: defaults from code, then
  `~/.config/opencode/turnstile.json`, then env (`TURNSTILE_TRACE`,
  `TURNSTILE_METRICS_DIR`, `TURNSTILE_CONFIG`), then injected options;
  fail-open validation, read once at setup.
- Privacy: `trace: false` suppresses the trace file and redacts bash
  commands, dispatch descriptions, and waiver quotes in the journal.
- LRU session cap (`maxSessions`, default 64) on gate state and the
  parent-session map.
- Plans-scan cache (mtime-keyed) for the decomposition gate.
- Test suite (`node:test`, 37 tests) wired into `npm run ci`; marker-drift
  guard; ESLint + Prettier toolchain.
- AGENTS.md contract template (`templates/global-AGENTS.md`) with
  sentinel-marker installer and the `turnstile-setup` skill.

### Changed

- Established the `turnstile` name for the module id, journal file, and
  user-facing messages.
- Gate journal entries are keyed by the parent session ID (raw child ID
  kept in `raw`) so replay restores state where the reviewer gate looks.
- Bare-output violation entries gained an `agent` field and fire only for
  marker-contracted agents.
- `BlockError` class replaces string-prefix error classification.

### Fixed

- Streaming marker re-delivery (`message.part.updated`, text deltas) no
  longer double-counts verdicts or spuriously trips the reviewer round cap.
- Reviewer temperature is forced to 0 even when the host sends no options
  object.

### Security

- Documented that turnstile is a speed bump/audit trail, not a
  security boundary: markers and waivers are forgeable by design (README,
  SECURITY.md).
