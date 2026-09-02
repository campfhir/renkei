# The agent system

Renkei's agents are user- or org-owned automations: a step document, a trigger that starts a run, and an execution engine that walks the steps calling out to the MCP tool surface as the run's owner. This is currently the most actively developed part of the codebase and, until now, the least documented — see the "recent activity" note at the end.

## The step-document model (`packages/agents`)

An agent is a `steps` document (`steps.ts`): a tree of `AgentStepNode`s.

- **`ActionStep`** — a name, instruction text (segments), at most one `tool`, `maxAttempts`, an optional `saveAs` (bind the result to a variable), and `failureHandling`/`onSuccess` branching.
- **`BranchStep`** — conditional branching on prior step results/variables.
- **`LoopStep`** — `foreach` or `until` iteration.
- **`GroupStep`** — a named grouping of steps (organizational, not control-flow).
- **`TerminalStep`** — ends the run.

Documents are versioned (currently 1–9+); the version only increments when a document actually uses a construct introduced in that version, so older, simpler agents stay byte-identical rather than being rewritten forward.

## Approval gate

As of the most recent rework, there is **no standalone "approval node."** Approval is a property directly on an `ActionStep`: `needsApproval?: boolean` (meaningless unless `tool` is also set), with `approvalTimeoutHours` and an `onNotApproved: BranchPath` taken either on explicit denial or on timeout. The decision and any comment are bound into the run as `approval.outcome`/`approval.comment` variables, available to later steps. This replaced an earlier design where approval was a separate node type in the step tree — if you find references to "the approval node" in an older design doc or comment, that's describing the prior shape, not the current one.

## `ask_person` and questions

`ask_person` is a free tool — not something the agent author has to wire up per step — offered to the model mid-run whenever the agent has `canAskQuestions` enabled. Calling it pauses the run and asks a human a question, optionally as a structured form (`question-form.ts` defines the field types). Answers are validated by `question-answers.ts`, keyed by field name — the same validation logic backs the card UI, the answer API route, and the MCP answer tool, so there's exactly one place that decides whether an answer is well-formed.

