---
name: turnstile-setup
description: Install the turnstile plugin and pipeline agents into the user's ~/.config/opencode and verify sync. Use when the user asks to set up turnstile, run the pipeline gates, add pipeline gates to a session, or after changing marker syntax in this repo. The plugin injects the orchestrator policy at runtime (via the execute.after hook); it does not write a contract block into AGENTS.md.
---

# Turnstile setup

Install the artifacts this repo owns into `~/.config/opencode` — the plugin and
the pipeline agent definitions — as symlinks (`scripts/install.mjs`, driven by
`install.json`). This repo no longer owns a contract block: the orchestrator
policy is injected at runtime by the plugin, not written to the user's global
instructions file (`~/.config/opencode/AGENTS.md`) at install time.

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

2. Confirm the runtime policy. The plugin injects the orchestrator policy
   into the primary session per task from `src/policy.ts`; there is no
   block to verify on disk. If the user's `~/.config/opencode/AGENTS.md`
   still contains a legacy turnstile sentinel block (from an install before
   the runtime-injection change), delete it by hand — the plugin does not
   read or manage it, and there is deliberately no installer to remove it:

   ```
   # ~/.config/opencode/AGENTS.md — delete the section between the
   # `<!-- turnstile:start -->` and `<!-- turnstile:end -->` sentinels
   ```

3. Verify the marker contract is still in sync with the parser:

   ```
   node scripts/check-markers.mjs
   ```

   Must pass. It validates the README's concrete examples, the `<n>`-placeholder
   templates in `agents/*.md`, and those in `src/policy.ts` against the parser
   regexes in `src/markers.ts`. If it fails, the README examples and the regex
   literals in `src/markers.ts` have drifted — fix both together.

## Report

Tell the user: which files were linked or copied (created or updated), that the
orchestrator policy is injected at runtime (no instructions-file block), and —
if a legacy sentinel block was present — that it was removed by hand. Do not
quote the injected policy back; summarize.
