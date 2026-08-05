/**
 * Write tool implementations for Jira MCP.
 * Adapted from renkei for Next.js.
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/server';
import type { MCPToolContext } from '../common';
import { jiraFetch, issueUrl } from '../common';

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
          fields.description = {
            content: [{ content: [{ text: description }], type: 'paragraph' }],
            type: 'doc',
            version: 1,
          };
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
          `${context.siteUrl}/rest/api/3/issue`,
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
      description: 'Update an existing Jira issue.',
      inputSchema: z.object({
        issueKey: z.string().describe('Issue key, e.g. PROJ-123'),
        summary: z.string().describe('New title (optional)').optional(),
        description: z.string().describe('New description in markdown (optional)').optional(),
        priority: z.string().describe('New priority (optional)').optional(),
        assignee: z.string().describe('New assignee email or account ID (optional)').optional(),
        labels: z.array(z.string()).describe('New labels (optional, replaces existing)').optional(),
      }),
    },
    async (args: Record<string, unknown>) => {
      try {
        const { issueKey, summary, description, priority, assignee, labels } = args;

        if (!isString(issueKey)) {
          return {
            content: [{ type: 'text' as const, text: 'issueKey is required' }],
            isError: true,
          };
        }

        const fields: Record<string, unknown> = {};

        if (summary && isString(summary)) {
          fields.summary = summary.substring(0, 255);
        }

        if (description && isString(description)) {
          fields.description = {
            content: [{ content: [{ text: description }], type: 'paragraph' }],
            type: 'doc',
            version: 1,
          };
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

        await jiraFetch(`${context.siteUrl}/rest/api/3/issue/${issueKey}`, context.accessToken, {
          method: 'PUT',
          body: JSON.stringify({ fields }),
        });

        const text = `Updated ${issueKey}\n\n[Open in Jira](${issueUrl(context.siteUrl, issueKey)})`;
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
          `${context.siteUrl}/rest/api/3/issue/${issueKey}/comments`,
          context.accessToken,
          {
            method: 'POST',
            body: JSON.stringify({
              body: {
                content: [{ content: [{ text: commentStr }], type: 'paragraph' }],
                type: 'doc',
                version: 1,
              },
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
          `${context.siteUrl}/rest/api/3/issue/${issueKey}/transitions`,
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
                  body: {
                    content: [{ content: [{ text: comment }], type: 'paragraph' }],
                    type: 'doc',
                    version: 1,
                  },
                },
              },
            ],
          };
        }

        await jiraFetch(
          `${context.siteUrl}/rest/api/3/issue/${issueKey}/transitions`,
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
          body.comment = {
            content: [{ content: [{ text: comment }], type: 'paragraph' }],
            type: 'doc',
            version: 1,
          };
        }

        await jiraFetch(
          `${context.siteUrl}/rest/api/3/issue/${issueKey}/worklog`,
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
