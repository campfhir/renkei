/**
 * Prose → drafted steps, for the builder's "start from a description" box.
 * Synchronous on purpose — the user is watching a spinner and the answer
 * IS the response. Nothing is persisted: the drafted steps land in the
 * builder for review and the ordinary save path validates them like
 * anything typed by hand.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getDatabase } from '@renkei/db';
import { getSessionFromRequest } from '@/lib/session';
import { listAvailableTools } from '@/lib/mcp-tools/tool-catalog';
import { draftAgentFromProse } from '@/lib/agents/draft-from-prose';

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ tenantId: string }> }
): Promise<NextResponse> {
  const { tenantId } = await params;
  const session = await getSessionFromRequest(request, tenantId);
  if (!session) return NextResponse.json({ error: 'Not signed in' }, { status: 401 });

  const dbResult = getDatabase();
  if (!dbResult.ok) return NextResponse.json({ error: 'Database unavailable' }, { status: 500 });

  const body: unknown = await request.json().catch(() => null);
  const payload: { text?: unknown } = typeof body === 'object' && body !== null ? body : {};
  if (typeof payload.text !== 'string' || payload.text.trim().length < 10) {
    return NextResponse.json(
      { error: 'Describe the automation in a sentence or two first.' },
      { status: 400 }
    );
  }

  const tools = await listAvailableTools(tenantId, session.subject);
  const drafted = await draftAgentFromProse(dbResult.val, tenantId, payload.text.trim(), tools);
  if ('error' in drafted) return NextResponse.json({ error: drafted.error }, { status: 422 });

  return NextResponse.json(drafted);
}
