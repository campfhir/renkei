/**
 * The lines every Pipelines route starts with, once: codeProjectContext
 * (the session, the person's access, the project as a code project),
 * then what these routes add — the repository must be on Bitbucket, a
 * write needs the editor role and an org not in read-only mode, and the
 * person's Bitbucket grant scopes are read so a missing capability can
 * be named in the Connectors page's words before Bitbucket is asked.
 * Not codeProjectContext's own `write` option: that gates on the
 * sandbox worker, which Pipelines never touch.
 */

import type { NextRequest } from 'next/server';
import type { NextResponse } from 'next/server';
import { ATLASSIAN_BITBUCKET, GITHUB } from '@renkei/provider-grants';
import { getOrgSettings } from '@renkei/settings';
import { jsonError } from '@/lib/chat/route-support';
import type { ProjectRow } from '@/lib/chat/projects';
import { grantScopes, missingScope, type PipelinesHost } from '@/lib/code/access';
import { codeProjectContext } from '@/lib/code/route-access';

export interface PipelinesProjectContext {
  project: ProjectRow & { repo: NonNullable<ProjectRow['repo']> };
  subject: string;
  /** What the person's connection to the project's host carries; null when not connected. */
  scopes: string[] | null;
}

export async function pipelinesProjectContext(
  request: NextRequest,
  projectId: string,
  options: { write?: boolean; host?: PipelinesHost } = {}
): Promise<{ ok: true; context: PipelinesProjectContext } | { ok: false; response: NextResponse }> {
  const ready = await codeProjectContext(request, projectId);
  if (!ready.ok) return ready;
  const { session, access, project } = ready.context;
  const host = options.host ?? ATLASSIAN_BITBUCKET;
  if (!project.repo || project.repo.provider !== host) {
    return {
      ok: false,
      response:
        host === GITHUB
          ? jsonError(409, 'not-github', 'Only a GitHub repository has Actions.')
          : jsonError(409, 'not-bitbucket', 'Only a Bitbucket repository has Pipelines.'),
    };
  }
  if (options.write) {
    if (access.role === 'viewer') {
      return {
        ok: false,
        response: jsonError(403, 'read-only', 'Only editors can change this project’s pipelines.'),
      };
    }
    const settings = await getOrgSettings();
    if (settings.ok && settings.val.readOnly) {
      return {
        ok: false,
        response: jsonError(403, 'read-only', 'The organization is in read-only mode.'),
      };
    }
  }
  const scopes = await grantScopes(session.subject, host);
  return {
    ok: true,
    context: { project: { ...project, repo: project.repo }, subject: session.subject, scopes },
  };
}

export { missingScope };
