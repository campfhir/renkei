/**
 * Opening a code project's preview, for the member who is signed in.
 *
 * A preview's link in the Code section points here when sandboxes are
 * orchestrated. This route — not the page, and nothing the browser sends
 * — says who is asking: the session is checked as a member of the
 * project, and the person's email is read from that session. Where the
 * sandbox's platform can let a named person in at the preview's port as
 * themselves (Azure, with Microsoft Entra on the port), the orchestrator
 * is asked to let THIS person in, and the browser is sent straight to
 * the sandbox; they sign in there with the same account. Anywhere else —
 * Docker, no orchestrator, a session with no email — the browser is sent
 * to the relay (app/ and ports/ beside this), where this app serves the
 * preview under the same session check as always.
 *
 * `?port=` names a port of the preview; without it, the first. The port's
 * number comes from the sandbox's own listing, never from the request.
 * The same handler serves `/chats/[chatId]/previews/[name]/open`.
 */

import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { validatePreviewName } from '@renkei/connector-sandbox';
import { clientFailure, exposeSandboxPort, sbPreviewList } from '@renkei/sandbox-client';
import { jsonError } from '@/lib/chat/route-support';
import { codeProjectContext } from '@/lib/code/route-access';
import { codeProjectTarget } from '@/lib/code/scope';
import { previewPortToOpen } from '@/lib/code/previews';
import { recordAuditEvent } from '@/lib/audit-events';
import { logger } from '@/lib/logger';
import { who } from '@/lib/log-actor';

const COMPONENT = 'api/code/projects/previews/open';

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ projectId: string; chatId?: string; name: string }> }
): Promise<Response> {
  const { projectId, chatId, name: rawName } = await params;
  const ready = await codeProjectContext(request, projectId, { chatId });
  if (!ready.ok) return ready.response;
  const { session, project } = ready.context;
  const name = validatePreviewName(rawName);
  if (!name.ok) return jsonError(404, 'not-found', 'No such preview');

  const target = codeProjectTarget(projectId);
  const listed = await sbPreviewList(target);
  if (!listed.ok) {
    const failure = clientFailure(listed.err);
    return jsonError(failure.status, 'sandbox', failure.message);
  }
  const preview = listed.val.find((entry) => entry.name === name.name);
  const port = preview
    ? previewPortToOpen(
        preview,
        { projectId, chatId: chatId ?? null },
        request.nextUrl.searchParams.get('port')
      )
    : null;
  if (!preview || !port) return jsonError(404, 'not-found', 'No such preview');

  const relay = new URL(port.relayPath, request.nextUrl.origin);
  const actor = who(session);
  // Only a real address can be let in by name; anyone else uses the relay.
  const email = typeof actor.email === 'string' && actor.email.includes('@') ? actor.email : null;
  if (!email) return NextResponse.redirect(relay, 302);

  const opened = await exposeSandboxPort(target.subject, port.port, [email]);
  if (!opened.ok) {
    logger.warn(
      '{actor} opened the preview "{preview}" of the project "{project}", but its port could not be opened to them directly: {error}; they were sent to the relay instead',
      {
        component: COMPONENT,
        ...actor,
        projectId,
        project: project.name,
        preview: preview.name,
        error: opened.message,
      }
    );
    return NextResponse.redirect(relay, 302);
  }
  if (!opened.url) return NextResponse.redirect(relay, 302);

  recordAuditEvent({
    actorSubject: session.subject,
    action: 'code.previews.opened',
    targetKind: 'code_project',
    targetLabel: project.name,
    details: { projectId, chatId: chatId ?? null, name: preview.name, port: port.port },
  });
  return NextResponse.redirect(opened.url, 302);
}
