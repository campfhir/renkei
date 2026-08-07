/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/consistent-type-assertions */
/**
 * Filter tools for Jira MCP.
 * Manage saved JQL filters and searches.
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/server';
import type { MCPToolContext } from '../common';
import { jiraFetch, getCachedDisplayName } from '../common';
import { logger } from '@/lib/logger';

export async function registerFilterTools(
  server: McpServer,
  context: MCPToolContext
): Promise<void> {
  // list_filters
  server.registerTool(
    'list_filters',
    {
      title: 'List saved filters',
      description: 'List all filters (saved searches) accessible to the current user.',
      annotations: { readOnlyHint: true },
      inputSchema: z.object({
        expand: z.string().describe('Expand details (e.g. "sharedUsers,subscriptions")').optional(),
      }),
    },
    async (args: Record<string, unknown>) => {
      const displayName = getCachedDisplayName(context.accountId);
      logger.info('[Tool] list_filters invoked', {
        tenantId: context.tenantId,
        accountId: context.accountId,
        displayName,
      });
      try {
        const { expand } = args;

        let url = `${context.apiBaseUrl}/rest/api/3/filter/search?maxResults=50`;
        if (expand) {
          url += `&expand=${encodeURIComponent(expand as string)}`;
        }

        const response = await jiraFetch(url, context.accessToken);
        const data = (await response.json()) as any;
        const filters = data.values || [];

        const lines = [
          `Found ${filters.length} filters:`,
          ...filters.map((f: any) => {
            const owner = f.owner?.displayName || 'Unknown';
            return `• ${f.name} (ID: ${f.id}) - Owner: ${owner}`;
          }),
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

  // get_filter
  server.registerTool(
    'get_filter',
    {
      title: 'Get filter details',
      description: 'Get detailed information about a specific filter including JQL query.',
      annotations: { readOnlyHint: true },
      inputSchema: z.object({
        filterId: z.string().describe('Filter ID'),
      }),
    },
    async (args: Record<string, unknown>) => {
      const displayName = getCachedDisplayName(context.accountId);
      logger.info('[Tool] get_filter invoked', {
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

        const response = await jiraFetch(
          `${context.apiBaseUrl}/rest/api/3/filter/${filterId}`,
          context.accessToken
        );

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

  // create_filter
  server.registerTool(
    'create_filter',
    {
      title: 'Create a filter',
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
      logger.info('[Tool] create_filter invoked', {
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

        const response = await jiraFetch(
          `${context.apiBaseUrl}/rest/api/3/filter`,
          context.accessToken,
          {
            method: 'POST',
            body: JSON.stringify(body),
          }
        );

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

  // delete_filter
  server.registerTool(
    'delete_filter',
    {
      title: 'Delete a filter',
      description: 'Delete a saved filter.',
      annotations: { readOnlyHint: false },
      inputSchema: z.object({
        filterId: z.string().describe('Filter ID'),
      }),
    },
    async (args: Record<string, unknown>) => {
      const displayName = getCachedDisplayName(context.accountId);
      logger.info('[Tool] delete_filter invoked', {
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

        await jiraFetch(
          `${context.apiBaseUrl}/rest/api/3/filter/${filterId}`,
          context.accessToken,
          { method: 'DELETE' }
        );

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
