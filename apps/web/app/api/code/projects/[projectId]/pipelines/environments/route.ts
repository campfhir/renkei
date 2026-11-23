/**
 * POST: add a Bitbucket deployment environment the project's pipeline
 * names but the repository lacks (editors), so its deploys and variables
 * have a home. Body: { name } — one of the saved pipeline's environments.
 */

import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { jsonError, readJsonBody } from '@/lib/chat/route-support';
import { bitbucketAuthFor } from '@/lib/code/bitbucket-browse';
import {
  PIPELINES_VARIABLE_SCOPE,
  createDeploymentEnvironment,
} from '@/lib/code/bitbucket-pipelines';
import { missingScope, pipelinesProjectContext } from '@/lib/code/pipelines-access';
import { pipelineVariableNeeds } from '@/lib/ci/pipeline-builder';
import { recordAuditEvent } from '@/lib/audit-events';
import { logger } from '@/lib/logger';
import { whoIs } from '@/lib/log-actor';

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ projectId: string }> }
): Promise<Response> {
  const { projectId } = await params;
  const found = await pipelinesProjectContext(request, projectId, { write: true });
  if (!found.ok) return found.response;
  const { project, subject, scopes } = found.context;
  const needs = missingScope(scopes, PIPELINES_VARIABLE_SCOPE);
  if (needs) return jsonError(403, 'scope', needs);
  const body = await readJsonBody(request);
  const name = typeof body.name === 'string' ? body.name.trim() : '';
  const pipeline = await pipelineVariableNeeds(projectId);
  if (!pipeline?.environments.includes(name)) {
    return jsonError(400, 'invalid', `The pipeline has no environment named ${name || '(none)'}.`);
  }
  const auth = await bitbucketAuthFor(request, subject);
  const created = await createDeploymentEnvironment(auth, project.repo.fullName, name);
  if (!created.ok) {
    logger.warn(
      '{actor} asked to add the deployment environment {environment} to the project "{project}" ({repository}), but Bitbucket refused; nothing was added: {error}',
      {
        component: 'api/code/projects/pipelines/environments',
        ...(await whoIs(subject)),
        projectId,
        project: project.name,
        repository: project.repo.fullName,
        environment: name,
        error: created.error,
      }
    );
    return jsonError(502, 'bitbucket', created.error);
  }
  logger.info(
    '{actor} added the deployment environment {environment} to the project "{project}" ({repository})',
    {
      component: 'api/code/projects/pipelines/environments',
      ...(await whoIs(subject)),
      projectId,
      project: project.name,
      repository: project.repo.fullName,
      environment: name,
    }
  );
  recordAuditEvent({
    actorSubject: subject,
    action: 'code.pipelines.environment.created',
    targetKind: 'code_project',
    targetLabel: project.name,
    details: { projectId, repository: project.repo.fullName, environment: name },
  });
  return NextResponse.json({ name }, { status: 201 });
}
