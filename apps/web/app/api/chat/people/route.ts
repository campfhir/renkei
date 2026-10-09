/**
 * The people a chat, project or library can be shared with: the tenant's
 * identity spine, as names and emails. Anyone signed in may look — the
 * same list the agents' sharing modal shows.
 */

import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { listIdentities } from '@/lib/identity';
import { chatRequestContext } from '@/lib/chat/route-support';

export async function GET(
  request: NextRequest
): Promise<Response> {
  const ready = await chatRequestContext(request);
  if (!ready.ok) return ready.response;
  const people = await listIdentities();
  return NextResponse.json({
    people: people.filter((person) => person.subject !== ready.context.session.subject),
  });
}
