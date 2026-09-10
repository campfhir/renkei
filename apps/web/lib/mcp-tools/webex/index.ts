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
 * actionable item, stage a message's attachments in the caller's sandbox
 * scratch space. Nothing here posts to WebEx as the user except
 * webex_send_message, on explicit request.
 */

import { z } from 'zod';
import { randomUUID } from 'crypto';
import type { McpServer } from '@modelcontextprotocol/server';
import { getDatabase } from '@renkei/db';
import { DEFAULT_MAX_FILE_BYTES, validateFilename } from '@renkei/connector-sandbox';
import { logger } from '@/lib/logger';
import { actMeta } from '@renkei/tool-outcomes';
import { clientFailure, sandboxConfig, sbWriteFile } from '@/lib/sandbox/service-client';
import { recordSentWebexMessage } from './sent-ledger';
import { withScopeGate } from '../capability-gate';
import { withPresentationHint, type MCPToolContext } from '../common';
import { fileLine } from '../sandbox/shared';
import {
  APP_ONLY_META,
  CHAT_MESSAGE_URI,
  confirmGuard,
  previewToolMeta,
  newPreviewId,
} from '../widgets';
import { resolveWebexAccess, type WebexAuth } from './webex-auth';

/**
 * The capability key the WebEx user tools register under. 'webex' — the same
 * key the connector catalog, the org's disabledConnectors and usage rows
 * (connectorKeyForTool) use. It was 'webex-user' (the CONFIG key) for a
 * while, which made the admin off switch a no-op: the switch wrote 'webex'
 * and the gate looked for 'webex-user'.
 */
export const WEBEX_USER_MCP_CONNECTOR = 'webex';

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

/** The content URLs a message carries — WebEx's `files` array, strings only. */
function messageFiles(message: Record<string, unknown>): string[] {
  return Array.isArray(message.files)
    ? message.files.filter((file): file is string => typeof file === 'string' && file !== '')
    : [];
}

function messageLine(message: Record<string, unknown>): string {
  const files = messageFiles(message);
  const text =
    str(message.text) || (files.length ? '(no text)' : '(no text — possibly a card or attachment)');
  // WebEx threads reply under the ROOT message's id, so a reply's parentId is
  // the one identifier that lets a caller answer in the same thread.
  const thread = str(message.parentId) ? ` — in thread ${str(message.parentId)}` : '';
  // The URLs are opaque (no filename until fetched), but their presence is
  // what tells a reader to reach for webex_download_attachments; listing
  // them also gives fileUrl something exact to name.
  const attachments = files.length
    ? `\n  attachments (${files.length}, stage with webex_download_attachments): ${files.join(', ')}`
    : '';
  return `[${str(message.created)}] ${str(message.personEmail)} (${str(message.id)})${thread}:\n  ${text.replace(/\n/g, '\n  ')}${attachments}`;
}

/**
 * The API path behind a message's content URL, when it IS one. WebEx hands
 * attachments out as `https://webexapis.com/v1/contents/<id>`; the token
 * only ever goes to that host and that endpoint — a `files` entry pointing
 * anywhere else (a malformed message, a spoofed webhook replay) is refused
 * rather than fetched with the user's bearer token attached. Null for
 * anything that isn't exactly that shape.
 */
export function contentPathOf(fileUrl: string): string | null {
  let url: URL;
  try {
    url = new URL(fileUrl);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' || url.hostname.toLowerCase() !== 'webexapis.com') return null;
  const match = /^\/v1\/contents\/([^/]+)$/.exec(url.pathname);
  return match ? `/contents/${match[1]}` : null;
}

/**
 * The filename a `Content-Disposition` header names, RFC 5987 form first
 * (`filename*=UTF-8''…`, the one that survives non-ASCII), then the plain
 * quoted or bare `filename=`. Empty when the header names none.
 */
export function filenameOfDisposition(header: string | null): string {
  if (!header) return '';
  const extended = /filename\*\s*=\s*(?:UTF-8|utf-8)?'[^']*'([^;]+)/.exec(header);
  if (extended) {
    try {
      return decodeURIComponent(extended[1].trim());
    } catch {
      // Fall through to the plain form.
    }
  }
  const plain = /filename\s*=\s*(?:"((?:[^"\\]|\\.)*)"|([^;]+))/.exec(header);
  if (!plain) return '';
  return (plain[1] !== undefined ? plain[1].replace(/\\(.)/g, '$1') : plain[2]).trim();
}

