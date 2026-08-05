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
    description: 'Analyze a transcript and extract action items, decisions, and key discussion points.',
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
        const actionItems = lines.filter((line: string) =>
          line.toLowerCase().includes('action item') ||
          line.toLowerCase().includes('todo') ||
          line.toLowerCase().includes('@') ||
          line.toLowerCase().includes('should'),
        );

        const decisions = lines.filter((line: string) =>
          line.toLowerCase().includes('decided') ||
          line.toLowerCase().includes('decision') ||
          line.toLowerCase().includes('agreed'),
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
        return toolError(`Failed to analyze transcript: ${error instanceof Error ? error.message : String(error)}`);
      }
    },
  },
];
