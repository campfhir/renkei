/**
 * Records one device's push subscription — the client's half of the
 * handshake that starts with GET .../push/public-key. Scoped to the
 * caller's own session.subject structurally: nothing in the body can name
 * a different subject to subscribe on behalf of.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getDatabase } from '@renkei/db';
import { saveSubscription } from '@renkei/notifications';
import { getSessionFromRequest } from '@/lib/session';

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ tenantId: string }> }
): Promise<NextResponse> {
  const { tenantId } = await params;
  const session = await getSessionFromRequest(request, tenantId);
  if (!session) return NextResponse.json({ error: 'Not signed in' }, { status: 401 });

  const body: unknown = await request.json().catch(() => null);
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return NextResponse.json({ error: 'Expected an object' }, { status: 400 });
  }
  const payload: { endpoint?: unknown; keys?: unknown } = body;

  if (typeof payload.endpoint !== 'string' || !payload.endpoint) {
    return NextResponse.json({ error: 'Expected a string endpoint' }, { status: 400 });
  }
  if (typeof payload.keys !== 'object' || payload.keys === null || Array.isArray(payload.keys)) {
    return NextResponse.json({ error: 'Expected subscription keys' }, { status: 400 });
  }
  const keys: { p256dh?: unknown; auth?: unknown } = payload.keys;
  if (typeof keys.p256dh !== 'string' || typeof keys.auth !== 'string') {
    return NextResponse.json({ error: 'Expected p256dh and auth strings' }, { status: 400 });
  }

  const dbResult = getDatabase();
  if (!dbResult.ok) return NextResponse.json({ error: 'Database unavailable' }, { status: 500 });

  await saveSubscription(dbResult.val, tenantId, session.subject, {
    endpoint: payload.endpoint,
    keys: { p256dh: keys.p256dh, auth: keys.auth },
  });

  return NextResponse.json({ ok: true });
}
