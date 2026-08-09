/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/consistent-type-assertions */
/**
 * Version (release) tools for Jira MCP.
 * List and manage project versions and releases.
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/server';
import type { MCPToolContext } from '../common';
import { jiraFetch, getCachedDisplayName } from '../common';
import { logger } from '@/lib/logger';

export async function registerVersionTools(
  server: McpServer,
  context: MCPToolContext
): Promise<void> {
  // jira_list_versions
  server.registerTool(
    'jira_list_versions',
    {
      title: 'Jira · Read — List project versions',
      description: 'List all versions/releases in a project.',
      annotations: { readOnlyHint: true },
      inputSchema: z.object({
        projectKey: z.string().describe('Project key, e.g. SCRUM'),
        orderBy: z
          .enum(['sequence', 'name', 'startDate', 'releaseDate'])
          .describe('Sort order (default: sequence)')
          .optional(),
        expand: z.string().describe('Additional fields to expand (e.g. "changelog")').optional(),
      }),
    },
    async (args: Record<string, unknown>) => {
      const displayName = getCachedDisplayName(context.accountId);
      logger.info('jira_list_versions invoked', {
        component: 'mcp/tool',
        tenantId: context.tenantId,
        accountId: context.accountId,
        displayName,
      });
      try {
        const { projectKey, orderBy = 'sequence', expand } = args;

        if (!projectKey) {
          return {
            content: [{ type: 'text' as const, text: 'projectKey is required' }],
            isError: true,
          };
        }

        let url = `${context.apiBaseUrl}/rest/api/3/project/${projectKey}/versions?orderBy=${orderBy}`;
        if (expand) {
          url += `&expand=${encodeURIComponent(expand as string)}`;
        }

        const response = await jiraFetch(url, context.accessToken);
        const data = (await response.json()) as any;
        // /project/{key}/versions returns a plain ARRAY — and on an array,
        // `.values` resolves to Array.prototype.values (a function), which
        // made the old `data.values || []` explode on .map.
        const versions = Array.isArray(data)
          ? data
          : Array.isArray(data?.values)
            ? data.values
            : [];

        const lines = [
          `Project ${projectKey} has ${versions.length} versions:`,
          ...versions.map((v: any) => {
            const status = v.released ? '(Released)' : v.archived ? '(Archived)' : '(Unreleased)';
            const date = v.releaseDate || v.startDate || 'No date';
            return `• ${v.name} ${status} - ${date}`;
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

  // jira_create_version
  server.registerTool(
    'jira_create_version',
    {
      title: 'Jira · Act — Create a project version',
      description: 'Create a new version/release in a project.',
      annotations: { readOnlyHint: false },
      inputSchema: z.object({
        projectKey: z.string().describe('Project key, e.g. SCRUM'),
        name: z.string().describe('Version name, e.g. "1.0.0"'),
        description: z.string().describe('Version description').optional(),
        startDate: z.string().describe('Start date in YYYY-MM-DD format').optional(),
        releaseDate: z.string().describe('Release date in YYYY-MM-DD format').optional(),
        released: z.boolean().describe('Is this version released?').optional(),
      }),
    },
    async (args: Record<string, unknown>) => {
      const displayName = getCachedDisplayName(context.accountId);
      logger.info('jira_create_version invoked', {
        component: 'mcp/tool',
        tenantId: context.tenantId,
        accountId: context.accountId,
        displayName,
      });
      try {
        const { projectKey, name, description, startDate, releaseDate, released } = args;

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
        if (startDate) body.startDate = startDate as string;
        if (releaseDate) body.releaseDate = releaseDate as string;
        if (released !== undefined) body.released = released as boolean;

        const response = await jiraFetch(
          `${context.apiBaseUrl}/rest/api/3/project/${projectKey}/version`,
          context.accessToken,
          {
            method: 'POST',
            body: JSON.stringify(body),
          }
        );

        const version = (await response.json()) as any;

        const lines = [
          `Version created: ${version.name}`,
          `ID: ${version.id}`,
          version.description ? `Description: ${version.description}` : '',
          `Released: ${version.released || false}`,
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

  // jira_get_version
  server.registerTool(
    'jira_get_version',
    {
      title: 'Jira · Read — Get version details',
      description: 'Get detailed information about a specific version.',
      annotations: { readOnlyHint: true },
      inputSchema: z.object({
        versionId: z.string().describe('Version ID'),
      }),
    },
    async (args: Record<string, unknown>) => {
      const displayName = getCachedDisplayName(context.accountId);
      logger.info('jira_get_version invoked', {
        component: 'mcp/tool',
        tenantId: context.tenantId,
        accountId: context.accountId,
        displayName,
      });
      try {
        const { versionId } = args;

        if (!versionId) {
          return {
            content: [{ type: 'text' as const, text: 'versionId is required' }],
            isError: true,
          };
        }

        const response = await jiraFetch(
          `${context.apiBaseUrl}/rest/api/3/version/${versionId}`,
          context.accessToken
        );

        const version = (await response.json()) as any;

        const lines = [
          `Version: ${version.name}`,
          `ID: ${version.id}`,
          version.description ? `Description: ${version.description}` : '',
          `Status: ${version.released ? 'Released' : version.archived ? 'Archived' : 'Unreleased'}`,
          version.startDate ? `Start Date: ${version.startDate}` : '',
          version.releaseDate ? `Release Date: ${version.releaseDate}` : '',
          version.userReleaseDate ? `User Release Date: ${version.userReleaseDate}` : '',
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
}
