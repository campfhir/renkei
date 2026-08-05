/**
 * Write tool implementations for Jira MCP.
 * Adapted from renkei for Next.js.
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/server';
import type { MCPToolContext } from '../common';
import { jiraFetch, issueUrl, getCachedDisplayName } from '../common';
import { markdownToAdf } from './markdown';
import {
  buildFieldUpdates,
  findStoryPointsField,
  isJiraDuration,
  loadFieldSchema,
} from './field-schema';
import { logger } from '@/lib/logger';

// Type guard functions
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isString(value: unknown): value is string {
  return typeof value === 'string';
}

function isArray(value: unknown): value is unknown[] {
  return Array.isArray(value);
}

function isNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

export async function registerWriteTools(
  server: McpServer,
  context: MCPToolContext
): Promise<void> {
  // create_issue
  server.registerTool(
    'create_issue',
    {
      title: 'Create a Jira issue',
      description: 'Create a new Jira issue in a project.',
      inputSchema: z.object({
        projectKey: z.string().describe('Project key, e.g. SCRUM'),
        issueType: z.string().describe('Issue type: Task, Bug, Story, Subtask, Epic, etc.'),
        summary: z.string().describe('Issue title (max 255 characters)'),
        description: z.string().describe('Issue description (markdown format)').optional(),
        priority: z.string().describe('Priority: Highest, High, Medium, Low, Lowest').optional(),
        assignee: z.string().describe('Email address or account ID to assign to').optional(),
        labels: z.array(z.string()).describe('Labels to apply').optional(),
      }),
    },
    async (args: Record<string, unknown>) => {
      const displayName = getCachedDisplayName(context.accountId);
      logger.info('[Tool] create_issue invoked', {
        tenantId: context.tenantId,
        accountId: context.accountId,
        displayName,
      });
      try {
        const { projectKey, issueType, summary, description, priority, assignee, labels } = args;

        if (!projectKey || !issueType || !summary) {
          return {
            content: [
              { type: 'text' as const, text: 'projectKey, issueType, and summary are required' },
            ],
            isError: true,
          };
        }

        const projectKeyStr = isString(projectKey) ? projectKey : String(projectKey);
        const issueTypeStr = isString(issueType) ? issueType : String(issueType);
        const summaryStr = isString(summary) ? summary : String(summary);

        const fields: Record<string, unknown> = {
          project: { key: projectKeyStr },
          issuetype: { name: issueTypeStr },
          summary: summaryStr.substring(0, 255),
        };

        if (description && isString(description)) {
          fields.description = markdownToAdf(description);
        }

        if (priority && isString(priority)) {
          fields.priority = { name: priority };
        }

        if (assignee && isString(assignee)) {
          fields.assignee = { name: assignee };
        }

        if (labels && isArray(labels)) {
          fields.labels = labels;
        }

        const response = await jiraFetch(
          `${context.apiBaseUrl}/rest/api/3/issue`,
          context.accessToken,
          {
            method: 'POST',
            body: JSON.stringify({ fields }),
          }
        );

        const result = await response.json();
        if (!isRecord(result)) {
          return {
            content: [{ type: 'text' as const, text: 'Invalid response from API' }],
            isError: true,
          };
        }
        const resultKey = isString(result.key) ? result.key : String(result.key);
        const text = `Created issue ${result.key}\n\n[Open in Jira](${issueUrl(context.siteUrl, resultKey)})`;
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

  // update_issue
  server.registerTool(
    'update_issue',
    {
      title: 'Update a Jira issue',
      description:
        'Update an existing Jira issue. Story points, the original estimate, and any custom ' +
        "field can be set: field names are resolved against this site's own schema, so no " +
        'customfield id needs to be known in advance.',
      inputSchema: z.object({
        issueKey: z.string().describe('Issue key, e.g. PROJ-123'),
        summary: z.string().describe('New title (optional)').optional(),
        description: z.string().describe('New description in markdown (optional)').optional(),
        priority: z.string().describe('New priority (optional)').optional(),
        assignee: z.string().describe('New assignee email or account ID (optional)').optional(),
        labels: z.array(z.string()).describe('New labels (optional, replaces existing)').optional(),
        storyPoints: z
          .number()
          .describe(
            'Story point estimate. The field is found by name on this site, whether it is ' +
              'called "Story Points" or "Story point estimate".'
          )
          .optional(),
        originalEstimate: z
          .string()
          .describe('Original time estimate in Jira duration form, e.g. "3d", "4h", "1w 2d"')
          .optional(),
        fields: z
          .record(z.string(), z.unknown())
          .describe(
            'Any other fields, keyed by name or id: {"Decision of Change Request": "Approved", ' +
              '"customfield_12016": 3}. Values are shaped to match each field\'s schema — a ' +
              'select field gets {value: …}, a number gets a number — so pass the plain value.'
          )
          .optional(),
      }),
    },
    async (args: Record<string, unknown>) => {
      const displayName = getCachedDisplayName(context.accountId);
      logger.info('[Tool] update_issue invoked', {
        tenantId: context.tenantId,
        accountId: context.accountId,
        displayName,
      });
      try {
        const { issueKey, summary, description, priority, assignee, labels } = args;

        if (!isString(issueKey)) {
          return {
            content: [{ type: 'text' as const, text: 'issueKey is required' }],
            isError: true,
          };
        }

        const fields: Record<string, unknown> = {};
        const applied: string[] = [];

        if (summary && isString(summary)) {
          fields.summary = summary.substring(0, 255);
        }

        if (description && isString(description)) {
          fields.description = markdownToAdf(description);
        }

        if (priority && isString(priority)) {
          fields.priority = { name: priority };
        }

        if (assignee && isString(assignee)) {
          fields.assignee = { name: assignee };
        }

        if (labels && isArray(labels)) {
          fields.labels = labels;
        }

        // Story points live in a per-instance custom field, so the id is looked
        // up by name against this site rather than assumed.
        if (isNumber(args.storyPoints)) {
          const schema = await loadFieldSchema(context);
          const lookup = findStoryPointsField(schema);
          if (!lookup.ok) {
            return { content: [{ type: 'text' as const, text: lookup.message }], isError: true };
          }
          fields[lookup.field.id] = args.storyPoints;
          applied.push(`${lookup.field.name} → ${args.storyPoints}`);
        }

        if (isString(args.originalEstimate)) {
          if (!isJiraDuration(args.originalEstimate)) {
            return {
              content: [
                {
                  type: 'text' as const,
                  text: `originalEstimate must be a Jira duration like "3d", "4h" or "1w 2d", got "${args.originalEstimate}"`,
                },
              ],
              isError: true,
            };
          }
          // A partial timetracking object leaves the remaining estimate alone,
          // which is what setting only the original is meant to do.
          fields.timetracking = { originalEstimate: args.originalEstimate };
          applied.push(`Original estimate → ${args.originalEstimate}`);
        }

        if (isRecord(args.fields)) {
          const updates = await buildFieldUpdates(context, args.fields);
          if (updates.problems.length > 0) {
            // Nothing is sent when a name does not resolve: a caller told "3 of 4
            // fields were set" has to work out which, and a half-applied update
            // is worse than one that plainly failed.
            return {
              content: [
                { type: 'text' as const, text: `Nothing updated.\n${updates.problems.join('\n')}` },
              ],
              isError: true,
            };
          }
          Object.assign(fields, updates.fields);
          applied.push(...updates.applied);
        }

        if (Object.keys(fields).length === 0) {
          return {
            content: [{ type: 'text' as const, text: `Nothing to update on ${issueKey}` }],
            isError: true,
          };
        }

        await jiraFetch(`${context.apiBaseUrl}/rest/api/3/issue/${issueKey}`, context.accessToken, {
          method: 'PUT',
          body: JSON.stringify({ fields }),
        });

        const detail =
          applied.length > 0 ? `\n${applied.map((line) => `• ${line}`).join('\n')}` : '';
        const text = `Updated ${issueKey}${detail}\n\n[Open in Jira](${issueUrl(context.siteUrl, issueKey)})`;
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

  // add_comment
  server.registerTool(
    'add_comment',
    {
      title: 'Comment on a Jira issue',
      description: 'Add a comment to a Jira issue.',
      inputSchema: z.object({
        issueKey: z.string().describe('Issue key, e.g. PROJ-123'),
        comment: z.string().describe('Comment text (markdown format)'),
      }),
    },
    async (args: Record<string, unknown>) => {
      const displayName = getCachedDisplayName(context.accountId);
      logger.info('[Tool] add_comment invoked', {
        tenantId: context.tenantId,
        accountId: context.accountId,
        displayName,
      });
      try {
        const { issueKey, comment } = args;

        if (!isString(issueKey) || !isString(comment)) {
          return {
            content: [{ type: 'text' as const, text: 'issueKey and comment are required' }],
            isError: true,
          };
        }

        const commentStr = comment;
        await jiraFetch(
          `${context.apiBaseUrl}/rest/api/3/issue/${issueKey}/comment`,
          context.accessToken,
          {
            method: 'POST',
            body: JSON.stringify({
              body: markdownToAdf(commentStr),
            }),
          }
        );

        const text = `Comment added to ${issueKey}\n\n[Open in Jira](${issueUrl(context.siteUrl, issueKey)})`;
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

  // transition_issue
  server.registerTool(
    'transition_issue',
    {
      title: 'Move a Jira issue through its workflow',
      description: 'Transition an issue to a different status.',
      inputSchema: z.object({
        issueKey: z.string().describe('Issue key, e.g. PROJ-123'),
        transitionName: z
          .string()
          .describe('Transition name, e.g. "Start Progress", "Resolve Issue"'),
        comment: z.string().describe('Optional comment to add during transition').optional(),
      }),
    },
    async (args: Record<string, unknown>) => {
      const displayName = getCachedDisplayName(context.accountId);
      logger.info('[Tool] transition_issue invoked', {
        tenantId: context.tenantId,
        accountId: context.accountId,
        displayName,
      });
      try {
        const { issueKey, transitionName, comment } = args;

        if (!isString(issueKey) || !isString(transitionName)) {
          return {
            content: [{ type: 'text' as const, text: 'issueKey and transitionName are required' }],
            isError: true,
          };
        }

        // First, get available transitions
        const transResponse = await jiraFetch(
          `${context.apiBaseUrl}/rest/api/3/issue/${issueKey}/transitions`,
          context.accessToken
        );
        const transData = await transResponse.json();
        if (!isRecord(transData)) {
          return {
            content: [{ type: 'text' as const, text: 'Invalid response from transitions API' }],
            isError: true,
          };
        }

        // Find the matching transition
        const transitionNameStr = transitionName;
        const transitions = isArray(transData.transitions) ? transData.transitions : [];
        const transition = transitions.find((t: unknown) => {
          if (!isRecord(t)) {
            return false;
          }
          return isString(t.name) && t.name.toLowerCase() === transitionNameStr.toLowerCase();
        });

        if (!transition) {
          const availableNames = transitions
            .map((t: unknown) => (isRecord(t) && isString(t.name) ? t.name : null))
            .filter((name): name is string => name !== null)
            .join(', ');
          return {
            content: [
              {
                type: 'text' as const,
                text: `Transition "${transitionNameStr}" not found. Available: ${availableNames || 'none'}`,
              },
            ],
            isError: true,
          };
        }

        // Execute the transition
        if (!isRecord(transition)) {
          return {
            content: [{ type: 'text' as const, text: 'Invalid transition object' }],
            isError: true,
          };
        }
        const body: Record<string, unknown> = {
          transition: { id: transition.id },
        };

        if (comment && isString(comment)) {
          body.update = {
            comment: [
              {
                add: {
                  body: markdownToAdf(comment),
                },
              },
            ],
          };
        }

        await jiraFetch(
          `${context.apiBaseUrl}/rest/api/3/issue/${issueKey}/transitions`,
          context.accessToken,
          {
            method: 'POST',
            body: JSON.stringify(body),
          }
        );

        const text = `Transitioned ${issueKey} to ${transitionName}\n\n[Open in Jira](${issueUrl(context.siteUrl, issueKey)})`;
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

  // log_work
  server.registerTool(
    'log_work',
    {
      title: 'Log work against a Jira issue',
      description: 'Log time spent on a Jira issue.',
      inputSchema: z.object({
        issueKey: z.string().describe('Issue key, e.g. PROJ-123'),
        timeSpent: z.string().describe('Time spent in Jira format: 1d, 2h, 30m, 1w'),
        comment: z.string().describe('Optional comment (what was done)').optional(),
      }),
    },
    async (args: Record<string, unknown>) => {
      const displayName = getCachedDisplayName(context.accountId);
      logger.info('[Tool] log_work invoked', {
        tenantId: context.tenantId,
        accountId: context.accountId,
        displayName,
      });
      try {
        const { issueKey, timeSpent, comment } = args;

        if (!isString(issueKey) || !isString(timeSpent)) {
          return {
            content: [{ type: 'text' as const, text: 'issueKey and timeSpent are required' }],
            isError: true,
          };
        }

        const timeSpentStr = timeSpent;
        const body: Record<string, unknown> = {
          timeSpent: timeSpentStr,
        };

        if (comment && isString(comment)) {
          body.comment = markdownToAdf(comment);
        }

        await jiraFetch(
          `${context.apiBaseUrl}/rest/api/3/issue/${issueKey}/worklog`,
          context.accessToken,
          {
            method: 'POST',
            body: JSON.stringify(body),
          }
        );

        const text = `Logged ${timeSpent} on ${issueKey}\n\n[Open in Jira](${issueUrl(context.siteUrl, issueKey)})`;
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
