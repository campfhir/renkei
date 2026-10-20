# The agent system

Renkei's agents are user- or org-owned automations: **instructions and a tool selection**, a trigger that starts a run, and an execution engine that hands the agent its instructions and lets it work toward the goal — calling tools through the MCP surface as the run's owner, retrying as it judges, inside hard limits. There is no step plan: the step-document model (actions, branches, loops, groups, terminal markers walked node by node) was replaced in migration 155, which converted every existing agent's steps into instructions.

## The definition (`packages/agents`)

An agent is an `AgentDefinition` (`definition.ts`): `instructions` — a structured Markdown prompt — and `tools`, the tool names it may use. The rest of the agent row sits around it: name, triggers, guardrails, model override, `canAskQuestions`, and `autoAcceptActions`.

- **The instructions are structured by convention, not by schema.** `INSTRUCTION_SECTIONS` names the headings the drafting flow writes and the builder seeds a new agent with — Goal, Context, Approach, Tools, Actions, Done when, Rules — each with the question it answers. The validator requires content (`instructionsHaveContent`: something beyond bare headings) and a length bound (`MAX_INSTRUCTIONS_CHARS`), never the headings themselves.
- **The tools are an allowlist**, validated at save against the OWNER's projection (`validateAgentDraft`): a tool they do not have, or an app-only one, is refused; at most `MAX_AGENT_TOOLS`. The old `blocked_tools` column is no longer read — not selecting a tool is how an agent is kept from it.
- A run **snapshots** the definition (`agent_runs.definition_snapshot`): it executes the instructions and tools as they were when it started, even if the agent is edited while it runs or waits. Guardrails, `canAskQuestions` and `autoAcceptActions` are live-read at run time instead, so tightening any of them bites in-flight runs.

The old columns are kept, unread, as `agents.legacy_steps` and `agent_runs.legacy_steps_snapshot` — nothing an owner wrote was lost — and a later migration may drop them. In-flight step runs were canceled by the migration (error kind `converted`): a half-walked plan cannot be continued as a conversation.

## How a run works (`apps/worker-agents/src/engine.ts`)

A run is **one conversation**:

