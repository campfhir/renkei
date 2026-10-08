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
   the model's own corrections, and the empty-search trap goes away. This
   lowers the failure rate of every existing agent without touching the
   builder.
2. **Add a second, simpler way to author** (§3): an agent that is a trigger,
   a brief in prose, and a tool allowance, executed by the chat's sub-agent
   loop — created from the chat ("do this every weekday at 8") or from a
   one-box builder, with the step document as the advanced form rather than
   the only form. The flow chart stays for people who want the control; it
   stops being the front door.

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

### 2.4 Discovery: agents live on an island

Agents are a top-level page described as "step-by-step helpers you draft
yourself". The chat — where people already are, and where they already run
multi-step work through `chat_delegate` — has no path to "do this on a
schedule" or "save what you just did as an agent". The MCP layer deliberately
has no drafting tool ("There is NO drafting tool here", `mcp-tools/agents`),
so a chat model cannot draft one either; it would have to hand-write the full
step JSON.

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

## 3. The front door: an agent as a brief

### 3.1 Shape

A second document shape beside the step tree:

```ts
interface AgentBrief {
  version: number;
  kind: 'brief';
  /** Prose with var/date chips — what to do, in the author's words. */
  brief: InstructionSegment[];
  /**
   * What it may call. Absent = the owner's reading tools plus find_tools;
   * acts must be listed (or discovered and then approved — see 3.3).
   */
  tools?: string[];
  /** Calls per run and wall clock, within org caps. */
  budget?: { calls?: number; minutes?: number };
}
```

Triggers, guardrails, memory, knowledge notes, `canAskQuestions`, the model
override, sharing, and the ledgers all stay exactly as they are — they hang
off the agent row, not the step document. The run row, token, notifier, and
timeline are reused: a brief run is one attempt row whose `toolCalls` is the
whole transcript, rendered the way `subagent-modal.tsx` renders a chat
sub-agent's.

### 3.2 Execution

`runSubagent` (`apps/web/lib/chat/subagent.ts`) already is the loop: a task,
a tool set, a step cap, a wall clock, LLM retry on transient kinds, progress
recording, and a report. The agents worker calls it (or a copy lifted into a
shared package — it has no chat-specific dependency that matters) with:

- the brief rendered with the trigger's variables (all of them — a brief has
  no chip contract; "the email" means the email);
- `find_tools` over the owner's projection, so the author never names a
  tool unless they want to restrict;
- `finish_step`-style closure replaced by the report: the run succeeds when
  the model reports, fails only on a hard abort (auth, budget, timeout);
- `remember`, `ask_person`, `resolve_time` as today.

What is lost relative to steps: determinism of _which_ tool runs _when_, and
per-step attribution in the usage page. What is gained: the author does not
have to predict the plan. For most of the agents people actually want
(digests, triage, "file this where it belongs"), the plan is the model's job.

### 3.3 Acting safely without a failure table

The step model's safety story is "the author named the one tool, and
`needsApproval` gates it". A brief needs an equivalent that does not require
naming tools up front:

- **Reads are free; acts are gated by the chat's permission rules.**
  `permission-rules.ts` already classifies acts and decides what asks. A
  brief run gates an act the same way `needsApproval` does today — park the
  run, raise the proposed-call card — unless the owner has allowed that tool
  for this agent ("always allow `jira_add_comment` here"), recorded on the
  agent like `blockedTools` is now.
- **Supervised first runs.** A new agent's first N runs (org setting, default 3) gate every act regardless. The card the owner answers is the same one
  the gate raises today; approving with "always" fills the allow list. This
  turns the first-run feedback loop from "read the timeline later" into
  "approve or correct as it goes".
- Guardrails inject as they do now; `blockedTools` still blocks.

### 3.4 Where briefs come from

- **Chat.** A `agent_draft` MCP tool (the drafting gap in `mcp-tools/agents`)
  that takes prose and a trigger, creates a disabled brief agent, and returns
  the link — so "every weekday at 8, tell me which of my tickets went stale"
  in chat becomes an agent in one turn, reviewed on its page, enabled with
  the existing review panel. And "save this as an agent" on a chat thread:
  the thread's task and tool calls are the best brief anyone will write.
- **The builder.** A new agent starts as a brief: one box, a trigger
  chooser, and Save. "Turn into steps" runs the existing drafter over the
  brief and opens the flow chart for people who want the control — the
  current flow, one click deeper instead of first.
- **Existing step agents** are untouched. Their export already renders as
  prose; "simplify to a brief" can be offered from the Improve panel, not
  forced.

### 3.5 The builder's default view for step agents

Independent of briefs: make the editable outline the default view and the
flow chart a "Diagram" tab. `renderStepsOutline` already produces the
numbered document; the step editor's fields (instruction with chips, save
as, the "if something goes wrong" line) render inline under each number,
branches and loops as indented blocks. The side panel stays for the dense
parts (failure rows, approval settings, schedule). This is the cheapest change
in this document that touches utilization, and it does not conflict with the
drag-and-drop work in [`builder-drag-drop-design.md`](./builder-drag-drop-design.md)
— the outline is a list too.

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
5. **Fix the empty-search trap** (#7, #8). Seeded and drafted `no-results`
   rows get `exhausted: 'continue'` and a cap of 2 tries; `newStep` and the
   draft grammar default `maxAttempts` to 1 (the design already written).
   Better still, drop the seeded retry and let the instruction's own words
   say whether nothing is an answer — the system prompt already treats an
   empty result as success unless the author handled `no-results`.
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

1. §4.1–4.5 and 4.7 — the engine defaults and the empty-search fix. Days,
   not weeks; every existing agent benefits; no UI beyond copy.
2. §5's failure query and the funnel events — so the rest can be judged.
3. §3.5 — the outline as the builder's default view.
4. §3.1–3.4 — brief agents, chat drafting, supervised first runs. The big
   bet; it reuses the sub-agent loop and the approval card, so most of the
   work is the document shape, the worker branch, and the run page.
5. §4.6 and 4.8 — loop item failures and evaluator context.

What this document does not propose: removing the step model, the flow
chart, or the failure table. They are the right tools for the automations
that need exactness — a filing pipeline with a branch per document type, a
loop with a bulk tool. The argument is that they were the only tools, and the
people who did not need exactness went back to the chat.
