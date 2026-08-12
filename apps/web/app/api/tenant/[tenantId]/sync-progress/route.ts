/**
 * Background indexing progress for the signed-in user's own connectors.
 *
 * Syncing is otherwise invisible: a user connects a mailbox or watches a
 * space, nothing appears to happen for several minutes, and there is no way
 * to tell "still working" from "broken". These are running counts, never a
 * percentage — no provider tells you up front how many items a delta or a
 * space will yield, so a denominator would be fiction.
 *
 * Strictly the caller's own rows: Microsoft subscriptions belong to their
 * grant, watches to their subject. An admin who wants a fleet view has the
 * admin surfaces; this is the "is my stuff working" answer.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getDatabase } from '@renkei/db';
import { MICROSOFT } from '@renkei/provider-grants';
import { getSessionFromRequest } from '@/lib/session';

export interface SyncProgressItem {
  label: string;
  /** 'idle' | 'syncing' | 'error' | 'paused' */
  status: string;
  lastSyncedAt: string | null;
  lastRunItems: number;
  totalItems: number;
  error: string | null;
}

/** A Graph resource path as something a person recognizes. */
function microsoftLabel(resource: string): string {
  if (resource.includes('/messages')) return 'Mail (inbox)';
  if (resource.includes('/events')) return 'Calendar';
  if (resource.includes('/tasks')) return 'To Do';
  return resource;
}

function iso(value: Date | string | null): string | null {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ tenantId: string }> }
): Promise<NextResponse> {
  const { tenantId } = await params;

  const session = await getSessionFromRequest(request, tenantId);
  if (!session) return NextResponse.json({ error: 'Not signed in' }, { status: 401 });

  const dbResult = getDatabase();
  if (!dbResult.ok) return NextResponse.json({ error: 'Database error' }, { status: 500 });
  const db = dbResult.val;

  // The Microsoft grant identifies which subscription rows are this user's;
  // webhook_subscriptions is keyed by provider account, not by subject.
  const microsoftGrant = await db
    .selectFrom('provider_grants')
    .select('provider_account_id')
    .where('tenant_id', '=', tenantId)
    .where('provider', '=', MICROSOFT)
    .where('subject', '=', session.subject)
    .executeTakeFirst();

  const [subscriptions, watches] = await Promise.all([
    microsoftGrant
      ? db
          .selectFrom('webhook_subscriptions')
          .select([
            'resource',
            'last_synced_at',
            'last_run_items',
            'total_items',
            'sync_status',
            'delta_link',
          ])
          .where('tenant_id', '=', tenantId)
          .where('provider', '=', MICROSOFT)
          .where('account_id', '=', microsoftGrant.provider_account_id)
          .orderBy('resource', 'asc')
          .execute()
      : Promise.resolve([]),
    db
      .selectFrom('content_watches')
      .select([
        'provider',
        'scope_key',
        'scope_label',
        'enabled',
        'last_synced_at',
        'last_run_items',
        'total_items',
        'sync_status',
        'last_error',
      ])
      .where('tenant_id', '=', tenantId)
      .where('subject', '=', session.subject)
      .orderBy('scope_key', 'asc')
      .execute(),
  ]);

  const microsoft: SyncProgressItem[] = subscriptions.map((row) => ({
    label: microsoftLabel(row.resource),
    // A row with no delta cursor yet has never completed a round, which
    // reads as "still working" rather than idle — otherwise a mailbox that
    // has been churning for ten minutes claims to be done.
    status: row.last_synced_at || row.delta_link ? row.sync_status : 'syncing',
    lastSyncedAt: iso(row.last_synced_at),
    lastRunItems: row.last_run_items,
    totalItems: row.total_items,
    error: null,
  }));

  const byProvider = (provider: string): SyncProgressItem[] =>
    watches
      .filter((row) => row.provider === provider)
      .map((row) => ({
        label: row.scope_label ? `${row.scope_label} (${row.scope_key})` : row.scope_key,
        status: row.enabled ? (row.last_synced_at ? row.sync_status : 'syncing') : 'paused',
        lastSyncedAt: iso(row.last_synced_at),
        lastRunItems: row.last_run_items,
        totalItems: row.total_items,
        error: row.last_error,
      }));

  return NextResponse.json({
    microsoft,
    jira: byProvider('jira'),
    confluence: byProvider('confluence'),
  });
}