- The **system prompt** (`runSystemPrompt` in `@renkei/agents/run-prompts`) carries everything constant for the run: the frame (how to work, the limits, the staging rule, the untrusted-content rule), the owner's guardrails, the agent's instructions, its knowledge-note index and its memory. It is byte-identical across the run, so from the second model call on it is a prompt-cache read; memory sits last because a `remember` call can change it mid-run.
- The **opening message** (`buildRunOpening`) carries this run's input: how it started, the facts (owner name and email, today, now), and every `trigger.*` value, fenced as `<untrusted>` data.
- Then the model calls tools, reads results (each fenced as untrusted, clipped at `TOOL_RESULT_CHARS`), and keeps going until it calls **`finish_run`** with `done`, `nothing_to_do` (optionally `quiet`) or `failed`, a summary, and an optional `result` handed to chained agents. A budget line (`budgetLine`) rides on each batch of tool results so the agent always knows what is left.
- `spawn_agent` (offered whenever the agent has a read tool): a read-only sub-agent for a self-contained read job. It gets a fresh conversation, the read tools the parent names, and returns one report; it cannot stage, ask or spawn. Its tool calls are billed to the parent's turn row (so the budget counts them; at most `MAX_SUB_AGENT_TOOL_CALLS` and never more than the parent has left), its model calls ride the parent's usage, and only the report enters the parent's context (`runSubAgent` in the engine). Several `spawn_agent` calls in one reply run in parallel, `MAX_CONCURRENT_SUB_AGENTS` (3) at a time; a run starts at most `MAX_SUB_AGENTS_PER_RUN` (10), counted from its turn rows. The spawn itself is not a tool call; each sub-agent's own reads are, deducted from the parent's budget as they are made (nothing is reserved), held to 30 per sub-agent. When its cap or the run's budget runs out mid-way, the sub-agent is told to stop and gets one tool-less call to report. It is told the run's facts (today, now, weekday, owner) and has the free `resolve_time`; a rate-limited, overloaded or unreachable model hands the run back to the queue as it does for the parent, and only the spawns still unanswered run again.
- Built-in tools, answered by the engine and never billed: `finish_run`, `remember` (an explicit note for future runs — the engine writes nothing to memory on its own), `resolve_time` (deterministic date arithmetic; it also names the day of the week, which the run's opening Facts state too — models guess weekdays wrongly), and `ask_person` when `canAskQuestions` is on.
- Long runs stay within the model's context. The budget is sized from the model's context window (`contextWindowOf` in `@renkei/agent-llm`: the model row's `settings.contextWindowTokens`, else the model family, else 128k tokens) less the reply, the system prompt and the tool list. When the conversation outgrows it, the run **compacts**: the turns before the last three are folded into notes the run's own model writes (`run-compaction.ts`: progress and next steps, exact facts and identifiers, changes and their outcomes, questions and answers, dead ends), in batches when the span is long. The notes are kept sealed on the turn that made them, and every later request is the run's opening, the notes, then the turns after them; the run page shows where a fold happened and its notes. Whatever still does not fit — one turn too big on its own, a dozen long reads in one reply — is cut by `fitMessages`: old results to a head, then the recent turn's largest results to a head and tail, each cut said in place, nothing dropped and no call left without its result. A provider that still refuses the request as too long gets it once more at half the budget. Sub-agents are fitted the same way. The stored turns keep everything.

### The hard limits

The agent has autonomy, inside two org-wide ceilings (`@renkei/settings`, Settings → Agents):

- **Active time** — `agentRunTimeoutMinutes`, default **30**. Only the time the agent holds control counts: `agent_runs.active_ms` accumulates while the run executes and is saved every turn and before control leaves. Waiting on a person (a staged batch awaiting acceptance, a question awaiting an answer) and the batch's own execution do not count — the clock stops and resumes when the run is handed back. Checked before every model call and every tool call; reaching it ends the run as `timeout`.
- **Tool calls** — `agentRunToolCallBudget`, default **150**. Every real tool call counts, and each staged action counts once, when it is proposed. Built-ins are free. The count is read from the turn rows (`tool_call_count`), never an in-memory counter. Out of calls, the agent gets ONE more model turn forced to `finish_run`, so the run ends with its own account of where it got to; a call past the budget is refused rather than made.

The frame tells the agent these are ceilings, not targets: finish as soon as the goal is met.

### Durability: turns are the engine's memory

Each model turn is an `agent_run_steps` row (`step_id = 'turn'`, `attempt` = turn number, `iteration` 0) written BEFORE the model is called and updated as each tool result lands. The detail is sealed under the owner's automation key (`turn-detail.ts`: the opening, the assistant blocks, the tool results, the summary and result in one `uenc1:` envelope; structure — usage, model-call timings, tool-call outlines, pause, finish — in the clear). A redelivered job (a crash, a deploy, a wake after a pause) rebuilds the conversation from the rows and continues from exactly where it stopped:

- a real call is marked `inFlight` before it goes out; a call found in flight on re-entry gets an "interrupted, outcome unknown — check before repeating" result and is **never made twice**;
- a row with no model reply is called again; a parked row is resolved (below);
- `unique(run_id, step_id, iteration, attempt)` makes a second executor of the same run fail loudly instead of acting twice.

A worker shutting down (`stopRequested`) hands the run back at its next checkpoint (`MessageReleased`); the next executor continues it.

## Changes are staged, never made by the agent

An agent **reads freely and never writes**. The engine mints two tokens per run: a probe token naming every selected tool (plus the notifier's) — used to learn from `tools/list` which tools read and which act (`readOnlyHint`; unknown reads as act) and to send the owner's notifications — and the **model's token, naming the read tools only**. The gateway registers nothing else for it, so however the conversation goes, no act tool is reachable from the model's calls.

Act tools are described inside the `stage_actions` tool (`buildStageActionsDef`: each tool's description and input schema), and the agent proposes changes with it — an ordered batch (`action-batch.ts`), one action or a series, each `{tool, args, reason}`, plus a summary. Staging ends the agent's turn:

1. The engine writes an `agent_action_batches` row (migration 155) — one per turn, `unique(run_id, turn)` — and decides who accepts it (`actApprovalReason` in `act-approval.ts`):
   - **the owner**, unless the agent's `autoAcceptActions` is on;
   - **a person anyway** when the batch holds a tool on the fixed high-risk list `ALWAYS_APPROVAL_TOOLS` (sending or forwarding mail, `webex_send_message`, merging a PR, granting repository access, deleting or sharing a document, `jira_delete_issue`, Mirth traffic and configuration writes, ADManager password resets, every `entra_*_preview` write — `apps/web/lib/mcp-tools/high-risk-tools.test.ts` holds it to registered names), or when the org's `agentActStepsRequireApproval` applies: by default every run an event or API key started (`externally_triggered` — a chained run inherits the ROOT of its chain's provenance, an unresolvable chain reads as external), optionally `all`, or `off`;
   - otherwise it is accepted automatically, on the owner's behalf.
2. A batch that needs a person gets ONE `approval` card for the whole batch (`actionable_items`, `suggested_action = {batchId, summary, actions}`, keyed `(run, 'turn', 0, turn)`), plus the owner's notification. The run waits (`waiting_until` from the agent's `timeoutHours`, default 96, clamped by `agentApprovalMaxWaitDays`). Accept or decline is for the whole batch, with an optional comment the agent reads (`decideApproval` in `apps/web/lib/agents/approvals.ts`; the feed card, the API route and the MCP tool all go through it).
3. An accepted batch is run by the **action executor** (`apps/worker-agents/src/actions.ts`) — a separate `{ batchId }` job of type `actions` on the agents queue, under a token of its own naming just the batch's tools. In order, one at a time; the first failure stops the batch and later actions are recorded `skipped`; each outcome is written to the batch as it lands; a batch found mid-execution after a crash records the interrupted action as failed with its outcome unknown and never repeats it; a batch whose run was canceled is not executed. Then it re-enqueues the run.
4. The engine reads the settled batch and returns `batchReportForAgent` as the `stage_actions` result — accepted by whom, each action's outcome (succeeded results fenced as untrusted), or declined/expired with the comment. The agent carries on: adjusting, staging again, or finishing.

The **approval sweep** (`approval-sweep.ts`) keeps waits honest: it expires cards past `waiting_until` (the agent reads that as "timed out"), re-wakes a run whose card was decided but whose wake was lost, and re-drives a waiting run with no card after a grace hour — which also re-hands an auto-accepted batch whose executor job was lost (the executor's claim is the arbiter, so duplicates are harmless).

## `ask_person` and questions

`ask_person` is offered when the agent has `canAskQuestions` on. It pauses the run behind a `question` card. The model asks the way a colleague would (`ask-questions.ts`): an `intro` in plain sentences, and either nothing more — one question, answered in a single reply box — or a batch of `questions`, one complete sentence per decision with its evidence in `context` and its own answer control (a long reply box by default; text, choice, multi, yes/no, number or date when one fits). Every question may be skipped, a batch ends with an "anything else?" box, and the answers come back as question/answer pairs. The older `{message, form}` shape is still read for cards already waiting; the answer — validated by `question-answers.ts`, the same check behind the card UI, the answer API route and the MCP answer tool — comes back as the call's result, and the agent continues the same conversation. The clock is stopped while the question waits.

## Knowledge and memory

Two separate things, easy to conflate:

- **Agent knowledge notes** — owner-curated. Every run's system prompt carries an INDEX of them (title and id per note, the whole body only for short notes, up to `AGENT_NOTES_INJECT_MAX_CHARS`); the run is given `agent_knowledge_list` to fetch a full note when one looks relevant. Managed via the `agent_knowledge_*` MCP tools.
- **Agent memory** (`memory.ts`, table `agent_memories`) — what runs chose to remember. The only run-time writer is the agent calling `remember`; a duplicate entry is skipped, and a new one is visible to the rest of the same run (the system prompt is re-rendered). Entries are capped at `MEMORY_ENTRY_MAX_CHARS`; the prompt carries up to `MEMORY_INJECT_MAX_CHARS`, summary first. Compaction happens in `apps/worker-agents/src/memory-compaction.ts`. Entries are sealed under the owner's automation key; `agent_memory_forget` deletes selectively.

## Triggers, runs, chaining

`triggers.ts`/`trigger-catalog.ts`/`trigger-filters.ts`/`recurrence.ts` describe what starts a run: an event match (fed by `apps/worker`'s domain-dispatch fan-out, `fanOutAgentEvents`), a schedule (`schedule-sweep.ts`, roughly every 30 seconds), an API key (`/api/agents/{id}/invoke`), another agent finishing (`finalize.ts`), or a person (`agent_run_now`, the Run button). Every start goes through `createAgentRun` (`runs.ts`): the cycle, chain-depth and daily-cap guards, then a `queued` row with the definition snapshot and a bare `{ runId }` job under ordering key `agent:{agentId}`.

A run that finishes `done` chains the agents triggered by it: the child starts with `parentSummary` — the parent's summary and `result`. `nothing_to_do` and quiet finishes chain nothing and notify no one; a failure emits `agents/run.failed` for the interactive worker's owner notification.

### Resuming a failed run

A failed run can be picked back up where it stopped — the run page's "Resume", `POST …/runs/{runId}/resume` (`{ guidance?, confirm? }`), or `agent_run_resume`. All call `resumeAgentRun` (`runs.ts`): the run goes back to `queued` with the failure cleared and recorded (`resume_failure`), `active_ms` reset, and the resume stamped (`resumed_at`, `resume_count`, `resume_guidance`). The engine continues the same conversation: calls the last turn never answered get a "not run" result, the next turn opens with `resumeMessage` (what stopped it and the owner's guidance, which is binding), and the tool budget counts only turns since `resumed_at` — a fresh budget, which is the owner's call to grant. Contrast with rerun, which starts a NEW run of the agent as it stands now on the old input.

## Drafting (`apps/web/lib/agents/draft-from-prose.ts`)

"Describe it" turns prose into a definition. The drafting system prompt (`draftSystemPrompt`) explains how agents work here (autonomy, the live limits, staged changes), lists **every tool the owner has** grouped by connector — each marked `[reads]` or `[changes]` with its full description — names the values a run is handed (builtins and the attached triggers' `trigger.*`), and asks for `{name, instructions, tools, questions?, guardrails?, triggers?}` with the instructions under exactly the `INSTRUCTION_SECTIONS` headings. Revising sends the current instructions and tools with the requested change. `parseDraftReply` verifies every tool name against the catalog (an unknown one is dropped with a note), reports missing headings, and parses proposed triggers (`draft-triggers.ts`); a reply with problems goes back once with them. The run is a durable job (`agent_drafts`, the agents worker's `draft` message calling back into `draft/{draftId}/run`), and nothing is saved until the owner does.

## Usage ledgers, the usage page, and the optimizer

- **The run log** (`agent_run_log`): one row per run — status, timing, cost (`attempts` now counts turns), and on failure the kind and the clipped error. Its step columns are left empty.
- **The token ledger** (`llm_calls`): one row per model turn (`purpose = 'run'`), per optimizer pass and per chat turn, with provider, model, cache breakdown and `duration_ms`. Per-step token views are retired — a run has turns, not steps; usage is overall, by model, and by run.
- **Tool calls** (`tool_calls`): the gateway's per-call ledger, stamped with the agent from the run token.
- **The optimizer** (`agent_optimizations`, `apps/web/lib/agents/optimize.ts`) gathers the run log's failures, run-level numbers (turns and tool calls per run), a per-tool call/failure profile from the turn rows' clear outlines, and the last turns of a few failed runs, renders the agent as the Markdown export does, and asks the org's model for findings plus a **revision brief** naming instruction sections and tools. It never edits the agent: `optimize/apply` turns the brief into an ordinary drafting revision for the owner to review.

## The run record and what each audience sees

`apps/web/lib/agents/runs-view.ts` projects a run as `RunDetail`: the definition snapshot, the turns (`attempts`), the staged batches (`batches`), wall time and active time. Content — turn details, the trigger input, the batches' summaries, actions and results, the resume guidance — is visible to the owner always and to an org admin only on a FAILED run; the content-free columns (statuses, counts, timings) are visible to both. `run-actions.ts` flattens a run into reads (from the turns) and changes (from executed batches); `run-debug.ts` renders the paste-ready debug export.

## LLM provider resolution (`packages/agent-llm`)

`resolveAgentLlm(db, agentModelConfigId)` picks the agent's own model override if one is set and enabled, otherwise the org's default `llm_model_configs` row. Failure modes are typed (`NO_MODEL`, `UNSUPPORTED_PROVIDER`, `CONFIG_ERROR`, `DB_ERROR`) — an agent never silently runs unconfigured. A run whose tools reach a PHI connector must resolve to a BAA-covered model when the org requires it (`phiCoveredModelRefusal`).

**Keep this file in sync** — this is the fastest-moving part of the system. See the maintenance note in [`docs/README.md`](./README.md).
