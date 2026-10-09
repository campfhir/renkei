/**
 * Background indexing progress for the signed-in user's own connectors.
 *
 * Syncing is otherwise invisible: a user connects a mailbox or watches a
 * space, nothing appears to happen for several minutes, and there is no way
 * to tell "still working" from "broken". These are running counts, never a
 * percentage — no provider tells you up front how many items a delta or a
 * space will yield, so a denominator would be fiction.
 *
 * Strictly the caller's own rows: watches belong to their subject. An admin
 * who wants a fleet view has the admin surfaces; this is the "is my stuff
 * working" answer.
 *
 * Nothing Microsoft is listed: the only Outlook subscription left is the
 * inbox trigger feed, which indexes nothing — mail, calendar and To Do are
 * personal and never enter the index — so "N indexed" beside it would be
 * false. SharePoint libraries report through the watch manager.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getDatabase } from '@renkei/db';
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

function iso(value: Date | string | null): string | null {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ tenantId: string }> }
): Promise<NextResponse> {

  const session = await getSessionFromRequest(request, tenantId);
  if (!session) return NextResponse.json({ error: 'Not signed in' }, { status: 401 });

  const dbResult = getDatabase();
  if (!dbResult.ok) return NextResponse.json({ error: 'Database error' }, { status: 500 });
  const db = dbResult.val;

  const watches = await db
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
    .where('subject', '=', session.subject)
    .orderBy('scope_key', 'asc')
    .execute();

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
    jira: byProvider('jira'),
    confluence: byProvider('confluence'),
  });
}
