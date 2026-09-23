/**
 * Put the seeded public images back into the allow-list — the ones that
 * are missing; whatever the organization added or kept stays. Operator-only.
 */

import { NextRequest, NextResponse } from 'next/server';
import { clientFailure, sandboxServicesEnabled, sbImageRulesRestore } from '@renkei/sandbox-client';
import { checkAccess, ROLE_OPERATOR } from '@/lib/access';
import { tenantForSlug } from '@/lib/tenant-slug';

export async function POST(
  _request: NextRequest,
  { params }: { params: Promise<{ slug: string }> }
): Promise<NextResponse> {
  const { slug } = await params;
  const tenant = await tenantForSlug(slug);
  if (!tenant) return NextResponse.json({ error: 'Tenant not found' }, { status: 404 });
  if (!(await checkAccess(tenant.id, [ROLE_OPERATOR]))) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  if (!sandboxServicesEnabled()) {
    return NextResponse.json(
      { error: 'Code project services are not enabled on this deployment', enabled: false },
      { status: 503 }
    );
  }
  const restored = await sbImageRulesRestore(tenant.id);
  if (!restored.ok) {
    const failure = clientFailure(restored.err);
    return NextResponse.json({ error: failure.message }, { status: failure.status });
  }
  return NextResponse.json({ added: restored.val.added, rules: restored.val.rules });
}
