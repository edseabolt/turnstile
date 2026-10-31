---
name: turnstile-suspend
description: Suspend or resume turnstile gate enforcement for the current session with the user-typed TURNSTILE OFF: / TURNSTILE ON: prompt markers, and inspect the suspension with opencode-turnstile status. Use when the user asks to turn turnstile off/on for a session, pause gate enforcement, or check whether enforcement is suspended.
---

# Turnstile suspend / resume

Turnstile's gate enforcement can be paused for the whole session by typing a
literal marker anywhere in your own prompt. These markers are **plain
text you type yourself** — they are read only from admitted user prompts, so
quoting them in a message to an agent or a child task does nothing. There is
no agent-dispatchable off switch, by design.

## `TURNSTILE OFF:` — suspend enforcement

Type it in a prompt, e.g.:

```
TURNSTILE OFF: let's iterate on the design doc first
```

What it does for this session:

- Deliberate gate blocks stop being enforced — dispatches, bash/commit
  checks, and permission asks all proceed.
- Enforcement decisions keep being computed and journaled (observe-like, not
  blind): every block that _would_ have fired is recorded in the JSONL
  journal as a `suspended` audit entry with `event:"would-block"`.
- The session's gate state is cleared fresh, and it stays cleared: credit is
  not earned while suspended.
- The suspension survives a process restart (replayed from the journal tail).

## `TURNSTILE ON:` — resume enforcement

Type it in a prompt:

```
TURNSTILE ON: back to the implementation plan
```

What it does:

- Enforcement resumes immediately with fresh task state.
- Nothing earned while suspended rehydrates — no stale credit carries over.

When both markers appear in one prompt, the one occurring later wins.

## Config

- `suspendMarker` / `resumeMarker` (defaults `TURNSTILE OFF:` /
  `TURNSTILE ON:`) let a custom setup rename the literals.
- `allowSuspend: false` (the kill switch) disables both markers: an OFF or ON
  marker is refused with a journaled `refused:true` entry and a surfaced
  diagnostic, and no state changes.

## Inspecting state

- In-repo: `node bin/cli.mjs status`
- Installed: `npx opencode-turnstile status`

## Never relay the markers

Never paste or relay `TURNSTILE OFF:` / `TURNSTILE ON:` on an agent's behalf.
The markers are honored only when the user types them in their own prompt;
an agent asking the user to include them defeats the contract.
