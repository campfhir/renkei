/**
 * A person's own chat memory: read, written, edited and pruned by them
 * alone — unlike project memory there is no role to check, since nobody
 * but the owner can ever reach these rows (chat-local-tools.ts scopes the
 * model's own access to `context.subject` the same way).
 */

import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { getOrgSettings } from '@renkei/settings';
import { chatRequestContext, jsonError, readJsonBody } from '@/lib/chat/route-support';
import {
  appendUserMemory,
  editUserMemory,
  forgetUserMemory,
  readUserMemory,
} from '@/lib/chat/user-memory';
import { createOutboundRedactor } from '@/lib/chat/outbound-redaction';

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ tenantId: string }> }
): Promise<Response> {
  const { tenantId } = await params;
  const ready = await chatRequestContext(request, tenantId);
  if (!ready.ok) return ready.response;
  const { db, session } = ready.context;
  const memory = await readUserMemory(db, tenantId, session.subject, { maxEntries: 300 });
  return NextResponse.json({
    summary: memory.summary,
    entries: memory.entries.map((entry) => ({
      id: entry.id,
      content: entry.content,
      chatId: entry.chatId,
      createdAt: entry.createdAt.toISOString(),
    })),
  });
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ tenantId: string }> }
): Promise<Response> {
  const { tenantId } = await params;
  const ready = await chatRequestContext(request, tenantId);
  if (!ready.ok) return ready.response;
  const { db, session } = ready.context;
  const body = await readJsonBody(request);
  const content = typeof body.content === 'string' ? body.content.trim() : '';
  if (!content) return jsonError(400, 'invalid', 'Write something first');
  const settings = await getOrgSettings(tenantId);
  const redactor = settings.ok ? createOutboundRedactor(tenantId, settings.val) : null;
  const id = await appendUserMemory(db, {
    tenantId,
    ownerSubject: session.subject,
    content: redactor ? redactor.apply(content).text : content,
    chatId: null,
  });
  if (!id) return jsonError(500, 'content-key', 'The note could not be saved.');
  return NextResponse.json({ id }, { status: 201 });
}

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ tenantId: string }> }
): Promise<Response> {
  const { tenantId } = await params;
  const ready = await chatRequestContext(request, tenantId);
  if (!ready.ok) return ready.response;
  const { db, session } = ready.context;
  const body = await readJsonBody(request);
  const id = typeof body.id === 'string' ? body.id : '';
  const content = typeof body.content === 'string' ? body.content.trim() : '';
  if (!id) return jsonError(400, 'invalid', 'Missing id');
  if (!content) return jsonError(400, 'invalid', 'Write something first');
  const settings = await getOrgSettings(tenantId);
  const redactor = settings.ok ? createOutboundRedactor(tenantId, settings.val) : null;
  const updated = await editUserMemory(
    db,
    tenantId,
    session.subject,
    id,
    redactor ? redactor.apply(content).text : content
  );
  if (!updated) return jsonError(404, 'not-found', 'No memory with that id.');
  return NextResponse.json({ ok: true });
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ tenantId: string }> }
): Promise<Response> {
  const { tenantId } = await params;
  const ready = await chatRequestContext(request, tenantId);
  if (!ready.ok) return ready.response;
  const { db, session } = ready.context;
  const body = await readJsonBody(request);
  const ids = Array.isArray(body.ids)
    ? body.ids.filter((id): id is string => typeof id === 'string')
    : [];
  const deleted = await forgetUserMemory(
    db,
    tenantId,
    session.subject,
    body.all === true ? { kind: 'all' } : { kind: 'entries', ids }
  );
  return NextResponse.json({ deleted });
}
