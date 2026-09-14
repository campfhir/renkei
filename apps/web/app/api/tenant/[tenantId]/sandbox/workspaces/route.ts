/**
 * The signed-in person's code workspaces — the connectors page's list and
 * clone calls. A thin, session-checked pass-through to the sandbox worker
 * (docs/sandbox-workspaces-design.md): the worker owns the checkouts and
 * scopes every row to this person's own (tenantId, subject).
 *
 * A clone spends the person's own Bitbucket grant: this route turns it
 * into a git credential (lib/sandbox/workspace-git.ts), forwards it to
 * the worker for that one clone, and keeps nothing — the same path the
 * sandbox_workspace_clone tool takes, so the UI and the model stand on
 * the same scope checks.
 */

import { NextRequest, NextResponse } from 'next/server';
import { validateRepoFullName } from '@renkei/connector-sandbox';
import { getSessionFromRequest } from '@/lib/session';
import { recordAuditEvent } from '@/lib/audit-events';
import { getOrigin } from '@/lib/get-origin';
import {
  clientFailure,
  sandboxWorkspacesEnabled,
  sbWorkspaceClone,
  sbWorkspaceList,
} from '@/lib/sandbox/service-client';
import { bitbucketCloneUrl, resolveWorkspaceGitCredential } from '@/lib/sandbox/workspace-git';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ tenantId: string }> }
): Promise<NextResponse> {
  const { tenantId } = await params;
  const session = await getSessionFromRequest(request, tenantId);
  if (!session) return NextResponse.json({ error: 'Not signed in' }, { status: 401 });
  if (!sandboxWorkspacesEnabled())
    return NextResponse.json({ error: 'Not found' }, { status: 404 });

  const listed = await sbWorkspaceList({ tenantId, subject: session.subject });
  if (!listed.ok) {
    const failure = clientFailure(listed.err);
    return NextResponse.json({ error: failure.message }, { status: failure.status });
  }
  return NextResponse.json({ workspaces: listed.val });
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ tenantId: string }> }
): Promise<NextResponse> {
  const { tenantId } = await params;
  const session = await getSessionFromRequest(request, tenantId);
  if (!session) return NextResponse.json({ error: 'Not signed in' }, { status: 401 });
  if (!sandboxWorkspacesEnabled())
    return NextResponse.json({ error: 'Not found' }, { status: 404 });

  const body: unknown = await request.json().catch(() => null);
  if (!isRecord(body)) {
    return NextResponse.json({ error: 'A JSON body is required' }, { status: 400 });
  }
  const repo = validateRepoFullName(body.repository);
  if (!repo.ok) return NextResponse.json({ error: repo.message }, { status: 400 });
  const branch = typeof body.branch === 'string' ? body.branch.trim() : '';
  const depth =
    typeof body.depth === 'number' && Number.isFinite(body.depth) ? body.depth : undefined;

  const origin = await getOrigin(request);
  const requestOrigin = origin.ok ? origin.val : '';
  const credential = await resolveWorkspaceGitCredential(
    { tenantId, subject: session.subject, origin: requestOrigin },
    { write: false }
  );
  if (typeof credential === 'string')
    return NextResponse.json({ error: credential }, { status: 409 });

  const cloned = await sbWorkspaceClone(
    { tenantId, subject: session.subject },
    {
      provider: 'atlassian-bitbucket',
      repoFullName: repo.fullName,
      ...(branch ? { branch } : {}),
      ...(depth !== undefined ? { depth } : {}),
      cloneUrl: bitbucketCloneUrl(repo.workspace, repo.repoSlug),
      authHeader: credential.authHeader,
    }
  );
  if (!cloned.ok) {
    const failure = clientFailure(cloned.err);
    return NextResponse.json({ error: failure.message }, { status: failure.status });
  }

  recordAuditEvent({
    tenantId,
    actorSubject: session.subject,
    action: 'sandbox.workspace.cloned',
    targetKind: 'sandbox_workspace',
    targetLabel: repo.fullName,
    details: { workspaceId: cloned.val.id, branch: branch || null },
  });
  return NextResponse.json({ workspace: cloned.val });
}
