/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/consistent-type-assertions */
/**
 * Work type (issue type) lookup for Jira MCP.
 *
 * "Work type" is Jira's current name for what the REST API still calls
 * "issue type" (Task, Bug, Story, Epic, Subtask, and any JSM
 * request-backing types like Incident or [System] Service request). A JSM
 * service desk is a Jira project under the hood, so scoping this to a
 * service desk's project key returns exactly the work types its request
 * types resolve to — no separate JSM-side tool needed.
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/server';
import type { MCPToolContext } from '../common';
import { getCachedDisplayName, withPresentationHint } from '../common';
import { logger } from '@/lib/logger';
import { granularJiraScopes, describeJiraAuthFailure, type JiraAuth } from './jira-auth';

function errText(value: string) {
  return { content: [{ type: 'text' as const, text: value }], isError: true };
}

function hierarchyLabel(level: unknown): string {
  if (typeof level !== 'number') return 'n/a';
  if (level === -1) return 'Subtask';
  if (level === 0) return 'Standard';
  if (level === 1) return 'Epic';
  return `Level ${level}`;
}

type ResolvedProject = { ok: true; id: string; label: string } | { ok: false; reason: string };

/**
 * projectId is the only thing GET /issuetype/project accepts — a numeric
 * Jira project ID, never a key. Resolved via project search (2 granular
 * scopes) rather than GET /project/{key} (11), which the watches.ts
 * projectName() comment documents as the wrong tool for this: a much
 * bigger documented scope set than the read bundle needs elsewhere.
 */
async function resolveProjectId(auth: JiraAuth, projectKey: string): Promise<ResolvedProject> {
  try {
    const response = await auth.fetch(
      granularJiraScopes('jira_list_work_types', true),
      `/rest/api/3/project/search?query=${encodeURIComponent(projectKey)}&maxResults=50`
    );
    if (!response.ok) return { ok: false, reason: await describeJiraAuthFailure(response) };
    const data = (await response.json()) as any;
    const projects = Array.isArray(data?.values) ? data.values : [];
    const wanted = projectKey.toLowerCase();
    const match =
      projects.find((p: any) => typeof p.key === 'string' && p.key.toLowerCase() === wanted) ??
      projects.find((p: any) => typeof p.id === 'string' && p.id === projectKey);
    if (!match) {
      return {
        ok: false,
        reason: `No project matches "${projectKey}". Use jira_list_projects to find the right key.`,
      };
    }
    return { ok: true, id: String(match.id), label: `${match.name} (${match.key})` };
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) };
  }
}

export async function registerWorkTypeTools(
  server: McpServer,
  context: MCPToolContext,
  auth: JiraAuth
): Promise<void> {
  // jira_list_work_types
  server.registerTool(
    'jira_list_work_types',
    {
      title: 'Jira · Read — List work types (issue types)',
      description:
        'List the work types (issue types) available in Jira — Task, Bug, Story, Epic, Subtask, ' +
        'and any JSM request-backing types like Incident or [System] Service request. Pass ' +
        'projectIdOrKey to scope to one project; a JSM service desk is a Jira project, so this ' +
        'covers a service desk\'s work types too — no separate JSM tool needed. Omit it to list ' +
        'every work type visible across the site.',
      annotations: { readOnlyHint: true },
      inputSchema: z.object({
        projectIdOrKey: z
          .string()
          .describe(
            'Project key or numeric ID to scope work types to a single project (Jira software, ' +
              'business, or JSM service desk). Omit to list every work type visible across the site.'
          )
          .optional(),
      }),
    },
    async (args: Record<string, unknown>) => {
      const displayName = getCachedDisplayName(context.accountId);
      logger.debug('jira_list_work_types invoked', {
        component: 'mcp/tool',
        tenantId: context.tenantId,
        accountId: context.accountId,
        displayName,
      });
      try {
        const projectIdOrKey =
          typeof args.projectIdOrKey === 'string' ? args.projectIdOrKey.trim() : '';

        let path = '/rest/api/3/issuetype';
        let projectLabel = '';
        if (projectIdOrKey) {
          if (/^\d+$/.test(projectIdOrKey)) {
            projectLabel = projectIdOrKey;
            path = `/rest/api/3/issuetype/project?projectId=${encodeURIComponent(projectIdOrKey)}`;
          } else {
            const resolved = await resolveProjectId(auth, projectIdOrKey);
            if (!resolved.ok) return errText(resolved.reason);
            projectLabel = resolved.label;
            path = `/rest/api/3/issuetype/project?projectId=${encodeURIComponent(resolved.id)}`;
          }
        }

        const response = await auth.fetch(granularJiraScopes('jira_list_work_types', true), path);
        if (!response.ok) return errText(await describeJiraAuthFailure(response));

        const data = (await response.json()) as any;
        const types: any[] = Array.isArray(data) ? data : [];
        if (types.length === 0) {
          return {
            content: [
              {
                type: 'text' as const,
                text: projectLabel
                  ? `No work types found for project ${projectLabel}.`
                  : 'No work types visible to you.',
              },
            ],
          };
        }

        const lines = types.map(
          (t: any) =>
            `• ${t.name} (${t.id})` +
            (t.subtask ? ' — subtask' : '') +
            ` — hierarchy: ${hierarchyLabel(t.hierarchyLevel)}` +
            (t.description ? ` — ${t.description}` : '')
        );
        const heading = projectLabel
          ? `${types.length} work type(s) for project ${projectLabel}:`
          : `${types.length} work type(s) visible to you:`;

        return {
          content: [
            {
              type: 'text' as const,
              text: withPresentationHint(
                [heading, ...lines].join('\n'),
                'a table (Name, ID, Subtask, Hierarchy) usually scans faster than this flat list.'
              ),
            },
          ],
        };
      } catch (error) {
        return {
          content: [
            { type: 'text' as const, text: error instanceof Error ? error.message : String(error) },
          ],
          isError: true,
        };
      }
    }
  );
}
