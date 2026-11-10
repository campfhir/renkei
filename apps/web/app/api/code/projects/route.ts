/**
 * Code projects: the ones this person can open, and creation
 * (lib/code/create-project.ts): a chat project with a repository on it.
 */

import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { chatRequestContext, jsonError, readJsonBody } from '@/lib/chat/route-support';
import { loadChatSidebar } from '@/lib/chat/sidebar';
import { createCodeProject } from '@/lib/code/create-project';
import { who } from '@/lib/log-actor';

export async function GET(request: NextRequest): Promise<Response> {
  const ready = await chatRequestContext(request);
  if (!ready.ok) return ready.response;
  const { session } = ready.context;
  const sidebar = await loadChatSidebar(session.subject);
  return NextResponse.json({ projects: sidebar.code.projects });
}

export async function POST(request: NextRequest): Promise<Response> {
  const ready = await chatRequestContext(request);
  if (!ready.ok) return ready.response;
  const { session } = ready.context;
  const created = await createCodeProject(
    session.subject,
    who(session),
    await readJsonBody(request)
  );
  if (!created.ok) return jsonError(created.status, created.code, created.message);
  return NextResponse.json(
    { projectId: created.projectId, envProblems: created.envProblems },
    { status: 201 }
  );
}
