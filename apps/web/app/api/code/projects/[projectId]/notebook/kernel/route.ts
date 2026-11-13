/**
 * A notebook's kernel, for the code pane: the Python the sandbox keeps
 * running for one notebook of the checkout, so its cells run one at a
 * time and each sees what the ones before it defined.
 *
 * GET `?path=`: `{kernel}` — the notebook's live kernel (`engine`,
 * `python`), or null when it has none. Any member may ask.
 *
 * POST `{path, action}`:
 *  - `execute` with `code`: one cell's code run in the notebook's
 *    kernel, which the worker starts when there is none (in the
 *    notebook's folder, as the project's uid with the project's
 *    environment). Answers `{run: {outputs, executionCount, succeeded,
 *    started, timedOut, kernel}}` — `outputs` in nbformat's shapes, for
 *    the pane to put into the notebook; a cell that raises is a finished
 *    run with `succeeded: false`, not an error. `started` says the
 *    kernel is new, so nothing earlier cells defined is there. Nothing
 *    is written to the checkout: the outputs are the pane's unsaved
 *    edits until the person saves. The answer is always a 200 begun at
 *    once and kept alive with spaces while the cell runs; a run the
 *    sandbox refused is `{error, code, status}` in that body.
 *  - `interrupt`: stop the running cell; the kernel and its state stay.
 *  - `restart`: end the kernel; the next `execute` starts a fresh one.
 *
 * Running a cell is running code as the project, so POST is a write:
 * editors only, the chat's owner in a chat's worktree, refused in the
 * organization's read-only mode. A kernel's start is on the audit log
 * (`code.notebook.run`); its cells are not, one by one.
 */

import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { validateWorkspacePath, WRITE_MAX_CHARS } from '@renkei/connector-sandbox';
import { isRecord } from '@renkei/guards';
import {
  clientFailure,
  sbKernelClose,
  sbKernelExecute,
  sbKernelInterrupt,
  sbKernelStatus,
  type SandboxClientError,
} from '@renkei/sandbox-client';
import { jsonError, readJsonBody } from '@/lib/chat/route-support';
import { isNotebookPath } from '@/lib/code/notebook';
import { codeProjectContext } from '@/lib/code/route-access';
import { codeProjectTarget } from '@/lib/code/scope';
import { recordAuditEvent } from '@/lib/audit-events';
import { who } from '@/lib/log-actor';
import { logger } from '@/lib/logger';
import type { Session } from '@/lib/session';

/** How long one cell may run before the worker interrupts it. */
const CELL_TIMEOUT_MS = 10 * 60_000;

export const maxDuration = 800;

type Params = { params: Promise<{ projectId: string; chatId?: string }> };

function notebookPath(value: unknown): { ok: true; path: string } | { ok: false; message: string } {
  const path = validateWorkspacePath(value);
  if (!path.ok) return { ok: false, message: path.message };
  if (!path.path) return { ok: false, message: 'Say which notebook.' };
  if (!isNotebookPath(path.path))
    return { ok: false, message: 'Only a notebook (.ipynb) has a kernel.' };
  return { ok: true, path: path.path };
}

export async function GET(request: NextRequest, { params }: Params): Promise<Response> {
  const { projectId, chatId } = await params;
  const ready = await codeProjectContext(request, projectId, { chatId });
  if (!ready.ok) return ready.response;
  const { workspaceId } = ready.context;
  const path = notebookPath(new URL(request.url).searchParams.get('path'));
  if (!path.ok) return jsonError(400, 'invalid', path.message);
  if (!workspaceId) return NextResponse.json({ kernel: null });
  const status = await sbKernelStatus(codeProjectTarget(projectId), {
    id: workspaceId,
    path: path.path,
  });
  // Not knowing is not an error worth a banner: the pane shows no kernel.
  return NextResponse.json({ kernel: status.ok ? status.val : null });
}

