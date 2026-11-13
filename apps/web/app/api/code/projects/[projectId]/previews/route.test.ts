/**
 * The previews routes with the sandbox worker answered by a double: a
 * start asks the worker for the chat's worktree with the address the
 * preview will be served at (a share token minted here when asked for),
 * answers that address back and records the act; a list carries the
 * addresses for each; one preview's logs and stop go by name; and the
 * same handlers serve the chat-scoped paths.
 */

jest.mock('@/lib/code/route-access', () => ({ codeProjectContext: jest.fn() }));
jest.mock('@/lib/audit-events', () => ({ recordAuditEvent: jest.fn() }));
jest.mock('@/lib/get-origin', () => ({
  getOrigin: jest.fn(async () => ({ ok: true, val: 'https://r.example' })),
}));
jest.mock('@renkei/sandbox-client', () => ({
  ...jest.requireActual('@renkei/sandbox-client'),
  sbPreviewList: jest.fn(),
  sbPreviewStart: jest.fn(),
  sbPreviewLogs: jest.fn(),
  sbPreviewStop: jest.fn(),
  unexposeSandboxPort: jest.fn(async () => undefined),
}));

import { NextRequest } from 'next/server';
import { GET, POST } from './route';
import { DELETE as stopByName, GET as logsByName } from './[name]/route';
import { GET as chatGET, POST as chatPOST } from '../chats/[chatId]/previews/route';

const access = jest.requireMock<{ codeProjectContext: jest.Mock }>('@/lib/code/route-access');
const sandbox = jest.requireMock<Record<string, jest.Mock>>('@renkei/sandbox-client');
const { recordAuditEvent } = jest.requireMock<{ recordAuditEvent: jest.Mock }>(
  '@/lib/audit-events'
);

const PROJECT = 'project-1';
const PREVIEW = {
  id: 'pv1',
  name: 'web',
  workspaceId: 'ws-chat',
  command: 'pnpm dev',
  ports: [
    {
      name: 'app',
      port: 10000,
      token: null,
      url: 'https://r.example/api/code/projects/project-1/previews/web/app/',
    },
  ],
  port: 10000,
  token: null,
  url: 'https://r.example/api/code/projects/project-1/previews/web/app/',
  status: 'running',
  exitCode: null,
  signal: null,
  startedAt: '2026-09-01T10:00:00.000Z',
  lastUsedAt: '2026-09-01T10:00:00.000Z',
  expiresAt: '2026-09-01T14:00:00.000Z',
};

