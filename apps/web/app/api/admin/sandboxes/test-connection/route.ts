/**
 * Tries the sandbox setup the operator is ABOUT to save — the form's
 * fields, the stored secrets where none were typed — by handing it to
 * the orchestrator, which asks the provider whether it answers (the
 * identity, its role and the sandbox group on Azure; the engine and the
 * image on Docker). No sandbox is made. A failed try is a successful
 * request: it answers ok:false at HTTP 200.
 */

import { NextRequest, NextResponse } from 'next/server';
import { parseOrchestratorInput } from '@renkei/sandbox-client';
import { checkAccess, ROLE_OPERATOR } from '@/lib/access';
import { testSandboxes } from '@/lib/sandboxes-admin';

export async function POST(request: NextRequest): Promise<NextResponse> {
  const access = await checkAccess([ROLE_OPERATOR]);
  if (!access) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const input = parseOrchestratorInput(await request.json().catch(() => null));
  if (typeof input === 'string') return NextResponse.json({ error: input }, { status: 400 });
  return NextResponse.json(await testSandboxes(input));
}
