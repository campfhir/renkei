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
import { getDataStore, type DeviceKeyRequestRecord } from '@renkei/db';
import { normalizeDeviceCode } from '@renkei/crypto';
import { chatRequestContext, jsonError, readJsonBody } from '@/lib/chat/route-support';
import { recordAuditEvent } from '@/lib/audit-events';

type Params = { params: Promise<{ requestId: string }> };

/** Wrong codes a request survives; the next one denies it. */
const MAX_ATTEMPTS = 5;

type AskRow = DeviceKeyRequestRecord;

const asks = () => getDataStore().deviceKeyRequests;

function open(row: AskRow): boolean {
  return (
    row.sealedKey === null &&
    row.consumedAt === null &&
    row.deniedAt === null &&
    row.expiresAt.getTime() > Date.now()
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
async function checkCode(row: AskRow, typed: string | null): Promise<NextResponse | null> {
  if (codeMatches(typed, row.code)) return null;
  const attempts = row.attempts + 1;
  await asks().recordMiss(row.id, attempts, attempts >= MAX_ATTEMPTS ? new Date() : null);
  return jsonError(
    403,
    'wrong_code',
    attempts >= MAX_ATTEMPTS
      ? 'That code was wrong too many times; the request is closed. Ask again from the other device.'
      : 'That is not the code the other device is showing.'
  );
}

export async function GET(request: NextRequest, { params }: Params): Promise<Response> {
  const { requestId } = await params;
  const ready = await chatRequestContext(request);
  if (!ready.ok) return ready.response;
  const { session } = ready.context;
  const row = await asks().get(session.subject, requestId);
  if (!row) return jsonError(404, 'not_found', 'No such request.');
  const expired = row.expiresAt.getTime() <= Date.now();

  if (row.askingSessionId === session.id) {
    // The asker, polling. The sealed key is handed over once.
    if (row.deniedAt || row.consumedAt) return jsonError(404, 'not_found', 'No such request.');
    if (row.sealedKey) await asks().consume(row.id, new Date());
    return NextResponse.json({ sealedKey: row.sealedKey, expired });
  }

  // Somebody else's browser of the same person: the approver, who must have
  // the code the asking screen shows before the request says anything.
  if (!open(row)) return jsonError(404, 'not_found', 'That request is gone or already answered.');
  const miss = await checkCode(
    row,
    normalizeDeviceCode(request.nextUrl.searchParams.get('code') ?? '')
  );
  if (miss) return miss;
  return NextResponse.json({
    publicKey: row.publicKey,
    createdAt: row.createdAt.toISOString(),
    userAgent: row.userAgent,
    expired,
  });
}

export async function POST(request: NextRequest, { params }: Params): Promise<Response> {
  const { requestId } = await params;
  const ready = await chatRequestContext(request);
  if (!ready.ok) return ready.response;
  const { session } = ready.context;
  const body = await readJsonBody(request);
  const sealedKey = typeof body.sealedKey === 'string' ? body.sealedKey : '';
  if (!sealedKey.startsWith('sbox1:') || sealedKey.length > 4096) {
    return jsonError(400, 'bad_request', 'The approval must carry a sealed key.');
  }
  const row = await asks().get(session.subject, requestId);
  if (!row || !open(row)) {
    return jsonError(404, 'not_found', 'That request is gone or already answered.');
  }
  if (row.askingSessionId === session.id) {
    return jsonError(403, 'self_approval', 'A device cannot approve its own request.');
  }
  const miss = await checkCode(
    row,
    normalizeDeviceCode(typeof body.code === 'string' ? body.code : '')
  );
  if (miss) return miss;
  const sealed = await asks().seal(row.id, sealedKey, session.id, new Date());
  if (sealed === 0) {
    return jsonError(404, 'not_found', 'That request is gone or already answered.');
  }
  recordAuditEvent({
    actorSubject: session.subject,
    action: 'encryption-key.device-approved',
    details: {
      requestId,
      askedAt: row.createdAt.toISOString(),
      askingUserAgent: row.userAgent,
    },
  });
  return NextResponse.json({ ok: true });
}

export async function DELETE(request: NextRequest, { params }: Params): Promise<Response> {
  const { requestId } = await params;
  const ready = await chatRequestContext(request);
  if (!ready.ok) return ready.response;
  const { session } = ready.context;
  const denied = await asks().deny(session.subject, requestId, new Date());
  if (denied > 0) {
    recordAuditEvent({
      actorSubject: session.subject,
      action: 'encryption-key.device-denied',
      details: { requestId },
    });
  }
  return NextResponse.json({ ok: true });
}
