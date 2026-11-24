/**
 * A branch's pipeline builder (`?branch=`, a branch assigned to one of
 * the project's environments): GET answers everything the page shows
 * (lib/ci/pipeline-builder.ts — the blocks, the targets, what the host
 * says, and the pipeline saved for the branch or one suggested from its
 * files), read with the person's own grant on the host; PUT saves the
 * pipeline as it stands (editors), without writing anything to the
 * repository.
 */

import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { readPipelineSpec } from '@renkei/ci-blocks';
import { readJsonBody } from '@/lib/chat/route-support';
import { recordAuditEvent } from '@/lib/audit-events';
import { builderPage, savePipeline, specForBranch } from '@/lib/ci/pipeline-builder';
import { branchContext } from '@/lib/ci/pipeline-builder-access';
import { logger } from '@/lib/logger';
import { whoIs } from '@/lib/log-actor';

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ projectId: string }> }
): Promise<Response> {
  const { projectId } = await params;
  const found = await branchContext(request, projectId);
  if (!found.ok) return found.response;
  const { project, subject, origin, canEdit, environment, production } = found.context;
  const page = await builderPage({ subject, origin }, project, environment);
  if (page.unread.length > 0) {
    logger.info(
      '{actor} opened the pipeline builder of the project "{project}" ({repository}); some of what the host says could not be read, so those checks were skipped: {unread}',
      {
        component: 'api/code/projects/pipeline-builder',
        ...(await whoIs(subject)),
        projectId,
        project: project.name,
        repository: project.repo.fullName,
        unread: page.unread.join('; '),
      }
    );
  }
  return NextResponse.json({
    ...page,
    canEdit,
    production,
    project: { name: project.name, repo: project.repo.fullName, branch: project.repo.branch },
  });
}

export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ projectId: string }> }
): Promise<Response> {
  const { projectId } = await params;
  const found = await branchContext(request, projectId, { write: true });
  if (!found.ok) return found.response;
  const { project, subject, environment, branch } = found.context;
  const body = await readJsonBody(request);
  const spec = readPipelineSpec(body.spec);
  if (!spec.ok) {
    return NextResponse.json(
      { error: 'The pipeline cannot be saved yet.', problems: spec.errors },
      { status: 400 }
    );
  }
  await savePipeline(project, specForBranch(spec.value, environment, branch), subject);
  recordAuditEvent({
    actorSubject: subject,
    action: 'ci.pipeline_saved',
    targetKind: 'code_project',
    targetLabel: project.name,
    details: {
      projectId,
      repository: project.repo.fullName,
      environments: [`${environment} ← ${branch}`],
    },
  });
  return NextResponse.json({ saved: true });
}
