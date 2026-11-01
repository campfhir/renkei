/**
 * A card's confirm button, run for real (POST …/widget/tool-call), on the
 * memory store: a card already decided — on another device, or by the
 * model on the person's word (chat_widget_resolve) — refuses to run its
 * confirm tool again, whatever the catalog says, with the words the card
 * shows. These were widget-card.spec.ts's "stale card" test and
 * widget-card-resolve.spec.ts's request after the receipt.
 *
 * The catalog and the MCP call are what the guard stands in front of:
 * both are replaced, so a call that got past it would show.
 */

jest.mock('@/lib/session', () => ({ getSessionFromRequest: jest.fn() }));
jest.mock('@/lib/mcp-tools/tool-catalog', () => ({ listAvailableTools: jest.fn() }));
jest.mock('@renkei/mcp-client', () => ({
  HttpMcpClient: jest.fn(),
  mintRunToken: jest.fn(),
  revokeRunToken: jest.fn(),
}));

import { NextRequest } from 'next/server';
import { createMemoryDataStore, getDataStore, registerDataStore, resetDataStore } from '@renkei/db';
import { POST as decisionPOST } from '../decision/route';
import { POST } from './route';

const { getSessionFromRequest: mockGetSession } = jest.requireMock<{
  getSessionFromRequest: jest.Mock;
}>('@/lib/session');
const { listAvailableTools: mockCatalog } = jest.requireMock<{ listAvailableTools: jest.Mock }>(
  '@/lib/mcp-tools/tool-catalog'
);
const mcp = jest.requireMock<{
  HttpMcpClient: jest.Mock;
  mintRunToken: jest.Mock;
  revokeRunToken: jest.Mock;
}>('@renkei/mcp-client');

const ME = 'alice';
const STATE_KEY = 'renkei-preview:p-1';
const CREATED = { content: [{ type: 'text', text: 'Created issue OPS-99.' }], isError: false };
const callTool = jest.fn();

beforeEach(() => {
  jest.clearAllMocks();
  registerDataStore(createMemoryDataStore());
  mockGetSession.mockResolvedValue({ subject: ME, roles: ['renkei-user'] });
  mockCatalog.mockResolvedValue([{ name: 'jira_create_issue_confirm', appOnly: true }]);
  mcp.mintRunToken.mockResolvedValue('token');
  mcp.revokeRunToken.mockResolvedValue(undefined);
  callTool.mockResolvedValue(CREATED);
  mcp.HttpMcpClient.mockImplementation(() => ({ initialize: jest.fn(), callTool }));
});

afterEach(() => resetDataStore());

async function newChat(owner = ME): Promise<string> {
  return getDataStore().chats.create({
    ownerSubject: owner,
    projectId: null,
    llmModelId: null,
    toolConfig: null,
    thinkingEnabled: false,
    autoMode: false,
  });
}

const params = (chatId: string) => ({ params: Promise.resolve({ chatId }) });
const post = (body: unknown) =>
  new NextRequest('http://test.local/widget', { method: 'POST', body: JSON.stringify(body) });

function confirm(chatId: string, extra: Record<string, unknown> = { stateKey: STATE_KEY }) {
  return POST(
    post({
      name: 'jira_create_issue_confirm',
      arguments: { projectKey: 'OPS', summary: 'Rotate the Zoom webhook secret' },
      ...extra,
    }),
    params(chatId)
  );
}

/** Another device's card finishing, as it reports it (bridge.ts's reportDecision). */
async function decidedElsewhere(chatId: string): Promise<void> {
  const response = await decisionPOST(
    post({
      stateKey: STATE_KEY,
      decision: 'confirmed',
      state: { icon: 'sent', headline: 'Created issue OPS-1.' },
    }),
    params(chatId)
  );
  expect(response.status).toBe(200);
}

