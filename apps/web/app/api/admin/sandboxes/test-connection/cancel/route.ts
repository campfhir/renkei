/**
 * Cancel the running Test connection. The orchestrator stops it and
 * removes its test sandbox; the job ends once that is done, so the page
 * keeps reading it until it says cancelled.
 */

import { NextRequest, NextResponse } from 'next/server';
import { isRecord } from '@renkei/guards';
import { checkAccess, ROLE_OPERATOR } from '@/lib/access';
import { logger } from '@/lib/logger';
import { who } from '@/lib/log-actor';
import { cancelSandboxesTest } from '@/lib/sandboxes-admin';

const COMPONENT = 'api/admin/sandboxes/test-connection/cancel';

export async function POST(request: NextRequest): Promise<NextResponse> {
  const access = await checkAccess([ROLE_OPERATOR]);
  if (!access) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const body: unknown = await request.json().catch(() => null);
  const id = isRecord(body) && typeof body.id === 'string' ? body.id : null;
  const job = await cancelSandboxesTest(id);
  logger.info('{actor} cancelled Test connection on the sandbox setup', {
    component: COMPONENT,
    ...who(access),
    job: id ?? 'the running one',
  });
  return NextResponse.json({ job });
}
