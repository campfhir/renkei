/**
 * Replace one variable set — the repository's, or a deployment
 * environment's — from its text: `KEY=value` lines, `secret ` for a
 * secured one (editors). The text is parsed here, the set Bitbucket has
 * is read, and only the difference travels: creates, replacements,
 * deletions, each on its own so a refusal names its key and the rest
 * still lands. Lines that were not variables come back by number. The
 * audit log records the keys, never a value.
 */

import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { jsonError, readJsonBody } from '@/lib/chat/route-support';
import { bitbucketAuthFor } from '@/lib/code/bitbucket-browse';
import {
  PIPELINES_VARIABLE_SCOPE,
  applyVariableText,
  listVariables,
  parseVariableText,
  repoBase,
  variablesPath,
} from '@/lib/code/bitbucket-pipelines';
import { recordAuditEvent } from '@/lib/audit-events';
import { missing, projectFor } from '../route';

const TEXT_MAX_CHARS = 200_000;

export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ tenantId: string; projectId: string }> }
): Promise<Response> {
  const { tenantId, projectId } = await params;
  const found = await projectFor(request, tenantId, projectId, true);
  if (!found.ok) return found.response;
  const { project, subject, scopes } = found.found;
  const needs = missing(scopes, PIPELINES_VARIABLE_SCOPE);
  if (needs) return jsonError(403, 'scope', needs);
  const body = await readJsonBody(request);
  const text = typeof body.text === 'string' ? body.text : '';
  if (text.length > TEXT_MAX_CHARS) return jsonError(413, 'invalid', 'The text is too long.');
  const environmentUuid =
    typeof body.environmentUuid === 'string' && body.environmentUuid.trim()
      ? body.environmentUuid.trim()
      : undefined;
  const base = repoBase(project.repo.fullName);
  if (!base) return jsonError(400, 'invalid', 'The repository name is not usable.');
  const parsed = parseVariableText(text);
  const auth = await bitbucketAuthFor(request, tenantId, subject);
  const current = await listVariables(auth, variablesPath(base, environmentUuid));
  if (!current.ok) return jsonError(502, 'bitbucket', current.error);
  const applied = await applyVariableText(
    auth,
    project.repo.fullName,
    environmentUuid,
    current.variables,
    parsed.entries
  );
  if (applied.added.length || applied.changed.length || applied.removed.length) {
    recordAuditEvent({
      tenantId,
      actorSubject: subject,
      action: 'code.pipelines.variables.replaced',
      targetKind: 'code_project',
      targetLabel: project.name,
      details: {
        projectId,
        repository: project.repo.fullName,
        environmentUuid: environmentUuid ?? null,
        added: applied.added,
        changed: applied.changed,
        removed: applied.removed,
      },
    });
  }
  return NextResponse.json({ ...applied, problems: parsed.problems });
}
