/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Zoom MCP tools over the caller's own user grant ("Renkei sees my meetings
 * as me"). Reading is the bulk of it — meetings, recordings, transcripts,
 * AI Companion summaries — plus the three scheduling actions the user asked
 * Renkei to be able to take: create, update, cancel a meeting. The acting
 * tools carry readOnlyHint false, so org read-only mode disables them.
 *
 * Scope nuance unique to Zoom: a classic-scope Marketplace app ignores the
 * authorize request's scope parameter and mints its full scope set, so the
 * scope gate here never trusts bare granted scopes — the transport route
 * computes context.zoomScopes as requested ∩ granted (granular apps mint
 * exactly the request, so the intersection is the request; classic apps
 * mint everything, so it still is).
 *
 * The grant is resolved from the database on every call rather than baked
 * into the handler closure: tokens rotate on refresh and handlers are
 * cached — the stale-closure lesson.
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/server';
import {
  getGrant,
  refreshGrantTokens,
  ZOOM,
  ZoomAdapter,
  type ProviderGrant,
} from '@renkei/provider-grants';
import { ZoomClient, encodeZoomMeetingId, vttToText } from '@renkei/connector-zoom';
import { parseEncryptionKey } from '@renkei/crypto';
import { getDatabase } from '@renkei/db';
import { getZoomApp } from '@/lib/zoom-app';
import { logger, secure } from '@/lib/logger';
import { withScopeGate } from '../capability-gate';
import { withPresentationHint, type MCPToolContext } from '../common';

export const ZOOM_MCP_CONNECTOR = 'zoom';

const API = 'https://api.zoom.us/v2';
/** Refresh when the token is inside this window of expiry. */
const REFRESH_MARGIN_MS = 2 * 60 * 1000;

export interface ZoomAccess {
  accessToken: string;
  email: string | null;
}

/** The caller's live Zoom token, refreshed through the adapter when stale. */
/** Exported so the summary collectors can reuse the same refresh-aware resolution. */
export async function resolveZoomAccess(context: MCPToolContext): Promise<ZoomAccess | string> {
  if (!context.subject) return 'No signed-in subject on this MCP session.';
  const keyResult = parseEncryptionKey(process.env.TOKEN_ENCRYPTION_KEY || '');
  if (!keyResult.ok) return 'Server misconfigured (encryption key).';
  const dbResult = getDatabase();
  if (!dbResult.ok) return 'Database unavailable.';

  const row = await dbResult.val
    .selectFrom('provider_grants')
    .select('provider_account_id')
    .where('tenant_id', '=', context.tenantId)
    .where('provider', '=', ZOOM)
    .where('subject', '=', context.subject)
    .executeTakeFirst();
  if (!row) {
    return 'Zoom is not connected. Connect it on the Connectors page, then try again.';
  }

  const grantResult = await getGrant(
    ZOOM,
    context.tenantId,
    row.provider_account_id,
    keyResult.val
  );
  if (!grantResult.ok || !grantResult.val) return 'Could not read the Zoom grant.';
  let grant: ProviderGrant = grantResult.val;

  if (new Date(grant.expiresAt).getTime() - Date.now() < REFRESH_MARGIN_MS) {
    const app = await getZoomApp(context.tenantId, context.origin ?? '');
    if (!app) return 'Zoom integration is no longer configured.';
    const refreshed = await refreshGrantTokens(
      new ZoomAdapter(app.clientSecret),
      context.tenantId,
      grant.accountId,
      keyResult.val,
      logger
    );
    if (!refreshed.ok) {
      return refreshed.err.type === 'GRANT_REVOKED'
        ? 'Your Zoom authorization was revoked. Reconnect it on the Connectors page.'
        : 'Could not refresh the Zoom token; try again shortly.';
    }
    grant = { ...grant, accessToken: refreshed.val.accessToken };
  }

  const email = typeof grant.metadata.email === 'string' ? grant.metadata.email : null;
  return { accessToken: grant.accessToken, email };
}

function describeStatus(status: number): string {
  if (status === 403) {
    return (
      'Zoom refused (403) — the grant likely lacks the scope, or the Marketplace app is missing ' +
      'it. The org admin adds it to the app; then disconnect and reconnect Zoom.'
    );
  }
  if (status === 429) return 'Zoom is rate limiting (429); try again shortly.';
  return `Zoom API answered ${status}`;
}

/** Cap a logged body: enough to diagnose, bounded against megabyte payloads. */
function truncateForLog(text: string): string {
  return text.length > 1300 ? `${text.slice(0, 1300)}… (${text.length} chars total)` : text;
}

