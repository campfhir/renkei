/**
 * Detailed request management tools for JSM.
 * Handle request approvals, SLA, participants, and attachments.
 */

import type { MCPToolContext, MCPToolResult } from '../common';
import { ok, toolError, jiraFetch } from '../common';

export interface RequestDetailsToolHandler {
  name: string;
  description: string;
  inputSchema?: Record<string, any>;
  handler: (context: MCPToolContext, params: any) => Promise<MCPToolResult>;
}

export const requestDetailsTools: RequestDetailsToolHandler[] = [
  {
    name: 'get_request_type_fields',
    description: 'Get the form fields for a request type.',
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
      },
      required: ['serviceDeskId', 'requestTypeId'],
    },
    handler: async (context, params) => {
      const { serviceDeskId, requestTypeId } = params;

      if (!serviceDeskId || !requestTypeId) {
        return toolError('serviceDeskId and requestTypeId are required');
      }

      try {
        const response = await jiraFetch(
          `${context.siteUrl}/rest/servicedeskapi/servicedesk/${serviceDeskId}/requesttype/${requestTypeId}/field`,
          context.accessToken,
        );

        const fields = (await response.json()) as any;
        const fieldList = (fields.values || []).map((f: any) => ({
          id: f.fieldId,
          name: f.name,
          required: f.required,
        }));

        const lines = [
          `Request type has ${fieldList.length} fields:`,
          ...fieldList.map(
            (f: any) => `• ${f.name} (${f.id})${f.required ? ' [REQUIRED]' : ''}`,
          ),
        ];

        return ok(lines.join('\n'));
      } catch (error) {
        return toolError(`Failed to get request type fields: ${error instanceof Error ? error.message : String(error)}`);
      }
    },
  },

  {
    name: 'list_request_approvals',
    description: 'List pending approvals on a request.',
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
          `${context.siteUrl}/rest/servicedeskapi/request/${issueKey}/approval`,
          context.accessToken,
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

        return ok(lines.join('\n'));
      } catch (error) {
        return toolError(`Failed to list approvals: ${error instanceof Error ? error.message : String(error)}`);
      }
    },
  },

  {
    name: 'get_request_sla',
    description: 'Get SLA information for a request.',
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
          `${context.siteUrl}/rest/servicedeskapi/request/${issueKey}/sla`,
          context.accessToken,
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

        return ok(lines.join('\n'));
      } catch (error) {
        return toolError(`Failed to get SLA: ${error instanceof Error ? error.message : String(error)}`);
      }
    },
  },

  {
    name: 'list_request_participants',
    description: 'List participants on a request.',
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
          `${context.siteUrl}/rest/servicedeskapi/request/${issueKey}/participant`,
          context.accessToken,
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

        return ok(lines.join('\n'));
      } catch (error) {
        return toolError(`Failed to list participants: ${error instanceof Error ? error.message : String(error)}`);
      }
    },
  },

  {
    name: 'add_request_participant',
    description: 'Add a participant to a request.',
    inputSchema: {
      type: 'object',
      properties: {
        issueKey: {
          type: 'string',
          description: 'Request key, e.g. SUP-1',
        },
        accountId: {
          type: 'string',
          description: 'Account ID of user to add',
        },
      },
      required: ['issueKey', 'accountId'],
    },
    handler: async (context, params) => {
      const { issueKey, accountId } = params;

      if (!issueKey || !accountId) {
        return toolError('issueKey and accountId are required');
      }

      try {
        await jiraFetch(
          `${context.siteUrl}/rest/servicedeskapi/request/${issueKey}/participant`,
          context.accessToken,
          {
            method: 'POST',
            body: JSON.stringify({
              accountIds: [accountId],
            }),
          },
        );

        return ok(`Added participant to ${issueKey}`);
      } catch (error) {
        return toolError(`Failed to add participant: ${error instanceof Error ? error.message : String(error)}`);
      }
    },
  },

  {
    name: 'remove_request_participant',
    description: 'Remove a participant from a request.',
    inputSchema: {
      type: 'object',
      properties: {
        issueKey: {
          type: 'string',
          description: 'Request key, e.g. SUP-1',
        },
        accountId: {
          type: 'string',
          description: 'Account ID of user to remove',
        },
      },
      required: ['issueKey', 'accountId'],
    },
    handler: async (context, params) => {
      const { issueKey, accountId } = params;

      if (!issueKey || !accountId) {
        return toolError('issueKey and accountId are required');
      }

      try {
        await jiraFetch(
          `${context.siteUrl}/rest/servicedeskapi/request/${issueKey}/participant/${accountId}`,
          context.accessToken,
          {
            method: 'DELETE',
          },
        );

        return ok(`Removed participant from ${issueKey}`);
      } catch (error) {
        return toolError(`Failed to remove participant: ${error instanceof Error ? error.message : String(error)}`);
      }
    },
  },

  {
    name: 'add_request_attachment',
    description: 'Upload a file attachment to a request.',
    inputSchema: {
      type: 'object',
      properties: {
        issueKey: {
          type: 'string',
          description: 'Request key, e.g. SUP-1',
        },
        filename: {
          type: 'string',
          description: 'File name',
        },
        contentBase64: {
          type: 'string',
          description: 'File content as base64',
        },
      },
      required: ['issueKey', 'filename', 'contentBase64'],
    },
    handler: async (context, params) => {
      const { issueKey, filename, contentBase64 } = params;

      if (!issueKey || !filename || !contentBase64) {
        return toolError('issueKey, filename, and contentBase64 are required');
      }

      try {
        const binaryString = Buffer.from(contentBase64, 'base64').toString('binary');
        const blob = Buffer.from(binaryString, 'binary');
        const formData = new FormData();
        formData.append('file', new Blob([blob]), filename);

        const response = await fetch(
          `${context.siteUrl}/rest/servicedeskapi/request/${issueKey}/attachment`,
          {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${context.accessToken}`,
            },
            body: formData,
          },
        );

        if (!response.ok) {
          throw new Error(`Upload failed: ${response.statusText}`);
        }

        return ok(`Attached ${filename} to ${issueKey}`);
      } catch (error) {
        return toolError(`Failed to add attachment: ${error instanceof Error ? error.message : String(error)}`);
      }
    },
  },
];
