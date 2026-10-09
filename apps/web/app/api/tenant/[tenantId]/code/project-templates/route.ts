/**
 * The template catalog the new-code-project form's picker reads: every
 * signed-in tenant member can read it (they need it to create a
 * project), while only operators can add to it (/api/admin/[slug]/
 * project-templates).
 */

import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { chatRequestContext } from '@/lib/chat/route-support';
import { listCodeProjectTemplates } from '@/lib/code/project-templates';

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ }> }
): Promise<Response> {
  const ready = await chatRequestContext(request);
  if (!ready.ok) return ready.response;
  const templates = await listCodeProjectTemplates(ready.context.db);
  return NextResponse.json({ templates });
}
