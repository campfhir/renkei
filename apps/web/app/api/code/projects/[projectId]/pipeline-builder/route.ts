/**
 * A code project's pipeline builder: GET answers everything the page
 * shows (lib/ci/pipeline-builder.ts — the blocks, the targets, what the
 * host says, and the saved pipeline or one suggested from the repository),
 * read with the person's own grant on the host; PUT saves the pipeline
 * as it stands (editors), without writing anything to the repository.
 */

import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { readPipelineSpec } from '@renkei/ci-blocks';
import { readJsonBody } from '@/lib/chat/route-support';
import { recordAuditEvent } from '@/lib/audit-events';
import { builderPage, savePipeline } from '@/lib/ci/pipeline-builder';
import { builderContext } from '@/lib/ci/pipeline-builder-access';
import { logger } from '@/lib/logger';
import { whoIs } from '@/lib/log-actor';

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ projectId: string }> }
): Promise<Response> {
  const { projectId } = await params;
  const found = await builderContext(request, projectId);
  if (!found.ok) return found.response;
  const { project, subject, origin, canEdit } = found.context;
  const page = await builderPage({ subject, origin }, project);
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
    // The branch it read: the repository's default when the project follows it.
    project: { name: project.name, repo: project.repo.fullName, branch: page.facts.branch },
  });
}

export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ projectId: string }> }
): Promise<Response> {
  const { projectId } = await params;
  const found = await builderContext(request, projectId, { write: true });
  if (!found.ok) return found.response;
  const { project, subject } = found.context;
  const body = await readJsonBody(request);
  const spec = readPipelineSpec(body.spec);
  if (!spec.ok) {
    return NextResponse.json(
      { error: 'The pipeline cannot be saved yet.', problems: spec.errors },
      { status: 400 }
    );
  }
  await savePipeline(project, spec.value, subject);
  recordAuditEvent({
    actorSubject: subject,
    action: 'ci.pipeline_saved',
    targetKind: 'code_project',
    targetLabel: project.name,
    details: {
      projectId,
      repository: project.repo.fullName,
      environments: spec.value.environments.map((e) => `${e.name} ← ${e.branch}`),
    },
  });
  return NextResponse.json({ saved: true });
}
