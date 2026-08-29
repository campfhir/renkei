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
 *  - The DEFINITION-EDITING tools (agent_create, agent_update) REFUSE
 *    agent-run callers (`context.agent` set): a run must not rewrite its
 *    own steps or strip its guardrails — the cards ground rule, applied
 *    to behavior. Knowledge and memory tools stay available to runs:
 *    knowledge is reference data an agent legitimately curates
 *    (knowledge_create_note already exists); steps and guardrails are
 *    behavior definition, and that line is the point.
 *  - Writes are CONFIRM-GATED: without `confirm: true`, agent_create and
 *    agent_update validate and report what WOULD be saved, persisting
 *    nothing. `enabled: true` is refused outright — the builder's review
 *    panel is the consent surface for arming an agent; disabling is
 *    always allowed.
 *  - There is NO drafting tool here. Prose-to-steps drafting is the web
 *    builder's own REST path (/agents/draft + the worker job); model
 *    callers work at the definition level instead — agent_get hands them
 *    the exact JSON, agent_update validates their edit deterministically.
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/server';
import { getDatabase, type DB } from '@renkei/db';
import type { Kysely } from 'kysely';
import {
  BUILTIN_VARIABLES,
  MAX_SCHEDULE_RULES,
  TRIGGER_EVENT_CATALOG,
  savesByPathCoverage,
  type AgentStepsDoc,
} from '@renkei/agents';
import { readAgentMemory } from '@renkei/agents/memory';
import { sql } from 'kysely';
import type { MCPToolContext } from '../common';
import { getAgent, listAgents, type StoredAgent } from '@/lib/agents/store';
import { saveAgent } from '@/lib/agents/save';
import { applyStepPatch, toPatchOperations } from '@/lib/agents/patch-steps';
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
        'To rewrite the agent, or to change its name, triggers, guardrails or blocked ' +
        'skills, edit this JSON — change only what the edit needs, keep the ids of ' +
        'steps/paths/triggers you are keeping (run history and retry settings anchor to ' +
        'them) — and pass the fields to agent_update. For the human-readable rendering ' +
        '(outline, knowledge, memory, chaining), use agent_get_description.',
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
      title: "Agents · Read — An agent's memory",
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
   * The trigger grammar, written out because a caller here has nowhere else
   * to read it: drafts are `unknown` to zod (the shapes are a discriminated
   * union zod's JSON Schema projection would flatten into noise), and the
   * builder — the only other place the vocabulary appears — is a UI. The
   * event ids come from the catalog so this cannot name a stale set.
   */
  const TRIGGERS_DESCRIPTION = [
    'Trigger drafts — {id?, draft, enabled?} entries, or bare drafts; default none',
    '(manual only). Keep the `id` of a trigger you are keeping VERBATIM (its firings and',
    'API key anchor to it); omit it for a new one.',
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

  const definitionSchema = {
    name: z.string().min(1).max(200).describe('The agent name'),
    steps: z
      .record(z.string(), z.unknown())
      .describe('The full steps document (e.g. the `steps` value from agent_get)'),
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
        'Create a new agent of yours from a full definition — authored directly, or taken ' +
        "from another agent's agent_get JSON or exported markdown. Without " +
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
                  'The step node for insert/replace — the same shape agent_get returns. A new ' +
                    'step needs a fresh uuid; a replacement keeps the id it replaces.'
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
    'agent_update',
    {
      title: 'Agents · Act — Update an agent (confirm-gated)',
      description:
        "REPLACE one of your agents' definition (name, steps, triggers, guardrails, blocked " +
        'skills) — the whole-document path, for a rewrite or for changing something that is ' +
        'NOT a step (the name, a trigger, the guardrails, blocked skills). ' +
        'TO CHANGE STEPS, USE agent_patch_steps INSTEAD: it inserts, replaces, removes or ' +
        'moves individual steps by id, and this tool requires echoing every untouched step ' +
        'back verbatim, where one slip silently rewrites a step nobody meant to touch. ' +
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
