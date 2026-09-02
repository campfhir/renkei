/**
 * The WebEx window sweep: turns dirty (room, day) marks into rebuild jobs,
 * and gives a newly opted-in watcher their recent history.
 *
 * Coalescing is the point. Dispatch marks a window on every message; this
 * sweep waits for a window to have been quiet for a moment, then enqueues
 * ONE `ingest.webex-window` job for it — so a lively conversation is
 * rebuilt once per lull rather than once per message. The mark is deleted
 * only if nothing re-marked it meanwhile (the `marked_at` guard), so a
 * message that lands during the sweep is not lost.
 *
 * Backfill runs here too, once per opted-in grant: list the watcher's
 * rooms, look at each room's most recent page of messages, and mark the
 * days those cover. One list call per room plus one per active day, rather
 * than thirty days times every room, most of which would be empty.
 */

import { sql } from 'kysely';
import { getDatabase } from '@renkei/db';
import { WebexClient } from '@renkei/connector-webex';
import { enqueueKnowledgeEvent } from '../enqueue';
import { resolveWebexUserAccessByAccount } from '../handlers/webex-linked-user';
import { windowDayOf, type WindowClient } from '../handlers/webex-windows';
import { logger } from '../logger';

const COMPONENT = 'webex/window-sweep';

export const WEBEX_WINDOW_SWEEP_INTERVAL_MS = 2 * 60_000;
/** A window must have been quiet this long before it is rebuilt. */
const QUIET_MS = 60_000;
/** Windows enqueued per pass. */
const MAX_WINDOWS_PER_PASS = 50;
/** Grants backfilled per pass — each is a room listing plus a page per room. */
const MAX_BACKFILLS_PER_PASS = 3;
/** Rooms considered per backfill, most recently active first. */
const BACKFILL_ROOMS = 100;

export interface WindowSweepDeps {
  makeClient?: (accessToken: string) => WindowClient & Pick<WebexClient, 'listRooms'>;
  resolveAccess?: typeof resolveWebexUserAccessByAccount;
  enqueue?: typeof enqueueKnowledgeEvent;
  now?: () => Date;
}

/** Any opted-in watcher of the tenant, for marks that did not record one. */
async function anyWatcherSubject(tenantId: string): Promise<string | null> {
  const dbResult = getDatabase();
  if (!dbResult.ok) return null;
  const row = await dbResult.val
    .selectFrom('provider_grants')
    .select('subject')
    .where('tenant_id', '=', tenantId)
    .where('provider', '=', 'webex')
    .where(sql<boolean>`metadata->>'allSpaces' = 'true'`)
    .orderBy('updated_at', 'desc')
    .executeTakeFirst();
  return row?.subject ?? null;
}

async function enqueueDirtyWindows(deps: WindowSweepDeps): Promise<void> {
  const enqueue = deps.enqueue ?? enqueueKnowledgeEvent;
  const now = (deps.now ?? (() => new Date()))();
  const dbResult = getDatabase();
  if (!dbResult.ok) return;
  const db = dbResult.val;

  const rows = await db
    .selectFrom('webex_dirty_windows')
    .select(['tenant_id', 'room_id', 'day', 'subject', 'marked_at'])
    .where('marked_at', '<=', new Date(now.getTime() - QUIET_MS))
    .orderBy('marked_at')
    .limit(MAX_WINDOWS_PER_PASS)
    .execute();

  for (const row of rows) {
    const subject = row.subject ?? (await anyWatcherSubject(row.tenant_id));
    if (!subject) {
      // Nobody in this org can read the room any more. Drop the mark:
      // keeping it would re-select it every pass forever.
      await db
        .deleteFrom('webex_dirty_windows')
        .where('tenant_id', '=', row.tenant_id)
        .where('room_id', '=', row.room_id)
        .where('day', '=', row.day)
        .execute();
      logger.info('no opted-in watcher; window {roomId}/{day} dropped', {
        component: COMPONENT,
        tenantId: row.tenant_id,
        roomId: row.room_id,
        day: row.day,
      });
      continue;
    }

    try {
      await enqueue(
        row.tenant_id,
        'ingest.webex-window',
        { provider: 'webex', roomId: row.room_id, day: row.day, subject },
        // Rebuilds of one room stay serial; different rooms embed in parallel.
        `webex/${row.tenant_id}/${row.room_id}`,
        { strict: true }
      );
    } catch (error) {
      logger.error('could not enqueue window {roomId}/{day}: {error}', {
        component: COMPONENT,
        tenantId: row.tenant_id,
        roomId: row.room_id,
        day: row.day,
        error: error instanceof Error ? error.message : String(error),
      });
      continue; // the mark stays; next pass retries
    }
    // Only the mark we read: a message that arrived meanwhile re-marked
    // the row with a newer marked_at, and that rebuild is still owed.
    await db
      .deleteFrom('webex_dirty_windows')
      .where('tenant_id', '=', row.tenant_id)
      .where('room_id', '=', row.room_id)
      .where('day', '=', row.day)
      .where('marked_at', '=', row.marked_at)
      .execute();
  }
}

