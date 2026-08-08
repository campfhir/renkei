/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/consistent-type-assertions */
/**
 * Component tools for Jira MCP.
 * Manage project components and categorization.
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/server';
import type { MCPToolContext } from '../common';
import { jiraFetch, getCachedDisplayName } from '../common';
import { logger } from '@/lib/logger';

export async function registerComponentTools(
  server: McpServer,
  context: MCPToolContext
): Promise<void> {
  // list_components (already exists in project.ts, but we can add more functionality)
  // get_component
  server.registerTool(
    'get_component',
    {
      title: 'Get component details',
      description: 'Get detailed information about a specific component.',
      annotations: { readOnlyHint: true },
      inputSchema: z.object({
        componentId: z.string().describe('Component ID'),
      }),
    },
    async (args: Record<string, unknown>) => {
      const displayName = getCachedDisplayName(context.accountId);
      logger.info('get_component invoked', {
        component: 'mcp/tool',
        tenantId: context.tenantId,
        accountId: context.accountId,
        displayName,
      });
      try {
        const { componentId } = args;

        if (!componentId) {
          return {
            content: [{ type: 'text' as const, text: 'componentId is required' }],
            isError: true,
          };
        }

        const response = await jiraFetch(
          `${context.apiBaseUrl}/rest/api/3/component/${componentId}`,
          context.accessToken
        );

        const component = (await response.json()) as any;

        const lines = [
          `Component: ${component.name}`,
          `ID: ${component.id}`,
          component.description ? `Description: ${component.description}` : '',
          component.lead
            ? `Lead: ${component.lead.displayName} (${component.lead.emailAddress})`
            : '',
          `Project: ${component.project}`,
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

  // create_component
  server.registerTool(
    'create_component',
    {
      title: 'Create a project component',
      description: 'Create a new component in a project.',
      annotations: { readOnlyHint: false },
      inputSchema: z.object({
        projectKey: z.string().describe('Project key, e.g. SCRUM'),
        name: z.string().describe('Component name'),
        description: z.string().describe('Component description').optional(),
        leadUserKey: z.string().describe('User key of the component lead (optional)').optional(),
      }),
    },
    async (args: Record<string, unknown>) => {
      const displayName = getCachedDisplayName(context.accountId);
      logger.info('create_component invoked', {
        component: 'mcp/tool',
        tenantId: context.tenantId,
        accountId: context.accountId,
        displayName,
      });
      try {
        const { projectKey, name, description, leadUserKey } = args;

        if (!projectKey || !name) {
          return {
            content: [
              {
                type: 'text' as const,
                text: 'projectKey and name are required',
              },
            ],
            isError: true,
          };
        }

        const body: any = {
          name: name as string,
        };

        if (description) body.description = description as string;
        if (leadUserKey) body.leadUserKey = leadUserKey as string;

        const response = await jiraFetch(
          `${context.apiBaseUrl}/rest/api/3/project/${projectKey}/component`,
          context.accessToken,
          {
            method: 'POST',
            body: JSON.stringify(body),
          }
        );

        const component = (await response.json()) as any;

        const lines = [
          `Component created: ${component.name}`,
          `ID: ${component.id}`,
          component.description ? `Description: ${component.description}` : '',
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

  // delete_component
  server.registerTool(
    'delete_component',
    {
      title: 'Delete a component',
      description: 'Delete a component from a project.',
      annotations: { readOnlyHint: false },
      inputSchema: z.object({
        componentId: z.string().describe('Component ID'),
        moveIssuesTo: z.string().describe('Component ID to move issues to (optional)').optional(),
      }),
    },
    async (args: Record<string, unknown>) => {
      const displayName = getCachedDisplayName(context.accountId);
      logger.info('delete_component invoked', {
        component: 'mcp/tool',
        tenantId: context.tenantId,
        accountId: context.accountId,
        displayName,
      });
      try {
        const { componentId, moveIssuesTo } = args;

        if (!componentId) {
          return {
            content: [{ type: 'text' as const, text: 'componentId is required' }],
            isError: true,
          };
        }

        let url = `${context.apiBaseUrl}/rest/api/3/component/${componentId}`;
        if (moveIssuesTo) {
          url += `?moveIssuesTo=${encodeURIComponent(moveIssuesTo as string)}`;
        }

        await jiraFetch(url, context.accessToken, { method: 'DELETE' });

        return {
          content: [{ type: 'text' as const, text: `Component ${componentId} deleted` }],
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
