/**
 * The agents-over-MCP tools — your agents as things chat and integrations
 * can read, inspect, and (with confirmation) change.
 *
 * The use cases that forced these: chaining ("what does my triage agent
 * save, so mine can use it?"), improvement ("show me the failed run, then
 * update the agent"), and curation (an agent writing reference notes onto
 * another agent it feeds). Reads render through the SAME renderers the web
 * UI uses — the agent's instructions verbatim, the run-debug markdown, the
 * bounded knowledge/memory blocks runs themselves receive — so there is no
 * third description of an agent to drift.
 *
 * Ground rules, each load-bearing:
 *
 *  - Access is STRUCTURAL, matching the web routes: an agent resolves for
 *    its owner, or for someone holding an unexpired access grant
 *    (access-grants.ts — the sharing modal's "share with a person"), through
 *    the SAME resolveAgentAccess every agent route uses. A grantee sees the
 *    agent exactly as the owner does — run details unredacted, edits
 *    allowed — because that is the point of sharing it. Someone with
 *    neither reads the agentId as not-found, never as forbidden. The one
 *    thing sharing does NOT extend is the owner's approval/question card
 *    feed (agent_approvals_list/agent_approval_decide and their question
 *    siblings) and agent deletion — both stay owner-only, matching every
 *    web route that touches them.
 *  - The DEFINITION-EDITING tools (agent_create, agent_update, agent_patch)
 *    REFUSE agent-run callers (`context.agent` set): a run must not rewrite
 *    its own instructions or strip its guardrails — the cards ground rule, applied
 *    to behavior. Knowledge and memory tools stay available to runs:
 *    knowledge is reference data an agent legitimately curates
 *    (knowledge_create_note already exists); instructions and guardrails
 *    are behavior definition, and that line is the point. The one memory
 *    exception: agent_memory_forget's blanket `all` wipe refuses runs too,
 *    because that record is what the NEXT run and the owner both read —
 *    forgetting named entries stays open to runs.
 *  - Writes are CONFIRM-GATED: without `confirm: true`, every
 *    definition-editing tool validates and reports what WOULD be saved,
 *    persisting nothing. `enabled: true` is refused outright — the builder's review
 *    panel is the consent surface for arming an agent; disabling is
 *    always allowed. agent_memory_forget shares the gate for its
 *    `all` wipe (a dry run reports what would go), while forgetting named
 *    entries is immediate — the caller listed them from agent_memory_list
 *    first.
 *  - There is NO drafting tool here. Prose-to-instructions drafting is the web
 *    builder's own REST path (/agents/draft + the worker job); model
 *    callers work at the definition level instead — agent_get hands them
 *    the exact JSON, agent_update validates their edit deterministically.
 *  - STARTING a run is narrow on purpose: agent_run_now brings a SCHEDULED
 *    agent's next run forward and does nothing else — an agent that is off,
 *    or that fires from an event, a chain, or an API key, comes back with
 *    that reason. It refuses agent-run callers too: an agent starting
 *    agents outside the chain would bypass the cycle and depth guards,
 *    which read a lineage only a real trigger carries.
 *  - USAGE is read from the token and tool ledgers (agent-usage.ts), the
 *    same rows the usage dashboards show: agent_usage_get per agent (or
 *    a line per reachable agent), a tokens line per run in
 *    agent_runs_list, and a per-model split under agent_run_get.
 *    Content-free by construction, so a grantee reads the owner's numbers
 *    and an agent run may read its own.
 *  - EDITS ARE PARTIAL BY DEFAULT: agent_update replaces the whole
 *    definition, which makes every untouched trigger a transcription risk,
 *    and an omitted trigger an outright delete. agent_patch (name,
 *    instructions, tools added/removed, one trigger by id, guardrails, the
 *    question and auto-accept switches, model) changes what it names and
 *    nothing else, through the same parse-and-save path — so a patch can
 *    never reach a state a full update could not.
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/server';
import { getDatabase, type DB } from '@renkei/db';
import type { Kysely } from 'kysely';
import {
  APPROVAL_DEFAULT_TIMEOUT_HOURS,
  MAX_QUESTION_FIELDS,
  BUILTIN_VARIABLES,
  DEFAULT_APPROVAL_WAIT_CAP_HOURS,
  INSTRUCTION_SECTIONS,
  MAX_ACTIVE_HOURS,
  MAX_AGENT_TOOLS,
  MAX_INSTRUCTIONS_CHARS,
  MAX_SCHEDULE_RULES,
  MAX_QUESTION_ANSWER_CHARS,
  TRIGGER_EVENT_CATALOG,
  agentDefinitionOf,
  flattenFormFields,
  friendlyToolName,
  isAlwaysApprovalTool,
  triggerVariableDescriptors,
  type ApiTriggerInput,
  type QuestionField,
  type TriggerDraft,
} from '@renkei/agents';
import { countAgentMemory, forgetAgentMemory, readAgentMemory } from '@renkei/agents/memory';
import { createAgentRun, findInProgressRun, resumeAgentRun } from '@renkei/agents/runs';
import { sql } from 'kysely';
import { keywordsFieldSchema, type MCPToolContext } from '../common';
import { listAgents, type TriggerPayload } from '@/lib/agents/store';
import {
  resolveAgentAccess,
  listAgentsSharedWith,
  type AgentAccess,
} from '@/lib/agents/access-grants';
import { getIdentityEmail } from '@/lib/identity';
import { saveAgent } from '@/lib/agents/save';
import { applyTriggerPatch, toTriggerOperations } from '@/lib/agents/patch-triggers';
import { parseAgentPayload } from '@/lib/agents/payload';
import { triggerSummary } from '@/lib/agents/trigger-summary';
import { listRunsForOwner, getRunForOwner } from '@/lib/agents/runs-view';
import { renderRunDebugMarkdown } from '@/lib/agents/run-debug';
import {
  getAgentTokenUsage,
  getAgentToolUsage,
  getRunTokenUsage,
  getTokenUsageByAgent,
  getTokenUsageByModel,
  getTokenUsageByRun,
  ZERO_TOKEN_USAGE,
} from '@/lib/agents/agent-usage';
import { isUsagePeriod, PERIOD_KEYS } from '@/lib/agents/usage-periods';
import {
  renderAgentUsageText,
  renderAgentsUsageText,
  renderRunUsageMarkdown,
  runTokenLine,
} from '@/lib/agents/usage-text';
import {
  createAgentNote,
  deleteAgentNote,
  listAgentNotes,
  updateAgentNote,
  MAX_AGENT_NOTE_CHARS,
  MAX_AGENT_NOTE_TITLE_CHARS,
  type AgentNoteError,
} from '@/lib/agents/agent-notes';
import { agentDefinition } from '@/lib/agents/definition';
import {
  answerQuestion,
  decideApproval,
  listPendingApprovals,
  listPendingQuestions,
  type PendingApproval,
  type PendingQuestion,
} from '@/lib/agents/approvals';
import { requestRunCancellation } from '@/lib/agents/run-cancellation';
import { listAvailableTools, type ToolDescriptor } from '@/lib/mcp-tools/tool-catalog';
import { DEFAULT_ORG_SETTINGS, getOrgSettings, type ActApprovalPolicy } from '@renkei/settings';
import { agentJobsQueue } from '@renkei/queue';
import { isUuid } from '@/lib/uuid';
import { logger } from '@/lib/logger';

/** The connector key the agents capabilities register under. */
export const AGENTS_CONNECTOR = 'agents';

function textResult(text: string) {
  return { content: [{ type: 'text' as const, text }] };
}

function errText(text: string) {
  return { content: [{ type: 'text' as const, text }], isError: true as const };
}

/** One API input's value, as a chat run may pass it — the same ceiling a call's state gets, far below it. */
const MAX_RUN_INPUT_CHARS = 8_000;

/** `{ name: text }` from a tool argument, or null when it is anything else. */
function textRecordOf(raw: unknown): Record<string, string> | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  const entries = Object.entries(raw);
  return entries.every(([, value]) => typeof value === 'string')
    ? Object.fromEntries(entries)
    : null;
}

/**
 * What is wrong with the inputs a chat run was given, or null when they fit
 * the agent's API trigger: every declared input given, none unknown, each
 * under the length cap. A missing input is named with its label, so the
 * agent's owner can see what to ask the person for.
 */
function apiRunInputsIssue(
  declared: ApiTriggerInput[],
  given: Record<string, string>
): string | null {
  const passed = Object.keys(given);
  const names = declared.map((input) => input.name);
  const unknown = passed.filter((name) => !names.includes(name));
  if (unknown.length > 0) {
    return (
      `Unknown input${unknown.length > 1 ? 's' : ''}: ${unknown.join(', ')}. ` +
      (names.length > 0 ? `This agent takes ${names.join(', ')}.` : 'This agent takes no inputs.')
    );
  }
  const missing = declared.filter((input) => !passed.includes(input.name));
  if (missing.length > 0) {
    return `Missing input${missing.length > 1 ? 's' : ''}: ${missing
      .map((input) => `${input.name} (${input.label})`)
      .join(', ')}.`;
  }
  const long = passed.find((name) => given[name].length > MAX_RUN_INPUT_CHARS);
  return long === undefined
    ? null
    : `The ${long} input is longer than ${MAX_RUN_INPUT_CHARS} characters.`;
}

/** "1 entry" / "3 entries" — memory counts appear in three sentences. */
function entryCount(count: number): string {
  return `${count} ${count === 1 ? 'entry' : 'entries'}`;
}

const NO_SUBJECT = 'This caller has no recorded identity, so it has no agents.';
/** The trailing window the agent page's "Tools used" card reads. */
const TOOL_USAGE_WINDOW_DAYS = 30;
const NOT_FOUND = 'No agent of yours, and none shared with you, has that id.';
const RUN_REFUSAL =
  'Agent runs cannot edit agent definitions — creating and updating agents is reserved ' +
  'for people. The read, run-history, knowledge, and memory tools remain available.';

const noteErrorText: Record<AgentNoteError, string> = {
  DB_ERROR: 'Database error.',
  NOT_FOUND: 'No such note on this agent.',
  EMBEDDINGS_OFF:
    'Knowledge notes need an embedding provider, and this organization has none configured.',
  EMBEDDING_FAILED: 'The embedding provider rejected the content — try again.',
};

/**
 * The caller's access to one agent — owner or grantee, through the same
 * resolver every agent web route uses. Someone with neither resolves to
 * null, which every caller here reports as not-found.
 */
async function agentAccessFor(
  db: Kysely<DB>,
  context: MCPToolContext,
  agentId: unknown
): Promise<AgentAccess | null> {
  const id = typeof agentId === 'string' ? agentId.trim() : '';
  if (!id || !context.subject) return null;
  return resolveAgentAccess(db, context.subject, id);
}

/** The instructions, verbatim, or a note that there are none yet. */
function instructionsOf(instructions: string): string {
  return instructions.trim() ? instructions : '(no instructions yet)';
}

/** The tool selection, one per line, or a note that there is none. */
function toolListLines(tools: string[]): string[] {
  return tools.length > 0 ? tools.map((tool) => `- ${tool}`) : ['- none (reasoning only)'];
}

/**
 * What every run of this agent is handed: the builtins, and what its
 * triggers deliver. Listed because an author working over MCP has no
 * builder sidebar to discover them from — instructions that never name the
 * message the run reacts to are instructions the agent has to guess at.
 */
function valueLines(triggers: TriggerDraft[]): string[] {
  const fromTriggers = triggerVariableDescriptors(triggers);
  return [
    'Every run is handed these values in its opening message (instructions may name them):',
    ...BUILTIN_VARIABLES.map((variable) => `- ${variable.name}: ${variable.description}`),
    ...fromTriggers.map((variable) => `- ${variable.name}: ${variable.description}`),
  ];
}

/** How long is left before a wait runs out, as a trailing clause. */
function remainingClause(waitingUntil: string | null, now: number): string {
  const deadline = waitingUntil ? new Date(waitingUntil).getTime() : null;
  const hoursLeft = deadline === null ? null : Math.round((deadline - now) / 3_600_000);
  if (hoursLeft === null) return '';
  return hoursLeft <= 0
    ? ' — the wait has run out; the run treats it as declined next'
    : ` — ${hoursLeft}h left before it times out`;
}

/**
 * One waiting batch, with everything a decision needs in the lines that
 * announce it: what the agent says it is for, every action in the order it
 * would run (tool, reason, arguments), which run it holds up, and how long
 * is left.
 */
function approvalLines(approval: PendingApproval, now: number): string[] {
  return [
    `- ${approval.title}`,
    `  cardId: ${approval.cardId} · agent "${approval.agentName}" (${approval.agentId}) · run ${approval.runId}`,
    `  ${approval.actions.length} staged action(s) · raised ${approval.raisedAt}${remainingClause(approval.waitingUntil, now)}`,
    ...(approval.summary ? [`  ${approval.summary.replace(/\n/g, '\n  ')}`] : []),
    ...approval.actions.flatMap((action, index) => [
      `  ${index + 1}. ${friendlyToolName(action.tool, null)} (${action.tool}) — ${action.reason}`,
      `     args: ${JSON.stringify(action.args)}`,
    ]),
  ];
}

/**
 * One waiting question, with everything an answer needs in the lines that
 * announce it: what is being asked, which run it holds up, the form (if
 * any), and how long is left.
 */
