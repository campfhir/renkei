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
import { logger } from '@/lib/logger';
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

async function webexGet(
  accessToken: string,
  path: string
): Promise<{ ok: true; body: Record<string, unknown> } | { ok: false; error: string }> {
  let response: Response;
  try {
    response = await fetch(`${API}${path}`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
  } catch {
    return { ok: false, error: 'Could not reach webexapis.com' };
  }
  if (!response.ok) {
    return { ok: false, error: `WebEx API answered ${response.status}` };
  }
  const body: unknown = await response.json().catch(() => null);
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

export async function registerWebexUserTools(
  server: McpServer,
  context: MCPToolContext
): Promise<void> {
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
      const result = await webexGet(access.accessToken, `/rooms?max=${max}&sortBy=lastactivity`);
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

      logger.info('[Tool] webex_capture_message captured', {
        tenantId: context.tenantId,
        messageId,
      });
      return textResult(`Captured. It is now on the card feed awaiting a human decision.`);
    }
  );
}
