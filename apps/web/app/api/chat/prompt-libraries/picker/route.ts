import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { chatRequestContext } from '@/lib/chat/route-support';
import { listPickerPrompts } from '@/lib/chat/prompts';

export async function GET(
  request: NextRequest
): Promise<Response> {
  const ready = await chatRequestContext(request);
  if (!ready.ok) return ready.response;
  const { db, session } = ready.context;
  return NextResponse.json({ prompts: await listPickerPrompts(db, session.subject) });
}
