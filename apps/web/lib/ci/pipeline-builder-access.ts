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
import { environmentOfBranch } from './environment-rules';
import { projectEnvironments } from './environments';
import { hostOf, onBranch, type CodeRepoProject } from './pipeline-builder';

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

export interface BranchContext extends BuilderContext {
  /** The branch asked about; `project.repo.branch` is it too. */
  branch: string;
  /** The environment the branch is assigned to. */
  environment: string;
  production: boolean;
}

/** The branch a request names, in its query (`?branch=`); null when it names none. */
export function branchAsked(request: NextRequest): string | null {
  const branch = request.nextUrl.searchParams.get('branch')?.trim() ?? '';
  return branch && branch.length <= 200 ? branch : null;
}

/**
 * builderContext for a route about one branch's pipeline: the branch is
 * named in the query and must be assigned to one of the project's
 * environments, since the environment is what its pipeline deploys.
 */
export async function branchContext(
  request: NextRequest,
  projectId: string,
  options: { write?: boolean } = {}
): Promise<{ ok: true; context: BranchContext } | { ok: false; response: NextResponse }> {
  const found = await builderContext(request, projectId, options);
  if (!found.ok) return found;
  const branch = branchAsked(request);
  if (!branch) {
    return {
      ok: false,
      response: jsonError(400, 'branch', 'Name the branch whose pipeline this is.'),
    };
  }
  const environment = environmentOfBranch(await projectEnvironments(projectId), branch);
  if (!environment) {
    return {
      ok: false,
      response: jsonError(
        409,
        'unassigned',
        `${branch} is not assigned to an environment; assign it on the project’s Environments page first.`
      ),
    };
  }
  return {
    ok: true,
    context: {
      ...found.context,
      project: onBranch(found.context.project, branch),
      branch,
      environment: environment.name,
      production: environment.production,
    },
  };
}
