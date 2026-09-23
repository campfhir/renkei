/**
 * Start a pipeline run from a code project's Pipelines page: on a branch
 * or tag, the ref's default pipeline or a named custom one (editors).
 * Stands on the same scope as the chat's bitbucket_trigger_pipeline —
 * a run spends build minutes and can deploy, so a grant narrowed to
 * reading pipelines cannot start one from here either. The run comes
 * back as the page lists runs.
 */

import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { jsonError, readJsonBody } from '@/lib/chat/route-support';
import { bitbucketAuthFor } from '@/lib/code/bitbucket-browse';
import {
  PIPELINES_RUN_SCOPE,
  triggerPipeline,
  validateRunInput,
} from '@/lib/code/bitbucket-pipelines';
import { recordAuditEvent } from '@/lib/audit-events';
import { missingScope, pipelinesProjectContext } from '@/lib/code/pipelines-access';

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ tenantId: string; projectId: string }> }
): Promise<Response> {
  const { tenantId, projectId } = await params;
  const found = await pipelinesProjectContext(request, tenantId, projectId, { write: true });
  if (!found.ok) return found.response;
  const { project, subject, scopes } = found.context;
  const needs = missingScope(scopes, PIPELINES_RUN_SCOPE);
  if (needs) return jsonError(403, 'scope', needs);
  const input = validateRunInput(await readJsonBody(request));
  if (!input.ok) return jsonError(400, 'invalid', input.message);
  const auth = await bitbucketAuthFor(request, tenantId, subject);
  const started = await triggerPipeline(auth, project.repo.fullName, input.input);
  if (!started.ok) return jsonError(502, 'bitbucket', started.error);
  recordAuditEvent({
    tenantId,
    actorSubject: subject,
    action: 'code.pipelines.run',
    targetKind: 'code_project',
    targetLabel: project.name,
    details: {
      projectId,
      repository: project.repo.fullName,
      ref: input.input.ref,
      refType: input.input.refType,
      pattern: input.input.pattern || null,
      buildNumber: started.run.buildNumber,
    },
  });
  return NextResponse.json({ run: started.run });
}
