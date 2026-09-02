/**
 * Admin-started knowledge reindex: the buttons on the Embeddings card.
 *
 * POST creates a `knowledge_reindex_runs` row and enqueues the first
 * `knowledge/reindex.batch` link on the embedding queue; the embedding
 * worker chains the rest (apps/worker/src/handlers/knowledge-reindex.ts)
 * and records progress on the row, which GET reads back. The web process
 * itself touches no embeddings endpoint and no model — it only asks.
 *
 * One active run per kind per org: a second click while one is running
 * is answered 409 rather than doubled, since two chains over the same rows
 * would do the same work twice and race on the tallies.
 */

import { randomUUID } from 'node:crypto';
import { NextRequest, NextResponse } from 'next/server';
import { getDatabase } from '@renkei/db';
import { embeddingJobsQueue } from '@renkei/queue';
import { getOrgSettings } from '@renkei/settings';
import { isReindexKind, REINDEX_KINDS, resolveEmbeddingProvider } from '@renkei/knowledge';
import type { ReindexKind } from '@renkei/knowledge';
import { checkAccess, ROLE_OPERATOR } from '@/lib/access';
import { tenantForSlug } from '@/lib/tenant-slug';
import { recordAuditEvent } from '@/lib/audit-events';

/** Runs listed back, newest first — enough to show each kind's latest. */
const RECENT_RUNS = 12;

export interface ReindexRunView {
  id: string;
  kind: ReindexKind;
  status: string;
  processed: number;
  skipped: number;
  failed: number;
  lastError: string | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}

function iso(value: Date | string | null): string | null {
  if (value === null) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

async function listRuns(tenantId: string): Promise<ReindexRunView[]> {
  const dbResult = getDatabase();
  if (!dbResult.ok) return [];
  const rows = await dbResult.val
    .selectFrom('knowledge_reindex_runs')
    .select([
      'id',
      'kind',
      'status',
      'processed',
      'skipped',
      'failed',
      'last_error',
      'created_at',
      'started_at',
      'finished_at',
    ])
    .where('tenant_id', '=', tenantId)
    .orderBy('created_at', 'desc')
    .limit(RECENT_RUNS)
    .execute();
  return rows.flatMap((row) =>
    isReindexKind(row.kind)
      ? [
          {
            id: row.id,
            kind: row.kind,
            status: row.status,
            processed: row.processed,
            skipped: row.skipped,
            failed: row.failed,
            lastError: row.last_error,
            createdAt: iso(row.created_at) ?? '',
            startedAt: iso(row.started_at),
            finishedAt: iso(row.finished_at),
          },
        ]
      : []
  );
}

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ slug: string }> }
): Promise<NextResponse> {
  const { slug } = await params;
  const tenant = await tenantForSlug(slug);
  if (!tenant) return NextResponse.json({ error: 'Tenant not found' }, { status: 404 });
  if (!(await checkAccess(tenant.id, [ROLE_OPERATOR]))) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  return NextResponse.json({ runs: await listRuns(tenant.id) });
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ slug: string }> }
): Promise<NextResponse> {
  const { slug } = await params;
  const tenant = await tenantForSlug(slug);
  if (!tenant) return NextResponse.json({ error: 'Tenant not found' }, { status: 404 });
  const access = await checkAccess(tenant.id, [ROLE_OPERATOR]);
  if (!access) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const body: unknown = await request.json().catch(() => null);
  const kind = typeof body === 'object' && body !== null ? Reflect.get(body, 'kind') : undefined;
  if (!isReindexKind(kind)) {
    return NextResponse.json(
      { error: `kind must be one of: ${REINDEX_KINDS.join(', ')}` },
      { status: 400 }
    );
  }

  // Say up front what the worker would otherwise discover one link in.
  if (kind === 'embed' && !(await resolveEmbeddingProvider(tenant.id))) {
    return NextResponse.json(
      { error: 'No embedding provider is configured; save one above first.' },
      { status: 400 }
    );
  }
  if (kind === 'keywords') {
    const settings = await getOrgSettings(tenant.id);
    if (!settings.ok || !settings.val.knowledgeKeywordEnrichment) {
      return NextResponse.json(
        { error: 'Keyword enrichment is off for this organization (Settings → Knowledge search).' },
        { status: 400 }
      );
    }
  }

  const dbResult = getDatabase();
  if (!dbResult.ok) return NextResponse.json({ error: 'Database error' }, { status: 500 });
  const db = dbResult.val;

  const active = await db
    .selectFrom('knowledge_reindex_runs')
    .select('id')
    .where('tenant_id', '=', tenant.id)
    .where('kind', '=', kind)
    .where('status', 'in', ['queued', 'running'])
    .executeTakeFirst();
  if (active) {
    return NextResponse.json({ error: `A ${kind} reindex is already running.` }, { status: 409 });
  }

  const runId = randomUUID();
  await db
    .insertInto('knowledge_reindex_runs')
    .values({ id: runId, tenant_id: tenant.id, kind, requested_by: access.subject })
    .execute();

  const enqueued = await embeddingJobsQueue().producer.enqueue({
    tenantId: tenant.id,
    source: 'knowledge:reindex',
    type: 'reindex.batch',
    payload: { provider: 'reindex', runId, kind },
    orderingKey: `reindex/${tenant.id}/${runId}`,
  });
  if (!enqueued.ok) {
    await db
      .updateTable('knowledge_reindex_runs')
      .set({ status: 'failed', last_error: 'could not enqueue the first batch' })
      .where('id', '=', runId)
      .execute();
    return NextResponse.json({ error: 'Could not start the reindex.' }, { status: 500 });
  }

  recordAuditEvent({
    tenantId: tenant.id,
    actorSubject: access.subject,
    action: 'knowledge.reindex.started',
    targetKind: 'knowledge',
    details: { kind, runId },
  });

  return NextResponse.json({ runs: await listRuns(tenant.id) });
}
