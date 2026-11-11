/**
 * Replace one Actions variable set — the repository's, or a deployment
 * environment's (named in `environmentUuid`, which for GitHub is the
 * environment's name) — from its text: `KEY=value` lines, as the
 * Bitbucket page takes them. Only the difference travels. A `secret` line
 * is refused by name: GitHub takes secrets only sealed, and they are set
 * on github.com. The audit log records the keys, never a value.
 */

import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { GITHUB } from '@renkei/provider-grants';
import { jsonError, readJsonBody } from '@/lib/chat/route-support';
import { githubAuthFor } from '@/lib/code/github-browse';
import { ACTIONS_CONFIG_SCOPE, applyActionsVariableText } from '@/lib/code/github-actions';
import { missingScope, pipelinesProjectContext } from '@/lib/code/pipelines-access';
import { recordAuditEvent } from '@/lib/audit-events';
import { logger } from '@/lib/logger';
import { whoIs } from '@/lib/log-actor';

const TEXT_MAX_CHARS = 200_000;

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
  const text = typeof body.text === 'string' ? body.text : '';
  if (text.length > TEXT_MAX_CHARS) return jsonError(413, 'invalid', 'The text is too long.');
  const environment =
    typeof body.environmentUuid === 'string' && body.environmentUuid.trim()
      ? body.environmentUuid.trim()
      : undefined;
  const auth = await githubAuthFor(request, subject);
  const result = await applyActionsVariableText(auth, project.repo.fullName, environment, text);
  if (!result.ok) {
    logger.warn(
      '{actor} saved the {which} Actions variables of the project "{project}" ({repository}), but GitHub did not list the current set; nothing was changed: {error}',
      {
        component: 'api/code/projects/actions/variables',
        ...(await whoIs(subject)),
        projectId,
        project: project.name,
        repository: project.repo.fullName,
        environment: environment ?? null,
        which: environment ? 'environment' : 'repository',
        error: result.error,
      }
    );
    return jsonError(502, 'host', result.error);
  }
  const { applied } = result;
  if (applied.added.length || applied.changed.length || applied.removed.length) {
    recordAuditEvent({
      actorSubject: subject,
      action: 'code.actions.variables.replaced',
      targetKind: 'code_project',
      targetLabel: project.name,
      details: {
        projectId,
        repository: project.repo.fullName,
        environment: environment ?? null,
        added: applied.added,
        changed: applied.changed,
        removed: applied.removed,
      },
    });
  }
  return NextResponse.json({ ...applied, problems: result.problems });
}
