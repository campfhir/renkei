/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Zoom MCP tools over the caller's own user grant ("Renkei sees my meetings
 * as me"). Reading is the bulk of it — meetings, recordings, transcripts,
 * AI Companion summaries — plus the three scheduling actions the user asked
 * Renkei to be able to take: create, update, cancel a meeting. The acting
 * tools carry readOnlyHint false, so org read-only mode disables them.
 *
 * How each call authenticates is an injected `ZoomAuth` (see zoom-auth.ts),
 * not something this file resolves itself — production always passes
 * `oauthZoomAuth`; `zoom.no-sandbox.test.ts` passes `deniedZoomAuth` instead,
 * since no Zoom sandbox exists yet. Two tools — zoom_get_transcript and
 * zoom_get_meeting_summary — are a documented exception: they construct a
 * ZoomClient with no injectable transport of its own, so they resolve
 * access via resolveZoomAccess directly rather than through ZoomAuth.fetch()
 * — see zoom-auth.ts's header for why that isn't fixable here.
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/server';
import { ZoomClient, encodeZoomMeetingId, vttToText } from '@renkei/connector-zoom';
import { logger } from '@/lib/logger';
import { withScopeGate } from '../capability-gate';
import { withPresentationHint, type MCPToolContext } from '../common';
import { APP_ONLY_META, MEETING_PREVIEW_URI, confirmGuard, previewToolMeta } from '../widgets';
import { resolveZoomAccess, ZOOM_API_BASE, type ZoomAuth } from './zoom-auth';

export const ZOOM_MCP_CONNECTOR = 'zoom';

function describeZoomFailure(status: number, detail: string): string {
  let base: string;
  if (status === 403) {
    base =
      'Zoom refused (403) — the grant likely lacks the scope, or the Marketplace app is missing ' +
      'it. The org admin adds it to the app; then disconnect and reconnect Zoom.';
  } else if (status === 429) {
    base = 'Zoom is rate limiting (429); try again shortly.';
  } else {
    base = `Zoom API answered ${status}`;
  }
  return detail ? `${base} Zoom said: "${detail}".` : base;
}

/** GET a path and parse its JSON body, translating a non-OK response uniformly. */
async function zoomGet(
  auth: ZoomAuth,
  scopes: string[],
  path: string
): Promise<{ ok: true; body: Record<string, unknown> } | { ok: false; error: string }> {
  const result = await zoomCall(auth, scopes, path);
  if (!result.ok) return result;
  const body: unknown = await result.response.json().catch(() => null);
  if (typeof body !== 'object' || body === null) {
    return { ok: false, error: 'Malformed Zoom API response' };
  }
  // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
  return { ok: true, body: body as Record<string, unknown> };
}

/** For callers that need the raw Response — a POST, or one whose caller reads the status itself. */
async function zoomCall(
  auth: ZoomAuth,
  scopes: string[],
  path: string,
  init?: { method?: string; json?: unknown }
): Promise<{ ok: true; response: Response } | { ok: false; error: string }> {
  const response = await auth.fetch(scopes, path, {
    method: init?.method ?? 'GET',
    ...(init?.json !== undefined ? { body: JSON.stringify(init.json) } : {}),
  });
  if (response.ok) return { ok: true, response };

  // Zoom's own {code, message} names the cause far better than a bare
  // status — an MCP caller cannot read our logs, so it rides the error. The
  // same body shape covers a synthetic auth-denial Response too (authFailure
  // puts its text in `message`), so one read handles both.
  const responseBody = await response.text().catch(() => '');
  let detail = '';
  try {
    const parsed: unknown = JSON.parse(responseBody);
    if (typeof parsed === 'object' && parsed !== null) {
      // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
      detail = str((parsed as Record<string, unknown>).message);
    }
  } catch {
    // non-JSON body — the status text will have to do
  }
  return { ok: false, error: describeZoomFailure(response.status, detail) };
}

/**
 * Best-effort: resolves a numeric meeting id to its latest UUID for
 * zoom_get_meeting_summary, which the summary endpoint requires. Failures
 * are silently ignored by the caller (the raw id is tried instead and
 * Zoom's own error names itself), so this needs no logging or detailed
 * error interpretation of its own — a small direct fetch rather than
 * routing a low-stakes, already-best-effort lookup through the full
 * ZoomAuth/zoomGet machinery.
 */
