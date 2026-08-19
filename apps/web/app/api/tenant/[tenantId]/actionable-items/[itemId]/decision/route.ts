/**
 * The approval gate on a curated card (RENKEI.md: suggest, then act on
 * approval). A decision is terminal: only a 'suggested' item can be decided,
 * the decider's OIDC subject and the time are recorded, and an approval
 * executes the suggested action as the approver — with the outcome, success
 * or failure, stored on the item for the audit trail.
 */

import { NextRequest, NextResponse } from 'next/server';
import { sql } from 'kysely';
import { getDatabase } from '@renkei/db';
import { getSessionFromRequest } from '@/lib/session';
import { executeCreateIssue, readCreateIssueAction } from '@/lib/actionable-items';

const PROJECT_KEY_SHAPE = /^[A-Z][A-Z0-9_]*$/;

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
  if (!isRecord(body) || (body.decision !== 'approve' && body.decision !== 'dismiss')) {
    return NextResponse.json({ error: "decision must be 'approve' or 'dismiss'" }, { status: 400 });
  }

  const dbResult = getDatabase();
  if (!dbResult.ok) {
    return NextResponse.json({ error: 'Database error' }, { status: 500 });
  }
  const db = dbResult.val;

  // Same visibility rule as the feed: a caller may act only on a tenant-wide
  // card (no owner) or their own. Scoping the fetch by owner means a private
  // card owned by another user is 404 here, not decidable — without this a
  // signed-in user could approve/dismiss someone else's private card by id.
  const item = await db
    .selectFrom('actionable_items')
    .select(['id', 'kind', 'status', 'suggested_action'])
    .where('id', '=', itemId)
    .where('tenant_id', '=', tenantId)
    .where((eb) =>
      eb.or([eb('owner_subject', 'is', null), eb('owner_subject', '=', session.subject)])
    )
    .executeTakeFirst();
  if (!item) {
    return NextResponse.json({ error: 'Item not found' }, { status: 404 });
  }
  if (item.status !== 'suggested') {
    return NextResponse.json({ error: `Item is already ${item.status}` }, { status: 409 });
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
    await db
      .updateTable('actionable_items')
      .set({
        status: 'dismissed',
        decided_by: session.subject,
        decided_at: sql`NOW()`,
        archived_at: sql`NOW()`,
        archived_by: session.subject,
        updated_at: sql`NOW()`,
      })
      .where('id', '=', itemId)
      .where('status', '=', 'suggested')
      .execute();
    return NextResponse.json({ status: 'dismissed' });
  }

  const action = readCreateIssueAction(item.suggested_action);
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
  const claimed = await db
    .updateTable('actionable_items')
    .set({
      status: 'approved',
      decided_by: session.subject,
      decided_at: sql`NOW()`,
      updated_at: sql`NOW()`,
    })
    .where('id', '=', itemId)
    .where('status', '=', 'suggested')
    .executeTakeFirst();
  if (Number(claimed.numUpdatedRows ?? 0) === 0) {
    return NextResponse.json({ error: 'Item was already decided' }, { status: 409 });
  }

  const outcome = await executeCreateIssue(tenantId, session.subject, action, projectKey);

  await db
    .updateTable('actionable_items')
    .set({
      status: outcome.ok ? 'executed' : 'failed',
      result: JSON.stringify(
        outcome.ok ? { issueKey: outcome.issueKey, url: outcome.url } : { error: outcome.error }
      ),
      updated_at: sql`NOW()`,
    })
    .where('id', '=', itemId)
    .execute();

  if (!outcome.ok) {
    return NextResponse.json({ status: 'failed', error: outcome.error }, { status: 502 });
  }
  return NextResponse.json({ status: 'executed', issueKey: outcome.issueKey, url: outcome.url });
}
