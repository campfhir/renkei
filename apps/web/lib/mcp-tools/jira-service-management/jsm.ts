/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/consistent-type-assertions */
/**
 * Jira Service Management (JSM) tools for MCP.
 * Handle customer requests, service desks, and support operations.
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/server';
import type { MCPToolContext } from '../common';
import { actMeta } from '@renkei/tool-outcomes';
import {
  JiraApiError,
  getCachedDisplayName,
  issueUrl,
  requestUrl,
  withPresentationHint,
} from '../common';
import { logger } from '@/lib/logger';
import {
  APP_ONLY_META,
  ISSUE_PREVIEW_URI,
  RESULTS_LIST_URI,
  confirmGuard,
  previewToolMeta,
  newPreviewId,
} from '../widgets';
import { serviceDeskScopes, describeJsmAuthFailure, type JsmAuth } from './jsm-auth';
import {
  describeComponents,
  fieldOptionsOf,
  loadProjectComponents,
  loadRequestTypeComponents,
  loadRequestTypeForm,
  matchComponents,
  resolveServiceDesk,
} from './components';
import { resolveUserId } from '../jira/resolve-user';

/**
 * The cross-family platform scope for the post-create edit below (assignee,
 * and priority when the request form cannot carry it). Same story as
 * read:project.component:jira: the servicedeskapi genuinely has no way to
 * express these, so the JSM app carries one Jira-API write scope, and a
 * grant minted before it was added gets a denial that names the fix.
 */
