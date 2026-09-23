/**
 * A code project's `bitbucket-pipelines.yml` on its branch: GET reads
 * it as text (any member; null when there is none), PUT commits new
 * text to the branch with the person's own grant (editors) — how a
 * pipeline file is started from a template, or edited, without a chat.
 * Stands on the scope a code project's pushes stand on, and Bitbucket's
 * own refusal (a restricted branch, say) is reported in its words.
 */

import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { jsonError, readJsonBody } from '@/lib/chat/route-support';
import { bitbucketAuthFor } from '@/lib/code/bitbucket-browse';
import {
  PIPELINES_FILE_SCOPE,
  commitPipelineConfigFile,
  readPipelineConfigFile,
} from '@/lib/code/bitbucket-pipelines';
import { recordAuditEvent } from '@/lib/audit-events';
import { missing, projectFor } from '../route';

const FILE_MAX_CHARS = 200_000;
const MESSAGE_MAX_CHARS = 500;

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ tenantId: string; projectId: string }> }
): Promise<Response> {
  const { tenantId, projectId } = await params;
  const found = await projectFor(request, tenantId, projectId, false);
  if (!found.ok) return found.response;
  const { project, subject } = found.found;
  const auth = await bitbucketAuthFor(request, tenantId, subject);
  const file = await readPipelineConfigFile(auth, project.repo.fullName, project.repo.branch);
  if (!file.ok) return jsonError(502, 'bitbucket', file.error);
  return NextResponse.json({ ref: file.ref, text: file.text });
}

export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ tenantId: string; projectId: string }> }
): Promise<Response> {
  const { tenantId, projectId } = await params;
  const found = await projectFor(request, tenantId, projectId, true);
  if (!found.ok) return found.response;
  const { project, subject, scopes } = found.found;
  const needs = missing(scopes, PIPELINES_FILE_SCOPE);
  if (needs) return jsonError(403, 'scope', needs);
  const body = await readJsonBody(request);
  const text = typeof body.text === 'string' ? body.text.replace(/\r\n?/g, '\n') : '';
  if (!text.trim()) return jsonError(400, 'invalid', 'The pipeline file is empty.');
  if (text.length > FILE_MAX_CHARS) return jsonError(413, 'invalid', 'The file is too long.');
  const message =
    (typeof body.message === 'string' ? body.message.trim().slice(0, MESSAGE_MAX_CHARS) : '') ||
    'Add bitbucket-pipelines.yml';
  const auth = await bitbucketAuthFor(request, tenantId, subject);
  const committed = await commitPipelineConfigFile(
    auth,
    project.repo.fullName,
    project.repo.branch,
    text,
    message
  );
  if (!committed.ok) return jsonError(502, 'bitbucket', committed.error);
  recordAuditEvent({
    tenantId,
    actorSubject: subject,
    action: 'code.pipelines.file.committed',
    targetKind: 'code_project',
    targetLabel: project.name,
    details: { projectId, repository: project.repo.fullName, ref: committed.ref, message },
  });
  return NextResponse.json({ ref: committed.ref, url: committed.url });
}
