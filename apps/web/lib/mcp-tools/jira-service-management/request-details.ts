/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/consistent-type-assertions */
/**
 * Detailed request management tools for JSM.
 * Handle request approvals, SLA, participants, and attachments.
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/server';
import type { MCPToolContext } from '../common';
import { getCachedDisplayName, withPresentationHint } from '../common';
import { logger } from '@/lib/logger';
import { serviceDeskScopes, describeJsmAuthFailure, type JsmAuth } from './jsm-auth';
import { base64LengthFor, decodeBase64Attachment } from '../fetch-guard';

const DEFAULT_MAX_ATTACHMENT_BYTES = 20_971_520; // 20MB — matches jira_add_attachment

function errText(value: string) {
  return { content: [{ type: 'text' as const, text: value }], isError: true };
}

export async function registerRequestDetailsTools(
  server: McpServer,
  context: MCPToolContext,
  auth: JsmAuth
): Promise<void> {
  // jsm_get_request_type_fields
  server.registerTool(
    'jsm_get_request_type_fields',
    {
      title: 'JSM · Read — Describe the form for a request type',
      description: 'Get the form fields for a request type.',
      annotations: { readOnlyHint: true },
      inputSchema: z.object({
        serviceDeskId: z.string().describe('Service desk ID'),
        requestTypeId: z.string().describe('Request type ID'),
      }),
    },
    async (args: Record<string, any>) => {
      const displayName = getCachedDisplayName(context.accountId);
      logger.info('jsm_get_request_type_fields invoked', {
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

        const response = await auth.fetch(
          serviceDeskScopes('jsm_get_request_type_fields', true),
          `/rest/servicedeskapi/servicedesk/${serviceDeskId}/requesttype/${requestTypeId}/field`
        );
        if (!response.ok) return errText(await describeJsmAuthFailure(response));

        const fields = (await response.json()) as any;
        // The payload key is requestTypeFields — .values belongs to the paged
        // JSM endpoints, so this silently mapped an empty list ("0 fields").
        const fieldList = (fields.requestTypeFields || fields.values || []).map((f: any) => ({
          id: f.fieldId,
          name: f.name,
          required: f.required,
        }));

        const lines = [
          `Request type has ${fieldList.length} fields:`,
          ...fieldList.map((f: any) => `• ${f.name} (${f.id})${f.required ? ' [REQUIRED]' : ''}`),
        ];
        const text = lines.join('\n');

        return {
          content: [
            {
              type: 'text' as const,
              text:
                fieldList.length === 0
                  ? text
                  : withPresentationHint(
                      text,
                      'a table (Field, Type, Required) usually scans faster than this flat list — ' +
                        'request forms often have many fields.'
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

  // jsm_list_request_approvals
  server.registerTool(
    'jsm_list_request_approvals',
    {
      title: 'JSM · Read — List approvals on a customer request',
      description: 'List pending approvals on a request.',
      annotations: { readOnlyHint: true },
      inputSchema: z.object({
        issueKey: z.string().describe('Request key, e.g. SUP-1'),
      }),
    },
    async (args: Record<string, any>) => {
      const displayName = getCachedDisplayName(context.accountId);
      logger.info('jsm_list_request_approvals invoked', {
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
          serviceDeskScopes('jsm_list_request_approvals', true),
          `/rest/servicedeskapi/request/${issueKey}/approval`
        );
        if (!response.ok) return errText(await describeJsmAuthFailure(response));

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
        const text = lines.join('\n');

        return {
          content: [
            {
              type: 'text' as const,
              text:
                approvals.length === 0
                  ? text
                  : withPresentationHint(
                      text,
                      'a table (Approver, Status, Decided) usually scans faster than this flat list.'
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

  // jsm_get_request_sla
  server.registerTool(
    'jsm_get_request_sla',
    {
      title: 'JSM · Read — Read the SLA clocks on a customer request',
      description: 'Get SLA information for a request.',
      annotations: { readOnlyHint: true },
      inputSchema: z.object({
        issueKey: z.string().describe('Request key, e.g. SUP-1'),
      }),
    },
    async (args: Record<string, any>) => {
      const displayName = getCachedDisplayName(context.accountId);
      logger.info('jsm_get_request_sla invoked', {
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
          serviceDeskScopes('jsm_get_request_sla', true),
          `/rest/servicedeskapi/request/${issueKey}/sla`
        );
        if (!response.ok) return errText(await describeJsmAuthFailure(response));

        const data = (await response.json()) as any;
        // SlaInformation has no status/breachTime at the top level: the live
        // clock is ongoingCycle {breached, paused, remainingTime, breachTime},
        // finished clocks are completedCycles.
        const slas = (data.values || []).map((s: any) => {
          const cycle = s.ongoingCycle;
          const state = cycle
            ? cycle.paused
              ? 'paused'
              : cycle.breached
                ? 'BREACHED'
                : `remaining ${cycle.remainingTime?.friendly ?? '?'}`
            : `no running cycle (${s.completedCycles?.length ?? 0} completed)`;
          const breach = cycle?.breachTime?.friendly;
          return `• ${s.name}: ${state}${breach ? ` — breach at ${breach}` : ''}`;
        });

        const lines = [`${issueKey} has ${slas.length} SLAs:`, ...slas];
        const text = lines.join('\n');

        return {
          content: [
            {
              type: 'text' as const,
              // A request usually carries just one or two SLA clocks — a
              // hint only earns its keep once there's an actual multi-row
              // list to reformat.
              text:
                slas.length > 1
                  ? withPresentationHint(
                      text,
                      'a small table (SLA, State, Breach time) usually scans faster than this flat ' +
                        'list when there is more than one SLA metric.'
                    )
                  : text,
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

  // jsm_list_request_participants
  server.registerTool(
    'jsm_list_request_participants',
    {
      title: 'JSM · Read — List participants on a customer request',
      description: 'List participants on a request.',
      annotations: { readOnlyHint: true },
      inputSchema: z.object({
        issueKey: z.string().describe('Request key, e.g. SUP-1'),
      }),
    },
    async (args: Record<string, any>) => {
      const displayName = getCachedDisplayName(context.accountId);
      logger.info('jsm_list_request_participants invoked', {
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
          serviceDeskScopes('jsm_list_request_participants', true),
          `/rest/servicedeskapi/request/${issueKey}/participant`
        );
        if (!response.ok) return errText(await describeJsmAuthFailure(response));

        const data = (await response.json()) as any;
        const participants = (data.values || []).map((p: any) => ({
          name: p.displayName,
          email: p.emailAddress,
        }));

        const lines = [
          `${issueKey} has ${participants.length} participants:`,
          ...participants.map((p: any) => `• ${p.name} (${p.email})`),
        ];
        const text = lines.join('\n');

        return {
          content: [
            {
              type: 'text' as const,
              text:
                participants.length === 0
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

  // jsm_add_request_participant
  server.registerTool(
    'jsm_add_request_participant',
    {
      title: 'JSM · Act — Add a participant to a customer request',
      description: 'Add a participant to a request.',
      annotations: { readOnlyHint: false },
      inputSchema: z.object({
        issueKey: z.string().describe('Request key, e.g. SUP-1'),
        accountId: z.string().describe('Account ID of user to add'),
      }),
    },
    async (args: Record<string, any>) => {
      const displayName = getCachedDisplayName(context.accountId);
      logger.info('jsm_add_request_participant invoked', {
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

        const response = await auth.fetch(
          serviceDeskScopes('jsm_add_request_participant', false),
          `/rest/servicedeskapi/request/${issueKey}/participant`,
          {
            method: 'POST',
            body: JSON.stringify({
              accountIds: [accountId],
            }),
          }
        );
        if (!response.ok) return errText(await describeJsmAuthFailure(response));

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

  // jsm_remove_request_participant
  server.registerTool(
    'jsm_remove_request_participant',
    {
      title: 'JSM · Act — Remove a participant from a customer request',
      description: 'Remove a participant from a request.',
      annotations: { readOnlyHint: false },
      inputSchema: z.object({
        issueKey: z.string().describe('Request key, e.g. SUP-1'),
        accountId: z.string().describe('Account ID of user to remove'),
      }),
    },
    async (args: Record<string, any>) => {
      const displayName = getCachedDisplayName(context.accountId);
      logger.info('jsm_remove_request_participant invoked', {
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
        const response = await auth.fetch(
          serviceDeskScopes('jsm_remove_request_participant', false),
          `/rest/servicedeskapi/request/${issueKey}/participant`,
          {
            method: 'DELETE',
            body: JSON.stringify({ accountIds: [accountId] }),
          }
        );
        if (!response.ok) return errText(await describeJsmAuthFailure(response));

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

  // jsm_add_request_attachment
  server.registerTool(
    'jsm_add_request_attachment',
    {
      title: 'JSM · Act — Attach a file to a customer request',
      description: 'Upload a file attachment to a request.',
      annotations: { readOnlyHint: false },
      inputSchema: z.object({
        issueKey: z.string().describe('Request key, e.g. SUP-1'),
        filename: z.string().describe('File name'),
        contentBase64: z
          .string()
          .min(1)
          .max(base64LengthFor(context.maxAttachmentBytes ?? DEFAULT_MAX_ATTACHMENT_BYTES))
          .describe(
            "The file's bytes, base64-encoded (a data:*;base64, URL prefix is stripped " +
              'automatically).'
          ),
      }),
    },
    async (args: Record<string, any>) => {
      const displayName = getCachedDisplayName(context.accountId);
      logger.info('jsm_add_request_attachment invoked', {
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

        // The servicedeskapi attachment flow is two-legged: multipart upload
        // to the SERVICE DESK's attachTemporaryFile, then attach the returned
        // temporary ids to the request as JSON (AttachmentCreateDTO:
        // temporaryAttachmentIds + public). The old code POSTed multipart
        // straight at the request — a shape this API never accepted — and
        // bypassed jiraFetch, so the failures never even reached the logs.
        const reqResponse = await auth.fetch(
          serviceDeskScopes('jsm_add_request_attachment', false),
          `/rest/servicedeskapi/request/${encodeURIComponent(issueKey as string)}`
        );
        if (!reqResponse.ok) return errText(await describeJsmAuthFailure(reqResponse));
        const reqBody = (await reqResponse.json()) as any;
        const serviceDeskId =
          typeof reqBody?.serviceDeskId === 'string' ? reqBody.serviceDeskId : '';
        if (!serviceDeskId) {
          return {
            content: [
              { type: 'text' as const, text: `Could not resolve the service desk of ${issueKey}` },
            ],
            isError: true,
          };
        }

        const decoded = decodeBase64Attachment(String(contentBase64));
        if (!decoded.ok) {
          return { content: [{ type: 'text' as const, text: decoded.error }], isError: true };
        }
        const bytes = decoded.buffer;
        // Same org-configurable ceiling as jira_add_attachment — this tool
        // previously had no cap at all.
        const maxBytes = context.maxAttachmentBytes ?? DEFAULT_MAX_ATTACHMENT_BYTES;
        if (bytes.byteLength > maxBytes) {
          return {
            content: [
              {
                type: 'text' as const,
                text: `Attachment is ${bytes.byteLength} bytes; the limit is ${maxBytes} bytes (MAX_ATTACHMENT_BYTES)`,
              },
            ],
            isError: true,
          };
        }
        const formData = new FormData();
        formData.append('file', new Blob([bytes]), filename as string);

        const upload = await auth.fetch(
          serviceDeskScopes('jsm_add_request_attachment', false),
          `/rest/servicedeskapi/servicedesk/${serviceDeskId}/attachTemporaryFile`,
          {
            method: 'POST',
            body: formData,
            // Required for multipart uploads to Atlassian; without it 404/403.
            headers: { 'X-Atlassian-Token': 'no-check' },
          }
        );
        if (!upload.ok) return errText(await describeJsmAuthFailure(upload));
        const uploaded = (await upload.json()) as any;
        const temporaryAttachmentIds = Array.isArray(uploaded?.temporaryAttachments)
          ? uploaded.temporaryAttachments
              .map((t: any) =>
                typeof t?.temporaryAttachmentId === 'string' ? t.temporaryAttachmentId : ''
              )
              .filter(Boolean)
          : [];
        if (temporaryAttachmentIds.length === 0) {
          return {
            content: [
              { type: 'text' as const, text: 'Upload succeeded but returned no attachment id' },
            ],
            isError: true,
          };
        }

        const attachResponse = await auth.fetch(
          serviceDeskScopes('jsm_add_request_attachment', false),
          `/rest/servicedeskapi/request/${encodeURIComponent(issueKey as string)}/attachment`,
          {
            method: 'POST',
            body: JSON.stringify({ temporaryAttachmentIds, public: true }),
          }
        );
        if (!attachResponse.ok) return errText(await describeJsmAuthFailure(attachResponse));

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
