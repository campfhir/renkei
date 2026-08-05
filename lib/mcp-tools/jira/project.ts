/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/consistent-type-assertions */
/**
 * Project structure tools for Jira MCP.
 * Discover components, fields, versions, and users.
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/server';
import type { MCPToolContext } from '../common';
import { jiraFetch } from '../common';

export async function registerProjectTools(
  server: McpServer,
  context: MCPToolContext
): Promise<void> {
  // list_components
  server.registerTool(
    'list_components',
    {
      title: 'List components in a project',
      description: 'List components in a Jira project.',
      annotations: { readOnlyHint: true },
      inputSchema: z.object({
        projectKey: z.string().describe('Project key, e.g. SCRUM'),
      }),
    },
    async (args: Record<string, unknown>) => {
      try {
        const { projectKey } = args;

        if (!projectKey) {
          return {
            content: [{ type: 'text' as const, text: 'projectKey is required' }],
            isError: true,
          };
        }

        const response = await jiraFetch(
          `${context.siteUrl}/rest/api/3/project/${projectKey}/components`,
          context.accessToken
        );

        const data = (await response.json()) as any;
        const components = Array.isArray(data) ? data : data.values || [];

        const lines = [
          `Project ${projectKey} has ${components.length} components:`,
          ...components.map((c: any) => `• ${c.name} (ID: ${c.id})`),
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

  // list_fields
  server.registerTool(
    'list_fields',
    {
      title: 'List all issue fields (standard and custom)',
      description: 'List all fields available in a Jira project.',
      annotations: { readOnlyHint: true },
      inputSchema: z.object({
        projectKey: z.string().describe('Project key, e.g. SCRUM (optional)').optional(),
      }),
    },
    async (_args: Record<string, unknown>) => {
      try {
        const response = await jiraFetch(
          `${context.siteUrl}/rest/api/3/field`,
          context.accessToken
        );

        const fields = (await response.json()) as any[];

        const lines = [
          `Found ${fields.length} fields:`,
          ...fields
            .slice(0, 50)
            .map((f: any) => `• ${f.name} (${f.id}) - ${f.schema?.type || 'unknown'}`),
          fields.length > 50 ? `... and ${fields.length - 50} more` : '',
        ];

        return { content: [{ type: 'text' as const, text: lines.filter(Boolean).join('\n') }] };
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

  // search_users
  server.registerTool(
    'search_users',
    {
      title: 'Search Jira users by name or email',
      description: 'Search for Jira users by email or name.',
      annotations: { readOnlyHint: true },
      inputSchema: z.object({
        query: z.string().describe('Email or name to search for'),
        maxResults: z.number().describe('Maximum results (1-50, default 10)').optional(),
      }),
    },
    async (args: Record<string, unknown>) => {
      try {
        const { query, maxResults = 10 } = args;

        if (!query) {
          return { content: [{ type: 'text' as const, text: 'query is required' }], isError: true };
        }

        const response = await jiraFetch(
          `${context.siteUrl}/rest/api/3/user/search?query=${encodeURIComponent(query as string)}&maxResults=${Math.min(maxResults as number, 50)}`,
          context.accessToken
        );

        const users = (await response.json()) as any[];

        const lines = [
          `Found ${users.length} users:`,
          ...users.map((u: any) => `• ${u.displayName} (${u.emailAddress}) - ${u.accountId}`),
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

  // list_transitions
  server.registerTool(
    'list_transitions',
    {
      title: 'List available Jira transitions',
      description: 'List available transitions for an issue.',
      annotations: { readOnlyHint: true },
      inputSchema: z.object({
        issueKey: z.string().describe('Issue key, e.g. PROJ-123'),
      }),
    },
    async (args: Record<string, unknown>) => {
      try {
        const { issueKey } = args;

        if (!issueKey) {
          return {
            content: [{ type: 'text' as const, text: 'issueKey is required' }],
            isError: true,
          };
        }

        const response = await jiraFetch(
          `${context.siteUrl}/rest/api/3/issue/${issueKey}/transitions`,
          context.accessToken
        );

        const data = (await response.json()) as any;
        const transitions = data.transitions || [];

        const lines = [
          `${issueKey} has ${transitions.length} available transitions:`,
          ...transitions.map((t: any) => `• ${t.name}`),
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
