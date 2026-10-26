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
import { routeLog } from '@/lib/log-context';

async function GETHandler(
  request: NextRequest,
  { params }: { params: Promise<{ libraryId: string }> }
): Promise<Response> {
  const { libraryId } = await params;
  const ready = await chatRequestContext(request);
  if (!ready.ok) return ready.response;
  const { db, session } = ready.context;
  const access = await resolveResourceAccess(db, session.subject, 'prompt_library', libraryId);
  const library = access ? await getLibrary(db, libraryId) : null;
  if (!access || !library) return jsonError(404, 'not-found', 'No such library');
  const prompts = await listPrompts(db, libraryId);
  return NextResponse.json({
    library: {
      id: library.id,
      name: library.name,
      description: library.description,
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

async function PATCHHandler(
  request: NextRequest,
  { params }: { params: Promise<{ libraryId: string }> }
): Promise<Response> {
  const { libraryId } = await params;
  const ready = await chatRequestContext(request);
  if (!ready.ok) return ready.response;
  const { db, session } = ready.context;
  const access = await resolveResourceAccess(db, session.subject, 'prompt_library', libraryId);
  if (!access) return jsonError(404, 'not-found', 'No such library');
  if (access.role === 'viewer')
    return jsonError(403, 'read-only', 'Only editors can change this library.');
  const body = await readJsonBody(request);
  const patch: { name?: string; description?: string | null } = {};
  const name = optionalString(body.name, LIBRARY_NAME_MAX_CHARS);
  if (name !== undefined) {
    if (!name) return jsonError(400, 'invalid', 'The name cannot be empty');
    patch.name = name;
  }
  const description = optionalString(body.description, 2_000);
  if (description !== undefined) patch.description = description || null;
  const updated = await updateLibrary(db, libraryId, patch);
  if (!updated) return jsonError(404, 'not-found', 'No such library');
  return NextResponse.json({ ok: true });
}

async function DELETEHandler(
  request: NextRequest,
  { params }: { params: Promise<{ libraryId: string }> }
): Promise<Response> {
  const { libraryId } = await params;
  const ready = await chatRequestContext(request);
  if (!ready.ok) return ready.response;
  const { db, session } = ready.context;
  const deleted = await deleteLibrary(db, session.subject, libraryId);
  if (!deleted) return jsonError(404, 'not-found', 'No such library');
  return NextResponse.json({ ok: true });
}

export const GET = routeLog(GETHandler);
export const PATCH = routeLog(PATCHHandler);
export const DELETE = routeLog(DELETEHandler);
