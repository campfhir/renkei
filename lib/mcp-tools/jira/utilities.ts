/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Utility tools for Jira MCP.
 * Miscellaneous helpful operations.
 */

import type { MCPToolContext, MCPToolResult } from '../common';
import { ok, toolError } from '../common';

export interface UtilityToolHandler {
  name: string;
  description: string;
  inputSchema?: Record<string, any>;
  handler: (context: MCPToolContext, params: any) => Promise<MCPToolResult>;
}

export const utilityTools: UtilityToolHandler[] = [
  {
    name: 'analyze_transcript',
    description:
      'Analyze a transcript and extract action items, decisions, and key discussion points.',
    inputSchema: {
      type: 'object',
      properties: {
        transcript: {
          type: 'string',
          description: 'Meeting or conversation transcript',
        },
        issueKey: {
          type: 'string',
          description: 'Optional issue key to associate with findings',
        },
      },
      required: ['transcript'],
    },
    handler: async (context, params) => {
      const { transcript, issueKey } = params;

      if (!transcript) {
        return toolError('transcript is required');
      }

      try {
        // Simple transcript analysis - extract lines that look like action items
        const lines = transcript.split('\n');
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

        return ok(summary.join('\n'));
      } catch (error) {
        return toolError(
          `Failed to analyze transcript: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    },
  },
  {
    name: 'connect_jira',
    description:
      'Get the Jira authentication URL to connect your Jira workspace to this tenant. Call this if Jira is not yet connected.',
    handler: async (context) => {
      const { db, tenantId, config } = context;

      if (!db || !config) {
        return toolError('Database or config not available');
      }

      try {
        // Check if a Jira grant already exists for this tenant
        const existingGrant = await db
          .selectFrom('atlassian_grants')
          .select(['operator_name', 'site_url'])
          .where('tenant_id', '=', tenantId)
          .executeTakeFirst();

        if (existingGrant) {
          return ok(
            `Jira is already connected as ${existingGrant.operator_name} at ${existingGrant.site_url}`
          );
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

        return ok(
          `**Jira is not connected yet.**\n\n` +
            `Please visit this URL to authenticate and connect your Jira workspace:\n\n` +
            `${authUrl}\n\n` +
            `After authentication, you'll be redirected back to complete the connection.`
        );
      } catch (error) {
        return toolError(
          `Failed to get Jira auth URL: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    },
  },
];
