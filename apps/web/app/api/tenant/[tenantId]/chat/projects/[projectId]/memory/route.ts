/**
 * A project's memory: read by any member, written and pruned by editors.
 */

import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { getOrgSettings } from '@renkei/settings';
import { chatRequestContext, jsonError, readJsonBody } from '@/lib/chat/route-support';
import { resolveResourceAccess } from '@/lib/chat/access';
import { appendProjectMemory, forgetProjectMemory, readProjectMemory } from '@/lib/chat/memory';
import { createOutboundRedactor } from '@/lib/chat/outbound-redaction';

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
  const memory = await readProjectMemory(db, tenantId, projectId, { maxEntries: 300 });
  return NextResponse.json({
    summary: memory.summary,
    entries: memory.entries.map((entry) => ({
      id: entry.id,
      content: entry.content,
      authorSubject: entry.authorSubject,
      chatId: entry.chatId,
      createdAt: entry.createdAt.toISOString(),
    })),
  });
}

export async function POST(
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
  if (access.role === 'viewer') return jsonError(403, 'read-only', 'Only editors can add notes.');
  const body = await readJsonBody(request);
  const content = typeof body.content === 'string' ? body.content.trim() : '';
  if (!content) return jsonError(400, 'invalid', 'Write something first');
  const settings = await getOrgSettings(tenantId);
  const redactor = settings.ok ? createOutboundRedactor(tenantId, settings.val) : null;
  const id = await appendProjectMemory(db, {
    tenantId,
    projectId,
    content: redactor ? redactor.apply(content).text : content,
    authorSubject: session.subject,
    chatId: null,
  });
  if (!id) return jsonError(500, 'content-key', 'The note could not be saved.');
  return NextResponse.json({ id }, { status: 201 });
}

export async function DELETE(
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
    return jsonError(403, 'read-only', 'Only editors can remove notes.');
  const body = await readJsonBody(request);
  const ids = Array.isArray(body.ids)
    ? body.ids.filter((id): id is string => typeof id === 'string')
    : [];
  const deleted = await forgetProjectMemory(
    db,
    tenantId,
    projectId,
    body.all === true ? { kind: 'all' } : { kind: 'entries', ids }
  );
  return NextResponse.json({ deleted });
}
