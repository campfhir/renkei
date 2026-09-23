/**
 * A code project's Bitbucket Pipelines — the switch, the YAML's presence,
 * the recent runs, the repository's variables and each deployment
 * environment's — read and written with the signed-in person's own
 * Bitbucket grant. GET reads it all for the project's Pipelines page, or
 * with `?view=summary` just what the project page's card shows: counts
 * and the last run, no variable names or values (any member). PUT flips
 * the switch (editors). Starting a run is runs/route.ts beside this, and
 * replacing a variable set from its text is variables/route.ts.
 *
 * Deliberately NOT MCP tools: a pipeline variable is where a deploy key
 * or a registry token lives. A chat can commit the YAML; the switch and
 * the variables are set here, by a person, and values go to Bitbucket
 * once and are never echoed. What the connection lacks is said in the
 * Connectors page's own words, before Bitbucket is asked.
 */

import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { jsonError, readJsonBody } from '@/lib/chat/route-support';
import { bitbucketAuthFor } from '@/lib/code/bitbucket-browse';
import { missingScope, pipelinesProjectContext } from '@/lib/code/pipelines-access';
import {
  PIPELINES_CONFIG_SCOPE,
  PIPELINES_VARIABLE_SCOPE,
  readPipelineSetup,
  setPipelinesEnabled,
  summarize,
} from '@/lib/code/bitbucket-pipelines';
import { recordAuditEvent } from '@/lib/audit-events';

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ tenantId: string; projectId: string }> }
): Promise<Response> {
  const { tenantId, projectId } = await params;
  const found = await pipelinesProjectContext(request, tenantId, projectId);
  if (!found.ok) return found.response;
  const { project, subject, scopes } = found.context;
  const configureNeeds = missingScope(scopes, PIPELINES_CONFIG_SCOPE);
  const variablesNeeds = missingScope(scopes, PIPELINES_VARIABLE_SCOPE);
  const auth = await bitbucketAuthFor(request, tenantId, subject);
  const read = await readPipelineSetup(auth, project.repo.fullName, project.repo.branch, {
    readSwitch: configureNeeds === null,
  });
  if (!read.ok) return jsonError(502, 'bitbucket', read.error);
  const setup = configureNeeds ? { ...read.setup, enabledError: configureNeeds } : read.setup;
  const access = { configureNeeds, variablesNeeds };
  if (request.nextUrl.searchParams.get('view') === 'summary') {
    return NextResponse.json({ ...summarize(setup), access });
  }
  return NextResponse.json({ ...setup, access });
}

export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ tenantId: string; projectId: string }> }
): Promise<Response> {
  const { tenantId, projectId } = await params;
  const found = await pipelinesProjectContext(request, tenantId, projectId, { write: true });
  if (!found.ok) return found.response;
  const { project, subject, scopes } = found.context;
  const needs = missingScope(scopes, PIPELINES_CONFIG_SCOPE);
  if (needs) return jsonError(403, 'scope', needs);
  const body = await readJsonBody(request);
  if (typeof body.enabled !== 'boolean') return jsonError(400, 'invalid', 'On or off?');
  const auth = await bitbucketAuthFor(request, tenantId, subject);
  const set = await setPipelinesEnabled(auth, project.repo.fullName, body.enabled);
  if (!set.ok) return jsonError(502, 'bitbucket', set.error);
  recordAuditEvent({
    tenantId,
    actorSubject: subject,
    action: set.enabled ? 'code.pipelines.enabled' : 'code.pipelines.disabled',
    targetKind: 'code_project',
    targetLabel: project.name,
    details: { projectId, repository: project.repo.fullName },
  });
  return NextResponse.json({ enabled: set.enabled });
}
