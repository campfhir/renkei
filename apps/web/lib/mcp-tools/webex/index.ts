/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * WebEx MCP tools over the caller's own user grant ("Renkei reads WebEx as
 * me") — the second WebEx integration, deliberately separate from the org
 * bot. The bot sees what spaces invite it to see; these tools see what the
 * connected user can see, because every call runs with that user's token.
 *
 * Read-and-capture only: list rooms, read messages, turn one into an
 * actionable item. Nothing here posts to WebEx as the user.
 *
 * The grant is resolved from the database on every call rather than baked
 * into the handler closure: tokens rotate on refresh, handlers are cached,
 * and a stale closure was exactly the failure mode the Jira tools solved
 * with a token-cache layer. Tool volume here is low enough to skip the
 * cache and read fresh.
 */

import { z } from 'zod';
import { randomUUID } from 'crypto';
import type { McpServer } from '@modelcontextprotocol/server';
import {
  getGrant,
  refreshGrantTokens,
  WEBEX_USER,
  WebexUserAdapter,
  type ProviderGrant,
} from '@renkei/provider-grants';
import { parseEncryptionKey } from '@renkei/crypto';
import { getDatabase } from '@renkei/db';
import { getWebexUserApp } from '@/lib/webex-app';
import { logger, secure } from '@/lib/logger';
import { withScopeGate } from '../capability-gate';
import type { MCPToolContext } from '../common';

export const WEBEX_USER_MCP_CONNECTOR = 'webex-user';

const API = 'https://webexapis.com/v1';
/** Refresh when the token is inside this window of expiry. */
const REFRESH_MARGIN_MS = 2 * 60 * 1000;

interface WebexAccess {
  accessToken: string;
  personEmail: string | null;
}

/** The caller's live WebEx token, refreshed through the adapter when stale. */
async function resolveWebexAccess(context: MCPToolContext): Promise<WebexAccess | string> {
  if (!context.subject) return 'No signed-in subject on this MCP session.';
  const keyResult = parseEncryptionKey(process.env.TOKEN_ENCRYPTION_KEY || '');
  if (!keyResult.ok) return 'Server misconfigured (encryption key).';
  const dbResult = getDatabase();
  if (!dbResult.ok) return 'Database unavailable.';

  const row = await dbResult.val
    .selectFrom('provider_grants')
    .select('provider_account_id')
    .where('tenant_id', '=', context.tenantId)
    .where('provider', '=', WEBEX_USER)
    .where('subject', '=', context.subject)
    .executeTakeFirst();
  if (!row) {
    return 'WebEx is not connected. Connect it on the Connectors page, then try again.';
  }

  const grantResult = await getGrant(
    WEBEX_USER,
    context.tenantId,
    row.provider_account_id,
    keyResult.val
  );
  if (!grantResult.ok || !grantResult.val) return 'Could not read the WebEx grant.';
  let grant: ProviderGrant = grantResult.val;

  if (new Date(grant.expiresAt).getTime() - Date.now() < REFRESH_MARGIN_MS) {
    const app = await getWebexUserApp(context.tenantId, context.origin ?? '');
    if (!app) return 'WebEx user integration is no longer configured.';
    const refreshed = await refreshGrantTokens(
      new WebexUserAdapter(app.clientSecret),
      context.tenantId,
      grant.accountId,
      keyResult.val,
      logger
    );
    if (!refreshed.ok) {
      return refreshed.err.type === 'GRANT_REVOKED'
        ? 'Your WebEx authorization was revoked. Reconnect it on the Connectors page.'
        : 'Could not refresh the WebEx token; try again shortly.';
    }
    grant = { ...grant, accessToken: refreshed.val.accessToken };
  }

  const personEmail =
    typeof grant.metadata.personEmail === 'string' ? grant.metadata.personEmail : null;
  return { accessToken: grant.accessToken, personEmail };
}

function describeStatus(status: number): string {
  if (status === 403) {
    return (
      'WebEx refused (403) — the grant likely lacks the needed scope. The org admin must select ' +
      'it on the Integration at developer.webex.com, then you disconnect and reconnect WebEx.'
    );
  }
  return `WebEx API answered ${status}`;
}

/** Who a failed WebEx call was for — every tool passes its MCPToolContext. */
interface WebexLogScope {
  tenantId: string;
  subject?: string;
}

