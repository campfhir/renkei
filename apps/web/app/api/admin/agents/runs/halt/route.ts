/**
 * Halt a batch of runs across the organization — the operator's queue
 * view (app/(app)/admin/agents/queue) clearing a backlog. Each run is
 * force-halted as the single-run route does (force-halt.ts); the answer
 * lists which were halted and which were not, and why. The body is one of:
 *  - `{ runs: [{ agentId, runId }] }`, at most MAX_ORG_HALT: these runs;
 *  - `{ all: { status? } }`: the oldest ALL_HALT_BATCH live runs (of that
 *    status, or any), answered with how many still match — the page asks
 *    again until none are left.
 */

import { NextRequest, NextResponse } from 'next/server';
import { isRecord } from '@renkei/guards';
import { checkAccess, ROLE_OPERATOR } from '@/lib/access';
import { recordAuditEvent } from '@/lib/audit-events';
import { MAX_ORG_HALT, haltAllMatching, haltRunsAsOperator } from '@/lib/agents/org-queue';

const LIVE = ['queued', 'running', 'waiting'];

export async function POST(request: NextRequest): Promise<NextResponse> {
  const session = await checkAccess([ROLE_OPERATOR]);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'The body must be JSON.' }, { status: 400 });
  }
  if (isRecord(body) && body.all !== undefined) {
    const all = body.all;
    const status = isRecord(all) ? all.status : undefined;
    if (
      !isRecord(all) ||
      (status !== undefined && (typeof status !== 'string' || !LIVE.includes(status)))
    ) {
      return NextResponse.json(
        { error: 'all is { status? }, the status one of queued, running, waiting.' },
        { status: 400 }
      );
    }
    const outcome = await haltAllMatching(
      typeof status === 'string' ? [status] : undefined,
      session.subject
    );
    // An operator ending other people's runs in bulk: who, which sweep, and what it did.
    recordAuditEvent({
      actorSubject: session.subject,
      action: 'agent.runs_halted',
      targetKind: 'agent_run',
      targetLabel: typeof status === 'string' ? `every ${status} run` : 'every live run',
      details: { scope: 'all', status: typeof status === 'string' ? status : null, outcome },
    });
    return NextResponse.json(outcome);
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

  const outcome = await haltRunsAsOperator(runs, session.subject);
  recordAuditEvent({
    actorSubject: session.subject,
    action: 'agent.runs_halted',
    targetKind: 'agent_run',
    targetLabel: `${runs.length} selected run(s)`,
    details: { scope: 'selected', runIds: runs.map((run) => run.runId), outcome },
  });
  return NextResponse.json(outcome);
}
