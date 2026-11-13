/**
 * A code project's previews — the project's own server, run in a
 * checkout by the sandbox worker and served through this app. GET lists
 * them with the addresses to open (any member); POST starts one
 * (editors), the way a chat's code_preview_start would: the command,
 * the ports it needs by name (numbers come from the worker's pool), and
 * whether to mint share links. Through
 * `/chats/[chatId]/previews` the command runs in that chat's worktree;
 * here, in the project's base clone. One preview by name — its logs,
 * stopping it, and the relay itself — is [name]/ beside this.
 */

import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import {
  clientFailure,
  sandboxOrchestratorConfig,
  sbPreviewList,
  sbPreviewStart,
} from '@renkei/sandbox-client';
import { jsonError, readJsonBody } from '@/lib/chat/route-support';
import { codeProjectContext } from '@/lib/code/route-access';
import { codeProjectTarget } from '@/lib/code/scope';
import {
  mintPreviewToken,
  parsePreviewStartPayload,
  previewAddresses,
  previewPortRequests,
  withAddresses,
} from '@/lib/code/previews';
import { getOrigin } from '@/lib/get-origin';
import { recordAuditEvent } from '@/lib/audit-events';
import { codePreviewHost } from '@/lib/code/preview-host-server';
import { logger } from '@/lib/logger';
import { who } from '@/lib/log-actor';

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ projectId: string; chatId?: string }> }
): Promise<Response> {
  const { projectId, chatId } = await params;
  const ready = await codeProjectContext(request, projectId, { chatId });
  if (!ready.ok) return ready.response;
  const origin = await getOrigin(request);
  const previewHost = await codePreviewHost();
  const listed = await sbPreviewList(codeProjectTarget(projectId));
  if (!listed.ok) {
    const failure = clientFailure(listed.err);
    if (failure.status === 503) return NextResponse.json({ previews: [] });
    logger.warn(
      '{actor} opened the previews of the project "{project}", but the sandbox did not list them ({status}); the page showed the error: {error}',
      {
        component: 'api/code/projects/previews',
        ...who(ready.context.session),
        projectId,
        project: ready.context.project.name,
        chatId,
        operation: 'listed',
        status: failure.status,
        error: 'message' in listed.err && listed.err.message ? listed.err.message : failure.message,
      }
    );
    return jsonError(failure.status, 'sandbox', failure.message);
  }
  return NextResponse.json({
    // Each port's addresses a browser opens; a token travels only inside its link.
    previews: listed.val.map((preview) =>
      withAddresses(
        preview,
        origin.ok ? origin.val : '',
        { projectId, chatId: chatId ?? null },
        previewHost,
        // Orchestrated: a click goes through `open`, which knows who is signed in.
        sandboxOrchestratorConfig() !== null
      )
    ),
  });
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ projectId: string; chatId?: string }> }
): Promise<Response> {
  const { projectId, chatId } = await params;
  const ready = await codeProjectContext(request, projectId, { write: true, chatId });
  if (!ready.ok) return ready.response;
  const { session, project, workspaceId } = ready.context;
  if (!workspaceId)
    return jsonError(409, 'not-cloned', 'There is no checkout to run a preview in yet.');
  const input = parsePreviewStartPayload(await readJsonBody(request));
  if ('error' in input) return jsonError(400, 'invalid', input.error);
  const origin = await getOrigin(request);
  if (!origin.ok)
    return jsonError(500, 'origin', 'The deployment’s address could not be determined.');
  // One share token per port when public: each port's link is its own secret.
  const addresses = previewAddresses(
    origin.val,
    {
      projectId,
      chatId: chatId ?? null,
      name: input.name,
      ports: input.ports.map((name) => ({ name, token: input.public ? mintPreviewToken() : null })),
    },
    await codePreviewHost()
  );
  const started = await sbPreviewStart(codeProjectTarget(projectId), {
    id: workspaceId,
    name: input.name,
    command: input.command,
    ports: previewPortRequests(addresses),
    ...(input.waitMs !== undefined ? { waitMs: input.waitMs } : {}),
  });
  if (!started.ok) {
    const failure = clientFailure(started.err);
    if (failure.status !== 400 && failure.status !== 404) {
      logger[failure.status >= 500 ? 'error' : 'warn'](
        '{actor} asked to start the preview "{name}" of the project "{project}", but the sandbox refused ({status}); nothing is running: {error}',
        {
          component: 'api/code/projects/previews',
          ...who(session),
          projectId,
          project: project.name,
          chatId,
          name: input.name,
          command: input.command,
          operation: 'started',
          status: failure.status,
          error:
            'message' in started.err && started.err.message ? started.err.message : failure.message,
        }
      );
    }
    return jsonError(failure.status, 'sandbox', failure.message);
  }
  recordAuditEvent({
    actorSubject: session.subject,
    action: 'code.previews.started',
    targetKind: 'code_project',
    targetLabel: project.name,
    details: {
      projectId,
      chatId: chatId ?? null,
      name: input.name,
      ports: started.val.preview.ports.map((port) => `${port.name}=${port.port}`),
      public: input.public,
      listening: started.val.listening,
    },
  });
  return NextResponse.json(
    {
      preview: { ...started.val.preview, ...addresses },
      listening: started.val.listening,
      logs: started.val.logs,
    },
    { status: started.val.listening.length ? 201 : 202 }
  );
}
