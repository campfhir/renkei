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
import { ATLASSIAN_BITBUCKET } from '@renkei/provider-grants';
import { chatRequestContext, jsonError, readJsonBody } from '@/lib/chat/route-support';
import { resolveResourceAccess } from '@/lib/chat/access';
import { getProjectRow, type ProjectRow } from '@/lib/chat/projects';
import { grantScopes, scopeOptionLabels } from '@/lib/code/access';
import { bitbucketAuthFor } from '@/lib/code/bitbucket-browse';
import {
  PIPELINES_CONFIG_SCOPE,
  PIPELINES_VARIABLE_SCOPE,
  readPipelineSetup,
  setPipelinesEnabled,
  summarize,
} from '@/lib/code/bitbucket-pipelines';
import { recordAuditEvent } from '@/lib/audit-events';

export interface Found {
  project: ProjectRow & { repo: NonNullable<ProjectRow['repo']> };
  subject: string;
  /** What the person's Bitbucket connection carries; null when not connected. */
  scopes: string[] | null;
}

export async function projectFor(
  request: NextRequest,
  tenantId: string,
  projectId: string,
  edit: boolean
): Promise<{ ok: true; found: Found } | { ok: false; response: NextResponse }> {
  const ready = await chatRequestContext(request, tenantId);
  if (!ready.ok) return { ok: false, response: ready.response };
  const { db, session } = ready.context;
  const access = await resolveResourceAccess(
    db,
    tenantId,
    session.subject,
    'chat_project',
    projectId
  );
  if (!access)
    return { ok: false as const, response: jsonError(404, 'not-found', 'No such project') };
  if (edit && access.role === 'viewer') {
    return {
      ok: false,
      response: jsonError(403, 'read-only', 'Only editors can change this project’s pipelines.'),
    };
  }
  const project = await getProjectRow(db, tenantId, projectId);
  if (!project || project.kind !== 'code' || !project.repo) {
    return { ok: false, response: jsonError(404, 'not-found', 'No such project') };
  }
  if (project.repo.provider !== ATLASSIAN_BITBUCKET) {
    return {
      ok: false,
      response: jsonError(409, 'not-bitbucket', 'Only a Bitbucket repository has Pipelines.'),
    };
  }
  const scopes = await grantScopes(db, tenantId, session.subject, ATLASSIAN_BITBUCKET);
  return {
    ok: true,
    found: { project: { ...project, repo: project.repo }, subject: session.subject, scopes },
  };
}

/** What the connection lacks for a scope, said as the Connectors page says it; null when it carries it. */
export function missing(scopes: string[] | null, scope: string): string | null {
  if (!scopes) return 'Connect Bitbucket on the Connectors page first.';
  if (scopes.includes(scope)) return null;
  const labels = scopeOptionLabels([scope], ATLASSIAN_BITBUCKET);
  return `Your Bitbucket connection does not carry “${labels[0] ?? scope}”. Reconnect Bitbucket on the Connectors page with it enabled.`;
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ tenantId: string; projectId: string }> }
): Promise<Response> {
  const { tenantId, projectId } = await params;
  const found = await projectFor(request, tenantId, projectId, false);
  if (!found.ok) return found.response;
  const { project, subject, scopes } = found.found;
  const configureNeeds = missing(scopes, PIPELINES_CONFIG_SCOPE);
  const variablesNeeds = missing(scopes, PIPELINES_VARIABLE_SCOPE);
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
  const found = await projectFor(request, tenantId, projectId, true);
  if (!found.ok) return found.response;
  const { project, subject, scopes } = found.found;
  const needs = missing(scopes, PIPELINES_CONFIG_SCOPE);
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
