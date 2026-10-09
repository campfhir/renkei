/**
 * A person's own connection to one share — the connect/disconnect flow the
 * connectors card drives. POST with credential fields validates the
 * credential against the live file server (through the fileshare worker)
 * BEFORE anything is stored, then seals it under TOKEN_ENCRYPTION_KEY;
 * POST without credential fields updates only the LLM-exposure choice,
 * keeping the stored credential. DELETE forgets the connection, credential
 * included.
 *
 * The plaintext credential exists in the web process only for the duration
 * of this request; it is never logged, never echoed, and only the worker
 * ever decrypts the sealed copy.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getDatabase } from '@renkei/db';
import {
  deleteConnection,
  getConnection,
  getShare,
  updateConnectionExposure,
  upsertConnection,
} from '@renkei/connector-fileshares';
import { delegateClient } from '@renkei/delegate-client';
import { getSessionFromRequest } from '@/lib/session';
import { recordAuditEvent } from '@/lib/audit-events';
import { clientFailure, fsTestConnection } from '@/lib/file-shares/service-client';
import { parseConnectPayload, parseExposurePayload } from '@/lib/file-shares/parse';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Whether the body carries any credential field (vs. exposure-only). */
function carriesCredential(body: Record<string, unknown>): boolean {
  return ['username', 'password', 'privateKey', 'passphrase', 'domain'].some(
    (field) => typeof body[field] === 'string' && body[field] !== ''
  );
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ shareId: string }> }
): Promise<NextResponse> {
  const { shareId } = await params;
  const session = await getSessionFromRequest(request);
  if (!session) return NextResponse.json({ error: 'Not signed in' }, { status: 401 });

  const dbResult = getDatabase();
  if (!dbResult.ok) return NextResponse.json({ error: 'Database unavailable' }, { status: 500 });
  const db = dbResult.val;

  const share = await getShare(db, shareId);
  if (!share.ok) return NextResponse.json({ error: 'Could not read the share' }, { status: 500 });
  if (!share.val || !share.val.summary.enabled) {
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
      shareId,
      session.subject,
      exposure.toolAccess,
      exposure.allowDelete
    );
    if (!updated.ok) {
      return NextResponse.json({ error: 'Could not update the connection' }, { status: 500 });
    }
    if (!updated.val) {
      return NextResponse.json({ error: 'Connect the share first' }, { status: 409 });
    }
    return NextResponse.json({ ok: true });
  }

  const parsed = parseConnectPayload(share.val.summary.protocol, body);
  if ('error' in parsed) return NextResponse.json({ error: parsed.error }, { status: 400 });

  // Validate against the live server before storing anything — a wrong
  // password is a 4xx here, never a stored credential that fails later.
  const tested = await fsTestConnection({ shareId, credentials: parsed.credentials });
  if (!tested.ok) {
    const failure = clientFailure(tested.err);
    const message =
      failure.status === 403 || tested.err.kind === 'op'
        ? `The file server did not accept these credentials: ${failure.message}`
        : failure.message;
    return NextResponse.json({ error: message }, { status: failure.status });
  }

  // Sealed under the connecting person's own key by the delegate — the one
  // process that holds a key; this one never derives it.
  const sealed = await delegateClient().sealForSubject(session.subject, [
    JSON.stringify(parsed.credentials),
  ]);
  if (!sealed.ok) {
    return sealed.err.type === 'NEEDS_DELEGATION' ||
      sealed.err.type === 'NEEDS_SESSION' ||
      sealed.err.type === 'NOT_ENROLLED'
      ? NextResponse.json(
          {
            error: 'Your encryption key is not connected to this session. Sign in again and retry.',
          },
          { status: 423 }
        )
      : NextResponse.json({ error: 'Encryption key unavailable' }, { status: 503 });
  }

  const stored = await upsertConnection(db, shareId, session.subject, {
    encryptedCredentials: sealed.val[0],
    username: parsed.credentials.username,
    toolAccess: parsed.toolAccess,
    allowDelete: parsed.allowDelete,
  });
  if (!stored.ok) {
    return NextResponse.json({ error: 'Could not store the connection' }, { status: 500 });
  }

  recordAuditEvent({
    actorSubject: session.subject,
    action: 'fileshare.connected',
    targetKind: 'fileshare',
    targetLabel: share.val.summary.name,
    details: { toolAccess: parsed.toolAccess, allowDelete: parsed.allowDelete },
  });
  // SFTP: the host key this connection verified — and whether it was the
  // first to see it (recorded for the admin to confirm on the share's page).
  return NextResponse.json({
    ok: true,
    ...(tested.val.hostKey ? { hostKey: tested.val.hostKey } : {}),
  });
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ shareId: string }> }
): Promise<NextResponse> {
  const { shareId } = await params;
  const session = await getSessionFromRequest(request);
  if (!session) return NextResponse.json({ error: 'Not signed in' }, { status: 401 });

  const dbResult = getDatabase();
  if (!dbResult.ok) return NextResponse.json({ error: 'Database unavailable' }, { status: 500 });

  const existing = await getConnection(dbResult.val, shareId, session.subject);
  if (!existing.ok) {
    return NextResponse.json({ error: 'Could not read the connection' }, { status: 500 });
  }
  if (!existing.val) return NextResponse.json({ error: 'Not connected' }, { status: 404 });

  const deleted = await deleteConnection(dbResult.val, shareId, session.subject);
  if (!deleted.ok) {
    return NextResponse.json({ error: 'Could not disconnect' }, { status: 500 });
  }

  const share = await getShare(dbResult.val, shareId);
  recordAuditEvent({
    actorSubject: session.subject,
    action: 'fileshare.disconnected',
    targetKind: 'fileshare',
    targetLabel: share.ok && share.val ? share.val.summary.name : shareId,
  });
  return NextResponse.json({ ok: true });
}
