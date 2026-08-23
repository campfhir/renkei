/**
 * The per-user Outlook indexing opt-in: which of mail / calendar / tasks
 * this user's grant may feed into the knowledge index. Default is OFF for
 * every category — granting a scope exists to power the interactive tools,
 * and consenting to background indexing is a separate decision this route
 * records explicitly (provider-grants/outlook-indexing.ts is the shared
 * contract the worker enforces).
 *
 * Saving triggers the same bootstrap event a fresh connect does, so an
 * opt-in starts indexing within moments rather than waiting out the
 * 15-minute subscription sweep; an opt-out is likewise applied by that
 * pass, which tears down the Graph subscription while keeping the delta
 * cursor for a cheap re-enable.
 */

import { NextRequest, NextResponse } from 'next/server';
import { sql } from 'kysely';
import { getDatabase } from '@renkei/db';
import { webhookEventsQueue } from '@renkei/queue';
import { MICROSOFT, outlookIndexingOf, OUTLOOK_INDEXING_CATEGORIES } from '@renkei/provider-grants';
import { getSessionFromRequest } from '@/lib/session';
import { logger } from '@/lib/logger';

async function grantOf(tenantId: string, subject: string) {
  const dbResult = getDatabase();
  if (!dbResult.ok) return null;
  const row = await dbResult.val
    .selectFrom('provider_grants')
    .select(['provider_account_id', 'metadata'])
    .where('tenant_id', '=', tenantId)
    .where('provider', '=', MICROSOFT)
    .where('subject', '=', subject)
    .limit(1)
    .executeTakeFirst();
  return row ?? null;
}

function metadataRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? { ...value } : {};
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ tenantId: string }> }
): Promise<NextResponse> {
  const { tenantId } = await params;
  const session = await getSessionFromRequest(request, tenantId);
  if (!session) return NextResponse.json({ error: 'Not signed in' }, { status: 401 });

  const grant = await grantOf(tenantId, session.subject);
  if (!grant) return NextResponse.json({ error: 'Microsoft is not connected' }, { status: 404 });
  return NextResponse.json({ indexing: outlookIndexingOf(metadataRecord(grant.metadata)) });
}

export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ tenantId: string }> }
): Promise<NextResponse> {
  const { tenantId } = await params;
  const session = await getSessionFromRequest(request, tenantId);
  if (!session) return NextResponse.json({ error: 'Not signed in' }, { status: 401 });

  const body: unknown = await request.json().catch(() => null);
  const requested = metadataRecord(body);
  const indexing: Record<string, boolean> = {};
  for (const category of OUTLOOK_INDEXING_CATEGORIES) {
    indexing[category] = requested[category] === true;
  }

  const grant = await grantOf(tenantId, session.subject);
  if (!grant) return NextResponse.json({ error: 'Microsoft is not connected' }, { status: 404 });

  const dbResult = getDatabase();
  if (!dbResult.ok) return NextResponse.json({ error: 'Database unavailable' }, { status: 500 });
  await dbResult.val
    .updateTable('provider_grants')
    .set({
      // A jsonb merge, not a read-modify-write: concurrent metadata writers
      // (token refresh re-deriving scopes) must not lose to this update.
      metadata: sql`metadata || jsonb_build_object('indexing', ${JSON.stringify(indexing)}::jsonb)`,
      updated_at: sql`NOW()`,
    })
    .where('tenant_id', '=', tenantId)
    .where('provider', '=', MICROSOFT)
    .where('provider_account_id', '=', grant.provider_account_id)
    .execute();

  // The same bootstrap a fresh connect enqueues: it reconciles subscriptions
  // to the new preference and runs the initial backfill for anything just
  // opted in. Best effort — the 15-minute sweep is the fallback.
  const enqueued = await webhookEventsQueue().producer.enqueue({
    tenantId,
    source: MICROSOFT,
    type: 'grant.connected',
    payload: { accountId: grant.provider_account_id, subject: session.subject },
    orderingKey: `microsoft/${grant.provider_account_id}`,
  });
  if (!enqueued.ok) {
    logger.warn('indexing prefs saved but bootstrap not enqueued; sweep will apply', {
      component: 'microsoft/indexing',
      tenantId,
      subject: session.subject,
    });
  }

  return NextResponse.json({ indexing });
}
