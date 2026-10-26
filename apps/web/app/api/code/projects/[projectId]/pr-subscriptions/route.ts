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
import { chatCipherById } from '@/lib/chat/chat-keys';
import { latestPrInTranscript } from '@/lib/code/chat-commits';
import { routeLog } from '@/lib/log-context';

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
 * The chat this subscription's auto-fix note (if any) would land in: the
 * person's own chat in the project whose most recent PR is this one — the
 * common case of subscribing right after that chat pushed it. A PR
 * subscribed to from elsewhere simply carries no chat (the worker skips
 * the note, still records the outcome and still honors auto-merge).
 */
/** How many of a person's recent chats in a project are searched for the one that opened a pull request. */
const CHATS_SEARCHED = 10;

async function chatForPr(
  db: Parameters<typeof listMessages>[0],
  projectId: string,
  subject: string,
  prNumber: number
): Promise<string | null> {
  // Chats in the project run side by side now, so the chat that opened
  // this pull request is looked for: the person's own, newest first.
  const candidates = await db
    .selectFrom('chats')
    .select('id')
    .where('project_id', '=', projectId)
    .where('owner_subject', '=', subject)
    .where('archived_at', 'is', null)
    .orderBy('updated_at', 'desc')
    .limit(CHATS_SEARCHED)
    .execute();
  for (const { id } of candidates) {
    const rows = await listMessages(db, id, await chatCipherById(db, id));
    const pr = latestPrInTranscript(rows.map(toMessageView));
    if (pr?.number === prNumber) return id;
  }
  return null;
}

function prNumberFrom(value: unknown): number | null {
  const number = typeof value === 'number' ? value : Number(value);
  return Number.isInteger(number) && number > 0 ? number : null;
}

async function GETHandler(
  request: NextRequest,
  { params }: { params: Promise<{ projectId: string }> }
): Promise<Response> {
  const { projectId } = await params;
  const ready = await codeProjectContext(request, projectId);
  if (!ready.ok) return ready.response;
  const { db, session, project } = ready.context;
  const prNumber = prNumberFrom(request.nextUrl.searchParams.get('prNumber'));
  if (!prNumber) return jsonError(400, 'invalid', 'Which pull request?');

  const row = await db
    .selectFrom('pr_subscriptions')
    .select(['id', 'watch_pipelines', 'auto_fix', 'auto_merge'])
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

async function POSTHandler(
  request: NextRequest,
  { params }: { params: Promise<{ projectId: string }> }
): Promise<Response> {
  const { projectId } = await params;
  const ready = await codeProjectContext(request, projectId);
  if (!ready.ok) return ready.response;
  const { db, session, project } = ready.context;

  const body = await readJsonBody(request);
  const prNumber = prNumberFrom(body.prNumber);
  if (!prNumber) return jsonError(400, 'invalid', 'Which pull request?');
  const watchPipelines = body.watchPipelines !== false;
  const autoFix = body.autoFix === true && watchPipelines;
  const autoMerge = body.autoMerge === true && watchPipelines;

  const chatId = await chatForPr(db, projectId, session.subject, prNumber);

  await db
    .insertInto('pr_subscriptions')
    .values({
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
      oc.columns(['provider', 'repo_full_name', 'pr_number', 'subscriber_subject']).doUpdateSet({
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

async function DELETEHandler(
  request: NextRequest,
  { params }: { params: Promise<{ projectId: string }> }
): Promise<Response> {
  const { projectId } = await params;
  const ready = await codeProjectContext(request, projectId);
  if (!ready.ok) return ready.response;
  const { db, session, project } = ready.context;

  const body = await readJsonBody(request);
  const prNumber = prNumberFrom(body.prNumber);
  if (!prNumber) return jsonError(400, 'invalid', 'Which pull request?');

  await db
    .updateTable('pr_subscriptions')
    .set({ status: 'canceled', updated_at: new Date() })
    .where('provider', '=', project.repo!.provider)
    .where('repo_full_name', '=', project.repo!.fullName)
    .where('pr_number', '=', prNumber)
    .where('subscriber_subject', '=', session.subject)
    .execute();

  return NextResponse.json({ ok: true });
}

export const GET = routeLog(GETHandler);
export const POST = routeLog(POSTHandler);
export const DELETE = routeLog(DELETEHandler);
