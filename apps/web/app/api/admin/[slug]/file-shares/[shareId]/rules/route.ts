/**
 * Path rules for one share — operator-only. `subject` empty/absent means
 * the share-wide layer; set, that subject's narrowing layer (which
 * requires their grant to exist — the composite FK enforces it, this
 * route explains it). Rules may name paths that do not exist yet: they
 * describe policy, not the filesystem.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getDatabase } from '@renkei/db';
import { getShare, listRules, upsertRule } from '@renkei/connector-fileshares';
import { checkAccess, ROLE_OPERATOR } from '@/lib/access';
import { tenantForSlug } from '@/lib/tenant-slug';
import { recordAuditEvent } from '@/lib/audit-events';
import { parseRulePayload } from '@/lib/file-shares/parse';

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ slug: string; shareId: string }> }
): Promise<NextResponse> {
  const { slug, shareId } = await params;
  const tenant = await tenantForSlug(slug);
  if (!tenant) return NextResponse.json({ error: 'Tenant not found' }, { status: 404 });
  if (!(await checkAccess(tenant.id, [ROLE_OPERATOR]))) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const dbResult = getDatabase();
  if (!dbResult.ok) return NextResponse.json({ error: 'Database unavailable' }, { status: 500 });

  const subject = request.nextUrl.searchParams.get('subject') || null;
  const rules = await listRules(dbResult.val, tenant.id, shareId, subject);
  if (!rules.ok) return NextResponse.json({ error: 'Could not read rules' }, { status: 500 });

  return NextResponse.json({
    rules: rules.val.map((rule) => ({
      id: rule.id,
      subject: rule.subject,
      path: rule.path,
      access: rule.access,
    })),
  });
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ slug: string; shareId: string }> }
): Promise<NextResponse> {
  const { slug, shareId } = await params;
  const tenant = await tenantForSlug(slug);
  if (!tenant) return NextResponse.json({ error: 'Tenant not found' }, { status: 404 });
  const session = await checkAccess(tenant.id, [ROLE_OPERATOR]);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const body: unknown = await request.json().catch(() => null);
  const parsed = parseRulePayload(body);
  if ('error' in parsed) return NextResponse.json({ error: parsed.error }, { status: 400 });

  const dbResult = getDatabase();
  if (!dbResult.ok) return NextResponse.json({ error: 'Database unavailable' }, { status: 500 });

  const share = await getShare(dbResult.val, tenant.id, shareId);
  if (!share.ok || !share.val) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  const saved = await upsertRule(
    dbResult.val,
    tenant.id,
    shareId,
    parsed.subject,
    parsed.path,
    parsed.access,
    session.subject
  );
  if (!saved.ok) {
    // The one expected failure: a per-user rule for a subject holding no
    // grant trips the composite FK.
    return NextResponse.json(
      { error: 'Could not save the rule — a per-user rule needs that user to hold a grant first' },
      { status: 400 }
    );
  }

  recordAuditEvent({
    tenantId: tenant.id,
    actorSubject: session.subject,
    action: 'fileshare.rule_added',
    targetKind: 'fileshare',
    targetLabel: share.val.summary.name,
    details: { subject: parsed.subject ?? undefined, path: parsed.path, access: parsed.access },
  });
  return NextResponse.json({ ok: true });
}
