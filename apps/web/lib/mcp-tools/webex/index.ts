/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * WebEx MCP tools over the caller's own user grant ("Renkei reads WebEx as
 * me") — the second WebEx integration, deliberately separate from the org
 * bot. The bot sees what spaces invite it to see; these tools see what the
 * connected user can see, because every call runs with that user's token.
 *
 * How each call authenticates is an injected `WebexAuth` (see
 * webex-auth.ts), not something this file resolves itself. Production
 * always passes `oauthWebexAuth`; `webex.no-sandbox.test.ts` passes
 * `deniedWebexAuth` instead, since no WebEx sandbox exists yet to test
 * against for real — see that file and webex-auth.ts for why.
 *
 * Read-and-capture only: list rooms, read messages, turn one into an
 * actionable item. Nothing here posts to WebEx as the user except
 * webex_send_message, on explicit request.
 */

import { z } from 'zod';
import { randomUUID } from 'crypto';
import type { McpServer } from '@modelcontextprotocol/server';
import { getDatabase } from '@renkei/db';
import { logger } from '@/lib/logger';
import { actMeta } from '@renkei/tool-outcomes';
import { recordSentWebexMessage } from './sent-ledger';
import { withScopeGate } from '../capability-gate';
import { withPresentationHint, type MCPToolContext } from '../common';
import {
  APP_ONLY_META,
  CHAT_MESSAGE_URI,
  confirmGuard,
  previewToolMeta,
  newPreviewId,
} from '../widgets';
import { resolveWebexAccess, type WebexAuth } from './webex-auth';

export const WEBEX_USER_MCP_CONNECTOR = 'webex-user';

async function describeWebexFailure(response: Response): Promise<string> {
  // Reads the body's `message` field either way: a real WebEx error carries
  // one, and so does every synthetic Response WebexAuth.fetch() returns for
  // a local failure (no connection, missing scope) — one interpretation
  // path covers both, the same way describeOpsFailure does for JSM Ops.
  const body = await response.text().catch(() => '');
  let detail = '';
  try {
    const parsed: unknown = JSON.parse(body);
    if (typeof parsed === 'object' && parsed !== null) {
      // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
      detail = str((parsed as Record<string, unknown>).message);
    }
  } catch {
    detail = body.slice(0, 300);
  }
  let text = `WebEx API answered ${response.status}${detail ? `: ${detail}` : ''}.`;
  if (response.status === 403) {
    text +=
      ' If the grant is missing a scope, the org admin selects it on the Integration at ' +
      'developer.webex.com, then you disconnect and reconnect WebEx.';
  }
  return text;
}

/** GET a path and parse its JSON body, translating a non-OK response uniformly. */
async function webexGet(
  auth: WebexAuth,
  scopes: string[],
  path: string
): Promise<{ ok: true; body: Record<string, unknown> } | { ok: false; error: string }> {
  const response = await auth.fetch(scopes, path);
  if (!response.ok) return { ok: false, error: await describeWebexFailure(response) };
  const body: unknown = await response.json().catch(() => null);
  if (typeof body !== 'object' || body === null) {
    return { ok: false, error: 'Malformed WebEx API response' };
  }
  // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
  return { ok: true, body: body as Record<string, unknown> };
}

/** For callers that need the raw Response — a POST, or a non-JSON body like a transcript download. */
async function webexCall(
  auth: WebexAuth,
  scopes: string[],
  path: string,
  init?: { method?: string; json?: unknown }
): Promise<{ ok: true; response: Response } | { ok: false; error: string }> {
  const response = await auth.fetch(scopes, path, {
    method: init?.method ?? 'GET',
    ...(init?.json !== undefined ? { body: JSON.stringify(init.json) } : {}),
  });
  if (!response.ok) return { ok: false, error: await describeWebexFailure(response) };
  return { ok: true, response };
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
  // WebEx threads reply under the ROOT message's id, so a reply's parentId is
  // the one identifier that lets a caller answer in the same thread.
  const thread = str(message.parentId) ? ` — in thread ${str(message.parentId)}` : '';
  return `[${str(message.created)}] ${str(message.personEmail)} (${str(message.id)})${thread}:\n  ${text.replace(/\n/g, '\n  ')}`;
}

