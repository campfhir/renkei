/**
 * Draft a CI building block from a description, on the organization's
 * default model (lib/ci/draft-block.ts) — operators only. Nothing is
 * saved: the editor fills its form with the answer.
 *
 *   POST { description } → { key, name, description, definition }; 422 { error } when no usable draft came back
 */

import { NextRequest, NextResponse } from 'next/server';
import { isRecord } from '@renkei/guards';
import { checkAccess, ROLE_OPERATOR } from '@/lib/access';
import { draftBlock } from '@/lib/ci/draft-block';

export const maxDuration = 300;

export async function POST(request: NextRequest): Promise<NextResponse> {
  if (!(await checkAccess([ROLE_OPERATOR]))) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  const body: unknown = await request.json().catch(() => null);
  const description =
    isRecord(body) && typeof body.description === 'string' ? body.description : '';
  const drafted = await draftBlock(description);
  if ('error' in drafted) return NextResponse.json({ error: drafted.error }, { status: 422 });
  return NextResponse.json(drafted);
}
