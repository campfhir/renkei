/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/consistent-type-assertions */
/**
 * Jira Service Management (JSM) tools for MCP.
 * Handle customer requests, service desks, and support operations.
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { MCPToolContext } from '../common';
import { jiraFetch } from '../common';

export async function registerJsmTools(server: McpServer, context: MCPToolContext): Promise<void> {
  // list_service_desks
  server.registerTool(
    'list_service_desks',
    {
      title: 'List Jira Service Management service desks',
      description: 'List all Jira Service Management service desks.',
      annotations: { readOnlyHint: true },
      inputSchema: z.object({
        maxResults: z.number().describe('Maximum results (1-100, default 25)').optional(),
      }),
    },
    async (args: Record<string, any>) => {
      try {
        const maxResults = Math.min(args.maxResults || 25, 100);

        const response = await jiraFetch(
          `${context.siteUrl}/rest/servicedeskapi/servicedesk?limit=${maxResults}`,
          context.accessToken
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

        return { content: [{ type: 'text' as const, text: lines.join('\n') }] };
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

  // list_request_types
  server.registerTool(
    'list_request_types',
    {
      title: 'List all request types for a service desk',
      description: 'List request types available on a service desk.',
      annotations: { readOnlyHint: true },
      inputSchema: z.object({
        serviceDeskId: z.string().describe('Service desk ID'),
      }),
    },
    async (args: Record<string, any>) => {
      try {
        const { serviceDeskId } = args;

        if (!serviceDeskId) {
          return {
            content: [{ type: 'text' as const, text: 'serviceDeskId is required' }],
            isError: true,
          };
        }

        const response = await jiraFetch(
          `${context.siteUrl}/rest/servicedeskapi/servicedesk/${serviceDeskId}/requesttype`,
          context.accessToken
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

        return { content: [{ type: 'text' as const, text: lines.join('\n') }] };
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

  // list_requests
  server.registerTool(
    'list_requests',
    {
      title: 'List Jira Service Management customer requests',
      description: 'List customer requests in a service desk.',
      annotations: { readOnlyHint: true },
      inputSchema: z.object({
        serviceDeskId: z.string().describe('Service desk ID (optional)').optional(),
        maxResults: z.number().describe('Maximum results (1-100, default 25)').optional(),
      }),
    },
    async (args: Record<string, any>) => {
      try {
        const maxResults = Math.min(args.maxResults || 25, 100);
        const query = new URLSearchParams({ limit: String(maxResults) });

        if (args.serviceDeskId) {
          query.append('serviceDeskId', args.serviceDeskId);
        }

        const response = await jiraFetch(
          `${context.siteUrl}/rest/servicedeskapi/request?${query}`,
          context.accessToken
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

        return { content: [{ type: 'text' as const, text: lines.join('\n') }] };
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

  // get_request
  server.registerTool(
    'get_request',
    {
      title: 'Read a customer request',
      description: 'Get details for a customer request.',
      annotations: { readOnlyHint: true },
      inputSchema: z.object({
        issueKey: z.string().describe('Request key, e.g. SUP-1'),
      }),
    },
    async (args: Record<string, any>) => {
      try {
        const { issueKey } = args;

        if (!issueKey) {
          return {
            content: [{ type: 'text' as const, text: 'issueKey is required' }],
            isError: true,
          };
        }

        const response = await jiraFetch(
          `${context.siteUrl}/rest/servicedeskapi/request/${issueKey}?expand=requestType,serviceDesk`,
          context.accessToken
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

        return { content: [{ type: 'text' as const, text: lines.join('\n') }] };
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

  // create_request
  server.registerTool(
    'create_request',
    {
      title: 'Create a customer or internal request',
      description: 'Create a customer request in a service desk.',
      inputSchema: z.object({
        serviceDeskId: z.string().describe('Service desk ID'),
        requestTypeId: z.string().describe('Request type ID'),
        summary: z.string().describe('Request summary/title'),
        description: z.string().describe('Request description (optional)').optional(),
      }),
    },
    async (args: Record<string, any>) => {
      try {
        const { serviceDeskId, requestTypeId, summary, description } = args;

        if (!serviceDeskId || !requestTypeId || !summary) {
          return {
            content: [
              {
                type: 'text' as const,
                text: 'serviceDeskId, requestTypeId, and summary are required',
              },
            ],
            isError: true,
          };
        }

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
          }
        );

        const result = (await response.json()) as any;
        return { content: [{ type: 'text' as const, text: `Created request ${result.issueKey}` }] };
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

  // add_request_comment
  server.registerTool(
    'add_request_comment',
    {
      title: 'Comment on a customer request',
      description: 'Add a comment to a customer request.',
      inputSchema: z.object({
        issueKey: z.string().describe('Request key, e.g. SUP-1'),
        comment: z.string().describe('Comment text'),
        isInternal: z
          .boolean()
          .describe('Is this internal only (not visible to customer)?')
          .optional(),
      }),
    },
    async (args: Record<string, any>) => {
      try {
        const { issueKey, comment, isInternal = false } = args;

        if (!issueKey || !comment) {
          return {
            content: [{ type: 'text' as const, text: 'issueKey and comment are required' }],
            isError: true,
          };
        }

        await jiraFetch(
          `${context.siteUrl}/rest/servicedeskapi/request/${issueKey}/comment`,
          context.accessToken,
          {
            method: 'POST',
            body: JSON.stringify({
              body: comment,
              internal: isInternal,
            }),
          }
        );

        return {
          content: [
            {
              type: 'text' as const,
              text: `Comment added to ${issueKey}${isInternal ? ' (internal)' : ''}`,
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

  // list_request_transitions
  server.registerTool(
    'list_request_transitions',
    {
      title: 'List customer transitions on a request',
      description: 'List available transitions for a customer request.',
      annotations: { readOnlyHint: true },
      inputSchema: z.object({
        issueKey: z.string().describe('Request key, e.g. SUP-1'),
      }),
    },
    async (args: Record<string, any>) => {
      try {
        const { issueKey } = args;

        if (!issueKey) {
          return {
            content: [{ type: 'text' as const, text: 'issueKey is required' }],
            isError: true,
          };
        }

        const response = await jiraFetch(
          `${context.siteUrl}/rest/servicedeskapi/request/${issueKey}/transition`,
          context.accessToken
        );

        const data = (await response.json()) as any;
        const transitions = (data.transitions || []).map((t: any) => t.name);

        const lines = [
          `${issueKey} has ${transitions.length} available transitions:`,
          ...transitions.map((t: string) => `• ${t}`),
        ];

        return { content: [{ type: 'text' as const, text: lines.join('\n') }] };
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

  // transition_request
  server.registerTool(
    'transition_request',
    {
      title: 'Transition a customer request',
      description: 'Transition a customer request to a new status.',
      inputSchema: z.object({
        issueKey: z.string().describe('Request key, e.g. SUP-1'),
        transitionName: z.string().describe('Transition name'),
      }),
    },
    async (args: Record<string, any>) => {
      try {
        const { issueKey, transitionName } = args;

        if (!issueKey || !transitionName) {
          return {
            content: [{ type: 'text' as const, text: 'issueKey and transitionName are required' }],
            isError: true,
          };
        }

        // Get available transitions
        const transResponse = await jiraFetch(
          `${context.siteUrl}/rest/servicedeskapi/request/${issueKey}/transition`,
          context.accessToken
        );
        const transData = (await transResponse.json()) as any;

        const transition = transData.transitions?.find(
          (t: any) => t.name.toLowerCase() === transitionName.toLowerCase()
        );

        if (!transition) {
          return {
            content: [
              {
                type: 'text' as const,
                text: `Transition "${transitionName}" not found. Available: ${transData.transitions?.map((t: any) => t.name).join(', ') || 'none'}`,
              },
            ],
            isError: true,
          };
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
          }
        );

        return {
          content: [
            { type: 'text' as const, text: `Transitioned ${issueKey} to "${transitionName}"` },
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

  // list_customers
  server.registerTool(
    'list_customers',
    {
      title: 'List customers in a service desk',
      description: 'List customers in a service desk.',
      annotations: { readOnlyHint: true },
      inputSchema: z.object({
        serviceDeskId: z.string().describe('Service desk ID'),
        maxResults: z.number().describe('Maximum results (1-50, default 10)').optional(),
      }),
    },
    async (args: Record<string, any>) => {
      try {
        const { serviceDeskId, maxResults = 10 } = args;

        if (!serviceDeskId) {
          return {
            content: [{ type: 'text' as const, text: 'serviceDeskId is required' }],
            isError: true,
          };
        }

        const response = await jiraFetch(
          `${context.siteUrl}/rest/servicedeskapi/servicedesk/${serviceDeskId}/customer?limit=${Math.min(maxResults, 50)}`,
          context.accessToken
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

        return { content: [{ type: 'text' as const, text: lines.join('\n') }] };
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
