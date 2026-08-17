/**
 * Prose → drafted steps, for the builder's "start from a description" box.
 * Synchronous on purpose — the user is watching a spinner and the answer
 * IS the response. Nothing is persisted: the drafted steps land in the
 * builder for review and the ordinary save path validates them like
 * anything typed by hand.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getDatabase } from '@renkei/db';
import { isAgentStepsDoc } from '@renkei/agents';
import { getSessionFromRequest } from '@/lib/session';
import { listAvailableTools } from '@/lib/mcp-tools/tool-catalog';
import { draftAgentFromProse } from '@/lib/agents/draft-from-prose';

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ tenantId: string }> }
): Promise<NextResponse> {
  const { tenantId } = await params;
  const session = await getSessionFromRequest(request, tenantId);
  if (!session) return NextResponse.json({ error: 'Not signed in' }, { status: 401 });

  const dbResult = getDatabase();
  if (!dbResult.ok) return NextResponse.json({ error: 'Database unavailable' }, { status: 500 });

  const body: unknown = await request.json().catch(() => null);
  const payload: { text?: unknown; steps?: unknown; triggerVars?: unknown } =
    typeof body === 'object' && body !== null ? body : {};
  if (typeof payload.text !== 'string' || payload.text.trim().length < 10) {
    return NextResponse.json(
      { error: 'Describe the automation in a sentence or two first.' },
      { status: 400 }
    );
  }
  // Revision context: the builder's CURRENT (possibly unsaved) steps — the
  // model revises what the user is looking at, not what was last saved.
  const currentSteps = isAgentStepsDoc(payload.steps) ? payload.steps.steps : [];
  const triggerVars = Array.isArray(payload.triggerVars)
    ? payload.triggerVars.filter(
        (name): name is string => typeof name === 'string' && name.length <= 128
      )
    : [];

  const tools = await listAvailableTools(tenantId, session.subject);
  const drafted = await draftAgentFromProse(dbResult.val, tenantId, payload.text.trim(), tools, {
    currentSteps,
    triggerVars,
  });
  if ('error' in drafted) {
    return NextResponse.json(
      { error: drafted.error, ...(drafted.detail ? { detail: drafted.detail } : {}) },
      { status: 422 }
    );
  }

  return NextResponse.json(drafted);
}
