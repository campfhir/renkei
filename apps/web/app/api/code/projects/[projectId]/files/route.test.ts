/**
 * The checkout's file routes (POST create, PUT upload, PATCH rename,
 * DELETE remove), with the sandbox worker answered by a double: what
 * code-file-management.spec.ts and code-uploads.spec.ts checked through
 * the tree before — a name ending in "/" makes a folder, a nested path
 * goes to the worker whole (it makes the parents), ".." is refused, a
 * taken name is refused, an empty upload is refused, and a delete that
 * finds nothing is a 404. The tree's own rules are
 * app/(app)/code/_components/repo-tree.model.test.ts.
 */

jest.mock('@/lib/code/route-access', () => ({ codeProjectContext: jest.fn() }));
jest.mock('@/lib/audit-events', () => ({ recordAuditEvent: jest.fn() }));
jest.mock('@renkei/sandbox-client', () => ({
  ...jest.requireActual('@renkei/sandbox-client'),
  sbWorkspaceMkdir: jest.fn(),
  sbWorkspaceRead: jest.fn(),
  sbWorkspaceWrite: jest.fn(),
  sbWorkspaceUpload: jest.fn(),
  sbWorkspaceMove: jest.fn(),
  sbWorkspaceRemove: jest.fn(),
}));

import { NextRequest } from 'next/server';
import { DELETE, PATCH, POST, PUT } from './route';

const access = jest.requireMock<{ codeProjectContext: jest.Mock }>('@/lib/code/route-access');
const sandbox = jest.requireMock<Record<string, jest.Mock>>('@renkei/sandbox-client');
const { recordAuditEvent } = jest.requireMock<{ recordAuditEvent: jest.Mock }>(
  '@/lib/audit-events'
);

const PROJECT = 'project-1';
const params = { params: Promise.resolve({ projectId: PROJECT }) };
const notFound = {
  ok: false,
  err: { kind: 'response', type: 'not_found', status: 404, message: 'No such file' },
};

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

const url = (query = '') => `http://test.local/api/code/projects/${PROJECT}/files${query}`;
const send = (method: string, body: unknown, query = '') =>
  new NextRequest(url(query), { method, body: JSON.stringify(body) });

beforeEach(() => {
  jest.clearAllMocks();
  cloned();
  sandbox.sbWorkspaceRead.mockResolvedValue(notFound);
  sandbox.sbWorkspaceWrite.mockImplementation(async (_target, input: { path: string }) => ({
    ok: true,
    val: { path: input.path, sizeBytes: 0 },
  }));
  sandbox.sbWorkspaceMkdir.mockImplementation(async (_target, input: { path: string }) => ({
    ok: true,
    val: { path: input.path, created: true },
  }));
});

describe('POST: New file', () => {
  it('a name ending in "/" makes an empty folder, not a file', async () => {
    const response = await POST(send('POST', { path: 'assets/' }), params);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ path: 'assets', created: true, kind: 'dir' });
    expect(sandbox.sbWorkspaceMkdir).toHaveBeenCalledWith(expect.anything(), {
      id: 'ws-1',
      path: 'assets',
    });
    expect(sandbox.sbWorkspaceWrite).not.toHaveBeenCalled();
  });

  it('a nested path is one empty file, its folders made by the worker', async () => {
    const response = await POST(send('POST', { path: 'generated/nested/deep.txt' }), params);
    expect(await response.json()).toEqual({
      path: 'generated/nested/deep.txt',
      created: true,
      kind: 'file',
    });
    expect(sandbox.sbWorkspaceWrite).toHaveBeenCalledWith(expect.anything(), {
      id: 'ws-1',
      path: 'generated/nested/deep.txt',
      content: '',
    });
    expect(recordAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'code.files.created' })
    );
  });

  it('a path leaving the workspace is refused before the worker is asked', async () => {
    const response = await POST(send('POST', { path: '../escape.txt' }), params);
    expect(response.status).toBe(400);
    expect(sandbox.sbWorkspaceWrite).not.toHaveBeenCalled();
  });

  it('never overwrites: a file already there is refused', async () => {
    sandbox.sbWorkspaceRead.mockResolvedValue({ ok: true, val: { path: 'notes.md', text: 'x' } });
    const response = await POST(send('POST', { path: 'notes.md' }), params);
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: 'notes.md already exists.' });
  });

  it('a folder already there is refused too', async () => {
    sandbox.sbWorkspaceMkdir.mockResolvedValue({ ok: true, val: { path: 'src', created: false } });
    expect((await POST(send('POST', { path: 'src/' }), params)).status).toBe(409);
  });

  it('nothing can be created before the repository is cloned', async () => {
    cloned(null);
    expect((await POST(send('POST', { path: 'a.txt' }), params)).status).toBe(409);
  });
});

describe('PUT: an uploaded file', () => {
  it('an empty file is refused, and says so', async () => {
    const response = await PUT(
      new NextRequest(url('?path=docs%2Fempty.md'), { method: 'PUT', body: new Uint8Array(0) }),
      params
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: 'The file is empty.' });
    expect(sandbox.sbWorkspaceUpload).not.toHaveBeenCalled();
  });

  it('a file lands at its path, uncommitted', async () => {
    sandbox.sbWorkspaceUpload.mockResolvedValue({
      ok: true,
      val: { path: 'docs/guide.md', sizeBytes: 8 },
    });
    const response = await PUT(
      new NextRequest(url('?path=docs%2Fguide.md'), {
        method: 'PUT',
        body: new TextEncoder().encode('# Guide\n'),
      }),
      params
    );
    expect(response.status).toBe(200);
    expect(sandbox.sbWorkspaceUpload).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ id: 'ws-1', path: 'docs/guide.md' })
    );
  });
});

describe('PATCH and DELETE', () => {
  it('a rename moves the file within the checkout', async () => {
    sandbox.sbWorkspaceMove.mockResolvedValue({
      ok: true,
      val: { from: 'notes.md', to: 'notes-renamed.md' },
    });
    const response = await PATCH(
      send('PATCH', { from: 'notes.md', to: 'notes-renamed.md' }),
      params
    );
    expect(await response.json()).toEqual({ from: 'notes.md', to: 'notes-renamed.md' });
  });

  it('a delete that finds nothing is a 404', async () => {
    sandbox.sbWorkspaceRemove.mockResolvedValue({ ok: true, val: { deleted: false } });
    const response = await DELETE(
      new NextRequest(url('?path=gone.txt'), { method: 'DELETE' }),
      params
    );
    expect(response.status).toBe(404);
  });
});
