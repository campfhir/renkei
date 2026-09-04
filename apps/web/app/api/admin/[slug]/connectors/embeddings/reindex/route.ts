/**
 * Admin-started knowledge reindex: the buttons on the Embeddings card.
 *
 * POST `{ kind }` (action defaults to 'start') creates a
 * `knowledge_reindex_runs` row and enqueues the first `knowledge/reindex.batch`
 * link on the embedding queue; the embedding worker chains the rest
 * (apps/worker/src/handlers/knowledge-reindex.ts) and records progress on
 * the row, which GET reads back. The web process itself touches no
 * embeddings endpoint and no model — it only asks.
 *
 * One active run per kind per org: a second 'start' click while one is
 * running is answered 409 rather than doubled, since two chains over the
 * same rows would do the same work twice and race on the tallies.
 *
 * POST `{ kind, action: 'pause', runId }` stops the chain after its
 * in-flight link (apps/worker's handler re-checks status before enqueuing
 * the next one) without discarding progress. POST
 * `{ kind, action: 'resume', runId }` picks a paused or failed run back up
 * from its own stored `cursor` — the whole point: `embed` is the one kind
 * where a fresh run at cursor null would silently redo every chunk this run
 * already got through (a rate limit stopping a run partway is the case that
 * motivated this — see knowledge-reindex.ts). `lexical` and `keywords` have
 * no real cursor (they self-select remaining rows by what is still NULL),
 * so resuming them just re-enters the same idempotent sweep a fresh run
 * would.
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

/** Say up front what the worker would otherwise discover one link in. */
async function unmetPrerequisite(tenantId: string, kind: ReindexKind): Promise<string | null> {
  if (kind === 'embed' && !(await resolveEmbeddingProvider(tenantId))) {
    return 'No embedding provider is configured; save one above first.';
  }
  if (kind === 'keywords') {
    const settings = await getOrgSettings(tenantId);
    if (!settings.ok || !settings.val.knowledgeKeywordEnrichment) {
      return 'Keyword enrichment is off for this organization (Settings → Knowledge search).';
    }
  }
  return null;
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
  const rawAction = typeof body === 'object' && body !== null ? Reflect.get(body, 'action') : undefined;
  const action = rawAction === 'pause' || rawAction === 'resume' ? rawAction : 'start';
  const rawRunId = typeof body === 'object' && body !== null ? Reflect.get(body, 'runId') : undefined;
  const runId = typeof rawRunId === 'string' ? rawRunId : '';
  if (action !== 'start' && !runId) {
    return NextResponse.json({ error: 'runId is required.' }, { status: 400 });
  }

  const dbResult = getDatabase();
  if (!dbResult.ok) return NextResponse.json({ error: 'Database error' }, { status: 500 });
  const db = dbResult.val;

  if (action === 'pause') {
    const updated = await db
      .updateTable('knowledge_reindex_runs')
      .set({ status: 'paused' })
      .where('id', '=', runId)
      .where('tenant_id', '=', tenant.id)
      .where('kind', '=', kind)
      .where('status', 'in', ['queued', 'running'])
      .executeTakeFirst();
    if (Number(updated.numUpdatedRows ?? 0) === 0) {
      return NextResponse.json({ error: `No active ${kind} reindex to pause.` }, { status: 409 });
    }
    recordAuditEvent({
      tenantId: tenant.id,
      actorSubject: access.subject,
      action: 'knowledge.reindex.paused',
      targetKind: 'knowledge',
      details: { kind, runId },
    });
    return NextResponse.json({ runs: await listRuns(tenant.id) });
  }

  if (action === 'resume') {
    const unmet = await unmetPrerequisite(tenant.id, kind);
    if (unmet) return NextResponse.json({ error: unmet }, { status: 400 });

    const run = await db
      .selectFrom('knowledge_reindex_runs')
      .select(['status', 'cursor'])
      .where('id', '=', runId)
      .where('tenant_id', '=', tenant.id)
      .where('kind', '=', kind)
      .executeTakeFirst();
    if (!run || (run.status !== 'paused' && run.status !== 'failed')) {
      return NextResponse.json(
        { error: `No paused or failed ${kind} reindex to resume.` },
        { status: 409 }
      );
    }

    const updated = await db
      .updateTable('knowledge_reindex_runs')
      .set({ status: 'queued', last_error: null, finished_at: null })
      .where('id', '=', runId)
      .where('status', 'in', ['paused', 'failed'])
      .executeTakeFirst();
    if (Number(updated.numUpdatedRows ?? 0) === 0) {
      return NextResponse.json(
        { error: `No paused or failed ${kind} reindex to resume.` },
        { status: 409 }
      );
    }

    const enqueued = await embeddingJobsQueue().producer.enqueue({
      tenantId: tenant.id,
      source: 'knowledge:reindex',
      type: 'reindex.batch',
      payload: { provider: 'reindex', runId, kind, ...(run.cursor ? { cursor: run.cursor } : {}) },
      orderingKey: `reindex/${tenant.id}/${runId}`,
    });
    if (!enqueued.ok) {
      await db
        .updateTable('knowledge_reindex_runs')
        .set({ status: 'failed', last_error: 'could not enqueue the resumed batch' })
        .where('id', '=', runId)
        .execute();
      return NextResponse.json({ error: 'Could not resume the reindex.' }, { status: 500 });
    }

    recordAuditEvent({
      tenantId: tenant.id,
      actorSubject: access.subject,
      action: 'knowledge.reindex.resumed',
      targetKind: 'knowledge',
      details: { kind, runId, cursor: run.cursor },
    });
    return NextResponse.json({ runs: await listRuns(tenant.id) });
  }

  const unmet = await unmetPrerequisite(tenant.id, kind);
  if (unmet) return NextResponse.json({ error: unmet }, { status: 400 });

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

  const newRunId = randomUUID();
  await db
    .insertInto('knowledge_reindex_runs')
    .values({ id: newRunId, tenant_id: tenant.id, kind, requested_by: access.subject })
    .execute();

  const enqueued = await embeddingJobsQueue().producer.enqueue({
    tenantId: tenant.id,
    source: 'knowledge:reindex',
    type: 'reindex.batch',
    payload: { provider: 'reindex', runId: newRunId, kind },
    orderingKey: `reindex/${tenant.id}/${newRunId}`,
  });
  if (!enqueued.ok) {
    await db
      .updateTable('knowledge_reindex_runs')
      .set({ status: 'failed', last_error: 'could not enqueue the first batch' })
      .where('id', '=', newRunId)
      .execute();
    return NextResponse.json({ error: 'Could not start the reindex.' }, { status: 500 });
  }

  recordAuditEvent({
    tenantId: tenant.id,
    actorSubject: access.subject,
    action: 'knowledge.reindex.started',
    targetKind: 'knowledge',
    details: { kind, runId: newRunId },
  });

  return NextResponse.json({ runs: await listRuns(tenant.id) });
}
