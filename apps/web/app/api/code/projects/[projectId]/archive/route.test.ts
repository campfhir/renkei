/**
 * A copy of the checkout to keep (GET …/code/projects/[id]/archive, and
 * the same handler under …/chats/[chatId]/archive), with the sandbox
 * worker answered by a double. What code-downloads.spec.ts checked by
 * opening the downloaded files: the whole checkout comes as
 * `<repo>.zip`, ignored files such as node_modules in it; a folder as
 * `<folder>.zip` holding only that folder; a file as its own bytes under
 * its own name. Which files the worker puts in the zip is the worker's;
 * here the route is shown to ask for the right checkout and path and to
 * pass the worker's bytes through untouched, named for the browser.
 */

jest.mock('@/lib/code/route-access', () => ({ codeProjectContext: jest.fn() }));
jest.mock('@/lib/code/projects', () => ({ projectWorkspace: jest.fn() }));
jest.mock('@/lib/audit-events', () => ({ recordAuditEvent: jest.fn() }));
jest.mock('@renkei/sandbox-client', () => ({
  ...jest.requireActual('@renkei/sandbox-client'),
  sbWorkspaceDownload: jest.fn(),
}));

import JSZip from 'jszip';
import { NextRequest } from 'next/server';
import { GET } from './route';
import { GET as chatGET } from '../chats/[chatId]/archive/route';

const access = jest.requireMock<{ codeProjectContext: jest.Mock }>('@/lib/code/route-access');
const projects = jest.requireMock<{ projectWorkspace: jest.Mock }>('@/lib/code/projects');
const sandbox = jest.requireMock<{ sbWorkspaceDownload: jest.Mock }>('@renkei/sandbox-client');
const { recordAuditEvent } = jest.requireMock<{ recordAuditEvent: jest.Mock }>(
  '@/lib/audit-events'
);

const PROJECT = 'project-1';
/** The checkout the worker holds, ignored files and all. */
const CHECKOUT: Record<string, string> = {
  'README.md': '# Billing service\n',
  'package.json': '{\n  "name": "billing-service"\n}\n',
  'src/billing.ts': 'export const bill = () => 0;\n',
  'src/index.ts': "export * from './billing';\n",
  'node_modules/.keep': '',
  'node_modules/left-pad/index.js': 'module.exports = (s) => s;\n',
};

function cloned(workspaceId: string | null = 'ws-base') {
  access.codeProjectContext.mockResolvedValue({
    ok: true,
    context: {
      session: { subject: 'me@example.com', roles: ['renkei-user'] },
      access: { role: 'owner' },
      project: { id: PROJECT, name: 'Billing', repo: { fullName: 'acme/billing-service' } },
      workspaceId,
      chat: null,
    },
  });
  projects.projectWorkspace.mockResolvedValue(workspaceId ? { status: 'ready' } : null);
}

function stream(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
}

/** The worker: a file as its bytes, a folder (or the checkout) as a zip of every file under it. */
async function worker(_target: unknown, input: { id: string; path: string }) {
  if (input.path in CHECKOUT) {
    const bytes = new TextEncoder().encode(CHECKOUT[input.path]);
    return {
      ok: true,
      val: {
        kind: 'file',
        contentType: 'application/octet-stream',
        sizeBytes: bytes.byteLength,
        body: stream(bytes),
      },
    };
  }
  const prefix = input.path ? `${input.path}/` : '';
  const zip = new JSZip();
  for (const [file, text] of Object.entries(CHECKOUT)) {
    if (file.startsWith(prefix)) zip.file(file, text);
  }
  const bytes = await zip.generateAsync({ type: 'uint8array' });
  return {
    ok: true,
    val: { kind: 'dir', contentType: 'application/zip', sizeBytes: null, body: stream(bytes) },
  };
}

const download = (query = '', chatId?: string) => {
  const request = new NextRequest(
    `http://test.local/api/code/projects/${PROJECT}${chatId ? `/chats/${chatId}` : ''}/archive${query}`
  );
  return chatId
    ? chatGET(request, { params: Promise.resolve({ projectId: PROJECT, chatId }) })
    : GET(request, { params: Promise.resolve({ projectId: PROJECT }) });
};

