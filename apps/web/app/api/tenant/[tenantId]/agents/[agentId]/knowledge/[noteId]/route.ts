/**
 * One agent knowledge note: replace (PUT) or delete — owner only, and the
 * note must actually be THIS agent's (the agentId stamp is part of the
 * lookup, so one agent's panel can never touch another's notes).
 */

import { NextRequest, NextResponse } from 'next/server';
import { getDatabase } from '@renkei/db';
import { getSessionFromRequest } from '@/lib/session';
import { getIdentityEmail } from '@/lib/identity';
import { getAgent } from '@/lib/agents/store';
import { deleteAgentNote, parseNotePayload, updateAgentNote } from '@/lib/agents/agent-notes';

async function ownedContext(
  request: NextRequest,
  tenantId: string,
  agentId: string
): Promise<
  { db: NonNullable<ReturnType<typeof getDatabase>['val']>; ownerEmail: string } | NextResponse
> {
  const session = await getSessionFromRequest(request, tenantId);
  if (!session) return NextResponse.json({ error: 'Not signed in' }, { status: 401 });

  const dbResult = getDatabase();
  if (!dbResult.ok) return NextResponse.json({ error: 'Database unavailable' }, { status: 500 });
  const db = dbResult.val;

  const agent = await getAgent(db, tenantId, session.subject, agentId);
  if (!agent) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  const emailResult = await getIdentityEmail(tenantId, session.subject);
  const ownerEmail = emailResult.ok ? emailResult.val : null;
  if (!ownerEmail) {
    return NextResponse.json(
      { error: 'No email is on record for your identity — sign in again to refresh it' },
      { status: 409 }
    );
  }
  return { db, ownerEmail };
}

function errorResponse(outcome: string): NextResponse {
  switch (outcome) {
    case 'NOT_FOUND':
      return NextResponse.json({ error: 'Note not found' }, { status: 404 });
    case 'EMBEDDINGS_OFF':
      return NextResponse.json(
        { error: 'The knowledge layer is not configured for this organization' },
        { status: 409 }
      );
    case 'EMBEDDING_FAILED':
      return NextResponse.json(
        { error: 'The embedding provider could not process the note' },
        { status: 502 }
      );
    default:
      return NextResponse.json({ error: 'The note could not be saved' }, { status: 500 });
  }
}

export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ tenantId: string; agentId: string; noteId: string }> }
): Promise<NextResponse> {
  const { tenantId, agentId, noteId } = await params;
  const context = await ownedContext(request, tenantId, agentId);
  if (context instanceof NextResponse) return context;

  const payload = parseNotePayload(await request.json().catch(() => null));
  if (!payload) {
    return NextResponse.json({ error: 'A title and content are required' }, { status: 400 });
  }

  const outcome = await updateAgentNote(context.db, {
    tenantId,
    agentId,
    ownerEmail: context.ownerEmail,
    noteId,
    title: payload.title,
    content: payload.content,
  });
  if (outcome !== 'OK') return errorResponse(outcome);
  return NextResponse.json({ ok: true });
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ tenantId: string; agentId: string; noteId: string }> }
): Promise<NextResponse> {
  const { tenantId, agentId, noteId } = await params;
  const context = await ownedContext(request, tenantId, agentId);
  if (context instanceof NextResponse) return context;

  const outcome = await deleteAgentNote(context.db, {
    tenantId,
    agentId,
    ownerEmail: context.ownerEmail,
    noteId,
  });
  if (outcome !== 'OK') return errorResponse(outcome);
  return NextResponse.json({ ok: true });
}
