/**
 * Answering the ask a turn is parked behind (POST …/turns/:turnId/permission),
 * on the memory store, with the preferences it writes (GET/PUT
 * /api/chat/tool-permissions). These were chat-permission.spec.ts's
 * server checks: Always allow puts the tool on the person's list and
 * reads the ask's notification; a second answer is a 409 that changes
 * nothing; only the owner answers; the Preferences form's Save replaces
 * both lists.
 */

jest.mock('@/lib/session', () => ({ getSessionFromRequest: jest.fn() }));

import { randomUUID } from 'node:crypto';
import { NextRequest } from 'next/server';
import { createMemoryDataStore, getDataStore, registerDataStore, resetDataStore } from '@renkei/db';
import { createTurn, requestToolPermission } from '@/lib/chat/turns';
import { CHAT_PERMISSION_NOTIFICATION_KIND } from '@/lib/chat/permission-notification';
import { GET as getPrefs, PUT as putPrefs } from '../../../../../tool-permissions/route';
import { POST } from './route';

const { getSessionFromRequest: mockGetSession } = jest.requireMock<{
  getSessionFromRequest: jest.Mock;
}>('@/lib/session');

const TOOL = 'chat_memory_remember';
let me: string;

beforeEach(() => {
  jest.clearAllMocks();
  registerDataStore(createMemoryDataStore());
  me = `alice-${randomUUID()}`;
  mockGetSession.mockImplementation(async () => ({ subject: me, roles: ['renkei-user'] }));
});

afterEach(() => resetDataStore());

/** A chat of `owner`'s whose running turn is parked behind TOOL, with the ask's notification. */
async function parked(owner: string) {
  const chatId = await getDataStore().chats.create({
    ownerSubject: owner,
    projectId: null,
    llmModelId: null,
    toolConfig: null,
    thinkingEnabled: false,
    autoMode: false,
  });
  const turn = await createTurn({ chatId, llmModelId: null, thinkingBudget: null });
  if (!turn.ok) throw new Error('no turn');
  const turnId = turn.val;
  const toolUseId = `toolu_${randomUUID()}`;
  await requestToolPermission(turnId, {
    toolUseId,
    messageId: randomUUID(),
    name: TOOL,
    requestedAt: '2026-11-01T00:00:00.000Z',
  });
  const notificationId = randomUUID();
  await getDataStore().notifications.insert({
    id: notificationId,
    subject: owner,
    kind: CHAT_PERMISSION_NOTIFICATION_KIND,
    category: null,
    connector: null,
    tool: TOOL,
    entity: null,
    headline: '“Chat” is waiting for your permission',
    refUrl: `/chat/${chatId}`,
    refId: toolUseId,
    agentId: null,
    agentName: null,
    runId: null,
    meta: null,
  });
  return { chatId, turnId, toolUseId, notificationId };
}

function answer(
  ask: { chatId: string; turnId: string; toolUseId: string },
  decision: string
): Promise<Response> {
  return POST(
    new NextRequest('http://test.local/permission', {
      method: 'POST',
      body: JSON.stringify({ toolUseId: ask.toolUseId, decision }),
    }),
    { params: Promise.resolve({ chatId: ask.chatId, turnId: ask.turnId }) }
  );
}

async function prefs(): Promise<unknown> {
  const response = await getPrefs(new NextRequest('http://test.local/tool-permissions'));
  return response.json();
}

describe('answering a permission ask', () => {
  it('Always allow puts the tool on the person’s list and reads the ask’s notification', async () => {
    const ask = await parked(me);
    const response = await answer(ask, 'always');
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, decision: 'always' });
    expect(await prefs()).toEqual({ alwaysAllow: [TOOL], alwaysDeny: [] });
    const notification = await getDataStore().notifications.find(me, ask.notificationId);
    expect(notification?.readAt).not.toBeNull();
  });

  it('Allow once lets the turn go on without remembering the tool', async () => {
    const ask = await parked(me);
    expect((await answer(ask, 'once')).status).toBe(200);
    expect(await prefs()).toEqual({ alwaysAllow: [], alwaysDeny: [] });
  });

  it('refuses a second answer, and the first one stands', async () => {
    const ask = await parked(me);
    expect((await answer(ask, 'always')).status).toBe(200);
    const again = await answer(ask, 'deny');
    expect(again.status).toBe(409);
    expect(await prefs()).toEqual({ alwaysAllow: [TOOL], alwaysDeny: [] });
  });

  it('refuses an answer for a call the turn is not waiting on', async () => {
    const ask = await parked(me);
    expect((await answer({ ...ask, toolUseId: 'toolu_other' }, 'once')).status).toBe(409);
  });

  it('refuses a decision it does not know', async () => {
    const ask = await parked(me);
    expect((await answer(ask, 'maybe')).status).toBe(400);
  });

  it('only the owner answers: anyone else finds no such chat', async () => {
    const ask = await parked(`bob-${randomUUID()}`);
    expect((await answer(ask, 'always')).status).toBe(404);
    expect(await prefs()).toEqual({ alwaysAllow: [], alwaysDeny: [] });
  });
});

describe('the preferences’ lists', () => {
  const put = (body: unknown) =>
    putPrefs(
      new NextRequest('http://test.local/tool-permissions', {
        method: 'PUT',
        body: JSON.stringify(body),
      })
    );

  it('Save replaces both lists, back to asking for what is on neither', async () => {
    const ask = await parked(me);
    await answer(ask, 'always');
    const saved = await put({ alwaysAllow: [], alwaysDeny: ['chat_memory_forget'] });
    expect(saved.status).toBe(200);
    expect(await saved.json()).toEqual({ alwaysAllow: [], alwaysDeny: ['chat_memory_forget'] });
    expect(await prefs()).toEqual({ alwaysAllow: [], alwaysDeny: ['chat_memory_forget'] });
  });

  it('a name on both lists is blocked', async () => {
    await put({ alwaysAllow: [TOOL], alwaysDeny: [TOOL] });
    expect(await prefs()).toEqual({ alwaysAllow: [], alwaysDeny: [TOOL] });
  });

  it('refuses a body without both lists', async () => {
    expect((await put({ alwaysAllow: [] })).status).toBe(400);
  });
});
