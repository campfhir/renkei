/**
 * Write tool implementations for Jira MCP.
 * Adapted from renkei for Next.js.
 */

import type { MCPToolContext, MCPToolResult } from '../common';
import { ok, okWithLink, toolError, jiraFetch, issueUrl } from '../common';

export interface WriteToolHandler {
  name: string;
  description: string;
  inputSchema?: Record<string, unknown>;
  handler: (context: MCPToolContext, params: unknown) => Promise<MCPToolResult>;
}

export const writeTools: WriteToolHandler[] = [
  {
    name: 'create_issue',
    description: 'Create a new Jira issue in a project.',
    inputSchema: {
      type: 'object',
      properties: {
        projectKey: {
          type: 'string',
          description: 'Project key, e.g. SCRUM',
        },
        issueType: {
          type: 'string',
          description: 'Issue type: Task, Bug, Story, Subtask, Epic, etc.',
        },
        summary: {
          type: 'string',
          description: 'Issue title (max 255 characters)',
        },
        description: {
          type: 'string',
          description: 'Issue description (markdown format)',
        },
        priority: {
          type: 'string',
          description: 'Priority: Highest, High, Medium, Low, Lowest',
        },
        assignee: {
          type: 'string',
          description: 'Email address or account ID to assign to',
        },
        labels: {
          type: 'array',
          items: { type: 'string' },
          description: 'Labels to apply',
        },
      },
      required: ['projectKey', 'issueType', 'summary'],
    },
    handler: async (context, params) => {
      const p = params as Record<string, unknown>;
      const { projectKey, issueType, summary, description, priority, assignee, labels } = p;

      if (!projectKey || !issueType || !summary) {
        return toolError('projectKey, issueType, and summary are required');
      }

      try {
        const fields: Record<string, unknown> = {
          project: { key: projectKey as string },
          issuetype: { name: issueType as string },
          summary: (summary as string).substring(0, 255),
        };

        if (description) {
          fields.description = { content: [{ content: [{ text: description }], type: 'paragraph' }], type: 'doc', version: 1 };
        }

        if (priority) {
          fields.priority = { name: priority };
        }

        if (assignee) {
          fields.assignee = { name: assignee };
        }

        if (labels && Array.isArray(labels)) {
          fields.labels = labels;
        }

        const response = await jiraFetch(
          `${context.siteUrl}/rest/api/3/issue`,
          context.accessToken,
          {
            method: 'POST',
            body: JSON.stringify({ fields }),
          },
        );

        const result = (await response.json()) as Record<string, unknown>;
        return okWithLink(`Created issue ${result.key}`, issueUrl(context.siteUrl, result.key as string));
      } catch (error) {
        return toolError(`Failed to create issue: ${error instanceof Error ? error.message : String(error)}`);
      }
    },
  },

  {
    name: 'update_issue',
    description: 'Update an existing Jira issue.',
    inputSchema: {
      type: 'object',
      properties: {
        issueKey: {
          type: 'string',
          description: 'Issue key, e.g. PROJ-123',
        },
        summary: {
          type: 'string',
          description: 'New title (optional)',
        },
        description: {
          type: 'string',
          description: 'New description in markdown (optional)',
        },
        priority: {
          type: 'string',
          description: 'New priority (optional)',
        },
        assignee: {
          type: 'string',
          description: 'New assignee email or account ID (optional)',
        },
        labels: {
          type: 'array',
          items: { type: 'string' },
          description: 'New labels (optional, replaces existing)',
        },
      },
      required: ['issueKey'],
    },
    handler: async (context, params) => {
      const p = params as Record<string, unknown>;
      const { issueKey, summary, description, priority, assignee, labels } = p;

      if (!issueKey) {
        return toolError('issueKey is required');
      }

      try {
        const fields: Record<string, unknown> = {};

        if (summary) {
          fields.summary = summary.substring(0, 255);
        }

        if (description) {
          fields.description = { content: [{ content: [{ text: description }], type: 'paragraph' }], type: 'doc', version: 1 };
        }

        if (priority) {
          fields.priority = { name: priority };
        }

        if (assignee) {
          fields.assignee = { name: assignee };
        }

        if (labels && Array.isArray(labels)) {
          fields.labels = labels;
        }

        await jiraFetch(
          `${context.siteUrl}/rest/api/3/issue/${issueKey}`,
          context.accessToken,
          {
            method: 'PUT',
            body: JSON.stringify({ fields }),
          },
        );

        return okWithLink(`Updated ${issueKey}`, issueUrl(context.siteUrl, issueKey));
      } catch (error) {
        return toolError(`Failed to update issue: ${error instanceof Error ? error.message : String(error)}`);
      }
    },
  },

  {
    name: 'add_comment',
    description: 'Add a comment to a Jira issue.',
    inputSchema: {
      type: 'object',
      properties: {
        issueKey: {
          type: 'string',
          description: 'Issue key, e.g. PROJ-123',
        },
        comment: {
          type: 'string',
          description: 'Comment text (markdown format)',
        },
      },
      required: ['issueKey', 'comment'],
    },
    handler: async (context, params) => {
      const p = params as Record<string, unknown>;
      const { issueKey, comment } = p;

      if (!issueKey || !comment) {
        return toolError('issueKey and comment are required');
      }

      try {
        await jiraFetch(
          `${context.siteUrl}/rest/api/3/issue/${issueKey}/comments`,
          context.accessToken,
          {
            method: 'POST',
            body: JSON.stringify({
              body: { content: [{ content: [{ text: comment }], type: 'paragraph' }], type: 'doc', version: 1 },
            }),
          },
        );

        return okWithLink(`Comment added to ${issueKey}`, issueUrl(context.siteUrl, issueKey));
      } catch (error) {
        return toolError(`Failed to add comment: ${error instanceof Error ? error.message : String(error)}`);
      }
    },
  },

  {
    name: 'transition_issue',
    description: 'Transition an issue to a different status.',
    inputSchema: {
      type: 'object',
      properties: {
        issueKey: {
          type: 'string',
          description: 'Issue key, e.g. PROJ-123',
        },
        transitionName: {
          type: 'string',
          description: 'Transition name, e.g. "Start Progress", "Resolve Issue"',
        },
        comment: {
          type: 'string',
          description: 'Optional comment to add during transition',
        },
      },
      required: ['issueKey', 'transitionName'],
    },
    handler: async (context, params) => {
      const p = params as Record<string, unknown>;
      const { issueKey, transitionName, comment } = p;

      if (!issueKey || !transitionName) {
        return toolError('issueKey and transitionName are required');
      }

      try {
        // First, get available transitions
        const transResponse = await jiraFetch(
          `${context.siteUrl}/rest/api/3/issue/${issueKey}/transitions`,
          context.accessToken,
        );
        const transData = (await transResponse.json()) as Record<string, unknown>;

        // Find the matching transition
        const transition = transData.transitions?.find(
          (t: Record<string, unknown>) => t.name.toLowerCase() === transitionName.toLowerCase(),
        );

        if (!transition) {
          return toolError(
            `Transition "${transitionName}" not found. Available: ${transData.transitions?.map((t: Record<string, unknown>) => t.name).join(', ') || 'none'}`,
          );
        }

        // Execute the transition
        const body: Record<string, unknown> = {
          transition: { id: transition.id },
        };

        if (comment) {
          body.update = {
            comment: [
              {
                add: {
                  body: { content: [{ content: [{ text: comment }], type: 'paragraph' }], type: 'doc', version: 1 },
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
          },
        );

        return okWithLink(`Transitioned ${issueKey} to ${transitionName}`, issueUrl(context.siteUrl, issueKey));
      } catch (error) {
        return toolError(`Failed to transition issue: ${error instanceof Error ? error.message : String(error)}`);
      }
    },
  },

  {
    name: 'log_work',
    description: 'Log time spent on a Jira issue.',
    inputSchema: {
      type: 'object',
      properties: {
        issueKey: {
          type: 'string',
          description: 'Issue key, e.g. PROJ-123',
        },
        timeSpent: {
          type: 'string',
          description: 'Time spent in Jira format: 1d, 2h, 30m, 1w',
        },
        comment: {
          type: 'string',
          description: 'Optional comment (what was done)',
        },
      },
      required: ['issueKey', 'timeSpent'],
    },
    handler: async (context, params) => {
      const p = params as Record<string, unknown>;
      const { issueKey, timeSpent, comment } = p;

      if (!issueKey || !timeSpent) {
        return toolError('issueKey and timeSpent are required');
      }

      try {
        const body: Record<string, unknown> = {
          timeSpent,
        };

        if (comment) {
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
          },
        );

        return okWithLink(`Logged ${timeSpent} on ${issueKey}`, issueUrl(context.siteUrl, issueKey));
      } catch (error) {
        return toolError(`Failed to log work: ${error instanceof Error ? error.message : String(error)}`);
      }
    },
  },
];
