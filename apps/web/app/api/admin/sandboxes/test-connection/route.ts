/**
 * Test connection on Organization → Sandboxes, as a job the orchestrator
 * runs (it can take minutes: a disk image built for this release, a test
 * sandbox that boots). POST starts trying the setup the operator is ABOUT
 * to save — the form's fields, the stored secrets where none were typed —
 * and answers the job at once; GET answers the job running, or the last
 * one, which the page reads every few seconds until it ends. Nothing is
 * stored. A test that failed is a successful request: its job says so.
 */

import { NextRequest, NextResponse } from 'next/server';
import { parseOrchestratorInput } from '@renkei/sandbox-client';
import { checkAccess, ROLE_OPERATOR } from '@/lib/access';
import { logger } from '@/lib/logger';
import { who } from '@/lib/log-actor';
import { sandboxesTestStatus, testSandboxes } from '@/lib/sandboxes-admin';

const COMPONENT = 'api/admin/sandboxes/test-connection';

export async function POST(request: NextRequest): Promise<NextResponse> {
  const access = await checkAccess([ROLE_OPERATOR]);
  if (!access) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const input = parseOrchestratorInput(await request.json().catch(() => null));
  if (typeof input === 'string') return NextResponse.json({ error: input }, { status: 400 });
  const job = await testSandboxes(input);
  logger.info('{actor} started Test connection on the sandbox setup; the test is {state}', {
    component: COMPONENT,
    ...who(access),
    job: job.id,
    state: job.state,
  });
  return NextResponse.json({ job });
}

export async function GET(_request: NextRequest): Promise<NextResponse> {
  const access = await checkAccess([ROLE_OPERATOR]);
  if (!access) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  return NextResponse.json({ job: await sandboxesTestStatus() });
}
