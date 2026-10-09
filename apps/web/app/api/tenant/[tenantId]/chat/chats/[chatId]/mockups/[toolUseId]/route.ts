/**
 * One mockup of this chat, as the HTML document the thread's iframe loads,
 * by the chat_show_mockup call that made it (lib/chat/mockup-tools.ts).
 * The source is read back from the call's own stored input — nothing is
 * kept beside it — and built the way the tool proved it would build.
 * Anyone who may read the chat may read it.
 *
 * The response is code the model wrote, so it goes out locked down
 * (`MOCKUP_CSP`: no network, no remote images, sandboxed even when this URL
 * is opened on its own) and the thread frames it with `sandbox="allow-scripts"`
 * and nothing more. Failures are answered as a small page in the frame's
 * own place, not JSON, because the frame is what shows them.
 */

import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { resolveChatAccess } from '@/lib/chat/access';
import { listMessages, toMessageView } from '@/lib/chat/messages';
import { chatRequestContext } from '@/lib/chat/route-support';
import { MOCKUP_CSP, buildMockupDocument } from '@/lib/mockups/document';
import { MOCKUP_TOOL, parseMockupRequest } from '@/lib/mockups/request';

function page(status: number, html: string, extra: Record<string, string> = {}): NextResponse {
  return new NextResponse(html, {
    status,
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'content-security-policy': MOCKUP_CSP,
      'x-content-type-options': 'nosniff',
      'referrer-policy': 'no-referrer',
      ...extra,
    },
  });
}

function problem(status: number, message: string): NextResponse {
  const safe = message.replace(/&/g, '&amp;').replace(/</g, '&lt;');
  return page(
    status,
    `<!doctype html><meta charset="utf-8"><body style="margin:0;padding:16px;font:13px/1.5 ui-sans-serif,system-ui,sans-serif;color:#6b7280;background:#fff">${safe}</body>`
  );
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ tenantId: string; chatId: string; toolUseId: string }> }
): Promise<Response> {
  const { chatId, toolUseId } = await params;
  const ready = await chatRequestContext(request, tenantId);
  if (!ready.ok) return problem(401, 'Sign in to see this mockup.');
  const { db, session } = ready.context;
  const access = await resolveChatAccess(db, tenantId, session.subject, chatId);
  if (!access) return problem(404, 'No such chat.');

  const messages = await listMessages(db, tenantId, chatId, access.cipher);
  for (const message of messages) {
    for (const block of toMessageView(message).blocks) {
      if (block.type !== 'tool_use' || block.id !== toolUseId) continue;
      if (block.name !== MOCKUP_TOOL) return problem(404, 'That call is not a mockup.');
      const parsed = parseMockupRequest(block.input);
      if (!parsed.ok) return problem(422, parsed.message);
      const built = await buildMockupDocument(parsed.request);
      if (!built.ok) return problem(422, built.message);
      // A call's input never changes once stored, so a fetched document
      // is good for a while; the window only bounds how long a rebuilt
      // runtime (a deploy) takes to reach a frame already fetched.
      return page(200, built.html, { 'cache-control': 'private, max-age=300' });
    }
  }
  return problem(404, 'No such mockup.');
}
