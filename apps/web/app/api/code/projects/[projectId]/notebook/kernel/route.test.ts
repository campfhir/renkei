/**
 * The notebook kernel route, with the sandbox worker answered by a
 * double: what it sends the worker for each action, who it refuses
 * before sending anything, and how each answer goes back. What a real
 * kernel does is apps/worker-sandbox/src/kernel-sessions.test.ts.
 */

jest.mock('@/lib/code/route-access', () => ({ codeProjectContext: jest.fn() }));
jest.mock('@/lib/audit-events', () => ({ recordAuditEvent: jest.fn() }));
jest.mock('@renkei/sandbox-client', () => ({
  ...jest.requireActual('@renkei/sandbox-client'),
  sbKernelExecute: jest.fn(),
  sbKernelStatus: jest.fn(),
  sbKernelInterrupt: jest.fn(),
  sbKernelClose: jest.fn(),
}));

import { NextRequest, NextResponse } from 'next/server';
import { GET, POST } from './route';

const access = jest.requireMock<{ codeProjectContext: jest.Mock }>('@/lib/code/route-access');
const sandbox = jest.requireMock<Record<string, jest.Mock>>('@renkei/sandbox-client');
const { recordAuditEvent } = jest.requireMock<{ recordAuditEvent: jest.Mock }>(
  '@/lib/audit-events'
);

const PROJECT = 'project-1';
const params = { params: Promise.resolve({ projectId: PROJECT, chatId: 'chat-1' }) };
const URL_BASE = `http://test.local/api/code/projects/${PROJECT}/chats/chat-1/notebook/kernel`;
const KERNEL = { engine: 'builtin', python: '3.11.2' };

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

function ran(more: Record<string, unknown> = {}) {
  sandbox.sbKernelExecute.mockResolvedValue({
    ok: true,
    val: {
      kernel: KERNEL,
      started: false,
      outputs: [{ output_type: 'stream', name: 'stdout', text: 'hi\n' }],
      executionCount: 3,
      succeeded: true,
      timedOut: false,
      ...more,
    },
  });
}

const post = (body: unknown) =>
  POST(new NextRequest(URL_BASE, { method: 'POST', body: JSON.stringify(body) }), params);
const NOTEBOOK = 'notebooks/revenue.ipynb';

beforeEach(() => {
  jest.clearAllMocks();
  cloned();
  ran();
});

describe('running a cell', () => {
  it('sends the cell’s code to the notebook’s kernel in the chat’s checkout, as a write', async () => {
    const response = await post({ path: NOTEBOOK, action: 'execute', code: 'print("hi")' });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      run: {
        kernel: KERNEL,
        started: false,
        outputs: [{ output_type: 'stream', name: 'stdout', text: 'hi\n' }],
        executionCount: 3,
        succeeded: true,
        timedOut: false,
      },
    });
    expect(access.codeProjectContext).toHaveBeenCalledWith(expect.anything(), PROJECT, {
      write: true,
      chatId: 'chat-1',
    });
    expect(sandbox.sbKernelExecute).toHaveBeenCalledWith(expect.anything(), {
      id: 'ws-1',
      path: NOTEBOOK,
      code: 'print("hi")',
      timeoutMs: 600_000,
    });
  });

  it('a cell that raised is a finished run, not an error', async () => {
    ran({ succeeded: false, outputs: [{ output_type: 'error', ename: 'KeyError', evalue: 'x' }] });
    const response = await post({ path: NOTEBOOK, action: 'execute', code: 'd["x"]' });
    expect(response.status).toBe(200);
    expect((await response.json()).run.succeeded).toBe(false);
  });

  it('a kernel’s start goes on the audit log; the cells it then runs do not', async () => {
    await post({ path: NOTEBOOK, action: 'execute', code: 'x = 1' });
    expect(recordAuditEvent).not.toHaveBeenCalled();
    ran({ started: true });
    await post({ path: NOTEBOOK, action: 'execute', code: 'x = 1' });
    expect(recordAuditEvent).toHaveBeenCalledTimes(1);
    expect(recordAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'code.notebook.run',
        details: { projectId: PROJECT, path: NOTEBOOK, engine: 'builtin', python: '3.11.2' },
      })
    );
  });

  it('a kernel that died under the cell is 410 with the worker’s own sentence', async () => {
    sandbox.sbKernelExecute.mockResolvedValue({
      ok: false,
      err: {
        kind: 'op',
        type: 'kernel_died',
        status: 410,
        message: 'The notebook kernel ended while the cell ran.',
      },
    });
    const response = await post({ path: NOTEBOOK, action: 'execute', code: 'x' });
    expect(response.status).toBe(410);
    expect((await response.json()).error).toBe('The notebook kernel ended while the cell ran.');
  });

  it.each([
    ['no code', { path: NOTEBOOK, action: 'execute' }],
    ['a blank cell', { path: NOTEBOOK, action: 'execute', code: '  \n' }],
    ['no notebook', { action: 'execute', code: '1' }],
    ['a path out of the checkout', { path: '../n.ipynb', action: 'execute', code: '1' }],
    ['a file that is not a notebook', { path: 'run.py', action: 'execute', code: '1' }],
    ['an action it does not know', { path: NOTEBOOK, action: 'reboot' }],
  ])('%s is refused before the worker hears of it', async (_name, body) => {
    expect((await post(body)).status).toBe(400);
    expect(sandbox.sbKernelExecute).not.toHaveBeenCalled();
  });
});

