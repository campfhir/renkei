/**
 * A widget card's HTML, by its `ui://` URI (widgets.ts's `widgetHtmlForUri`)
 * — the chat host's `<iframe srcdoc>` source. Static per build; any
 * signed-in member of the tenant may fetch it, same as they could reach it
 * through an external MCP Apps host with their own token.
 */

import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { chatRequestContext, jsonError } from '@/lib/chat/route-support';
import { widgetHtmlForUri } from '@/lib/mcp-tools/widgets';

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ tenantId: string }> }
): Promise<Response> {
  const { tenantId } = await params;
  const ready = await chatRequestContext(request, tenantId);
  if (!ready.ok) return ready.response;

  const uri = new URL(request.url).searchParams.get('uri') ?? '';
  if (!uri.startsWith('ui://')) return jsonError(400, 'invalid', 'Not a widget resource URI.');
  const html = widgetHtmlForUri(uri);
  if (!html) return jsonError(404, 'not-found', 'No such widget.');
  return new NextResponse(html, {
    headers: {
      'content-type': 'text/html;profile=mcp-app; charset=utf-8',
      // The hash in the URI IS the version; a URI is either exactly this
      // content forever or it does not resolve.
      'cache-control': 'public, max-age=31536000, immutable',
    },
  });
}
