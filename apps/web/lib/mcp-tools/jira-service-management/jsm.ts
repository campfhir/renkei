/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/consistent-type-assertions */
/**
 * Jira Service Management (JSM) tools for MCP.
 * Handle customer requests, service desks, and support operations.
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/server';
import type { MCPToolContext } from '../common';
import { getCachedDisplayName, requestUrl, withPresentationHint } from '../common';
import { logger } from '@/lib/logger';
import { serviceDeskScopes, describeJsmAuthFailure, type JsmAuth } from './jsm-auth';

function str(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function errText(value: string) {
  return { content: [{ type: 'text' as const, text: value }], isError: true };
}

export async function registerJsmTools(
  server: McpServer,
  context: MCPToolContext,
  auth: JsmAuth
): Promise<void> {
  // jsm_list_service_desks
  server.registerTool(
    'jsm_list_service_desks',
    {
      title: 'JSM · Read — List Jira Service Management service desks',
      description:
        'List all Jira Service Management service desks. Call this before jira_create_issue ' +
        "whenever you're not already sure a target project is a plain project rather than a " +
        "service desk — cross-reference the project key against this list's `key` field.",
      annotations: { readOnlyHint: true },
      inputSchema: z.object({
        maxResults: z.number().describe('Maximum results (1-100, default 25)').optional(),
      }),
    },
    async (args: Record<string, any>) => {
      const displayName = getCachedDisplayName(context.accountId);
      logger.info('jsm_list_service_desks invoked', {
        component: 'mcp/tool',
        tenantId: context.tenantId,
        accountId: context.accountId,
        displayName,
      });
      try {
        const maxResults = Math.min(args.maxResults || 25, 100);

        const response = await auth.fetch(
          serviceDeskScopes('jsm_list_service_desks', true),
          `/rest/servicedeskapi/servicedesk?limit=${maxResults}`
        );
        if (!response.ok) return errText(await describeJsmAuthFailure(response));

        const data = (await response.json()) as any;
        const desks = (data.values || []).map((desk: any) => ({
          id: desk.id,
          name: desk.projectName,
          key: desk.projectKey,
        }));

        const lines = [
          `Found ${data.size ?? 0} service desks (showing ${desks.length}):`,
          ...desks.map((d: any) => `• ${d.name} (${d.key}) — serviceDeskId: ${d.id}`),
        ];
        const text = lines.join('\n');

        return {
          content: [
            {
              type: 'text' as const,
              text:
                desks.length === 0
                  ? text
                  : withPresentationHint(
                      text,
                      'a table (Service desk, Project key, id) usually scans faster than this flat list.'
                    ),
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

  // jsm_list_request_types
  server.registerTool(
    'jsm_list_request_types',
    {
      title: 'JSM · Read — List all request types for a service desk',
      description: 'List request types available on a service desk.',
      annotations: { readOnlyHint: true },
      inputSchema: z.object({
        serviceDeskId: z.string().describe('Service desk ID'),
      }),
    },
    async (args: Record<string, any>) => {
      const displayName = getCachedDisplayName(context.accountId);
      logger.info('jsm_list_request_types invoked', {
        component: 'mcp/tool',
        tenantId: context.tenantId,
        accountId: context.accountId,
        displayName,
      });
      try {
        const { serviceDeskId } = args;

        if (!serviceDeskId) {
          return {
            content: [{ type: 'text' as const, text: 'serviceDeskId is required' }],
            isError: true,
          };
        }

        const response = await auth.fetch(
          serviceDeskScopes('jsm_list_request_types', true),
          `/rest/servicedeskapi/servicedesk/${serviceDeskId}/requesttype`
        );
        if (!response.ok) return errText(await describeJsmAuthFailure(response));

        const data = (await response.json()) as any;
        const types = (data.values || []).map((type: any) => ({
          id: type.id,
          name: type.name,
        }));

        const lines = [
          `Service desk has ${types.length} request types:`,
          ...types.map((t: any) => `• ${t.name} (ID: ${t.id})`),
        ];
        const text = lines.join('\n');

        return {
          content: [
            {
              type: 'text' as const,
              text:
                types.length === 0
                  ? text
                  : withPresentationHint(
                      text,
                      'a table (Request type, Service desk, id) usually scans faster than this flat list.'
                    ),
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

  // jsm_list_requests
  server.registerTool(
    'jsm_list_requests',
    {
      title: 'JSM · Read — List Jira Service Management customer requests',
      description: 'List customer requests in a service desk.',
      annotations: { readOnlyHint: true },
      inputSchema: z.object({
        serviceDeskId: z.string().describe('Service desk ID (optional)').optional(),
        maxResults: z.number().describe('Maximum results (1-100, default 25)').optional(),
      }),
    },
    async (args: Record<string, any>) => {
      const displayName = getCachedDisplayName(context.accountId);
      logger.info('jsm_list_requests invoked', {
        component: 'mcp/tool',
        tenantId: context.tenantId,
        accountId: context.accountId,
        displayName,
      });
      try {
        const maxResults = Math.min(args.maxResults || 25, 100);
        const query = new URLSearchParams({ limit: String(maxResults) });

        if (args.serviceDeskId) {
          query.append('serviceDeskId', args.serviceDeskId);
        }

        const response = await auth.fetch(
          serviceDeskScopes('jsm_list_requests', true),
          `/rest/servicedeskapi/request?${query}`
        );
        if (!response.ok) return errText(await describeJsmAuthFailure(response));

        const data = (await response.json()) as any;
        const requests = (data.values || []).map((req: any) => ({
          key: req.issueKey,
          summary: req.summary,
          // The field is currentStatus.status — .name does not exist on this DTO.
          status: req.currentStatus?.status || 'Unknown',
        }));

        const lines = [
          `Found ${data.size ?? 0} requests (showing ${requests.length}):`,
          ...requests.map((r: any) => `• ${r.key}: ${r.summary} [${r.status}]`),
        ];
        const text = lines.join('\n');

        return {
          content: [
            {
              type: 'text' as const,
              text:
                requests.length === 0
                  ? text
                  : withPresentationHint(
                      text,
                      'a table (Key, Summary, Status, Requester) usually scans faster than this flat ' +
                        'list, especially with more than a handful of results.'
                    ),
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

  // jsm_get_request
  server.registerTool(
    'jsm_get_request',
    {
      title: 'JSM · Read — Read a customer request',
      description: 'Get details for a customer request.',
      annotations: { readOnlyHint: true },
      inputSchema: z.object({
        issueKey: z.string().describe('Request key, e.g. SUP-1'),
      }),
    },
    async (args: Record<string, any>) => {
      const displayName = getCachedDisplayName(context.accountId);
      logger.info('jsm_get_request invoked', {
        component: 'mcp/tool',
        tenantId: context.tenantId,
        accountId: context.accountId,
        displayName,
      });
      try {
        const { issueKey } = args;

        if (!issueKey) {
          return {
            content: [{ type: 'text' as const, text: 'issueKey is required' }],
            isError: true,
          };
        }

        const response = await auth.fetch(
          serviceDeskScopes('jsm_get_request', true),
          `/rest/servicedeskapi/request/${issueKey}?expand=requestType,serviceDesk`
        );
        if (!response.ok) return errText(await describeJsmAuthFailure(response));

        const request = (await response.json()) as any;

        const lines = [
          `${issueKey}: ${request.summary}`,
          `Status: ${request.currentStatus?.status || 'Unknown'}`,
          `Request Type: ${request.requestType?.name || 'Unknown'}`,
          // Dates are DateDTO objects; there is no top-level created/updated,
          // and the payload carries no updated date at all.
          `Created: ${request.createdDate?.friendly ?? request.createdDate?.iso8601 ?? 'Unknown'}`,
          `Reporter: ${request.reporter?.displayName ?? 'Unknown'}`,
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

  // jsm_create_request
  server.registerTool(
    'jsm_create_request',
    {
      title: 'JSM · Act — Create a customer or internal request',
      description:
        'Create a customer request in a service desk. Prefer this over jira_create_issue ' +
        'whenever the target project is a service desk (see jsm_list_service_desks) — a plain ' +
        'issue in a service desk project skips its request types and SLAs.',
      annotations: { readOnlyHint: false },
      inputSchema: z.object({
        serviceDeskId: z.string().describe('Service desk ID'),
        requestTypeId: z.string().describe('Request type ID'),
        summary: z.string().describe('Request summary/title'),
        description: z.string().describe('Request description (optional)').optional(),
      }),
    },
    async (args: Record<string, any>) => {
      const displayName = getCachedDisplayName(context.accountId);
      logger.info('jsm_create_request invoked', {
        component: 'mcp/tool',
        tenantId: context.tenantId,
        accountId: context.accountId,
        displayName,
      });
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

        // The servicedeskapi wants issue fields nested under
        // requestFieldValues — top-level summary (platform-API style) is
        // "Invalid request payload". The 401 scope gate used to fire before
        // payload validation, which is why this never surfaced until the
        // JSM app's scopes landed.
        const body: any = {
          serviceDeskId: String(serviceDeskId),
          requestTypeId: String(requestTypeId),
          requestFieldValues: {
            summary,
            ...(description ? { description } : {}),
          },
        };

        const response = await auth.fetch(
          serviceDeskScopes('jsm_create_request', false),
          '/rest/servicedeskapi/request',
          {
            method: 'POST',
            body: JSON.stringify(body),
          }
        );
        if (!response.ok) return errText(await describeJsmAuthFailure(response));

        const result = (await response.json()) as any;
        // Echo what Jira actually created, not the input.
        const key = str(result.issueKey) || '(no key in response)';
        return {
          content: [
            {
              type: 'text' as const,
              text: `Created request ${key}\n\n[Open in portal](${requestUrl(context.siteUrl, key)})`,
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

  // jsm_add_request_comment
  server.registerTool(
    'jsm_add_request_comment',
    {
      title: 'JSM · Act — Comment on a customer request',
      description: 'Add a comment to a customer request.',
      annotations: { readOnlyHint: false },
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
      const displayName = getCachedDisplayName(context.accountId);
      logger.info('jsm_add_request_comment invoked', {
        component: 'mcp/tool',
        tenantId: context.tenantId,
        accountId: context.accountId,
        displayName,
      });
      try {
        const { issueKey, comment, isInternal = false } = args;

        if (!issueKey || !comment) {
          return {
            content: [{ type: 'text' as const, text: 'issueKey and comment are required' }],
            isError: true,
          };
        }

        const response = await auth.fetch(
          serviceDeskScopes('jsm_add_request_comment', false),
          `/rest/servicedeskapi/request/${issueKey}/comment`,
          {
            method: 'POST',
            body: JSON.stringify({
              body: comment,
              // CommentCreateDTO has exactly {body, public} — `internal` is
              // not a key this API knows, and the sense is inverted.
              public: !isInternal,
            }),
          }
        );
        if (!response.ok) return errText(await describeJsmAuthFailure(response));

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

  // jsm_list_request_transitions
  server.registerTool(
    'jsm_list_request_transitions',
    {
      title: 'JSM · Read — List customer transitions on a request',
      description: 'List available transitions for a customer request.',
      annotations: { readOnlyHint: true },
      inputSchema: z.object({
        issueKey: z.string().describe('Request key, e.g. SUP-1'),
      }),
    },
    async (args: Record<string, any>) => {
      const displayName = getCachedDisplayName(context.accountId);
      logger.info('jsm_list_request_transitions invoked', {
        component: 'mcp/tool',
        tenantId: context.tenantId,
        accountId: context.accountId,
        displayName,
      });
      try {
        const { issueKey } = args;

        if (!issueKey) {
          return {
            content: [{ type: 'text' as const, text: 'issueKey is required' }],
            isError: true,
          };
        }

        const response = await auth.fetch(
          serviceDeskScopes('jsm_list_request_transitions', true),
          `/rest/servicedeskapi/request/${issueKey}/transition`
        );
        if (!response.ok) return errText(await describeJsmAuthFailure(response));

        const data = (await response.json()) as any;
        const transitions = (data.values || []).map((t: any) => t.name);

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

  // jsm_transition_request
  server.registerTool(
    'jsm_transition_request',
    {
      title: 'JSM · Act — Transition a customer request',
      description: 'Transition a customer request to a new status.',
      annotations: { readOnlyHint: false },
      inputSchema: z.object({
        issueKey: z.string().describe('Request key, e.g. SUP-1'),
        transitionName: z.string().describe('Transition name'),
      }),
    },
    async (args: Record<string, any>) => {
      const displayName = getCachedDisplayName(context.accountId);
      logger.info('jsm_transition_request invoked', {
        component: 'mcp/tool',
        tenantId: context.tenantId,
        accountId: context.accountId,
        displayName,
      });
      try {
        const { issueKey, transitionName } = args;

        if (!issueKey || !transitionName) {
          return {
            content: [{ type: 'text' as const, text: 'issueKey and transitionName are required' }],
            isError: true,
          };
        }

        // Get available transitions
        const transResponse = await auth.fetch(
          serviceDeskScopes('jsm_transition_request', false),
          `/rest/servicedeskapi/request/${issueKey}/transition`
        );
        if (!transResponse.ok) return errText(await describeJsmAuthFailure(transResponse));
        const transData = (await transResponse.json()) as any;

        const transition = transData.values?.find(
          (t: any) => t.name.toLowerCase() === transitionName.toLowerCase()
        );

        if (!transition) {
          return {
            content: [
              {
                type: 'text' as const,
                text: `Transition "${transitionName}" not found. Available: ${transData.values?.map((t: any) => t.name).join(', ') || 'none'}`,
              },
            ],
            isError: true,
          };
        }

        // Execute transition
        const execResponse = await auth.fetch(
          serviceDeskScopes('jsm_transition_request', false),
          `/rest/servicedeskapi/request/${issueKey}/transition`,
          {
            method: 'POST',
            // CustomerTransitionExecutionDTO is {id, additionalComment} —
            // the platform-style {transition:{id}} wrapper 400s here. The id
            // is a string in this API even when it looks numeric.
            body: JSON.stringify({ id: String(transition.id) }),
          }
        );
        if (!execResponse.ok) return errText(await describeJsmAuthFailure(execResponse));

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

  // jsm_list_customers
  server.registerTool(
    'jsm_list_customers',
    {
      title: 'JSM · Read — List customers in a service desk',
      description: 'List customers in a service desk.',
      annotations: { readOnlyHint: true },
      inputSchema: z.object({
        serviceDeskId: z.string().describe('Service desk ID'),
        maxResults: z.number().describe('Maximum results (1-50, default 10)').optional(),
      }),
    },
    async (args: Record<string, any>) => {
      const displayName = getCachedDisplayName(context.accountId);
      logger.info('jsm_list_customers invoked', {
        component: 'mcp/tool',
        tenantId: context.tenantId,
        accountId: context.accountId,
        displayName,
      });
      try {
        const { serviceDeskId, maxResults = 10 } = args;

        if (!serviceDeskId) {
          return {
            content: [{ type: 'text' as const, text: 'serviceDeskId is required' }],
            isError: true,
          };
        }

        const response = await auth.fetch(
          serviceDeskScopes('jsm_list_customers', true),
          `/rest/servicedeskapi/servicedesk/${serviceDeskId}/customer?limit=${Math.min(maxResults, 50)}`,
          // Atlassian has kept the customer endpoints "experimental" for
          // years; without the opt-in header they answer 412.
          { headers: { 'X-ExperimentalApi': 'opt-in' } }
        );
        if (!response.ok) return errText(await describeJsmAuthFailure(response));

        const data = (await response.json()) as any;
        const customers = (data.values || []).map((c: any) => ({
          id: c.accountId,
          name: c.displayName,
          email: c.email,
        }));

        const lines = [
          `Service desk has ${data.size ?? 0} customers (showing ${customers.length}):`,
          ...customers.map((c: any) => `• ${c.name} (${c.email})`),
        ];
        const text = lines.join('\n');

        return {
          content: [
            {
              type: 'text' as const,
              text:
                customers.length === 0
                  ? text
                  : withPresentationHint(
                      text,
                      'a table (Name, Email) usually scans faster than this flat list.'
                    ),
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