/**
 * A name the scratch space accepts: what the header said when that is
 * usable, else `attachment-<n>` with the extension a media type implies.
 * Path separators are replaced rather than refused — the name is only a
 * label here; the worker validates it again.
 */
function stagedFilename(disposition: string | null, contentType: string, ordinal: number): string {
  const named = filenameOfDisposition(disposition).replace(/[/\\\0]/g, '_');
  const valid = validateFilename(named);
  if (valid.ok) return valid.filename;
  const extension =
    {
      'application/pdf': '.pdf',
      'image/png': '.png',
      'image/jpeg': '.jpg',
      'image/gif': '.gif',
      'text/plain': '.txt',
      'text/csv': '.csv',
    }[contentType] ?? '';
  return `attachment-${ordinal}${extension}`;
}

/** How the markdown field explains itself everywhere a message is composed. */
const MARKDOWN_HINT =
  'Message body, WebEx markdown. Tag a person with <@personEmail:their.email@org.com>; ' +
  '<@all> tags everyone in a group space.';

/** How the parentId field explains itself everywhere a message is composed. */
const PARENT_ID_HINT =
  'Thread root to reply under — the id in "in thread <id>" from webex_list_messages, or a ' +
  "top-level message's own id. Omitted = new top-level message.";

/** How the since field explains itself on both message-listing tools. */
const SINCE_HINT =
  'Only messages created at or after this ISO 8601 timestamp, e.g. 2026-09-08T00:00:00Z. ' +
  'WebEx cannot filter by this itself, so the tool walks the room newest-first and stops at ' +
  'the start of the window; limit caps how many come back and keep picks which end of the ' +
  'window survives when it holds more.';

/** How the keep field explains itself on both message-listing tools. */
const KEEP_HINT =
  'Which end of the since window survives when it holds more than limit: "newest" (default) ' +
  'reads only as far as limit needs; "oldest" first walks back to since, then keeps the ' +
  'earliest — more calls, so only ask for it when the start of the window matters. Needs since.';

/** Messages one webex_list_messages / webex_bulk_list_messages call returns per room, at most. */
const ROOM_LIMIT_CAP = 200;
/** Messages one webex_bulk_list_messages call may return across all its rooms, at most. */
const BULK_MESSAGES_CAP = 600;
/** Messages per page while walking a room back; WebEx's own ceiling for /messages. */
const WALK_PAGE_SIZE = 100;
/** Pages one walk may read before giving up on reaching the window's start. */
const WALK_PAGE_CAP = 10;

/**
 * Parses the optional `since` argument. Absent → null (no window); present
 * but not a date → an error string for the caller, since a silently ignored
 * window would return messages the caller explicitly asked not to see.
 */
function parseSince(value: unknown): number | null | { error: string } {
  if (value === undefined || value === null || value === '') return null;
  const ms = typeof value === 'string' ? Date.parse(value) : NaN;
  return Number.isNaN(ms)
    ? { error: 'since must be an ISO 8601 timestamp, e.g. 2026-09-08T00:00:00Z' }
    : ms;
}

type Keep = 'newest' | 'oldest';

/** What both message-listing tools take, parsed once and shared by every room they read. */
interface WindowArgs {
  limit: number;
  sinceMs: number | null;
  since: string;
  keep: Keep;
}

/**
 * The listing arguments common to webex_list_messages and
 * webex_bulk_list_messages, validated the same way in both: a `since` that
 * is not a date, or `keep: "oldest"` with no `since` (which would mean
 * walking the room's entire history to find its oldest messages) are
 * errors the caller must see, not filters silently dropped.
 */
function parseWindowArgs(args: Record<string, any>): WindowArgs | { error: string } {
  const limit = typeof args.limit === 'number' ? args.limit : 20;
  const since = parseSince(args.since);
  if (typeof since === 'object' && since !== null) return since;
  const keep: Keep = args.keep === 'oldest' ? 'oldest' : 'newest';
  if (keep === 'oldest' && since === null) {
    return {
      error:
        'keep: "oldest" needs since — without a window start, the oldest messages would mean ' +
        "walking the room's whole history.",
    };
  }
  return { limit, sinceMs: since, since: str(args.since), keep };
}

