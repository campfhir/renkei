/**
 * The agents this person may ask from a chat (lib/chat/agent-asks.ts) —
 * the composer's @-mention list. `?projectId=` puts that project's team
 * first; a project the person cannot see is ignored.
 */

import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { isUuid } from '@/lib/uuid';
import { chatRequestContext } from '@/lib/chat/route-support';
import { resolveResourceAccess } from '@/lib/chat/access';
import { listAskableAgents } from '@/lib/chat/agent-asks';

export async function GET(request: NextRequest): Promise<Response> {
  const ready = await chatRequestContext(request);
  if (!ready.ok) return ready.response;
  const { session } = ready.context;
  const requested = request.nextUrl.searchParams.get('projectId');
  const projectId =
    requested &&
    isUuid(requested) &&
    (await resolveResourceAccess(session.subject, 'chat_project', requested))
      ? requested
      : null;
  return NextResponse.json({ agents: await listAskableAgents(session.subject, projectId) });
}
