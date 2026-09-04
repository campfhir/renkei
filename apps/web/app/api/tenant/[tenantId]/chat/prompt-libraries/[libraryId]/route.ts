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
  deleteLibrary,
  getLibrary,
  listPrompts,
  updateLibrary,
  LIBRARY_NAME_MAX_CHARS,
} from '@/lib/chat/prompts';

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ tenantId: string; libraryId: string }> }
): Promise<Response> {
  const { tenantId, libraryId } = await params;
  const ready = await chatRequestContext(request, tenantId);
  if (!ready.ok) return ready.response;
  const { db, session } = ready.context;
  const access = await resolveResourceAccess(
    db,
    tenantId,
    session.subject,
    'prompt_library',
    libraryId
  );
  const library = access ? await getLibrary(db, tenantId, libraryId) : null;
  if (!access || !library) return jsonError(404, 'not-found', 'No such library');
  const prompts = await listPrompts(db, tenantId, libraryId);
  return NextResponse.json({
    library: {
      id: library.id,
      name: library.name,
      description: library.description,
      publishedToOrg: library.publishedToOrg,
      role: access.role,
    },
    prompts: prompts.map((prompt) => ({
      id: prompt.id,
      title: prompt.title,
      body: prompt.body,
      position: prompt.position,
      updatedAt: prompt.updatedAt.toISOString(),
    })),
  });
}

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ tenantId: string; libraryId: string }> }
): Promise<Response> {
  const { tenantId, libraryId } = await params;
  const ready = await chatRequestContext(request, tenantId);
  if (!ready.ok) return ready.response;
  const { db, session } = ready.context;
  const access = await resolveResourceAccess(
    db,
    tenantId,
    session.subject,
    'prompt_library',
    libraryId
  );
  if (!access) return jsonError(404, 'not-found', 'No such library');
  if (access.role === 'viewer')
    return jsonError(403, 'read-only', 'Only editors can change this library.');
  const body = await readJsonBody(request);
  const patch: { name?: string; description?: string | null; publishedToOrg?: boolean } = {};
  const name = optionalString(body.name, LIBRARY_NAME_MAX_CHARS);
  if (name !== undefined) {
    if (!name) return jsonError(400, 'invalid', 'The name cannot be empty');
    patch.name = name;
  }
  const description = optionalString(body.description, 2_000);
  if (description !== undefined) patch.description = description || null;
  if (typeof body.publishedToOrg === 'boolean') {
    if (access.role !== 'owner') return jsonError(403, 'owner-only', 'Only the owner can publish.');
    patch.publishedToOrg = body.publishedToOrg;
  }
  const updated = await updateLibrary(db, tenantId, libraryId, patch);
  if (!updated) return jsonError(404, 'not-found', 'No such library');
  return NextResponse.json({ ok: true });
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ tenantId: string; libraryId: string }> }
): Promise<Response> {
  const { tenantId, libraryId } = await params;
  const ready = await chatRequestContext(request, tenantId);
  if (!ready.ok) return ready.response;
  const { db, session } = ready.context;
  const deleted = await deleteLibrary(db, tenantId, session.subject, libraryId);
  if (!deleted) return jsonError(404, 'not-found', 'No such library');
  return NextResponse.json({ ok: true });
}
