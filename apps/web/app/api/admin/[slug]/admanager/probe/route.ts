/**
 * The admin form's "test reachability" — operator-only. Probes a stored
 * instance by id, or the unsaved form values, through the ADManager Plus
 * worker; unauthenticated on the ADManager Plus side, so a 401 from the
 * server is the healthy answer (a REST API is listening and demanding a
 * token).
 */

import { NextRequest, NextResponse } from 'next/server';
import { parseBaseUrl } from '@renkei/connector-admanager';
import { checkAccess, ROLE_OPERATOR } from '@/lib/access';
import { tenantForSlug } from '@/lib/tenant-slug';
import { admanagerClientFailure, admanagerProbe } from '@/lib/admanager/service-client';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ slug: string }> }
): Promise<NextResponse> {
  const { slug } = await params;
  const tenant = await tenantForSlug(slug);
  if (!tenant) return NextResponse.json({ error: 'Tenant not found' }, { status: 404 });
  if (!(await checkAccess(tenant.id, [ROLE_OPERATOR]))) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const body: unknown = await request.json().catch(() => null);
  if (!isRecord(body))
    return NextResponse.json({ error: 'A JSON body is required' }, { status: 400 });

  let target: Parameters<typeof admanagerProbe>[1];
  if (typeof body.instanceId === 'string' && body.instanceId) {
    target = { instanceId: body.instanceId };
  } else {
    const allowInsecureHttp = body.allowInsecureHttp === true;
    const baseUrl = parseBaseUrl(body.baseUrl, allowInsecureHttp);
    if (!baseUrl) {
      return NextResponse.json({ error: 'baseUrl is not a usable URL' }, { status: 400 });
    }
    target = {
      unsaved: {
        baseUrl,
        tlsVerify: body.tlsVerify !== false,
        caPem: typeof body.caPem === 'string' && body.caPem.trim() ? body.caPem : null,
        allowInsecureHttp,
      },
    };
  }

  const probed = await admanagerProbe(tenant.id, target);
  if (!probed.ok) {
    const failure = admanagerClientFailure(probed.err);
    return NextResponse.json({ error: failure.message }, { status: failure.status });
  }
  return NextResponse.json(probed.val);
}
