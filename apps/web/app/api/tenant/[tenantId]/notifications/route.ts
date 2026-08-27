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
 */

import { NextRequest, NextResponse } from 'next/server';
import { getDatabase } from '@renkei/db';
import { getSessionFromRequest } from '@/lib/session';

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 50;

export interface NotificationView {
  id: string;
  kind: string;
  category: string | null;
  connector: string | null;
  tool: string | null;
  headline: string;
  refUrl: string | null;
  agentId: string | null;
  agentName: string | null;
  runId: string | null;
  readAt: string | null;
  createdAt: string;
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ tenantId: string }> }
): Promise<NextResponse> {
  const { tenantId } = await params;
  const session = await getSessionFromRequest(request, tenantId);
  if (!session) return NextResponse.json({ error: 'Not signed in' }, { status: 401 });

  const dbResult = getDatabase();
  if (!dbResult.ok) return NextResponse.json({ error: 'Database unavailable' }, { status: 500 });
  const db = dbResult.val;

  const search = request.nextUrl.searchParams;
  const sinceRaw = search.get('since');
  const since = sinceRaw ? new Date(sinceRaw) : null;
  // A malformed cursor is treated as no cursor rather than as an error: the
  // poller would otherwise get stuck on it forever, one 400 at a time.
  const validSince = since && !Number.isNaN(since.getTime()) ? since : null;

  const requested = Number(search.get('limit') ?? DEFAULT_LIMIT);
  const limit = Number.isFinite(requested)
    ? Math.min(Math.max(Math.trunc(requested), 1), MAX_LIMIT)
    : DEFAULT_LIMIT;

  let query = db
    .selectFrom('agent_notifications')
    .select([
      'id',
      'kind',
      'category',
      'connector',
      'tool',
      'headline',
      'ref_url',
      'agent_id',
      'agent_name',
      'run_id',
      'read_at',
      'created_at',
    ])
    .where('tenant_id', '=', tenantId)
    .where('subject', '=', session.subject)
    .orderBy('created_at', 'desc')
    .limit(limit);

  if (validSince) query = query.where('created_at', '>', validSince);
  if (search.get('unreadOnly') === 'true') query = query.where('read_at', 'is', null);

  const [rows, unread] = await Promise.all([
    query.execute(),
    db
      .selectFrom('agent_notifications')
      .select((eb) => eb.fn.countAll<string>().as('count'))
      .where('tenant_id', '=', tenantId)
      .where('subject', '=', session.subject)
      .where('read_at', 'is', null)
      .executeTakeFirst(),
  ]);

  const notifications: NotificationView[] = rows.map((row) => ({
    id: row.id,
    kind: row.kind,
    category: row.category,
    connector: row.connector,
    tool: row.tool,
    headline: row.headline,
    refUrl: row.ref_url,
    agentId: row.agent_id,
    agentName: row.agent_name,
    runId: row.run_id,
    readAt: row.read_at ? new Date(row.read_at).toISOString() : null,
    createdAt: new Date(row.created_at).toISOString(),
  }));

  return NextResponse.json({
    notifications,
    unread: Number(unread?.count ?? 0),
    serverTime: new Date().toISOString(),
  });
}

/**
 * Mark some or all of the caller's notifications read — or, with
 * `unread: true`, back to unread (the feed menu's "keep this one in my
 * face" action).
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ tenantId: string }> }
): Promise<NextResponse> {
  const { tenantId } = await params;
  const session = await getSessionFromRequest(request, tenantId);
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

  const dbResult = getDatabase();
  if (!dbResult.ok) return NextResponse.json({ error: 'Database unavailable' }, { status: 500 });

  let update = dbResult.val
    .updateTable('agent_notifications')
    .set({ read_at: toUnread ? null : new Date() })
    .where('tenant_id', '=', tenantId)
    .where('subject', '=', session.subject)
    .where('read_at', toUnread ? 'is not' : 'is', null);
  // Narrowing by id still carries the tenant and subject predicates, so a
  // borrowed id from someone else's feed updates nothing.
  if (ids) {
    if (ids.length === 0) return NextResponse.json({ marked: 0 });
    update = update.where('id', 'in', ids);
  }

  const result = await update.executeTakeFirst();
  return NextResponse.json({ marked: Number(result.numUpdatedRows ?? 0) });
}

/**
 * Delete some or all of the caller's notifications — the UI's dismiss.
 *
 * A hard delete on purpose: rows are an ephemeral feed the retention sweep
 * already deletes wholesale, so a tombstone would outlive its point. The
 * same structural scoping as the POST — a borrowed id deletes nothing.
 */
export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ tenantId: string }> }
): Promise<NextResponse> {
  const { tenantId } = await params;
  const session = await getSessionFromRequest(request, tenantId);
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

  const dbResult = getDatabase();
  if (!dbResult.ok) return NextResponse.json({ error: 'Database unavailable' }, { status: 500 });

  let del = dbResult.val
    .deleteFrom('agent_notifications')
    .where('tenant_id', '=', tenantId)
    .where('subject', '=', session.subject);
  if (ids) {
    if (ids.length === 0) return NextResponse.json({ deleted: 0 });
    del = del.where('id', 'in', ids);
  }

  const result = await del.executeTakeFirst();
  return NextResponse.json({ deleted: Number(result.numDeletedRows ?? 0) });
}
