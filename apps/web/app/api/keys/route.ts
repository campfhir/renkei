/**
 * The signed-in person's encryption key, as the browser needs to see it
 * (docs/delegate-key-design.md): enrollment, what is delegated as of this
 * session, the live delegate instances to seal to, the wrapped keys the
 * device opens with the user key it holds, and any device asking for the
 * key. Read by the KeyGuard on every page and by the preferences section.
 * Strictly the caller's own — the subject comes from the session.
 */

import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { chatRequestContext, jsonError } from '@/lib/chat/route-support';
import { keyStatusView } from '@/lib/keys/status';

export async function GET(
  request: NextRequest
): Promise<Response> {
  const ready = await chatRequestContext(request);
  if (!ready.ok) return ready.response;
  const view = await keyStatusView(ready.context.session);
  if (!view) return jsonError(500, 'database', 'Database unavailable');
  return NextResponse.json(view, { headers: { 'cache-control': 'no-store' } });
}