function member(workspaceId: string | null = 'ws-chat', chat: { id: string } | null = null) {
  access.codeProjectContext.mockResolvedValue({
    ok: true,
    context: {
      session: { subject: 'me@example.com', roles: ['renkei-user'] },
      access: { role: 'owner' },
      project: { id: PROJECT, name: 'Billing', repo: { fullName: 'acme/billing-service' } },
      workspaceId,
      chat,
    },
  });
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe('GET …/previews', () => {
  const list = () =>
    GET(new NextRequest(`https://r.example/api/code/projects/${PROJECT}/previews`), {
      params: Promise.resolve({ projectId: PROJECT }),
    });

  afterEach(() => {
    delete process.env.SANDBOX_ORCHESTRATOR_URL;
    delete process.env.SANDBOX_ORCHESTRATOR_API_KEY;
  });

  it('with orchestrated sandboxes, a member’s link goes through the open route, which knows who is signed in', async () => {
    process.env.SANDBOX_ORCHESTRATOR_URL = 'http://orchestrator:8097';
    process.env.SANDBOX_ORCHESTRATOR_API_KEY = 'k';
    member();
    sandbox.sbPreviewList.mockResolvedValue({ ok: true, val: [PREVIEW] });
    const body = await (await list()).json();
    expect(body.previews[0].url).toBe(
      `https://r.example/api/code/projects/${PROJECT}/previews/web/open`
    );
  });

  it('otherwise it is the relay’s address, as it always was', async () => {
    member();
    sandbox.sbPreviewList.mockResolvedValue({ ok: true, val: [PREVIEW] });
    const body = await (await list()).json();
    expect(body.previews[0].url).toBe(
      `https://r.example/api/code/projects/${PROJECT}/previews/web/app/`
    );
  });
});

describe('POST …/previews', () => {
  it('starts the server in the route’s checkout with its address, and answers the address', async () => {
    member('ws-chat', { id: 'chat-1' });
    sandbox.sbPreviewStart.mockResolvedValue({
      ok: true,
      val: { preview: PREVIEW, listening: ['app'], logs: 'ready' },
    });
    const response = await chatPOST(
      new NextRequest(`https://r.example/api/code/projects/${PROJECT}/chats/chat-1/previews`, {
        method: 'POST',
        body: JSON.stringify({ name: 'web', command: 'pnpm dev', waitSeconds: 30 }),
        headers: { 'content-type': 'application/json' },
      }),
      { params: Promise.resolve({ projectId: PROJECT, chatId: 'chat-1' }) }
    );
    expect(response.status).toBe(201);
    expect(access.codeProjectContext).toHaveBeenCalledWith(expect.anything(), PROJECT, {
      write: true,
      chatId: 'chat-1',
    });
    expect(sandbox.sbPreviewStart).toHaveBeenCalledWith(
      { subject: `code-project:${PROJECT}` },
      {
        id: 'ws-chat',
        name: 'web',
        command: 'pnpm dev',
        ports: [
          {
            name: 'app',
            url: `https://r.example/api/code/projects/${PROJECT}/chats/chat-1/previews/web/app/`,
          },
        ],
        waitMs: 30_000,
      }
    );
    const body = await response.json();
    expect(body.listening).toEqual(['app']);
    expect(body.preview.url).toBe(
      `https://r.example/api/code/projects/${PROJECT}/chats/chat-1/previews/web/app/`
    );
    expect(body.preview.publicUrl).toBeNull();
    expect(recordAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'code.previews.started',
        details: expect.objectContaining({ name: 'web', public: false, chatId: 'chat-1' }),
      })
    );
  });

  it('mints a share token per port for a public preview and tells the worker each public address', async () => {
    member();
    sandbox.sbPreviewStart.mockImplementation(
      async (
        _t: unknown,
        input: { ports: Array<{ name: string; token?: string; url: string }> }
      ) => ({
        ok: true,
        val: {
          preview: {
            ...PREVIEW,
            ports: input.ports.map((port, index) => ({
              name: port.name,
              port: 10000 + index,
              token: port.token ?? null,
              url: port.url,
            })),
          },
          listening: [],
          logs: '',
        },
      })
    );
    const response = await POST(
      new NextRequest(`https://r.example/api/code/projects/${PROJECT}/previews`, {
        method: 'POST',
        body: JSON.stringify({
          name: 'web',
          command: 'pnpm dev',
          ports: ['web', 'api'],
          public: true,
        }),
        headers: { 'content-type': 'application/json' },
      }),
      { params: Promise.resolve({ projectId: PROJECT }) }
    );
    expect(response.status).toBe(202);
    const sent = sandbox.sbPreviewStart.mock.calls[0][1];
    expect(sent.ports).toHaveLength(2);
    for (const port of sent.ports) {
      expect(port.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(port.url).toBe(`https://r.example/api/code/preview/${port.token}/`);
    }
    const body = await response.json();
    expect(body.preview.publicUrl).toBe(
      `https://r.example/api/code/preview/${sent.ports[0].token}/`
    );
    expect(body.preview.url).toBe(
      `https://r.example/api/code/projects/${PROJECT}/previews/web/app/`
    );
    expect(body.preview.ports[1].url).toBe(
      `https://r.example/api/code/projects/${PROJECT}/previews/web/ports/api/`
    );
  });

  it('refuses a bad payload before the worker, and a project with no checkout', async () => {
    member();
    const bad = await POST(
      new NextRequest(`https://r.example/api/code/projects/${PROJECT}/previews`, {
        method: 'POST',
        body: JSON.stringify({ name: 'Web', command: 'pnpm dev' }),
        headers: { 'content-type': 'application/json' },
      }),
      { params: Promise.resolve({ projectId: PROJECT }) }
    );
    expect(bad.status).toBe(400);
    member(null);
    const uncloned = await POST(
      new NextRequest(`https://r.example/api/code/projects/${PROJECT}/previews`, {
        method: 'POST',
        body: JSON.stringify({ name: 'web', command: 'pnpm dev' }),
        headers: { 'content-type': 'application/json' },
      }),
      { params: Promise.resolve({ projectId: PROJECT }) }
    );
    expect(uncloned.status).toBe(409);
    expect(sandbox.sbPreviewStart).not.toHaveBeenCalled();
  });
});

