/**
 * The agents-over-MCP tools — your agents as things chat and integrations
 * can read, inspect, and (with confirmation) change.
 *
 * The use cases that forced these: chaining ("what does my triage agent
 * save, so mine can use it?"), improvement ("show me the failed run, then
 * update the agent"), and curation (an agent writing reference notes onto
 * another agent it feeds). Reads render through the SAME renderers the web
 * UI uses — the reviewer's steps outline, the run-debug markdown, the
 * bounded knowledge/memory blocks runs themselves receive — so there is no
 * third description of an agent to drift.
 *
 * Ground rules, each load-bearing:
 *
 *  - Everything is OWNER-SCOPED: every lookup goes through the same
 *    subject-scoped queries the web routes use, so someone else's agentId
 *    reads as not-found, never as forbidden.
 *  - The DEFINITION-EDITING tools (agent_create, agent_update, and the
 *    agent_patch_* pair) REFUSE
 *    agent-run callers (`context.agent` set): a run must not rewrite its
 *    own steps or strip its guardrails — the cards ground rule, applied
 *    to behavior. Knowledge and memory tools stay available to runs:
 *    knowledge is reference data an agent legitimately curates
 *    (knowledge_create_note already exists); steps and guardrails are
 *    behavior definition, and that line is the point. The one memory
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
 *  - There is NO drafting tool here. Prose-to-steps drafting is the web
 *    builder's own REST path (/agents/draft + the worker job); model
 *    callers work at the definition level instead — agent_get hands them
 *    the exact JSON, agent_update validates their edit deterministically.
 *  - EDITS ARE PARTIAL BY DEFAULT: agent_update replaces the whole
 *    definition, which makes every untouched step and trigger a
 *    transcription risk, and an omitted trigger an outright delete.
 *    agent_patch_steps (steps, by id) and agent_patch (name, one trigger by
 *    id, guardrails, blocked skills, model) change what they name and
 *    nothing else, through the same parse-and-save path — so a patch can
 *    never reach a state a full update could not.
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/server';
import { getDatabase, type DB } from '@renkei/db';
import type { Kysely } from 'kysely';
import {
  APPROVAL_DEFAULT_TIMEOUT_HOURS,
  MAX_APPROVAL_FIELDS,
  BUILTIN_VARIABLES,
  CURRENT_STEPS_VERSION,
  DEFAULT_APPROVAL_WAIT_CAP_HOURS,
  MAX_BRANCH_DEPTH_V3,
  MAX_BRANCH_PATHS,
  MAX_LOOP_ITERATIONS,
  MAX_SCHEDULE_RULES,
  MAX_STEPS,
  MAX_STEP_ATTEMPTS,
  TRIGGER_EVENT_CATALOG,
  friendlyToolName,
  savesByPathCoverage,
  type AgentStepsDoc,
} from '@renkei/agents';
import { countAgentMemory, forgetAgentMemory, readAgentMemory } from '@renkei/agents/memory';
import { sql } from 'kysely';
import type { MCPToolContext } from '../common';
import { getAgent, listAgents, type StoredAgent, type TriggerPayload } from '@/lib/agents/store';
import { saveAgent } from '@/lib/agents/save';
import { applyStepPatch, toPatchOperations } from '@/lib/agents/patch-steps';
import { applyTriggerPatch, toTriggerOperations } from '@/lib/agents/patch-triggers';
import { parseAgentPayload } from '@/lib/agents/payload';
import { renderStepsOutline } from '@/lib/agents/describe';
import { triggerSummary } from '@/lib/agents/trigger-summary';
import { listRunsForOwner, getRunForOwner } from '@/lib/agents/runs-view';
import { renderRunDebugMarkdown } from '@/lib/agents/run-debug';
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
  decideApproval,
  listPendingApprovals,
  MAX_APPROVAL_ANSWER_CHARS,
  type PendingApproval,
} from '@/lib/agents/approvals';
import type { ApprovalField } from '@renkei/agents';
import { listAvailableTools, type ToolDescriptor } from '@/lib/mcp-tools/tool-catalog';
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

/** "1 entry" / "3 entries" — memory counts appear in three sentences. */
function entryCount(count: number): string {
  return `${count} ${count === 1 ? 'entry' : 'entries'}`;
}

const NO_SUBJECT = 'This caller has no recorded identity, so it has no agents.';
const NOT_FOUND = 'No agent of yours has that id.';
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

/** The caller's agent, owner-scoped: someone else's id reads as null. */
async function ownAgent(
  db: Kysely<DB>,
  context: MCPToolContext,
  agentId: unknown
): Promise<StoredAgent | null> {
  const id = typeof agentId === 'string' ? agentId.trim() : '';
  if (!id || !context.subject) return null;
  return getAgent(db, context.tenantId, context.subject, id);
}

function outlineOf(steps: AgentStepsDoc): string {
  const outline = renderStepsOutline(steps);
  return outline.trim() ? outline : '(no steps yet)';
}

/**
 * What an agent's steps bind, with whether each name always materializes,
 * plus the builtins every step can reference regardless.
 *
 * The builtins are listed because an author working over MCP has no
 * autocomplete to discover them from — the builder's insert menu is the
 * only other place they appear, and a chip nobody knows about is a chip
 * nobody writes.
 */
function variableLines(steps: AgentStepsDoc): string[] {
  const coverage = savesByPathCoverage(steps.steps);
  return [
    'Variables always available (var chips):',
    ...BUILTIN_VARIABLES.map((variable) => `- ${variable.name}: ${variable.description}`),
    ...(coverage.size > 0
      ? [
          'Variables this agent saves (chainable):',
          ...[...coverage.entries()].map(
            ([name, kind]) =>
              `- ${name} (${kind === 'always' ? 'always set on success' : 'conditional — only some routes set it'})`
          ),
        ]
      : []),
  ];
}

/**
 * One waiting approval, with everything a decision needs in the lines that
 * announce it: what is being asked, which run it holds up, whether a
 * verdict is enough or an answer is wanted, and how long is left.
 */
function approvalLines(approval: PendingApproval, now: number): string[] {
  const deadline = approval.waitingUntil ? new Date(approval.waitingUntil).getTime() : null;
  const hoursLeft = deadline === null ? null : Math.round((deadline - now) / 3_600_000);
  const remaining =
    hoursLeft === null
      ? ''
      : hoursLeft <= 0
        ? ' — the wait has run out; the run takes its timed-out path next'
        : ` — ${hoursLeft}h left before it times out`;
  return [
    `- ${approval.title}`,
    `  cardId: ${approval.cardId} · agent "${approval.agentName}" (${approval.agentId}) · run ${approval.runId}`,
    `  ${
      approval.fields.length > 0
        ? 'Wants a FORM filled in — decide with `answers`, keyed by the field names below'
        : approval.mode === 'input'
          ? 'Wants a typed ANSWER — decide with `answer`, or decline to say you have none'
          : 'Wants approve or decline'
    }` + ` · raised ${approval.raisedAt}${remaining}`,
    ...(approval.message ? [`  ${approval.message.replace(/\n/g, '\n  ')}`] : []),
    // The form itself, because a caller cannot see the card: without the
    // types and the option lists, answering it is guesswork the checker
    // then rejects.
    ...approval.fields.map((field) => `  · ${describeApprovalField(field)}`),
  ];
}

