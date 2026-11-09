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
import { logger } from '@/lib/logger';
import { who } from '@/lib/log-actor';
import { isRecord } from '@renkei/guards';

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

  const share = await getShare(shareId);
  if (!share.ok) {
    logger.error(
      '{actor} tried to connect a file share, but it could not be read; nothing was changed: {error}',
      {
        component: 'api/fileshares/connection',
        ...who(session),
        shareId,
        error: share.err.message ?? share.err.type,
      }
    );
    return NextResponse.json({ error: 'Could not read the share' }, { status: 500 });
  }
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
      shareId,
      session.subject,
      exposure.toolAccess,
      exposure.allowDelete
    );
    if (!updated.ok) {
      logger.error(
        '{actor} changed the LLM exposure of their connection to file share "{name}", but it was not saved: {error}',
        {
          component: 'api/fileshares/connection',
          ...who(session),
          shareId,
          name: share.val.summary.name,
          error: updated.err.message ?? updated.err.type,
        }
      );
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
    logger.warn(
      '{actor} tried to connect file share "{name}" as "{username}", but the connection test failed ({status}); nothing was stored: {error}',
      {
        component: 'api/fileshares/connection',
        ...who(session),
        shareId,
        name: share.val.summary.name,
        username: parsed.credentials.username,
        status: failure.status,
        error: failure.message,
      }
    );
    return NextResponse.json({ error: message }, { status: failure.status });
  }

  // Sealed under the connecting person's own key by the delegate — the one
  // process that holds a key; this one never derives it.
  const sealed = await delegateClient().sealForSubject(session.subject, [
    JSON.stringify(parsed.credentials),
  ]);
  if (!sealed.ok) {
    logger.warn(
      '{actor} tried to connect file share "{name}", but the credentials could not be sealed under their key ({reason}); nothing was stored: {error}',
      {
        component: 'api/fileshares/connection',
        ...who(session),
        shareId,
        name: share.val.summary.name,
        reason: sealed.err.type,
        error: sealed.err.message ?? sealed.err.type,
      }
    );
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

  const stored = await upsertConnection(shareId, session.subject, {
    encryptedCredentials: sealed.val[0],
    username: parsed.credentials.username,
    toolAccess: parsed.toolAccess,
    allowDelete: parsed.allowDelete,
  });
  if (!stored.ok) {
    logger.error(
      '{actor} connected file share "{name}" as "{username}", but the connection was not stored: {error}',
      {
        component: 'api/fileshares/connection',
        ...who(session),
        shareId,
        name: share.val.summary.name,
        username: parsed.credentials.username,
        error: stored.err.message ?? stored.err.type,
      }
    );
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

  const existing = await getConnection(shareId, session.subject);
  if (!existing.ok) {
    logger.error(
      '{actor} tried to disconnect a file share, but their connection could not be read; nothing was changed: {error}',
      {
        component: 'api/fileshares/connection',
        ...who(session),
        shareId,
        error: existing.err.message ?? existing.err.type,
      }
    );
    return NextResponse.json({ error: 'Could not read the connection' }, { status: 500 });
  }
  if (!existing.val) return NextResponse.json({ error: 'Not connected' }, { status: 404 });

  const deleted = await deleteConnection(shareId, session.subject);
  if (!deleted.ok) {
    logger.error(
      '{actor} tried to disconnect a file share, but the connection was not removed: {error}',
      {
        component: 'api/fileshares/connection',
        ...who(session),
        shareId,
        error: deleted.err.message ?? deleted.err.type,
      }
    );
    return NextResponse.json({ error: 'Could not disconnect' }, { status: 500 });
  }

  const share = await getShare(shareId);
  recordAuditEvent({
    actorSubject: session.subject,
    action: 'fileshare.disconnected',
    targetKind: 'fileshare',
    targetLabel: share.ok && share.val ? share.val.summary.name : shareId,
  });
  return NextResponse.json({ ok: true });
}
