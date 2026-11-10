/**
 * The one piece of push setup a browser needs before it can subscribe: the
 * VAPID public key `PushManager.subscribe()` signs its request against.
 * Not itself secret — it is handed to every subscribing browser by design —
 * but still behind a session check, same as every other tenant route here.
 */

import { NextRequest, NextResponse } from 'next/server';
import { loadKeyring } from '@renkei/crypto';
import { getVapidKeys } from '@renkei/notifications';
import { getSessionFromRequest } from '@/lib/session';
import { logger } from '@/lib/logger';
import { who } from '@/lib/log-actor';

export async function GET(request: NextRequest): Promise<NextResponse> {
  const session = await getSessionFromRequest(request);
  if (!session) return NextResponse.json({ error: 'Not signed in' }, { status: 401 });

  const keyResult = loadKeyring('TOKEN_ENCRYPTION_KEY');
  if (!keyResult.ok) {
    logger.error(
      '{actor} asked for the push public key, but TOKEN_ENCRYPTION_KEY is missing or malformed; push is not configured and the browser cannot subscribe',
      {
        component: 'api/push/public-key',
        ...who(session),
      }
    );
    return NextResponse.json({ error: 'Push is not configured' }, { status: 500 });
  }

  try {
    const { publicKey } = await getVapidKeys(keyResult.val);
    return NextResponse.json({ publicKey });
  } catch (error) {
    logger.error(
      '{actor} asked for the push public key, but the VAPID keys could not be read; the browser cannot subscribe: {error}',
      {
        component: 'api/push/public-key',
        ...who(session),
        error: error instanceof Error ? error.message : String(error),
      }
    );
    return NextResponse.json({ error: 'Push is not configured' }, { status: 500 });
  }
}