const ISSUE_EDIT_WRITE = 'write:issue:jira';

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
      logger.debug('jsm_list_service_desks invoked', {
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
      logger.debug('jsm_list_request_types invoked', {
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
      logger.debug('jsm_list_requests invoked', {
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
          reporter: req.reporter?.displayName || '',
        }));

        const lines = [
          `Found ${data.size ?? 0} requests (showing ${requests.length}):`,
          ...requests.map(
            (r: any) =>
              `• ${r.key}: ${r.summary} [${r.status}]` +
              (r.reporter ? ` reported by ${r.reporter}` : '')
          ),
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

  // ——— Interactive results (MCP Apps) ————————————————————————————————
  // The queue as a card. Each request carries BOTH of its lives: the agent
  // view (the Jira issue) and the customer portal view — different URLs,
  // different audiences, one click each.
  server.registerTool(
    'jsm_list_requests_preview',
    {
      title: 'JSM · Read — List requests, rendered as a card',
      description:
        'List customer requests and render them as an interactive card where each request has ' +
        'an "Agent view" link (the Jira issue) and a "Customer portal" link. Prefer this over ' +
        'jsm_list_requests when the user wants to SEE the queue; use jsm_list_requests when ' +
        'you need the rows to reason over. After calling, do not repeat the rows in your ' +
        'reply — reference request keys only.',
      annotations: { readOnlyHint: true },
      _meta: previewToolMeta(RESULTS_LIST_URI),
      inputSchema: z.object({
        serviceDeskId: z.string().describe('Service desk ID (optional)').optional(),
        maxResults: z.number().describe('Maximum results (1-100, default 25)').optional(),
      }),
    },
    async (args: Record<string, any>) => {
      try {
        const maxResults = Math.min(args.maxResults || 25, 100);
        const query = new URLSearchParams({ limit: String(maxResults) });
        if (args.serviceDeskId) query.append('serviceDeskId', args.serviceDeskId);

        const response = await auth.fetch(
          serviceDeskScopes('jsm_list_requests', true),
          `/rest/servicedeskapi/request?${query}`
        );
        if (!response.ok) return errText(await describeJsmAuthFailure(response));

        const data = (await response.json()) as any;
        const requests: any[] = Array.isArray(data.values) ? data.values : [];
        // Grouped by status like the Jira card. The servicedeskapi DTO
        // carries no status category, so group chips stay neutral-toned.
        const grouped = new Map<string, any[]>();
        for (const req of requests) {
          const key = str(req.issueKey);
          const status = str(req.currentStatus?.status) || 'Unknown';
          const reporterName = str(req.reporter?.displayName);
          const avatarUrl = str(
            req.reporter?.avatarUrls?.['24x24'] ?? req.reporter?.avatarUrls?.['48x48']
          );
          const row = {
            key,
            title: `${key} — ${str(req.summary)}`,
            meta: str(req.requestType?.name),
            people: reporterName
              ? [{ name: reporterName, ...(avatarUrl ? { avatarUrl } : {}), role: 'reporter' }]
              : [],
            links: [
              { label: 'Agent view', url: issueUrl(context.siteUrl, key) },
              { label: 'Customer portal', url: requestUrl(context.siteUrl, key) },
            ],
          };
          grouped.set(status, [...(grouped.get(status) ?? []), row]);
        }
        const groups = [...grouped.entries()].map(([label, rows]) => ({
          label,
          chip: { label, tone: 'neutral' },
          rows: rows.map(({ key: _key, ...row }) => row),
        }));

        const keys = requests.map((req: any) => str(req.issueKey));
        return {
          content: [
            {
              type: 'text' as const,
              text:
                `${keys.length} request${keys.length === 1 ? '' : 's'} rendered on the card, ` +
                `grouped by status` +
                (keys.length > 0 ? `: ${keys.join(', ')}` : '.') +
                ' Do not repeat the rows; the user sees them on the card.',
            },
          ],
          structuredContent: {
            kind: 'results',
            title: 'Service desk requests',
            groups,
            // Flat duplicate for hosts still holding a pre-`groups`
            // template — see the identical note in jira_search_issues_preview.
            rows: groups.flatMap((group) => group.rows),
          },
        };
      } catch (error) {
        return errText(error instanceof Error ? error.message : String(error));
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
      logger.debug('jsm_get_request invoked', {
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

  // jsm_list_components
  server.registerTool(
    'jsm_list_components',
    {
      title: 'JSM · Read — List the components on a service desk',
      description:
        "List a service desk's components, so a request can be filed under the right one. " +
        'Pass requestTypeId to get the components THAT request type can actually set — a ' +
        'request form does not always carry the components field, and when it does its list ' +
        'is what jsm_create_request accepts. Without it you get every component on the ' +
        "desk's project, which needs the Jira project-component scope on this connection.",
      annotations: { readOnlyHint: true },
      inputSchema: z.object({
        serviceDeskId: z.string().describe('Service desk id, or the project key'),
        requestTypeId: z
          .string()
          .describe('Limit to what this request type accepts (from jsm_list_request_types)')
          .optional(),
      }),
    },
    async (args: Record<string, any>) => {
      const displayName = getCachedDisplayName(context.accountId);
      logger.debug('jsm_list_components invoked', {
        component: 'mcp/tool',
        tenantId: context.tenantId,
        accountId: context.accountId,
        displayName,
      });
      try {
        const desk = await resolveServiceDesk(auth, str(args.serviceDeskId));
        if (!desk.ok) return errText(desk.message);

        const requestTypeId = str(args.requestTypeId);
        if (requestTypeId) {
          const found = await loadRequestTypeComponents(auth, desk.desk.id, requestTypeId);
          if (!found.ok) return errText(found.message);
          if (!found.components.present) {
            // Not an error — a form without the field is a normal, and
            // important, answer: nothing can set a component on this
            // request type, so a caller should stop trying rather than
            // retry with a different name.
            return {
              content: [
                {
                  type: 'text' as const,
                  text:
                    `Request type ${requestTypeId} has no components field on its form, so ` +
                    `a request of this type cannot carry one. Set it on the issue afterwards ` +
                    `with jira_update_issue if it needs one.`,
                },
              ],
            };
          }
          const lines = [
            `Request type ${requestTypeId} accepts ${found.components.options.length} components:`,
            ...found.components.options.map((option) => `• ${option.name} (id ${option.id})`),
          ];
          return { content: [{ type: 'text' as const, text: lines.join('\n') }] };
        }

        const all = await loadProjectComponents(auth, desk.desk.projectKey);
        if (!all.ok) return errText(all.message);
        const lines = [
          `Project ${desk.desk.projectKey} has ${all.options.length} components:`,
          ...all.options.map((option) => `• ${option.name} (id ${option.id})`),
          '',
          'Whether a given request type can SET one depends on its form — pass requestTypeId.',
        ];
        return { content: [{ type: 'text' as const, text: lines.join('\n') }] };
      } catch (error) {
        return errText(error instanceof Error ? error.message : String(error));
      }
    }
  );

  // jsm_create_request — schema and handler shared with the card-invoked
  // jsm_create_request_confirm below, so the confirm path IS the create path.
  const createRequestSchema = z.object({
    serviceDeskId: z.string().describe('Service desk ID'),
    requestTypeId: z.string().describe('Request type ID'),
    summary: z.string().describe('Request summary/title'),
    description: z.string().describe('Request description (optional)').optional(),
    reporter: z
      .string()
      .describe(
        'Who the request is FOR — their email or accountId. Becomes the reporter (raised on ' +
          'their behalf). Always set this when the request originates from someone else (a ' +
          'message, a thread, a call); omitted, the request is reported by YOU. ' +
          'jira_search_users or jsm_list_customers finds the address.'
      )
      .optional(),
    assignee: z
      .string()
      .describe(
        'Email or accountId of the person to assign the issue to. Set right after creation ' +
          '(the request form cannot carry it); if it cannot be set the request is still ' +
          'created and the reply says so. Omit to leave unassigned.'
      )
      .optional(),
    priority: z
      .string()
      .describe(
        'Priority name (e.g. "High") or id. Set through the request form when this request ' +
          'type carries a priority field, otherwise right after creation; if it cannot be ' +
          'set the request is still created and the reply says so.'
      )
      .optional(),
    components: z
      .array(z.string())
      .describe(
        'Component names (or ids) to file the request under — jsm_list_components shows what ' +
          'this request type accepts. Names are matched case-insensitively.'
      )
      .optional(),
  });
  const createRequestHandler = async (args: Record<string, any>) => {
    const displayName = getCachedDisplayName(context.accountId);
    logger.debug('jsm_create_request invoked', {
      component: 'mcp/tool',
      tenantId: context.tenantId,
      accountId: context.accountId,
      displayName,
    });
    try {
      const { serviceDeskId, requestTypeId, summary, description, components } = args;
      const reporter = str(args.reporter).trim();
      const assignee = str(args.assignee).trim();
      const priorityWanted = str(args.priority).trim();

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

      // The GET endpoints take the project KEY in their URL path, so models
      // that just used "CAS" for jsm_get_request_type_fields naturally pass
      // it here too — but POST /request wants the NUMERIC id in the body
      // and answers a bare 400 for a key. Resolve rather than reject: the
      // desk lookup accepts the key and echoes its id.
      let deskId = String(serviceDeskId).trim();
      if (!/^\d+$/.test(deskId)) {
        const desk = await resolveServiceDesk(auth, deskId);
        if (!desk.ok) return errText(desk.message);
        deskId = desk.desk.id;
      }

      /*
        Components and priority, resolved against the REQUEST TYPE's own
        form rather than the project at large.

        The servicedeskapi rejects the whole payload for a field the form
        does not declare, so sending either blindly would turn "the field
        did not stick" into "the request was never created" — strictly
        worse. And a name that is off by a case or a space is rejected the
        same way. So both are checked here, and neither costs the request:
        an unusable value becomes a NOTE on an otherwise successful create,
        which is the same posture jira_create_issue takes with a field it
        could not write. A priority the form cannot carry still has a path —
        the post-create platform edit below.
      */
      const wanted = Array.isArray(components) ? components.map((c: unknown) => String(c)) : [];
      let componentValues: { id: string }[] = [];
      let priorityValue: { id: string } | null = null;
      let priorityViaEdit = false;
      const notes: string[] = [];
      if (wanted.length > 0 || priorityWanted) {
        const form = await loadRequestTypeForm(auth, deskId, String(requestTypeId));
        if (!form.ok) {
          if (wanted.length > 0) notes.push(`Components were not set — ${form.message}`);
          // The form being unreadable does not decide whether priority can
          // be set at all — the platform edit still can.
          if (priorityWanted) priorityViaEdit = true;
        } else {
          if (wanted.length > 0) {
            const found = fieldOptionsOf(form.fields, 'components');
            if (!found.present) {
              notes.push(
                `Components were not set: request type ${requestTypeId} has no components field ` +
                  `on its form. Set them on the issue afterwards with jira_update_issue.`
              );
            } else {
              const matched = matchComponents(wanted, found.options);
              componentValues = matched.resolved.map((option) => ({ id: option.id }));
              if (matched.missing.length > 0) {
                notes.push(
                  `Not set: ${matched.missing.map((name) => `"${name}"`).join(', ')} — ` +
                    `this request type accepts ${describeComponents(found.options)}.`
                );
              }
            }
          }
          if (priorityWanted) {
            const found = fieldOptionsOf(form.fields, 'priority');
            if (!found.present) {
              priorityViaEdit = true;
            } else {
              const matched = matchComponents([priorityWanted], found.options);
              if (matched.resolved.length > 0) {
                priorityValue = { id: matched.resolved[0].id };
              } else {
                notes.push(
                  `Priority was not set: "${priorityWanted}" is not one this request type ` +
                    `accepts — it accepts ` +
                    `${found.options.map((option) => `${option.name} (${option.id})`).join(', ')}.`
                );
              }
            }
          }
        }
      }

      // The servicedeskapi wants issue fields nested under
      // requestFieldValues — top-level summary (platform-API style) is
      // "Invalid request payload". The 401 scope gate used to fire before
      // payload validation, which is why this never surfaced until the
      // JSM app's scopes landed.
      const postCreate = async (withReporter: boolean): Promise<Response> => {
        const body: any = {
          serviceDeskId: deskId,
          requestTypeId: String(requestTypeId),
          // raiseOnBehalfOf is how the servicedeskapi sets the reporter: the
          // request is raised FOR that customer (email or accountId).
          ...(withReporter && reporter ? { raiseOnBehalfOf: reporter } : {}),
          requestFieldValues: {
            summary,
            ...(description ? { description } : {}),
            ...(componentValues.length > 0 ? { components: componentValues } : {}),
            ...(priorityValue ? { priority: priorityValue } : {}),
          },
        };
        return auth.fetch(
          serviceDeskScopes('jsm_create_request', false),
          '/rest/servicedeskapi/request',
          {
            method: 'POST',
            body: JSON.stringify(body),
          }
        );
      };

      // A reporter Jira does not recognize (not a customer of this desk, a
      // typo, a hidden account) rejects the WHOLE payload. That must cost
      // the reporter, not the request: retry once as the caller and say so.
      let reporterSet = Boolean(reporter);
      let response: Response;
      try {
        response = await postCreate(true);
      } catch (error) {
        if (
          reporter &&
          error instanceof JiraApiError &&
          (error.status === 400 || error.status === 404)
        ) {
          reporterSet = false;
          notes.push(
            `Reporter was not set — Jira rejected raising the request on behalf of ` +
              `"${reporter}" (${error.message}). It was created with you as the reporter; ` +
              `check the address with jira_search_users or jsm_list_customers, then fix it ` +
              `with jira_update_issue.`
          );
          response = await postCreate(false);
        } else {
          throw error;
        }
      }
      if (!response.ok) return errText(await describeJsmAuthFailure(response));

      const result = (await response.json()) as any;
      // Echo what Jira actually created, not the input.
      const realKey = str(result.issueKey);
      const key = realKey || '(no key in response)';

      // Assignee (always) and priority (when the form could not carry it)
      // live on the platform API — the request form has no field for them.
      // Each is best-effort AFTER the create: a value that cannot land
      // costs itself and a note, never the request.
      let assigneeSet = false;
      if (assignee && realKey) {
        const resolved = await resolveUserId(auth, assignee);
        if (!resolved.ok) {
          notes.push(`Assignee was not set — ${resolved.reason}. Set it with jira_update_issue.`);
        } else {
          try {
            const put = await auth.fetch(
              [ISSUE_EDIT_WRITE],
              `/rest/api/3/issue/${encodeURIComponent(realKey)}/assignee`,
              { method: 'PUT', body: JSON.stringify({ accountId: resolved.id }) }
            );
            if (!put.ok) {
              notes.push(`Assignee was not set — ${await describeJsmAuthFailure(put)}`);
            } else {
              assigneeSet = true;
            }
          } catch (error) {
            notes.push(
              `Assignee was not set — ${error instanceof Error ? error.message : String(error)}. ` +
                `Set it with jira_update_issue.`
            );
          }
        }
      }

      let prioritySet = priorityValue !== null;
      if (priorityWanted && priorityViaEdit && realKey) {
        const value = /^\d+$/.test(priorityWanted)
          ? { id: priorityWanted }
          : { name: priorityWanted };
        try {
          const put = await auth.fetch(
            [ISSUE_EDIT_WRITE],
            `/rest/api/3/issue/${encodeURIComponent(realKey)}`,
            { method: 'PUT', body: JSON.stringify({ fields: { priority: value } }) }
          );
          if (!put.ok) {
            notes.push(`Priority was not set — ${await describeJsmAuthFailure(put)}`);
          } else {
            prioritySet = true;
          }
        } catch (error) {
          notes.push(
            `Priority was not set — ${error instanceof Error ? error.message : String(error)}. ` +
              `Set it with jira_update_issue.`
          );
        }
      }

      return {
        content: [
          {
            type: 'text' as const,
            // Both views: whoever works it needs the Jira issue, whoever
            // reported it can only open the portal.
            text:
              `Created request ${key}` +
              (reporter && reporterSet ? `\nReporter: raised on behalf of ${reporter}` : '') +
              (assigneeSet ? `\nAssignee: set` : '') +
              (prioritySet ? `\nPriority: set` : '') +
              (componentValues.length > 0 ? `\nComponents: ${componentValues.length} set` : '') +
              // Said out loud, never swallowed: a field that did not land is
              // the exact failure this whole posture exists to stop being
              // invisible.
              (notes.length > 0 ? `\n\n${notes.join('\n')}` : '') +
              `\n\n[Open in Jira](${issueUrl(context.siteUrl, key)}) · ` +
              `[Customer portal](${requestUrl(context.siteUrl, key)})`,
          },
        ],
        // The receipt turns the owner's notification from "Raised a
        // service request" into "Raised a service request CAS-101", with a
        // link to the issue. Only the handler ever sees the key, which is
        // why it has to be attached here.
        ...(realKey
          ? {
              _meta: actMeta({
                id: realKey,
                ...(context.siteUrl ? { url: issueUrl(context.siteUrl, realKey) } : {}),
              }),
            }
          : {}),
      };
    } catch (error) {
      return {
        content: [
          { type: 'text' as const, text: error instanceof Error ? error.message : String(error) },
        ],
        isError: true,
      };
    }
  };
  server.registerTool(
    'jsm_create_request',
    {
      title: 'JSM · Act — Create a customer or internal request',
      description:
        'Create a customer request in a service desk. Prefer this over jira_create_issue ' +
        'whenever the target project is a service desk (see jsm_list_service_desks) — a plain ' +
        'issue in a service desk project skips its request types and SLAs. Reporter, assignee, ' +
        'priority, and components are their own inputs here — pass them as fields, never as ' +
        'lines inside the description text.',
      annotations: { readOnlyHint: false },
      inputSchema: createRequestSchema,
    },
    createRequestHandler
  );

  // ——— Interactive preview (MCP Apps) ————————————————————————————————
  // Same shape as the Jira issue previews: nothing is created at preview
  // time, the card holds the request, and its Create button runs the
  // app-only confirm twin — which IS jsm_create_request's handler.

  server.registerTool(
    'jsm_create_request_preview',
    {
      title: 'JSM · Act — Preview a request before creating it',
      description:
        'Show the user an interactive preview card of a new service desk request to create or ' +
        'cancel. Prefer this over jsm_create_request whenever the user should review first — ' +
        'the card does the creating.',
      annotations: { readOnlyHint: false },
      _meta: previewToolMeta(ISSUE_PREVIEW_URI),
      inputSchema: createRequestSchema,
    },
    async (args: Record<string, any>) => {
      const serviceDeskId = str(args.serviceDeskId);
      const requestTypeId = str(args.requestTypeId);
      const summary = str(args.summary);
      if (!serviceDeskId || !requestTypeId || !summary) {
        return errText('serviceDeskId, requestTypeId, and summary are required');
      }

      // Best-effort: name the desk and request type like the portal would
      // rather than showing bare ids. A failed read costs the labels only.
      let deskName = '';
      let typeName = '';
      try {
        const [deskResponse, typeResponse] = await Promise.all([
          auth.fetch(
            serviceDeskScopes('jsm_list_service_desks', true),
            `/rest/servicedeskapi/servicedesk/${encodeURIComponent(serviceDeskId)}`
          ),
          auth.fetch(
            serviceDeskScopes('jsm_list_request_types', true),
            `/rest/servicedeskapi/servicedesk/${encodeURIComponent(serviceDeskId)}` +
              `/requesttype/${encodeURIComponent(requestTypeId)}`
          ),
        ]);
        if (deskResponse.ok) {
          const desk = (await deskResponse.json().catch(() => null)) as any;
          deskName = str(desk?.projectName);
        }
        if (typeResponse.ok) {
          const requestType = (await typeResponse.json().catch(() => null)) as any;
          typeName = str(requestType?.name);
        }
      } catch {
        // preview renders with ids
      }

      return {
        content: [
          {
            type: 'text' as const,
            text:
              `The request "${summary}" is awaiting the user's decision on the preview card. ` +
              `Do not create it another way and do not repeat its contents in your reply; the ` +
              `user confirms or cancels from the card. If no card appeared in this client, ask ` +
              `the user how to proceed.`,
          },
        ],
        structuredContent: {
          kind: 'issue',
          previewId: newPreviewId(),
          title: 'Create service desk request',
          subtitle: `${deskName || `desk ${serviceDeskId}`} · ${typeName || `type ${requestTypeId}`}`,
          confirmTool: 'jsm_create_request_confirm',
          confirmLabel: 'Create request',
          confirmArgs: args,
          editable: { summaryKey: 'summary', descriptionKey: 'description' },
          fields: [
            { label: 'Service desk', value: deskName || serviceDeskId },
            { label: 'Request type', value: typeName || requestTypeId },
            // Only when asked for. A card row reading "Components: —" on
            // every request would be noise; the point of showing these is
            // that somebody approving the card can see who it is for, who
            // gets it, and where it will be filed.
            ...(str(args.reporter) ? [{ label: 'Reporter', value: str(args.reporter) }] : []),
            ...(str(args.assignee) ? [{ label: 'Assignee', value: str(args.assignee) }] : []),
            ...(str(args.priority) ? [{ label: 'Priority', value: str(args.priority) }] : []),
            ...(Array.isArray(args.components) && args.components.length > 0
              ? [{ label: 'Components', value: args.components.map(String).join(', ') }]
              : []),
          ],
        },
      };
    }
  );

  server.registerTool(
    'jsm_create_request_confirm',
    {
      title: 'JSM · Act — Create a previewed request (card only)',
      description:
        'Create a service desk request the user approved on a preview card.' +
        confirmGuard('jsm_create_request_preview'),
      annotations: { readOnlyHint: false },
      _meta: APP_ONLY_META,
      inputSchema: createRequestSchema,
    },
    createRequestHandler
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
      logger.debug('jsm_add_request_comment invoked', {
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
          _meta: actMeta({
            id: String(issueKey),
            ...(context.siteUrl ? { url: issueUrl(context.siteUrl, String(issueKey)) } : {}),
          }),
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
      logger.debug('jsm_list_request_transitions invoked', {
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
      logger.debug('jsm_transition_request invoked', {
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
          _meta: actMeta({
            id: String(issueKey),
            ...(context.siteUrl ? { url: issueUrl(context.siteUrl, String(issueKey)) } : {}),
          }),
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
      logger.debug('jsm_list_customers invoked', {
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
