# Waivers and approvals

Turnstile reads a waiver or a human plan approval only from the user's OWN
prompt — the plugin observes it at prompt admission, never from an agent's
dispatch prompt. A marker inside an agent-composed prompt must never unlock
a gate, so the channel is checked, not the text.

### Observe mode

`observeSessions: N` runs the first N admitted parent sessions as an
adoption period: every gate keeps computing and journaling exactly as
before, but the deliberate `BLOCKED by turnstile:` throw is suppressed —
the decision is journaled as a `would-block` entry and the call proceeds,
metered like an admitted dispatch. When the next session admits past the
boundary, the period completes and enforcement switches on; the first
string-output delivery after it carries a once-per-load `[turnstile]
observe:` block reporting the would-have-blocked counts, and that
surfacing is journaled so a restart never re-fires it. The default
`observeSessions: 0` enforces from the first session — byte-identical to
the pre-observe behavior. Fail-toward-enforce: if the observe phase read
itself fails, the error is journaled and the block proceeds. The
summary's counts are read at injection time, so sessions admitted between
period completion and the first delivery shift the reported totals
slightly (cosmetic drift, accepted). A boot that replays a completed
period whose summary never surfaced re-arms the block even if the current
config has since been disarmed (`observeSessions: 0`) — at most one block
per load, accepted behavior.

### Prompt-channel waiver

Put the literal marker `USER WAIVER:` in the text of your prompt to waive a
gate. Your words may name configured agent stages to scope the waiver: the
grammar is literal configured stage names (any of the `config.agents` values
— `planner`, `plan-reviewer`, `executor`, `test-runner`, `reviewer`,
`debugger`, `requirements`), matched case-insensitively. The plan gate is covered by either its plan-reviewer or
executor stage name; a name with no guarded gate (e.g. `debugger`) names
nothing the waiver covers — the block message self-explains at runtime.

Two lifecycles:

- An **unscoped** waiver covers every gate, but the reviewer gate consumes
  it on the first dispatch it unlocks.
- A **scoped** waiver stays live until that stage's waiver allowance is
  spent (for the reviewer gate, max 2 waiver-unblocked dispatches, metered
  separately from the ordinary dispatch caps on `reviewWaiverRounds`).

A new user prompt drops the waiver; a blocked dispatch reports whether a
waiver is out of scope or consumed.

A waiver-admitted reviewer dispatch never counts toward the reviewer
ensemble: under `reviewEnsemble: enforce` a fully waived review leaves the
landing gate red — it is released only by the human, never by
the waived verdict. The landing gate is never waiver-released at all: a
`USER WAIVER:` in your prompt covers the dispatch gates but does not release
`git push` — only the credited reviewer verdict or your explicit approval
(prompt marker, or your permission reply under `escalation: "ask"`)
does (a waiver aimed at landing is captured at admission and inert there).

Only the reviewer stage meters waiver exemptions; a waiver covering another
stage exempts that leg's loop cap and the total dispatch budget without
counting — by design, a planner-scoped waiver permits an unbounded planner
loop within the task; the bound is the user's own prompt.

### Prompt-channel approval

Put `PLAN APPROVED:` in your prompt to approve the plan the same way a
plan-reviewer `VERDICT: APPROVE` would; it records human provenance and
replays across restart like a reviewer verdict.

### Permission-prompt escalation

Repeat-attempt escalation of the landing and hands-on gates is controlled by
`escalation` (`"block"`, the default, or `"ask"`):

- **`block` (default) — ask-first with block fallback.** The repeat attempt
  arms the same one-shot latch and forces the host permission ask exactly as
  under `"ask"`: reply `always` (released for the task), `once` (one
  dispatch/edit), or `reject` (gate stays red). The block-throw with the
  stop-and-report instruction is only the fallback for the no-human cases:
  when no one answers the ask, or when a re-arm inside the ask-latch TTL
  journals no second ask row (same-tick dedupe collapses parallel tool
  batches that escalate together into one ask row) and re-blocks instead,
  while the already-armed latch still forces the ask. Release also flows via
  a user-authored prompt marker (`USER WAIVER:` for hands-on / dispatch
  gates, `PLAN APPROVED:` for the plan gate) or an earned reviewer
  `VERDICT: APPROVE` (landing).
- **`ask` — interactive ladder.** Identical ask-first behavior: the repeat
  attempt arms a one-shot latch and forces the host permission ask with the
  same `always`/`once`/`reject` replies, with the same TTL dedupe and
  block fallback.

The plan-gate escalation (the first executor dispatch when no plan approval
holds) follows the `escalation` mode: under `"block"` (the default) the
dispatch blocks with the stop-and-report instruction and release flows via
`PLAN APPROVED:` or a waiver; under `"ask"` it surfaces the permission
prompt. It is not part of the landing/hands-on ladder.

> **Warning — auto-accept voids the human decision point.** If the host
> answers permission asks automatically (`session.permissions:
"autoaccept"` in `~/.config/opencode/cli.json`), the landing/hands-on
> ask latches (both `escalation` modes) and the ensemble's human release
> are all answered without you: the landing gate degrades to a two-push
> delay and, under `"ask"`, the plan gate degrades to a one-block
> delay. Turnstile
> assumes a human actually answers; this is one reason the default is
> `"block"`. `opencode-turnstile status` prints an
> advisory when it detects the setting.

### Parent hands-on edits

You normally never edit files from your own prompt — the pipeline does the
work. If the parent session (the one you type into) tries a `write` or
`edit` itself, the always-on hands-on gate steps in:

- The **first** parent edit of a task is refused with
  `BLOCKED by turnstile: parent-session write/edit requires the pipeline…`.
- The **repeat** attempt arms a one-shot ask latch and escalates to an
  interactive permission ask through OpenCode's permission surface in BOTH
  `escalation` modes (the block-throw is only the no-human fallback). Reply
  `always` to release the gate for the rest of the task, `once` to release
  exactly the one edit in flight, or `reject` to keep the gate red — the
  next attempt re-blocks (a within-window re-arm after a reject throws
  instead of re-asking). The gate also releases on a `USER WAIVER:` (below)
  or a hands-on release carried from a prior session.
- A `USER WAIVER:` in your prompt whose scope covers the `executor` stage
  also releases the gate. Plan approval does **not** — approving the plan
  tells turnstile the executor may start, not that the parent may edit.
- A new user prompt resets the gate: the block count and any `always`
  release start over.

The gate covers the parent session and every non-pipeline subagent;
only the pipeline's own agents (executor and friends) are exempt, because
their writes are the pipeline's work.

If you genuinely want one-off hands-on fixes, reply `once` per edit, or
scope a `USER WAIVER: executor` for a task of small direct tweaks.

### How the plugin sees your prompt

Capture happens at prompt admission on whichever host channel carries it —
the `session` prompt hook, or the correlated `session.inbox.enqueued`
admission (same message id, same marker, same journal shapes). A prompt
delivered on neither channel is journaled as one distinguishing error rather
than failing silently.

### Stale approvals

Plan edits invalidate approvals: a bound approval (recorded for a specific
plan file) is dropped only by that plan's own content change or removal
(`plan-edited` / `plan-missing`, journaled STALE); unbound approvals stamp a
path-free whole-directory signature, so any plan-file change drops them
loudly the same way (`signature-mismatch`). The unbound stamp is journaled
with the APPROVE entry, so a plan edited while the process was down
invalidates the restored approval on its first dispatch.
