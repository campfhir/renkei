/**
 * Project structure tools for Jira MCP.
 * Discover components, fields, versions, and users.
 */

import type { MCPToolContext, MCPToolResult } from '../common';
import { ok, toolError, jiraFetch } from '../common';

export interface ProjectToolHandler {
  name: string;
  description: string;
  inputSchema?: Record<string, any>;
  handler: (context: MCPToolContext, params: any) => Promise<MCPToolResult>;
}

export const projectTools: ProjectToolHandler[] = [
  {
    name: 'list_components',
    description: 'List components in a Jira project.',
    inputSchema: {
      type: 'object',
      properties: {
        projectKey: {
          type: 'string',
          description: 'Project key, e.g. SCRUM',
        },
      },
      required: ['projectKey'],
    },
    handler: async (context, params) => {
      const { projectKey } = params;

      if (!projectKey) {
        return toolError('projectKey is required');
      }

      try {
        const response = await jiraFetch(
          `${context.siteUrl}/rest/api/3/project/${projectKey}/components`,
          context.accessToken,
        );

        const data = (await response.json()) as any;
        const components = Array.isArray(data) ? data : data.values || [];

        const lines = [
          `Project ${projectKey} has ${components.length} components:`,
          ...components.map((c: any) => `• ${c.name} (ID: ${c.id})`),
        ];

        return ok(lines.join('\n'));
      } catch (error) {
        return toolError(`Failed to list components: ${error instanceof Error ? error.message : String(error)}`);
      }
    },
  },

  {
    name: 'list_fields',
    description: 'List all fields available in a Jira project.',
    inputSchema: {
      type: 'object',
      properties: {
        projectKey: {
          type: 'string',
          description: 'Project key, e.g. SCRUM (optional)',
        },
      },
    },
    handler: async (context, params) => {
      const { projectKey } = params;

      try {
        const response = await jiraFetch(
          `${context.siteUrl}/rest/api/3/fields`,
          context.accessToken,
        );

        const fields = (await response.json()) as any[];

        const lines = [
          `Found ${fields.length} fields:`,
          ...fields.slice(0, 50).map((f: any) => `• ${f.name} (${f.id}) - ${f.schema?.type || 'unknown'}`),
          fields.length > 50 ? `... and ${fields.length - 50} more` : '',
        ];

        return ok(lines.filter(Boolean).join('\n'));
      } catch (error) {
        return toolError(`Failed to list fields: ${error instanceof Error ? error.message : String(error)}`);
      }
    },
  },

  {
    name: 'search_users',
    description: 'Search for Jira users by email or name.',
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Email or name to search for',
        },
        maxResults: {
          type: 'number',
          description: 'Maximum results (1-50, default 10)',
        },
      },
      required: ['query'],
    },
    handler: async (context, params) => {
      const { query, maxResults = 10 } = params;

      if (!query) {
        return toolError('query is required');
      }

      try {
        const response = await jiraFetch(
          `${context.siteUrl}/rest/api/3/user/search?query=${encodeURIComponent(query)}&maxResults=${Math.min(maxResults, 50)}`,
          context.accessToken,
        );

        const users = (await response.json()) as any[];

        const lines = [
          `Found ${users.length} users:`,
          ...users.map((u: any) => `• ${u.displayName} (${u.emailAddress}) - ${u.accountId}`),
        ];

        return ok(lines.join('\n'));
      } catch (error) {
        return toolError(`Failed to search users: ${error instanceof Error ? error.message : String(error)}`);
      }
    },
  },

  {
    name: 'list_transitions',
    description: 'List available transitions for an issue.',
    inputSchema: {
      type: 'object',
      properties: {
        issueKey: {
          type: 'string',
          description: 'Issue key, e.g. PROJ-123',
        },
      },
      required: ['issueKey'],
    },
    handler: async (context, params) => {
      const { issueKey } = params;

      if (!issueKey) {
        return toolError('issueKey is required');
      }

      try {
        const response = await jiraFetch(
          `${context.siteUrl}/rest/api/3/issue/${issueKey}/transitions`,
          context.accessToken,
        );

        const data = (await response.json()) as any;
        const transitions = data.transitions || [];

        const lines = [
          `${issueKey} has ${transitions.length} available transitions:`,
          ...transitions.map((t: any) => `• ${t.name}`),
        ];

        return ok(lines.join('\n'));
      } catch (error) {
        return toolError(`Failed to list transitions: ${error instanceof Error ? error.message : String(error)}`);
      }
    },
  },
];