async function webexRequest(
  scope: WebexLogScope,
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
    logger.warn('WebEx API unreachable', {
      component: 'webex/fetch',
      tenantId: scope.tenantId,
      subject: scope.subject,
      path,
      method: init?.method ?? 'GET',
    });
    return { ok: false, error: 'Could not reach webexapis.com' };
  }
  if (!response.ok) {
    // The full exchange, scoped to tenant and OIDC user — a status alone was
    // not enough to troubleshoot. The bearer never reaches the log.
    const responseBody = await response.text().catch(() => '');
    logger.warn('WebEx API non-OK response', {
      component: 'webex/fetch',
      tenantId: scope.tenantId,
      subject: scope.subject,
      path,
      method: init?.method ?? 'GET',
      status: response.status,
      // secure(): bodies can carry message content — console masks them, and
      // the Postgres adapter encrypts at rest once keys are configured.
      requestBody: body === undefined ? undefined : secure(truncateForLog(body)),
      responseBody: responseBody ? secure(truncateForLog(responseBody)) : undefined,
    });
    return { ok: false, error: describeStatus(response.status) };
  }
  return { ok: true, response };
}

/** Cap a logged body: enough to diagnose, bounded against megabyte payloads. */
function truncateForLog(text: string): string {
  // 1300, not more: secure() bodies encrypt to ~1.4x base64url, and values
  // past ~2KB fall into blob storage where the adapter does not decrypt on
  // read — 1300 keeps the ciphertext inline, so the viewer shows plaintext.
  return text.length > 1300 ? `${text.slice(0, 1300)}… (${text.length} chars total)` : text;
}

async function webexGet(
  scope: WebexLogScope,
  accessToken: string,
  path: string
): Promise<{ ok: true; body: Record<string, unknown> } | { ok: false; error: string }> {
  const result = await webexRequest(scope, accessToken, path);
  if (!result.ok) return result;
  const body: unknown = await result.response.json().catch(() => null);
  if (typeof body !== 'object' || body === null) {
    return { ok: false, error: 'Malformed WebEx API response' };
  }
  // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
  return { ok: true, body: body as Record<string, unknown> };
}

