/**
 * Another device (docs/delegate-key-design.md, "Another device"): a
 * browser signed in as the person but without their user key asks for it.
 * It POSTs an ephemeral X25519 public key and gets a short code; an
 * enrolled device of the same person lists the asks (GET), shows the
 * code, and on the person's say-so seals the user key to that public key
 * (devices/[requestId]). The asking device polls the same row for the
 * sealed box. The server relays and never holds the key in the clear.
 *
 * Both sides are the same signed-in subject, so the request is bound to
 * the person by the session; the code is what the person compares across
 * the two screens so that a request they did not make is not approved.
 */

import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { deviceCodeOf } from '@renkei/crypto';
import { chatRequestContext, jsonError, readJsonBody } from '@/lib/chat/route-support';

const REQUEST_TTL_MS = 10 * 60_000;
/** The most a person may have open at once; older ones are superseded. */
const MAX_OPEN = 3;

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ tenantId: string }> }
): Promise<Response> {
  const { tenantId } = await params;
  const ready = await chatRequestContext(request, tenantId);
  if (!ready.ok) return ready.response;
  const { db, session } = ready.context;
  const rows = await db
    .selectFrom('device_key_requests')
    .select(['id', 'code', 'created_at'])
    .where('tenant_id', '=', tenantId)
    .where('subject', '=', session.subject)
    .where('sealed_key', 'is', null)
    .where('expires_at', '>', new Date())
    .orderBy('created_at', 'asc')
    .execute();
  return NextResponse.json({
    requests: rows.map((row) => ({
      id: row.id,
      code: row.code,
      createdAt: row.created_at.toISOString(),
    })),
  });
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ tenantId: string }> }
): Promise<Response> {
  const { tenantId } = await params;
  const ready = await chatRequestContext(request, tenantId);
  if (!ready.ok) return ready.response;
  const { db, session } = ready.context;
  const body = await readJsonBody(request);
  const publicKey = typeof body.publicKey === 'string' ? body.publicKey : '';
  const raw = Buffer.from(publicKey, 'base64');
  if (raw.byteLength !== 32)
    return jsonError(400, 'bad_request', 'A device public key is 32 bytes.');
  await db
    .deleteFrom('device_key_requests')
    .where('tenant_id', '=', tenantId)
    .where('subject', '=', session.subject)
    .where((eb) =>
      eb.or([
        eb('expires_at', '<=', new Date()),
        eb(
          'id',
          'in',
          eb
            .selectFrom('device_key_requests')
            .select('id')
            .where('tenant_id', '=', tenantId)
            .where('subject', '=', session.subject)
            .orderBy('created_at', 'desc')
            .offset(MAX_OPEN - 1)
        ),
      ])
    )
    .execute();
  const inserted = await db
    .insertInto('device_key_requests')
    .values({
      tenant_id: tenantId,
      subject: session.subject,
      public_key: publicKey,
      code: deviceCodeOf(new Uint8Array(raw)),
      expires_at: new Date(Date.now() + REQUEST_TTL_MS),
    })
    .returning(['id', 'code', 'expires_at'])
    .executeTakeFirstOrThrow();
  return NextResponse.json({
    id: inserted.id,
    code: inserted.code,
    expiresAt: inserted.expires_at.toISOString(),
  });
}
