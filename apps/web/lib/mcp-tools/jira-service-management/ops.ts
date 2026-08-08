/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * JSM Operations tools — alerts, schedules, rotations, on-call — over the
 * caller's existing Atlassian grant. Same auth.atlassian.com token, different
 * gateway: api.atlassian.com/jsm/ops/api/{cloudId}/v1 (spec vendored at
 * docs/jira-service-management-ops-rest-api-open-api-spec.json).
 *
 * The Ops API takes GRANULAR scopes only (read:ops-alert:… etc.), which ship
 * default-off in the connector's scope checkboxes — a 401/403 here means the
 * grant predates them or the Atlassian app lacks them, and the error says so
 * rather than leaving a bare status. Teams have no list endpoint in this API
 * (that is the separate Atlassian platform Teams API); schedules carry their
 * owning teamId.
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/server';
import { jiraFetch } from '../common';
import type { MCPToolContext } from '../common';
import { logger } from '@/lib/logger';

function textResult(value: string) {
  return { content: [{ type: 'text' as const, text: value }] };
}

function errText(value: string) {
  return { content: [{ type: 'text' as const, text: value }], isError: true };
}

function opsBase(context: MCPToolContext): string | null {
  return context.cloudId ? `https://api.atlassian.com/jsm/ops/api/${context.cloudId}/v1` : null;
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
  if (response.status === 401 || response.status === 403) {
    return (
      `JSM Operations refused (${response.status}). The grant likely lacks the granular Ops ` +
      'scopes (read:ops-alert / write:ops-alert / read:ops-config, all suffixed ' +
      ':jira-service-management). An org admin must check them in the connector setup AND add ' +
      'them to the Atlassian app, then you reconnect Jira. If Atlassian refuses the authorize ' +
      'step after that, the classic and granular scopes may need separate app registrations.'
    );
  }
  const body = await response.text().catch(() => '');
  let detail = '';
  try {
    const parsed: unknown = JSON.parse(body);
    if (typeof parsed === 'object' && parsed !== null) {
      // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
      detail = str((parsed as Record<string, unknown>).message);
    }
  } catch {
    // Non-JSON body; the status alone will have to do.
  }
  return `JSM Operations answered ${response.status}${detail ? `: ${detail}` : ''}`;
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
  context: MCPToolContext
): Promise<void> {
  server.registerTool(
    'jsm_ops_list_alerts',
    {
      title: 'List JSM Operations alerts',
      description:
        'List operations alerts (the Opsgenie-style alerting in Jira Service Management), ' +
        'newest first. Supports the alert search syntax, e.g. `status:open`, ' +
        '`status:open AND priority:P1`, `responders:"Team Name"`.',
      annotations: { readOnlyHint: true },
      inputSchema: z.object({
        query: z.string().describe('Alert search query, e.g. status:open').optional(),
        size: z.number().int().min(1).max(100).describe('How many (default 20)').optional(),
      }),
    },
    async (args: Record<string, any>) => {
      const base = opsBase(context);
      if (!base) return errText('No Atlassian cloud id on this connection.');
      const parts = [
        `size=${typeof args.size === 'number' ? args.size : 20}`,
        'sort=createdAt',
        'order=desc',
      ];
      if (str(args.query)) parts.push(`query=${encodeURIComponent(str(args.query))}`);
      const response = await jiraFetch(`${base}/alerts?${parts.join('&')}`, context.accessToken);
      if (!response.ok) return errText(await describeOpsFailure(response));
      const body: unknown = await response.json().catch(() => null);
      const lines = items(body).map(alertLine);
      return textResult(lines.length === 0 ? 'No alerts.' : lines.join('\n'));
    }
  );

  server.registerTool(
    'jsm_ops_get_alert',
    {
      title: 'Get a JSM Operations alert',
      description: 'Full detail of one alert by id: description, responders, tags, timestamps.',
      annotations: { readOnlyHint: true },
      inputSchema: z.object({
        alertId: z.string().min(1).describe('Alert id from jsm_ops_list_alerts'),
      }),
    },
    async (args: Record<string, any>) => {
      const base = opsBase(context);
      if (!base) return errText('No Atlassian cloud id on this connection.');
      const response = await jiraFetch(
        `${base}/alerts/${encodeURIComponent(str(args.alertId))}`,
        context.accessToken
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
      title: 'Acknowledge a JSM Operations alert',
      description:
        'Acknowledge an alert as the connected user — tells the team someone is on it. ' +
        'Requires the write:ops-alert scope.',
      inputSchema: z.object({
        alertId: z.string().min(1).describe('Alert id'),
      }),
    },
    async (args: Record<string, any>) => {
      const base = opsBase(context);
      if (!base) return errText('No Atlassian cloud id on this connection.');
      const alertId = encodeURIComponent(str(args.alertId));
      const response = await jiraFetch(
        `${base}/alerts/${alertId}/acknowledge`,
        context.accessToken,
        {
          method: 'POST',
          body: JSON.stringify({}),
        }
      );
      if (!response.ok) return errText(await describeOpsFailure(response));
      logger.info('[Tool] jsm_ops_acknowledge_alert', {
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
      title: 'Close a JSM Operations alert',
      description:
        'Close an alert as the connected user. Closing is a decision — do it only when the ' +
        'user says the alert is resolved. Requires the write:ops-alert scope.',
      inputSchema: z.object({
        alertId: z.string().min(1).describe('Alert id'),
      }),
    },
    async (args: Record<string, any>) => {
      const base = opsBase(context);
      if (!base) return errText('No Atlassian cloud id on this connection.');
      const alertId = encodeURIComponent(str(args.alertId));
      const response = await jiraFetch(`${base}/alerts/${alertId}/close`, context.accessToken, {
        method: 'POST',
        body: JSON.stringify({}),
      });
      if (!response.ok) return errText(await describeOpsFailure(response));
      logger.info('[Tool] jsm_ops_close_alert', {
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
      title: 'List JSM Operations on-call schedules',
      description:
        'List on-call schedules with their rotations: rotation type, length, and participants. ' +
        'Schedule ids feed jsm_ops_whos_on_call.',
      annotations: { readOnlyHint: true },
      inputSchema: z.object({
        size: z.number().int().min(1).max(50).describe('How many (default 20)').optional(),
      }),
    },
    async (args: Record<string, any>) => {
      const base = opsBase(context);
      if (!base) return errText('No Atlassian cloud id on this connection.');
      const size = typeof args.size === 'number' ? args.size : 20;
      const response = await jiraFetch(
        `${base}/schedules?size=${size}&expand=rotation`,
        context.accessToken
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
          return (
            `  rotation: ${str(rotation.name) || '(unnamed)'} — ${str(rotation.type)}` +
            `${typeof rotation.length === 'number' ? ` ×${rotation.length}` : ''}` +
            (participants.length ? ` — participants: ${participants.join(', ')}` : '')
          );
        });
        return [
          `${str(schedule.name) || '(unnamed)'} — tz ${str(schedule.timezone)} — ` +
            `${schedule.enabled === false ? 'disabled' : 'enabled'} — id: ${str(schedule.id)}` +
            (str(schedule.teamId) ? ` — team: ${str(schedule.teamId)}` : ''),
          ...rotationLines,
        ].join('\n');
      });
      return textResult(lines.length === 0 ? 'No schedules.' : lines.join('\n\n'));
    }
  );

  server.registerTool(
    'jsm_ops_whos_on_call',
    {
      title: 'Who is on call',
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
      const base = opsBase(context);
      if (!base) return errText('No Atlassian cloud id on this connection.');
      const scheduleId = encodeURIComponent(str(args.scheduleId));
      const parts = ['flat=true'];
      if (str(args.date)) parts.push(`date=${encodeURIComponent(str(args.date))}`);
      const response = await jiraFetch(
        `${base}/schedules/${scheduleId}/on-calls?${parts.join('&')}`,
        context.accessToken
      );
      if (!response.ok) return errText(await describeOpsFailure(response));
      const body: unknown = await response.json().catch(() => null);
      const participants =
        typeof body === 'object' && body !== null
          ? // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
            (body as Record<string, unknown>).onCallParticipants
          : null;
      const names = Array.isArray(participants)
        ? participants
            .map((p) => (typeof p === 'string' ? p : str(isRecord(p) ? p.id : null)))
            .filter(Boolean)
        : [];
      return textResult(
        names.length === 0 ? 'Nobody is on call for that schedule.' : names.join('\n')
      );
    }
  );
}
