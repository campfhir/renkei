/**
 * What this person decided ahead of time about the chat's act tools: the
 * always-allowed list ("Always allow" on the card writes to it too) and
 * the blocked list (permission-prefs.ts), edited on the Preferences page.
 * PUT replaces both lists wholesale; a name on neither asks again. The
 * lists are kept per kind of chat session (`kind`: 'chat', the default,
 * 'project' or 'code'), as the query string says for GET and the body for
 * PUT.
 */

import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { chatRequestContext, jsonError, readJsonBody } from '@/lib/chat/route-support';
import {
  getChatToolPermissionPrefs,
  parseChatToolPermissionPrefs,
  setChatToolPermissionPrefs,
} from '@/lib/chat/permission-prefs';
import { isChatSessionKind } from '@/lib/chat/permission-rules';
import { logger } from '@/lib/logger';
import { who } from '@/lib/log-actor';

export async function GET(request: NextRequest): Promise<Response> {
  const ready = await chatRequestContext(request);
  if (!ready.ok) return ready.response;
  const kindParam = request.nextUrl.searchParams.get('kind') ?? 'chat';
  if (!isChatSessionKind(kindParam)) {
    return jsonError(400, 'invalid-kind', "Expected kind 'chat', 'project' or 'code'");
  }
  const prefs = await getChatToolPermissionPrefs(ready.context.session.subject, {
    fresh: true,
    kind: kindParam,
  });
  return NextResponse.json(prefs);
}

export async function PUT(request: NextRequest): Promise<Response> {
  const ready = await chatRequestContext(request);
  if (!ready.ok) return ready.response;
  const body = await readJsonBody(request);
  if (!Array.isArray(body.alwaysAllow) || !Array.isArray(body.alwaysDeny)) {
    return jsonError(
      400,
      'invalid-permissions',
      'Expected alwaysAllow: string[] and alwaysDeny: string[]'
    );
  }
  const prefs = parseChatToolPermissionPrefs({
    alwaysAllow: body.alwaysAllow,
    alwaysDeny: body.alwaysDeny,
  });
  const kind = body.kind ?? 'chat';
  if (!isChatSessionKind(kind)) {
    return jsonError(400, 'invalid-kind', "Expected kind 'chat', 'project' or 'code'");
  }
  const written = await setChatToolPermissionPrefs(ready.context.session.subject, prefs, kind);
  if (!written.ok) {
    logger.error(
      '{actor} changed their tool permissions ({allowed} always allowed, {denied} blocked), but they were not saved: {error}',
      {
        component: 'api/chat/tool-permissions',
        ...who(ready.context.session),
        allowed: prefs.alwaysAllow.length,
        denied: prefs.alwaysDeny.length,
        error: written.err.message ?? written.err.type,
      }
    );
    return jsonError(500, 'save-failed', 'Could not save');
  }
  return NextResponse.json(prefs);
}
