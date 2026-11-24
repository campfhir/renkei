/**
 * POST: save the pipeline and put its file in a pull request against the
 * project's branch (lib/ci/pipeline-builder.ts) with the person's own
 * grant — a new pull request from a renkei/pipeline branch, or a commit
 * on the builder's own while it is open. Editors only; the host's refusal
 * is reported in its words. A file that cannot be written yet answers 400
 * with each reason, and nothing is sent to the host.
 */

import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { GITHUB } from '@renkei/provider-grants';
import { readPipelineSpec } from '@renkei/ci-blocks';
import { jsonError, readJsonBody } from '@/lib/chat/route-support';
import { recordAuditEvent } from '@/lib/audit-events';
import { missingScope } from '@/lib/code/access';
import { openPipelinePullRequest, specForBranch } from '@/lib/ci/pipeline-builder';
import { branchContext } from '@/lib/ci/pipeline-builder-access';
import { logger } from '@/lib/logger';
import { whoIs } from '@/lib/log-actor';

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ projectId: string }> }
): Promise<Response> {
  const { projectId } = await params;
  const found = await branchContext(request, projectId, { write: true });
  if (!found.ok) return found.response;
  const { project, subject, origin, host, scopes, environment, branch: base } = found.context;
  const provider = host === 'github' ? GITHUB : project.repo.provider;
  for (const scope of ['repository:write', 'pullrequest:write']) {
    const needs = missingScope(scopes, scope, host === 'github' ? GITHUB : undefined);
    if (needs) return jsonError(403, 'scope', needs);
  }
  const body = await readJsonBody(request);
  const spec = readPipelineSpec(body.spec);
  if (!spec.ok) {
    return NextResponse.json(
      { error: 'The pipeline cannot be saved yet.', problems: spec.errors },
      { status: 400 }
    );
  }
  const outcome = await openPipelinePullRequest(
    { subject, origin },
    project,
    specForBranch(spec.value, environment, base),
    new Date()
  );
  if (!outcome.ok) {
    if (outcome.status >= 500) {
      logger.warn(
        '{actor} opened a pull request with the pipeline of the project "{project}" ({repository}), but the host refused; no pull request was opened: {error}',
        {
          component: 'api/code/projects/pipeline-builder/pull-request',
          ...(await whoIs(subject)),
          projectId,
          project: project.name,
          repository: project.repo.fullName,
          provider,
          error: outcome.error,
        }
      );
    }
    return NextResponse.json(
      { error: outcome.error, ...(outcome.problems ? { problems: outcome.problems } : {}) },
      { status: outcome.status }
    );
  }
  recordAuditEvent({
    actorSubject: subject,
    action: 'ci.pipeline_pull_request',
    targetKind: 'code_project',
    targetLabel: project.name,
    details: {
      projectId,
      repository: project.repo.fullName,
      environment,
      into: base,
      branch: outcome.branch,
      url: outcome.url,
      updated: outcome.updated,
    },
  });
  logger.info(
    '{actor} {verb} the pull request with the {into} pipeline of the project "{project}" ({repository}) from {branch}: {url}',
    {
      component: 'api/code/projects/pipeline-builder/pull-request',
      ...(await whoIs(subject)),
      projectId,
      project: project.name,
      repository: project.repo.fullName,
      verb: outcome.updated ? 'updated' : 'opened',
      into: base,
      environment,
      branch: outcome.branch,
      url: outcome.url,
    }
  );
  return NextResponse.json({
    url: outcome.url,
    branch: outcome.branch,
    updated: outcome.updated,
  });
}
