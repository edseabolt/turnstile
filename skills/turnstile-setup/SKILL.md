---
name: turnstile-setup
description: Install or update the turnstile plugin, pipeline agents, and contract block into the user's ~/.config/opencode, then verify sync. Use when the user asks to set up turnstile, add pipeline gates to AGENTS.md, refresh the installed contract block, or after changing marker syntax in this repo.
---

# Turnstile setup

Install the artifacts this repo owns into `~/.config/opencode` — the
plugin and pipeline agents as symlinks (`scripts/install.mjs`, driven by
`install.json`), and the contract block this plugin enforces into the
user's global instructions file (`scripts/install-agents.mjs`).

## Steps

1. Install the plugin and agents from the repo's root:

   ```
   npm run init
   ```

   - Default is symlink mode (repo edits live); use
     `npm run init -- --copy` for real copies when the user refuses
     symlinks — copy mode keeps a ledger recording what it installed.
   - Targets come from `install.json`; unowned files are never touched.
   - Conflicts (a real file differing from the repo, or a user-edited
     copy) fail with a summary. Review with the user, then re-run with
     `--force` to back up and replace.
   - Verify with `npm run install:check` (add `-- --copy` for copy mode)
     — must exit 0.

2. Install the contract block into the global AGENTS.md:

   ```
   node scripts/install-agents.mjs
   ```

   - Default target is `~/.config/opencode/AGENTS.md`; pass
     `--file <path>` only if the user asks for a different file.
   - Preflight: adoption is automatic. When the target already contains
     turnstile contract content but **no** `<!-- turnstile:start -->` …
     `<!-- turnstile:end -->` sentinels, the installer adopts the section:
     it wraps an equivalent section with the sentinels (no content
     change), and for a section that differs it backs up the target first
     (`<file>.bak.<timestamp>`) and replaces the span with the current
     template. Run with `--check` to preview without writing, or
     `--no-adopt` to refuse and get reconciliation instructions instead.
   - The installer only refuses (exit 1, no write) for targets it cannot
     resolve safely: a corrupted one — a start sentinel with no end
     sentinel — or an ambiguous one — more than one turnstile section.
     Fix one of those by hand, then re-run.
   - The script touches only the managed block; everything else in the
     target file is preserved.

3. Verify the installed block matches the template:

   ```
   node scripts/install-agents.mjs --check
   ```

   Must exit 0. If it exits 1, re-run step 2 and investigate rather than
   hand-editing the installed file.

4. Verify the marker contract is still in sync with the parser:

   ```
   node scripts/check-markers.mjs
   ```

   Must pass. If it fails, the README's marker examples and the regex
   literals in `src/markers.ts` have drifted — fix both together.

## Report

Tell the user: which files were linked or written, whether each was
created or updated, and that OpenCode sessions restart to pick up the
change. Do not quote the whole installed block back; summarize.
