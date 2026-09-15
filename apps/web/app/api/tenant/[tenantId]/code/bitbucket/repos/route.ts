/**
 * Create an empty Bitbucket repository — for the new-project form's
 * "Create new repository" tab. The result is a RepoChoice, same shape
 * the browser returns for an existing repository, so the form treats a
 * freshly created repo exactly like one it found.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSessionFromRequest } from '@/lib/session';
import { sandboxWorkspacesEnabled } from '@renkei/sandbox-client';
import { bitbucketAuthFor, createRepository } from '@/lib/code/bitbucket-browse';
import { optionalString, readJsonBody } from '@/lib/chat/route-support';

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ tenantId: string }> }
): Promise<NextResponse> {
  const { tenantId } = await params;
  const session = await getSessionFromRequest(request, tenantId);
  if (!session) return NextResponse.json({ error: 'Not signed in' }, { status: 401 });
  if (!sandboxWorkspacesEnabled())
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  const body = await readJsonBody(request);
  const workspace = optionalString(body.workspace, 200) ?? '';
  const project = optionalString(body.project, 200) ?? '';
  const name = optionalString(body.name, 200) ?? '';
  const created = await createRepository(
    await bitbucketAuthFor(request, tenantId, session.subject),
    { workspace, project, name }
  );
  if (!created.ok) return NextResponse.json({ error: created.error }, { status: 409 });
  return NextResponse.json({ repo: created.repo });
}
