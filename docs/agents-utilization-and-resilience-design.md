# Agents: why they are not used, why steps fail on benign problems, and what to change — design

No code yet. An evaluation of the agent system as it stands (see
[`agents.md`](./agents.md) for the as-built reference), prompted by two
observations: almost nobody builds agents, and the agents that exist fail on
problems that were never really problems.

Everything below is argued from the code paths; the usage and failure numbers
that would confirm it are in the ledgers (`agent_run_log`, `llm_calls`) and
were not available while writing this. §5 says which query to run first.

## 1. The short version

The agent system asks a person to write a **program** — a typed tree of steps,
each naming exactly one tool, wired together by variable chips, with a failure
table per step — when what they have is an **intent** ("every morning, tell me
which tickets went stale"). The chat already executes intents: it discovers
tools on its own, takes fifteen to forty steps, retries its own hiccups, and
asks when it is unsure. The agent runtime gives a step one named tool, three
calls, no discovery, and stops the whole run on the first unhandled failure
code. The builder's flow chart is where the gap is felt first, but the chart
is the symptom: it is the honest rendering of a model that is too fine-grained
for the people meant to author in it.

Two moves, in order:

1. **Make the runtime resilient by default** (§4). Small engine changes:
   transient problems retry themselves, a step with no failure row gets one
   corrective try before it kills the run, the tool budget stops charging for
   the model's own corrections, and "nothing found" stops being a failure.
   This lowers the failure rate of every existing agent without touching the
   builder.
2. **Make each step a sub-agent and the engine an orchestrator** (§3). A
   step becomes a task in prose with a tool allowance and a budget, run by
   the chat's sub-agent loop, closing with a **report** rather than a verdict
   keyed by failure codes. The orchestrator keeps the structure people need
   (order, branches, loops, approval, and now parallel lanes) and routes on
   reports. The per-step failure table, the one-tool rule and the chip
   contract go away, which is what lets the builder become a numbered
   outline with the flow chart as an optional diagram.

## 2. Where the friction is, concretely

### 2.1 Authoring: the cost of the first agent

To save an agent today a person supplies, per action step: a name, an
instruction, exactly one tool chip (`validate.ts:189` — a second chip is a
save error), optionally a `saveAs` name, a `maxAttempts`, and a failure table
keyed by the tool's outcome codes. Across steps they must know that **a step
sees only the variables it chips** (`variables.ts`, `knownVariables`): "comment
on the ticket" with no `[the ticket]` chip silently hands the model nothing.
`lint.ts` exists to warn about exactly this, and the drafting prompt spends a
paragraph on it (`draft-from-prose.ts:296`), which is the tell — a contract
that needs a linter and a paragraph is a contract people will not hold in
their heads.

The validator has roughly 35 distinct save-blocking messages (`validate.ts`).
Branches and until-loops are evaluated by a model with **no tools and only
the chipped variables** (`BRANCH_SYSTEM_PROMPT`), so "if the ticket is
urgent" routes on whatever the author remembered to chip — and when nothing
was chipped it routes to the default path, quietly.

The "Start from a description" box is the intended shortcut, and it is a good
one, but its output is still the flow chart: the person reviews a tree they
did not build, with lint hints, "questions" the drafter could not settle, and
"concerns" from the review loop, then fixes chips and failure rows by hand.
It takes 20 seconds to several minutes (`DRAFT_TIMEOUT_MS` is five minutes and
the status copy tells people they can leave the page). The drafting grammar
the model is given runs to well over a hundred lines of rules
(`draft-from-prose.ts:255-400`); the MCP definition tools are 2,853 lines. The
authoring surface is large because the execution model is.

### 2.2 Authoring: you cannot try it

An agent with only event triggers hides "Run now" (`agents-list.tsx`: "every
`trigger.*` detail is unbound, which is a confusing failure, not a test"). So
the common agent — "when I get an email about X" — cannot be exercised at all
from the builder. The author enables it, waits for a real email, and reads a
run timeline after the fact. There is no sample payload, no replay of a recent
event, and no dry mode in which act tools preview instead of fire (the
`*_preview` variants exist in the catalog for chat, not for runs). The first
feedback loop is hours long and happens in production.

### 2.3 Authoring: the flow chart as the first thing you see

`flow-canvas.tsx` is a careful piece of work — one column at every width,
containers folding past depth 1, "+" on every edge — and it is the right
surface for _reviewing_ a branched, looped automation. As the _primary
authoring_ surface it costs: every edit is select → side panel (or a modal on
a phone) → type → close; a step card shows 70 characters of its instruction;
retry and save-as live in badges; the failure table is a disclosure inside
the panel. Reading the recipe end to end means opening each node. The repo
already has the alternative renderer — `renderStepsOutline` and the Markdown
export produce a numbered document of the same steps — it is just not
editable.

### 2.4 Discovery: the chat can make agents, but only in the step grammar

The chat already has the bridge: `agent_create`, `agent_update`,
`agent_patch_steps` and `agent_patch` (`mcp-tools/agents`) let a chat turn
create and edit agents, and `agent_run_get` reads a run back for improvement.
What makes that path heavy is the same thing that makes the builder heavy:
the chat model has to emit the full step grammar — one tool per step, chips
for every value a step needs, failure rows keyed by outcome codes — and the
save tools echo lint hints back when it gets the chips wrong. A smaller step
contract (§3) shrinks that grammar for the chat as much as for the builder.

### 2.5 Runtime: the ways a step fails on a benign problem

Each of these is a path in `engine.ts` by which a run ends `failed` when
nothing the author would call a failure happened.

| #   | Path                                                                                                                                                                                                                                                                                                                                                                                                             | Where                                                |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------- |
| 1   | **An unhandled code exits.** `handlingFor` matches the code, else an `other` row, else nothing — and nothing means `exit`. A new step has no rows (the builder's muted line: "every failure stops the agent"), so every declared failure, including a transient one, ends the run.                                                                                                                               | `engine.ts:614`, `:1937`                             |
| 2   | **A transient model error after the first tool call is a step failure.** `rate_limit`/`overloaded`/`network` before any billed call becomes a queue redelivery; after one it becomes a declared `service-unavailable` failure — which by #1 exits. `invalid_request` (a too-long context, say) aborts the run outright.                                                                                          | `engine.ts:3282-3300`                                |
| 3   | **Three billed tool calls per attempt.** `NORMAL_TOOL_CAP = 3`, and an errored call costs the same as a good one. Look up → act → verify is the cap; one mistyped argument and its correction is two-thirds of it. Past the cap the model is forced to declare, and a declared failure meets #1.                                                                                                                 | `step-prompts.ts:836`, `engine.ts:4100`              |
| 4   | **A tool that could not be reached costs budget.** Transport failures come back as an `isError` result the model must spend another call to retry.                                                                                                                                                                                                                                                               | `engine.ts:4153`                                     |
| 5   | **The error-text heuristic outranks the model's own code.** `classifyFailure` takes the tool's `_meta` code, else a regex over the error text ("required", "400", "not found"…), and only then what the model declared. A tool error whose text happens to say "required" lands on `invalid-input`, which the author handled as nothing.                                                                         | `engine.ts:545-612`                                  |
| 6   | **The outcome catalog's `retriable` flag is never read by the engine.** It only seeds the builder's `no-results` row. The vocabulary for "this is the kind of failure that clears itself" exists and nothing acts on it.                                                                                                                                                                                         | `tool-outcomes/outcomes.ts`, `step-editor.tsx:35`    |
| 7   | **The empty-search trap.** A search tool gets a seeded `no-results → retry` row with `exhausted: 'continue'`, which is right. The drafting grammar seeds the same row but documents the exhausted default as `stop` (`draft-from-prose.ts:396`), so a drafted agent that legitimately finds nothing on a quiet morning searches again up to `tries` (default 5) times with reworded queries, then fails the run. | `draft-from-prose.ts:382-401`, `engine.ts:2740-2765` |
| 8   | **`maxAttempts` defaults to 5 with no retry row,** so the number is fiction until a row exists — and when the drafter adds one, five searches for nothing is the result. Already diagnosed in [`loop-failure-handling-design.md`](./loop-failure-handling-design.md) (Problem 2), not yet built.                                                                                                                 | `flow-tree.ts:33`                                    |
| 9   | **One bad item ends a loop.** Item 4 of 50 failing means items 5–50 never run. Designed in the same document (Problem 1), not yet built.                                                                                                                                                                                                                                                                         | `engine.ts:1495`                                     |
| 10  | **An until-loop that hits `maxIterations` fails the run,** and a branch whose evaluator fumbles twice fails the run (`BRANCH_DEFAULT_ATTEMPTS = 2`).                                                                                                                                                                                                                                                             | `engine.ts:1722`, `:1978` (test)                     |
| 11  | **A revoked grant fails every scheduled tick.** The pre-flight `config` failure is correct, but it repeats on every schedule until someone notices in oversight; nothing pauses the agent or tells the owner once.                                                                                                                                                                                               | `engine.ts:1784`                                     |
| 12  | **Ten turns without `finish_step` is `llm_error: other`,** which exits by #1. A model that narrates instead of calling tools, nudged ten times, kills the run.                                                                                                                                                                                                                                                   | `engine.ts:4237`                                     |

The pattern across the table: the engine is scrupulous about **recording**
what happened (attempt rows, codes, ledgers, the debug export) and
deliberately hands every **decision** about what a failure means to the
author's failure table — whose default is empty. The chat sub-agent loop made
the opposite choice (`subagent.ts`: `RETRYABLE_LLM_ERRORS`, 15–40 steps, a
report rather than a verdict) and is the surface people use.

## 3. Steps as sub-agents, the engine as orchestrator

### 3.1 What a step becomes

Today an attempt is a loop of at most ten model turns over one named tool,
three billed calls, and a forced `finish_step` with an outcome code
(`runAttempt`, `engine.ts:3700-4240`). The chat's sub-agent
(`apps/web/lib/chat/subagent.ts`, `runSubagent`) is the same loop with the
ties cut: a task, a tool set that can grow through `find_tools`, 15–40
steps, a wall clock, provider-error retry, and a **report** as its result.
A step becomes that:

```ts
interface TaskStep {
  id: string;
  kind: 'task';
  name: string;
  /** What to do, in the author's words. Chips optional, never required. */
  task: InstructionSegment[];
  /**
   * What it may call. Absent = the owner's reading tools, discoverable
   * through find_tools. Act tools must be listed here — or discovered and
   * then approved at the card (§3.5).
   */
  tools?: string[];
  /** Model calls and billed tool calls per attempt; org caps bound both. */
  budget?: { calls?: number; minutes?: number };
  /** Binds the report's named outputs for later steps and loops. */
  saveAs?: string;
  /** Attempts when the step reports itself blocked. Default 2. */
  tries?: number;
  /** When every try ends blocked. Default 'stop'. */
  ifStuck?: 'stop' | 'continue' | 'stop-quiet';
  onSuccess?: 'continue' | 'stop' | 'stop-quiet';
  needsApproval?: boolean;
  approvalTimeoutHours?: number;
  onNotApproved?: BranchPath;
}
```

The closure tool replaces `finish_step`:

```ts
interface StepReport {
  /**
   * 'done'          — the task is complete (including "I looked and there
   *                   is nothing": an empty search is a finding, reported
   *                   as such — never a failure, never a retry trigger).
   * 'not-applicable'— this step's action does not apply to this input
   *                   (today's 'skipped').
   * 'blocked'       — it could not be completed; the report says why.
   */
  outcome: 'done' | 'not-applicable' | 'blocked';
  /** For the owner and the next step. Bounded (REPORT_CHARS, ~4 000). */
  report: string;
  /** Named results a later step or loop reads: a key, a list, a draft. */
  outputs?: Record<string, string | string[]>;
  stop?: boolean;
  quiet?: boolean;
}
```

What disappears from authoring: the one-tool rule, the failure table and
its outcome codes, the `when …` custom conditions, `maxAttempts` as a
number nobody chose, and the chip contract (§3.3). What stays: order,
branches, loops with `collect`, groups, endings, the approval gate, `remember`,
`ask_person`, `resolve_time`, guardrails, memory, knowledge notes, the model
override, sharing, chaining, resume, and every ledger.

### 3.2 The orchestrator

`engine.ts` keeps its frame stack, attempt rows, token, deadline, cancel
and resume machinery. What changes is the inside of `executeStep`:

- **Routing on the report, not on codes.** `done` advances (binding
  `outputs` and the report text under `saveAs`); `not-applicable` advances
  with nothing bound (as a skip does today); `blocked` retries up to `tries`
  with the previous report in view (today's corrective attempt, with the
  same laxer allowance), then takes `ifStuck`.
- **"Nothing found" never fails a run.** It is a `done` report whose text
  says so, bound under `saveAs` like any other result; a branch after the
  step routes on it ("did it find anything?") if the author cares. The
  seeded `no-results → retry` row, the drafter's `no-results` rule and the
  outcome guide's "declare it as a failure" paragraph all go. This is the
  "treat no-results as exhaustion" idea taken one step further: exhaustion
  still ends in `ifStuck`, which can be `stop`; a finding of nothing should
  not be able to stop a run at all unless a branch or ending says so.
- **Transient problems are the loop's, not the author's.** The sub-agent
  loop already retries `network`/`rate_limit`/`overloaded` model errors
  within a step (`RETRYABLE_LLM_ERRORS`); a tool that could not be reached
  is retried once by the loop before the model sees it. A step reports
  `blocked` only when the model concludes it is.
- **Branch and until-loop evaluators** keep their no-tools judgment frame
  but read the reports of the steps before them (bounded), not just chipped
  variables — a judgment with the evidence in front of it.

The engine's two correctness properties (attempt row before the loop, budget
by counting rows) hold unchanged: a sub-agent step is one attempt row whose
`toolCalls` is the transcript's tool calls and whose `detail` carries the
report, which is what the timeline and the debug export already render.

### 3.3 What a step sees: isolation over per-step guardrails

Per-step guardrails were raised as a way to stop flooding a step with
context that makes it misbehave. The sub-agent shape gets most of that for
free, and adding a per-step guardrails field would put authoring surface
back where this design is removing it. What a step receives:

- **Its task**, with the trigger's values available — the trigger is the
  reason the run exists, so every step sees it (bounded, long values by
  reference as today's "Known information" does).
- **The reports it needs.** Default: the report of the step immediately
  before it in its list, plus any `saveAs` name its task mentions in words
  or chips. The orchestrator resolves mentions by name (today's lint is
  the matcher — promoted from a hint to the binding); nothing else is sent.
  An author who wants more names it; one who wants less gets less by
  default. This is the per-step context control, expressed as "what this
  step reads" rather than as a second rulebook.
- **Agent guardrails, in full, every step.** They are policy ("never send
  outside the org", "no PHI in comments"), binding and short, and the
  owner's one safety net across every step; splitting them per step would
  invite the gap where the one step that needed the rule did not get it.
- **Memory and the knowledge index**, as today, in the system prompt. If
  the failure query (§5) later shows a step misbehaving because of them,
  a per-step `context: 'minimal'` switch is a one-field addition. It should
  wait for that evidence.

### 3.4 Parallel lanes

With reports as the only hand-off, independent steps can run at once. This
should be **explicit**, not inferred from dependencies: a sub-agent step
discovers its tools at run time, so nothing static says what it touches,
and an orchestrator that silently parallelises is one that silently
reorders acts. A container:

```ts
interface ParallelStep {
  id: string;
  kind: 'parallel';
  name: string;
  /** Each lane runs serially; lanes run at the same time. 2..MAX_LANES. */
  lanes: BranchPath[];
  /** When a lane ends stuck: let the others finish, then apply the lane's
   *  ifStuck; or cancel the others at once. Default 'finish-others'. */
  onLaneStuck?: 'finish-others' | 'cancel-others';
}
```

Semantics worth fixing now:

- The group finishes when every lane has; the steps after it see every
  lane's last report. `saveAs` names must be unique across lanes (the
  validator already enforces doc-wide uniqueness).
- An approval gate or `ask_person` in one lane parks that lane; the others
  continue; the run is `waiting` only when no lane can proceed. The card
  identifies the lane.
- Loops may contain a parallel group; a parallel group may contain a loop.
  Lanes may not contain another parallel group.
- The drafter is told to parallelise only lanes that read, or that act on
  different things; two lanes updating the same ticket is the author's
  problem the way two serial steps are, but the outline should warn when
  two lanes list the same act tool.

Engine cost: the frame stack is a single program counter and the run row
has one `current_step_id` (`engine.ts:1228-1278`). Lanes need a cursor each
(a JSON column, or a `agent_run_lanes` table), the resume fast-forward
walks per lane, and the janitor's "stuck run" check reads all cursors.
Attempt rows need no change: they are keyed by `step_id`, and lanes never
share a step. This is the one piece of §3 with real engineering risk, and
it is severable — everything above it works with `lanes` absent.

### 3.5 Acting safely without a failure table

The step model's safety story was "the author named the one tool, and
`needsApproval` gates it". With discovery, the equivalent:

- **Reads are free; acts are gated** by the chat's permission rules
  (`permission-rules.ts` already classifies acts). A step that reaches for
  an act not in its `tools` list parks and raises the proposed-call card the
  gate raises today; approving with "always for this agent" records the
  tool on the agent, beside `blockedTools`.
- **Supervised first runs.** An org setting (default 3): a new agent's
  first N runs gate every act regardless. The owner approves or corrects as
  it goes, which is a better first feedback loop than reading a timeline
  later — and it answers §2.2 for event-triggered agents, which still
  cannot be run by hand.
- `blockedTools` stays enforced at the gateway, and the run token (minted
  by `mintRunToken` for the tools the steps name) widens to the owner's
  projection minus blocks when a step has no `tools` list.

### 3.6 The builder

With no per-step tool, codes or chips to collect, a step is a name and a
paragraph. The builder's primary surface becomes the numbered **outline**
`renderStepsOutline` already produces, made editable in place:

```
1. Find the ticket          may use: jira_search_issues
   Look up the Jira ticket the email is about — the key is usually in the
   subject; otherwise search by the sender and the last week.
   tries 2 · if stuck: stop

2. If a ticket was found
   a. Add the email as a comment       needs approval
      …
   b. Reply in the thread with what changed
      …
   Otherwise
   a. Create a ticket in SUPPORT …

3. At the same time
   lane 1: …        lane 2: …
```

Branches read "If … / Otherwise", loops "For each … in …", lanes "At the
same time". The side panel keeps the dense parts (schedule, approval
settings, the tool allowance picker). The flow chart becomes a "Diagram"
tab over the same document — unchanged code, one tab deeper. The drafting
grammar (`draft-from-prose.ts`) loses its tool, chip and failure rules and
gains "lanes"; the chat's `agent_create` grammar shrinks the same way.

### 3.7 Engineering notes

- `runSubagent` and `find_tools` live in `apps/web/lib/chat` with
  dependencies on `local-tools`, `turn-runner` and the chat's tool surface;
  `apps/worker-agents` cannot import `apps/web`. Lift the loop and
  discovery into a package (the move `tool-outcomes` made for the same
  reason), with the chat and the engine both calling it.
- Discovery in a run goes through the MCP gateway's `tools/list` under the
  run token rather than the chat's in-process catalog; the gateway already
  projects per caller, so `find_tools` for a run is a filter over that list.
- `REPORT_CHARS` bounds what a step hands on; `outputs` entries take
  `SAVE_VALUE_CHARS`/`SAVE_ITEM_CHARS` as today. A step's prompt cost is
  its task plus one or two reports, which is comparable to today's
  "Known information" block.
- Org caps: `agentMaxStepAttempts` stays; add `agentMaxStepCalls`
  (default 15, as `CHAT_DELEGATE_DEFAULT_STEPS`) and keep
  `agentRunTimeoutMinutes` for the whole run.
- The run timeline renders a task step the way `subagent-modal.tsx`
  renders a sub-agent's transcript: the report on top, each model turn and
  its calls beneath.

### 3.8 Migration

A version 10 document may hold `task` steps beside `action` steps; the
engine runs each by its kind, so no existing agent changes behaviour on
deploy. "Convert to tasks" in the builder (and a flag on `agent_update`)
turns an action step into a task step mechanically: the instruction becomes
the task, the tool becomes the one-entry `tools` list, `saveAs` carries
over, `retry` rows become `tries`, and `exhausted`/`stop-quiet` rows become
`ifStuck`. New agents draft as task steps. Once the ledgers show action
steps idle, the `action` kind and its failure table can be retired.

## 4. The runtime: resilient by default

These apply to step agents as they exist and are each small. Order by
expected effect on the failure rate.

1. **Implicit retry for retriable codes.** When `handlingFor` finds no row
   and the code is marked `retriable` in the outcome catalog (or is
   `service-unavailable`), act as `{ action: 'retry', exhausted: 'exit' }`
   with a budget of `min(2, maxAttempts)` and the previous failure in view —
   the corrective attempt the engine already knows how to run. The builder's
   muted line becomes "retries once on a temporary problem, then stops". A
   row the author wrote still wins. This alone closes #1 for the transient
   half of failures and finally uses the `retriable` flag (#6).
2. **Transient model errors never fail an attempt.** Treat
   `rate_limit`/`overloaded`/`network` mid-attempt the way `subagent.ts`
   does: back off and re-issue the same turn (the messages are in hand) up
   to a small cap, counted in `modelCalls` for the timeline. Only after the
   cap does it become the `service-unavailable` outcome — which #1 then
   retries once more at the attempt level (#2).
3. **Stop charging the model for its own corrections.** Count an errored
   call at half, or not at all, toward `NORMAL_TOOL_CAP`, keeping
   `MAX_LLM_TURNS` as the real bound; and raise the normal cap to 5. A step
   that needs look-up → act → verify should not be at its ceiling on
   attempt 1 (#3, #4). The prompt's budget sentence changes with it.
4. **The model's declared code outranks the regex** when the step handles
   that code: `_meta` → declared-and-handled → heuristic → declared →
   `other`. The author planned for the model's reading, not for the error
   text's vocabulary (#5).
5. **"Nothing found" is a result, not a failure** (#7, #8). Remove the
   seeded `no-results → retry` row from `seededHandlingFor`, drop the
   drafter's `no-results` rule, and drop the outcome guide's paragraph that
   tells the model to declare an empty search as a failure; the system
   prompt already treats it as success. Where an author's own `no-results`
   row exists, its exhaustion takes `continue` when unset. `newStep` and the
   draft grammar default `maxAttempts` to 1 (the design already written).
6. **Build per-item loop failure handling** as designed (#9). It is the
   difference between an agent that can be trusted with a list and one that
   cannot.
7. **A `config` failure pauses, notifies once, and stops retrying** (#11):
   disable the trigger that fired it, raise a card ("Jira access expired —
   reconnect to resume"), and leave the agent enabled so reconnecting resumes
   it. Oversight keeps its row.
8. **Branch and until evaluators get the step's live context.** When the
   condition chips nothing, list the variables the enclosing steps saved
   (bounded) rather than nothing — a judgment with no evidence is not a
   judgment. Cheap, and it turns silent misroutes into right ones.

None of these change what a run records; the timeline, ledgers, and oversight
keep working, with more rows marked `retried` and fewer runs marked `failed`.

## 5. Measure before and after

The ledgers already hold what is needed; the queries do not exist yet.

- **Failure taxonomy.** `agent_run_log` grouped by `error_kind` and
  `outcome_code` over the last 90 days, with a "benign" bucket:
  `service-unavailable`, `llm_error`, `timeout`, `guard` (budget), `config`,
  and `no-results` exhausted. If that bucket is a third or more of failures,
  §4 is the first thing to build and the number to watch.
- **The authoring funnel.** Builder opened → draft requested → draft applied
  → saved → enabled → first run → first succeeded run, per person. Today
  only the last three are recorded (`agents`, `agent_run_log`). Two events on
  the draft route and one on save close the gap. The number that matters is
  the share of people who open the builder and enable something within a day.
- **Chat-to-agent.** Once §3.4 exists: agents created from chat versus from
  the builder, and their 30-day survival (still enabled, ran in the last
  week).

## 6. Order

1. §4.1–4.5 and 4.7 — the engine defaults and the nothing-found fix. Days,
   not weeks; every existing agent benefits; no UI beyond copy.
2. §5's failure query and the funnel events — so the rest can be judged.
3. §3.1–3.3, 3.5, 3.7 — task steps: lift the sub-agent loop into a package,
   add the `task` kind and `report_step`, route on reports, widen the run
   token, supervised first runs. Existing agents untouched.
4. §3.6 and 3.8 — the outline as the builder's default view, with the
   diagram as a tab; the drafter and `agent_create` on the smaller grammar;
   "convert to tasks".
5. §3.4 — parallel lanes, once task steps have run for a while and the
   lane cursor design has been tried against resume and the janitor.
6. §4.6 and 4.8 — loop item failures and evaluator context, where not
   already subsumed by task steps.

What this document does not propose: removing branches, loops, endings, the
approval gate, or the diagram. They are the structure a person wants to see
and control. The argument is that the structure was carrying a per-step
contract — one tool, named chips, coded failures — that belongs to the model
at run time, and the people who did not want that contract went back to the
chat.
