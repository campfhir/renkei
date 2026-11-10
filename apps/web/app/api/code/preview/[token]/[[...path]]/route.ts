/**
 * A public preview, by its share link: everything under
 * `/api/code/preview/[token]/` is relayed to the preview the token names
 * — no session, no project in the address. The token is the whole
 * secret (32 random bytes, minted when the preview was started public),
 * it stops working the moment the preview is stopped or expires, and the
 * worker answers nothing for one it does not hold. A link is for a
 * phone, a colleague or a webhook to reach what a chat built, for a few
 * hours; it is not a way to host.
 */

import type { NextRequest } from 'next/server';
import { isPreviewToken, publicPreviewPath } from '@renkei/connector-sandbox';
import { jsonError } from '@/lib/chat/route-support';
import { previewRelay } from '@/lib/code/previews';

type Params = Promise<{ token: string; path?: string[] }>;

async function relay(request: NextRequest, { params }: { params: Params }): Promise<Response> {
  const { token, path } = await params;
  if (!isPreviewToken(token)) return jsonError(404, 'not-found', 'No such preview');
  return previewRelay(request, { token }, { prefix: publicPreviewPath(token), path });
}

export const GET = relay;
export const HEAD = relay;
export const POST = relay;
export const PUT = relay;
export const PATCH = relay;
export const DELETE = relay;
export const OPTIONS = relay;
