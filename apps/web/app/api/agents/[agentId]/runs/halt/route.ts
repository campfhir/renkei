/**
 * Halt stuck runs of an agent: the one named in the body
 * (`{ runId }`), or — with no body — every run of the agent that has been
 * queued or running for over two hours. See run-halt.ts for why
 * this exists beside cancel, and why only stuck runs qualify.
 *
 * Owner or grantee, like the cancel route: troubleshooting someone else's
 * stuck agent includes being able to clear it.
 */

import { NextRequest, NextResponse } from 'next/server';
import { isRecord } from '@renkei/guards';
import { getSessionFromRequest } from '@/lib/session';
import { resolveAgentAccess } from '@/lib/agents/access-grants';
import { haltStuckRuns } from '@/lib/agents/run-halt';
import { statusLabel } from '@/lib/agents/run-labels';
import { isUuid } from '@/lib/uuid';

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ agentId: string }> }
): Promise<NextResponse> {
  const { agentId } = await params;
  if (!isUuid(agentId)) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  const session = await getSessionFromRequest(request);
  if (!session) return NextResponse.json({ error: 'Not signed in' }, { status: 401 });

  const access = await resolveAgentAccess(session.subject, agentId);
  if (!access) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  let runId: string | undefined;
  const raw = await request.text();
  if (raw.trim()) {
    let body: unknown;
    try {
      body = JSON.parse(raw);
    } catch {
      return NextResponse.json({ error: 'The body must be JSON.' }, { status: 400 });
    }
    if (isRecord(body) && body.runId !== undefined) {
      if (typeof body.runId !== 'string') {
        return NextResponse.json({ error: 'runId must be a run id.' }, { status: 400 });
      }
      runId = body.runId;
    }
  }

  const result = await haltStuckRuns({
    agentId,
    ownerSubject: access.ownerSubject,
    bySubject: session.subject,
    ...(runId !== undefined ? { runId } : {}),
    nowMs: Date.now(),
  });

  switch (result.outcome) {
    case 'not-found':
      return NextResponse.json({ error: 'Not found' }, { status: 404 });
    case 'not-stuck':
      return NextResponse.json(
        {
          error:
            result.status === 'queued' || result.status === 'running'
              ? 'This run has not been stuck for two hours yet — cancel it instead.'
              : `This run is ${statusLabel(result.status).toLowerCase()}, not stuck.`,
        },
        { status: 409 }
      );
    case 'halted':
      return NextResponse.json({ halted: result.runIds });
  }
}
