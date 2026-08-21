/**
 * The operator's off switch for any agent — disable only, never edit:
 * troubleshooting and containment are the admin's job, authoring is the
 * owner's. Audited, because turning off someone else's automation is an
 * act they will ask about.
 */

import { NextRequest, NextResponse } from 'next/server';
import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import { getDatabase } from '@renkei/db';
import { checkAccess, ROLE_OPERATOR } from '@/lib/access';
import { tenantForSlug } from '@/lib/tenant-slug';
import { recordAuditEvent } from '@/lib/audit-events';
import { isUuid } from '@/lib/uuid';

export async function POST(
  _request: NextRequest,
  { params }: { params: Promise<{ slug: string; agentId: string }> }
): Promise<NextResponse> {
  const { slug, agentId } = await params;
  if (!isUuid(agentId)) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  const tenant = await tenantForSlug(slug);
  if (!tenant) return NextResponse.json({ error: 'Tenant not found' }, { status: 404 });
  const access = await checkAccess(tenant.id, [ROLE_OPERATOR]);
  if (!access) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const dbResult = getDatabase();
  if (!dbResult.ok) return NextResponse.json({ error: 'Database unavailable' }, { status: 500 });
  const db = dbResult.val;

  const agent = await db
    .selectFrom('agents')
    .select(['name'])
    .where('tenant_id', '=', tenant.id)
    .where('id', '=', agentId)
    .executeTakeFirst();

  const updated = await db
    .updateTable('agents')
    .set({ enabled: false, updated_at: sql`NOW()` })
    .where('tenant_id', '=', tenant.id)
    .where('id', '=', agentId)
    .executeTakeFirst();
  if (Number(updated.numUpdatedRows ?? 0) === 0) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }

  // Twice on purpose: the deployment-scoped log is the installation's
  // record; the tenant trail is what the org's own audit page reads.
  await db
    .insertInto('platform_audit_log')
    .values({
      id: randomUUID(),
      event_type: 'agent.disabled_by_admin',
      actor_id: access.subject,
      resource_id: agentId,
      details: JSON.stringify({ tenantId: tenant.id }),
    })
    .execute();
  recordAuditEvent({
    tenantId: tenant.id,
    actorSubject: access.subject,
    action: 'agent.disabled',
    targetKind: 'agent',
    targetLabel: agent?.name ?? agentId,
    details: { byAdmin: true },
  });

  return NextResponse.json({ disabled: true });
}