async function backfillNewWatchers(deps: WindowSweepDeps): Promise<void> {
  const makeClient =
    deps.makeClient ?? ((token: string) => new WebexClient(token, { lane: 'background' }));
  const resolveAccess = deps.resolveAccess ?? resolveWebexUserAccessByAccount;
  const dbResult = getDatabase();
  if (!dbResult.ok) return;
  const db = dbResult.val;

  const grants = await db
    .selectFrom('provider_grants')
    .select(['tenant_id', 'provider_account_id', 'subject'])
    .where('provider', '=', 'webex')
    .where(sql<boolean>`metadata->>'allSpaces' = 'true'`)
    .where(sql<boolean>`metadata->>'windowsBackfilledAt' IS NULL`)
    .limit(MAX_BACKFILLS_PER_PASS)
    .execute();

  for (const grant of grants) {
    const access = await resolveAccess(grant.tenant_id, grant.provider_account_id);
    if (!access) continue; // token trouble; the webhook sweep will say so
    const client = makeClient(access.accessToken);

    const rooms = await client.listRooms(BACKFILL_ROOMS);
    if (!rooms.ok) {
      logger.warn('backfill: could not list rooms: {error}', {
        component: COMPONENT,
        tenantId: grant.tenant_id,
        error: rooms.err.message ?? 'unknown',
      });
      continue; // not marked done; retried next pass
    }

    let marked = 0;
    for (const room of rooms.val) {
      const recent = await client.listMessagesBefore(room.id, { max: 100 });
      if (!recent.ok) continue;
      const days = new Set(
        recent.val.filter((m) => m.created && m.text).map((m) => windowDayOf(m.created))
      );
      for (const day of days) {
        await db
          .insertInto('webex_dirty_windows')
          .values({
            tenant_id: grant.tenant_id,
            room_id: room.id,
            day,
            subject: access.subject,
            marked_at: sql`NOW()`,
          })
          .onConflict((oc) => oc.columns(['tenant_id', 'room_id', 'day']).doNothing())
          .execute();
        marked += 1;
      }
    }

    await db
      .updateTable('provider_grants')
      .set({
        metadata: sql`COALESCE(metadata, '{}'::jsonb) || ${JSON.stringify({
          windowsBackfilledAt: new Date().toISOString(),
        })}::jsonb`,
      })
      .where('tenant_id', '=', grant.tenant_id)
      .where('provider', '=', 'webex')
      .where('provider_account_id', '=', grant.provider_account_id)
      .execute();
    logger.info('backfill: marked {marked} window(s) across {rooms} room(s) for {subject}', {
      component: COMPONENT,
      tenantId: grant.tenant_id,
      marked,
      rooms: rooms.val.length,
      subject: grant.subject ?? grant.provider_account_id,
    });
  }
}

export async function sweepWebexWindows(deps: WindowSweepDeps = {}): Promise<void> {
  const dbResult = getDatabase();
  if (!dbResult.ok) {
    logger.error('database unavailable', { component: COMPONENT });
    return;
  }
  await backfillNewWatchers(deps);
  await enqueueDirtyWindows(deps);
}
