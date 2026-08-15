/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/consistent-type-assertions */
/**
 * Bulk operation tools for Jira MCP.
 * Handle multiple issues at once.
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/server';
import type { MCPToolContext } from '../common';
import { getCachedDisplayName } from '../common';
import { logger } from '@/lib/logger';
import { buildFieldUpdates } from './field-schema';
import { writeWithFieldFallback, type FieldWritePlan } from './field-write';
import { recordUnwritten } from './write';
import { granularJiraScopes, describeJiraAuthFailure, type JiraAuth } from './jira-auth';

function errText(value: string) {
  return { content: [{ type: 'text' as const, text: value }], isError: true };
}

export async function registerBulkTools(
  server: McpServer,
  context: MCPToolContext,
  auth: JiraAuth
): Promise<void> {
  // jira_bulk_update_issues (not in renkei_tools.json but keeping for now)
  server.registerTool(
    'jira_bulk_update_issues',
    {
      title: 'Jira · Act — Update multiple Jira issues',
      description: 'Update multiple issues at once with the same changes.',
      annotations: { readOnlyHint: false },
      inputSchema: z.object({
        jql: z.string().describe('JQL query to select issues to update'),
        fields: z.record(z.string(), z.any()).describe('Fields to update on all matched issues'),
      }),
    },
    async (args: Record<string, any>) => {
      const displayName = getCachedDisplayName(context.accountId);
      logger.info('jira_bulk_update_issues invoked', {
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
        const searchResponse = await auth.fetch(
          granularJiraScopes('jira_bulk_update_issues', true),
          '/rest/api/3/search/jql',
          {
            method: 'POST',
            body: JSON.stringify({
              jql,
              maxResults: 100,
              fields: ['key'],
            }),
          }
        );
        if (!searchResponse.ok) return errText(await describeJiraAuthFailure(searchResponse));

        const searchData = (await searchResponse.json()) as any;
        const issueKeys = (searchData.issues || []).map((i: any) => i.key);

        if (issueKeys.length === 0) {
          return { content: [{ type: 'text' as const, text: 'No issues matched the JQL query' }] };
        }

        // The same schema-aware resolver jira_update_issue uses: field names or
        // ids resolve against this site's schema, values are coerced per
        // field type (priority string → {name}, rich text → ADF, options
        // validated). Allowed values come from the first matched issue's
        // editmeta — a JQL selection is near-always homogeneous enough for
        // its option sets to hold across the batch, and a mismatch only
        // costs that issue its field via the fallback below.
        const updates = await buildFieldUpdates(context, auth, fields, { issueKey: issueKeys[0] });
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

        const labels: Record<string, string> = {};
        for (const id of Object.keys(updates.fields)) {
          labels[id] = updates.applied.find((entry) => entry.includes(id)) ?? id;
        }
        const plan: FieldWritePlan = {
          required: {},
          optional: updates.fields,
          labels,
          hints: updates.optionHints,
        };

        // Update each issue with the same degrading write single-issue
        // updates get: a field one issue's screen refuses is dropped and
        // recorded as a comment there, instead of failing that whole issue.
        // Failures keep their reason — "N failed" with no why is
        // undebuggable at 1 issue and ruinous at 50.
        let updated = 0;
        const failures: string[] = [];
        const degraded: string[] = [];

        for (const key of issueKeys) {
          try {
            const outcome = await writeWithFieldFallback(plan, async (fieldsToSend) => {
              const response = await auth.fetch(
                granularJiraScopes('jira_bulk_update_issues', false),
                `/rest/api/3/issue/${key}`,
                { method: 'PUT', body: JSON.stringify({ fields: fieldsToSend }) }
              );
              if (!response.ok) {
                throw new Error(await describeJiraAuthFailure(response));
              }
            });

            if (!outcome.sent) {
              failures.push(
                `${key}: every field was refused — ${outcome.dropped
                  .map((field) => `${field.label} (${field.reason})`)
                  .join('; ')}`
              );
              continue;
            }

            updated++;
            if (outcome.dropped.length > 0) {
              const commented = await recordUnwritten(context, auth, key, outcome.dropped);
              degraded.push(
                `${key}: not set — ${outcome.dropped
                  .map((field) => `${field.label} (${field.reason})`)
                  .join('; ')}${commented ? ' [recorded as a comment]' : ''}`
              );
            }
          } catch (error) {
            failures.push(`${key}: ${error instanceof Error ? error.message : String(error)}`);
          }
        }

        const resolutionNotes = updates.problems.length
          ? `\nNot written (unresolvable): ${updates.problems.join('; ')}`
          : '';
        const summary = `Updated ${updated} issues, ${failures.length} failed (total: ${issueKeys.length}). Applied: ${updates.applied.join(', ')}${resolutionNotes}`;
        const detail = [
          degraded.length ? `Partially applied:\n${degraded.map((d) => `• ${d}`).join('\n')}` : '',
          failures.length ? `Failures:\n${failures.map((f) => `• ${f}`).join('\n')}` : '',
        ]
          .filter(Boolean)
          .join('\n');
        return {
          content: [
            {
              type: 'text' as const,
              text: detail ? `${summary}\n${detail}` : summary,
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

  // jira_bulk_transition_issues
  server.registerTool(
    'jira_bulk_transition_issues',
    {
      title: 'Jira · Act — Move multiple Jira issues through workflow',
      description: 'Transition multiple issues to the same status.',
      annotations: { readOnlyHint: false },
      inputSchema: z.object({
        jql: z.string().describe('JQL query to select issues'),
        transitionName: z.string().describe('Transition name to apply to all issues'),
      }),
    },
    async (args: Record<string, any>) => {
      const displayName = getCachedDisplayName(context.accountId);
      logger.info('jira_bulk_transition_issues invoked', {
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
        const searchResponse = await auth.fetch(
          granularJiraScopes('jira_bulk_transition_issues', true),
          '/rest/api/3/search/jql',
          {
            method: 'POST',
            body: JSON.stringify({
              jql,
              maxResults: 100,
              fields: ['key'],
            }),
          }
        );
        if (!searchResponse.ok) return errText(await describeJiraAuthFailure(searchResponse));

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
            const transResponse = await auth.fetch(
              granularJiraScopes('jira_bulk_transition_issues', true),
              `/rest/api/3/issue/${key}/transitions`
            );
            if (!transResponse.ok) {
              failures.push(`${key}: ${await describeJiraAuthFailure(transResponse)}`);
              continue;
            }
            const transData = (await transResponse.json()) as any;

            const transition = transData.transitions?.find(
              (t: any) => t.name.toLowerCase() === transitionName.toLowerCase()
            );

            if (transition) {
              const execResponse = await auth.fetch(
                granularJiraScopes('jira_bulk_transition_issues', false),
                `/rest/api/3/issue/${key}/transitions`,
                {
                  method: 'POST',
                  body: JSON.stringify({
                    transition: { id: transition.id },
                  }),
                }
              );
              if (!execResponse.ok) {
                failures.push(`${key}: ${await describeJiraAuthFailure(execResponse)}`);
                continue;
              }
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
