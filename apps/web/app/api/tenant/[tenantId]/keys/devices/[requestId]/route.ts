/**
 * One device request (see ../route.ts). Two browsers of one person meet
 * here, told apart by session:
 *
 *   - the ASKING browser (its session made the request) polls GET for the
 *     sealed key; the answer is handed over once and the row marked
 *     consumed. It never sees the code again — it already has it.
 *   - an APPROVING browser reads GET with `?code=` typed off the asking
 *     screen — a match answers the ask's public key, when it was made and
 *     from what browser; a miss counts an attempt, and the fifth denies
 *     the request — then POSTs the user key sealed to that public key, with
 *     the code again. DELETE denies.
 *
 * A sealed box answers only to the asking device's private key, which never
 * left that device; the code is what proves the approver is looking at the
 * asking screen and not at a request somebody else planted.
 */

import { timingSafeEqual } from 'node:crypto';
import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import type { Kysely } from 'kysely';
import type { DB } from '@renkei/db';
import { normalizeDeviceCode } from '@renkei/crypto';
import { chatRequestContext, jsonError, readJsonBody } from '@/lib/chat/route-support';
import { recordAuditEvent } from '@/lib/audit-events';

type Params = { params: Promise<{ tenantId: string; requestId: string }> };

/** Wrong codes a request survives; the next one denies it. */
const MAX_ATTEMPTS = 5;

interface AskRow {
  id: string;
  public_key: string;
  code: string;
  sealed_key: string | null;
  asking_session_id: string | null;
  user_agent: string | null;
  attempts: number;
  consumed_at: Date | null;
  denied_at: Date | null;
  created_at: Date;
  expires_at: Date;
}

async function askFor(
  db: Kysely<DB>,
  tenantId: string,
  subject: string,
  requestId: string
): Promise<AskRow | null> {
  const row = await db
    .selectFrom('device_key_requests')
    .select([
      'id',
      'public_key',
      'code',
      'sealed_key',
      'asking_session_id',
      'user_agent',
      'attempts',
      'consumed_at',
      'denied_at',
      'created_at',
      'expires_at',
    ])
    .where('id', '=', requestId)
    .where('tenant_id', '=', tenantId)
    .where('subject', '=', subject)
    .executeTakeFirst();
  return row ?? null;
}

function open(row: AskRow): boolean {
  return (
    row.sealed_key === null &&
    row.consumed_at === null &&
    row.denied_at === null &&
    row.expires_at.getTime() > Date.now()
  );
}

function codeMatches(typed: string | null, code: string): boolean {
  if (!typed) return false;
  const left = Buffer.from(typed);
  const right = Buffer.from(code);
  return left.byteLength === right.byteLength && timingSafeEqual(left, right);
}

/**
 * The typed code against the request's: a miss counts, and the request
 * that has taken its last miss is denied. Answers the response to send on
 * a miss, or null on a match.
 */
async function checkCode(
  db: Kysely<DB>,
  row: AskRow,
  typed: string | null
): Promise<NextResponse | null> {
  if (codeMatches(typed, row.code)) return null;
  const attempts = row.attempts + 1;
  await db
    .updateTable('device_key_requests')
    .set(attempts >= MAX_ATTEMPTS ? { attempts, denied_at: new Date() } : { attempts })
    .where('id', '=', row.id)
    .execute();
  return jsonError(
    403,
    'wrong_code',
    attempts >= MAX_ATTEMPTS
      ? 'That code was wrong too many times; the request is closed. Ask again from the other device.'
      : 'That is not the code the other device is showing.'
  );
}

export async function GET(request: NextRequest, { params }: Params): Promise<Response> {
  const { tenantId, requestId } = await params;
  const ready = await chatRequestContext(request, tenantId);
  if (!ready.ok) return ready.response;
  const { db, session } = ready.context;
  const row = await askFor(db, tenantId, session.subject, requestId);
  if (!row) return jsonError(404, 'not_found', 'No such request.');
  const expired = row.expires_at.getTime() <= Date.now();

  if (row.asking_session_id === session.id) {
    // The asker, polling. The sealed key is handed over once.
    if (row.denied_at || row.consumed_at) return jsonError(404, 'not_found', 'No such request.');
    if (row.sealed_key) {
      await db
        .updateTable('device_key_requests')
        .set({ sealed_key: null, consumed_at: new Date() })
        .where('id', '=', requestId)
        .execute();
    }
    return NextResponse.json({ sealedKey: row.sealed_key, expired });
  }

  // Somebody else's browser of the same person: the approver, who must have
  // the code the asking screen shows before the request says anything.
  if (!open(row)) return jsonError(404, 'not_found', 'That request is gone or already answered.');
  const miss = await checkCode(
    db,
    row,
    normalizeDeviceCode(request.nextUrl.searchParams.get('code') ?? '')
  );
  if (miss) return miss;
  return NextResponse.json({
    publicKey: row.public_key,
    createdAt: row.created_at.toISOString(),
    userAgent: row.user_agent,
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
  const row = await askFor(db, tenantId, session.subject, requestId);
  if (!row || !open(row)) {
    return jsonError(404, 'not_found', 'That request is gone or already answered.');
  }
  if (row.asking_session_id === session.id) {
    return jsonError(403, 'self_approval', 'A device cannot approve its own request.');
  }
  const miss = await checkCode(
    db,
    row,
    normalizeDeviceCode(typeof body.code === 'string' ? body.code : '')
  );
  if (miss) return miss;
  const result = await db
    .updateTable('device_key_requests')
    .set({ sealed_key: sealedKey, approved_by_session_id: session.id })
    .where('id', '=', requestId)
    .where('sealed_key', 'is', null)
    .where('denied_at', 'is', null)
    .where('expires_at', '>', new Date())
    .executeTakeFirst();
  if (Number(result.numUpdatedRows) === 0) {
    return jsonError(404, 'not_found', 'That request is gone or already answered.');
  }
  recordAuditEvent({
    tenantId,
    actorSubject: session.subject,
    action: 'encryption-key.device-approved',
    details: {
      requestId,
      askedAt: row.created_at.toISOString(),
      askingUserAgent: row.user_agent,
    },
  });
  return NextResponse.json({ ok: true });
}

export async function DELETE(request: NextRequest, { params }: Params): Promise<Response> {
  const { tenantId, requestId } = await params;
  const ready = await chatRequestContext(request, tenantId);
  if (!ready.ok) return ready.response;
  const { db, session } = ready.context;
  const result = await db
    .updateTable('device_key_requests')
    .set({ denied_at: new Date(), sealed_key: null })
    .where('id', '=', requestId)
    .where('tenant_id', '=', tenantId)
    .where('subject', '=', session.subject)
    .where('denied_at', 'is', null)
    .executeTakeFirst();
  if (Number(result.numUpdatedRows) > 0) {
    recordAuditEvent({
      tenantId,
      actorSubject: session.subject,
      action: 'encryption-key.device-denied',
      details: { requestId },
    });
  }
  return NextResponse.json({ ok: true });
}
