/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/consistent-type-assertions */
/**
 * Worklog (time tracking) tools for Jira MCP.
 * List, create, and manage time tracking entries on issues.
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/server';
import type { MCPToolContext } from '../common';
import { getCachedDisplayName, issueUrl, withPresentationHint } from '../common';
import { adfToMarkdown } from './adf';
import { markdownToAdf } from './markdown';
import { logger } from '@/lib/logger';
import { granularJiraScopes, describeJiraAuthFailure, type JiraAuth } from './jira-auth';

function errText(value: string) {
  return { content: [{ type: 'text' as const, text: value }], isError: true };
}

export async function registerWorklogTools(
  server: McpServer,
  context: MCPToolContext,
  auth: JiraAuth
): Promise<void> {
  // jira_list_worklogs
  server.registerTool(
    'jira_list_worklogs',
    {
      title: 'Jira · Read — List worklogs on an issue',
      description:
        'For many issues use jira_bulk_get_worklogs — one call covers a whole sprint. This ' +
        'lists all time tracking entries on ONE specific issue.',
      annotations: { readOnlyHint: true },
      inputSchema: z.object({
        issueKey: z.string().describe('Issue key, e.g. PROJ-123'),
      }),
    },
    async (args: Record<string, unknown>) => {
      const displayName = getCachedDisplayName(context.accountId);
      logger.info('jira_list_worklogs invoked', {
        component: 'mcp/tool',
        tenantId: context.tenantId,
        accountId: context.accountId,
        displayName,
      });
      try {
        const { issueKey } = args;

        if (!issueKey) {
          return {
            content: [{ type: 'text' as const, text: 'issueKey is required' }],
            isError: true,
          };
        }

        const response = await auth.fetch(
          granularJiraScopes('jira_list_worklogs', true),
          `/rest/api/3/issue/${issueKey}/worklog`
        );
        if (!response.ok) return errText(await describeJiraAuthFailure(response));

        const data = (await response.json()) as any;
        const worklogs = data.worklogs || [];

        const lines = [
          `Issue ${issueKey} has ${worklogs.length} worklogs:`,
          ...worklogs.map((w: any) => {
            const author = w.author?.displayName || 'Unknown';
            const duration = w.timeSpent || 'N/A';
            const started = w.started ? new Date(w.started).toLocaleDateString() : 'N/A';
            // Worklog comments are ADF documents — flattened, not stringified.
            return `• ${author}: ${duration} (${started}) (ID: ${w.id})${w.comment ? ` - ${adfToMarkdown(w.comment)}` : ''}`;
          }),
        ];

        if (worklogs.length === 0) {
          return { content: [{ type: 'text' as const, text: lines.join('\n') }] };
        }
        return {
          content: [
            {
              type: 'text' as const,
              text: withPresentationHint(
                lines.join('\n'),
                'a table (Author, Time spent, Date, Comment) usually scans faster than this flat ' +
                  'list.'
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

  // jira_bulk_get_worklogs — the "worklogs for a whole sprint" answer in one
  // HTTP call: search/jql returns each issue's embedded worklog list (first
  // 20 entries, with a total marker) plus its aggregate timetracking.
  server.registerTool(
    'jira_bulk_get_worklogs',
    {
      title: 'Jira · Read — Worklogs across many issues at once',
      description:
        'Time tracking for MANY issues in one call — a sprint, an epic, any JQL selection. ' +
        'Returns each issue’s total time spent and its worklog entries (first 20 per issue). ' +
        'Always prefer this over calling jira_list_worklogs once per issue.',
      annotations: { readOnlyHint: true },
      inputSchema: z.object({
        jql: z
          .string()
          .describe('JQL selecting the issues, e.g. "sprint = 42" or "project = PROJ"')
          .optional(),
        issueKeys: z
          .array(z.string().min(1))
          .max(100)
          .describe('Explicit issue keys instead of JQL')
          .optional(),
        maxResults: z.number().describe('Maximum issues covered (1-100, default 50)').optional(),
      }),
    },
    async (args: Record<string, unknown>) => {
      const displayName = getCachedDisplayName(context.accountId);
      logger.info('jira_bulk_get_worklogs invoked', {
        component: 'mcp/tool',
        tenantId: context.tenantId,
        accountId: context.accountId,
        displayName,
      });
      try {
        const issueKeys = Array.isArray(args.issueKeys)
          ? args.issueKeys.filter((key): key is string => typeof key === 'string' && !!key)
          : [];
        const jql =
          typeof args.jql === 'string' && args.jql.trim()
            ? args.jql.trim()
            : issueKeys.length > 0
              ? `key in (${issueKeys.join(', ')})`
              : '';
        if (!jql) return errText('Provide jql or issueKeys.');
        const maxResults = Math.min(
          (typeof args.maxResults === 'number' ? args.maxResults : 50) || 50,
          context.maxJqlResults
        );

        const response = await auth.fetch(
          granularJiraScopes('jira_bulk_get_worklogs', true),
          '/rest/api/3/search/jql',
          {
            method: 'POST',
            body: JSON.stringify({
              jql,
              maxResults,
              fields: ['summary', 'worklog', 'timetracking'],
            }),
          }
        );
        if (!response.ok) return errText(await describeJiraAuthFailure(response));

        const data = (await response.json()) as any;
        const issues: any[] = Array.isArray(data?.issues) ? data.issues : [];
        if (issues.length === 0) {
          return { content: [{ type: 'text' as const, text: 'No issues matched.' }] };
        }

        const lines: string[] = [];
        for (const issue of issues) {
          const fields = issue?.fields ?? {};
          const timeSpent = fields.timetracking?.timeSpent;
          const worklogField = fields.worklog ?? {};
          const entries: any[] = Array.isArray(worklogField.worklogs) ? worklogField.worklogs : [];
          const total = typeof worklogField.total === 'number' ? worklogField.total : entries.length;
          lines.push(
            `• ${issue.key}: ${fields.summary ?? ''} — total logged: ${timeSpent || (total === 0 ? 'none' : 'N/A')}` +
              (total === 0 ? '' : ` (${total} worklog${total === 1 ? '' : 's'})`)
          );
          for (const entry of entries) {
            const author = entry.author?.displayName || 'Unknown';
            const started = entry.started ? new Date(entry.started).toLocaleDateString() : 'N/A';
            lines.push(`    - ${author}: ${entry.timeSpent || 'N/A'} (${started})`);
          }
          if (total > entries.length) {
            lines.push(
              `    … ${total - entries.length} more — call jira_list_worklogs ${issue.key} for the full list.`
            );
          }
        }
        const more = typeof data?.nextPageToken === 'string' && data.nextPageToken.length > 0;
        return {
          content: [
            {
              type: 'text' as const,
              text: withPresentationHint(
                [
                  `Worklogs across ${issues.length} issue${issues.length === 1 ? '' : 's'}` +
                    (more ? ' — more match; narrow the JQL or raise maxResults.' : '') +
                    ':',
                  ...lines,
                ].join('\n'),
                'a table (Issue, Total logged, Who, When) usually scans faster than this flat list.'
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

  // jira_create_worklog
  server.registerTool(
    'jira_create_worklog',
    {
      title: 'Jira · Act — Create a worklog entry',
      description: 'Log time spent on an issue.',
      annotations: { readOnlyHint: false },
      inputSchema: z.object({
        issueKey: z.string().describe('Issue key, e.g. PROJ-123'),
        timeSpent: z
          .string()
          .describe('Time spent in Jira duration format, e.g. "2h", "30m", "1w 2d 4h"'),
        comment: z.string().describe('Optional comment about the work').optional(),
        started: z
          .string()
          .describe('Optional start time in ISO format, e.g. 2024-01-15T10:30:00.000+0000')
          .optional(),
      }),
    },
    async (args: Record<string, unknown>) => {
      const displayName = getCachedDisplayName(context.accountId);
      logger.info('jira_create_worklog invoked', {
        component: 'mcp/tool',
        tenantId: context.tenantId,
        accountId: context.accountId,
        displayName,
      });
      try {
        const { issueKey, timeSpent, comment, started } = args;

        if (!issueKey || !timeSpent) {
          return {
            content: [
              {
                type: 'text' as const,
                text: 'issueKey and timeSpent are required',
              },
            ],
            isError: true,
          };
        }

        const body: any = {
          timeSpent: timeSpent as string,
        };

        if (comment) {
          // The v3 worklog API takes ADF here, not a plain string.
          body.comment = markdownToAdf(comment as string);
        }
        if (started) {
          body.started = started as string;
        }

        const response = await auth.fetch(
          granularJiraScopes('jira_create_worklog', false),
          `/rest/api/3/issue/${issueKey}/worklog`,
          {
            method: 'POST',
            body: JSON.stringify(body),
          }
        );
        if (!response.ok) return errText(await describeJiraAuthFailure(response));

        const worklog = (await response.json()) as any;

        const lines = [
          `Worklog created on ${issueKey}`,
          `Time: ${worklog.timeSpent}`,
          `Author: ${worklog.author?.displayName}`,
          `Issue: ${issueUrl(context.siteUrl, issueKey as string)}`,
        ];

        return { content: [{ type: 'text' as const, text: lines.join('\n') }] };
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

  // jira_delete_worklog
  server.registerTool(
    'jira_delete_worklog',
    {
      title: 'Jira · Act — Delete a worklog entry',
      description: 'Remove a time tracking entry from an issue.',
      annotations: { readOnlyHint: false },
      inputSchema: z.object({
        issueKey: z.string().describe('Issue key, e.g. PROJ-123'),
        worklogId: z.string().describe('ID of the worklog entry to delete'),
      }),
    },
    async (args: Record<string, unknown>) => {
      const displayName = getCachedDisplayName(context.accountId);
      logger.info('jira_delete_worklog invoked', {
        component: 'mcp/tool',
        tenantId: context.tenantId,
        accountId: context.accountId,
        displayName,
      });
      try {
        const { issueKey, worklogId } = args;

        if (!issueKey || !worklogId) {
          return {
            content: [
              {
                type: 'text' as const,
                text: 'issueKey and worklogId are required',
              },
            ],
            isError: true,
          };
        }

        const response = await auth.fetch(
          granularJiraScopes('jira_delete_worklog', false),
          `/rest/api/3/issue/${issueKey}/worklog/${worklogId}`,
          { method: 'DELETE' }
        );
        if (!response.ok) return errText(await describeJiraAuthFailure(response));

        return {
          content: [
            {
              type: 'text' as const,
              text: `Worklog ${worklogId} deleted from ${issueKey}`,
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