export async function POST(request: NextRequest, { params }: Params): Promise<Response> {
  const { projectId, chatId } = await params;
  const ready = await codeProjectContext(request, projectId, { write: true, chatId });
  if (!ready.ok) return ready.response;
  const { session, project, workspaceId } = ready.context;
  if (!workspaceId)
    return jsonError(409, 'not-cloned', 'Clone the repository before running its notebooks.');

  const body = await readJsonBody(request);
  const path = notebookPath(body.path);
  if (!path.ok) return jsonError(400, 'invalid', path.message);
  const target = codeProjectTarget(projectId);
  const named = { id: workspaceId, path: path.path };
  const refused = (operation: string, err: SandboxClientError): Response => {
    const failure = clientFailure(err);
    logger[failure.status >= 500 ? 'error' : 'warn'](
      '{actor} could not {operation} the notebook {path} of code project "{project}": the sandbox answered {status}, {error}; nothing was run',
      {
        component: 'api/code/projects/notebook/kernel',
        ...who(session),
        projectId,
        chatId,
        project: project.name,
        path: path.path,
        operation,
        status: failure.status,
        error: 'message' in err && err.message ? err.message : failure.message,
      }
    );
    return jsonError(failure.status, 'kernel', failure.message);
  };

  switch (body.action) {
    case 'execute': {
      if (typeof body.code !== 'string' || !body.code.trim())
        return jsonError(400, 'invalid', 'There is no code in the cell to run.');
      if (body.code.length > WRITE_MAX_CHARS)
        return jsonError(413, 'too-large', 'The cell is too long to run.');
      const code = body.code;
      // A cell may run for minutes. The answer begins at once and is kept
      // alive with a space every few seconds (whitespace before a JSON
      // value is still that value), so no proxy or client between here and
      // the page gives up on it; a refusal therefore rides in the body,
      // with the status it would have had.
      return keptAlive(async () => {
        const ran = await sbKernelExecute(target, { ...named, code, timeoutMs: CELL_TIMEOUT_MS });
        if (!ran.ok) {
          const response = refused('run a cell of', ran.err);
          const said: unknown = await response.json();
          return { ...(isRecord(said) ? said : {}), status: response.status };
        }
        if (ran.val.started) started(session, project.name, projectId, path.path, ran.val.kernel);
        return { run: ran.val };
      });
    }
    case 'interrupt': {
      const interrupted = await sbKernelInterrupt(target, named);
      if (!interrupted.ok) return refused('interrupt', interrupted.err);
      return NextResponse.json({ interrupted: interrupted.val });
    }
    case 'restart': {
      const closed = await sbKernelClose(target, named);
      if (!closed.ok) return refused('restart the kernel of', closed.err);
      return NextResponse.json({ restarted: true, wasRunning: closed.val });
    }
    default:
      return jsonError(400, 'invalid', 'Unknown action.');
  }
}

const KEEPALIVE_MS = 15_000;

/** A 200 whose JSON body is whatever `work` answers, with spaces sent ahead of it while it is awaited. */
function keptAlive(work: () => Promise<unknown>): Response {
  const encoder = new TextEncoder();
  let alive: ReturnType<typeof setInterval> | null = null;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      alive = setInterval(() => {
        try {
          controller.enqueue(encoder.encode(' '));
        } catch {
          // The page went away; the cell runs on in its kernel.
        }
      }, KEEPALIVE_MS);
      void work()
        .catch(() => ({ error: 'The cell could not be run.', code: 'kernel', status: 500 }))
        .then((value) => {
          if (alive) clearInterval(alive);
          try {
            controller.enqueue(encoder.encode(JSON.stringify(value)));
            controller.close();
          } catch {
            // Nobody is reading any more.
          }
        });
    },
    cancel() {
      if (alive) clearInterval(alive);
    },
  });
  return new Response(stream, {
    status: 200,
    headers: {
      'content-type': 'application/json',
      'cache-control': 'no-store',
      // Ask a buffering proxy to pass the keep-alive through as it comes.
      'x-accel-buffering': 'no',
    },
  });
}

function started(
  session: Session,
  projectName: string,
  projectId: string,
  path: string,
  kernel: { engine: string; python: string }
): void {
  recordAuditEvent({
    actorSubject: session.subject,
    action: 'code.notebook.run',
    targetKind: 'code_project',
    targetLabel: projectName,
    details: { projectId, path, engine: kernel.engine, python: kernel.python },
  });
}
