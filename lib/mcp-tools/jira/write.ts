/**
 * Write tool implementations for Jira MCP.
 * Adapted from renkei for Next.js.
 */

import type { MCPToolContext, MCPToolResult } from '../common';
import { okWithLink, toolError, jiraFetch, issueUrl } from '../common';

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
      if (!isRecord(params)) {
        return toolError('Invalid parameters');
      }
      const p = params;
      const { projectKey, issueType, summary, description, priority, assignee, labels } = p;

      if (!projectKey || !issueType || !summary) {
        return toolError('projectKey, issueType, and summary are required');
      }

      try {
        const projectKeyStr = isString(projectKey) ? projectKey : String(projectKey);
        const issueTypeStr = isString(issueType) ? issueType : String(issueType);
        const summaryStr = isString(summary) ? summary : String(summary);

        const fields: Record<string, unknown> = {
          project: { key: projectKeyStr },
          issuetype: { name: issueTypeStr },
          summary: summaryStr.substring(0, 255),
        };

        if (description && isString(description)) {
          fields.description = { content: [{ content: [{ text: description }], type: 'paragraph' }], type: 'doc', version: 1 };
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
          },
        );

        const result = await response.json();
        if (!isRecord(result)) {
          return toolError('Invalid response from API');
        }
        const resultKey = isString(result.key) ? result.key : String(result.key);
        return okWithLink(`Created issue ${result.key}`, issueUrl(context.siteUrl, resultKey));
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
      if (!isRecord(params)) {
        return toolError('Invalid parameters');
      }
      const p = params;
      const { issueKey, summary, description, priority, assignee, labels } = p;

      if (!issueKey) {
        return toolError('issueKey is required');
      }

      try {
        const fields: Record<string, unknown> = {};

        if (summary && isString(summary)) {
          fields.summary = summary.substring(0, 255);
        }

        if (description && isString(description)) {
          fields.description = { content: [{ content: [{ text: description }], type: 'paragraph' }], type: 'doc', version: 1 };
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
      if (!isRecord(params)) {
        return toolError('Invalid parameters');
      }
      const p = params;
      const { issueKey, comment } = p;

      if (!issueKey || !comment) {
        return toolError('issueKey and comment are required');
      }

      try {
        const commentStr = isString(comment) ? comment : String(comment);
        await jiraFetch(
          `${context.siteUrl}/rest/api/3/issue/${issueKey}/comments`,
          context.accessToken,
          {
            method: 'POST',
            body: JSON.stringify({
              body: { content: [{ content: [{ text: commentStr }], type: 'paragraph' }], type: 'doc', version: 1 },
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
      if (!isRecord(params)) {
        return toolError('Invalid parameters');
      }
      const p = params;
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
        const transData = await transResponse.json();
        if (!isRecord(transData)) {
          return toolError('Invalid response from transitions API');
        }

        // Find the matching transition
        const transitionNameStr = isString(transitionName) ? transitionName : String(transitionName);
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
          return toolError(
            `Transition "${transitionNameStr}" not found. Available: ${availableNames || 'none'}`,
          );
        }

        // Execute the transition
        if (!isRecord(transition)) {
          return toolError('Invalid transition object');
        }
        const body: Record<string, unknown> = {
          transition: { id: transition.id },
        };

        if (comment && isString(comment)) {
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
      if (!isRecord(params)) {
        return toolError('Invalid parameters');
      }
      const p = params;
      const { issueKey, timeSpent, comment } = p;

      if (!issueKey || !timeSpent) {
        return toolError('issueKey and timeSpent are required');
      }

      try {
        const timeSpentStr = isString(timeSpent) ? timeSpent : String(timeSpent);
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
          },
        );

        return okWithLink(`Logged ${timeSpent} on ${issueKey}`, issueUrl(context.siteUrl, issueKey));
      } catch (error) {
        return toolError(`Failed to log work: ${error instanceof Error ? error.message : String(error)}`);
      }
    },
  },
];
