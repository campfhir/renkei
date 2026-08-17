/**
 * One agent: read, update, delete — owner only. Someone else's agentId is
 * a 404, never a 403 (server-derived authority: the row is looked up by
 * the caller's own subject, so there is no "exists but forbidden" to leak).
 *
 * DELETE cascades the run history by FK design: deleting an agent is the
 * owner saying the whole thing goes.
 */

import { NextRequest, NextResponse } from 'next/server';
import { after } from 'next/server';
import { getDatabase } from '@renkei/db';
import { normalizeAgentDraft, validateAgentDraft } from '@renkei/agents';
import { getSessionFromRequest } from '@/lib/session';
import { listAvailableTools } from '@/lib/mcp-tools/tool-catalog';
import { parseAgentPayload } from '@/lib/agents/payload';
import { deleteAgent, getAgent, updateAgent } from '@/lib/agents/store';
import { generateAgentDescription } from '@/lib/agents/describe';
import { recordAuditEvent } from '@/lib/audit-events';

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ tenantId: string; agentId: string }> }
): Promise<NextResponse> {
  const { tenantId, agentId } = await params;
  const session = await getSessionFromRequest(request, tenantId);
  if (!session) return NextResponse.json({ error: 'Not signed in' }, { status: 401 });

  const dbResult = getDatabase();
  if (!dbResult.ok) return NextResponse.json({ error: 'Database unavailable' }, { status: 500 });

  const agent = await getAgent(dbResult.val, tenantId, session.subject, agentId);
  if (!agent) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  return NextResponse.json({ agent });
}

export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ tenantId: string; agentId: string }> }
): Promise<NextResponse> {
  const { tenantId, agentId } = await params;
  const session = await getSessionFromRequest(request, tenantId);
  if (!session) return NextResponse.json({ error: 'Not signed in' }, { status: 401 });

  const dbResult = getDatabase();
  if (!dbResult.ok) return NextResponse.json({ error: 'Database unavailable' }, { status: 500 });

  const body = await request.json().catch(() => null);
  const parsed = parseAgentPayload(body);
  if ('error' in parsed) return NextResponse.json({ error: parsed.error }, { status: 400 });

  const normalized = normalizeAgentDraft(parsed.draft);
  const tools = await listAvailableTools(tenantId, session.subject);
  const issues = validateAgentDraft(normalized, tools);
  if (issues.length > 0) return NextResponse.json({ issues }, { status: 422 });

  // A save that changed nothing the summary describes — an on/off toggle —
  // keeps the description it has instead of going stale and paying for a
  // model call it cannot improve.
  const existing = await getAgent(dbResult.val, tenantId, session.subject, agentId);
  if (!existing) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  const describedChanged =
    existing.name !== normalized.name ||
    JSON.stringify(existing.steps) !== JSON.stringify(normalized.steps) ||
    JSON.stringify(existing.triggers.map((trigger) => trigger.draft)) !==
      JSON.stringify(normalized.triggers);
  const needsDescription = describedChanged || existing.descriptionStatus !== 'ok';

  const result = await updateAgent(
    dbResult.val,
    tenantId,
    session.subject,
    agentId,
    {
      ...parsed.input,
      name: normalized.name,
      steps: normalized.steps,
    },
    { markDescriptionStale: needsDescription }
  );
  if (result === 'NOT_FOUND') return NextResponse.json({ error: 'Not found' }, { status: 404 });
  if (result === 'NAME_TAKEN') {
    return NextResponse.json(
      { issues: [{ path: 'name', message: 'You already have an agent with this name.' }] },
      { status: 422 }
    );
  }

  // A toggle and an edit are different stories in the audit trail: "turned
  // it on" is a decision to let it act, "changed it" is a change to what it
  // does. A save that flips enabled AND rewrites steps records both.
  if (existing.enabled !== normalized.enabled) {
    recordAuditEvent({
      tenantId,
      actorSubject: session.subject,
      action: normalized.enabled ? 'agent.enabled' : 'agent.disabled',
      targetKind: 'agent',
      targetLabel: normalized.name,
    });
  }
  if (describedChanged) {
    recordAuditEvent({
      tenantId,
      actorSubject: session.subject,
      action: 'agent.updated',
      targetKind: 'agent',
      targetLabel: normalized.name,
    });
  }

  if (needsDescription) {
    // Written AFTER the response; the builder polls and shows an indicator.
    after(() =>
      generateAgentDescription(dbResult.val, tenantId, {
        id: agentId,
        name: normalized.name,
        steps: normalized.steps,
        triggers: normalized.triggers,
        llmModelId: parsed.input.llmModelId,
      })
    );
  }

  const agent = await getAgent(dbResult.val, tenantId, session.subject, agentId);
  return NextResponse.json({
    agent,
    apiKeys: result.apiKeys,
    descriptionPending: needsDescription,
  });
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ tenantId: string; agentId: string }> }
): Promise<NextResponse> {
  const { tenantId, agentId } = await params;
  const session = await getSessionFromRequest(request, tenantId);
  if (!session) return NextResponse.json({ error: 'Not signed in' }, { status: 401 });

  const dbResult = getDatabase();
  if (!dbResult.ok) return NextResponse.json({ error: 'Database unavailable' }, { status: 500 });

  // Fetched first: after the cascade there is no row left to name in the
  // audit trail, and "deleted agent <uuid>" tells an operator nothing.
  const existing = await getAgent(dbResult.val, tenantId, session.subject, agentId);
  const deleted = await deleteAgent(dbResult.val, tenantId, session.subject, agentId);
  if (!deleted) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  recordAuditEvent({
    tenantId,
    actorSubject: session.subject,
    action: 'agent.deleted',
    targetKind: 'agent',
    targetLabel: existing?.name ?? agentId,
  });
  return NextResponse.json({ deleted: true });
}
