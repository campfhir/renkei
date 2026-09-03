/**
 * The signed-in person's browser secrets — the UI's list and create calls.
 * Everything here is a thin, session-checked pass-through to the sandbox
 * worker, which is the only process that seals a secret or holds its key
 * (docs/sandbox-connector-design.md, "Secrets"). The values in a POST
 * exist in this process only for the duration of the request and are
 * forwarded once, never logged, never stored, never echoed. The one thing
 * a response carries that must be kept is the generated passphrase, which
 * the worker returns exactly once and the UI shows exactly once.
 *
 * Deliberately NOT an MCP tool: the model may list and type secrets, but
 * supplying, unlocking and revoking them is a person's gesture, made here
 * with their own session.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSessionFromRequest } from '@/lib/session';
import { recordAuditEvent } from '@/lib/audit-events';
import {
  clientFailure,
  sandboxBrowserEnabled,
  sbSecretCreate,
  sbSecretsList,
} from '@/lib/sandbox/service-client';

const HOUR_MS = 60 * 60_000;
const DAY_MS = 24 * HOUR_MS;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ tenantId: string }> }
): Promise<NextResponse> {
  const { tenantId } = await params;
  const session = await getSessionFromRequest(request, tenantId);
  if (!session) return NextResponse.json({ error: 'Not signed in' }, { status: 401 });
  if (!sandboxBrowserEnabled()) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  const listed = await sbSecretsList({ tenantId, subject: session.subject });
  if (!listed.ok) {
    const failure = clientFailure(listed.err);
    return NextResponse.json({ error: failure.message }, { status: failure.status });
  }
  return NextResponse.json({ secrets: listed.val });
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ tenantId: string }> }
): Promise<NextResponse> {
  const { tenantId } = await params;
  const session = await getSessionFromRequest(request, tenantId);
  if (!session) return NextResponse.json({ error: 'Not signed in' }, { status: 401 });
  if (!sandboxBrowserEnabled()) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  const body: unknown = await request.json().catch(() => null);
  if (!isRecord(body)) {
    return NextResponse.json({ error: 'A JSON body is required' }, { status: 400 });
  }
  const fields = isRecord(body.fields) ? body.fields : {};
  const values: Record<string, string> = {};
  for (const [name, value] of Object.entries(fields)) {
    if (typeof value === 'string') values[name] = value;
  }
  const hosts = Array.isArray(body.hosts)
    ? body.hosts.filter((entry): entry is string => typeof entry === 'string')
    : typeof body.hosts === 'string'
      ? [body.hosts]
      : [];
  const unlockHours = typeof body.unlockHours === 'number' ? body.unlockHours : undefined;
  const ttlDays = typeof body.ttlDays === 'number' ? body.ttlDays : undefined;

  // The worker validates every field and phrases every refusal; this
  // route only shapes the request.
  const created = await sbSecretCreate(
    { tenantId, subject: session.subject },
    {
      name: typeof body.name === 'string' ? body.name : '',
      fields: values,
      hosts,
      ...(typeof body.passphrase === 'string' && body.passphrase
        ? { passphrase: body.passphrase }
        : {}),
      ...(unlockHours ? { unlockMs: unlockHours * HOUR_MS } : {}),
      ...(ttlDays ? { ttlMs: ttlDays * DAY_MS } : {}),
    }
  );
  if (!created.ok) {
    const failure = clientFailure(created.err);
    return NextResponse.json({ error: failure.message }, { status: failure.status });
  }

  recordAuditEvent({
    tenantId,
    actorSubject: session.subject,
    action: 'sandbox.secret.created',
    targetKind: 'sandbox_secret',
    targetLabel: created.val.secret.name,
    details: { hosts: created.val.secret.hosts, fields: created.val.secret.fields },
  });
  return NextResponse.json({ secret: created.val.secret, passphrase: created.val.passphrase });
}