describe('POST widget/tool-call', () => {
  it('runs the card’s confirm tool with its arguments, scoped to that one tool', async () => {
    const chatId = await newChat();

    const response = await confirm(chatId);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ result: CREATED });
    expect(callTool).toHaveBeenCalledWith('jira_create_issue_confirm', {
      projectKey: 'OPS',
      summary: 'Rotate the Zoom webhook secret',
    });
    expect(mcp.mintRunToken).toHaveBeenCalledWith(
      expect.objectContaining({ tools: ['jira_create_issue_confirm'], application: 'widget' })
    );
    expect(mcp.revokeRunToken).toHaveBeenCalledWith('token');
  });

  it('a stale card refuses to re-run a confirm tool another device already decided', async () => {
    const chatId = await newChat();
    await decidedElsewhere(chatId);

    const response = await confirm(chatId);

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      code: 'already-decided',
      error: 'This was already decided on another device — reload to see it.',
    });
    // Refused before the catalog is read or anything is called.
    expect(mockCatalog).not.toHaveBeenCalled();
    expect(callTool).not.toHaveBeenCalled();
  });

  it('a decided card stays refused even when its tool has since left the catalog', async () => {
    const chatId = await newChat();
    await decidedElsewhere(chatId);
    mockCatalog.mockResolvedValue([]);

    expect((await confirm(chatId)).status).toBe(409);
  });

  it('a card that sends no key cannot be checked, so its tool runs', async () => {
    const chatId = await newChat();
    await decidedElsewhere(chatId);

    expect((await confirm(chatId, {})).status).toBe(200);
    expect(callTool).toHaveBeenCalledTimes(1);
  });

  it('refuses a tool that is not a card action', async () => {
    const chatId = await newChat();
    mockCatalog.mockResolvedValue([{ name: 'jira_create_issue_confirm', appOnly: false }]);

    const response = await confirm(chatId);

    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ code: 'not-a-card-tool' });
    expect(callTool).not.toHaveBeenCalled();
  });

  it('a tool that could not be reached is a 502 the card shows', async () => {
    const chatId = await newChat();
    callTool.mockRejectedValue(new Error('connection refused'));

    const response = await confirm(chatId);

    expect(response.status).toBe(502);
    expect(await response.json()).toMatchObject({ code: 'call-failed' });
    expect(mcp.revokeRunToken).toHaveBeenCalledWith('token');
  });

  it('refuses someone else’s chat, and a call with no tool name', async () => {
    expect((await confirm(await newChat('bob'))).status).toBe(404);
    const chatId = await newChat();
    expect((await POST(post({ arguments: {} }), params(chatId))).status).toBe(400);
    expect(callTool).not.toHaveBeenCalled();
  });
});

describe('POST widget/decision', () => {
  it('the first decision for a card stands; a later one does not rewrite it', async () => {
    const chatId = await newChat();
    await decidedElsewhere(chatId);
    const later = await decisionPOST(
      post({
        stateKey: STATE_KEY,
        decision: 'cancelled',
        state: { icon: 'cancelled', headline: 'Cancelled' },
      }),
      params(chatId)
    );
    expect(later.status).toBe(200);
    expect(await getDataStore().chatThreads.getWidgetDecision(STATE_KEY)).toMatchObject({
      icon: 'sent',
      headline: 'Created issue OPS-1.',
    });
  });

  it('refuses a decision with no receipt it can read', async () => {
    const chatId = await newChat();
    for (const body of [
      { stateKey: STATE_KEY, decision: 'confirmed', state: { icon: 'maybe', headline: 'x' } },
      { stateKey: STATE_KEY, decision: 'later', state: { icon: 'sent', headline: 'x' } },
      { decision: 'confirmed', state: { icon: 'sent', headline: 'x' } },
    ]) {
      expect((await decisionPOST(post(body), params(chatId))).status).toBe(400);
    }
    expect(await getDataStore().chatThreads.getWidgetDecision(STATE_KEY)).toBeNull();
  });
});
