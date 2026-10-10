/**
 * One ADManager Plus instance's config — operator-only, connection
 * details only. Credentials are each person's own, stored via the
 * connectors page, and never pass through the admin surface. A pinned CA
 * is reported only as present/absent on GET; the PEM itself is
 * write-only from here.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getDatabase } from '@renkei/db';
import { deleteInstance, getInstance, updateInstance } from '@renkei/connector-admanager';
import { checkAccess, ROLE_OPERATOR } from '@/lib/access';
import { recordAuditEvent } from '@/lib/audit-events';
import {
  checkInsecureTransport,
  insecureTransportModes,
  isProductionLabel,
} from '@/lib/insecure-transport';
import { parseInstancePayload } from '@/lib/admanager/parse';

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ instanceId: string }> }
): Promise<NextResponse> {
  const { instanceId } = await params;
  if (!(await checkAccess([ROLE_OPERATOR]))) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const dbResult = getDatabase();
  if (!dbResult.ok) return NextResponse.json({ error: 'Database unavailable' }, { status: 500 });

  const instance = await getInstance(dbResult.val, instanceId);
  if (!instance.ok) {
    return NextResponse.json({ error: 'Could not read the instance' }, { status: 500 });
  }
  if (!instance.val) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  return NextResponse.json({
    instance: { ...instance.val.summary, updatedAt: instance.val.updatedAt.toISOString() },
  });
}

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ instanceId: string }> }
): Promise<NextResponse> {
  const { instanceId } = await params;
  const session = await checkAccess([ROLE_OPERATOR]);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const body: unknown = await request.json().catch(() => null);
  const parsed = parseInstancePayload(body);
  if ('error' in parsed) return NextResponse.json({ error: parsed.error }, { status: 400 });

  // Transport security off (certificate verification, or plaintext HTTP)
  // is a recorded decision for a lab server on a private network and
  // nothing else: never for a production instance, never for a public host.
  const insecureModes = insecureTransportModes(parsed.input);
  const transport = await checkInsecureTransport({
    modes: insecureModes,
    production: isProductionLabel(parsed.input.environment),
    urls: [parsed.input.baseUrl],
  });
  if (!transport.ok) return NextResponse.json({ error: transport.error }, { status: 400 });

  const dbResult = getDatabase();
  if (!dbResult.ok) return NextResponse.json({ error: 'Database unavailable' }, { status: 500 });

  const updated = await updateInstance(dbResult.val, instanceId, parsed.input);
  if (!updated.ok) {
    if (updated.err.type === 'DUPLICATE_NAME') {
      return NextResponse.json({ error: 'An instance with that name exists' }, { status: 409 });
    }
    return NextResponse.json({ error: 'Could not update the instance' }, { status: 500 });
  }
  if (!updated.val) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  recordAuditEvent({
    actorSubject: session.subject,
    action: 'admanager.instance.updated',
    targetKind: 'admanager-instance',
    targetLabel: parsed.input.name,
  });
  if (insecureModes.length) {
    recordAuditEvent({
      actorSubject: session.subject,
      action: 'admanager.instance.insecure_transport_enabled',
      targetKind: 'admanager-instance',
      targetLabel: parsed.input.name,
      details: {
        modes: insecureModes,
        baseUrl: parsed.input.baseUrl,
        environment: parsed.input.environment,
      },
    });
  }
  return NextResponse.json({ ok: true });
}

export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ instanceId: string }> }
): Promise<NextResponse> {
  const { instanceId } = await params;
  const session = await checkAccess([ROLE_OPERATOR]);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const dbResult = getDatabase();
  if (!dbResult.ok) return NextResponse.json({ error: 'Database unavailable' }, { status: 500 });

  // Read the name before the row goes, so the audit line names the thing.
  const instance = await getInstance(dbResult.val, instanceId);
  const name = instance.ok && instance.val ? instance.val.summary.name : instanceId;

  const deleted = await deleteInstance(dbResult.val, instanceId);
  if (!deleted.ok) {
    return NextResponse.json({ error: 'Could not delete the instance' }, { status: 500 });
  }
  if (!deleted.val) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  recordAuditEvent({
    actorSubject: session.subject,
    action: 'admanager.instance.deleted',
    targetKind: 'admanager-instance',
    targetLabel: name,
  });
  return NextResponse.json({ ok: true });
}