function questionLines(question: PendingQuestion, now: number): string[] {
  const fields = flattenFormFields(question.form);
  return [
    `- ${question.title}`,
    `  cardId: ${question.cardId} · agent "${question.agentName}" (${question.agentId}) · run ${question.runId}`,
    `  ${
      fields.length > 0
        ? 'Wants a FORM filled in — answer with `answers`, keyed by the field names below'
        : 'Wants an open answer'
    }` + ` · raised ${question.raisedAt}${remainingClause(question.waitingUntil, now)}`,
    ...(question.message ? [`  ${question.message.replace(/\n/g, '\n  ')}`] : []),
    // The form itself, because a caller cannot see the card: without the
    // types and the option lists, answering it is guesswork the checker
    // then rejects.
    ...fields.map((field) => `  · ${describeQuestionField(field)}`),
  ];
}

/** One field as one line: what it wants, and what it will accept. */
function describeQuestionField(field: QuestionField): string {
  const shape =
    field.type === 'choice' || field.type === 'multi'
      ? `${field.type === 'multi' ? 'any of' : 'one of'}: ${(field.options ?? []).join(' | ')}`
      : field.type === 'number'
        ? `number${field.min !== undefined ? `, min ${field.min}` : ''}${
            field.max !== undefined ? `, max ${field.max}` : ''
          }`
        : field.type === 'date'
          ? 'date, as YYYY-MM-DD'
          : 'text';
  return (
    `"${field.name}" — ${field.label.trim() || field.name} (${shape})` +
    `${field.key ? ` · writes to ${field.key}` : ''}` +
    `${field.required ? ' · required' : ''}${field.help ? ` · ${field.help}` : ''}`
  );
}

/**
 * How an agent works, which no skill in the catalog accounts for.
 *
 * A model reading the catalog as "everything this agent could do" would
 * conclude an agent calls a send tool the moment it decides to — and write
 * instructions that assume so. It cannot: every change is staged and
 * accepted first. The limits are the org's LIVE values, read by the caller.
 */
function nativeCapabilities(limits: { minutes: number; toolCalls: number }): string {
  return [
    'How an agent works — no skill above accounts for this:',
    '- An agent is INSTRUCTIONS plus a TOOL SELECTION. It works autonomously from the ' +
      'instructions: it decides which of its tools to call and in what order, and retries ' +
      'another way when a call fails. Write a goal and guidance, not a script.',
    `- HARD LIMITS on every run: ${limits.toolCalls} tool calls and ${limits.minutes} minutes ` +
      'of ACTIVE time (time spent waiting on a person does not count). The agent is told what ' +
      'is left as it goes and is expected to finish as soon as the goal is met; reaching a ' +
      'limit ends the run unfinished.',
    '- It READS freely with its [read] tools. It NEVER calls an [act] tool itself: it stages ' +
      'the changes as ONE batch (its built-in stage_actions call: an ordered list of ' +
      '{tool, args, reason}), and the run pauses. The owner accepts or declines the WHOLE ' +
      'batch on one card — or, when the agent has `autoAcceptActions: true`, it is accepted ' +
      "automatically wherever the org's policy allows (by default not on runs an event or " +
      'webhook started) and never for the fixed high-risk tools (sending mail, merging a pull ' +
      'request, deleting or sharing a document, directory writes). A separate process then ' +
      'carries the batch out in order, stops at the first failure, and reports each outcome ' +
      'back to the agent, which carries on. So give an agent the [act] tools its changes need, ' +
      'and say in its instructions exactly what each change must contain. ' +
      'agent_approvals_list shows the batches waiting on you; agent_approval_decide answers one.',
    '- ASK A PERSON — with the agent-level `canAskQuestions: true` the agent gains a free ' +
      '`ask_person` call: {intro, questions?, timeoutHours?}. It pauses the run behind one ' +
      `question card (default wait ${APPROVAL_DEFAULT_TIMEOUT_HOURS}h, never more than ` +
      `${DEFAULT_APPROVAL_WAIT_CAP_HOURS}h). With only an intro the person answers in one ` +
      `reply box; with up to ${MAX_QUESTION_FIELDS} questions ({question, context?, ` +
      'answer?: {type: "longtext"|"text"|"choice"|"multi"|"yesno"|"number"|"date", options?}}) ' +
      'each is answered or skipped on its own, and an "anything else?" box closes the card. The ' +
      "answers come back as the call's result. agent_questions_list shows the ones waiting on " +
      'you, and agent_question_answer answers one.',
    '- REMEMBER — a free `remember` call records one fact future runs need (what was already ' +
      'handled). Say so in the instructions when it matters ("remember which ticket you filed").',
    '- FINISH — the agent ends every run with `finish_run`: "done", "nothing_to_do" (quietly, ' +
      'when the input called for no work) or "failed", with a summary and an optional result ' +
      'that an agent chained after it receives.',
  ].join('\n');
}

/** The org's live per-run limits, or the defaults when settings cannot be read. */
async function runLimits(): Promise<{ minutes: number; toolCalls: number }> {
  const settings = await getOrgSettings();
  const org = settings.ok ? settings.val : DEFAULT_ORG_SETTINGS;
  return { minutes: org.agentRunTimeoutMinutes, toolCalls: org.agentRunToolCallBudget };
}

/**
 * How many tools one call spells out in full before it stops and says how
 * many more matched. A cap, not a page: the answer to "there are 90 of
 * these" is a narrower filter, not a second call.
 */
const TOOLS_DETAILED = 60;

/**
 * One tool, as an author choosing between them needs to read it.
 *
 * The FULL description, deliberately — the same thing the web builder's
 * drafting prompt puts in front of the model that writes instructions. A
 * clipped description is how instructions get written against a tool whose
 * requirements (an input it needs, a bulk variant to prefer) lived in the
 * part nobody read. Whether it reads or changes is the one fact that
 * decides how the agent uses it: called directly, or staged for acceptance.
 */
function toolLine(tool: ToolDescriptor): string {
  const description = (tool.description ?? '').replace(/\s+/g, ' ').trim();
  return (
    `- ${tool.name} (${friendlyToolName(tool.name, tool.title)}) ` +
    `[${tool.kind === 'read' ? 'read' : 'act — changes something; staged for acceptance'}]` +
    `${description ? ` — ${description}` : ''}`
  );
}

