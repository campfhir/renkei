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
import { getDataStore, type PrSubscriptionKey } from '@renkei/db';
import { jsonError, readJsonBody } from '@/lib/chat/route-support';
import { codeProjectContext } from '@/lib/code/route-access';
import { listMessages, toMessageView } from '@/lib/chat/messages';
import { chatCipherById } from '@/lib/chat/chat-keys';
import { latestPrInTranscript } from '@/lib/code/chat-commits';
import type { ProjectRow } from '@/lib/chat/projects';

interface EventView {
  conclusion: string;
  actionTaken: string | null;
  observedAt: string;
}

async function latestEvent(subscriptionId: string): Promise<EventView | null> {
  const row = await getDataStore().codeProjects.latestPrPipelineEvent(subscriptionId);
  return row
    ? {
        conclusion: row.conclusion,
        actionTaken: row.actionTaken,
        observedAt: row.observedAt.toISOString(),
      }
    : null;
}

interface SubscriptionView {
  watchPipelines: boolean;
  autoFix: boolean;
  autoMerge: boolean;
}

/** The (project's repository, PR, signed-in person) a subscription is keyed by. */
function keyOf(project: ProjectRow, prNumber: number, subject: string): PrSubscriptionKey {
  return {
    provider: project.repo!.provider,
    repoFullName: project.repo!.fullName,
    prNumber,
    subscriberSubject: subject,
  };
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
  projectId: string,
  subject: string,
  prNumber: number
): Promise<string | null> {
  // Chats in the project run side by side now, so the chat that opened
  // this pull request is looked for: the person's own, newest first.
  const candidates = await getDataStore().chats.listOwnedInProject(
    subject,
    projectId,
    CHATS_SEARCHED
  );
  for (const { id } of candidates) {
    const rows = await listMessages(id, await chatCipherById(id));
    const pr = latestPrInTranscript(rows.map(toMessageView));
    if (pr?.number === prNumber) return id;
  }
  return null;
}

function prNumberFrom(value: unknown): number | null {
  const number = typeof value === 'number' ? value : Number(value);
  return Number.isInteger(number) && number > 0 ? number : null;
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ projectId: string }> }
): Promise<Response> {
  const { projectId } = await params;
  const ready = await codeProjectContext(request, projectId);
  if (!ready.ok) return ready.response;
  const { session, project } = ready.context;
  const prNumber = prNumberFrom(request.nextUrl.searchParams.get('prNumber'));
  if (!prNumber) return jsonError(400, 'invalid', 'Which pull request?');

  const row = await getDataStore().codeProjects.getActivePrSubscription(
    keyOf(project, prNumber, session.subject)
  );

  if (!row) return NextResponse.json({ subscription: null, lastEvent: null });

  const subscription: SubscriptionView = {
    watchPipelines: row.watchPipelines,
    autoFix: row.autoFix,
    autoMerge: row.autoMerge,
  };
  const lastEvent = await latestEvent(row.id);
  return NextResponse.json({ subscription, lastEvent });
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ projectId: string }> }
): Promise<Response> {
  const { projectId } = await params;
  const ready = await codeProjectContext(request, projectId);
  if (!ready.ok) return ready.response;
  const { session, project } = ready.context;

  const body = await readJsonBody(request);
  const prNumber = prNumberFrom(body.prNumber);
  if (!prNumber) return jsonError(400, 'invalid', 'Which pull request?');
  const watchPipelines = body.watchPipelines !== false;
  const autoFix = body.autoFix === true && watchPipelines;
  const autoMerge = body.autoMerge === true && watchPipelines;

  const chatId = await chatForPr(projectId, session.subject, prNumber);

  await getDataStore().codeProjects.savePrSubscription({
    ...keyOf(project, prNumber, session.subject),
    projectId,
    chatId,
    watchPipelines,
    autoFix,
    autoMerge,
  });

  const subscription: SubscriptionView = { watchPipelines, autoFix, autoMerge };
  return NextResponse.json({ subscription });
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ projectId: string }> }
): Promise<Response> {
  const { projectId } = await params;
  const ready = await codeProjectContext(request, projectId);
  if (!ready.ok) return ready.response;
  const { session, project } = ready.context;

  const body = await readJsonBody(request);
  const prNumber = prNumberFrom(body.prNumber);
  if (!prNumber) return jsonError(400, 'invalid', 'Which pull request?');

  await getDataStore().codeProjects.cancelPrSubscription(keyOf(project, prNumber, session.subject));

  return NextResponse.json({ ok: true });
}