describe('interrupt and restart', () => {
  it('interrupt asks the worker to stop the running cell', async () => {
    sandbox.sbKernelInterrupt.mockResolvedValue({ ok: true, val: true });
    const response = await post({ path: NOTEBOOK, action: 'interrupt' });
    expect(await response.json()).toEqual({ interrupted: true });
    expect(sandbox.sbKernelInterrupt).toHaveBeenCalledWith(expect.anything(), {
      id: 'ws-1',
      path: NOTEBOOK,
    });
  });

  it('restart ends the kernel; a notebook with none is restarted all the same', async () => {
    sandbox.sbKernelClose.mockResolvedValue({ ok: true, val: false });
    const response = await post({ path: NOTEBOOK, action: 'restart' });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ restarted: true, wasRunning: false });
  });
});

describe('who may', () => {
  it('someone who may not change the checkout runs nothing', async () => {
    access.codeProjectContext.mockResolvedValue({
      ok: false,
      response: NextResponse.json({ error: 'Only editors', code: 'read-only' }, { status: 403 }),
    });
    expect((await post({ path: NOTEBOOK, action: 'execute', code: '1' })).status).toBe(403);
    expect(sandbox.sbKernelExecute).not.toHaveBeenCalled();
  });

  it('a project with no checkout yet has nothing to run in', async () => {
    cloned(null);
    const response = await post({ path: NOTEBOOK, action: 'execute', code: '1' });
    expect(response.status).toBe(409);
    expect((await response.json()).code).toBe('not-cloned');
  });
});

describe('asking whether there is a kernel', () => {
  const get = (query: string) => GET(new NextRequest(`${URL_BASE}${query}`), params);

  it('any member may ask, and hears the kernel or none', async () => {
    sandbox.sbKernelStatus.mockResolvedValue({ ok: true, val: KERNEL });
    const response = await get(`?path=${encodeURIComponent(NOTEBOOK)}`);
    expect(await response.json()).toEqual({ kernel: KERNEL });
    expect(access.codeProjectContext).toHaveBeenCalledWith(expect.anything(), PROJECT, {
      chatId: 'chat-1',
    });
    sandbox.sbKernelStatus.mockResolvedValue({ ok: true, val: null });
    expect(await (await get(`?path=${encodeURIComponent(NOTEBOOK)}`)).json()).toEqual({
      kernel: null,
    });
  });

  it('before a clone, or when the worker cannot say, there is simply none', async () => {
    cloned(null);
    expect(await (await get(`?path=${NOTEBOOK}`)).json()).toEqual({ kernel: null });
    expect(sandbox.sbKernelStatus).not.toHaveBeenCalled();
    cloned();
    sandbox.sbKernelStatus.mockResolvedValue({ ok: false, err: { kind: 'unreachable' } });
    expect(await (await get(`?path=${NOTEBOOK}`)).json()).toEqual({ kernel: null });
  });

  it('wants a notebook', async () => {
    expect((await get('?path=run.py')).status).toBe(400);
  });
});
