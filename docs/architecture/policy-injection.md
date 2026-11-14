# Policy injection

Turnstile does not read orchestrator policy from a file at install time; it
makes that policy available by injecting it at runtime. The primary channel is
the pre-first-model-call `session.context` hook: `injectContextPolicy` in
`src/context-surface.ts` appends the policy head (and any pending intent nudge)
into the parent's primary-turn draft `system` array before the first model
call, parent-guarded and latched (see the `context` hook in [hooks](hooks.md)). The
`execute.after` body in `src/hooks-tool.ts` stays armed as the fallback: it
prepends the orchestrator policy paragraph from `src/policy.ts` (via
`src/delivery.ts`) to the first `task` (or `subagent`) result delivery per
task, once per task, and appends a per-delivery `PIPELINE:` status tail to
every
pipeline-stage delivery (see Pipeline continuation below), via the
`tool.hook("execute.after")` handler (the same hook the plugin already uses
to rewrite tool output reaching the model). Each
delivery is classified once by `classifyDelivery` into its host shape: the
v1 string shape (child-keyed event, text in `result.output`, the child
optionally named by a string `metadata.sessionID`) or the v2 structured shape
(parent-keyed event, structured `result.output`, the child on
`metadata.sessionID` or the structured `output.sessionID`, the canonical
child text in `output.output`, model-visible `content` as a string or a block
array). The policy head and the status tail both land on that shape's
model-visible text through the shared shape ladder (`mutateDeliveryText`):
`result.output` for the string shape; string or block-array `result.content`
for the structured one (a string carries both mutations in place, a block
array gains one prepended head block and one appended tail block, and absent
or other content falls back to the structured output string, which the host
stringifies into the transcript).
The classified child and text also drive marker parsing, the bare-output
check, and the reviewer capture, always from the canonical `output.output`
string, so a structured delivery parses and attributes to the real child
exactly like its string twin. Attribution is
edge-first: the `childToParent` edge (seeded by `session.created`, back-filled
via `session.get` in `resolveParent`) decides where the policy lands, so both
shapes inject on the receiving parent; the `policyInjected` flag and the
`injected:true` journal entry key on that resolved parent. The source of truth
is code shipped with the plugin, so a fresh install can never lose it, and it
follows the plugin through updates and uninstall–reinstall cycles.

- **Fail-open.** The injection is fully guarded with an inner try/catch; on
  failure it journals a `type:"policy"` entry with `injected:false` and
  proceeds, so a broken injection never blocks a tool call ([invariants](invariants.md)). The status
  tail has its own fail-open catch: a throwing append journals
  `{type:"error", error:"pipeline-status: …"}` without rethrowing, and the
  independent policy head still lands (and vice versa). The only silent skips
  are the once-flag (which gates only the policy head; the tail lands on
  every pipeline-stage delivery) and an absent result (nothing to deliver);
  a present-but-unclassifiable result journals loudly on EVERY such delivery
  (the once-flag no longer gates it) as
  `{type:"policy", injected:false, reason:"unknown-shape", shape:<descriptor>}`,
  where the descriptor is a
  bounded, value-free summary of the unrecognized result (per-field types
  plus the sorted key names of an object `output`, capped at 8), so a broken
  shape is discoverable by grepping `type:"policy"` like every other skip.
- **Per-task idempotency.** A `GateState.policyInjected` flag (cleared on
  each new prompt, so the block re-injects per task) means the policy is
  prepended exactly once per task, not once per turn. The `PIPELINE:` tail
  has no such once-flag; it is per-delivery by design. The shared latch also
  gates the context-hook channel: its success journals
  `{type:"policy", injected:true, surface:"context"}` and its skips journal
  `skipped:true` with reason `context-agent` / `context-child` /
  `context-no-id`, discoverable by grepping `type:"policy"` like every other
  decision.