This is distinct from the card-level approve/dismiss flow described in [`mcp-gateway.md`](./mcp-gateway.md#cards--actionable-items): that operates on `actionable_items` created by the ambient event pipeline, while `needsApproval`/`ask_person` operate on individual steps _inside_ a running agent.

## Knowledge and memory

Two separate things, easy to conflate:

- **Agent knowledge notes** — owner-curated, always included in full in every run's context. Managed via the `agent_knowledge_*` MCP tools.
- **Agent memory** (`memory.ts`, table `agent_memories`) — append-only entries the agent itself writes during runs. Each entry is capped at `MEMORY_ENTRY_MAX_CHARS` (500); injected into prompts up to `MEMORY_INJECT_MAX_CHARS` (4000), summaries first, then newest-fit. Compaction (summarizing old memory to make room) happens in `apps/worker-agents` rather than in `packages/agents`, since it needs an LLM call. Selective deletion is available via the `agent_memory_forget` MCP tool.

## Triggers and runs

`triggers.ts`/`trigger-catalog.ts`/`trigger-filters.ts`/`recurrence.ts` describe what starts a run: an event match (fed by `apps/worker`'s domain-dispatch fan-out, `fanOutAgentEvents`) or a schedule/recurrence (fired by `apps/worker-agents`'s `schedule-sweep.ts`, checked roughly every 30 seconds). `runs.ts` creates and guards run rows and records failures. Runs can also be started by hand via the `agent_run_now` MCP tool, bypassing both event and schedule triggers.

## Execution engine (`apps/worker-agents`)

`engine.ts` claims an `agent_jobs` message and drives the run step by step. Two correctness properties worth knowing if you touch this code:

- Every attempt gets an `agent_run_steps` row **written before the LLM loop starts**, under a `unique(run_id, step_id, attempt)` constraint — so a redelivered queue message resumes the existing attempt rather than re-acting.
- The attempt-budget cap is enforced by counting real rows in the database, never an in-memory counter that could drift from what actually happened.

Tool calls execute through `AgentMcpClient` (`mcp-client.ts`) against `apps/web`'s own MCP endpoint (`RENKEI_WEB_INTERNAL_URL`), authenticated with a per-run token (`token.ts`) — an agent run is, from the MCP gateway's point of view, just another authenticated caller subject to the same capability projection and gates as a human-driven MCP client. `finalize.ts` handles chaining a follow-up agent and reporting `agents/run.failed` back to `apps/worker`; `notifications.ts` and `memory-compaction.ts`/`maintenance.ts` cover run notifications and retention sweeps.

`draft.ts` (`createDraftHandler`) handles a second message type, `draft`, for turning a prose description into an agent step document — the "type what you want, get a draft agent" builder flow, distinct from executing an existing agent.

## Usage ledgers, the usage page, and the optimizer

Three timestamped, content-free ledgers turn run history into something an owner can act on, and — because each row carries a real instant rather than a server-calendar day — into charts in the viewer's own timezone:

- **The run log** (`agent_run_log`, migration 083): one row per run, inserted at creation and upserted by `recordAgentRunOutcome` (`packages/agents/src/runs.ts`) from the engine's `finalizeRun` (and the stuck-run janitor): status, timing, what the run cost, and on failure the step it stopped at (resolved to its name), the engine's `error_kind`, the failed attempt's `outcome_code`, and the clipped error. `run_id` is a soft reference — runs are pruned by `agentRunRetentionDays`, the log by the org's `agentUsageRetentionDays` (default a year).
- **The token ledger** (`llm_calls`, migration 085): one row per finalized attempt's model spend (`purpose = 'run'`, with agent/run/step ids) and per optimizer pass (`'optimize'`), attributed to the person whose spend it was. Written by `recordLlmCall` beside the per-day counter tally; pruned with the run log.
- **Tool calls** (`tool_calls`, agent stamped by migration 086): the existing per-call ledger, now carrying `agent_id` from the run token so an agent's calls are attributable without reading the per-attempt JSON.

Every page that counts runs or tokens — the agent overview's Invocations and Usage panels, agent oversight, the person page, the Tools page's by-agent table — reads these ledgers. The per-day counters (`agent_run_counters`, 049/072) are no longer written or read: they were keyed on the database's `CURRENT_DATE` and could not be re-cut per viewer. Migration 087 backfills the ledgers from the runs still within retention, and leaves the counter table in place as pre-ledger history for an operator; a later migration may drop it.

- **My usage** (`apps/web/app/[slug]/utilization`). One person's overall utilization, pinned to the session's own subject: tokens from `llm_calls`, runs and failures from `agent_run_log` (their owned agents), tool calls from `tool_calls` under their subject — which includes their agents' calls, since a run token is bound to the owner — every series bucketed with `AT TIME ZONE` in the viewer's zone from a window that starts at the viewer's midnight, plus recurring failure signatures (same agent, same step, same kind) each linking to the agent's Improve panel. Queries live in `apps/web/lib/usage/user-utilization.ts`; the period/bucket arithmetic in `window.ts` is unit-tested.
- **The optimizer** (`agent_optimizations`, migration 084). Owner-only. `POST /api/tenant/{tenantId}/agents/{agentId}/optimize` writes a row (with the org's `agentOptimizerWindowDays`, default 30, frozen onto it) and enqueues an `optimize` job; the agents worker (`optimize.ts`, the draft handler's twin) calls back into `optimize/{optimizationId}/run` with an owner-bound token, and `apps/web/lib/agents/optimize.ts` gathers the evidence (the run log's failures and run-level numbers, a per-step token/attempt profile from `agent_run_steps`, the failing steps of a few recent failed runs under the owner's visibility), renders the agent as the Markdown export does, and asks the org's model for a JSON report: summary, findings by area (accuracy, reliability, tokens) with a fix and the evidence each rests on, expected impact, and a **revision brief** in prose. The optimizer never edits the agent: `optimize/apply` turns the brief into an ordinary `agent_drafts` revision (the same pipeline as "describe it" in the builder), and the builder offers the result on open for the owner to review before saving. `optimization-sweep.ts` rescues stuck passes and prunes old reports, like the draft sweep.

## LLM provider resolution (`packages/agent-llm`)

`resolveAgentLlm(db, tenantId, agentModelConfigId)` picks the agent's own model override if one is set and enabled, otherwise the org's default `llm_model_configs` row. API keys are decrypted at time of use (60-second cache) rather than held decrypted. Failure modes are typed rather than thrown-and-caught generically: `NO_MODEL`, `UNSUPPORTED_PROVIDER`, `CONFIG_ERROR`, `DB_ERROR` — an agent never silently runs unconfigured. `buildProvider` currently supports `anthropic` and `openai` (the latter also covers Azure AI Foundry and other OpenAI-dialect gateways via a configurable `baseUrl`); a `gemini` slot exists but is stubbed.

## Recent activity (context for the next change here)

The dominant recent thread in this part of the codebase is the approval/question migration: moving from a standalone approval node to the `needsApproval` gate on `ActionStep`, adding `ask_person`, splitting the approval card and the question-answer card into separate flows, reframing input-mode approvals to read as questions rather than proposals, and making form answers keyed consistently by field name across the card UI, the API route, and the MCP tool. If you're extending the approval/question system, read the git history on `packages/agents` and `apps/web/lib/agents` before assuming the old "approval node" shape still applies anywhere — it doesn't, and stale references to it in comments or older design docs should be treated as historical, not current.

**Keep this file in sync as that work continues** — it's the newest, fastest-moving part of the system and the part most likely to drift out of date. See the maintenance note in [`docs/README.md`](./README.md).
