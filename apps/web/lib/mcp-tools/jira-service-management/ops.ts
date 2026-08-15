/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * JSM Operations tools — alerts, schedules, rotations, on-call.
 *
 * How each call authenticates is an injected `JsmOpsAuth` (see ops-auth.ts),
 * not something this file decides. Production always passes
 * `oauthJsmOpsAuth`, running every call through the same /ex/jira/{cloudId}
 * gateway as every other 3LO call in this codebase — spec vendored at
 * docs/jira-service-management-ops-rest-api-open-api-spec.json.
 * `ops.integration.test.ts` passes `patJsmOpsAuth` instead, against a real
 * sandbox. This file's own code is identical either way.
 *
 * The Ops API takes GRANULAR scopes only (read:ops-alert:… etc.), which ship
 * default-off in the connector's scope checkboxes — a 401/403 here means the
 * grant predates them or the Atlassian app lacks them, and the error says so
 * rather than leaving a bare status. Teams here are the OPS teams (GET
 * /v1/teams, read:ops-config scope) — the ones schedules, escalations and
 * routing rules hang off — not the separate Atlassian platform Teams API.
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/server';
import { withPresentationHint } from '../common';
import type { MCPToolContext } from '../common';
import { logger } from '@/lib/logger';
import { opsScopes, type JsmOpsAuth } from './ops-auth';

function textResult(value: string) {
  return { content: [{ type: 'text' as const, text: value }] };
}

