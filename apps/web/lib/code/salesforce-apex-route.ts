/**
 * What every route of the code pane's Apex panel starts with
 * (app/api/code/projects/[projectId]/salesforce-apex/…, reached through a
 * chat as `/chats/[chatId]/salesforce-apex/…`): the session, the project
 * and the checkout (codeProjectContext, editors and the chat's owner only
 * for anything that writes or runs), and how a failure from
 * salesforce-apex.ts answers.
 */

import type { NextRequest } from 'next/server';
import { clientFailure } from '@renkei/sandbox-client';
import { jsonError } from '@/lib/chat/route-support';
import { getOrigin } from '@/lib/get-origin';
import { logger } from '@/lib/logger';
import { who } from '@/lib/log-actor';
import type { Session } from '@/lib/session';
import type { ProjectRow } from '@/lib/chat/projects';
import { codeProjectContext } from './route-access';
import { codeProjectTarget } from './scope';
import type { ApexCaller, ApexCheckout, ApexFailure } from './salesforce-apex';

export interface ApexRouteContext {
  session: Session;
  project: ProjectRow;
  caller: ApexCaller;
  checkout: ApexCheckout;
}

export async function apexRouteContext(
  request: NextRequest,
  params: Promise<{ projectId: string; chatId?: string }>,
  options: { write: boolean }
): Promise<{ ok: true; context: ApexRouteContext } | { ok: false; response: Response }> {
  const { projectId, chatId } = await params;
  const ready = await codeProjectContext(request, projectId, { write: options.write, chatId });
  if (!ready.ok) return ready;
  const { session, project, workspaceId } = ready.context;
  if (!workspaceId) {
    return {
      ok: false,
      response: jsonError(
        409,
        'not-cloned',
        'There is no checkout yet: start a chat in the project first.'
      ),
    };
  }
  const origin = await getOrigin(request);
  return {
    ok: true,
    context: {
      session,
      project,
      caller: { subject: session.subject, ...(origin.ok ? { origin: origin.val } : {}) },
      checkout: { target: codeProjectTarget(projectId), workspaceId },
    },
  };
}

/**
 * A failure as the panel reads it: the sandbox worker's own status for a
 * checkout problem; 400 for what Salesforce or the request refused (the
 * person's connection, a name not found, nothing to send), with the words
 * to show.
 */
export function apexFailureResponse(
  context: ApexRouteContext,
  failure: ApexFailure,
  doing: string
): Response {
  if (failure.sandbox) {
    const { status, message } = clientFailure(failure.sandbox);
    if (status >= 500) {
      logger.error(
        '{actor} could not {doing} in the code project "{project}": the sandbox answered {status}; nothing was changed',
        {
          component: 'api/code/salesforce-apex',
          ...who(context.session),
          doing,
          project: context.project.name,
          projectId: context.project.id,
          status,
          error: message,
        }
      );
    }
    return jsonError(status, 'sandbox', message);
  }
  return jsonError(400, 'apex', failure.error);
}
