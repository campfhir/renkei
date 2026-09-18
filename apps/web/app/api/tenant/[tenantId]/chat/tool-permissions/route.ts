/**
 * The tools this person lets every chat call without asking — the list
 * "Always allow" writes to (permission-prefs.ts), read and pruned from the
 * preferences page. PUT replaces the list wholesale; taking a name off it
 * means the next call to that tool asks again.
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
  if (!Array.isArray(body.alwaysAllow)) {
    return jsonError(400, 'invalid-permissions', 'Expected alwaysAllow: string[]');
  }
  const prefs = parseChatToolPermissionPrefs({ alwaysAllow: body.alwaysAllow });
  const written = await setChatToolPermissionPrefs(tenantId, ready.context.session.subject, prefs);
  if (!written.ok) return jsonError(500, 'save-failed', 'Could not save');
  return NextResponse.json(prefs);
}
