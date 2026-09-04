/**
 * The toolset picker's data: connectors this person can offer a chat, with
 * tool counts, which ones are on by default, and their own saved default
 * toolset (if they have one — see tool-prefs.ts). PUT saves or clears that
 * default; it is not a chat's own toolset, which is set on the chat itself.
 */

import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { chatRequestContext, jsonError, readJsonBody } from '@/lib/chat/route-support';
import { listChatConnectors } from '@/lib/chat/tool-surface';
import { CHAT_CORE_CONNECTORS, parseToolConfig, toolConfigJson } from '@/lib/chat/tool-config';
import { getDefaultChatTools, setDefaultChatTools } from '@/lib/chat/tool-prefs';

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ tenantId: string }> }
): Promise<Response> {
  const { tenantId } = await params;
  const ready = await chatRequestContext(request, tenantId);
  if (!ready.ok) return ready.response;
  const { session } = ready.context;
  const [connectors, userDefault] = await Promise.all([
    listChatConnectors(tenantId, session.subject),
    getDefaultChatTools(tenantId, session.subject, { fresh: true }),
  ]);
  return NextResponse.json({
    connectors,
    core: CHAT_CORE_CONNECTORS,
    userDefault: userDefault ? toolConfigJson(userDefault) : null,
  });
}

export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ tenantId: string }> }
): Promise<Response> {
  const { tenantId } = await params;
  const ready = await chatRequestContext(request, tenantId);
  if (!ready.ok) return ready.response;
  const { session } = ready.context;
  const body = await readJsonBody(request);

  // null clears the saved default (back to "no opinion" — falls through to
  // the project's toolset, then the core set); anything else must parse.
  if (body.userDefault !== null && body.userDefault !== undefined) {
    const config = parseToolConfig(body.userDefault);
    if (!config) return jsonError(400, 'invalid-tool-config', 'Invalid tool configuration');
    const written = await setDefaultChatTools(tenantId, session.subject, config);
    if (!written.ok) return jsonError(500, 'save-failed', 'Could not save');
    return NextResponse.json({ userDefault: toolConfigJson(config) });
  }

  const written = await setDefaultChatTools(tenantId, session.subject, null);
  if (!written.ok) return jsonError(500, 'save-failed', 'Could not save');
  return NextResponse.json({ userDefault: null });
}
