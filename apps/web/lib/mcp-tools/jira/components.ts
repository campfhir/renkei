/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/consistent-type-assertions */
/**
 * Component tools for Jira MCP.
 * Manage project components and categorization.
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/server';
import type { MCPToolContext } from '../common';
import { getCachedDisplayName } from '../common';
import { logger } from '@/lib/logger';
import { granularJiraScopes, describeJiraAuthFailure, type JiraAuth } from './jira-auth';
import { resolveUserId } from './resolve-user';
import { resolveProject } from './work-types';

function errText(value: string) {
  return { content: [{ type: 'text' as const, text: value }], isError: true };
}

export async function registerComponentTools(
  server: McpServer,
  context: MCPToolContext,
  auth: JiraAuth
): Promise<void> {
  // jira_list_components (already exists in project.ts, but we can add more functionality)
  // jira_get_component
  server.registerTool(
    'jira_get_component',
    {
      title: 'Jira · Read — Get component details',
      description: 'Get detailed information about a specific component.',
      annotations: { readOnlyHint: true },
      inputSchema: z.object({
        componentId: z.string().describe('Component ID'),
      }),
    },
    async (args: Record<string, unknown>) => {
      const displayName = getCachedDisplayName(context.accountId);
      logger.debug('jira_get_component invoked', {
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

        const response = await auth.fetch(
          granularJiraScopes('jira_get_component', true),
          `/rest/api/3/component/${componentId}`
        );
        if (!response.ok) return errText(await describeJiraAuthFailure(response));

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

  // jira_create_component
  server.registerTool(
    'jira_create_component',
    {
      title: 'Jira · Act — Create a project component',
      description: 'Create a new component in a project.',
      annotations: { readOnlyHint: false },
      inputSchema: z.object({
        projectKey: z.string().describe('Project key or numeric ID, e.g. SCRUM'),
        name: z.string().describe('Component name'),
        description: z.string().describe('Component description').optional(),
        lead: z.string().describe('Email address or account ID of the component lead').optional(),
      }),
    },
    async (args: Record<string, unknown>) => {
      const displayName = getCachedDisplayName(context.accountId);
      logger.debug('jira_create_component invoked', {
        component: 'mcp/tool',
        tenantId: context.tenantId,
        accountId: context.accountId,
        displayName,
      });
      try {
        const { projectKey, name, description, lead } = args;

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

        // Create is POST /component with the project KEY in the body —
        // /project/{key}/component only answers GET. Resolving first turns a
        // lowercase key or a numeric ID into the key Jira expects.
        const project = await resolveProject(auth, String(projectKey));
        if (!project.ok) return errText(project.reason);

        const body: any = {
          name: name as string,
          project: project.project.key,
        };

        if (description) body.description = description as string;
        // Jira Cloud identifies the lead by accountId only; a user key or
        // email in the body is dropped or refused (resolve-user.ts).
        if (typeof lead === 'string' && lead.trim()) {
          const resolved = await resolveUserId(auth, lead);
          if (!resolved.ok) return errText(`Component lead: ${resolved.reason}`);
          body.leadAccountId = resolved.id;
        }

        const response = await auth.fetch(
          granularJiraScopes('jira_create_component', false),
          '/rest/api/3/component',
          {
            method: 'POST',
            body: JSON.stringify(body),
          }
        );
        if (!response.ok) return errText(await describeJiraAuthFailure(response));

        const component = (await response.json()) as any;

        const lines = [
          `Component created: ${component.name}`,
          `ID: ${component.id}`,
          `Project: ${project.project.key}`,
          component.description ? `Description: ${component.description}` : '',
          component.lead?.displayName ? `Lead: ${component.lead.displayName}` : '',
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

  // jira_delete_component
  server.registerTool(
    'jira_delete_component',
    {
      title: 'Jira · Act — Delete a component',
      description: 'Delete a component from a project.',
      annotations: { readOnlyHint: false },
      inputSchema: z.object({
        componentId: z.string().describe('Component ID'),
        moveIssuesTo: z.string().describe('Component ID to move issues to (optional)').optional(),
      }),
    },
    async (args: Record<string, unknown>) => {
      const displayName = getCachedDisplayName(context.accountId);
      logger.debug('jira_delete_component invoked', {
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

        let path = `/rest/api/3/component/${componentId}`;
        if (moveIssuesTo) {
          path += `?moveIssuesTo=${encodeURIComponent(moveIssuesTo as string)}`;
        }

        const response = await auth.fetch(
          granularJiraScopes('jira_delete_component', false),
          path,
          { method: 'DELETE' }
        );
        if (!response.ok) return errText(await describeJiraAuthFailure(response));

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
