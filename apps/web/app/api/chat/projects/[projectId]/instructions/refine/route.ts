/**
 * Refine a project's instructions (lib/chat/refine-instructions.ts):
 * editors only, like saving them. The body carries the draft as it stands
 * in the field — saved or not — what the editor wants changed, and the
 * model to ask (one from the chat roster; the org's default when absent).
 * Answers a proposal and saves nothing: the page puts it in the field and
 * the editor's Save keeps it.
 */

import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import {
  chatRequestContext,
  jsonError,
  optionalString,
  readJsonBody,
} from '@/lib/chat/route-support';
import { resolveProjectAccess } from '@/lib/chat/access';
import { getProjectRow, PROJECT_INSTRUCTIONS_MAX_CHARS } from '@/lib/chat/projects';
import { listChatModels } from '@/lib/chat/models';
import { refineInstructions, REFINE_GUIDANCE_MAX_CHARS } from '@/lib/chat/refine-instructions';

import { tokenLimitRefusal } from '@/lib/token-limits/refusal';
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ projectId: string }> }
): Promise<Response> {
  const { projectId } = await params;
  const ready = await chatRequestContext(request);
  if (!ready.ok) return ready.response;
  const { session } = ready.context;
  const access = await resolveProjectAccess(session.subject, projectId);
  if (!access) return jsonError(404, 'not-found', 'No such project');
  if (access.role === 'viewer')
    return jsonError(403, 'read-only', 'Only editors can change this project.');
  const project = await getProjectRow(projectId);
  if (!project) return jsonError(404, 'not-found', 'No such project');

  const body = await readJsonBody(request);
  const instructions = optionalString(body.instructions, PROJECT_INSTRUCTIONS_MAX_CHARS);
  if (!instructions) {
    return jsonError(400, 'empty', 'Write some instructions first, then refine them.');
  }
  const guidance = optionalString(body.guidance, REFINE_GUIDANCE_MAX_CHARS) || null;
  let llmModelId: string | null = null;
  if (body.llmModelId !== undefined && body.llmModelId !== null) {
    const models = await listChatModels();
    const model = models.find((option) => option.id === body.llmModelId);
    if (!model) return jsonError(400, 'invalid-model', 'That model is not available.');
    llmModelId = model.id;
  }
  const overLimit = await tokenLimitRefusal(session.subject, llmModelId);
  if (overLimit) return jsonError(429, 'token-limit', overLimit);

  const outcome = await refineInstructions(
    session.subject,
    {
      kind: project.kind,
      name: project.name,
      description: project.description,
      instructions,
      guidance,
    },
    llmModelId
  );
  if (!outcome.ok) return jsonError(outcome.status, outcome.code, outcome.error);
  return NextResponse.json(outcome.proposal);
}