/** One field as one line: what it wants, and what it will accept. */
function describeApprovalField(field: ApprovalField): string {
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
 * What an agent can do that no skill accounts for.
 *
 * The engine provides these as step KINDS, so they are invisible to a
 * catalog built from registered tools — and a model that reads the catalog
 * as "everything this agent could do" concludes an agent cannot pause for a
 * person, because nothing named `*_ask_approval` came back. It then writes a
 * step that says "check with the owner first" and acts anyway.
 */
const NATIVE_CAPABILITIES = [
  'These are step KINDS, not skills, so no name above covers them:',
  '- PAUSE FOR A PERSON — a {kind:"approval"} step parks the run as "waiting" and puts an ' +
    "interactive card on the owner's home-page feed, then resumes down whichever of its " +
    'three outcome paths applies. This is how an agent gets a human decision; there is no ' +
    'skill for it. Use it for "ask me before sending", "let me approve this", "check with ' +
    'me first". agent_approvals_list shows the ones waiting on you right now, and ' +
    'agent_approval_decide answers one.',
  '  The card asks in one of two ways. mode:"approve" is a VERDICT on something already ' +
    'decided — approve or decline. mode:"input" ASKS FOR INFORMATION the agent could not ' +
    'work out for itself, and it does not have to be prose: give it `fields` and the card ' +
    'renders a FORM — a number, a date, one of a list of choices, several of them, short or ' +
    'long text — each binding its own variable for later steps, and each checked before the ' +
    'run continues. Reach for fields whenever the answer has a shape ("which issue?", "how ' +
    'many points?", "which of these to post?"): a plain box makes the next step parse a ' +
    'string that may be anything, while a form cannot come back as anything else. A field ' +
    'may also carry the destination\'s own id (`key`, e.g. "customfield_10016"), which ' +
    'travels with the answer so the step that writes it has both halves.',
  '- END THE RUN AND SAY SO — a {kind:"terminal"} step ends the whole run as a success, a ' +
    'deliberate failure, or a graceful skip, and emails or WebEx-messages the owner the ' +
    'message it carries.',
  '- DECIDE, REPEAT, GROUP — {kind:"branch"}, {kind:"loop"} and {kind:"group"} nodes.',
  'The full shape of each is on the "steps" argument of agent_create and agent_update.',
].join('\n');

/**
 * How many tools one call spells out in full before it stops and says how
 * many more matched. A cap, not a page: the answer to "there are 90 of
 * these" is a narrower filter, not a second call.
 */
const TOOLS_DETAILED = 60;

/**
 * One tool, as an author choosing between them needs to read it.
 *
 * The FULL description, deliberately, and the failure codes with it — the
 * same two things the web builder's drafting prompt puts in front of the
 * model that writes steps. A clipped description is how a step gets drafted
 * against a tool whose requirements (an input it needs, a bulk variant to
 * prefer) lived in the part nobody read, and the failure codes are the
 * vocabulary `failureHandling` is keyed by, so a step cannot handle a
 * condition it was never told about.
 */
function toolLine(tool: ToolDescriptor): string {
  const description = (tool.description ?? '').replace(/\s+/g, ' ').trim();
  return (
    `- ${tool.name} (${friendlyToolName(tool.name, tool.title)}) [${tool.kind}]` +
    `${description ? ` — ${description}` : ''}` +
    ` | failure codes: ${tool.outcomes.failures.map((failure) => failure.code).join(', ')}`
  );
}

export function registerAgentTools(server: McpServer, context: MCPToolContext): void {
  server.registerTool(
    'agent_list',
    {
      title: 'Agents · Read — List your agents',
      description:
        'Your Renkei agents: id, name, on/off, what each does, and when it runs. Start here ' +
        'to find an agentId for the other agent tools.',
      annotations: { readOnlyHint: true },
      inputSchema: z.object({}),
    },
    async () => {
      if (!context.subject) return errText(NO_SUBJECT);
      const dbResult = getDatabase();
      if (!dbResult.ok) return errText('Database unavailable.');

      const agents = await listAgents(dbResult.val, context.tenantId, context.subject);
      if (agents.length === 0) return textResult('You have no agents yet.');
      const lines = [`${agents.length} agent(s):`];
      for (const agent of agents) {
        const triggers = agent.triggers.map((trigger) => triggerSummary(trigger.draft)).join('; ');
        lines.push(
          '',
          `- ${agent.name} — ${agent.enabled ? 'ON' : 'off'}${agent.guardrails ? ' · has guardrails' : ''}`,
          `  agentId: ${agent.id}`,
          ...(agent.description ? [`  ${agent.description}`] : []),
          `  runs: ${triggers || 'no triggers (manual only)'}`
        );
      }
      return textResult(lines.join('\n'));
    }
  );

  server.registerTool(
    'agent_get',
    {
      title: 'Agents · Read — The exact definition, as JSON',
      description:
        "One of your agents' EXACT stored definition, as raw JSON — the machine path. " +
        'To change a STEP, take its id from here and use agent_patch_steps: it inserts, ' +
        'replaces, removes or moves one step at a time and leaves the rest untouched. ' +
        'To change the NAME, a TRIGGER, the guardrails, the blocked skills or the model, ' +
        'take the trigger ids from here and use agent_patch: it changes only the fields ' +
        'you send. Reach for agent_update — which replaces the whole definition, ids and ' +
        'all — only for a rewrite. For the human-readable rendering (outline, knowledge, ' +
        'memory, chaining), use agent_get_description.',
      annotations: { readOnlyHint: true },
      inputSchema: z.object({
        agentId: z.string().min(1).describe('From agent_list'),
      }),
    },
    async (args: Record<string, unknown>) => {
      if (!context.subject) return errText(NO_SUBJECT);
      const dbResult = getDatabase();
      if (!dbResult.ok) return errText('Database unavailable.');
      const agent = await ownAgent(dbResult.val, context, args.agentId);
      if (!agent) return errText(NOT_FOUND);

      // Raw JSON, nothing else: agentId/enabled are read-only context (the
      // save path ignores them); every other key is exactly what
      // agent_update takes.
      return textResult(
        JSON.stringify(
          {
            agentId: agent.id,
            enabled: agent.enabled,
            ...agentDefinition({
              name: agent.name,
              description: agent.description,
              steps: agent.steps,
              triggers: agent.triggers,
              guardrails: agent.guardrails,
              blockedTools: agent.blockedTools,
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
        'The human-readable rendering of one of your agents: the steps outline, guardrails, ' +
        'blocked skills, the variables it saves (for chaining), triggers, and agents ' +
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
      const agent = await ownAgent(db, context, args.agentId);
      if (!agent) return errText(NOT_FOUND);

      // Agents chained AFTER this one — the caller's own only, matching the
      // finalize query that actually fires them.
      const chained = await db
        .selectFrom('agent_triggers as t')
        .innerJoin('agents as a', 'a.id', 't.agent_id')
        .select(['a.id', 'a.name'])
        .where('t.tenant_id', '=', context.tenantId)
        .where('t.kind', '=', 'agent')
        .where('t.enabled', '=', true)
        .where(sql<string>`t.config->>'callerAgentId'`, '=', agent.id)
        .where('a.owner_subject', '=', context.subject)
        .execute();

      const lines = [
        `${agent.name} — ${agent.enabled ? 'ON' : 'off'} (agentId: ${agent.id})`,
        ...(agent.description ? ['', agent.description] : []),
        '',
        'Steps:',
        outlineOf(agent.steps),
        ...(agent.guardrails ? ['', 'Standing guardrails:', agent.guardrails] : []),
        ...(agent.blockedTools.length > 0
          ? ['', `Blocked skills (the engine refuses these): ${agent.blockedTools.join(', ')}`]
          : []),
        '',
        ...variableLines(agent.steps),
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
        'Every skill your agents can be given a step for — the vocabulary agent_create, ' +
        'agent_update and agent_patch_steps accept in a step\'s "tool", and the failure ' +
        'codes its "failureHandling" is keyed by. READ THIS BEFORE WRITING STEPS: the ' +
        'builder shows an author this catalog in a picker, and a caller working over MCP ' +
        'has nowhere else to find it — a step naming a tool that does not exist here is ' +
        'refused by validation, and a tool nobody knows about is a step nobody writes. ' +
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
          .describe('"read" gathers information; "act" changes something in a system'),
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
      // offer a tool a step would then be refused for naming.
      const all = (await listAvailableTools(context.tenantId, context.subject)).filter(
        // Preview-card buttons: the model never sees them, so an author must
        // not be told to write a step for one.
        (tool) => !tool.appOnly
      );
      if (all.length === 0) {
        return textResult(
          [
            'No skills are available to you — this organization has no connectors enabled, ' +
              'or none that you have authorized. Connect one in the web app, then ask again.',
            '',
            NATIVE_CAPABILITIES,
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
      // step has to get exactly right, and the full descriptions for 300
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
            'Pass connector, kind or query to read what each one does and the failure codes ' +
              'its steps can handle.',
            '',
            NATIVE_CAPABILITIES,
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
      title: 'Agents · Read — Approvals waiting on you',
      description:
        'The approval cards your agents are PAUSED on, waiting for you to decide — oldest ' +
        'first, because the oldest is the one about to time out. An agent that reaches an ' +
        'approval step parks its whole run as "waiting" and raises one of these; until ' +
        'somebody answers, that run does nothing and the work behind it does not happen. ' +
        'Each entry carries the cardId agent_approval_decide takes, what is being asked, ' +
        'which run it holds up, whether a verdict is enough or a typed answer is wanted, and ' +
        'how long is left before the wait runs out and the run takes its timed-out path.',
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

      const approvals = await listPendingApprovals(
        dbResult.val,
        context.tenantId,
        context.subject,
        {
          agentId: typeof args.agentId === 'string' ? args.agentId : undefined,
          limit: typeof args.limit === 'number' ? args.limit : undefined,
        }
      );
      if (approvals.length === 0) {
        return textResult(
          'Nothing is waiting on you — none of your agents is paused for a decision.'
        );
      }

      const now = Date.now();
      return textResult(
        [
          `${approvals.length} approval(s) waiting on you, longest-waiting first:`,
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
      title: 'Agents · Act — Approve or decline a paused run',
      description:
        'Answer one of the approval cards from agent_approvals_list: approve it, or decline ' +
        'it. The run resumes down whichever outcome path applies — approved, declined, or ' +
        '(if nobody answers in time) timed out. A declined approval does NOT fail the run by ' +
        'itself; it takes the path its author wrote for that answer. When the card wants a ' +
        'typed answer ("input" mode), pass `answer` — it binds to the variable the step ' +
        'named, and everything after can use it. ' +
        "This is a REAL DECISION on the owner's behalf, taken immediately and not " +
        'reversible from here — an approval step exists because a person was meant to weigh ' +
        'in, so confirm with them before deciding for them. AGENT RUNS CANNOT CALL THIS: an ' +
        'agent approving its own pause is the whole point of the pause, undone.',
      annotations: { readOnlyHint: false },
      inputSchema: z.object({
        cardId: z.string().min(1).describe('From agent_approvals_list'),
        decision: z
          .enum(['approve', 'decline'])
          .describe('"approve" takes the approved path; "decline" takes the declined path'),
        answer: z
          .string()
          .max(MAX_APPROVAL_ANSWER_CHARS)
          .optional()
          .describe(
            'The typed answer, for a card in "input" mode — it binds to the step\'s saveAs ' +
              'name for everything after it'
          ),
        answers: z
          .record(z.string(), z.union([z.string(), z.array(z.string())]))
          .optional()
          .describe(
            'For a card that asks with a FORM: {"<field name>": value} — the names ' +
              'agent_approvals_list prints, one entry each. A multi-select takes an array. ' +
              'Checked against the form before anything is recorded — a number that is not a ' +
              'number, or a choice that is not on offer, comes back as an error, not as a ' +
              'bad answer'
          ),
      }),
    },
    async (args: Record<string, unknown>) => {
      if (!context.subject) return errText(NO_SUBJECT);
      // The cards ground rule, at its sharpest: the pause exists so a PERSON
      // decides. A run that could answer its own approval — or another
      // agent's — would make every approval step decorative.
      if (context.agent) {
        return errText(
          'Agent runs cannot decide approvals — that is the one thing an approval step ' +
            'exists to prevent. A person answers this, in the Renkei feed or through their ' +
            'own MCP client.'
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
        context.tenantId,
        context.subject,
        {
          cardId: typeof args.cardId === 'string' ? args.cardId.trim() : '',
          decision,
          answer: typeof args.answer === 'string' ? args.answer : undefined,
          answers: args.answers,
        }
      );

      switch (result.outcome) {
        case 'invalid-answers':
          return errText(
            [
              'That card asks with a form, and these answers do not fit it:',
              ...result.issues.map((issue) => `- ${issue.label}: ${issue.message}`),
              'agent_approvals_list prints the form — the fields, their types, and what each accepts.',
            ].join('\n')
          );
        case 'answer-too-long':
          return errText(`The answer must stay under ${result.max} characters.`);
        case 'not-found':
          return errText(
            'No approval of yours has that cardId. Approvals are owner-scoped — ' +
              'agent_approvals_list shows the ones you can decide.'
          );
        case 'not-approval':
          return errText(
            'That card is not an approval. Informational cards are dismissed with ' +
              'card_dismiss; only a paused run raises a decision.'
          );
        case 'already-decided':
          // Someone (or the timeout sweep) got there first. Saying so beats
          // overwriting a decision that already stands.
          return errText(
            `That approval is already ${result.status} — it was decided elsewhere, or the ` +
              'wait ran out and the run took its timed-out path.'
          );
        case 'decided': {
          logger.info('agent_approval_decide answered a paused run', {
            component: 'mcp/tool',
            tenantId: context.tenantId,
            runId: result.runId,
            decision: result.decision,
          });
          return textResult(
            [
              `${result.decision === 'approve' ? 'Approved' : 'Declined'}. Run ${result.runId} ` +
                `takes its ${result.decision === 'approve' ? 'approved' : 'declined'} path.`,
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
    'agent_runs_list',
    {
      title: 'Agents · Read — Recent runs of an agent',
      description:
        "One of your agents' recent runs: status (including 'waiting' for approval pauses), " +
        'what failed and where, trigger, timing. Use agent_run_get on a runId for the full story.',
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
      const agent = await ownAgent(dbResult.val, context, args.agentId);
      if (!agent) return errText(NOT_FOUND);

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
      const runs = await listRunsForOwner(
        dbResult.val,
        context.tenantId,
        context.subject,
        agent.id,
        { status, limit }
      );
      if (runs.length === 0) return textResult('No runs match.');

      // "waiting" on its own says a run is stuck without saying on WHAT, and
      // the answer is a decision this caller can make right here.
      const waiting = runs.some((run) => run.status === 'waiting')
        ? await listPendingApprovals(dbResult.val, context.tenantId, context.subject, {
            agentId: agent.id,
            limit: 50,
          })
        : [];
      const byRun = new Map(waiting.map((approval) => [approval.runId, approval]));
      const now = Date.now();

      const lines = [`${runs.length} run(s) of "${agent.name}", newest first:`];
      for (const run of runs) {
        const duration = run.durationMs !== null ? ` · ${Math.round(run.durationMs / 1000)}s` : '';
        const approval = byRun.get(run.id);
        lines.push(
          '',
          `- ${run.status} · via ${run.triggerKind} · ${run.createdAt}${duration}`,
          `  runId: ${run.id}`,
          ...(approval
            ? ['  Waiting on you:', ...approvalLines(approval, now).map((line) => `  ${line}`)]
            : []),
          ...(run.error
            ? [
                `  ${run.errorKind ?? 'error'}${run.failedStepName ? ` at "${run.failedStepName}"` : ''}: ${run.error}`,
              ]
            : [])
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
        'The full debugging view of one run of YOUR agent — snapshot outline, timeline, every ' +
        'attempt with its tool calls. The same markdown the run page\'s "Copy for debugging" ' +
        'button produces, designed to be handed to a model.',
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

      // Resolve the agent from the run row (owner-scoped), then reuse the
      // owner-audience detail read.
      const runRow = await db
        .selectFrom('agent_runs')
        .select(['agent_id'])
        .where('id', '=', runId)
        .where('tenant_id', '=', context.tenantId)
        .where('owner_subject', '=', context.subject)
        .executeTakeFirst();
      if (!runRow) return errText('No run of yours has that id.');
      const agent = await ownAgent(db, context, runRow.agent_id);
      if (!agent) return errText('No run of yours has that id.');
      const run = await getRunForOwner(db, context.tenantId, context.subject, agent.id, runId);
      if (!run) return errText('No run of yours has that id.');

      // A parked run's timeline ends mid-air without this: the last thing it
      // did was raise a card, and the card is what happens next.
      const approval =
        run.status === 'waiting'
          ? (
              await listPendingApprovals(db, context.tenantId, context.subject, {
                agentId: agent.id,
                limit: 50,
              })
            ).find((pending) => pending.runId === runId)
          : undefined;

      return textResult(
        [
          renderRunDebugMarkdown(agent.name, run),
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
    'agent_memory_list',
    {
      title: "Agents · Read — An agent's memory",
      description:
        "One of your agents' memory in full: the rolling summary and the newest entries the " +
        'engine recorded across runs. agent_get shows the bounded slice runs receive; this is ' +
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
      const agent = await ownAgent(dbResult.val, context, args.agentId);
      if (!agent) return errText(NOT_FOUND);

      const memory = await readAgentMemory(dbResult.val, context.tenantId, agent.id, {
        maxEntries: 100,
      });
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
        'Delete what one of your agents remembers: named entries (entryIds from ' +
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
      const agent = await ownAgent(db, context, args.agentId);
      if (!agent) return errText(NOT_FOUND);

      if (all) {
        const held = await countAgentMemory(db, context.tenantId, agent.id);
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
        const result = await forgetAgentMemory(db, context.tenantId, agent.id, { kind: 'all' });
        // Memory does not come back, so the wipe leaves a trace somewhere.
        logger.info('agent_memory_forget cleared an agent memory', {
          component: 'mcp/tool',
          tenantId: context.tenantId,
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
        const result = await forgetAgentMemory(db, context.tenantId, agent.id, {
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
        const result = await forgetAgentMemory(db, context.tenantId, agent.id, {
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
        "One of your agents' knowledge notes in full — the reference material its runs carry " +
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
      const agent = await ownAgent(dbResult.val, context, args.agentId);
      if (!agent) return errText(NOT_FOUND);

      const notes = await listAgentNotes(dbResult.val, context.tenantId, agent.id);
      if (notes.length === 0) return textResult(`"${agent.name}" has no knowledge notes.`);
      const lines = [`${notes.length} note(s) on "${agent.name}":`];
      for (const note of notes) {
        lines.push(
          '',
          `## ${note.title} (noteId: ${note.noteId}, by ${note.authoredBy})`,
          note.content
        );
      }
      return textResult(lines.join('\n'));
    }
  );

  server.registerTool(
    'agent_knowledge_write',
    {
      title: 'Agents · Act — Add knowledge notes to an agent',
      description:
        'Write one or MORE knowledge notes onto one of your agents — reference material its ' +
        'runs will carry (policies, formats, standing facts). Each note is persisted ' +
        'independently: one bad entry does not void the rest.',
      annotations: { readOnlyHint: false },
      inputSchema: z.object({
        agentId: z.string().min(1).describe('From agent_list'),
        notes: z
          .array(
            z.object({
              title: z.string().min(1).max(MAX_AGENT_NOTE_TITLE_CHARS),
              content: z.string().min(1).max(MAX_AGENT_NOTE_CHARS),
            })
          )
          .min(1)
          .max(20)
          .describe('The notes to add — several at once is the point'),
      }),
    },
    async (args: Record<string, unknown>) => {
      if (!context.subject) return errText(NO_SUBJECT);
      const ownerEmail = context.userEmail;
      if (!ownerEmail) {
        return errText('This caller has no recorded email, which knowledge notes require.');
      }
      const dbResult = getDatabase();
      if (!dbResult.ok) return errText('Database unavailable.');
      const agent = await ownAgent(dbResult.val, context, args.agentId);
      if (!agent) return errText(NOT_FOUND);
      const notes = Array.isArray(args.notes) ? args.notes : [];
      if (notes.length === 0) return errText('Pass at least one note.');

      const lines: string[] = [];
      let failures = 0;
      for (const entry of notes) {
        const note: { title?: unknown; content?: unknown } =
          typeof entry === 'object' && entry !== null ? entry : {};
        const title = typeof note.title === 'string' ? note.title.trim() : '';
        const content = typeof note.content === 'string' ? note.content : '';
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
          tenantId: context.tenantId,
          agentId: agent.id,
          ownerEmail,
          title,
          content,
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
        "Replace a note's title and/or content on one of your agents. Omitted fields keep " +
        'their current value; the stored note is fully rewritten with the result.',
      annotations: { readOnlyHint: false },
      inputSchema: z.object({
        agentId: z.string().min(1).describe('From agent_list'),
        noteId: z.string().min(1).describe('From agent_knowledge_list'),
        title: z.string().min(1).max(MAX_AGENT_NOTE_TITLE_CHARS).optional(),
        content: z.string().min(1).max(MAX_AGENT_NOTE_CHARS).optional(),
      }),
    },
    async (args: Record<string, unknown>) => {
      if (!context.subject) return errText(NO_SUBJECT);
      const ownerEmail = context.userEmail;
      if (!ownerEmail) {
        return errText('This caller has no recorded email, which knowledge notes require.');
      }
      const noteId = typeof args.noteId === 'string' ? args.noteId.trim() : '';
      const title = typeof args.title === 'string' ? args.title.trim() : undefined;
      const content = typeof args.content === 'string' ? args.content : undefined;
      if (!noteId) return errText('noteId is required.');
      if (title === undefined && content === undefined) {
        return errText('Nothing to update — pass a new title and/or content.');
      }
      const dbResult = getDatabase();
      if (!dbResult.ok) return errText('Database unavailable.');
      const agent = await ownAgent(dbResult.val, context, args.agentId);
      if (!agent) return errText(NOT_FOUND);

      // Full-replacement semantics underneath (same as the web panel): an
      // omitted half is carried over from the stored note.
      const current = (await listAgentNotes(dbResult.val, context.tenantId, agent.id)).find(
        (note) => note.noteId === noteId
      );
      if (!current) return errText(noteErrorText.NOT_FOUND);

      const result = await updateAgentNote(dbResult.val, {
        tenantId: context.tenantId,
        agentId: agent.id,
        ownerEmail,
        noteId,
        title: title ?? current.title,
        content: content ?? current.content,
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
        'Delete one or more knowledge notes from one of your agents. Each note is removed ' +
        'independently: one bad id does not void the rest.',
      annotations: { readOnlyHint: false },
      inputSchema: z.object({
        agentId: z.string().min(1).describe('From agent_list'),
        noteIds: z.array(z.string().min(1)).min(1).max(50).describe('From agent_knowledge_list'),
      }),
    },
    async (args: Record<string, unknown>) => {
      if (!context.subject) return errText(NO_SUBJECT);
      const ownerEmail = context.userEmail;
      if (!ownerEmail) {
        return errText('This caller has no recorded email, which knowledge notes require.');
      }
      const dbResult = getDatabase();
      if (!dbResult.ok) return errText('Database unavailable.');
      const agent = await ownAgent(dbResult.val, context, args.agentId);
      if (!agent) return errText(NOT_FOUND);
      const noteIds = Array.isArray(args.noteIds)
        ? args.noteIds.filter((id): id is string => typeof id === 'string' && id.length > 0)
        : [];
      if (noteIds.length === 0) return errText('Pass at least one noteId.');

      const lines: string[] = [];
      let failures = 0;
      for (const noteId of noteIds) {
        const result = await deleteAgentNote(dbResult.val, {
          tenantId: context.tenantId,
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
   * The step-node grammar, written out for the same reason the trigger one
   * is: `steps` crosses the wire as an opaque object, and the builder — a
   * UI with a node palette — is the only other place the vocabulary
   * appears. A caller here cannot read a palette.
   *
   * The APPROVAL node is the load-bearing entry. It is a Renkei capability
   * with NO TOOL BEHIND IT: agent_list_tools cannot mention it, because
   * pausing a run and raising a card on someone's home page is something
   * the engine does, not something a connector exposes. So a model asked to
   * "have it check with me first" had no way to know the construct existed,
   * and wrote a step that says "ask the owner" and then acts anyway.
   *
   * Caps come from the constants they enforce, so this cannot name a limit
   * the validator does not.
   */
  const STEP_NODE_GRAMMAR = [
    'Every node has a uuid "id" and a "name". A node is one of:',
    'An ACTION step (NO "kind" key) — the default: {id, name, instruction:[segment,...],',
    'tool:<a skill name from agent_list_tools, or null for a pure reasoning step>,',
    `maxAttempts:1-${MAX_STEP_ATTEMPTS}, saveAs?:<short name later steps reference as a var>,`,
    'failureHandling:[{outcome:<a failure code of THAT skill, from agent_list_tools, or',
    '"other">, action:"retry"|"exit"|"stop-quiet"|"continue", guidance?:[segment,...]}],',
    'onSuccess?:"continue"|"stop"|"stop-quiet"}. At most one tool per step.',
    '{kind:"approval"} — PAUSE THE RUN AND ASK A PERSON. This is how an agent gets a human',
    'decision, and there is no tool for it: reaching the node parks the whole run as',
    '"waiting" and puts an interactive CARD on the owner\'s home-page feed for them to',
    'approve or decline (or type an answer). REACH FOR THIS whenever the automation should',
    'not act without a person saying so — "ask me before sending", "let me approve the',
    'refund", "check with me first". {id, name, message:[segment,...] (the card body AND the',
    'notification), mode:"approve" (approve/decline buttons) or "input" (asks for an answer),',
    'saveAs? (REQUIRED in "input" mode unless fields is given — it binds the typed answer),',
    'fields? (input mode WITH STRUCTURE: a form of up to',
    `${MAX_APPROVAL_FIELDS} controls, each {name:<the variable it binds, and the key its`,
    'answer comes back under>, label:<what the person is asked>,',
    'type:"text"|"longtext"|"number"|"date"|"choice"|"multi", required:true|false,',
    'options?:[...] (choice/multi, at least two), min?/max? (number), help?,',
    'key?:<what the DESTINATION calls this field, e.g. "customfield_10016" — opaque here,',
    'carried so the step that writes the answer has the id and the value together>}.',
    'USE FIELDS when the answer has a shape the agent would otherwise have to parse —',
    'a number, a date, one of a known set — because the card refuses anything that does not',
    'fit, so no step has to. Each field binds its own variable and a "multi" also binds a',
    'LIST a foreach loop can iterate. A step may have saveAs OR fields, never both),',
    'timeoutHours (how long it may wait; default',
    `${APPROVAL_DEFAULT_TIMEOUT_HOURS}, clamped by the org's cap, never more than`,
    `${DEFAULT_APPROVAL_WAIT_CAP_HOURS}), notifyEmail, notifyWebex (send the card link to the`,
    'owner), and three outcome paths onApproved, onDeclined and onTimeout, each',
    '{id, name, steps:[node,...]} — an EMPTY path just continues after the node, and a',
    'timeout never fails the run by itself.}',
    '{kind:"branch"} — a fork the model decides: {id, name, condition:[segment,...] (prose and',
    'var segments only, NEVER tool segments — do the tool work in a step before the branch and',
    `save it), paths:[2-${MAX_BRANCH_PATHS} × {id, name, steps:[...]}] where the LAST path is`,
    'the fallback, failurePath?:{id, name, steps} (taken when the EVALUATION itself runs out',
    `of attempts), maxAttempts}. Branches nest at most ${MAX_BRANCH_DEPTH_V3} deep, and an`,
    'approval counts toward the same budget.',
    '{kind:"loop"} — repeat a body: mode:"foreach" with itemsVar (a saved list) and itemVar',
    '(the per-round binding), or mode:"until" with condition:[segment,...] checked AFTER each',
    `round. Both take maxIterations:1-${MAX_LOOP_ITERATIONS} and steps:[...], and may set`,
    'collectFrom (a saveAs inside the body) plus collectVar (a new list of what it saved).',
    'Loops never nest in loops. Prefer ONE bulk skill call over a loop wherever one exists.',
    '{kind:"group"} — pure structure for readability: {id, name, steps:[...]}, executed as if',
    'inlined.',
    '{kind:"terminal"} — end the whole run here: {id, name, result:"success"|"failure"|"stop",',
    'message:[segment,...], notifyEmail, notifyWebex}.',
    'A segment is {t:"text", v:"..."}, {t:"var", name:"<a variable this agent has>"} or',
    '{t:"tool", name:"<a skill name>"}.',
  ].join(' ');

  /**
   * ONE worked node, and it is the approval-with-a-form.
   *
   * The grammar above is complete and dense, and the node it describes
   * least readably is the one with the most parts. What came back without
   * this was the shape a reader guesses from prose: fields as a bare list
   * of names, or options on a number, or a form that also sets saveAs. An
   * example costs a few hundred characters in a description that is read
   * once per session and copied from every time.
   */
  const FORM_EXAMPLE = [
    'Example of an input node that asks with a form:',
    JSON.stringify({
      id: '<uuid>',
      kind: 'approval',
      name: 'Where do these go?',
      message: [{ t: 'text', v: 'I found 7 decisions with no home. Which issue tracks them?' }],
      mode: 'input',
      fields: [
        {
          name: 'the issue key',
          label: 'Which issue tracks this?',
          type: 'text',
          required: true,
          help: 'e.g. CIO-12',
        },
        {
          name: 'the points',
          label: 'Story Points',
          type: 'number',
          required: false,
          min: 1,
          max: 13,
          key: 'customfield_10016',
        },
        {
          name: 'the comments',
          label: 'Which of these should I post?',
          type: 'multi',
          required: false,
          options: ['decision 1', 'risk 2', 'action 3'],
        },
      ],
      timeoutHours: 72,
      notifyEmail: true,
      notifyWebex: false,
      onApproved: { id: '<uuid>', name: 'Answered', steps: [] },
      onDeclined: { id: '<uuid>', name: 'Skipped', steps: [] },
      onTimeout: { id: '<uuid>', name: 'No answer', steps: [] },
    }),
    'The steps inside onApproved then use the chips "the issue key", "the points" and',
    '"the comments" — that is the whole point of asking: the write the answer unlocks happens',
    'in the same run, and the answered path is told "Story Points [customfield_10016]: 8" so',
    'the step posting it needs no second lookup.',
  ].join(' ');

  const STEPS_DESCRIPTION = [
    `The full steps document: {version:${CURRENT_STEPS_VERSION}, steps:[node,...]} — e.g. the`,
    '`steps` value from agent_get. Array order is execution order.',
    `At most ${MAX_STEPS} steps by default (the org may allow more).`,
    STEP_NODE_GRAMMAR,
    FORM_EXAMPLE,
  ].join(' ');

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
    'blackoutPolicy?:"skip"|"before"|"after"} — where each rule is exactly one of',
    '{every:"hour"}, {every:"day", at:"HH:MM"}, {every:"weekday", at:"HH:MM"} (Mon-Fri),',
    '{every:"week", weekday:0-6, at:"HH:MM"} (Sunday=0 — this is how a single named day is',
    'expressed; there is no {every:"sunday"}), or {every:"month", at:"HH:MM"} plus EXACTLY ONE',
    'of day:1-31 (clamped to short months), on:"last-day"|"first-weekday"|"last-weekday", or',
    "nth:1|2|3|4|-1 with weekday:0-6. Times are 24-hour wall clock read in the schedule's",
    `timezone, and rules combine by union (earliest wins, at most ${MAX_SCHEDULE_RULES}).`,
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

  const definitionSchema = {
    name: z.string().min(1).max(200).describe('The agent name'),
    steps: z.record(z.string(), z.unknown()).describe(STEPS_DESCRIPTION),
    triggers: z.array(z.unknown()).optional().describe(TRIGGERS_DESCRIPTION),
    llmModelId: z.string().optional().describe('Model config id; default the org default'),
    guardrails: z
      .string()
      .max(1_000_000)
      .optional()
      .describe('Standing instructions injected into every model call of every run'),
    blockedTools: z
      .array(z.string())
      .optional()
      .describe('Act tools the engine must refuse for this agent, by name from agent_list_tools'),
    confirm: z
      .boolean()
      .optional()
      .describe('Without true: validate and report only, persist nothing'),
  };

  /** The wire body agent_create/agent_update share, via the routes' parser. */
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
      steps: args.steps,
      triggers,
      enabled,
      llmModelId: typeof args.llmModelId === 'string' ? args.llmModelId : null,
      guardrails: typeof args.guardrails === 'string' ? args.guardrails : null,
      blockedTools: Array.isArray(args.blockedTools) ? args.blockedTools : [],
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

  server.registerTool(
    'agent_create',
    {
      title: 'Agents · Act — Create an agent (confirm-gated)',
      description:
        'Create a new agent of yours from a full definition — authored directly, or taken ' +
        "from another agent's agent_get JSON or exported markdown. Authoring one directly " +
        'starts at agent_list_tools: it names every skill a step may use and the failure ' +
        'codes that step can handle, which is the catalog the web builder shows in a picker ' +
        'and nothing else here would tell you. Without ' +
        'confirm:true this is a DRY RUN — it validates and ' +
        'shows what would be created, persisting nothing. The agent is always created ' +
        'DISABLED: turning it on happens in the builder, where the review panel is.',
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
      const result = await saveAgent(dbResult.val, context.tenantId, context.subject, parsed, {
        dryRun,
      });
      if (result.outcome === 'not-found') return errText(NOT_FOUND);
      if (result.outcome === 'invalid') return errText(issueLines(result.issues));
      if (result.outcome === 'valid-dry-run') {
        return textResult(
          [
            `Valid. This would create "${result.normalized.name}" (disabled) with:`,
            outlineOf(result.normalized.steps),
            ...(result.normalized.guardrails
              ? ['', 'Guardrails:', result.normalized.guardrails]
              : []),
            '',
            'Nothing was saved. Call again with confirm:true to create it.',
          ].join('\n')
        );
      }

      logger.info('agent_create persisted a new agent', {
        component: 'mcp/tool',
        tenantId: context.tenantId,
        agentId: result.agentId,
      });
      return textResult(
        [
          `Created "${result.normalized.name}" — DISABLED until you review and turn it on in the builder.`,
          `agentId: ${result.agentId}`,
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
    'agent_patch_steps',
    {
      title: 'Agents · Act — Change some steps of an agent (confirm-gated)',
      description:
        "Change PART of one of your agents' steps without resending the whole definition — " +
        'insert a step between two others, replace one, remove one, or move one. Prefer this ' +
        'over agent_update for anything short of a rewrite: agent_update requires echoing ' +
        'every untouched step back verbatim, and one transcription slip silently rewrites a ' +
        'step nobody meant to touch. Positions are given as after/before another step id ' +
        '(from agent_get), or intoPath / intoContainer / atTop for a list. Operations apply ' +
        'in order and each sees the last, so you can insert a loop and move a step into it in ' +
        'one call; if any operation cannot be applied, NONE are. Without confirm:true this is ' +
        'a DRY RUN. Ids are never changed here — run history, retry settings and trigger ' +
        'firings anchor to them.',
      annotations: { readOnlyHint: false },
      inputSchema: z.object({
        agentId: z.string().min(1).describe('From agent_list'),
        operations: z
          .array(
            z.object({
              op: z.enum(['insert', 'replace', 'remove', 'move']),
              id: z
                .string()
                .optional()
                .describe('The step to replace, remove or move (not used by insert)'),
              node: z
                .unknown()
                .optional()
                .describe(
                  'The step node for insert/replace — the same shape agent_get returns. ' +
                    'A new step needs a fresh uuid; a replacement keeps the id it ' +
                    'replaces. ' +
                    STEP_NODE_GRAMMAR +
                    ' ' +
                    FORM_EXAMPLE
                ),
              at: z
                .object({
                  after: z
                    .string()
                    .optional()
                    .describe("Immediately after this step, in that step's own list"),
                  before: z
                    .string()
                    .optional()
                    .describe("Immediately before this step, in that step's own list"),
                  intoPath: z
                    .string()
                    .optional()
                    .describe('Into this branch path (appended unless index is given)'),
                  intoContainer: z
                    .string()
                    .optional()
                    .describe('Into this loop or group (appended unless index is given)'),
                  atTop: z.boolean().optional().describe('Onto the top-level list'),
                  index: z.number().int().min(0).optional(),
                })
                .optional()
                .describe('Where the step goes, for insert and move. Exactly one anchor.'),
            })
          )
          .min(1)
          .describe('Applied in order; all or nothing'),
        confirm: z.boolean().optional().describe('Without true: validate and report only'),
      }),
    },
    async (args: Record<string, unknown>) => {
      if (!context.subject) return errText(NO_SUBJECT);
      if (context.agent) return errText(RUN_REFUSAL);
      const dbResult = getDatabase();
      if (!dbResult.ok) return errText('Database unavailable.');
      const agent = await ownAgent(dbResult.val, context, args.agentId);
      if (!agent) return errText(NOT_FOUND);

      const operations = toPatchOperations(args.operations);
      if ('error' in operations) return errText(operations.error);

      const patched = applyStepPatch(agent.steps, operations.val);
      if (!patched.ok) return errText(patched.error);

      // The patched document goes through the SAME save path as a full
      // update, so validation, clamping and the format re-stamp are
      // identical — a patch cannot reach a state agent_update could not.
      const dryRun = args.confirm !== true;
      // Everything except the steps is the agent as stored: a patch changes
      // steps and nothing else, and it goes through the SAME parse and save
      // path as a full update so validation and clamping are identical.
      const parsed = parseDefinition(
        {
          name: agent.name,
          steps: patched.steps,
          triggers: agent.triggers,
          llmModelId: agent.llmModelId,
          guardrails: agent.guardrails,
          blockedTools: agent.blockedTools,
        },
        agent.enabled
      );
      if ('error' in parsed) return errText(parsed.error);

      const result = await saveAgent(dbResult.val, context.tenantId, context.subject, parsed, {
        agentId: agent.id,
        dryRun,
      });
      if (result.outcome === 'not-found') return errText(NOT_FOUND);
      if (result.outcome === 'invalid') return errText(issueLines(result.issues));
      if (result.outcome === 'valid-dry-run') {
        return textResult(
          [
            `Valid. ${operations.val.length} operation(s) would leave "${result.normalized.name}" as:`,
            outlineOf(result.normalized.steps),
            '',
            'Nothing was saved. Call again with confirm:true to apply it.',
          ].join('\n')
        );
      }

      logger.info('agent_patch_steps applied', {
        component: 'mcp/tool',
        tenantId: context.tenantId,
        agentId: agent.id,
      });
      return textResult(
        [`Updated "${result.normalized.name}":`, outlineOf(result.normalized.steps)].join('\n')
      );
    }
  );

  server.registerTool(
    'agent_patch',
    {
      title: 'Agents · Act — Change one part of an agent (confirm-gated)',
      description:
        'Change PART of one of your agents WITHOUT resending its steps — its name, its ' +
        'triggers (one at a time, by id), its guardrails, its blocked skills, or its model. ' +
        'ONLY the fields you send change; everything you leave out is kept exactly as ' +
        'stored. Prefer this over agent_update for anything short of a rewrite: agent_update ' +
        'REPLACES the whole definition, so it makes you echo every step and every trigger ' +
        'back verbatim, and a trigger missing from that echo is DELETED along with its ' +
        'firing history, its next run time and an API key that can never be shown again. ' +
        'To change STEPS use agent_patch_steps. Trigger ids come from agent_get; a trigger ' +
        'you do not name here is left untouched, ids and all. Without confirm:true this is ' +
        'a DRY RUN — it validates and shows what would change, persisting nothing. This ' +
        'tool never TURNS ON an agent (the builder is the consent surface for that): an off ' +
        'agent stays off, an already-enabled one stays on unless keepEnabled:false.',
      annotations: { readOnlyHint: false },
      inputSchema: z.object({
        agentId: z.string().min(1).describe('From agent_list'),
        name: z.string().min(1).max(200).optional().describe('Rename the agent'),
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
            'Standing instructions injected into every model call of every run; null or "" ' +
              'to drop them'
          ),
        blockedTools: z
          .array(z.string())
          .optional()
          .describe('Replaces the blocked-skill list outright; [] unblocks everything'),
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
      const agent = await ownAgent(dbResult.val, context, args.agentId);
      if (!agent) return errText(NOT_FOUND);

      // Present means change it, absent means keep it: the whole point of
      // this tool is that what a caller does not mention is not touched.
      // `null` is a value here, not an omission — it clears the field.
      const given = (key: string) => key in args && args[key] !== undefined;
      const fields = ['name', 'triggers', 'guardrails', 'blockedTools', 'llmModelId'];
      if (!fields.some(given) && args.keepEnabled === undefined) {
        return errText(`Nothing to change — send at least one of ${fields.join(', ')}.`);
      }

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
      // validation and clamping are identical — a patch cannot reach a state
      // agent_update could not.
      const parsed = parseDefinition(
        {
          name: given('name') ? args.name : agent.name,
          steps: agent.steps,
          triggers,
          llmModelId: given('llmModelId') ? args.llmModelId : agent.llmModelId,
          guardrails: given('guardrails') ? args.guardrails : agent.guardrails,
          blockedTools: given('blockedTools') ? args.blockedTools : agent.blockedTools,
        },
        enabled
      );
      if ('error' in parsed) return errText(parsed.error);

      const changed = [
        ...(given('name') ? [`name → "${parsed.input.name}"`] : []),
        ...(given('triggers') ? ['triggers'] : []),
        ...(given('guardrails') ? ['guardrails'] : []),
        ...(given('blockedTools') ? ['blocked skills'] : []),
        ...(given('llmModelId') ? ['model'] : []),
        ...(agent.enabled && !enabled ? ['turned off'] : []),
      ].join(', ');

      const dryRun = args.confirm !== true;
      const result = await saveAgent(dbResult.val, context.tenantId, context.subject, parsed, {
        agentId: agent.id,
        dryRun,
      });
      if (result.outcome === 'not-found') return errText(NOT_FOUND);
      if (result.outcome === 'invalid') return errText(issueLines(result.issues));
      if (result.outcome === 'valid-dry-run') {
        return textResult(
          [
            `Valid. This would change "${agent.name}": ${changed}.`,
            ...triggerLines(triggers),
            '',
            `Its steps are untouched. It stays ${enabled ? 'ENABLED' : 'disabled'}. Nothing was saved. Call again with confirm:true to apply.`,
          ].join('\n')
        );
      }

      logger.info('agent_patch changed an agent definition', {
        component: 'mcp/tool',
        tenantId: context.tenantId,
        agentId: result.agentId,
      });
      return textResult(
        [
          `Updated "${result.normalized.name}" (${enabled ? 'still enabled' : 'disabled'}): ${changed}.`,
          ...triggerLines(triggers),
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
        "REPLACE one of your agents' definition (name, steps, triggers, guardrails, blocked " +
        'skills) — the whole-document path, for a REWRITE. ' +
        'FOR ANYTHING SHORT OF ONE, PATCH INSTEAD: agent_patch_steps changes steps by id, ' +
        'agent_patch changes the name, a trigger, the guardrails, the blocked skills or the ' +
        'model. This tool requires echoing everything untouched back verbatim, where one ' +
        'slip silently rewrites a step nobody meant to touch and an omitted trigger is ' +
        'deleted with its firing history and its API key. ' +
        "If you do use this: start from the exact definition in agent_get's " +
        '```json renkei-agent block, change ONLY what the edit needs, and send the whole ' +
        'definition back. Keep the ids of steps, branch paths, and triggers you are keeping ' +
        'VERBATIM (run history, retry settings, and firings anchor to them); give brand-new ' +
        'steps fresh UUIDs. Validation is deterministic and reports precise per-path issues; ' +
        'the save also re-stamps the current steps format. Without confirm:true this is a ' +
        'DRY RUN — it validates and shows what would change, persisting nothing. This tool ' +
        'never TURNS ON an agent (the builder is the consent surface for that): an off agent ' +
        'stays off, an already-enabled one stays on unless keepEnabled:false disables it. ' +
        'Prose-to-steps drafting lives in the web builder.',
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
      const agent = await ownAgent(dbResult.val, context, args.agentId);
      if (!agent) return errText(NOT_FOUND);

      // enabled is never RAISED here: an off agent stays off; an on agent
      // stays on (the owner armed it knowingly) unless keepEnabled:false.
      const enabled = agent.enabled && args.keepEnabled !== false;
      const parsed = parseDefinition(args, enabled);
      if ('error' in parsed) return errText(parsed.error);

      const dryRun = args.confirm !== true;
      const result = await saveAgent(dbResult.val, context.tenantId, context.subject, parsed, {
        agentId: agent.id,
        dryRun,
      });
      if (result.outcome === 'not-found') return errText(NOT_FOUND);
      if (result.outcome === 'invalid') return errText(issueLines(result.issues));
      if (result.outcome === 'valid-dry-run') {
        return textResult(
          [
            `Valid. This would rewrite "${agent.name}" to:`,
            outlineOf(result.normalized.steps),
            ...(result.normalized.guardrails
              ? ['', 'Guardrails:', result.normalized.guardrails]
              : []),
            '',
            `It stays ${enabled ? 'ENABLED' : 'disabled'}. Nothing was saved. Call again with confirm:true to apply.`,
          ].join('\n')
        );
      }

      logger.info('agent_update rewrote an agent definition', {
        component: 'mcp/tool',
        tenantId: context.tenantId,
        agentId: result.agentId,
      });
      return textResult(
        [
          `Updated "${result.normalized.name}" (${enabled ? 'still enabled' : 'disabled'}).`,
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
