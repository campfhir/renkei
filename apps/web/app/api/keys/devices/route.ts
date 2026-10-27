/**
 * Another device (docs/delegate-key-design.md, "Another device"): a
 * browser signed in as the person but without their user key asks for it.
 * It POSTs an ephemeral X25519 public key and gets a ten-character code —
 * the first fifty bits of the key's SHA-256, base32 — which that page
 * shows. An enrolled device of the same person lists the asks (GET: when,
 * from what browser; never the code), the person TYPES the code off the
 * asking screen, and on a match that device seals the user key to the
 * ask's public key (devices/[requestId]). The asking device polls the same
 * row for the sealed box. The server relays and never holds the key.
 *
 * Both sides are the same signed-in subject, so a request is bound to the
 * person by the session — and to the asking browser by its session id, so
 * only that browser reads the answer. The typed code is what keeps a
 * request the person did not make from being approved: an approver who
 * cannot see the asking screen cannot type it, and a stolen session cookie
 * cannot list it. Asks are rate-limited to three per person per ten
 * minutes, and an ask's row stays for those ten minutes once answered or
 * denied so the limit holds.
 */

import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { getDataStore } from '@renkei/db';
import { deviceCodeOf } from '@renkei/crypto';
import { chatRequestContext, jsonError, readJsonBody } from '@/lib/chat/route-support';
import { pendingDevicesOf } from '@/lib/keys/status';

const REQUEST_TTL_MS = 10 * 60_000;
/** The most asks a person may make in one TTL window, answered or not. */
const MAX_ASKS_PER_WINDOW = 3;

export async function GET(request: NextRequest): Promise<Response> {
  const ready = await chatRequestContext(request);
  if (!ready.ok) return ready.response;
  const { session } = ready.context;
  return NextResponse.json({ requests: await pendingDevicesOf(session.subject) });
}

export async function POST(request: NextRequest): Promise<Response> {
  const ready = await chatRequestContext(request);
  if (!ready.ok) return ready.response;
  const { session } = ready.context;
  const store = getDataStore().deviceKeyRequests;
  const body = await readJsonBody(request);
  const publicKey = typeof body.publicKey === 'string' ? body.publicKey : '';
  const raw = Buffer.from(publicKey, 'base64');
  if (raw.byteLength !== 32)
    return jsonError(400, 'bad_request', 'A device public key is 32 bytes.');
  // Rows older than the window have nothing left to say; the ones inside it
  // are what the limit counts, whatever became of them.
  const windowStart = new Date(Date.now() - REQUEST_TTL_MS);
  await store.purgeBefore(session.subject, windowStart);
  const recent = await store.countSince(session.subject, windowStart);
  if (recent >= MAX_ASKS_PER_WINDOW) {
    return jsonError(
      429,
      'rate_limited',
      'Too many requests for your key in the last ten minutes; wait before asking again.'
    );
  }
  const inserted = await store.create({
    subject: session.subject,
    publicKey,
    code: deviceCodeOf(new Uint8Array(raw)),
    askingSessionId: session.id,
    userAgent: (request.headers.get('user-agent') ?? '').slice(0, 200) || null,
    expiresAt: new Date(Date.now() + REQUEST_TTL_MS),
  });
  return NextResponse.json({
    id: inserted.id,
    code: inserted.code,
    expiresAt: inserted.expiresAt.toISOString(),
  });
}
