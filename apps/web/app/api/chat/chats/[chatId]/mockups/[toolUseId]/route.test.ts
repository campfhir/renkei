/**
 * The mockup route's own rules, which the browser spec used to check over
 * HTTP: it answers only for a chat the person may read and a
 * chat_show_mockup call that exists in it, and every answer — the
 * document or a failure page — goes out as HTML under the locked-down
 * mockup CSP (no network, sandboxed even when the URL is opened on its
 * own). The session, the chat's access and its stored messages are the
 * seams; the request parsing and the document build are the real ones.
 * That the sandbox really holds inside a frame is the spec's
 * (mockups.spec.ts), in a browser.
 */

jest.mock('@/lib/session', () => ({ getSessionFromRequest: jest.fn() }));
jest.mock('@/lib/chat/access', () => ({ resolveChatAccess: jest.fn() }));
jest.mock('@/lib/chat/messages', () => ({
  ...jest.requireActual<object>('@/lib/chat/messages'),
  listMessages: jest.fn(),
}));

import { NextRequest } from 'next/server';
import type { StoredMessage } from '@/lib/chat/messages';
import { MOCKUP_CSP } from '@/lib/mockups/document';
import { GET } from './route';

const { getSessionFromRequest } = jest.requireMock<{ getSessionFromRequest: jest.Mock }>(
  '@/lib/session'
);
const { resolveChatAccess } = jest.requireMock<{ resolveChatAccess: jest.Mock }>(
  '@/lib/chat/access'
);
const { listMessages } = jest.requireMock<{ listMessages: jest.Mock }>('@/lib/chat/messages');

const CHAT_ID = '11111111-2222-3333-4444-555555555555';

function assistant(blocks: StoredMessage['blocks']): StoredMessage {
  const at = new Date('2026-01-01T00:00:00Z');
  return {
    id: 'm1',
    chatId: CHAT_ID,
    turnId: null,
    seq: 1,
    role: 'assistant',
    kind: 'assistant',
    status: 'complete',
    blocks,
    llmModelId: null,
    provider: null,
    model: null,
    stopReason: null,
    usage: null,
    timing: null,
    error: null,
    summaryId: null,
    createdAt: at,
    updatedAt: at,
  };
}

const HERO = {
  type: 'tool_use' as const,
  id: 'toolu_hero',
  name: 'chat_show_mockup',
  input: { title: 'Mobile hero', format: 'html', source: '<h1>Ship it Friday</h1>', width: 390 },
};

async function get(toolUseId: string): Promise<Response> {
  const request = new NextRequest(
    new Request(`http://x/api/chat/chats/${CHAT_ID}/mockups/${toolUseId}`)
  );
  return GET(request, { params: Promise.resolve({ chatId: CHAT_ID, toolUseId }) });
}

function expectLockedDown(response: Response): void {
  const csp = response.headers.get('content-security-policy') ?? '';
  expect(csp).toBe(MOCKUP_CSP);
  expect(csp).toMatch(/sandbox allow-scripts$/);
  expect(csp).toContain("connect-src 'none'");
  expect(response.headers.get('content-type')).toBe('text/html; charset=utf-8');
  expect(response.headers.get('x-content-type-options')).toBe('nosniff');
  expect(response.headers.get('referrer-policy')).toBe('no-referrer');
}

beforeEach(() => {
  jest.clearAllMocks();
  getSessionFromRequest.mockResolvedValue({ subject: 'auth0|alice' });
  resolveChatAccess.mockResolvedValue({ role: 'owner', cipher: { keyId: null } });
  listMessages.mockResolvedValue([
    assistant([
      { type: 'text', text: 'Here is a mockup.' },
      { type: 'tool_use', id: 'toolu_other', name: 'chat_rename', input: {} },
      HERO,
    ]),
  ]);
});

test('a mockup call in the chat is served as a locked-down HTML document', async () => {
  const response = await get('toolu_hero');
  expect(response.status).toBe(200);
  expectLockedDown(response);
  expect(response.headers.get('cache-control')).toBe('private, max-age=300');
  const html = await response.text();
  expect(html).toMatch(/^<!doctype html>/i);
  expect(html).toContain('<h1>Ship it Friday</h1>');
  expect(resolveChatAccess).toHaveBeenCalledWith('auth0|alice', CHAT_ID);
});

test('a call that does not exist in the chat is a 404', async () => {
  const response = await get('toolu_nothing');
  expect(response.status).toBe(404);
  expectLockedDown(response);
  expect(await response.text()).toContain('No such mockup.');
});

test('a call that exists but is not a mockup is a 404', async () => {
  const response = await get('toolu_other');
  expect(response.status).toBe(404);
  expect(await response.text()).toContain('That call is not a mockup.');
});

test('a chat the person may not read is a 404, and its messages are never read', async () => {
  resolveChatAccess.mockResolvedValue(null);
  const response = await get('toolu_hero');
  expect(response.status).toBe(404);
  expectLockedDown(response);
  expect(listMessages).not.toHaveBeenCalled();
});

test('a signed-out request is a 401 page, still under the mockup CSP', async () => {
  getSessionFromRequest.mockResolvedValue(null);
  const response = await get('toolu_hero');
  expect(response.status).toBe(401);
  expectLockedDown(response);
  expect(resolveChatAccess).not.toHaveBeenCalled();
});

test('a stored mockup that does not build is a 422 page saying why', async () => {
  listMessages.mockResolvedValue([
    assistant([
      {
        type: 'tool_use',
        id: 'toolu_broken',
        name: 'chat_show_mockup',
        input: { title: 'Broken try', format: 'react', source: 'export default () => <div>;' },
      },
    ]),
  ]);
  const response = await get('toolu_broken');
  expect(response.status).toBe(422);
  expectLockedDown(response);
  expect(await response.text()).toMatch(/did not compile/);
});
