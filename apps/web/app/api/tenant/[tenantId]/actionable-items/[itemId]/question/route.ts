/**
 * Answering an `ask_person` card — the web feed's half of a paused agent
 * run, and the `'question'` sibling of the approval route.
 *
 * The claim semantics live in `lib/agents/approvals.ts`, shared with the
 * MCP tools. See that route's doc comment for the two rules worth
 * restating: a concurrent decision loses with 409 rather than silently
 * overwriting one that stands, and a failed enqueue is 502 with "will
 * resume automatically" rather than a rollback.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getDatabase } from '@renkei/db';
import { agentJobsQueue } from '@renkei/queue';
import { getSessionFromRequest } from '@/lib/session';
import { answerQuestion } from '@/lib/agents/approvals';

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
  // { answers: { <fieldName>: string | string[] } }; the shape is checked
  // against the card's own form in answerQuestion, the only place that has it.
  const answers = isRecord(body) && isRecord(body.answers) ? body.answers : {};

  const dbResult = getDatabase();
  if (!dbResult.ok) {
    return NextResponse.json({ error: 'Database error' }, { status: 500 });
  }

  const result = await answerQuestion(
    dbResult.val,
    agentJobsQueue().producer,
    tenantId,
    session.subject,
    { cardId: itemId, answers }
  );

  switch (result.outcome) {
    case 'invalid-answers':
      // 422: the request was understood and the form was not satisfied.
      // Per-field messages travel with it — the card marks the controls.
      return NextResponse.json(
        { error: 'Some answers need another look.', issues: result.issues },
        { status: 422 }
      );
    case 'not-found':
      return NextResponse.json({ error: 'Item not found' }, { status: 404 });
    case 'not-question':
      return NextResponse.json(
        { error: 'This card is not a question — use its regular decision controls' },
        { status: 422 }
      );
    case 'already-decided':
      return NextResponse.json(
        {
          error:
            result.status === 'decided'
              ? 'Item was already answered'
              : `Item is already ${result.status}`,
        },
        { status: 409 }
      );
    case 'answered':
      return result.resumed
        ? NextResponse.json({ status: 'answered' })
        : NextResponse.json(
            {
              status: 'answered',
              warning: 'Your answer is saved; the run will resume automatically shortly.',
            },
            { status: 502 }
          );
  }
}
