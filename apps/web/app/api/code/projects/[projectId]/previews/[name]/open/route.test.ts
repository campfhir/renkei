/**
 * Opening a preview: who is asking comes from the session, never from the
 * request; a person the sandbox's platform can let in by name is sent
 * straight to the sandbox, and everyone else to the relay.
 */

jest.mock('@/lib/code/route-access', () => ({ codeProjectContext: jest.fn() }));
jest.mock('@/lib/audit-events', () => ({ recordAuditEvent: jest.fn() }));
jest.mock('@renkei/sandbox-client', () => ({
  ...jest.requireActual('@renkei/sandbox-client'),
  sbPreviewList: jest.fn(),
  exposeSandboxPort: jest.fn(),
}));

import { NextRequest, NextResponse } from 'next/server';
import { GET } from './route';
import { GET as chatGET } from '../../../chats/[chatId]/previews/[name]/open/route';

const access = jest.requireMock<{ codeProjectContext: jest.Mock }>('@/lib/code/route-access');
const sandbox = jest.requireMock<Record<string, jest.Mock>>('@renkei/sandbox-client');
const { recordAuditEvent } = jest.requireMock<{ recordAuditEvent: jest.Mock }>(
  '@/lib/audit-events'
);

const PROJECT = 'project-1';
const port = (name: string, number: number) => ({ name, port: number, token: null, url: '' });
const PREVIEW = {
  id: 'pv1',
  name: 'web',
  workspaceId: 'ws',
  command: 'pnpm dev',
  ports: [port('app', 10000), port('api', 10001)],
  port: 10000,
  token: null,
  url: '',
  status: 'running',
  exitCode: null,
  signal: null,
  startedAt: '2026-09-01T10:00:00.000Z',
  lastUsedAt: '2026-09-01T10:00:00.000Z',
  expiresAt: '2026-09-01T14:00:00.000Z',
};

function signedIn(email: string | null) {
  access.codeProjectContext.mockResolvedValue({
    ok: true,
    context: {
      session: {
        subject: 'entra|ada',
        roles: ['renkei-user'],
        actor: { subject: 'entra|ada', name: 'Ada Lovelace', email },
      },
      access: { role: 'viewer' },
      project: { id: PROJECT, name: 'Billing', repo: { fullName: 'acme/billing-service' } },
      workspaceId: 'ws',
      chat: null,
    },
  });
}

const open = (query = '', name = 'web') =>
  GET(
    new NextRequest(`https://r.example/api/code/projects/${PROJECT}/previews/${name}/open${query}`),
    { params: Promise.resolve({ projectId: PROJECT, name }) }
  );

beforeEach(() => {
  jest.clearAllMocks();
  sandbox.sbPreviewList.mockResolvedValue({ ok: true, val: [PREVIEW] });
});

describe('GET …/previews/[name]/open', () => {
  it('lets the signed-in person in at the sandbox’s port by the email their session holds, and sends them there', async () => {
    signedIn('ada@contoso.com');
    sandbox.exposeSandboxPort.mockResolvedValue({ ok: true, url: 'https://az-1-10000.example' });
    // Whatever the request claims about who it is for is not read.
    const response = await open('?email=mallory@evil.example&port=app');
    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toBe('https://az-1-10000.example/');
    expect(sandbox.exposeSandboxPort).toHaveBeenCalledWith(`code-project:${PROJECT}`, 10000, [
      'ada@contoso.com',
    ]);
    expect(recordAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        actorSubject: 'entra|ada',
        action: 'code.previews.opened',
        details: expect.objectContaining({ name: 'web', port: 10000 }),
      })
    );
  });

  it('opens the port named, by the number the sandbox lists for it', async () => {
    signedIn('ada@contoso.com');
    sandbox.exposeSandboxPort.mockResolvedValue({ ok: true, url: 'https://az-1-10001.example' });
    await open('?port=api');
    expect(sandbox.exposeSandboxPort).toHaveBeenCalledWith(expect.anything(), 10001, [
      'ada@contoso.com',
    ]);
  });

  it('sends them to the relay where the sandbox has no door of its own', async () => {
    signedIn('ada@contoso.com');
    sandbox.exposeSandboxPort.mockResolvedValue({ ok: true, url: null });
    const first = await open();
    expect(first.headers.get('location')).toBe(
      `https://r.example/api/code/projects/${PROJECT}/previews/web/app/`
    );
    const named = await open('?port=api');
    expect(named.headers.get('location')).toBe(
      `https://r.example/api/code/projects/${PROJECT}/previews/web/ports/api/`
    );
    expect(recordAuditEvent).not.toHaveBeenCalled();
  });

  it('sends them to the relay when the port could not be opened to them, or their session holds no email', async () => {
    signedIn('ada@contoso.com');
    sandbox.exposeSandboxPort.mockResolvedValue({ ok: false, message: 'quota' });
    expect((await open()).headers.get('location')).toContain('/previews/web/app/');

    signedIn(null);
    expect((await open()).headers.get('location')).toContain('/previews/web/app/');
    expect(sandbox.exposeSandboxPort).toHaveBeenCalledTimes(1);
  });

  it('opens nothing for someone who is not a member of the project', async () => {
    access.codeProjectContext.mockResolvedValue({
      ok: false,
      response: NextResponse.json({ error: 'not-found' }, { status: 404 }),
    });
    expect((await open()).status).toBe(404);
    expect(sandbox.sbPreviewList).not.toHaveBeenCalled();
    expect(sandbox.exposeSandboxPort).not.toHaveBeenCalled();
  });

  it('answers 404 for a preview or a port there is none of', async () => {
    signedIn('ada@contoso.com');
    expect((await open('', 'other')).status).toBe(404);
    expect((await open('?port=nope')).status).toBe(404);
    expect(sandbox.exposeSandboxPort).not.toHaveBeenCalled();
  });

  it('serves a chat’s previews the same way, in that chat’s worktree', async () => {
    signedIn('ada@contoso.com');
    sandbox.exposeSandboxPort.mockResolvedValue({ ok: true, url: null });
    const response = await chatGET(
      new NextRequest(
        `https://r.example/api/code/projects/${PROJECT}/chats/chat-1/previews/web/open`
      ),
      { params: Promise.resolve({ projectId: PROJECT, chatId: 'chat-1', name: 'web' }) }
    );
    expect(access.codeProjectContext).toHaveBeenCalledWith(expect.anything(), PROJECT, {
      chatId: 'chat-1',
    });
    expect(response.headers.get('location')).toBe(
      `https://r.example/api/code/projects/${PROJECT}/chats/chat-1/previews/web/app/`
    );
  });
});
