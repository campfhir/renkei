/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/consistent-type-assertions */
/**
 * Issue linking tools for Jira MCP.
 * Create and manage relationships between issues.
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/server';
import type { MCPToolContext } from '../common';
import { jiraFetch, getCachedDisplayName } from '../common';
import { logger } from '@/lib/logger';

export async function registerIssueLinkTools(
  server: McpServer,
  context: MCPToolContext
): Promise<void> {
  // list_link_types
  server.registerTool(
    'list_link_types',
    {
      title: 'List available issue link types',
      description: 'List all issue link types available in the Jira instance.',
      annotations: { readOnlyHint: true },
      inputSchema: z.object({}),
    },
    async (_args: Record<string, unknown>) => {
      const displayName = getCachedDisplayName(context.accountId);
      logger.info('[Tool] list_link_types invoked', {
        tenantId: context.tenantId,
        accountId: context.accountId,
        displayName,
      });
      try {
        const response = await jiraFetch(
          `${context.apiBaseUrl}/rest/api/3/issueLinkType`,
          context.accessToken
        );

        const data = (await response.json()) as any;
        const linkTypes = data.issueLinkTypes || [];

        const lines = [
          `Found ${linkTypes.length} issue link types:`,
          ...linkTypes.map((lt: any) => `• ${lt.name} (${lt.id}): ${lt.description || 'N/A'}`),
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

  // create_issue_link
  server.registerTool(
    'create_issue_link',
    {
      title: 'Create an issue link',
      description: 'Create a relationship between two issues.',
      annotations: { readOnlyHint: false },
      inputSchema: z.object({
        linkType: z.string().describe('Link type name, e.g. "blocks", "relates to", "duplicates"'),
        fromIssueKey: z.string().describe('Source issue key, e.g. PROJ-123'),
        toIssueKey: z.string().describe('Target issue key, e.g. PROJ-456'),
      }),
    },
    async (args: Record<string, unknown>) => {
      const displayName = getCachedDisplayName(context.accountId);
      logger.info('[Tool] create_issue_link invoked', {
        tenantId: context.tenantId,
        accountId: context.accountId,
        displayName,
      });
      try {
        const { linkType, fromIssueKey, toIssueKey } = args;

        if (!linkType || !fromIssueKey || !toIssueKey) {
          return {
            content: [
              {
                type: 'text' as const,
                text: 'linkType, fromIssueKey, and toIssueKey are required',
              },
            ],
            isError: true,
          };
        }

        const body = {
          type: {
            name: linkType as string,
          },
          inwardIssue: {
            key: fromIssueKey as string,
          },
          outwardIssue: {
            key: toIssueKey as string,
          },
        };

        const response = await jiraFetch(
          `${context.apiBaseUrl}/rest/api/3/issueLink`,
          context.accessToken,
          {
            method: 'POST',
            body: JSON.stringify(body),
          }
        );

        // The API returns 201 Created with no body, so don't try to parse JSON
        if (!response.ok) {
          throw new Error(`Failed to create link: ${response.statusText}`);
        }

        const lines = [`Link created: ${fromIssueKey} ${linkType} ${toIssueKey}`];

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

  // delete_issue_link
  server.registerTool(
    'delete_issue_link',
    {
      title: 'Delete an issue link',
      description: 'Remove a relationship between two issues.',
      annotations: { readOnlyHint: false },
      inputSchema: z.object({
        linkId: z.string().describe('ID of the link to delete'),
      }),
    },
    async (args: Record<string, unknown>) => {
      const displayName = getCachedDisplayName(context.accountId);
      logger.info('[Tool] delete_issue_link invoked', {
        tenantId: context.tenantId,
        accountId: context.accountId,
        displayName,
      });
      try {
        const { linkId } = args;

        if (!linkId) {
          return {
            content: [{ type: 'text' as const, text: 'linkId is required' }],
            isError: true,
          };
        }

        await jiraFetch(
          `${context.apiBaseUrl}/rest/api/3/issueLink/${linkId}`,
          context.accessToken,
          { method: 'DELETE' }
        );

        return {
          content: [{ type: 'text' as const, text: `Link ${linkId} deleted` }],
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