interface WindowRead {
  /** Newest first, at most `limit` of them. */
  messages: Record<string, unknown>[];
  /** The window holds more than `limit` — the other end was cut. */
  more: boolean;
  /** The walk gave up before reaching the window's start — the earliest shown may not be the earliest. */
  unreached: boolean;
}

/**
 * Reads one room's messages within the window, walking back page by page
 * with `beforeMessage` — WebEx's /messages takes `before` but has no
 * `since`, so the window's start is found by reading until a message
 * falls before it.
 *
 * `keep: "newest"` stops as soon as `limit` messages are in hand: with
 * no `since` and a limit within one page that is the single call it
 * always was. `keep: "oldest"` has to reach the start of the window
 * before it knows which messages are the earliest, so it walks the whole
 * window (up to WALK_PAGE_CAP pages) and then keeps the last `limit`.
 * A message whose created stamp does not parse is kept: dropping it
 * would hide it for a reason unrelated to the window.
 */
async function readWindow(
  auth: WebexAuth,
  scopes: string[],
  roomId: string,
  window: WindowArgs
): Promise<{ ok: true; value: WindowRead } | { ok: false; error: string }> {
  const { limit, sinceMs, keep } = window;
  const pageSize = keep === 'oldest' ? WALK_PAGE_SIZE : Math.min(limit, WALK_PAGE_SIZE);
  const collected: Record<string, unknown>[] = [];
  let before: string | null = null;
  let pages = 0;
  // True once the room has no more messages inside the window: either it
  // ran out, or a message before `since` was reached.
  let exhausted = false;
  while (pages < WALK_PAGE_CAP && !(keep === 'newest' && collected.length >= limit)) {
    const cursor = before ? `&beforeMessage=${encodeURIComponent(before)}` : '';
    const result = await webexGet(
      auth,
      scopes,
      `/messages?roomId=${encodeURIComponent(roomId)}&max=${pageSize}${cursor}`
    );
    if (!result.ok) return result;
    pages += 1;
    const page = items(result.body);
    for (const message of page) {
      const created = Date.parse(str(message.created));
      if (sinceMs !== null && !Number.isNaN(created) && created < sinceMs) {
        exhausted = true;
        break;
      }
      collected.push(message);
    }
    if (exhausted || page.length < pageSize) {
      exhausted = true;
      break;
    }
    const lastId = str(page[page.length - 1].id);
    // No id to page from, or the API handed the same page back: stop rather
    // than loop; the walk is then reported as not having reached the start.
    if (!lastId || lastId === before) break;
    before = lastId;
  }
  if (keep === 'oldest') {
    return {
      ok: true,
      value: {
        messages: collected.slice(-limit),
        more: collected.length > limit,
        unreached: !exhausted,
      },
    };
  }
  return {
    ok: true,
    value: {
      messages: collected.slice(0, limit),
      more: collected.length > limit || (collected.length === limit && !exhausted),
      unreached: false,
    },
  };
}

/** The one text block for a room's window: its messages, then how it was cut, if it was. */
function renderWindow(read: WindowRead, window: WindowArgs): string {
  const { since, keep, limit } = window;
  if (read.messages.length === 0) return since ? `(No messages since ${since}.)` : '(No messages.)';
  const notes: string[] = [];
  // Without a window, "the room has older messages than these" goes without
  // saying; with one, a cut is the difference between "that was everything
  // since Monday" and "that was the latest 20 since Monday".
  if (since && read.more) {
    notes.push(
      keep === 'oldest'
        ? `(Only the oldest ${limit} of the window are shown — newer messages since ${since} ` +
            'were left out; raise limit, or pass keep: "newest" for the latest.)'
        : `(Only the newest ${limit} of the window are shown — more messages since ${since} ` +
            'exist; raise limit, or pass keep: "oldest" for the earliest.)'
    );
  }
  if (read.unreached) {
    notes.push(
      `(Walked ${WALK_PAGE_CAP * WALK_PAGE_SIZE} messages back without reaching ${since} — the ` +
        'earliest shown may not be the earliest in the window; narrow since.)'
    );
  }
  return [read.messages.map(messageLine).join('\n\n'), ...notes].join('\n\n');
}

/** The title webex_note_to_self creates — and finds first on every later run. */
/**
 * Decodes a WebEx API id — base64 of a `ciscospark://…/<TYPE>/<uuid>` URI —
 * to the uuid, when it matches the given type. Room and message ids share
 * this exact shape, one per resource type. Null when the id doesn't decode
 * to that shape, or decodes to a different type — a caller asking for a
 * ROOM must never get a MESSAGE's uuid back.
 */
