/**
 * Refine or draft a library prompt (lib/chat/refine-prompt.ts): editors
 * only, like saving a prompt. The body carries the title and draft as they
 * stand in the editor — saved or not — what the editor wants changed (or,
 * with no draft, what the prompt is for), and the model to ask (one from
 * the chat roster; the org's default when absent). Answers a proposal and
 * saves nothing: the editor puts it in the field and Save keeps it.
 */

import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import {
  chatRequestContext,
  jsonError,
  optionalString,
  readJsonBody,
} from '@/lib/chat/route-support';
import { resolveResourceAccess } from '@/lib/chat/access';
import { getLibrary, PROMPT_BODY_MAX_CHARS, PROMPT_TITLE_MAX_CHARS } from '@/lib/chat/prompts';
import { listChatModels } from '@/lib/chat/models';
import { refinePrompt, REFINE_PROMPT_GUIDANCE_MAX_CHARS } from '@/lib/chat/refine-prompt';

import { tokenLimitRefusal } from '@/lib/token-limits/refusal';
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ libraryId: string }> }
): Promise<Response> {
  const { libraryId } = await params;
  const ready = await chatRequestContext(request);
  if (!ready.ok) return ready.response;
  const { session } = ready.context;
  const access = await resolveResourceAccess(session.subject, 'prompt_library', libraryId);
  if (!access) return jsonError(404, 'not-found', 'No such library');
  if (access.role === 'viewer')
    return jsonError(403, 'read-only', 'Only editors can change this library.');
  const library = await getLibrary(libraryId);
  if (!library) return jsonError(404, 'not-found', 'No such library');

  const body = await readJsonBody(request);
  const title = optionalString(body.title, PROMPT_TITLE_MAX_CHARS) || '';
  const draft = optionalString(body.body, PROMPT_BODY_MAX_CHARS) || '';
  const guidance = optionalString(body.guidance, REFINE_PROMPT_GUIDANCE_MAX_CHARS) || null;
  if (!draft.trim() && !guidance?.trim()) {
    return jsonError(400, 'empty', 'Write a prompt, or describe the one you want, first.');
  }
  let llmModelId: string | null = null;
  if (body.llmModelId !== undefined && body.llmModelId !== null) {
    const models = await listChatModels();
    const model = models.find((option) => option.id === body.llmModelId);
    if (!model) return jsonError(400, 'invalid-model', 'That model is not available.');
    llmModelId = model.id;
  }
  const overLimit = await tokenLimitRefusal(session.subject, llmModelId);
  if (overLimit) return jsonError(429, 'token-limit', overLimit);

  const outcome = await refinePrompt(
    session.subject,
    {
      libraryName: library.name,
      libraryDescription: library.description,
      scope: library.scope,
      title,
      body: draft,
      guidance,
    },
    llmModelId
  );
  if (!outcome.ok) return jsonError(outcome.status, outcome.code, outcome.error);
  return NextResponse.json(outcome.proposal);
}
