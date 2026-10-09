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
  deletePrompt,
  updatePrompt,
  PROMPT_BODY_MAX_CHARS,
  PROMPT_TITLE_MAX_CHARS,
} from '@/lib/chat/prompts';

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ libraryId: string; promptId: string }> }
): Promise<Response> {
  const { libraryId, promptId } = await params;
  const ready = await chatRequestContext(request);
  if (!ready.ok) return ready.response;
  const { db, session } = ready.context;
  const access = await resolveResourceAccess(
    db,
    session.subject,
    'prompt_library',
    libraryId
  );
  if (!access) return jsonError(404, 'not-found', 'No such library');
  if (access.role === 'viewer')
    return jsonError(403, 'read-only', 'Only editors can change prompts.');
  const body = await readJsonBody(request);
  const patch: { title?: string; body?: string; position?: number } = {};
  const title = optionalString(body.title, PROMPT_TITLE_MAX_CHARS);
  if (title !== undefined) {
    if (!title) return jsonError(400, 'invalid', 'The title cannot be empty');
    patch.title = title;
  }
  if (typeof body.body === 'string') {
    const text = body.body.trim().slice(0, PROMPT_BODY_MAX_CHARS);
    if (!text) return jsonError(400, 'invalid', 'The body cannot be empty');
    patch.body = text;
  }
  if (typeof body.position === 'number' && Number.isFinite(body.position)) {
    patch.position = Math.max(0, Math.floor(body.position));
  }
  const updated = await updatePrompt(db, libraryId, promptId, patch, session.subject);
  if (!updated) return jsonError(404, 'not-found', 'No such prompt');
  return NextResponse.json({ ok: true });
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ libraryId: string; promptId: string }> }
): Promise<Response> {
  const { libraryId, promptId } = await params;
  const ready = await chatRequestContext(request);
  if (!ready.ok) return ready.response;
  const { db, session } = ready.context;
  const access = await resolveResourceAccess(
    db,
    session.subject,
    'prompt_library',
    libraryId
  );
  if (!access) return jsonError(404, 'not-found', 'No such library');
  if (access.role === 'viewer')
    return jsonError(403, 'read-only', 'Only editors can delete prompts.');
  const deleted = await deletePrompt(db, libraryId, promptId);
  if (!deleted) return jsonError(404, 'not-found', 'No such prompt');
  return NextResponse.json({ ok: true });
}
