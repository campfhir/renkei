/**
 * A GitHub code project's Actions — the switch, the workflow files, the
 * recent runs, the repository's variables and each deployment
 * environment's (with secret names, never values) — read and written with
 * the signed-in person's own GitHub grant: the counterpart of
 * pipelines/route.ts for Bitbucket. GET reads it all for the project's
 * Actions page, or with `?view=summary` just what the project page's card
 * shows: counts and the last run, no variable names or values (any
 * member). PUT flips the switch (editors). Replacing a variable set from
 * its text is variables/route.ts; committing a workflow file is
 * workflow-file/route.ts.
 *
 * What the connection lacks is said in the Connectors page's own words,
 * before GitHub is asked.
 */

import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { GITHUB } from '@renkei/provider-grants';
import { jsonError, readJsonBody } from '@/lib/chat/route-support';
import { githubAuthFor } from '@/lib/code/github-browse';
import {
  ACTIONS_CONFIG_SCOPE,
  readActionsSetup,
  setActionsEnabled,
  summarizeActions,
} from '@/lib/code/github-actions';
import { missingScope, pipelinesProjectContext } from '@/lib/code/pipelines-access';
import { recordAuditEvent } from '@/lib/audit-events';
import { logger } from '@/lib/logger';
import { whoIs } from '@/lib/log-actor';

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ projectId: string }> }
): Promise<Response> {
  const { projectId } = await params;
  const found = await pipelinesProjectContext(request, projectId, { host: GITHUB });
  if (!found.ok) return found.response;
  const { project, subject, scopes } = found.context;
  const configureNeeds = missingScope(scopes, ACTIONS_CONFIG_SCOPE, GITHUB);
  const auth = await githubAuthFor(request, subject);
  const summary = request.nextUrl.searchParams.get('view') === 'summary';
  const read = await readActionsSetup(auth, project.repo.fullName, project.repo.branch, {
    readConfig: configureNeeds === null,
    runs: summary ? 1 : 20,
  });
  if (!read.ok) {
    logger.warn(
      '{actor} opened the Actions page of the project "{project}" ({repository}), but GitHub did not answer; the page showed the error: {error}',
      {
        component: 'api/code/projects/actions',
        ...(await whoIs(subject)),
        projectId,
        project: project.name,
        repository: project.repo.fullName,
        error: read.error,
      }
    );
    return jsonError(502, 'host', read.error);
  }
  // The runs are what every member can read; when GitHub cannot list them
  // (no grant of the person's own, say) the reason is the answer, as it was
  // before this route read more, so the card and the page say it as an alert.
  if (read.setup.runsError) {
    logger.warn(
      '{actor} opened the Actions runs of the project "{project}" ({repository}), but GitHub did not list them; the page showed the error: {error}',
      {
        component: 'api/code/projects/actions',
        ...(await whoIs(subject)),
        projectId,
        project: project.name,
        repository: project.repo.fullName,
        error: read.setup.runsError,
      }
    );
    return jsonError(502, 'host', read.setup.runsError);
  }
  const setup = configureNeeds ? { ...read.setup, enabledError: configureNeeds } : read.setup;
  const access = { configureNeeds };
  if (summary)
    return NextResponse.json({ ...summarizeActions(setup, configureNeeds === null), access });
  return NextResponse.json({ ...setup, access });
}

export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ projectId: string }> }
): Promise<Response> {
  const { projectId } = await params;
  const found = await pipelinesProjectContext(request, projectId, { write: true, host: GITHUB });
  if (!found.ok) return found.response;
  const { project, subject, scopes } = found.context;
  const needs = missingScope(scopes, ACTIONS_CONFIG_SCOPE, GITHUB);
  if (needs) return jsonError(403, 'scope', needs);
  const body = await readJsonBody(request);
  if (typeof body.enabled !== 'boolean') return jsonError(400, 'invalid', 'On or off?');
  const auth = await githubAuthFor(request, subject);
  const set = await setActionsEnabled(auth, project.repo.fullName, body.enabled);
  if (!set.ok) {
    logger.warn(
      '{actor} switched Actions {onOff} for the project "{project}" ({repository}), but GitHub refused; the switch is unchanged: {error}',
      {
        component: 'api/code/projects/actions',
        ...(await whoIs(subject)),
        projectId,
        project: project.name,
        repository: project.repo.fullName,
        onOff: body.enabled ? 'on' : 'off',
        error: set.error,
      }
    );
    return jsonError(502, 'host', set.error);
  }
  recordAuditEvent({
    actorSubject: subject,
    action: set.enabled ? 'code.actions.enabled' : 'code.actions.disabled',
    targetKind: 'code_project',
    targetLabel: project.name,
    details: { projectId, repository: project.repo.fullName },
  });
  return NextResponse.json({ enabled: set.enabled });
}