export function registerAgentTools(server: McpServer, context: MCPToolContext): void {
  server.registerTool(
    'agent_list',
    {
      title: 'Agents · Read — List your agents',
      description:
        'Your Renkei agents, plus any others have shared with you: id, name, on/off, what ' +
        'each does, when it runs, and (for a shared one) who owns it. Start here to find an ' +
        'agentId for the other agent tools — a shared agentId works everywhere an owned one ' +
        'does, except deciding its approval/question cards and deleting it.',
      annotations: { readOnlyHint: true },
      inputSchema: z.object({}),
    },
    async () => {
      if (!context.subject) return errText(NO_SUBJECT);
      const dbResult = getDatabase();
      if (!dbResult.ok) return errText('Database unavailable.');
      const db = dbResult.val;

      const [agents, shared] = await Promise.all([
        listAgents(db, context.subject),
        listAgentsSharedWith(db, context.subject),
      ]);
      if (agents.length === 0 && shared.length === 0) {
        return textResult('You have no agents yet, and none have been shared with you.');
      }

      const lines: string[] = [];
      if (agents.length > 0) {
        lines.push(`${agents.length} agent(s) of yours:`);
        for (const agent of agents) {
          const triggers = agent.triggers
            .map((trigger) => triggerSummary(trigger.draft))
            .join('; ');
          lines.push(
            '',
            `- ${agent.name} — ${agent.enabled ? 'ON' : 'off'}${agent.guardrails ? ' · has guardrails' : ''}`,
            `  agentId: ${agent.id}`,
            ...(agent.description ? [`  ${agent.description}`] : []),
            `  runs: ${triggers || 'no triggers (manual only)'}`
          );
        }
      }
      if (shared.length > 0) {
        lines.push('', `${shared.length} agent(s) shared with you:`);
        for (const listing of shared) {
          const agent = listing.agent;
          const triggers = agent.triggers
            .map((trigger) => triggerSummary(trigger.draft))
            .join('; ');
          lines.push(
            '',
            `- ${agent.name} — ${agent.enabled ? 'ON' : 'off'}${agent.guardrails ? ' · has guardrails' : ''}`,
            `  agentId: ${agent.id}`,
            `  shared by ${listing.ownerName ?? listing.ownerEmail ?? listing.ownerSubject}`,
            ...(agent.description ? [`  ${agent.description}`] : []),
            `  runs: ${triggers || 'no triggers (manual only)'}`
          );
        }
      }
      return textResult(lines.join('\n'));
    }
  );

  server.registerTool(
    'agent_get',
    {
      title: 'Agents · Read — The exact definition, as JSON',
      description:
        "One of your agents' (or one shared with you) EXACT stored definition, as raw JSON — " +
        'the machine path: its instructions, tool selection, triggers, guardrails and ' +
        'switches. To change the NAME, the INSTRUCTIONS, the TOOLS, a TRIGGER, the ' +
        'guardrails, the question/auto-accept switches or the model, take the trigger ids ' +
        'from here and use agent_patch: it changes only the fields you send. Reach for ' +
        'agent_update — which replaces the whole definition, trigger ids and all — only for ' +
        'a rewrite. For the human-readable rendering (values it is handed, chaining), use ' +
        'agent_get_description.',
      annotations: { readOnlyHint: true },
      inputSchema: z.object({
        agentId: z.string().min(1).describe('From agent_list'),
      }),
    },
    async (args: Record<string, unknown>) => {
      if (!context.subject) return errText(NO_SUBJECT);
      const dbResult = getDatabase();
      if (!dbResult.ok) return errText('Database unavailable.');
      const db = dbResult.val;
      const access = await agentAccessFor(db, context, args.agentId);
      if (!access) return errText(NOT_FOUND);
      const agent = access.agent;

      // Get owner info for shared agents so callers know whose agent they're working with
      let ownerEmail: string | null = null;
      if (!access.viewerIsOwner) {
        const ownerEmailResult = await getIdentityEmail(access.ownerSubject);
        ownerEmail = ownerEmailResult.ok ? ownerEmailResult.val : null;
      }

      // Raw JSON, nothing else: agentId/enabled are read-only context (the
      // save path ignores them); every other key is exactly what
      // agent_update takes. ownerEmail appears for shared agents so a caller
      // knows whose agent they are working with.
      return textResult(
        JSON.stringify(
          {
            agentId: agent.id,
            enabled: agent.enabled,
            ...(ownerEmail ? { ownerEmail } : {}),
            ...agentDefinition({
              name: agent.name,
              description: agent.description,
              instructions: agent.instructions,
              tools: agent.tools,
              triggers: agent.triggers,
              guardrails: agent.guardrails,
              canAskQuestions: agent.canAskQuestions,
              autoAcceptActions: agent.autoAcceptActions,
              llmModelId: agent.llmModelId,
            }),
          },
          null,
          2
        )
      );
    }
  );

  server.registerTool(
    'agent_get_description',
    {
      title: 'Agents · Read — One agent, described',
      description:
        'The human-readable rendering of one of your agents (or one shared with you): its ' +
        'instructions, its tools, guardrails, whether it may ask you questions and accepts ' +
        'its own staged changes, the values every run is handed, triggers, and agents ' +
        'chained after it. For the exact definition to edit, use agent_get; for what its ' +
        'runs carry, agent_knowledge_list and agent_memory_list.',
      annotations: { readOnlyHint: true },
      inputSchema: z.object({
        agentId: z.string().min(1).describe('From agent_list'),
      }),
    },
    async (args: Record<string, unknown>) => {
      if (!context.subject) return errText(NO_SUBJECT);
      const dbResult = getDatabase();
      if (!dbResult.ok) return errText('Database unavailable.');
      const db = dbResult.val;
      const access = await agentAccessFor(db, context, args.agentId);
      if (!access) return errText(NOT_FOUND);
      const agent = access.agent;

      // Agents chained AFTER this one — the same owner's, matching the
      // finalize query that actually fires them.
      const chained = await db
        .selectFrom('agent_triggers as t')
        .innerJoin('agents as a', 'a.id', 't.agent_id')
        .select(['a.id', 'a.name'])
        .where('t.kind', '=', 'agent')
        .where('t.enabled', '=', true)
        .where(sql<string>`t.config->>'callerAgentId'`, '=', agent.id)
        .where('a.owner_subject', '=', access.ownerSubject)
        .execute();

      const lines = [
        `${agent.name} — ${agent.enabled ? 'ON' : 'off'} (agentId: ${agent.id})`,
        ...(agent.description ? ['', agent.description] : []),
        '',
        'Instructions:',
        instructionsOf(agent.instructions),
        '',
        'Tools:',
        ...toolListLines(agent.tools),
        ...(agent.guardrails ? ['', 'Standing guardrails:', agent.guardrails] : []),
        '',
        `Can ask you questions: ${agent.canAskQuestions ? 'yes' : 'no'}`,
        `Staged changes: ${agent.autoAcceptActions ? 'accepted automatically where the org allows it (never the high-risk tools)' : 'wait for you to accept them'}`,
        '',
        ...valueLines(agent.triggers.map((trigger) => trigger.draft)),
        '',
        'Triggers:',
        ...(agent.triggers.length > 0
          ? agent.triggers.map(
              (trigger) => `- ${triggerSummary(trigger.draft)}${trigger.enabled ? '' : ' (off)'}`
            )
          : ['- none (manual only)']),
        ...(chained.length > 0
          ? [
              '',
              'Chained after it (start when this one succeeds):',
              ...chained.map((row) => `- ${row.name} (agentId: ${row.id})`),
            ]
          : []),
      ];
      return textResult(lines.join('\n'));
    }
  );

  server.registerTool(
    'agent_list_tools',
    {
      title: 'Agents · Read — The skills an agent of yours can use',
      description:
        'Every skill your agents can be given — the vocabulary agent_create, agent_update ' +
        'and agent_patch accept in "tools". Each is a READ (the agent calls it directly) ' +
        'or an ACT (it changes something, so the agent stages it for acceptance — never ' +
        'calls it itself). READ THIS BEFORE WRITING AN AGENT: the builder shows an author ' +
        'this catalog in a picker, and a caller working over MCP has nowhere else to find ' +
        'it — a tool that does not exist here is refused by validation, and a tool nobody ' +
        'knows about is a capability nobody gives the agent. ' +
        'What comes back is scoped to YOU: only the connectors this organization has ' +
        'enabled and you have authorized, so it is what your agents could actually run, ' +
        'not a brochure. With no filter it names every skill by connector; pass connector, ' +
        'kind or query to read what they each do.',
      annotations: { readOnlyHint: true },
      inputSchema: z.object({
        connector: z
          .string()
          .optional()
          .describe('Only this connector, e.g. "outlook", "jira", "webex" (from the overview)'),
        kind: z
          .enum(['read', 'act'])
          .optional()
          .describe('"read" gathers information; "act" changes something (staged for acceptance)'),
        query: z
          .union([z.string(), z.array(z.string())])
          .optional()
          .describe(
            'Substring filter on name, title or description, e.g. "send message". An array ' +
              'reports each filter separately, e.g. ["send mail", "create issue"].'
          ),
      }),
    },
    async (args: Record<string, unknown>) => {
      if (!context.subject) return errText(NO_SUBJECT);

      // Same projection the save path validates against, so this cannot
      // offer a tool the save would then refuse.
      const all = (await listAvailableTools(context.subject, { roles: context.roles })).filter(
        // Preview-card buttons: the model never sees them, so an author must
        // not be told to give an agent one.
        (tool) => !tool.appOnly
      );
      if (all.length === 0) {
        return textResult(
          [
            'No skills are available to you — this organization has no connectors enabled, ' +
              'or none that you have authorized. Connect one in the web app, then ask again.',
            '',
            nativeCapabilities(await runLimits()),
          ].join('\n')
        );
      }

      const connector = typeof args.connector === 'string' ? args.connector.trim() : '';
      const kind = args.kind === 'read' || args.kind === 'act' ? args.kind : null;
      const requested = Array.isArray(args.query) ? args.query : [args.query];
      const queries: string[] = [];
      const seen = new Set<string>();
      for (const entry of requested) {
        const text = typeof entry === 'string' ? entry.trim() : '';
        if (!text || seen.has(text.toLowerCase())) continue;
        seen.add(text.toLowerCase());
        queries.push(text);
      }

      const scoped = all.filter(
        (tool) =>
          (!connector || (tool.connector ?? '') === connector) && (!kind || tool.kind === kind)
      );
      if (scoped.length === 0) {
        const known = [...new Set(all.map((tool) => tool.connector ?? 'other'))].sort();
        return errText(
          `No skills match${connector ? ` connector "${connector}"` : ''}${kind ? ` kind "${kind}"` : ''} — ` +
            `your connectors are ${known.join(', ')}.`
        );
      }

      const matches = (query: string) => {
        const needle = query.toLowerCase();
        return scoped.filter(
          (tool) =>
            tool.name.toLowerCase().includes(needle) ||
            (tool.title ?? '').toLowerCase().includes(needle) ||
            (tool.description ?? '').toLowerCase().includes(needle)
        );
      };

      const detailed = (found: ToolDescriptor[]) => [
        ...found.slice(0, TOOLS_DETAILED).map(toolLine),
        found.length > TOOLS_DETAILED
          ? `... and ${found.length - TOOLS_DETAILED} more — narrow with connector, kind or query.`
          : '',
      ];

      // No filter at all: the whole vocabulary by name. Names are what a
      // tool selection has to get exactly right, and the full descriptions for 300
      // skills are a wall nobody reads — so the overview is complete, and
      // reading what one DOES is a filtered call away.
      if (!connector && !kind && queries.length === 0) {
        const byConnector = new Map<string, ToolDescriptor[]>();
        for (const tool of scoped) {
          const key = tool.connector ?? 'other';
          byConnector.set(key, [...(byConnector.get(key) ?? []), tool]);
        }
        const sections = [...byConnector.entries()]
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([key, tools]) =>
            [`${key} (${tools.length}):`, `  ${tools.map((tool) => tool.name).join(', ')}`].join(
              '\n'
            )
          );
        return textResult(
          [
            `${scoped.length} skills your agents can use, across ${byConnector.size} connectors:`,
            '',
            ...sections,
            '',
            'Pass connector, kind or query to read what each one does and whether it reads ' +
              'or changes.',
            '',
            nativeCapabilities(await runLimits()),
          ].join('\n')
        );
      }

      if (queries.length <= 1) {
        const query = queries[0];
        const found = query ? matches(query) : scoped;
        const scope = [
          connector ? `connector "${connector}"` : '',
          kind ? `kind "${kind}"` : '',
          query ? `matching "${query}"` : '',
        ].filter(Boolean);
        if (found.length === 0) {
          return textResult(`No skills ${scope.join(', ')}.`);
        }
        return textResult(
          [
            `${found.length} skill(s)${scope.length > 0 ? ` — ${scope.join(', ')}` : ''}:`,
            ...detailed(found),
          ]
            .filter(Boolean)
            .join('\n')
        );
      }

      // Several filters: a section each, so a caller reading the answer can
      // tell which skill came from which question.
      const sections = queries.map((query) => {
        const found = matches(query);
        if (found.length === 0) return `"${query}" — no match`;
        return [`"${query}" — ${found.length} match(es):`, ...detailed(found)]
          .filter(Boolean)
          .join('\n');
      });
      return textResult(
        [
          `${scoped.length} skills searched, against ${queries.length} filters:`,
          '',
          sections.join('\n\n'),
        ].join('\n')
      );
    }
  );

  server.registerTool(
    'agent_approvals_list',
    {
      title: 'Agents · Read — Staged changes waiting on you',
      description:
        'The batches of staged changes your agents are PAUSED on, waiting for you to accept ' +
        'or decline — oldest first, because the oldest is the one about to time out. An agent ' +
        'never makes a change itself: it stages its changes as one batch, and its run waits ' +
        'here until somebody decides; nothing in the batch happens before then. Each entry ' +
        'carries the cardId agent_approval_decide takes, what the agent says the batch is ' +
        'for, every action in the order it would run (tool, reason, arguments), which run it ' +
        'holds up, and how long is left before the wait runs out and the batch is treated as ' +
        'declined.',
      annotations: { readOnlyHint: true },
      inputSchema: z.object({
        agentId: z
          .string()
          .optional()
          .describe('Only approvals raised by this agent (from agent_list)'),
        limit: z.number().int().min(1).max(50).optional().describe('Max approvals (default 20)'),
      }),
    },
    async (args: Record<string, unknown>) => {
      if (!context.subject) return errText(NO_SUBJECT);
      const dbResult = getDatabase();
      if (!dbResult.ok) return errText('Database unavailable.');

      const approvals = await listPendingApprovals(dbResult.val, context.subject, {
        agentId: typeof args.agentId === 'string' ? args.agentId : undefined,
        limit: typeof args.limit === 'number' ? args.limit : undefined,
      });
      if (approvals.length === 0) {
        return textResult(
          'Nothing is waiting on you — none of your agents has changes staged for a decision.'
        );
      }

      const now = Date.now();
      return textResult(
        [
          `${approvals.length} batch(es) of staged changes waiting on you, longest-waiting first:`,
          ...approvals.flatMap((approval) => ['', ...approvalLines(approval, now)]),
          '',
          'Answer one with agent_approval_decide, giving its cardId.',
        ].join('\n')
      );
    }
  );

  server.registerTool(
    'agent_approval_decide',
    {
      title: 'Agents · Act — Accept or decline a batch of staged changes',
      description:
        'Decide one of the batches from agent_approvals_list — the WHOLE batch, accepted or ' +
        'declined; there is no per-action choice and no editing the arguments. Accepted: a ' +
        'separate process carries every action out in order with the SAME arguments the ' +
        'card showed, stopping at the first failure, and reports each outcome back to the ' +
        'agent. Declined: none of it happens, and the agent is told so. Either way the run ' +
        'then continues — a decline does NOT fail it by itself. An optional `comment` is ' +
        'passed to the agent with the decision (e.g. WHY it was declined, so it can stage ' +
        'something better). ' +
        "This is a REAL DECISION on the owner's behalf, taken immediately and not " +
        'reversible from here — staged changes wait because a person was meant to weigh in, ' +
        'so confirm with them before deciding for them. AGENT RUNS CANNOT CALL THIS: an ' +
        'agent accepting its own changes is the whole point of staging them, undone.',
      annotations: { readOnlyHint: false },
      inputSchema: z.object({
        cardId: z.string().min(1).describe('From agent_approvals_list'),
        decision: z
          .enum(['approve', 'decline'])
          .describe('"approve" carries the whole batch out; "decline" makes none of it'),
        comment: z
          .string()
          .max(MAX_QUESTION_ANSWER_CHARS)
          .optional()
          .describe('A short note alongside the decision — the agent reads it'),
      }),
    },
    async (args: Record<string, unknown>) => {
      if (!context.subject) return errText(NO_SUBJECT);
      // The cards ground rule, at its sharpest: the pause exists so a PERSON
      // decides. A run that could answer its own approval — or another
      // agent's — would make every gate decorative.
      if (context.agent) {
        return errText(
          'Agent runs cannot decide staged changes — that is the one thing staging exists to ' +
            'prevent. A person answers this, in the Renkei feed or through their own MCP client.'
        );
      }
      const decision =
        args.decision === 'approve' || args.decision === 'decline' ? args.decision : null;
      if (!decision) return errText('decision must be "approve" or "decline".');

      const dbResult = getDatabase();
      if (!dbResult.ok) return errText('Database unavailable.');

      const result = await decideApproval(
        dbResult.val,
        agentJobsQueue().producer,
        context.subject,
        {
          cardId: typeof args.cardId === 'string' ? args.cardId.trim() : '',
          decision,
          comment: typeof args.comment === 'string' ? args.comment : undefined,
        }
      );

      switch (result.outcome) {
        case 'comment-too-long':
          return errText(`The comment must stay under ${result.max} characters.`);
        case 'not-found':
          return errText(
            'No staged batch of yours has that cardId. Batches are owner-scoped — ' +
              'agent_approvals_list shows the ones you can decide.'
          );
        case 'not-approval':
          return errText(
            'That card is not a staged batch. Informational cards are dismissed with ' +
              'card_dismiss; a question card is answered with agent_question_answer.'
          );
        case 'already-decided':
          // Someone (or the timeout sweep) got there first. Saying so beats
          // overwriting a decision that already stands.
          return errText(
            `That batch is already ${result.status} — it was decided elsewhere, or the ` +
              'wait ran out and it was treated as declined.'
          );
        case 'decided': {
          logger.info('agent_approval_decide decided a staged batch', {
            component: 'mcp/tool',
            runId: result.runId,
            decision: result.decision,
          });
          return textResult(
            [
              `${result.decision === 'approve' ? 'Accepted — the batch will be carried out, in order, and the agent told how each action went.' : 'Declined — none of it happens; the agent is told.'} Run ${result.runId}.`,
              // The claim is durable either way; only the wake is in doubt,
              // and the sweep covers it. Never report this as a failure.
              result.resumed
                ? 'It has been queued to resume — agent_run_get will show where it went.'
                : 'The decision is saved; the run will resume automatically within a few minutes.',
            ].join('\n')
          );
        }
      }
    }
  );

  server.registerTool(
    'agent_questions_list',
    {
      title: 'Agents · Read — Questions waiting on you',
      description:
        'The ask_person cards your agents are PAUSED on, waiting for you to answer — oldest ' +
        'first, because the oldest is the one about to time out. An agent with ' +
        '`canAskQuestions` on may pause mid-run and raise one of these; until somebody ' +
        'answers, that run does nothing. Each entry carries the cardId ' +
        'agent_question_answer takes, what is being asked (and its form, if it has one), ' +
        'which run it holds up, and how long is left before the wait runs out and the run ' +
        'treats it as unanswered.',
      annotations: { readOnlyHint: true },
      inputSchema: z.object({
        agentId: z
          .string()
          .optional()
          .describe('Only questions raised by this agent (from agent_list)'),
        limit: z.number().int().min(1).max(50).optional().describe('Max questions (default 20)'),
      }),
    },
    async (args: Record<string, unknown>) => {
      if (!context.subject) return errText(NO_SUBJECT);
      const dbResult = getDatabase();
      if (!dbResult.ok) return errText('Database unavailable.');

      const questions = await listPendingQuestions(dbResult.val, context.subject, {
        agentId: typeof args.agentId === 'string' ? args.agentId : undefined,
        limit: typeof args.limit === 'number' ? args.limit : undefined,
      });
      if (questions.length === 0) {
        return textResult(
          'Nothing is waiting on you — none of your agents has a pending question.'
        );
      }

      const now = Date.now();
      return textResult(
        [
          `${questions.length} question(s) waiting on you, longest-waiting first:`,
          ...questions.flatMap((question) => ['', ...questionLines(question, now)]),
          '',
          'Answer one with agent_question_answer, giving its cardId.',
        ].join('\n')
      );
    }
  );

  server.registerTool(
    'agent_question_answer',
    {
      title: 'Agents · Act — Answer a paused run',
      description:
        'Answer one of the question cards from agent_questions_list. The run resumes where ' +
        'it paused, with your answer as the result of its question — nothing it had worked ' +
        'out is lost. ' +
        "This is a REAL ANSWER on the owner's behalf, taken immediately and not reversible " +
        'from here — the agent asked because a person was meant to supply the answer, so confirm ' +
        'with them before answering for them. AGENT RUNS CANNOT CALL THIS: an agent answering ' +
        'its own question is the whole point of asking, undone.',
      annotations: { readOnlyHint: false },
      inputSchema: z.object({
        cardId: z.string().min(1).describe('From agent_questions_list'),
        answers: z
          .record(z.string(), z.union([z.string(), z.array(z.string())]))
          .optional()
          .describe(
            '{"<field name>": value} — the names agent_questions_list prints, one entry ' +
              'each. A multi-select takes an array. Checked against the form before anything ' +
              'is recorded — a number that is not a number, or a choice that is not on offer, ' +
              'comes back as an error, not as a bad answer. Omit (or {}) for a message-only ' +
              'question with no fields.'
          ),
      }),
    },
    async (args: Record<string, unknown>) => {
      if (!context.subject) return errText(NO_SUBJECT);
      if (context.agent) {
        return errText(
          'Agent runs cannot answer questions — that is the one thing ask_person exists to ' +
            'prevent. A person answers this, in the Renkei feed or through their own MCP client.'
        );
      }

      const dbResult = getDatabase();
      if (!dbResult.ok) return errText('Database unavailable.');

      const result = await answerQuestion(
        dbResult.val,
        agentJobsQueue().producer,
        context.subject,
        {
          cardId: typeof args.cardId === 'string' ? args.cardId.trim() : '',
          answers: typeof args.answers === 'object' && args.answers !== null ? args.answers : {},
        }
      );

      switch (result.outcome) {
        case 'invalid-answers':
          return errText(
            [
              'That card asks with a form, and these answers do not fit it:',
              ...result.issues.map((issue) => `- ${issue.label}: ${issue.message}`),
              'agent_questions_list prints the form — the fields, their types, and what each accepts.',
            ].join('\n')
          );
        case 'not-found':
          return errText(
            'No question of yours has that cardId. Questions are owner-scoped — ' +
              'agent_questions_list shows the ones you can answer.'
          );
        case 'not-question':
          return errText(
            'That card is not a question. Informational cards are dismissed with ' +
              'card_dismiss; an approval card is decided with agent_approval_decide.'
          );
        case 'already-decided':
          return errText(
            `That question is already ${result.status} — it was answered elsewhere, or the ` +
              'wait ran out and the run treated it as unanswered.'
          );
        case 'answered': {
          logger.info('agent_question_answer answered a paused run', {
            component: 'mcp/tool',
            runId: result.runId,
          });
          return textResult(
            [
              `Answered. Run ${result.runId} continues with it.`,
              result.resumed
                ? 'It has been queued to resume — agent_run_get will show where it went.'
                : 'The answer is saved; the run will resume automatically within a few minutes.',
            ].join('\n')
          );
        }
      }
    }
  );

  server.registerTool(
    'agent_runs_list',
    {
      title: 'Agents · Read — Recent runs of an agent',
      description:
        "One of your agents' (or one shared with you) recent runs: status (including " +
        "'waiting' for staged changes or a question), " +
        'what failed, trigger, timing, and the tokens each run spent. Use ' +
        'agent_run_get on a runId for the full story; agent_usage_get for the agent as a whole.',
      annotations: { readOnlyHint: true },
      inputSchema: z.object({
        agentId: z.string().min(1).describe('From agent_list'),
        status: z
          .enum(['succeeded', 'failed', 'stopped', 'waiting', 'running', 'queued', 'canceled'])
          .optional()
          .describe('Only runs in this state'),
        limit: z.number().int().min(1).max(50).optional().describe('Max runs (default 20)'),
      }),
    },
    async (args: Record<string, unknown>) => {
      if (!context.subject) return errText(NO_SUBJECT);
      const dbResult = getDatabase();
      if (!dbResult.ok) return errText('Database unavailable.');
      const access = await agentAccessFor(dbResult.val, context, args.agentId);
      if (!access) return errText(NOT_FOUND);
      const agent = access.agent;

      const limit =
        typeof args.limit === 'number' ? Math.min(Math.max(Math.trunc(args.limit), 1), 50) : 20;
      const status =
        args.status === 'succeeded' ||
        args.status === 'failed' ||
        args.status === 'stopped' ||
        args.status === 'waiting' ||
        args.status === 'running' ||
        args.status === 'queued' ||
        args.status === 'canceled'
          ? args.status
          : undefined;
      const runs = await listRunsForOwner(dbResult.val, access.ownerSubject, agent.id, {
        status,
        limit,
      });
      if (runs.length === 0) return textResult('No runs match.');

      // "waiting" on its own says a run is stuck without saying on WHAT, and
      // the answer is a decision this caller can make right here.
      const waiting = runs.some((run) => run.status === 'waiting')
        ? await listPendingApprovals(dbResult.val, context.subject, {
            agentId: agent.id,
            limit: 50,
          })
        : [];
      const byRun = new Map(waiting.map((approval) => [approval.runId, approval]));
      // What each run cost, from the token ledger — the figure the usage
      // dashboards show per agent, here per run. A run with no ledger rows
      // (queued, never reached the model) simply has no tokens line.
      const tokensByRun = await getTokenUsageByRun(
        dbResult.val,
        runs.map((run) => run.id)
      );
      const now = Date.now();

      const lines = [`${runs.length} run(s) of "${agent.name}", newest first:`];
      for (const run of runs) {
        const duration = run.durationMs !== null ? ` · ${Math.round(run.durationMs / 1000)}s` : '';
        const approval = byRun.get(run.id);
        const tokens = tokensByRun[run.id];
        lines.push(
          '',
          `- ${run.status} · via ${run.triggerKind} · ${run.createdAt}${duration}`,
          `  runId: ${run.id}`,
          ...(tokens ? [`  ${runTokenLine(tokens)}`] : []),
          ...(approval
            ? ['  Waiting on you:', ...approvalLines(approval, now).map((line) => `  ${line}`)]
            : []),
          ...(run.error ? [`  ${run.errorKind ?? 'error'}: ${run.error}`] : [])
        );
      }
      return textResult(lines.join('\n'));
    }
  );

  server.registerTool(
    'agent_run_get',
    {
      title: 'Agents · Read — One run in full',
      description:
        'The full debugging view of one run of one of your agents (or one shared with you) — ' +
        'the instructions it ran with, what it touched (reads and changes), the batches it ' +
        'staged and how each action went, every model turn with its tool calls, and active ' +
        'vs wall time. The same markdown the run page\'s "Copy for debugging" button ' +
        'produces, designed to be handed to a model, plus the tokens the run spent in total ' +
        'and by model.',
      annotations: { readOnlyHint: true },
      inputSchema: z.object({
        runId: z.string().min(1).describe('From agent_runs_list'),
      }),
    },
    async (args: Record<string, unknown>) => {
      if (!context.subject) return errText(NO_SUBJECT);
      const runId = typeof args.runId === 'string' ? args.runId.trim() : '';
      if (!isUuid(runId)) return errText('No run of yours has that id.');
      const dbResult = getDatabase();
      if (!dbResult.ok) return errText('Database unavailable.');
      const db = dbResult.val;

      // Resolve the agent from the run row FIRST (no owner filter — the
      // caller may be a grantee, not the owner), then check access to that
      // agentId the same way every other read here does. A run id whose
      // agent the caller cannot reach reads as not-found, same as a bad
      // runId — never "found but not yours".
      const runRow = await db
        .selectFrom('agent_runs')
        .select(['agent_id'])
        .where('id', '=', runId)
        .executeTakeFirst();
      if (!runRow) return errText('No run of yours has that id.');
      const access = await resolveAgentAccess(db, context.subject, runRow.agent_id);
      if (!access) return errText('No run of yours has that id.');
      const agent = access.agent;
      const run = await getRunForOwner(db, access.ownerSubject, agent.id, runId);
      if (!run) return errText('No run of yours has that id.');

      // A parked run's timeline ends mid-air without this: the last thing it
      // did was raise a card, and the card is what happens next. The card
      // is the OWNER's decision to make — approving spends their grants —
      // so a grantee reads the timeline without this section, same as the
      // run page.
      const approval =
        access.viewerIsOwner && run.status === 'waiting'
          ? (
              await listPendingApprovals(db, access.ownerSubject, {
                agentId: agent.id,
                limit: 50,
              })
            ).find((pending) => pending.runId === runId)
          : undefined;

      // The run's own tokens from the ledger, by model.
      const usageRows = await getRunTokenUsage(db, runId);

      return textResult(
        [
          renderRunDebugMarkdown(agent.name, run),
          renderRunUsageMarkdown(usageRows),
          ...(approval
            ? [
                '',
                '## Waiting on you',
                '',
                ...approvalLines(approval, Date.now()),
                '',
                'Answer it with agent_approval_decide, giving its cardId.',
              ]
            : []),
        ].join('\n')
      );
    }
  );

  server.registerTool(
    'agent_usage_get',
    {
      title: 'Agents · Read — Token and tool usage of your agents',
      description:
        'What your agents (and those shared with you) spend, from the same ledger the usage ' +
        'dashboards read. Without agentId: every agent you can reach, one line each, tokens ' +
        "in/out for the chosen period, largest first. With agentId: that agent's tokens for " +
        'every period (today through all time), the chosen period split by model, and its ' +
        'tool calls over the last 30 days by connector. Cached prompt tokens ' +
        'are reported as the portion of the input served from cache. For what one RUN ' +
        'cost, agent_runs_list shows a tokens line per run and agent_run_get the split by ' +
        'model.',
      annotations: { readOnlyHint: true },
      inputSchema: z.object({
        agentId: z
          .string()
          .min(1)
          .optional()
          .describe('From agent_list. Omit for a line per agent instead.'),
        period: z
          .enum(PERIOD_KEYS)
          .optional()
          .describe('The calendar period to split by (default: month = this month).'),
      }),
    },
    async (args: Record<string, unknown>) => {
      if (!context.subject) return errText(NO_SUBJECT);
      const dbResult = getDatabase();
      if (!dbResult.ok) return errText('Database unavailable.');
      const db = dbResult.val;
      const period = isUsagePeriod(args.period) ? args.period : 'month';

      const agentId = typeof args.agentId === 'string' ? args.agentId.trim() : '';
      if (!agentId) {
        // Every agent the caller can reach — their own plus the shared
        // ones — against the org-wide per-agent buckets, filtered down
        // to those ids. The caller's reach decides what is listed; the
        // ledger only ever fills in numbers for ids already resolved.
        const [own, shared, byAgent] = await Promise.all([
          listAgents(db, context.subject),
          listAgentsSharedWith(db, context.subject),
          getTokenUsageByAgent(db),
        ]);
        if (own.length === 0 && shared.length === 0) {
          return textResult('You have no agents yet, and none have been shared with you.');
        }
        return textResult(
          renderAgentsUsageText(period, [
            ...own.map((agent) => ({
              agentId: agent.id,
              name: agent.name,
              tokens: byAgent[agent.id] ?? ZERO_TOKEN_USAGE,
            })),
            ...shared.map((listing) => ({
              agentId: listing.agent.id,
              name: listing.agent.name,
              sharedBy: listing.ownerName ?? listing.ownerEmail ?? listing.ownerSubject,
              tokens: byAgent[listing.agent.id] ?? ZERO_TOKEN_USAGE,
            })),
          ])
        );
      }

      const access = await agentAccessFor(db, context, agentId);
      if (!access) return errText(NOT_FOUND);
      const agent = access.agent;
      const [tokens, byModel, tools] = await Promise.all([
        getAgentTokenUsage(db, agent.id),
        getTokenUsageByModel(db, agent.id),
        getAgentToolUsage(db, agent.id, TOOL_USAGE_WINDOW_DAYS),
      ]);
      return textResult(
        renderAgentUsageText({
          agentName: agent.name,
          agentId: agent.id,
          period,
          tokens,
          byModel,
          tools,
          toolWindowDays: TOOL_USAGE_WINDOW_DAYS,
        })
      );
    }
  );

  server.registerTool(
    'agent_run_cancel',
    {
      title: 'Agents · Act — Stop a run',
      description:
        'Stop a run of one of your agents (or one shared with you) that has not finished — ' +
        'queued, waiting on you, or actively running. This only REQUESTS the stop: a queued ' +
        'or waiting run cancels within a moment, but a running one finishes the call it is ' +
        'making first and stops before the next — agent_run_get shows when it lands. Refuses ' +
        'agent-run callers, same as agent_run_now: stopping runs outside the chain is a ' +
        'human/API decision, not one an agent makes for itself or another run mid-chain.',
      annotations: { readOnlyHint: false },
      inputSchema: z.object({
        runId: z.string().min(1).describe('From agent_runs_list'),
      }),
    },
    async (args: Record<string, unknown>) => {
      if (!context.subject) return errText(NO_SUBJECT);
      if (context.agent) {
        return errText('Agent runs cannot cancel runs from here — that is a human/API decision.');
      }
      const runId = typeof args.runId === 'string' ? args.runId.trim() : '';
      if (!isUuid(runId)) return errText('No run of yours has that id.');
      const dbResult = getDatabase();
      if (!dbResult.ok) return errText('Database unavailable.');
      const db = dbResult.val;

      // Resolve the agent from the run row first (no owner filter — the
      // caller may be a grantee), then check access the same way every
      // other read here does.
      const runRow = await db
        .selectFrom('agent_runs')
        .select(['agent_id'])
        .where('id', '=', runId)
        .executeTakeFirst();
      if (!runRow) return errText('No run of yours has that id.');
      const access = await resolveAgentAccess(db, context.subject, runRow.agent_id);
      if (!access) return errText('No run of yours has that id.');

      const result = await requestRunCancellation(db, agentJobsQueue().producer, {
        agentId: access.agent.id,
        runId,
        ownerSubject: access.ownerSubject,
        canceledBySubject: context.subject,
      });
      switch (result.outcome) {
        case 'not-found':
          return errText('No run of yours has that id.');
        case 'already-final':
          return errText(
            result.status === 'canceled'
              ? 'That run was already canceled.'
              : `That run already ${result.status} — nothing to stop.`
          );
        case 'canceling':
          return textResult(
            'Cancellation requested. agent_run_get on this runId will show "canceled" once it lands.'
          );
      }
    }
  );

  server.registerTool(
    'agent_run_resume',
    {
      title: 'Agents · Act — Resume a failed run where it stopped',
      description:
        'Pick a FAILED run of one of your agents (or one shared with you) back up where it ' +
        'stopped — the same run and conversation, with everything it had already found, and ' +
        'a fresh budget of tool calls and active time. Pass guidance to tell the agent what ' +
        'to do differently (it reads the note as binding: "the CIO project has no Task issue ' +
        'type — file it as a Project"). Different from agent_run_now: that starts a NEW run ' +
        'from the top; this continues an existing one. Refuses runs that are not failed. If ' +
        'the agent already has a run queued or running, this refuses and says so — pass ' +
        'confirm: true to queue it anyway. Refuses agent-run callers, same as ' +
        'agent_run_cancel. Follow the run with agent_run_get.',
      annotations: { readOnlyHint: false },
      inputSchema: z.object({
        runId: z.string().min(1).describe('From agent_runs_list — a run whose status is failed'),
        guidance: z
          .string()
          .max(2000)
          .optional()
          .describe('What the agent should do differently this time (optional)'),
        confirm: z
          .boolean()
          .optional()
          .describe('Resume anyway when this agent already has a run queued or running.'),
      }),
    },
    async (args: Record<string, unknown>) => {
      if (!context.subject) return errText(NO_SUBJECT);
      if (context.agent) {
        return errText('Agent runs cannot resume runs from here — that is a human/API decision.');
      }
      const runId = typeof args.runId === 'string' ? args.runId.trim() : '';
      if (!isUuid(runId)) return errText('No run of yours has that id.');
      const dbResult = getDatabase();
      if (!dbResult.ok) return errText('Database unavailable.');
      const db = dbResult.val;

      const runRow = await db
        .selectFrom('agent_runs')
        .select(['agent_id', 'trigger_kind'])
        .where('id', '=', runId)
        .executeTakeFirst();
      if (!runRow) return errText('No run of yours has that id.');
      const access = await resolveAgentAccess(db, context.subject, runRow.agent_id);
      if (!access) return errText('No run of yours has that id.');
      const agent = access.agent;

      if (runRow.trigger_kind !== 'event' && args.confirm !== true) {
        const inProgress = await findInProgressRun(db, agent.id);
        if (inProgress) {
          return errText(
            `"${agent.name}" already has a run ${inProgress.status} (runId: ${inProgress.id}). ` +
              'Call again with confirm: true to queue the resumed run behind it anyway.'
          );
        }
      }

      const resumed = await resumeAgentRun(db, agentJobsQueue().producer, {
        agentId: agent.id,
        runId,
        ownerSubject: access.ownerSubject,
        resumedBySubject: context.subject,
        ...(typeof args.guidance === 'string' ? { guidance: args.guidance } : {}),
      });
      if (!resumed.ok) {
        switch (resumed.err.type) {
          case 'NOT_FOUND':
            return errText('No run of yours has that id.');
          case 'NOT_FAILED':
            return errText(resumed.err.message ?? 'This run cannot be resumed.');
          case 'QUEUE_ERROR':
            return errText('The run could not be queued — try again shortly.');
          case 'DB_ERROR':
            return errText('The run could not be resumed.');
        }
      }

      logger.info('agent_run_resume resumed a failed run', {
        component: 'mcp/tool',
        agentId: agent.id,
        runId: resumed.val.runId,
      });
      return textResult(
        [
          `Resumed run ${runId} of "${agent.name}" where it stopped, with a fresh budget.`,
          typeof args.guidance === 'string' && args.guidance.trim()
            ? 'Your guidance is the first thing the agent reads when it continues.'
            : 'No guidance given — the agent is told the run stopped and takes another go.',
          'It is queued; agent_run_get on that runId shows how it went.',
        ].join('\n')
      );
    }
  );

  server.registerTool(
    'agent_run_now',
    {
      title: 'Agents · Act — Run an agent now',
      description:
        'Start an agent of yours (or one shared with you) immediately, without waiting for its ' +
        'next scheduled time — the "run it now" you would otherwise get by editing the schedule ' +
        'or calling its API. Two kinds of agent can be started this way, and only these: an ' +
        'agent ON with an enabled schedule trigger (its schedule is left alone, and the next ' +
        'scheduled run still happens at its own time), and an agent ON with an enabled API ' +
        'trigger, which takes the inputs that trigger declares — pass them as `inputs`, keyed ' +
        'by input name, and every declared one must be given. An agent with an API trigger is ' +
        'started that way even if it also has a schedule. An agent that is off, or that fires ' +
        'from an event or another agent, is refused with the reason. If this agent already has a ' +
        'run queued or running, this refuses and says so instead of piling a second one on — ' +
        'pass confirm: true to start it anyway. Follow the run with agent_run_get.',
      annotations: { readOnlyHint: false },
      inputSchema: z.object({
        agentId: z.string().min(1).describe('From agent_list'),
        inputs: z
          .record(z.string(), z.string())
          .optional()
          .describe(
            'For an agent with an API trigger: the value of each declared input, by name ' +
              '(agent_get lists them). Not used for a scheduled agent.'
          ),
        confirm: z
          .boolean()
          .optional()
          .describe('Start anyway when this agent already has a run queued or running.'),
      }),
    },
    async (args: Record<string, unknown>) => {
      if (!context.subject) return errText(NO_SUBJECT);
      // An agent starting agents outside the chain would bypass the cycle and
      // depth guards, which are computed from a lineage only a real trigger
      // carries. The sanctioned path stays the `agent` trigger kind.
      if (context.agent) {
        return errText(
          'Agent runs cannot start other agents from here — chain them instead, by giving ' +
            'the agent that should follow a trigger of kind "agent" naming this one. That ' +
            'path carries the lineage the cycle and depth guards read.'
        );
      }
      const dbResult = getDatabase();
      if (!dbResult.ok) return errText('Database unavailable.');
      const db = dbResult.val;
      const access = await agentAccessFor(db, context, args.agentId);
      if (!access) return errText(NOT_FOUND);
      const agent = access.agent;

      if (!agent.enabled) {
        return errText(
          `"${agent.name}" is turned off, so it is not running on its schedule and this will ` +
            'not run it either. Turn it on in the builder first — the review panel is where ' +
            'an agent gets armed.'
        );
      }

      const inputs = args.inputs === undefined ? undefined : textRecordOf(args.inputs);
      if (inputs === null) {
        return errText('inputs must be an object of text values, keyed by input name.');
      }

      // An API trigger is started the way its own Run button starts it: a
      // manual run carrying the inputs as trigger.* values, the same state a
      // system call through the API would hand it. Taken before the schedule,
      // so an agent with both still runs with the inputs it was given.
      const apiInputs: ApiTriggerInput[] = [];
      let hasApiTrigger = false;
      let hasApiDraft = false;
      for (const trigger of agent.triggers) {
        if (trigger.draft.kind !== 'api') continue;
        hasApiDraft = true;
        if (!trigger.enabled) continue;
        hasApiTrigger = true;
        apiInputs.push(...trigger.draft.inputs);
      }

      // Schedule rows only: the timezone comes from the same config the sweep
      // reads, so a manual run binds trigger.* exactly as a scheduled one does.
      const schedules: Array<{ timezone: string; enabled: boolean; nextRunAt: string | null }> = [];
      for (const trigger of agent.triggers) {
        if (trigger.draft.kind !== 'schedule') continue;
        schedules.push({
          timezone: trigger.draft.timezone,
          enabled: trigger.enabled,
          nextRunAt: trigger.nextRunAt,
        });
      }
      const armed = schedules.find((schedule) => schedule.enabled);

      let initialState: Record<string, unknown>;
      let closing: string[];
      if (hasApiTrigger) {
        const issue = apiRunInputsIssue(apiInputs, inputs ?? {});
        if (issue) return errText(issue);
        initialState = inputs ?? {};
        closing = [];
      } else {
        if (inputs !== undefined) {
          return errText(
            hasApiDraft
              ? `"${agent.name}"'s API trigger is switched off, so there is no API run to start. ` +
                  'Turn it back on in the builder.'
              : `"${agent.name}" has no API trigger, so it takes no inputs. Start it without inputs.`
          );
        }
        if (schedules.length === 0) {
          return errText(
            [
              `"${agent.name}" is not triggered by a schedule or an API trigger, and this tool ` +
                'only starts those.',
              agent.triggers.length > 0
                ? `It runs: ${agent.triggers
                    .map(
                      (trigger) =>
                        `${triggerSummary(trigger.draft)}${trigger.enabled ? '' : ' (off)'}`
                    )
                    .join('; ')}.`
                : 'It has no triggers at all — it only runs when someone starts it in Renkei.',
            ].join('\n')
          );
        }
        if (!armed) {
          return errText(
            `"${agent.name}" has a schedule, but that trigger is switched off — so there is no ` +
              'scheduled run to bring forward. Turn the schedule back on in the builder.'
          );
        }
        // The state matches what the sweep hands a scheduled run, so an agent
        // reading trigger.scheduledFor behaves the same way it will tonight.
        initialState = { scheduledFor: new Date().toISOString(), timezone: armed.timezone };
        closing = [
          armed.nextRunAt
            ? `Its schedule is untouched: the next scheduled run is still ${armed.nextRunAt}.`
            : 'Its schedule is untouched.',
        ];
      }

      // Same sanity check the "Run now" button's confirm modal makes a
      // person answer: a run already queued or running for this agent is
      // not a reason to refuse forever, just a reason to ask first — an
      // agent-run caller is already refused above, so this is always a
      // human or API-key caller deciding for themselves.
      if (args.confirm !== true) {
        const inProgress = await findInProgressRun(db, agent.id);
        if (inProgress) {
          return errText(
            `"${agent.name}" already has a run ${inProgress.status} (runId: ${inProgress.id}). ` +
              'Call again with confirm: true to start another anyway, or agent_run_get that ' +
              'runId to see how it is going.'
          );
        }
      }

      // Recorded as the manual run it is (trigger_id stays null) — the owner
      // started it, so it is not an externally triggered run for approvals.
      const result = await createAgentRun(db, agentJobsQueue().producer, {
        agentId: agent.id,
        ownerSubject: access.ownerSubject,
        definition: agentDefinitionOf(agent),
        llmModelId: agent.llmModelId,
        triggerId: null,
        triggerKind: 'manual',
        triggeredBySubject: context.subject,
        initialState,
      });
      if (!result.ok) {
        return errText(result.err.message ?? `The run could not be started (${result.err.type}).`);
      }

      logger.info('agent_run_now started an agent by hand', {
        component: 'mcp/tool',
        agentId: agent.id,
        runId: result.val.runId,
        viaApiTrigger: hasApiTrigger,
      });
      return textResult(
        [
          `Started "${agent.name}" now — runId: ${result.val.runId}.`,
          ...closing,
          'It is queued; agent_run_get on that runId shows how it went.',
        ].join('\n')
      );
    }
  );

  server.registerTool(
    'agent_memory_list',
    {
      title: "Agents · Read — An agent's memory",
      description:
        "One of your agents' (or one shared with you) memory in full: the rolling summary " +
        'and the newest entries the ' +
        'engine recorded across runs. Each entry came from a run explicitly calling the ' +
        'runtime remember tool — a deliberate note, never an automatic side effect of a run ' +
        'succeeding or failing. agent_get shows the bounded slice runs receive; this is ' +
        'the raw list. Returns entryIds for agent_memory_forget.',
      annotations: { readOnlyHint: true },
      inputSchema: z.object({
        agentId: z.string().min(1).describe('From agent_list'),
      }),
    },
    async (args: Record<string, unknown>) => {
      if (!context.subject) return errText(NO_SUBJECT);
      const dbResult = getDatabase();
      if (!dbResult.ok) return errText('Database unavailable.');
      const access = await agentAccessFor(dbResult.val, context, args.agentId);
      if (!access) return errText(NOT_FOUND);
      const agent = access.agent;

      const memory = await readAgentMemory(dbResult.val, agent.id, {
        maxEntries: 100,
      });
      if (memory.unavailable) {
        return errText(
          `"${agent.name}"'s memory is sealed under its owner's encryption key, which is not ` +
            'connected right now — the owner signing in again makes it readable.'
        );
      }
      if (!memory.summary && memory.entries.length === 0) {
        return textResult(`"${agent.name}" remembers nothing yet.`);
      }
      const lines = [`Memory of "${agent.name}":`];
      if (memory.summary) lines.push('', 'Summary:', memory.summary);
      if (memory.entries.length > 0) {
        lines.push('', `Entries (${memory.entries.length}, newest first):`);
        for (const entry of memory.entries) {
          // The entryId rides along because forgetting is SELECTIVE here:
          // without an id per line the only reachable verb is "clear it all".
          lines.push(
            `- [${entry.createdAt.toISOString()}] (entryId: ${entry.id}) ${entry.content}`
          );
        }
      }
      return textResult(lines.join('\n'));
    }
  );

  server.registerTool(
    'agent_memory_forget',
    {
      title: "Agents · Act — Forget an agent's memory",
      description:
        'Delete what one of your agents (or one shared with you) remembers: named entries ' +
        '(entryIds from ' +
        'agent_memory_list), the rolling summary, or everything. Selective forgetting is the ' +
        'point — an agent that learned one wrong fact should lose that fact, not its whole ' +
        'history. `all: true` needs `confirm: true`; without it you get a count of what would ' +
        'go and nothing is deleted. Memory does not come back.',
      annotations: { readOnlyHint: false, destructiveHint: true },
      inputSchema: z.object({
        agentId: z.string().min(1).describe('From agent_list'),
        entryIds: z
          .array(z.string().min(1))
          .min(1)
          .max(100)
          .optional()
          .describe('From agent_memory_list — the entries to forget'),
        summary: z
          .boolean()
          .optional()
          .describe('Also drop the rolling summary (entries are untouched)'),
        all: z
          .boolean()
          .optional()
          .describe('Forget everything — entries and summary. Requires confirm: true'),
        confirm: z.boolean().optional().describe('Required for all: true'),
      }),
    },
    async (args: Record<string, unknown>) => {
      if (!context.subject) return errText(NO_SUBJECT);
      const all = args.all === true;
      // A run curating its own notes is fine — wiping the record of what it
      // has already done is not: the next run reads that memory, and the
      // owner reads it to see what the agent has been doing. Selective
      // forgetting stays open to runs; the blanket wipe is the owner's.
      if (all && context.agent) {
        return errText(
          "Agent runs cannot clear an agent's whole memory — that record is what the next " +
            'run and the owner both read. Forget specific entryIds instead, or clear it from ' +
            "the agent's page."
        );
      }
      const entryIds = Array.isArray(args.entryIds)
        ? [
            ...new Set(
              args.entryIds.filter((id): id is string => typeof id === 'string' && !!id.trim())
            ),
          ]
        : [];
      const clearSummary = args.summary === true;
      if (!all && entryIds.length === 0 && !clearSummary) {
        return errText(
          'Nothing to forget — pass entryIds (from agent_memory_list), summary: true, or ' +
            'all: true.'
        );
      }
      if (all && (entryIds.length > 0 || clearSummary)) {
        return errText(
          'all: true already clears everything — call it on its own, or name entryIds instead.'
        );
      }

      const dbResult = getDatabase();
      if (!dbResult.ok) return errText('Database unavailable.');
      const db = dbResult.val;
      const access = await agentAccessFor(db, context, args.agentId);
      if (!access) return errText(NOT_FOUND);
      const agent = access.agent;

      if (all) {
        const held = await countAgentMemory(db, agent.id);
        if (held.entries === 0 && !held.hasSummary) {
          return textResult(`"${agent.name}" remembers nothing already — nothing to forget.`);
        }
        const holding = `${entryCount(held.entries)}${
          held.hasSummary ? ' and the rolling summary' : ''
        }`;
        if (args.confirm !== true) {
          return textResult(
            [
              `Would clear ALL of "${agent.name}"'s memory: ${holding}.`,
              'Nothing deleted — call again with confirm: true.',
            ].join('\n')
          );
        }
        const result = await forgetAgentMemory(db, agent.id, { kind: 'all' });
        // Memory does not come back, so the wipe leaves a trace somewhere.
        logger.info('agent_memory_forget cleared an agent memory', {
          component: 'mcp/tool',
          agentId: agent.id,
          entriesDeleted: result.entriesDeleted,
          summaryCleared: result.summaryCleared,
        });
        return textResult(
          `Cleared "${agent.name}"'s memory: ${entryCount(result.entriesDeleted)}` +
            `${result.summaryCleared ? ' and the rolling summary' : ''} forgotten.`
        );
      }

      const lines: string[] = [];
      let entriesDeleted = 0;
      if (entryIds.length > 0) {
        const result = await forgetAgentMemory(db, agent.id, {
          kind: 'entries',
          entryIds,
        });
        entriesDeleted = result.entriesDeleted;
        lines.push(
          `${entriesDeleted}/${entryIds.length} named entr` +
            `${entryIds.length === 1 ? 'y' : 'ies'} forgotten.`
        );
        for (const id of result.missingIds) {
          lines.push(`- ${id}: no entry of this agent has that id.`);
        }
      }
      if (clearSummary) {
        const result = await forgetAgentMemory(db, agent.id, {
          kind: 'summary',
        });
        lines.push(
          result.summaryCleared
            ? 'Rolling summary cleared.'
            : 'No rolling summary to clear — the agent had none.'
        );
      }
      // Entries the summary already folded in survive inside it; say so
      // rather than let "forgotten" read as more than it is.
      if (entriesDeleted > 0 && !clearSummary) {
        lines.push(
          'Note: anything compaction had already folded into the rolling summary stays there — ' +
            'pass summary: true to drop that too.'
        );
      }
      const body = [`Memory of "${agent.name}":`, ...lines].join('\n');
      // Every named id missing and nothing else asked for is a failed call,
      // not a quiet no-op.
      return entryIds.length > 0 && entriesDeleted === 0 && !clearSummary
        ? errText(body)
        : textResult(body);
    }
  );

  server.registerTool(
    'agent_knowledge_list',
    {
      title: "Agents · Read — An agent's knowledge notes",
      description:
        "One of your agents' (or one shared with you) knowledge notes in full — the " +
        'reference material its runs carry ' +
        '(agent_get shows only the bounded render). Returns noteIds for update/remove.',
      annotations: { readOnlyHint: true },
      inputSchema: z.object({
        agentId: z.string().min(1).describe('From agent_list'),
      }),
    },
    async (args: Record<string, unknown>) => {
      if (!context.subject) return errText(NO_SUBJECT);
      const dbResult = getDatabase();
      if (!dbResult.ok) return errText('Database unavailable.');
      const access = await agentAccessFor(dbResult.val, context, args.agentId);
      if (!access) return errText(NOT_FOUND);
      const agent = access.agent;

      const notes = await listAgentNotes(dbResult.val, agent.id);
      if (notes.length === 0) return textResult(`"${agent.name}" has no knowledge notes.`);
      const lines = [`${notes.length} note(s) on "${agent.name}":`];
      for (const note of notes) {
        lines.push(
          '',
          `## ${note.title} (noteId: ${note.noteId}, by ${note.authoredBy})`,
          ...(note.keywords.length > 0 ? [`Keywords: ${note.keywords.join(', ')}`] : []),
          note.content
        );
      }
      return textResult(lines.join('\n'));
    }
  );

  /** The caller's keyword list as strings; validation of shape is zod's, this only narrows. */
  function keywordList(value: readonly unknown[]): string[] {
    return value.filter((entry): entry is string => typeof entry === 'string');
  }

  server.registerTool(
    'agent_knowledge_write',
    {
      title: 'Agents · Act — Add knowledge notes to an agent',
      description:
        'Write one or MORE knowledge notes onto one of your agents (or one shared with you) ' +
        '— reference material its runs will carry (policies, formats, standing facts). Each ' +
        'note is persisted independently: one bad entry does not void the rest. Include ' +
        '`keywords` on every note — the names, identifiers and topic phrases someone would ' +
        'search to find it; you are the model, so no other model is asked.',
      annotations: { readOnlyHint: false },
      inputSchema: z.object({
        agentId: z.string().min(1).describe('From agent_list'),
        notes: z
          .array(
            z.object({
              title: z.string().min(1).max(MAX_AGENT_NOTE_TITLE_CHARS),
              content: z.string().min(1).max(MAX_AGENT_NOTE_CHARS),
              keywords: keywordsFieldSchema(
                'Up to 20 search keywords/phrases for this note: proper nouns, identifiers ' +
                  '(ticket keys, file names, versions), specific topic phrases of 1–4 words. ' +
                  'Indexed above the body text for keyword matching.'
              ),
            })
          )
          .min(1)
          .max(20)
          .describe('The notes to add — several at once is the point'),
      }),
    },
    async (args: Record<string, unknown>) => {
      if (!context.subject) return errText(NO_SUBJECT);
      const dbResult = getDatabase();
      if (!dbResult.ok) return errText('Database unavailable.');
      const access = await agentAccessFor(dbResult.val, context, args.agentId);
      if (!access) return errText(NOT_FOUND);
      const agent = access.agent;
      // Notes are keyed under the OWNER's email regardless of who writes
      // them — the owner's runs read the notes, whoever authored them.
      const ownerEmailResult = await getIdentityEmail(access.ownerSubject);
      const ownerEmail = ownerEmailResult.ok ? ownerEmailResult.val : null;
      if (!ownerEmail) {
        return errText("No email is on record for the agent owner's identity.");
      }
      const notes = Array.isArray(args.notes) ? args.notes : [];
      if (notes.length === 0) return errText('Pass at least one note.');

      const lines: string[] = [];
      let failures = 0;
      for (const entry of notes) {
        const note: { title?: unknown; content?: unknown; keywords?: unknown } =
          typeof entry === 'object' && entry !== null ? entry : {};
        const title = typeof note.title === 'string' ? note.title.trim() : '';
        const content = typeof note.content === 'string' ? note.content : '';
        // The caller is a model: its own keywords or none, never a second
        // model call. Omitted stores none, which a reindex may fill later.
        const keywords = Array.isArray(note.keywords) ? keywordList(note.keywords) : null;
        if (
          !title ||
          title.length > MAX_AGENT_NOTE_TITLE_CHARS ||
          !content ||
          content.length > MAX_AGENT_NOTE_CHARS
        ) {
          failures += 1;
          lines.push(`- "${title || '(untitled)'}": rejected — bad title or content length.`);
          continue;
        }
        const result = await createAgentNote(dbResult.val, {
          agentId: agent.id,
          ownerEmail,
          title,
          content,
          keywords,
        });
        if (typeof result === 'string') {
          failures += 1;
          lines.push(`- "${title}": failed — ${noteErrorText[result]}`);
        } else {
          lines.push(`- "${title}": created (noteId: ${result.noteId})`);
        }
      }
      const summary = `${notes.length - failures}/${notes.length} note(s) written to "${agent.name}":`;
      const body = [summary, ...lines].join('\n');
      return failures === notes.length ? errText(body) : textResult(body);
    }
  );

  server.registerTool(
    'agent_knowledge_update',
    {
      title: 'Agents · Act — Rewrite one knowledge note',
      description:
        "Replace a note's title, content and/or keywords on one of your agents (or one " +
        'shared with you). Omitted fields keep their current value; the stored note is ' +
        'fully rewritten with the result. When you change the content, pass fresh `keywords` ' +
        'for it.',
      annotations: { readOnlyHint: false },
      inputSchema: z.object({
        agentId: z.string().min(1).describe('From agent_list'),
        noteId: z.string().min(1).describe('From agent_knowledge_list'),
        title: z.string().min(1).max(MAX_AGENT_NOTE_TITLE_CHARS).optional(),
        content: z.string().min(1).max(MAX_AGENT_NOTE_CHARS).optional(),
        keywords: keywordsFieldSchema(
          'Replacement search keywords/phrases (up to 20); omitted keeps the current ones'
        ),
      }),
    },
    async (args: Record<string, unknown>) => {
      if (!context.subject) return errText(NO_SUBJECT);
      const noteId = typeof args.noteId === 'string' ? args.noteId.trim() : '';
      const title = typeof args.title === 'string' ? args.title.trim() : undefined;
      const content = typeof args.content === 'string' ? args.content : undefined;
      const keywords = Array.isArray(args.keywords) ? keywordList(args.keywords) : undefined;
      if (!noteId) return errText('noteId is required.');
      if (title === undefined && content === undefined && keywords === undefined) {
        return errText('Nothing to update — pass a new title, content, and/or keywords.');
      }
      const dbResult = getDatabase();
      if (!dbResult.ok) return errText('Database unavailable.');
      const access = await agentAccessFor(dbResult.val, context, args.agentId);
      if (!access) return errText(NOT_FOUND);
      const agent = access.agent;
      const ownerEmailResult = await getIdentityEmail(access.ownerSubject);
      const ownerEmail = ownerEmailResult.ok ? ownerEmailResult.val : null;
      if (!ownerEmail) {
        return errText("No email is on record for the agent owner's identity.");
      }

      // Full-replacement semantics underneath (same as the web panel): an
      // omitted half is carried over from the stored note.
      const current = (await listAgentNotes(dbResult.val, agent.id)).find(
        (note) => note.noteId === noteId
      );
      if (!current) return errText(noteErrorText.NOT_FOUND);

      const result = await updateAgentNote(dbResult.val, {
        agentId: agent.id,
        ownerEmail,
        noteId,
        title: title ?? current.title,
        content: content ?? current.content,
        // The caller's list, else the stored one — never the org's model.
        keywords: keywords ?? current.keywords,
      });
      if (result !== 'OK') return errText(noteErrorText[result]);
      return textResult('Note updated.');
    }
  );

  server.registerTool(
    'agent_knowledge_remove',
    {
      title: 'Agents · Act — Remove knowledge notes',
      description:
        'Delete one or more knowledge notes from one of your agents (or one shared with ' +
        'you). Each note is removed independently: one bad id does not void the rest.',
      annotations: { readOnlyHint: false },
      inputSchema: z.object({
        agentId: z.string().min(1).describe('From agent_list'),
        noteIds: z.array(z.string().min(1)).min(1).max(50).describe('From agent_knowledge_list'),
      }),
    },
    async (args: Record<string, unknown>) => {
      if (!context.subject) return errText(NO_SUBJECT);
      const dbResult = getDatabase();
      if (!dbResult.ok) return errText('Database unavailable.');
      const access = await agentAccessFor(dbResult.val, context, args.agentId);
      if (!access) return errText(NOT_FOUND);
      const agent = access.agent;
      const ownerEmailResult = await getIdentityEmail(access.ownerSubject);
      const ownerEmail = ownerEmailResult.ok ? ownerEmailResult.val : null;
      if (!ownerEmail) {
        return errText("No email is on record for the agent owner's identity.");
      }
      const noteIds = Array.isArray(args.noteIds)
        ? args.noteIds.filter((id): id is string => typeof id === 'string' && id.length > 0)
        : [];
      if (noteIds.length === 0) return errText('Pass at least one noteId.');

      const lines: string[] = [];
      let failures = 0;
      for (const noteId of noteIds) {
        const result = await deleteAgentNote(dbResult.val, {
          agentId: agent.id,
          ownerEmail,
          noteId,
        });
        if (result !== 'OK') {
          failures += 1;
          lines.push(`- ${noteId}: failed — ${noteErrorText[result]}`);
        } else {
          lines.push(`- ${noteId}: removed`);
        }
      }
      const body = [
        `${noteIds.length - failures}/${noteIds.length} note(s) removed from "${agent.name}":`,
        ...lines,
      ].join('\n');
      return failures === noteIds.length ? errText(body) : textResult(body);
    }
  );

  /**
   * The trigger grammar, written out because a caller here has nowhere else
   * to read it: drafts are `unknown` to zod (the shapes are a discriminated
   * union zod's JSON Schema projection would flatten into noise), and the
   * builder — the only other place the vocabulary appears — is a UI. The
   * event ids come from the catalog so this cannot name a stale set.
   */
  const TRIGGER_DRAFT_GRAMMAR = [
    'A draft is one of:',
    '{kind:"schedule", recurrences:[rule,...], timezone:<IANA zone, e.g. "America/Chicago">,',
    'startAt?:"YYYY-MM-DD", calendarId?:<holiday calendar id>,',
    'blackouts?:[{date:"YYYY-MM-DD"}|{start,end}|{annual:"MM-DD"}, each with an optional label],',
    'blackoutPolicy?:"skip"|"before"|"after",',
    `activeHours?:[{start:"HH:MM", end:"HH:MM"|"24:00", weekdays?:[0-6,...]}, ...] (at most`,
    `${MAX_ACTIVE_HOURS})}`,
    '— where each rule is exactly one of',
    '{every:"hour"}, {every:"day", at:"HH:MM"}, {every:"weekday", at:"HH:MM"} (Mon-Fri),',
    '{every:"week", weekday:0-6, at:"HH:MM"} (Sunday=0 — this is how a single named day is',
    'expressed; there is no {every:"sunday"}), or {every:"month", at:"HH:MM"} plus EXACTLY ONE',
    'of day:1-31 (clamped to short months), on:"last-day"|"first-weekday"|"last-weekday", or',
    "nth:1|2|3|4|-1 with weekday:0-6. Times are 24-hour wall clock read in the schedule's",
    `timezone, and rules combine by union (earliest wins, at most ${MAX_SCHEDULE_RULES}).`,
    'activeHours constrains ONLY {every:"hour"} rules to one or more windows (union) within the',
    'day — e.g. business hours 8am-8pm is {start:"08:00",end:"20:00"}; an overnight window is',
    'two entries rather than one that wraps midnight, e.g. {start:"00:00",end:"08:00"} plus',
    '{start:"19:00",end:"24:00"}. Rules with an explicit "at" already fire once at a chosen',
    'time and ignore activeHours — pick an "at" inside the desired range instead. A window\'s',
    '"weekdays" (Sunday=0) scopes it to those days, e.g. business hours Mon-Fri is',
    '{start:"08:00",end:"18:00",weekdays:[1,2,3,4,5]}; omitted means every day.',
    `{kind:"event", eventId:<one of ${TRIGGER_EVENT_CATALOG.map((event) => `"${event.id}"`).join(', ')}>,`,
    "match?:{<the event's filter field id>: string | string[]}} — filters are optional and",
    'narrow deterministically before a run exists.',
    '{kind:"agent", callerAgentId:<the agent id whose run starts this one>}.',
    '{kind:"api", inputs:[{name, label}, ...]} — each becomes a trigger.<name> variable.',
  ].join(' ');

  const TRIGGERS_DESCRIPTION = [
    'Trigger drafts — {id?, draft, enabled?} entries, or bare drafts; default none',
    '(manual only). This list REPLACES the stored one: keep the `id` of a trigger you are',
    'keeping VERBATIM (its firings and API key anchor to it), omit `id` for a new one, and',
    'know that a trigger left out is DELETED — agent_patch changes one trigger by id',
    'instead.',
    TRIGGER_DRAFT_GRAMMAR,
  ].join(' ');

  /**
   * What `instructions` should look like, from the same section list the
   * builder's editor and the drafting prompt use — so an instruction
   * written over MCP reads like one written anywhere else.
   */
  const INSTRUCTIONS_DESCRIPTION = [
    "The agent's instructions, as Markdown — what it should achieve and how; it works out the",
    'calls itself. Write them under these headings, in order:',
    ...INSTRUCTION_SECTIONS.map((section) => `"## ${section.heading}" — ${section.asks}`),
    'Name tools by their exact names where they fit, and the identifiers the agent needs',
    '(projects, channels, recipients). Name the values a run is handed (trigger.*, user.*,',
    `today) where it should use them. At most ${MAX_INSTRUCTIONS_CHARS.toLocaleString('en-US')}`,
    'characters. The agent never makes a change itself — describe the changes it should',
    'propose and what each must contain; they are staged for acceptance.',
  ].join(' ');

  const TOOLS_DESCRIPTION = [
    'The tools the agent may use, by exact name from agent_list_tools — reads it calls',
    'directly, acts it stages for acceptance. Every tool the instructions rely on and nothing',
    `else; at most ${MAX_AGENT_TOOLS}. Each is described to the model on every call, so a long`,
    'list of unused tools costs tokens every turn.',
  ].join(' ');

  const definitionSchema = {
    name: z.string().min(1).max(200).describe('The agent name'),
    instructions: z.string().min(1).max(MAX_INSTRUCTIONS_CHARS).describe(INSTRUCTIONS_DESCRIPTION),
    tools: z.array(z.string()).max(MAX_AGENT_TOOLS).optional().describe(TOOLS_DESCRIPTION),
    triggers: z.array(z.unknown()).optional().describe(TRIGGERS_DESCRIPTION),
    llmModelId: z.string().optional().describe('Model config id; default the org default'),
    guardrails: z
      .string()
      .max(1_000_000)
      .optional()
      .describe(
        'Standing rules injected into every model call of every run; binding over the ' +
          'instructions where they conflict'
      ),
    canAskQuestions: z
      .boolean()
      .optional()
      .describe(
        'Default false. When true, the agent gains the free ask_person call — see ' +
          'agent_list_tools for how agents work.'
      ),
    autoAcceptActions: z
      .boolean()
      .optional()
      .describe(
        "Default false. When true, the agent's staged changes are accepted without a person " +
          "wherever the org's policy allows (by default not on runs an event or webhook " +
          'started) — never for the fixed high-risk tools (sending mail, merging, deleting or ' +
          'sharing documents, directory writes).'
      ),
    confirm: z
      .boolean()
      .optional()
      .describe('Without true: validate and report only, persist nothing'),
  };

  /** The wire body agent_create/agent_update/agent_patch share, via the routes' parser. */
  function parseDefinition(args: Record<string, unknown>, enabled: boolean) {
    // Bare TriggerDraft entries are wrapped to the routes' {draft, enabled}
    // shape; entries already in that shape pass through.
    const triggers = Array.isArray(args.triggers)
      ? args.triggers.map((entry) =>
          typeof entry === 'object' && entry !== null && 'draft' in entry
            ? entry
            : { draft: entry, enabled: true }
        )
      : [];
    return parseAgentPayload({
      name: args.name,
      instructions: args.instructions,
      tools: Array.isArray(args.tools) ? args.tools : [],
      triggers,
      enabled,
      llmModelId: typeof args.llmModelId === 'string' ? args.llmModelId : null,
      guardrails: typeof args.guardrails === 'string' ? args.guardrails : null,
      canAskQuestions: args.canAskQuestions === true,
      autoAcceptActions: args.autoAcceptActions === true,
    });
  }

  /** The trigger list as a caller can act on it next: id, what it does, on/off. */
  function triggerLines(triggers: TriggerPayload[]): string[] {
    if (triggers.length === 0) {
      return ['Triggers: none — this agent runs only when started by hand.'];
    }
    return [
      'Triggers:',
      ...triggers.map(
        (trigger) =>
          `- ${trigger.id ?? '(new)'}: ${triggerSummary(trigger.draft)}${trigger.enabled ? '' : ' — off'}`
      ),
    ];
  }

  function issueLines(issues: { path: string; message: string }[]): string {
    return [
      'The definition does not validate:',
      ...issues.map((issue) => `- ${issue.path}: ${issue.message}`),
    ].join('\n');
  }

  /** What a save would leave: the instructions, the tools, the guardrails. */
  function definitionLines(normalized: {
    instructions: string;
    tools: string[];
    guardrails: string | null;
  }): string[] {
    return [
      'Instructions:',
      instructionsOf(normalized.instructions),
      '',
      'Tools:',
      ...toolListLines(normalized.tools),
      ...(normalized.guardrails ? ['', 'Guardrails:', normalized.guardrails] : []),
    ];
  }

  /**
   * Where the agent's changes will wait for a person — so the reply to a
   * save says it before the first run does. Best effort: the catalog's
   * read-or-act kind and the org setting are read here, and a failure to
   * read either says nothing rather than refusing the save.
   */
  async function hintLines(draft: {
    tools: string[];
    autoAcceptActions: boolean;
  }): Promise<string[]> {
    if (!context.subject) return [];
    let policy: ActApprovalPolicy = DEFAULT_ORG_SETTINGS.agentActStepsRequireApproval;
    let kinds: Map<string, 'read' | 'act'>;
    try {
      const [settings, catalog] = await Promise.all([
        getOrgSettings(),
        listAvailableTools(context.subject, { roles: context.roles }),
      ]);
      if (settings.ok) policy = settings.val.agentActStepsRequireApproval;
      kinds = new Map(catalog.map((tool) => [tool.name, tool.kind]));
    } catch {
      return [];
    }
    const acts = draft.tools.filter((tool) => kinds.get(tool) !== 'read');
    if (acts.length === 0) {
      return ['', 'This agent has no act tools: it can read and report, but stage no changes.'];
    }
    const highRisk = acts.filter(isAlwaysApprovalTool);
    const lines = [
      '',
      `Changes it can stage (accepted before anything happens): ${acts.join(', ')}.`,
    ];
    if (!draft.autoAcceptActions) {
      lines.push('Every batch it stages waits for you to accept it.');
    } else {
      lines.push(
        policy === 'all'
          ? "Auto-accept is on, but the org's policy has a person accept every batch anyway."
          : policy === 'externally_triggered'
            ? 'Batches are accepted automatically on runs started by hand or on a schedule; ' +
              'runs an event or webhook started still wait for you.'
            : 'Batches are accepted automatically.'
      );
      if (highRisk.length > 0) {
        lines.push(`A batch holding ${highRisk.join(', ')} always waits for you.`);
      }
    }
    return lines;
  }

  server.registerTool(
    'agent_create',
    {
      title: 'Agents · Act — Create an agent (confirm-gated)',
      description:
        'Create a new agent of yours from a full definition — instructions plus a tool ' +
        "selection — authored directly, or taken from another agent's agent_get JSON or " +
        'exported markdown. Authoring one directly starts at agent_list_tools: it names every ' +
        'skill an agent may be given, whether each reads or changes, and how agents work ' +
        'here — the catalog the web builder shows in a picker and nothing else here would ' +
        'tell you. Without confirm:true this is a DRY RUN — it validates and shows what would ' +
        'be created, persisting nothing. The agent is always created DISABLED: turning it on ' +
        'happens in the builder, where the review panel is.',
      annotations: { readOnlyHint: false },
      inputSchema: z.object(definitionSchema),
    },
    async (args: Record<string, unknown>) => {
      if (!context.subject) return errText(NO_SUBJECT);
      if (context.agent) return errText(RUN_REFUSAL);
      if ('enabled' in args && args.enabled === true) {
        return errText(
          'Enabling an agent is done in the builder after review — create it disabled first.'
        );
      }
      const dbResult = getDatabase();
      if (!dbResult.ok) return errText('Database unavailable.');
      const parsed = parseDefinition(args, false);
      if ('error' in parsed) return errText(parsed.error);

      const dryRun = args.confirm !== true;
      const result = await saveAgent(dbResult.val, context.subject, parsed, {
        dryRun,
      });
      if (result.outcome === 'not-found') return errText(NOT_FOUND);
      if (result.outcome === 'invalid') return errText(issueLines(result.issues));
      if (result.outcome === 'valid-dry-run') {
        return textResult(
          [
            `Valid. This would create "${result.normalized.name}" (disabled) with:`,
            ...definitionLines(result.normalized),
            ...(await hintLines(result.normalized)),
            '',
            'Nothing was saved. Call again with confirm:true to create it.',
          ].join('\n')
        );
      }

      logger.info('agent_create persisted a new agent', {
        component: 'mcp/tool',
        agentId: result.agentId,
      });
      return textResult(
        [
          `Created "${result.normalized.name}" — DISABLED until you review and turn it on in the builder.`,
          `agentId: ${result.agentId}`,
          ...(await hintLines(result.normalized)),
          ...(result.apiKeys.length > 0
            ? [
                'API trigger keys (shown exactly once):',
                ...result.apiKeys.map((key) => `- trigger ${key.triggerId}: ${key.key}`),
              ]
            : []),
          'A plain-language summary and review notes are being written; agent_get will show them shortly.',
        ].join('\n')
      );
    }
  );

  server.registerTool(
    'agent_patch',
    {
      title: 'Agents · Act — Change part of an agent (confirm-gated)',
      description:
        'Change PART of one of your agents (or one shared with you) WITHOUT resending all of ' +
        'it — its name, its instructions (sent whole), tools to add or remove, its triggers ' +
        '(one at a time, by id), its guardrails, whether it may ask you questions, whether it ' +
        'auto-accepts its staged changes, or its model. ONLY the fields you send change; ' +
        'everything you leave out is kept exactly as stored. Prefer this over agent_update ' +
        'for anything short of a rewrite: agent_update REPLACES the whole definition, so it ' +
        'makes you echo every trigger back verbatim, and a trigger missing from that echo is ' +
        'DELETED along with its firing history, its next run time and an API key that can ' +
        'never be shown again. Trigger ids come from agent_get; a trigger you do not name ' +
        'here is left untouched, ids and all. Without confirm:true this is a DRY RUN — it ' +
        'validates and shows what would change, persisting nothing. This tool never TURNS ON ' +
        'an agent (the builder is the consent surface for that): an off agent stays off, an ' +
        'already-enabled one stays on unless keepEnabled:false.',
      annotations: { readOnlyHint: false },
      inputSchema: z.object({
        agentId: z.string().min(1).describe('From agent_list'),
        name: z.string().min(1).max(200).optional().describe('Rename the agent'),
        instructions: z
          .string()
          .min(1)
          .max(MAX_INSTRUCTIONS_CHARS)
          .optional()
          .describe(
            "Replaces the instructions WHOLE — start from agent_get's and change only what " +
              'the edit needs. ' +
              INSTRUCTIONS_DESCRIPTION
          ),
        addTools: z
          .array(z.string())
          .optional()
          .describe('Tools to give the agent, by exact name from agent_list_tools'),
        removeTools: z.array(z.string()).optional().describe('Tools to take away, by name'),
        triggers: z
          .array(
            z.object({
              op: z.enum(['add', 'update', 'remove']),
              id: z
                .string()
                .optional()
                .describe('The trigger to update or remove, from agent_get (not used by add)'),
              draft: z
                .unknown()
                .optional()
                .describe(
                  'The trigger draft, for add and for an update that changes what fires. An ' +
                    "update keeps the trigger's kind — a draft of a different kind is a " +
                    'different trigger, so remove it and add the new one instead. ' +
                    TRIGGER_DRAFT_GRAMMAR
                ),
              enabled: z
                .boolean()
                .optional()
                .describe(
                  "This TRIGGER's own on/off state (not the agent's) — on for a new trigger, " +
                    'unchanged on an update that omits it'
                ),
            })
          )
          .min(1)
          .optional()
          .describe(
            'Trigger changes, applied in order and all-or-nothing: {op:"add", draft, ' +
              'enabled?}, {op:"update", id, draft?, enabled?} or {op:"remove", id}. Triggers ' +
              'you do not name are untouched.'
          ),
        llmModelId: z
          .string()
          .nullable()
          .optional()
          .describe('Model config id; null to fall back to the org default'),
        guardrails: z
          .string()
          .max(1_000_000)
          .nullable()
          .optional()
          .describe(
            'Standing rules injected into every model call of every run; null or "" to drop them'
          ),
        canAskQuestions: z
          .boolean()
          .optional()
          .describe('Whether the agent may pause and ask you a question (ask_person)'),
        autoAcceptActions: z
          .boolean()
          .optional()
          .describe(
            "Whether its staged changes are accepted without a person where the org's policy " +
              'allows (never for the fixed high-risk tools)'
          ),
        keepEnabled: z
          .boolean()
          .optional()
          .describe('Keep an ALREADY-ENABLED agent enabled through this change (default true)'),
        confirm: z
          .boolean()
          .optional()
          .describe('Without true: validate and report only, persist nothing'),
      }),
    },
    async (args: Record<string, unknown>) => {
      if (!context.subject) return errText(NO_SUBJECT);
      if (context.agent) return errText(RUN_REFUSAL);
      if (args.enabled === true) {
        return errText(
          'Enabling an agent is done in the builder after review. This tool can change or ' +
            'disable, and keeps an already-enabled agent on unless keepEnabled:false.'
        );
      }
      const dbResult = getDatabase();
      if (!dbResult.ok) return errText('Database unavailable.');
      const access = await agentAccessFor(dbResult.val, context, args.agentId);
      if (!access) return errText(NOT_FOUND);
      const agent = access.agent;

      // Present means change it, absent means keep it: the whole point of
      // this tool is that what a caller does not mention is not touched.
      // `null` is a value here, not an omission — it clears the field.
      const given = (key: string) => key in args && args[key] !== undefined;
      const fields = [
        'name',
        'instructions',
        'addTools',
        'removeTools',
        'triggers',
        'guardrails',
        'canAskQuestions',
        'autoAcceptActions',
        'llmModelId',
      ];
      if (!fields.some(given) && args.keepEnabled === undefined) {
        return errText(`Nothing to change — send at least one of ${fields.join(', ')}.`);
      }

      const names = (value: unknown): string[] =>
        Array.isArray(value)
          ? value.filter((entry): entry is string => typeof entry === 'string')
          : [];
      const removed = new Set(names(args.removeTools).map((tool) => tool.trim()));
      const unknownRemovals = [...removed].filter((tool) => !agent.tools.includes(tool));
      if (unknownRemovals.length > 0) {
        return errText(
          `This agent does not have ${unknownRemovals.join(', ')} — its tools are: ` +
            `${agent.tools.join(', ') || 'none'}.`
        );
      }
      const tools = [
        ...agent.tools.filter((tool) => !removed.has(tool)),
        ...names(args.addTools)
          .map((tool) => tool.trim())
          .filter((tool) => tool && !agent.tools.includes(tool)),
      ];

      let triggers: TriggerPayload[] = agent.triggers.map((trigger) => ({
        id: trigger.id,
        draft: trigger.draft,
        enabled: trigger.enabled,
      }));
      if (given('triggers')) {
        const operations = toTriggerOperations(args.triggers);
        if ('error' in operations) return errText(operations.error);
        const patched = applyTriggerPatch(agent.triggers, operations.val);
        if (!patched.ok) return errText(patched.error);
        triggers = patched.triggers;
      }

      // enabled is never RAISED here, exactly as in agent_update.
      const enabled = agent.enabled && args.keepEnabled !== false;
      // Everything the caller left out is the agent as stored, and the whole
      // thing goes through the SAME parse and save path as a full update, so
      // validation is identical — a patch cannot reach a state agent_update
      // could not.
      const parsed = parseDefinition(
        {
          name: given('name') ? args.name : agent.name,
          instructions: given('instructions') ? args.instructions : agent.instructions,
          tools,
          triggers,
          llmModelId: given('llmModelId') ? args.llmModelId : agent.llmModelId,
          guardrails: given('guardrails') ? args.guardrails : agent.guardrails,
          canAskQuestions: given('canAskQuestions') ? args.canAskQuestions : agent.canAskQuestions,
          autoAcceptActions: given('autoAcceptActions')
            ? args.autoAcceptActions
            : agent.autoAcceptActions,
        },
        enabled
      );
      if ('error' in parsed) return errText(parsed.error);

      const changed = [
        ...(given('name') ? [`name → "${parsed.input.name}"`] : []),
        ...(given('instructions') ? ['instructions'] : []),
        ...(given('addTools') || given('removeTools') ? ['tools'] : []),
        ...(given('triggers') ? ['triggers'] : []),
        ...(given('guardrails') ? ['guardrails'] : []),
        ...(given('canAskQuestions') ? ['canAskQuestions'] : []),
        ...(given('autoAcceptActions') ? ['autoAcceptActions'] : []),
        ...(given('llmModelId') ? ['model'] : []),
        ...(agent.enabled && !enabled ? ['turned off'] : []),
      ].join(', ');

      const dryRun = args.confirm !== true;
      const result = await saveAgent(dbResult.val, context.subject, parsed, {
        agentId: agent.id,
        dryRun,
        ...(access.viewerIsOwner ? {} : { ownerSubject: access.ownerSubject }),
      });
      if (result.outcome === 'not-found') return errText(NOT_FOUND);
      if (result.outcome === 'invalid') return errText(issueLines(result.issues));
      const toolsChanged = given('addTools') || given('removeTools');
      if (result.outcome === 'valid-dry-run') {
        return textResult(
          [
            `Valid. This would change "${agent.name}": ${changed}.`,
            ...(given('instructions')
              ? ['', 'Instructions:', instructionsOf(result.normalized.instructions)]
              : []),
            ...(toolsChanged ? ['', 'Tools:', ...toolListLines(result.normalized.tools)] : []),
            ...triggerLines(triggers),
            ...(toolsChanged || given('autoAcceptActions')
              ? await hintLines(result.normalized)
              : []),
            '',
            `It stays ${enabled ? 'ENABLED' : 'disabled'}. Nothing was saved. Call again with confirm:true to apply.`,
          ].join('\n')
        );
      }

      logger.info('agent_patch changed an agent definition', {
        component: 'mcp/tool',
        agentId: result.agentId,
      });
      return textResult(
        [
          `Updated "${result.normalized.name}" (${enabled ? 'still enabled' : 'disabled'}): ${changed}.`,
          ...triggerLines(triggers),
          ...(toolsChanged || given('autoAcceptActions') ? await hintLines(result.normalized) : []),
          ...(result.apiKeys.length > 0
            ? [
                '',
                'API trigger keys (shown exactly once):',
                ...result.apiKeys.map((key) => `- trigger ${key.triggerId}: ${key.key}`),
              ]
            : []),
        ].join('\n')
      );
    }
  );

  server.registerTool(
    'agent_update',
    {
      title: 'Agents · Act — Update an agent (confirm-gated)',
      description:
        "REPLACE one of your agents' (or one shared with you) definition (name, instructions, " +
        'tools, triggers, guardrails, switches) — the whole-document path, for a REWRITE. ' +
        'FOR ANYTHING SHORT OF ONE, USE agent_patch, which changes only the fields you send. ' +
        'This tool requires echoing everything untouched back verbatim, and an omitted ' +
        'trigger is deleted with its firing history and its API key. ' +
        "If you do use this: start from the exact definition in agent_get's " +
        '```json renkei-agent block, change ONLY what the edit needs, and send the whole ' +
        'definition back. Keep the ids of triggers you are keeping VERBATIM (their firings ' +
        'and API keys anchor to them). Validation is deterministic and reports precise ' +
        'per-field issues. Without confirm:true this is a DRY RUN — it validates and shows ' +
        'what would change, persisting nothing. This tool never TURNS ON an agent (the ' +
        'builder is the consent surface for that): an off agent stays off, an already-enabled ' +
        'one stays on unless keepEnabled:false disables it. Prose-to-instructions drafting ' +
        'lives in the web builder.',
      annotations: { readOnlyHint: false },
      inputSchema: z.object({
        agentId: z.string().min(1).describe('From agent_list'),
        ...definitionSchema,
        keepEnabled: z
          .boolean()
          .optional()
          .describe('Keep an ALREADY-ENABLED agent enabled through this update (default true)'),
      }),
    },
    async (args: Record<string, unknown>) => {
      if (!context.subject) return errText(NO_SUBJECT);
      if (context.agent) return errText(RUN_REFUSAL);
      if ('enabled' in args && args.enabled === true) {
        return errText(
          'Enabling an agent is done in the builder after review. This tool can update or ' +
            'disable, and keeps an already-enabled agent on unless keepEnabled:false.'
        );
      }
      const dbResult = getDatabase();
      if (!dbResult.ok) return errText('Database unavailable.');
      const access = await agentAccessFor(dbResult.val, context, args.agentId);
      if (!access) return errText(NOT_FOUND);
      const agent = access.agent;

      // enabled is never RAISED here: an off agent stays off; an on agent
      // stays on (the owner armed it knowingly) unless keepEnabled:false.
      const enabled = agent.enabled && args.keepEnabled !== false;
      const parsed = parseDefinition(args, enabled);
      if ('error' in parsed) return errText(parsed.error);

      const dryRun = args.confirm !== true;
      const result = await saveAgent(dbResult.val, context.subject, parsed, {
        agentId: agent.id,
        dryRun,
        ...(access.viewerIsOwner ? {} : { ownerSubject: access.ownerSubject }),
      });
      if (result.outcome === 'not-found') return errText(NOT_FOUND);
      if (result.outcome === 'invalid') return errText(issueLines(result.issues));
      if (result.outcome === 'valid-dry-run') {
        return textResult(
          [
            `Valid. This would rewrite "${agent.name}" to:`,
            ...definitionLines(result.normalized),
            ...(await hintLines(result.normalized)),
            '',
            `It stays ${enabled ? 'ENABLED' : 'disabled'}. Nothing was saved. Call again with confirm:true to apply.`,
          ].join('\n')
        );
      }

      logger.info('agent_update rewrote an agent definition', {
        component: 'mcp/tool',
        agentId: result.agentId,
      });
      return textResult(
        [
          `Updated "${result.normalized.name}" (${enabled ? 'still enabled' : 'disabled'}).`,
          ...(await hintLines(result.normalized)),
          ...(result.apiKeys.length > 0
            ? [
                'API trigger keys (shown exactly once):',
                ...result.apiKeys.map((key) => `- trigger ${key.triggerId}: ${key.key}`),
              ]
            : []),
          ...(result.descriptionPending
            ? [
                'The summary and review notes are being rewritten; agent_get will show them shortly.',
              ]
            : []),
        ].join('\n')
      );
    }
  );
}
