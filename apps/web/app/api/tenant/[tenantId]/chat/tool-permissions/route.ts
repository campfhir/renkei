/**
 * What this person decided ahead of time about the chat's act tools: the
 * always-allowed list ("Always allow" on the card writes to it too) and
 * the blocked list (permission-prefs.ts), edited on the Preferences page.
 * PUT replaces both lists wholesale; a name on neither asks again.
 */

import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { chatRequestContext, jsonError, readJsonBody } from '@/lib/chat/route-support';
import {
  getChatToolPermissionPrefs,
  parseChatToolPermissionPrefs,
  setChatToolPermissionPrefs,
} from '@/lib/chat/permission-prefs';

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ tenantId: string }> }
): Promise<Response> {
  const { tenantId } = await params;
  const ready = await chatRequestContext(request, tenantId);
  if (!ready.ok) return ready.response;
  const prefs = await getChatToolPermissionPrefs(tenantId, ready.context.session.subject, {
    fresh: true,
  });
  return NextResponse.json(prefs);
}

export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ tenantId: string }> }
): Promise<Response> {
  const { tenantId } = await params;
  const ready = await chatRequestContext(request, tenantId);
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
  const written = await setChatToolPermissionPrefs(tenantId, ready.context.session.subject, prefs);
  if (!written.ok) return jsonError(500, 'save-failed', 'Could not save');
  return NextResponse.json(prefs);
}
