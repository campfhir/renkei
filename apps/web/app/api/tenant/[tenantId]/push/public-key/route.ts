/**
 * The one piece of push setup a browser needs before it can subscribe: the
 * VAPID public key `PushManager.subscribe()` signs its request against.
 * Not itself secret — it is handed to every subscribing browser by design —
 * but still behind a session check, same as every other tenant route here.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getDatabase } from '@renkei/db';
import { parseEncryptionKey } from '@renkei/crypto';
import { getVapidKeys } from '@renkei/notifications';
import { getSessionFromRequest } from '@/lib/session';
import { logger } from '@/lib/logger';

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ tenantId: string }> }
): Promise<NextResponse> {
  const { tenantId } = await params;
  const session = await getSessionFromRequest(request, tenantId);
  if (!session) return NextResponse.json({ error: 'Not signed in' }, { status: 401 });

  const dbResult = getDatabase();
  if (!dbResult.ok) return NextResponse.json({ error: 'Database unavailable' }, { status: 500 });

  const keyResult = parseEncryptionKey(process.env.TOKEN_ENCRYPTION_KEY || '');
  if (!keyResult.ok) {
    logger.error('TOKEN_ENCRYPTION_KEY is missing or malformed', {
      component: 'api/push/public-key',
      tenantId,
    });
    return NextResponse.json({ error: 'Push is not configured' }, { status: 500 });
  }

  try {
    const { publicKey } = await getVapidKeys(dbResult.val, keyResult.val);
    return NextResponse.json({ publicKey });
  } catch (error) {
    logger.error('could not read VAPID keys', {
      component: 'api/push/public-key',
      tenantId,
      error: error instanceof Error ? error.message : String(error),
    });
    return NextResponse.json({ error: 'Push is not configured' }, { status: 500 });
  }
}
