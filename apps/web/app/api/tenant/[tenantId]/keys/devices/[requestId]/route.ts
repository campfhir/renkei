/**
 * One device request (see ../route.ts): the asking device polls it (GET)
 * for the sealed key; an enrolled device approves it (POST, with the user
 * key sealed to the request's public key) or denies it (DELETE). A sealed
 * box answers only to the asking device's private key, which never left
 * that device.
 */

import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { chatRequestContext, jsonError, readJsonBody } from '@/lib/chat/route-support';
import { recordAuditEvent } from '@/lib/audit-events';

type Params = { params: Promise<{ tenantId: string; requestId: string }> };

export async function GET(request: NextRequest, { params }: Params): Promise<Response> {
  const { tenantId, requestId } = await params;
  const ready = await chatRequestContext(request, tenantId);
  if (!ready.ok) return ready.response;
  const { db, session } = ready.context;
  const row = await db
    .selectFrom('device_key_requests')
    .select(['public_key', 'code', 'sealed_key', 'expires_at'])
    .where('id', '=', requestId)
    .where('tenant_id', '=', tenantId)
    .where('subject', '=', session.subject)
    .executeTakeFirst();
  if (!row) return jsonError(404, 'not_found', 'No such request.');
  const expired = row.expires_at.getTime() <= Date.now();
  if (row.sealed_key) {
    // Picked up once: the row's job is done.
    await db.deleteFrom('device_key_requests').where('id', '=', requestId).execute();
  }
  return NextResponse.json({
    publicKey: row.public_key,
    code: row.code,
    sealedKey: row.sealed_key,
    expired,
  });
}

export async function POST(request: NextRequest, { params }: Params): Promise<Response> {
  const { tenantId, requestId } = await params;
  const ready = await chatRequestContext(request, tenantId);
  if (!ready.ok) return ready.response;
  const { db, session } = ready.context;
  const body = await readJsonBody(request);
  const sealedKey = typeof body.sealedKey === 'string' ? body.sealedKey : '';
  if (!sealedKey.startsWith('sbox1:') || sealedKey.length > 4096) {
    return jsonError(400, 'bad_request', 'The approval must carry a sealed key.');
  }
  const result = await db
    .updateTable('device_key_requests')
    .set({ sealed_key: sealedKey })
    .where('id', '=', requestId)
    .where('tenant_id', '=', tenantId)
    .where('subject', '=', session.subject)
    .where('sealed_key', 'is', null)
    .where('expires_at', '>', new Date())
    .executeTakeFirst();
  if (Number(result.numUpdatedRows) === 0) {
    return jsonError(404, 'not_found', 'That request is gone or already answered.');
  }
  recordAuditEvent({
    tenantId,
    actorSubject: session.subject,
    action: 'encryption-key.device-approved',
  });
  return NextResponse.json({ ok: true });
}

export async function DELETE(request: NextRequest, { params }: Params): Promise<Response> {
  const { tenantId, requestId } = await params;
  const ready = await chatRequestContext(request, tenantId);
  if (!ready.ok) return ready.response;
  const { db, session } = ready.context;
  await db
    .deleteFrom('device_key_requests')
    .where('id', '=', requestId)
    .where('tenant_id', '=', tenantId)
    .where('subject', '=', session.subject)
    .execute();
  return NextResponse.json({ ok: true });
}
