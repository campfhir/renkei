/**
 * The notebook run route, with the sandbox worker answered by a double:
 * what it sends the worker, who it refuses before sending anything, and
 * how each way a run can end is answered. What the command does with a
 * real Python is lib/code/notebook-runner.test.ts.
 */

jest.mock('@/lib/code/route-access', () => ({ codeProjectContext: jest.fn() }));
jest.mock('@/lib/audit-events', () => ({ recordAuditEvent: jest.fn() }));
jest.mock('@renkei/sandbox-client', () => ({
  ...jest.requireActual('@renkei/sandbox-client'),
  sbWorkspaceExec: jest.fn(),
}));

import { NextRequest, NextResponse } from 'next/server';
import { RESULT_MARKER } from '@/lib/code/notebook-runner';
import { POST } from './route';

const access = jest.requireMock<{ codeProjectContext: jest.Mock }>('@/lib/code/route-access');
const sandbox = jest.requireMock<{ sbWorkspaceExec: jest.Mock }>('@renkei/sandbox-client');
const { recordAuditEvent } = jest.requireMock<{ recordAuditEvent: jest.Mock }>(
  '@/lib/audit-events'
);

const PROJECT = 'project-1';
const params = { params: Promise.resolve({ projectId: PROJECT, chatId: 'chat-1' }) };

function cloned(workspaceId: string | null = 'ws-1') {
  access.codeProjectContext.mockResolvedValue({
    ok: true,
    context: {
      session: { subject: 'me@example.com', roles: ['renkei-user'] },
      access: { role: 'owner' },
      project: { id: PROJECT, name: 'Billing' },
      workspaceId,
      chat: null,
    },
  });
}

function answers(line: string, more: Record<string, unknown> = {}) {
  sandbox.sbWorkspaceExec.mockResolvedValue({
    ok: true,
    val: {
      exitCode: 0,
      signal: null,
      stdout: line ? `${RESULT_MARKER}${line}\n` : '',
      stderr: '',
      timedOut: false,
      interrupted: false,
      truncated: false,
      durationMs: 1500,
      timeoutMs: 600_000,
      sizeBytes: 1,
      unreadableEnv: [],
      ...more,
    },
  });
}

const run = (body: unknown) =>
  POST(
    new NextRequest(`http://test.local/api/code/projects/${PROJECT}/chats/chat-1/notebook/run`, {
      method: 'POST',
      body: JSON.stringify(body),
    }),
    params
  );

beforeEach(() => {
  jest.clearAllMocks();
  cloned();
  answers('{"engine":"builtin","ran":3,"total":3,"failed":null,"seconds":1.5}');
});

describe('running a notebook', () => {
  it('runs it in the chat’s checkout as a write, with the longest time the worker allows', async () => {
    const response = await run({ path: 'notebooks/revenue.ipynb' });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      run: { ok: true, engine: 'builtin', ran: 3, total: 3, seconds: 1.5, failed: null },
    });
    expect(access.codeProjectContext).toHaveBeenCalledWith(expect.anything(), PROJECT, {
      write: true,
      chatId: 'chat-1',
    });
    const [, input, options] = sandbox.sbWorkspaceExec.mock.calls[0];
    expect(input).toMatchObject({ id: 'ws-1', timeoutMs: 600_000 });
    expect(input.command).toContain("RENKEI_NOTEBOOK_PATH='notebooks/revenue.ipynb'");
    // Stop in the pane drops the request, and that reaches the command.
    expect(options.signal).toBeInstanceOf(AbortSignal);
    expect(recordAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'code.notebook.run',
        details: expect.objectContaining({
          path: 'notebooks/revenue.ipynb',
          engine: 'builtin',
          cells: 3,
          failed: false,
        }),
      })
    );
  });

  it('a cell that raised is still a finished run', async () => {
    answers(
      '{"engine":"builtin","ran":2,"total":3,"seconds":1,"failed":{"index":4,"number":2,"ename":"KeyError","evalue":"x"}}'
    );
    const response = await run({ path: 'n.ipynb' });
    expect(response.status).toBe(200);
    expect((await response.json()).run.failed).toEqual({
      index: 4,
      number: 2,
      ename: 'KeyError',
      evalue: 'x',
    });
  });

  it('a run that could not happen is refused with the reason, and still on the record', async () => {
    answers('{"error":"no-python"}');
    const response = await run({ path: 'n.ipynb' });
    expect(response.status).toBe(422);
    expect(await response.json()).toEqual({
      error: 'There is no Python in the sandbox to run the notebook with.',
      code: 'run',
    });
    expect(recordAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        details: expect.objectContaining({
          refused: 'There is no Python in the sandbox to run the notebook with.',
        }),
      })
    );
  });

  it('a run cut off by the time limit says so', async () => {
    answers('', { timedOut: true, exitCode: null });
    const response = await run({ path: 'n.ipynb' });
    expect(response.status).toBe(422);
    expect((await response.json()).error).toContain('still running after 10 minutes');
  });

  it('the worker’s own refusal is passed on', async () => {
    sandbox.sbWorkspaceExec.mockResolvedValue({
      ok: false,
      err: { kind: 'response', type: 'quota_exceeded', status: 413, message: 'Over its limit' },
    });
    const response = await run({ path: 'n.ipynb' });
    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(recordAuditEvent).not.toHaveBeenCalled();
  });
});

describe('what is refused before anything runs', () => {
  it('someone who may not change the checkout', async () => {
    access.codeProjectContext.mockResolvedValue({
      ok: false,
      response: NextResponse.json({ error: 'Only editors', code: 'read-only' }, { status: 403 }),
    });
    expect((await run({ path: 'n.ipynb' })).status).toBe(403);
    expect(sandbox.sbWorkspaceExec).not.toHaveBeenCalled();
  });

  it('a project with no checkout yet', async () => {
    cloned(null);
    const response = await run({ path: 'n.ipynb' });
    expect(response.status).toBe(409);
    expect((await response.json()).code).toBe('not-cloned');
    expect(sandbox.sbWorkspaceExec).not.toHaveBeenCalled();
  });

  it.each([
    ['no path', {}],
    ['a path out of the checkout', { path: '../secrets.ipynb' }],
    ['a file that is not a notebook', { path: 'scripts/deploy.sh' }],
  ])('%s', async (_name, body) => {
    const response = await run(body);
    expect(response.status).toBe(400);
    expect(sandbox.sbWorkspaceExec).not.toHaveBeenCalled();
  });
});