async function zoomRequest(
  context: MCPToolContext,
  accessToken: string,
  path: string,
  init?: { method?: string; json?: unknown }
): Promise<{ ok: true; response: Response } | { ok: false; error: string }> {
  const body = init?.json !== undefined ? JSON.stringify(init.json) : undefined;
  let response: Response;
  try {
    response = await fetch(`${API}${path}`, {
      method: init?.method ?? 'GET',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(body !== undefined ? { body } : {}),
    });
  } catch {
    logger.warn('Zoom API unreachable', {
      component: 'zoom/fetch',
      tenantId: context.tenantId,
      subject: context.subject,
      url: `${API}${path}`,
      method: init?.method ?? 'GET',
    });
    return { ok: false, error: 'Could not reach api.zoom.us' };
  }
  if (!response.ok) {
    const responseBody = await response.text().catch(() => '');
    logger.warn('Zoom API non-OK response', {
      component: 'zoom/fetch',
      tenantId: context.tenantId,
      subject: context.subject,
      url: `${API}${path}`,
      method: init?.method ?? 'GET',
      status: response.status,
      requestBody: body === undefined ? undefined : secure(truncateForLog(body)),
      responseBody: responseBody ? secure(truncateForLog(responseBody)) : undefined,
    });
    // Zoom's own {code, message} names the cause far better than a bare
    // status — an MCP caller cannot read our logs, so it rides the error.
    let zoomDetail = '';
    try {
      const parsed: unknown = JSON.parse(responseBody);
      if (typeof parsed === 'object' && parsed !== null) {
        // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
        const record = parsed as Record<string, unknown>;
        const message = typeof record.message === 'string' ? record.message : '';
        const code = typeof record.code === 'number' ? record.code : null;
        if (message)
          zoomDetail = ` Zoom said: "${message}"${code !== null ? ` (code ${code})` : ''}.`;
      }
    } catch {
      // non-JSON body — the status text will have to do
    }
    return { ok: false, error: `${describeStatus(response.status)}${zoomDetail}` };
  }
  return { ok: true, response };
}

async function zoomGet(
  context: MCPToolContext,
  accessToken: string,
  path: string
): Promise<{ ok: true; body: Record<string, unknown> } | { ok: false; error: string }> {
  const result = await zoomRequest(context, accessToken, path);
  if (!result.ok) return result;
  const body: unknown = await result.response.json().catch(() => null);
  if (typeof body !== 'object' || body === null) {
    return { ok: false, error: 'Malformed Zoom API response' };
  }
  // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
  return { ok: true, body: body as Record<string, unknown> };
}

function textResult(value: string) {
  return { content: [{ type: 'text' as const, text: value }] };
}

