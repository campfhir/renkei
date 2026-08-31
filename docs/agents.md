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

This is distinct from the card-level approve/dismiss flow described in [`mcp-gateway.md`](./mcp-gateway.md#cards--actionable-items): that operates on `actionable_items` created by the ambient event pipeline, while `needsApproval`/`ask_person` operate on individual steps *inside* a running agent.

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

## LLM provider resolution (`packages/agent-llm`)

`resolveAgentLlm(db, tenantId, agentModelConfigId)` picks the agent's own model override if one is set and enabled, otherwise the org's default `llm_model_configs` row. API keys are decrypted at time of use (60-second cache) rather than held decrypted. Failure modes are typed rather than thrown-and-caught generically: `NO_MODEL`, `UNSUPPORTED_PROVIDER`, `CONFIG_ERROR`, `DB_ERROR` — an agent never silently runs unconfigured. `buildProvider` currently supports `anthropic` and `openai` (the latter also covers Azure AI Foundry and other OpenAI-dialect gateways via a configurable `baseUrl`); a `gemini` slot exists but is stubbed.

## Recent activity (context for the next change here)

The dominant recent thread in this part of the codebase is the approval/question migration: moving from a standalone approval node to the `needsApproval` gate on `ActionStep`, adding `ask_person`, splitting the approval card and the question-answer card into separate flows, reframing input-mode approvals to read as questions rather than proposals, and making form answers keyed consistently by field name across the card UI, the API route, and the MCP tool. If you're extending the approval/question system, read the git history on `packages/agents` and `apps/web/lib/agents` before assuming the old "approval node" shape still applies anywhere — it doesn't, and stale references to it in comments or older design docs should be treated as historical, not current.

**Keep this file in sync as that work continues** — it's the newest, fastest-moving part of the system and the part most likely to drift out of date. See the maintenance note in [`docs/README.md`](./README.md).
