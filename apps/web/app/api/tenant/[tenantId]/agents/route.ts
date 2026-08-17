/**
 * Your agents: list and create.
 *
 * Validation is the shared @renkei/agents validator, run here as the
 * authority against THIS caller's tool projection (listAvailableTools —
 * the same gates the MCP route applies). The draft is normalized before
 * persisting, which is where the 5-attempt ceiling becomes a server fact
 * rather than a UI courtesy.
 *
 * A create returns any freshly minted API-trigger keys exactly once; only
 * their SHA-256 digests are stored.
 */

import { NextRequest, NextResponse } from 'next/server';
import { after } from 'next/server';
import { getDatabase } from '@renkei/db';
import { normalizeAgentDraft, validateAgentDraft } from '@renkei/agents';
import { getOrgSettings } from '@renkei/settings';
import { getSessionFromRequest } from '@/lib/session';
import { listAvailableTools } from '@/lib/mcp-tools/tool-catalog';
import { parseAgentPayload } from '@/lib/agents/payload';
import { createAgent, listAgents } from '@/lib/agents/store';
import { recordAuditEvent } from '@/lib/audit-events';
import { generateAgentDescription } from '@/lib/agents/describe';

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ tenantId: string }> }
): Promise<NextResponse> {
  const { tenantId } = await params;
  const session = await getSessionFromRequest(request, tenantId);
  if (!session) return NextResponse.json({ error: 'Not signed in' }, { status: 401 });

  const dbResult = getDatabase();
  if (!dbResult.ok) return NextResponse.json({ error: 'Database unavailable' }, { status: 500 });

  const agents = await listAgents(dbResult.val, tenantId, session.subject);
  return NextResponse.json({ agents });
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

  const body = await request.json().catch(() => null);
  const parsed = parseAgentPayload(body);
  if ('error' in parsed) return NextResponse.json({ error: parsed.error }, { status: 400 });

  const settings = await getOrgSettings(tenantId);
  const normalized = normalizeAgentDraft(parsed.draft, {
    attemptsCap: settings.ok ? settings.val.agentMaxStepAttempts : undefined,
  });
  const tools = await listAvailableTools(tenantId, session.subject);
  const issues = validateAgentDraft(normalized, tools);
  if (issues.length > 0) return NextResponse.json({ issues }, { status: 422 });

  const result = await createAgent(dbResult.val, tenantId, session.subject, {
    ...parsed.input,
    name: normalized.name,
    steps: normalized.steps,
  });
  if (result === 'NAME_TAKEN') {
    return NextResponse.json(
      { issues: [{ path: 'name', message: 'You already have an agent with this name.' }] },
      { status: 422 }
    );
  }

  recordAuditEvent({
    tenantId,
    actorSubject: session.subject,
    action: 'agent.created',
    targetKind: 'agent',
    targetLabel: normalized.name,
  });

  // The summary is written AFTER the response: authoring must never wait
  // on a model. The builder polls the agent until description_status
  // resolves and shows a writing indicator meanwhile.
  after(() =>
    generateAgentDescription(dbResult.val, tenantId, {
      id: result.agentId,
      name: normalized.name,
      steps: normalized.steps,
      triggers: normalized.triggers,
      llmModelId: parsed.input.llmModelId,
    })
  );

  return NextResponse.json(
    { agentId: result.agentId, apiKeys: result.apiKeys, descriptionPending: true },
    { status: 201 }
  );
}