describe('GET …/previews, and one by name', () => {
  it('lists the previews with their addresses, through the project and through a chat', async () => {
    member();
    sandbox.sbPreviewList.mockResolvedValue({ ok: true, val: [PREVIEW] });
    const listed = await GET(
      new NextRequest(`https://r.example/api/code/projects/${PROJECT}/previews`),
      { params: Promise.resolve({ projectId: PROJECT }) }
    );
    expect(listed.status).toBe(200);
    expect((await listed.json()).previews[0].url).toBe(
      `https://r.example/api/code/projects/${PROJECT}/previews/web/app/`
    );
    const viaChat = await chatGET(
      new NextRequest(`https://r.example/api/code/projects/${PROJECT}/chats/chat-1/previews`),
      { params: Promise.resolve({ projectId: PROJECT, chatId: 'chat-1' }) }
    );
    expect((await viaChat.json()).previews[0].url).toBe(
      `https://r.example/api/code/projects/${PROJECT}/chats/chat-1/previews/web/app/`
    );
  });

  it('answers an empty list where the deployment has no workspaces', async () => {
    member();
    sandbox.sbPreviewList.mockResolvedValue({
      ok: false,
      err: { kind: 'op', type: 'workspaces_unavailable', status: 503 },
    });
    const listed = await GET(
      new NextRequest(`https://r.example/api/code/projects/${PROJECT}/previews`),
      { params: Promise.resolve({ projectId: PROJECT }) }
    );
    expect(listed.status).toBe(200);
    expect(await listed.json()).toEqual({ previews: [] });
  });

  it('reads logs and stops by name, recording the stop', async () => {
    member();
    sandbox.sbPreviewLogs.mockResolvedValue({
      ok: true,
      val: { preview: PREVIEW, logs: 'GET / 200', truncated: false, count: 1 },
    });
    const logs = await logsByName(
      new NextRequest(`https://r.example/api/code/projects/${PROJECT}/previews/web?lines=50`),
      { params: Promise.resolve({ projectId: PROJECT, name: 'web' }) }
    );
    expect(logs.status).toBe(200);
    expect(sandbox.sbPreviewLogs).toHaveBeenCalledWith(
      { subject: `code-project:${PROJECT}` },
      { name: 'web', lines: 50 }
    );
    sandbox.sbPreviewStop.mockResolvedValue({ ok: true, val: PREVIEW });
    const stopped = await stopByName(
      new NextRequest(`https://r.example/api/code/projects/${PROJECT}/previews/web`, {
        method: 'DELETE',
      }),
      { params: Promise.resolve({ projectId: PROJECT, name: 'web' }) }
    );
    expect(stopped.status).toBe(200);
    expect(recordAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'code.previews.stopped' })
    );
    const unknown = await logsByName(
      new NextRequest(`https://r.example/api/code/projects/${PROJECT}/previews/Nope`),
      { params: Promise.resolve({ projectId: PROJECT, name: 'Nope' }) }
    );
    expect(unknown.status).toBe(404);
  });
});
