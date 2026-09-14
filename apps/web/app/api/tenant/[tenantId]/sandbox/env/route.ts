/**
 * The signed-in person's workspace environment variables — the values
 * their sandbox commands run with. List (GET — names and dates, never a
 * value) and set (PUT — a name and a value, forwarded once to the sandbox
 * worker, which seals it under its own key; this process keeps nothing
 * and echoes nothing back).
 *
 * Deliberately NOT an MCP tool: the model may list the names, and the
 * worker puts the values in a command's environment, but supplying and
 * removing them is a person's gesture, made here with their own session.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSessionFromRequest } from '@/lib/session';
import { recordAuditEvent } from '@/lib/audit-events';
import {
  clientFailure,
  sandboxWorkspacesEnabled,
  sbEnvList,
  sbEnvSet,
} from '@/lib/sandbox/service-client';

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
  if (!sandboxWorkspacesEnabled())
    return NextResponse.json({ error: 'Not found' }, { status: 404 });

  const listed = await sbEnvList({ tenantId, subject: session.subject });
  if (!listed.ok) {
    const failure = clientFailure(listed.err);
    return NextResponse.json({ error: failure.message }, { status: failure.status });
  }
  return NextResponse.json({ variables: listed.val });
}

export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ tenantId: string }> }
): Promise<NextResponse> {
  const { tenantId } = await params;
  const session = await getSessionFromRequest(request, tenantId);
  if (!session) return NextResponse.json({ error: 'Not signed in' }, { status: 401 });
  if (!sandboxWorkspacesEnabled())
    return NextResponse.json({ error: 'Not found' }, { status: 404 });

  const body: unknown = await request.json().catch(() => null);
  if (!isRecord(body)) {
    return NextResponse.json({ error: 'A JSON body is required' }, { status: 400 });
  }
  // The worker validates the name and the value and phrases every
  // refusal; this route only shapes the request.
  const set = await sbEnvSet(
    { tenantId, subject: session.subject },
    {
      name: typeof body.name === 'string' ? body.name.trim() : '',
      value: typeof body.value === 'string' ? body.value : '',
    }
  );
  if (!set.ok) {
    const failure = clientFailure(set.err);
    return NextResponse.json({ error: failure.message }, { status: failure.status });
  }
  recordAuditEvent({
    tenantId,
    actorSubject: session.subject,
    action: 'sandbox.env.set',
    targetKind: 'sandbox_env',
    targetLabel: set.val.name,
  });
  return NextResponse.json({ variable: set.val });
}
