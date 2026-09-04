import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { chatRequestContext } from '@/lib/chat/route-support';
import { listChatModels } from '@/lib/chat/models';

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ tenantId: string }> }
): Promise<Response> {
  const { tenantId } = await params;
  const ready = await chatRequestContext(request, tenantId);
  if (!ready.ok) return ready.response;
  return NextResponse.json({ models: await listChatModels(ready.context.db, tenantId) });
}
