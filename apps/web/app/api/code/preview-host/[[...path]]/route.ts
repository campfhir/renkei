/**
 * Everything the organization's preview host serves (lib/code/preview-host.ts).
 * The operator's reverse proxy forwards that host here, path appended, and
 * does nothing else; which preview a path names, who may see it and how a
 * signed-in member is known on that host are all decided in this file.
 *
 * It answers only for the preview host itself: with no host set, or a
 * request that arrived for any other host (the app's own included), it is
 * a 404 — so a preview's HTML is never served on the app's origin through
 * this prefix.
 *
 * No app session exists on the preview host. A share link is its own
 * credential (the token); a member's preview is reached with the preview
 * host's own cookie, set by `/enter` from a ticket the app minted for the
 * signed-in person, and project access is checked against that subject on
 * every request.
 */

import { NextResponse, type NextRequest } from 'next/server';
import {
  isPreviewToken,
  validatePreviewName,
  validatePreviewPortName,
} from '@renkei/connector-sandbox';
import { getPublicBaseUrl } from '@renkei/settings';
import { jsonError } from '@/lib/chat/route-support';
import { codeProjectTarget } from '@/lib/code/scope';
import { previewRelay } from '@/lib/code/previews';
import {
  PREVIEW_ENTER_PATH,
  PREVIEW_HOST_PREFIX,
  PREVIEW_SESSION_COOKIE,
  PREVIEW_SESSION_TTL_MS,
  mintPreviewSession,
  openPreviewSession,
  openPreviewTicket,
  parsePreviewHostPath,
  previewHostBase,
  requestHost,
  safePreviewHostPath,
} from '@/lib/code/preview-host';
import { codePreviewHost, mayViewPreview, previewHostKey } from '@/lib/code/preview-host-server';

type Params = Promise<{ path?: string[] }>;

const NOT_FOUND = () => jsonError(404, 'not-found', 'No such preview');

/** The path and query as the preview host's own address has them (the prefix is the proxy's doing). */
function hostPathOf(request: NextRequest): string {
  const { pathname, search } = request.nextUrl;
  const path = pathname.startsWith(PREVIEW_HOST_PREFIX)
    ? pathname.slice(PREVIEW_HOST_PREFIX.length)
    : pathname;
  return `${path || '/'}${search}`;
}

async function serve(request: NextRequest, { params }: { params: Params }): Promise<Response> {
  const host = await codePreviewHost();
  if (!host || requestHost(request.headers) !== host) return NOT_FOUND();
  const route = parsePreviewHostPath((await params).path ?? []);
  if (!route) return NOT_FOUND();

  if (route.kind === 'token') {
    if (!isPreviewToken(route.token)) return NOT_FOUND();
    return previewRelay(
      request,
      { token: route.token },
      { prefix: route.prefix, path: route.rest }
    );
  }

  const key = previewHostKey();
  if (!key) return jsonError(503, 'unavailable', 'Previews are not available on this deployment.');

  if (route.kind === 'enter') {
    if (request.method !== 'GET') return NOT_FOUND();
    const ticket = request.nextUrl.searchParams.get('ticket') ?? '';
    const to = safePreviewHostPath(request.nextUrl.searchParams.get('to'));
    const subject = openPreviewTicket(key, ticket, Date.now());
    if (!subject || !to) {
      return jsonError(403, 'forbidden', 'This preview link has expired. Open the preview again.');
    }
    const response = NextResponse.redirect(`${previewHostBase(host)}${to}`, 303);
    response.cookies.set(PREVIEW_SESSION_COOKIE, mintPreviewSession(key, subject, Date.now()), {
      httpOnly: true,
      secure: true,
      sameSite: 'lax',
      path: '/',
      maxAge: Math.floor(PREVIEW_SESSION_TTL_MS / 1000),
    });
    // The ticket was in this address: it goes no further.
    response.headers.set('referrer-policy', 'no-referrer');
    response.headers.set('cache-control', 'no-store');
    return response;
  }

  const name = validatePreviewName(route.name);
  const port = route.port === null ? null : validatePreviewPortName(route.port);
  if (!name.ok || (port !== null && !port.ok)) return NOT_FOUND();

  const cookie = request.cookies.get(PREVIEW_SESSION_COOKIE)?.value ?? '';
  const subject = cookie ? openPreviewSession(key, cookie, Date.now()) : null;
  if (!subject) {
    // Not known on this host yet: the app checks its own session and hands
    // the person back. Only a page load can follow that; anything else is told.
    const app = getPublicBaseUrl();
    if (app && (request.method === 'GET' || request.method === 'HEAD')) {
      const enter = new URL(PREVIEW_ENTER_PATH, app);
      enter.searchParams.set('to', hostPathOf(request));
      const response = NextResponse.redirect(enter, 303);
      response.headers.set('cache-control', 'no-store');
      return response;
    }
    return jsonError(401, 'unauthenticated', 'Open this preview from the app first.');
  }
  if (!(await mayViewPreview(subject, route.projectId, route.chatId))) return NOT_FOUND();

  return previewRelay(
    request,
    {
      subject: codeProjectTarget(route.projectId).subject,
      name: name.name,
      ...(port ? { port: port.name } : {}),
    },
    { prefix: route.prefix, path: route.rest }
  );
}

export const GET = serve;
export const HEAD = serve;
export const POST = serve;
export const PUT = serve;
export const PATCH = serve;
export const DELETE = serve;
export const OPTIONS = serve;