function decodeSparkId(id: string, type: 'ROOM' | 'MESSAGE'): string | null {
  try {
    const decoded = Buffer.from(id, 'base64').toString('utf8');
    const match = new RegExp(`/${type}/([0-9a-f-]{36})$`, 'i').exec(decoded);
    return match ? match[1] : null;
  } catch {
    return null;
  }
}

/**
 * A `webexteams://` deep link to a WebEx space, straight to one message
 * within it when the message id is known — opens the native app directly,
 * never a browser tab landing on the generic web client shell.
 *
 * `im?space=<uuid>` is the one documented way to open an existing space
 * (alongside `im?email=` for a 1:1); `&message=<uuid>` is undocumented but
 * does the job of scrolling straight to that message, both uuids decoded
 * from the API's own room/message ids the same way. Null when the room id
 * doesn't decode to a ROOM uri — a receipt with no link beats a link to the
 * wrong place; a message id that doesn't decode just drops the param.
 */
function webexSpaceUrl(roomId: string, messageId?: string): string | null {
  const spaceId = decodeSparkId(roomId, 'ROOM');
  if (!spaceId) return null;
  const activityId = messageId ? decodeSparkId(messageId, 'MESSAGE') : null;
  return `webexteams://im?space=${spaceId}${activityId ? `&message=${activityId}` : ''}`;
}

