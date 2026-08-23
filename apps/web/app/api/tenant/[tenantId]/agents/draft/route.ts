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
import { draftAgentFromProse, type TriggerVarInfo } from '@/lib/agents/draft-from-prose';

/** Accept {name, description} entries, tolerating the older bare-string form. */
function parseTriggerVars(value: unknown): TriggerVarInfo[] {
  if (!Array.isArray(value)) return [];
  const parsed: TriggerVarInfo[] = [];
  for (const entry of value) {
    if (typeof entry === 'string' && entry.length <= 128) {
      parsed.push({
        name: entry,
        description: 'Provided by a trigger when the automation starts.',
      });
    } else if (typeof entry === 'object' && entry !== null) {
      const candidate: { name?: unknown; description?: unknown } = entry;
      if (
        typeof candidate.name === 'string' &&
        candidate.name.length > 0 &&
        candidate.name.length <= 128
      ) {
        parsed.push({
          name: candidate.name,
          description:
            typeof candidate.description === 'string' && candidate.description
              ? candidate.description.slice(0, 400)
              : 'Provided by a trigger when the automation starts.',
        });
      }
    }
  }
  return parsed;
}

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
  const payload: {
    text?: unknown;
    steps?: unknown;
    triggerVars?: unknown;
    suggestTriggers?: unknown;
  } = typeof body === 'object' && body !== null ? body : {};
  if (typeof payload.text !== 'string' || payload.text.trim().length < 10) {
    return NextResponse.json(
      { error: 'Describe the automation in a sentence or two first.' },
      { status: 400 }
    );
  }
  // Revision context: the builder's CURRENT (possibly unsaved) steps — the
  // model revises what the user is looking at, not what was last saved.
  const currentSteps = isAgentStepsDoc(payload.steps) ? payload.steps.steps : [];
  const triggerVars = parseTriggerVars(payload.triggerVars);

  // Agent-finished trigger targets come from the database, not the request:
  // the drafted callerAgentId ends up saved on a trigger, so the name→id
  // mapping must only ever cover agents the caller actually owns.
  const suggestTriggers = payload.suggestTriggers === true;
  const otherAgents = suggestTriggers
    ? await dbResult.val
        .selectFrom('agents')
        .select(['id', 'name'])
        .where('tenant_id', '=', tenantId)
        .where('owner_subject', '=', session.subject)
        .orderBy('name')
        .execute()
    : [];

  const tools = await listAvailableTools(tenantId, session.subject);
  const drafted = await draftAgentFromProse(dbResult.val, tenantId, payload.text.trim(), tools, {
    currentSteps,
    triggerVars,
    suggestTriggers,
    otherAgents,
  });
  if ('error' in drafted) {
    return NextResponse.json(
      { error: drafted.error, ...(drafted.detail ? { detail: drafted.detail } : {}) },
      { status: 422 }
    );
  }

  return NextResponse.json(drafted);
}
