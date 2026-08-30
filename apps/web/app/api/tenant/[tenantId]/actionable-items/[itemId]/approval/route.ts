/**
 * Deciding an approval card — the web feed's half of a paused agent run.
 *
 * The claim semantics live in `lib/agents/approvals.ts`, shared with the
 * MCP tools that offer the same decision to a caller who is not looking at
 * the feed. This route is the HTTP shape over them: which outcome is which
 * status code, and the session that says who is deciding.
 *
 * The two rules worth restating where they are read: the loser of a
 * concurrent decision sees 409 rather than overwriting a decision that
 * already stands, and a failed enqueue is 502 with "will resume
 * automatically" — the claim is durable and the approval sweep picks the
 * run up, so a rollback would be the lie.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getDatabase } from '@renkei/db';
import { agentJobsQueue } from '@renkei/queue';
import { getSessionFromRequest } from '@/lib/session';
import { decideApproval, MAX_APPROVAL_ANSWER_CHARS } from '@/lib/agents/approvals';

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
    return NextResponse.json({ error: "decision must be 'approve' or 'decline'" }, { status: 400 });
  }
  const answer = typeof body.answer === 'string' ? body.answer : '';
  // A form card posts { answers: { <fieldId>: string | string[] } }; the
  // shape is checked against the card's own spec in decideApproval, which
  // is the only place that has it.
  const answers = isRecord(body.answers) ? body.answers : undefined;

  const dbResult = getDatabase();
  if (!dbResult.ok) {
    return NextResponse.json({ error: 'Database error' }, { status: 500 });
  }

  const result = await decideApproval(
    dbResult.val,
    agentJobsQueue().producer,
    tenantId,
    session.subject,
    { cardId: itemId, decision: body.decision, answer, answers }
  );

  switch (result.outcome) {
    case 'invalid-answers':
      // 422: the request was understood and the form was not satisfied.
      // Per-field messages travel with it — the card marks the controls.
      return NextResponse.json(
        {
          error: 'Some answers need another look.',
          issues: result.issues,
        },
        { status: 422 }
      );
    case 'answer-too-long':
      return NextResponse.json(
        { error: `answer must stay under ${MAX_APPROVAL_ANSWER_CHARS} characters` },
        { status: 413 }
      );
    case 'not-found':
      return NextResponse.json({ error: 'Item not found' }, { status: 404 });
    case 'not-approval':
      return NextResponse.json(
        { error: 'This card is not an approval — use its regular decision controls' },
        { status: 422 }
      );
    case 'already-decided':
      return NextResponse.json(
        {
          error:
            result.status === 'decided'
              ? 'Item was already decided'
              : `Item is already ${result.status}`,
        },
        { status: 409 }
      );
    case 'decided': {
      const status = result.decision === 'approve' ? 'approved' : 'declined';
      return result.resumed
        ? NextResponse.json({ status })
        : NextResponse.json(
            {
              status,
              warning: 'Your decision is saved; the run will resume automatically shortly.',
            },
            { status: 502 }
          );
    }
  }
}