/** How the markdown field explains itself everywhere a message is composed. */
const MARKDOWN_HINT =
  'Message body, WebEx markdown. Tag a person with <@personEmail:their.email@org.com>; ' +
  '<@all> tags everyone in a group space.';

/** How the parentId field explains itself everywhere a message is composed. */
const PARENT_ID_HINT =
  'Thread root to reply under — the id in "in thread <id>" from webex_list_messages, or a ' +
  "top-level message's own id. Omitted = new top-level message.";

/** The title webex_note_to_self creates — and finds first on every later run. */
/**
 * A `webexteams://` deep link to a WebEx space — opens the native app
 * directly, never a browser tab landing on the generic web client shell —
 * from the API's room id.
 *
 * The id is base64 of a `ciscospark://…/ROOM/<uuid>` URI; that uuid is the
 * same one `webexteams://im?space=` takes. There is no documented deep
 * link for one message within a space — only `im?space=` (an existing
 * space) and `im?email=` (a 1:1) are — so this points at the space itself
 * rather than the exact message; add a `#…` (or equivalent) once WebEx
 * documents one. Null when the id doesn't decode to that shape — a receipt
 * with no link beats a link to the wrong place.
 */
function webexSpaceUrl(roomId: string): string | null {
  try {
    const decoded = Buffer.from(roomId, 'base64').toString('utf8');
    const match = /\/ROOM\/([0-9a-f-]{36})$/i.exec(decoded);
    return match ? `webexteams://im?space=${match[1]}` : null;
  } catch {
    return null;
  }
}

const NOTE_TO_SELF_TITLE = 'Note to Self';
/** Membership probes before concluding no solo space exists and creating one. */
const SOLO_PROBE_CAP = 20;

/**
 * WebEx cannot create a 1:1 room between an account and itself — POST
 * /messages with the caller's own email answers an opaque 400 "Failed to
 * create room", every time. Caught up front so the caller is redirected to
 * webex_note_to_self instead of burning the attempt.
 */
async function selfDmError(context: MCPToolContext, toPersonEmail: string): Promise<string | null> {
  const access = await resolveWebexAccess(context);
  // Identity unknown (unresolved grant, no recorded email): let WebEx answer.
  if (typeof access === 'string' || !access.personEmail) return null;
  if (access.personEmail.toLowerCase() !== toPersonEmail.trim().toLowerCase()) return null;
  return (
    'That address is your own WebEx account, and WebEx cannot deliver a 1:1 message to ' +
    'yourself. Use webex_note_to_self instead, or send to a space by roomId.'
  );
}

