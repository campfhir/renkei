/**
 * One image rule: change it (PUT — its pattern, note, and credential
 * when one is given or `clearCredential` asks) or delete it (DELETE).
 * Operator-only; the worker does the work.
 */

import { NextRequest, NextResponse } from 'next/server';
import {
  clientFailure,
  sandboxServicesEnabled,
  sbImageRuleDelete,
  sbImageRuleSet,
} from '@renkei/sandbox-client';
import { checkAccess, ROLE_OPERATOR } from '@/lib/access';
import { tenantForSlug } from '@/lib/tenant-slug';
import { parseImageRulePayload } from '@/lib/code/image-rules';
import { isUuid } from '@/lib/uuid';

async function operatorTenant(slug: string): Promise<{ id: string } | NextResponse> {
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
  return { id: tenant.id };
}

export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ slug: string; ruleId: string }> }
): Promise<NextResponse> {
  const { slug, ruleId } = await params;
  const tenant = await operatorTenant(slug);
  if (tenant instanceof NextResponse) return tenant;
  if (!isUuid(ruleId)) return NextResponse.json({ error: 'Rule not found' }, { status: 404 });
  const body: unknown = await request.json().catch(() => null);
  const parsed = parseImageRulePayload(body);
  if ('error' in parsed) return NextResponse.json({ error: parsed.error }, { status: 400 });
  const set = await sbImageRuleSet(tenant.id, { id: ruleId, ...parsed });
  if (!set.ok) {
    const failure = clientFailure(set.err);
    return NextResponse.json({ error: failure.message }, { status: failure.status });
  }
  return NextResponse.json({ rule: set.val.rule, dropped: set.val.dropped });
}

export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ slug: string; ruleId: string }> }
): Promise<NextResponse> {
  const { slug, ruleId } = await params;
  const tenant = await operatorTenant(slug);
  if (tenant instanceof NextResponse) return tenant;
  if (!isUuid(ruleId)) return NextResponse.json({ error: 'Rule not found' }, { status: 404 });
  const deleted = await sbImageRuleDelete(tenant.id, ruleId);
  if (!deleted.ok) {
    const failure = clientFailure(deleted.err);
    return NextResponse.json({ error: failure.message }, { status: failure.status });
  }
  return NextResponse.json({ ok: true });
}