const NOTE_TO_SELF_TITLE = 'Note to Self';
/** Membership probes before concluding no solo space exists and creating one. */
const SOLO_PROBE_CAP = 20;
/** Rooms one webex_bulk_list_messages call fans out over. */
const BULK_ROOMS_CAP = 25;

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
    // /contents/<id> is served under the same scope as the message that
    // carries the file — no separate files scope exists.
    case 'webex_download_attachments':
      return ['spark:messages_read'];
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
        'answer in the same thread. Pass since for "what happened after <time>", and keep to ' +
        'say which end of that window matters when it holds more than limit. For several ' +
        'rooms at once, call webex_bulk_list_messages instead of this once per room.',
      annotations: { readOnlyHint: true },
      inputSchema: z.object({
        roomId: z.string().min(1).describe('Room id from webex_list_rooms'),
        limit: z
          .number()
          .int()
          .min(1)
          .max(ROOM_LIMIT_CAP)
          .describe(`How many messages at most (default 20, up to ${ROOM_LIMIT_CAP})`)
          .optional(),
        since: z.string().describe(SINCE_HINT).optional(),
        keep: z.enum(['newest', 'oldest']).describe(KEEP_HINT).optional(),
      }),
    },
    async (args: Record<string, any>) => {
      const roomId = str(args.roomId);
      if (!roomId) return errText('roomId is required');
      const window = parseWindowArgs(args);
      if ('error' in window) return errText(window.error);
      const result = await readWindow(auth, webexScopeFor('webex_list_messages'), roomId, window);
      if (!result.ok) return errText(result.error);
      if (result.value.messages.length === 0) {
        return textResult(window.since ? `No messages since ${window.since}.` : 'No messages.');
      }
      return textResult(
        withPresentationHint(
          renderWindow(result.value, window),
          'a chat-thread layout (grouped by sender, newest last) usually reads more naturally ' +
            'than this flat list.'
        )
      );
    }
  );

  server.registerTool(
    'webex_bulk_list_messages',
    {
      title: 'WebEx · Read — List WebEx messages across many rooms',
      description:
        'Recent messages from up to 25 rooms in a single call, newest first within each room — ' +
        'use this instead of one webex_list_messages per room whenever a request spans several ' +
        'spaces (a catch-up, a digest, "what did I miss"). WebEx has no multi-room endpoint, so ' +
        'this fans the reads out server-side and returns one section per room, in the order ' +
        'asked. A room that cannot be read (not a member, unknown id) is reported in its own ' +
        'section without failing the others. Pass since for "what happened after <time>", and ' +
        'keep to say which end of that window matters when a room holds more than limit. ' +
        'Access and thread marking are the same as webex_list_messages.',
      annotations: { readOnlyHint: true },
      inputSchema: z.object({
        roomIds: z
          .array(z.string().min(1))
          .min(1)
          .max(BULK_ROOMS_CAP)
          .describe('Room ids from webex_list_rooms'),
        limit: z
          .number()
          .int()
          .min(1)
          .max(ROOM_LIMIT_CAP)
          .describe(
            `How many messages per room at most (default 20, up to ${ROOM_LIMIT_CAP}; rooms × ` +
              `limit may not exceed ${BULK_MESSAGES_CAP})`
          )
          .optional(),
        since: z.string().describe(SINCE_HINT).optional(),
        keep: z.enum(['newest', 'oldest']).describe(KEEP_HINT).optional(),
      }),
    },
    async (args: Record<string, any>) => {
      const roomIds: string[] = Array.isArray(args.roomIds)
        ? args.roomIds.filter((id: unknown): id is string => typeof id === 'string' && id !== '')
        : [];
      if (roomIds.length === 0) return errText('roomIds is required');
      const unique = [...new Set(roomIds)].slice(0, BULK_ROOMS_CAP);
      const window = parseWindowArgs(args);
      if ('error' in window) return errText(window.error);
      // The cap protects the reader's context, not the API: 25 rooms × 200
      // messages is a wall of text no one can act on in one turn.
      if (unique.length * window.limit > BULK_MESSAGES_CAP) {
        return errText(
          `${unique.length} room(s) × limit ${window.limit} could return ` +
            `${unique.length * window.limit} messages, over the ${BULK_MESSAGES_CAP} one call ` +
            'can carry; lower limit or split the rooms across calls.'
        );
      }

      // WebEx rate-limits per user and per app; a bounded window keeps 25
      // rooms polite while still finishing in a few round trips. Each room's
      // own walk is sequential — page N+1 needs page N's last id.
      const CONCURRENCY = 4;
      const sections: string[] = new Array<string>(unique.length);
      const failedIds: string[] = [];
      let cursor = 0;
      const fetchOne = async (): Promise<void> => {
        for (;;) {
          const index = cursor;
          cursor += 1;
          if (index >= unique.length) return;
          const roomId = unique[index];
          const result = await readWindow(
            auth,
            webexScopeFor('webex_bulk_list_messages'),
            roomId,
            window
          );
          // The id is labelled `roomId` — the exact parameter name
          // webex_list_messages and webex_send_message take — so the
          // follow-up call is a copy, not a guessing game.
          const heading = `## roomId: ${roomId}`;
          if (!result.ok) {
            failedIds.push(roomId);
            sections[index] = `${heading}\n(Could not read: ${result.error})`;
            continue;
          }
          sections[index] = `${heading}\n${renderWindow(result.value, window)}`;
        }
      };
      await Promise.all(
        Array.from({ length: Math.min(CONCURRENCY, unique.length) }, () => fetchOne())
      );

      // Partial failure is a report; TOTAL failure (revoked scope, dead
      // credential) is an error the caller must see as one.
      if (failedIds.length === unique.length) {
        return errText(`None of the ${unique.length} room(s) could be read:\n\n${sections[0]}`);
      }
      const failed = failedIds.length ? ` (${failedIds.length} could not be read)` : '';
      return textResult(
        withPresentationHint(
          `${unique.length} room(s)${failed}:\n\n${sections.join('\n\n---\n\n')}`,
          'one chat-thread block per room (grouped by sender, newest last) usually reads more ' +
            'naturally than this flat list.'
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

  // Registered only where this deployment runs a sandbox worker — the same
  // env check registry.ts makes for sandbox_* itself. Without one there is
  // nowhere to put the bytes, and a tool that can only ever answer "not
  // configured" is noise in the model's catalog.
  if (sandboxConfig() !== null) {
    server.registerTool(
      'webex_download_attachments',
      {
        title: 'WebEx · Act — Download a message’s attachments into your scratch space',
        description:
          'Stage the files attached to a WebEx message in your sandbox scratch space, ' +
          'server-to-server — the bytes never pass through the model. Messages carrying files ' +
          'show an "attachments" line in webex_list_messages / webex_get_message; this stages ' +
          'all of them, or just the one named by fileUrl. Each staged file answers with an id: ' +
          'sandbox_read_file extracts its text, sandbox_send_to_upload forwards it into a ' +
          'Jira, OnBase or Confluence upload. Staged files expire after a day and count ' +
          'against a per-caller quota; sandbox_delete_file removes one early.',
        // Writes to the caller's scratch space, never to WebEx — but it is a
        // write, so org read-only mode disables it, like sandbox_download_url.
        annotations: { readOnlyHint: false },
        inputSchema: z.object({
          messageId: z.string().min(1).describe('Message id whose attachments to stage'),
          fileUrl: z
            .string()
            .describe(
              'One content URL from the message’s "attachments" line, to stage only that ' +
                'file. Omitted = every attachment on the message.'
            )
            .optional(),
        }),
      },
      async (args: Record<string, any>) => {
        const messageId = str(args.messageId);
        if (!messageId) return errText('messageId is required');
        if (!context.subject) return errText('No signed-in identity on this request.');
        const target = { tenantId: context.tenantId, subject: context.subject };
        const scopes = webexScopeFor('webex_download_attachments');

        const message = await webexGet(auth, scopes, `/messages/${encodeURIComponent(messageId)}`);
        if (!message.ok) return errText(message.error);
        const files = messageFiles(message.body);
        if (files.length === 0) return textResult('That message has no attachments.');

        const wanted = str(args.fileUrl);
        if (wanted && !files.includes(wanted)) {
          return errText(
            `That message carries no attachment at ${wanted}. Its attachments: ${files.join(', ')}`
          );
        }
        const selected = wanted ? [wanted] : files;

        // The org's attachment cap is the ceiling the worker's own limit
        // sits under; either refusal reads the same to the caller. Checked
        // on the declared length first so an oversized file is never held
        // in memory, then on the bytes, since Content-Length is optional.
        const maxBytes = context.maxAttachmentBytes ?? DEFAULT_MAX_FILE_BYTES;
        const lines: string[] = [];
        let staged = 0;
        for (const [index, fileUrl] of selected.entries()) {
          const path = contentPathOf(fileUrl);
          if (!path) {
            lines.push(`Skipped ${fileUrl}: not a WebEx content URL, so it was not fetched.`);
            continue;
          }
          const fetched = await webexCall(auth, scopes, path);
          if (!fetched.ok) {
            lines.push(`Could not fetch ${fileUrl}: ${fetched.error}`);
            continue;
          }
          const response = fetched.response;
          const declared = Number(response.headers.get('content-length'));
          if (Number.isFinite(declared) && declared > maxBytes) {
            lines.push(
              `Skipped ${fileUrl}: ${declared} bytes is over this org's ${maxBytes}-byte attachment limit.`
            );
            continue;
          }
          const bytes = new Uint8Array(
            await response.arrayBuffer().catch(() => new ArrayBuffer(0))
          );
          if (bytes.byteLength === 0) {
            lines.push(`Could not fetch ${fileUrl}: WebEx returned no content.`);
            continue;
          }
          if (bytes.byteLength > maxBytes) {
            lines.push(
              `Skipped ${fileUrl}: ${bytes.byteLength} bytes is over this org's ${maxBytes}-byte attachment limit.`
            );
            continue;
          }
          const contentType = (response.headers.get('content-type') ?? '')
            .split(';')[0]
            .trim()
            .toLowerCase();
          const filename = stagedFilename(
            response.headers.get('content-disposition'),
            contentType,
            index + 1
          );
          const written = await sbWriteFile(
            target,
            {
              filename,
              ...(contentType ? { contentType } : {}),
              source: `webex:${messageId}`,
            },
            bytes
          );
          if (!written.ok) {
            lines.push(`Could not stage ${fileUrl}: ${clientFailure(written.err).message}`);
            continue;
          }
          staged += 1;
          lines.push(`Staged ${fileLine(written.val)}`);
        }

        logger.info('webex_download_attachments staged', {
          component: 'mcp/tool',
          tenantId: context.tenantId,
          messageId,
          staged,
          attempted: selected.length,
        });
        // Partial failure is a report; TOTAL failure (revoked scope, full
        // quota) is an error the caller must see as one.
        if (staged === 0) return errText(lines.join('\n'));
        return textResult(
          `${staged} of ${selected.length} attachment(s) staged from message ${messageId}:\n` +
            lines.join('\n')
        );
      }
    );
  }

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
      // The message id takes the link straight to this message, not just
      // the space it landed in.
      const sentRoomUrl = str(sent.roomId) ? webexSpaceUrl(str(sent.roomId), str(sent.id)) : null;
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
      const noteRoomUrl = webexSpaceUrl(roomId, str(sent.id));
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
