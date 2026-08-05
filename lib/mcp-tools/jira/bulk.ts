/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/consistent-type-assertions */
/**
 * Bulk operation tools for Jira MCP.
 * Handle multiple issues at once.
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/server';
import type { MCPToolContext } from '../common';
import { jiraFetch } from '../common';

export async function registerBulkTools(server: McpServer, context: MCPToolContext): Promise<void> {
  // bulk_update_issues (not in renkei_tools.json but keeping for now)
  server.registerTool(
    'bulk_update_issues',
    {
      title: 'Update multiple Jira issues',
      description: 'Update multiple issues at once with the same changes.',
      inputSchema: z.object({
        jql: z.string().describe('JQL query to select issues to update'),
        fields: z.record(z.string(), z.any()).describe('Fields to update on all matched issues'),
      }),
    },
    async (args: Record<string, any>) => {
      try {
        const { jql, fields } = args;

        if (!jql || !fields) {
          return {
            content: [{ type: 'text' as const, text: 'jql and fields are required' }],
            isError: true,
          };
        }

        // First search for issues matching the JQL
        const searchResponse = await jiraFetch(
          `${context.siteUrl}/rest/api/3/search`,
          context.accessToken,
          {
            method: 'POST',
            body: JSON.stringify({
              jql,
              maxResults: 100,
              fields: ['key'],
            }),
          }
        );

        const searchData = (await searchResponse.json()) as any;
        const issueKeys = (searchData.issues || []).map((i: any) => i.key);

        if (issueKeys.length === 0) {
          return { content: [{ type: 'text' as const, text: 'No issues matched the JQL query' }] };
        }

        // Update each issue
        let updated = 0;
        let failed = 0;

        for (const key of issueKeys) {
          try {
            await jiraFetch(`${context.siteUrl}/rest/api/3/issue/${key}`, context.accessToken, {
              method: 'PUT',
              body: JSON.stringify({ fields }),
            });
            updated++;
          } catch {
            failed++;
          }
        }

        return {
          content: [
            {
              type: 'text' as const,
              text: `Updated ${updated} issues, ${failed} failed (total: ${issueKeys.length})`,
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

  // bulk_transition_issues
  server.registerTool(
    'bulk_transition_issues',
    {
      title: 'Move multiple Jira issues through workflow',
      description: 'Transition multiple issues to the same status.',
      inputSchema: z.object({
        jql: z.string().describe('JQL query to select issues'),
        transitionName: z.string().describe('Transition name to apply to all issues'),
      }),
    },
    async (args: Record<string, any>) => {
      try {
        const { jql, transitionName } = args;

        if (!jql || !transitionName) {
          return {
            content: [{ type: 'text' as const, text: 'jql and transitionName are required' }],
            isError: true,
          };
        }

        // Search for issues
        const searchResponse = await jiraFetch(
          `${context.siteUrl}/rest/api/3/search`,
          context.accessToken,
          {
            method: 'POST',
            body: JSON.stringify({
              jql,
              maxResults: 100,
              fields: ['key'],
            }),
          }
        );

        const searchData = (await searchResponse.json()) as any;
        const issueKeys = (searchData.issues || []).map((i: any) => i.key);

        if (issueKeys.length === 0) {
          return { content: [{ type: 'text' as const, text: 'No issues matched the JQL query' }] };
        }

        let transitioned = 0;
        let failed = 0;

        for (const key of issueKeys) {
          try {
            // Get available transitions
            const transResponse = await jiraFetch(
              `${context.siteUrl}/rest/api/3/issue/${key}/transitions`,
              context.accessToken
            );
            const transData = (await transResponse.json()) as any;

            const transition = transData.transitions?.find(
              (t: any) => t.name.toLowerCase() === transitionName.toLowerCase()
            );

            if (transition) {
              await jiraFetch(
                `${context.siteUrl}/rest/api/3/issue/${key}/transitions`,
                context.accessToken,
                {
                  method: 'POST',
                  body: JSON.stringify({
                    transition: { id: transition.id },
                  }),
                }
              );
              transitioned++;
            } else {
              failed++;
            }
          } catch {
            failed++;
          }
        }

        return {
          content: [
            {
              type: 'text' as const,
              text: `Transitioned ${transitioned} issues to "${transitionName}", ${failed} failed (total: ${issueKeys.length})`,
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
}
