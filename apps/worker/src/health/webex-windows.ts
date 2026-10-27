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

import { getDataStore } from '@renkei/db';
import { WebexClient } from '@renkei/connector-webex';
import type { AuthedFetch } from '@renkei/delegate-client';
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
  makeClient?: (auth: AuthedFetch) => WindowClient & Pick<WebexClient, 'listRooms'>;
  resolveAccess?: typeof resolveWebexUserAccessByAccount;
  enqueue?: typeof enqueueKnowledgeEvent;
  now?: () => Date;
}

/** Any opted-in watcher of the tenant, for marks that did not record one. */
async function anyWatcherSubject(): Promise<string | null> {
  const [grant] = await getDataStore().providerGrants.listWithMetadata(
    'webex',
    { equals: { allSpaces: 'true' } },
    { newestFirst: true, limit: 1 }
  );
  return grant?.subject ?? null;
}

async function enqueueDirtyWindows(deps: WindowSweepDeps): Promise<void> {
  const enqueue = deps.enqueue ?? enqueueKnowledgeEvent;
  const now = (deps.now ?? (() => new Date()))();
  const windows = getDataStore().webexDirtyWindows;

  const rows = await windows.listQuiet(new Date(now.getTime() - QUIET_MS), MAX_WINDOWS_PER_PASS);

  for (const row of rows) {
    const subject = row.subject ?? (await anyWatcherSubject());
    if (!subject) {
      // Nobody in this org can read the room any more. Drop the mark:
      // keeping it would re-select it every pass forever.
      await windows.delete(row.roomId, row.day);
      logger.info('no opted-in watcher; window {roomId}/{day} dropped', {
        component: COMPONENT,
        roomId: row.roomId,
        day: row.day,
      });
      continue;
    }

    try {
      await enqueue(
        'ingest.webex-window',
        { provider: 'webex', roomId: row.roomId, day: row.day, subject },
        // Rebuilds of one room stay serial; different rooms embed in parallel.
        `webex/${row.roomId}`,
        { strict: true }
      );
    } catch (error) {
      logger.error('could not enqueue window {roomId}/{day}: {error}', {
        component: COMPONENT,
        roomId: row.roomId,
        day: row.day,
        error: error instanceof Error ? error.message : String(error),
      });
      continue; // the mark stays; next pass retries
    }
    // Only the mark we read: a message that arrived meanwhile re-marked
    // the row with a newer marked_at, and that rebuild is still owed.
    await windows.delete(row.roomId, row.day, { markedAt: row.markedAt });
  }
}

async function backfillNewWatchers(deps: WindowSweepDeps): Promise<void> {
  const makeClient =
    deps.makeClient ?? ((auth: AuthedFetch) => new WebexClient(auth, { lane: 'background' }));
  const resolveAccess = deps.resolveAccess ?? resolveWebexUserAccessByAccount;
  const store = getDataStore();

  const grants = await store.providerGrants.listWithMetadata(
    'webex',
    { equals: { allSpaces: 'true' }, missing: ['windowsBackfilledAt'] },
    { limit: MAX_BACKFILLS_PER_PASS }
  );

  for (const grant of grants) {
    const access = await resolveAccess(grant.accountId);
    if (!access) continue; // token trouble; the webhook sweep will say so
    const client = makeClient(access.auth);

    const rooms = await client.listRooms(BACKFILL_ROOMS);
    if (!rooms.ok) {
      logger.warn('backfill: could not list rooms: {error}', {
        component: COMPONENT,
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
        await store.webexDirtyWindows.markIfAbsent(room.id, day, access.subject);
        marked += 1;
      }
    }

    await store.providerGrants.mergeMetadata(
      'webex',
      grant.accountId,
      { windowsBackfilledAt: new Date().toISOString() },
      { touch: false }
    );
    logger.info('backfill: marked {marked} window(s) across {rooms} room(s) for {subject}', {
      component: COMPONENT,
      marked,
      rooms: rooms.val.length,
      subject: grant.subject ?? grant.accountId,
    });
  }
}

export async function sweepWebexWindows(deps: WindowSweepDeps = {}): Promise<void> {
  await backfillNewWatchers(deps);
  await enqueueDirtyWindows(deps);
}