function errText(value: string) {
  return { content: [{ type: 'text' as const, text: value }], isError: true };
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function num(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function rec(value: unknown): Record<string, unknown> {
  // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
}

function list(body: Record<string, unknown>, key: string): Record<string, unknown>[] {
  const entries = body[key];
  return Array.isArray(entries)
    ? entries.filter(
        (item): item is Record<string, unknown> => typeof item === 'object' && item !== null
      )
    : [];
}

function meetingLine(meeting: Record<string, unknown>): string {
  const duration = num(meeting.duration);
  // The uuid rides along because some endpoints (meeting_summary, per-
  // occurrence lookups) only accept it — the numeric id is not enough.
  return (
    `${str(meeting.topic) || '(no topic)'} — ${str(meeting.start_time) || '(no start time)'}` +
    (duration !== null ? ` — ${duration} min` : '') +
    ` — id: ${str(meeting.id) || String(meeting.id ?? '')}` +
    (str(meeting.uuid) ? ` — uuid: ${str(meeting.uuid)}` : '') +
    (str(meeting.join_url) ? ` — [join](${str(meeting.join_url)})` : '')
  );
}

/** Which Zoom scope each tool stands on; registration filters against the grant. */
function zoomScopeFor(toolName: string): string[] {
  switch (toolName) {
    case 'zoom_list_meetings':
      return ['meeting:read:list_meetings'];
    case 'zoom_get_meeting':
      return ['meeting:read:meeting'];
    case 'zoom_create_meeting':
      return ['meeting:write:meeting'];
    case 'zoom_update_meeting':
      return ['meeting:update:meeting'];
    case 'zoom_delete_meeting':
      return ['meeting:delete:meeting'];
    case 'zoom_list_recordings':
      return ['cloud_recording:read:list_user_recordings'];
    case 'zoom_get_transcript':
      return ['cloud_recording:read:meeting_transcript'];
    case 'zoom_get_meeting_summary':
      return ['meeting:read:summary'];
    case 'zoom_search_notes':
      return ['canvas:write:file_search'];
    case 'zoom_list_notes':
      return ['my_notes:read:note'];
    case 'zoom_get_note':
      return ['my_notes:read:content'];
    case 'zoom_get_doc':
      return ['docs:read:export'];
    case 'zoom_create_doc':
      return ['docs:write:import'];
    case 'zoom_append_to_doc':
      return ['docs:write:content'];
    default:
      return ['user:read:user'];
  }
}

export async function registerZoomTools(
  rawServer: McpServer,
  context: MCPToolContext
): Promise<void> {
  // A tool whose scope the user's (possibly narrowed) selection lacks is
  // never registered — Renkei-enforced narrowing, see the header comment.
  const server = withScopeGate(rawServer, context.zoomScopes, (name) => zoomScopeFor(name));

  server.registerTool(
    'zoom_list_meetings',
    {
      title: 'Zoom · Read — List Zoom meetings',
      description:
        'List the connected user’s meetings — upcoming by default, or previous ones. Meeting ' +
        'ids feed zoom_get_meeting, zoom_get_transcript and zoom_get_meeting_summary.',
      annotations: { readOnlyHint: true },
      inputSchema: z.object({
        which: z
          .enum(['upcoming', 'previous_meetings', 'scheduled', 'live'])
          .describe('Which meetings (default upcoming)')
          .optional(),
        max: z.number().int().min(1).max(100).describe('How many (default 20)').optional(),
      }),
    },
    async (args: Record<string, any>) => {
      const access = await resolveZoomAccess(context);
      if (typeof access === 'string') return errText(access);
      const which = str(args.which) || 'upcoming';
      const max = typeof args.max === 'number' ? args.max : 20;
      const result = await zoomGet(
        context,
        access.accessToken,
        `/users/me/meetings?type=${encodeURIComponent(which)}&page_size=${max}`
      );
      if (!result.ok) return errText(result.error);
      const lines = list(result.body, 'meetings').map(meetingLine);
      if (lines.length === 0) return textResult('No meetings.');
      return textResult(
        withPresentationHint(
          lines.join('\n'),
          'a calendar-style agenda, or a table of time/topic/duration, usually reads clearer ' +
            'than this flat list.'
        )
      );
    }
  );

  server.registerTool(
    'zoom_get_meeting',
    {
      title: 'Zoom · Read — Get one Zoom meeting',
      description: 'Fetch a meeting’s details by id: time, agenda, join link.',
      annotations: { readOnlyHint: true },
      inputSchema: z.object({
        meetingId: z.string().min(1).describe('Meeting id (numeric) or UUID'),
      }),
    },
    async (args: Record<string, any>) => {
      const access = await resolveZoomAccess(context);
      if (typeof access === 'string') return errText(access);
      const meetingId = str(args.meetingId);
      if (!meetingId) return errText('meetingId is required');
      const result = await zoomGet(
        context,
        access.accessToken,
        `/meetings/${encodeZoomMeetingId(meetingId)}`
      );
      if (!result.ok) return errText(result.error);
      const meeting = result.body;
      return textResult(
        `${meetingLine(meeting)}\n` +
          `Timezone: ${str(meeting.timezone) || '(none)'} — status: ${str(meeting.status) || 'unknown'}\n` +
          (str(meeting.agenda) ? `\nAgenda:\n${str(meeting.agenda)}` : 'No agenda.')
      );
    }
  );

  server.registerTool(
    'zoom_create_meeting',
    {
      title: 'Zoom · Act — Schedule a Zoom meeting',
      description:
        'Create a scheduled meeting on the connected user’s calendar. Acts as the user — only ' +
        'schedule what they asked for.',
      // Acting tool: readOnlyHint false, so org read-only mode disables it.
      annotations: { readOnlyHint: false },
      inputSchema: z.object({
        topic: z.string().min(1).describe('Meeting topic/title'),
        startTime: z
          .string()
          .min(1)
          .describe('Start, ISO-8601 (e.g. 2026-08-12T15:00:00Z or local with timezone below)'),
        durationMinutes: z.number().int().min(1).max(1440).describe('Length in minutes'),
        timezone: z
          .string()
          .describe('IANA timezone for startTime (e.g. America/Chicago)')
          .optional(),
        agenda: z.string().describe('Agenda text shown on the invite').optional(),
      }),
    },
    async (args: Record<string, any>) => {
      const access = await resolveZoomAccess(context);
      if (typeof access === 'string') return errText(access);
      const result = await zoomRequest(context, access.accessToken, '/users/me/meetings', {
        method: 'POST',
        json: {
          topic: str(args.topic),
          type: 2, // scheduled
          start_time: str(args.startTime),
          duration: args.durationMinutes,
          ...(str(args.timezone) ? { timezone: str(args.timezone) } : {}),
          ...(str(args.agenda) ? { agenda: str(args.agenda) } : {}),
        },
      });
      if (!result.ok) return errText(result.error);
      const body = rec(await result.response.json().catch(() => null));
      logger.info('zoom_create_meeting created', {
        component: 'mcp/tool',
        tenantId: context.tenantId,
        meetingId: String(body.id ?? ''),
      });
      return textResult(
        `Scheduled "${str(body.topic)}" at ${str(body.start_time)} (id ${String(body.id ?? 'unknown')}).` +
          (str(body.join_url) ? `\nJoin: ${str(body.join_url)}` : '')
      );
    }
  );

  server.registerTool(
    'zoom_update_meeting',
    {
      title: 'Zoom · Act — Reschedule or edit a Zoom meeting',
      description:
        'Update a meeting’s topic, time, duration or agenda. Acts as the user; attendees see ' +
        'the change through Zoom.',
      annotations: { readOnlyHint: false },
      inputSchema: z.object({
        meetingId: z.string().min(1).describe('Meeting id to update'),
        topic: z.string().describe('New topic').optional(),
        startTime: z.string().describe('New start, ISO-8601').optional(),
        durationMinutes: z.number().int().min(1).max(1440).describe('New length').optional(),
        timezone: z.string().describe('IANA timezone for startTime').optional(),
        agenda: z.string().describe('New agenda').optional(),
      }),
    },
    async (args: Record<string, any>) => {
      const access = await resolveZoomAccess(context);
      if (typeof access === 'string') return errText(access);
      const meetingId = str(args.meetingId);
      if (!meetingId) return errText('meetingId is required');
      const patch: Record<string, unknown> = {};
      if (str(args.topic)) patch.topic = str(args.topic);
      if (str(args.startTime)) patch.start_time = str(args.startTime);
      if (typeof args.durationMinutes === 'number') patch.duration = args.durationMinutes;
      if (str(args.timezone)) patch.timezone = str(args.timezone);
      if (str(args.agenda)) patch.agenda = str(args.agenda);
      if (Object.keys(patch).length === 0) return errText('Nothing to update.');

      const result = await zoomRequest(
        context,
        access.accessToken,
        `/meetings/${encodeZoomMeetingId(meetingId)}`,
        { method: 'PATCH', json: patch }
      );
      if (!result.ok) return errText(result.error);
      logger.info('zoom_update_meeting updated', {
        component: 'mcp/tool',
        tenantId: context.tenantId,
        meetingId,
      });
      return textResult(`Meeting ${meetingId} updated (${Object.keys(patch).join(', ')}).`);
    }
  );

  server.registerTool(
    'zoom_delete_meeting',
    {
      title: 'Zoom · Act — Cancel a Zoom meeting',
      description: 'Delete (cancel) a scheduled meeting. Acts as the user; this cannot be undone.',
      annotations: { readOnlyHint: false },
      inputSchema: z.object({
        meetingId: z.string().min(1).describe('Meeting id to cancel'),
        notifyRegistrants: z
          .boolean()
          .describe('Email cancellation to registrants (default false)')
          .optional(),
      }),
    },
    async (args: Record<string, any>) => {
      const access = await resolveZoomAccess(context);
      if (typeof access === 'string') return errText(access);
      const meetingId = str(args.meetingId);
      if (!meetingId) return errText('meetingId is required');
      const notify = args.notifyRegistrants === true ? '?cancel_meeting_reminder=true' : '';
      const result = await zoomRequest(
        context,
        access.accessToken,
        `/meetings/${encodeZoomMeetingId(meetingId)}${notify}`,
        { method: 'DELETE' }
      );
      if (!result.ok) return errText(result.error);
      logger.info('zoom_delete_meeting cancelled', {
        component: 'mcp/tool',
        tenantId: context.tenantId,
        meetingId,
      });
      return textResult(`Meeting ${meetingId} cancelled.`);
    }
  );

  server.registerTool(
    'zoom_list_recordings',
    {
      title: 'Zoom · Read — List Zoom cloud recordings',
      description:
        'List the connected user’s cloud recordings in a time window (default: last 30 days). ' +
        'Meeting ids/UUIDs feed zoom_get_transcript.',
      annotations: { readOnlyHint: true },
      inputSchema: z.object({
        from: z.string().describe('Window start, YYYY-MM-DD (default 30 days ago)').optional(),
        to: z.string().describe('Window end, YYYY-MM-DD (default today)').optional(),
        max: z.number().int().min(1).max(100).describe('How many (default 20)').optional(),
      }),
    },
    async (args: Record<string, any>) => {
      const access = await resolveZoomAccess(context);
      if (typeof access === 'string') return errText(access);
      const from =
        str(args.from) || new Date(Date.now() - 30 * 24 * 3600 * 1000).toISOString().slice(0, 10);
      const to = str(args.to) || new Date().toISOString().slice(0, 10);
      const max = typeof args.max === 'number' ? args.max : 20;
      const result = await zoomGet(
        context,
        access.accessToken,
        `/users/me/recordings?from=${from}&to=${to}&page_size=${max}`
      );
      if (!result.ok) return errText(result.error);
      const lines = list(result.body, 'meetings').map((meeting) => {
        const files = Array.isArray(meeting.recording_files) ? meeting.recording_files.length : 0;
        return (
          `${str(meeting.topic) || '(no topic)'} — ${str(meeting.start_time)} — ` +
          `${files} file(s) — meeting id: ${String(meeting.id ?? '')} — uuid: ${str(meeting.uuid)}`
        );
      });
      if (lines.length === 0) return textResult('No recordings in that window.');
      return textResult(
        withPresentationHint(
          lines.join('\n'),
          'a table (Meeting, Date, File count) usually scans faster than this flat list.'
        )
      );
    }
  );

  server.registerTool(
    'zoom_get_transcript',
    {
      title: 'Zoom · Read — Get a Zoom meeting transcript',
      description:
        'Download and clean the transcript of a cloud-recorded meeting (audio transcript must ' +
        'have been enabled). The raw material for "summarize that meeting".',
      annotations: { readOnlyHint: true },
      inputSchema: z.object({
        meetingId: z.string().min(1).describe('Meeting id or UUID from zoom_list_recordings'),
      }),
    },
    async (args: Record<string, any>) => {
      const access = await resolveZoomAccess(context);
      if (typeof access === 'string') return errText(access);
      const meetingId = str(args.meetingId);
      if (!meetingId) return errText('meetingId is required');

      const client = new ZoomClient(access.accessToken);
      const transcript = await client.getMeetingTranscript(meetingId);
      if (!transcript.ok) {
        return errText(
          transcript.err.type === 'NOT_FOUND'
            ? 'No transcript for that meeting (not cloud-recorded, still processing, or audio transcript disabled).'
            : `Could not fetch the transcript from Zoom: ${transcript.err.message ?? 'unknown error'}`
        );
      }
      const vtt = await client.downloadFromUrl(transcript.val.downloadUrl);
      if (!vtt.ok) {
        return errText(
          `Could not download the transcript file: ${vtt.err.message ?? 'unknown error'}`
        );
      }
      const text = vttToText(vtt.val);
      if (!text) return errText('Transcript came back empty.');
      const MAX = 80_000;
      const capped =
        text.length > MAX
          ? `${text.slice(0, MAX)}\n\n[…truncated: ${text.length - MAX} more characters]`
          : text;
      return textResult(capped);
    }
  );

  server.registerTool(
    'zoom_get_meeting_summary',
    {
      title: 'Zoom · Read — Get a Zoom AI Companion meeting summary',
      description:
        'Fetch the AI Companion summary of a meeting the connected user hosted (AI Companion ' +
        'must be enabled on the account). Accepts the meeting UUID directly, or a numeric ' +
        'meeting id — which is resolved to the latest occurrence’s UUID first, because the ' +
        'summary endpoint only answers to UUIDs.',
      annotations: { readOnlyHint: true },
      inputSchema: z.object({
        meetingId: z.string().min(1).describe('Meeting UUID (preferred) or numeric meeting id'),
      }),
    },
    async (args: Record<string, any>) => {
      const access = await resolveZoomAccess(context);
      if (typeof access === 'string') return errText(access);
      const meetingId = str(args.meetingId);
      if (!meetingId) return errText('meetingId is required');

      // The summary endpoint 400s on numeric ids ("Invalid meeting id") —
      // it wants the occurrence UUID. Resolve numeric ids through the
      // meeting lookup; if that lookup is refused (scope narrowed away),
      // fall through with the raw id and let Zoom's error name itself.
      let summaryKey = meetingId;
      if (/^\d+$/.test(meetingId)) {
        const lookup = await zoomGet(context, access.accessToken, `/meetings/${meetingId}`);
        if (lookup.ok && str(lookup.body.uuid)) {
          summaryKey = str(lookup.body.uuid);
        }
      }

      const client = new ZoomClient(access.accessToken);
      const summary = await client.getMeetingSummary(summaryKey);
      if (!summary.ok) {
        return errText(
          summary.err.type === 'NOT_FOUND'
            ? 'No AI Companion summary for that meeting (not generated, or AI Companion is off).'
            : `Could not fetch the meeting summary from Zoom: ${summary.err.message ?? 'unknown error'}`
        );
      }
      const body = rec(summary.val);
      const details = Array.isArray(body.summary_details)
        ? body.summary_details
            .map((entry) => {
              const detail = rec(entry);
              return `## ${str(detail.label) || 'Section'}\n${str(detail.summary)}`;
            })
            .join('\n\n')
        : '';
      const nextSteps = Array.isArray(body.next_steps)
        ? body.next_steps.filter((step): step is string => typeof step === 'string')
        : [];
      const text = [
        `# ${str(body.summary_title) || str(body.meeting_topic) || 'Meeting summary'}`,
        str(body.summary_overview),
        details,
        nextSteps.length ? `## Next steps\n${nextSteps.map((step) => `- ${step}`).join('\n')}` : '',
      ]
        .filter(Boolean)
        .join('\n\n');
      return textResult(text || 'The summary exists but carried no content.');
    }
  );

  server.registerTool(
    'zoom_search_notes',
    {
      title: 'Zoom · Read — Search all My Notes',
      description:
        'List or search the connected user’s My Notes across ALL meetings (no meeting id ' +
        'needed) — titles and searchable content, newest-relevant first. Note ids feed ' +
        'zoom_get_note. Leave query empty to just list notes.',
      annotations: { readOnlyHint: true },
      inputSchema: z.object({
        query: z
          .string()
          .describe('Keyword matched against note titles and content; omit to list all')
          .optional(),
        modifiedAfter: z
          .string()
          .describe('Only notes modified after this ISO-8601 time')
          .optional(),
        modifiedBefore: z
          .string()
          .describe('Only notes modified before this ISO-8601 time')
          .optional(),
        max: z.number().int().min(1).max(50).describe('Per page (default 20)').optional(),
        nextPageToken: z
          .string()
          .describe('Opaque cursor from a previous page — pass with the SAME filters')
          .optional(),
      }),
    },
    async (args: Record<string, any>) => {
      const access = await resolveZoomAccess(context);
      if (typeof access === 'string') return errText(access);

      // The cross-meeting listing lives in the Canvas Search API — the
      // My Notes API itself can only list per meeting.
      const result = await zoomRequest(context, access.accessToken, '/docs/file_search', {
        method: 'POST',
        json: {
          file_types: ['note'],
          page_size: typeof args.max === 'number' ? args.max : 20,
          ...(str(args.query) ? { query: str(args.query) } : {}),
          ...(str(args.modifiedAfter) ? { modified_time_from: str(args.modifiedAfter) } : {}),
          ...(str(args.modifiedBefore) ? { modified_time_to: str(args.modifiedBefore) } : {}),
          ...(str(args.nextPageToken) ? { next_page_token: str(args.nextPageToken) } : {}),
        },
      });
      if (!result.ok) {
        // "Route Not Found" here is Zoom's gateway hiding an entitlement-
        // gated route (the Search API shipped 2026-08-03 but only resolves
        // for accounts with Zoom Docs enabled) — a provisioning fact, not a
        // data state.
        return errText(
          result.error.includes('404')
            ? `${result.error} The cross-meeting note search lives in the Zoom Docs (Canvas) ` +
                'API, which is not reachable for this account yet: enable Zoom Docs in admin ' +
                'settings (separate from My Notes), and note Zoom may still be rolling this ' +
                'endpoint out (released 2026-08-03). Per-meeting zoom_list_notes still works.'
            : result.error
        );
      }
      const body = rec(await result.response.json().catch(() => null));

      const lines = list(body, 'files').map(
        (file) =>
          `${str(file.file_name) || '(untitled)'} — id: ${str(file.file_id)}` +
          (str(file.file_link) ? ` — [open](${str(file.file_link)})` : '')
      );
      const nextToken = str(body.next_page_token);
      const nextLine = nextToken ? `\n\nMore available — pass nextPageToken: ${nextToken}` : '';
      if (lines.length === 0) return textResult(`No notes found.${nextLine}`);
      return textResult(
        withPresentationHint(
          lines.join('\n') + nextLine,
          'a table (Note, id) usually scans faster than this flat list.'
        )
      );
    }
  );

  server.registerTool(
    'zoom_list_notes',
    {
      title: 'Zoom · Read — List My Notes for a meeting',
      description:
        'The connected user’s My Notes attached to one meeting (Zoom’s AI note-taking ' +
        'companion). Note ids feed zoom_get_note. My Notes must be enabled on the account.',
      annotations: { readOnlyHint: true },
      inputSchema: z.object({
        meetingId: z.string().min(1).describe('Meeting id or UUID the notes belong to'),
      }),
    },
    async (args: Record<string, any>) => {
      const access = await resolveZoomAccess(context);
      if (typeof access === 'string') return errText(access);
      const meetingId = str(args.meetingId);
      if (!meetingId) return errText('meetingId is required');
      const result = await zoomGet(
        context,
        access.accessToken,
        `/my_notes/notes?meeting_id=${encodeURIComponent(meetingId)}`
      );
      if (!result.ok) return errText(result.error);
      const lines = list(result.body, 'notes').map(
        (note) =>
          `${str(note.note_name) || '(untitled)'} — modified ${str(note.modified_time)}` +
          ` — id: ${str(note.note_id)}` +
          (str(note.note_link) ? ` — [open](${str(note.note_link)})` : '')
      );
      if (lines.length === 0) return textResult('No notes for that meeting.');
      return textResult(
        withPresentationHint(
          lines.join('\n'),
          'a table (Note, Modified, id) usually scans faster than this flat list.'
        )
      );
    }
  );

  server.registerTool(
    'zoom_get_note',
    {
      title: 'Zoom · Read — Get a My Notes note',
      description:
        'One My Notes note: the user’s own notes plus the AI-generated recap, optionally with ' +
        'the meeting transcript. The My Notes API is read-only — Zoom publishes no update ' +
        'endpoint, so edits happen in the Zoom client.',
      annotations: { readOnlyHint: true },
      inputSchema: z.object({
        noteId: z.string().min(1).describe('Note id from zoom_list_notes'),
        includeTranscript: z
          .boolean()
          .describe('Also return the associated meeting transcript (default false)')
          .optional(),
      }),
    },
    async (args: Record<string, any>) => {
      const access = await resolveZoomAccess(context);
      if (typeof access === 'string') return errText(access);
      const noteId = str(args.noteId);
      if (!noteId) return errText('noteId is required');
      const include = args.includeTranscript === true ? '?include=transcript' : '';
      const result = await zoomGet(
        context,
        access.accessToken,
        `/my_notes/notes/${encodeURIComponent(noteId)}/content${include}`
      );
      if (!result.ok) return errText(result.error);
      const note = result.body;

      const sections = [
        `# ${str(note.note_name) || '(untitled note)'}` +
          (str(note.note_url) ? `\n[Open in Zoom](${str(note.note_url)})` : ''),
      ];
      const manual = str(note.manual_note_content);
      if (manual.trim()) sections.push(`## Your notes\n${manual}`);
      const generated = str(note.generated_note_content);
      if (generated.trim()) sections.push(`## AI-generated notes\n${generated}`);
      if (!manual.trim() && !generated.trim()) sections.push('(The note has no content yet.)');

      const transcript = rec(note.transcript);
      if (Array.isArray(transcript.items) && transcript.items.length > 0) {
        // Resolve speaker ids to names so the transcript reads as dialogue.
        const speakerNames = new Map<string, string>();
        if (Array.isArray(transcript.speakers)) {
          for (const entry of transcript.speakers) {
            const speaker = rec(entry);
            const id = str(speaker.speaker_id);
            if (id) speakerNames.set(id, str(speaker.display_name) || `Speaker ${id}`);
          }
        }
        const lines = transcript.items.map((entry) => {
          const item = rec(entry);
          const who = speakerNames.get(str(item.speaker_id)) ?? 'Unknown speaker';
          return `[${str(item.start_time)}] ${who}: ${str(item.text)}`;
        });
        const joined = lines.join('\n');
        const MAX = 60_000;
        sections.push(
          `## Transcript\n${
            joined.length > MAX
              ? `${joined.slice(0, MAX)}\n\n[…truncated: ${joined.length - MAX} more characters]`
              : joined
          }`
        );
      }
      return textResult(sections.join('\n\n'));
    }
  );

  server.registerTool(
    'zoom_get_doc',
    {
      title: 'Zoom · Read — Get a Zoom Doc',
      description:
        'Read a Zoom Doc as Markdown — including a My Notes page: a note IS a doc, and its ' +
        'file id is the last path segment of the note_url from zoom_get_note or the id from ' +
        'zoom_search_notes. Needs Zoom Docs enabled on the account.',
      annotations: { readOnlyHint: true },
      inputSchema: z.object({
        fileId: z
          .string()
          .min(1)
          .describe('Doc file id (from zoom_search_notes, or the docs.zoom.us/doc/… URL)'),
      }),
    },
    async (args: Record<string, any>) => {
      const access = await resolveZoomAccess(context);
      if (typeof access === 'string') return errText(access);
      const fileId = str(args.fileId);
      if (!fileId) return errText('fileId is required');
      const result = await zoomGet(
        context,
        access.accessToken,
        `/docs/files/${encodeURIComponent(fileId)}/content`
      );
      if (!result.ok) return errText(result.error);
      const name = str(result.body.file_name);
      const content = str(result.body.file_content);
      const MAX = 80_000;
      const capped =
        content.length > MAX
          ? `${content.slice(0, MAX)}\n\n[…truncated: ${content.length - MAX} more characters]`
          : content;
      return textResult(`# ${name || '(untitled doc)'}\n\n${capped || '(The doc is empty.)'}`);
    }
  );

  server.registerTool(
    'zoom_create_doc',
    {
      title: 'Zoom · Act — Create a Zoom Doc',
      description:
        'Create a new Zoom Doc from Markdown content (up to 100 KB), placed under My Docs. ' +
        'Acts as the user — only create what they asked for.',
      annotations: { readOnlyHint: false },
      inputSchema: z.object({
        name: z.string().min(1).describe('Document title'),
        markdown: z.string().min(1).describe('Document content, Markdown'),
      }),
    },
    async (args: Record<string, any>) => {
      const access = await resolveZoomAccess(context);
      if (typeof access === 'string') return errText(access);
      const result = await zoomRequest(context, access.accessToken, '/docs/import_content', {
        method: 'POST',
        json: { file_name: str(args.name), content: str(args.markdown) },
      });
      if (!result.ok) return errText(result.error);
      const body = rec(await result.response.json().catch(() => null));
      logger.info('zoom_create_doc created', {
        component: 'mcp/tool',
        tenantId: context.tenantId,
        fileId: str(body.file_id),
      });
      return textResult(
        `Created "${str(args.name)}" (id ${str(body.file_id) || 'unknown'}).` +
          (str(body.file_link) ? `\n[Open](${str(body.file_link)})` : '')
      );
    }
  );

  server.registerTool(
    'zoom_append_to_doc',
    {
      title: 'Zoom · Act — Append to a Zoom Doc',
      description:
        'Append text to the end of a Zoom Doc — including a My Notes page, which makes this ' +
        'the way to add follow-ups or action items to a note. Each paragraph becomes a text ' +
        'block. Acts as the user.',
      annotations: { readOnlyHint: false },
      inputSchema: z.object({
        fileId: z
          .string()
          .min(1)
          .describe('Doc file id (from zoom_search_notes, or the docs.zoom.us/doc/… URL)'),
        text: z.string().min(1).describe('Text to append; blank lines split paragraphs'),
      }),
    },
    async (args: Record<string, any>) => {
      const access = await resolveZoomAccess(context);
      if (typeof access === 'string') return errText(access);
      const fileId = str(args.fileId);
      if (!fileId) return errText('fileId is required');
      const text = str(args.text);
      if (!text.trim()) return errText('text is required');

      // The blocks API takes Zoom's XML block format; plain paragraphs wrapped
      // as <text> elements cover the append-notes case without the block-id
      // dance (block-level edits are future work if ever needed).
      const escapeXml = (value: string) =>
        value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
      const blocks = text
        .split(/\n{2,}/)
        .map((paragraph) => paragraph.trim())
        .filter(Boolean)
        .map((paragraph) => `<text>${escapeXml(paragraph)}</text>`)
        .join('');

      const result = await zoomRequest(
        context,
        access.accessToken,
        `/docs/files/${encodeURIComponent(fileId)}/blocks`,
        { method: 'POST', json: { blocks } }
      );
      if (!result.ok) return errText(result.error);
      logger.info('zoom_append_to_doc appended', {
        component: 'mcp/tool',
        tenantId: context.tenantId,
        fileId,
      });
      return textResult(`Appended to doc ${fileId}.`);
    }
  );
}
