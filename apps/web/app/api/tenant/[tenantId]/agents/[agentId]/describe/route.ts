/**
 * On-demand re-check: regenerate the summary and worth-checking notes for
 * the agent AS SAVED. The builder offers this beside the notes so a rule
 * change in the checker (or a fixed model config) can be re-applied
 * without editing anything — and it analyzes the stored version on
 * purpose: describing unsaved edits would pin a summary to steps that may
 * never be saved.
 */

import { NextRequest, NextResponse } from 'next/server';
import { after } from 'next/server';
import { sql } from 'kysely';
import { getDatabase } from '@renkei/db';
import { getSessionFromRequest } from '@/lib/session';
import { resolveAgentAccess } from '@/lib/agents/access-grants';
import { generateAgentDescription } from '@/lib/agents/describe';

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ tenantId: string; agentId: string }> }
): Promise<NextResponse> {
  const { tenantId, agentId } = await params;
  const session = await getSessionFromRequest(request, tenantId);
  if (!session) return NextResponse.json({ error: 'Not signed in' }, { status: 401 });

  const dbResult = getDatabase();
  if (!dbResult.ok) return NextResponse.json({ error: 'Database unavailable' }, { status: 500 });
  const db = dbResult.val;

  const access = await resolveAgentAccess(db, tenantId, session.subject, agentId);
  if (!access) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  const agent = access.agent;

  // 'stale' is what the polling clients watch; set it before the response
  // so their spinner starts on the very next poll.
  await db
    .updateTable('agents')
    .set({ description_status: 'stale', updated_at: sql`NOW()` })
    .where('tenant_id', '=', tenantId)
    .where('id', '=', agentId)
    .execute();

  after(() =>
    generateAgentDescription(db, tenantId, {
      id: agent.id,
      name: agent.name,
      steps: agent.steps,
      triggers: agent.triggers.map((trigger) => trigger.draft),
      llmModelId: agent.llmModelId,
      guardrails: agent.guardrails,
    })
  );

  return NextResponse.json({ descriptionPending: true }, { status: 202 });
}