/** Which WebEx scope each tool stands on; used at both registration and call time. */
export function webexScopeFor(toolName: string): string[] {
  switch (toolName) {
    // The preview/confirm pair stands on the same scope as the send it gates.
    case 'webex_send_message':
    case 'webex_send_message_preview':
    case 'webex_send_message_confirm':
      return ['spark:messages_write'];
    // Reads rooms and their memberships to find a space holding only the
    // user, may create one, then posts — four scopes, all load-bearing.
    case 'webex_note_to_self':
      return [
        'spark:messages_write',
        'spark:rooms_read',
        'spark:rooms_write',
        'spark:memberships_read',
      ];
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
  context: MCPToolContext,
  auth: WebexAuth
): Promise<void> {
  // A tool whose scope this user's grant does not carry is not registered at
  // all — the org may have narrowed the checkboxes, or the user connected
  // before a scope was added.
  const server = withScopeGate(rawServer, context.webexScopes, (name) => webexScopeFor(name));
  server.registerTool(
    'webex_list_rooms',
    {
      title: 'WebEx · Read — List WebEx rooms',
      description:
        'List the WebEx rooms (spaces) the connected user is a member of, most recently active ' +
        'first. Returns room ids for use with webex_list_messages.',
      annotations: { readOnlyHint: true },
      inputSchema: z.object({
        max: z.number().int().min(1).max(100).describe('How many rooms (default 30)').optional(),
      }),
    },
    async (args: Record<string, any>) => {
      const max = typeof args.max === 'number' ? args.max : 30;
      const result = await webexGet(
        auth,
        webexScopeFor('webex_list_rooms'),
        `/rooms?max=${max}&sortBy=lastactivity`
      );
      if (!result.ok) return errText(result.error);
      const rooms = items(result.body).map(
        (room) =>
          `${str(room.title) || '(untitled)'} — ${str(room.type)} — id: ${str(room.id)}` +
          (str(room.lastActivity) ? ` — last activity ${str(room.lastActivity)}` : '')
      );
      if (rooms.length === 0) return textResult('No rooms.');
      return textResult(
        withPresentationHint(
          rooms.join('\n'),
          'a table (Room, Type, Last activity) usually scans faster than this flat list.'
        )
      );
    }
  );

  server.registerTool(
    'webex_list_messages',
    {
      title: 'WebEx · Read — List WebEx messages in a room',
      description:
        'Read recent messages in a room the connected user is a member of, newest first. ' +
        'Access is the user’s own — rooms they are not in cannot be read. Threaded replies ' +
        'are marked "in thread <id>"; pass that id as parentId to webex_send_message to ' +
        'answer in the same thread.',
      annotations: { readOnlyHint: true },
      inputSchema: z.object({
        roomId: z.string().min(1).describe('Room id from webex_list_rooms'),
        max: z.number().int().min(1).max(50).describe('How many messages (default 20)').optional(),
      }),
    },
    async (args: Record<string, any>) => {
      const roomId = str(args.roomId);
      if (!roomId) return errText('roomId is required');
      const max = typeof args.max === 'number' ? args.max : 20;
      const result = await webexGet(
        auth,
        webexScopeFor('webex_list_messages'),
        `/messages?roomId=${encodeURIComponent(roomId)}&max=${max}`
      );
      if (!result.ok) return errText(result.error);
      const lines = items(result.body).map(messageLine);
      if (lines.length === 0) return textResult('No messages.');
      return textResult(
        withPresentationHint(
          lines.join('\n\n'),
          'a chat-thread layout (grouped by sender, newest last) usually reads more naturally ' +
            'than this flat list.'
        )
      );
    }
  );

  server.registerTool(
    'webex_get_message',
    {
      title: 'WebEx · Read — Get one WebEx message',
      description: 'Fetch a single message by id, with its full text.',
      annotations: { readOnlyHint: true },
      inputSchema: z.object({
        messageId: z.string().min(1).describe('Message id'),
      }),
    },
    async (args: Record<string, any>) => {
      const messageId = str(args.messageId);
      if (!messageId) return errText('messageId is required');
      const result = await webexGet(
        auth,
        webexScopeFor('webex_get_message'),
        `/messages/${encodeURIComponent(messageId)}`
      );
      if (!result.ok) return errText(result.error);
      return textResult(messageLine(result.body));
    }
  );

  server.registerTool(
    'webex_capture_message',
    {
      title: 'WebEx · Act — Capture a WebEx message into Renkei',
      description:
        'Turn a WebEx message into an actionable item on the Renkei card feed, where a human ' +
        'approves or dismisses it. Nothing is executed and nothing is posted to WebEx — this ' +
        'only records a suggestion.',
      // Writes to Renkei's own feed, never to the provider — but it is a
      // write, so readOnlyHint is false: org read-only mode disables it.
      annotations: { readOnlyHint: false },
      inputSchema: z.object({
        messageId: z.string().min(1).describe('Message id to capture'),
        note: z.string().describe('Why this was captured — shown alongside the card').optional(),
      }),
    },
    async (args: Record<string, any>) => {
      const messageId = str(args.messageId);
      if (!messageId) return errText('messageId is required');

      const result = await webexGet(
        auth,
        webexScopeFor('webex_capture_message'),
        `/messages/${encodeURIComponent(messageId)}`
      );
      if (!result.ok) return errText(result.error);
      const message = result.body;
      const text = str(message.text);
      if (!text) return errText('That message has no text to capture.');

      const dbResult = getDatabase();
      if (!dbResult.ok) return errText('Database unavailable.');

      // Resolved separately from the auth wrapper's own call: `capturedBy`
      // wants the WebEx account's own email, which only resolveWebexAccess
      // exposes — WebexAuth.fetch() deliberately returns a bare Response,
      // with no side channel for it, so as not to leak WebEx-specific
      // metadata onto an interface every connector shares the same shape of.
      const access = await resolveWebexAccess(context);
      const personEmail = typeof access === 'string' ? null : access.personEmail;

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
            capturedBy: personEmail ?? context.subject ?? 'unknown',
            ...(note ? { note } : {}),
          }),
          // The same shape the ambient pipeline writes, so the card's approve
          // flow (jira_create_issue with a human-chosen project) works unchanged.
          suggested_action: JSON.stringify({
            tool: 'jira_create_issue',
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
      title: 'WebEx · Act — Send a WebEx message',
      description:
        'Post a message as the connected user, to a room or a person — e.g. a summary of Jira ' +
        'tickets assembled with the Jira tools. Markdown supported, including mentions; pass ' +
        'parentId to reply inside an existing thread. This speaks AS the user, so only send ' +
        'what they asked to send. To message the user themself, use webex_note_to_self — ' +
        'WebEx rejects a 1:1 to your own address.',
      // The one acting tool: readOnlyHint false, so org read-only mode disables it.
      annotations: { readOnlyHint: false },
      inputSchema: z.object({
        roomId: z.string().describe('Destination room id (from webex_list_rooms)').optional(),
        toPersonEmail: z
          .string()
          .describe('Recipient email for a 1:1 message instead of a room')
          .optional(),
        markdown: z.string().min(1).describe(MARKDOWN_HINT),
        parentId: z.string().describe(PARENT_ID_HINT).optional(),
      }),
    },
    async (args: Record<string, any>) => {
      const roomId = str(args.roomId);
      const toPersonEmail = str(args.toPersonEmail);
      if (!roomId && !toPersonEmail) return errText('Provide roomId or toPersonEmail.');
      if (roomId && toPersonEmail) return errText('Provide roomId or toPersonEmail, not both.');
      if (toPersonEmail) {
        const refusal = await selfDmError(context, toPersonEmail);
        if (refusal) return errText(refusal);
      }

      const result = await webexCall(auth, webexScopeFor('webex_send_message'), '/messages', {
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
      // Recorded BEFORE the tool answers, so the ledger row is in place well
      // ahead of the webhook round-trip that will ask about it.
      await recordSentWebexMessage(context.tenantId, str(sent.id), context.accountId);
      logger.info('webex_send_message sent', {
        component: 'mcp/tool',
        tenantId: context.tenantId,
        roomId: str(sent.roomId),
      });
      // Room id included so a 1:1 send's room is addressable afterward —
      // follow-ups and thread replies need it, and only this response has it.
      const sentRoomUrl = str(sent.roomId) ? webexSpaceUrl(str(sent.roomId)) : null;
      return {
        content: [
          {
            type: 'text' as const,
            text:
              `Sent (message id ${str(sent.id) || 'unknown'}` +
              `${str(sent.roomId) ? `, room ${str(sent.roomId)}` : ''}).`,
          },
        ],
        // The receipt gives the owner's "Posted a WebEx message"
        // notification a link to the space it landed in. No id: a base64
        // message id in a headline is noise, not a name.
        ...(sentRoomUrl ? { _meta: actMeta({ url: sentRoomUrl }) } : {}),
      };
    }
  );

  server.registerTool(
    'webex_note_to_self',
    {
      title: 'WebEx · Act — Send yourself a note',
      description:
        'Post a message to the connected user’s private note-to-self space — reminders, ' +
        'digests, focus lists addressed to the user themself. WebEx cannot deliver a 1:1 ' +
        'message to your own address, so this is THE way to WebEx yourself: it finds a space ' +
        'containing only the user (creating one titled "Note to Self" if none exists) and ' +
        'posts there. Markdown supported.',
      annotations: { readOnlyHint: false },
      inputSchema: z.object({
        markdown: z.string().min(1).describe('Note body, WebEx markdown'),
      }),
    },
    async (args: Record<string, any>) => {
      const markdown = str(args.markdown);
      if (!markdown) return errText('markdown is required');
      const scopes = webexScopeFor('webex_note_to_self');

      // Only group rooms can hold a single person — a direct room always has
      // two. Title matches are probed first, so the space this tool creates
      // is found on the first probe of every later run; the cap bounds only
      // the first-ever scan of a member-heavy account.
      const roomsResult = await webexGet(
        auth,
        scopes,
        '/rooms?max=100&type=group&sortBy=lastactivity'
      );
      if (!roomsResult.ok) return errText(roomsResult.error);
      const rooms = items(roomsResult.body);
      const titled = (room: Record<string, unknown>) =>
        str(room.title).trim().toLowerCase() === NOTE_TO_SELF_TITLE.toLowerCase();
      const candidates = [...rooms.filter(titled), ...rooms.filter((room) => !titled(room))];

      let roomId = '';
      let roomTitle = '';
      for (const room of candidates.slice(0, SOLO_PROBE_CAP)) {
        const id = str(room.id);
        if (!id) continue;
        const membership = await webexGet(
          auth,
          scopes,
          `/memberships?roomId=${encodeURIComponent(id)}&max=2`
        );
        if (!membership.ok) return errText(membership.error);
        if (items(membership.body).length === 1) {
          roomId = id;
          roomTitle = str(room.title);
          break;
        }
      }

      let created = false;
      if (!roomId) {
        const createResult = await webexCall(auth, scopes, '/rooms', {
          method: 'POST',
          json: { title: NOTE_TO_SELF_TITLE },
        });
        if (!createResult.ok) return errText(createResult.error);
        const createdBody: unknown = await createResult.response.json().catch(() => null);
        roomId =
          typeof createdBody === 'object' && createdBody !== null
            ? // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
              str((createdBody as Record<string, unknown>).id)
            : '';
        if (!roomId) return errText('WebEx did not return an id for the created space.');
        roomTitle = NOTE_TO_SELF_TITLE;
        created = true;
      }

      const sendResult = await webexCall(auth, scopes, '/messages', {
        method: 'POST',
        json: { roomId, markdown },
      });
      if (!sendResult.ok) return errText(sendResult.error);
      const sentBody: unknown = await sendResult.response.json().catch(() => null);
      const sent =
        typeof sentBody === 'object' && sentBody !== null
          ? // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
            (sentBody as Record<string, unknown>)
          : {};
      await recordSentWebexMessage(context.tenantId, str(sent.id), context.accountId);
      logger.info('webex_note_to_self sent', {
        component: 'mcp/tool',
        tenantId: context.tenantId,
        roomId,
        created,
      });
      const noteRoomUrl = webexSpaceUrl(roomId);
      return {
        content: [
          {
            type: 'text' as const,
            text: `Sent to ${
              created
                ? `a newly created "${NOTE_TO_SELF_TITLE}" space`
                : `"${roomTitle || NOTE_TO_SELF_TITLE}"`
            } (room ${roomId}, message id ${str(sent.id) || 'unknown'}).`,
          },
        ],
        // The receipt gives the owner's "Left you a WebEx note"
        // notification a link straight to the note-to-self space.
        ...(noteRoomUrl ? { _meta: actMeta({ url: noteRoomUrl }) } : {}),
      };
    }
  );

  // ——— Interactive preview (MCP Apps) ————————————————————————————————
  // WebEx has no draft concept, so unlike the Outlook previews nothing is
  // created server-side: the preview resolves the destination to something a
  // human recognizes (a room title rather than an opaque id) and the card
  // holds the message until its Send button runs the confirm tool below.

  server.registerTool(
    'webex_send_message_preview',
    {
      title: 'WebEx · Act — Preview a message before sending',
      description:
        'Show the user an interactive preview card of a WebEx message to send or cancel. ' +
        'Prefer this over webex_send_message whenever the user should review first — the ' +
        'card does the sending; after calling this do not send the message another way and ' +
        'do not repeat its contents in your reply. This speaks AS the user.',
      annotations: { readOnlyHint: false },
      _meta: previewToolMeta(CHAT_MESSAGE_URI),
      inputSchema: z.object({
        roomId: z.string().describe('Destination room id (from webex_list_rooms)').optional(),
        toPersonEmail: z
          .string()
          .describe('Recipient email for a 1:1 message instead of a room')
          .optional(),
        markdown: z.string().min(1).describe(MARKDOWN_HINT),
        parentId: z.string().describe(PARENT_ID_HINT).optional(),
      }),
    },
    async (args: Record<string, any>) => {
      const roomId = str(args.roomId);
      const toPersonEmail = str(args.toPersonEmail);
      if (!roomId && !toPersonEmail) return errText('Provide roomId or toPersonEmail.');
      if (roomId && toPersonEmail) return errText('Provide roomId or toPersonEmail, not both.');
      if (toPersonEmail) {
        const refusal = await selfDmError(context, toPersonEmail);
        if (refusal) return errText(refusal);
      }
      const markdown = str(args.markdown);
      if (!markdown) return errText('markdown is required');

      // Best-effort: the card should say "Renkei team" rather than a base64
      // room id. A grant without rooms_read (or a stale id) falls back to
      // the id — the preview still works, it just reads worse.
      let roomTitle = '';
      if (roomId) {
        const room = await webexGet(
          auth,
          webexScopeFor('webex_list_rooms'),
          `/rooms/${encodeURIComponent(roomId)}`
        );
        if (room.ok) roomTitle = str(room.body.title);
      }

      const destination = roomId ? roomTitle || `room ${roomId}` : toPersonEmail;
      return {
        ...textResult(
          `The message to ${destination} is awaiting the user's decision on the preview card. ` +
            `Do not send it another way and do not repeat its contents in your reply; the user ` +
            `sends or cancels from the card. If no card appeared in this client, ask the user ` +
            `whether to send it with webex_send_message instead.`
        ),
        structuredContent: {
          previewId: newPreviewId(),
          kind: 'webex',
          ...(roomId ? { roomId, ...(roomTitle ? { roomTitle } : {}) } : { toPersonEmail }),
          markdown,
          ...(str(args.parentId) ? { parentId: str(args.parentId) } : {}),
        },
      };
    }
  );

  server.registerTool(
    'webex_send_message_confirm',
    {
      title: 'WebEx · Act — Send a previewed message (card only)',
      description:
        'Post a WebEx message the user approved on a preview card.' +
        confirmGuard('webex_send_message_preview'),
      annotations: { readOnlyHint: false },
      _meta: APP_ONLY_META,
      inputSchema: z.object({
        roomId: z.string().describe('Destination room id').optional(),
        toPersonEmail: z.string().describe('Recipient email for a 1:1 message').optional(),
        markdown: z.string().min(1).describe(MARKDOWN_HINT),
        parentId: z.string().describe(PARENT_ID_HINT).optional(),
      }),
    },
    async (args: Record<string, any>) => {
      const roomId = str(args.roomId);
      const toPersonEmail = str(args.toPersonEmail);
      if (!roomId && !toPersonEmail) return errText('Provide roomId or toPersonEmail.');
      if (roomId && toPersonEmail) return errText('Provide roomId or toPersonEmail, not both.');
      if (toPersonEmail) {
        const refusal = await selfDmError(context, toPersonEmail);
        if (refusal) return errText(refusal);
      }

      const result = await webexCall(auth, webexScopeFor('webex_send_message'), '/messages', {
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
      await recordSentWebexMessage(context.tenantId, str(sent.id), context.accountId);
      logger.info('webex_send_message_confirm sent', {
        component: 'mcp/tool',
        tenantId: context.tenantId,
        roomId: str(sent.roomId),
      });
      return textResult(
        `Sent (message id ${str(sent.id) || 'unknown'}` +
          `${str(sent.roomId) ? `, room ${str(sent.roomId)}` : ''}).`
      );
    }
  );

  server.registerTool(
    'webex_list_meetings',
    {
      title: 'WebEx · Read — List WebEx meetings',
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
      const from = str(args.from) || new Date(Date.now() - 7 * 24 * 3600 * 1000).toISOString();
      const to = str(args.to) || new Date().toISOString();
      const max = typeof args.max === 'number' ? args.max : 20;
      const query = `from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}&max=${max}&meetingType=meeting`;
      const result = await webexGet(
        auth,
        webexScopeFor('webex_list_meetings'),
        `/meetings?${query}`
      );
      if (!result.ok) return errText(result.error);
      const lines = items(result.body).map(
        (meeting) =>
          `${str(meeting.title) || '(untitled)'} — ${str(meeting.start)} → ${str(meeting.end)} — ` +
          `state: ${str(meeting.state)} — id: ${str(meeting.id)}`
      );
      if (lines.length === 0) return textResult('No meetings in that window.');
      return textResult(
        withPresentationHint(
          lines.join('\n'),
          'a calendar-style day-by-day agenda, or a table of day/time/title/state, usually reads ' +
            'clearer than this flat list.'
        )
      );
    }
  );

  server.registerTool(
    'webex_list_transcripts',
    {
      title: 'WebEx · Read — List WebEx meeting transcripts',
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
      const parts = [`max=${typeof args.max === 'number' ? args.max : 20}`];
      if (str(args.meetingId)) parts.push(`meetingId=${encodeURIComponent(str(args.meetingId))}`);
      if (str(args.from)) parts.push(`from=${encodeURIComponent(str(args.from))}`);
      if (str(args.to)) parts.push(`to=${encodeURIComponent(str(args.to))}`);
      const result = await webexGet(
        auth,
        webexScopeFor('webex_list_transcripts'),
        `/meetingTranscripts?${parts.join('&')}`
      );
      if (!result.ok) return errText(result.error);
      const lines = items(result.body).map(
        (transcript) =>
          `${str(transcript.meetingTopic) || '(no topic)'} — ${str(transcript.startTime)} — ` +
          `id: ${str(transcript.id)}`
      );
      if (lines.length === 0) return textResult('No transcripts.');
      return textResult(
        withPresentationHint(
          lines.join('\n'),
          'a table (Meeting, Date, id) usually scans faster than this flat list.'
        )
      );
    }
  );

  server.registerTool(
    'webex_get_transcript',
    {
      title: 'WebEx · Read — Download a WebEx meeting transcript',
      description:
        'Fetch a transcript’s text by id — the raw material for "summarize that meeting and ' +
        'file/announce the outcomes".',
      annotations: { readOnlyHint: true },
      inputSchema: z.object({
        transcriptId: z.string().min(1).describe('Transcript id from webex_list_transcripts'),
      }),
    },
    async (args: Record<string, any>) => {
      const transcriptId = str(args.transcriptId);
      if (!transcriptId) return errText('transcriptId is required');
      const result = await webexCall(
        auth,
        webexScopeFor('webex_get_transcript'),
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
      title: 'WebEx · Read — List WebEx meeting recordings',
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
      const parts = [`max=${typeof args.max === 'number' ? args.max : 20}`];
      if (str(args.meetingId)) parts.push(`meetingId=${encodeURIComponent(str(args.meetingId))}`);
      if (str(args.from)) parts.push(`from=${encodeURIComponent(str(args.from))}`);
      if (str(args.to)) parts.push(`to=${encodeURIComponent(str(args.to))}`);
      const result = await webexGet(
        auth,
        webexScopeFor('webex_list_recordings'),
        `/recordings?${parts.join('&')}`
      );
      if (!result.ok) return errText(result.error);
      const lines = items(result.body).map(
        (recording) =>
          `${str(recording.topic) || '(no topic)'} — ${str(recording.createTime)} — ` +
          `${typeof recording.durationSeconds === 'number' ? `${Math.round(recording.durationSeconds / 60)} min — ` : ''}` +
          `${str(recording.playbackUrl) ? `[play](${str(recording.playbackUrl)})` : 'no playback link'} — id: ${str(recording.id)}`
      );
      if (lines.length === 0) return textResult('No recordings.');
      return textResult(
        withPresentationHint(
          lines.join('\n'),
          'a table (Meeting, Date, Duration, Play link) usually scans faster than this flat list.'
        )
      );
    }
  );
}
