/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/consistent-type-assertions */
/**
 * User and group management tools for Jira MCP.
 * Search users, manage groups, and resolve user information.
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/server';
import type { MCPToolContext } from '../common';
import { jiraFetch, getCachedDisplayName } from '../common';
import { logger } from '@/lib/logger';

export async function registerUserTools(server: McpServer, context: MCPToolContext): Promise<void> {
  // jira_list_users
  server.registerTool(
    'jira_list_users',
    {
      title: 'Jira · Read — List Jira users',
      description: 'List users with optional search and pagination.',
      annotations: { readOnlyHint: true },
      inputSchema: z.object({
        query: z.string().describe('Search query (email or name) - optional').optional(),
        maxResults: z.number().describe('Maximum results to return (1-50, default 10)').optional(),
      }),
    },
    async (args: Record<string, unknown>) => {
      const displayName = getCachedDisplayName(context.accountId);
      logger.info('jira_list_users invoked', {
        component: 'mcp/tool',
        tenantId: context.tenantId,
        accountId: context.accountId,
        displayName,
      });
      try {
        const { query, maxResults = 10 } = args;
        const limit = Math.min(maxResults as number, 50);

        // /users/search is get-ALL-users and silently ignores `query` — it
        // returned page 1 of the directory for every search, which looked
        // plausible and was always wrong. Filtering lives on /user/search.
        const url = query
          ? `${context.apiBaseUrl}/rest/api/3/user/search?maxResults=${limit}&query=${encodeURIComponent(query as string)}`
          : `${context.apiBaseUrl}/rest/api/3/users/search?maxResults=${limit}`;

        const response = await jiraFetch(url, context.accessToken);
        const users = (await response.json()) as any[];

        const lines = [
          `Found ${users.length} users:`,
          ...users.map(
            (u: any) => `• ${u.displayName} (${u.emailAddress || 'no email'}) - ${u.accountId}`
          ),
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

  // jira_get_user
  server.registerTool(
    'jira_get_user',
    {
      title: 'Jira · Read — Get user details',
      description: 'Get detailed information about a specific user by account ID or email.',
      annotations: { readOnlyHint: true },
      inputSchema: z.object({
        accountId: z.string().describe('User account ID'),
      }),
    },
    async (args: Record<string, unknown>) => {
      const displayName = getCachedDisplayName(context.accountId);
      logger.info('jira_get_user invoked', {
        component: 'mcp/tool',
        tenantId: context.tenantId,
        accountId: context.accountId,
        displayName,
      });
      try {
        const { accountId } = args;

        if (!accountId) {
          return {
            content: [{ type: 'text' as const, text: 'accountId is required' }],
            isError: true,
          };
        }

        const response = await jiraFetch(
          `${context.apiBaseUrl}/rest/api/3/user?accountId=${encodeURIComponent(accountId as string)}`,
          context.accessToken
        );

        const user = (await response.json()) as any;

        const lines = [
          `User: ${user.displayName}`,
          `Email: ${user.emailAddress}`,
          `Account ID: ${user.accountId}`,
          `Active: ${user.active}`,
          `Avatar: ${user.avatarUrls?.['16x16'] || 'N/A'}`,
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

  // jira_list_groups
  server.registerTool(
    'jira_list_groups',
    {
      title: 'Jira · Read — List Jira groups',
      description: 'List all groups or search for groups by name.',
      annotations: { readOnlyHint: true },
      inputSchema: z.object({
        query: z.string().describe('Search query - optional').optional(),
        maxResults: z.number().describe('Maximum results to return (default 10)').optional(),
      }),
    },
    async (args: Record<string, unknown>) => {
      const displayName = getCachedDisplayName(context.accountId);
      logger.info('jira_list_groups invoked', {
        component: 'mcp/tool',
        tenantId: context.tenantId,
        accountId: context.accountId,
        displayName,
      });
      try {
        const { query, maxResults = 10 } = args;

        let url = `${context.apiBaseUrl}/rest/api/3/groups/picker?maxResults=${Math.min(maxResults as number, 50)}`;
        if (query) {
          url += `&query=${encodeURIComponent(query as string)}`;
        }

        const response = await jiraFetch(url, context.accessToken);
        const data = (await response.json()) as any;
        const groups = data.groups || [];

        const lines = [`Found ${groups.length} groups:`, ...groups.map((g: any) => `• ${g.name}`)];

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

  // jira_list_group_members
  server.registerTool(
    'jira_list_group_members',
    {
      title: 'Jira · Read — List members of a group',
      description: 'List all members of a specific group.',
      annotations: { readOnlyHint: true },
      inputSchema: z.object({
        groupName: z.string().describe('Name of the group'),
        maxResults: z.number().describe('Maximum results to return (default 10)').optional(),
      }),
    },
    async (args: Record<string, unknown>) => {
      const displayName = getCachedDisplayName(context.accountId);
      logger.info('jira_list_group_members invoked', {
        component: 'mcp/tool',
        tenantId: context.tenantId,
        accountId: context.accountId,
        displayName,
      });
      try {
        const { groupName, maxResults = 10 } = args;

        if (!groupName) {
          return {
            content: [{ type: 'text' as const, text: 'groupName is required' }],
            isError: true,
          };
        }

        const response = await jiraFetch(
          `${context.apiBaseUrl}/rest/api/3/group/member?groupname=${encodeURIComponent(groupName as string)}&maxResults=${Math.min(maxResults as number, 50)}`,
          context.accessToken
        );

        const data = (await response.json()) as any;
        const members = data.values || [];

        const lines = [
          `Group "${groupName}" has ${members.length} members:`,
          ...members.map((m: any) => `• ${m.displayName} (${m.emailAddress})`),
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

  // jira_get_user_groups
  server.registerTool(
    'jira_get_user_groups',
    {
      title: 'Jira · Read — Get groups for a user',
      description: 'List all groups that a user belongs to.',
      annotations: { readOnlyHint: true },
      inputSchema: z.object({
        accountId: z.string().describe('User account ID'),
      }),
    },
    async (args: Record<string, unknown>) => {
      const displayName = getCachedDisplayName(context.accountId);
      logger.info('jira_get_user_groups invoked', {
        component: 'mcp/tool',
        tenantId: context.tenantId,
        accountId: context.accountId,
        displayName,
      });
      try {
        const { accountId } = args;

        if (!accountId) {
          return {
            content: [{ type: 'text' as const, text: 'accountId is required' }],
            isError: true,
          };
        }

        const response = await jiraFetch(
          `${context.apiBaseUrl}/rest/api/3/user/groups?accountId=${encodeURIComponent(accountId as string)}`,
          context.accessToken
        );

        const data = (await response.json()) as any;
        // /user/groups returns a plain ARRAY — `.values` on an array is the
        // built-in iterator method, not data, so the old read crashed .map.
        const groups = Array.isArray(data) ? data : Array.isArray(data?.values) ? data.values : [];

        const lines = [
          `User is member of ${groups.length} groups:`,
          ...groups.map((g: any) => `• ${g.name}`),
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
}
