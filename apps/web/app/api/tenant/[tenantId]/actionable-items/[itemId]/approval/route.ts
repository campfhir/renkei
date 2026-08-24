/**
 * Deciding an approval card — the human half of a paused agent run.
 *
 * The card's optimistic `suggested → approved|declined` claim is the SINGLE
 * arbiter (the engine and the timeout sweep race through the same UPDATE):
 * the loser of a concurrent decision sees 409. The claim also archives the
 * card, so the feed self-cleans. Run-status transitions belong to the
 * ENGINE alone — this route only claims the card and enqueues {runId}; the
 * worker reads the card and routes the outcome path. If the enqueue fails,
 * the decision STANDS (the claim is durable) and the approval sweep's
 * decided-but-stuck arm resumes the run within minutes — hence 502 with
 * "will resume automatically", never a rollback.
 */

import { NextRequest, NextResponse } from 'next/server';
import { sql } from 'kysely';
import { getDatabase } from '@renkei/db';
import { agentJobsQueue } from '@renkei/queue';
import { getSessionFromRequest } from '@/lib/session';

const MAX_ANSWER_CHARS = 10_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ tenantId: string; itemId: string }> }
): Promise<NextResponse> {
  const { tenantId, itemId } = await params;

  const session = await getSessionFromRequest(request, tenantId);
  if (!session) {
    return NextResponse.json({ error: 'Not signed in' }, { status: 401 });
  }

  const body: unknown = await request.json().catch(() => null);
  if (!isRecord(body) || (body.decision !== 'approve' && body.decision !== 'decline')) {
    return NextResponse.json(
      { error: "decision must be 'approve' or 'decline'" },
      { status: 400 }
    );
  }
  const answer = typeof body.answer === 'string' ? body.answer.trim() : '';
  if (answer.length > MAX_ANSWER_CHARS) {
    return NextResponse.json(
      { error: `answer must stay under ${MAX_ANSWER_CHARS} characters` },
      { status: 413 }
    );
  }

  const dbResult = getDatabase();
  if (!dbResult.ok) {
    return NextResponse.json({ error: 'Database error' }, { status: 500 });
  }
  const db = dbResult.val;

  // Approval cards are always owner-scoped (the engine writes owner_subject
  // = the run's owner), so someone else's card is 404 here — not decidable.
  const item = await db
    .selectFrom('actionable_items')
    .select(['id', 'kind', 'status', 'run_id'])
    .where('id', '=', itemId)
    .where('tenant_id', '=', tenantId)
    .where('owner_subject', '=', session.subject)
    .executeTakeFirst();
  if (!item) {
    return NextResponse.json({ error: 'Item not found' }, { status: 404 });
  }
  if (item.kind !== 'approval' || !item.run_id) {
    return NextResponse.json(
      { error: 'This card is not an approval — use its regular decision controls' },
      { status: 422 }
    );
  }
  if (item.status !== 'suggested') {
    return NextResponse.json({ error: `Item is already ${item.status}` }, { status: 409 });
  }

  // The optimistic claim: exactly one decider wins; decided beats expired.
  const claimed = await db
    .updateTable('actionable_items')
    .set({
      status: body.decision === 'approve' ? 'approved' : 'declined',
      result: JSON.stringify({
        ...(answer ? { answer } : {}),
        decidedBy: session.subject,
      }),
      decided_by: session.subject,
      decided_at: sql`NOW()`,
      archived_at: sql`NOW()`,
      archived_by: session.subject,
      updated_at: sql`NOW()`,
    })
    .where('id', '=', itemId)
    .where('status', '=', 'suggested')
    .executeTakeFirst();
  if (Number(claimed.numUpdatedRows ?? 0) === 0) {
    return NextResponse.json({ error: 'Item was already decided' }, { status: 409 });
  }

  // Wake the run. The ordering key serializes with the agent's other jobs —
  // the same key every enqueue of this run uses.
  const run = await db
    .selectFrom('agent_runs')
    .select(['id', 'agent_id'])
    .where('id', '=', item.run_id)
    .where('tenant_id', '=', tenantId)
    .executeTakeFirst();
  const enqueue = run
    ? await agentJobsQueue().producer.enqueue({
        tenantId,
        source: `agents:${run.agent_id}`,
        type: 'run',
        payload: { runId: run.id },
        orderingKey: `agent:${run.agent_id}`,
      })
    : null;
  if (!enqueue || !enqueue.ok) {
    // The decision is recorded; the sweep's decided-but-stuck arm picks the
    // run up shortly. Truthful status, no rollback.
    return NextResponse.json(
      {
        status: body.decision === 'approve' ? 'approved' : 'declined',
        warning: 'Your decision is saved; the run will resume automatically shortly.',
      },
      { status: 502 }
    );
  }
  return NextResponse.json({
    status: body.decision === 'approve' ? 'approved' : 'declined',
  });
}
