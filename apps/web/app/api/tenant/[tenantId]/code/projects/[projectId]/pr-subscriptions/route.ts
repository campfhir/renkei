/**
 * A person's own opt-in to hear about one pull request's pipeline
 * outcome (and, separately, to auto-merge on green or note a failure
 * into the chat that pushed it) — pr_subscriptions, matched against
 * incoming webhook deliveries by the worker
 * (apps/worker/src/handlers/pr-pipeline-events.ts). Anyone with access
 * to the project may subscribe themselves; there is no one else's
 * subscription to see or change here — GET/POST/DELETE all operate on
 * the signed-in person's own row for (project, PR).
 */

import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import type { Kysely } from 'kysely';
import type { DB } from '@renkei/db';
import { jsonError, readJsonBody } from '@/lib/chat/route-support';
import { codeProjectContext } from '@/lib/code/route-access';
import { listMessages, toMessageView } from '@/lib/chat/messages';
import { latestPrInTranscript } from '@/lib/code/chat-commits';

interface EventView {
  conclusion: string;
  actionTaken: string | null;
  observedAt: string;
}

async function latestEvent(db: Kysely<DB>, subscriptionId: string): Promise<EventView | null> {
  const row = await db
    .selectFrom('pr_pipeline_events')
    .select(['conclusion', 'action_taken', 'observed_at'])
    .where('subscription_id', '=', subscriptionId)
    .orderBy('observed_at', 'desc')
    .executeTakeFirst();
  return row
    ? {
        conclusion: row.conclusion,
        actionTaken: row.action_taken,
        observedAt: row.observed_at.toISOString(),
      }
    : null;
}

interface SubscriptionView {
  watchPipelines: boolean;
  autoFix: boolean;
  autoMerge: boolean;
}

/**
 * The chat this subscription's auto-fix note (if any) would land in:
 * the project's active chat, when its own most recent PR is this one —
 * the common case of subscribing right after that chat pushed it.
 * There is no project-wide index of "which chat made which PR," so a
 * PR subscribed to from elsewhere in the project's history simply
 * carries no chat (the worker skips the note, still records the
 * outcome and still honors auto-merge).
 */
async function chatForPr(
  db: Parameters<typeof listMessages>[0],
  tenantId: string,
  activeChatId: string | null,
  prNumber: number
): Promise<string | null> {
  if (!activeChatId) return null;
  const rows = await listMessages(db, tenantId, activeChatId);
  const pr = latestPrInTranscript(rows.map(toMessageView));
  return pr?.number === prNumber ? activeChatId : null;
}

function prNumberFrom(value: unknown): number | null {
  const number = typeof value === 'number' ? value : Number(value);
  return Number.isInteger(number) && number > 0 ? number : null;
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ tenantId: string; projectId: string }> }
): Promise<Response> {
  const { tenantId, projectId } = await params;
  const ready = await codeProjectContext(request, tenantId, projectId);
  if (!ready.ok) return ready.response;
  const { db, session, project } = ready.context;
  const prNumber = prNumberFrom(request.nextUrl.searchParams.get('prNumber'));
  if (!prNumber) return jsonError(400, 'invalid', 'Which pull request?');

  const row = await db
    .selectFrom('pr_subscriptions')
    .select(['id', 'watch_pipelines', 'auto_fix', 'auto_merge'])
    .where('tenant_id', '=', tenantId)
    .where('provider', '=', project.repo!.provider)
    .where('repo_full_name', '=', project.repo!.fullName)
    .where('pr_number', '=', prNumber)
    .where('subscriber_subject', '=', session.subject)
    .where('status', '=', 'active')
    .executeTakeFirst();

  if (!row) return NextResponse.json({ subscription: null, lastEvent: null });

  const subscription: SubscriptionView = {
    watchPipelines: row.watch_pipelines,
    autoFix: row.auto_fix,
    autoMerge: row.auto_merge,
  };
  const lastEvent = await latestEvent(db, row.id);
  return NextResponse.json({ subscription, lastEvent });
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ tenantId: string; projectId: string }> }
): Promise<Response> {
  const { tenantId, projectId } = await params;
  const ready = await codeProjectContext(request, tenantId, projectId);
  if (!ready.ok) return ready.response;
  const { db, session, project } = ready.context;

  const body = await readJsonBody(request);
  const prNumber = prNumberFrom(body.prNumber);
  if (!prNumber) return jsonError(400, 'invalid', 'Which pull request?');
  const watchPipelines = body.watchPipelines !== false;
  const autoFix = body.autoFix === true && watchPipelines;
  const autoMerge = body.autoMerge === true && watchPipelines;

  const chatId = await chatForPr(db, tenantId, project.activeChatId, prNumber);

  await db
    .insertInto('pr_subscriptions')
    .values({
      tenant_id: tenantId,
      project_id: projectId,
      chat_id: chatId,
      subscriber_subject: session.subject,
      provider: project.repo!.provider,
      repo_full_name: project.repo!.fullName,
      pr_number: prNumber,
      watch_pipelines: watchPipelines,
      auto_fix: autoFix,
      auto_merge: autoMerge,
      status: 'active',
    })
    .onConflict((oc) =>
      oc
        .columns(['tenant_id', 'provider', 'repo_full_name', 'pr_number', 'subscriber_subject'])
        .doUpdateSet({
          chat_id: chatId,
          watch_pipelines: watchPipelines,
          auto_fix: autoFix,
          auto_merge: autoMerge,
          status: 'active',
          updated_at: new Date(),
        })
    )
    .execute();

  const subscription: SubscriptionView = { watchPipelines, autoFix, autoMerge };
  return NextResponse.json({ subscription });
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ tenantId: string; projectId: string }> }
): Promise<Response> {
  const { tenantId, projectId } = await params;
  const ready = await codeProjectContext(request, tenantId, projectId);
  if (!ready.ok) return ready.response;
  const { db, session, project } = ready.context;

  const body = await readJsonBody(request);
  const prNumber = prNumberFrom(body.prNumber);
  if (!prNumber) return jsonError(400, 'invalid', 'Which pull request?');

  await db
    .updateTable('pr_subscriptions')
    .set({ status: 'canceled', updated_at: new Date() })
    .where('tenant_id', '=', tenantId)
    .where('provider', '=', project.repo!.provider)
    .where('repo_full_name', '=', project.repo!.fullName)
    .where('pr_number', '=', prNumber)
    .where('subscriber_subject', '=', session.subject)
    .execute();

  return NextResponse.json({ ok: true });
}
