/**
 * ADManager Plus instance registry CRUD — operator-only, connection
 * details only. No credential ever passes through here: each person
 * connects an instance with their own authtoken on the connectors page.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getDatabase } from '@renkei/db';
import { createInstance, listInstances } from '@renkei/connector-admanager';
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
  { params }: { params: Promise<{ slug: string }> }
): Promise<NextResponse> {
  const { slug } = await params;
  if (!(await checkAccess([ROLE_OPERATOR]))) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const dbResult = getDatabase();
  if (!dbResult.ok) return NextResponse.json({ error: 'Database unavailable' }, { status: 500 });

  const instances = await listInstances(dbResult.val);
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

  const created = await createInstance(dbResult.val, parsed.input);
  if (!created.ok) {
    if (created.err.type === 'DUPLICATE_NAME') {
      return NextResponse.json({ error: 'An instance with that name exists' }, { status: 409 });
    }
    return NextResponse.json({ error: 'Could not create the instance' }, { status: 500 });
  }

  recordAuditEvent({
    actorSubject: session.subject,
    action: 'admanager.instance.created',
    targetKind: 'admanager-instance',
    targetLabel: parsed.input.name,
    details: { environment: parsed.input.environment, baseUrl: parsed.input.baseUrl },
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
  return NextResponse.json({ id: created.val }, { status: 201 });
}
