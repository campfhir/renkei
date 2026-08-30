# Replacing the approval node with a step-level gate and an agent-level question capability — design

No code yet.

## What exists today

`{kind:"approval"}` (`ApprovalStep`, `packages/agents/src/steps.ts:415-...`) is one node
that does two different jobs by branching on `mode`:

- `mode:"approve"` — gate a decision the agent already made, approve/decline.
- `mode:"input"` — ask the person for information, optionally through a
  `fields` form (`ApprovalField[]`, `MAX_APPROVAL_FIELDS=10`).

Both share `message`, `saveAs`, `timeoutHours` (default `APPROVAL_DEFAULT_TIMEOUT_HOURS=72`,
capped by the org's `agentApprovalMaxWaitDays` via `DEFAULT_APPROVAL_WAIT_CAP_HOURS`),
`notifyEmail`/`notifyWebex`, and three outcome paths — `onApproved`, `onDeclined`,
`onTimeout` — each a full nested step list.

`fields` is fixed at authoring time: the same labels every run. A step that needs to
ask something DIFFERENT each time (Portfolio Updater's weekly "which issue tracks this
KPI update" — a different question per pending item, discovered fresh each run) has no
field to bind that to, so the only way to ask it today is to loop one approval per item,
with the loop's raw per-item record interpolated into the message via a `{t:'var'}` chip
(a mistake fixed once already, at the message-authoring level, in this agent — see the
"Portfolio Updater" incident this design grew out of).

## The pause/resume mechanism (reusable — this is not going away)

From a full-repo inventory of `apps/worker-agents/src/engine.ts`'s `executeApproval`
(2050-2399) and `approval-sweep.ts`: an approval node's pause parks the run
(`agent_runs.status='waiting'`, `waiting_until`), raises an `actionable_items` card
(`kind:'approval'`, linked by `run_id`/`step_id`/`iteration` — migration
`053-approval-pauses.ts`), and resumes via an optimistic single-arbiter claim shared by
the decide route, the engine's re-entry check, and the sweep's three arms (timeout,
decided-but-stuck, orphan).

Load-bearing fact for this redesign: **an approval node already writes to the same
`agent_run_steps` attempt-row table an action step uses** — same `(run_id, step_id,
iteration, attempt)` keying, same replay-by-row semantics, just with an extra
`status:'waiting'` value in between. Putting an approval GATE on an action step needs no
new attempt-row infrastructure — it needs the gate to reuse the row the step already
gets. The card/notify/claim/sweep machinery is the same story: it keys off
`(run_id, step_id, iteration)`, not off "this is a distinct node kind," so it carries
over to a gate largely as-is.

## Proposal: two primitives instead of one node

### 1. `needsApproval` — a gate on an `ActionStep`

```ts
interface ActionStep {
  // ...existing fields unchanged...
  /** Pause before THIS step's tool call and ask a person first. Meaningless
   *  without `tool` set — validated at save time. */
  needsApproval?: boolean;
  /** Default 96 (4 days), clamped by the org's approvalWaitCapHours, same
   *  rule `timeoutHours` uses today. */
  approvalTimeoutHours?: number;
  /** Taken when the answer is 'denied' or the wait times out — both are
   *  "not approved". Empty/absent = skip the tool call, continue below the
   *  step. The decision's outcome ('approved'|'denied'|'timedOut') and
   *  optional comment are bound as vars (approval.outcome, approval.comment)
   *  for a branch inside this path to read, if the author wants denied and
   *  timed-out handled differently — no separate onDeclined/onTimeout paths
   *  on the node itself. */
  onNotApproved?: BranchPath;
}
```

The card shows the proposed call — the step's tool name and its rendered arguments —
never an author-written message: there is nothing to author, the point of the flag is
"gate whatever this step is about to do," not "gate this and say something custom." A
model deciding whether to write can already say why in its own `instruction`; that
reasoning is visible on the run timeline the same way it is for an ungated step.

Outcome is `'approved' | 'denied' | 'timedOut'`, each with an optional person-typed
`comment`. **No fourth outcome on the gate itself.** "Failed" (from the last design
round — "when the comment causes confusion or contradiction") is the ordinary
step-failure vocabulary applying to whatever step reads `approval.comment` afterward,
not a new state the gate can be in.

**Retrying with the person's feedback, without a goto:** wrap "decide the value →
gated step" in a `mode:"until"` loop (bounded by `maxIterations`, existing primitive)
whose exit condition reads `approval.outcome`. A denial with a comment drives another
bounded iteration, replanning with that comment in scope as a variable. The steps model
stays a forward-only tree (`steps.ts`'s own doc comment: "Structured blocks, not a goto
graph") — no backward jump gets added, and every crash-recovery assumption the engine
already makes about forward progress keeps holding.

### 2. `canAskQuestions` — an agent-level capability, not a node

Lives beside `enabled`/`guardrails`/`blockedTools` on the agent record, not in the
steps doc:

```ts
canAskQuestions: boolean; // default false
```

When true, every step's LLM turn loop (`engine.ts` ~2988-3200, where `FINISH_STEP_DEF`/
`RESOLVE_TIME_DEF` are unconditionally offered today) additionally offers a free tool,
`ask_person`:

```ts
{
  message: string;           // what's being asked, plain prose
  form?: FormNode[];         // optional structure beyond one open question
  timeoutHours?: number;     // default 96, same org clamp
}
```

Calling it ends the CURRENT attempt — the same way `finish_step` does — and pauses the
run exactly like a gate does (status, card, sweep, claim: all shared code). On answer
or timeout, the step gets a FRESH attempt whose prompt includes what was asked and what
came back, so the model picks the thread back up without the engine needing to persist
and replay an in-flight LLM conversation across a wait that can span days (the
alternative considered and rejected: no new "paused mid-turn" persistence layer, reuses
the existing attempt/resume guarantees instead). The model can call `ask_person` again
for a second round — no loop needed, no pre-planned node, as many questions as the run
turns up.

### `FormNode` — the shared vocabulary both primitives' cards render

```ts
type FormNode =
  | ({ kind: 'field' } & ApprovalField)   // existing type: text/longtext/number/date/choice/multi
  | { kind: 'paragraph'; text: string }   // context, no control
  | { kind: 'group'; label: string; nodes: FormNode[] }; // one level, no nested groups
```

No new field type for yes/no — `choice` with two options covers it; the card can render
a two-option `choice` as buttons instead of a dropdown, a rendering choice, not a type.

## Card model

Two `actionable_items.kind` values instead of one:

- `'approval'` — a `needsApproval` gate. `suggested_action` carries the proposed call
  (tool name + rendered args); `result` carries `{outcome, comment?}` once decided.
- `'question'` — an `ask_person` call. `suggested_action` carries `{message, form}`;
  `result` carries the answers, keyed by each field's `name` across every group (same
  "whole reply" shape the old form-mode approval already produced).

No new migration expected beyond an `agents.can_ask_questions` column — both
`suggested_action` and `result` are already `jsonb`, and the `run_id`/`step_id`/
`iteration` linkage from migration 053 is reused unchanged for both kinds.

## MCP surface

Replaces the `{kind:"approval"}` paragraph in `STEP_NODE_GRAMMAR` and `FORM_EXAMPLE`
(`apps/web/lib/mcp-tools/agents/index.ts:1546-1656`) with the `needsApproval`/
`approvalTimeoutHours`/`onNotApproved` grammar on the action-step paragraph, the
until-loop retry pattern spelled out as the worked example, and a new paragraph on
`canAskQuestions` (in the agent-level grammar `agent_create`/`agent_update` already
document alongside `guardrails`/`blockedTools`) naming `ask_person` and when to turn it
on.

Two tools replace `agent_approval_decide`: `agent_approval_decide` narrows to the gate
shape (`approve`/`deny` + optional comment); a new `agent_question_answer` submits a
`'question'` card's form answers. Splitting them keeps each tool's input shape specific
instead of one tool branching on card kind.

## Order

1. **Types** — `steps.ts` (`needsApproval`/`approvalTimeoutHours`/`onNotApproved` on
   `ActionStep`, `FormNode`, remove `ApprovalStep`/`ApprovalMode`) and `validate.ts`
   (drop the approval-node rules, add gate validation: `needsApproval` requires `tool`,
   `approvalTimeoutHours` clamped, `onNotApproved` recursion). Foundation everything
   else compiles against.
2. **Migration** — `agents.can_ask_questions boolean default false`.
3. **Engine** — the gate (before a tool call fires) and `ask_person` (in the per-step
   turn loop), both reusing the existing pause/card/sweep/claim machinery keyed off
   `(run_id, step_id, iteration)`. The biggest, riskiest piece — this is a live
   execution engine with a currently-scheduled production agent depending on it.
4. **Web**: `approvals.ts`'s `decideApproval` narrows to the gate; a new
   `answerQuestion` (mirrors it) for `'question'` cards; REST routes for both.
5. **Cards**: `cards.tsx`/`approval-actions.tsx` render the gate's proposed-call view;
   a new `question-actions.tsx` renders `FormNode` (paragraph/group/field) trees.
6. **MCP**: grammar + `agent_approval_decide` narrowed + `agent_question_answer` added.
7. **Tests**: `engine.test.ts`, `validate.test.ts`, `steps.test.ts`,
   `approval-answers.test.ts`, `approvals.test.ts`, MCP `index.test.ts` — mostly
   rewritten, not patched (per the inventory, nearly all existing approval-node
   coverage tests behavior this removes).
8. **Verify + migrate**: full typecheck/lint/test, live Playwright pass, then use
   `agent_patch_steps` to move the live "Portfolio Updater — Sunday Deep Sweep" agent's
   two approval nodes onto the new shape so it keeps running.

Deferred, not forgotten:

- **Phase B** — the visual builder (`approval-editor.tsx` 579 lines,
  `approval-node.tsx` 104 lines — both wholesale rewrites; `agent-builder.tsx`,
  `flow-canvas.tsx`, `flow-tree.ts` — ~15-20 approval switch-arms apiece). Needed for
  hand-authoring via the canvas; not needed for MCP-authored agents to run.
- **Phase C** — `draft-from-prose.ts`'s ask→approval parsing, `export-markdown.ts`,
  `run-debug.ts` wording. Peripheral rendering/drafting polish.

No back-compat shim for the old node: this is a beta app, and the old node's three-path
richness is judged not worth carrying two systems for. Existing saved agents using
`{kind:"approval"}` stop being current the moment `CURRENT_STEPS_VERSION` bumps, same as
any other version bump — they load for editing, refuse to run, same message every
stale-version agent gets today ("open it in the builder and save it to update it").
Portfolio Updater is migrated by hand (step 8) specifically because it is live and
scheduled; nothing else in the repo constructs an approval node in seed/fixture data
(confirmed by inventory) — only test files do, and those are being rewritten anyway.
