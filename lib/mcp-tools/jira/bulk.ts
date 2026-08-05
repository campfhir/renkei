/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/consistent-type-assertions */
/**
 * Bulk operation tools for Jira MCP.
 * Handle multiple issues at once.
 */

import type { MCPToolContext, MCPToolResult } from '../common';
import { ok, toolError, jiraFetch } from '../common';

export interface BulkToolHandler {
  name: string;
  description: string;
  inputSchema?: Record<string, any>;
  handler: (context: MCPToolContext, params: any) => Promise<MCPToolResult>;
}

export const bulkTools: BulkToolHandler[] = [
  {
    name: 'bulk_update_issues',
    description: 'Update multiple issues at once with the same changes.',
    inputSchema: {
      type: 'object',
      properties: {
        jql: {
          type: 'string',
          description: 'JQL query to select issues to update',
        },
        fields: {
          type: 'object',
          description: 'Fields to update on all matched issues',
        },
      },
      required: ['jql', 'fields'],
    },
    handler: async (context, params) => {
      const { jql, fields } = params;

      if (!jql || !fields) {
        return toolError('jql and fields are required');
      }

      try {
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
          },
        );

        const searchData = (await searchResponse.json()) as any;
        const issueKeys = (searchData.issues || []).map((i: any) => i.key);

        if (issueKeys.length === 0) {
          return ok('No issues matched the JQL query');
        }

        // Update each issue
        let updated = 0;
        let failed = 0;

        for (const key of issueKeys) {
          try {
            await jiraFetch(
              `${context.siteUrl}/rest/api/3/issue/${key}`,
              context.accessToken,
              {
                method: 'PUT',
                body: JSON.stringify({ fields }),
              },
            );
            updated++;
          } catch {
            failed++;
          }
        }

        return ok(`Updated ${updated} issues, ${failed} failed (total: ${issueKeys.length})`);
      } catch (error) {
        return toolError(`Bulk update failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    },
  },

  {
    name: 'bulk_transition_issues',
    description: 'Transition multiple issues to the same status.',
    inputSchema: {
      type: 'object',
      properties: {
        jql: {
          type: 'string',
          description: 'JQL query to select issues',
        },
        transitionName: {
          type: 'string',
          description: 'Transition name to apply to all issues',
        },
      },
      required: ['jql', 'transitionName'],
    },
    handler: async (context, params) => {
      const { jql, transitionName } = params;

      if (!jql || !transitionName) {
        return toolError('jql and transitionName are required');
      }

      try {
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
          },
        );

        const searchData = (await searchResponse.json()) as any;
        const issueKeys = (searchData.issues || []).map((i: any) => i.key);

        if (issueKeys.length === 0) {
          return ok('No issues matched the JQL query');
        }

        let transitioned = 0;
        let failed = 0;

        for (const key of issueKeys) {
          try {
            // Get available transitions
            const transResponse = await jiraFetch(
              `${context.siteUrl}/rest/api/3/issue/${key}/transitions`,
              context.accessToken,
            );
            const transData = (await transResponse.json()) as any;

            const transition = transData.transitions?.find(
              (t: any) => t.name.toLowerCase() === transitionName.toLowerCase(),
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
                },
              );
              transitioned++;
            } else {
              failed++;
            }
          } catch {
            failed++;
          }
        }

        return ok(
          `Transitioned ${transitioned} issues to "${transitionName}", ${failed} failed (total: ${issueKeys.length})`,
        );
      } catch (error) {
        return toolError(`Bulk transition failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    },
  },
];
