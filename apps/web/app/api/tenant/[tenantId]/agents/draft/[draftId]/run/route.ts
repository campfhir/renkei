/**
 * Do the drafting. Called by the agents worker, never by a browser.
 *
 * Why the work stayed here rather than moving into the worker: drafting
 * needs the caller's TOOL CATALOG, and that is built by running the whole
 * MCP registration for a specific user against this app's own module graph.
 * Porting it would mean two copies of a thing that must not drift. The
 * worker supplies what it is good at — a durable queue, retries, and a
 * process that does not care whether anyone is still looking at the page —
 * and calls this over the same internal URL it already uses for MCP.
 *
 * ## Authentication
 *
 * The same bearer token the worker mints to act as a run's owner at the MCP
 * endpoint, with `application: 'agent'`. That is deliberate rather than a
 * new shared secret: the token names a SUBJECT, and drafting must run with
 * the draft owner's catalog. A token for the wrong subject cannot draft as
 * the right one, because the subject is read from the token and matched
 * against the row.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getDatabase } from '@renkei/db';
import { isAgentStepsDoc } from '@renkei/agents';
import { getBearerToken, resolveAccessToken } from '@/lib/mcp-token';
import { listAvailableTools } from '@/lib/mcp-tools/tool-catalog';
import { claimDraft, finishDraft, getDraft } from '@/lib/agents/draft-store';
import { draftAgentFromProse, type TriggerVarInfo } from '@/lib/agents/draft-from-prose';
import { logger } from '@/lib/logger';

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
  { params }: { params: Promise<{ tenantId: string; draftId: string }> }
): Promise<NextResponse> {
  const { tenantId, draftId } = await params;

  const token = getBearerToken(request);
  if (!token) return NextResponse.json({ error: 'Not authorized' }, { status: 401 });
  const record = await resolveAccessToken(token, tenantId, 'agent');
  if (!record) return NextResponse.json({ error: 'Not authorized' }, { status: 401 });

  const dbResult = getDatabase();
  if (!dbResult.ok) return NextResponse.json({ error: 'Database unavailable' }, { status: 500 });
  const db = dbResult.val;

  // Owner-scoped by the TOKEN's subject: this is what stops a token minted
  // for one person from drafting with another person's tool catalog.
  const draft = await getDraft(db, tenantId, record.subject, draftId);
  if (!draft) return NextResponse.json({ error: 'No such draft' }, { status: 404 });

  // The claim is the idempotency guard. A redelivered queue row — or a
  // second replica racing the first — finds the row already running and
  // stops, rather than spending a second model call on the same answer.
  if (!(await claimDraft(db, draftId))) {
    return NextResponse.json({ status: draft.status, alreadyClaimed: true });
  }

  try {
    const currentSteps = isAgentStepsDoc(draft.request.steps) ? draft.request.steps.steps : [];
    const suggestTriggers = draft.request.suggestTriggers;

    // Agent-finished trigger targets come from the database, not the stored
    // request: a drafted callerAgentId ends up saved on a trigger, so the
    // name→id mapping must only ever cover agents this caller owns NOW.
    const otherAgents = suggestTriggers
      ? await db
          .selectFrom('agents')
          .select(['id', 'name'])
          .where('tenant_id', '=', tenantId)
          .where('owner_subject', '=', record.subject)
          .orderBy('name')
          .execute()
      : [];

    const tools = await listAvailableTools(tenantId, record.subject);
    const drafted = await draftAgentFromProse(db, tenantId, draft.request.text, tools, {
      currentSteps,
      triggerVars: parseTriggerVars(draft.request.triggerVars),
      suggestTriggers,
      otherAgents,
      guardrails: draft.request.guardrails,
      // Still NOT refineWithReview. Nobody is watching a spinner any more,
      // but that loop costs up to five more SEQUENTIAL model calls, each
      // re-sending the whole tool catalog and regenerating every step
      // verbatim. The quality pass already happens on save, where it fills
      // the builder's "Worth checking" panel.
    });

    if ('error' in drafted) {
      await finishDraft(db, draftId, {
        status: 'failed',
        error: drafted.error,
        detail: drafted.detail ?? null,
      });
      return NextResponse.json({ status: 'failed' });
    }

    await finishDraft(db, draftId, { status: 'succeeded', result: drafted });
    return NextResponse.json({ status: 'succeeded' });
  } catch (error) {
    // The row must not be left claimed: a draft stuck in `running` can never
    // be retried, and the builder would poll it until it gave up. Recording
    // the failure is what turns a crash into something a person can read.
    const message = error instanceof Error ? error.message : String(error);
    logger.error('draft {draftId} threw: {error}', {
      component: 'api/agents-draft-run',
      tenantId,
      draftId,
      error: message,
    });
    await finishDraft(db, draftId, { status: 'failed', error: message });
    // 500 so the queue records a failure too — the row is already terminal,
    // so the retry finds it claimed and stops. The job's error is the trail.
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
