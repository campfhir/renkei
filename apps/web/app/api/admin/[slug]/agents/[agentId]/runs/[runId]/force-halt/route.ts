/**
 * The one place admin oversight stops being read-only — see force-halt.ts
 * for why the override exists and what it bypasses. ROLE_OPERATOR only,
 * same gate as the rest of the admin agents tree.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getDatabase } from '@renkei/db';
import { checkAccess, ROLE_OPERATOR } from '@/lib/access';
import { tenantForSlug } from '@/lib/tenant-slug';
import { forceHaltRun } from '@/lib/agents/force-halt';
import { isUuid } from '@/lib/uuid';

export async function POST(
  _request: NextRequest,
  { params }: { params: Promise<{ slug: string; agentId: string; runId: string }> }
): Promise<NextResponse> {
  const { slug, agentId, runId } = await params;
  if (!isUuid(agentId) || !isUuid(runId)) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }

  const tenant = await tenantForSlug(slug);
  if (!tenant) return NextResponse.json({ error: 'Tenant not found' }, { status: 404 });
  const session = await checkAccess(tenant.id, [ROLE_OPERATOR]);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const dbResult = getDatabase();
  if (!dbResult.ok) return NextResponse.json({ error: 'Database unavailable' }, { status: 500 });

  const result = await forceHaltRun(dbResult.val, {
    tenantId: tenant.id,
    agentId,
    runId,
    haltedBySubject: session.subject,
  });

  switch (result.outcome) {
    case 'not-found':
      return NextResponse.json({ error: 'Not found' }, { status: 404 });
    case 'already-final':
      return NextResponse.json(
        {
          error: `This run already ${result.status === 'canceled' ? 'was canceled' : result.status}.`,
        },
        { status: 409 }
      );
    case 'halted':
      return NextResponse.json({ ok: true });
  }
}
