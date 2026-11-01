/**
 * The approval gate on a curated card (RENKEI.md: suggest, then act on
 * approval). A decision is terminal: only a 'suggested' item can be decided,
 * the decider's OIDC subject and the time are recorded, and an approval
 * executes the suggested action as the approver — with the outcome, success
 * or failure, stored on the item for the audit trail.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getDataStore } from '@renkei/db';
import { wrapAsync } from '@campfhir/safe-functions/helpers';
import { getSessionFromRequest } from '@/lib/session';
import { executeCreateIssue, readCreateIssueAction } from '@/lib/actionable-items';
import { logger } from '@/lib/logger';
import { isRecord } from '@renkei/guards';

const PROJECT_KEY_SHAPE = /^[A-Z][A-Z0-9_]*$/;

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ itemId: string }> }
): Promise<NextResponse> {
  const { itemId } = await params;

  const session = await getSessionFromRequest(request);
  if (!session) {
    return NextResponse.json({ error: 'Not signed in' }, { status: 401 });
  }

  const body: unknown = await request.json().catch(() => null);
  if (!isRecord(body) || (body.decision !== 'approve' && body.decision !== 'dismiss')) {
    return NextResponse.json({ error: "decision must be 'approve' or 'dismiss'" }, { status: 400 });
  }

  const store = getDataStore().actionableItems;

  // Same visibility rule as the feed: a caller may act only on a tenant-wide
  // card (no owner) or their own. Scoping the fetch by owner means a private
  // card owned by another user is 404 here, not decidable — without this a
  // signed-in user could approve/dismiss someone else's private card by id.
  const found = await wrapAsync(
    () => store.findVisible(session.subject, itemId),
    'DB_ERROR' as const
  );
  if (!found.ok) {
    logger.error('Database error: {error}', {
      component: 'api/actionable-items/decision',
      subject: session.subject,
      itemId,
      error: found.err.message ?? found.err.type,
    });
    return NextResponse.json({ error: 'Database error' }, { status: 500 });
  }
  const item = found.val;
  if (!item) {
    return NextResponse.json({ error: 'Item not found' }, { status: 404 });
  }
  if (item.status !== 'suggested') {
    return NextResponse.json({ error: `Item is already ${item.status}` }, { status: 409 });
  }
  if (item.kind === 'approval') {
    // An approval card gates a PAUSED AGENT RUN — deciding it must go
    // through the approval route, which also wakes the run. Dismissing is
    // refused too: the run would wait for a card nobody can see.
    return NextResponse.json(
      { error: 'This card resumes an agent run — use its approve/decline controls' },
      { status: 422 }
    );
  }
  if (item.kind === 'question') {
    // Same story as an approval card: a question gates a PAUSED AGENT
    // RUN — answering it must go through the question route.
    return NextResponse.json(
      { error: 'This card resumes an agent run — use its answer controls' },
      { status: 422 }
    );
  }
  if (item.kind === 'info' && body.decision === 'approve') {
    // Named early rather than falling through to "carries no executable
    // action": an info card is WORKING as designed, not missing data.
    return NextResponse.json(
      { error: 'This is an informational card — dismiss is its only action' },
      { status: 422 }
    );
  }

  if (body.decision === 'dismiss') {
    // Dismissing also archives: one click both records the decision and
    // removes the card from the default feed. The history view still shows
    // it, so the audit trail loses nothing.
    await store.decide(itemId, session.subject, 'dismissed');
    return NextResponse.json({ status: 'dismissed' });
  }

  const action = readCreateIssueAction(item.suggestedAction);
  if (!action) {
    return NextResponse.json({ error: 'Item carries no executable action' }, { status: 422 });
  }

  const projectKey = typeof body.projectKey === 'string' ? body.projectKey.trim() : '';
  if (!PROJECT_KEY_SHAPE.test(projectKey)) {
    return NextResponse.json(
      { error: 'projectKey is required (uppercase key, e.g. SCRUM)' },
      { status: 400 }
    );
  }

  // Claim the decision before executing so two approvers cannot both run the
  // action: only the update that actually flips suggested → approved wins.
  const claimed = await store.decide(itemId, session.subject, 'approved');
  if (claimed === 0) {
    return NextResponse.json({ error: 'Item was already decided' }, { status: 409 });
  }

  const outcome = await executeCreateIssue(session.subject, action, projectKey);

  await store.recordOutcome(
    itemId,
    outcome.ok ? 'executed' : 'failed',
    outcome.ok ? { issueKey: outcome.issueKey, url: outcome.url } : { error: outcome.error }
  );

  if (!outcome.ok) {
    logger.warn('Could not create the approved issue: {error}', {
      component: 'api/actionable-items/decision',
      subject: session.subject,
      itemId,
      error: outcome.error,
    });
    return NextResponse.json({ status: 'failed', error: outcome.error }, { status: 502 });
  }
  return NextResponse.json({ status: 'executed', issueKey: outcome.issueKey, url: outcome.url });
}
