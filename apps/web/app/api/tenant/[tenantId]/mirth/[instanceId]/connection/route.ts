/**
 * A person's own connection to one Mirth instance — the connect/disconnect
 * flow the connectors card drives. POST with credential fields validates
 * the credential against the live Mirth server (through the Mirth worker)
 * BEFORE anything is stored, then seals it under TOKEN_ENCRYPTION_KEY;
 * POST without credential fields updates only the LLM-exposure choice,
 * keeping the stored credential. DELETE forgets the connection, credential
 * included, and asks the worker to end the Mirth session.
 *
 * The plaintext credential exists in the web process only for the duration
 * of this request; it is never logged, never echoed, and only the worker
 * ever decrypts the sealed copy.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getDatabase } from '@renkei/db';
import { parseEncryptionKey } from '@renkei/crypto';
import {
  deleteConnection,
  encryptCredentials,
  getConnection,
  getInstance,
  updateConnectionExposure,
  upsertConnection,
} from '@renkei/connector-mirth';
import { getSessionFromRequest } from '@/lib/session';
import { recordAuditEvent } from '@/lib/audit-events';
import { mirthClientFailure, mirthLogout, mirthTestConnection } from '@/lib/mirth/service-client';
import { parseConnectPayload, parseExposurePayload } from '@/lib/mirth/parse';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Whether the body carries any credential field (vs. exposure-only). */
function carriesCredential(body: Record<string, unknown>): boolean {
  return ['username', 'password'].some(
    (field) => typeof body[field] === 'string' && body[field] !== ''
  );
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ tenantId: string; instanceId: string }> }
): Promise<NextResponse> {
  const { tenantId, instanceId } = await params;
  const session = await getSessionFromRequest(request, tenantId);
  if (!session) return NextResponse.json({ error: 'Not signed in' }, { status: 401 });

  const dbResult = getDatabase();
  if (!dbResult.ok) return NextResponse.json({ error: 'Database unavailable' }, { status: 500 });
  const db = dbResult.val;

  const instance = await getInstance(db, tenantId, instanceId);
  if (!instance.ok) {
    return NextResponse.json({ error: 'Could not read the instance' }, { status: 500 });
  }
  if (!instance.val || !instance.val.summary.enabled) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }

  const body: unknown = await request.json().catch(() => null);
  if (!isRecord(body)) {
    return NextResponse.json({ error: 'A JSON body is required' }, { status: 400 });
  }

  if (!carriesCredential(body)) {
    // Exposure-only update: the checkboxes on an already-connected card.
    const exposure = parseExposurePayload(body);
    if ('error' in exposure) {
      return NextResponse.json({ error: exposure.error }, { status: 400 });
    }
    const updated = await updateConnectionExposure(
      db,
      tenantId,
      instanceId,
      session.subject,
      exposure.toolAccess,
      exposure.allowDestructive
    );
    if (!updated.ok) {
      return NextResponse.json({ error: 'Could not update the connection' }, { status: 500 });
    }
    if (!updated.val) {
      return NextResponse.json({ error: 'Connect the instance first' }, { status: 409 });
    }
    return NextResponse.json({ ok: true });
  }

  const parsed = parseConnectPayload(body);
  if ('error' in parsed) return NextResponse.json({ error: parsed.error }, { status: 400 });

  // Validate against the live server before storing anything — a wrong
  // password is a 4xx here, never a stored credential that fails later.
  const tested = await mirthTestConnection({
    tenantId,
    instanceId,
    credentials: parsed.credentials,
  });
  if (!tested.ok) {
    const failure = mirthClientFailure(tested.err);
    const message =
      tested.err.kind === 'op' && tested.err.type === 'login_failed'
        ? 'The Mirth server did not accept these credentials.'
        : failure.message;
    return NextResponse.json({ error: message }, { status: failure.status });
  }

  const keyResult = parseEncryptionKey(process.env.TOKEN_ENCRYPTION_KEY || '');
  if (!keyResult.ok) {
    return NextResponse.json({ error: 'Encryption key unavailable' }, { status: 500 });
  }

  const stored = await upsertConnection(db, tenantId, instanceId, session.subject, {
    encryptedCredentials: encryptCredentials(parsed.credentials, keyResult.val),
    username: parsed.credentials.username,
    toolAccess: parsed.toolAccess,
    allowDestructive: parsed.allowDestructive,
  });
  if (!stored.ok) {
    return NextResponse.json({ error: 'Could not store the connection' }, { status: 500 });
  }

  recordAuditEvent({
    tenantId,
    actorSubject: session.subject,
    action: 'mirth.connected',
    targetKind: 'mirth-instance',
    targetLabel: instance.val.summary.name,
    details: {
      toolAccess: parsed.toolAccess,
      allowDestructive: parsed.allowDestructive,
      serverVersion: tested.val.version,
    },
  });
  return NextResponse.json({ ok: true, version: tested.val.version });
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ tenantId: string; instanceId: string }> }
): Promise<NextResponse> {
  const { tenantId, instanceId } = await params;
  const session = await getSessionFromRequest(request, tenantId);
  if (!session) return NextResponse.json({ error: 'Not signed in' }, { status: 401 });

  const dbResult = getDatabase();
  if (!dbResult.ok) return NextResponse.json({ error: 'Database unavailable' }, { status: 500 });

  const existing = await getConnection(dbResult.val, tenantId, instanceId, session.subject);
  if (!existing.ok) {
    return NextResponse.json({ error: 'Could not read the connection' }, { status: 500 });
  }
  if (!existing.val) return NextResponse.json({ error: 'Not connected' }, { status: 404 });

  // End the Mirth session first, while the worker can still resolve the
  // instance; the stored credential goes right after regardless.
  await mirthLogout({ tenantId, instanceId, subject: session.subject });

  const deleted = await deleteConnection(dbResult.val, tenantId, instanceId, session.subject);
  if (!deleted.ok) {
    return NextResponse.json({ error: 'Could not disconnect' }, { status: 500 });
  }

  const instance = await getInstance(dbResult.val, tenantId, instanceId);
  recordAuditEvent({
    tenantId,
    actorSubject: session.subject,
    action: 'mirth.disconnected',
    targetKind: 'mirth-instance',
    targetLabel: instance.ok && instance.val ? instance.val.summary.name : instanceId,
  });
  return NextResponse.json({ ok: true });
}
