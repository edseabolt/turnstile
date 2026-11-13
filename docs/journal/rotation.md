# Journal rotation and per-session sinks

## Rotation

The journaler appends on the hot path without stat or rename: `journal()`
only appends and advances a per-file counter. The rotate-then-rename
sequence runs once per `journalRotateEveryEntries` appends (default 512),
only under a created `<file>.lock` atomic-mkdir mutex, so two concurrent
sessions never both rename the shared file. Disk usage stays bounded at
`(N + 1) × maxBytes`, plus at most `journalRotateEveryEntries × ~2 KB` of
overshoot between the size check and the rename. A contended lock or any
rotation error is swallowed (fail-open). The journaler steals a leftover
`<file>.lock` from a crash once its mtime passes the staleness bound
(journaling a `rotation-lock-stale:` `error` entry), so rotation resumes
instead of stopping forever; a freshly held lock is still skipped silently
while journaling keeps appending. One bounded race remains: a writer that
opens the path across the rename may land an entry in a generation past the
current file, but the replay scan walks all retained generations, so such
an entry simply joins the tail window when it is read back (the window is
small and clock-free). Files rotate at 5 MB, 5 generations.

## Per-session sink rules

Each `sessions/<parentID>.jsonl` file carries the same rotation bounds as
the shared file (5 MB, 5 generations, same lock cadence and stale-lock
steal). The steal's `rotation-lock-stale:` error row always appends to the
shared `turnstile.jsonl`, even when the contended file is a session sink.
Aggregate retention and boot read cost scale with the live session count:
per-file bounds are equivalent, but the file count grows with sessions
(accepted; the shared-file bound alone is unchanged).
