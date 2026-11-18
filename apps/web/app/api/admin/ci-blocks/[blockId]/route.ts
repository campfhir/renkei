/**
 * One CI building block — operators only.
 *
 *   GET    → BlockDetail: the draft, the latest published definition, every version
 *   PUT    { name, description?, kind, definition } → saves the draft as it stands
 *   DELETE → the block and its versions; pipelines already written keep their YAML
 */

import { NextRequest, NextResponse } from 'next/server';
import { checkAccess, ROLE_OPERATOR } from '@/lib/access';
import { deleteBlock, getBlock, parseBlockPayload, saveBlockDraft } from '@/lib/ci/blocks';
import { isUuid } from '@/lib/uuid';
import { recordAuditEvent } from '@/lib/audit-events';
import { logger } from '@/lib/logger';
import { who } from '@/lib/log-actor';

type Params = { params: Promise<{ blockId: string }> };
const notFound = () => NextResponse.json({ error: 'Block not found' }, { status: 404 });

export async function GET(_request: NextRequest, { params }: Params): Promise<NextResponse> {
  if (!(await checkAccess([ROLE_OPERATOR]))) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  const { blockId } = await params;
  if (!isUuid(blockId)) return notFound();
  const block = await getBlock(blockId);
  return block ? NextResponse.json(block) : notFound();
}

export async function PUT(request: NextRequest, { params }: Params): Promise<NextResponse> {
  if (!(await checkAccess([ROLE_OPERATOR]))) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  const { blockId } = await params;
  if (!isUuid(blockId)) return notFound();
  const body: unknown = await request.json().catch(() => null);
  const parsed = parseBlockPayload(body, { create: false });
  if ('error' in parsed) return NextResponse.json({ error: parsed.error }, { status: 400 });
  return (await saveBlockDraft(blockId, parsed)) ? NextResponse.json({ ok: true }) : notFound();
}

export async function DELETE(_request: NextRequest, { params }: Params): Promise<NextResponse> {
  const session = await checkAccess([ROLE_OPERATOR]);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const { blockId } = await params;
  if (!isUuid(blockId)) return notFound();
  const deleted = await deleteBlock(blockId);
  if (!deleted) return notFound();
  recordAuditEvent({
    actorSubject: session.subject,
    action: 'ci.block_deleted',
    targetKind: 'ci_block',
    targetLabel: deleted.name,
    details: { blockId },
  });
  logger.info('{actor} deleted the CI building block "{block}"', {
    component: 'api/admin/ci-blocks',
    ...who(session),
    block: deleted.name,
    blockId,
  });
  return NextResponse.json({ ok: true });
}
