/**
 * WebEx room-day windows: the unit the knowledge index holds WebEx in.
 *
 * A message on its own is a poor retrieval unit — short, context-free,
 * and unable to say which conversation it came from. So a captured
 * message does not get indexed; it marks its (room, UTC day) DIRTY
 * (`markWebexWindowDirty`, called from the dispatch handler), the sweep in
 * health/webex-windows.ts coalesces marks into one rebuild job per window,
 * and the handler here (`createKnowledgeIngestWebexWindowHandler`, on the
 * embedding worker) refetches the whole day from WebEx with a watcher's
 * own token, renders it as a transcript, and ingests it under the ref
 * `${roomId}/day/${day}`.
 *
 * The ref keeps the room as everything before the first `/`, which is all
 * the WebEx access verifier reads — room membership is the ACL for a day of
 * a room exactly as it was for one message of it — so the gate needs no
 * change. Rebuilding from the API rather than appending locally means an
 * edited or deleted message is simply absent from the next rebuild, and
 * that the text is the full message rather than the 1k preview the domain
 * event carries.
 */

import { sql } from 'kysely';
import { getDatabase } from '@renkei/db';
import { WebexClient, webexRefId } from '@renkei/connector-webex';
import type { WebexMessage, WebexRoom } from '@renkei/connector-webex';
import {
  resolveEmbeddingProvider,
  ingestObjectChunks,
  deleteObjectChunks,
  escapeLike,
} from '@renkei/knowledge';
import type { EventHandler } from '../handlers';
import { resolveWebexUserAccessBySubject } from './webex-linked-user';
import { logger } from '../logger';

const COMPONENT = 'knowledge/webex-window';

/** A day of chat is a transcript; chunk it like one (see zoom-events.ts). */
const WINDOW_CHUNKING = { maxChars: 4_000, overlap: 400 };

/** Messages per WebEx page; the API caps well above this. */
const PAGE_SIZE = 100;
/** A ceiling on one day of one room, so a runaway bot room cannot page forever. */
const MAX_MESSAGES_PER_WINDOW = 2_000;

/** The UTC calendar day a timestamp falls on, as the window key; today when unparseable. */
export function windowDayOf(iso: string | undefined | null): string {
  const parsed = iso ? new Date(iso) : new Date();
  const date = Number.isNaN(parsed.getTime()) ? new Date() : parsed;
  return date.toISOString().slice(0, 10);
}

/** The knowledge ref of a room-day window. */
export function webexWindowRefId(roomId: string, day: string): string {
  return webexRefId(roomId, `day/${day}`);
}

function dayBounds(day: string): { start: Date; end: Date } {
  const start = new Date(`${day}T00:00:00.000Z`);
  const end = new Date(start.getTime() + 24 * 3_600_000);
  return { start, end };
}

/**
 * Mark a window for rebuild. Idempotent per (tenant, room, day); a second
 * mark only refreshes `marked_at`, which is what the sweep's quiet-period
 * debounce keys on. Throws on a database failure so the dispatch row
 * retries — a lost mark is a conversation missing from search with nothing
 * to re-capture it.
 */
export async function markWebexWindowDirty(
  tenantId: string,
  roomId: string,
  day: string,
  subject: string | null
): Promise<void> {
  const dbResult = getDatabase();
  if (!dbResult.ok) throw new Error('database unavailable to mark a WebEx window dirty');
  await dbResult.val
    .insertInto('webex_dirty_windows')
    .values({ tenant_id: tenantId, room_id: roomId, day, subject, marked_at: sql`NOW()` })
    .onConflict((oc) =>
      oc.columns(['tenant_id', 'room_id', 'day']).doUpdateSet({
        marked_at: sql`NOW()`,
        // A watcher that is still around beats one that may have opted out.
        subject: sql`COALESCE(EXCLUDED.subject, webex_dirty_windows.subject)`,
      })
    )
    .execute();
}

