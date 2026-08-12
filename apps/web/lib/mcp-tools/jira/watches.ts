/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Standing indexing instructions for Jira projects.
 *
 * These do not fetch anything — they tell the worker's poller what to keep
 * fresh. Content then becomes findable through search_knowledge, still
 * gated live per read against the caller's own Jira permissions, so
 * watching a project never widens what anyone can see.
 *
 * Polling rather than webhooks is a forced choice: Jira's dynamic webhooks
 * cap at five per user, expire monthly, and carry an undocumented
 * non-public-app delivery restriction. Confluence has no OAuth webhook at
 * all. One polling path for both keeps the two halves equally fresh.
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/server';
import type { MCPToolContext } from '../common';
import { jiraFetch } from '../common';
import { upsertWatch, disableWatch, listWatches, watchLine } from '../content-watches';

// common.ts's ok()/toolError() build a content ITEM, not a result — the
// Jira tools each wrap them inline. These are the same two lines, named.
function ok(text: string) {
  return { content: [{ type: 'text' as const, text }] };
}
function toolError(text: string) {
  return { content: [{ type: 'text' as const, text }], isError: true };
}

/** The project's display name, or null when Jira doesn't know that key. */
async function resolveProject(
  context: MCPToolContext,
  projectKey: string
): Promise<{ key: string; name: string } | null> {
  const response = await jiraFetch(
    `${context.apiBaseUrl}/rest/api/3/project/${encodeURIComponent(projectKey)}`,
    context.accessToken
  );
  if (!response.ok) return null;
  const body: any = await response.json().catch(() => null);
  if (!body || typeof body.key !== 'string') return null;
  return { key: body.key, name: typeof body.name === 'string' ? body.name : body.key };
}

export async function registerWatchTools(
  server: McpServer,
  context: MCPToolContext
): Promise<void> {
  server.registerTool(
    'jira_watch_project',
    {
      title: 'Jira · Write — Watch a project for indexing',
      description:
        'Keep a Jira project continuously indexed so its issues become searchable through ' +
        'search_knowledge by meaning, not just by JQL. Indexing runs in the background under ' +
        'your own Jira access, and every result is re-checked against your live permissions ' +
        'when it is read. Watching is per-user: it does not affect what anyone else can see.',
      inputSchema: z.object({
        projectKey: z.string().min(1).describe('Project key, e.g. SCRUM'),
      }),
    },
    async (args: Record<string, any>) => {
      if (!context.subject) return toolError('No signed-in subject on this MCP session.');
      const projectKey = String(args.projectKey ?? '').trim();
      if (!projectKey) return toolError('projectKey is required');

      // Validate against Jira before storing: a typo'd key would otherwise
      // become a watch that fails silently in the background forever.
      const project = await resolveProject(context, projectKey);
      if (!project) {
        return toolError(
          `Jira has no project "${projectKey}" visible to you. Check the key with jira_list_projects.`
        );
      }

      const result = await upsertWatch(
        { tenantId: context.tenantId, subject: context.subject, accountId: context.accountId },
        'jira',
        'project',
        project.key,
        project.name
      );
      if (!result.ok) return toolError(result.error);

      return ok(
        result.created
          ? `Watching ${project.name} (${project.key}). The first indexing pass starts within a ` +
              'few minutes; large projects take a while to work through.'
          : `${project.name} (${project.key}) was already being watched — nothing changed.`
      );
    }
  );

  server.registerTool(
    'jira_unwatch_project',
    {
      title: 'Jira · Write — Stop watching a project',
      description:
        'Stop indexing new changes in a Jira project. Already-indexed issues stay searchable ' +
        '(they are permission-checked live on every read); this only stops the background ' +
        'polling. Re-watching later resumes where it left off rather than re-reading history.',
      inputSchema: z.object({
        projectKey: z.string().min(1).describe('Project key, e.g. SCRUM'),
      }),
    },
    async (args: Record<string, any>) => {
      if (!context.subject) return toolError('No signed-in subject on this MCP session.');
      const projectKey = String(args.projectKey ?? '').trim();
      if (!projectKey) return toolError('projectKey is required');

      const result = await disableWatch(
        { tenantId: context.tenantId, subject: context.subject, accountId: context.accountId },
        'jira',
        'project',
        projectKey
      );
      if (!result.ok) return toolError(result.error);
      return ok(
        result.found
          ? `Stopped watching ${projectKey}.`
          : `You were not watching ${projectKey} — nothing to stop.`
      );
    }
  );

  server.registerTool(
    'jira_list_watches',
    {
      title: 'Jira · Read — List watched projects',
      description:
        'Show which Jira projects you have set to be indexed, with how much has been indexed ' +
        'and when each last synced. Use this to check whether a project is actually being ' +
        'kept fresh before trusting a search_knowledge result to be complete.',
      annotations: { readOnlyHint: true },
      inputSchema: z.object({}),
    },
    async () => {
      if (!context.subject) return toolError('No signed-in subject on this MCP session.');
      const result = await listWatches(
        { tenantId: context.tenantId, subject: context.subject, accountId: context.accountId },
        'jira'
      );
      if (!result.ok) return toolError(result.error);
      if (result.watches.length === 0) {
        return ok('You are not watching any Jira projects. Add one with jira_watch_project.');
      }
      return ok(
        [
          `Watched Jira projects (${result.watches.length}):`,
          ...result.watches.map(watchLine),
        ].join('\n• ')
      );
    }
  );
}
