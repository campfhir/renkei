/**
 * Halt a batch of runs across the organization — the operator's queue
 * view (app/(app)/admin/agents/queue) clearing a backlog. Body:
 * `{ runs: [{ agentId, runId }] }`, at most MAX_ORG_HALT. Each run is
 * force-halted as the single-run route does (force-halt.ts); the answer
 * lists which were halted and which were not, and why.
 */

import { NextRequest, NextResponse } from 'next/server';
import { isRecord } from '@renkei/guards';
import { checkAccess, ROLE_OPERATOR } from '@/lib/access';
import { MAX_ORG_HALT, haltRunsAsOperator } from '@/lib/agents/org-queue';

export async function POST(request: NextRequest): Promise<NextResponse> {
  const session = await checkAccess([ROLE_OPERATOR]);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'The body must be JSON.' }, { status: 400 });
  }
  const list = isRecord(body) ? body.runs : undefined;
  if (!Array.isArray(list) || list.length === 0) {
    return NextResponse.json({ error: 'runs must list at least one run.' }, { status: 400 });
  }
  if (list.length > MAX_ORG_HALT) {
    return NextResponse.json(
      { error: `Halt at most ${MAX_ORG_HALT} runs at a time.` },
      { status: 400 }
    );
  }
  const runs: { agentId: string; runId: string }[] = [];
  for (const entry of list) {
    if (!isRecord(entry) || typeof entry.agentId !== 'string' || typeof entry.runId !== 'string') {
      return NextResponse.json({ error: 'Each run is { agentId, runId }.' }, { status: 400 });
    }
    runs.push({ agentId: entry.agentId, runId: entry.runId });
  }

  return NextResponse.json(await haltRunsAsOperator(runs, session.subject));
}
