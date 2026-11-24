/**
 * An environment's health token (lib/ci/health.ts), for the Environments
 * page. Editors only.
 *
 *   POST { environment } → { token, url, hint }: a new token for that
 *     environment of the project, in place of any it had. The token is in
 *     this answer and nowhere else: Renkei keeps its hash.
 *   DELETE { environment } → the token is taken away, and the check-ins
 *     made with it stop showing.
 */

import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { jsonError, readJsonBody } from '@/lib/chat/route-support';
import { recordAuditEvent } from '@/lib/audit-events';
import { projectEnvironments } from '@/lib/ci/environments';
import { checkInUrl, issueHealthToken, revokeHealthToken } from '@/lib/ci/health';
import { builderContext } from '@/lib/ci/pipeline-builder-access';

async function environmentNamed(projectId: string, name: unknown): Promise<string | null> {
  const wanted = typeof name === 'string' ? name.trim().toLowerCase() : '';
  if (!wanted) return null;
  const found = (await projectEnvironments(projectId)).find((e) => e.name.toLowerCase() === wanted);
  return found?.name ?? null;
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ projectId: string }> }
): Promise<Response> {
  const { projectId } = await params;
  const found = await builderContext(request, projectId, { write: true });
  if (!found.ok) return found.response;
  const { project, subject, origin } = found.context;
  const body = await readJsonBody(request);
  const environment = await environmentNamed(projectId, body.environment);
  if (!environment) {
    return jsonError(400, 'environment', 'The project has no environment of that name.');
  }
  const url = checkInUrl(origin);
  if (!url) {
    return jsonError(
      409,
      'origin',
      'Renkei does not know its own address here, so an application has nowhere to check in; an operator sets the site’s address.'
    );
  }
  const issued = await issueHealthToken(projectId, environment, subject, new Date());
  recordAuditEvent({
    actorSubject: subject,
    action: 'ci.health_token_issued',
    targetKind: 'code_project',
    targetLabel: project.name,
    // The hint tells one token from another; the token itself is never recorded.
    details: { projectId, environment, tokenHint: issued.hint },
  });
  return NextResponse.json({ token: issued.token, hint: issued.hint, url, environment });
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ projectId: string }> }
): Promise<Response> {
  const { projectId } = await params;
  const found = await builderContext(request, projectId, { write: true });
  if (!found.ok) return found.response;
  const { project, subject } = found.context;
  const body = await readJsonBody(request);
  const environment =
    (await environmentNamed(projectId, body.environment)) ??
    (typeof body.environment === 'string' ? body.environment.trim() : '');
  if (!environment) return jsonError(400, 'environment', 'Which environment?');
  const revoked = await revokeHealthToken(projectId, environment);
  if (revoked) {
    recordAuditEvent({
      actorSubject: subject,
      action: 'ci.health_token_revoked',
      targetKind: 'code_project',
      targetLabel: project.name,
      details: { projectId, environment },
    });
  }
  return NextResponse.json({ revoked });
}
