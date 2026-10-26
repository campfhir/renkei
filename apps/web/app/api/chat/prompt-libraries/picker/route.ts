import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { chatRequestContext } from '@/lib/chat/route-support';
import { listPickerPrompts } from '@/lib/chat/prompts';
import { routeLog } from '@/lib/log-context';

async function GETHandler(request: NextRequest): Promise<Response> {
  const ready = await chatRequestContext(request);
  if (!ready.ok) return ready.response;
  const { db, session } = ready.context;
  return NextResponse.json({ prompts: await listPickerPrompts(db, session.subject) });
}

export const GET = routeLog(GETHandler);
