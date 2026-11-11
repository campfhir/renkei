/**
 * One workflow file of a GitHub code project, `.github/workflows/<name>`
 * on its branch: GET reads it as text (any member; null when there is
 * none), PUT commits new text to the branch with the person's own grant
 * (editors) — how a workflow is started from a template, or edited,
 * without a chat. The file is named in `?name=` / the body, since GitHub
 * has many where Bitbucket has one. GitHub's own refusal (a protected
 * branch, say) is reported in its words.
 */

import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { GITHUB } from '@renkei/provider-grants';
import { jsonError, readJsonBody } from '@/lib/chat/route-support';
import { githubAuthFor } from '@/lib/code/github-browse';
import {
  ACTIONS_FILE_SCOPE,
  commitWorkflowFile,
  readWorkflowFile,
  workflowFileName,
} from '@/lib/code/github-actions';
import { missingScope, pipelinesProjectContext } from '@/lib/code/pipelines-access';
import { recordAuditEvent } from '@/lib/audit-events';
import { logger } from '@/lib/logger';
import { whoIs } from '@/lib/log-actor';

const FILE_MAX_CHARS = 200_000;
const MESSAGE_MAX_CHARS = 500;

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ projectId: string }> }
): Promise<Response> {
  const { projectId } = await params;
  const found = await pipelinesProjectContext(request, projectId, { host: GITHUB });
  if (!found.ok) return found.response;
  const { project, subject } = found.context;
  const name = workflowFileName(request.nextUrl.searchParams.get('name') ?? '');
  if (!name) return jsonError(400, 'invalid', 'Which workflow file? A name like ci.yml.');
  const auth = await githubAuthFor(request, subject);
  const file = await readWorkflowFile(auth, project.repo.fullName, project.repo.branch, name);
  if (!file.ok) {
    logger.warn(
      '{actor} opened the workflow file {file} of the project "{project}" ({repository}), but GitHub did not return it; the editor showed the error: {error}',
      {
        component: 'api/code/projects/actions/workflow-file',
        ...(await whoIs(subject)),
        projectId,
        project: project.name,
        repository: project.repo.fullName,
        file: name,
        error: file.error,
      }
    );
    return jsonError(502, 'host', file.error);
  }
  return NextResponse.json({ name, ref: file.ref, text: file.text });
}

export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ projectId: string }> }
): Promise<Response> {
  const { projectId } = await params;
  const found = await pipelinesProjectContext(request, projectId, { write: true, host: GITHUB });
  if (!found.ok) return found.response;
  const { project, subject, scopes } = found.context;
  const needs = missingScope(scopes, ACTIONS_FILE_SCOPE, GITHUB);
  if (needs) return jsonError(403, 'scope', needs);
  const body = await readJsonBody(request);
  const name = workflowFileName(typeof body.name === 'string' ? body.name : '');
  if (!name) return jsonError(400, 'invalid', 'Which workflow file? A name like ci.yml.');
  const text = typeof body.text === 'string' ? body.text.replace(/\r\n?/g, '\n') : '';
  if (!text.trim()) return jsonError(400, 'invalid', 'The workflow file is empty.');
  if (text.length > FILE_MAX_CHARS) return jsonError(413, 'invalid', 'The file is too long.');
  const message =
    (typeof body.message === 'string' ? body.message.trim().slice(0, MESSAGE_MAX_CHARS) : '') ||
    `Add ${name}`;
  const auth = await githubAuthFor(request, subject);
  const committed = await commitWorkflowFile(
    auth,
    project.repo.fullName,
    project.repo.branch,
    name,
    text,
    message
  );
  if (!committed.ok) {
    logger.warn(
      '{actor} saved the workflow file {file} of the project "{project}" ({repository}), but GitHub refused the commit to {branch}; the file is unchanged: {error}',
      {
        component: 'api/code/projects/actions/workflow-file',
        ...(await whoIs(subject)),
        projectId,
        project: project.name,
        repository: project.repo.fullName,
        file: name,
        branch: project.repo.branch || 'the default branch',
        error: committed.error,
      }
    );
    return jsonError(502, 'host', committed.error);
  }
  recordAuditEvent({
    actorSubject: subject,
    action: 'code.actions.file.committed',
    targetKind: 'code_project',
    targetLabel: project.name,
    details: {
      projectId,
      repository: project.repo.fullName,
      file: name,
      ref: committed.ref,
      message,
    },
  });
  return NextResponse.json({ name, ref: committed.ref, url: committed.url });
}