function items(body: Record<string, unknown>): Record<string, unknown>[] {
  return Array.isArray(body.items)
    ? body.items.filter(
        (item): item is Record<string, unknown> => typeof item === 'object' && item !== null
      )
    : [];
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

function messageLine(message: Record<string, unknown>): string {
  const text = str(message.text) || '(no text — possibly a card or attachment)';
  return `[${str(message.created)}] ${str(message.personEmail)} (${str(message.id)}):\n  ${text.replace(/\n/g, '\n  ')}`;
}

/** Which WebEx scope each tool stands on; registration filters against the grant. */
function webexScopeFor(toolName: string): string[] {
  switch (toolName) {
    case 'webex_send_message':
      return ['spark:messages_write'];
    case 'webex_list_meetings':
      return ['meeting:schedules_read'];
    case 'webex_list_transcripts':
    case 'webex_get_transcript':
      return ['meeting:transcripts_read'];
    case 'webex_list_recordings':
      return ['meeting:recordings_read'];
    case 'webex_list_rooms':
      return ['spark:rooms_read'];
    default:
      // list/get/capture message tools
      return ['spark:messages_read'];
  }
}

export async function registerWebexUserTools(
  rawServer: McpServer,
  context: MCPToolContext
): Promise<void> {
  // A tool whose scope this user's grant does not carry is not registered at
  // all — the org may have narrowed the checkboxes, or the user connected
  // before a scope was added.
  const server = withScopeGate(rawServer, context.webexScopes, (name) => webexScopeFor(name));
  server.registerTool(
    'webex_list_rooms',
    {
      title: 'List WebEx rooms',
      description:
        'List the WebEx rooms (spaces) the connected user is a member of, most recently active ' +
        'first. Returns room ids for use with webex_list_messages.',
      annotations: { readOnlyHint: true },
      inputSchema: z.object({
        max: z.number().int().min(1).max(100).describe('How many rooms (default 30)').optional(),
      }),
    },
    async (args: Record<string, any>) => {
      const access = await resolveWebexAccess(context);
      if (typeof access === 'string') return errText(access);
      const max = typeof args.max === 'number' ? args.max : 30;
      const result = await webexGet(
        context,
        access.accessToken,
        `/rooms?max=${max}&sortBy=lastactivity`
      );
      if (!result.ok) return errText(result.error);
      const rooms = items(result.body).map(
        (room) =>
          `${str(room.title) || '(untitled)'} — ${str(room.type)} — id: ${str(room.id)}` +
          (str(room.lastActivity) ? ` — last activity ${str(room.lastActivity)}` : '')
      );
      return textResult(rooms.length === 0 ? 'No rooms.' : rooms.join('\n'));
    }
  );

  server.registerTool(
    'webex_list_messages',
    {
      title: 'List WebEx messages in a room',
      description:
        'Read recent messages in a room the connected user is a member of, newest first. ' +
        'Access is the user’s own — rooms they are not in cannot be read.',
      annotations: { readOnlyHint: true },
      inputSchema: z.object({
        roomId: z.string().min(1).describe('Room id from webex_list_rooms'),
        max: z.number().int().min(1).max(50).describe('How many messages (default 20)').optional(),
      }),
    },
    async (args: Record<string, any>) => {
      const access = await resolveWebexAccess(context);
      if (typeof access === 'string') return errText(access);
      const roomId = str(args.roomId);
      if (!roomId) return errText('roomId is required');
      const max = typeof args.max === 'number' ? args.max : 20;
      const result = await webexGet(
        context,
        access.accessToken,
        `/messages?roomId=${encodeURIComponent(roomId)}&max=${max}`
      );
      if (!result.ok) return errText(result.error);
      const lines = items(result.body).map(messageLine);
      return textResult(lines.length === 0 ? 'No messages.' : lines.join('\n\n'));
    }
  );

  server.registerTool(
    'webex_get_message',
    {
      title: 'Get one WebEx message',
      description: 'Fetch a single message by id, with its full text.',
      annotations: { readOnlyHint: true },
      inputSchema: z.object({
        messageId: z.string().min(1).describe('Message id'),
      }),
    },
    async (args: Record<string, any>) => {
      const access = await resolveWebexAccess(context);
      if (typeof access === 'string') return errText(access);
      const messageId = str(args.messageId);
      if (!messageId) return errText('messageId is required');
      const result = await webexGet(
        context,
        access.accessToken,
        `/messages/${encodeURIComponent(messageId)}`
      );
      if (!result.ok) return errText(result.error);
      return textResult(messageLine(result.body));
    }
  );

  server.registerTool(
    'webex_capture_message',
    {
      title: 'Capture a WebEx message into Renkei',
      description:
        'Turn a WebEx message into an actionable item on the Renkei card feed, where a human ' +
        'approves or dismisses it. Nothing is executed and nothing is posted to WebEx — this ' +
        'only records a suggestion.',
      // Writes to Renkei's own feed, never to the provider — but it is a
      // write, so no readOnlyHint: org read-only mode disables it.
      inputSchema: z.object({
        messageId: z.string().min(1).describe('Message id to capture'),
        note: z.string().describe('Why this was captured — shown alongside the card').optional(),
      }),
    },
    async (args: Record<string, any>) => {
      const access = await resolveWebexAccess(context);
      if (typeof access === 'string') return errText(access);
      const messageId = str(args.messageId);
      if (!messageId) return errText('messageId is required');

      const result = await webexGet(
        context,
        access.accessToken,
        `/messages/${encodeURIComponent(messageId)}`
      );
      if (!result.ok) return errText(result.error);
      const message = result.body;
      const text = str(message.text);
      if (!text) return errText('That message has no text to capture.');

      const dbResult = getDatabase();
      if (!dbResult.ok) return errText('Database unavailable.');

      const title = text.length > 120 ? `${text.slice(0, 117)}…` : text;
      const note = str(args.note);
      await dbResult.val
        .insertInto('actionable_items')
        .values({
          id: randomUUID(),
          tenant_id: context.tenantId,
          source: 'webex',
          title,
          summary: text,
          evidence: JSON.stringify({
            provider: 'webex',
            roomId: str(message.roomId),
            messageId: str(message.id),
            personEmail: str(message.personEmail),
            created: str(message.created),
            excerpt: text.slice(0, 500),
            capturedBy: access.personEmail ?? context.subject ?? 'unknown',
            ...(note ? { note } : {}),
          }),
          // The same shape the ambient pipeline writes, so the card's approve
          // flow (create_issue with a human-chosen project) works unchanged.
          suggested_action: JSON.stringify({
            tool: 'create_issue',
            args: { summary: title, description: text, issueType: 'Task' },
          }),
        })
        .execute();

      logger.info('webex_capture_message captured', {
        component: 'mcp/tool',
        tenantId: context.tenantId,
        messageId,
      });
      return textResult(`Captured. It is now on the card feed awaiting a human decision.`);
    }
  );

  server.registerTool(
    'webex_send_message',
    {
      title: 'Send a WebEx message',
      description:
        'Post a message as the connected user, to a room or a person — e.g. a summary of Jira ' +
        'tickets assembled with the Jira tools. Markdown supported. This speaks AS the user, so ' +
        'only send what they asked to send.',
      // The one acting tool: no readOnlyHint, so org read-only mode disables it.
      inputSchema: z.object({
        roomId: z.string().describe('Destination room id (from webex_list_rooms)').optional(),
        toPersonEmail: z
          .string()
          .describe('Recipient email for a 1:1 message instead of a room')
          .optional(),
        markdown: z.string().min(1).describe('Message body, WebEx markdown'),
        parentId: z.string().describe('Message id to reply to, threading under it').optional(),
      }),
    },
    async (args: Record<string, any>) => {
      const access = await resolveWebexAccess(context);
      if (typeof access === 'string') return errText(access);
      const roomId = str(args.roomId);
      const toPersonEmail = str(args.toPersonEmail);
      if (!roomId && !toPersonEmail) return errText('Provide roomId or toPersonEmail.');
      if (roomId && toPersonEmail) return errText('Provide roomId or toPersonEmail, not both.');

      const result = await webexRequest(context, access.accessToken, '/messages', {
        method: 'POST',
        json: {
          ...(roomId ? { roomId } : { toPersonEmail }),
          markdown: str(args.markdown),
          ...(str(args.parentId) ? { parentId: str(args.parentId) } : {}),
        },
      });
      if (!result.ok) return errText(result.error);
      const body: unknown = await result.response.json().catch(() => null);
      const sent =
        typeof body === 'object' && body !== null
          ? // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
            (body as Record<string, unknown>)
          : {};
      logger.info('webex_send_message sent', {
        component: 'mcp/tool',
        tenantId: context.tenantId,
        roomId: str(sent.roomId),
      });
      return textResult(`Sent (message id ${str(sent.id) || 'unknown'}).`);
    }
  );

  server.registerTool(
    'webex_list_meetings',
    {
      title: 'List WebEx meetings',
      description:
        'List the connected user’s meetings in a time window — scheduled or ended. Meeting ids ' +
        'feed webex_list_transcripts and webex_list_recordings.',
      annotations: { readOnlyHint: true },
      inputSchema: z.object({
        from: z.string().describe('ISO start of the window (default: 7 days ago)').optional(),
        to: z.string().describe('ISO end of the window (default: now)').optional(),
        max: z.number().int().min(1).max(100).describe('How many (default 20)').optional(),
      }),
    },
    async (args: Record<string, any>) => {
      const access = await resolveWebexAccess(context);
      if (typeof access === 'string') return errText(access);
      const from = str(args.from) || new Date(Date.now() - 7 * 24 * 3600 * 1000).toISOString();
      const to = str(args.to) || new Date().toISOString();
      const max = typeof args.max === 'number' ? args.max : 20;
      const query = `from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}&max=${max}&meetingType=meeting`;
      const result = await webexGet(context, access.accessToken, `/meetings?${query}`);
      if (!result.ok) return errText(result.error);
      const lines = items(result.body).map(
        (meeting) =>
          `${str(meeting.title) || '(untitled)'} — ${str(meeting.start)} → ${str(meeting.end)} — ` +
          `state: ${str(meeting.state)} — id: ${str(meeting.id)}`
      );
      return textResult(lines.length === 0 ? 'No meetings in that window.' : lines.join('\n'));
    }
  );

  server.registerTool(
    'webex_list_transcripts',
    {
      title: 'List WebEx meeting transcripts',
      description:
        'List transcripts of the connected user’s hosted meetings, optionally narrowed to one ' +
        'meeting. Transcript ids feed webex_get_transcript.',
      annotations: { readOnlyHint: true },
      inputSchema: z.object({
        meetingId: z.string().describe('Narrow to one meeting').optional(),
        from: z.string().describe('ISO start of the window').optional(),
        to: z.string().describe('ISO end of the window').optional(),
        max: z.number().int().min(1).max(100).describe('How many (default 20)').optional(),
      }),
    },
    async (args: Record<string, any>) => {
      const access = await resolveWebexAccess(context);
      if (typeof access === 'string') return errText(access);
      const parts = [`max=${typeof args.max === 'number' ? args.max : 20}`];
      if (str(args.meetingId)) parts.push(`meetingId=${encodeURIComponent(str(args.meetingId))}`);
      if (str(args.from)) parts.push(`from=${encodeURIComponent(str(args.from))}`);
      if (str(args.to)) parts.push(`to=${encodeURIComponent(str(args.to))}`);
      const result = await webexGet(
        context,
        access.accessToken,
        `/meetingTranscripts?${parts.join('&')}`
      );
      if (!result.ok) return errText(result.error);
      const lines = items(result.body).map(
        (transcript) =>
          `${str(transcript.meetingTopic) || '(no topic)'} — ${str(transcript.startTime)} — ` +
          `id: ${str(transcript.id)}`
      );
      return textResult(lines.length === 0 ? 'No transcripts.' : lines.join('\n'));
    }
  );

  server.registerTool(
    'webex_get_transcript',
    {
      title: 'Download a WebEx meeting transcript',
      description:
        'Fetch a transcript’s text by id — the raw material for "summarize that meeting and ' +
        'file/announce the outcomes".',
      annotations: { readOnlyHint: true },
      inputSchema: z.object({
        transcriptId: z.string().min(1).describe('Transcript id from webex_list_transcripts'),
      }),
    },
    async (args: Record<string, any>) => {
      const access = await resolveWebexAccess(context);
      if (typeof access === 'string') return errText(access);
      const transcriptId = str(args.transcriptId);
      if (!transcriptId) return errText('transcriptId is required');
      const result = await webexRequest(
        context,
        access.accessToken,
        `/meetingTranscripts/${encodeURIComponent(transcriptId)}/download?format=txt`
      );
      if (!result.ok) return errText(result.error);
      const content = await result.response.text().catch(() => '');
      if (!content) return errText('Transcript came back empty.');
      // A long meeting can be megabytes of text; cap what one tool call returns.
      const MAX = 80_000;
      const capped =
        content.length > MAX
          ? `${content.slice(0, MAX)}\n\n[…truncated: ${content.length - MAX} more characters]`
          : content;
      return textResult(capped);
    }
  );

  server.registerTool(
    'webex_list_recordings',
    {
      title: 'List WebEx meeting recordings',
      description:
        'List recordings of the connected user’s meetings, with playback links. Read-only; the ' +
        'links open in a browser.',
      annotations: { readOnlyHint: true },
      inputSchema: z.object({
        meetingId: z.string().describe('Narrow to one meeting').optional(),
        from: z.string().describe('ISO start of the window').optional(),
        to: z.string().describe('ISO end of the window').optional(),
        max: z.number().int().min(1).max(100).describe('How many (default 20)').optional(),
      }),
    },
    async (args: Record<string, any>) => {
      const access = await resolveWebexAccess(context);
      if (typeof access === 'string') return errText(access);
      const parts = [`max=${typeof args.max === 'number' ? args.max : 20}`];
      if (str(args.meetingId)) parts.push(`meetingId=${encodeURIComponent(str(args.meetingId))}`);
      if (str(args.from)) parts.push(`from=${encodeURIComponent(str(args.from))}`);
      if (str(args.to)) parts.push(`to=${encodeURIComponent(str(args.to))}`);
      const result = await webexGet(context, access.accessToken, `/recordings?${parts.join('&')}`);
      if (!result.ok) return errText(result.error);
      const lines = items(result.body).map(
        (recording) =>
          `${str(recording.topic) || '(no topic)'} — ${str(recording.createTime)} — ` +
          `${typeof recording.durationSeconds === 'number' ? `${Math.round(recording.durationSeconds / 60)} min — ` : ''}` +
          `${str(recording.playbackUrl) ? `[play](${str(recording.playbackUrl)})` : 'no playback link'} — id: ${str(recording.id)}`
      );
      return textResult(lines.length === 0 ? 'No recordings.' : lines.join('\n'));
    }
  );
}
