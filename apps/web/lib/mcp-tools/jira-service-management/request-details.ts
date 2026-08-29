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
import { createUploadSlot } from '../upload-slots';
// The same spelling jira_list_fields gives a Jira option field: the two are
// one question asked of two systems, and a caller reading both should not
// have to notice which it is looking at.
import { renderOptions } from '../jira/field-schema';

/** How many of a field's accepted values one line spells out. */
const VALUES_SHOWN = 25;

/** An ISO timestamp out of JSM's date object, which wraps every format. */
function jsmDate(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value !== 'object' || value === null) return '';
  const date: { iso8601?: unknown; friendly?: unknown } = value;
  if (typeof date.iso8601 === 'string') return date.iso8601;
  return typeof date.friendly === 'string' ? date.friendly : '';
}

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
      logger.debug('jsm_get_request_type_fields invoked', {
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
          // The hint below promised a Type column this never carried, and
          // the id alone is half an answer anyway: a caller still has to
          // guess whether the field wants a string, a date or one of a
          // closed set, and jsm_create_request answers a wrong guess with a
          // 400 that names nothing.
          type: typeof f.jiraSchema?.type === 'string' ? f.jiraSchema.type : '',
          // JSM sends the accepted values IN THIS RESPONSE — a form
          // description that drops them leaves the caller inventing one.
          // `value` is what a write sends; `label` is what a person reads.
          values: (Array.isArray(f.validValues) ? f.validValues : []).map((v: any) => ({
            value: typeof v.label === 'string' ? v.label : String(v.value ?? ''),
            id: typeof v.value === 'string' ? v.value : undefined,
          })),
          description: typeof f.description === 'string' ? f.description.trim() : '',
        }));

        const lines = [
          `Request type has ${fieldList.length} fields:`,
          ...fieldList.flatMap((f: any) => [
            `• ${f.name} (${f.id})${f.type ? ` - ${f.type}` : ''}${f.required ? ' [REQUIRED]' : ''}`,
            ...(f.values.length > 0
              ? [
                  `    accepts: ${renderOptions(f.values, VALUES_SHOWN)}` +
                    (f.values.length > VALUES_SHOWN
                      ? `, +${f.values.length - VALUES_SHOWN} more`
                      : ''),
                ]
              : []),
            ...(f.description ? [`    ${f.description}`] : []),
          ]),
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
      logger.debug('jsm_list_request_approvals invoked', {
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
          // The JSM payload calls it finalDecision; `status` alone rendered
          // "[undefined]" on every row.
          status: a.finalDecision || a.status || 'unknown',
          // Who is actually being waited on, and what each of them said —
          // "Manager approval [pending]" does not say whose desk it is on.
          approvers: (Array.isArray(a.approvers) ? a.approvers : []).map((entry: any) => {
            const who = entry?.approver?.displayName || entry?.approver?.accountId || 'someone';
            const decision = entry?.approverDecision;
            return decision ? `${who} (${decision})` : who;
          }),
          // The hint promised a Decided column; the dates were in hand.
          decided: jsmDate(a.completedDate),
          created: jsmDate(a.createdDate),
        }));

        const lines = [
          `${issueKey} has ${approvals.length} approvals:`,
          ...approvals.map(
            (a: any) =>
              `• ${a.name} [${a.status}]` +
              (a.decided ? ` — decided ${a.decided}` : a.created ? ` — raised ${a.created}` : '') +
              (a.approvers.length > 0 ? ` — approvers: ${a.approvers.join(', ')}` : '')
          ),
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
      logger.debug('jsm_get_request_sla invoked', {
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
      logger.debug('jsm_list_request_participants invoked', {
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
      logger.debug('jsm_add_request_participant invoked', {
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
      logger.debug('jsm_remove_request_participant invoked', {
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

  // jsm_request_attachment_upload — the out-of-band byte path; JSM tool
  // arguments must never carry file content (model-generated base64 at any
  // real size reads as a hang).
  server.registerTool(
    'jsm_request_attachment_upload',
    {
      title: 'JSM · Act — Request an upload endpoint for a request attachment',
      description:
        'Attach a NEW file to a customer request — without base64. Returns a short-lived ' +
        'single-use endpoint; send the raw bytes there (curl with the Authorization header, ' +
        'or the returned browser link). Never generate file content as a tool argument.',
      annotations: { readOnlyHint: false },
      inputSchema: z.object({
        issueKey: z.string().describe('Request key, e.g. SUP-1'),
        filename: z.string().min(1).describe('File name'),
        contentType: z.string().describe('MIME type (optional)').optional(),
      }),
    },
    async (args: Record<string, any>) => {
      const displayName = getCachedDisplayName(context.accountId);
      logger.debug('jsm_request_attachment_upload invoked', {
        component: 'mcp/tool',
        tenantId: context.tenantId,
        accountId: context.accountId,
        displayName,
      });
      const issueKey = typeof args.issueKey === 'string' ? args.issueKey : '';
      const filename = typeof args.filename === 'string' ? args.filename : '';
      if (!issueKey || !filename) {
        return {
          content: [{ type: 'text' as const, text: 'issueKey and filename are required' }],
          isError: true,
        };
      }
      const slot = await createUploadSlot(
        context,
        'jsm-attachment',
        { requestKey: issueKey },
        {
          filename,
          contentType: typeof args.contentType === 'string' ? args.contentType : undefined,
          maxBytes: context.maxAttachmentBytes ?? DEFAULT_MAX_ATTACHMENT_BYTES,
        }
      );
      if (!slot.ok) {
        return { content: [{ type: 'text' as const, text: slot.error }], isError: true };
      }
      return { content: [{ type: 'text' as const, text: slot.instructions }] };
    }
  );
}