async function tryResolveMeetingUuid(
  accessToken: string,
  meetingId: string
): Promise<string | null> {
  try {
    const response = await fetch(`${ZOOM_API_BASE}/meetings/${meetingId}`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!response.ok) return null;
    const body: unknown = await response.json().catch(() => null);
    const uuid =
      typeof body === 'object' && body !== null
        ? // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
          (body as Record<string, unknown>).uuid
        : undefined;
    return typeof uuid === 'string' && uuid ? uuid : null;
  } catch {
    return null;
  }
}

function textResult(value: string) {
  return { content: [{ type: 'text' as const, text: value }] };
}

function errText(value: string) {
  return { content: [{ type: 'text' as const, text: value }], isError: true };
}

function clipChars(value: string, max: number): string {
  return value.length > max
    ? `${value.slice(0, max)}\n[…truncated: ${value.length - max} more characters]`
    : value;
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

/** Which Zoom scope each tool stands on; used at both registration and call time. */
export function zoomScopeFor(toolName: string): string[] {
  switch (toolName) {
    case 'zoom_list_meetings':
      return ['meeting:read:list_meetings'];
    case 'zoom_get_meeting':
      return ['meeting:read:meeting'];
    // The preview/confirm pair stands on the same scope as the create it gates.
    case 'zoom_create_meeting':
    case 'zoom_create_meeting_preview':
    case 'zoom_create_meeting_confirm':
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
    case 'zoom_bulk_get_notes':
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
  context: MCPToolContext,
  auth: ZoomAuth
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
      const which = str(args.which) || 'upcoming';
      const max = typeof args.max === 'number' ? args.max : 20;
      const result = await zoomGet(
        auth,
        zoomScopeFor('zoom_list_meetings'),
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
      const meetingId = str(args.meetingId);
      if (!meetingId) return errText('meetingId is required');
      const result = await zoomGet(
        auth,
        zoomScopeFor('zoom_get_meeting'),
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
      const result = await zoomCall(
        auth,
        zoomScopeFor('zoom_create_meeting'),
        '/users/me/meetings',
        {
          method: 'POST',
          json: {
            topic: str(args.topic),
            type: 2, // scheduled
            start_time: str(args.startTime),
            duration: args.durationMinutes,
            ...(str(args.timezone) ? { timezone: str(args.timezone) } : {}),
            ...(str(args.agenda) ? { agenda: str(args.agenda) } : {}),
          },
        }
      );
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

  // ——— Interactive preview (MCP Apps) ————————————————————————————————
  // Zoom-side nothing is created at preview time; the card holds the
  // normalized request and its Create button runs the confirm tool below.

  server.registerTool(
    'zoom_create_meeting_preview',
    {
      title: 'Zoom · Act — Preview a meeting before scheduling',
      description:
        'Show the user an interactive preview card of a Zoom meeting to create or cancel. ' +
        'Prefer this over zoom_create_meeting whenever the user should review first — the ' +
        'card does the creating; after calling this do not schedule the meeting another way. ' +
        'Acts as the user.',
      annotations: { readOnlyHint: false },
      _meta: previewToolMeta(MEETING_PREVIEW_URI),
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
      const topic = str(args.topic);
      const startTime = str(args.startTime);
      if (!topic) return errText('topic is required');
      if (!startTime) return errText('startTime is required');
      return {
        ...textResult(
          `The meeting "${topic}" (${startTime}) is awaiting the user's decision on the ` +
            `preview card. Do not schedule it another way; the user creates or cancels from ` +
            `the card. If no card appeared in this client, ask the user whether to schedule ` +
            `it with zoom_create_meeting instead.`
        ),
        structuredContent: {
          kind: 'zoom',
          topic,
          startTime,
          durationMinutes: args.durationMinutes,
          ...(str(args.timezone) ? { timezone: str(args.timezone) } : {}),
          ...(str(args.agenda) ? { agenda: str(args.agenda) } : {}),
        },
      };
    }
  );

  server.registerTool(
    'zoom_create_meeting_confirm',
    {
      title: 'Zoom · Act — Schedule a previewed meeting (card only)',
      description:
        'Create a Zoom meeting the user approved on a preview card.' +
        confirmGuard('zoom_create_meeting_preview'),
      annotations: { readOnlyHint: false },
      _meta: APP_ONLY_META,
      inputSchema: z.object({
        topic: z.string().min(1).describe('Meeting topic/title'),
        startTime: z.string().min(1).describe('Start, ISO-8601'),
        durationMinutes: z.number().int().min(1).max(1440).describe('Length in minutes'),
        timezone: z.string().describe('IANA timezone for startTime').optional(),
        agenda: z.string().describe('Agenda text shown on the invite').optional(),
      }),
    },
    async (args: Record<string, any>) => {
      const result = await zoomCall(
        auth,
        zoomScopeFor('zoom_create_meeting'),
        '/users/me/meetings',
        {
          method: 'POST',
          json: {
            topic: str(args.topic),
            type: 2, // scheduled
            start_time: str(args.startTime),
            duration: args.durationMinutes,
            ...(str(args.timezone) ? { timezone: str(args.timezone) } : {}),
            ...(str(args.agenda) ? { agenda: str(args.agenda) } : {}),
          },
        }
      );
      if (!result.ok) return errText(result.error);
      const body = rec(await result.response.json().catch(() => null));
      logger.info('zoom_create_meeting_confirm created', {
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
      const meetingId = str(args.meetingId);
      if (!meetingId) return errText('meetingId is required');
      const patch: Record<string, unknown> = {};
      if (str(args.topic)) patch.topic = str(args.topic);
      if (str(args.startTime)) patch.start_time = str(args.startTime);
      if (typeof args.durationMinutes === 'number') patch.duration = args.durationMinutes;
      if (str(args.timezone)) patch.timezone = str(args.timezone);
      if (str(args.agenda)) patch.agenda = str(args.agenda);
      if (Object.keys(patch).length === 0) return errText('Nothing to update.');

      const result = await zoomCall(
        auth,
        zoomScopeFor('zoom_update_meeting'),
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
      const meetingId = str(args.meetingId);
      if (!meetingId) return errText('meetingId is required');
      const notify = args.notifyRegistrants === true ? '?cancel_meeting_reminder=true' : '';
      const result = await zoomCall(
        auth,
        zoomScopeFor('zoom_delete_meeting'),
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
      const from =
        str(args.from) || new Date(Date.now() - 30 * 24 * 3600 * 1000).toISOString().slice(0, 10);
      const to = str(args.to) || new Date().toISOString().slice(0, 10);
      const max = typeof args.max === 'number' ? args.max : 20;
      const result = await zoomGet(
        auth,
        zoomScopeFor('zoom_list_recordings'),
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
      const meetingId = str(args.meetingId);
      if (!meetingId) return errText('meetingId is required');
      // ZoomClient has no injectable transport — see this file's header.
      const access = await resolveZoomAccess(context);
      if (typeof access === 'string') return errText(access);

      const client = new ZoomClient(access.accessToken, { lane: 'interactive' });
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
      const meetingId = str(args.meetingId);
      if (!meetingId) return errText('meetingId is required');
      // ZoomClient has no injectable transport — see this file's header.
      const access = await resolveZoomAccess(context);
      if (typeof access === 'string') return errText(access);

      // The summary endpoint 400s on numeric ids ("Invalid meeting id") —
      // it wants the occurrence UUID. Best-effort resolution; a failed
      // lookup falls through with the raw id and lets Zoom's error name
      // itself.
      let summaryKey = meetingId;
      if (/^\d+$/.test(meetingId)) {
        const uuid = await tryResolveMeetingUuid(access.accessToken, meetingId);
        if (uuid) summaryKey = uuid;
      }

      const client = new ZoomClient(access.accessToken, { lane: 'interactive' });
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
      // The cross-meeting listing lives in the Canvas Search API — the
      // My Notes API itself can only list per meeting.
      const result = await zoomCall(auth, zoomScopeFor('zoom_search_notes'), '/docs/file_search', {
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
      const meetingId = str(args.meetingId);
      if (!meetingId) return errText('meetingId is required');
      const result = await zoomGet(
        auth,
        zoomScopeFor('zoom_list_notes'),
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
      const noteId = str(args.noteId);
      if (!noteId) return errText('noteId is required');
      const include = args.includeTranscript === true ? '?include=transcript' : '';
      const result = await zoomGet(
        auth,
        zoomScopeFor('zoom_get_note'),
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
    'zoom_bulk_get_notes',
    {
      title: 'Zoom · Read — Get many My Notes notes in one call',
      description:
        'The content of up to 50 My Notes notes in a single call — use this instead of one ' +
        'zoom_get_note per note whenever a request covers several meetings’ notes. Zoom’s API ' +
        'has no batch endpoint, so this tool fans the fetches out server-side. Per-note content ' +
        'is capped; pull an individual note with zoom_get_note (which can also include the ' +
        'transcript) when the full text of one matters.',
      annotations: { readOnlyHint: true },
      inputSchema: z.object({
        noteIds: z
          .array(z.string().min(1))
          .min(1)
          .max(50)
          .describe('Note ids from zoom_list_notes or zoom_search_notes'),
      }),
    },
    async (args: Record<string, any>) => {
      const noteIds: string[] = Array.isArray(args.noteIds)
        ? args.noteIds.filter((id: unknown): id is string => typeof id === 'string' && id !== '')
        : [];
      if (noteIds.length === 0) return errText('noteIds is required');
      const unique = [...new Set(noteIds)].slice(0, 50);

      // Zoom rate-limits per app; a bounded window keeps 50 notes polite
      // while still finishing in a few round trips.
      const CONCURRENCY = 4;
      const PER_NOTE_MAX_CHARS = 8_000;
      const sections: string[] = new Array<string>(unique.length);
      let cursor = 0;
      const fetchOne = async (): Promise<void> => {
        for (;;) {
          const index = cursor;
          cursor += 1;
          if (index >= unique.length) return;
          const noteId = unique[index];
          const result = await zoomGet(
            auth,
            zoomScopeFor('zoom_bulk_get_notes'),
            `/my_notes/notes/${encodeURIComponent(noteId)}/content`
          );
          if (!result.ok) {
            sections[index] = `## ${noteId}\n(Could not fetch: ${result.error})`;
            continue;
          }
          const note = result.body;
          const parts = [
            `## ${str(note.note_name) || '(untitled note)'} — id: ${noteId}` +
              (str(note.note_url) ? `\n[Open in Zoom](${str(note.note_url)})` : ''),
          ];
          const manual = str(note.manual_note_content).trim();
          if (manual) parts.push(`### Your notes\n${clipChars(manual, PER_NOTE_MAX_CHARS)}`);
          const generated = str(note.generated_note_content).trim();
          if (generated) {
            parts.push(`### AI-generated notes\n${clipChars(generated, PER_NOTE_MAX_CHARS)}`);
          }
          if (!manual && !generated) parts.push('(The note has no content yet.)');
          sections[index] = parts.join('\n\n');
        }
      };
      await Promise.all(
        Array.from({ length: Math.min(CONCURRENCY, unique.length) }, () => fetchOne())
      );

      const failed = sections.filter((section) => section.includes('(Could not fetch:')).length;
      // Partial failure is a report; TOTAL failure (revoked scope, dead
      // credential) is an error the caller must see as one.
      if (failed === unique.length) {
        return errText(`None of the ${unique.length} note(s) could be fetched:\n\n${sections[0]}`);
      }
      return textResult(
        `${unique.length} note(s)${failed ? ` (${failed} could not be fetched)` : ''}:\n\n` +
          sections.join('\n\n---\n\n')
      );
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
      const fileId = str(args.fileId);
      if (!fileId) return errText('fileId is required');
      const result = await zoomGet(
        auth,
        zoomScopeFor('zoom_get_doc'),
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
      const result = await zoomCall(auth, zoomScopeFor('zoom_create_doc'), '/docs/import_content', {
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

      const result = await zoomCall(
        auth,
        zoomScopeFor('zoom_append_to_doc'),
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
