/**
 * The organization's CI building blocks (lib/ci/blocks.ts) — operators
 * only: the catalogue to read, and a new block, its definition a draft
 * until it is published.
 *
 *   GET  → { blocks: BlockSummary[] }
 *   POST { key, name, description?, kind, definition } → 201 { id }; 409 for a taken key
 */

import { NextRequest, NextResponse } from 'next/server';
import { checkAccess, ROLE_OPERATOR } from '@/lib/access';
import { createBlock, listBlocks, parseBlockPayload } from '@/lib/ci/blocks';

export async function GET(_request: NextRequest): Promise<NextResponse> {
  if (!(await checkAccess([ROLE_OPERATOR]))) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  return NextResponse.json({ blocks: await listBlocks() });
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  const session = await checkAccess([ROLE_OPERATOR]);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const body: unknown = await request.json().catch(() => null);
  const parsed = parseBlockPayload(body, { create: true });
  if ('error' in parsed) return NextResponse.json({ error: parsed.error }, { status: 400 });
  const created = await createBlock(parsed, session.subject);
  if (!created.ok) {
    return NextResponse.json(
      { error: `A block with the key “${parsed.key}” exists.` },
      { status: 409 }
    );
  }
  return NextResponse.json({ id: created.id }, { status: 201 });
}
