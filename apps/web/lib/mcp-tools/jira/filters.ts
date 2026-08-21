/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/consistent-type-assertions */
/**
 * Filter tools for Jira MCP.
 * Manage saved JQL filters and searches.
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

export async function registerFilterTools(
  server: McpServer,
  context: MCPToolContext,
  auth: JiraAuth
): Promise<void> {
  // jira_list_filters
  server.registerTool(
    'jira_list_filters',
    {
      title: 'Jira · Read — List saved filters',
      description: 'List all filters (saved searches) accessible to the current user.',
      annotations: { readOnlyHint: true },
      inputSchema: z.object({
        expand: z.string().describe('Expand details (e.g. "sharedUsers,subscriptions")').optional(),
      }),
    },
    async (args: Record<string, unknown>) => {
      const displayName = getCachedDisplayName(context.accountId);
      logger.debug('jira_list_filters invoked', {
        component: 'mcp/tool',
        tenantId: context.tenantId,
        accountId: context.accountId,
        displayName,
      });
      try {
        const { expand } = args;

        // owner (and jql) only appear when expanded — without this every
        // filter showed Owner: Unknown.
        let path = `/rest/api/3/filter/search?maxResults=50&expand=owner,jql`;
        if (expand) {
          path += `&expand=${encodeURIComponent(expand as string)}`;
        }

        const response = await auth.fetch(granularJiraScopes('jira_list_filters', true), path);
        if (!response.ok) return errText(await describeJiraAuthFailure(response));
        const data = (await response.json()) as any;
        const filters = data.values || [];

        const lines = [
          `Found ${filters.length} filters:`,
          ...filters.map((f: any) => {
            const owner = f.owner?.displayName || 'Unknown';
            return `• ${f.name} (ID: ${f.id}) - Owner: ${owner}`;
          }),
        ];

        if (filters.length === 0) {
          return { content: [{ type: 'text' as const, text: lines.join('\n') }] };
        }
        return {
          content: [
            {
              type: 'text' as const,
              text: withPresentationHint(
                lines.join('\n'),
                'a table (Filter name, Owner, id) usually scans faster than this flat list.'
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

  // jira_get_filter
  server.registerTool(
    'jira_get_filter',
    {
      title: 'Jira · Read — Get filter details',
      description: 'Get detailed information about a specific filter including JQL query.',
      annotations: { readOnlyHint: true },
      inputSchema: z.object({
        filterId: z.string().describe('Filter ID'),
      }),
    },
    async (args: Record<string, unknown>) => {
      const displayName = getCachedDisplayName(context.accountId);
      logger.debug('jira_get_filter invoked', {
        component: 'mcp/tool',
        tenantId: context.tenantId,
        accountId: context.accountId,
        displayName,
      });
      try {
        const { filterId } = args;

        if (!filterId) {
          return {
            content: [{ type: 'text' as const, text: 'filterId is required' }],
            isError: true,
          };
        }

        const response = await auth.fetch(
          granularJiraScopes('jira_get_filter', true),
          `/rest/api/3/filter/${filterId}?expand=owner,jql`
        );
        if (!response.ok) return errText(await describeJiraAuthFailure(response));

        const filter = (await response.json()) as any;

        const lines = [
          `Filter: ${filter.name}`,
          `ID: ${filter.id}`,
          filter.description ? `Description: ${filter.description}` : '',
          `JQL: ${filter.jql}`,
          `Owner: ${filter.owner?.displayName || 'Unknown'}`,
          `Shared: ${filter.sharePermissions?.length > 0 ? 'Yes' : 'No'}`,
        ].filter(Boolean);

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

  // jira_create_filter
  server.registerTool(
    'jira_create_filter',
    {
      title: 'Jira · Act — Create a filter',
      description: 'Create a new saved filter using a JQL query.',
      annotations: { readOnlyHint: false },
      inputSchema: z.object({
        name: z.string().describe('Filter name'),
        jql: z.string().describe('JQL query string'),
        description: z.string().describe('Filter description').optional(),
        favourite: z.boolean().describe('Add to favorites?').optional(),
      }),
    },
    async (args: Record<string, unknown>) => {
      const displayName = getCachedDisplayName(context.accountId);
      logger.debug('jira_create_filter invoked', {
        component: 'mcp/tool',
        tenantId: context.tenantId,
        accountId: context.accountId,
        displayName,
      });
      try {
        const { name, jql, description, favourite } = args;

        if (!name || !jql) {
          return {
            content: [
              {
                type: 'text' as const,
                text: 'name and jql are required',
              },
            ],
            isError: true,
          };
        }

        const body: any = {
          name: name as string,
          jql: jql as string,
        };

        if (description) body.description = description as string;
        if (favourite) body.favourite = favourite as boolean;

        const response = await auth.fetch(
          granularJiraScopes('jira_create_filter', false),
          '/rest/api/3/filter',
          {
            method: 'POST',
            body: JSON.stringify(body),
          }
        );
        if (!response.ok) return errText(await describeJiraAuthFailure(response));

        const filter = (await response.json()) as any;

        const lines = [`Filter created: ${filter.name}`, `ID: ${filter.id}`, `JQL: ${filter.jql}`];

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

  // jira_delete_filter
  server.registerTool(
    'jira_delete_filter',
    {
      title: 'Jira · Act — Delete a filter',
      description: 'Delete a saved filter.',
      annotations: { readOnlyHint: false },
      inputSchema: z.object({
        filterId: z.string().describe('Filter ID'),
      }),
    },
    async (args: Record<string, unknown>) => {
      const displayName = getCachedDisplayName(context.accountId);
      logger.debug('jira_delete_filter invoked', {
        component: 'mcp/tool',
        tenantId: context.tenantId,
        accountId: context.accountId,
        displayName,
      });
      try {
        const { filterId } = args;

        if (!filterId) {
          return {
            content: [{ type: 'text' as const, text: 'filterId is required' }],
            isError: true,
          };
        }

        const response = await auth.fetch(
          granularJiraScopes('jira_delete_filter', false),
          `/rest/api/3/filter/${filterId}?expand=owner,jql`,
          { method: 'DELETE' }
        );
        if (!response.ok) return errText(await describeJiraAuthFailure(response));

        return {
          content: [{ type: 'text' as const, text: `Filter ${filterId} deleted` }],
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
