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

/**
 * Validate a project key with the SAME call the poller will make.
 *
 * The obvious check — GET /rest/api/3/project/{key} — needs
 * read:project:jira, a different granular scope than the read:issue:jira
 * this tool gates on and the poller uses. A token carrying one but not the
 * other answers 401 "scope does not match", so validation could fail on a
 * project the sync would have read perfectly well. Validating through the
 * search endpoint removes the extra scope from the picture entirely: if
 * this succeeds, polling will too, by construction.
 */
async function projectIsVisible(
  context: MCPToolContext,
  projectKey: string
): Promise<{ ok: true } | { ok: false; reason: string }> {
  try {
    // maxResults 0 — this asks "does this JQL resolve", not for issues. An
    // empty project is still a valid thing to watch.
    const response = await jiraFetch(
      `${context.apiBaseUrl}/rest/api/3/search/jql`,
      context.accessToken,
      {
        method: 'POST',
        body: JSON.stringify({
          jql: `project = "${projectKey.replace(/"/g, '')}"`,
          maxResults: 0,
        }),
      }
    );
    return response.ok ? { ok: true } : { ok: false, reason: `Jira answered ${response.status}` };
  } catch (error) {
    // jiraFetch THROWS on any non-2xx (see its doc comment) — an unknown
    // project key arrives here as a 400, not as a falsy response.ok.
    return { ok: false, reason: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * The project's display name for the watch label. Best-effort on purpose:
 * this is the read:project:jira call, and a missing label is cosmetic —
 * failing the whole watch over it would be the bug described above.
 */
async function projectName(context: MCPToolContext, projectKey: string): Promise<string | null> {
  try {
    const response = await jiraFetch(
      `${context.apiBaseUrl}/rest/api/3/project/${encodeURIComponent(projectKey)}`,
      context.accessToken
    );
    const body: any = await response.json().catch(() => null);
    return body && typeof body.name === 'string' ? body.name : null;
  } catch {
    return null;
  }
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
      const visible = await projectIsVisible(context, projectKey);
      if (!visible.ok) {
        return toolError(
          `Could not read project "${projectKey}" as you. ${visible.reason}\n` +
            'If the key is right, your Jira connection may not carry the read scope this needs — ' +
            'reconnect Jira on the Connectors page.'
        );
      }
      const name = (await projectName(context, projectKey)) ?? projectKey;

      const result = await upsertWatch(
        { tenantId: context.tenantId, subject: context.subject, accountId: context.accountId },
        'jira',
        'project',
        projectKey,
        name
      );
      if (!result.ok) return toolError(result.error);

      return ok(
        result.created
          ? `Watching ${name} (${projectKey}). The first indexing pass starts within a ` +
              'few minutes; large projects take a while to work through.'
          : `${name} (${projectKey}) was already being watched — nothing changed.`
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
