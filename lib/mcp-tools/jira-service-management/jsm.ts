/**
 * Jira Service Management (JSM) tools for MCP.
 * Handle customer requests, service desks, and support operations.
 */

import type { MCPToolContext, MCPToolResult } from '../common';
import { ok, toolError, jiraFetch, requestUrl } from '../common';

export interface JSMToolHandler {
  name: string;
  description: string;
  inputSchema?: Record<string, any>;
  handler: (context: MCPToolContext, params: any) => Promise<MCPToolResult>;
}

export const jsmTools: JSMToolHandler[] = [
  {
    name: 'list_service_desks',
    description: 'List all Jira Service Management service desks.',
    inputSchema: {
      type: 'object',
      properties: {
        maxResults: {
          type: 'number',
          description: 'Maximum results (1-100, default 25)',
        },
      },
    },
    handler: async (context, params) => {
      const maxResults = Math.min(params.maxResults || 25, 100);

      try {
        const response = await jiraFetch(
          `${context.siteUrl}/rest/servicedeskapi/servicedesk?limit=${maxResults}`,
          context.accessToken,
        );

        const data = (await response.json()) as any;
        const desks = (data.values || []).map((desk: any) => ({
          id: desk.id,
          name: desk.projectName,
          key: desk.projectKey,
        }));

        const lines = [
          `Found ${data.total || 0} service desks (showing ${desks.length}):`,
          ...desks.map((d: any) => `• ${d.name} (${d.key})`),
        ];

        return ok(lines.join('\n'));
      } catch (error) {
        return toolError(`Failed to list service desks: ${error instanceof Error ? error.message : String(error)}`);
      }
    },
  },

  {
    name: 'list_request_types',
    description: 'List request types available on a service desk.',
    inputSchema: {
      type: 'object',
      properties: {
        serviceDeskId: {
          type: 'string',
          description: 'Service desk ID',
        },
      },
      required: ['serviceDeskId'],
    },
    handler: async (context, params) => {
      const { serviceDeskId } = params;

      if (!serviceDeskId) {
        return toolError('serviceDeskId is required');
      }

      try {
        const response = await jiraFetch(
          `${context.siteUrl}/rest/servicedeskapi/servicedesk/${serviceDeskId}/requesttype`,
          context.accessToken,
        );

        const data = (await response.json()) as any;
        const types = (data.values || []).map((type: any) => ({
          id: type.id,
          name: type.name,
        }));

        const lines = [
          `Service desk has ${types.length} request types:`,
          ...types.map((t: any) => `• ${t.name} (ID: ${t.id})`),
        ];

        return ok(lines.join('\n'));
      } catch (error) {
        return toolError(`Failed to list request types: ${error instanceof Error ? error.message : String(error)}`);
      }
    },
  },

  {
    name: 'list_requests',
    description: 'List customer requests in a service desk.',
    inputSchema: {
      type: 'object',
      properties: {
        serviceDeskId: {
          type: 'string',
          description: 'Service desk ID (optional)',
        },
        maxResults: {
          type: 'number',
          description: 'Maximum results (1-100, default 25)',
        },
      },
    },
    handler: async (context, params) => {
      const maxResults = Math.min(params.maxResults || 25, 100);
      const query = new URLSearchParams({ limit: String(maxResults) });

      if (params.serviceDeskId) {
        query.append('serviceDeskId', params.serviceDeskId);
      }

      try {
        const response = await jiraFetch(
          `${context.siteUrl}/rest/servicedeskapi/request?${query}`,
          context.accessToken,
        );

        const data = (await response.json()) as any;
        const requests = (data.values || []).map((req: any) => ({
          key: req.issueKey,
          summary: req.summary,
          status: req.currentStatus?.name || 'Unknown',
        }));

        const lines = [
          `Found ${data.total || 0} requests (showing ${requests.length}):`,
          ...requests.map((r: any) => `• ${r.key}: ${r.summary} [${r.status}]`),
        ];

        return ok(lines.join('\n'));
      } catch (error) {
        return toolError(`Failed to list requests: ${error instanceof Error ? error.message : String(error)}`);
      }
    },
  },

  {
    name: 'get_request',
    description: 'Get details for a customer request.',
    inputSchema: {
      type: 'object',
      properties: {
        issueKey: {
          type: 'string',
          description: 'Request key, e.g. SUP-1',
        },
      },
      required: ['issueKey'],
    },
    handler: async (context, params) => {
      const { issueKey } = params;

      if (!issueKey) {
        return toolError('issueKey is required');
      }

      try {
        const response = await jiraFetch(
          `${context.siteUrl}/rest/servicedeskapi/request/${issueKey}?expand=requestType,serviceDesk`,
          context.accessToken,
        );

        const request = (await response.json()) as any;

        const lines = [
          `${issueKey}: ${request.summary}`,
          `Status: ${request.currentStatus?.name || 'Unknown'}`,
          `Request Type: ${request.requestType?.name || 'Unknown'}`,
          `Created: ${request.created}`,
          `Updated: ${request.updated}`,
        ];

        if (request.description) {
          lines.push(`\nDescription:\n${request.description}`);
        }

        return ok(lines.join('\n'));
      } catch (error) {
        return toolError(`Failed to get request: ${error instanceof Error ? error.message : String(error)}`);
      }
    },
  },

  {
    name: 'create_request',
    description: 'Create a customer request in a service desk.',
    inputSchema: {
      type: 'object',
      properties: {
        serviceDeskId: {
          type: 'string',
          description: 'Service desk ID',
        },
        requestTypeId: {
          type: 'string',
          description: 'Request type ID',
        },
        summary: {
          type: 'string',
          description: 'Request summary/title',
        },
        description: {
          type: 'string',
          description: 'Request description (optional)',
        },
      },
      required: ['serviceDeskId', 'requestTypeId', 'summary'],
    },
    handler: async (context, params) => {
      const { serviceDeskId, requestTypeId, summary, description } = params;

      if (!serviceDeskId || !requestTypeId || !summary) {
        return toolError('serviceDeskId, requestTypeId, and summary are required');
      }

      try {
        const body: any = {
          serviceDeskId,
          requestTypeId,
          summary,
        };

        if (description) {
          body.description = description;
        }

        const response = await jiraFetch(
          `${context.siteUrl}/rest/servicedeskapi/request`,
          context.accessToken,
          {
            method: 'POST',
            body: JSON.stringify(body),
          },
        );

        const result = (await response.json()) as any;
        return ok(`Created request ${result.issueKey}`);
      } catch (error) {
        return toolError(`Failed to create request: ${error instanceof Error ? error.message : String(error)}`);
      }
    },
  },

  {
    name: 'add_request_comment',
    description: 'Add a comment to a customer request.',
    inputSchema: {
      type: 'object',
      properties: {
        issueKey: {
          type: 'string',
          description: 'Request key, e.g. SUP-1',
        },
        comment: {
          type: 'string',
          description: 'Comment text',
        },
        isInternal: {
          type: 'boolean',
          description: 'Is this internal only (not visible to customer)?',
        },
      },
      required: ['issueKey', 'comment'],
    },
    handler: async (context, params) => {
      const { issueKey, comment, isInternal = false } = params;

      if (!issueKey || !comment) {
        return toolError('issueKey and comment are required');
      }

      try {
        await jiraFetch(
          `${context.siteUrl}/rest/servicedeskapi/request/${issueKey}/comment`,
          context.accessToken,
          {
            method: 'POST',
            body: JSON.stringify({
              body: comment,
              internal: isInternal,
            }),
          },
        );

        return ok(`Comment added to ${issueKey}${isInternal ? ' (internal)' : ''}`);
      } catch (error) {
        return toolError(`Failed to add comment: ${error instanceof Error ? error.message : String(error)}`);
      }
    },
  },

  {
    name: 'list_request_transitions',
    description: 'List available transitions for a customer request.',
    inputSchema: {
      type: 'object',
      properties: {
        issueKey: {
          type: 'string',
          description: 'Request key, e.g. SUP-1',
        },
      },
      required: ['issueKey'],
    },
    handler: async (context, params) => {
      const { issueKey } = params;

      if (!issueKey) {
        return toolError('issueKey is required');
      }

      try {
        const response = await jiraFetch(
          `${context.siteUrl}/rest/servicedeskapi/request/${issueKey}/transition`,
          context.accessToken,
        );

        const data = (await response.json()) as any;
        const transitions = (data.transitions || []).map((t: any) => t.name);

        const lines = [
          `${issueKey} has ${transitions.length} available transitions:`,
          ...transitions.map((t: string) => `• ${t}`),
        ];

        return ok(lines.join('\n'));
      } catch (error) {
        return toolError(`Failed to list transitions: ${error instanceof Error ? error.message : String(error)}`);
      }
    },
  },

  {
    name: 'transition_request',
    description: 'Transition a customer request to a new status.',
    inputSchema: {
      type: 'object',
      properties: {
        issueKey: {
          type: 'string',
          description: 'Request key, e.g. SUP-1',
        },
        transitionName: {
          type: 'string',
          description: 'Transition name',
        },
      },
      required: ['issueKey', 'transitionName'],
    },
    handler: async (context, params) => {
      const { issueKey, transitionName } = params;

      if (!issueKey || !transitionName) {
        return toolError('issueKey and transitionName are required');
      }

      try {
        // Get available transitions
        const transResponse = await jiraFetch(
          `${context.siteUrl}/rest/servicedeskapi/request/${issueKey}/transition`,
          context.accessToken,
        );
        const transData = (await transResponse.json()) as any;

        const transition = transData.transitions?.find(
          (t: any) => t.name.toLowerCase() === transitionName.toLowerCase(),
        );

        if (!transition) {
          return toolError(
            `Transition "${transitionName}" not found. Available: ${transData.transitions?.map((t: any) => t.name).join(', ') || 'none'}`,
          );
        }

        // Execute transition
        await jiraFetch(
          `${context.siteUrl}/rest/servicedeskapi/request/${issueKey}/transition`,
          context.accessToken,
          {
            method: 'POST',
            body: JSON.stringify({
              transition: { id: transition.id },
            }),
          },
        );

        return ok(`Transitioned ${issueKey} to "${transitionName}"`);
      } catch (error) {
        return toolError(`Failed to transition request: ${error instanceof Error ? error.message : String(error)}`);
      }
    },
  },

  {
    name: 'list_customers',
    description: 'List customers in a service desk.',
    inputSchema: {
      type: 'object',
      properties: {
        serviceDeskId: {
          type: 'string',
          description: 'Service desk ID',
        },
        maxResults: {
          type: 'number',
          description: 'Maximum results (1-50, default 10)',
        },
      },
      required: ['serviceDeskId'],
    },
    handler: async (context, params) => {
      const { serviceDeskId, maxResults = 10 } = params;

      if (!serviceDeskId) {
        return toolError('serviceDeskId is required');
      }

      try {
        const response = await jiraFetch(
          `${context.siteUrl}/rest/servicedeskapi/servicedesk/${serviceDeskId}/customer?limit=${Math.min(maxResults, 50)}`,
          context.accessToken,
        );

        const data = (await response.json()) as any;
        const customers = (data.values || []).map((c: any) => ({
          id: c.accountId,
          name: c.displayName,
          email: c.email,
        }));

        const lines = [
          `Service desk has ${data.total || 0} customers (showing ${customers.length}):`,
          ...customers.map((c: any) => `• ${c.name} (${c.email})`),
        ];

        return ok(lines.join('\n'));
      } catch (error) {
        return toolError(`Failed to list customers: ${error instanceof Error ? error.message : String(error)}`);
      }
    },
  },
];