function errText(value: string) {
  return { content: [{ type: 'text' as const, text: value }], isError: true };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function items(body: unknown): Record<string, unknown>[] {
  if (typeof body !== 'object' || body === null) return [];
  // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
  const values = (body as Record<string, unknown>).values;
  return Array.isArray(values)
    ? values.filter(
        (item): item is Record<string, unknown> => typeof item === 'object' && item !== null
      )
    : [];
}

async function describeOpsFailure(response: Response): Promise<string> {
  // Always surface what Atlassian actually said — an earlier version replaced
  // the body with a scope lecture on every 401/403, which sent a healthy
  // token's owner off chasing scopes while the real reason sat in the
  // discarded body.
  const body = await response.text().catch(() => '');
  let detail = '';
  try {
    const parsed: unknown = JSON.parse(body);
    if (typeof parsed === 'object' && parsed !== null) {
      // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
      const record = parsed as Record<string, unknown>;
      detail =
        str(record.message) ||
        (Array.isArray(record.errors) ? record.errors.map(String).join('; ') : '');
    }
  } catch {
    detail = body.slice(0, 300);
  }

  let text = `JSM Operations answered ${response.status}${detail ? `: ${detail}` : ''}.`;
  if (response.status === 401 || response.status === 403) {
    text +=
      ' If the grant is missing Ops scopes, an org admin checks them in connector setup, adds ' +
      'them to the Atlassian app, and you reconnect. If the scopes are present, this usually ' +
      'means JSM Operations is not provisioned for this site or user — the caller must be a ' +
      'Jira Service Management agent with Operations enabled (Alerts/On-call visible in the ' +
      'JSM UI).';
  }
  return text;
}

function alertLine(alert: Record<string, unknown>): string {
  const priority = str(alert.priority);
  const status = str(alert.status);
  const acknowledged = alert.acknowledged === true ? ' (acked)' : '';
  return (
    `[${priority || '?'}] ${str(alert.message) || '(no message)'} — ${status}${acknowledged}` +
    ` — created ${str(alert.createdAt)} — id: ${str(alert.id)}`
  );
}

export async function registerJsmOpsTools(
  server: McpServer,
  context: MCPToolContext,
  auth: JsmOpsAuth
): Promise<void> {
  server.registerTool(
    'jsm_ops_list_alerts',
    {
      title: 'JSM Ops · Read — List JSM Operations alerts',
      description:
        'List operations alerts (the Opsgenie-style alerting in Jira Service Management), ' +
        'newest first. Supports the alert search syntax — field:value terms, e.g. `status:open`, ' +
        '`acknowledged:false`, `status:open AND priority:P1`, `responders:"Team Name"`. ' +
        'Bare keywords like `NOT acknowledged` are a syntax error (422).',
      annotations: { readOnlyHint: true },
      inputSchema: z.object({
        query: z.string().describe('Alert search query, e.g. status:open').optional(),
        size: z.number().int().min(1).max(100).describe('How many (default 20)').optional(),
      }),
    },
    async (args: Record<string, any>) => {
      const parts = [
        `size=${typeof args.size === 'number' ? args.size : 20}`,
        'sort=createdAt',
        'order=desc',
      ];
      if (str(args.query)) parts.push(`query=${encodeURIComponent(str(args.query))}`);
      const response = await auth.fetch(
        opsScopes('jsm_ops_list_alerts', true),
        `/alerts?${parts.join('&')}`
      );
      if (!response.ok) return errText(await describeOpsFailure(response));
      const body: unknown = await response.json().catch(() => null);
      const lines = items(body).map(alertLine);
      if (lines.length === 0) return textResult('No alerts.');
      return textResult(
        withPresentationHint(
          lines.join('\n'),
          'a table (Alert, Status, Priority, Created) usually scans faster than this flat list.'
        )
      );
    }
  );

  server.registerTool(
    'jsm_ops_get_alert',
    {
      title: 'JSM Ops · Read — Get a JSM Operations alert',
      description: 'Full detail of one alert by id: description, responders, tags, timestamps.',
      annotations: { readOnlyHint: true },
      inputSchema: z.object({
        alertId: z.string().min(1).describe('Alert id from jsm_ops_list_alerts'),
      }),
    },
    async (args: Record<string, any>) => {
      const response = await auth.fetch(
        opsScopes('jsm_ops_get_alert', true),
        `/alerts/${encodeURIComponent(str(args.alertId))}`
      );
      if (!response.ok) return errText(await describeOpsFailure(response));
      const body: unknown = await response.json().catch(() => null);
      if (typeof body !== 'object' || body === null) return errText('Malformed alert response.');
      // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
      const alert = body as Record<string, unknown>;
      const tags = Array.isArray(alert.tags) ? alert.tags.filter((t) => typeof t === 'string') : [];
      const lines = [
        alertLine(alert),
        str(alert.description) ? `description: ${str(alert.description)}` : '',
        str(alert.source) ? `source: ${str(alert.source)}` : '',
        tags.length ? `tags: ${tags.join(', ')}` : '',
        typeof alert.count === 'number' ? `occurrences: ${alert.count}` : '',
        str(alert.lastOccurredAt) ? `last occurred: ${str(alert.lastOccurredAt)}` : '',
      ].filter(Boolean);
      return textResult(lines.join('\n'));
    }
  );

  server.registerTool(
    'jsm_ops_acknowledge_alert',
    {
      title: 'JSM Ops · Act — Acknowledge a JSM Operations alert',
      description:
        'Acknowledge an alert as the connected user — tells the team someone is on it. ' +
        'Idempotent: acking an already-acked alert succeeds without changing anything. ' +
        'Requires the write:ops-alert scope.',
      annotations: { readOnlyHint: false },
      inputSchema: z.object({
        alertId: z.string().min(1).describe('Alert id'),
      }),
    },
    async (args: Record<string, any>) => {
      const alertId = encodeURIComponent(str(args.alertId));
      const response = await auth.fetch(
        opsScopes('jsm_ops_acknowledge_alert', false),
        `/alerts/${alertId}/acknowledge`,
        { method: 'POST', body: JSON.stringify({}) }
      );
      if (!response.ok) return errText(await describeOpsFailure(response));
      logger.info('jsm_ops_acknowledge_alert', {
        component: 'mcp/tool',
        tenantId: context.tenantId,
        accountId: context.accountId,
        alertId: str(args.alertId),
      });
      return textResult('Acknowledged.');
    }
  );

  server.registerTool(
    'jsm_ops_close_alert',
    {
      title: 'JSM Ops · Act — Close a JSM Operations alert',
      description:
        'Close an alert as the connected user. Closing is a decision — do it only when the ' +
        'user says the alert is resolved. Requires the write:ops-alert scope.',
      annotations: { readOnlyHint: false },
      inputSchema: z.object({
        alertId: z.string().min(1).describe('Alert id'),
      }),
    },
    async (args: Record<string, any>) => {
      const alertId = encodeURIComponent(str(args.alertId));
      const response = await auth.fetch(
        opsScopes('jsm_ops_close_alert', false),
        `/alerts/${alertId}/close`,
        { method: 'POST', body: JSON.stringify({}) }
      );
      if (!response.ok) return errText(await describeOpsFailure(response));
      logger.info('jsm_ops_close_alert', {
        component: 'mcp/tool',
        tenantId: context.tenantId,
        accountId: context.accountId,
        alertId: str(args.alertId),
      });
      return textResult('Closed.');
    }
  );

  server.registerTool(
    'jsm_ops_list_schedules',
    {
      title: 'JSM Ops · Read — List JSM Operations on-call schedules',
      description:
        'List on-call schedules with their rotations: rotation type, length, and participants. ' +
        'Schedule ids feed jsm_ops_whos_on_call and jsm_ops_list_overrides; rotation ids feed ' +
        'jsm_ops_update_rotation and jsm_ops_create_override. This is the ONLY tool that ' +
        'returns rotation ids — a rotation name is not accepted anywhere one is asked for.',
      annotations: { readOnlyHint: true },
      inputSchema: z.object({
        size: z.number().int().min(1).max(50).describe('How many (default 20)').optional(),
      }),
    },
    async (args: Record<string, any>) => {
      const size = typeof args.size === 'number' ? args.size : 20;
      const response = await auth.fetch(
        opsScopes('jsm_ops_list_schedules', true),
        `/schedules?size=${size}&expand=rotation`
      );
      if (!response.ok) return errText(await describeOpsFailure(response));
      const body: unknown = await response.json().catch(() => null);
      const lines = items(body).map((schedule) => {
        const rotations = Array.isArray(schedule.rotations)
          ? schedule.rotations.filter(
              (r): r is Record<string, unknown> => typeof r === 'object' && r !== null
            )
          : [];
        const rotationLines = rotations.map((rotation) => {
          const participants = Array.isArray(rotation.participants)
            ? rotation.participants
                .filter((p): p is Record<string, unknown> => typeof p === 'object' && p !== null)
                .map((p) => str(p.id) || str(p.type))
                .filter(Boolean)
            : [];
          // The rotation ID IS THE POINT of this line, not a detail of it.
          // Two Act tools name this tool as where to get it —
          // jsm_ops_update_rotation requires it, jsm_ops_create_override
          // takes it — and it was never printed. Following that documented
          // handoff left the caller with a rotation NAME and one plausible
          // move: pass the name as the id, and read a 404 saying no rotation
          // exists with id "Business%20Hours". Nothing about that failure
          // points at the tool that omitted the field.
          return (
            `  rotation: ${str(rotation.name) || '(unnamed)'} — ${str(rotation.type)}` +
            `${typeof rotation.length === 'number' ? ` ×${rotation.length}` : ''}` +
            (participants.length ? ` — participants: ${participants.join(', ')}` : '') +
            ` — id: ${str(rotation.id)}`
          );
        });
        return [
          `${str(schedule.name) || '(unnamed)'} — tz ${str(schedule.timezone)} — ` +
            `${schedule.enabled === false ? 'disabled' : 'enabled'} — id: ${str(schedule.id)}` +
            (str(schedule.teamId) ? ` — team: ${str(schedule.teamId)}` : ''),
          ...rotationLines,
        ].join('\n');
      });
      if (lines.length === 0) return textResult('No schedules.');
      return textResult(
        withPresentationHint(
          lines.join('\n\n'),
          'a table (Schedule, Team) usually scans faster than this flat list.'
        )
      );
    }
  );

  server.registerTool(
    'jsm_ops_whos_on_call',
    {
      title: 'JSM Ops · Read — Who is on call',
      description:
        'The people currently on call for a schedule (or at a given moment). Answers ' +
        '"who do I page right now".',
      annotations: { readOnlyHint: true },
      inputSchema: z.object({
        scheduleId: z.string().min(1).describe('Schedule id from jsm_ops_list_schedules'),
        date: z.string().describe('ISO timestamp to ask about a moment other than now').optional(),
      }),
    },
    async (args: Record<string, any>) => {
      const scheduleId = encodeURIComponent(str(args.scheduleId));
      const parts = ['flat=true'];
      if (str(args.date)) parts.push(`date=${encodeURIComponent(str(args.date))}`);
      const response = await auth.fetch(
        opsScopes('jsm_ops_whos_on_call', true),
        `/schedules/${scheduleId}/on-calls?${parts.join('&')}`
      );
      if (!response.ok) return errText(await describeOpsFailure(response));
      const body: unknown = await response.json().catch(() => null);
      // The response is a oneOf keyed by the flat param: flat=true answers
      // { onCallUsers: string[] } (user ids), flat absent answers
      // { onCallParticipants: [{id, type, ...}] }. This read both keys wrong
      // once — flat=true was sent while onCallParticipants was read, so the
      // tool said "nobody is on call" against every schedule, always.
      const record = isRecord(body) ? body : {};
      const flatUsers = Array.isArray(record.onCallUsers)
        ? record.onCallUsers.filter((u): u is string => typeof u === 'string')
        : [];
      const participants = Array.isArray(record.onCallParticipants)
        ? record.onCallParticipants
            .map((p) =>
              isRecord(p) ? `${str(p.id)}${str(p.type) ? ` (${str(p.type)})` : ''}` : ''
            )
            .filter(Boolean)
        : [];
      const names = flatUsers.length > 0 ? flatUsers : participants;
      if (names.length === 0) return textResult('Nobody is on call for that schedule.');
      return textResult(
        withPresentationHint(
          `On call now (user ids — resolve names via jira_get_user):\n${names.join('\n')}`,
          "a small card per schedule (who's on call, until when) usually reads better than a flat " +
            'list here, since it is really a status snapshot rather than a big table of rows.'
        )
      );
    }
  );

  server.registerTool(
    'jsm_ops_list_overrides',
    {
      title: 'JSM Ops · Read — List schedule overrides',
      description:
        'The overrides currently on a schedule: who is covering, for which window, on which ' +
        'rotations. Read this before creating an override, to avoid stacking conflicting ones.',
      annotations: { readOnlyHint: true },
      inputSchema: z.object({
        scheduleId: z.string().min(1).describe('Schedule id from jsm_ops_list_schedules'),
      }),
    },
    async (args: Record<string, any>) => {
      const scheduleId = encodeURIComponent(str(args.scheduleId));
      const response = await auth.fetch(
        opsScopes('jsm_ops_list_overrides', true),
        `/schedules/${scheduleId}/overrides`
      );
      if (!response.ok) return errText(await describeOpsFailure(response));
      const body: unknown = await response.json().catch(() => null);
      const lines = items(body).map((override) => {
        const responder = isRecord(override.responder)
          ? str(override.responder.id) || str(override.responder.type)
          : '?';
        const rotations = Array.isArray(override.rotationIds)
          ? override.rotationIds.filter((r) => typeof r === 'string')
          : [];
        return (
          `${responder} covers ${str(override.startDate)} → ${str(override.endDate)}` +
          (rotations.length ? ` — rotations: ${rotations.join(', ')}` : ' — whole schedule') +
          ` — alias: ${str(override.alias)}`
        );
      });
      if (lines.length === 0) return textResult('No overrides.');
      return textResult(
        withPresentationHint(
          lines.join('\n'),
          'a table (Schedule, Override user, Start, End) usually scans faster than this flat list.'
        )
      );
    }
  );

  server.registerTool(
    'jsm_ops_create_override',
    {
      title: 'JSM Ops · Act — Create a schedule override (wizard)',
      description:
        'Put someone on call in place of the rotation for a window — "cover for me Friday". ' +
        'This is a WIZARD: gather each missing piece from the user (it will tell you what is ' +
        'missing), then call WITHOUT confirm to get a preview, show the user that preview, and ' +
        'only after their explicit yes call again with confirm=true. Never invent times or ' +
        'responders. Requires the write:ops-config scope.',
      annotations: { readOnlyHint: false },
      inputSchema: z.object({
        scheduleId: z.string().min(1).describe('Schedule id from jsm_ops_list_schedules'),
        responderAccountId: z
          .string()
          .describe('Atlassian accountId of who covers — resolve via jira_search_users')
          .optional(),
        startDate: z.string().describe('ISO start of the coverage window').optional(),
        endDate: z.string().describe('ISO end of the coverage window').optional(),
        rotationIds: z
          .array(z.string())
          .describe('Limit the override to specific rotations; omit for the whole schedule')
          .optional(),
        confirm: z
          .boolean()
          .describe('true ONLY after the user approved the preview this tool returned')
          .optional(),
      }),
    },
    async (args: Record<string, any>) => {
      const scheduleId = str(args.scheduleId);
      const scopes = opsScopes('jsm_ops_create_override', false);

      // Context for the wizard: the schedule must exist, and its name and
      // timezone anchor every question the assistant asks the user.
      const scheduleResponse = await auth.fetch(
        scopes,
        `/schedules/${encodeURIComponent(scheduleId)}`
      );
      if (!scheduleResponse.ok) return errText(await describeOpsFailure(scheduleResponse));
      const scheduleBody: unknown = await scheduleResponse.json().catch(() => null);
      const schedule = isRecord(scheduleBody) ? scheduleBody : {};
      const scheduleName = str(schedule.name) || scheduleId;
      const timezone = str(schedule.timezone) || 'UTC';

      const missing: string[] = [];
      if (!str(args.responderAccountId)) {
        missing.push(
          'WHO covers: ask the user for the person, resolve their Atlassian accountId with jira_search_users'
        );
      }
      if (!str(args.startDate)) {
        missing.push(`WHEN it starts: ISO timestamp (schedule timezone is ${timezone})`);
      }
      if (!str(args.endDate)) {
        missing.push(`WHEN it ends: ISO timestamp (schedule timezone is ${timezone})`);
      }
      if (missing.length > 0) {
        return textResult(
          `Override on "${scheduleName}" — still needed before a preview:\n` +
            missing.map((m) => `- ${m}`).join('\n') +
            '\nAsk the user, then call this tool again with the answers.'
        );
      }

      const start = new Date(str(args.startDate));
      const end = new Date(str(args.endDate));
      if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || end <= start) {
        return errText(
          'startDate/endDate must be valid ISO timestamps with end after start. Re-ask the user.'
        );
      }

      const rotationIds = Array.isArray(args.rotationIds)
        ? args.rotationIds.filter((r: unknown) => typeof r === 'string')
        : [];

      if (args.confirm !== true) {
        return textResult(
          `PREVIEW — nothing written yet.\n` +
            `Schedule: ${scheduleName} (tz ${timezone})\n` +
            `Covering: ${str(args.responderAccountId)}\n` +
            `Window: ${start.toISOString()} → ${end.toISOString()}\n` +
            `Rotations: ${rotationIds.length ? rotationIds.join(', ') : 'whole schedule'}\n` +
            'Show this to the user. If they approve, call again with confirm: true.'
        );
      }

      const response = await auth.fetch(
        scopes,
        `/schedules/${encodeURIComponent(scheduleId)}/overrides`,
        {
          method: 'POST',
          body: JSON.stringify({
            responder: { type: 'user', id: str(args.responderAccountId) },
            startDate: start.toISOString(),
            endDate: end.toISOString(),
            ...(rotationIds.length ? { rotationIds } : {}),
          }),
        }
      );
      if (!response.ok) return errText(await describeOpsFailure(response));
      const created: unknown = await response.json().catch(() => null);
      const alias = isRecord(created) ? str(created.alias) : '';
      logger.info('jsm_ops_create_override', {
        component: 'mcp/tool',
        tenantId: context.tenantId,
        accountId: context.accountId,
        scheduleId,
      });
      return textResult(`Override created${alias ? ` (alias ${alias})` : ''}.`);
    }
  );

  server.registerTool(
    'jsm_ops_delete_override',
    {
      title: 'JSM Ops · Act — Delete a schedule override (confirm-gated)',
      description:
        'Remove an override by its alias — coverage falls back to the rotation. Deletion is not ' +
        'reversible: call WITHOUT confirm first to see exactly which override would go, show the ' +
        'user, and only after their explicit yes call again with confirm=true. Requires the ' +
        'delete:ops-config scope.',
      annotations: { readOnlyHint: false },
      inputSchema: z.object({
        scheduleId: z.string().min(1).describe('Schedule id'),
        alias: z.string().min(1).describe('Override alias from jsm_ops_list_overrides'),
        confirm: z
          .boolean()
          .describe('true ONLY after the user approved the preview this tool returned')
          .optional(),
      }),
    },
    async (args: Record<string, any>) => {
      const scheduleId = encodeURIComponent(str(args.scheduleId));
      const alias = encodeURIComponent(str(args.alias));
      const scopes = opsScopes('jsm_ops_delete_override', false);

      // Fetch the override first — the preview must describe the real thing,
      // and a delete of a mistyped alias should fail loudly here, not there.
      const currentResponse = await auth.fetch(
        scopes,
        `/schedules/${scheduleId}/overrides/${alias}`
      );
      if (!currentResponse.ok) return errText(await describeOpsFailure(currentResponse));
      const currentBody: unknown = await currentResponse.json().catch(() => null);
      const override = isRecord(currentBody) ? currentBody : {};
      const responder = isRecord(override.responder)
        ? str(override.responder.id) || str(override.responder.type)
        : '?';
      const summary =
        `${responder} covering ${str(override.startDate)} → ${str(override.endDate)}` +
        (Array.isArray(override.rotationIds) && override.rotationIds.length
          ? ` on rotations ${override.rotationIds.filter((r) => typeof r === 'string').join(', ')}`
          : ' (whole schedule)');

      if (args.confirm !== true) {
        return textResult(
          `PREVIEW — nothing deleted yet.\nWould remove: ${summary}\n` +
            'Coverage falls back to the rotation for that window. Show this to the user; if ' +
            'they approve, call again with confirm: true.'
        );
      }

      const response = await auth.fetch(scopes, `/schedules/${scheduleId}/overrides/${alias}`, {
        method: 'DELETE',
      });
      if (!response.ok) return errText(await describeOpsFailure(response));
      logger.info('jsm_ops_delete_override', {
        component: 'mcp/tool',
        tenantId: context.tenantId,
        accountId: context.accountId,
        scheduleId: str(args.scheduleId),
        alias: str(args.alias),
      });
      return textResult(`Override removed (${summary}).`);
    }
  );

  server.registerTool(
    'jsm_ops_update_rotation',
    {
      title: 'JSM Ops · Act — Update a rotation (wizard)',
      description:
        'Change a rotation’s name, window, type, length, or participants. This is a WIZARD: ' +
        'call with only scheduleId+rotationId to see current values, gather the changes from ' +
        'the user, call with the changes for a preview diff, show it, and only after their ' +
        'explicit yes call again with confirm=true. Only the fields you pass change. Requires ' +
        'the write:ops-config scope.',
      annotations: { readOnlyHint: false },
      inputSchema: z.object({
        scheduleId: z.string().min(1).describe('Schedule id'),
        rotationId: z.string().min(1).describe('Rotation id from jsm_ops_list_schedules'),
        name: z.string().describe('New rotation name').optional(),
        startDate: z.string().describe('New ISO start').optional(),
        endDate: z.string().describe('New ISO end').optional(),
        type: z.enum(['daily', 'weekly', 'hourly']).describe('New rotation type').optional(),
        length: z.number().int().min(1).describe('New rotation length (units of type)').optional(),
        participantAccountIds: z
          .array(z.string())
          .describe(
            'REPLACEMENT participant list, in on-call order — resolve via jira_search_users'
          )
          .optional(),
        confirm: z
          .boolean()
          .describe('true ONLY after the user approved the preview this tool returned')
          .optional(),
      }),
    },
    async (args: Record<string, any>) => {
      const scheduleId = encodeURIComponent(str(args.scheduleId));
      const rotationId = encodeURIComponent(str(args.rotationId));
      const scopes = opsScopes('jsm_ops_update_rotation', false);

      const currentResponse = await auth.fetch(
        scopes,
        `/schedules/${scheduleId}/rotations/${rotationId}`
      );
      if (!currentResponse.ok) return errText(await describeOpsFailure(currentResponse));
      const currentBody: unknown = await currentResponse.json().catch(() => null);
      const current = isRecord(currentBody) ? currentBody : {};
      const currentParticipants = Array.isArray(current.participants)
        ? current.participants
            .filter(isRecord)
            .map((p) => str(p.id) || str(p.type))
            .filter(Boolean)
        : [];

      const patch: Record<string, unknown> = {};
      if (str(args.name)) patch.name = str(args.name);
      if (str(args.startDate)) patch.startDate = str(args.startDate);
      if (str(args.endDate)) patch.endDate = str(args.endDate);
      if (str(args.type)) patch.type = str(args.type);
      if (typeof args.length === 'number') patch.length = args.length;
      if (Array.isArray(args.participantAccountIds)) {
        patch.participants = args.participantAccountIds
          .filter((p: unknown) => typeof p === 'string')
          .map((id: string) => ({ type: 'user', id }));
      }

      const currentSummary =
        `Rotation "${str(current.name) || rotationId}": ${str(current.type)}` +
        `${typeof current.length === 'number' ? ` ×${current.length}` : ''}, ` +
        `${str(current.startDate)} → ${str(current.endDate) || 'open-ended'}, ` +
        `participants: ${currentParticipants.join(', ') || '(none)'}`;

      if (Object.keys(patch).length === 0) {
        return textResult(
          `${currentSummary}\n` +
            'No changes given. Ask the user what to change (name, window, type, length, or the ' +
            'participant list — participants REPLACE the whole list, in on-call order), then ' +
            'call again with those fields.'
        );
      }

      if (args.confirm !== true) {
        const changes = Object.entries(patch)
          .map(([key, value]) => `  ${key}: ${JSON.stringify(value)}`)
          .join('\n');
        return textResult(
          `PREVIEW — nothing written yet.\nCurrent → ${currentSummary}\nChanges:\n${changes}\n` +
            'Show this to the user. If they approve, call again with confirm: true.'
        );
      }

      const response = await auth.fetch(
        scopes,
        `/schedules/${scheduleId}/rotations/${rotationId}`,
        { method: 'PATCH', body: JSON.stringify(patch) }
      );
      if (!response.ok) return errText(await describeOpsFailure(response));
      logger.info('jsm_ops_update_rotation', {
        component: 'mcp/tool',
        tenantId: context.tenantId,
        accountId: context.accountId,
        rotationId: str(args.rotationId),
        fields: Object.keys(patch),
      });
      return textResult('Rotation updated.');
    }
  );

  server.registerTool(
    'jsm_ops_list_teams',
    {
      title: 'JSM Ops · Read — List JSM Operations teams',
      description:
        'List the operations teams — the ones schedules, escalations and routing rules belong ' +
        'to. Team ids feed jsm_ops_list_escalations and match the teamId on schedules.',
      annotations: { readOnlyHint: true },
      inputSchema: z.object({}),
    },
    async () => {
      const response = await auth.fetch(opsScopes('jsm_ops_list_teams', true), '/teams');
      if (!response.ok) return errText(await describeOpsFailure(response));
      const body: unknown = await response.json().catch(() => null);
      const teams =
        isRecord(body) && Array.isArray(body.platformTeams)
          ? body.platformTeams.filter(isRecord)
          : [];
      const lines = teams.map(
        (team) => `${str(team.teamName) || '(unnamed)'} — id: ${str(team.teamId)}`
      );
      if (lines.length === 0) return textResult('No operations teams.');
      return textResult(
        withPresentationHint(
          lines.join('\n'),
          'a table (Team, id) usually scans faster than this flat list.'
        )
      );
    }
  );

  server.registerTool(
    'jsm_ops_list_escalations',
    {
      title: 'JSM Ops · Read — List a team’s escalation policies',
      description:
        'The escalation policies of one operations team: each rule’s condition, delay, and ' +
        'recipient — how an unacknowledged alert climbs the ladder.',
      annotations: { readOnlyHint: true },
      inputSchema: z.object({
        teamId: z.string().min(1).describe('Team id from jsm_ops_list_teams'),
      }),
    },
    async (args: Record<string, any>) => {
      const teamId = encodeURIComponent(str(args.teamId));
      const response = await auth.fetch(
        opsScopes('jsm_ops_list_escalations', true),
        `/teams/${teamId}/escalations`
      );
      if (!response.ok) return errText(await describeOpsFailure(response));
      const body: unknown = await response.json().catch(() => null);
      const lines = items(body).map((escalation) => {
        const rules = Array.isArray(escalation.rules)
          ? escalation.rules.filter(isRecord).map((rule) => {
              const recipient = isRecord(rule.recipient)
                ? str(rule.recipient.id) || str(rule.recipient.type)
                : '';
              const delay = isRecord(rule.delay)
                ? `${rule.delay.timeAmount ?? ''} ${str(rule.delay.timeUnit)}`.trim()
                : '';
              return (
                `  ${str(rule.condition) || 'if-not-acked'} → notify ${recipient || '?'}` +
                (delay ? ` after ${delay}` : '')
              );
            })
          : [];
        return [
          `${str(escalation.name) || '(unnamed)'} — ` +
            `${escalation.enabled === false ? 'disabled' : 'enabled'} — id: ${str(escalation.id)}`,
          ...rules,
        ].join('\n');
      });
      if (lines.length === 0) return textResult('No escalation policies.');
      return textResult(
        withPresentationHint(
          lines.join('\n\n'),
          'a table (Escalation, Team) usually scans faster than this flat list.'
        )
      );
    }
  );
}
