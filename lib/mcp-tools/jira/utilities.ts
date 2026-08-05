/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Utility tools for Jira MCP.
 * Miscellaneous helpful operations.
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { MCPToolContext } from '../common';

export async function registerUtilityTools(
  server: McpServer,
  context: MCPToolContext
): Promise<void> {
  // analyze_transcript
  server.registerTool(
    'analyze_transcript',
    {
      title: 'Analyze a meeting transcript for Jira actions',
      description:
        'Analyze a transcript and extract action items, decisions, and key discussion points.',
      annotations: { readOnlyHint: true },
      inputSchema: z.object({
        transcript: z.string().describe('Meeting or conversation transcript'),
        issueKey: z.string().describe('Optional issue key to associate with findings').optional(),
      }),
    },
    async (args: Record<string, any>) => {
      try {
        const { transcript, issueKey } = args;

        if (!transcript) {
          return {
            content: [{ type: 'text' as const, text: 'transcript is required' }],
            isError: true,
          };
        }

        // Simple transcript analysis - extract lines that look like action items
        const lines = String(transcript).split('\n');
        const actionItems = lines.filter(
          (line: string) =>
            line.toLowerCase().includes('action item') ||
            line.toLowerCase().includes('todo') ||
            line.toLowerCase().includes('@') ||
            line.toLowerCase().includes('should')
        );

        const decisions = lines.filter(
          (line: string) =>
            line.toLowerCase().includes('decided') ||
            line.toLowerCase().includes('decision') ||
            line.toLowerCase().includes('agreed')
        );

        const summary = [
          '## Transcript Analysis',
          '',
          `**Total lines:** ${lines.length}`,
          `**Action items found:** ${actionItems.length}`,
          `**Decisions found:** ${decisions.length}`,
          '',
        ];

        if (actionItems.length > 0) {
          summary.push('### Action Items');
          actionItems.slice(0, 10).forEach((item: string) => {
            summary.push(`- ${item.trim()}`);
          });
          summary.push('');
        }

        if (decisions.length > 0) {
          summary.push('### Decisions');
          decisions.slice(0, 10).forEach((item: string) => {
            summary.push(`- ${item.trim()}`);
          });
          summary.push('');
        }

        if (issueKey) {
          summary.push(`\n*Analysis for ${issueKey}*`);
        }

        return { content: [{ type: 'text' as const, text: summary.join('\n') }] };
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

  // connect_jira
  server.registerTool(
    'connect_jira',
    {
      title: 'Get Jira authentication URL',
      description:
        'Get the Jira authentication URL to connect your Jira workspace to this tenant. Call this if Jira is not yet connected.',
      annotations: { readOnlyHint: true },
    },
    async (_args: Record<string, any>) => {
      try {
        const { db, tenantId, config } = context;

        if (!db || !config) {
          return {
            content: [{ type: 'text' as const, text: 'Database or config not available' }],
            isError: true,
          };
        }

        // Check if a Jira grant already exists for this tenant
        const existingGrant = await db
          .selectFrom('atlassian_grants')
          .select(['operator_name', 'site_url'])
          .where('tenant_id', '=', tenantId)
          .executeTakeFirst();

        if (existingGrant) {
          return {
            content: [
              {
                type: 'text' as const,
                text: `Jira is already connected as ${existingGrant.operator_name} at ${existingGrant.site_url}`,
              },
            ],
          };
        }

        // Generate the Jira authorization URL
        const params = new URLSearchParams({
          response_type: 'code',
          client_id: config.ATLASSIAN_CLIENT_ID,
          redirect_uri: config.ATLASSIAN_REDIRECT_URI,
          scope: config.ATLASSIAN_SCOPES,
          state: 'jira-setup',
          audience: 'api.atlassian.com',
        });

        const authUrl = `https://auth.atlassian.com/authorize?${params.toString()}`;

        const text =
          `**Jira is not connected yet.**\n\n` +
          `Please visit this URL to authenticate and connect your Jira workspace:\n\n` +
          `${authUrl}\n\n` +
          `After authentication, you'll be redirected back to complete the connection.`;

        return { content: [{ type: 'text' as const, text }] };
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
