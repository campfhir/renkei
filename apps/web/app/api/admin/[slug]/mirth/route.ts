/**
 * Mirth instance registry CRUD — operator-only, connection details only.
 * No credential ever passes through here: each person connects an
 * instance with their own Mirth account on the connectors page.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getDatabase } from '@renkei/db';
import { createInstance, listInstances } from '@renkei/connector-mirth';
import { checkAccess, ROLE_OPERATOR } from '@/lib/access';
import { tenantForSlug } from '@/lib/tenant-slug';
import { recordAuditEvent } from '@/lib/audit-events';
import { parseInstancePayload } from '@/lib/mirth/parse';

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ slug: string }> }
): Promise<NextResponse> {
  const { slug } = await params;
  const tenant = await tenantForSlug(slug);
  if (!tenant) return NextResponse.json({ error: 'Tenant not found' }, { status: 404 });
  if (!(await checkAccess(tenant.id, [ROLE_OPERATOR]))) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const dbResult = getDatabase();
  if (!dbResult.ok) return NextResponse.json({ error: 'Database unavailable' }, { status: 500 });

  const instances = await listInstances(dbResult.val, tenant.id);
  if (!instances.ok) {
    return NextResponse.json({ error: 'Could not read instances' }, { status: 500 });
  }

  return NextResponse.json({
    instances: instances.val.map((row) => ({
      ...row.summary,
      updatedAt: row.updatedAt.toISOString(),
    })),
  });
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ slug: string }> }
): Promise<NextResponse> {
  const { slug } = await params;
  const tenant = await tenantForSlug(slug);
  if (!tenant) return NextResponse.json({ error: 'Tenant not found' }, { status: 404 });
  const session = await checkAccess(tenant.id, [ROLE_OPERATOR]);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const body: unknown = await request.json().catch(() => null);
  const parsed = parseInstancePayload(body);
  if ('error' in parsed) return NextResponse.json({ error: parsed.error }, { status: 400 });

  const dbResult = getDatabase();
  if (!dbResult.ok) return NextResponse.json({ error: 'Database unavailable' }, { status: 500 });

  const created = await createInstance(dbResult.val, tenant.id, parsed.input);
  if (!created.ok) {
    if (created.err.type === 'DUPLICATE_NAME') {
      return NextResponse.json({ error: 'An instance with that name exists' }, { status: 409 });
    }
    return NextResponse.json({ error: 'Could not create the instance' }, { status: 500 });
  }

  recordAuditEvent({
    tenantId: tenant.id,
    actorSubject: session.subject,
    action: 'mirth.instance.created',
    targetKind: 'mirth-instance',
    targetLabel: parsed.input.name,
    details: { environment: parsed.input.environment, baseUrl: parsed.input.baseUrl },
  });
  return NextResponse.json({ id: created.val }, { status: 201 });
}
