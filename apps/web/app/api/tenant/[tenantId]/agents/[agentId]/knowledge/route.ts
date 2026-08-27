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
import { getDatabase } from '@renkei/db';
import { getSessionFromRequest } from '@/lib/session';
import { getIdentityEmail } from '@/lib/identity';
import { resolveAgentAccess } from '@/lib/agents/access-grants';
import {
  createAgentNote,
  listAgentNotes,
  parseNotePayload,
  MAX_AGENT_NOTE_CHARS,
  MAX_AGENT_NOTE_TITLE_CHARS,
} from '@/lib/agents/agent-notes';

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ tenantId: string; agentId: string }> }
): Promise<NextResponse> {
  const { tenantId, agentId } = await params;
  const session = await getSessionFromRequest(request, tenantId);
  if (!session) return NextResponse.json({ error: 'Not signed in' }, { status: 401 });

  const dbResult = getDatabase();
  if (!dbResult.ok) return NextResponse.json({ error: 'Database unavailable' }, { status: 500 });
  const db = dbResult.val;

  const access = await resolveAgentAccess(db, tenantId, session.subject, agentId);
  if (!access) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  return NextResponse.json({ notes: await listAgentNotes(db, tenantId, agentId) });
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ tenantId: string; agentId: string }> }
): Promise<NextResponse> {
  const { tenantId, agentId } = await params;
  const session = await getSessionFromRequest(request, tenantId);
  if (!session) return NextResponse.json({ error: 'Not signed in' }, { status: 401 });

  const dbResult = getDatabase();
  if (!dbResult.ok) return NextResponse.json({ error: 'Database unavailable' }, { status: 500 });
  const db = dbResult.val;

  const access = await resolveAgentAccess(db, tenantId, session.subject, agentId);
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

  const emailResult = await getIdentityEmail(tenantId, access.ownerSubject);
  const ownerEmail = emailResult.ok ? emailResult.val : null;
  if (!ownerEmail) {
    return NextResponse.json(
      { error: "No email is on record for the agent owner's identity" },
      { status: 409 }
    );
  }

  const created = await createAgentNote(db, {
    tenantId,
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
      return NextResponse.json(
        { error: 'The embedding provider could not process the note; nothing was saved' },
        { status: 502 }
      );
    }
    return NextResponse.json({ error: 'The note could not be saved' }, { status: 500 });
  }
  return NextResponse.json({ noteId: created.noteId }, { status: 201 });
}
