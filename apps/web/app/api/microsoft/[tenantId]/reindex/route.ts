/**
 * User-initiated re-index of the caller's own Microsoft 365 connector.
 * Subject-scoped, same as grant/route.ts's disconnect: the session decides
 * whose mail gets re-synced, never a parameter.
 *
 * There is no bulk "reprocess everything" primitive to build here — Graph's
 * delta protocol already gives us one for free. A delta round with no
 * cursor returns the mailbox's/calendar's/task list's full current state as
 * "changed" (see packages/connector-microsoft/src/delta.ts and
 * apps/worker/src/handlers/microsoft-sync.ts's `deltaStartUrl` fallback), so
 * nulling `delta_link` on this account's subscription rows is a full
 * backfill request, not a new indexing mode. Re-enqueuing the existing
 * `microsoft/change-notification` event per subscription reuses the exact
 * handler webhooks already drive — nothing new on the worker side.
 *
 * This is why the button only exists for Microsoft today: Zoom and WebEx
 * ingestion is webhook-only with no enumerate-everything capability wired
 * to ingestion (their `*_list_*` MCP tools call the provider directly and
 * never touch knowledge_chunks) — giving them an equivalent button would
 * mean building that backfill capability first, not just resetting a cursor.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getDatabase } from '@renkei/db';
import { webhookEventsQueue } from '@renkei/queue';
import { getSessionFromRequest } from '@/lib/session';
import { MICROSOFT } from '@renkei/provider-grants';

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ tenantId: string }> }
): Promise<NextResponse> {
  const { tenantId } = await params;
  const session = await getSessionFromRequest(request, tenantId);
  if (!session) {
    return NextResponse.json({ error: 'Not signed in' }, { status: 401 });
  }

  const dbResult = getDatabase();
  if (!dbResult.ok) {
    return NextResponse.json({ error: 'Database error' }, { status: 500 });
  }
  const db = dbResult.val;

  const grantRow = await db
    .selectFrom('provider_grants')
    .select(['provider_account_id'])
    .where('tenant_id', '=', tenantId)
    .where('provider', '=', MICROSOFT)
    .where('subject', '=', session.subject)
    .executeTakeFirst();
  if (!grantRow) {
    return NextResponse.json({ error: 'Microsoft 365 is not connected' }, { status: 400 });
  }
  const accountId = grantRow.provider_account_id;

  const subscriptions = await db
    .selectFrom('webhook_subscriptions')
    .select(['subscription_id'])
    .where('tenant_id', '=', tenantId)
    .where('provider', '=', MICROSOFT)
    .where('account_id', '=', accountId)
    .execute();
  const active = subscriptions.filter(
    (row): row is { subscription_id: string } => row.subscription_id !== null
  );
  if (active.length === 0) {
    return NextResponse.json(
      { error: 'No active subscriptions to re-index — try disconnecting and reconnecting' },
      { status: 400 }
    );
  }

  // Null the cursor first so the events below land as a fresh delta round
  // once claimed, not a no-op incremental one.
  await db
    .updateTable('webhook_subscriptions')
    .set({ delta_link: null })
    .where('tenant_id', '=', tenantId)
    .where('provider', '=', MICROSOFT)
    .where('account_id', '=', accountId)
    .execute();

  const producer = webhookEventsQueue().producer;
  for (const row of active) {
    await producer.enqueue({
      tenantId,
      source: MICROSOFT,
      type: 'change-notification',
      payload: { accountId, subscriptionId: row.subscription_id },
      // Same key shape as the Graph webhook route: one subscription's delta
      // rounds never race each other.
      orderingKey: `microsoft/${accountId}/${row.subscription_id}`,
    });
  }

  return NextResponse.json({ reindexing: active.length });
}
