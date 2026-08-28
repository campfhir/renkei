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
 *  - The three DEFINITION-EDITING tools (agent_draft, agent_create,
 *    agent_update) REFUSE agent-run callers (`context.agent` set): a run
 *    must not rewrite its own steps or strip its guardrails — the cards
 *    ground rule, applied to behavior. Knowledge and memory tools stay
 *    available to runs: knowledge is reference data an agent legitimately
 *    curates (knowledge_create_note already exists); steps and guardrails
 *    are behavior definition, and that line is the point.
 *  - Writes are CONFIRM-GATED: without `confirm: true`, agent_create and
 *    agent_update validate and report what WOULD be saved, persisting
 *    nothing. `enabled: true` is refused outright — the builder's review
 *    panel is the consent surface for arming an agent; disabling is
 *    always allowed.
 *  - Drafting is a BACKGROUND JOB: agent_draft writes the same durable
 *    `agent_drafts` row the builder uses and enqueues the worker job;
 *    agent_draft_get polls it. The model time used to run inline in the
 *    MCP request, which is a long-lived connection that times out at
 *    sixty seconds somewhere you cannot see.
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/server';
import { getDatabase, type DB } from '@renkei/db';
import type { Kysely } from 'kysely';
import { agentJobsQueue } from '@renkei/queue';
import {
  isAgentStepsDoc,
  isTriggerDraft,
  CURRENT_STEPS_VERSION,
  savesByPathCoverage,
  triggerVariableDescriptors,
  type AgentStepsDoc,
} from '@renkei/agents';
import {
  readAgentMemory,
  renderAgentKnowledgeNotes,
  renderAgentMemory,
} from '@renkei/agents/memory';
import { sql } from 'kysely';
import type { MCPToolContext } from '../common';
import { getAgent, listAgents, type StoredAgent } from '@/lib/agents/store';
import { saveAgent } from '@/lib/agents/save';
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
import { consumeDraft, createDraft, getDraft } from '@/lib/agents/draft-store';
import { fencedDefinition } from '@/lib/agents/definition';
import { parseReviewNotes } from '@/lib/agents/notes';
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

const NO_SUBJECT = 'This caller has no recorded identity, so it has no agents.';
const NOT_FOUND = 'No agent of yours has that id.';
const RUN_REFUSAL =
  'Agent runs cannot edit agent definitions — drafting, creating, and updating agents is ' +
  'reserved for people. The read, run-history, knowledge, and memory tools remain available.';

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

