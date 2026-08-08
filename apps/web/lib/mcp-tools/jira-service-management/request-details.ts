/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/consistent-type-assertions */
/**
 * Detailed request management tools for JSM.
 * Handle request approvals, SLA, participants, and attachments.
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/server';
import type { MCPToolContext } from '../common';
import { jiraFetch, getCachedDisplayName } from '../common';
import { logger } from '@/lib/logger';

export async function registerRequestDetailsTools(
  server: McpServer,
  context: MCPToolContext
): Promise<void> {
  // get_request_type_fields
  server.registerTool(
    'get_request_type_fields',
    {
      title: 'Describe the form for a request type',
      description: 'Get the form fields for a request type.',
      annotations: { readOnlyHint: true },
      inputSchema: z.object({
        serviceDeskId: z.string().describe('Service desk ID'),
        requestTypeId: z.string().describe('Request type ID'),
      }),
    },
    async (args: Record<string, any>) => {
      const displayName = getCachedDisplayName(context.accountId);
      logger.info('get_request_type_fields invoked', {
        component: 'mcp/tool',
        tenantId: context.tenantId,
        accountId: context.accountId,
        displayName,
      });
      try {
        const { serviceDeskId, requestTypeId } = args;

        if (!serviceDeskId || !requestTypeId) {
          return {
            content: [
              { type: 'text' as const, text: 'serviceDeskId and requestTypeId are required' },
            ],
            isError: true,
          };
        }

        const response = await jiraFetch(
          `${context.apiBaseUrl}/rest/servicedeskapi/servicedesk/${serviceDeskId}/requesttype/${requestTypeId}/field`,
          context.accessToken
        );

        const fields = (await response.json()) as any;
        const fieldList = (fields.values || []).map((f: any) => ({
          id: f.fieldId,
          name: f.name,
          required: f.required,
        }));

        const lines = [
          `Request type has ${fieldList.length} fields:`,
          ...fieldList.map((f: any) => `• ${f.name} (${f.id})${f.required ? ' [REQUIRED]' : ''}`),
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

  // list_request_approvals
  server.registerTool(
    'list_request_approvals',
    {
      title: 'List approvals on a customer request',
      description: 'List pending approvals on a request.',
      annotations: { readOnlyHint: true },
      inputSchema: z.object({
        issueKey: z.string().describe('Request key, e.g. SUP-1'),
      }),
    },
    async (args: Record<string, any>) => {
      const displayName = getCachedDisplayName(context.accountId);
      logger.info('list_request_approvals invoked', {
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

        const response = await jiraFetch(
          `${context.apiBaseUrl}/rest/servicedeskapi/request/${issueKey}/approval`,
          context.accessToken
        );

        const data = (await response.json()) as any;
        const approvals = (data.values || []).map((a: any) => ({
          id: a.id,
          name: a.name,
          status: a.status,
        }));

        const lines = [
          `${issueKey} has ${approvals.length} approvals:`,
          ...approvals.map((a: any) => `• ${a.name} [${a.status}]`),
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

  // get_request_sla
  server.registerTool(
    'get_request_sla',
    {
      title: 'Read the SLA clocks on a customer request',
      description: 'Get SLA information for a request.',
      annotations: { readOnlyHint: true },
      inputSchema: z.object({
        issueKey: z.string().describe('Request key, e.g. SUP-1'),
      }),
    },
    async (args: Record<string, any>) => {
      const displayName = getCachedDisplayName(context.accountId);
      logger.info('get_request_sla invoked', {
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

        const response = await jiraFetch(
          `${context.apiBaseUrl}/rest/servicedeskapi/request/${issueKey}/sla`,
          context.accessToken
        );

        const data = (await response.json()) as any;
        const slas = (data.values || []).map((s: any) => ({
          name: s.name,
          status: s.status,
          breachTime: s.breachTime?.epoch || 'N/A',
        }));

        const lines = [
          `${issueKey} has ${slas.length} SLAs:`,
          ...slas.map((s: any) => `• ${s.name}: ${s.status} (breach: ${s.breachTime})`),
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

  // list_request_participants
  server.registerTool(
    'list_request_participants',
    {
      title: 'List participants on a customer request',
      description: 'List participants on a request.',
      annotations: { readOnlyHint: true },
      inputSchema: z.object({
        issueKey: z.string().describe('Request key, e.g. SUP-1'),
      }),
    },
    async (args: Record<string, any>) => {
      const displayName = getCachedDisplayName(context.accountId);
      logger.info('list_request_participants invoked', {
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

        const response = await jiraFetch(
          `${context.apiBaseUrl}/rest/servicedeskapi/request/${issueKey}/participant`,
          context.accessToken
        );

        const data = (await response.json()) as any;
        const participants = (data.values || []).map((p: any) => ({
          name: p.displayName,
          email: p.emailAddress,
        }));

        const lines = [
          `${issueKey} has ${participants.length} participants:`,
          ...participants.map((p: any) => `• ${p.name} (${p.email})`),
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

  // add_request_participant
  server.registerTool(
    'add_request_participant',
    {
      title: 'Add a participant to a customer request',
      description: 'Add a participant to a request.',
      inputSchema: z.object({
        issueKey: z.string().describe('Request key, e.g. SUP-1'),
        accountId: z.string().describe('Account ID of user to add'),
      }),
    },
    async (args: Record<string, any>) => {
      const displayName = getCachedDisplayName(context.accountId);
      logger.info('add_request_participant invoked', {
        component: 'mcp/tool',
        tenantId: context.tenantId,
        accountId: context.accountId,
        displayName,
      });
      try {
        const { issueKey, accountId } = args;

        if (!issueKey || !accountId) {
          return {
            content: [{ type: 'text' as const, text: 'issueKey and accountId are required' }],
            isError: true,
          };
        }

        await jiraFetch(
          `${context.apiBaseUrl}/rest/servicedeskapi/request/${issueKey}/participant`,
          context.accessToken,
          {
            method: 'POST',
            body: JSON.stringify({
              accountIds: [accountId],
            }),
          }
        );

        return { content: [{ type: 'text' as const, text: `Added participant to ${issueKey}` }] };
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

  // remove_request_participant
  server.registerTool(
    'remove_request_participant',
    {
      title: 'Remove a participant from a customer request',
      description: 'Remove a participant from a request.',
      inputSchema: z.object({
        issueKey: z.string().describe('Request key, e.g. SUP-1'),
        accountId: z.string().describe('Account ID of user to remove'),
      }),
    },
    async (args: Record<string, any>) => {
      const displayName = getCachedDisplayName(context.accountId);
      logger.info('remove_request_participant invoked', {
        component: 'mcp/tool',
        tenantId: context.tenantId,
        accountId: context.accountId,
        displayName,
      });
      try {
        const { issueKey, accountId } = args;

        if (!issueKey || !accountId) {
          return {
            content: [{ type: 'text' as const, text: 'issueKey and accountId are required' }],
            isError: true,
          };
        }

        // The account id goes in the body, not the path: there is no
        // .../participant/{accountId} route, so the old form 404'd and the tool
        // still reported success because nothing checked the status.
        await jiraFetch(
          `${context.apiBaseUrl}/rest/servicedeskapi/request/${issueKey}/participant`,
          context.accessToken,
          {
            method: 'DELETE',
            body: JSON.stringify({ accountIds: [accountId] }),
          }
        );

        return {
          content: [{ type: 'text' as const, text: `Removed participant from ${issueKey}` }],
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

  // add_request_attachment
  server.registerTool(
    'add_request_attachment',
    {
      title: 'Attach a file to a customer request',
      description: 'Upload a file attachment to a request.',
      inputSchema: z.object({
        issueKey: z.string().describe('Request key, e.g. SUP-1'),
        filename: z.string().describe('File name'),
        contentBase64: z.string().describe('File content as base64'),
      }),
    },
    async (args: Record<string, any>) => {
      const displayName = getCachedDisplayName(context.accountId);
      logger.info('add_request_attachment invoked', {
        component: 'mcp/tool',
        tenantId: context.tenantId,
        accountId: context.accountId,
        displayName,
      });
      try {
        const { issueKey, filename, contentBase64 } = args;

        if (!issueKey || !filename || !contentBase64) {
          return {
            content: [
              { type: 'text' as const, text: 'issueKey, filename, and contentBase64 are required' },
            ],
            isError: true,
          };
        }

        const binaryString = Buffer.from(contentBase64 as string, 'base64').toString('binary');
        const blob = Buffer.from(binaryString, 'binary');
        const formData = new FormData();
        formData.append('file', new Blob([blob]), filename);

        const response = await fetch(
          `${context.apiBaseUrl}/rest/servicedeskapi/request/${issueKey}/attachment`,
          {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${context.accessToken}`,
            },
            body: formData,
          }
        );

        if (!response.ok) {
          throw new Error(`Upload failed: ${response.statusText}`);
        }

        return {
          content: [{ type: 'text' as const, text: `Attached ${filename} to ${issueKey}` }],
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
