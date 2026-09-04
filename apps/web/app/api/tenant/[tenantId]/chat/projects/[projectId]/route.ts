/**
 * One project: read (any member), settings (editor+; publishing is the
 * owner's), delete (owner).
 */

import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import {
  chatRequestContext,
  jsonError,
  optionalString,
  readJsonBody,
} from '@/lib/chat/route-support';
import { resolveResourceAccess } from '@/lib/chat/access';
import {
  deleteProject,
  getProjectRow,
  updateProject,
  PROJECT_INSTRUCTIONS_MAX_CHARS,
  PROJECT_NAME_MAX_CHARS,
  type ProjectPatch,
} from '@/lib/chat/projects';
import { parseToolConfig } from '@/lib/chat/tool-config';
import { loadProjectView } from '@/lib/chat/project-view';

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ tenantId: string; projectId: string }> }
): Promise<Response> {
  const { tenantId, projectId } = await params;
  const ready = await chatRequestContext(request, tenantId);
  if (!ready.ok) return ready.response;
  const { db, session } = ready.context;
  const access = await resolveResourceAccess(
    db,
    tenantId,
    session.subject,
    'chat_project',
    projectId
  );
  if (!access) return jsonError(404, 'not-found', 'No such project');
  const view = await loadProjectView(db, tenantId, session.subject, projectId, access);
  if (!view) return jsonError(404, 'not-found', 'No such project');
  return NextResponse.json(view);
}

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ tenantId: string; projectId: string }> }
): Promise<Response> {
  const { tenantId, projectId } = await params;
  const ready = await chatRequestContext(request, tenantId);
  if (!ready.ok) return ready.response;
  const { db, session } = ready.context;
  const access = await resolveResourceAccess(
    db,
    tenantId,
    session.subject,
    'chat_project',
    projectId
  );
  if (!access) return jsonError(404, 'not-found', 'No such project');
  if (access.role === 'viewer')
    return jsonError(403, 'read-only', 'Only editors can change this project.');
  const body = await readJsonBody(request);
  const patch: ProjectPatch = {};
  const name = optionalString(body.name, PROJECT_NAME_MAX_CHARS);
  if (name !== undefined) {
    if (!name) return jsonError(400, 'invalid', 'The name cannot be empty');
    patch.name = name;
  }
  const description = optionalString(body.description, 2_000);
  if (description !== undefined) patch.description = description || null;
  const instructions = optionalString(body.instructions, PROJECT_INSTRUCTIONS_MAX_CHARS);
  if (instructions !== undefined) patch.instructions = instructions || null;
  if (body.toolConfig === null) patch.toolConfig = null;
  else if (body.toolConfig !== undefined) {
    const parsed = parseToolConfig(body.toolConfig);
    if (!parsed) return jsonError(400, 'invalid', 'Invalid tool configuration');
    patch.toolConfig = parsed;
  }
  if (typeof body.publishedToOrg === 'boolean') {
    if (access.role !== 'owner') {
      return jsonError(403, 'owner-only', 'Only the owner can publish a project.');
    }
    patch.publishedToOrg = body.publishedToOrg;
  }
  const updated = await updateProject(db, tenantId, projectId, patch);
  if (!updated) return jsonError(404, 'not-found', 'No such project');
  const row = await getProjectRow(db, tenantId, projectId);
  return NextResponse.json({ ok: true, publishedToOrg: row?.publishedToOrg ?? false });
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ tenantId: string; projectId: string }> }
): Promise<Response> {
  const { tenantId, projectId } = await params;
  const ready = await chatRequestContext(request, tenantId);
  if (!ready.ok) return ready.response;
  const { db, session } = ready.context;
  const deleted = await deleteProject(db, tenantId, session.subject, projectId);
  if (!deleted) return jsonError(404, 'not-found', 'No such project');
  return NextResponse.json({ ok: true });
}
