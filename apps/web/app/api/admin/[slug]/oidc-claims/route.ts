/**
 * The claim mappings of the org's sign-in: which id_token claim carries
 * roles, which values make an operator or a user, and which claim carries
 * groups. Operator-only, and deliberately not the full OIDC config —
 * changing a claim name should not require re-entering the client secret,
 * which is what POST /api/tenant/[tenantId]/oidc demands.
 *
 * Takes effect at each person's NEXT sign-in: groups are recorded from the
 * token, so nothing here rewrites what anyone already has on record.
 */

import { NextRequest, NextResponse } from 'next/server';
import { checkAccess, ROLE_OPERATOR } from '@/lib/access';
import { tenantForSlug } from '@/lib/tenant-slug';
import { getTenantOidcClaims, setTenantOidcClaims } from '@/lib/tenant-operations';
import { recordAuditEvent } from '@/lib/audit-events';

const CLAIM_NAME = /^[A-Za-z0-9_.:/-]{1,128}$/;

function optionalString(value: unknown, name: string): string | null | { error: string } {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string') return { error: `${name} must be a string` };
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  if (trimmed.length > 255) return { error: `${name} is too long` };
  return trimmed;
}

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ slug: string }> }
): Promise<NextResponse> {
  const { slug } = await params;
  const tenantRef = await tenantForSlug(slug);
  if (!tenantRef) return NextResponse.json({ error: 'Tenant not found' }, { status: 404 });
  if (!(await checkAccess(tenantRef.id, [ROLE_OPERATOR]))) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  const claims = await getTenantOidcClaims(tenantRef.id);
  if (!claims.ok) return NextResponse.json({ error: 'Could not read' }, { status: 500 });
  return NextResponse.json({ configured: claims.val !== null, ...(claims.val ?? {}) });
}

export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ slug: string }> }
): Promise<NextResponse> {
  const { slug } = await params;
  const tenantRef = await tenantForSlug(slug);
  if (!tenantRef) return NextResponse.json({ error: 'Tenant not found' }, { status: 404 });
  const session = await checkAccess(tenantRef.id, [ROLE_OPERATOR]);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const body: unknown = await request.json().catch(() => null);
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return NextResponse.json({ error: 'JSON body required' }, { status: 400 });
  }
  const record: Record<string, unknown> = { ...body };
  const fields = {
    roleClaim: optionalString(record.roleClaim, 'roleClaim'),
    operatorIdpValue: optionalString(record.operatorIdpValue, 'operatorIdpValue'),
    userIdpValue: optionalString(record.userIdpValue, 'userIdpValue'),
    groupsClaim: optionalString(record.groupsClaim, 'groupsClaim'),
  };
  for (const value of Object.values(fields)) {
    if (typeof value === 'object' && value !== null) {
      return NextResponse.json({ error: value.error }, { status: 400 });
    }
  }
  const claims = {
    roleClaim: typeof fields.roleClaim === 'string' ? fields.roleClaim : null,
    operatorIdpValue: typeof fields.operatorIdpValue === 'string' ? fields.operatorIdpValue : null,
    userIdpValue: typeof fields.userIdpValue === 'string' ? fields.userIdpValue : null,
    groupsClaim: typeof fields.groupsClaim === 'string' ? fields.groupsClaim : null,
  };
  for (const name of [claims.roleClaim, claims.groupsClaim]) {
    if (name !== null && !CLAIM_NAME.test(name)) {
      return NextResponse.json({ error: `Claim name "${name}" is not valid` }, { status: 400 });
    }
  }

  const saved = await setTenantOidcClaims(tenantRef.id, claims);
  if (!saved.ok) return NextResponse.json({ error: 'Could not save' }, { status: 500 });
  if (!saved.val) {
    return NextResponse.json({ error: 'Sign-in is not configured yet' }, { status: 409 });
  }
  recordAuditEvent({
    tenantId: tenantRef.id,
    actorSubject: session.subject,
    action: 'settings.updated',
    targetKind: 'oidc-claims',
    targetLabel: claims.groupsClaim ?? 'groups',
  });
  return NextResponse.json({ configured: true, ...claims });
}
