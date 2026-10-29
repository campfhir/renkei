/**
 * One person's notification feed, and marking it read.
 *
 * Strictly the caller's own rows. The scoping is structural, the way every
 * tenant route here does it: the query is keyed by `tenant_id` AND
 * `session.subject`, and no parameter can name a subject. Somebody else's
 * notification is not forbidden, it is invisible.
 *
 * The GET is shaped for polling: `since` is a cursor, and the answer in the
 * overwhelmingly common case is an empty list plus a count. `serverTime`
 * comes back so the poller advances its cursor by OUR clock — a browser
 * running a few minutes fast would otherwise skip rows for good, and one
 * running slow would replay them.
 *
 * The same GET also serves the notifications page's "Show more": `before`
 * pages backward past the page's own PAGE_SIZE. MAX_LIMIT matches that
 * PAGE_SIZE (apps/web/app/(app)/notifications/page.tsx) so one click loads
 * one full page rather than several partial ones.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getDataStore } from '@renkei/db';
import { wrapAsync } from '@campfhir/safe-functions/helpers';
import { getSessionFromRequest } from '@/lib/session';
import { logger } from '@/lib/logger';

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

export interface NotificationView {
  id: string;
  kind: string;
  category: string | null;
  connector: string | null;
  tool: string | null;
  entity: string | null;
  headline: string;
  refUrl: string | null;
  agentId: string | null;
  agentName: string | null;
  runId: string | null;
  /**
   * Structured facts about the thing the row is about — a batch job's
   * counts and status (lib/notifications/batch-meta.ts). Null for the
   * agent-run and act kinds.
   */
  meta: unknown;
  readAt: string | null;
  createdAt: string;
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  const session = await getSessionFromRequest(request);
  if (!session) return NextResponse.json({ error: 'Not signed in' }, { status: 401 });

  const search = request.nextUrl.searchParams;
  const sinceRaw = search.get('since');
  const since = sinceRaw ? new Date(sinceRaw) : null;
  // A malformed cursor is treated as no cursor rather than as an error: the
  // poller would otherwise get stuck on it forever, one 400 at a time.
  const validSince = since && !Number.isNaN(since.getTime()) ? since : null;

  // `before` is the notifications PAGE's cursor, not the poller's: "Show
  // more" pages backward in time past PAGE_SIZE, the mirror image of
  // `since` paging forward. The two are never sent together in practice,
  // but nothing stops them combining if they ever were.
  const beforeRaw = search.get('before');
  const before = beforeRaw ? new Date(beforeRaw) : null;
  const validBefore = before && !Number.isNaN(before.getTime()) ? before : null;

  const requested = Number(search.get('limit') ?? DEFAULT_LIMIT);
  const limit = Number.isFinite(requested)
    ? Math.min(Math.max(Math.trunc(requested), 1), MAX_LIMIT)
    : DEFAULT_LIMIT;

  const store = getDataStore().notifications;
  const read = await wrapAsync(
    () =>
      Promise.all([
        store.list(session.subject, {
          limit,
          ...(validSince ? { since: validSince } : {}),
          ...(validBefore ? { before: validBefore } : {}),
          unreadOnly: search.get('unreadOnly') === 'true',
        }),
        store.countUnread(session.subject),
      ]),
    'DB_ERROR' as const
  );
  if (!read.ok) {
    logger.error('Database unavailable: {error}', {
      component: 'api/notifications',
      subject: session.subject,
      error: read.err.message ?? read.err.type,
    });
    return NextResponse.json({ error: 'Database unavailable' }, { status: 500 });
  }
  const [rows, unread] = read.val;

  const notifications: NotificationView[] = rows.map((row) => ({
    id: row.id,
    kind: row.kind,
    category: row.category,
    connector: row.connector,
    tool: row.tool,
    entity: row.entity,
    headline: row.headline,
    refUrl: row.refUrl,
    agentId: row.agentId,
    agentName: row.agentName,
    runId: row.runId,
    meta: row.meta,
    readAt: row.readAt ? row.readAt.toISOString() : null,
    createdAt: row.createdAt.toISOString(),
  }));

  return NextResponse.json({
    notifications,
    unread,
    serverTime: new Date().toISOString(),
  });
}

/**
 * Mark some or all of the caller's notifications read — or, with
 * `unread: true`, back to unread (the feed menu's "keep this one in my
 * face" action).
 */
export async function POST(request: NextRequest): Promise<NextResponse> {
  const session = await getSessionFromRequest(request);
  if (!session) return NextResponse.json({ error: 'Not signed in' }, { status: 401 });

  const body: unknown = await request.json().catch(() => null);
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return NextResponse.json({ error: 'Expected an object' }, { status: 400 });
  }
  const payload: { ids?: unknown; all?: unknown; unread?: unknown } = body;
  const ids = Array.isArray(payload.ids)
    ? payload.ids.filter((id): id is string => typeof id === 'string')
    : null;
  if (!ids && payload.all !== true) {
    return NextResponse.json({ error: 'Expected ids: string[] or all: true' }, { status: 400 });
  }
  const toUnread = payload.unread === true;

  // The store keys every change by the session's subject, so a borrowed
  // id from someone else's feed updates nothing.
  const marked = await wrapAsync(
    () =>
      getDataStore().notifications.mark(session.subject, ids ? { ids } : { all: true }, {
        unread: toUnread,
      }),
    'DB_ERROR' as const
  );
  if (!marked.ok) {
    logger.error('Database unavailable: {error}', {
      component: 'api/notifications',
      subject: session.subject,
      error: marked.err.message ?? marked.err.type,
    });
    return NextResponse.json({ error: 'Database unavailable' }, { status: 500 });
  }
  return NextResponse.json({ marked: marked.val });
}

/**
 * Delete some or all of the caller's notifications — the UI's dismiss.
 *
 * A hard delete on purpose: rows are an ephemeral feed the retention sweep
 * already deletes wholesale, so a tombstone would outlive its point. The
 * same structural scoping as the POST — a borrowed id deletes nothing.
 */
export async function DELETE(request: NextRequest): Promise<NextResponse> {
  const session = await getSessionFromRequest(request);
  if (!session) return NextResponse.json({ error: 'Not signed in' }, { status: 401 });

  const body: unknown = await request.json().catch(() => null);
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return NextResponse.json({ error: 'Expected an object' }, { status: 400 });
  }
  const payload: { ids?: unknown; all?: unknown } = body;
  const ids = Array.isArray(payload.ids)
    ? payload.ids.filter((id): id is string => typeof id === 'string')
    : null;
  if (!ids && payload.all !== true) {
    return NextResponse.json({ error: 'Expected ids: string[] or all: true' }, { status: 400 });
  }

  const deleted = await wrapAsync(
    () => getDataStore().notifications.delete(session.subject, ids ? { ids } : { all: true }),
    'DB_ERROR' as const
  );
  if (!deleted.ok) {
    logger.error('Database unavailable: {error}', {
      component: 'api/notifications',
      subject: session.subject,
      error: deleted.err.message ?? deleted.err.type,
    });
    return NextResponse.json({ error: 'Database unavailable' }, { status: 500 });
  }
  return NextResponse.json({ deleted: deleted.val });
}
