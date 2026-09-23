/**
 * Language servers for the code pane's editor.
 *
 * GET: which servers the sandbox worker can start, and whether the
 * project's checkout is ready for one — the pane decides from this
 * whether a file gets a language server or the tokenizer alone.
 *
 * POST `{ server, clientId }`: start a server (or get the editor's
 * existing one back) for the project's checkout; answers the session's
 * id and the server's capabilities. The server runs on the worker as
 * the project's own uid, in its checkout, and speaks to the editor
 * through `…/lsp/[sessionId]`. Any member of the project may have one:
 * it reads the repository the way the tree and the files route do, and
 * writes nothing the editor does not save through the files route.
 */

import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { LSP_CLIENT_ID_PATTERN, isLanguageServerId } from '@renkei/connector-sandbox';
import {
  clientFailure,
  sandboxWorkspacesEnabled,
  sbLspLanguages,
  sbLspOpen,
} from '@renkei/sandbox-client';
import { jsonError } from '@/lib/chat/route-support';
import { projectWorkspace } from '@/lib/code/projects';
import { codeProjectContext } from '@/lib/code/route-access';
import { codeProjectTarget } from '@/lib/code/scope';

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ tenantId: string; projectId: string }> }
): Promise<Response> {
  const { tenantId, projectId } = await params;
  const ready = await codeProjectContext(request, tenantId, projectId);
  if (!ready.ok) return ready.response;
  const { project } = ready.context;
  if (!sandboxWorkspacesEnabled()) {
    return NextResponse.json({ available: [], ready: false });
  }
  const target = codeProjectTarget(tenantId, projectId);
  const [languages, workspace] = await Promise.all([
    sbLspLanguages(target),
    projectWorkspace(project),
  ]);
  return NextResponse.json({
    available: languages.ok ? languages.val : [],
    ready: workspace?.status === 'ready',
  });
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ tenantId: string; projectId: string }> }
): Promise<Response> {
  const { tenantId, projectId } = await params;
  const ready = await codeProjectContext(request, tenantId, projectId);
  if (!ready.ok) return ready.response;
  const { project } = ready.context;
  if (!sandboxWorkspacesEnabled()) {
    return jsonError(503, 'unavailable', 'Code workspaces are not enabled on this deployment.');
  }
  if (!project.workspaceId) {
    return jsonError(409, 'not-cloned', 'Send a message so a chat clones the repository first.');
  }
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return jsonError(400, 'invalid', 'Say which server.');
  }
  const server = typeof body === 'object' && body !== null && 'server' in body ? body.server : null;
  const clientId =
    typeof body === 'object' && body !== null && 'clientId' in body ? body.clientId : null;
  if (!isLanguageServerId(server)) return jsonError(400, 'invalid', 'Unknown language server.');
  if (typeof clientId !== 'string' || !LSP_CLIENT_ID_PATTERN.test(clientId)) {
    return jsonError(400, 'invalid', 'A client id is required.');
  }
  const opened = await sbLspOpen(codeProjectTarget(tenantId, projectId), {
    id: project.workspaceId,
    server,
    clientId,
  });
  if (!opened.ok) {
    const failure = clientFailure(opened.err);
    return jsonError(failure.status, 'lsp', failure.message);
  }
  return NextResponse.json({ session: opened.val });
}
