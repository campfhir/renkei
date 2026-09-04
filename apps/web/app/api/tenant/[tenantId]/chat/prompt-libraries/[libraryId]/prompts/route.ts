import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import {
  chatRequestContext,
  jsonError,
  optionalString,
  readJsonBody,
} from '@/lib/chat/route-support';
import { resolveResourceAccess } from '@/lib/chat/access';
import { createPrompt, PROMPT_BODY_MAX_CHARS, PROMPT_TITLE_MAX_CHARS } from '@/lib/chat/prompts';

export async function POST(
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
  if (access.role === 'viewer') return jsonError(403, 'read-only', 'Only editors can add prompts.');
  const body = await readJsonBody(request);
  const title = optionalString(body.title, PROMPT_TITLE_MAX_CHARS);
  const text =
    typeof body.body === 'string' ? body.body.trim().slice(0, PROMPT_BODY_MAX_CHARS) : '';
  if (!title || !text) return jsonError(400, 'invalid', 'A prompt needs a title and a body');
  const promptId = await createPrompt(db, {
    tenantId,
    libraryId,
    title,
    body: text,
    subject: session.subject,
  });
  return NextResponse.json({ promptId }, { status: 201 });
}
