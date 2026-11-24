/**
 * The variables a code project's pipelines run with, on its host
 * (lib/code/host-variables.ts), for the Variables tab of its Environments
 * page.
 *
 *   GET ?environment=NAME → the repository's set and, when an environment
 *     of the project is named, the host's deployment environment of that
 *     name (whether it exists, and its set). Secrets come by name only.
 *   PUT { scope: 'repository' | 'environment', environment?, set, remove }
 *     → the change applied (editors): names to set, each with its value
 *     and whether it is a secret, and names to remove. Saving to an
 *     environment the host does not have yet makes it there first, and
 *     `{ scope: 'environment', environment, create: true }` only makes it.
 *
 * The body is what the person typed or the `.env` file they picked, parsed
 * in their browser: it goes from here to the host and nowhere else — not
 * to a model, not to a log. The audit log records the names, never a value.
 */

import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { GITHUB } from '@renkei/provider-grants';
import { jsonError, readJsonBody } from '@/lib/chat/route-support';
import { recordAuditEvent } from '@/lib/audit-events';
import { projectEnvironments } from '@/lib/ci/environments';
import { builderContext } from '@/lib/ci/pipeline-builder-access';
import { bitbucketAuthFor } from '@/lib/code/bitbucket-browse';
import { PIPELINES_VARIABLE_SCOPE } from '@/lib/code/bitbucket-pipelines';
import { githubAuthFor } from '@/lib/code/github-browse';
import { ACTIONS_CONFIG_SCOPE } from '@/lib/code/github-actions';
import { grantScopes, missingScope } from '@/lib/code/access';
import {
  applyBitbucketVariables,
  applyGithubVariables,
  readBitbucketVariables,
  readGithubVariables,
  readVariableChanges,
  type VariablesPage,
} from '@/lib/code/host-variables';
import { logger } from '@/lib/logger';
import { whoIs } from '@/lib/log-actor';

/** The project's environment a request names, as the project spells it; null when it names none it has. */
async function environmentNamed(
  projectId: string,
  name: string | null
): Promise<{ name: string; production: boolean } | null> {
  const wanted = name?.trim().toLowerCase();
  if (!wanted) return null;
  const found = (await projectEnvironments(projectId)).find((e) => e.name.toLowerCase() === wanted);
  return found ? { name: found.name, production: found.production } : null;
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ projectId: string }> }
): Promise<Response> {
  const { projectId } = await params;
  const found = await builderContext(request, projectId);
  if (!found.ok) return found.response;
  const { project, subject, host, canEdit } = found.context;
  const environment = await environmentNamed(
    projectId,
    request.nextUrl.searchParams.get('environment')
  );
  const provider = project.repo.provider;
  const scopes = await grantScopes(subject, provider);
  const needs = !canEdit
    ? 'Only the project’s editors change its variables.'
    : host === 'github'
      ? missingScope(scopes, ACTIONS_CONFIG_SCOPE, GITHUB)
      : missingScope(scopes, PIPELINES_VARIABLE_SCOPE);
  const read =
    host === 'github'
      ? await readGithubVariables(
          await githubAuthFor(request, subject),
          project.repo.fullName,
          environment?.name ?? null
        )
      : await readBitbucketVariables(
          await bitbucketAuthFor(request, subject),
          project.repo.fullName,
          environment?.name ?? null
        );
  const page: VariablesPage = { host, ...read, needs };
  return NextResponse.json(page);
}

export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ projectId: string }> }
): Promise<Response> {
  const { projectId } = await params;
  const found = await builderContext(request, projectId, { write: true });
  if (!found.ok) return found.response;
  const { project, subject, host, scopes } = found.context;
  const needs =
    host === 'github'
      ? missingScope(scopes, ACTIONS_CONFIG_SCOPE, GITHUB)
      : missingScope(scopes, PIPELINES_VARIABLE_SCOPE);
  if (needs) return jsonError(403, 'scope', needs);
  const body = await readJsonBody(request);
  // `create: true` on an environment's set makes the host's deployment
  // environment and changes no variable.
  const createOnly = body.scope === 'environment' && body.create === true;
  const read = readVariableChanges(body, { allowEmpty: createOnly });
  if (!read.ok) return jsonError(400, 'invalid', read.message);
  const environment =
    body.scope === 'environment'
      ? await environmentNamed(
          projectId,
          typeof body.environment === 'string' ? body.environment : null
        )
      : null;
  if (body.scope === 'environment' && !environment) {
    return jsonError(400, 'environment', 'The project has no environment of that name.');
  }
  const which = environment ? `${environment.name} environment’s` : 'repository’s';
  const result =
    host === 'github'
      ? await applyGithubVariables(
          await githubAuthFor(request, subject),
          project.repo.fullName,
          environment,
          read.changes
        )
      : await applyBitbucketVariables(
          await bitbucketAuthFor(request, subject),
          project.repo.fullName,
          environment,
          read.changes
        );
  if (!result.ok) {
    logger.warn(
      '{actor} saved the {which} pipeline variables of the project "{project}" ({repository}), but the host did not take the change; nothing was changed: {error}',
      {
        component: 'api/code/projects/variables',
        ...(await whoIs(subject)),
        projectId,
        project: project.name,
        repository: project.repo.fullName,
        environment: environment?.name ?? null,
        which,
        error: result.error,
      }
    );
    return jsonError(502, 'host', result.error);
  }
  const { applied } = result;
  if (applied.added.length || applied.changed.length || applied.removed.length || result.created) {
    recordAuditEvent({
      actorSubject: subject,
      action: 'code.variables.saved',
      targetKind: 'code_project',
      targetLabel: project.name,
      details: {
        projectId,
        repository: project.repo.fullName,
        host,
        environment: environment?.name ?? null,
        environmentCreated: result.created,
        added: applied.added,
        changed: applied.changed,
        removed: applied.removed,
        secrets: read.changes.set.filter((c) => c.secured).map((c) => c.key),
      },
    });
  }
  if (applied.errors.length > 0) {
    logger.warn(
      '{actor} saved the {which} pipeline variables of the project "{project}" ({repository}), but the host refused some; those were not saved: {refused}',
      {
        component: 'api/code/projects/variables',
        ...(await whoIs(subject)),
        projectId,
        project: project.name,
        repository: project.repo.fullName,
        environment: environment?.name ?? null,
        which,
        // Names and the host's reasons; a value is never in an error.
        refused: applied.errors.join('; '),
      }
    );
  }
  return NextResponse.json({ ...applied, environmentCreated: result.created });
}
