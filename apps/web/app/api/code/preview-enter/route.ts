/**
 * The app's half of the preview host's sign-in handoff
 * (lib/code/preview-host.ts): a signed-in person on the app's own origin is
 * given a ticket that lives a minute and sent to the preview host's
 * `/enter`, which sets that host's cookie and goes on to the preview they
 * asked for. Someone not signed in signs in first and comes back here.
 *
 * The ticket names only who they are; whether they may see the preview is
 * checked on the preview host, on every request.
 */

import { NextResponse, type NextRequest } from 'next/server';
import { getPublicBaseUrl } from '@renkei/settings';
import { jsonError } from '@/lib/chat/route-support';
import { getSessionFromRequest } from '@/lib/session';
import {
  PREVIEW_ENTER_PATH,
  mintPreviewTicket,
  previewHostBase,
  safePreviewHostPath,
} from '@/lib/code/preview-host';
import { codePreviewHost, previewHostKey } from '@/lib/code/preview-host-server';

export async function GET(request: NextRequest): Promise<Response> {
  const host = await codePreviewHost();
  const to = safePreviewHostPath(request.nextUrl.searchParams.get('to'));
  if (!host || !to) return jsonError(404, 'not-found', 'No such preview');

  const session = await getSessionFromRequest(request);
  if (!session) {
    const app = getPublicBaseUrl();
    if (!app) return jsonError(401, 'unauthenticated', 'Not signed in');
    const login = new URL('/api/auth/oidc/login', app);
    login.searchParams.set('redirect', `${PREVIEW_ENTER_PATH}?to=${encodeURIComponent(to)}`);
    return NextResponse.redirect(login, 303);
  }

  const key = previewHostKey();
  if (!key) return jsonError(503, 'unavailable', 'Previews are not available on this deployment.');
  const enter = new URL('/enter', previewHostBase(host));
  enter.searchParams.set('ticket', mintPreviewTicket(key, session.subject, Date.now()));
  enter.searchParams.set('to', to);
  const response = NextResponse.redirect(enter, 303);
  response.headers.set('referrer-policy', 'no-referrer');
  response.headers.set('cache-control', 'no-store');
  return response;
}
