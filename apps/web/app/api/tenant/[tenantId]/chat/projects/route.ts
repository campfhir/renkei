/**
 * Projects: the ones this person can open, and creation.
 */

import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import {
  chatRequestContext,
  jsonError,
  optionalString,
  readJsonBody,
} from '@/lib/chat/route-support';
import {
  createProject,
  PROJECT_INSTRUCTIONS_MAX_CHARS,
  PROJECT_NAME_MAX_CHARS,
} from '@/lib/chat/projects';
import { parseToolConfig } from '@/lib/chat/tool-config';
import { loadChatSidebar } from '@/lib/chat/sidebar';

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ tenantId: string }> }
): Promise<Response> {
  const { tenantId } = await params;
  const ready = await chatRequestContext(request, tenantId);
  if (!ready.ok) return ready.response;
  const { db, session } = ready.context;
  const sidebar = await loadChatSidebar(db, tenantId, session.subject);
  return NextResponse.json({ projects: sidebar.projects });
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ tenantId: string }> }
): Promise<Response> {
  const { tenantId } = await params;
  const ready = await chatRequestContext(request, tenantId);
  if (!ready.ok) return ready.response;
  const { db, session } = ready.context;
  const body = await readJsonBody(request);
  const name = optionalString(body.name, PROJECT_NAME_MAX_CHARS);
  if (!name) return jsonError(400, 'invalid', 'Give the project a name');
  const description = optionalString(body.description, 2_000) ?? null;
  const instructions = optionalString(body.instructions, PROJECT_INSTRUCTIONS_MAX_CHARS) ?? null;
  const toolConfig = body.toolConfig === undefined ? null : parseToolConfig(body.toolConfig);
  const projectId = await createProject(db, {
    tenantId,
    ownerSubject: session.subject,
    name,
    description: description || null,
    instructions: instructions || null,
    toolConfig,
  });
  if (!projectId)
    return jsonError(500, 'content-key', 'The content encryption key is not configured.');
  return NextResponse.json({ projectId }, { status: 201 });
}
