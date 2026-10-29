/**
 * The operator's off switch for any agent — disable only, never edit:
 * troubleshooting and containment are the admin's job, authoring is the
 * owner's. Audited, because turning off someone else's automation is an
 * act they will ask about.
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
  const agent = await store.agents.setEnabled(agentId, false);
  if (!agent) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  // Twice on purpose: the deployment-scoped log is the installation's
  // record; the tenant trail is what the org's own audit page reads.
  await store.auditEvents.recordPlatform({
    id: randomUUID(),
    eventType: 'agent.disabled_by_admin',
    actorId: access.subject,
    resourceId: agentId,
    details: {},
  });
  recordAuditEvent({
    actorSubject: access.subject,
    action: 'agent.disabled',
    targetKind: 'agent',
    targetLabel: agent.name,
    details: { byAdmin: true },
  });

  return NextResponse.json({ disabled: true });
}