async function entries(response: Response): Promise<string[]> {
  const zip = await JSZip.loadAsync(await response.arrayBuffer());
  return Object.keys(zip.files)
    .filter((name) => !zip.files[name]!.dir)
    .sort();
}

beforeEach(() => {
  jest.clearAllMocks();
  cloned();
  sandbox.sbWorkspaceDownload.mockImplementation(worker);
});

describe('downloading a code project', () => {
  it('the whole checkout comes as <repo>.zip, node_modules and all', async () => {
    const response = await download();
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('application/zip');
    expect(response.headers.get('content-disposition')).toBe(
      `attachment; filename="billing-service.zip"; filename*=UTF-8''billing-service.zip`
    );
    expect(response.headers.get('x-download-kind')).toBe('dir');
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await entries(response)).toEqual([
      'README.md',
      'node_modules/.keep',
      'node_modules/left-pad/index.js',
      'package.json',
      'src/billing.ts',
      'src/index.ts',
    ]);
    expect(sandbox.sbWorkspaceDownload).toHaveBeenCalledWith(
      { subject: `code-project:${PROJECT}` },
      { id: 'ws-base', path: '' }
    );
    expect(recordAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'code.files.downloaded',
        details: { projectId: PROJECT, chatId: null, path: '.', kind: 'dir' },
      })
    );
  });

  it('a folder comes as <folder>.zip holding only that folder', async () => {
    const response = await download('?path=src');
    expect(response.headers.get('content-disposition')).toContain('filename="src.zip"');
    expect(await entries(response)).toEqual(['src/billing.ts', 'src/index.ts']);
  });

  it('a file comes as itself, under its own name', async () => {
    const response = await download('?path=package.json');
    expect(response.headers.get('content-disposition')).toContain('filename="package.json"');
    expect(response.headers.get('content-length')).toBe(
      String(new TextEncoder().encode(CHECKOUT['package.json']).byteLength)
    );
    expect(response.headers.get('x-download-kind')).toBe('file');
    expect(await response.text()).toContain('"name": "billing-service"');
  });

  it('through a chat, it is the chat’s worktree that is copied', async () => {
    cloned('ws-chat-7');
    const response = await download('?path=src', 'chat-7');
    expect(response.status).toBe(200);
    expect(sandbox.sbWorkspaceDownload).toHaveBeenCalledWith(expect.anything(), {
      id: 'ws-chat-7',
      path: 'src',
    });
    expect(recordAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({ details: expect.objectContaining({ chatId: 'chat-7' }) })
    );
  });

  it('names a folder outside ASCII for any browser, with its real name beside', async () => {
    const response = await download('?path=docs/r%C3%A9unions');
    expect(response.headers.get('content-disposition')).toBe(
      `attachment; filename="r_unions.zip"; filename*=UTF-8''r%C3%A9unions.zip`
    );
  });

  it('before a clone there is nothing to copy', async () => {
    cloned(null);
    const response = await download();
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      error: 'There is no checkout to download yet.',
    });
    expect(sandbox.sbWorkspaceDownload).not.toHaveBeenCalled();
  });

  it('a checkout still cloning has nothing to copy yet', async () => {
    projects.projectWorkspace.mockResolvedValue({ status: 'cloning' });
    expect((await download()).status).toBe(409);
    expect(sandbox.sbWorkspaceDownload).not.toHaveBeenCalled();
  });

  it('a path leaving the checkout is refused before the worker is asked', async () => {
    expect((await download('?path=../etc')).status).toBe(400);
    expect(sandbox.sbWorkspaceDownload).not.toHaveBeenCalled();
  });

  it('a path the worker does not have is a 404 with its words', async () => {
    sandbox.sbWorkspaceDownload.mockResolvedValue({
      ok: false,
      err: {
        kind: 'response',
        type: 'not_found',
        status: 404,
        message: 'No such file or folder: nope',
      },
    });
    const response = await download('?path=nope');
    expect(response.status).toBe(404);
    expect(recordAuditEvent).not.toHaveBeenCalled();
  });
});