/** What an agent's steps bind, with whether each name always materializes. */
function variableLines(steps: AgentStepsDoc): string[] {
  const coverage = savesByPathCoverage(steps.steps);
  if (coverage.size === 0) return [];
  return [
    'Variables this agent saves (chainable):',
    ...[...coverage.entries()].map(
      ([name, kind]) =>
        `- ${name} (${kind === 'always' ? 'always set on success' : 'conditional — only some routes set it'})`
    ),
  ];
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
      return textResult(lines.join('\n'));
    }
  );

  server.registerTool(
    'agent_get',
    {
      title: 'Agents · Read — One agent in full',
      description:
        "One of your agents in full: the steps outline, guardrails, blocked skills, the " +
        'variables it saves (for chaining), triggers, agents chained after it, the ' +
        'knowledge and memory its runs carry — and the EXACT stored definition as a ' +
        '```json renkei-agent fenced block. To change the agent, edit that JSON directly ' +
        'and pass its fields to agent_update (no drafting round-trip needed).',
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

      const [knowledge, memory] = await Promise.all([
        renderAgentKnowledgeNotes(db, context.tenantId, agent.id),
        readAgentMemory(db, context.tenantId, agent.id).then(renderAgentMemory),
      ]);

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
        ...(() => {
          const vars = variableLines(agent.steps);
          return vars.length > 0 ? ['', ...vars] : [];
        })(),
        '',
        'Triggers:',
        ...(agent.triggers.length > 0
          ? agent.triggers.map(
              (trigger) =>
                `- ${triggerSummary(trigger.draft)}${trigger.enabled ? '' : ' (off)'}`
            )
          : ['- none (manual only)']),
        ...(chained.length > 0
          ? [
              '',
              'Chained after it (start when this one succeeds):',
              ...chained.map((row) => `- ${row.name} (agentId: ${row.id})`),
            ]
          : []),
        ...(knowledge ? ['', 'Knowledge notes (as injected into runs):', knowledge] : []),
        ...(memory ? ['', 'Memory (as injected into runs):', memory] : []),
        '',
        'Definition (machine-readable) — the exact stored definition. To change the agent,',
        'edit this JSON and pass its fields to agent_update (keep the ids of steps you are',
        'keeping; they anchor run history and retry settings):',
        fencedDefinition({
          name: agent.name,
          description: agent.description,
          steps: agent.steps,
          triggers: agent.triggers,
          guardrails: agent.guardrails,
          blockedTools: agent.blockedTools,
          llmModelId: agent.llmModelId,
        }),
      ];
      return textResult(lines.join('\n'));
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

      const lines = [`${runs.length} run(s) of "${agent.name}", newest first:`];
      for (const run of runs) {
        const duration = run.durationMs !== null ? ` · ${Math.round(run.durationMs / 1000)}s` : '';
        lines.push(
          '',
          `- ${run.status} · via ${run.triggerKind} · ${run.createdAt}${duration}`,
          `  runId: ${run.id}`,
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

      return textResult(renderRunDebugMarkdown(agent.name, run));
    }
  );

  server.registerTool(
    'agent_memory_list',
    {
      title: 'Agents · Read — An agent\'s memory',
      description:
        "One of your agents' memory in full: the rolling summary and the newest entries the " +
        'engine recorded across runs. agent_get shows the bounded slice runs receive; this is ' +
        'the raw list.',
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
          lines.push(`- [${entry.createdAt.toISOString()}] ${entry.content}`);
        }
      }
      return textResult(lines.join('\n'));
    }
  );

  server.registerTool(
    'agent_knowledge_list',
    {
      title: 'Agents · Read — An agent\'s knowledge notes',
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

  server.registerTool(
    'agent_draft',
    {
      title: 'Agents · Act — Start drafting an agent from a description',
      description:
        'Turn a PLAIN-LANGUAGE description into a drafted agent definition — a background ' +
        'model job (a minute or two; poll agent_draft_get for the result). Use this only ' +
        'when starting from prose. To CHANGE an existing agent, do not draft: read its ' +
        'exact definition from agent_get, edit the JSON yourself, and pass it to ' +
        'agent_update — deterministic, validated, and immediate. No agent is created or ' +
        'changed by drafting. Pass agentId to revise that agent instead of starting fresh.',
      annotations: { readOnlyHint: false },
      inputSchema: z.object({
        text: z
          .string()
          .min(10)
          .max(20_000)
          .describe('What the agent should do, in plain language'),
        agentId: z
          .string()
          .optional()
          .describe('Revise THIS agent of yours: its current steps are the starting point'),
      }),
    },
    async (args: Record<string, unknown>) => {
      if (!context.subject) return errText(NO_SUBJECT);
      if (context.agent) return errText(RUN_REFUSAL);
      const text = typeof args.text === 'string' ? args.text.trim() : '';
      if (text.length < 10) return errText('Describe the automation in a sentence or two first.');
      const dbResult = getDatabase();
      if (!dbResult.ok) return errText('Database unavailable.');
      const db = dbResult.val;

      let revising: StoredAgent | null = null;
      if (typeof args.agentId === 'string' && args.agentId.trim()) {
        revising = await ownAgent(db, context, args.agentId);
        if (!revising) return errText(NOT_FOUND);
      }

      // The same durable job the builder uses: a draft row plus a queue
      // entry, worked by the agents worker. Doing the model calls inline
      // here is what this replaced — an MCP request is exactly the kind of
      // long-lived connection that times out at sixty seconds somewhere you
      // cannot see, and the caller's client gives up while the work is
      // still (invisibly) succeeding.
      const draftId = await createDraft(db, {
        tenantId: context.tenantId,
        ownerSubject: context.subject,
        agentId: revising?.id ?? null,
        request: {
          text,
          steps: revising ? JSON.parse(JSON.stringify(revising.steps)) : null,
          // Chips in existing steps only survive a revision when the
          // drafting model knows the trigger variables that back them —
          // the same list the builder sends.
          triggerVars: revising
            ? JSON.parse(
                JSON.stringify(
                  triggerVariableDescriptors(revising.triggers.map((t) => t.draft)).map(
                    ({ name, description }) => ({ name, description })
                  )
                )
              )
            : [],
          // Suggestions fill an empty slot, they never rewrite configured
          // triggers — the builder's rule, applied here.
          suggestTriggers: !revising || revising.triggers.length === 0,
          guardrails: revising?.guardrails ?? null,
        },
      });

      const enqueued = await agentJobsQueue().producer.enqueue({
        tenantId: context.tenantId,
        source: 'agents',
        type: 'draft',
        payload: { draftId },
        // Drafts for one person stay serial: two at once would race for the
        // same builder and cost double the model time for one usable answer.
        orderingKey: `draft:${context.tenantId}:${context.subject}`,
      });
      if (!enqueued.ok) {
        logger.error('could not enqueue draft job {draftId}: {error}', {
          component: 'mcp/tool',
          tenantId: context.tenantId,
          draftId,
          error: enqueued.err.message ?? 'unknown',
        });
        return errText('Could not start drafting. Try again in a moment.');
      }

      return textResult(
        [
          `Drafting ${revising ? `a revision of "${revising.name}"` : 'a new agent'} in the background.`,
          `draftId: ${draftId}`,
          'It takes a minute or two of model time. Poll agent_draft_get with this draftId for the result; nothing is created or changed by drafting.',
        ].join('\n')
      );
    }
  );

  server.registerTool(
    'agent_draft_get',
    {
      title: 'Agents · Read — Check on a background draft',
      description:
        'The status of a draft started by agent_draft and, once it finishes, the result: the ' +
        'steps outline, open questions, and the raw steps document to pass to agent_create ' +
        'or agent_update. Drafting takes a minute or two — poll this until it reports done.',
      annotations: { readOnlyHint: true },
      inputSchema: z.object({
        draftId: z.string().min(1).describe('From agent_draft'),
      }),
    },
    async (args: Record<string, unknown>) => {
      if (!context.subject) return errText(NO_SUBJECT);
      const dbResult = getDatabase();
      if (!dbResult.ok) return errText('Database unavailable.');
      const db = dbResult.val;
      const draftId = typeof args.draftId === 'string' ? args.draftId.trim() : '';
      const draft = await getDraft(db, context.tenantId, context.subject, draftId);
      if (!draft) return errText('No draft of yours has that id.');

      if (draft.status === 'queued' || draft.status === 'running') {
        return textResult(
          `Still drafting (${draft.status}) — a minute or two of model time. Check again shortly.`
        );
      }
      if (draft.status === 'failed') {
        return errText(
          `Drafting failed: ${draft.error ?? 'unknown error'}` +
            `${draft.errorDetail ? ` ${draft.errorDetail}` : ''} Start again with agent_draft.`
        );
      }

      // The stored result is the drafting pipeline's own output (a
      // DraftedAgent round-tripped through jsonb); the guard is for a row
      // damaged in storage, not a second validation pass. Version 7 is the
      // most permissive shape gate — the real version is recomputed below.
      const record: { [key: string]: unknown } =
        typeof draft.result === 'object' && draft.result !== null && !Array.isArray(draft.result)
          ? draft.result
          : {};
      const guard: unknown = { version: CURRENT_STEPS_VERSION, steps: record.steps };
      if (!isAgentStepsDoc(guard)) {
        return errText('The stored draft is unreadable — start again with agent_draft.');
      }
      const doc: AgentStepsDoc = { version: CURRENT_STEPS_VERSION, steps: guard.steps };

      const name = typeof record.name === 'string' && record.name ? record.name : 'Untitled agent';
      const questions = Array.isArray(record.questions)
        ? record.questions.filter(
            (question): question is string => typeof question === 'string' && question.trim() !== ''
          )
        : [];
      const concerns = parseReviewNotes(record.concerns);
      const guardrails =
        typeof record.guardrails === 'string' && record.guardrails.trim()
          ? record.guardrails
          : null;
      const triggers = Array.isArray(record.triggers) ? record.triggers.filter(isTriggerDraft) : [];

      // Picked up: the builder stops offering this draft on its next open.
      await consumeDraft(db, context.tenantId, context.subject, draft.id);

      const revising = draft.agentId !== null;
      const lines = [
        `Drafted "${name}"${revising ? ` (a revision of agentId ${draft.agentId})` : ''}. Nothing is saved yet.`,
        '',
        'Steps:',
        outlineOf(doc),
        ...(guardrails ? ['', 'Proposed guardrails:', guardrails] : []),
        ...(triggers.length > 0
          ? [
              '',
              'Proposed triggers — pass them in the "triggers" input alongside the steps:',
              ...triggers.map((trigger) => `- ${triggerSummary(trigger)}`),
              JSON.stringify(triggers),
            ]
          : []),
        ...(questions.length > 0
          ? [
              '',
              'Open questions — answer these and draft again, or edit the steps yourself:',
              ...questions.map((question) => `- ${question}`),
            ]
          : []),
        ...(concerns.length > 0
          ? [
              '',
              'Reviewer concerns still open:',
              ...concerns.map((concern) => `- ${concern.issue}${concern.fix ? ` Fix: ${concern.fix}` : ''}`),
            ]
          : []),
        '',
        `To save: pass this steps document to ${revising ? 'agent_update' : 'agent_create'} (it stays a draft until you confirm):`,
        JSON.stringify(doc),
      ];
      return textResult(lines.join('\n'));
    }
  );

  const definitionSchema = {
    name: z.string().min(1).max(200).describe('The agent name'),
    steps: z
      .record(z.string(), z.unknown())
      .describe('The full steps document (e.g. from agent_draft or agent_get)'),
    triggers: z
      .array(z.unknown())
      .optional()
      .describe('Trigger drafts ({draft, enabled} entries or bare drafts); default none'),
    llmModelId: z.string().optional().describe('Model config id; default the org default'),
    guardrails: z
      .string()
      .max(1_000_000)
      .optional()
      .describe('Standing instructions injected into every model call of every run'),
    blockedTools: z
      .array(z.string())
      .optional()
      .describe('Act tools the engine must refuse for this agent'),
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
        'Create a new agent of yours from a full definition — authored directly, taken from ' +
        "another agent's agent_get definition block or exported markdown, or drafted from " +
        'prose via agent_draft. Without confirm:true this is a DRY RUN — it validates and ' +
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
    'agent_update',
    {
      title: 'Agents · Act — Update an agent (confirm-gated)',
      description:
        "REPLACE one of your agents' definition (name, steps, triggers, guardrails, blocked " +
        'skills) — the direct edit path, and the preferred one: start from the exact ' +
        'definition in agent_get\'s ```json renkei-agent block, change ONLY what the edit ' +
        'needs, and send the whole definition back. Keep the ids of steps, branch paths, ' +
        'and triggers you are keeping VERBATIM (run history, retry settings, and firings ' +
        'anchor to them); give brand-new steps fresh UUIDs. Validation is deterministic and ' +
        'reports precise per-path issues; the save also re-stamps the current steps format. ' +
        'Without confirm:true this is a DRY RUN — it validates and shows what would change, ' +
        'persisting nothing. This tool never TURNS ON an agent (the builder is the consent ' +
        'surface for that): an off agent stays off, an already-enabled one stays on unless ' +
        'keepEnabled:false disables it. Only draft (agent_draft) when working from prose.',
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
            ? ['The summary and review notes are being rewritten; agent_get will show them shortly.']
            : []),
        ].join('\n')
      );
    }
  );
}
