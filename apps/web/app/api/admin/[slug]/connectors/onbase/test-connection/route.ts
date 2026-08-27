/**
 * Reachability test for the OnBase configuration — operator-gated, and it
 * tests the UNSAVED form payload, falling back to the stored row for
 * anything the body omits (the file-shares test-connection discipline: the
 * admin is testing what they are about to save). The actual dialing
 * happens in the OnBase worker; a failed test is a successful request, so
 * failures come back as ok:false fields at HTTP 200.
 */

import { NextRequest, NextResponse } from 'next/server';
import { checkAccess, ROLE_OPERATOR } from '@/lib/access';
import { tenantForSlug } from '@/lib/tenant-slug';
import { obTestConnection, onbaseClientFailure } from '@/lib/onbase/service-client';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ slug: string }> }
): Promise<NextResponse> {
  const { slug } = await params;
  const tenantRef = await tenantForSlug(slug);
  if (!tenantRef) {
    return NextResponse.json({ error: 'Tenant not found' }, { status: 404 });
  }
  const access = await checkAccess(tenantRef.id, [ROLE_OPERATOR]);
  if (!access) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const body: unknown = await request.json().catch(() => null);
  const unsavedRecord = isRecord(body) ? body : {};
  const unsaved = {
    ...(typeof unsavedRecord.apiBaseUrl === 'string' && unsavedRecord.apiBaseUrl
      ? { apiBaseUrl: unsavedRecord.apiBaseUrl }
      : {}),
    ...(typeof unsavedRecord.idpIssuer === 'string' && unsavedRecord.idpIssuer
      ? { idpIssuer: unsavedRecord.idpIssuer }
      : {}),
    ...(typeof unsavedRecord.allowInsecureHttp === 'boolean'
      ? { allowInsecureHttp: unsavedRecord.allowInsecureHttp }
      : {}),
  };

  const tested = await obTestConnection({ tenantId: tenantRef.id, unsaved });
  if (!tested.ok) {
    const failure = onbaseClientFailure(tested.err);
    return NextResponse.json({ error: failure.message }, { status: failure.status });
  }
  return NextResponse.json(tested.val);
}