function timeOf(iso: string | null): string {
  if (!iso) return '--:--';
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? '--:--' : date.toISOString().slice(11, 16);
}

/**
 * The window as text: a heading a reader (and the context header) can use,
 * then one line per message in the order it was said, threaded replies
 * marked. Chunk boundaries fall on line breaks, so a chunk is always whole
 * messages.
 */
export function renderWebexWindow(
  room: Pick<WebexRoom, 'title' | 'type'>,
  day: string,
  messages: readonly WebexMessage[]
): string {
  const title = room.title?.trim() || (room.type === 'direct' ? 'Direct messages' : 'WebEx space');
  const lines = [`# ${title} — ${day}`, ''];
  for (const message of messages) {
    const text = message.text?.trim();
    if (!text) continue;
    const who = message.personEmail || 'unknown';
    const reply = message.parentId ? '↳ ' : '';
    lines.push(`[${timeOf(message.created)}] ${who}: ${reply}${text.replace(/\s*\n\s*/g, ' / ')}`);
  }
  return lines.join('\n');
}

export type WindowClient = Pick<WebexClient, 'getRoom' | 'listMessagesBefore'>;

/**
 * Every message of one room on one UTC day, oldest first, walked backwards
 * from the day's end page by page until a page crosses the day's start.
 */
export async function fetchWindowMessages(
  client: WindowClient,
  roomId: string,
  day: string
): Promise<
  { ok: true; messages: WebexMessage[] } | { ok: false; message: string; status: number | null }
> {
  const { start, end } = dayBounds(day);
  const collected: WebexMessage[] = [];
  let beforeMessage: string | undefined;
  for (;;) {
    const page = await client.listMessagesBefore(roomId, {
      max: PAGE_SIZE,
      ...(beforeMessage ? { beforeMessage } : { before: end.toISOString() }),
    });
    if (!page.ok) {
      const text = page.err.message ?? 'WebEx API error';
      const status = /WebEx API (\d{3})/.exec(text);
      return { ok: false, message: text, status: status ? Number(status[1]) : null };
    }
    if (page.val.length === 0) break;

    let crossed = false;
    for (const message of page.val) {
      const created = message.created ? new Date(message.created) : null;
      if (!created || Number.isNaN(created.getTime())) continue;
      if (created < start) {
        crossed = true;
        break;
      }
      if (created < end) collected.push(message);
    }
    if (crossed || collected.length >= MAX_MESSAGES_PER_WINDOW) break;
    // A short page is the last page — no need to ask again and be told so.
    if (page.val.length < PAGE_SIZE) break;
    const oldest = page.val[page.val.length - 1]?.id;
    // No progress means the cursor is being ignored; stop rather than spin.
    if (!oldest || oldest === beforeMessage) break;
    beforeMessage = oldest;
  }
  return { ok: true, messages: collected.reverse() };
}

/**
 * Drop the pre-window per-message rows of this room-day. Called AFTER the
 * window is written, so search never has a gap; scoped to the day so a
 * room's other days keep their rows until their own window lands.
 */
