/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/consistent-type-assertions */
/**
 * Bulk operation tools for Jira MCP.
 * Handle multiple issues at once.
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/server';
import type { MCPToolContext } from '../common';
import { jiraFetch, getCachedDisplayName } from '../common';
import { logger } from '@/lib/logger';
import { buildFieldUpdates } from './field-schema';

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
      const displayName = getCachedDisplayName(context.accountId);
      logger.info('bulk_update_issues invoked', {
        component: 'mcp/tool',
        tenantId: context.tenantId,
        accountId: context.accountId,
        displayName,
      });
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
          `${context.apiBaseUrl}/rest/api/3/search/jql`,
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

        // The same schema-aware resolver update_issue uses: field names or
        // ids resolve against this site's schema, values are coerced per
        // field type (priority string → {name}, rich text → ADF, options
        // validated). Bulk previously PUT the caller's record verbatim,
        // which is why single-issue updates worked while bulk 400'd.
        const updates = await buildFieldUpdates(context, fields);
        if (Object.keys(updates.fields).length === 0) {
          return {
            content: [
              {
                type: 'text' as const,
                text: `No writable fields resolved.${updates.problems.length ? `\n${updates.problems.map((problem) => `• ${problem}`).join('\n')}` : ''}`,
              },
            ],
            isError: true,
          };
        }

        // Update each issue, keeping each failure's reason — "N failed" with
        // no why is undebuggable at 1 issue and ruinous at 50.
        let updated = 0;
        const failures: string[] = [];

        for (const key of issueKeys) {
          try {
            await jiraFetch(`${context.apiBaseUrl}/rest/api/3/issue/${key}`, context.accessToken, {
              method: 'PUT',
              body: JSON.stringify({ fields: updates.fields }),
            });
            updated++;
          } catch (error) {
            failures.push(`${key}: ${error instanceof Error ? error.message : String(error)}`);
          }
        }

        const resolutionNotes = updates.problems.length
          ? `\nNot written (unresolvable): ${updates.problems.join('; ')}`
          : '';
        const summary = `Updated ${updated} issues, ${failures.length} failed (total: ${issueKeys.length}). Applied: ${updates.applied.join(', ')}${resolutionNotes}`;
        return {
          content: [
            {
              type: 'text' as const,
              text: failures.length
                ? `${summary}\nFailures:\n${failures.map((f) => `• ${f}`).join('\n')}`
                : summary,
            },
          ],
          ...(updated === 0 && failures.length > 0 ? { isError: true } : {}),
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
      const displayName = getCachedDisplayName(context.accountId);
      logger.info('bulk_transition_issues invoked', {
        component: 'mcp/tool',
        tenantId: context.tenantId,
        accountId: context.accountId,
        displayName,
      });
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
          `${context.apiBaseUrl}/rest/api/3/search/jql`,
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
        const failures: string[] = [];

        for (const key of issueKeys) {
          try {
            // Get available transitions
            const transResponse = await jiraFetch(
              `${context.apiBaseUrl}/rest/api/3/issue/${key}/transitions`,
              context.accessToken
            );
            const transData = (await transResponse.json()) as any;

            const transition = transData.transitions?.find(
              (t: any) => t.name.toLowerCase() === transitionName.toLowerCase()
            );

            if (transition) {
              await jiraFetch(
                `${context.apiBaseUrl}/rest/api/3/issue/${key}/transitions`,
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
              const names = Array.isArray(transData.transitions)
                ? transData.transitions.map((t: any) => t.name).join(', ')
                : '(none)';
              failures.push(
                `${key}: no transition named "${transitionName}" — available: ${names}`
              );
            }
          } catch (error) {
            failures.push(`${key}: ${error instanceof Error ? error.message : String(error)}`);
          }
        }

        const summary = `Transitioned ${transitioned} issues to "${transitionName}", ${failures.length} failed (total: ${issueKeys.length})`;
        return {
          content: [
            {
              type: 'text' as const,
              text: failures.length
                ? `${summary}\nFailures:\n${failures.map((f) => `• ${f}`).join('\n')}`
                : summary,
            },
          ],
          ...(transitioned === 0 && failures.length > 0 ? { isError: true } : {}),
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