- **Pipeline continuation.** Every pipeline-stage delivery (the delivery's
  agent matched against the configured `config.agents` names, so a renamed
  install names its renamed stages) gains a one-line status tail rendered
  by `formatPipelineStatus` (`src/state.ts`) from the resolved parent's gate
  state after the just-arrived delivery: `PIPELINE: <stage>=done
plan=APPROVED|PENDING tests=GREEN|RED reviewer=<n>/2 next=<successor> —
<directive>`. The successor is the stage the orchestrator dispatches next,
  decidable from the gate flags alone: planner → plan-reviewer; plan-reviewer
  → executor once `hasPlanVerdict` holds, else planner (a BLOCK re-plans);
  executor → test-runner; test-runner → reviewer once `hasGatePass` holds,
  else executor (a FAIL re-runs); reviewer → the literal `land` once
  `hasReviewApprove` holds, else the reviewer again while `reviewerDispatches`
  is below `REVIEW_ENSEMBLE_SIZE` (2), else the literal `escalate`. The
  directive is "dispatch the next agent in this same turn" for a stage
  successor, "task complete; land through the gated push" for `land`, and
  "escalate to the user" for `escalate`. Two documented residuals: an agent
  outside the five stages renders `""` and the append is skipped entirely
  (non-pipeline deliveries stay byte-identical); and on a capped round (the
  other legs carry dispatch caps too: planner 3, plan-reviewer 3,
  test-runner 4) the line may name a stage the dispatch gate will refuse;
  it reports the pipeline's nominal successor, not the gate's cap check. The
  tail rides the policy head's `mutateDeliveryText` shape ladder, and the
  output always reads policy head → child text → `PIPELINE:` tail (the
  once-per-load `[turnstile] config:` block sits between head and child text,
  per the config-surface ordering). Every status word is a non-marker token,
  so an echoed copy of the line never parses as a `GATE:`/`VERDICT:` marker,
  and the line never enters the journal: persistence schema, replay,
  rotation, and `opencode-turnstile status` are unchanged.
- **Edge-first attribution.** A delivery whose child→parent edge is
  registered injects regardless of the `event.agent` name; the name
  heuristic never excludes an edge-resolved delivery. The name guard survives
  only as a conservative fallback for non-structured deliveries: a delivery
  carrying a config-known subagent name whose edge is unresolvable (no
  `session.created` and no `session.get` record) is skipped and journaled
  `{type:"policy", sessionID:<child>, injected:false, skipped:true,
reason:"agent-name"}` so the decision is observable. Structured deliveries
  skip the guard by construction: the host builds that result on the
  parent's own tool call, so it is always the parent-facing channel and
  `event.agent` there is the parent's agent name. Consulting it risks a
  bogus skip for a parent running under a config-known name. The one
  residual corner that still injects without an edge is a config-UNKNOWN
  name on a host without a session API:
  with neither an edge nor a name signal there is no way to tell a
  parent-facing delivery from a child-own session one, so the self-keyed
  injection there is a documented, accepted residual. The handler fires only
  on `task`/`subagent` tool results, so child streaming text never receives
  the policy.
- **Marker placeholders.** The injected paragraph quotes the gate/verdict
  markers with `<n>` placeholders (e.g. `GATE: PASS tests=<n> passed=<n>
failed=<n>`, `VERDICT: APPROVE crit=<n> high=<n> med=<n> low=<n>`) rather
  than concrete digits, and never the pipe-joined `PASS|FAIL` form. The
  plugin parses markers from _any_ session text but applies them only from a
  marker-contracted emitter, so a fully concrete example echoed back by an
  unauthoritative session is journaled `suppressed` rather than flipping a
  gate. The placeholder form stays unparseable, which is defense in depth
  against a contracted emitter echoing a fully concrete line (e.g. a reviewer
  re-stating a verdict) and against contract drift.
- **Per-agent instructions** are not injected by the plugin: they live in
  each `agents/<name>.md` installed alongside the plugin.

With the plugin **off**, none of this prose is present anywhere; there is no
AGENTS.md block to fall back on. That is the deliberate tradeoff: loss-proof
by construction while the plugin loads, and a known, documented gap when it
does not.

A legacy variant once wrote a managed contract block into
`~/.config/opencode/AGENTS.md`. That block is now orphaned: the plugin no
longer reads or manages it, and it will coexist with the injected policy
(duplicate prose until removed). There is deliberately no installer to remove
it; turnstile no longer owns that file, so it never rewrites it. Delete the
section between the `<!-- turnstile:start -->` and `<!-- turnstile:end -->`
sentinels by hand, once; after that, the injected policy is the single source
of orchestrator policy for the session.
