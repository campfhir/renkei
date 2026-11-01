/**
 * An agent's knowledge notes — the owner or a grantee through an unexpired
 * access grant (someone else's agentId is a 404, the item-route rule). GET
 * lists them; POST creates one, embedded synchronously so the agent's very
 * next run carries it. Creation needs the org's embedding provider AND the
 * OWNER's recorded email (the note ref's owner prefix — the owner's runs
 * read the notes, whoever wrote them) — each absence is named, not lumped
 * into a 500.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSessionFromRequest } from '@/lib/session';
import { getIdentityEmail } from '@/lib/identity';
import { resolveAgentAccess } from '@/lib/agents/access-grants';
import {
  createAgentNote,
  deleteAgentNotes,
  listAgentNotes,
  parseNotePayload,
  MAX_AGENT_NOTE_CHARS,
  MAX_AGENT_NOTE_TITLE_CHARS,
} from '@/lib/agents/agent-notes';
import { logger } from '@/lib/logger';
import { isRecord } from '@renkei/guards';

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ agentId: string }> }
): Promise<NextResponse> {
  const { agentId } = await params;
  const session = await getSessionFromRequest(request);
  if (!session) return NextResponse.json({ error: 'Not signed in' }, { status: 401 });

  const access = await resolveAgentAccess(session.subject, agentId);
  if (!access) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  return NextResponse.json({ notes: await listAgentNotes(agentId) });
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ agentId: string }> }
): Promise<NextResponse> {
  const { agentId } = await params;
  const session = await getSessionFromRequest(request);
  if (!session) return NextResponse.json({ error: 'Not signed in' }, { status: 401 });

  const access = await resolveAgentAccess(session.subject, agentId);
  if (!access) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  const payload = parseNotePayload(await request.json().catch(() => null));
  if (!payload) {
    return NextResponse.json(
      {
        error: `A title (≤${MAX_AGENT_NOTE_TITLE_CHARS} chars) and content (≤${MAX_AGENT_NOTE_CHARS}) are required`,
      },
      { status: 400 }
    );
  }

  const emailResult = await getIdentityEmail(access.ownerSubject);
  const ownerEmail = emailResult.ok ? emailResult.val : null;
  if (!ownerEmail) {
    return NextResponse.json(
      { error: "No email is on record for the agent owner's identity" },
      { status: 409 }
    );
  }

  const created = await createAgentNote({
    agentId,
    ownerEmail,
    title: payload.title,
    content: payload.content,
  });
  if (typeof created === 'string') {
    if (created === 'EMBEDDINGS_OFF') {
      return NextResponse.json(
        { error: 'The knowledge layer is not configured for this organization' },
        { status: 409 }
      );
    }
    if (created === 'EMBEDDING_FAILED') {
      logger.warn('The embedding provider could not process the note; nothing was saved', {
        component: 'api/agents/knowledge',
        subject: session.subject,
        agentId,
      });
      return NextResponse.json(
        { error: 'The embedding provider could not process the note; nothing was saved' },
        { status: 502 }
      );
    }
    logger.error('The note could not be saved: {error}', {
      component: 'api/agents/knowledge',
      subject: session.subject,
      agentId,
      error: created,
    });
    return NextResponse.json({ error: 'The note could not be saved' }, { status: 500 });
  }
  return NextResponse.json({ noteId: created.noteId }, { status: 201 });
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ agentId: string }> }
): Promise<NextResponse> {
  const { agentId } = await params;
  const session = await getSessionFromRequest(request);
  if (!session) return NextResponse.json({ error: 'Not signed in' }, { status: 401 });

  const access = await resolveAgentAccess(session.subject, agentId);
  if (!access) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  const ownerEmail = await getIdentityEmail(access.ownerSubject);
  if (!ownerEmail.ok || !ownerEmail.val) {
    return NextResponse.json({ error: 'The agent owner has no recorded email' }, { status: 409 });
  }

  const body: unknown = await request.json().catch(() => null);
  const record = isRecord(body) ? body : {};
  const all = record.all === true;
  const noteIds = Array.isArray(record.noteIds)
    ? record.noteIds.filter((id): id is string => typeof id === 'string' && id.length > 0)
    : [];
  if (!all && noteIds.length === 0) {
    return NextResponse.json({ error: 'Give noteIds, or all: true' }, { status: 400 });
  }

  const result = await deleteAgentNotes({
    agentId,
    ownerEmail: ownerEmail.val,
    ...(all ? { all } : { noteIds }),
  });
  return NextResponse.json(result);
}
