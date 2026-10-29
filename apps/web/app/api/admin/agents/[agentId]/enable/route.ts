/**
 * The operator's on switch for any agent — the mirror of disable/route.ts.
 * Containment (turning something off) used to be the admin's only lever
 * here; the agent detail page's toggle needs the reverse too, so an admin
 * who paused an agent (or is looking at one an owner left off) can put it
 * back — audited the same way disabling is, because turning someone else's
 * automation on is just as much an act they will ask about.
 */

import { NextRequest, NextResponse } from 'next/server';
import { randomUUID } from 'node:crypto';
import { getDataStore } from '@renkei/db';
import { checkAccess, ROLE_OPERATOR } from '@/lib/access';
import { recordAuditEvent } from '@/lib/audit-events';
import { isUuid } from '@/lib/uuid';

export async function POST(
  _request: NextRequest,
  { params }: { params: Promise<{ agentId: string }> }
): Promise<NextResponse> {
  const { agentId } = await params;
  if (!isUuid(agentId)) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  const access = await checkAccess([ROLE_OPERATOR]);
  if (!access) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const store = getDataStore();
  const agent = await store.agents.setEnabled(agentId, true);
  if (!agent) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  // Twice on purpose: the deployment-scoped log is the installation's
  // record; the tenant trail is what the org's own audit page reads.
  await store.auditEvents.recordPlatform({
    id: randomUUID(),
    eventType: 'agent.enabled_by_admin',
    actorId: access.subject,
    resourceId: agentId,
    details: {},
  });
  recordAuditEvent({
    actorSubject: access.subject,
    action: 'agent.enabled',
    targetKind: 'agent',
    targetLabel: agent.name,
    details: { byAdmin: true },
  });

  return NextResponse.json({ enabled: true });
}
