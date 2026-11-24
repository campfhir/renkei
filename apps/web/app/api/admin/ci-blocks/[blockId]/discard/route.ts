/**
 * Drop a CI building block's draft, back to its latest published version —
 * operators only.
 *
 *   POST → { ok: true }; 409 when there is no draft
 */

import { NextRequest, NextResponse } from 'next/server';
import { checkAccess, ROLE_OPERATOR } from '@/lib/access';
import { discardBlockDraft } from '@/lib/ci/blocks';
import { isUuid } from '@/lib/uuid';

export async function POST(
  _request: NextRequest,
  { params }: { params: Promise<{ blockId: string }> }
): Promise<NextResponse> {
  if (!(await checkAccess([ROLE_OPERATOR]))) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  const { blockId } = await params;
  if (!isUuid(blockId)) return NextResponse.json({ error: 'Block not found' }, { status: 404 });
  return (await discardBlockDraft(blockId))
    ? NextResponse.json({ ok: true })
    : NextResponse.json({ error: 'There is no draft to discard.' }, { status: 409 });
}
