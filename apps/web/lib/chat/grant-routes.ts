/**
 * The grants routes for projects and libraries share one body: list for
 * the owner, add a person with a role and an optional expiry, revoke.
 * Chats have their own copy because their role is fixed to viewer.
 */

import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import {
  grantResourceAccess,
  isGrantRole,
  listResourceGrants,
  revokeResourceGrant,
} from './access';
import { parseExpiry } from './grant-input';
import { chatRequestContext, jsonError, readJsonBody } from './route-support';

export async function listGrantsRoute(
  request: NextRequest,
  tenantId: string,
  kind: 'chat_project' | 'prompt_library',
  resourceId: string
): Promise<Response> {
  const ready = await chatRequestContext(request, tenantId);
  if (!ready.ok) return ready.response;
  const { db, session } = ready.context;
  return NextResponse.json({
    grants: await listResourceGrants(db, tenantId, session.subject, kind, resourceId),
  });
}

export async function addGrantRoute(
  request: NextRequest,
  tenantId: string,
  kind: 'chat_project' | 'prompt_library',
  resourceId: string
): Promise<Response> {
  const ready = await chatRequestContext(request, tenantId);
  if (!ready.ok) return ready.response;
  const { db, session } = ready.context;
  const body = await readJsonBody(request);
  const granteeSubject = typeof body.granteeSubject === 'string' ? body.granteeSubject.trim() : '';
  if (!granteeSubject) return jsonError(400, 'invalid', 'Choose a person');
  const role = isGrantRole(body.role) ? body.role : 'viewer';
  const expiresAt = parseExpiry(body.expiresAt);
  if (expiresAt === undefined) return jsonError(400, 'invalid', 'Invalid expiry');
  const outcome = await grantResourceAccess(db, tenantId, session.subject, kind, resourceId, {
    granteeSubject,
    role,
    expiresAt,
  });
  if (outcome === 'NOT_FOUND') return jsonError(404, 'not-found', 'Not found');
  if (outcome === 'SELF') return jsonError(400, 'self', 'That is you');
  if (outcome === 'INVALID_ROLE') return jsonError(400, 'invalid', 'Invalid role');
  return NextResponse.json({ ok: true });
}

export async function revokeGrantRoute(
  request: NextRequest,
  tenantId: string,
  kind: 'chat_project' | 'prompt_library',
  resourceId: string,
  grantId: string
): Promise<Response> {
  const ready = await chatRequestContext(request, tenantId);
  if (!ready.ok) return ready.response;
  const { db, session } = ready.context;
  const revoked = await revokeResourceGrant(
    db,
    tenantId,
    session.subject,
    kind,
    resourceId,
    grantId
  );
  if (!revoked) return jsonError(404, 'not-found', 'No such share');
  return NextResponse.json({ ok: true });
}
