/**
 * A code project's environments: GET answers the Environments page
 * (lib/ci/environments.ts — each environment, the branches assigned to
 * it, what the builder keeps for each branch, what its pipelines last
 * reported, and the repository's branches as its host lists them, read
 * with the person's own grant); PUT replaces the list (editors), under
 * the rules of lib/ci/environment-rules.ts: one production environment
 * holding at most one branch, a branch in one environment, and only
 * branches the remote has.
 */

import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { readJsonBody } from '@/lib/chat/route-support';
import { recordAuditEvent } from '@/lib/audit-events';
import { readEnvironmentList } from '@/lib/ci/environment-rules';
import { environmentChanges, environmentsPage, saveEnvironments } from '@/lib/ci/environments';
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
  const { project, subject, origin, host, canEdit } = found.context;
  return NextResponse.json(await environmentsPage(host, { subject, origin }, project, canEdit));
}

export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ projectId: string }> }
): Promise<Response> {
  const { projectId } = await params;
  const found = await builderContext(request, projectId, { write: true });
  if (!found.ok) return found.response;
  const { project, subject, origin, host, canEdit } = found.context;
  const body = await readJsonBody(request);
  const list = readEnvironmentList(body.environments);
  if (!list) {
    return NextResponse.json(
      { error: 'The environments were not sent as a list.', problems: [] },
      { status: 400 }
    );
  }
  const caller = { subject, origin };
  const saved = await saveEnvironments(host, caller, project, list);
  if (!saved.ok) {
    logger.warn(
      '{actor} changed the environments of the project "{project}" ({repository}), but the list breaks a rule; nothing was saved: {problems}',
      {
        component: 'api/code/projects/environments',
        ...(await whoIs(subject)),
        projectId,
        project: project.name,
        repository: project.repo.fullName,
        problems: saved.problems.join(' '),
      }
    );
    return NextResponse.json(
      { error: saved.problems[0] ?? 'The environments cannot be saved.', problems: saved.problems },
      { status: 400 }
    );
  }
  const changes = environmentChanges(saved.before, saved.environments);
  if (changes.length > 0) {
    recordAuditEvent({
      actorSubject: subject,
      action: 'ci.environments_saved',
      targetKind: 'code_project',
      targetLabel: project.name,
      details: { projectId, repository: project.repo.fullName, changes },
    });
  }
  return NextResponse.json(await environmentsPage(host, caller, project, canEdit));
}
