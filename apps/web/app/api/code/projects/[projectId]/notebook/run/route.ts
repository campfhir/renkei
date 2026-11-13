/**
 * Run a notebook of the project's checkout, for the code pane.
 *
 * POST `{path}`: every code cell of the `.ipynb` at `path` executed top
 * to bottom on the sandbox, in the notebook's own folder, as the
 * project's uid with the project's environment — one command through
 * the exec verb the chat's own tool uses (lib/code/notebook-runner.ts
 * says what it runs). The outputs are written into the file itself, in
 * the working tree, uncommitted; the answer is only how it went
 * (`{run: {engine, ran, total, seconds, failed}}`) and the pane reads
 * the file again. A cell that raises is a finished run with `failed`
 * set, not an error; a run that could not happen at all (no Python, a
 * kernel that would not start, the time limit) is 422 with the reason.
 *
 * Running a notebook is running the repository's code and changes a
 * file, so it is a write: editors only, the chat's owner in a chat's
 * worktree, refused in the organization's read-only mode. A request
 * that goes away (the pane's Stop) takes the run with it.
 */

import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { validateWorkspacePath } from '@renkei/connector-sandbox';
import { clientFailure, sbWorkspaceExec } from '@renkei/sandbox-client';
import { jsonError, readJsonBody } from '@/lib/chat/route-support';
import { isNotebookPath } from '@/lib/code/notebook';
import {
  NOTEBOOK_RUN_TIMEOUT_MS,
  notebookRunCommand,
  readNotebookRun,
} from '@/lib/code/notebook-runner';
import { codeProjectContext } from '@/lib/code/route-access';
import { codeProjectTarget } from '@/lib/code/scope';
import { recordAuditEvent } from '@/lib/audit-events';
import { who } from '@/lib/log-actor';
import { logger } from '@/lib/logger';

export const maxDuration = 660;

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ projectId: string; chatId?: string }> }
): Promise<Response> {
  const { projectId, chatId } = await params;
  const ready = await codeProjectContext(request, projectId, { write: true, chatId });
  if (!ready.ok) return ready.response;
  const { session, project, workspaceId } = ready.context;
  if (!workspaceId)
    return jsonError(409, 'not-cloned', 'Clone the repository before running its notebooks.');

  const body = await readJsonBody(request);
  const path = validateWorkspacePath(body.path, { forWrite: true });
  if (!path.ok || !path.path)
    return jsonError(400, 'invalid', path.ok ? 'Say which notebook.' : path.message);
  if (!isNotebookPath(path.path))
    return jsonError(400, 'invalid', 'Only a notebook (.ipynb) runs here.');

  const ran = await sbWorkspaceExec(
    codeProjectTarget(projectId),
    {
      id: workspaceId,
      command: notebookRunCommand(path.path),
      timeoutMs: NOTEBOOK_RUN_TIMEOUT_MS,
    },
    { signal: request.signal }
  );
  if (!ran.ok) {
    if (request.signal.aborted) return jsonError(499, 'stopped', 'The run was stopped.');
    const failure = clientFailure(ran.err);
    logger[failure.status >= 500 ? 'error' : 'warn'](
      '{actor} could not run the notebook {path} of code project "{project}": the sandbox answered {status}, {error}; nothing was run',
      {
        component: 'api/code/projects/notebook/run',
        ...who(session),
        projectId,
        chatId,
        project: project.name,
        path: path.path,
        status: failure.status,
        error: 'message' in ran.err && ran.err.message ? ran.err.message : failure.message,
      }
    );
    return jsonError(failure.status, 'run', failure.message);
  }

  const result = readNotebookRun(ran.val);
  recordAuditEvent({
    actorSubject: session.subject,
    action: 'code.notebook.run',
    targetKind: 'code_project',
    targetLabel: project.name,
    details: {
      projectId,
      path: path.path,
      durationMs: ran.val.durationMs,
      ...(result.ok
        ? { engine: result.engine, cells: result.ran, failed: result.failed !== null }
        : { refused: result.message }),
    },
  });
  if (!result.ok) return jsonError(422, 'run', result.message);
  return NextResponse.json({ run: result });
}
