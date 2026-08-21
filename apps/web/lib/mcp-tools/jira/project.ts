/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/consistent-type-assertions */
/**
 * Project structure tools for Jira MCP.
 * Discover components, fields, versions, and users.
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

export async function registerProjectTools(
  server: McpServer,
  context: MCPToolContext,
  auth: JiraAuth
): Promise<void> {
  // jira_list_projects
  server.registerTool(
    'jira_list_projects',
    {
      title: 'Jira · Read — List projects',
      description:
        'List the Jira projects you can see, with their keys. Every tool that takes a projectKey ' +
        'wants one of these. Covers software, business and service-desk projects alike — a JSM ' +
        'project is a Jira project, so there is no need to go via jsm_list_service_desks to find ' +
        'a key.',
      annotations: { readOnlyHint: true },
      inputSchema: z.object({
        query: z
          .string()
          .describe('Substring filter on project name or key, e.g. "eng" (optional)')
          .optional(),
        max: z.number().int().min(1).max(100).describe('How many (default 50)').optional(),
      }),
    },
    async (args: Record<string, unknown>) => {
      const displayName = getCachedDisplayName(context.accountId);
      logger.debug('jira_list_projects invoked', {
        component: 'mcp/tool',
        tenantId: context.tenantId,
        accountId: context.accountId,
        displayName,
      });
      try {
        const max = typeof args.max === 'number' ? args.max : 50;
        const query = typeof args.query === 'string' ? args.query.trim() : '';
        const params = [`maxResults=${max}`, 'orderBy=key'];
        if (query) params.push(`query=${encodeURIComponent(query)}`);
        const response = await auth.fetch(
          granularJiraScopes('jira_list_projects', true),
          `/rest/api/3/project/search?${params.join('&')}`
        );
        if (!response.ok) return errText(await describeJiraAuthFailure(response));
        const data = (await response.json()) as any;
        const projects = Array.isArray(data?.values) ? data.values : [];
        if (projects.length === 0) {
          return {
            content: [
              {
                type: 'text' as const,
                text: query ? `No projects match "${query}".` : 'No projects visible to you.',
              },
            ],
          };
        }
        const lines = projects.map(
          (project: any) =>
            `• ${project.name} — key: ${project.key}` +
            (project.projectTypeKey ? ` — ${project.projectTypeKey}` : '')
        );
        return {
          content: [
            {
              type: 'text' as const,
              text: withPresentationHint(
                [`${projects.length} project(s):`, ...lines].join('\n'),
                'a table (Name, Key, Type) usually scans faster than this flat list.'
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

  // jira_list_components
  server.registerTool(
    'jira_list_components',
    {
      title: 'Jira · Read — List components in a project',
      description: 'List components in a Jira project.',
      annotations: { readOnlyHint: true },
      inputSchema: z.object({
        projectKey: z.string().describe('Project key, e.g. SCRUM'),
      }),
    },
    async (args: Record<string, unknown>) => {
      const displayName = getCachedDisplayName(context.accountId);
      logger.debug('jira_list_components invoked', {
        component: 'mcp/tool',
        tenantId: context.tenantId,
        accountId: context.accountId,
        displayName,
      });
      try {
        const { projectKey } = args;

        if (!projectKey) {
          return {
            content: [{ type: 'text' as const, text: 'projectKey is required' }],
            isError: true,
          };
        }

        const response = await auth.fetch(
          granularJiraScopes('jira_list_components', true),
          `/rest/api/3/project/${projectKey}/components`
        );
        if (!response.ok) return errText(await describeJiraAuthFailure(response));

        const data = (await response.json()) as any;
        const components = Array.isArray(data) ? data : data.values || [];

        const lines = [
          `Project ${projectKey} has ${components.length} components:`,
          ...components.map((c: any) => `• ${c.name} (ID: ${c.id})`),
        ];

        if (components.length === 0) {
          return { content: [{ type: 'text' as const, text: lines.join('\n') }] };
        }
        return {
          content: [
            {
              type: 'text' as const,
              text: withPresentationHint(
                lines.join('\n'),
                'a table (Component, Lead, id) usually scans faster than this flat list.'
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

  // jira_list_fields
  server.registerTool(
    'jira_list_fields',
    {
      title: 'Jira · Read — List all issue fields (standard and custom)',
      description: 'List all fields available in a Jira project.',
      annotations: { readOnlyHint: true },
      inputSchema: z.object({
        projectKey: z.string().describe('Project key, e.g. SCRUM (optional)').optional(),
        query: z
          .string()
          .describe('Substring filter on field name or id, e.g. "change" (optional)')
          .optional(),
      }),
    },
    async (args: Record<string, unknown>) => {
      const displayName = getCachedDisplayName(context.accountId);
      logger.debug('jira_list_fields invoked', {
        component: 'mcp/tool',
        tenantId: context.tenantId,
        accountId: context.accountId,
        displayName,
      });
      try {
        const response = await auth.fetch(
          granularJiraScopes('jira_list_fields', true),
          '/rest/api/3/field'
        );
        if (!response.ok) return errText(await describeJiraAuthFailure(response));

        const fields = (await response.json()) as any[];

        // 378 fields on a real site makes unfiltered paging blind — a
        // substring filter turns this into a usable lookup.
        const query = typeof args.query === 'string' ? args.query.toLowerCase() : '';
        const matching = query
          ? fields.filter(
              (f: any) =>
                String(f.name ?? '')
                  .toLowerCase()
                  .includes(query) ||
                String(f.id ?? '')
                  .toLowerCase()
                  .includes(query)
            )
          : fields;

        const lines = [
          query
            ? `${matching.length} of ${fields.length} fields match "${args.query}":`
            : `Found ${fields.length} fields:`,
          ...matching
            .slice(0, 50)
            .map((f: any) => `• ${f.name} (${f.id}) - ${f.schema?.type || 'unknown'}`),
          matching.length > 50 ? `... and ${matching.length - 50} more` : '',
        ];
        const text = lines.filter(Boolean).join('\n');

        if (matching.length === 0) {
          return { content: [{ type: 'text' as const, text }] };
        }
        return {
          content: [
            {
              type: 'text' as const,
              text: withPresentationHint(
                text,
                'a table (Field name, id, Type) usually scans faster than this flat list — ' +
                  'there can be dozens of custom fields.'
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

  // jira_search_users
  server.registerTool(
    'jira_search_users',
    {
      title: 'Jira · Read — Search Jira users by name or email',
      description: 'Search for Jira users by email or name.',
      annotations: { readOnlyHint: true },
      inputSchema: z.object({
        query: z.string().describe('Email or name to search for'),
        maxResults: z.number().describe('Maximum results (1-50, default 10)').optional(),
      }),
    },
    async (args: Record<string, unknown>) => {
      const displayName = getCachedDisplayName(context.accountId);
      logger.debug('jira_search_users invoked', {
        component: 'mcp/tool',
        tenantId: context.tenantId,
        accountId: context.accountId,
        displayName,
      });
      try {
        const { query, maxResults = 10 } = args;

        if (!query) {
          return { content: [{ type: 'text' as const, text: 'query is required' }], isError: true };
        }

        const response = await auth.fetch(
          granularJiraScopes('jira_search_users', true),
          `/rest/api/3/user/search?query=${encodeURIComponent(query as string)}&maxResults=${Math.min(maxResults as number, 50)}`
        );
        if (!response.ok) return errText(await describeJiraAuthFailure(response));

        const users = (await response.json()) as any[];

        const lines = [
          `Found ${users.length} users:`,
          ...users.map((u: any) => `• ${u.displayName} (${u.emailAddress}) - ${u.accountId}`),
        ];

        if (users.length === 0) {
          return { content: [{ type: 'text' as const, text: lines.join('\n') }] };
        }
        return {
          content: [
            {
              type: 'text' as const,
              text: withPresentationHint(
                lines.join('\n'),
                'a table (Name, Email, Account id) usually scans faster than this flat list.'
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

  // jira_list_transitions
  server.registerTool(
    'jira_list_transitions',
    {
      title: 'Jira · Read — List available Jira transitions',
      description: 'List available transitions for an issue.',
      annotations: { readOnlyHint: true },
      inputSchema: z.object({
        issueKey: z.string().describe('Issue key, e.g. PROJ-123'),
      }),
    },
    async (args: Record<string, unknown>) => {
      const displayName = getCachedDisplayName(context.accountId);
      logger.debug('jira_list_transitions invoked', {
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
          granularJiraScopes('jira_list_transitions', true),
          `/rest/api/3/issue/${issueKey}/transitions`
        );
        if (!response.ok) return errText(await describeJiraAuthFailure(response));

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
