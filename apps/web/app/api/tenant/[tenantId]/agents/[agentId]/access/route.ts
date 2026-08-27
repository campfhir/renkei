/**
 * Who may see this agent as the owner does — the sharing modal's "People
 * with access" data. Owner only, structurally: every helper is keyed by
 * the caller's own subject, so someone else's agent is a 404.
 *
 * GET returns the grant list plus the tenant's people (recorded
 * identities) for the picker; POST grants (or re-grants, refreshing the
 * expiry) one person. Revocation is the [grantId] route's DELETE.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getDatabase } from '@renkei/db';
import { getSessionFromRequest } from '@/lib/session';
import { getIdentityDisplay, listIdentities } from '@/lib/identity';
import { getAgent } from '@/lib/agents/store';
import { grantAgentAccess, listAgentAccessGrants } from '@/lib/agents/access-grants';
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

  const grants = await listAgentAccessGrants(dbResult.val, tenantId, session.subject, agentId);
  if (grants === null) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  const people = (await listIdentities(tenantId)).filter(
    (person) => person.subject !== session.subject
  );
  return NextResponse.json({ grants, people });
}

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

  const body: unknown = await request.json().catch(() => null);
  const granteeSubject =
    typeof body === 'object' && body !== null && 'granteeSubject' in body
      ? body.granteeSubject
      : null;
  const expiresAtRaw =
    typeof body === 'object' && body !== null && 'expiresAt' in body ? body.expiresAt : null;
  if (typeof granteeSubject !== 'string' || granteeSubject.length === 0) {
    return NextResponse.json({ error: 'granteeSubject is required' }, { status: 400 });
  }

  let expiresAt: Date | null = null;
  if (typeof expiresAtRaw === 'string' && expiresAtRaw.length > 0) {
    const parsed = new Date(expiresAtRaw);
    if (Number.isNaN(parsed.getTime())) {
      return NextResponse.json({ error: 'expiresAt is not a date' }, { status: 400 });
    }
    if (parsed.getTime() <= Date.now()) {
      return NextResponse.json({ error: 'expiresAt is already in the past' }, { status: 400 });
    }
    expiresAt = parsed;
  } else if (expiresAtRaw !== null && expiresAtRaw !== undefined) {
    return NextResponse.json({ error: 'expiresAt is not a date' }, { status: 400 });
  }

  // A grant is addressed to a recorded person, not a free-typed string — a
  // typo'd subject would sit granting nothing to nobody, invisibly.
  const grantee = await getIdentityDisplay(tenantId, granteeSubject);
  if (!grantee) return NextResponse.json({ error: 'No such person in this org' }, { status: 400 });

  const agent = await getAgent(db, tenantId, session.subject, agentId);
  if (!agent) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  const outcome = await grantAgentAccess(db, tenantId, session.subject, agentId, {
    granteeSubject,
    expiresAt,
  });
  if (outcome === 'NOT_FOUND') return NextResponse.json({ error: 'Not found' }, { status: 404 });
  if (outcome === 'SELF') {
    return NextResponse.json(
      { error: 'You already have access to your own agent' },
      { status: 400 }
    );
  }

  recordAuditEvent({
    tenantId,
    actorSubject: session.subject,
    action: 'agent.access_granted',
    targetKind: 'agent',
    targetLabel: agent.name,
    details: { granteeSubject, expiresAt: expiresAt ? expiresAt.toISOString() : null },
  });
  const grants = await listAgentAccessGrants(db, tenantId, session.subject, agentId);
  return NextResponse.json({ grants: grants ?? [] });
}
