/**
 * Publish a CI building block's draft as its next version — operators
 * only. Refused, naming every problem, when the draft does not read whole.
 *
 *   POST → { version }; 400 { error, problems } for a draft that does not read;
 *          409 when there is no draft to publish
 */

import { NextRequest, NextResponse } from 'next/server';
import { checkAccess, ROLE_OPERATOR } from '@/lib/access';
import { getBlock, publishBlock } from '@/lib/ci/blocks';
import { isUuid } from '@/lib/uuid';
import { recordAuditEvent } from '@/lib/audit-events';
import { logger } from '@/lib/logger';
import { who } from '@/lib/log-actor';

export async function POST(
  _request: NextRequest,
  { params }: { params: Promise<{ blockId: string }> }
): Promise<NextResponse> {
  const session = await checkAccess([ROLE_OPERATOR]);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const { blockId } = await params;
  if (!isUuid(blockId)) return NextResponse.json({ error: 'Block not found' }, { status: 404 });
  const outcome = await publishBlock(blockId, session.subject);
  if (!outcome.ok) {
    if (outcome.error === 'invalid') {
      return NextResponse.json(
        {
          error: 'The block cannot be published until these are fixed.',
          problems: outcome.problems,
        },
        { status: 400 }
      );
    }
    return outcome.error === 'not-found'
      ? NextResponse.json({ error: 'Block not found' }, { status: 404 })
      : NextResponse.json(
          { error: 'Nothing has changed since the last version.' },
          { status: 409 }
        );
  }
  const block = await getBlock(blockId);
  recordAuditEvent({
    actorSubject: session.subject,
    action: 'ci.block_published',
    targetKind: 'ci_block',
    targetLabel: block?.name ?? blockId,
    details: { blockId, version: outcome.version },
  });
  logger.info('{actor} published version {version} of the CI building block "{block}"', {
    component: 'api/admin/ci-blocks',
    ...who(session),
    version: outcome.version,
    block: block?.name ?? blockId,
    blockId,
  });
  return NextResponse.json({ version: outcome.version });
}