export async function deleteLegacyMessageRows(
  tenantId: string,
  roomId: string,
  day: string
): Promise<void> {
  const dbResult = getDatabase();
  if (!dbResult.ok) throw new Error('database unavailable');
  const { start, end } = dayBounds(day);
  const prefix = escapeLike(roomId);
  await dbResult.val
    .deleteFrom('knowledge_chunks')
    .where('tenant_id', '=', tenantId)
    .where('provider', '=', 'webex')
    .where('ref_id', 'like', `${prefix}/%`)
    .where('ref_id', 'not like', `${prefix}/day/%`)
    .where('source_at', '>=', start)
    .where('source_at', '<', end)
    .execute();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

export interface WindowHandlerDeps {
  resolveAccess?: typeof resolveWebexUserAccessBySubject;
  makeClient?: (accessToken: string) => WindowClient;
  deleteLegacy?: typeof deleteLegacyMessageRows;
}

/**
 * `knowledge/ingest.webex-window` — rebuild one room-day and index it.
 *
 * Failure policy follows knowledge-ingest.ts: a transient WebEx or
 * embeddings failure THROWS so the queue retries; the permanent outcomes —
 * no watcher token any more, a room the watcher can no longer read — log
 * and return, leaving whatever the index already holds.
 */
export function createKnowledgeIngestWebexWindowHandler(
  deps: WindowHandlerDeps = {}
): EventHandler {
  const resolveAccess = deps.resolveAccess ?? resolveWebexUserAccessBySubject;
  const makeClient =
    deps.makeClient ?? ((token: string) => new WebexClient(token, { lane: 'background' }));
  const deleteLegacy = deps.deleteLegacy ?? deleteLegacyMessageRows;

  return async (event) => {
    const payload = isRecord(event.payload) ? event.payload : {};
    const roomId = str(payload.roomId);
    const day = str(payload.day);
    const subject = str(payload.subject);
    if (!roomId || !/^\d{4}-\d{2}-\d{2}$/.test(day) || !subject) {
      throw new Error('webex window payload is missing roomId/day/subject');
    }
    const tenantId = event.tenant_id;

    const embedder = await resolveEmbeddingProvider(tenantId);
    if (!embedder) return; // knowledge layer off for this org

    const access = await resolveAccess(tenantId, subject);
    if (!access) {
      logger.info('no usable WebEx grant for {subject}; window {roomId}/{day} not rebuilt', {
        component: COMPONENT,
        tenantId,
        subject,
        roomId,
        day,
      });
      return;
    }
    const client = makeClient(access.accessToken);

    const room = await client.getRoom(roomId);
    if (!room.ok) {
      const text = room.err.message ?? '';
      if (/WebEx API 40[34]/.test(text)) {
        logger.info('watcher can no longer read room {roomId}; window not rebuilt', {
          component: COMPONENT,
          tenantId,
          roomId,
        });
        return;
      }
      throw new Error(`could not read WebEx room ${roomId}: ${text}`);
    }

    const fetched = await fetchWindowMessages(client, roomId, day);
    if (!fetched.ok) {
      if (fetched.status === 403 || fetched.status === 404) return;
      throw new Error(`could not list WebEx room ${roomId} for ${day}: ${fetched.message}`);
    }

    const refId = webexWindowRefId(roomId, day);
    const spoken = fetched.messages.filter((message) => message.text?.trim());
    if (spoken.length === 0) {
      // Everything that day was deleted, or never had text: the window
      // goes, and so do the legacy rows it would have replaced.
      const removed = await deleteObjectChunks(tenantId, 'webex', refId);
      if (!removed.ok) throw new Error(`could not delete empty window ${refId}`);
      await deleteLegacy(tenantId, roomId, day);
      return;
    }

    const participants = [...new Set(spoken.map((m) => m.personEmail).filter(Boolean))];
    const latest = spoken[spoken.length - 1]?.created ?? null;
    const ingested = await ingestObjectChunks(
      tenantId,
      embedder,
      {
        provider: 'webex',
        refId,
        content: renderWebexWindow(room.val, day, spoken),
        metadata: {
          kind: 'window',
          roomId,
          roomType: room.val.type ?? undefined,
          title: room.val.title ?? undefined,
          day,
          participants,
          messageCount: spoken.length,
        },
        // The day's last word, so "last 7 days" means the conversation was
        // still going then and the browse order reads as recency.
        sourceAt: latest,
      },
      WINDOW_CHUNKING
    );
    if (!ingested.ok) {
      throw new Error(`could not index window ${refId}: ${ingested.err.type}`);
    }
    await deleteLegacy(tenantId, roomId, day);

    logger.debug('rebuilt window {roomId}/{day}: {messages} message(s), {chunks} chunk(s)', {
      component: COMPONENT,
      tenantId,
      roomId,
      day,
      messages: spoken.length,
      chunks: ingested.val.chunks,
    });
  };
}
