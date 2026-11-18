/**
 * The lines every pipeline builder route starts with: the session and the
 * person's access to the code project (codeProjectContext), the host the
 * repository is on, and — for a save or a pull request — that the person
 * is an editor and the organization not read-only. Not codeProjectContext's
 * own `write` option: that gates on the sandbox worker, which the builder
 * never touches.
 */

import type { NextRequest } from 'next/server';
import type { NextResponse } from 'next/server';
import type { Host } from '@renkei/ci-blocks';
import { getOrgSettings } from '@renkei/settings';
import { jsonError } from '@/lib/chat/route-support';
import { grantScopes } from '@/lib/code/access';
import { codeProjectContext } from '@/lib/code/route-access';
import { getOrigin } from '@/lib/get-origin';
import { hostOf, type CodeRepoProject } from './pipeline-builder';

export interface BuilderContext {
  project: CodeRepoProject;
  subject: string;
  origin: string;
  host: Host;
  canEdit: boolean;
  /** What the person's connection to the host carries; null when not connected. */
  scopes: string[] | null;
}

export async function builderContext(
  request: NextRequest,
  projectId: string,
  options: { write?: boolean } = {}
): Promise<{ ok: true; context: BuilderContext } | { ok: false; response: NextResponse }> {
  const ready = await codeProjectContext(request, projectId);
  if (!ready.ok) return ready;
  const { session, access, project } = ready.context;
  const host = project.repo ? hostOf(project.repo.provider) : null;
  if (!project.repo || !host) {
    return {
      ok: false,
      response: jsonError(409, 'host', 'Only a Bitbucket or GitHub repository has a pipeline.'),
    };
  }
  const canEdit = access.role !== 'viewer';
  if (options.write) {
    if (!canEdit) {
      return {
        ok: false,
        response: jsonError(403, 'read-only', 'Only editors can change this project’s pipeline.'),
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
  const origin = await getOrigin(request);
  return {
    ok: true,
    context: {
      project: { ...project, repo: project.repo },
      subject: session.subject,
      origin: origin.ok ? origin.val : '',
      host,
      canEdit,
      scopes: options.write ? await grantScopes(session.subject, project.repo.provider) : null,
    },
  };
}
